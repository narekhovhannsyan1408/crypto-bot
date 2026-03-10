import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BotRunnerService } from './bot/bot-runner/bot-runner.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const runner = app.get(BotRunnerService);
  await runner.start();
}

bootstrap();
