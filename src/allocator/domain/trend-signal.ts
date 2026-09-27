export type TrendSignalParams = {
  smaPeriods: number[];
  // Целевая годовая волатильность позиции (0 — выключено)
  volTarget: number;
  volLookbackDays: number;
};

export type TrendSignal = {
  // Доля выделенного активу капитала, которую держим в монете (0..1)
  exposure: number;
  // Доля скользящих средних, над которыми закрылась цена (0..1)
  trendScore: number;
  annualizedVol: number | null;
  close: number;
  smaValues: Record<number, number>;
  isReady: boolean;
};

const DAYS_PER_YEAR = 365;

export const getRequiredHistoryDays = (params: TrendSignalParams) =>
  Math.max(
    ...params.smaPeriods,
    params.volTarget > 0 ? params.volLookbackDays + 1 : 0,
  );

const simpleMovingAverage = (closes: number[], period: number) => {
  const window = closes.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / window.length;
};

export const annualizedVolatility = (
  closes: number[],
  lookbackDays: number,
) => {
  if (closes.length < lookbackDays + 1 || lookbackDays < 2) {
    return null;
  }

  const window = closes.slice(-(lookbackDays + 1));
  const returns = window
    .slice(1)
    .map((close, index) => Math.log(close / window[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);

  return Math.sqrt(variance * DAYS_PER_YEAR);
};

/**
 * Ансамбль трендовых фильтров по дневным закрытиям.
 *
 * Для каждой SMA из набора цена выше средней даёт голос "в рынке". Экспозиция равна
 * доле голосов: 4 из 4 — полностью в монете, 0 из 4 — полностью в USDT. Ансамбль
 * устойчивее одного параметра, потому что не зависит от удачно подобранного периода.
 *
 * closes — только закрытые дневные свечи, последний элемент — последний закрытый день.
 */
export const computeTrendSignal = (
  closes: number[],
  params: TrendSignalParams,
): TrendSignal => {
  const close = closes.at(-1) ?? 0;
  const required = getRequiredHistoryDays(params);

  if (closes.length < required || params.smaPeriods.length === 0) {
    return {
      exposure: 0,
      trendScore: 0,
      annualizedVol: null,
      close,
      smaValues: {},
      isReady: false,
    };
  }

  const smaValues: Record<number, number> = {};
  let votes = 0;
  for (const period of params.smaPeriods) {
    const average = simpleMovingAverage(closes, period);
    smaValues[period] = average;
    if (close > average) {
      votes += 1;
    }
  }

  const trendScore = votes / params.smaPeriods.length;
  const annualizedVol =
    params.volTarget > 0
      ? annualizedVolatility(closes, params.volLookbackDays)
      : null;
  const volScale =
    params.volTarget > 0 && annualizedVol && annualizedVol > 0
      ? Math.min(1, params.volTarget / annualizedVol)
      : 1;

  return {
    exposure: trendScore * volScale,
    trendScore,
    annualizedVol,
    close,
    smaValues,
    isReady: true,
  };
};
