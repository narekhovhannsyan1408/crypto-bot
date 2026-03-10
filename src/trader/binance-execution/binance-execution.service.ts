import { Injectable } from '@nestjs/common';
import * as ccxt from 'ccxt';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PaperTraderService } from '../paper-trader/paper-trader.service';
import {
  ExecutionMarketType,
  ExecutionMode,
  ExecutionStatus,
} from '../execution.types';
import { ExecutionResult } from '../types';

@Injectable()
export class BinanceExecutionService {
  private readonly config = getBotConfig();
  private readonly clients = new Map<string, ccxt.Exchange>();

  constructor(
    private readonly portfolio: PortfolioService,
    private readonly paperTrader: PaperTraderService,
  ) {}

  async refreshAccountStatus(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
  ): Promise<ExecutionStatus> {
    const apiConfigured = this.hasCredentials(mode);

    if (mode === 'paper') {
      return this.buildStatus(mode, marketType, {
        apiConfigured: false,
        accountConnectivity: 'unknown',
        quoteFree: this.portfolio.balance,
        quoteTotal: this.portfolio.getEquity(),
        warnings: [],
      });
    }

    if (!apiConfigured) {
      return this.buildStatus(mode, marketType, {
        apiConfigured: false,
        accountConnectivity: 'error',
        lastError: 'Не заданы API credentials для выбранного режима',
      });
    }

    try {
      const client = await this.getClient(mode, marketType);
      const balance = await client.fetchBalance();
      const quoteAsset = 'USDT';
      const quoteWallet =
        (balance[quoteAsset] as { free?: number; total?: number } | undefined) ?? {};

      return this.buildStatus(mode, marketType, {
        apiConfigured: true,
        accountConnectivity: 'ok',
        quoteFree:
          typeof quoteWallet.free === 'number' && Number.isFinite(quoteWallet.free)
            ? quoteWallet.free
            : null,
        quoteTotal:
          typeof quoteWallet.total === 'number' && Number.isFinite(quoteWallet.total)
            ? quoteWallet.total
            : null,
        lastError: null,
      });
    } catch (error) {
      return this.buildStatus(mode, marketType, {
        apiConfigured: true,
        accountConnectivity: 'error',
        lastError: error instanceof Error ? error.message : 'Не удалось подключиться к Binance',
      });
    }
  }

  syncPortfolioBalance(status: ExecutionStatus) {
    this.portfolio.syncExternalUsdtWallet(status.quoteFree, status.quoteTotal);
  }

