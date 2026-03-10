import { Module } from '@nestjs/common';
import { BinanceExecutionService } from './binance-execution/binance-execution.service';
import { ExecutionControlService } from './execution-control/execution-control.service';
import { ExecutionGatewayService } from './execution-gateway/execution-gateway.service';
import { PaperTraderService } from './paper-trader/paper-trader.service';
import { PortfolioService } from './portfolio/portfolio.service';
import { RiskManagerService } from './risk-manager/risk-manager.service';

@Module({
  providers: [
    PaperTraderService,
    PortfolioService,
    RiskManagerService,
    ExecutionControlService,
    BinanceExecutionService,
    ExecutionGatewayService,
  ],
  exports: [
    PaperTraderService,
    PortfolioService,
    RiskManagerService,
    ExecutionControlService,
    BinanceExecutionService,
    ExecutionGatewayService,
  ],
})
export class TraderModule {}
