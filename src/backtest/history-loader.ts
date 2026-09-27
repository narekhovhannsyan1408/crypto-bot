import axios from 'axios';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { intervalToMs } from '../config/bot-config';
import { Candle } from '../market/types';

type RawKline = [number, string, string, string, string, string, number];

const KLINES_PAGE_LIMIT = 1000;

export type HistoryRequest = {
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  restBaseUrl: string;
  cacheDir: string;
};

/**
 * Загружает закрытые свечи с публичного REST Binance постранично и кэширует их на диск,
 * чтобы повторные прогоны бэктеста не качали историю заново.
 */
export const loadHistoricalCandles = async (
  request: HistoryRequest,
): Promise<Candle[]> => {
  const { symbol, interval, startTime, endTime, restBaseUrl, cacheDir } =
    request;
  const cacheFile = join(
    cacheDir,
    `${symbol}_${interval}_${startTime}_${endTime}.json`,
  );

  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as Candle[];
  }

  const intervalMs = intervalToMs(interval);
  const candles: Candle[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const response = await axios.get<RawKline[]>(
      `${restBaseUrl}/api/v3/klines`,
      {
        params: {
          symbol,
          interval,
          startTime: cursor,
          endTime,
          limit: KLINES_PAGE_LIMIT,
        },
      },
    );
    const page = response.data;

    if (page.length === 0) {
      break;
    }

    for (const kline of page) {
      if (kline[6] >= endTime) {
        continue;
      }

      candles.push({
        symbol,
        interval,
        openTime: kline[0],
        closeTime: kline[6],
        open: Number(kline[1]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        volume: Number(kline[5]),
        isClosed: true,
      });
    }

    cursor = page[page.length - 1][0] + intervalMs;
  }

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(candles));

  return candles;
};
