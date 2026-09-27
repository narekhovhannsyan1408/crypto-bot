import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BotConfig } from '../config/bot-config';
import { AppLogger } from './app-logger';
import { getBuildInfo } from './build-info';

const MB = 1024 * 1024;

/** Настройки для журнала без секретов и без длинных списков. */
export const describeConfig = (config: BotConfig) => ({
  strategyMode: config.strategyMode,
  executionMode: config.executionMode,
  allowLiveReal: config.allowLiveReal,
  apiKeys: {
    real: Boolean(config.binanceApiKey && config.binanceApiSecret),
    demo: Boolean(
      config.binanceTestnetApiKey && config.binanceTestnetApiSecret,
    ),
  },
  dashboard: config.dashboardEnabled
    ? `http://${config.dashboardHost}:${config.dashboardPort}`
    : 'выключен',
  allocator: {
    assets: config.allocator.assets,
    smaPeriods: config.allocator.smaPeriods,
    volTarget: config.allocator.volTarget,
    rebalanceThresholdPct: config.allocator.rebalanceThresholdPct,
    minOrderUsdt: config.allocator.minOrderUsdt,
    checkIntervalMs: config.allocator.checkIntervalMs,
    stateFile: config.allocator.stateFile,
    dataRestBaseUrl: config.allocator.dataRestBaseUrl,
  },
  feePct: config.feePct,
  slippagePct: config.slippagePct,
  logging: config.logging,
});

/**
 * Пишет в журнал старт процесса, регулярный heartbeat и падения.
 * По пропускам heartbeat видно, когда процесс не работал (например, компьютер спал).
 */
export const installProcessMonitor = (logger: AppLogger, config: BotConfig) => {
  const startedAt = Date.now();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  logger.info('process.started', 'Процесс бота запущен', {
    ...getBuildInfo(),
    pid: process.pid,
    cwd: process.cwd(),
    config: describeConfig(config),
  });

  const heartbeat = setInterval(() => {
    const memory = process.memoryUsage();
    logger.debug('process.heartbeat', 'Процесс работает', {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(memory.rss / MB),
      heapUsedMb: Math.round(memory.heapUsed / MB),
      // Долгие задержки цикла событий означают, что что-то блокирует процесс
      eventLoopDelayP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
      eventLoopDelayMaxMs: Math.round(loopDelay.max / 1e6),
    });
    loopDelay.reset();
  }, config.logging.heartbeatMs);
  heartbeat.unref();

  process.on('uncaughtException', (error) => {
    logger.fatal(
      'process.uncaught_exception',
      'Необработанное исключение',
      error,
    );
    console.error('[КРИТИЧЕСКАЯ_ОШИБКА][uncaughtException]', error);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      'process.unhandled_rejection',
      'Необработанный отказ промиса',
      reason,
    );
    console.error('[КРИТИЧЕСКАЯ_ОШИБКА][unhandledRejection]', reason);
  });
  process.on('exit', (code) => {
    logger.info('process.exit', 'Процесс завершается', {
      code,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  });
};
