import { ExecutionMode } from '../trader/execution.types';

export type SolanaMode = 'solana_sim' | 'solana_real';

/**
 * Режимы аллокатора: Binance (paper — виртуальный счёт на ценах Binance,
 * live_testnet — Binance Demo, live_real — реальный аккаунт) и Solana
 * (solana_sim — котировки Jupiter без отправки транзакций, solana_real — свопы
 * с кошелька в основной сети).
 */
export type AllocatorMode = ExecutionMode | SolanaMode;

export const ALLOCATOR_MODES: AllocatorMode[] = [
  'paper',
  'live_testnet',
  'live_real',
  'solana_sim',
  'solana_real',
];

export const isSolanaMode = (mode: AllocatorMode): mode is SolanaMode =>
  mode === 'solana_sim' || mode === 'solana_real';

export const isRealMoneyMode = (mode: AllocatorMode) =>
  mode === 'live_real' || mode === 'solana_real';

// Режимы с внешним счётом: перед запуском проверяется свободный баланс
export const hasExternalAccount = (mode: AllocatorMode) =>
  mode === 'live_testnet' || mode === 'live_real' || mode === 'solana_real';

export const venueOf = (mode: AllocatorMode) =>
  isSolanaMode(mode) ? 'Solana' : 'Binance';

export const quoteAssetOf = (mode: AllocatorMode) =>
  isSolanaMode(mode) ? 'USDC' : 'USDT';
