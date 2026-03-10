import { Module } from '@nestjs/common';
import { PaperTraderService } from './paper-trader/paper-trader.service';
import { PortfolioService } from './portfolio/portfolio.service';

@Module({
  providers: [PaperTraderService, PortfolioService],
  exports: [PaperTraderService, PortfolioService],
})
export class TraderModule {}
