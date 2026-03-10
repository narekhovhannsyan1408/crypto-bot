import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { PositionSide } from '../../trader/types';
import { TradingStrategy, StrategyResult } from '../types';
import {
  StrategyState,
  calculateCoreIndicators,
  pushClosedCandle,
  seedClosedCandles,
} from '../strategy-utils';

@Injectable()
export class StrategyService implements TradingStrategy {
  readonly id = 'momentum_trend';
  readonly name = 'Momentum Trend';
  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(this.config.emaSlowPeriod + 1, this.config.rsiPeriod + 1, 15);
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
        reason: `Прогрев индикаторов: ${state.candles.length}/${warmupBars}`,
      };
    }

    const core = calculateCoreIndicators(
      state.candles,
      this.config.emaFastPeriod,
      this.config.emaSlowPeriod,
      this.config.rsiPeriod,
    );

    if (!core) {
      return { signal: 'HOLD', reason: 'Индикаторы ещё не готовы' };
    }

    const { emaFast, emaSlow, rsi, atr, atrPct, trendStrengthPct } = core;
    const indicators = {
      emaFast,
      emaSlow,
      rsi,
      atr,
      atrPct,
      trendStrengthPct,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown после сделки: ${this.config.cooldownCandles} свечей`,
        indicators,
      };
    }

    if (atrPct < this.config.minAtrPct) {
      return {
        signal: 'HOLD',
        reason: 'Слишком низкая волатильность для входа',
        indicators,
      };
    }

    if (atrPct > this.config.maxAtrPct) {
      return {
        signal: 'HOLD',
        reason: 'Слишком высокая волатильность, пропускаем вход',
        indicators,
      };
    }

    if (trendStrengthPct < this.config.minTrendStrengthPct) {
      return {
        signal: 'HOLD',
        reason: 'Тренд слишком слабый',
        indicators,
      };
    }

    const bullishEntry =
      emaFast > emaSlow && rsi > this.config.rsiLongThreshold;
    const bearishEntry =
      emaFast < emaSlow && rsi < this.config.rsiShortThreshold;

    if (!positionSide) {
      if (bullishEntry) {
        return {
          signal: 'OPEN_LONG',
          reason: 'Long: fast EMA выше slow EMA, RSI подтверждает импульс',
          indicators,
          entryScore:
            (rsi - this.config.rsiLongThreshold) +
            trendStrengthPct * 12000 +
            atrPct * 5000,
          marketRegime: 'trend_bullish',
        };
      }

      if (bearishEntry) {
        return {
          signal: 'OPEN_SHORT',
          reason: 'Short: fast EMA ниже slow EMA, RSI подтверждает импульс',
          indicators,
          entryScore:
            (this.config.rsiShortThreshold - rsi) +
            trendStrengthPct * 12000 +
            atrPct * 5000,
          marketRegime: 'trend_bearish',
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Нет сигнала на вход',
        indicators,
      };
    }

    if (positionSide === 'LONG') {
      if (bearishEntry) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason: 'Переворот: bullish regime сломан и сформирован bearish impulse',
          indicators,
        };
      }

      if (emaFast < emaSlow || rsi < this.config.rsiShortThreshold) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Закрытие лонга: импульс ослаб и структура стала bearish',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Держим лонг',
        indicators,
      };
    }

    if (bullishEntry) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason: 'Переворот: bearish regime сломан и сформирован bullish impulse',
        indicators,
      };
    }

    if (emaFast > emaSlow || rsi > this.config.rsiLongThreshold) {
      return {
        signal: 'CLOSE_SHORT',
        reason: 'Закрытие шорта: импульс ослаб и структура стала bullish',
        indicators,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Держим шорт',
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

    return state.barsSeen - state.lastExitBarIndex <= this.config.cooldownCandles;
  }

  private makeKey(symbol: string, interval: string) {
    return `${symbol}:${interval}`;
  }
}
