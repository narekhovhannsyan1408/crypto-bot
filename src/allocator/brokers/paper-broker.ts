import { AllocatorMarketDataService } from '../market-data/allocator-market-data.service';
import { AllocatorBroker, AllocatorFill } from './allocator-broker';

/** Виртуальный счёт: настоящие цены Binance, комиссия и проскальзывание моделируются. */
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

  getPrices(symbols: string[]) {
    return this.marketData.getPrices(symbols);
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
