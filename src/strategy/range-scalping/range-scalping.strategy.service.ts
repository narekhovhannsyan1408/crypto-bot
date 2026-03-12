import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { PositionSide } from '../../trader/types';
import {
  StrategyState,
  average,
  calculateCoreIndicators,
  highestHigh,
  lowestLow,
  pushClosedCandle,
  seedClosedCandles,
} from '../strategy-utils';
import { StrategyResult, TradingStrategy } from '../types';

@Injectable()
export class RangeScalpingStrategyService implements TradingStrategy {
  readonly id = 'range_scalping';
  readonly name = 'Range Scalping';

  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(this.config.emaSlowPeriod + 6, this.config.rsiPeriod + 6, 28);
  }

  getConfirmationPolicy() {
    return 'none' as const;
  }

  seedHistory(symbol: string, interval: string, candles: Candle[]) {
    const closedCandles = seedClosedCandles(candles);
    this.states.set(this.makeKey(symbol, interval), {
      candles: closedCandles,
      barsSeen: closedCandles.length,
      lastExitBarIndex: null,
    });
  }

  resetSymbol(symbol: string, interval: string) {
    this.states.delete(this.makeKey(symbol, interval));
  }

  registerTradeClosed(symbol: string, interval: string) {
    const state = this.getOrCreateState(symbol, interval);
    state.lastExitBarIndex = state.barsSeen;
  }

  onNewCandle(candle: Candle, positionSide: PositionSide | null): StrategyResult {
    if (!candle.isClosed) {
      return { signal: 'HOLD', reason: 'Свеча ещё не закрыта' };
    }

    const state = this.getOrCreateState(candle.symbol, candle.interval);
    pushClosedCandle(state, candle);

    const warmupBars = this.getRequiredWarmupCandles();
    if (state.candles.length < warmupBars) {
      return {
        signal: 'HOLD',
        reason: `Прогрев range scalping: ${state.candles.length}/${warmupBars}`,
      };
    }

    const core = calculateCoreIndicators(
      state.candles,
      this.config.emaFastPeriod,
      this.config.emaSlowPeriod,
      this.config.rsiPeriod,
    );

    if (!core) {
      return { signal: 'HOLD', reason: 'Индикаторы range scalping ещё не готовы' };
    }

    const priorCandles = state.candles.slice(0, -1);
    const rangeLookback = 18;
    const rangeHigh = highestHigh(priorCandles, rangeLookback);
    const rangeLow = lowestLow(priorCandles, rangeLookback);
    const rangeMid = (rangeHigh + rangeLow) / 2;
    const rangeWidthPct = rangeMid > 0 ? (rangeHigh - rangeLow) / rangeMid : 0;
    const distanceToLowPct = rangeLow > 0 ? (candle.close - rangeLow) / rangeLow : 0;
    const distanceToHighPct = rangeHigh > 0 ? (rangeHigh - candle.close) / rangeHigh : 0;
    const recentVolumes = priorCandles.slice(-10).map((item) => item.volume);
    const averageRecentVolume = average(recentVolumes);
    const volumeCompression =
      averageRecentVolume > 0 ? candle.volume / averageRecentVolume : 1;
    const indicators = {
      ...core,
      rangeHigh,
      rangeLow,
      rangeMid,
      rangeWidthPct,
      distanceToLowPct,
      distanceToHighPct,
      volumeCompression,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown range scalping: ${this.config.cooldownCandles} свечей`,
        indicators,
      };
    }

    const lowTrend = core.trendStrengthPct < 0.0014;
    const stableVolatility = core.atrPct >= this.config.minAtrPct * 0.7 && core.atrPct <= 0.007;
    const insideRange = rangeWidthPct > 0.002 && rangeWidthPct < 0.02;
    const quietEnough = volumeCompression < 1.35;
    const longBounceCandidate =
      lowTrend &&
      stableVolatility &&
      insideRange &&
      quietEnough &&
      distanceToLowPct < 0.0025 &&
      core.rsi < 41;
    const shortBounceCandidate =
      lowTrend &&
      stableVolatility &&
      insideRange &&
      quietEnough &&
      distanceToHighPct < 0.0025 &&
      core.rsi > 59;

    if (!positionSide) {
      if (longBounceCandidate) {
        return {
          signal: 'OPEN_LONG',
          reason: 'Range scalping long: цена у нижней границы диапазона и рынок без выраженного тренда',
          indicators,
          entryScore:
            Math.max(0, 0.0025 - distanceToLowPct) * 15000 +
            Math.max(0, 41 - core.rsi) +
            Math.max(0, 0.002 - core.trendStrengthPct) * 7000,
          marketRegime: 'range_low',
        };
      }

      if (shortBounceCandidate) {
        return {
          signal: 'OPEN_SHORT',
          reason: 'Range scalping short: цена у верхней границы диапазона и рынок без выраженного тренда',
          indicators,
          entryScore:
            Math.max(0, 0.0025 - distanceToHighPct) * 15000 +
            Math.max(0, core.rsi - 59) +
            Math.max(0, 0.002 - core.trendStrengthPct) * 7000,
          marketRegime: 'range_high',
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Range scalping не видит качественную работу от границы диапазона',
        indicators,
      };
    }

    if (positionSide === 'LONG') {
      if (shortBounceCandidate && candle.close > rangeMid) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason: 'Range scalping: нижняя граница отработала и цена дошла до противоположной зоны',
          indicators,
        };
      }

      if (candle.close >= rangeMid || core.rsi > 52 || !insideRange) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Range scalping фиксирует long у середины диапазона или при сломе флэта',
          indicators,
        };
      }

      return { signal: 'HOLD', reason: 'Range scalping удерживает long', indicators };
    }

    if (longBounceCandidate && candle.close < rangeMid) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason: 'Range scalping: верхняя граница отработала и цена дошла до противоположной зоны',
        indicators,
      };
    }

    if (candle.close <= rangeMid || core.rsi < 48 || !insideRange) {
      return {
        signal: 'CLOSE_SHORT',
        reason: 'Range scalping фиксирует short у середины диапазона или при сломе флэта',
        indicators,
      };
    }

    return { signal: 'HOLD', reason: 'Range scalping удерживает short', indicators };
  }

  private getOrCreateState(symbol: string, interval: string) {
    const key = this.makeKey(symbol, interval);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }

    const state: StrategyState = {
      candles: [],
      barsSeen: 0,
      lastExitBarIndex: null,
    };
    this.states.set(key, state);
    return state;
  }

  private isInCooldown(state: StrategyState) {
    if (state.lastExitBarIndex === null) {
      return false;
    }

    return state.barsSeen - state.lastExitBarIndex <= this.config.cooldownCandles;
  }

  private makeKey(symbol: string, interval: string) {
    return `${symbol}:${interval}`;
  }
}
