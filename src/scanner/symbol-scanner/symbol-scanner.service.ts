import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getBotConfig } from '../../config/bot-config';

type ExchangeInfoSymbol = {
  symbol: string;
  status: string;
  quoteAsset: string;
};

type Ticker24h = {
  symbol: string;
  priceChangePercent: string;
  quoteVolume: string;
};

export type ScannedSymbol = {
  symbol: string;
  score: number;
  priceChangePercent: number;
  quoteVolume: number;
  recentMovePct: number;
  intradayVolatilityPct: number;
  volumeAcceleration: number;
};

@Injectable()
export class SymbolScannerService {
  private readonly config = getBotConfig();
  private tradableSymbolsCache: {
    expiresAt: number;
    symbols: Set<string>;
  } | null = null;

  async scanBestSymbol(): Promise<ScannedSymbol | null> {
    const candidates = await this.scanTopSymbols(1);
    return candidates[0] ?? null;
  }

  async scanTopSymbols(limit = 5): Promise<ScannedSymbol[]> {
    const tradableSymbols = await this.loadTradableSymbols();
    const tickerRes = await axios.get(
      `${this.config.binanceRestBaseUrl}/api/v3/ticker/24hr`,
    );

    const prefiltered = (tickerRes.data as Ticker24h[])
      .map((item) => this.toBaseCandidate(item, tradableSymbols))
      .filter((item): item is ScannedSymbol => item !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.scannerShortlistSize);

    const enriched = await Promise.all(
      prefiltered.map(async (candidate) => this.enrichCandidate(candidate)),
    );

    return enriched.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async loadTradableSymbols() {
    const now = Date.now();

    if (
      this.tradableSymbolsCache &&
      this.tradableSymbolsCache.expiresAt > now
    ) {
      return this.tradableSymbolsCache.symbols;
    }

    const exchangeInfoRes = await axios.get(
      `${this.config.binanceRestBaseUrl}/api/v3/exchangeInfo`,
    );

    const tradableSymbols = new Set<string>();

    for (const symbol of exchangeInfoRes.data.symbols as ExchangeInfoSymbol[]) {
      if (symbol.quoteAsset !== 'USDT') continue;
      if (symbol.status !== 'TRADING') continue;

      if (
        this.config.allowedSymbols.length > 0 &&
        !this.config.allowedSymbols.includes(symbol.symbol)
      ) {
        continue;
      }

      tradableSymbols.add(symbol.symbol);
    }

    this.tradableSymbolsCache = {
      expiresAt: now + 6 * 60 * 60 * 1000,
      symbols: tradableSymbols,
    };

    return tradableSymbols;
  }

  private toBaseCandidate(item: Ticker24h, tradableSymbols: Set<string>) {
    if (!tradableSymbols.has(item.symbol)) {
      return null;
    }

    const priceChangePercent = Number(item.priceChangePercent);
    const quoteVolume = Number(item.quoteVolume);

    if (!Number.isFinite(priceChangePercent) || !Number.isFinite(quoteVolume)) {
      return null;
    }

    if (quoteVolume < this.config.scannerMinQuoteVolume) {
      return null;
    }

    const volatilityScore = Math.abs(priceChangePercent);
    const liquidityScore = Math.log10(Math.max(quoteVolume, 1));
    const score = volatilityScore * 0.5 + liquidityScore * 0.5;

    return {
      symbol: item.symbol,
      score,
      priceChangePercent,
      quoteVolume,
      recentMovePct: 0,
      intradayVolatilityPct: 0,
      volumeAcceleration: 0,
    };
  }

  private async enrichCandidate(
    candidate: ScannedSymbol,
  ): Promise<ScannedSymbol> {
    try {
      const klinesRes = await axios.get(
        `${this.config.binanceRestBaseUrl}/api/v3/klines`,
        {
          params: {
            symbol: candidate.symbol,
            interval: this.config.interval,
            limit: this.config.scannerKlineLookback,
          },
        },
      );

      const klines = klinesRes.data as Array<
        [number, string, string, string, string, string]
      >;

      const closes = klines.map((item) => Number(item[4]));
      const volumes = klines.map((item) => Number(item[5]));

      if (closes.length < 5 || volumes.length < 5) {
        return candidate;
      }

      const firstClose = closes[0];
      const lastClose = closes.at(-1) ?? firstClose;
      const recentMovePct =
        firstClose > 0 ? (lastClose - firstClose) / firstClose : 0;

      const returns = closes.slice(1).map((close, index) => {
        const prev = closes[index];
        return prev > 0 ? (close - prev) / prev : 0;
      });

      const meanReturn =
        returns.reduce((sum, value) => sum + value, 0) /
        Math.max(returns.length, 1);
      const variance =
        returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) /
        Math.max(returns.length, 1);
      const intradayVolatilityPct = Math.sqrt(variance);

      const recentVolume = this.average(volumes.slice(-5));
      const baselineVolume = this.average(volumes.slice(0, -5));
      const volumeAcceleration =
        baselineVolume > 0 ? recentVolume / baselineVolume - 1 : 0;

      const efficiency = this.computeEfficiency(closes);
      const enrichedScore =
        Math.abs(candidate.priceChangePercent) * 0.2 +
        Math.log10(Math.max(candidate.quoteVolume, 1)) * 0.15 +
        Math.abs(recentMovePct) * 100 * 0.25 +
        intradayVolatilityPct * 100 * 0.15 +
        volumeAcceleration * 10 * 0.1 +
        efficiency * 0.15;

      return {
        ...candidate,
        score: enrichedScore,
        recentMovePct,
        intradayVolatilityPct,
        volumeAcceleration,
      };
    } catch {
      return candidate;
    }
  }

  private computeEfficiency(closes: number[]) {
    if (closes.length < 2) {
      return 0;
    }

    const netMove = Math.abs(closes.at(-1)! - closes[0]);
    let pathLength = 0;

    for (let index = 1; index < closes.length; index += 1) {
      pathLength += Math.abs(closes[index] - closes[index - 1]);
    }

    if (pathLength === 0) {
      return 0;
    }

    return netMove / pathLength;
  }

  private average(values: number[]) {
    if (values.length === 0) {
      return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}
