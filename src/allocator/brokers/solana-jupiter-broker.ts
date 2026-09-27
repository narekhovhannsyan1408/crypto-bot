import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { SolanaConfig } from '../../config/bot-config';
import { AppLogger } from '../../observability/app-logger';
import { LocalizedError, msg } from '../../i18n/messages';
import {
  JupiterClient,
  JupiterQuote,
  routeLabel,
} from '../../solana/jupiter-client';
import { ownerBalanceChange, SwapMeta } from '../../solana/swap-accounting';
import {
  buildTokenRegistry,
  fromRawAmount,
  NATIVE_SOL_MINT,
  SolanaToken,
  toRawAmount,
  USDC,
} from '../../solana/solana-tokens';
import {
  ChainTx,
  createConnection,
  explorerTxUrl,
  loadKeypair,
  shortAddress,
} from '../../solana/solana-wallet';
import { SolanaMode } from '../allocator-mode';
import {
  AllocatorBroker,
  AllocatorFill,
  baseAssetOf,
} from './allocator-broker';

const CONFIRM_POLL_MS = 2_000;
// Столько сбоев RPC подряд терпим, пока ждём подтверждения свопа
const MAX_RPC_FAILURES = 10;
const META_ATTEMPTS = 5;

type SwapResult = {
  // Минимальные единицы: сколько отдали и сколько получили
  spent: bigint;
  received: bigint;
  feeUsd: number;
  chainTx?: ChainTx;
};

// Своп точно не исполнен — повтор безопасен
class SwapNotExecutedError extends LocalizedError {}

