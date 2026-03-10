import { Module } from '@nestjs/common';
import { BacktestEngineService } from './backtest-engine/backtest-engine.service';

@Module({
  providers: [BacktestEngineService],
  exports: [BacktestEngineService],
})
export class BacktestModule {}
