import { Module } from '@nestjs/common';
import { HigherTimeframeConfirmationService } from './higher-timeframe-confirmation/higher-timeframe-confirmation.service';
import { MeanReversionStrategyService } from './mean-reversion/mean-reversion.strategy.service';
import { StrategyService } from './strategy/strategy.service';
import { StrategyRegistryService } from './strategy-registry/strategy-registry.service';

@Module({
  providers: [
    StrategyService,
    MeanReversionStrategyService,
    StrategyRegistryService,
    HigherTimeframeConfirmationService,
  ],
  exports: [
    StrategyService,
    MeanReversionStrategyService,
    StrategyRegistryService,
    HigherTimeframeConfirmationService,
  ],
})
export class StrategyModule {}
