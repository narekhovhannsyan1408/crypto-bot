import { ru } from '../../i18n/messages';
import { baseAssetOf } from '../brokers/allocator-broker';

// Названия монет — имена собственные, на всех языках одинаковые
const NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  BNB: 'BNB',
  SOL: 'Solana',
  XRP: 'XRP',
  ADA: 'Cardano',
  DOGE: 'Dogecoin',
  LINK: 'Chainlink',
};

export const assetName = (symbol: string) => {
  const base = baseAssetOf(symbol);
  return NAMES[base] ?? base;
};

// Сила тренда по числу скользящих средних ниже цены — ключ словаря
export const trendKey = (votes: number, total: number) => {
  if (total <= 0) return 'trend.none';
  const share = votes / total;
  if (share === 1) return 'trend.strongUp';
  if (share >= 0.75) return 'trend.up';
  if (share >= 0.5) return 'trend.mixed';
  if (share > 0) return 'trend.weak';
  return 'trend.down';
};

export const trendLabel = (votes: number, total: number) =>
  ru({ key: trendKey(votes, total) });
