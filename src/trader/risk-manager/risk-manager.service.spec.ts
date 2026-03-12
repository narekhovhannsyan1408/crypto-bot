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
    process.env.BOT_MIN_POSITION_SIZE_USDT = '25';
    process.env.BOT_POSITION_SIZE_USDT = '0';
    process.env.BOT_MAX_POSITION_SIZE_PCT_OF_EQUITY = '0.05';
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
      strategyId: 'momentum_trend',
      side: 'LONG',
      entryPrice: 100,
      timestamp: Date.now(),
    });

    expect(approval.status).toBe('APPROVED');
    if (approval.status === 'APPROVED') {
      expect(approval.approvedSizeUsdt).toBeCloseTo(50, 8);
    }
  });

  it('denies trade after too many consecutive losses', () => {
    portfolio.consecutiveLosses = 3;
    portfolio.closedTrades.push({
      key: 'BTCUSDT:momentum_trend',
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum',
      side: 'LONG',
      marketType: 'spot',
      entryPrice: 100,
      exitPrice: 99,
      quantity: 1,
      investedUsdt: 100,
      grossPnl: -1,
      pnlNet: -1,
      totalFees: 0,
      exitFee: 0,
      openedAt: Date.now() - 120000,
      closedAt: Date.now() - 60000,
      reason: 'stop',
    });

    const approval = service.approveOpenPosition({
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      side: 'LONG',
      entryPrice: 100,
      timestamp: Date.now(),
    });

    expect(approval.status).toBe('DENIED');
  });

  it('allows trade after consecutive losses when cooldown passed', async () => {
    process.env.BOT_CONSECUTIVE_LOSSES_COOLDOWN_MINUTES = '60';
    resetBotConfigCache();

    const moduleRef = await Test.createTestingModule({
      providers: [RiskManagerService, PortfolioService],
    }).compile();
    const svc = moduleRef.get<RiskManagerService>(RiskManagerService);
    const port = moduleRef.get<PortfolioService>(PortfolioService);

    port.consecutiveLosses = 3;
    port.closedTrades.push({
      key: 'BTCUSDT:momentum_trend',
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum',
      side: 'LONG',
      marketType: 'spot',
      entryPrice: 100,
      exitPrice: 99,
      quantity: 1,
      investedUsdt: 100,
      grossPnl: -1,
      pnlNet: -1,
      totalFees: 0,
      exitFee: 0,
      openedAt: Date.now() - 120 * 60 * 1000,
      closedAt: Date.now() - 61 * 60 * 1000,
      reason: 'stop',
    });

    const approval = svc.approveOpenPosition({
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'mean_reversion',
      side: 'LONG',
      entryPrice: 100,
      timestamp: Date.now(),
    });

    expect(approval.status).toBe('APPROVED');

    delete process.env.BOT_CONSECUTIVE_LOSSES_COOLDOWN_MINUTES;
    resetBotConfigCache();
  });

  it('denies trade when approved size is below minimum position size', () => {
    portfolio.balance = 10;

    const approval = service.approveOpenPosition({
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      side: 'LONG',
      entryPrice: 100,
      timestamp: Date.now(),
    });

    expect(approval.status).toBe('DENIED');
  });
});