export type SolanaBrokerOptions = {
  connectionFactory?: (rpcUrl: string) => Connection;
  pollMs?: number;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Solana через агрегатор Jupiter: USDC ↔ cbBTC / WETH / SOL по лучшему маршруту DEX.
 *
 * solana_sim — котировки Jupiter исполняются виртуально: настоящие цены, глубина
 * рынка и проскальзывание маршрута, но транзакции не отправляются и кошелёк не нужен.
 * solana_real — своп подписывается ключом кошелька и отправляется в основную сеть;
 * результат учитывается по фактическим изменениям балансов в транзакции.
 */
export class SolanaJupiterAllocatorBroker implements AllocatorBroker {
  readonly quoteAsset = USDC.symbol;
  private readonly registry: Record<string, SolanaToken>;
  private readonly connectionFactory: (rpcUrl: string) => Connection;
  private readonly pollMs: number;
  private wallet: Keypair | null = null;
  private connection: Connection | null = null;

  constructor(
    readonly mode: SolanaMode,
    private readonly settings: SolanaConfig,
    private readonly jupiter: JupiterClient,
    private readonly journal?: AppLogger,
    options: SolanaBrokerOptions = {},
  ) {
    this.registry = buildTokenRegistry(settings.tokenMints);
    this.connectionFactory = options.connectionFactory ?? createConnection;
    this.pollMs = options.pollMs ?? CONFIRM_POLL_MS;
  }

  async getPrice(symbol: string) {
    return (await this.getPrices([symbol]))[symbol];
  }

  async getPrices(symbols: string[]) {
    const tokens = symbols.map((symbol) => this.token(symbol));
    const usd = await this.jupiter.getUsdPrices(tokens.map((t) => t.mint));
    return Object.fromEntries(
      symbols.map((symbol, index) => [symbol, usd[tokens[index].mint]]),
    );
  }

  // У DEX нет минимального ордера; нижнюю границу задаёт BOT_ALLOCATOR_MIN_ORDER_USDT
  getMinOrderUsdt() {
    return Promise.resolve(1);
  }

  async getFreeBalances(assets: string[]) {
    if (this.mode === 'solana_sim') {
      return null;
    }
    const { connection, wallet } = this.chain();
    const wanted: Array<[string, SolanaToken]> = [
      ...assets.map((symbol): [string, SolanaToken] => [
        baseAssetOf(symbol),
        this.token(symbol),
      ]),
      [USDC.symbol, USDC],
    ];
    const balances = Object.fromEntries(
      await Promise.all(
        wanted.map(
          async ([key, token]) =>
            [
              key,
              await this.walletBalance(connection, wallet.publicKey, token),
            ] as const,
        ),
      ),
    );
    this.journal?.debug('broker.solana.balance', 'Остатки кошелька Solana', {
      mode: this.mode,
      wallet: wallet.publicKey.toBase58(),
      balances,
    });
    return balances;
  }

  async assertCanTrade() {
    if (this.mode === 'solana_sim') return;
    const { connection, wallet } = this.chain();
    const sol =
      (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
    if (sol < this.settings.minSolForFees) {
      throw new LocalizedError(
        msg('err.solana.lowSol', {
          address: shortAddress(wallet.publicKey.toBase58()),
          sol: sol.toFixed(4),
          min: this.settings.minSolForFees,
        }),
      );
    }
  }

  async buy(symbol: string, quoteAmount: number): Promise<AllocatorFill> {
    const token = this.token(symbol);
    const result = await this.swap(
      'BUY',
      symbol,
      USDC,
      token,
      toRawAmount(quoteAmount, USDC.decimals),
    );
    const quantity = fromRawAmount(result.received, token.decimals);
    const spent = fromRawAmount(result.spent, USDC.decimals);
    return {
      symbol,
      side: 'BUY',
      quantity,
      quoteAmount: spent,
      price: spent / quantity,
      fee: result.feeUsd,
      feeAsset: 'SOL',
      chainTx: result.chainTx,
    };
  }

  async sell(symbol: string, quantity: number): Promise<AllocatorFill> {
    const token = this.token(symbol);
    const amount = toRawAmount(quantity, token.decimals);
    if (amount <= 0n) {
      throw new LocalizedError(
        msg('err.solana.tooSmall', { qty: quantity, symbol }),
      );
    }
    const result = await this.swap('SELL', symbol, token, USDC, amount);
    const sold = fromRawAmount(result.spent, token.decimals);
    const received = fromRawAmount(result.received, USDC.decimals);
    return {
      symbol,
      side: 'SELL',
      quantity: sold,
      quoteAmount: received,
      price: received / sold,
      fee: result.feeUsd,
      feeAsset: 'SOL',
      chainTx: result.chainTx,
    };
  }

  /** Адрес кошелька для интерфейса; null, если ключ не задан или не читается. */
  walletAddress() {
    try {
      return this.chain().wallet.publicKey.toBase58();
    } catch {
      return null;
    }
  }

  private token(symbol: string) {
    const base = baseAssetOf(symbol);
    const token = this.registry[base];
    if (!token) {
      throw new LocalizedError(msg('err.solana.assetUnsupported', { base }));
    }
    return token;
  }

  private async swap(
    side: 'BUY' | 'SELL',
    symbol: string,
    input: SolanaToken,
    output: SolanaToken,
    amount: bigint,
  ): Promise<SwapResult> {
    const startedAt = performance.now();
    const quote = await this.jupiter.getQuote({
      inputMint: input.mint,
      outputMint: output.mint,
      amount,
      slippageBps: this.settings.slippageBps,
    });
    const context = {
      mode: this.mode,
      symbol,
      side,
      from: input.symbol,
      to: output.symbol,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpactPct: Number(quote.priceImpactPct),
      route: routeLabel(quote),
    };

    if (this.mode === 'solana_sim') {
      this.journal?.debug(
        'broker.solana.sim_fill',
        `Виртуальный своп ${side} ${symbol} по котировке Jupiter`,
        context,
      );
      return {
        spent: BigInt(quote.inAmount),
        received: BigInt(quote.outAmount),
        feeUsd: 0,
      };
    }

    this.journal?.info(
      'broker.solana.swap_request',
      `Своп ${side} ${symbol} через Jupiter`,
      context,
    );
    try {
      const result = await this.execute(quote);
      this.journal?.log(
        'info',
        'broker.solana.swap_confirmed',
        `Своп ${side} ${symbol} подтверждён`,
        {
          durationMs: performance.now() - startedAt,
          data: {
            ...context,
            txId: result.chainTx?.txId,
            url: result.chainTx
              ? explorerTxUrl(result.chainTx.txId, result.chainTx.cluster)
              : null,
            spent: result.spent.toString(),
            received: result.received.toString(),
            feeUsd: result.feeUsd,
          },
        },
      );
      return result;
    } catch (error) {
      this.journal?.log(
        'error',
        'broker.solana.swap_failed',
        `Своп ${side} ${symbol} не исполнен`,
        {
          durationMs: performance.now() - startedAt,
          data: {
            ...context,
            definitelyNotExecuted: error instanceof SwapNotExecutedError,
          },
          err: error,
        },
      );
      throw error;
    }
  }

  private async execute(quote: JupiterQuote): Promise<SwapResult> {
    const { connection, wallet } = this.chain();
    const owner = wallet.publicKey.toBase58();
    const swap = await this.jupiter.buildSwapTransaction(
      quote,
      owner,
      this.settings.maxPriorityFeeLamports,
    );
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swap.swapTransaction, 'base64'),
    );
    transaction.sign([wallet]);
    // id транзакции — её подпись: известен до отправки, по нему проверяем статус
    const txId = bs58.encode(transaction.signatures[0]);
    const chainTx: ChainTx = { txId, cluster: 'mainnet-beta' };
    try {
      await connection.sendRawTransaction(transaction.serialize(), {
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
    } catch (error) {
      if (error instanceof SendTransactionError) {
        // Отказ preflight-симуляции: транзакция в сеть не ушла
        throw new SwapNotExecutedError(
          msg('err.solana.preflight', { detail: error.message }),
        );
      }
      // Ответ RPC потерялся, но транзакция могла уйти — исход покажет её статус
      this.journal?.warn(
        'broker.solana.send_uncertain',
        'Нет ответа на отправку свопа, проверяем статус',
        { txId },
        error,
      );
    }
    this.journal?.info('broker.solana.swap_sent', 'Своп отправлен в сеть', {
      txId,
      url: explorerTxUrl(txId, chainTx.cluster),
      lastValidBlockHeight: swap.lastValidBlockHeight,
    });

    await this.waitForConfirmation(connection, txId, swap.lastValidBlockHeight);

    const meta = await this.fetchMeta(connection, txId);
    if (!meta) {
      // Своп уже в блокчейне: без деталей учитываем по котировке, а не теряем сделку
      this.journal?.warn(
        'broker.solana.meta_unavailable',
        'RPC не отдал детали подтверждённого свопа, учёт по котировке',
        { txId },
      );
      return {
        spent: BigInt(quote.inAmount),
        received: BigInt(quote.outAmount),
        feeUsd: 0,
        chainTx,
      };
    }
    const spent = -ownerBalanceChange(meta, owner, quote.inputMint);
    const received = ownerBalanceChange(meta, owner, quote.outputMint);
    if (spent <= 0n || received <= 0n) {
      throw new LocalizedError(msg('err.solana.noSwapInTx', { tx: txId }));
    }
    return {
      spent,
      received,
      feeUsd: await this.networkFeeUsd(meta.fee),
      chainTx,
    };
  }

  /**
   * Ждём, пока своп подтвердится или его блокхэш истечёт — только тогда можно
   * точно сказать, что транзакция не исполнится. Сбои RPC по пути не означают отказ.
   */
  private async waitForConfirmation(
    connection: Connection,
    txId: string,
    lastValidBlockHeight: number,
  ) {
    let rpcFailures = 0;
    for (;;) {
      try {
        const status = (await connection.getSignatureStatuses([txId])).value[0];
        if (status?.err) {
          throw new SwapNotExecutedError(
            msg('err.solana.rejected', {
              tx: txId,
              detail: JSON.stringify(status.err),
            }),
          );
        }
        if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized'
        ) {
          return;
        }
        if (
          !status &&
          (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight
        ) {
          const final = (
            await connection.getSignatureStatuses([txId], {
              searchTransactionHistory: true,
            })
          ).value[0];
          if (!final) {
            throw new SwapNotExecutedError(
              msg('err.solana.expired', { tx: txId }),
            );
          }
        }
        rpcFailures = 0;
      } catch (error) {
        if (error instanceof SwapNotExecutedError) throw error;
        rpcFailures += 1;
        if (rpcFailures >= MAX_RPC_FAILURES) {
          throw new LocalizedError(
            msg('err.solana.statusUnknown', {
              tx: txId,
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      await sleep(this.pollMs);
    }
  }

  private async fetchMeta(connection: Connection, txId: string) {
    for (let attempt = 1; attempt <= META_ATTEMPTS; attempt += 1) {
      try {
        const tx = await connection.getTransaction(txId, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (tx?.meta) return tx.meta as SwapMeta;
      } catch {
        // RPC ещё не проиндексировал транзакцию или временно недоступен
      }
      await sleep(this.pollMs);
    }
    return null;
  }

  private async networkFeeUsd(lamports: number) {
    try {
      const prices = await this.jupiter.getUsdPrices([NATIVE_SOL_MINT]);
      return (lamports / LAMPORTS_PER_SOL) * prices[NATIVE_SOL_MINT];
    } catch {
      return 0;
    }
  }

  private async walletBalance(
    connection: Connection,
    owner: PublicKey,
    token: SolanaToken,
  ) {
    if (token.mint === NATIVE_SOL_MINT) {
      const sol = (await connection.getBalance(owner)) / LAMPORTS_PER_SOL;
      return Math.max(sol - this.settings.minSolForFees, 0);
    }
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
      mint: new PublicKey(token.mint),
    });
    const raw = accounts.value.reduce((sum, account) => {
      const parsed = account.account.data.parsed as {
        info?: { tokenAmount?: { amount?: string } };
      };
      return sum + BigInt(parsed.info?.tokenAmount?.amount ?? '0');
    }, 0n);
    return fromRawAmount(raw, token.decimals);
  }

  private chain() {
    if (!this.wallet) {
      const wallet = loadKeypair(this.settings);
      if (!wallet) {
        throw new LocalizedError(msg('err.solana.noWallet'));
      }
      this.wallet = wallet;
    }
    this.connection ??= this.connectionFactory(this.settings.rpcUrl);
    return { wallet: this.wallet, connection: this.connection };
  }
}
