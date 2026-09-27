/**
 * CLI-бэктест на реальной истории Binance.
 *
 *   npm run backtest -- --days 90 --symbols BTCUSDT,ETHUSDT --inverted
 *
 * Прогоняет текущий конфиг бота (.env) через стратегии, RiskManager и paper-исполнение,
 * сравнивает результат со случайными входами и (опционально) с инвертированными сигналами
 * и печатает вердикт: есть ли у стратегии преимущество, покрывающее издержки.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getBotConfig,
  intervalToMs,
  resetBotConfigCache,
} from '../config/bot-config';
import { Candle } from '../market/types';
import { TradingStrategy } from '../strategy/types';
import { BacktestEngineService } from './backtest-engine/backtest-engine.service';
import {
  BacktestSummary,
  buildVerdict,
  summarizeBacktest,
} from './backtest-summary';
import {
  createRandomEntryStrategy,
  invertStrategy,
} from './baseline-strategies';
import { loadHistoricalCandles } from './history-loader';

type CliOptions = {
  symbols?: string[];
  interval?: string;
  days: number;
  fee?: number;
  slippage: number;
  strategies?: string[];
  randomRuns: number;
  inverted: boolean;
  restUrl: string;
  json?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = `Использование: npm run backtest -- [опции]

  --days <n>            Сколько дней истории (по умолчанию 90)
  --symbols <a,b>       Символы (по умолчанию BOT_ALLOWED_SYMBOLS или BOT_SYMBOL)
  --interval <5m>       Таймфрейм (по умолчанию BOT_INTERVAL)
  --strategies <a,b>    Стратегии (по умолчанию BOT_ENABLED_STRATEGIES)
  --fee <0.001>         Комиссия на сторону (по умолчанию BOT_FEE_PCT)
  --slippage <0.0005>   Проскальзывание на сторону (по умолчанию 0.0005 = 0.05%)
  --random-runs <n>     Прогонов со случайными входами для сравнения (по умолчанию 3, 0 — выключить)
  --inverted            Дополнительно прогнать сигналы наоборот (long <-> short)
  --rest-url <url>      REST Binance для истории (по умолчанию https://api.binance.com)
  --json <file>         Сохранить полные отчёты в JSON
`;

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    days: 90,
    slippage: 0.0005,
    randomRuns: 3,
    inverted: false,
    restUrl: 'https://api.binance.com',
  };
  const list = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const positiveNumber = (flag: string, value: string | undefined) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Некорректное значение для ${flag}: ${value}`);
    }
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Для ${flag} нужно значение`);
      }
      index += 1;
      return value;
    };

    switch (flag) {
      case '--days':
        options.days = positiveNumber(flag, next());
        break;
      case '--symbols':
        options.symbols = list(next()).map((symbol) => symbol.toUpperCase());
        break;
      case '--interval':
        options.interval = next();
        break;
      case '--strategies':
        options.strategies = list(next());
        break;
      case '--fee':
        options.fee = positiveNumber(flag, next());
        break;
      case '--slippage':
        options.slippage = positiveNumber(flag, next());
        break;
      case '--random-runs':
        options.randomRuns = Math.floor(positiveNumber(flag, next()));
        break;
      case '--inverted':
        options.inverted = true;
        break;
      case '--rest-url':
        options.restUrl = next();
        break;
      case '--json':
        options.json = next();
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

  return options;
};

const applyEnvOverrides = (options: CliOptions) => {
  if (options.fee !== undefined) process.env.BOT_FEE_PCT = String(options.fee);
  if (options.strategies)
    process.env.BOT_ENABLED_STRATEGIES = options.strategies.join(',');
  process.env.BOT_SLIPPAGE_PCT = String(options.slippage);
  resetBotConfigCache();
};

const money = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const pct = (value: number, digits = 2) =>
  `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
const date = (timestamp: number) =>
  new Date(timestamp).toISOString().slice(0, 10);

const printTable = (headers: string[], rows: (string | number)[][]) => {
  const cells = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) =>
    Math.max(...cells.map((row) => row[column].length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join('  ');

  console.log(line(cells[0]));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of cells.slice(1)) console.log(line(row));
  console.log();
};

const summaryRow = (label: string, summary: BacktestSummary) => [
  label,
  summary.trades,
  pct(summary.winRatePct, 1).replace('+', ''),
  money(summary.grossPnl),
  money(-summary.feesPaid),
  money(summary.netPnl),
  pct(summary.netPerTradePct, 3),
  `${summary.maxDrawdownPct.toFixed(1)}%`,
];

const SUMMARY_HEADERS = [
  'Вариант',
  'Сделок',
  'Win rate',
  'До комиссий $',
  'Комиссии $',
  'Итог $',
  'На сделку',
  'Макс. просадка',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  applyEnvOverrides(options);

  const config = getBotConfig();
  const interval = options.interval ?? config.interval;
  const symbols =
    options.symbols ??
    (config.allowedSymbols.length > 0
      ? config.allowedSymbols
      : [config.symbol]);
  const endTime = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const startTime = endTime - options.days * DAY_MS;
  const cacheDir = join(process.cwd(), '.backtest-cache');

  console.log('\n=== Бэктест crypto-bot ===\n');
  console.log(
    `Период:      ${date(startTime)} → ${date(endTime)} (${options.days} дн.)`,
  );
  console.log(`Символы:     ${symbols.join(', ')}`);
  console.log(`Таймфрейм:   ${interval}`);
  console.log(`Стратегии:   ${config.enabledStrategies.join(', ')}`);
  console.log(
    `Выходы:      стоп ${pct(config.stopLossPct * 100)}, тейк ${pct(config.takeProfitPct * 100)}, трейлинг ${pct(config.trailingStopPct * 100)}, ` +
      `безубыток ${config.breakevenTriggerPct > 0 ? pct(config.breakevenTriggerPct * 100) : 'выкл'}, ` +
      `time stop ${config.maxPositionHoldMinutes > 0 ? `${config.maxPositionHoldMinutes} мин` : 'выкл'}, ` +
      `выход по сигналу ${config.exitOnStrategySignal ? 'вкл' : 'выкл'}`,
  );
  console.log(
    `Издержки:    комиссия ${(config.feePct * 100).toFixed(3)}% + проскальзывание ${(config.slippagePct * 100).toFixed(3)}% на сторону`,
  );
  console.log(`Депозит:     ${config.initialBalance} USDT\n`);

  const candlesBySymbol: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    process.stdout.write(`Загрузка истории ${symbol} ${interval}... `);
    candlesBySymbol[symbol] = await loadHistoricalCandles({
      symbol,
      interval,
      startTime,
      endTime,
      restBaseUrl: options.restUrl,
      cacheDir,
    });
    console.log(`${candlesBySymbol[symbol].length} свечей`);
  }

  const candles = symbols.flatMap((symbol) => candlesBySymbol[symbol]);
  if (candles.length === 0) {
    throw new Error('История не загружена — проверь символы и интервал');
  }

  const costs = { feePct: config.feePct, slippagePct: config.slippagePct };
  const engine = new BacktestEngineService();
  const runVariant = (label: string, strategies?: TradingStrategy[]) => {
    const startedAt = Date.now();
    process.stdout.write(`Прогон: ${label}... `);
    const report = engine.runBacktest({ candles, strategies });
    console.log(`${((Date.now() - startedAt) / 1000).toFixed(0)} с`);
    return { label, report, summary: summarizeBacktest(report, costs) };
  };

  console.log('\nЭто может занять несколько минут.');
  const strategyRun = runVariant('стратегии бота');

  const barsPerSymbol = options.days * (DAY_MS / intervalToMs(interval));
  const entryProbability = Math.min(
    Math.max(
      (2 * strategyRun.summary.trades) /
        Math.max(barsPerSymbol * symbols.length, 1),
      0.002,
    ),
    0.05,
  );
  const strategyCount = Math.max(config.enabledStrategies.length, 1);
  const randomRuns = Array.from({ length: options.randomRuns }, (_, run) =>
    runVariant(
      `случайные входы #${run + 1}`,
      Array.from({ length: strategyCount }, (_, index) =>
        createRandomEntryStrategy(
          `random_${index + 1}`,
          1000 * (run + 1) + index,
          entryProbability,
        ),
      ),
    ),
  );
  const inverted = options.inverted
    ? runVariant(
        'сигналы наоборот',
        engine.buildStrategies().map((strategy) => invertStrategy(strategy)),
      )
    : null;

  console.log('\n--- Buy & hold за период (для сравнения) ---\n');
  printTable(
    ['Символ', 'Изменение цены'],
    symbols.map((symbol) => {
      const series = candlesBySymbol[symbol];
      return [
        symbol,
        pct((series.at(-1)!.close / series[0].open - 1) * 100, 1),
      ];
    }),
  );

  console.log('--- Результаты ---\n');
  printTable(SUMMARY_HEADERS, [
    summaryRow('Стратегии бота', strategyRun.summary),
    ...randomRuns.map((run) => summaryRow(run.label, run.summary)),
    ...(inverted ? [summaryRow('Сигналы наоборот', inverted.summary)] : []),
  ]);

  console.log('--- Стратегии бота: по стратегиям ---\n');
  printTable(
    ['Стратегия', 'Сделок', 'Win rate', 'Итог $'],
    Object.entries(strategyRun.summary.byStrategy).map(([id, stats]) => [
      id,
      stats.trades,
      `${stats.winRatePct.toFixed(1)}%`,
      money(stats.netPnl),
    ]),
  );

  console.log('--- Стратегии бота: как закрываются сделки ---\n');
  printTable(
    ['Выход', 'Сделок', 'Доля', 'Среднее до издержек', 'Итог $'],
    Object.entries(strategyRun.summary.byExit)
      .sort((left, right) => right[1].trades - left[1].trades)
      .map(([exit, stats]) => [
        exit,
        stats.trades,
        `${((stats.trades / Math.max(strategyRun.summary.trades, 1)) * 100).toFixed(1)}%`,
        pct(stats.avgBeforeCostsPct, 3),
        money(stats.netPnl),
      ]),
  );

  console.log('--- Стратегии бота: по месяцам ---\n');
  printTable(
    ['Месяц', 'Сделок', 'Win rate', 'Итог $'],
    Object.entries(strategyRun.summary.byMonth).map(([month, stats]) => [
      month,
      stats.trades,
      `${stats.winRatePct.toFixed(1)}%`,
      money(stats.netPnl),
    ]),
  );

  const haltedByDrawdown =
    strategyRun.report.maxDrawdownPct / 100 >= config.maxDrawdownStopPct;
  const verdict = buildVerdict({
    strategy: strategyRun.summary,
    randomBaseline: randomRuns.map((run) => run.summary),
    inverted: inverted?.summary ?? null,
    haltedByDrawdown,
  });

  console.log('--- Вердикт ---\n');
  console.log(
    `Средняя сделка: ${pct(strategyRun.summary.edgeBeforeCostsPct, 3)} до издержек, издержки на круг ${strategyRun.summary.costPerTradePct.toFixed(3)}%, ` +
      `средний выигрыш ${pct(strategyRun.summary.avgWinPct)}, средний проигрыш ${pct(strategyRun.summary.avgLossPct)}, удержание ${strategyRun.summary.avgHoldMinutes.toFixed(0)} мин`,
  );
  if (haltedByDrawdown && strategyRun.summary.lastTradeAt) {
    console.log(`Последняя сделка: ${date(strategyRun.summary.lastTradeAt)}`);
  }
  console.log();
  for (const finding of verdict.findings) console.log(`• ${finding}`);
  console.log(
    verdict.ready
      ? '\nИТОГ: есть признаки преимущества. Перед реальными деньгами проверь на другом периоде (--days) и в paper.'
      : '\nИТОГ: стратегия НЕ готова к реальным деньгам.',
  );
  console.log(
    '\nОграничения: бэктест не учитывает подтверждение старшим таймфреймом, сканер и адаптивный таймфрейм; ' +
      'стопы исполняются по цене стопа, а в live — рыночным ордером после закрытия свечи.\n',
  );

  if (options.json) {
    writeFileSync(
      options.json,
      JSON.stringify(
        {
          options,
          strategyRun,
          randomRuns,
          inverted,
          verdict,
        },
        null,
        2,
      ),
    );
    console.log(`Полные отчёты сохранены в ${options.json}`);
  }
}

main().catch((error: unknown) => {
  console.error(
    `\n[БЭКТЕСТ][ОШИБКА] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
