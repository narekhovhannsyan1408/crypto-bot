import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { SolanaConfig } from '../../config/bot-config';
import { AppLogger } from '../../observability/app-logger';
import { MemorySink } from '../../observability/rotating-file-sink';
import { MEMO_PROGRAM_ID } from '../../solana/decision-proof';
import { JupiterClient } from '../../solana/jupiter-client';
import {
  buildTokenRegistry,
  NATIVE_SOL_MINT,
  USDC,
} from '../../solana/solana-tokens';
import { SolanaJupiterAllocatorBroker } from './solana-jupiter-broker';

const BTC = buildTokenRegistry('').BTC;
const SOL_PRICE = 150;

const settings = (wallet: Keypair): SolanaConfig => ({
  rpcUrl: 'http://rpc.test',
  jupiterApiUrl: 'http://jupiter.test',
  jupiterApiKey: '',
  privateKey: JSON.stringify(Array.from(wallet.secretKey)),
  keypairPath: '',
  allowReal: true,
  slippageBps: 50,
  maxPriorityFeeLamports: 100_000,
  minSolForFees: 0.02,
  tokenMints: '',
  proof: {
    enabled: false,
    cluster: 'devnet',
    rpcUrl: 'http://devnet.test',
    keypairPath: '',
  },
});

// Настоящая подписываемая транзакция: брокер десериализует и подписывает ответ Jupiter
const swapTransactionFor = (wallet: Keypair) =>
  Buffer.from(
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [
          new TransactionInstruction({
            programId: new PublicKey(MEMO_PROGRAM_ID),
            keys: [],
            data: Buffer.from('swap'),
          }),
        ],
      }).compileToV0Message(),
    ).serialize(),
  ).toString('base64');

const createJupiter = (wallet: Keypair) => ({
  getUsdPrices: jest.fn((mints: string[]) =>
    Promise.resolve(
      Object.fromEntries(
        mints.map((mint) => [
          mint,
          mint === NATIVE_SOL_MINT ? SOL_PRICE : 85_000,
        ]),
      ),
    ),
  ),
  getQuote: jest.fn(
    (params: { inputMint: string; outputMint: string; amount: bigint }) =>
      Promise.resolve({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amount.toString(),
        // 500 USDC → 0.00588 cbBTC по котировке
        outAmount: '588000',
        otherAmountThreshold: '585000',
        slippageBps: 50,
        priceImpactPct: '0.0002',
        routePlan: [
          { percent: 100, swapInfo: { label: 'Orca', ammKey: 'pool' } },
        ],
      }),
  ),
  buildSwapTransaction: jest.fn(() =>
    Promise.resolve({
      swapTransaction: swapTransactionFor(wallet),
      lastValidBlockHeight: 1_000,
    }),
  ),
});

const tokenBalance = (mint: string, owner: string, amount: string) => ({
  accountIndex: 1,
  mint,
  owner,
  uiTokenAmount: { amount },
});

type FakeConnection = {
  sendRawTransaction: jest.Mock;
  getSignatureStatuses: jest.Mock;
  getBlockHeight: jest.Mock;
  getTransaction: jest.Mock;
  getBalance: jest.Mock;
  getParsedTokenAccountsByOwner: jest.Mock;
};

const createConnection = (wallet: Keypair): FakeConnection => {
  const owner = wallet.publicKey.toBase58();
  return {
    sendRawTransaction: jest.fn(() => Promise.resolve('ignored')),
    // Сначала транзакция ещё не видна, потом подтверждена
    getSignatureStatuses: jest
      .fn()
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValue({
        value: [{ confirmationStatus: 'confirmed', err: null }],
      }),
    getBlockHeight: jest.fn(() => Promise.resolve(900)),
    // Фактически получили меньше котировки (проскальзывание) — учитываем факт
    getTransaction: jest.fn(() =>
      Promise.resolve({
        meta: {
          fee: 10_000,
          preBalances: [1_000_000_000],
          postBalances: [999_990_000],
          preTokenBalances: [tokenBalance(USDC.mint, owner, '800000000')],
          postTokenBalances: [
            tokenBalance(USDC.mint, owner, '300000000'),
            tokenBalance(BTC.mint, owner, '587000'),
          ],
        },
      }),
    ),
    getBalance: jest.fn(() => Promise.resolve(1_000_000_000)),
    getParsedTokenAccountsByOwner: jest.fn(
      (_owner: PublicKey, filter: { mint: PublicKey }) =>
        Promise.resolve({
          value:
            filter.mint.toBase58() === USDC.mint
              ? [
                  {
                    account: {
                      data: {
                        parsed: {
                          info: { tokenAmount: { amount: '800000000' } },
                        },
                      },
                    },
                  },
                ]
              : [],
        }),
    ),
  };
};

