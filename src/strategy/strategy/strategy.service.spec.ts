import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { StrategyService } from './strategy.service';

describe('StrategyService', () => {
  let service: StrategyService;

  beforeEach(async () => {
    process.env.BOT_EMA_FAST_PERIOD = '9';
    process.env.BOT_EMA_SLOW_PERIOD = '21';
    process.env.BOT_RSI_PERIOD = '14';
    process.env.BOT_RSI_LONG_THRESHOLD = '55';
    process.env.BOT_RSI_SHORT_THRESHOLD = '45';
    process.env.BOT_RSI_LONG_MAX_ENTRY = '68';
    process.env.BOT_RSI_SHORT_MIN_ENTRY = '32';
    process.env.BOT_MOMENTUM_MAX_EMA_STRETCH_PCT = '0.0022';
    process.env.BOT_MIN_TREND_STRENGTH_PCT = '0';
    process.env.BOT_MIN_ATR_PCT = '0';
    process.env.BOT_MAX_ATR_PCT = '1';
    process.env.BOT_COOLDOWN_CANDLES = '2';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [StrategyService],
    }).compile();

    service = module.get<StrategyService>(StrategyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('keeps indicator history isolated per symbol', () => {
    service.seedHistory('BTCUSDT', '1m', buildTrendCandles('BTCUSDT', 100, 1));
    service.seedHistory('ETHUSDT', '1m', buildTrendCandles('ETHUSDT', 200, -1));

    const btcResult = service.onNewCandle(
      buildSingleCandle('BTCUSDT', 10_000, 130, 131, 129, 131),
      null,
    );
    const ethResult = service.onNewCandle(
      buildSingleCandle('ETHUSDT', 10_000, 170, 171, 168, 168),
      null,
    );

    expect(btcResult.signal).toBe('OPEN_LONG');
    expect(ethResult.signal).toBe('OPEN_SHORT');
  });

  it('enforces cooldown after a close', () => {
    service.seedHistory('BTCUSDT', '1m', buildTrendCandles('BTCUSDT', 100, 1));
    service.registerTradeClosed('BTCUSDT', '1m');

    const result = service.onNewCandle(
      buildSingleCandle('BTCUSDT', 10_000, 130, 131, 129, 131),
      null,
    );

    expect(result.signal).toBe('HOLD');
    expect(result.reason).toContain('Cooldown');
  });

  it('skips overheated long entries with too high RSI', () => {
    service.seedHistory('BTCUSDT', '1m', buildTrendCandles('BTCUSDT', 100, 1));

    const result = service.onNewCandle(
      buildSingleCandle('BTCUSDT', 10_000, 140, 145, 139, 145),
      null,
    );

    expect(result.signal).toBe('HOLD');
    expect(result.reason).toContain('перегрет');
  });

  it('skips stretched long entries far from fast EMA', async () => {
    process.env.BOT_RSI_LONG_MAX_ENTRY = '90';
    process.env.BOT_MOMENTUM_MAX_EMA_STRETCH_PCT = '0.001';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [StrategyService],
    }).compile();
    const stretchedService = module.get<StrategyService>(StrategyService);
    stretchedService.seedHistory(
      'BTCUSDT',
      '1m',
      buildTrendCandles('BTCUSDT', 100, 1),
    );

    const result = stretchedService.onNewCandle(
      buildSingleCandle('BTCUSDT', 10_000, 130, 138, 129, 137),
      null,
    );

    expect(result.signal).toBe('HOLD');
    expect(result.reason).toContain('слишком далеко ушёл от EMA');
  });
});

function buildTrendCandles(symbol: string, startPrice: number, step: number) {
  return Array.from({ length: 40 }, (_, index) =>
    buildSingleCandle(
      symbol,
      index * 60_000,
      startPrice + step * index,
      startPrice + step * index + 1,
      startPrice + step * index - 1,
      startPrice + step * index + step,
    ),
  );
}

function buildSingleCandle(
  symbol: string,
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  return {
    symbol,
    interval: '1m',
    openTime,
    closeTime: openTime + 59_000,
    open,
    high,
    low,
    close,
    volume: 100,
    isClosed: true,
  };
}
