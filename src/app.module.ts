import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { MarketModule } from './market/market.module';
import { StrategyModule } from './strategy/strategy.module';
import { TraderModule } from './trader/trader.module';
import { LoggerModule } from './logger/logger.module';

@Module({
  imports: [BotModule, MarketModule, StrategyModule, TraderModule, LoggerModule],
})
export class AppModule {}
