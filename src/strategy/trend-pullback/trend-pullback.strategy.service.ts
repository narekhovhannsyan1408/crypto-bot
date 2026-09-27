import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { PositionSide } from '../../trader/types';
import {
  StrategyState,
  average,
  calculateCoreIndicators,
  pushClosedCandle,
  seedClosedCandles,
} from '../strategy-utils';
import { StrategyResult, TradingStrategy } from '../types';

@Injectable()
export class TrendPullbackStrategyService implements TradingStrategy {
  readonly id = 'trend_pullback';
  readonly name = 'Trend Pullback';

  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(
      this.config.emaSlowPeriod + 10,
      this.config.rsiPeriod + 8,
      35,
    );
  }

  getConfirmationPolicy() {
    return 'align_with_signal' as const;
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

  onNewCandle(
    candle: Candle,
    positionSide: PositionSide | null,
  ): StrategyResult {
    if (!candle.isClosed) {
      return { signal: 'HOLD', reason: 'Свеча ещё не закрыта' };
    }

    const state = this.getOrCreateState(candle.symbol, candle.interval);
    pushClosedCandle(state, candle);

    const warmupBars = this.getRequiredWarmupCandles();
    if (state.candles.length < warmupBars) {
      return {
        signal: 'HOLD',
        reason: `Прогрев trend pullback: ${state.candles.length}/${warmupBars}`,
      };
    }

    const core = calculateCoreIndicators(
      state.candles,
      this.config.emaFastPeriod,
      this.config.emaSlowPeriod,
      this.config.rsiPeriod,
    );

    if (!core) {
      return {
        signal: 'HOLD',
        reason: 'Индикаторы trend pullback ещё не готовы',
      };
    }

    const recentCloses = state.candles.slice(-6).map((item) => item.close);
    const recentMean = average(recentCloses);
    const pullbackPctToFast = (candle.close - core.emaFast) / core.emaFast;
    const pullbackPctToSlow = (candle.close - core.emaSlow) / core.emaSlow;
    const driftFromRecentMean =
      (candle.close - recentMean) / Math.max(recentMean, 1);
    const indicators = {
      ...core,
      pullbackPctToFast,
      pullbackPctToSlow,
      driftFromRecentMean,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown trend pullback: ${this.config.cooldownCandles} свечей`,
        indicators,
      };
    }

    const bullishTrend =
      core.emaFast > core.emaSlow && core.trendStrengthPct > 0.0012;
    const bearishTrend =
      core.emaFast < core.emaSlow && core.trendStrengthPct > 0.0012;
    const longPullback =
      bullishTrend &&
      pullbackPctToFast < -0.0006 &&
      pullbackPctToSlow > -0.0028 &&
      core.rsi >= 45 &&
      core.rsi <= 58;
    const shortPullback =
      bearishTrend &&
      pullbackPctToFast > 0.0006 &&
      pullbackPctToSlow < 0.0028 &&
      core.rsi <= 55 &&
      core.rsi >= 42;

    if (!positionSide) {
      if (longPullback) {
        return {
          signal: 'OPEN_LONG',
          reason:
            'Trend pullback long: откат в восходящем тренде к быстрой EMA',
          indicators,
          entryScore:
            Math.abs(pullbackPctToFast) * 12000 +
            core.trendStrengthPct * 10000 +
            Math.max(0, 58 - core.rsi),
          marketRegime: 'trend_pullback_bullish',
        };
      }

      if (shortPullback) {
        return {
          signal: 'OPEN_SHORT',
          reason:
            'Trend pullback short: откат в нисходящем тренде к быстрой EMA',
          indicators,
          entryScore:
            Math.abs(pullbackPctToFast) * 12000 +
            core.trendStrengthPct * 10000 +
            Math.max(0, core.rsi - 42),
          marketRegime: 'trend_pullback_bearish',
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Trend pullback не видит качественного отката в тренде',
        indicators,
      };
    }

    if (positionSide === 'LONG') {
      if (shortPullback && core.emaFast < core.emaSlow) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason:
            'Trend pullback: восходящий тренд сломан и сформирован bearish pullback',
          indicators,
        };
      }

      if (
        core.rsi > 64 ||
        driftFromRecentMean > 0.0035 ||
        core.emaFast < core.emaSlow
      ) {
        return {
          signal: 'CLOSE_LONG',
          reason:
            'Trend pullback закрывает long: импульс реализован или тренд ослаб',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Trend pullback удерживает long',
        indicators,
      };
    }

    if (longPullback && core.emaFast > core.emaSlow) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason:
          'Trend pullback: нисходящий тренд сломан и сформирован bullish pullback',
        indicators,
      };
    }

    if (
      core.rsi < 36 ||
      driftFromRecentMean < -0.0035 ||
      core.emaFast > core.emaSlow
    ) {
      return {
        signal: 'CLOSE_SHORT',
        reason:
          'Trend pullback закрывает short: импульс реализован или тренд ослаб',
        indicators,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Trend pullback удерживает short',
      indicators,
    };
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

    return (
      state.barsSeen - state.lastExitBarIndex <= this.config.cooldownCandles
    );
  }

  private makeKey(symbol: string, interval: string) {
    return `${symbol}:${interval}`;
  }
}
