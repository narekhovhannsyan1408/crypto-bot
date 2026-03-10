import { Module } from '@nestjs/common';
import { BotLoggerService } from './bot-logger/bot-logger.service';

@Module({
  providers: [BotLoggerService],
  exports: [BotLoggerService],
})
export class LoggerModule {}
