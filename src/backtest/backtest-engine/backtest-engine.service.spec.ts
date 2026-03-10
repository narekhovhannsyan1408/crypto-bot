import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { BacktestEngineService } from './backtest-engine.service';

describe('BacktestEngineService', () => {
  let service: BacktestEngineService;

  beforeEach(async () => {
    process.env.BOT_INITIAL_BALANCE = '1000';
    process.env.BOT_POSITION_SIZE_USDT = '100';
    process.env.BOT_FEE_PCT = '0.001';
    process.env.BOT_RISK_PER_TRADE_PCT = '0.01';
    process.env.BOT_MIN_TREND_STRENGTH_PCT = '0';
    process.env.BOT_MIN_ATR_PCT = '0';
    process.env.BOT_MAX_ATR_PCT = '1';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [BacktestEngineService],
    }).compile();

    service = module.get<BacktestEngineService>(BacktestEngineService);
  });

  it('builds an equity curve from candle replay', () => {
    const candles = Array.from({ length: 40 }, (_, index) => ({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: index * 60_000,
      closeTime: index * 60_000 + 59_000,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 10,
      isClosed: true,
    }));

    const report = service.runBacktest({ candles });

    expect(report.startingBalance).toBe(1000);
    expect(report.equityCurve.length).toBeGreaterThan(0);
  });
});
