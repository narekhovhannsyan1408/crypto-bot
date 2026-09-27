import { ClosedTrade } from '../trader/types';
import { buildVerdict, summarizeBacktest } from './backtest-summary';
import { BacktestReport } from './types';

const trade = (
  grossPnl: number,
  reason: string,
  closedAt = Date.UTC(2026, 5, 1),
): ClosedTrade => {
  const totalFees = 0.1;
  return {
    key: 'BTCUSDT::momentum_trend',
    symbol: 'BTCUSDT',
    interval: '5m',
    strategyId: 'momentum_trend',
    strategyName: 'Momentum Trend',
    side: 'LONG',
    marketType: 'spot',
    entryPrice: 100,
    exitPrice: 100,
    quantity: 0.5,
    investedUsdt: 50,
    grossPnl,
    pnlNet: grossPnl - totalFees,
    totalFees,
    exitFee: 0.05,
    openedAt: closedAt - 60 * 60_000,
    closedAt,
    reason,
  };
};

const report = (closedTrades: ClosedTrade[]): BacktestReport => {
  const net = closedTrades.reduce((sum, item) => sum + item.pnlNet, 0);
  const wins = closedTrades.filter((item) => item.pnlNet > 0).length;
  return {
    startingBalance: 1000,
    endingEquity: 1000 + net,
    realizedResult: net,
    unrealizedResult: 0,
    totalTrades: closedTrades.length,
    wins,
    losses: closedTrades.length - wins,
    winRate: closedTrades.length ? (wins / closedTrades.length) * 100 : 0,
    maxDrawdownPct: 1,
    feesPaid: closedTrades.reduce((sum, item) => sum + item.totalFees, 0),
    closedTrades,
    equityCurve: [],
  };
};

const costs = { feePct: 0.001, slippagePct: 0 };

describe('summarizeBacktest', () => {
  it('computes per-trade edge before costs and groups exits', () => {
    const summary = summarizeBacktest(
      report([
        trade(1.1, 'Тейк-профит по лонгу'),
        trade(-0.5, 'Стоп-лосс/трейлинг по лонгу'),
        trade(0.2, 'Стоп-лосс/трейлинг по лонгу'),
        trade(0, 'Time stop по лонгу: превышено максимальное время удержания'),
      ]),
      costs,
    );

    expect(summary.trades).toBe(4);
    // (2.2 - 1 + 0.4 + 0) / 4 = 0.4% от позиции 50 USDT
    expect(summary.edgeBeforeCostsPct).toBeCloseTo(0.4, 6);
    expect(summary.costPerTradePct).toBeCloseTo(0.2, 6);
    expect(summary.byExit['тейк-профит'].trades).toBe(1);
    expect(summary.byExit['стоп/трейлинг в минус'].trades).toBe(1);
    expect(summary.byExit['трейлинг/безубыток в плюс'].trades).toBe(1);
    expect(summary.byExit['выход по времени'].trades).toBe(1);
    expect(summary.byMonth['2026-06'].trades).toBe(4);
  });

  it('adds slippage back when estimating edge before costs', () => {
    const summary = summarizeBacktest(
      report([trade(0, 'Тейк-профит по лонгу')]),
      {
        feePct: 0.001,
        slippagePct: 0.0005,
      },
    );

    expect(summary.edgeBeforeCostsPct).toBeCloseTo(0.1, 6);
    expect(summary.costPerTradePct).toBeCloseTo(0.3, 6);
  });
});

describe('buildVerdict', () => {
  const noisyTrades = (bias: number) =>
    Array.from({ length: 100 }, (_, index) =>
      trade(
        (index % 2 === 0 ? 0.5 : -0.5) + bias,
        'Стоп-лосс/трейлинг по лонгу',
      ),
    );

  it('rejects a strategy whose edge is smaller than trading costs', () => {
    const strategy = summarizeBacktest(report(noisyTrades(0.01)), costs);
    const random = summarizeBacktest(report(noisyTrades(0)), costs);
    const verdict = buildVerdict({
      strategy,
      randomBaseline: [random],
      inverted: null,
      haltedByDrawdown: false,
    });

    expect(verdict.ready).toBe(false);
    expect(verdict.findings.join(' ')).toContain('меньше издержек');
  });

  it('accepts a strategy with a significant edge that covers costs and beats random', () => {
    const strategy = summarizeBacktest(report(noisyTrades(0.4)), costs);
    const random = summarizeBacktest(report(noisyTrades(0)), costs);
    const verdict = buildVerdict({
      strategy,
      randomBaseline: [random],
      inverted: null,
      haltedByDrawdown: false,
    });

    expect(verdict.ready).toBe(true);
  });

  it('refuses to conclude on too few trades', () => {
    const strategy = summarizeBacktest(
      report(noisyTrades(1).slice(0, 5)),
      costs,
    );
    const verdict = buildVerdict({
      strategy,
      randomBaseline: [],
      inverted: null,
      haltedByDrawdown: false,
    });

    expect(verdict.ready).toBe(false);
    expect(verdict.findings[0]).toContain('Слишком мало сделок');
  });
});
