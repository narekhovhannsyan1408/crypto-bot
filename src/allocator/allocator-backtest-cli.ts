/**
 * Бэктест трендового аллокатора на дневной истории Binance.
 *
 *   npm run allocator:backtest -- --from 2018-01-01 --vol-target 0.4
 *
 * Использует ту же логику сигнала и ребалансировки, что и живой режим
 * BOT_STRATEGY_MODE=trend_allocator, и сравнивает результат с buy&hold и
 * со случайным таймингом входа/выхода.
 */
import { join } from 'node:path';
import { getBotConfig } from '../config/bot-config';
import { loadHistoricalCandles } from '../backtest/history-loader';
import {
  computePerformance,
  createRandomTimingExposure,
  DailySeries,
  PerformanceStats,
  simulateAllocator,
  SimulationParams,
} from './allocator-simulator';
import { getRequiredHistoryDays } from './trend-signal';

const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = `Использование: npm run allocator:backtest -- [опции]

  --from <YYYY-MM-DD>     Начало оценки (по умолчанию 2018-01-01)
  --to <YYYY-MM-DD>       Конец (по умолчанию сегодня)
  --assets <a,b>          Активы (по умолчанию BOT_ALLOCATOR_ASSETS или BTCUSDT,ETHUSDT)
  --sma <20,50,100,200>   Периоды SMA ансамбля
  --vol-target <0.4>      Целевая годовая волатильность (0 — выключено)
  --threshold <0.1>       Порог ребалансировки (доля капитала актива)
  --fee <0.001>           Комиссия на сторону
  --slippage <0.0005>     Проскальзывание на сторону
  --capital <1000>        Стартовый капитал USDT
  --random-runs <200>     Прогонов случайного тайминга для сравнения
`;

const parseDate = (value: string) => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Некорректная дата: ${value}`);
  }
  return timestamp;
};

const parseArgs = (argv: string[]) => {
  const config = getBotConfig();
  const options = {
    from: Date.UTC(2018, 0, 1),
    to: Math.floor(Date.now() / DAY_MS) * DAY_MS,
    assets: config.allocator.assets,
    smaPeriods: config.allocator.smaPeriods,
    volTarget: config.allocator.volTarget,
    volLookbackDays: config.allocator.volLookbackDays,
    rebalanceThresholdPct: config.allocator.rebalanceThresholdPct,
    minOrderUsdt: config.allocator.minOrderUsdt,
    feePct: config.feePct,
    slippagePct: 0.0005,
    capital: config.allocator.paperInitialBalance,
    randomRuns: 200,
  };
  const numberArg = (flag: string, value: string | undefined) => {
    const parsed = Number(value);
    if (value === undefined || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Некорректное значение для ${flag}: ${value}`);
    }
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const consume = () => {
      index += 1;
      return value;
    };

    switch (flag) {
      case '--from':
        options.from = parseDate(consume());
        break;
      case '--to':
        options.to = parseDate(consume());
        break;
      case '--assets':
        options.assets = consume()
          .split(',')
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean);
        break;
      case '--sma':
        options.smaPeriods = consume()
          .split(',')
          .map(Number)
          .filter((period) => Number.isInteger(period) && period > 1);
        break;
      case '--vol-target':
        options.volTarget = numberArg(flag, consume());
        break;
      case '--threshold':
        options.rebalanceThresholdPct = numberArg(flag, consume());
        break;
      case '--fee':
        options.feePct = numberArg(flag, consume());
        break;
      case '--slippage':
        options.slippagePct = numberArg(flag, consume());
        break;
      case '--capital':
        options.capital = numberArg(flag, consume());
        break;
      case '--random-runs':
        options.randomRuns = Math.floor(numberArg(flag, consume()));
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Неизвестная опция: ${flag}\n\n${USAGE}`);
    }
  }

  if (options.smaPeriods.length === 0) {
    throw new Error('Нужен хотя бы один период SMA');
  }

  return options;
};

const pct = (value: number, digits = 1) =>
  `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
const date = (timestamp: number) =>
  new Date(timestamp).toISOString().slice(0, 10);

