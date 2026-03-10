import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { PortfolioService } from './portfolio.service';

describe('PortfolioService', () => {
  let service: PortfolioService;

  beforeEach(async () => {
    process.env.BOT_INITIAL_BALANCE = '1000';
    process.env.BOT_FEE_PCT = '0.001';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [PortfolioService],
    }).compile();

    service = module.get<PortfolioService>(PortfolioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('calculates long equity using liquidation value', () => {
    service.balance = 900;
    service.position = {
      symbol: 'BTCUSDT',
      interval: '1m',
      side: 'LONG',
      entryPrice: 100,
      quantity: 0.999,
      investedUsdt: 100,
      openedAt: 1,
      entryFeePaid: 0.1,
      stopLossPct: 0.012,
      takeProfitPct: 0.02,
      trailingStopPct: 0.008,
      stopPrice: 98.8,
      takePrice: 102,
      highestPrice: 100,
      lowestPrice: 100,
    };

    expect(service.getEquity(100)).toBeCloseTo(999.8001, 6);
  });

  it('calculates short equity including both entry and exit fees', () => {
    service.balance = 900;
    service.position = {
      symbol: 'BTCUSDT',
      interval: '1m',
      side: 'SHORT',
      entryPrice: 100,
      quantity: 0.999,
      investedUsdt: 100,
      openedAt: 1,
      entryFeePaid: 0.1,
      stopLossPct: 0.012,
      takeProfitPct: 0.02,
      trailingStopPct: 0.008,
      stopPrice: 101.2,
      takePrice: 98,
      highestPrice: 100,
      lowestPrice: 100,
    };

    expect(service.getEquity(100)).toBeCloseTo(999.8001, 6);
  });
});
