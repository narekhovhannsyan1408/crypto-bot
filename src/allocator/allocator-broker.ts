import * as ccxt from 'ccxt';
import { BotConfig } from '../config/bot-config';
import { ExecutionMode } from '../trader/execution.types';
import { AllocatorMarketDataService } from './allocator-market-data.service';

export type AllocatorFill = {
  symbol: string;
  side: 'BUY' | 'SELL';
  // BUY: сколько монет получили (за вычетом комиссии в монете); SELL: сколько продали
  quantity: number;
  // BUY: сколько USDT потратили; SELL: сколько USDT получили (за вычетом комиссии в USDT)
  quoteAmount: number;
  price: number;
  fee: number;
  feeAsset: string;
};

export interface AllocatorBroker {
  readonly mode: ExecutionMode;
  getPrice(symbol: string): Promise<number>;
  getMinOrderUsdt(symbol: string): Promise<number>;
  // Свободные остатки на бирже (для сверки кармана); null — брокер без внешнего аккаунта
  getFreeBalances(assets: string[]): Promise<Record<string, number> | null>;
  buy(symbol: string, quoteAmount: number): Promise<AllocatorFill>;
  sell(symbol: string, quantity: number): Promise<AllocatorFill>;
}

export const baseAssetOf = (symbol: string) => symbol.replace(/USDT$/, '');

export class PaperAllocatorBroker implements AllocatorBroker {
  readonly mode = 'paper' as const;

  constructor(
    private readonly marketData: AllocatorMarketDataService,
    private readonly feePct: number,
    private readonly slippagePct: number,
  ) {}

  getPrice(symbol: string) {
    return this.marketData.getPrice(symbol);
  }

  getMinOrderUsdt() {
    return Promise.resolve(5);
  }

  getFreeBalances() {
    return Promise.resolve(null);
  }

  async buy(symbol: string, quoteAmount: number): Promise<AllocatorFill> {
    const price = (await this.getPrice(symbol)) * (1 + this.slippagePct);
    const fee = quoteAmount * this.feePct;
    return {
      symbol,
      side: 'BUY',
      quantity: (quoteAmount - fee) / price,
      quoteAmount,
      price,
      fee,
      feeAsset: 'USDT',
    };
  }

  async sell(symbol: string, quantity: number): Promise<AllocatorFill> {
    const price = (await this.getPrice(symbol)) * (1 - this.slippagePct);
    const gross = quantity * price;
    const fee = gross * this.feePct;
    return {
      symbol,
      side: 'SELL',
      quantity,
      quoteAmount: gross - fee,
      price,
      fee,
      feeAsset: 'USDT',
    };
  }
}

/**
 * Binance Spot через ccxt. live_testnet — Binance Demo, live_real — реальный аккаунт.
 * Только рыночные ордера на споте: без плеча, без шортов.
 */
export class BinanceSpotAllocatorBroker implements AllocatorBroker {
  private client: ccxt.binance | null = null;

  constructor(
    readonly mode: 'live_testnet' | 'live_real',
    private readonly config: BotConfig,
  ) {}

  async getPrice(symbol: string) {
    const client = await this.getClient();
    const ticker = await client.fetchTicker(this.toMarket(symbol));
    const price = Number(ticker.last ?? ticker.close);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Binance не вернул цену для ${symbol}`);
    }
    return price;
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
    return Object.fromEntries(
      [...assets.map(baseAssetOf), 'USDT'].map((asset) => [
        asset,
        Number(free[asset] ?? 0),
      ]),
    );
  }

  async buy(symbol: string, quoteAmount: number): Promise<AllocatorFill> {
    const client = await this.getClient();
    const cost = Math.floor(quoteAmount * 100) / 100;
    const order = await client.createMarketBuyOrderWithCost(
      this.toMarket(symbol),
      cost,
    );
    return this.toFill(symbol, 'BUY', await this.ensureFilled(order, symbol));
  }

  async sell(symbol: string, quantity: number): Promise<AllocatorFill> {
    const client = await this.getClient();
    const market = this.toMarket(symbol);
    const amount = Number(client.amountToPrecision(market, quantity));
    if (!(amount > 0)) {
      throw new Error(
        `Количество ${quantity} ${symbol} меньше шага лота Binance`,
      );
    }
    const order = await client.createOrder(market, 'market', 'sell', amount);
    return this.toFill(symbol, 'SELL', await this.ensureFilled(order, symbol));
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
      throw new Error(
        `Ордер ${side} ${symbol} не исполнен (status=${order.status})`,
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

  private async getClient() {
    if (this.client) {
      return this.client;
    }

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
      throw new Error(
        this.mode === 'live_testnet'
          ? 'Для аллокатора в live_testnet нужны BINANCE_TESTNET_API_KEY/SECRET (Binance Spot Demo)'
          : 'Для аллокатора в live_real нужны BINANCE_API_KEY/SECRET',
      );
    }

    const client = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      enableRateLimit: true,
      options: { defaultType: 'spot', adjustForTimeDifference: true },
    });
    if (this.mode === 'live_testnet') {
      client.enableDemoTrading(true);
    }
    await client.loadMarkets();
    this.client = client;
    return client;
  }
}
