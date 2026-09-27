import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { errorMsg, Msg } from '../../i18n/messages';
import { AppLogger } from '../../observability/app-logger';
import { JupiterClient } from '../../solana/jupiter-client';
import { loadKeypair } from '../../solana/solana-wallet';
import { AllocatorMode, isSolanaMode } from '../allocator-mode';
import { AllocatorMarketDataService } from '../market-data/allocator-market-data.service';
import { AllocatorBroker } from './allocator-broker';
import { BinanceSpotAllocatorBroker } from './binance-spot-broker';
import { PaperAllocatorBroker } from './paper-broker';
import { SolanaJupiterAllocatorBroker } from './solana-jupiter-broker';

const PAPER_DEFAULT_SLIPPAGE_PCT = 0.0005;

export type SolanaWalletInfo = { address: string | null; problem: Msg | null };

/**
 * Создаёт брокера под режим и переиспользует его: подключение к Binance
 * (загрузка рынков ccxt) дорогое, его не нужно повторять на каждый запрос.
 */
@Injectable()
export class BrokerFactory {
  private readonly config = getBotConfig();
  private readonly brokers = new Map<AllocatorMode, AllocatorBroker>();
  private walletInfo: SolanaWalletInfo | null = null;

  constructor(
    private readonly marketData: AllocatorMarketDataService,
    private readonly jupiter: JupiterClient,
    private readonly journal: AppLogger,
  ) {}

  get(mode: AllocatorMode): AllocatorBroker {
    const existing = this.brokers.get(mode);
    if (existing) {
      return existing;
    }

    const broker = isSolanaMode(mode)
      ? new SolanaJupiterAllocatorBroker(
          mode,
          this.config.solana,
          this.jupiter,
          this.journal,
        )
      : mode === 'paper'
        ? new PaperAllocatorBroker(
            this.marketData,
            this.config.feePct,
            this.config.slippagePct || PAPER_DEFAULT_SLIPPAGE_PCT,
            this.journal,
          )
        : new BinanceSpotAllocatorBroker(mode, this.config, this.journal);
    this.brokers.set(mode, broker);
    return broker;
  }

  /** Кошелёк для solana_real: адрес или понятная причина, почему он не загружен. */
  solanaWallet(): SolanaWalletInfo {
    if (!this.walletInfo) {
      try {
        const wallet = loadKeypair(this.config.solana);
        this.walletInfo = {
          address: wallet?.publicKey.toBase58() ?? null,
          problem: null,
        };
      } catch (error) {
        this.walletInfo = { address: null, problem: errorMsg(error) };
      }
    }
    return this.walletInfo;
  }
}
