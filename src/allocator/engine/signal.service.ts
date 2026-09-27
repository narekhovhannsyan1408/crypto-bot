import { Injectable } from '@nestjs/common';
import { LocalizedError, msg } from '../../i18n/messages';
import {
  computeTrendSignal,
  getRequiredHistoryDays,
  TrendSignalParams,
} from '../domain/trend-signal';
import { AllocatorMarketDataService } from '../market-data/allocator-market-data.service';
import { SignalSnapshot } from '../session/session.types';

/** Дневные сигналы по всем активам: данные загружаются параллельно. */
@Injectable()
export class SignalService {
  constructor(private readonly marketData: AllocatorMarketDataService) {}

  computeSignals(
    assets: string[],
    params: TrendSignalParams,
    day: number,
    now: number,
  ): Promise<SignalSnapshot[]> {
    const historyDays = getRequiredHistoryDays(params) + 5;
    return Promise.all(
      assets.map(async (symbol) => {
        const closes = await this.marketData.getClosedDailyCloses(
          symbol,
          historyDays,
          now,
        );
        if (closes.at(-1)?.day !== day) {
          throw new LocalizedError(msg('err.candleNotReady', { symbol, day }));
        }
        const signal = computeTrendSignal(
          closes.map((item) => item.close),
          params,
        );
        if (!signal.isReady) {
          throw new LocalizedError(
            msg('err.notEnoughHistory', { symbol, count: closes.length }),
          );
        }
        return {
          symbol,
          day,
          close: signal.close,
          trendScore: signal.trendScore,
          exposure: signal.exposure,
          annualizedVol: signal.annualizedVol,
          smaValues: signal.smaValues,
        };
      }),
    );
  }
}
