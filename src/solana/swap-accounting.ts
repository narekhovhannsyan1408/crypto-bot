import { NATIVE_SOL_MINT } from './solana-tokens';

type TokenBalance = {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

/** Часть meta подтверждённой транзакции, нужная для учёта свопа. */
export type SwapMeta = {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
};

const sumOwned = (
  balances: TokenBalance[] | null | undefined,
  owner: string,
  mint: string,
) =>
  (balances ?? [])
    .filter((item) => item.owner === owner && item.mint === mint)
    .reduce((sum, item) => sum + BigInt(item.uiTokenAmount.amount), 0n);

/**
 * Изменение баланса кошелька по токену в минимальных единицах — по фактическим
 * данным блокчейна, а не по котировке. Для SOL учитываются лампорты кошелька
 * (он же плательщик комиссии, индекс 0) без комиссии сети плюс wSOL-счета.
 */
export const ownerBalanceChange = (
  meta: SwapMeta,
  owner: string,
  mint: string,
) => {
  const tokenChange =
    sumOwned(meta.postTokenBalances, owner, mint) -
    sumOwned(meta.preTokenBalances, owner, mint);
  if (mint !== NATIVE_SOL_MINT) {
    return tokenChange;
  }
  const lamports =
    BigInt(meta.postBalances[0] ?? 0) -
    BigInt(meta.preBalances[0] ?? 0) +
    BigInt(meta.fee);
  return lamports + tokenChange;
};
