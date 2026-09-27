import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { PositionSide } from '../../trader/types';
import { StrategyResult, TradingStrategy } from '../types';
import {
  StrategyState,
  calculateCoreIndicators,
  pushClosedCandle,
  seedClosedCandles,
} from '../strategy-utils';

@Injectable()
export class MeanReversionStrategyService implements TradingStrategy {
  readonly id = 'mean_reversion';
  readonly name = 'Mean Reversion';

  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(
      this.config.emaSlowPeriod + 5,
      this.config.rsiPeriod + 5,
      25,
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
        reason: `Прогрев индикаторов стратегии mean reversion: ${state.candles.length}/${warmupBars}`,
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
        reason: 'Индикаторы mean reversion ещё не готовы',
      };
    }

    const { emaSlow, emaFast, rsi, atr, atrPct, trendStrengthPct } = core;
    const deviationPct = (candle.close - emaSlow) / emaSlow;
    const indicators = {
      emaFast,
      emaSlow,
      rsi,
      atr,
      atrPct,
      deviationPct,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown mean reversion после сделки: ${this.config.cooldownCandles} свечей`,
        indicators,
      };
    }

    if (atrPct < this.config.minAtrPct || atrPct > this.config.maxAtrPct) {
      return {
        signal: 'HOLD',
        reason:
          'Mean reversion пропускает рынок из-за неподходящей волатильности',
        indicators,
      };
    }

    const oversoldLong = deviationPct < -0.003 && rsi < 35;
    const overboughtShort = deviationPct > 0.003 && rsi > 65;
    const meanRecovered = Math.abs(deviationPct) < 0.0008;

    if (!positionSide) {
      if (oversoldLong) {
        return {
          signal: 'OPEN_LONG',
          reason:
            'Mean reversion long: цена сильно ниже среднего и RSI перепродан',
          indicators,
          entryScore:
            Math.abs(deviationPct) * 10000 +
            (35 - rsi) +
            Math.max(0, 0.006 - trendStrengthPct) * 7000,
          marketRegime: 'range_oversold',
        };
      }

      if (overboughtShort) {
        return {
          signal: 'OPEN_SHORT',
          reason:
            'Mean reversion short: цена сильно выше среднего и RSI перекуплен',
          indicators,
          entryScore:
            Math.abs(deviationPct) * 10000 +
            (rsi - 65) +
            Math.max(0, 0.006 - trendStrengthPct) * 7000,
          marketRegime: 'range_overbought',
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Mean reversion не видит экстремума',
        indicators,
      };
    }

    if (positionSide === 'LONG') {
      if (overboughtShort) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason:
            'Mean reversion: long экстремум исчерпан и сформирован short-экстремум',
          indicators,
        };
      }

      if (meanRecovered || rsi > 52) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Mean reversion закрывает long после возврата к среднему',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Mean reversion удерживает long',
        indicators,
      };
    }

    if (oversoldLong) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason:
          'Mean reversion: short экстремум исчерпан и сформирован long-экстремум',
        indicators,
      };
    }

    if (meanRecovered || rsi < 48) {
      return {
        signal: 'CLOSE_SHORT',
        reason: 'Mean reversion закрывает short после возврата к среднему',
        indicators,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Mean reversion удерживает short',
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
