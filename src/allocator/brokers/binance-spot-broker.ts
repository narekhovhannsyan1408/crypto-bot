import * as ccxt from 'ccxt';
import { BotConfig } from '../../config/bot-config';
import { LocalizedError, msg } from '../../i18n/messages';
import { AppLogger } from '../../observability/app-logger';
import {
  AllocatorBroker,
  AllocatorFill,
  baseAssetOf,
} from './allocator-broker';

/**
 * Binance Spot через ccxt. live_testnet — Binance Demo, live_real — реальный аккаунт.
 * Только рыночные ордера на споте: без плеча, без шортов.
 */
export class BinanceSpotAllocatorBroker implements AllocatorBroker {
  readonly quoteAsset = 'USDT';
  private clientPromise: Promise<ccxt.binance> | null = null;

  constructor(
    readonly mode: 'live_testnet' | 'live_real',
    private readonly config: BotConfig,
    private readonly journal?: AppLogger,
  ) {}

  async getPrice(symbol: string) {
    const client = await this.getClient();
    const ticker = await client.fetchTicker(this.toMarket(symbol));
    const price = Number(ticker.last ?? ticker.close);
    if (!Number.isFinite(price) || price <= 0) {
      throw new LocalizedError(
        msg('err.priceMissing', { source: 'Binance', symbol }),
      );
    }
    return price;
  }

  async getPrices(symbols: string[]) {
    const client = await this.getClient();
    const tickers = await client.fetchTickers(
      symbols.map((symbol) => this.toMarket(symbol)),
    );
    const prices: Record<string, number> = {};
    for (const symbol of symbols) {
      const ticker = tickers[this.toMarket(symbol)];
      const price = Number(ticker?.last ?? ticker?.close);
      if (!Number.isFinite(price) || price <= 0) {
        throw new LocalizedError(
          msg('err.priceMissing', { source: 'Binance', symbol }),
        );
      }
      prices[symbol] = price;
    }
    return prices;
  }

  async getMinOrderUsdt(symbol: string) {
    const client = await this.getClient();
    const market = client.market(this.toMarket(symbol));
    return Number(market.limits?.cost?.min ?? 5);
  }

  async getFreeBalances(assets: string[]) {
    const client = await this.getClient();
    const balance = await client.fetchBalance();
    const free = (balance.free ?? {}) as unknown as Record<
      string,
      number | undefined
    >;
    const balances = Object.fromEntries(
      [...assets.map(baseAssetOf), 'USDT'].map((asset) => [
        asset,
        Number(free[asset] ?? 0),
      ]),
    );
    this.journal?.debug('broker.binance.balance', 'Free balances on Binance', {
      mode: this.mode,
      balances,
    });
    return balances;
  }

  async buy(symbol: string, quoteAmount: number): Promise<AllocatorFill> {
    const client = await this.getClient();
    const cost = Math.floor(quoteAmount * 100) / 100;
    const order = await this.tracedOrder(
      'BUY',
      symbol,
      { quoteAmount, cost },
      () => client.createMarketBuyOrderWithCost(this.toMarket(symbol), cost),
    );
    return this.toFill(symbol, 'BUY', order);
  }

  async sell(symbol: string, quantity: number): Promise<AllocatorFill> {
    const client = await this.getClient();
    const market = this.toMarket(symbol);
    const amount = Number(client.amountToPrecision(market, quantity));
    if (!(amount > 0)) {
      throw new LocalizedError(msg('err.lotStep', { qty: quantity, symbol }));
    }
    const order = await this.tracedOrder(
      'SELL',
      symbol,
      { quantity, amount },
      () => client.createOrder(market, 'market', 'sell', amount),
    );
    return this.toFill(symbol, 'SELL', order);
  }

