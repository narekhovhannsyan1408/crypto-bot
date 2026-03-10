import { Module } from '@nestjs/common';
import { StrategyService } from './strategy/strategy.service';

@Module({
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
