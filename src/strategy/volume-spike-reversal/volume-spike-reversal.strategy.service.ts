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
export class VolumeSpikeReversalStrategyService implements TradingStrategy {
  readonly id = 'volume_spike_reversal';
  readonly name = 'Volume Spike Reversal';

  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(
      this.config.emaSlowPeriod + 6,
      this.config.rsiPeriod + 8,
      26,
    );
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
        reason: `Прогрев volume spike reversal: ${state.candles.length}/${warmupBars}`,
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
        reason: 'Индикаторы volume spike reversal ещё не готовы',
      };
    }

    const averageVolume = average(
      state.candles.slice(-21, -1).map((item) => item.volume),
    );
    const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 1;
    const candleRange = Math.max(candle.high - candle.low, 1e-9);
    const upperWickPct =
      (candle.high - Math.max(candle.open, candle.close)) / candleRange;
    const lowerWickPct =
      (Math.min(candle.open, candle.close) - candle.low) / candleRange;
    const bodyPct = Math.abs(candle.close - candle.open) / candleRange;
    const indicators = {
      ...core,
      volumeRatio,
      upperWickPct,
      lowerWickPct,
      bodyPct,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown volume spike reversal: ${this.config.cooldownCandles} свечей`,
        indicators,
      };
    }

    const bullishReversal =
      volumeRatio > 1.8 &&
      lowerWickPct > 0.38 &&
      bodyPct < 0.52 &&
      core.rsi < 42;
    const bearishReversal =
      volumeRatio > 1.8 &&
      upperWickPct > 0.38 &&
      bodyPct < 0.52 &&
      core.rsi > 58;

    if (!positionSide) {
      if (bullishReversal) {
        return {
          signal: 'OPEN_LONG',
          reason:
            'Volume spike reversal long: всплеск объёма и выкуп нижней тени',
          indicators,
          entryScore:
            volumeRatio * 15 +
            lowerWickPct * 100 +
            Math.max(0, 42 - core.rsi) +
            Math.max(0, 0.003 - core.trendStrengthPct) * 5000,
          marketRegime: 'reversal_bullish',
        };
      }

      if (bearishReversal) {
        return {
          signal: 'OPEN_SHORT',
          reason:
            'Volume spike reversal short: всплеск объёма и продажа от верхней тени',
          indicators,
          entryScore:
            volumeRatio * 15 +
            upperWickPct * 100 +
            Math.max(0, core.rsi - 58) +
            Math.max(0, 0.003 - core.trendStrengthPct) * 5000,
          marketRegime: 'reversal_bearish',
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Volume spike reversal не видит качественную разворотную свечу',
        indicators,
      };
    }

    if (positionSide === 'LONG') {
      if (bearishReversal && core.rsi > 56) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason:
            'Volume spike reversal: рынок показал сильный bearish rejection',
          indicators,
        };
      }

      if (core.rsi > 54 || upperWickPct > 0.42) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Volume spike reversal закрывает long: откат реализован',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Volume spike reversal удерживает long',
        indicators,
      };
    }

    if (bullishReversal && core.rsi < 44) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason:
          'Volume spike reversal: рынок показал сильный bullish rejection',
        indicators,
      };
    }

    if (core.rsi < 46 || lowerWickPct > 0.42) {
      return {
        signal: 'CLOSE_SHORT',
        reason: 'Volume spike reversal закрывает short: откат реализован',
        indicators,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Volume spike reversal удерживает short',
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
