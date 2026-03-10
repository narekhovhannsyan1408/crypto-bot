import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { PortfolioService } from '../portfolio/portfolio.service';
import { RiskManagerService } from './risk-manager.service';

describe('RiskManagerService', () => {
  let service: RiskManagerService;
  let portfolio: PortfolioService;

  beforeEach(async () => {
    process.env.BOT_INITIAL_BALANCE = '1000';
    process.env.BOT_MAX_CONCURRENT_POSITIONS = '2';
    process.env.BOT_MAX_PORTFOLIO_EXPOSURE_PCT = '0.8';
    process.env.BOT_MAX_DRAWDOWN_STOP_PCT = '0.15';
    process.env.BOT_MAX_DAILY_LOSS_PCT = '0.04';
    process.env.BOT_MAX_CONSECUTIVE_LOSSES = '3';
    process.env.BOT_POSITION_SIZE_USDT = '100';
    process.env.BOT_RISK_PER_TRADE_PCT = '0.01';
    process.env.BOT_STOP_LOSS_PCT = '0.01';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [RiskManagerService, PortfolioService],
    }).compile();

    service = module.get<RiskManagerService>(RiskManagerService);
    portfolio = module.get<PortfolioService>(PortfolioService);
  });

  it('approves a valid trade request', () => {
    const approval = service.approveOpenPosition({
      symbol: 'BTCUSDT',
      interval: '1m',
      side: 'LONG',
      entryPrice: 100,
      timestamp: Date.now(),
    });

    expect(approval.status).toBe('APPROVED');
  });

  it('denies trade after too many consecutive losses', () => {
    portfolio.consecutiveLosses = 3;

    const approval = service.approveOpenPosition({
      symbol: 'BTCUSDT',
      interval: '1m',
      side: 'LONG',
      entryPrice: 100,
      timestamp: Date.now(),
    });

    expect(approval.status).toBe('DENIED');
  });
});
