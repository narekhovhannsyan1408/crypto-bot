import { ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  encodeDecisionMemo,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ID,
} from './decision-proof';
import {
  buildProofTransaction,
  PROOF_COMPUTE_UNITS,
} from './solana-proof.service';
import { ownerBalanceChange } from './swap-accounting';
import {
  buildTokenRegistry,
  fromRawAmount,
  NATIVE_SOL_MINT,
  toRawAmount,
  unsupportedAssets,
  USDC,
} from './solana-tokens';
import { explorerTxUrl, loadKeypair, parseSecretKey } from './solana-wallet';

describe('Solana tokens', () => {
  it('maps allocator assets to liquid Solana tokens', () => {
    const registry = buildTokenRegistry('');

    expect(registry.BTC.symbol).toBe('cbBTC');
    expect(registry.ETH.symbol).toBe('WETH');
    expect(registry.SOL.mint).toBe(NATIVE_SOL_MINT);
    expect(unsupportedAssets(registry, ['BTC', 'DOGE'])).toEqual(['DOGE']);
  });

  it('accepts custom token addresses and rejects malformed ones', () => {
    const wbtc = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
    const registry = buildTokenRegistry(`btc:${wbtc}:8`);

    expect(registry.BTC).toMatchObject({ mint: wbtc, decimals: 8 });
    expect(() => buildTokenRegistry('BTC:not-an-address:8')).toThrow(
      'SOLANA_TOKEN_MINTS',
    );
    expect(() => buildTokenRegistry(`BTC:${wbtc}`)).toThrow();
  });

  it('converts amounts to raw units without float artefacts', () => {
    expect(toRawAmount(0.29, 8)).toBe(29_000_000n);
    expect(toRawAmount(1.23456789, 8)).toBe(123_456_789n);
    // Лишние знаки отбрасываются вниз: нельзя продать больше, чем есть
    expect(toRawAmount(1.999999999, 6)).toBe(1_999_999n);
    expect(toRawAmount(-5, 6)).toBe(0n);
    expect(fromRawAmount('2500000', USDC.decimals)).toBe(2.5);
  });
});

describe('Solana wallet', () => {
  const keypair = Keypair.generate();

  it('reads base58 and solana-keygen JSON keys', () => {
    const base58 = bs58.encode(keypair.secretKey);
    const json = JSON.stringify(Array.from(keypair.secretKey));

    expect(loadKeypair({ privateKey: base58 })?.publicKey).toEqual(
      keypair.publicKey,
    );
    expect(loadKeypair({ privateKey: json })?.publicKey).toEqual(
      keypair.publicKey,
    );
    expect(loadKeypair({})).toBeNull();
  });

  it('never echoes key material in errors', () => {
    const broken = `${bs58.encode(keypair.secretKey).slice(0, 40)}0OIl`;

    expect(() => parseSecretKey(broken)).toThrow("wasn't recognized");
    try {
      parseSecretKey(broken);
    } catch (error) {
      expect((error as Error).message).not.toContain(broken.slice(0, 10));
    }
    expect(() => parseSecretKey('[1,2,3]')).toThrow('64 bytes');
  });

  it('links transactions to the right cluster in the explorer', () => {
    expect(explorerTxUrl('abc', 'mainnet-beta')).toBe(
      'https://explorer.solana.com/tx/abc',
    );
    expect(explorerTxUrl('abc', 'devnet')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=devnet',
    );
  });
});

describe('swap accounting', () => {
  const owner = 'Owner111';
  const other = 'Other111';
  const balance = (mint: string, holder: string, amount: string) => ({
    accountIndex: 1,
    mint,
    owner: holder,
    uiTokenAmount: { amount },
  });

  it('measures token changes of the wallet only', () => {
    const meta = {
      fee: 5_000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [
        balance(USDC.mint, owner, '1000000000'),
        balance(USDC.mint, other, '777'),
      ],
      postTokenBalances: [
        balance(USDC.mint, owner, '500000000'),
        balance(USDC.mint, other, '999999'),
      ],
    };

    expect(ownerBalanceChange(meta, owner, USDC.mint)).toBe(-500_000_000n);
  });

  it('counts native SOL without the network fee', () => {
    const meta = {
      fee: 5_000,
      preBalances: [3_000_000_000],
      postBalances: [1_999_995_000],
      preTokenBalances: [],
      postTokenBalances: [],
    };

    expect(ownerBalanceChange(meta, owner, NATIVE_SOL_MINT)).toBe(
      -1_000_000_000n,
    );
  });
});

describe('decision memo', () => {
  const proof = {
    sessionId: '1759000000000',
    mode: 'solana_sim',
    day: Date.UTC(2026, 8, 26),
    equity: 1234.5678,
    quote: 'USDC',
    signals: [
      { asset: 'BTC', close: 84831.1, votes: 4, total: 4, targetWeight: 0.5 },
      { asset: 'ETH', close: 2707.67, votes: 2, total: 4, targetWeight: 0.25 },
    ],
    orders: [{ side: 'BUY' as const, asset: 'BTC', amount: 250.123 }],
  };

  it('is compact, readable JSON with the signals and planned orders', () => {
    const memo = JSON.parse(encodeDecisionMemo(proof)) as Record<
      string,
      unknown
    >;

    expect(memo).toMatchObject({
      app: 'crypto-bot',
      kind: 'daily-decision',
      day: '2026-09-26',
      equity: 1234.57,
      signals: {
        BTC: { close: 84831.1, sma: '4/4', target: 0.5 },
        ETH: { close: 2707.67, sma: '2/4', target: 0.25 },
      },
      orders: ['BUY BTC 250.12'],
    });
  });

  it('drops the order list first when the memo would not fit', () => {
    const many = {
      ...proof,
      orders: Array.from({ length: 30 }, (_, index) => ({
        side: 'SELL' as const,
        asset: `ASSET${index}`,
        amount: 1000 + index,
      })),
    };

    const memo = encodeDecisionMemo(many);

    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(MAX_MEMO_BYTES);
    expect((JSON.parse(memo) as { orders: unknown }).orders).toBe(30);
  });

  it('builds a transaction that fits even the largest memo', () => {
    const signer = Keypair.generate();
    const memo = 'x'.repeat(MAX_MEMO_BYTES);
    const transaction = buildProofTransaction(
      memo,
      signer.publicKey,
      Keypair.generate().publicKey.toBase58(),
      100,
    );
    transaction.sign(signer);

    const [budget, memoInstruction] = transaction.instructions;
    // Проверено симуляцией в devnet: 559 байт требуют ~211 тыс. единиц при лимите 200 тыс.
    expect(budget.programId).toEqual(ComputeBudgetProgram.programId);
    expect(budget.data.readUInt32LE(1)).toBe(PROOF_COMPUTE_UNITS);
    expect(PROOF_COMPUTE_UNITS).toBeGreaterThan(MAX_MEMO_BYTES * 380);
    expect(memoInstruction.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(memoInstruction.data.toString('utf8')).toBe(memo);
    expect(transaction.serialize().length).toBeLessThanOrEqual(1232);
  });
});
