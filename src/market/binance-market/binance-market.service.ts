import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { Candle } from '../types';

@Injectable()
export class BinanceMarketService {
  private ws?: WebSocket;
  private reconnectTimeout?: NodeJS.Timeout;
  private isReconnecting = false;
  private currentStream?: string;
  private candleHandler?: (candle: Candle) => void;
  private manualSwitchInProgress = false;

  connect(stream: string, onCandle: (candle: Candle) => void) {
    this.currentStream = stream;
    this.candleHandler = onCandle;

    const url = `wss://stream.testnet.binance.vision/ws/${stream}`;

    console.log(`[РЫНОК] Пытаемся подключиться к ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.isReconnecting = false;
      console.log(`[РЫНОК] Успешное подключение к ${url}`);
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
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

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonText = reason?.toString?.() || 'без причины';

      console.log(
        `[РЫНОК] Соединение закрыто. Код=${code}, причина=${reasonText}`,
      );

      if (this.manualSwitchInProgress) {
        this.manualSwitchInProgress = false;
        return;
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[РЫНОК] Ошибка WebSocket:', error);
    });
  }

  switchSymbol(symbol: string, interval = '1m') {
    const nextStream = `${symbol.toLowerCase()}@kline_${interval}`;

    if (this.currentStream === nextStream) {
      console.log(`[РЫНОК] Символ уже активен: ${symbol}`);
      return;
    }

    console.log(`[РЫНОК] Переключение стрима на ${symbol}`);

    this.currentStream = nextStream;
    this.manualSwitchInProgress = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
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

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    console.log('[РЫНОК] Переподключение через 3 секунды...');

    this.reconnectTimeout = setTimeout(() => {
      this.connect(this.currentStream!, this.candleHandler!);
    }, 3000);
  }
}
