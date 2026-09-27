import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AllocatorEngine } from './allocator/engine/allocator-engine.service';
import { AppModule } from './app.module';
import { setupHttpApp } from './app.setup';
import { BotRunnerService } from './bot/bot-runner/bot-runner.service';
import { getBotConfig } from './config/bot-config';
import { getAppLogger } from './observability/app-logger';
import { NestLoggerBridge } from './observability/nest-logger.bridge';
import { installProcessMonitor } from './observability/process-monitor';

const config = getBotConfig();
const logger = getAppLogger();
installProcessMonitor(logger, config);

async function bootstrap() {
  const appModule = AppModule.forRoot(config.strategyMode);
  const nestLogger = new NestLoggerBridge(logger);
  console.log(`[СИСТЕМА] Запуск, режим стратегии: ${config.strategyMode}`);
  console.log(`[СИСТЕМА] Диагностический журнал: ${config.logging.dir}`);

  let app:
    | NestExpressApplication
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  if (config.dashboardEnabled) {
    const httpApp = setupHttpApp(
      await NestFactory.create<NestExpressApplication>(appModule, {
        logger: nestLogger,
      }),
      logger,
    );
    await httpApp.listen(config.dashboardPort, config.dashboardHost);
    console.log(
      `[DASHBOARD] Откройте http://${config.dashboardHost}:${config.dashboardPort}`,
    );
    app = httpApp;
  } else {
    app = await NestFactory.createApplicationContext(appModule, {
      logger: nestLogger,
    });
    app.enableShutdownHooks();
  }

  logger.info('process.ready', 'Приложение готово к работе', {
    strategyMode: config.strategyMode,
  });

  if (config.strategyMode === 'trend_allocator') {
    await app.get(AllocatorEngine).resumeIfRunning();
  } else {
    await app.get(BotRunnerService).start();
  }
}

bootstrap().catch((error) => {
  logger.fatal('process.bootstrap_failed', 'Приложение не запустилось', error);
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][bootstrap]', error);
  process.exit(1);
});
