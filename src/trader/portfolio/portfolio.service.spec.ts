import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { makePositionKey } from '../types';
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
    service.registerOpenedPosition({
      key: makePositionKey('BTCUSDT', 'momentum_trend'),
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum Trend',
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
    });
    service.updateMark('BTCUSDT', 100);

    expect(service.getEquity()).toBeCloseTo(999.8001, 6);
  });

  it('calculates short equity including both entry and exit fees', () => {
    service.balance = 900;
    service.registerOpenedPosition({
      key: makePositionKey('BTCUSDT', 'momentum_trend'),
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum Trend',
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
    });
    service.updateMark('BTCUSDT', 100);

    expect(service.getEquity()).toBeCloseTo(999.8001, 6);
  });

  it('aggregates equity across multiple positions', () => {
    service.balance = 800;

    service.registerOpenedPosition({
      key: makePositionKey('BTCUSDT', 'momentum_trend'),
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum Trend',
      side: 'LONG',
      entryPrice: 100,
      quantity: 1,
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
    });
    service.registerOpenedPosition({
      key: makePositionKey('ETHUSDT', 'mean_reversion'),
      symbol: 'ETHUSDT',
      interval: '1m',
      strategyId: 'mean_reversion',
      strategyName: 'Mean Reversion',
      side: 'LONG',
      entryPrice: 200,
      quantity: 0.5,
      investedUsdt: 100,
      openedAt: 1,
      entryFeePaid: 0.1,
      stopLossPct: 0.012,
      takeProfitPct: 0.02,
      trailingStopPct: 0.008,
      stopPrice: 197.6,
      takePrice: 204,
      highestPrice: 200,
      lowestPrice: 200,
    });

    service.updateMark('BTCUSDT', 100);
    service.updateMark('ETHUSDT', 200);

    expect(service.getOpenPositionsCount()).toBe(2);
    expect(service.getEquity()).toBeCloseTo(999.8, 6);
  });
});
