/**
 * Состояние сессии «стратегия, прогнанная на реальных ценах» — для скриншотов и видео.
 * Та же логика, что в живом режиме (simulateAllocator, те же сигналы и нарратор),
 * исторические дневные цены Binance, издержки тестового режима (0.1% + 0.05%).
 * В презентации и видео такие кадры подписаны как replay на исторических ценах.
 *
 *   npx ts-node --transpile-only docs/hackathon/replay-state.ts 2026-01-01 .tmp/demo-state.json
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computePerformance,
  DailySeries,
  simulateAllocator,
} from '../../src/allocator/domain/allocator-simulator';
import {
  computeTrendSignal,
  getRequiredHistoryDays,
} from '../../src/allocator/domain/trend-signal';
import {
  describeHoldingDecision,
  describeStart,
  explainOrder,
} from '../../src/allocator/engine/narrator';
import { appendActivity } from '../../src/allocator/session/session-helpers';
import {
  AllocatorSession,
  SignalSnapshot,
} from '../../src/allocator/session/session.types';
import { loadHistoricalCandles } from '../../src/backtest/history-loader';
import { getBotConfig } from '../../src/config/bot-config';

const DAY_MS = 86_400_000;
const DECISION_DELAY_MS = 5 * 60_000;
const ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SMA = [20, 50, 100, 200];
const CAPITAL = 1000;
const AUTO_STOP = 0.3;
const params = {
  smaPeriods: SMA,
  volTarget: 0,
  volLookbackDays: 30,
  initialCapital: CAPITAL,
  feePct: 0.001,
  slippagePct: 0.0005,
  rebalanceThresholdPct: 0.1,
  minOrderUsdt: 10,
};

async function main() {
  const [fromIso = '2026-01-01', out = '.tmp/demo-state.json'] =
    process.argv.slice(2);
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const warmup = getRequiredHistoryDays(params) + 10;

  const closesBySymbol: Record<string, Map<number, number>> = {};
  for (const symbol of ASSETS) {
    const candles = await loadHistoricalCandles({
      symbol,
      interval: '1d',
      startTime: from - warmup * DAY_MS,
      endTime: to,
      restBaseUrl: getBotConfig().allocator.dataRestBaseUrl,
      cacheDir: join(process.cwd(), '.backtest-cache'),
    });
    closesBySymbol[symbol] = new Map(
      candles.map((c) => [Math.floor(c.openTime / DAY_MS) * DAY_MS, c.close]),
    );
  }
  const firstDay = Math.min(
    ...Object.values(closesBySymbol).map((m) => [...m.keys()][0]),
  );
  const series: DailySeries = { dates: [], closes: {} };
  for (const symbol of ASSETS) series.closes[symbol] = [];
  // Только закрытые дни: последняя свеча — вчерашняя
  for (let day = firstDay; day < to; day += DAY_MS) {
    series.dates.push(day);
    for (const symbol of ASSETS)
      series.closes[symbol].push(closesBySymbol[symbol].get(day) ?? null);
  }

  const result = simulateAllocator(series, { ...params, startAt: from });
  const hold = simulateAllocator(series, {
    ...params,
    startAt: from,
    exposureOverride: () => 1,
  });
  const stats = computePerformance(result.equityCurve);
  const holdStats = computePerformance(hold.equityCurve);

  // Сигналы каждого дня — те же, что считает живой бот (для объяснений в ленте)
  const signals = new Map<number, Record<string, SignalSnapshot>>();
  const history: Record<string, number[]> = Object.fromEntries(
    ASSETS.map((s) => [s, []]),
  );
  series.dates.forEach((day, index) => {
    const byAsset: Record<string, SignalSnapshot> = {};
    for (const symbol of ASSETS) {
      const close = series.closes[symbol][index];
      if (close === null) continue;
      history[symbol].push(close);
      const signal = computeTrendSignal(history[symbol], params);
      byAsset[symbol] = {
        symbol,
        day,
        close: signal.close,
        trendScore: signal.trendScore,
        exposure: signal.exposure,
        annualizedVol: signal.annualizedVol,
        smaValues: signal.smaValues,
      };
    }
    signals.set(day, byAsset);
  });

  const decisionTime = (day: number) => day + DAY_MS + DECISION_DELAY_MS;
  const startDay = series.dates.find((day) => day >= from)!;
  const startPrices = signals.get(startDay)!;
  const session: AllocatorSession = {
    id: `${decisionTime(startDay)}`,
    mode: 'paper',
    status: 'running',
    startedAt: decisionTime(startDay) - 60_000,
    stoppedAt: null,
    stopReason: null,
    initialCapital: CAPITAL,
    autoStopLossPct: AUTO_STOP,
    cash: CAPITAL,
    quantities: Object.fromEntries(ASSETS.map((s) => [s, 0])),
    feesPaid: 0,
    lastRebalanceDay: series.dates[series.dates.length - 1],
    lastSignals: Object.values(
      signals.get(series.dates[series.dates.length - 1])!,
    ),
    benchmarkStartPrices: Object.fromEntries(
      ASSETS.map((s) => [s, startPrices[s].close]),
    ),
    equityHistory: [
      { timestamp: decisionTime(startDay) - 60_000, equity: CAPITAL },
    ],
    activity: [],
  };
  appendActivity(session, {
    kind: 'start',
    ...describeStart('paper', CAPITAL, AUTO_STOP),
    timestamp: session.startedAt,
  });

  const tradesByDay = new Map<number, typeof result.trades>();
  for (const trade of result.trades) {
    tradesByDay.set(trade.timestamp, [
      ...(tradesByDay.get(trade.timestamp) ?? []),
      trade,
    ]);
  }
  const days = series.dates.filter((day) => day >= from);
  days.forEach((day, index) => {
    const today = signals.get(day)!;
    const previous = index > 0 ? signals.get(days[index - 1]) : undefined;
    const trades = tradesByDay.get(day) ?? [];
    trades.forEach((trade, order) => {
      const quoteAmount =
        trade.side === 'SELL'
          ? trade.quoteAmount - trade.fee
          : trade.quoteAmount;
      if (trade.side === 'BUY') {
        session.cash -= quoteAmount;
        session.quantities[trade.symbol] += trade.quantity;
      } else {
        session.cash += quoteAmount;
        session.quantities[trade.symbol] = Math.max(
          session.quantities[trade.symbol] - trade.quantity,
          0,
        );
      }
      session.feesPaid += trade.fee;
      const signal = today[trade.symbol];
      appendActivity(session, {
        kind: trade.side === 'BUY' ? 'buy' : 'sell',
        ...explainOrder(
          {
            symbol: trade.symbol,
            side: trade.side,
            quoteAmount,
            quantity: trade.quantity,
            price: trade.price,
            currentWeight: 0,
            targetWeight: signal.exposure / ASSETS.length,
          },
          signal,
          previous?.[trade.symbol],
          SMA.length,
          'USDT',
        ),
        symbol: trade.symbol,
        quantity: trade.quantity,
        price: trade.price,
        quoteAmount,
        fee: trade.fee,
        timestamp: decisionTime(day) + order * 1000,
      });
    });
    if (trades.length === 0) {
      appendActivity(session, {
        kind: 'check',
        ...describeHoldingDecision(
          Object.values(today),
          ASSETS.length,
          SMA.length,
          'USDT',
        ),
        timestamp: decisionTime(day),
      });
    }
    const point = result.equityCurve.find((item) => item.timestamp === day);
    if (point) {
      session.equityHistory.push({
        timestamp: decisionTime(day) + 30_000,
        equity: point.equity,
      });
    }
  });

  const lastPrices = signals.get(series.dates[series.dates.length - 1])!;
  const equity = ASSETS.reduce(
    (sum, symbol) =>
      sum + session.quantities[symbol] * lastPrices[symbol].close,
    session.cash,
  );
  const minEquity = Math.min(
    ...result.equityCurve.map((point) => point.equity),
  );
  writeFileSync(
    out,
    JSON.stringify({ version: 2, current: session, history: [] }),
  );
  console.log(
    `${fromIso} → ${new Date(series.dates.at(-1)!).toISOString().slice(0, 10)}: ` +
      `strategy ${stats.totalReturnPct.toFixed(1)}% (equity ${equity.toFixed(2)}, sim ${stats.endEquity.toFixed(2)}), ` +
      `buy & hold ${holdStats.totalReturnPct.toFixed(1)}%, max DD ${stats.maxDrawdownPct.toFixed(1)}% vs ${holdStats.maxDrawdownPct.toFixed(1)}%, ` +
      `min equity ${minEquity.toFixed(0)}, trades ${result.trades.length}, activity ${session.activity.length} → ${out}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