const printTable = (headers: string[], rows: string[][]) => {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => row[column].length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
  console.log();
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const warmupDays = getRequiredHistoryDays(options) + 5;
  const loadFrom = options.from - warmupDays * DAY_MS;
  const cacheDir = join(process.cwd(), '.backtest-cache');

  console.log('\n=== Бэктест трендового аллокатора ===\n');
  console.log(`Период:        ${date(options.from)} → ${date(options.to)}`);
  console.log(
    `Активы:        ${options.assets.join(', ')} (капитал делится поровну)`,
  );
  console.log(
    `Сигнал:        ансамбль SMA ${options.smaPeriods.join('/')}` +
      (options.volTarget > 0
        ? `, vol-target ${(options.volTarget * 100).toFixed(0)}%`
        : ', без vol-target'),
  );
  console.log(
    `Издержки:      комиссия ${(options.feePct * 100).toFixed(3)}% + проскальзывание ${(options.slippagePct * 100).toFixed(3)}% на сторону`,
  );
  console.log(
    `Ребалансировка: при отклонении > ${(options.rebalanceThresholdPct * 100).toFixed(0)}% от доли актива\n`,
  );

  const closesBySymbol: Record<string, Map<number, number>> = {};
  for (const symbol of options.assets) {
    process.stdout.write(`Загрузка ${symbol} 1d... `);
    const candles = await loadHistoricalCandles({
      symbol,
      interval: '1d',
      startTime: loadFrom,
      endTime: options.to,
      restBaseUrl: getBotConfig().allocator.dataRestBaseUrl,
      cacheDir,
    });
    closesBySymbol[symbol] = new Map(
      candles.map((candle) => [
        Math.floor(candle.openTime / DAY_MS) * DAY_MS,
        candle.close,
      ]),
    );
    console.log(`${candles.length} дней`);
  }

  const firstDay = Math.min(
    ...Object.values(closesBySymbol).flatMap((closes) =>
      [...closes.keys()].slice(0, 1),
    ),
  );
  const series: DailySeries = { dates: [], closes: {} };
  for (const symbol of options.assets) series.closes[symbol] = [];
  for (let day = firstDay; day < options.to; day += DAY_MS) {
    series.dates.push(day);
    for (const symbol of options.assets) {
      series.closes[symbol].push(closesBySymbol[symbol].get(day) ?? null);
    }
  }

  const baseParams: SimulationParams = {
    smaPeriods: options.smaPeriods,
    volTarget: options.volTarget,
    volLookbackDays: options.volLookbackDays,
    initialCapital: options.capital,
    feePct: options.feePct,
    slippagePct: options.slippagePct,
    rebalanceThresholdPct: options.rebalanceThresholdPct,
    minOrderUsdt: options.minOrderUsdt,
    startAt: options.from,
  };

  const strategy = simulateAllocator(series, baseParams);
  const strategyStats = computePerformance(strategy.equityCurve);
  const buyHold = simulateAllocator(series, {
    ...baseParams,
    exposureOverride: () => 1,
  });
  const buyHoldStats = computePerformance(buyHold.equityCurve);

  const randomStats: PerformanceStats[] = [];
  for (let run = 0; run < options.randomRuns; run += 1) {
    const exposure = createRandomTimingExposure(7919 * (run + 1));
    randomStats.push(
      computePerformance(
        simulateAllocator(series, {
          ...baseParams,
          exposureOverride: (symbol) => exposure(symbol),
        }).equityCurve,
      ),
    );
  }
  const sortedRandom = [...randomStats].sort((a, b) => a.cagrPct - b.cagrPct);
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const beatenShare = randomStats.length
    ? (randomStats.filter((run) => run.cagrPct < strategyStats.cagrPct).length /
        randomStats.length) *
      100
    : 0;

  const row = (label: string, stats: PerformanceStats) => [
    label,
    pct(stats.cagrPct),
    `${stats.maxDrawdownPct.toFixed(1)}%`,
    stats.sharpe.toFixed(2),
    `x${(stats.endEquity / stats.startEquity).toFixed(2)}`,
  ];

  console.log('\n--- Результаты ---\n');
  printTable(
    ['Вариант', 'Годовых', 'Макс. просадка', 'Sharpe', 'Рост капитала'],
    [
      row('Трендовый аллокатор', strategyStats),
      row('Buy & hold (те же активы)', buyHoldStats),
      ...(randomStats.length
        ? [
            [
              `Случайный тайминг (медиана из ${randomStats.length})`,
              pct(median(randomStats.map((run) => run.cagrPct))),
              `${median(randomStats.map((run) => run.maxDrawdownPct)).toFixed(1)}%`,
              median(randomStats.map((run) => run.sharpe)).toFixed(2),
              '',
            ],
          ]
        : []),
    ],
  );

  console.log('--- По годам ---\n');
  printTable(
    ['Год', 'Аллокатор', 'Buy & hold'],
    Object.keys(strategyStats.byYearPct).map((year) => [
      year,
      pct(strategyStats.byYearPct[year]),
      pct(buyHoldStats.byYearPct[year] ?? 0),
    ]),
  );

  const years = (options.to - options.from) / (365 * DAY_MS);
  console.log('--- Детали ---\n');
  console.log(
    `Средняя доля капитала в монетах: ${strategy.averageExposurePct.toFixed(0)}%`,
  );
  console.log(
    `Сделок: ${strategy.trades.length} (≈${(strategy.trades.length / Math.max(years, 1 / 365)).toFixed(0)} в год), комиссии: ${strategy.feesPaid.toFixed(2)} USDT`,
  );
  if (randomStats.length) {
    console.log(
      `Аллокатор лучше ${beatenShare.toFixed(1)}% случайных таймингов по годовой доходности ` +
        `(95-й перцентиль случайных: ${pct(sortedRandom[Math.floor(sortedRandom.length * 0.95)].cagrPct)})`,
    );
  }
  console.log(
    '\nВажно: это история, а не гарантия. Стратегия зарабатывает на длинных трендах крипторынка ' +
      'и сокращает потери в медвежьих фазах, но в боковике и при резких разворотах теряет на ложных сигналах.\n',
  );
}

main().catch((error: unknown) => {
  console.error(
    `\n[АЛЛОКАТОР][ОШИБКА] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
