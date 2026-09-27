import { Module } from '@nestjs/common';
import { LoggerModule } from '../logger/logger.module';
import { AllocatorController } from './api/allocator.controller';
import { BrokerFactory } from './brokers/broker.factory';
import { AllocatorEngine } from './engine/allocator-engine.service';
import { SignalService } from './engine/signal.service';
import { AllocatorMarketDataService } from './market-data/allocator-market-data.service';
import { SessionStore } from './session/session-store';

@Module({
  imports: [LoggerModule],
  controllers: [AllocatorController],
  providers: [
    AllocatorMarketDataService,
    BrokerFactory,
    SessionStore,
    SignalService,
    AllocatorEngine,
  ],
  exports: [AllocatorEngine],
})
export class AllocatorModule {}
