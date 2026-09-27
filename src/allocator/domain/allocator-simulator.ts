import { planRebalance } from './rebalance-planner';
import { computeTrendSignal, TrendSignalParams } from './trend-signal';

export type DailySeries = {
  // Время закрытия дня (UTC) для каждого индекса
  dates: number[];
  // Дневные закрытия по символу; null — у символа ещё/уже нет торгов в этот день
  closes: Record<string, Array<number | null>>;
};

export type SimulationParams = TrendSignalParams & {
  initialCapital: number;
  feePct: number;
  slippagePct: number;
  rebalanceThresholdPct: number;
  minOrderUsdt: number;
  // Считать метрики начиная с этой даты (раньше — только прогрев индикаторов)
  startAt?: number;
  // Подмена экспозиции (для baseline: buy&hold, случайный тайминг)
  exposureOverride?: (symbol: string, dayIndex: number) => number;
};

export type SimulatedTrade = {
  timestamp: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  quoteAmount: number;
  fee: number;
};

export type SimulationResult = {
  equityCurve: Array<{ timestamp: number; equity: number }>;
  trades: SimulatedTrade[];
  feesPaid: number;
  averageExposurePct: number;
};

export type PerformanceStats = {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  byYearPct: Record<string, number>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const simulateAllocator = (
  series: DailySeries,
  params: SimulationParams,
): SimulationResult => {
  const symbols = Object.keys(series.closes);
  const allocationPerAsset = 1 / symbols.length;
  const quantities: Record<string, number> = Object.fromEntries(
    symbols.map((s) => [s, 0]),
  );
  const lastPrice: Record<string, number> = {};
  const history: Record<string, number[]> = Object.fromEntries(
    symbols.map((s) => [s, []]),
  );
  const equityCurve: SimulationResult['equityCurve'] = [];
  const trades: SimulatedTrade[] = [];
  let cash = params.initialCapital;
  let feesPaid = 0;
  let exposureSum = 0;
  let exposureDays = 0;

  for (let dayIndex = 0; dayIndex < series.dates.length; dayIndex += 1) {
    const timestamp = series.dates[dayIndex];
    const targetWeights: Record<string, number> = {};
    const tradable: string[] = [];

    for (const symbol of symbols) {
      const close = series.closes[symbol][dayIndex];
      if (close === null || close === undefined) {
        continue;
      }
      history[symbol].push(close);
      lastPrice[symbol] = close;
      tradable.push(symbol);

      const exposure = params.exposureOverride
        ? params.exposureOverride(symbol, dayIndex)
        : computeTrendSignal(history[symbol], params).exposure;
      targetWeights[symbol] = exposure * allocationPerAsset;
    }

    const trading = params.startAt === undefined || timestamp >= params.startAt;
    if (trading && tradable.length > 0) {
      const plan = planRebalance({
        cash,
        holdings: tradable.map((symbol) => ({
          symbol,
          quantity: quantities[symbol],
          price: lastPrice[symbol],
        })),
        targetWeights,
        rebalanceThresholdPct: params.rebalanceThresholdPct,
        minOrderUsdt: params.minOrderUsdt,
        allocationPerAsset,
      });

      for (const order of plan.orders) {
        if (order.side === 'SELL') {
          const quantity = Math.min(order.quantity, quantities[order.symbol]);
          const fillPrice = order.price * (1 - params.slippagePct);
          const gross = quantity * fillPrice;
          const fee = gross * params.feePct;
          quantities[order.symbol] -= quantity;
          cash += gross - fee;
          feesPaid += fee;
          trades.push({
            timestamp,
            symbol: order.symbol,
            side: 'SELL',
            price: fillPrice,
            quantity,
            quoteAmount: gross,
            fee,
          });
        } else {
          const spend = Math.min(order.quoteAmount, cash);
          const fillPrice = order.price * (1 + params.slippagePct);
          const fee = spend * params.feePct;
          const quantity = (spend - fee) / fillPrice;
          quantities[order.symbol] += quantity;
          cash -= spend;
          feesPaid += fee;
          trades.push({
            timestamp,
            symbol: order.symbol,
            side: 'BUY',
            price: fillPrice,
            quantity,
            quoteAmount: spend,
            fee,
          });
        }
      }
    }

    if (!trading) {
      continue;
    }

    const holdingsValue = symbols.reduce(
      (sum, symbol) => sum + quantities[symbol] * (lastPrice[symbol] ?? 0),
      0,
    );
    const equity = cash + holdingsValue;
    equityCurve.push({ timestamp, equity });
    exposureSum += equity > 0 ? holdingsValue / equity : 0;
    exposureDays += 1;
  }

  return {
    equityCurve,
    trades,
    feesPaid,
    averageExposurePct: exposureDays ? (exposureSum / exposureDays) * 100 : 0,
  };
};

export const computePerformance = (
  equityCurve: Array<{ timestamp: number; equity: number }>,
): PerformanceStats => {
  if (equityCurve.length < 2) {
    const equity = equityCurve[0]?.equity ?? 0;
    return {
      startEquity: equity,
      endEquity: equity,
      totalReturnPct: 0,
      cagrPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
      byYearPct: {},
    };
  }

  const first = equityCurve[0];
  const last = equityCurve[equityCurve.length - 1];
  const years = (last.timestamp - first.timestamp) / (365 * DAY_MS);
  const returns: number[] = [];
  let peak = first.equity;
  let maxDrawdown = 0;
  const yearBounds: Record<string, { start: number; end: number }> = {};

  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = equityCurve[index - 1];
    const point = equityCurve[index];
    returns.push(point.equity / previous.equity - 1);
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - point.equity / peak);
    const year = String(new Date(point.timestamp).getUTCFullYear());
    yearBounds[year] ??= { start: previous.equity, end: point.equity };
    yearBounds[year].end = point.equity;
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const deviation = Math.sqrt(
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(returns.length - 1, 1),
  );

  return {
    startEquity: first.equity,
    endEquity: last.equity,
    totalReturnPct: (last.equity / first.equity - 1) * 100,
    cagrPct:
      years > 0
        ? (Math.pow(last.equity / first.equity, 1 / years) - 1) * 100
        : 0,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: deviation > 0 ? (mean / deviation) * Math.sqrt(365) : 0,
    byYearPct: Object.fromEntries(
      Object.entries(yearBounds).map(([year, bounds]) => [
        year,
        (bounds.end / bounds.start - 1) * 100,
      ]),
    ),
  };
};

/**
 * Случайный тайминг с той же частотой смены позиции, что у тренд-фильтра
 * (в среднем раз в ~18 дней). Нужен, чтобы проверить: даёт ли сигнал что-то
 * сверх того, что стратегия просто половину времени сидит в кэше.
 */
export const createRandomTimingExposure = (
  seed: number,
  switchProbability = 1 / 18,
) => {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
  const positions: Record<string, number> = {};

  return (symbol: string) => {
    positions[symbol] ??= random() < 0.5 ? 1 : 0;
    if (random() < switchProbability) {
      positions[symbol] = 1 - positions[symbol];
    }
    return positions[symbol];
  };
};
