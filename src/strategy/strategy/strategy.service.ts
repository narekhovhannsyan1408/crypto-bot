import { Injectable } from '@nestjs/common';
import { EMA, RSI } from 'technicalindicators';
import { Candle, TradeSignal } from '../../market/types';

type PositionSide = 'LONG' | 'SHORT' | null;

@Injectable()
export class StrategyService {
  private candles: Candle[] = [];

  onNewCandle(
    candle: Candle,
    positionSide: PositionSide,
  ): {
    signal: TradeSignal;
    reason: string;
    indicators?: { ema9: number; ema21: number; rsi14: number };
  } {
    if (!candle.isClosed) {
      return { signal: 'HOLD', reason: 'Свеча ещё не закрыта' };
    }

    this.candles.push(candle);

    if (this.candles.length > 300) {
      this.candles.shift();
    }

    const closes = this.candles.map((c) => c.close);

    if (closes.length < 22) {
      return {
        signal: 'HOLD',
        reason: `Прогрев индикаторов: ${closes.length}/22`,
      };
    }

    const ema9Arr = EMA.calculate({ period: 9, values: closes });
    const ema21Arr = EMA.calculate({ period: 21, values: closes });
    const rsi14Arr = RSI.calculate({ period: 14, values: closes });

    const ema9 = ema9Arr.at(-1);
    const ema21 = ema21Arr.at(-1);
    const rsi14 = rsi14Arr.at(-1);

    if (ema9 === undefined || ema21 === undefined || rsi14 === undefined) {
      return { signal: 'HOLD', reason: 'Индикаторы ещё не готовы' };
    }

    const indicators = { ema9, ema21, rsi14 };

    if (!positionSide) {
      if (ema9 > ema21 && rsi14 > 55) {
        return {
          signal: 'OPEN_LONG',
          reason: 'Открытие лонга: EMA9 выше EMA21 и RSI14 выше 55',
          indicators,
        };
      }

      if (ema9 < ema21 && rsi14 < 45) {
        return {
          signal: 'OPEN_SHORT',
          reason: 'Открытие шорта: EMA9 ниже EMA21 и RSI14 ниже 45',
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
      if (ema9 < ema21) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Закрытие лонга: EMA9 пересекла EMA21 сверху вниз',
          indicators,
        };
      }

      if (rsi14 < 45) {
        return {
          signal: 'CLOSE_LONG',
          reason: 'Закрытие лонга: RSI14 опустился ниже 45',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Держим лонг',
        indicators,
      };
    }

    if (positionSide === 'SHORT') {
      if (ema9 > ema21) {
        return {
          signal: 'CLOSE_SHORT',
          reason: 'Закрытие шорта: EMA9 пересекла EMA21 снизу вверх',
          indicators,
        };
      }

      if (rsi14 > 55) {
        return {
          signal: 'CLOSE_SHORT',
          reason: 'Закрытие шорта: RSI14 поднялся выше 55',
          indicators,
        };
      }

      return {
        signal: 'HOLD',
        reason: 'Держим шорт',
        indicators,
      };
    }

    return {
      signal: 'HOLD',
      reason: 'Нет сигнала',
      indicators,
    };
  }
}
