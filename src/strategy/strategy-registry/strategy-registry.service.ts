import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { MeanReversionStrategyService } from '../mean-reversion/mean-reversion.strategy.service';
import { StrategyService } from '../strategy/strategy.service';
import { TradingStrategy } from '../types';

@Injectable()
export class StrategyRegistryService {
  private readonly config = getBotConfig();
  private readonly strategies: TradingStrategy[];

  constructor(
    momentumTrendStrategy: StrategyService,
    meanReversionStrategy: MeanReversionStrategyService,
  ) {
    const allStrategies = [momentumTrendStrategy, meanReversionStrategy];
    const enabled = new Set(this.config.enabledStrategies);

    this.strategies = allStrategies.filter((strategy) => enabled.has(strategy.id));
  }

  getStrategies() {
    return this.strategies;
  }

  getStrategyById(strategyId: string) {
    return this.strategies.find((strategy) => strategy.id === strategyId) ?? null;
  }
}
