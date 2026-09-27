import { TradeSignal } from '../market/types';
import { PositionSide } from '../trader/types';
import { StrategyResult, TradingStrategy } from '../strategy/types';

// Детерминированный генератор, чтобы прогоны baseline были воспроизводимыми
const createSeededRandom = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
};

/**
 * Стратегия-"монетка": входит в случайную сторону с заданной вероятностью на свечу.
 * Выходы остаются общими (стопы, тейк, трейлинг, time stop), поэтому сравнение с ней
 * показывает, дают ли сигналы настоящей стратегии что-то сверх случайного входа.
 */
export const createRandomEntryStrategy = (
  id: string,
  seed: number,
  entryProbability: number,
): TradingStrategy => {
  const random = createSeededRandom(seed);

  return {
    id,
    name: `Random baseline ${id}`,
    getRequiredWarmupCandles: () => 0,
    getConfirmationPolicy: () => 'none',
    seedHistory: () => undefined,
    resetSymbol: () => undefined,
    registerTradeClosed: () => undefined,
    onNewCandle: (_candle, positionSide): StrategyResult => {
      if (positionSide) {
        return { signal: 'HOLD', reason: 'Random baseline держит позицию' };
      }

      const roll = random();
      if (roll < entryProbability / 2) {
        return {
          signal: 'OPEN_LONG',
          reason: 'Random baseline long',
          entryScore: 0,
        };
      }
      if (roll < entryProbability) {
        return {
          signal: 'OPEN_SHORT',
          reason: 'Random baseline short',
          entryScore: 0,
        };
      }

      return { signal: 'HOLD', reason: 'Random baseline ждёт' };
    },
  };
};

const invertedSignals: Record<TradeSignal, TradeSignal> = {
  OPEN_LONG: 'OPEN_SHORT',
  OPEN_SHORT: 'OPEN_LONG',
  CLOSE_LONG: 'CLOSE_SHORT',
  CLOSE_SHORT: 'CLOSE_LONG',
  REVERSE_TO_LONG: 'REVERSE_TO_SHORT',
  REVERSE_TO_SHORT: 'REVERSE_TO_LONG',
  HOLD: 'HOLD',
};

/**
 * Разворачивает сигналы стратегии (long <-> short). Если у сигналов есть реальное
 * преимущество, инвертированная версия должна торговать заметно хуже оригинала.
 */
export const invertStrategy = (strategy: TradingStrategy): TradingStrategy => ({
  id: strategy.id,
  name: `${strategy.name} (inverted)`,
  getRequiredWarmupCandles: () => strategy.getRequiredWarmupCandles(),
  getConfirmationPolicy: () => strategy.getConfirmationPolicy(),
  seedHistory: (symbol, interval, candles) =>
    strategy.seedHistory(symbol, interval, candles),
  resetSymbol: (symbol, interval) => strategy.resetSymbol(symbol, interval),
  registerTradeClosed: (symbol, interval) =>
    strategy.registerTradeClosed(symbol, interval),
  onNewCandle: (candle, positionSide): StrategyResult => {
    const originalSide: PositionSide | null =
      positionSide === 'LONG'
        ? 'SHORT'
        : positionSide === 'SHORT'
          ? 'LONG'
          : null;
    const result = strategy.onNewCandle(candle, originalSide);

    return { ...result, signal: invertedSignals[result.signal] };
  },
});
