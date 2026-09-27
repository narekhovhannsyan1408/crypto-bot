import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { TraderModule } from '../trader/trader.module';
import { StreamingModule } from '../streaming/streaming.module';
import { AllocatorModule } from '../allocator/allocator.module';
import { DashboardServerService } from './dashboard-server/dashboard-server.service';

@Module({
  imports: [BotModule, TraderModule, StreamingModule, AllocatorModule],
  providers: [DashboardServerService],
  exports: [DashboardServerService],
})
export class DashboardModule {}
