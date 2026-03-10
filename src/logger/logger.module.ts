import { Module } from '@nestjs/common';
import { BotLoggerService } from './bot-logger/bot-logger.service';
import { StreamingModule } from '../streaming/streaming.module';

@Module({
  imports: [StreamingModule],
  providers: [BotLoggerService],
  exports: [BotLoggerService],
})
export class LoggerModule {}
