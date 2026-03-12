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
      marketType: 'spot',
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
      breakevenArmed: false,
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
      marketType: 'futures',
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
      breakevenArmed: false,
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
      marketType: 'spot',
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
      breakevenArmed: false,
    });
    service.registerOpenedPosition({
      key: makePositionKey('ETHUSDT', 'mean_reversion'),
      symbol: 'ETHUSDT',
      interval: '1m',
      strategyId: 'mean_reversion',
      strategyName: 'Mean Reversion',
      side: 'LONG',
      marketType: 'spot',
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
      breakevenArmed: false,
    });

    service.updateMark('BTCUSDT', 100);
    service.updateMark('ETHUSDT', 200);

    expect(service.getOpenPositionsCount()).toBe(2);
    expect(service.getEquity()).toBeCloseTo(999.8, 6);
  });

  it('syncs live wallet total into balance when there are no open positions', () => {
    service.syncExternalUsdtWallet(980, 1250);

    expect(service.balance).toBe(1250);
    expect(service.getEquity()).toBe(1250);
    expect(service.peakEquity).toBe(1250);
  });

  it('does not reset historical drawdown when external balance sync happens flat', () => {
    service.peakEquity = 1200;
    service.maxDrawdownPct = 10;

    service.syncExternalUsdtWallet(950, 950);

    expect(service.balance).toBe(950);
    expect(service.peakEquity).toBe(1200);
    expect(service.maxDrawdownPct).toBeCloseTo(((1200 - 950) / 1200) * 100, 6);
  });
});
