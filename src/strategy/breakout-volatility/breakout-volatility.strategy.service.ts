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
export class BreakoutVolatilityStrategyService implements TradingStrategy {
  readonly id = 'breakout_volatility';
  readonly name = 'Breakout Volatility';

  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(
      this.config.emaSlowPeriod + 8,
      this.config.rsiPeriod + 8,
      30,
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
        reason: `Прогрев breakout volatility: ${state.candles.length}/${warmupBars}`,
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
        reason: 'Индикаторы breakout volatility ещё не готовы',
      };
    }

    const lookback = 20;
    const previousCandles = state.candles.slice(0, -1);
    const breakoutHigh = highestHigh(previousCandles, lookback);
    const breakoutLow = lowestLow(previousCandles, lookback);
    const recentAtrPct = average(
      state.candles.slice(-6, -1).map((item, index, list) => {
        if (index === 0) {
          return Math.abs(item.high - item.low) / Math.max(item.close, 1);
        }
        const prevClose = list[index - 1]?.close ?? item.close;
        const tr = Math.max(
          item.high - item.low,
          Math.abs(item.high - prevClose),
          Math.abs(item.low - prevClose),
        );
        return tr / Math.max(item.close, 1);
      }),
    );
    const averageVolume = average(
      state.candles.slice(-21, -1).map((item) => item.volume),
    );
    const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 1;
    const breakoutDistancePct =
      candle.close > breakoutHigh
        ? (candle.close - breakoutHigh) / breakoutHigh
        : breakoutLow > 0
          ? (breakoutLow - candle.close) / breakoutLow
          : 0;
    const indicators = {
      ...core,
      breakoutHigh,
      breakoutLow,
      recentAtrPct,
      volumeRatio,
      breakoutDistancePct,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown breakout volatility: ${this.config.cooldownCandles} свечей`,
        indicators,
      };
    }

    const bullishBreakout =
      candle.close > breakoutHigh &&
      core.emaFast > core.emaSlow &&
      core.rsi > 56 &&
      core.atrPct >= Math.max(this.config.minAtrPct, recentAtrPct * 0.9) &&
      volumeRatio > 1.2;
    const bearishBreakout =
      candle.close < breakoutLow &&
      core.emaFast < core.emaSlow &&
      core.rsi < 44 &&
      core.atrPct >= Math.max(this.config.minAtrPct, recentAtrPct * 0.9) &&
      volumeRatio > 1.2;

    if (!positionSide) {
      if (bullishBreakout) {
        return {
          signal: 'OPEN_LONG',
          reason:
            'Breakout volatility long: цена пробила диапазон вверх на усилении объёма',
          indicators,
          entryScore:
            breakoutDistancePct * 12000 +
            volumeRatio * 12 +
            core.trendStrengthPct * 8000 +
            (core.rsi - 56),
          marketRegime: 'breakout_bullish',
        };
      }

      if (bearishBreakout) {
        return {
          signal: 'OPEN_SHORT',
          reason:
            'Breakout volatility short: цена пробила диапазон вниз на усилении объёма',
          indicators,
          entryScore:
            breakoutDistancePct * 12000 +
            volumeRatio * 12 +
            core.trendStrengthPct * 8000 +
            (44 - core.rsi),
          marketRegime: 'breakout_bearish',
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Breakout volatility не видит подтверждённого пробоя',
        indicators,
      };
    }

    if (positionSide === 'LONG') {
      if (bearishBreakout) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason:
            'Breakout volatility: bullish breakout сломан и рынок пробил вниз',
          indicators,
        };
      }

      if (candle.close < breakoutHigh || core.rsi < 50) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Breakout volatility закрывает long: пробой потерял силу',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Breakout volatility удерживает long',
        indicators,
      };
    }

    if (bullishBreakout) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason:
          'Breakout volatility: bearish breakout сломан и рынок пробил вверх',
        indicators,
      };
    }

    if (candle.close > breakoutLow || core.rsi > 50) {
      return {
        signal: 'CLOSE_SHORT',
        reason: 'Breakout volatility закрывает short: пробой потерял силу',
        indicators,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Breakout volatility удерживает short',
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
