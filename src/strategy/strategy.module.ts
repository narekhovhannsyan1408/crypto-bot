import { Module } from '@nestjs/common';
import { BreakoutVolatilityStrategyService } from './breakout-volatility/breakout-volatility.strategy.service';
import { HigherTimeframeConfirmationService } from './higher-timeframe-confirmation/higher-timeframe-confirmation.service';
import { MarketRegimeSwitcherStrategyService } from './market-regime-switcher/market-regime-switcher.strategy.service';
import { MeanReversionStrategyService } from './mean-reversion/mean-reversion.strategy.service';
import { RangeScalpingStrategyService } from './range-scalping/range-scalping.strategy.service';
import { StrategyArbitrationService } from './strategy-arbitration/strategy-arbitration.service';
import { StrategyService } from './strategy/strategy.service';
import { StrategyRegistryService } from './strategy-registry/strategy-registry.service';
import { TrendPullbackStrategyService } from './trend-pullback/trend-pullback.strategy.service';
import { VolumeSpikeReversalStrategyService } from './volume-spike-reversal/volume-spike-reversal.strategy.service';

@Module({
  providers: [
    StrategyService,
    MeanReversionStrategyService,
    BreakoutVolatilityStrategyService,
    TrendPullbackStrategyService,
    RangeScalpingStrategyService,
    VolumeSpikeReversalStrategyService,
    MarketRegimeSwitcherStrategyService,
    StrategyRegistryService,
    StrategyArbitrationService,
    HigherTimeframeConfirmationService,
  ],
  exports: [
    StrategyService,
    MeanReversionStrategyService,
    BreakoutVolatilityStrategyService,
    TrendPullbackStrategyService,
    RangeScalpingStrategyService,
    VolumeSpikeReversalStrategyService,
    MarketRegimeSwitcherStrategyService,
    StrategyRegistryService,
    StrategyArbitrationService,
    HigherTimeframeConfirmationService,
  ],
})
export class StrategyModule {}
