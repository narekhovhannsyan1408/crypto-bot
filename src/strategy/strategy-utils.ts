import { ATR, EMA, RSI } from 'technicalindicators';
import { Candle } from '../market/types';

export type StrategyState = {
  candles: Candle[];
  barsSeen: number;
  lastExitBarIndex: number | null;
};

export type CoreIndicators = {
  emaFast: number;
  emaSlow: number;
  rsi: number;
  atr: number;
  atrPct: number;
  trendStrengthPct: number;
  close: number;
  volume: number;
};

export const seedClosedCandles = (candles: Candle[]) =>
  candles.filter((candle) => candle.isClosed).slice(-500);

export const pushClosedCandle = (state: StrategyState, candle: Candle) => {
  const lastCandle = state.candles.at(-1);

  if (lastCandle?.closeTime === candle.closeTime) {
    state.candles[state.candles.length - 1] = candle;
  } else {
    state.candles.push(candle);
    state.barsSeen += 1;
  }

  if (state.candles.length > 500) {
    state.candles.shift();
  }
};

export const calculateCoreIndicators = (
  candles: Candle[],
  emaFastPeriod: number,
  emaSlowPeriod: number,
  rsiPeriod: number,
): CoreIndicators | null => {
  const closes = candles.map((item) => item.close);
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);

  const emaFast = EMA.calculate({
    period: emaFastPeriod,
    values: closes,
  }).at(-1);
  const emaSlow = EMA.calculate({
    period: emaSlowPeriod,
    values: closes,
  }).at(-1);
  const rsi = RSI.calculate({
    period: rsiPeriod,
    values: closes,
  }).at(-1);
  const atr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes,
  }).at(-1);

  const close = closes.at(-1);
  const volume = candles.at(-1)?.volume;

  if (
    emaFast === undefined ||
    emaSlow === undefined ||
    rsi === undefined ||
    atr === undefined ||
    close === undefined ||
    volume === undefined
  ) {
    return null;
  }

  return {
    emaFast,
    emaSlow,
    rsi,
    atr,
    atrPct: close > 0 ? atr / close : 0,
    trendStrengthPct: close > 0 ? Math.abs(emaFast - emaSlow) / close : 0,
    close,
    volume,
  };
};

export const average = (values: number[]) => {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const highestHigh = (candles: Candle[], lookback: number) =>
  Math.max(...candles.slice(-lookback).map((candle) => candle.high));

export const lowestLow = (candles: Candle[], lookback: number) =>
  Math.min(...candles.slice(-lookback).map((candle) => candle.low));
