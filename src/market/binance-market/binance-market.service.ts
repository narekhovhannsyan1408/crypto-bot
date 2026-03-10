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
  private currentStream?: string;
  private candleHandler?: (candle: Candle) => void;
  private manualSwitchTarget?: string;
  private reconnectAttempts = 0;

  connect(stream: string, onCandle: (candle: Candle) => void) {
    this.currentStream = stream;
    this.candleHandler = onCandle;

    const url = `${this.config.binanceWsBaseUrl.replace(/\/$/, '')}/${stream}`;
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
        const data = JSON.parse(raw.toString());

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

        onCandle(candle);
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

      if (this.manualSwitchTarget === stream) {
        this.manualSwitchTarget = undefined;
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

  switchSymbol(symbol: string, interval = '1m') {
    const nextStream = `${symbol.toLowerCase()}@kline_${interval}`;

    if (this.currentStream === nextStream) {
      console.log(`[РЫНОК] Символ уже активен: ${symbol}`);
      return;
    }

    console.log(`[РЫНОК] Переключение стрима на ${symbol}`);

    this.currentStream = nextStream;
    this.manualSwitchTarget = nextStream;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('[РЫНОК] Ошибка при закрытии старого соединения:', error);
      }
    }

    if (this.candleHandler) {
      this.connect(nextStream, this.candleHandler);
    }
  }

  private scheduleReconnect() {
    if (this.isReconnecting) {
      console.log('[РЫНОК] Переподключение уже запланировано');
      return;
    }

    if (!this.currentStream || !this.candleHandler) {
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
      if (!this.currentStream || !this.candleHandler) {
        return;
      }

      this.connect(this.currentStream, this.candleHandler);
    }, backoffMs);
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