  async tryOpenLong(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> {
    return this.tryOpenPosition(
      mode,
      marketType,
      'LONG',
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

  async tryOpenShort(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> {
    return this.tryOpenPosition(
      mode,
      marketType,
      'SHORT',
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
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ): Promise<ExecutionResult | null> {
    return this.tryClosePosition(
      mode,
      marketType,
      'LONG',
      symbol,
      strategyId,
      price,
      timestamp,
      reason,
    );
  }

  async tryCloseShort(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ): Promise<ExecutionResult | null> {
    return this.tryClosePosition(
      mode,
      marketType,
      'SHORT',
      symbol,
      strategyId,
      price,
      timestamp,
      reason,
    );
  }

  async checkStops(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    candle: Candle,
  ): Promise<ExecutionResult[]> {
    if (mode === 'paper') {
      return this.paperTrader.checkStops(candle);
    }

    const positions = this.portfolio.getPositionsForSymbol(candle.symbol);
    const actions: ExecutionResult[] = [];

    for (const position of positions) {
      if (position.side === 'LONG') {
        if (candle.low <= position.stopPrice) {
          const action = await this.tryCloseLong(
            mode,
            marketType,
            candle.symbol,
            position.strategyId,
            position.stopPrice,
            candle.closeTime,
            'Стоп-лосс/трейлинг по лонгу',
          );
          if (action) actions.push(action);
          continue;
        }

        if (candle.high >= position.takePrice) {
          const action = await this.tryCloseLong(
            mode,
            marketType,
            candle.symbol,
            position.strategyId,
            position.takePrice,
            candle.closeTime,
            'Тейк-профит по лонгу',
          );
          if (action) actions.push(action);
        }
        continue;
      }

      if (candle.high >= position.stopPrice) {
        const action = await this.tryCloseShort(
          mode,
          marketType,
          candle.symbol,
          position.strategyId,
          position.stopPrice,
          candle.closeTime,
          'Стоп-лосс/трейлинг по шорту',
        );
        if (action) actions.push(action);
        continue;
      }

      if (candle.low <= position.takePrice) {
        const action = await this.tryCloseShort(
          mode,
          marketType,
          candle.symbol,
          position.strategyId,
          position.takePrice,
          candle.closeTime,
          'Тейк-профит по шорту',
        );
        if (action) actions.push(action);
      }
    }

    return actions;
  }

  private async tryOpenPosition(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    side: 'LONG' | 'SHORT',
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> {
    if (marketType === 'spot' && side === 'SHORT') {
      return {
        status: 'REJECTED',
        action: 'OPEN_SHORT',
        symbol,
        interval,
        strategyId,
        strategyName,
        reason: 'Режим Spot не поддерживает открытие short-позиции',
      };
    }

    const client = await this.getClient(mode, marketType);
    const marketSymbol = await this.getMarketSymbol(client, symbol);
    const amount = this.normalizeAmount(client, marketSymbol, positionSizeUsdt / price);
    const orderSide = side === 'LONG' ? 'buy' : 'sell';
    const order = await client.createOrder(marketSymbol, 'market', orderSide, amount);
    const executionPrice = this.resolveExecutionPrice(order, price);
    const executionTimestamp = order.timestamp ?? timestamp;
    const executionReason = `${reason} [${mode}/${marketType}]`;

    return side === 'LONG'
      ? this.paperTrader.tryOpenLong(
          symbol,
          interval,
          strategyId,
          strategyName,
          executionPrice,
          executionTimestamp,
          executionReason,
          positionSizeUsdt,
        )
      : this.paperTrader.tryOpenShort(
          symbol,
          interval,
          strategyId,
          strategyName,
          executionPrice,
          executionTimestamp,
          executionReason,
          positionSizeUsdt,
        );
  }

  private async tryClosePosition(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    expectedSide: 'LONG' | 'SHORT',
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ): Promise<ExecutionResult | null> {
    const position = this.portfolio.getPosition(symbol, strategyId);
    if (!position || position.side !== expectedSide) {
      return null;
    }

    if (marketType === 'spot' && expectedSide === 'SHORT') {
      return {
        status: 'REJECTED',
        action: 'CLOSE_SHORT',
        symbol,
        interval: position.interval,
        strategyId,
        strategyName: position.strategyName,
        reason: 'Режим Spot не поддерживает short-позиции',
      };
    }

    const client = await this.getClient(mode, marketType);
    const marketSymbol = await this.getMarketSymbol(client, symbol);
    const amount = this.normalizeAmount(client, marketSymbol, position.quantity);
    const orderSide =
      expectedSide === 'LONG'
        ? 'sell'
        : 'buy';
    const params =
      marketType === 'futures'
        ? { reduceOnly: true }
        : undefined;
    const order = await client.createOrder(
      marketSymbol,
      'market',
      orderSide,
      amount,
      undefined,
      params,
    );
    const executionPrice = this.resolveExecutionPrice(order, price);
    const executionTimestamp = order.timestamp ?? timestamp;
    const executionReason = `${reason} [${mode}/${marketType}]`;

    return expectedSide === 'LONG'
      ? this.paperTrader.tryCloseLong(
          symbol,
          strategyId,
          executionPrice,
          executionTimestamp,
          executionReason,
        )
      : this.paperTrader.tryCloseShort(
          symbol,
          strategyId,
          executionPrice,
          executionTimestamp,
          executionReason,
        );
  }

  private hasCredentials(mode: ExecutionMode) {
    if (mode === 'live_testnet') {
      return Boolean(
        this.config.binanceTestnetApiKey && this.config.binanceTestnetApiSecret,
      );
    }

    return Boolean(this.config.binanceApiKey && this.config.binanceApiSecret);
  }

  private async getClient(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
  ): Promise<ccxt.Exchange> {
    const cacheKey = `${mode}:${marketType}`;
    const existing = this.clients.get(cacheKey);
    if (existing) {
      return existing;
    }

    const credentials =
      mode === 'live_testnet'
        ? {
            apiKey: this.config.binanceTestnetApiKey,
            secret: this.config.binanceTestnetApiSecret,
          }
        : {
            apiKey: this.config.binanceApiKey,
            secret: this.config.binanceApiSecret,
          };

    const client = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      enableRateLimit: true,
      options: {
        defaultType: marketType === 'futures' ? 'future' : 'spot',
        adjustForTimeDifference: true,
      },
    });

    if (mode === 'live_testnet') {
      client.setSandboxMode(true);
    }

    await client.loadMarkets();
    this.clients.set(cacheKey, client);
    return client;
  }

  private async getMarketSymbol(client: ccxt.Exchange, symbol: string) {
    const marketSymbol = `${symbol.replace(/USDT$/, '')}/USDT`;
    const market = client.markets[marketSymbol];
    return market?.symbol ?? marketSymbol;
  }

  private normalizeAmount(client: ccxt.Exchange, marketSymbol: string, amount: number) {
    const normalized = Number(client.amountToPrecision(marketSymbol, amount));
    return normalized > 0 ? normalized : amount;
  }

  private resolveExecutionPrice(order: ccxt.Order, fallbackPrice: number) {
    const average = typeof order.average === 'number' ? order.average : undefined;
    const price = typeof order.price === 'number' ? order.price : undefined;

    return average ?? price ?? fallbackPrice;
  }

  private buildStatus(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    partial: Partial<ExecutionStatus>,
  ): ExecutionStatus {
    return {
      mode,
      marketType,
      label:
        mode === 'paper'
          ? 'PAPER'
          : mode === 'live_testnet'
            ? marketType === 'spot'
              ? 'LIVE TESTNET SPOT'
              : 'LIVE TESTNET FUTURES'
            : marketType === 'spot'
              ? 'LIVE REAL SPOT'
              : 'LIVE REAL FUTURES',
      canTradeShort: marketType === 'futures',
      liveTradingEnabled: mode !== 'paper',
      usingTestnet: mode === 'live_testnet',
      allowLiveReal: this.config.allowLiveReal,
      apiConfigured: partial.apiConfigured ?? false,
      accountConnectivity: partial.accountConnectivity ?? 'unknown',
      quoteAsset: 'USDT',
      quoteFree: partial.quoteFree ?? null,
      quoteTotal: partial.quoteTotal ?? null,
      lastSyncAt: Date.now(),
      lastError: partial.lastError ?? null,
      warnings: partial.warnings ?? [],
    };
  }
}
