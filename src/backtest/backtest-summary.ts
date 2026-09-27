import { ClosedTrade } from '../trader/types';
import { BacktestReport } from './types';

export type BacktestCosts = {
  feePct: number;
  slippagePct: number;
};

export type GroupStats = {
  trades: number;
  winRatePct: number;
  netPnl: number;
};

export type BacktestSummary = {
  trades: number;
  winRatePct: number;
  netPnl: number;
  grossPnl: number;
  feesPaid: number;
  maxDrawdownPct: number;
  avgWinPct: number;
  avgLossPct: number;
  avgHoldMinutes: number;
  // Средний результат сделки до комиссий и проскальзывания, % от позиции
  edgeBeforeCostsPct: number;
  // Издержки на круг (вход + выход), % от позиции
  costPerTradePct: number;
  netPerTradePct: number;
  // t-статистика среднего результата до издержек: |t| < 2 — преимущество не отличимо от нуля
  edgeTStat: number;
  lastTradeAt: number | null;
  byStrategy: Record<string, GroupStats>;
  byExit: Record<string, GroupStats & { avgBeforeCostsPct: number }>;
  byMonth: Record<string, GroupStats>;
};

export const classifyExit = (trade: ClosedTrade) => {
  if (trade.reason.startsWith('Тейк-профит')) return 'тейк-профит';
  if (trade.reason.startsWith('Time stop')) return 'выход по времени';
  if (trade.reason.startsWith('Стоп-лосс/трейлинг')) {
    return trade.grossPnl >= 0
      ? 'трейлинг/безубыток в плюс'
      : 'стоп/трейлинг в минус';
  }
  return 'сигнал стратегии';
};

const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const standardDeviation = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
};

const groupBy = (
  trades: ClosedTrade[],
  keyOf: (trade: ClosedTrade) => string,
) => {
  const groups: Record<string, ClosedTrade[]> = {};
  for (const trade of trades) {
    const key = keyOf(trade);
    groups[key] ??= [];
    groups[key].push(trade);
  }
  return groups;
};

const toGroupStats = (trades: ClosedTrade[]): GroupStats => ({
  trades: trades.length,
  winRatePct: trades.length
    ? (trades.filter((trade) => trade.pnlNet > 0).length / trades.length) * 100
    : 0,
  netPnl: trades.reduce((sum, trade) => sum + trade.pnlNet, 0),
});

export const summarizeBacktest = (
  report: BacktestReport,
  costs: BacktestCosts,
): BacktestSummary => {
  const trades = report.closedTrades;
  // grossPnl уже включает проскальзывание (оно заложено в цены), поэтому возвращаем его обратно
  const slippageRoundTripPct = costs.slippagePct * 2 * 100;
  const beforeCostsPct = trades.map(
    (trade) =>
      (trade.grossPnl / trade.investedUsdt) * 100 + slippageRoundTripPct,
  );
  const netPct = trades.map(
    (trade) => (trade.pnlNet / trade.investedUsdt) * 100,
  );
  const wins = netPct.filter((value) => value > 0);
  const losses = netPct.filter((value) => value <= 0);
  const deviation = standardDeviation(beforeCostsPct);

  const byExitGroups = groupBy(trades, classifyExit);

  return {
    trades: trades.length,
    winRatePct: report.winRate,
    netPnl: report.endingEquity - report.startingBalance,
    grossPnl: trades.reduce((sum, trade) => sum + trade.grossPnl, 0),
    feesPaid: report.feesPaid,
    maxDrawdownPct: report.maxDrawdownPct,
    avgWinPct: mean(wins),
    avgLossPct: mean(losses),
    avgHoldMinutes: mean(
      trades.map((trade) => (trade.closedAt - trade.openedAt) / 60_000),
    ),
    edgeBeforeCostsPct: mean(beforeCostsPct),
    costPerTradePct: (costs.feePct * 2 + costs.slippagePct * 2) * 100,
    netPerTradePct: mean(netPct),
    edgeTStat:
      deviation > 0
        ? mean(beforeCostsPct) / (deviation / Math.sqrt(beforeCostsPct.length))
        : 0,
    lastTradeAt: trades.at(-1)?.closedAt ?? null,
    byStrategy: Object.fromEntries(
      Object.entries(groupBy(trades, (trade) => trade.strategyId)).map(
        ([key, group]) => [key, toGroupStats(group)],
      ),
    ),
    byExit: Object.fromEntries(
      Object.entries(byExitGroups).map(([key, group]) => [
        key,
        {
          ...toGroupStats(group),
          avgBeforeCostsPct: mean(
            group.map(
              (trade) =>
                (trade.grossPnl / trade.investedUsdt) * 100 +
                slippageRoundTripPct,
            ),
          ),
        },
      ]),
    ),
    byMonth: Object.fromEntries(
      Object.entries(
        groupBy(trades, (trade) =>
          new Date(trade.closedAt).toISOString().slice(0, 7),
        ),
      ).map(([key, group]) => [key, toGroupStats(group)]),
    ),
  };
};

