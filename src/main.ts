import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AllocatorEngine } from './allocator/engine/allocator-engine.service';
import { AppModule } from './app.module';
import { setupHttpApp } from './app.setup';
import { BotRunnerService } from './bot/bot-runner/bot-runner.service';
import { getBotConfig } from './config/bot-config';

process.on('uncaughtException', (error) => {
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][uncaughtException]', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][unhandledRejection]', reason);
});

async function bootstrap() {
  const config = getBotConfig();
  const appModule = AppModule.forRoot(config.strategyMode);
  console.log(`[СИСТЕМА] Запуск, режим стратегии: ${config.strategyMode}`);

  let app:
    | NestExpressApplication
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  if (config.dashboardEnabled) {
    const httpApp = setupHttpApp(
      await NestFactory.create<NestExpressApplication>(appModule),
    );
    await httpApp.listen(config.dashboardPort, config.dashboardHost);
    console.log(
      `[DASHBOARD] Откройте http://${config.dashboardHost}:${config.dashboardPort}`,
    );
    app = httpApp;
  } else {
    app = await NestFactory.createApplicationContext(appModule);
    app.enableShutdownHooks();
  }

  if (config.strategyMode === 'trend_allocator') {
    await app.get(AllocatorEngine).resumeIfRunning();
  } else {
    await app.get(BotRunnerService).start();
  }
}

bootstrap().catch((error) => {
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][bootstrap]', error);
  process.exit(1);
});
