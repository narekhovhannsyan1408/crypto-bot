import { Injectable } from '@nestjs/common';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { getBotConfig, SolanaCluster } from '../config/bot-config';
import { errorMsg, Msg, ru } from '../i18n/messages';
import { AppLogger } from '../observability/app-logger';
import {
  DecisionProof,
  encodeDecisionMemo,
  MEMO_PROGRAM_ID,
} from './decision-proof';
import {
  ChainTx,
  createConnection,
  explorerTxUrl,
  loadKeypair,
} from './solana-wallet';

/**
 * Memo-программа тратит ~350 вычислительных единиц на байт: запись в 560 байт
 * (~215 тыс.) не укладывается в стандартные 200 тыс. Лимит без цены за единицу
 * комиссию не увеличивает.
 */
export const PROOF_COMPUTE_UNITS = 400_000;

export const buildProofTransaction = (
  memo: string,
  signer: PublicKey,
  blockhash: string,
  lastValidBlockHeight: number,
) =>
  new Transaction({ feePayer: signer, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: PROOF_COMPUTE_UNITS }),
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
      data: Buffer.from(memo, 'utf8'),
    }),
  );

export type ProofStatus = {
  enabled: boolean;
  cluster: SolanaCluster;
  address: string | null;
  // Почему журнал включён, но не работает — ключ словаря для страницы
  problem: Msg | null;
};

/**
 * Публикует ежедневные решения бота в Solana через Memo-программу.
 * Сбой публикации никогда не мешает торговле: он только пишется в журнал.
 */
@Injectable()
export class SolanaProofService {
  private readonly settings = getBotConfig().solana.proof;
  private keypair: Keypair | null = null;
  private problem: Msg | null = null;
  private connection: Connection | null = null;

  constructor(private readonly journal: AppLogger) {
    if (!this.settings.enabled) return;
    try {
      this.keypair = loadKeypair({ keypairPath: this.settings.keypairPath });
    } catch (error) {
      this.problem = errorMsg(error);
      this.journal.warn(
        'solana.proof.unavailable',
        'Журнал решений в Solana включён, но кошелёк не загружен',
        { cluster: this.settings.cluster, problem: ru(this.problem) },
      );
    }
  }

  status(): ProofStatus {
    return {
      enabled: this.settings.enabled,
      cluster: this.settings.cluster,
      address: this.keypair?.publicKey.toBase58() ?? null,
      problem: this.problem,
    };
  }

  /**
   * Отправляет запись и возвращает id транзакции, не дожидаясь подтверждения:
   * подтверждение приходит через несколько секунд и пишется в журнал отдельно.
   */
  async publish(proof: DecisionProof): Promise<ChainTx | null> {
    const keypair = this.keypair;
    if (!this.settings.enabled || !keypair) return null;

    const memo = encodeDecisionMemo(proof);
    const connection = (this.connection ??= createConnection(
      this.settings.rpcUrl,
    ));
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    const transaction = buildProofTransaction(
      memo,
      keypair.publicKey,
      blockhash,
      lastValidBlockHeight,
    );
    transaction.sign(keypair);
    const txId = await connection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 5,
    });
    const cluster = this.settings.cluster;
    this.journal.info('solana.proof.sent', 'Решение отправлено в Solana', {
      txId,
      cluster,
      url: explorerTxUrl(txId, cluster),
      memoBytes: Buffer.byteLength(memo),
    });

    void connection
      .confirmTransaction(
        { signature: txId, blockhash, lastValidBlockHeight },
        'confirmed',
      )
      .then((result) => {
        if (result.value.err) {
          throw new Error(JSON.stringify(result.value.err));
        }
        this.journal.info(
          'solana.proof.confirmed',
          'Решение подтверждено в Solana',
          { txId, cluster },
        );
      })
      .catch((error: unknown) =>
        this.journal.warn(
          'solana.proof.unconfirmed',
          'Запись решения не подтвердилась',
          { txId, cluster },
          error,
        ),
      );

    return { txId, cluster };
  }
}
