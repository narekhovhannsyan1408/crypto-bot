import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { getBotConfig } from '../../config/bot-config';

type RawKline = [number, string, string, string, string, string, number];

export type DailyClose = {
  // openTime дня (UTC 00:00)
  day: number;
  close: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Без таймаута зависший запрос навсегда блокирует цикл бота
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Публичные рыночные данные Binance для сигналов.
 * Сигналы всегда считаются по основному рынку, даже когда ордера идут в Demo.
 */
@Injectable()
export class AllocatorMarketDataService {
  private readonly http: AxiosInstance = axios.create({
    baseURL: getBotConfig().allocator.dataRestBaseUrl,
    timeout: REQUEST_TIMEOUT_MS,
  });

  async getClosedDailyCloses(symbol: string, days: number, now = Date.now()) {
    const response = await this.http.get<RawKline[]>('/api/v3/klines', {
      params: { symbol, interval: '1d', limit: Math.min(days + 2, 1000) },
    });

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
    const prices = await this.getPrices([symbol]);
    return prices[symbol];
  }

  /** Цены нескольких символов одним запросом. */
  async getPrices(symbols: string[]) {
    const response = await this.http.get<
      Array<{ symbol: string; price: string }>
    >('/api/v3/ticker/price', { params: { symbols: JSON.stringify(symbols) } });
    const prices: Record<string, number> = {};
    for (const item of response.data) {
      const price = Number(item.price);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Некорректная цена ${item.symbol}: ${item.price}`);
      }
      prices[item.symbol] = price;
    }
    for (const symbol of symbols) {
      if (prices[symbol] === undefined) {
        throw new Error(`Binance не вернул цену ${symbol}`);
      }
    }
    return prices;
  }
}
