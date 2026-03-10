import { Injectable } from '@nestjs/common';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { Candle } from '../../market/types';

@Injectable()
export class BotRunnerService {
  constructor(
    private readonly market: BinanceMarketService,
    private readonly strategy: StrategyService,
    private readonly trader: PaperTraderService,
    private readonly portfolio: PortfolioService,
    private readonly logger: BotLoggerService,
  ) {}

  async start() {
    this.logger.logInfo('Запуск торгового бота');
    this.market.connect((candle) => this.handleCandle(candle));
  }

  private handleCandle(candle: Candle) {
    if (!candle.isClosed) return;

    this.logger.logCandle({
      символ: candle.symbol,
      интервал: candle.interval,
      времяЗакрытия: candle.closeTime,
      ценаЗакрытия: candle.close,
      объём: candle.volume,
    });

    const stopAction = this.trader.checkStops(candle.close, candle.closeTime);
    if (stopAction) {
      this.logger.logTrade(this.translateTrade(stopAction));
      this.printPortfolio(candle.close);
      return;
    }

    const result = this.strategy.onNewCandle(
      candle,
      this.portfolio.position?.side ?? null,
    );

    this.logger.logSignal({
      символ: candle.symbol,
      цена: candle.close,
      сигнал: result.signal,
      причина: result.reason,
      индикаторы: result.indicators
        ? {
          ema9: result.indicators.ema9,
          ema21: result.indicators.ema21,
          rsi14: result.indicators.rsi14,
        }
        : null,
    });

    const position = this.portfolio.position;

    if (!position) {
      if (result.signal === 'OPEN_LONG') {
        const trade = this.trader.tryOpenLong(
          candle.close,
          candle.closeTime,
          result.reason,
        );
        if (trade) this.logger.logTrade(this.translateTrade(trade));
      }

      if (result.signal === 'OPEN_SHORT') {
        const trade = this.trader.tryOpenShort(
          candle.close,
          candle.closeTime,
          result.reason,
        );
        if (trade) this.logger.logTrade(this.translateTrade(trade));
      }
    } else {
      if (position.side === 'LONG' && result.signal === 'CLOSE_LONG') {
        const trade = this.trader.tryCloseLong(
          candle.close,
          candle.closeTime,
          result.reason,
        );
        if (trade) this.logger.logTrade(this.translateTrade(trade));
      }

      if (position.side === 'SHORT' && result.signal === 'CLOSE_SHORT') {
        const trade = this.trader.tryCloseShort(
          candle.close,
          candle.closeTime,
          result.reason,
        );
        if (trade) this.logger.logTrade(this.translateTrade(trade));
      }
    }

    this.printPortfolio(candle.close);
  }

  private printPortfolio(currentPrice: number) {
    const position = this.portfolio.position;

    let unrealizedPnl = 0;
    let stopPrice: number | null = null;
    let takePrice: number | null = null;

    if (position) {
      const stopLossPct = Number(process.env.BOT_STOP_LOSS_PCT || 0.012);
      const takeProfitPct = Number(process.env.BOT_TAKE_PROFIT_PCT || 0.02);

      if (position.side === 'LONG') {
        unrealizedPnl =
          (currentPrice - position.entryPrice) * position.quantity;
        stopPrice = position.entryPrice * (1 - stopLossPct);
        takePrice = position.entryPrice * (1 + takeProfitPct);
      } else {
        unrealizedPnl =
          (position.entryPrice - currentPrice) * position.quantity;
        stopPrice = position.entryPrice * (1 + stopLossPct);
        takePrice = position.entryPrice * (1 - takeProfitPct);
      }
    }

    this.logger.logPortfolio({
      баланс: this.portfolio.balance,
      реализованныйPnl: this.portfolio.realizedPnl,
      equity: this.portfolio.getEquity(currentPrice),
      естьОткрытаяПозиция: this.portfolio.hasOpenPosition(),
      текущаяЦена: currentPrice,
      сторонаПозиции: position?.side ?? null,
      ценаВхода: position?.entryPrice ?? null,
      количество: position?.quantity ?? null,
      плавающийPnl: unrealizedPnl,
      стопЦена: stopPrice,
      тейкЦена: takePrice,

      всегоСделок: this.portfolio.totalTrades,
      прибыльныхСделок: this.portfolio.wins,
      убыточныхСделок: this.portfolio.losses,
      winrate: Number(this.portfolio.getWinRate().toFixed(2)),
      cumulativePnl: this.portfolio.realizedPnl,
    });
  }

  private translateTrade(trade: Record<string, unknown>) {
    const actionMap: Record<string, string> = {
      OPEN_LONG: 'ОТКРЫТЬ_ЛОНГ',
      CLOSE_LONG: 'ЗАКРЫТЬ_ЛОНГ',
      OPEN_SHORT: 'ОТКРЫТЬ_ШОРТ',
      CLOSE_SHORT: 'ЗАКРЫТЬ_ШОРТ',
      SKIP: 'ПРОПУСК',
    };

    const sideMap: Record<string, string> = {
      LONG: 'ЛОНГ',
      SHORT: 'ШОРТ',
    };

    return {
      действие:
        typeof trade.action === 'string'
          ? (actionMap[trade.action] ?? trade.action)
          : trade.action,
      сторона:
        typeof trade.side === 'string'
          ? (sideMap[trade.side] ?? trade.side)
          : trade.side,
      ценаВхода: trade.entryPrice,
      ценаВыхода: trade.exitPrice,
      цена: trade.price,
      количество: trade.quantity,
      pnlNet: trade.pnlNet,
      комиссия: trade.fee,
      открытаВ: trade.openedAt,
      закрытаВ: trade.closedAt,
      причина: trade.reason,
    };
  }
}
