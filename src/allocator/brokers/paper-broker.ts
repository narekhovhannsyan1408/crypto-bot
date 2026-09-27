import { AppLogger } from '../../observability/app-logger';
import { AllocatorMarketDataService } from '../market-data/allocator-market-data.service';
import { AllocatorBroker, AllocatorFill } from './allocator-broker';

/** Виртуальный счёт: настоящие цены Binance, комиссия и проскальзывание моделируются. */
export class PaperAllocatorBroker implements AllocatorBroker {
  readonly mode = 'paper' as const;
  readonly quoteAsset = 'USDT';

  constructor(
    private readonly marketData: AllocatorMarketDataService,
    private readonly feePct: number,
    private readonly slippagePct: number,
    private readonly journal?: AppLogger,
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
    this.journal?.debug('broker.paper.fill', `Виртуальная покупка ${symbol}`, {
      symbol,
      quoteAmount,
      price,
      fee,
    });
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
    this.journal?.debug('broker.paper.fill', `Виртуальная продажа ${symbol}`, {
      symbol,
      quantity,
      price,
      fee,
    });
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
