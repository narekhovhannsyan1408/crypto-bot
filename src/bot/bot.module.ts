import { Module } from '@nestjs/common';
import { BotRunnerService } from './bot-runner/bot-runner.service';
import { MarketModule } from '../market/market.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TraderModule } from '../trader/trader.module';
import { LoggerModule } from '../logger/logger.module';

@Module({
  imports: [MarketModule, StrategyModule, TraderModule, LoggerModule],
  providers: [BotRunnerService],
  exports: [BotRunnerService],
})
export class BotModule {}
