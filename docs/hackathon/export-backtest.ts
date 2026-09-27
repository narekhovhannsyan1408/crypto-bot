// Данные графика для слайда «Backtest»: кривые капитала аллокатора и buy & hold.
// Запуск из корня проекта: npx ts-node --transpile-only docs/hackathon/export-backtest.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computePerformance,
  DailySeries,
  simulateAllocator,
} from '../../src/allocator/domain/allocator-simulator';
import { getRequiredHistoryDays } from '../../src/allocator/domain/trend-signal';
import { loadHistoricalCandles } from '../../src/backtest/history-loader';
import { getBotConfig } from '../../src/config/bot-config';

const DAY_MS = 86_400_000;
const SMA = [20, 50, 100, 200];

async function scenario(
  assets: string[],
  fromIso: string,
  feePct = 0.001,
  slippagePct = 0.0005,
) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const warmup =
    getRequiredHistoryDays({
      smaPeriods: SMA,
      volTarget: 0,
      volLookbackDays: 30,
    }) + 10;
  const closes: Record<string, Map<number, number>> = {};
  for (const symbol of assets) {
    const candles = await loadHistoricalCandles({
      symbol,
      interval: '1d',
      startTime: from - warmup * DAY_MS,
      endTime: to,
      restBaseUrl: getBotConfig().allocator.dataRestBaseUrl,
      cacheDir: join(process.cwd(), '.backtest-cache'),
    });
    closes[symbol] = new Map(
      candles.map((c) => [Math.floor(c.openTime / DAY_MS) * DAY_MS, c.close]),
    );
  }
  const firstDay = Math.min(
    ...Object.values(closes).map((m) => [...m.keys()][0]),
  );
  const series: DailySeries = { dates: [], closes: {} };
  for (const symbol of assets) series.closes[symbol] = [];
  for (let day = firstDay; day < to; day += DAY_MS) {
    series.dates.push(day);
    for (const symbol of assets)
      series.closes[symbol].push(closes[symbol].get(day) ?? null);
  }
  const params = {
    smaPeriods: SMA,
    volTarget: 0,
    volLookbackDays: 30,
    initialCapital: 1000,
    feePct,
    slippagePct,
    rebalanceThresholdPct: 0.1,
    minOrderUsdt: 10,
    startAt: from,
  };
  const strategy = simulateAllocator(series, params);
  const hold = simulateAllocator(series, {
    ...params,
    exposureOverride: () => 1,
  });
  const weekly = (curve: Array<{ timestamp: number; equity: number }>) =>
    curve
      .filter((_, index) => index % 7 === 0 || index === curve.length - 1)
      .map((point) => [point.timestamp, Math.round(point.equity * 100) / 100]);
  const stats = (curve: Array<{ timestamp: number; equity: number }>) => {
    const { cagrPct, maxDrawdownPct, sharpe, endEquity, startEquity } =
      computePerformance(curve);
    return { cagrPct, maxDrawdownPct, sharpe, endEquity, startEquity };
  };
  return {
    from: fromIso,
    strategy: weekly(strategy.equityCurve),
    hold: weekly(hold.equityCurve),
    stats: stats(strategy.equityCurve),
    holdStats: stats(hold.equityCurve),
  };
}

async function main() {
  const btcEth = await scenario(['BTCUSDT', 'ETHUSDT'], '2018-01-01');
  const withSol = await scenario(
    ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    '2021-06-01',
  );
  // Те же сигналы с издержками уровня DEX (Jupiter): без комиссии биржи, 0.03% на сторону
  const jupiter = await scenario(
    ['BTCUSDT', 'ETHUSDT'],
    '2018-01-01',
    0,
    0.0003,
  );
  const data = {
    btcEth,
    jupiterCosts: jupiter.stats,
    withSol: withSol.stats,
    withSolHold: withSol.holdStats,
  };
  writeFileSync(
    join(__dirname, 'assets', 'backtest-data.js'),
    '// Сгенерировано docs/hackathon/export-backtest.ts\n' +
      `window.BACKTEST = ${JSON.stringify(data)};\n`,
  );
  console.log(
    `BTC+ETH: ${btcEth.stats.cagrPct.toFixed(1)}%/yr vs ${btcEth.holdStats.cagrPct.toFixed(1)}%, ` +
      `max DD ${btcEth.stats.maxDrawdownPct.toFixed(1)}% vs ${btcEth.holdStats.maxDrawdownPct.toFixed(1)}%; ` +
      `Jupiter costs ${jupiter.stats.cagrPct.toFixed(1)}%/yr; with SOL ${withSol.stats.cagrPct.toFixed(1)}%/yr`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