describe('SolanaJupiterAllocatorBroker', () => {
  const setup = (mode: 'solana_sim' | 'solana_real' = 'solana_real') => {
    const wallet = Keypair.generate();
    const jupiter = createJupiter(wallet);
    const connection = createConnection(wallet);
    const journal = new MemorySink();
    const broker = new SolanaJupiterAllocatorBroker(
      mode,
      settings(wallet),
      jupiter as unknown as JupiterClient,
      new AppLogger(journal, 'trace'),
      {
        connectionFactory: () => connection as unknown as Connection,
        pollMs: 1,
      },
    );
    return { wallet, jupiter, connection, journal, broker };
  };

  it('simulates swaps from Jupiter quotes without a wallet or transactions', async () => {
    const { broker, jupiter, connection } = setup('solana_sim');

    const fill = await broker.buy('BTCUSDT', 500);

    expect(fill).toMatchObject({
      side: 'BUY',
      quantity: 0.00588,
      quoteAmount: 500,
      fee: 0,
    });
    expect(fill.chainTx).toBeUndefined();
    expect(jupiter.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMint: USDC.mint,
        outputMint: BTC.mint,
        amount: 500_000_000n,
      }),
    );
    expect(jupiter.buildSwapTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(await broker.getFreeBalances(['BTCUSDT'])).toBeNull();
  });

  it('signs, sends and books a real swap by the on-chain balance changes', async () => {
    const { broker, wallet, jupiter, connection, journal } = setup();

    const fill = await broker.buy('BTCUSDT', 500);

    expect(jupiter.buildSwapTransaction).toHaveBeenCalledWith(
      expect.anything(),
      wallet.publicKey.toBase58(),
      100_000,
    );
    const [raw] = connection.sendRawTransaction.mock.calls[0] as [Uint8Array];
    const sent = VersionedTransaction.deserialize(raw);
    expect(fill.chainTx).toEqual({
      txId: bs58.encode(sent.signatures[0]),
      cluster: 'mainnet-beta',
    });
    expect(fill.quantity).toBe(0.00587);
    expect(fill.quoteAmount).toBe(500);
    expect(fill.fee).toBeCloseTo((10_000 / 1e9) * SOL_PRICE, 8);
    expect(journal.events()).toEqual(
      expect.arrayContaining([
        'broker.solana.swap_request',
        'broker.solana.swap_sent',
        'broker.solana.swap_confirmed',
      ]),
    );
  });

  it('fails fast when the swap is rejected before sending', async () => {
    const { broker, connection } = setup();
    connection.sendRawTransaction.mockRejectedValue(
      new SendTransactionError({
        action: 'send',
        signature: '',
        transactionMessage: 'insufficient funds',
        logs: [],
      }),
    );

    await expect(broker.buy('BTCUSDT', 500)).rejects.toThrow(
      'отклонила своп до отправки',
    );
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('still books the swap when the send response is lost but the swap landed', async () => {
    const { broker, connection, journal } = setup();
    connection.sendRawTransaction.mockRejectedValue(
      new TypeError('fetch failed'),
    );

    const fill = await broker.buy('BTCUSDT', 500);

    expect(fill.quantity).toBe(0.00587);
    expect(journal.events()).toContain('broker.solana.send_uncertain');
  });

  it('reports a swap as not executed only after its blockhash expired', async () => {
    const { broker, connection } = setup();
    connection.getSignatureStatuses.mockReset();
    connection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    connection.getBlockHeight
      .mockResolvedValueOnce(990)
      .mockResolvedValue(1_001);

    await expect(broker.buy('BTCUSDT', 500)).rejects.toThrow('не попал в блок');
    expect(connection.getTransaction).not.toHaveBeenCalled();
  });

  it('books a swap found only in the history after the blockhash expired', async () => {
    const { broker, connection } = setup();
    // Недавний кэш статусов транзакцию уже не помнит, а история — помнит
    connection.getSignatureStatuses.mockReset();
    connection.getSignatureStatuses.mockImplementation(
      (_ids: string[], config?: { searchTransactionHistory?: boolean }) =>
        Promise.resolve({
          value: [
            config?.searchTransactionHistory
              ? { confirmationStatus: 'finalized', err: null }
              : null,
          ],
        }),
    );
    connection.getBlockHeight.mockResolvedValue(1_001);

    const fill = await broker.buy('BTCUSDT', 500);

    expect(fill.quantity).toBe(0.00587);
    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it('reports a failed swap found in the history as not executed', async () => {
    const { broker, connection } = setup();
    connection.getSignatureStatuses.mockReset();
    connection.getSignatureStatuses.mockImplementation(
      (_ids: string[], config?: { searchTransactionHistory?: boolean }) =>
        Promise.resolve({
          value: [
            config?.searchTransactionHistory
              ? {
                  confirmationStatus: 'finalized',
                  err: { InstructionError: [2, 'Custom'] },
                }
              : null,
          ],
        }),
    );
    connection.getBlockHeight.mockResolvedValue(1_001);

    await expect(broker.buy('BTCUSDT', 500)).rejects.toThrow(
      'InstructionError',
    );
    expect(connection.getTransaction).not.toHaveBeenCalled();
  });

  it('reads wallet balances and keeps SOL for network fees', async () => {
    const { broker } = setup();

    expect(await broker.getFreeBalances(['BTCUSDT', 'SOLUSDT'])).toEqual({
      BTC: 0,
      SOL: 0.98,
      USDC: 800,
    });
  });

  it('refuses to start without SOL for network fees', async () => {
    const { broker, connection } = setup();
    connection.getBalance.mockResolvedValue(1_000_000);

    await expect(broker.assertCanTrade()).rejects.toThrow('комиссий сети');
  });
});
