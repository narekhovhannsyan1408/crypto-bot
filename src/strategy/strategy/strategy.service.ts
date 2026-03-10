import { Injectable } from '@nestjs/common';
import { ATR, EMA, RSI } from 'technicalindicators';
import { getBotConfig } from '../../config/bot-config';
import { Candle, TradeSignal } from '../../market/types';
import { PositionSide } from '../../trader/types';

type StrategyState = {
  candles: Candle[];
  barsSeen: number;
  lastExitBarIndex: number | null;
};

type StrategyIndicators = {
  emaFast: number;
  emaSlow: number;
  rsi: number;
  atr: number;
  atrPct: number;
  trendStrengthPct: number;
};

@Injectable()
export class StrategyService {
  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  seedHistory(symbol: string, interval: string, candles: Candle[]) {
    const closedCandles = candles.filter((candle) => candle.isClosed).slice(-500);

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
  ): {
    signal: TradeSignal;
    reason: string;
    indicators?: StrategyIndicators;
  } {
    if (!candle.isClosed) {
      return { signal: 'HOLD', reason: 'Свеча ещё не закрыта' };
    }

    const state = this.getOrCreateState(candle.symbol, candle.interval);
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

    const closes = state.candles.map((item) => item.close);
    const highs = state.candles.map((item) => item.high);
    const lows = state.candles.map((item) => item.low);

    const warmupBars = Math.max(
      this.config.emaSlowPeriod + 1,
      this.config.rsiPeriod + 1,
      15,
    );

    if (closes.length < warmupBars) {
      return {
        signal: 'HOLD',
        reason: `Прогрев индикаторов: ${closes.length}/${warmupBars}`,
      };
    }

    const emaFast = EMA.calculate({
      period: this.config.emaFastPeriod,
      values: closes,
    }).at(-1);
    const emaSlow = EMA.calculate({
      period: this.config.emaSlowPeriod,
      values: closes,
    }).at(-1);
    const rsi = RSI.calculate({
      period: this.config.rsiPeriod,
      values: closes,
    }).at(-1);
    const atr = ATR.calculate({
      period: 14,
      high: highs,
      low: lows,
      close: closes,
    }).at(-1);

    if (
      emaFast === undefined ||
      emaSlow === undefined ||
      rsi === undefined ||
      atr === undefined
    ) {
      return { signal: 'HOLD', reason: 'Индикаторы ещё не готовы' };
    }

    const atrPct = atr / candle.close;
    const trendStrengthPct = Math.abs(emaFast - emaSlow) / candle.close;
    const indicators: StrategyIndicators = {
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
        };
      }

      if (bearishEntry) {
        return {
          signal: 'OPEN_SHORT',
          reason: 'Short: fast EMA ниже slow EMA, RSI подтверждает импульс',
          indicators,
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
