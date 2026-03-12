import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as ccxt from 'ccxt';
import { MainClient, WebsocketClient } from 'binance';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PaperTraderService } from '../paper-trader/paper-trader.service';
import {
  armBreakeven,
  hasExceededMaxHoldTime,
  shouldArmBreakeven,
  updateTrailingStop,
} from '../trade-protection.utils';
import {
  ExecutionMarketType,
  ExecutionMode,
  ExecutionStatus,
} from '../execution.types';
import { ExecutionResult } from '../types';

@Injectable()
export class BinanceExecutionService implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private readonly clients = new Map<string, ccxt.Exchange>();
  private readonly spotRestClients = new Map<ExecutionMode, MainClient>();
  private readonly spotWsClients = new Map<ExecutionMode, WebsocketClient>();
  private readonly spotUserDataState = new Map<
    ExecutionMode,
    {
      connected: boolean;
      lastEventAt: number | null;
      lastError: string | null;
      lastExecutionReportAt: number | null;
    }
  >();

  constructor(
    private readonly portfolio: PortfolioService,
    private readonly paperTrader: PaperTraderService,
  ) {}

  onModuleDestroy() {
    for (const client of this.spotWsClients.values()) {
      try {
        client.closeAll(true);
      } catch {
        // ignore cleanup errors during shutdown
      }
    }
  }

  async refreshAccountStatus(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
  ): Promise<ExecutionStatus> {
    const apiConfigured = this.hasCredentials(mode, marketType);

    if (mode === 'paper') {
      return this.buildStatus(mode, marketType, {
        apiConfigured: false,
        accountConnectivity: 'unknown',
        quoteFree: this.portfolio.balance,
        quoteTotal: this.portfolio.getEquity(),
        spotQuoteFree: marketType !== 'futures' ? this.portfolio.balance : null,
        spotQuoteTotal: marketType !== 'futures' ? this.portfolio.getEquity() : null,
        futuresQuoteFree: marketType !== 'spot' ? this.portfolio.balance : null,
        futuresQuoteTotal: marketType !== 'spot' ? this.portfolio.getEquity() : null,
        warnings: [],
      });
    }

    if (!apiConfigured) {
      return this.buildStatus(mode, marketType, {
        apiConfigured: false,
        accountConnectivity: 'error',
        lastError: this.getMissingCredentialsMessage(mode, marketType),
      });
    }

    try {
      if (marketType === 'spot') {
        return await this.refreshSpotAccountStatus(mode);
      }

      const client = await this.getClient(mode, marketType);
      const balance = await client.fetchBalance();
      const quoteAsset = 'USDT';
      const quoteWallet =
        (balance[quoteAsset] as { free?: number; total?: number } | undefined) ?? {};
      const warnings: string[] = [];

      if (mode === 'live_testnet' && marketType === 'futures') {
        warnings.push('Binance Futures Demo работает через demo trading endpoint');
        if (this.isUsingSharedLiveTestnetKeyForFutures()) {
          warnings.push(
            'Для Binance Futures Demo используется общий demo key из BINANCE_TESTNET_API_*',
          );
        }
      }

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
        spotQuoteFree: null,
        spotQuoteTotal: null,
        futuresQuoteFree: quoteWallet.free ?? null,
        futuresQuoteTotal: quoteWallet.total ?? null,
        lastError: null,
        warnings,
      });
    } catch (error) {
      return this.buildStatus(mode, marketType, {
        apiConfigured: true,
        accountConnectivity: 'error',
        lastError: this.describeUnknownError(error, 'Не удалось подключиться к Binance'),
      });
    }
  }

  syncPortfolioBalance(status: ExecutionStatus) {
    this.portfolio.syncExternalUsdtWallet(status.quoteFree, status.quoteTotal);
  }

  async liquidateAllSpotAssets(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
    reason: string,
  ) {
    if (mode === 'paper') {
      return {
        success: false,
        message: 'В режиме paper нет внешних spot-активов для ликвидации',
        soldAssets: [] as string[],
        skippedAssets: [] as Array<{ asset: string; reason: string }>,
      };
    }

    if (marketType !== 'spot' && marketType !== 'hybrid') {
      return {
        success: false,
        message: 'Ликвидация внешних активов доступна только в режиме Spot или Hybrid',
        soldAssets: [] as string[],
        skippedAssets: [] as Array<{ asset: string; reason: string }>,
      };
    }

    const restClient = this.getSpotRestClient(mode);
    const tradingClient = await this.getClient(mode, 'spot');
    const accountInfo = await restClient.getAccountInformation({ omitZeroBalances: true });
    const balances = Array.isArray(accountInfo.balances) ? accountInfo.balances : [];
    const managedAssets = new Set(
      this.portfolio
        .getOpenPositions()
        .filter((position) => position.side === 'LONG' && position.symbol.endsWith('USDT'))
        .map((position) => position.symbol.replace(/USDT$/, '')),
    );
    const soldAssets: string[] = [];
    const skippedAssets: Array<{ asset: string; reason: string }> = [];

    for (const balance of balances) {
      const asset = balance.asset;
      const freeAmount = Number(balance.free ?? 0);
      const lockedAmount = Number(balance.locked ?? 0);

      if (!asset || asset === 'USDT') {
        continue;
      }

      if (managedAssets.has(asset)) {
        skippedAssets.push({
          asset,
          reason: 'Актив используется открытой spot-позицией бота и пропущен',
        });
        continue;
      }

      if (!Number.isFinite(freeAmount) || freeAmount <= 0) {
        if (lockedAmount > 0) {
          skippedAssets.push({
            asset,
            reason: 'Актив заблокирован в ордерах и недоступен для market sell',
          });
        }
        continue;
      }

      const marketSymbol = `${asset}/USDT`;
      const market = tradingClient.markets[marketSymbol];

      if (!market) {
        skippedAssets.push({
          asset,
          reason: 'Нет прямой пары к USDT на Binance spot',
        });
        continue;
      }

      const normalizedAmount = this.normalizeAmount(
        tradingClient,
        market.symbol,
        freeAmount,
      );

      if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        skippedAssets.push({
          asset,
          reason: 'Количество слишком мало после нормализации lot size',
        });
        continue;
      }

      try {
        await tradingClient.createOrder(
          market.symbol,
          'market',
          'sell',
          normalizedAmount,
        );
        soldAssets.push(asset);
      } catch (error) {
        skippedAssets.push({
          asset,
          reason: error instanceof Error ? error.message : 'Не удалось выставить market sell',
        });
      }
    }

    await this.refreshSpotBalancesFromRest(mode);

    return {
      success: soldAssets.length > 0,
      message:
        soldAssets.length > 0
          ? `Ликвидация завершена: продано ${soldAssets.length} активов`
          : 'Не удалось продать ни одного внешнего spot-актива',
      soldAssets,
      skippedAssets,
      reason,
    };
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
      const positionMarketType = position.marketType;

      if (position.side === 'LONG') {
        if (candle.low <= position.stopPrice) {
          const action = await this.tryCloseLong(
            mode,
            positionMarketType,
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
            positionMarketType,
            candle.symbol,
            position.strategyId,
            position.takePrice,
            candle.closeTime,
            'Тейк-профит по лонгу',
          );
          if (action) actions.push(action);
          continue;
        }

        if (
          shouldArmBreakeven(
            position,
            candle.close,
            this.config.breakevenTriggerPct,
          )
        ) {
          armBreakeven(
            position,
            this.config.feePct,
            this.config.breakevenOffsetPct,
          );
        }

        if (
          hasExceededMaxHoldTime(
            position,
            candle.closeTime,
            this.config.maxPositionHoldMinutes,
          )
        ) {
          const action = await this.tryCloseLong(
            mode,
            positionMarketType,
            candle.symbol,
            position.strategyId,
            candle.close,
            candle.closeTime,
            'Time stop по лонгу: превышено максимальное время удержания',
          );
          if (action) actions.push(action);
          continue;
        }

        updateTrailingStop(position, candle);
        continue;
      }

      if (candle.high >= position.stopPrice) {
        const action = await this.tryCloseShort(
          mode,
          positionMarketType,
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
          positionMarketType,
          candle.symbol,
          position.strategyId,
          position.takePrice,
          candle.closeTime,
          'Тейк-профит по шорту',
        );
        if (action) actions.push(action);
        continue;
      }

      if (
        shouldArmBreakeven(
          position,
          candle.close,
          this.config.breakevenTriggerPct,
        )
      ) {
        armBreakeven(position, this.config.feePct, this.config.breakevenOffsetPct);
      }

      if (
        hasExceededMaxHoldTime(
          position,
          candle.closeTime,
          this.config.maxPositionHoldMinutes,
        )
      ) {
        const action = await this.tryCloseShort(
          mode,
          positionMarketType,
          candle.symbol,
          position.strategyId,
          candle.close,
          candle.closeTime,
          'Time stop по шорту: превышено максимальное время удержания',
        );
        if (action) actions.push(action);
        continue;
      }

      updateTrailingStop(position, candle);
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
    const executionMarketType =
      marketType === 'hybrid' ? (side === 'LONG' ? 'spot' : 'futures') : marketType;

    if (executionMarketType === 'spot' && side === 'SHORT') {
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

    const client = await this.getClient(mode, executionMarketType);
    const marketSymbol = await this.getMarketSymbol(client, symbol);
    const amount = this.normalizeAmount(client, marketSymbol, positionSizeUsdt / price);
    const orderSide = side === 'LONG' ? 'buy' : 'sell';
    const rejectAction = side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT';

    try {
      const order = await client.createOrder(marketSymbol, 'market', orderSide, amount);
      const executionPrice = this.resolveExecutionPrice(order, price);
      const executionTimestamp = order.timestamp ?? timestamp;
      const executionReason = `${reason} [${mode}/${marketType}]`;
      const quoteAsset = 'USDT';
      const baseAsset = symbol.replace(/USDT$/, '');
      const feeSummary = this.resolveOrderFeeSummary(order, baseAsset, quoteAsset);
      const executedQuantity = this.resolveOpenedQuantity(
        order,
        amount,
        side,
        executionMarketType,
        feeSummary.baseFee,
      );
      const executedNotional = this.resolveExecutedQuoteNotional(
        order,
        executionPrice,
        executedQuantity,
        positionSizeUsdt,
      );

      return this.paperTrader.recordExternalOpenPosition({
        side,
        symbol,
        interval,
        strategyId,
        strategyName,
        price: executionPrice,
        timestamp: executionTimestamp,
        reason: executionReason,
        quantity: executedQuantity,
        investedUsdt: executedNotional + feeSummary.quoteFee,
        entryFeePaid: feeSummary.quoteFee,
        marketType: executionMarketType,
      });
    } catch (error) {
      if (this.isInsufficientFundsError(error)) {
        const availableQuote = await this.getAvailableQuoteBalance(mode, executionMarketType);
        const venueLabel =
          executionMarketType === 'futures' ? 'Binance Futures' : 'Binance Spot';
        const fundsHint =
          executionMarketType === 'futures'
            ? 'Пополни/сбрось Futures Demo баланс, проверь leverage по символу или уменьши BOT_POSITION_SIZE_USDT.'
            : 'Проверь свободный USDT на Spot Demo или уменьши BOT_POSITION_SIZE_USDT.';
        const availableHint =
          availableQuote === null
            ? ''
            : ` Доступно примерно ${availableQuote.toFixed(4)} USDT в ${venueLabel}.`;

        return {
          status: 'REJECTED',
          action: rejectAction,
          symbol,
          interval,
          strategyId,
          strategyName,
          reason: `Недостаточно средств для открытия позиции на ${venueLabel}: запрошен размер ~${positionSizeUsdt.toFixed(
            4,
          )} USDT.${availableHint} ${fundsHint}`.trim(),
        };
      }

      throw error;
    }
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

    const executionMarketType =
      marketType === 'hybrid' ? position.marketType : marketType;

    if (executionMarketType === 'spot' && expectedSide === 'SHORT') {
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

    const client = await this.getClient(mode, executionMarketType);
    const marketSymbol = await this.getMarketSymbol(client, symbol);
    let amount = this.normalizeAmount(client, marketSymbol, position.quantity);

    if (executionMarketType === 'spot' && expectedSide === 'LONG') {
      const baseAsset = symbol.replace(/USDT$/, '');
      const balance = await this.getSpotAssetBalance(mode, baseAsset);
      const freeBalance = balance.free;
      const totalBalance = balance.free + balance.locked;

      if (totalBalance <= 0) {
        return this.paperTrader.tryCloseLong(
          symbol,
          strategyId,
          price,
          timestamp,
          `${reason} [${mode}/${executionMarketType}] [sync: asset already absent on exchange]`,
          executionMarketType,
        );
      }

      if (freeBalance <= 0 && balance.locked > 0) {
        return {
          status: 'REJECTED',
          action: 'CLOSE_LONG',
          symbol,
          interval: position.interval,
          strategyId,
          strategyName: position.strategyName,
          reason:
            'Нельзя закрыть spot-позицию: актив полностью заблокирован в открытых ордерах Binance. Сначала сними внешние ордера или дождись их исполнения.',
        };
      }

      const availableAmount = this.normalizeAmount(client, marketSymbol, freeBalance);
      if (!Number.isFinite(availableAmount) || availableAmount <= 0) {
        if (balance.locked > 0) {
          return {
            status: 'REJECTED',
            action: 'CLOSE_LONG',
            symbol,
            interval: position.interval,
            strategyId,
            strategyName: position.strategyName,
            reason:
              'Нельзя закрыть spot-позицию: доступное количество после lot-size нормализации равно нулю, а актив заблокирован в ордерах Binance.',
          };
        }

        return this.paperTrader.tryCloseLong(
          symbol,
          strategyId,
          price,
          timestamp,
          `${reason} [${mode}/${executionMarketType}] [sync: available asset amount rounded to zero]`,
          executionMarketType,
        );
      }

      if (availableAmount < amount) {
        const totalCoverageRatio =
          position.quantity > 0 ? totalBalance / position.quantity : 0;

        if (totalCoverageRatio < 0.95) {
          return this.paperTrader.tryCloseLong(
            symbol,
            strategyId,
            price,
            timestamp,
            `${reason} [${mode}/${executionMarketType}] [sync: exchange asset balance diverged from bot position]`,
            executionMarketType,
          );
        }

        if (balance.locked > 0) {
          return {
            status: 'REJECTED',
            action: 'CLOSE_LONG',
            symbol,
            interval: position.interval,
            strategyId,
            strategyName: position.strategyName,
            reason:
              'Нельзя закрыть spot-позицию полным объёмом: часть актива заблокирована во внешних ордерах Binance.',
          };
        }

        amount = availableAmount;
      }
    }

    const orderSide =
      expectedSide === 'LONG'
        ? 'sell'
        : 'buy';
    const params =
      executionMarketType === 'futures'
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
    const executionReason = `${reason} [${mode}/${executionMarketType}]`;
    const quoteAsset = 'USDT';
    const baseAsset = symbol.replace(/USDT$/, '');
    const feeSummary = this.resolveOrderFeeSummary(order, baseAsset, quoteAsset);
    const executedQuantity = this.resolveClosedQuantity(order, amount);

    return this.paperTrader.recordExternalClosePosition({
      expectedSide,
      symbol,
      strategyId,
      price: executionPrice,
      timestamp: executionTimestamp,
      reason: executionReason,
      executedQuantity,
      exitFeePaid: feeSummary.quoteFee,
      marketType: executionMarketType,
    });
  }

  private hasCredentials(
    mode: ExecutionMode,
    marketType: 'spot' | 'futures' | 'hybrid',
  ) {
    if (mode === 'live_testnet') {
      if (marketType === 'hybrid') {
        return (
          this.hasLiveTestnetCredentials('spot') &&
          this.hasLiveTestnetCredentials('futures')
        );
      }

      return this.hasLiveTestnetCredentials(marketType);
    }

    return Boolean(this.config.binanceApiKey && this.config.binanceApiSecret);
  }

  private async refreshSpotAccountStatus(mode: ExecutionMode): Promise<ExecutionStatus> {
    const client = this.getSpotRestClient(mode);
    const [accountInfo, openOrders] = await Promise.all([
      client.getAccountInformation({ omitZeroBalances: true }),
      client.getOpenOrders(),
    ]);
    await this.ensureSpotUserDataStream(mode);

    const balances = Array.isArray(accountInfo.balances) ? accountInfo.balances : [];
    const usdtBalance = balances.find((balance) => balance.asset === 'USDT');
    const quoteFree = Number(usdtBalance?.free ?? 0);
    const quoteLocked = Number(usdtBalance?.locked ?? 0);
    const nonUsdtBalances = balances.filter((balance) => {
      if (balance.asset === 'USDT') {
        return false;
      }

      return Number(balance.free ?? 0) > 0 || Number(balance.locked ?? 0) > 0;
    });
    const streamState = this.getSpotUserDataState(mode);
    const streamStatus = streamState.lastError
      ? 'error'
      : streamState.connected
        ? 'connected'
        : 'disconnected';
    const spotAssetsPreview = nonUsdtBalances
      .slice(0, 8)
      .map((balance) => balance.asset);
    const warnings: string[] = [];

    if (openOrders.length > 0) {
      warnings.push(`Есть открытые spot-ордера на Binance: ${openOrders.length}`);
    }

    if (nonUsdtBalances.length > 0) {
      warnings.push(`На Binance есть незакрытые spot-активы: ${nonUsdtBalances.length} шт.`);
    }

    if (this.isSpotDemoRestFallbackMessage(streamState.lastError)) {
      warnings.push(
        'Spot Demo private user-data stream недоступен у Binance. Используем REST fallback для spot account sync.',
      );
    } else if (streamStatus === 'disconnected') {
      warnings.push('Private user-data stream Binance не подтверждён');
    }

    if (streamState.lastError && !this.isSpotDemoRestFallbackMessage(streamState.lastError)) {
      warnings.push(`User-data stream: ${streamState.lastError}`);
    }

    return this.buildStatus(mode, 'spot', {
      apiConfigured: true,
      accountConnectivity: 'ok',
      quoteFree: Number.isFinite(quoteFree) ? quoteFree : null,
      quoteTotal: Number.isFinite(quoteFree + quoteLocked) ? quoteFree + quoteLocked : null,
      spotQuoteFree: Number.isFinite(quoteFree) ? quoteFree : null,
      spotQuoteTotal: Number.isFinite(quoteFree + quoteLocked) ? quoteFree + quoteLocked : null,
      futuresQuoteFree: null,
      futuresQuoteTotal: null,
      lastError: null,
      userDataStreamStatus: streamStatus,
      userDataStreamLastEventAt: streamState.lastEventAt,
      userDataStreamLastExecutionReportAt: streamState.lastExecutionReportAt,
      openSpotOrdersCount: openOrders.length,
      spotAssetsCount: nonUsdtBalances.length,
      spotAssetsPreview,
      warnings,
    });
  }

  private getSpotRestClient(mode: ExecutionMode) {
    const existing = this.spotRestClients.get(mode);
    if (existing) {
      return existing;
    }

    const credentials = this.getApiCredentials(mode, 'spot');
    this.assertCredentialsLoaded(credentials, mode, 'spot');

    const client = new MainClient({
      api_key: credentials.apiKey,
      api_secret: credentials.secret,
      testnet: false,
      demoTrading: mode === 'live_testnet',
      baseUrl: mode === 'live_testnet' ? 'https://demo-api.binance.com' : undefined,
      beautifyResponses: true,
    });

    this.spotRestClients.set(mode, client);
    return client;
  }

  private async ensureSpotUserDataStream(mode: ExecutionMode) {
    if (mode === 'live_testnet') {
      const state = this.getSpotUserDataState(mode);
      state.connected = false;
      state.lastError =
        'Spot Demo private user-data stream недоступен у Binance; используем REST fallback';
      return null;
    }

    const existing = this.spotWsClients.get(mode);
    if (existing) {
      return existing;
    }

    const credentials = this.getApiCredentials(mode, 'spot');
    this.assertCredentialsLoaded(credentials, mode, 'spot');

    const client = new WebsocketClient({
      api_key: credentials.apiKey,
      api_secret: credentials.secret,
      testnet: false,
      demoTrading: false,
      wsUrl: undefined,
      beautify: true,
    });
    const wsKey = 'main';

    client.on('open', () => {
      const state = this.getSpotUserDataState(mode);
      state.connected = true;
      state.lastError = null;
    });

    client.on('reconnected', () => {
      const state = this.getSpotUserDataState(mode);
      state.connected = true;
      state.lastError = null;
      void this.refreshSpotBalancesFromRest(mode);
    });

    client.on('close', () => {
      const state = this.getSpotUserDataState(mode);
      state.connected = false;
    });

    client.on('exception', (event) => {
      const state = this.getSpotUserDataState(mode);
      state.connected = false;
      state.lastError =
        event instanceof Error
          ? event.message
          : typeof event?.message === 'string'
            ? event.message
            : 'Ошибка private user-data stream Binance';
    });

    client.on('formattedUserDataMessage', (event) => {
      this.handleSpotUserDataMessage(
        mode,
        event as unknown as Record<string, unknown>,
      );
    });

    try {
      await client.subscribeSpotUserDataStream(wsKey);
      this.spotWsClients.set(mode, client);
      return client;
    } catch (error) {
      const state = this.getSpotUserDataState(mode);
      state.connected = false;

      if (this.isDeprecatedSpotTestnetUserDataStreamError(error)) {
        state.lastError =
          'Spot Demo private user-data stream временно недоступен. Продолжаем через REST polling.';
        try {
          client.closeAll(true);
        } catch {
          // ignore cleanup errors
        }
        return null;
      }

      throw error;
    }
  }

  private handleSpotUserDataMessage(
    mode: ExecutionMode,
    event: Record<string, unknown>,
  ) {
    const state = this.getSpotUserDataState(mode);
    state.connected = true;
    state.lastError = null;
    state.lastEventAt = Date.now();

    if (event.eventType === 'outboundAccountPosition') {
      const balances = Array.isArray(event.balances) ? event.balances : [];
      const usdtBalance = balances.find(
        (balance) =>
          typeof balance === 'object' &&
          balance !== null &&
          'asset' in balance &&
          balance.asset === 'USDT',
      ) as
        | {
            availableBalance?: number;
            onOrderBalance?: number;
          }
        | undefined;

      if (usdtBalance) {
        const free = Number(usdtBalance.availableBalance ?? 0);
        const locked = Number(usdtBalance.onOrderBalance ?? 0);
        this.portfolio.syncExternalUsdtWallet(free, free + locked);
      }

      return;
    }

    if (event.eventType === 'executionReport') {
      state.lastExecutionReportAt = Date.now();
      void this.refreshSpotBalancesFromRest(mode);
    }
  }

  private async refreshSpotBalancesFromRest(mode: ExecutionMode) {
    try {
      const client = this.getSpotRestClient(mode);
      const accountInfo = await client.getAccountInformation({ omitZeroBalances: true });
      const balances = Array.isArray(accountInfo.balances) ? accountInfo.balances : [];
      const usdtBalance = balances.find((balance) => balance.asset === 'USDT');
      const free = Number(usdtBalance?.free ?? 0);
      const locked = Number(usdtBalance?.locked ?? 0);
      this.portfolio.syncExternalUsdtWallet(
        Number.isFinite(free) ? free : undefined,
        Number.isFinite(free + locked) ? free + locked : undefined,
      );
    } catch (error) {
      const state = this.getSpotUserDataState(mode);
      state.lastError = this.describeUnknownError(
        error,
        'Не удалось обновить spot-балансы через Binance SDK',
      );
    }
  }

  private async getSpotAssetBalance(mode: ExecutionMode, asset: string) {
    const client = this.getSpotRestClient(mode);
    const accountInfo = await client.getAccountInformation({ omitZeroBalances: true });
    const balances = Array.isArray(accountInfo.balances) ? accountInfo.balances : [];
    const assetBalance = balances.find((balance) => balance.asset === asset);

    return {
      free: Number(assetBalance?.free ?? 0),
      locked: Number(assetBalance?.locked ?? 0),
    };
  }

  private getSpotUserDataState(mode: ExecutionMode) {
    const existing = this.spotUserDataState.get(mode);
    if (existing) {
      return existing;
    }

    const state = {
      connected: false,
      lastEventAt: null,
      lastError: null,
      lastExecutionReportAt: null,
    };
    this.spotUserDataState.set(mode, state);
    return state;
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

    const normalizedMarketType = marketType === 'hybrid' ? 'spot' : marketType;
    const credentials = this.getApiCredentials(mode, normalizedMarketType);
    this.assertCredentialsLoaded(credentials, mode, normalizedMarketType);

    const client = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      enableRateLimit: true,
      options: {
        defaultType: normalizedMarketType === 'futures' ? 'future' : 'spot',
        adjustForTimeDifference: true,
      },
    });

    if (mode === 'live_testnet') {
      if (normalizedMarketType === 'futures') {
        client.enableDemoTrading(true);
      } else {
        client.enableDemoTrading(true);
      }
    }

    await client.loadMarkets();
    this.clients.set(cacheKey, client);
    return client;
  }

  private getApiCredentials(
    mode: ExecutionMode,
    marketType: 'spot' | 'futures',
  ) {
    if (mode === 'live_testnet') {
      return this.getLiveTestnetCredentials(marketType);
    }

    return {
      apiKey: this.config.binanceApiKey,
      secret: this.config.binanceApiSecret,
    };
  }

  private assertCredentialsLoaded(
    credentials: { apiKey?: string; secret?: string },
    mode: ExecutionMode,
    marketType: 'spot' | 'futures',
  ) {
    if (credentials.apiKey && credentials.secret) {
      return;
    }

    if (mode === 'live_testnet') {
      throw new Error(
        `Не загружены testnet credentials для ${marketType}. Проверь .env и полный restart процесса.`,
      );
    }

    throw new Error(
      `Не загружены API credentials для ${mode}/${marketType}. Проверь .env и способ запуска процесса.`,
    );
  }

  private hasLiveTestnetCredentials(marketType: 'spot' | 'futures') {
    const credentials = this.getLiveTestnetCredentials(marketType);
    return Boolean(credentials.apiKey && credentials.secret);
  }

  private getLiveTestnetCredentials(marketType: 'spot' | 'futures') {
    if (marketType === 'futures') {
      if (this.config.binanceFuturesDemoApiKey && this.config.binanceFuturesDemoApiSecret) {
        return {
          apiKey: this.config.binanceFuturesDemoApiKey,
          secret: this.config.binanceFuturesDemoApiSecret,
        };
      }

      return {
        apiKey: this.config.binanceTestnetApiKey,
        secret: this.config.binanceTestnetApiSecret,
      };
    }

    return {
      apiKey: this.config.binanceTestnetApiKey,
      secret: this.config.binanceTestnetApiSecret,
    };
  }

  private getMissingCredentialsMessage(
    mode: ExecutionMode,
    marketType: ExecutionMarketType,
  ) {
    if (mode !== 'live_testnet') {
      return 'Не заданы API credentials для выбранного режима';
    }

    if (marketType === 'hybrid') {
      return 'Для live_testnet/hybrid нужен хотя бы BINANCE_TESTNET_API_*; при наличии отдельного BINANCE_FUTURES_DEMO_API_* он будет использован для futures, иначе futures demo попробует общий demo key из BINANCE_TESTNET_API_*';
    }

    return marketType === 'futures'
      ? 'Для live_testnet/futures нужен BINANCE_FUTURES_DEMO_API_* или общий demo key в BINANCE_TESTNET_API_* с включённым Futures permission'
      : 'Для live_testnet/spot нужны credentials BINANCE_TESTNET_API_*';
  }

  private isUsingSharedLiveTestnetKeyForFutures() {
    return Boolean(
      !this.config.binanceFuturesDemoApiKey &&
        !this.config.binanceFuturesDemoApiSecret &&
        this.config.binanceTestnetApiKey &&
        this.config.binanceTestnetApiSecret,
    );
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

  private resolveExecutedQuoteNotional(
    order: ccxt.Order,
    executionPrice: number,
    executedQuantity: number,
    fallbackNotional: number,
  ) {
    if (typeof order.cost === 'number' && Number.isFinite(order.cost) && order.cost > 0) {
      return order.cost;
    }

    const derivedNotional = executionPrice * executedQuantity;
    if (Number.isFinite(derivedNotional) && derivedNotional > 0) {
      return derivedNotional;
    }

    return fallbackNotional;
  }

  private resolveOpenedQuantity(
    order: ccxt.Order,
    fallbackAmount: number,
    side: 'LONG' | 'SHORT',
    marketType: 'spot' | 'futures',
    baseFee: number,
  ) {
    const filled =
      typeof order.filled === 'number' && Number.isFinite(order.filled) && order.filled > 0
        ? order.filled
        : fallbackAmount;

    if (side === 'LONG' && marketType === 'spot') {
      return Math.max(filled - baseFee, 0);
    }

    return filled;
  }

  private resolveClosedQuantity(order: ccxt.Order, fallbackAmount: number) {
    if (typeof order.filled === 'number' && Number.isFinite(order.filled) && order.filled > 0) {
      return order.filled;
    }

    return fallbackAmount;
  }

  private resolveOrderFeeSummary(
    order: ccxt.Order,
    baseAsset: string,
    quoteAsset: string,
  ) {
    const fees =
      Array.isArray(order.fees) && order.fees.length > 0 ? [...order.fees] : [];
    if (order.fee) {
      fees.push(order.fee);
    }

    return fees.reduce(
      (acc, fee) => {
        if (!fee || typeof fee.cost !== 'number' || !Number.isFinite(fee.cost) || fee.cost <= 0) {
          return acc;
        }

        const currency = fee.currency?.toUpperCase();
        if (currency === quoteAsset.toUpperCase()) {
          acc.quoteFee += fee.cost;
        }

        if (currency === baseAsset.toUpperCase()) {
          acc.baseFee += fee.cost;
        }

        return acc;
      },
      { quoteFee: 0, baseFee: 0 },
    );
  }

  private isInsufficientFundsError(error: unknown) {
    if (error instanceof ccxt.InsufficientFunds) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /insufficient balance|insufficient funds|margin is insufficient/i.test(message);
  }

  private isDeprecatedSpotTestnetUserDataStreamError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /410 gone|testnet\.binance\.vision\/api\/v3\/userdatastream/i.test(message);
  }

  private async getAvailableQuoteBalance(
    mode: ExecutionMode,
    marketType: 'spot' | 'futures',
  ): Promise<number | null> {
    try {
      if (marketType === 'spot') {
        const balance = await this.getSpotAssetBalance(mode, 'USDT');
        return Number.isFinite(balance.free) ? balance.free : null;
      }

      const client = await this.getClient(mode, 'futures');
      const balance = await client.fetchBalance();
      const quoteWallet =
        (balance.USDT as { free?: number; total?: number } | undefined) ?? {};
      return typeof quoteWallet.free === 'number' && Number.isFinite(quoteWallet.free)
        ? quoteWallet.free
        : null;
    } catch {
      return null;
    }
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
              ? 'LIVE DEMO SPOT'
              : 'LIVE DEMO FUTURES'
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
      spotQuoteFree: partial.spotQuoteFree ?? null,
      spotQuoteTotal: partial.spotQuoteTotal ?? null,
      futuresQuoteFree: partial.futuresQuoteFree ?? null,
      futuresQuoteTotal: partial.futuresQuoteTotal ?? null,
      lastSyncAt: Date.now(),
      lastError: partial.lastError ?? null,
      userDataStreamStatus: partial.userDataStreamStatus ?? 'unknown',
      userDataStreamLastEventAt: partial.userDataStreamLastEventAt ?? null,
      userDataStreamLastExecutionReportAt:
        partial.userDataStreamLastExecutionReportAt ?? null,
      openSpotOrdersCount: partial.openSpotOrdersCount ?? 0,
      spotAssetsCount: partial.spotAssetsCount ?? 0,
      spotAssetsPreview: partial.spotAssetsPreview ?? [],
      warnings: partial.warnings ?? [],
    };
  }

  private isSpotDemoRestFallbackMessage(lastError: string | null | undefined) {
    return (
      typeof lastError === 'string' &&
      /rest fallback|spot demo private user-data stream/i.test(lastError)
    );
  }

  private describeUnknownError(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }

    if (typeof error === 'object' && error !== null) {
      const candidate = error as Record<string, unknown>;
      const directMessage = [
        candidate.message,
        candidate.msg,
        candidate.error,
        candidate.body,
      ].find((value) => typeof value === 'string' && value.trim());

      if (typeof directMessage === 'string' && directMessage.trim()) {
        return directMessage.trim();
      }

      const code =
        typeof candidate.code === 'string' || typeof candidate.code === 'number'
          ? String(candidate.code)
          : null;
      const requestUrl =
        typeof candidate.requestUrl === 'string' && candidate.requestUrl.trim()
          ? candidate.requestUrl
          : null;

      if (code || requestUrl) {
        return [code ? `code=${code}` : null, requestUrl]
          .filter(Boolean)
          .join(' | ');
      }
    }

    const text = String(error);
    if (text && text !== '[object Object]') {
      return text;
    }

    return fallback;
  }
}
