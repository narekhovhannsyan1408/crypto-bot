import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AllocatorModule } from '../allocator/allocator.module';
import { BotModule } from '../bot/bot.module';
import { BotConfig } from '../config/bot-config';
import { StreamingModule } from '../streaming/streaming.module';
import { DashboardSocketService } from './legacy-dashboard/dashboard-socket.service';
import { LegacyDashboardController } from './legacy-dashboard/legacy-dashboard.controller';
import { LegacyRuntimeService } from './legacy-dashboard/legacy-runtime.service';
import { TrustedRequestGuard } from './security/trusted-request.guard';

@Module({})
export class WebModule {
  static forRoot(strategyMode: BotConfig['strategyMode']): DynamicModule {
    return {
      module: WebModule,
      imports: [
        StreamingModule,
        AllocatorModule,
        ...(strategyMode === 'intraday' ? [BotModule] : []),
      ],
      controllers: [LegacyDashboardController],
      providers: [
        LegacyRuntimeService,
        DashboardSocketService,
        { provide: APP_GUARD, useClass: TrustedRequestGuard },
      ],
    };
  }
}
