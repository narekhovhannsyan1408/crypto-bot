import { Injectable } from '@nestjs/common';
import axios from 'axios';

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
};

@Injectable()
export class SymbolScannerService {
  private readonly restBaseUrl =
    process.env.BINANCE_REST_BASE_URL || 'https://testnet.binance.vision';

  async scanBestSymbol(): Promise<ScannedSymbol | null> {
    const [exchangeInfoRes, tickerRes] = await Promise.all([
      axios.get(`${this.restBaseUrl}/api/v3/exchangeInfo`),
      axios.get(`${this.restBaseUrl}/api/v3/ticker/24hr`),
    ]);

    const allowedSymbols = (process.env.BOT_ALLOWED_SYMBOLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const minQuoteVolume = Number(process.env.BOT_MIN_QUOTE_VOLUME || 1000000);

    const tradableSymbols = new Map<string, ExchangeInfoSymbol>();

    for (const symbol of exchangeInfoRes.data.symbols as ExchangeInfoSymbol[]) {
      if (symbol.quoteAsset !== 'USDT') continue;
      if (symbol.status !== 'TRADING') continue;

      if (allowedSymbols.length > 0 && !allowedSymbols.includes(symbol.symbol)) {
        continue;
      }

      tradableSymbols.set(symbol.symbol, symbol);
    }

    const candidates: ScannedSymbol[] = [];

    for (const item of tickerRes.data as Ticker24h[]) {
      if (!tradableSymbols.has(item.symbol)) continue;

      const priceChangePercent = Number(item.priceChangePercent);
      const quoteVolume = Number(item.quoteVolume);

      if (!Number.isFinite(priceChangePercent)) continue;
      if (!Number.isFinite(quoteVolume)) continue;
      if (quoteVolume < minQuoteVolume) continue;

      // Скоринг:
      // 1) берем абсолютную амплитуду движения
      // 2) добавляем бонус за ликвидность
      const volatilityScore = Math.abs(priceChangePercent);
      const liquidityScore = Math.log10(Math.max(quoteVolume, 1));
      const score = volatilityScore * 0.7 + liquidityScore * 0.3;

      candidates.push({
        symbol: item.symbol,
        score,
        priceChangePercent,
        quoteVolume,
      });
    }

    candidates.sort((a, b) => b.score - a.score);

    return candidates[0] ?? null;
  }

  async scanTopSymbols(limit = 5): Promise<ScannedSymbol[]> {
    const [exchangeInfoRes, tickerRes] = await Promise.all([
      axios.get(`${this.restBaseUrl}/api/v3/exchangeInfo`),
      axios.get(`${this.restBaseUrl}/api/v3/ticker/24hr`),
    ]);

    const allowedSymbols = (process.env.BOT_ALLOWED_SYMBOLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const minQuoteVolume = Number(process.env.BOT_MIN_QUOTE_VOLUME || 1000000);

    const tradableSymbols = new Map<string, ExchangeInfoSymbol>();

    for (const symbol of exchangeInfoRes.data.symbols as ExchangeInfoSymbol[]) {
      if (symbol.quoteAsset !== 'USDT') continue;
      if (symbol.status !== 'TRADING') continue;

      if (allowedSymbols.length > 0 && !allowedSymbols.includes(symbol.symbol)) {
        continue;
      }

      tradableSymbols.set(symbol.symbol, symbol);
    }

    const candidates: ScannedSymbol[] = [];

    for (const item of tickerRes.data as Ticker24h[]) {
      if (!tradableSymbols.has(item.symbol)) continue;

      const priceChangePercent = Number(item.priceChangePercent);
      const quoteVolume = Number(item.quoteVolume);

      if (!Number.isFinite(priceChangePercent)) continue;
      if (!Number.isFinite(quoteVolume)) continue;
      if (quoteVolume < minQuoteVolume) continue;

      const volatilityScore = Math.abs(priceChangePercent);
      const liquidityScore = Math.log10(Math.max(quoteVolume, 1));
      const score = volatilityScore * 0.7 + liquidityScore * 0.3;

      candidates.push({
        symbol: item.symbol,
        score,
        priceChangePercent,
        quoteVolume,
      });
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
