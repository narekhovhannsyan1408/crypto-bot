import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getBotConfig } from '../config/bot-config';

type RawKline = [number, string, string, string, string, string, number];

export type DailyClose = {
  // openTime дня (UTC 00:00)
  day: number;
  close: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Публичные рыночные данные Binance для сигналов аллокатора.
 * Сигналы всегда считаются по основному рынку, даже когда ордера идут в Demo.
 */
@Injectable()
export class AllocatorMarketDataService {
  private readonly config = getBotConfig();

  async getClosedDailyCloses(symbol: string, days: number, now = Date.now()) {
    const response = await axios.get<RawKline[]>(
      `${this.config.allocator.dataRestBaseUrl}/api/v3/klines`,
      { params: { symbol, interval: '1d', limit: Math.min(days + 2, 1000) } },
    );

    return response.data
      .filter((kline) => kline[6] < now)
      .map(
        (kline): DailyClose => ({
          day: Math.floor(kline[0] / DAY_MS) * DAY_MS,
          close: Number(kline[4]),
        }),
      )
      .slice(-days);
  }

  async getPrice(symbol: string) {
    const response = await axios.get<{ price: string }>(
      `${this.config.allocator.dataRestBaseUrl}/api/v3/ticker/price`,
      { params: { symbol } },
    );
    const price = Number(response.data.price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Некорректная цена ${symbol}: ${response.data.price}`);
    }

    return price;
  }
}
