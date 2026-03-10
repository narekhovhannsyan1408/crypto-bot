import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { Candle } from '../types';

@Injectable()
export class BinanceMarketService {
  private ws?: WebSocket;

  connect(onCandle: (candle: Candle) => void) {
    const stream = process.env.BOT_STREAM || 'btcusdt@kline_1m';
    const url = `wss://stream.testnet.binance.vision/ws/${stream}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`[РЫНОК] Подключено к ${url}`);
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

    this.ws.on('close', () => {
      console.log('[РЫНОК] Соединение закрыто. Переподключение через 3 секунды...');
      setTimeout(() => this.connect(onCandle), 3000);
    });

    this.ws.on('error', (error) => {
      console.error('[РЫНОК] Ошибка WebSocket:', error);
    });
  }
}
