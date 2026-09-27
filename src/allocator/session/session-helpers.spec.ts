import { appendEquityPoint, downsampleEquity } from './session-helpers';
import { EquityPoint } from './session.types';

describe('session helpers', () => {
  it('keeps extremes and endpoints when downsampling', () => {
    const points: EquityPoint[] = Array.from({ length: 1000 }, (_, index) => ({
      timestamp: index,
      equity: index === 500 ? 10 : index === 700 ? 5000 : 1000,
    }));

    const result = downsampleEquity(points, 100);

    expect(result.length).toBeLessThanOrEqual(100);
    expect(result[0]).toBe(points[0]);
    expect(result.at(-1)).toBe(points.at(-1));
    expect(result.some((point) => point.equity === 10)).toBe(true);
    expect(result.some((point) => point.equity === 5000)).toBe(true);
    expect(
      result.every(
        (point, index) =>
          index === 0 || point.timestamp >= result[index - 1].timestamp,
      ),
    ).toBe(true);
  });

  it('adds equity points no more often than the interval unless forced', () => {
    const history: EquityPoint[] = [{ timestamp: 0, equity: 1 }];

    appendEquityPoint(history, { timestamp: 10, equity: 2 }, 100);
    appendEquityPoint(history, { timestamp: 20, equity: 3 }, 100, true);
    appendEquityPoint(history, { timestamp: 200, equity: 4 }, 100);

    expect(history.map((point) => point.equity)).toEqual([1, 3, 4]);
  });
});
