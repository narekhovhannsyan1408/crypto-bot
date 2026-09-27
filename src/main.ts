import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllocatorRunnerService } from './allocator/allocator-runner.service';
import { getBotConfig } from './config/bot-config';
import { BotRunnerService } from './bot/bot-runner/bot-runner.service';
import { DashboardServerService } from './dashboard/dashboard-server/dashboard-server.service';

process.on('uncaughtException', (error) => {
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][uncaughtException]', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][unhandledRejection]', reason);
});

async function bootstrap() {
  console.log('[СИСТЕМА] Запуск приложения...');

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const runner = app.get(BotRunnerService);
  app.get(DashboardServerService);

  console.log('[СИСТЕМА] Контекст NestJS успешно создан');

  if (getBotConfig().strategyMode === 'trend_allocator') {
    console.log('[СИСТЕМА] Режим стратегии: trend_allocator');
    await app.get(AllocatorRunnerService).resumeIfRunning();
    return;
  }

  await runner.start();
}

bootstrap().catch((error) => {
  console.error('[КРИТИЧЕСКАЯ_ОШИБКА][bootstrap]', error);
});
