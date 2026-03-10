import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { TraderModule } from '../trader/trader.module';
import { StreamingModule } from '../streaming/streaming.module';
import { DashboardServerService } from './dashboard-server/dashboard-server.service';

@Module({
  imports: [BotModule, TraderModule, StreamingModule],
  providers: [DashboardServerService],
  exports: [DashboardServerService],
})
export class DashboardModule {}
