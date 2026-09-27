import { ChainTx } from '../../solana/solana-wallet';
import { AllocatorMode } from '../allocator-mode';

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
  // Транзакция в блокчейне (свопы на Solana)
  chainTx?: ChainTx;
};

export interface AllocatorBroker {
  readonly mode: AllocatorMode;
  // В чём бот держит свободные деньги: USDT на Binance, USDC на Solana
  readonly quoteAsset: string;
  getPrice(symbol: string): Promise<number>;
  getPrices(symbols: string[]): Promise<Record<string, number>>;
  getMinOrderUsdt(symbol: string): Promise<number>;
  // Свободные остатки на бирже (для сверки учёта сессии); null — брокер без внешнего аккаунта
  getFreeBalances(assets: string[]): Promise<Record<string, number> | null>;
  // Проверка перед запуском сверх баланса (например, SOL на комиссии сети); бросает понятную ошибку
  assertCanTrade?(): Promise<void>;
  buy(symbol: string, quoteAmount: number): Promise<AllocatorFill>;
  sell(symbol: string, quantity: number): Promise<AllocatorFill>;
}

export const baseAssetOf = (symbol: string) => symbol.replace(/USDT$/, '');
