import { Injectable } from '@nestjs/common';
import { EMA } from 'technicalindicators';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';

type ConfirmationTrend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

type ConfirmationState = {
  candles: Candle[];
  trend: ConfirmationTrend;
  emaFast?: number;
  emaSlow?: number;
  trendStrengthPct?: number;
  updatedAt?: number;
};

export type ConfirmationSnapshot = {
  isReady: boolean;
  trend: ConfirmationTrend;
  emaFast?: number;
  emaSlow?: number;
  trendStrengthPct?: number;
  updatedAt?: number;
};

@Injectable()
export class HigherTimeframeConfirmationService {
  private readonly config = getBotConfig();
  private readonly states = new Map<string, ConfirmationState>();

  getRequiredWarmupCandles() {
    return Math.max(this.config.emaSlowPeriod + 1, 20);
  }

  seedHistory(symbol: string, interval: string, candles: Candle[]) {
    const closedCandles = candles.filter((candle) => candle.isClosed).slice(-500);
    const state: ConfirmationState = {
      candles: closedCandles,
      trend: 'NEUTRAL',
    };

    this.computeTrend(state);
    this.states.set(this.makeKey(symbol, interval), state);
  }

  resetSymbol(symbol: string, interval: string) {
    this.states.delete(this.makeKey(symbol, interval));
  }

  onNewCandle(candle: Candle): ConfirmationSnapshot {
    const state = this.getOrCreateState(candle.symbol, candle.interval);
    const lastCandle = state.candles.at(-1);

    if (lastCandle?.closeTime === candle.closeTime) {
      state.candles[state.candles.length - 1] = candle;
    } else {
      state.candles.push(candle);
    }

    if (state.candles.length > 500) {
      state.candles.shift();
    }

    state.updatedAt = candle.closeTime;
    this.computeTrend(state);
    return this.toSnapshot(state);
  }

  getTrend(symbol: string, interval: string): ConfirmationSnapshot {
    const state = this.states.get(this.makeKey(symbol, interval));
    if (!state) {
      return {
        isReady: false,
        trend: 'NEUTRAL',
      };
    }

    return this.toSnapshot(state);
  }

  private getOrCreateState(symbol: string, interval: string) {
    const key = this.makeKey(symbol, interval);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }

    const state: ConfirmationState = {
      candles: [],
      trend: 'NEUTRAL',
    };
    this.states.set(key, state);
    return state;
  }

  private computeTrend(state: ConfirmationState) {
    if (state.candles.length < this.getRequiredWarmupCandles()) {
      state.trend = 'NEUTRAL';
      state.emaFast = undefined;
      state.emaSlow = undefined;
      state.trendStrengthPct = undefined;
      return;
    }

    const closes = state.candles.map((item) => item.close);
    const emaFast = EMA.calculate({
      period: this.config.emaFastPeriod,
      values: closes,
    }).at(-1);
    const emaSlow = EMA.calculate({
      period: this.config.emaSlowPeriod,
      values: closes,
    }).at(-1);

    if (emaFast === undefined || emaSlow === undefined) {
      state.trend = 'NEUTRAL';
      state.emaFast = undefined;
      state.emaSlow = undefined;
      state.trendStrengthPct = undefined;
      return;
    }

    const lastClose = closes.at(-1) ?? 0;
    const trendStrengthPct = lastClose > 0 ? Math.abs(emaFast - emaSlow) / lastClose : 0;

    state.emaFast = emaFast;
    state.emaSlow = emaSlow;
    state.trendStrengthPct = trendStrengthPct;

    if (trendStrengthPct < this.config.minTrendStrengthPct) {
      state.trend = 'NEUTRAL';
      return;
    }

    if (emaFast > emaSlow) {
      state.trend = 'BULLISH';
      return;
    }

    if (emaFast < emaSlow) {
      state.trend = 'BEARISH';
      return;
    }

    state.trend = 'NEUTRAL';
  }

  private toSnapshot(state: ConfirmationState): ConfirmationSnapshot {
    return {
      isReady: state.candles.length >= this.getRequiredWarmupCandles(),
      trend: state.trend,
      emaFast: state.emaFast,
      emaSlow: state.emaSlow,
      trendStrengthPct: state.trendStrengthPct,
      updatedAt: state.updatedAt,
    };
  }

  private makeKey(symbol: string, interval: string) {
    return `${symbol}:${interval}`;
  }
}
