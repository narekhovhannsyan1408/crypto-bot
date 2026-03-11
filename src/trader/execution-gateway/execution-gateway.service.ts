import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { BinanceExecutionService } from '../binance-execution/binance-execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import {
  ExecutionMarketType,
  ExecutionMode,
  ExecutionStatus,
  TraderService,
} from '../execution.types';
import { PaperTraderService } from '../paper-trader/paper-trader.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { ExecutionResult } from '../types';

@Injectable()
export class ExecutionGatewayService implements TraderService {
  private readonly config = getBotConfig();

  constructor(
    private readonly paperTrader: PaperTraderService,
    private readonly liveTrader: BinanceExecutionService,
    private readonly executionControl: ExecutionControlService,
    private readonly portfolio: PortfolioService,
  ) {
    if (this.executionControl.getMode() === 'paper') {
      this.executionControl.updateStatus(this.buildPaperStatus());
    }
  }

  async tryOpenLong(
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> {
    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.tryOpenLong(
        symbol,
        interval,
        strategyId,
        strategyName,
        price,
        timestamp,
        reason,
        positionSizeUsdt,
      );
    }

    return this.liveTrader.tryOpenLong(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
      symbol,
      interval,
      strategyId,
      strategyName,
      price,
      timestamp,
      reason,
      positionSizeUsdt,
    );
  }

  async tryCloseLong(
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ) {
    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.tryCloseLong(
        symbol,
        strategyId,
        price,
        timestamp,
        reason,
      );
    }

    return this.liveTrader.tryCloseLong(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
      symbol,
      strategyId,
      price,
      timestamp,
      reason,
    );
  }

  async tryOpenShort(
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> {
    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.tryOpenShort(
        symbol,
        interval,
        strategyId,
        strategyName,
        price,
        timestamp,
        reason,
        positionSizeUsdt,
      );
    }

    return this.liveTrader.tryOpenShort(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
      symbol,
      interval,
      strategyId,
      strategyName,
      price,
      timestamp,
      reason,
      positionSizeUsdt,
    );
  }

  async tryCloseShort(
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ) {
    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.tryCloseShort(
        symbol,
        strategyId,
        price,
        timestamp,
        reason,
      );
    }

    return this.liveTrader.tryCloseShort(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
      symbol,
      strategyId,
      price,
      timestamp,
      reason,
    );
  }

  async checkStops(candle: Candle) {
    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.checkStops(candle);
    }

    return this.liveTrader.checkStops(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
      candle,
    );
  }

  getExecutionStatus() {
    return this.executionControl.getStatus();
  }

  async refreshExecutionStatus() {
    if (this.executionControl.getMode() === 'paper') {
      const status = this.buildPaperStatus();
      this.executionControl.updateStatus(status);
      return status;
    }

    const status = await this.liveTrader.refreshAccountStatus(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
    );
    this.executionControl.updateStatus(status);
    if (status.accountConnectivity === 'ok') {
      this.liveTrader.syncPortfolioBalance(status);
    }
    return this.executionControl.getStatus();
  }

  async liquidateAllSpotAssets(reason: string) {
    if (this.executionControl.getMode() === 'paper') {
      return {
        success: false,
        message: 'В режиме paper внешние spot-активы отсутствуют',
        soldAssets: [] as string[],
        skippedAssets: [] as Array<{ asset: string; reason: string }>,
      };
    }

    return this.liveTrader.liquidateAllSpotAssets(
      this.executionControl.getMode(),
      this.executionControl.getMarketType(),
      reason,
    );
  }

  async setExecutionMode(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    confirmationPhrase?: string,
  ) {
    const current = this.executionControl.getStatus();

    if (this.portfolio.getOpenPositionsCount() > 0) {
      return {
        success: false,
        message:
          'Нельзя переключать execution mode, пока есть открытые позиции. Сначала закрой позиции.',
        status: current,
      };
    }

    if (mode === 'live_real' && !this.config.allowLiveReal) {
      return {
        success: false,
        message:
          'LIVE REAL запрещён конфигом. Установи BOT_ALLOW_LIVE_REAL=true для осознанного включения.',
        status: current,
      };
    }

    if (mode === 'live_real' && confirmationPhrase !== 'ENABLE LIVE') {
      return {
        success: false,
        message:
          'Для включения LIVE REAL нужно явное подтверждение с фразой ENABLE LIVE.',
        status: current,
      };
    }

    this.executionControl.setExecutionMode(mode, marketType);
    const status = await this.refreshExecutionStatus();

    if (mode !== 'paper' && status.accountConnectivity !== 'ok') {
      this.executionControl.setExecutionMode(current.mode, current.marketType);
      await this.refreshExecutionStatus();

      return {
        success: false,
        message:
          status.lastError ||
          'Не удалось подключить live execution. Оставляем предыдущий режим.',
        status: this.executionControl.getStatus(),
      };
    }

    return {
      success: true,
      message: `Execution mode переключен на ${status.label}`,
      status,
    };
  }

  private buildPaperStatus(): Partial<ExecutionStatus> {
    return {
      mode: 'paper',
      marketType: this.executionControl.getMarketType(),
      label: 'PAPER',
      canTradeShort: true,
      liveTradingEnabled: false,
      usingTestnet: false,
      allowLiveReal: this.config.allowLiveReal,
      apiConfigured: false,
      accountConnectivity: 'unknown',
      quoteAsset: 'USDT',
      quoteFree: this.portfolio.balance,
      quoteTotal: this.portfolio.getEquity(),
      lastSyncAt: Date.now(),
      lastError: null,
      warnings: ['Paper trading: реальные ордера не отправляются'],
    };
  }
}
