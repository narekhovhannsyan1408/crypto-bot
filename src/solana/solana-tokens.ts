import { LocalizedError, msg } from '../i18n/messages';

/**
 * Токены Solana, которыми торгует бот. Ключ — базовый актив из BOT_ALLOCATOR_ASSETS
 * (BTC, ETH, SOL): сигналы считаются по BTCUSDT/ETHUSDT, а исполнение идёт в их
 * представителях на Solana.
 */
export type SolanaToken = {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
};

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

// Расчётный стейблкоин на Solana: самый ликвидный доллар в сети
export const USDC: SolanaToken = {
  symbol: 'USDC',
  name: 'USD Coin',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
};

const DEFAULT_TOKENS: Record<string, SolanaToken> = {
  BTC: {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
    decimals: 8,
  },
  ETH: {
    symbol: 'WETH',
    name: 'Ether (Wormhole)',
    mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    decimals: 8,
  },
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    mint: NATIVE_SOL_MINT,
    decimals: 9,
  },
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Реестр токенов с учётом SOLANA_TOKEN_MINTS=BTC:<mint>:<decimals>,…
 * (например, чтобы торговать WBTC вместо cbBTC).
 */
export const buildTokenRegistry = (overrides: string) => {
  const registry: Record<string, SolanaToken> = { ...DEFAULT_TOKENS };
  for (const item of overrides.split(',').map((part) => part.trim())) {
    if (!item) continue;
    const [asset, mint, decimalsText] = item.split(':').map((s) => s.trim());
    const decimals = Number(decimalsText);
    if (
      !asset ||
      !BASE58_ADDRESS.test(mint ?? '') ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 18
    ) {
      throw new LocalizedError(msg('err.solana.tokenMints', { item }));
    }
    const base = asset.toUpperCase();
    registry[base] = { symbol: base, name: base, mint, decimals };
  }
  return registry;
};

export const unsupportedAssets = (
  registry: Record<string, SolanaToken>,
  baseAssets: string[],
) => baseAssets.filter((base) => !registry[base]);

/**
 * Число → целое количество минимальных единиц токена. Дробный остаток отбрасывается,
 * чтобы не продать больше, чем есть; погрешность float (0.29 * 1e8 = 28999999.99…)
 * округляется к ближайшему целому.
 */
export const toRawAmount = (amount: number, decimals: number) => {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const scaled = amount * 10 ** decimals;
  const nearest = Math.round(scaled);
  return BigInt(
    Math.abs(scaled - nearest) < 1e-6 ? nearest : Math.floor(scaled),
  );
};

export const fromRawAmount = (raw: bigint | string, decimals: number) =>
  Number(BigInt(raw)) / 10 ** decimals;