export type VerdictInput = {
  strategy: BacktestSummary;
  randomBaseline: BacktestSummary[];
  inverted: BacktestSummary | null;
  haltedByDrawdown: boolean;
};

export type Verdict = {
  ready: boolean;
  findings: string[];
};

const MIN_TRADES_FOR_CONCLUSION = 30;
const SIGNIFICANT_T_STAT = 2;

export const buildVerdict = (input: VerdictInput): Verdict => {
  const { strategy, randomBaseline, inverted, haltedByDrawdown } = input;
  const findings: string[] = [];
  const fmt = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;

  if (strategy.trades < MIN_TRADES_FOR_CONCLUSION) {
    return {
      ready: false,
      findings: [
        `Слишком мало сделок (${strategy.trades}) для вывода. Увеличь период (--days) или число символов.`,
      ],
    };
  }

  const edgeIsSignificant = strategy.edgeTStat >= SIGNIFICANT_T_STAT;
  findings.push(
    edgeIsSignificant
      ? `Преимущество до издержек статистически заметно (t = ${strategy.edgeTStat.toFixed(2)}).`
      : `Преимущество до издержек не отличимо от нуля (t = ${strategy.edgeTStat.toFixed(2)}, нужно ≥ ${SIGNIFICANT_T_STAT}).`,
  );

  const edgeCoversCosts =
    strategy.edgeBeforeCostsPct > strategy.costPerTradePct;
  findings.push(
    edgeCoversCosts
      ? `Средний заработок сделки до издержек (${fmt(strategy.edgeBeforeCostsPct)}) больше издержек (${strategy.costPerTradePct.toFixed(3)}%).`
      : `Средний заработок сделки до издержек (${fmt(strategy.edgeBeforeCostsPct)}) меньше издержек на круг (${strategy.costPerTradePct.toFixed(3)}%): каждая сделка в среднем убыточна.`,
  );

  let beatsRandom = true;
  if (randomBaseline.length > 0) {
    const randomNetPerTrade = mean(
      randomBaseline.map((run) => run.netPerTradePct),
    );
    const bestRandomNetPerTrade = Math.max(
      ...randomBaseline.map((run) => run.netPerTradePct),
    );
    beatsRandom = strategy.netPerTradePct > bestRandomNetPerTrade;
    findings.push(
      `Результат на сделку: стратегия ${fmt(strategy.netPerTradePct)}, случайные входы в среднем ${fmt(randomNetPerTrade)} (лучший прогон ${fmt(bestRandomNetPerTrade)}).` +
        (beatsRandom ? '' : ' Стратегия не лучше случайных входов.'),
    );
  }

  if (inverted) {
    const gap = strategy.netPerTradePct - inverted.netPerTradePct;
    findings.push(
      `Сигналы наоборот дают ${fmt(inverted.netPerTradePct)} на сделку (разница с оригиналом ${fmt(gap)}).` +
        (Math.abs(gap) < Math.max(strategy.costPerTradePct / 4, 0.02)
          ? ' Почти одинаково — сигналы не несут информации о направлении.'
          : ''),
    );
  }

  if (haltedByDrawdown) {
    findings.push(
      'Торговля остановилась по лимиту просадки (BOT_MAX_DRAWDOWN_STOP_PCT) — оставшаяся часть периода не торговалась.',
    );
  }

  return {
    ready:
      strategy.netPnl > 0 &&
      edgeIsSignificant &&
      edgeCoversCosts &&
      beatsRandom,
    findings,
  };
};
