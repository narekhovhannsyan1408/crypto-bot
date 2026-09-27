import { Candle } from '../market/types';
import { StrategyResult, TradingStrategy } from '../strategy/types';
import {
  createRandomEntryStrategy,
  invertStrategy,
} from './baseline-strategies';

const candle: Candle = {
  symbol: 'BTCUSDT',
  interval: '5m',
  openTime: 0,
  closeTime: 299_999,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
  isClosed: true,
};

const fixedStrategy = (result: StrategyResult) => {
  const seenSides: Array<'LONG' | 'SHORT' | null> = [];
  const strategy: TradingStrategy = {
    id: 'fixed',
    name: 'Fixed',
    getRequiredWarmupCandles: () => 5,
    getConfirmationPolicy: () => 'align_with_signal',
    seedHistory: () => undefined,
    resetSymbol: () => undefined,
    registerTradeClosed: () => undefined,
    onNewCandle: (_candle, side) => {
      seenSides.push(side);
      return result;
    },
  };
  return { strategy, seenSides };
};

describe('baseline strategies', () => {
  it('inverts entry direction and passes the original-side position to the wrapped strategy', () => {
    const { strategy, seenSides } = fixedStrategy({
      signal: 'OPEN_LONG',
      reason: 'test',
      entryScore: 7,
    });
    const inverted = invertStrategy(strategy);

    expect(inverted.onNewCandle(candle, null)).toMatchObject({
      signal: 'OPEN_SHORT',
      entryScore: 7,
    });
    inverted.onNewCandle(candle, 'SHORT');
    expect(seenSides).toEqual([null, 'LONG']);
    expect(inverted.id).toBe('fixed');
    expect(inverted.getRequiredWarmupCandles()).toBe(5);
  });

  it('maps close and reverse signals to the opposite side', () => {
    const { strategy } = fixedStrategy({
      signal: 'REVERSE_TO_SHORT',
      reason: 'test',
    });
    expect(invertStrategy(strategy).onNewCandle(candle, 'SHORT').signal).toBe(
      'REVERSE_TO_LONG',
    );
  });

  it('produces reproducible random entries for the same seed and holds while in position', () => {
    const signals = (seed: number) => {
      const random = createRandomEntryStrategy('random_1', seed, 0.5);
      return Array.from(
        { length: 50 },
        () => random.onNewCandle(candle, null).signal,
      );
    };

    expect(signals(1)).toEqual(signals(1));
    expect(signals(1)).toContain('OPEN_LONG');
    expect(signals(1)).toContain('OPEN_SHORT');
    expect(
      createRandomEntryStrategy('random_1', 1, 1).onNewCandle(candle, 'LONG')
        .signal,
    ).toBe('HOLD');
  });
});
