import { DynamicModule, Module } from '@nestjs/common';
import { AllocatorModule } from './allocator/allocator.module';
import { BotModule } from './bot/bot.module';
import { BotConfig, getBotConfig } from './config/bot-config';
import { LoggerModule } from './logger/logger.module';
import { MarketModule } from './market/market.module';
import { ScannerModule } from './scanner/scanner.module';
import { StrategyModule } from './strategy/strategy.module';
import { StreamingModule } from './streaming/streaming.module';
import { TraderModule } from './trader/trader.module';
import { WebModule } from './web/web.module';

/**
 * Модули внутридневных стратегий подключаются только в режиме intraday —
 * в основном режиме (трендовый аллокатор) они не нужны.
 */
@Module({})
export class AppModule {
  static forRoot(
    strategyMode: BotConfig['strategyMode'] = getBotConfig().strategyMode,
  ): DynamicModule {
    const intradayModules =
      strategyMode === 'intraday'
        ? [MarketModule, StrategyModule, TraderModule, ScannerModule, BotModule]
        : [];

    return {
      module: AppModule,
      imports: [
        StreamingModule,
        LoggerModule,
        AllocatorModule,
        ...intradayModules,
        WebModule.forRoot(strategyMode),
      ],
    };
  }
}