  /** Ордер с записью в журнал: что отправили, что ответила биржа или какая ошибка. */
  private async tracedOrder(
    side: 'BUY' | 'SELL',
    symbol: string,
    request: Record<string, unknown>,
    send: () => Promise<ccxt.Order>,
  ) {
    const startedAt = performance.now();
    const context = { mode: this.mode, symbol, side, ...request };
    this.journal?.info(
      'broker.binance.order_request',
      `Sending order ${side} ${symbol}`,
      context,
    );
    try {
      const order = await this.ensureFilled(await send(), symbol);
      this.journal?.log(
        'info',
        'broker.binance.order_response',
        `Binance response: ${side} ${symbol}`,
        {
          durationMs: performance.now() - startedAt,
          data: {
            ...context,
            id: order.id,
            status: order.status,
            filled: order.filled,
            cost: order.cost,
            average: order.average,
            fees: order.fees,
          },
        },
      );
      return order;
    } catch (error) {
      this.journal?.log(
        'error',
        'broker.binance.order_failed',
        `Binance rejected order ${side} ${symbol}`,
        {
          durationMs: performance.now() - startedAt,
          data: context,
          err: error,
        },
      );
      throw error;
    }
  }

  private async ensureFilled(order: ccxt.Order, symbol: string) {
    if (order.filled && order.cost) {
      return order;
    }
    const client = await this.getClient();
    return client.fetchOrder(order.id, this.toMarket(symbol));
  }

  private toFill(
    symbol: string,
    side: 'BUY' | 'SELL',
    order: ccxt.Order,
  ): AllocatorFill {
    const baseAsset = baseAssetOf(symbol);
    const filled = Number(order.filled ?? 0);
    const cost = Number(order.cost ?? 0);
    const fees = order.fees?.length ? order.fees : order.fee ? [order.fee] : [];
    let baseFee = 0;
    let quoteFee = 0;
    let feeAsset = 'USDT';
    for (const fee of fees) {
      const amount = Number(fee?.cost ?? 0);
      if (fee?.currency === baseAsset) baseFee += amount;
      else if (fee?.currency === 'USDT') quoteFee += amount;
      if (fee?.currency) feeAsset = fee.currency;
    }

    if (!(filled > 0) || !(cost > 0)) {
      throw new LocalizedError(
        msg('err.orderNotFilled', {
          side,
          symbol,
          status: order.status ?? null,
        }),
      );
    }

    return side === 'BUY'
      ? {
          symbol,
          side,
          quantity: filled - baseFee,
          quoteAmount: cost + quoteFee,
          price: cost / filled,
          fee: baseFee * (cost / filled) + quoteFee,
          feeAsset,
        }
      : {
          symbol,
          side,
          quantity: filled + baseFee,
          quoteAmount: cost - quoteFee,
          price: cost / filled,
          fee: baseFee * (cost / filled) + quoteFee,
          feeAsset,
        };
  }

  private toMarket(symbol: string) {
    return `${baseAssetOf(symbol)}/USDT`;
  }

  private getClient() {
    // Одно подключение на брокера: загрузка рынков дорогая, параллельные вызовы ждут её
    this.clientPromise ??= this.createClient().catch((error: unknown) => {
      this.clientPromise = null;
      this.journal?.error(
        'broker.binance.connect_failed',
        'Failed to connect to Binance',
        error,
        {
          mode: this.mode,
        },
      );
      throw error;
    });
    return this.clientPromise;
  }

  private async createClient() {
    const credentials =
      this.mode === 'live_testnet'
        ? {
            apiKey: this.config.binanceTestnetApiKey,
            secret: this.config.binanceTestnetApiSecret,
          }
        : {
            apiKey: this.config.binanceApiKey,
            secret: this.config.binanceApiSecret,
          };

    if (!credentials.apiKey || !credentials.secret) {
      throw new LocalizedError(
        msg(
          this.mode === 'live_testnet'
            ? 'err.binanceDemoKeys'
            : 'err.binanceRealKeys',
        ),
      );
    }

    const client = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      enableRateLimit: true,
      timeout: 15_000,
      options: { defaultType: 'spot', adjustForTimeDifference: true },
    });
    if (this.mode === 'live_testnet') {
      client.enableDemoTrading(true);
    }
    const startedAt = performance.now();
    await client.loadMarkets();
    this.journal?.log(
      'info',
      'broker.binance.connected',
      'Connected to Binance',
      {
        durationMs: performance.now() - startedAt,
        data: {
          mode: this.mode,
          markets: Object.keys(client.markets ?? {}).length,
        },
      },
    );
    return client;
  }
}
