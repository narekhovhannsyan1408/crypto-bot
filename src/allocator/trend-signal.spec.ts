import {
  annualizedVolatility,
  computeTrendSignal,
  getRequiredHistoryDays,
} from './trend-signal';

const params = { smaPeriods: [2, 3, 5], volTarget: 0, volLookbackDays: 3 };

describe('computeTrendSignal', () => {
  it('is fully invested when the close is above every moving average', () => {
    const signal = computeTrendSignal([1, 2, 3, 4, 5, 6], params);

    expect(signal.isReady).toBe(true);
    expect(signal.trendScore).toBe(1);
    expect(signal.exposure).toBe(1);
  });

  it('is fully in cash when the close is below every moving average', () => {
    const signal = computeTrendSignal([6, 5, 4, 3, 2, 1], params);

    expect(signal.exposure).toBe(0);
  });

  it('gives partial exposure when only some averages are below the close', () => {
    // SMA2 = 9.5 (ниже 10), SMA3 ≈ 12.3 и SMA5 = 13.4 (выше 10)
    const signal = computeTrendSignal([15, 15, 18, 9, 10], params);

    expect(signal.trendScore).toBeCloseTo(1 / 3, 6);
  });

  it('is not ready and stays in cash without enough history', () => {
    const signal = computeTrendSignal([1, 2, 3], params);

    expect(signal.isReady).toBe(false);
    expect(signal.exposure).toBe(0);
    expect(getRequiredHistoryDays(params)).toBe(5);
  });

  it('scales exposure down when volatility exceeds the target', () => {
    const closes = [100, 120, 90, 130, 95, 140];
    const volatility = annualizedVolatility(closes, 3)!;
    const signal = computeTrendSignal(closes, {
      ...params,
      smaPeriods: [2],
      volTarget: 0.5,
    });

    expect(volatility).toBeGreaterThan(0.5);
    expect(signal.exposure).toBeCloseTo(0.5 / volatility, 6);
  });
});
