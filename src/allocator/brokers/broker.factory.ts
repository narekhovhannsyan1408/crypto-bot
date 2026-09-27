import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { ExecutionMode } from '../../trader/execution.types';
import { AllocatorMarketDataService } from '../market-data/allocator-market-data.service';
import { AllocatorBroker } from './allocator-broker';
import { BinanceSpotAllocatorBroker } from './binance-spot-broker';
import { PaperAllocatorBroker } from './paper-broker';

const PAPER_DEFAULT_SLIPPAGE_PCT = 0.0005;

/**
 * Создаёт брокера под режим и переиспользует его: подключение к Binance
 * (загрузка рынков ccxt) дорогое, его не нужно повторять на каждый запрос.
 */
@Injectable()
export class BrokerFactory {
  private readonly config = getBotConfig();
  private readonly brokers = new Map<ExecutionMode, AllocatorBroker>();

  constructor(private readonly marketData: AllocatorMarketDataService) {}

  get(mode: ExecutionMode): AllocatorBroker {
    const existing = this.brokers.get(mode);
    if (existing) {
      return existing;
    }

    const broker =
      mode === 'paper'
        ? new PaperAllocatorBroker(
            this.marketData,
            this.config.feePct,
            this.config.slippagePct || PAPER_DEFAULT_SLIPPAGE_PCT,
          )
        : new BinanceSpotAllocatorBroker(mode, this.config);
    this.brokers.set(mode, broker);
    return broker;
  }
}
