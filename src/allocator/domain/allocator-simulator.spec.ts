import {
  computePerformance,
  createRandomTimingExposure,
  simulateAllocator,
  SimulationParams,
} from './allocator-simulator';

const DAY_MS = 24 * 60 * 60 * 1000;
const params: SimulationParams = {
  smaPeriods: [5, 10],
  volTarget: 0,
  volLookbackDays: 10,
  initialCapital: 1000,
  feePct: 0.001,
  slippagePct: 0.0005,
  rebalanceThresholdPct: 0.1,
  minOrderUsdt: 10,
};

const series = (closes: number[]) => ({
  dates: closes.map((_, index) => index * DAY_MS),
  closes: { BTCUSDT: closes },
});

describe('simulateAllocator', () => {
  it('rides an uptrend and ends mostly invested with a profit', () => {
    const closes = Array.from(
      { length: 120 },
      (_, index) => 100 * 1.01 ** index,
    );
    const result = simulateAllocator(series(closes), params);
    const stats = computePerformance(result.equityCurve);

    expect(stats.endEquity).toBeGreaterThan(2000);
    expect(result.trades[0].side).toBe('BUY');
    expect(result.feesPaid).toBeGreaterThan(0);
  });

  it('exits a downtrend and loses far less than buy and hold', () => {
    const closes = [
      ...Array.from({ length: 30 }, (_, index) => 100 + index),
      ...Array.from({ length: 90 }, (_, index) => 129 * 0.98 ** index),
    ];
    const strategy = computePerformance(
      simulateAllocator(series(closes), params).equityCurve,
    );
    const buyHold = computePerformance(
      simulateAllocator(series(closes), {
        ...params,
        exposureOverride: () => 1,
      }).equityCurve,
    );

    expect(buyHold.totalReturnPct).toBeLessThan(-70);
    expect(strategy.totalReturnPct).toBeGreaterThan(-15);
  });

  it('does not trade before startAt', () => {
    const closes = Array.from({ length: 50 }, (_, index) => 100 + index);
    const result = simulateAllocator(series(closes), {
      ...params,
      startAt: 40 * DAY_MS,
    });

    expect(result.trades.every((trade) => trade.timestamp >= 40 * DAY_MS)).toBe(
      true,
    );
    expect(result.equityCurve[0].timestamp).toBe(40 * DAY_MS);
  });
});

describe('createRandomTimingExposure', () => {
  it('is reproducible for the same seed', () => {
    const first = createRandomTimingExposure(1);
    const second = createRandomTimingExposure(1);
    const run = (fn: (symbol: string) => number) =>
      Array.from({ length: 100 }, () => fn('BTCUSDT'));

    expect(run(first)).toEqual(run(second));
  });
});
