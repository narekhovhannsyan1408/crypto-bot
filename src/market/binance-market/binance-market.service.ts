import { Injectable, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import WebSocket from 'ws';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../types';

@Injectable()
export class BinanceMarketService implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private ws?: WebSocket;
  private reconnectTimeout?: NodeJS.Timeout;
  private isReconnecting = false;
  private currentStreams: string[] = [];
  private candleHandler?: (candle: Candle) => void;
  private reconnectAttempts = 0;

  connect(streams: string[] | string, onCandle: (candle: Candle) => void) {
    this.currentStreams = this.normalizeStreams(streams);
    this.candleHandler = onCandle;
    this.openConnection();
  }

  replaceSubscriptions(streams: string[] | string) {
    this.currentStreams = this.normalizeStreams(streams);

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('[РЫНОК] Ошибка при закрытии соединения:', error);
      }
    } else {
      this.openConnection();
    }
  }

  private openConnection() {
    if (!this.candleHandler || this.currentStreams.length === 0) {
      return;
    }

    const url = this.buildWsUrl(this.currentStreams);
    const socket = new WebSocket(url);

    console.log(`[РЫНОК] Пытаемся подключиться к ${url}`);

    this.ws = socket;

    socket.on('open', () => {
      if (socket !== this.ws) {
        return;
      }

      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      console.log(`[РЫНОК] Успешное подключение к ${url}`);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      if (socket !== this.ws) {
        return;
      }

      try {
        const payload = JSON.parse(raw.toString());
        const data = payload.data ?? payload;

        if (!data.k) return;

        const k = data.k;

        const candle: Candle = {
          symbol: data.s,
          interval: k.i,
          openTime: k.t,
          closeTime: k.T,
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
          isClosed: Boolean(k.x),
        };

        this.candleHandler?.(candle);
      } catch (error) {
        console.error('[РЫНОК] Ошибка парсинга сообщения:', error);
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const reasonText = reason?.toString?.() || 'без причины';

      console.log(
        `[РЫНОК] Соединение закрыто. Код=${code}, причина=${reasonText}`,
      );

      if (socket !== this.ws) {
        return;
      }

      this.ws = undefined;
      this.scheduleReconnect();
    });

    socket.on('error', (error) => {
      if (socket !== this.ws) {
        return;
      }

      console.error('[РЫНОК] Ошибка WebSocket:', error);
    });
  }

  async loadHistoricalCandles(symbol: string, interval = '1m', limit = 200) {
    const response = await axios.get(`${this.config.binanceRestBaseUrl}/api/v3/klines`, {
      params: { symbol, interval, limit },
    });

    return (response.data as Array<[number, string, string, string, string, string, number]>)
      .map((item) => ({
        symbol,
        interval,
        openTime: item[0],
        closeTime: item[6],
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5]),
        isClosed: true,
      }))
      .filter((candle) => Number.isFinite(candle.close));
  }

  connectSymbols(symbols: string[], interval = '1m', onCandle: (candle: Candle) => void) {
    const streams = symbols.map((symbol) => `${symbol.toLowerCase()}@kline_${interval}`);
    this.connect(streams, onCandle);
  }

  replaceSymbols(symbols: string[], interval = '1m') {
    const streams = symbols.map((symbol) => `${symbol.toLowerCase()}@kline_${interval}`);
    this.replaceSubscriptions(streams);
  }

  private scheduleReconnect() {
    if (this.isReconnecting) {
      console.log('[РЫНОК] Переподключение уже запланировано');
      return;
    }

    if (this.currentStreams.length === 0 || !this.candleHandler) {
      console.log('[РЫНОК] Нет данных для переподключения');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    const backoffMs = Math.min(3000 * 2 ** (this.reconnectAttempts - 1), 30_000);
    console.log(`[РЫНОК] Переподключение через ${backoffMs} мс...`);

    this.reconnectTimeout = setTimeout(() => {
      if (this.currentStreams.length === 0 || !this.candleHandler) {
        return;
      }

      this.openConnection();
    }, backoffMs);
  }

  private buildWsUrl(streams: string[]) {
    const baseUrl = this.config.binanceWsBaseUrl.replace(/\/$/, '');

    if (streams.length === 1) {
      return `${baseUrl}/${streams[0]}`;
    }

    const rootUrl = baseUrl.replace(/\/ws$/, '');
    return `${rootUrl}/stream?streams=${streams.join('/')}`;
  }

  private normalizeStreams(streams: string[] | string) {
    const normalized = (Array.isArray(streams) ? streams : [streams])
      .map((stream) => stream.trim())
      .filter(Boolean);

    return [...new Set(normalized)];
  }

  onModuleDestroy() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
  }
}
