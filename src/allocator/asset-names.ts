import { baseAssetOf } from './allocator-broker';

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

// Понятное описание силы тренда по числу скользящих средних ниже цены
export const trendLabel = (votes: number, total: number) => {
  if (total <= 0) return 'Нет данных';
  const share = votes / total;
  if (share === 1) return 'Сильный рост';
  if (share >= 0.75) return 'Рост';
  if (share >= 0.5) return 'Неопределённо';
  if (share > 0) return 'Слабость';
  return 'Падение';
};
