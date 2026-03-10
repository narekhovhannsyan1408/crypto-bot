import { Module } from '@nestjs/common';
import { PaperTraderService } from './paper-trader/paper-trader.service';
import { PortfolioService } from './portfolio/portfolio.service';
import { RiskManagerService } from './risk-manager/risk-manager.service';

@Module({
  providers: [PaperTraderService, PortfolioService, RiskManagerService],
  exports: [PaperTraderService, PortfolioService, RiskManagerService],
})
export class TraderModule {}
