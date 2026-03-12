import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { BinanceMarketService } from './binance-market.service';

jest.mock('axios');

describe('BinanceMarketService', () => {
  let service: BinanceMarketService;
  const axiosMock = axios as jest.Mocked<typeof axios>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BinanceMarketService],
    }).compile();

    service = module.get<BinanceMarketService>(BinanceMarketService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('filters out unfinished last kline during warmup', async () => {
    const now = Date.now();
    axiosMock.get.mockResolvedValueOnce({
      data: [
        [now - 180_000, '100', '101', '99', '100.5', '10', now - 120_000],
        [now - 120_000, '100.5', '102', '100', '101', '11', now - 60_000],
        [now - 60_000, '101', '103', '100.5', '102', '12', now + 60_000],
      ],
    } as never);

    const candles = await service.loadHistoricalCandles('BTCUSDT', '1m', 3);

    expect(candles).toHaveLength(2);
    expect(candles.every((candle) => candle.isClosed)).toBe(true);
    expect(candles.at(-1)?.closeTime).toBe(now - 60_000);
  });
});
