import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import {
  ExecutionMarketType,
  ExecutionMode,
  ExecutionStatus,
} from '../execution.types';

@Injectable()
export class ExecutionControlService {
  private readonly config = getBotConfig();
  private mode: ExecutionMode = this.config.executionMode;
  private marketType: ExecutionMarketType = this.config.executionMarketType;
  private lastStatus: ExecutionStatus = this.buildBaseStatus();

  getMode() {
    return this.mode;
  }

  getMarketType() {
    return this.marketType;
  }

  setExecutionMode(mode: ExecutionMode, marketType: ExecutionMarketType) {
    this.mode = mode;
    this.marketType = marketType;
    this.lastStatus = {
      ...this.lastStatus,
      mode,
      marketType,
      label: this.getModeLabel(mode, marketType),
      canTradeShort: marketType !== 'spot',
      longMarketType: marketType === 'futures' ? 'futures' : 'spot',
      shortMarketType: marketType === 'spot' ? 'spot' : 'futures',
      liveTradingEnabled: mode !== 'paper',
      usingTestnet: mode === 'live_testnet',
      allowLiveReal: this.config.allowLiveReal,
      warnings: this.mergeWarnings(mode, marketType, this.lastStatus.warnings),
    };
  }

  updateStatus(partial: Partial<ExecutionStatus>) {
    this.lastStatus = {
      ...this.lastStatus,
      ...partial,
      mode: partial.mode ?? this.mode,
      marketType: partial.marketType ?? this.marketType,
      label: partial.label ?? this.getModeLabel(this.mode, this.marketType),
      canTradeShort:
        partial.canTradeShort ?? this.lastStatus.canTradeShort ?? this.marketType !== 'spot',
      longMarketType:
        partial.longMarketType ??
        this.lastStatus.longMarketType ??
        (this.marketType === 'futures' ? 'futures' : 'spot'),
      shortMarketType:
        partial.shortMarketType ??
        this.lastStatus.shortMarketType ??
        (this.marketType === 'spot' ? 'spot' : 'futures'),
      liveTradingEnabled: partial.liveTradingEnabled ?? this.mode !== 'paper',
      usingTestnet: partial.usingTestnet ?? this.mode === 'live_testnet',
      allowLiveReal: this.config.allowLiveReal,
      warnings: this.mergeWarnings(
        partial.mode ?? this.mode,
        partial.marketType ?? this.marketType,
        partial.warnings ?? this.lastStatus.warnings,
      ),
    };
  }

  getStatus() {
    return this.lastStatus;
  }

  private buildBaseStatus(): ExecutionStatus {
    return {
      mode: this.mode,
      marketType: this.marketType,
      label: this.getModeLabel(this.mode, this.marketType),
      canTradeShort: this.marketType !== 'spot',
      longMarketType: this.marketType === 'futures' ? 'futures' : 'spot',
      shortMarketType: this.marketType === 'spot' ? 'spot' : 'futures',
      liveTradingEnabled: this.mode !== 'paper',
      usingTestnet: this.mode === 'live_testnet',
      allowLiveReal: this.config.allowLiveReal,
      apiConfigured: false,
      accountConnectivity: 'unknown',
      quoteAsset: 'USDT',
      quoteFree: null,
      quoteTotal: null,
      spotQuoteFree: null,
      spotQuoteTotal: null,
      futuresQuoteFree: null,
      futuresQuoteTotal: null,
      lastSyncAt: undefined,
      lastError: null,
      warnings: this.mergeWarnings(this.mode, this.marketType, []),
    };
  }

  private getModeLabel(mode: ExecutionMode, marketType: ExecutionMarketType) {
    if (mode === 'paper') {
      return 'PAPER';
    }

    if (mode === 'live_testnet') {
      if (marketType === 'hybrid') {
        return 'LIVE DEMO HYBRID';
      }
      return marketType === 'spot' ? 'LIVE DEMO SPOT' : 'LIVE DEMO FUTURES';
    }

    if (marketType === 'hybrid') {
      return 'LIVE REAL HYBRID';
    }

    return marketType === 'spot' ? 'LIVE REAL SPOT' : 'LIVE REAL FUTURES';
  }

  private mergeWarnings(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    warnings: string[],
  ) {
    const nextWarnings = [...warnings];

    if (mode === 'live_real' && !this.config.allowLiveReal) {
      nextWarnings.push(
        'Реальный LIVE запрещён конфигом. Для включения нужен BOT_ALLOW_LIVE_REAL=true',
      );
    }

    if (mode !== 'paper') {
      nextWarnings.push(
        'Live execution предполагает выделенный Binance-аккаунт или субаккаунт только для этого бота',
      );
    }

    if (marketType === 'spot') {
      nextWarnings.push('В режиме Spot short-сделки недоступны');
    }

    if (marketType === 'hybrid') {
      nextWarnings.push('Hybrid routing: long открывается на Spot, short открывается на Futures');
    }

    return [...new Set(nextWarnings)];
  }
}
