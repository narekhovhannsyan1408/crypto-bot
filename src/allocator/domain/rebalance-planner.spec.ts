import { planRebalance, RebalancePlanInput } from './rebalance-planner';

const base: RebalancePlanInput = {
  cash: 1000,
  holdings: [
    { symbol: 'BTCUSDT', quantity: 0, price: 100 },
    { symbol: 'ETHUSDT', quantity: 0, price: 10 },
  ],
  targetWeights: { BTCUSDT: 0.5, ETHUSDT: 0.5 },
  rebalanceThresholdPct: 0.1,
  minOrderUsdt: 10,
  allocationPerAsset: 0.5,
};

describe('planRebalance', () => {
  it('buys target weights from cash', () => {
    const plan = planRebalance(base);

    expect(plan.equity).toBe(1000);
    expect(
      plan.orders.map((order) => [order.symbol, order.side, order.quoteAmount]),
    ).toEqual([
      ['BTCUSDT', 'BUY', 500],
      ['ETHUSDT', 'BUY', 500],
    ]);
  });

  it('does nothing when the portfolio is already within the threshold (idempotent)', () => {
    const plan = planRebalance({
      ...base,
      cash: 20,
      holdings: [
        { symbol: 'BTCUSDT', quantity: 4.9, price: 100 },
        { symbol: 'ETHUSDT', quantity: 49, price: 10 },
      ],
    });

    expect(plan.orders).toEqual([]);
  });

  it('sells the whole position when the target is zero and puts sells before buys', () => {
    const plan = planRebalance({
      ...base,
      cash: 0,
      holdings: [
        { symbol: 'BTCUSDT', quantity: 5, price: 100 },
        { symbol: 'ETHUSDT', quantity: 0, price: 10 },
      ],
      targetWeights: { BTCUSDT: 0, ETHUSDT: 0.5 },
    });

    expect(plan.orders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'SELL',
      quantity: 5,
    });
    expect(plan.orders[1]).toMatchObject({
      symbol: 'ETHUSDT',
      side: 'BUY',
      quoteAmount: 250,
    });
  });

  it('scales buys down to the cash that will be available', () => {
    const plan = planRebalance({
      ...base,
      cash: 100,
      holdings: [
        { symbol: 'BTCUSDT', quantity: 4.5, price: 100 },
        { symbol: 'ETHUSDT', quantity: 45, price: 10 },
      ],
      targetWeights: { BTCUSDT: 1, ETHUSDT: 1 },
    });
    const bought = plan.orders.reduce(
      (sum, order) => sum + order.quoteAmount,
      0,
    );

    expect(bought).toBeCloseTo(100, 6);
  });

  it('skips orders below the exchange minimum', () => {
    const plan = planRebalance({ ...base, cash: 12, minOrderUsdt: 10 });

    expect(plan.orders).toEqual([]);
    expect(plan.skipped.map((item) => item.symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
    ]);
  });
});
