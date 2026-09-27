import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { BreakoutVolatilityStrategyService } from '../breakout-volatility/breakout-volatility.strategy.service';
import { MarketRegimeSwitcherStrategyService } from '../market-regime-switcher/market-regime-switcher.strategy.service';
import { MeanReversionStrategyService } from '../mean-reversion/mean-reversion.strategy.service';
import { RangeScalpingStrategyService } from '../range-scalping/range-scalping.strategy.service';
import { StrategyService } from '../strategy/strategy.service';
import { TrendPullbackStrategyService } from '../trend-pullback/trend-pullback.strategy.service';
import { VolumeSpikeReversalStrategyService } from '../volume-spike-reversal/volume-spike-reversal.strategy.service';
import { TradingStrategy } from '../types';

@Injectable()
export class StrategyRegistryService {
  private readonly config = getBotConfig();
  private readonly strategies: TradingStrategy[];

  constructor(
    momentumTrendStrategy: StrategyService,
    meanReversionStrategy: MeanReversionStrategyService,
    breakoutVolatilityStrategy: BreakoutVolatilityStrategyService,
    trendPullbackStrategy: TrendPullbackStrategyService,
    rangeScalpingStrategy: RangeScalpingStrategyService,
    volumeSpikeReversalStrategy: VolumeSpikeReversalStrategyService,
    marketRegimeSwitcherStrategy: MarketRegimeSwitcherStrategyService,
  ) {
    const allStrategies = [
      momentumTrendStrategy,
      meanReversionStrategy,
      breakoutVolatilityStrategy,
      trendPullbackStrategy,
      rangeScalpingStrategy,
      volumeSpikeReversalStrategy,
      marketRegimeSwitcherStrategy,
    ];
    const enabled = new Set(this.config.enabledStrategies);

    this.strategies = allStrategies.filter((strategy) =>
      enabled.has(strategy.id),
    );
  }

  getStrategies() {
    return this.strategies;
  }

  getStrategyById(strategyId: string) {
    return (
      this.strategies.find((strategy) => strategy.id === strategyId) ?? null
    );
  }
}
