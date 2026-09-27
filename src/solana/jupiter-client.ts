import { Injectable } from '@nestjs/common';
import axios, {
  AxiosError,
  AxiosInstance,
  InternalAxiosRequestConfig,
} from 'axios';
import { getBotConfig } from '../config/bot-config';
import { LocalizedError, msg } from '../i18n/messages';
import { AppLogger } from '../observability/app-logger';

type TimedConfig = InternalAxiosRequestConfig & { startedAt?: number };
const REQUEST_TIMEOUT_MS = 15_000;

export type JupiterQuote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    percent: number;
    swapInfo: { label?: string; ammKey: string };
  }>;
  // Остальные поля нужны Jupiter при сборке транзакции — передаём ответ как есть
  [field: string]: unknown;
};

export type JupiterSwap = {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
};

export const routeLabel = (quote: JupiterQuote) =>
  [
    ...new Set(
      quote.routePlan.map(
        (step) => step.swapInfo.label ?? step.swapInfo.ammKey,
      ),
    ),
  ].join(' → ');

/**
 * Jupiter — агрегатор ликвидности Solana: цены токенов, котировки и готовые
 * транзакции свопа по лучшему маршруту через все DEX сети.
 */
@Injectable()
export class JupiterClient {
  private readonly settings = getBotConfig().solana;
  private readonly http: AxiosInstance = axios.create({
    baseURL: this.settings.jupiterApiUrl,
    timeout: REQUEST_TIMEOUT_MS,
    headers: this.settings.jupiterApiKey
      ? { 'x-api-key': this.settings.jupiterApiKey }
      : undefined,
  });

  constructor(private readonly journal: AppLogger) {
    this.http.interceptors.request.use((config: TimedConfig) => {
      config.startedAt = performance.now();
      return config;
    });
    this.http.interceptors.response.use(
      (response) => {
        const config = response.config as TimedConfig;
        this.journal.log(
          'trace',
          'solana.jupiter.http',
          `${config.url} → ${response.status}`,
          {
            durationMs:
              performance.now() - (config.startedAt ?? performance.now()),
            data: { url: config.url, status: response.status },
          },
        );
        return response;
      },
      (error: AxiosError) => {
        const config = (error.config ?? {}) as TimedConfig;
        this.journal.log(
          'warn',
          'solana.jupiter.failed',
          `Запрос к Jupiter не удался: ${config.url}`,
          {
            durationMs: config.startedAt
              ? performance.now() - config.startedAt
              : undefined,
            data: { url: config.url, params: config.params as unknown },
            err: error,
          },
        );
        return Promise.reject(error);
      },
    );
  }

  /** Цены в долларах по адресам токенов. */
  async getUsdPrices(mints: string[]) {
    const response = await this.http.get<
      Record<string, { usdPrice?: number } | null>
    >('/price/v3', { params: { ids: [...new Set(mints)].join(',') } });
    const prices: Record<string, number> = {};
    for (const mint of mints) {
      const price = Number(response.data[mint]?.usdPrice);
      if (!Number.isFinite(price) || price <= 0) {
        throw new LocalizedError(msg('err.jupiter.noPrice', { mint }));
      }
      prices[mint] = price;
    }
    return prices;
  }

  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }) {
    const response = await this.http.get<JupiterQuote>('/swap/v1/quote', {
      params: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
        slippageBps: params.slippageBps,
      },
    });
    const quote = response.data;
    if (!(BigInt(quote.outAmount ?? 0) > 0n)) {
      throw new LocalizedError(msg('err.jupiter.noRoute'));
    }
    return quote;
  }

  /** Готовая к подписи транзакция свопа (base64, VersionedTransaction). */
  async buildSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    maxPriorityFeeLamports: number,
  ) {
    const response = await this.http.post<JupiterSwap>('/swap/v1/swap', {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: maxPriorityFeeLamports,
          priorityLevel: 'high',
        },
      },
    });
    if (!response.data?.swapTransaction) {
      throw new LocalizedError(msg('err.jupiter.noTx'));
    }
    return response.data;
  }
}
