import { Injectable } from '@nestjs/common';

@Injectable()
export class BotLoggerService {
  logCandle(payload: unknown) {
    console.log('[СВЕЧА]', JSON.stringify(payload));
  }

  logSignal(payload: unknown) {
    console.log('[СИГНАЛ]', JSON.stringify(payload));
  }

  logTrade(payload: unknown) {
    console.log('[СДЕЛКА]', JSON.stringify(payload));
  }

  logPortfolio(payload: unknown) {
    console.log('[ПОРТФЕЛЬ]', JSON.stringify(payload));
  }

  logInfo(message: string, payload?: unknown) {
    if (payload !== undefined) {
      console.log('[ИНФО]', message, JSON.stringify(payload));
      return;
    }

    console.log('[ИНФО]', message);
  }

  logError(message: string, payload?: unknown) {
    if (payload !== undefined) {
      console.error('[ОШИБКА]', message, JSON.stringify(payload));
      return;
    }

    console.error('[ОШИБКА]', message);
  }
}
