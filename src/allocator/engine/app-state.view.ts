import { ExecutionMode } from '../../trader/execution.types';
import { baseAssetOf } from '../brokers/allocator-broker';
import { downsampleEquity } from '../session/session-helpers';
import { AllocatorSession, SessionSummary } from '../session/session.types';
import { assetName, trendLabel } from './asset-names';
import { MODE_LABELS } from './narrator';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHART_POINTS = 600;
// Цены старше этого срока считаем устаревшими (сбой связи с биржей)
export const PRICES_STALE_MS = 15 * 60_000;

export type ChartRange = 'day' | 'week' | 'month' | 'all';
const RANGE_MS: Record<Exclude<ChartRange, 'all'>, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

export type Readiness = { available: boolean; missing: string[] };

export type ViewContext = {
  session: AllocatorSession | null;
  history: SessionSummary[];
  prices: Record<string, number>;
  pricesAt: number;
  lastError: string | null;
  busy: boolean;
  readiness: Record<ExecutionMode, Readiness>;
  assets: string[];
  smaPeriods: number[];
  minCapital: number;
  now: number;
  activityLimit: number;
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

export const sessionEquity = (
  session: AllocatorSession,
  prices: Record<string, number>,
  assets: string[],
) =>
  assets.reduce(
    (sum, symbol) =>
      sum + (session.quantities[symbol] ?? 0) * (prices[symbol] ?? 0),
    session.cash,
  );

/** «Если бы просто купили активы поровну на старте и держали» — без комиссий. */
export const benchmarkEquity = (
  session: AllocatorSession,
  prices: Record<string, number>,
  assets: string[],
) => {
  const start = session.benchmarkStartPrices;
  if (!start || assets.some((symbol) => !start[symbol] || !prices[symbol])) {
    return null;
  }
  const growth =
    assets.reduce((sum, symbol) => sum + prices[symbol] / start[symbol], 0) /
    assets.length;
  return session.initialCapital * growth;
};

export const chartVersion = (session: AllocatorSession) =>
  `${session.id}:${session.equityHistory.length}:${session.equityHistory.at(-1)?.timestamp ?? 0}`;

export const buildAppState = (ctx: ViewContext) => {
  const base = {
    generatedAt: ctx.now,
    busy: ctx.busy,
    lastError: ctx.lastError,
    readiness: ctx.readiness,
    history: ctx.history.map((item) => ({
      ...item,
      modeLabel: MODE_LABELS[item.mode],
      profit: round(item.finalEquity - item.initialCapital),
      profitPct: round((item.finalEquity / item.initialCapital - 1) * 100),
    })),
    strategy: {
      assets: ctx.assets.map((symbol) => ({
        symbol,
        base: baseAssetOf(symbol),
        name: assetName(symbol),
      })),
      smaPeriods: ctx.smaPeriods,
      minCapital: ctx.minCapital,
    },
  };

  const session = ctx.session;
  if (!session) {
    return { ...base, status: 'idle' as const, session: null };
  }

  const running = session.status === 'running';
  const equity = sessionEquity(session, ctx.prices, ctx.assets);
  const benchmark = benchmarkEquity(session, ctx.prices, ctx.assets);
  const smaCount = ctx.smaPeriods.length;
  const assets = ctx.assets.map((symbol) => {
    const signal = session.lastSignals.find((item) => item.symbol === symbol);
    const quantity = session.quantities[symbol] ?? 0;
    const price = ctx.prices[symbol] ?? signal?.close ?? 0;
    const value = quantity * price;
    const votes = signal ? Math.round(signal.trendScore * smaCount) : null;
    return {
      symbol,
      base: baseAssetOf(symbol),
      name: assetName(symbol),
      quantity,
      price,
      value: round(value),
      weightPct: equity > 0 ? round((value / equity) * 100, 1) : 0,
      targetWeightPct: signal
        ? round((signal.exposure / ctx.assets.length) * 100, 1)
        : null,
      trendVotes: votes,
      trendTotal: smaCount,
      trendLabel: votes === null ? 'Нет данных' : trendLabel(votes, smaCount),
    };
  });

  return {
    ...base,
    status: session.status,
    session: {
      id: session.id,
      mode: session.mode,
      modeLabel: MODE_LABELS[session.mode],
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      stopReason: session.stopReason,
      initialCapital: session.initialCapital,
      equity: round(equity),
      profit: round(equity - session.initialCapital),
      profitPct: round((equity / session.initialCapital - 1) * 100),
      benchmark:
        benchmark === null
          ? null
          : {
              equity: round(benchmark),
              profit: round(benchmark - session.initialCapital),
              profitPct: round((benchmark / session.initialCapital - 1) * 100),
            },
      cash: round(session.cash),
      cashWeightPct: equity > 0 ? round((session.cash / equity) * 100, 1) : 100,
      feesPaid: round(session.feesPaid),
      autoStopLossPct: session.autoStopLossPct,
      autoStopEquity:
        session.autoStopLossPct > 0
          ? round(session.initialCapital * (1 - session.autoStopLossPct))
          : null,
      assets,
      lastDecisionDay: session.lastRebalanceDay,
      nextDecisionAt: running
        ? (Math.floor(ctx.now / DAY_MS) + 1) * DAY_MS
        : null,
      pricesUpdatedAt: ctx.pricesAt || null,
      pricesStale: running && ctx.now - ctx.pricesAt > PRICES_STALE_MS,
      chartVersion: chartVersion(session),
      activity: session.activity.slice(0, ctx.activityLimit),
      activityTotal: session.activity.length,
    },
  };
};

export type AppState = ReturnType<typeof buildAppState>;

export type ChartData = {
  version: string | null;
  initialCapital: number;
  points: Array<{ timestamp: number; equity: number }>;
  trades: Array<{ timestamp: number; kind: 'buy' | 'sell'; title: string }>;
};

export const buildChart = (
  session: AllocatorSession | null,
  range: ChartRange,
): ChartData => {
  if (!session) {
    return { version: null, initialCapital: 0, points: [], trades: [] };
  }

  let points = session.equityHistory;
  if (range !== 'all' && points.length > 1) {
    const cutoff = points[points.length - 1].timestamp - RANGE_MS[range];
    const inRange = points.filter((point) => point.timestamp >= cutoff);
    points = inRange.length >= 2 ? inRange : points.slice(-2);
  }
  const from = points[0]?.timestamp ?? 0;

  return {
    version: chartVersion(session),
    initialCapital: session.initialCapital,
    points: downsampleEquity(points, MAX_CHART_POINTS).map((point) => ({
      timestamp: point.timestamp,
      equity: round(point.equity),
    })),
    trades: session.activity
      .filter(
        (entry) =>
          (entry.kind === 'buy' || entry.kind === 'sell') &&
          entry.timestamp >= from,
      )
      .map((entry) => ({
        timestamp: entry.timestamp,
        kind: entry.kind as 'buy' | 'sell',
        title: entry.title,
      })),
  };
};

/** Снимок для расширенного дашборда (/advanced). */
export const buildLegacySnapshot = (state: AppState, smaPeriods: number[]) => {
  if (!state.session) {
    return { статус: 'не запущен', ошибка: state.lastError };
  }
  const { session } = state;
  return {
    статус: session.stoppedAt ? 'остановлен' : 'работает',
    режим: session.modeLabel,
    капитал: session.equity,
    стартовыйКапитал: session.initialCapital,
    результатВПроцентах: session.profitPct,
    usdt: session.cash,
    активы: session.assets.map((asset) => ({
      символ: asset.symbol,
      количество: round(asset.quantity, 8),
      цена: asset.price,
      стоимость: asset.value,
      текущийВес: asset.weightPct,
      целевойВес: asset.targetWeightPct,
      тренд:
        asset.trendVotes === null
          ? 'нет данных'
          : `выше ${asset.trendVotes}/${asset.trendTotal} SMA`,
    })),
    последнийСигнал: session.lastDecisionDay
      ? new Date(session.lastDecisionDay).toISOString().slice(0, 10)
      : null,
    сигнал: `ансамбль SMA ${smaPeriods.join('/')}`,
    ошибка: state.lastError,
  };
};
