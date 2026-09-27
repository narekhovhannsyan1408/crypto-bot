import { Module } from '@nestjs/common';
import { LoggerModule } from '../logger/logger.module';
import { AllocatorMarketDataService } from './allocator-market-data.service';
import { AllocatorRunnerService } from './allocator-runner.service';

@Module({
  imports: [LoggerModule],
  providers: [AllocatorMarketDataService, AllocatorRunnerService],
  exports: [AllocatorRunnerService],
})
export class AllocatorModule {}
