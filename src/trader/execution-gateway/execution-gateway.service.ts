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
    const marketType = this.resolveOpenMarketType('LONG');

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
        marketType,
      );
    }

    return this.liveTrader.tryOpenLong(
      this.executionControl.getMode(),
      marketType,
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
    const marketType = this.resolvePositionMarketType(symbol, strategyId, 'spot');

    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.tryCloseLong(
        symbol,
        strategyId,
        price,
        timestamp,
        reason,
        marketType,
      );
    }

    return this.liveTrader.tryCloseLong(
      this.executionControl.getMode(),
      marketType,
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
    const marketType = this.resolveOpenMarketType('SHORT');

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
        marketType,
      );
    }

    return this.liveTrader.tryOpenShort(
      this.executionControl.getMode(),
      marketType,
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
    const marketType = this.resolvePositionMarketType(symbol, strategyId, 'futures');

    if (this.executionControl.getMode() === 'paper') {
      return this.paperTrader.tryCloseShort(
        symbol,
        strategyId,
        price,
        timestamp,
        reason,
        marketType,
      );
    }

    return this.liveTrader.tryCloseShort(
      this.executionControl.getMode(),
      marketType,
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

    if (this.executionControl.getMarketType() === 'hybrid') {
      const [spotStatus, futuresStatus] = await Promise.all([
        this.liveTrader.refreshAccountStatus(this.executionControl.getMode(), 'spot'),
        this.liveTrader.refreshAccountStatus(this.executionControl.getMode(), 'futures'),
      ]);
      const status = this.mergeHybridStatus(spotStatus, futuresStatus);
      this.executionControl.updateStatus(status);
      if (status.accountConnectivity === 'ok') {
        this.liveTrader.syncPortfolioBalance(status);
      }
      return this.executionControl.getStatus();
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
      canTradeShort: this.executionControl.getMarketType() !== 'spot',
      longMarketType:
        this.executionControl.getMarketType() === 'futures' ? 'futures' : 'spot',
      shortMarketType:
        this.executionControl.getMarketType() === 'spot' ? 'spot' : 'futures',
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

  private resolveOpenMarketType(side: 'LONG' | 'SHORT'): 'spot' | 'futures' {
    const configuredMarketType = this.executionControl.getMarketType();

    if (configuredMarketType === 'hybrid') {
      return side === 'LONG' ? 'spot' : 'futures';
    }

    return configuredMarketType;
  }

  private resolvePositionMarketType(
    symbol: string,
    strategyId: string,
    fallback: 'spot' | 'futures',
  ): 'spot' | 'futures' {
    const position = this.portfolio.getPosition(symbol, strategyId);
    return position?.marketType ?? fallback;
  }

  private mergeHybridStatus(
    spotStatus: ExecutionStatus,
    futuresStatus: ExecutionStatus,
  ): ExecutionStatus {
    const quoteFree =
      (spotStatus.quoteFree ?? 0) + (futuresStatus.quoteFree ?? 0);
    const quoteTotal =
      (spotStatus.quoteTotal ?? 0) + (futuresStatus.quoteTotal ?? 0);
    const warnings = [...(spotStatus.warnings ?? []), ...(futuresStatus.warnings ?? [])];
    const lastError = [spotStatus.lastError, futuresStatus.lastError].filter(Boolean).join(' | ');

    return {
      mode: this.executionControl.getMode(),
      marketType: 'hybrid',
      label:
        this.executionControl.getMode() === 'live_testnet'
          ? 'LIVE DEMO HYBRID'
          : 'LIVE REAL HYBRID',
      canTradeShort: true,
      longMarketType: 'spot',
      shortMarketType: 'futures',
      liveTradingEnabled: true,
      usingTestnet: this.executionControl.getMode() === 'live_testnet',
      allowLiveReal: this.config.allowLiveReal,
      apiConfigured: spotStatus.apiConfigured && futuresStatus.apiConfigured,
      accountConnectivity:
        spotStatus.accountConnectivity === 'ok' && futuresStatus.accountConnectivity === 'ok'
          ? 'ok'
          : 'error',
      quoteAsset: 'USDT',
      quoteFree,
      quoteTotal,
      lastSyncAt: Date.now(),
      lastError: lastError || null,
      userDataStreamStatus: spotStatus.userDataStreamStatus,
      userDataStreamLastEventAt: spotStatus.userDataStreamLastEventAt,
      userDataStreamLastExecutionReportAt: spotStatus.userDataStreamLastExecutionReportAt,
      openSpotOrdersCount: spotStatus.openSpotOrdersCount,
      spotAssetsCount: spotStatus.spotAssetsCount,
      spotAssetsPreview: spotStatus.spotAssetsPreview,
      warnings: [...new Set(warnings)],
    };
  }
}
