import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { MarketModule } from './market/market.module';
import { StrategyModule } from './strategy/strategy.module';
import { TraderModule } from './trader/trader.module';
import { LoggerModule } from './logger/logger.module';
import { ScannerModule } from './scanner/scanner.module';
import { BacktestModule } from './backtest/backtest.module';
import { StreamingModule } from './streaming/streaming.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AllocatorModule } from './allocator/allocator.module';

@Module({
  imports: [
    StreamingModule,
    BotModule,
    MarketModule,
    StrategyModule,
    TraderModule,
    LoggerModule,
    ScannerModule,
    BacktestModule,
    DashboardModule,
    AllocatorModule,
  ],
})
export class AppModule {}
