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
export class MarketRegimeSwitcherStrategyService implements TradingStrategy {
  readonly id = 'market_regime_switcher';
  readonly name = 'Market Regime Switcher';

  private readonly config = getBotConfig();
  private readonly states = new Map<string, StrategyState>();

  getRequiredWarmupCandles() {
    return Math.max(
      this.config.emaSlowPeriod + 10,
      this.config.rsiPeriod + 10,
      35,
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
        reason: `Прогрев market regime switcher: ${state.candles.length}/${warmupBars}`,
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
        reason: 'Индикаторы market regime switcher ещё не готовы',
      };
    }

    const lookback = 18;
    const priorCandles = state.candles.slice(0, -1);
    const regimeHigh = highestHigh(priorCandles, lookback);
    const regimeLow = lowestLow(priorCandles, lookback);
    const rangeMid = (regimeHigh + regimeLow) / 2;
    const rangeWidthPct =
      rangeMid > 0 ? (regimeHigh - regimeLow) / rangeMid : 0;
    const avgVolume = average(
      state.candles.slice(-18).map((item) => item.volume),
    );
    const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 1;
    const deviationPct =
      rangeMid > 0 ? (candle.close - rangeMid) / rangeMid : 0;
    const trendRegime =
      core.trendStrengthPct > 0.0018 && core.atrPct > this.config.minAtrPct;
    const rangeRegime = core.trendStrengthPct < 0.0012 && rangeWidthPct < 0.018;
    const regimeName = trendRegime ? 'trend' : rangeRegime ? 'range' : 'mixed';
    const indicators = {
      ...core,
      regimeHigh,
      regimeLow,
      rangeMid,
      rangeWidthPct,
      volumeRatio,
      deviationPct,
    };

    if (!positionSide && this.isInCooldown(state)) {
      return {
        signal: 'HOLD',
        reason: `Cooldown market regime switcher: ${this.config.cooldownCandles} свечей`,
        indicators,
        marketRegime: regimeName,
      };
    }

    const trendLong =
      trendRegime &&
      candle.close > regimeHigh &&
      core.emaFast > core.emaSlow &&
      core.rsi > 56 &&
      volumeRatio > 1.1;
    const trendShort =
      trendRegime &&
      candle.close < regimeLow &&
      core.emaFast < core.emaSlow &&
      core.rsi < 44 &&
      volumeRatio > 1.1;
    const rangeLong =
      rangeRegime && deviationPct < -rangeWidthPct * 0.24 && core.rsi < 40;
    const rangeShort =
      rangeRegime && deviationPct > rangeWidthPct * 0.24 && core.rsi > 60;

    if (!positionSide) {
      if (trendLong || rangeLong) {
        return {
          signal: 'OPEN_LONG',
          reason: trendLong
            ? 'Market regime switcher выбрал trend-following long'
            : 'Market regime switcher выбрал mean-reversion long',
          indicators,
          entryScore: trendLong
            ? core.trendStrengthPct * 12000 + volumeRatio * 10 + (core.rsi - 56)
            : Math.abs(deviationPct) * 12000 + Math.max(0, 40 - core.rsi) + 20,
          marketRegime: trendLong
            ? 'adaptive_trend_bullish'
            : 'adaptive_range_bullish',
        };
      }

      if (trendShort || rangeShort) {
        return {
          signal: 'OPEN_SHORT',
          reason: trendShort
            ? 'Market regime switcher выбрал trend-following short'
            : 'Market regime switcher выбрал mean-reversion short',
          indicators,
          entryScore: trendShort
            ? core.trendStrengthPct * 12000 + volumeRatio * 10 + (44 - core.rsi)
            : Math.abs(deviationPct) * 12000 + Math.max(0, core.rsi - 60) + 20,
          marketRegime: trendShort
            ? 'adaptive_trend_bearish'
            : 'adaptive_range_bearish',
        };
      }

      return {
        signal: 'HOLD',
        reason: `Market regime switcher не видит качественную сделку в режиме ${regimeName}`,
        indicators,
        marketRegime: regimeName,
      };
    }

    if (positionSide === 'LONG') {
      if (trendShort || rangeShort) {
        return {
          signal: 'REVERSE_TO_SHORT',
          reason: 'Market regime switcher видит смену режима и сигнал на short',
          indicators,
          marketRegime: regimeName,
        };
      }

      if (
        (trendRegime && core.rsi < 49) ||
        (rangeRegime && candle.close >= rangeMid)
      ) {
        return {
          signal: 'CLOSE_LONG',
          reason:
            'Market regime switcher закрывает long по завершению сценария',
          indicators,
          marketRegime: regimeName,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Market regime switcher удерживает long',
        indicators,
        marketRegime: regimeName,
      };
    }

    if (trendLong || rangeLong) {
      return {
        signal: 'REVERSE_TO_LONG',
        reason: 'Market regime switcher видит смену режима и сигнал на long',
        indicators,
        marketRegime: regimeName,
      };
    }

    if (
      (trendRegime && core.rsi > 51) ||
      (rangeRegime && candle.close <= rangeMid)
    ) {
      return {
        signal: 'CLOSE_SHORT',
        reason: 'Market regime switcher закрывает short по завершению сценария',
        indicators,
        marketRegime: regimeName,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Market regime switcher удерживает short',
      indicators,
      marketRegime: regimeName,
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
