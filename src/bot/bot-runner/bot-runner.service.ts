import { Injectable } from '@nestjs/common';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { Candle } from '../../market/types';
import {
  ScannedSymbol,
  SymbolScannerService,
} from '../../scanner/symbol-scanner/symbol-scanner.service';

@Injectable()
export class BotRunnerService {
  private activeSymbol = process.env.BOT_SYMBOL || 'BTCUSDT';
  private activeInterval = '1m';
  private candlesWithoutPosition = 0;
  private lastScanTop: ScannedSymbol[] = [];

  constructor(
    private readonly market: BinanceMarketService,
    private readonly strategy: StrategyService,
    private readonly trader: PaperTraderService,
    private readonly portfolio: PortfolioService,
    private readonly logger: BotLoggerService,
    private readonly scanner: SymbolScannerService,
  ) {}

  async start() {
    this.logger.logInfo('Запуск торгового бота');

    const useScanner = process.env.BOT_USE_SCANNER === 'true';

    if (useScanner) {
      await this.selectInitialSymbol();
      this.startScannerLoop();
    }

    const stream = `${this.activeSymbol.toLowerCase()}@kline_${this.activeInterval}`;
    this.market.connect(stream, (candle) => this.handleCandle(candle));
  }

  private async selectInitialSymbol() {
    try {
      const best = await this.scanner.scanBestSymbol();
      if (best) {
        this.activeSymbol = best.symbol;
        this.logger.logInfo('Выбрана стартовая пара', best);
      }
    } catch (error) {
      this.logger.logError('Не удалось выбрать стартовую пару', error);
    }
  }

  private startScannerLoop() {
    const scanIntervalMs = Number(process.env.BOT_SCAN_INTERVAL_MS || 60000);

    setInterval(async () => {
      try {
        const top = await this.scanner.scanTopSymbols(5);
        this.lastScanTop = top;

        this.logger.logInfo(
          'Топ пар по сканеру',
          top.map((item) => ({
            символ: item.symbol,
            score: Number(item.score.toFixed(4)),
            изменение24ч: Number(item.priceChangePercent.toFixed(2)),
            quoteVolume: Number(item.quoteVolume.toFixed(2)),
          })),
        );

        if (this.portfolio.hasOpenPosition()) {
          return;
        }

        const best = top[0];
        if (!best) return;

        const current = top.find((x) => x.symbol === this.activeSymbol);

        const currentScore = current?.score ?? 0;
        const bestScore = best.score;

        const shouldSwitch =
          best.symbol !== this.activeSymbol &&
          (this.candlesWithoutPosition >=
            Number(process.env.BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH || 8) ||
            bestScore > currentScore * 1.15);

        if (shouldSwitch) {
          this.logger.logInfo('Переключаемся на более активную пару', {
            стараяПара: this.activeSymbol,
            новаяПара: best.symbol,
            scoreТекущей: Number(currentScore.toFixed(4)),
            scoreНовой: Number(bestScore.toFixed(4)),
          });

          this.activeSymbol = best.symbol;
          this.candlesWithoutPosition = 0;
          this.market.switchSymbol(this.activeSymbol, this.activeInterval);
        }
      } catch (error) {
        this.logger.logError('Ошибка сканера', error);
      }
    }, scanIntervalMs);
  }

  private handleCandle(candle: Candle) {
    if (!candle.isClosed) return;
    if (candle.symbol !== this.activeSymbol) return;

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
      this.candlesWithoutPosition = 0;
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
          ema9: Number(result.indicators.ema9.toFixed(6)),
          ema21: Number(result.indicators.ema21.toFixed(6)),
          rsi14: Number(result.indicators.rsi14.toFixed(2)),
        }
        : null,
    });

    const position = this.portfolio.position;
    let tradeHappened = false;

    if (!position) {
      this.candlesWithoutPosition += 1;

      if (result.signal === 'OPEN_LONG') {
        const trade = this.trader.tryOpenLong(
          candle.close,
          candle.closeTime,
          result.reason,
        );
        if (trade) {
          this.logger.logTrade(this.translateTrade(trade));
          this.candlesWithoutPosition = 0;
          tradeHappened = true;
        }
      }

      if (result.signal === 'OPEN_SHORT') {
        const trade = this.trader.tryOpenShort(
          candle.close,
          candle.closeTime,
          result.reason,
        );
        if (trade) {
          this.logger.logTrade(this.translateTrade(trade));
          this.candlesWithoutPosition = 0;
          tradeHappened = true;
        }
      }
    } else {
      this.candlesWithoutPosition = 0;

      if (position.side === 'LONG') {
        if (result.signal === 'CLOSE_LONG') {
          const trade = this.trader.tryCloseLong(
            candle.close,
            candle.closeTime,
            result.reason,
          );
          if (trade) {
            this.logger.logTrade(this.translateTrade(trade));
            tradeHappened = true;
          }
        }

        if (result.signal === 'REVERSE_TO_SHORT') {
          const closeTrade = this.trader.tryCloseLong(
            candle.close,
            candle.closeTime,
            'Переворот: закрываем лонг перед открытием шорта',
          );
          if (closeTrade) this.logger.logTrade(this.translateTrade(closeTrade));

          const openTrade = this.trader.tryOpenShort(
            candle.close,
            candle.closeTime,
            result.reason,
          );
          if (openTrade) this.logger.logTrade(this.translateTrade(openTrade));

          tradeHappened = true;
        }
      }

      if (position.side === 'SHORT') {
        if (result.signal === 'CLOSE_SHORT') {
          const trade = this.trader.tryCloseShort(
            candle.close,
            candle.closeTime,
            result.reason,
          );
          if (trade) {
            this.logger.logTrade(this.translateTrade(trade));
            tradeHappened = true;
          }
        }

        if (result.signal === 'REVERSE_TO_LONG') {
          const closeTrade = this.trader.tryCloseShort(
            candle.close,
            candle.closeTime,
            'Переворот: закрываем шорт перед открытием лонга',
          );
          if (closeTrade) this.logger.logTrade(this.translateTrade(closeTrade));

          const openTrade = this.trader.tryOpenLong(
            candle.close,
            candle.closeTime,
            result.reason,
          );
          if (openTrade) this.logger.logTrade(this.translateTrade(openTrade));

          tradeHappened = true;
        }
      }
    }

    if (!tradeHappened && !this.portfolio.hasOpenPosition()) {
      this.trySwitchByWeakness();
    }

    this.printPortfolio(candle.close);
  }

  private trySwitchByWeakness() {
    if (this.lastScanTop.length === 0) return;

    const best = this.lastScanTop[0];
    if (!best) return;
    if (best.symbol === this.activeSymbol) return;
    if (this.portfolio.hasOpenPosition()) return;

    const threshold = Number(
      process.env.BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH || 8,
    );

    if (this.candlesWithoutPosition < threshold) return;

    this.logger.logInfo('Текущая пара ослабла, переключаемся', {
      текущаяПара: this.activeSymbol,
      новаяПара: best.symbol,
      свечейБезПозиции: this.candlesWithoutPosition,
    });

    this.activeSymbol = best.symbol;
    this.candlesWithoutPosition = 0;
    this.market.switchSymbol(this.activeSymbol, this.activeInterval);
  }

  private printPortfolio(currentPrice: number) {
    const position = this.portfolio.position;

    let unrealizedPnl = 0;
    let stopPrice: number | null = null;
    let takePrice: number | null = null;

    const feePct = Number(process.env.BOT_FEE_PCT || 0.001);

    if (position) {
      const stopLossPct = Number(process.env.BOT_STOP_LOSS_PCT || 0.012);
      const takeProfitPct = Number(process.env.BOT_TAKE_PROFIT_PCT || 0.02);

      const exitFee = currentPrice * position.quantity * feePct;

      if (position.side === 'LONG') {
        const gross = (currentPrice - position.entryPrice) * position.quantity;
        unrealizedPnl = gross - exitFee;
        stopPrice = position.entryPrice * (1 - stopLossPct);
        takePrice = position.entryPrice * (1 + takeProfitPct);
      } else {
        const gross = (position.entryPrice - currentPrice) * position.quantity;
        unrealizedPnl = gross - exitFee;
        stopPrice = position.entryPrice * (1 + stopLossPct);
        takePrice = position.entryPrice * (1 - takeProfitPct);
      }
    }

    const equity = this.portfolio.balance + unrealizedPnl;

    this.logger.logPortfolio({
      активнаяПара: this.activeSymbol,
      баланс: Number(this.portfolio.balance.toFixed(6)),
      реализованныйPnl: Number(this.portfolio.realizedPnl.toFixed(6)),
      cumulativePnl: Number(this.portfolio.realizedPnl.toFixed(6)),
      equity: Number(equity.toFixed(6)),
      естьОткрытаяПозиция: this.portfolio.hasOpenPosition(),
      текущаяЦена: Number(currentPrice.toFixed(2)),
      сторонаПозиции:
        position?.side === 'LONG'
          ? 'ЛОНГ'
          : position?.side === 'SHORT'
            ? 'ШОРТ'
            : null,
      ценаВхода: position ? Number(position.entryPrice.toFixed(2)) : null,
      количество: position ? Number(position.quantity.toFixed(8)) : null,
      плавающийPnl: Number(unrealizedPnl.toFixed(6)),
      стопЦена: stopPrice ? Number(stopPrice.toFixed(2)) : null,
      тейкЦена: takePrice ? Number(takePrice.toFixed(2)) : null,
      всегоСделок: this.portfolio.totalTrades,
      прибыльныхСделок: this.portfolio.wins,
      убыточныхСделок: this.portfolio.losses,
      winrate: Number(this.portfolio.getWinRate().toFixed(2)),
      свечейБезПозиции: this.candlesWithoutPosition,
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
      ценаВхода:
        typeof trade.entryPrice === 'number'
          ? Number(trade.entryPrice.toFixed(2))
          : trade.entryPrice,
      ценаВыхода:
        typeof trade.exitPrice === 'number'
          ? Number(trade.exitPrice.toFixed(2))
          : trade.exitPrice,
      цена:
        typeof trade.price === 'number'
          ? Number(trade.price.toFixed(2))
          : trade.price,
      количество:
        typeof trade.quantity === 'number'
          ? Number(trade.quantity.toFixed(8))
          : trade.quantity,
      pnlNet:
        typeof trade.pnlNet === 'number'
          ? Number(trade.pnlNet.toFixed(6))
          : trade.pnlNet,
      комиссия:
        typeof trade.fee === 'number'
          ? Number(trade.fee.toFixed(6))
          : trade.fee,
      открытаВ: trade.openedAt,
      закрытаВ: trade.closedAt,
      причина: trade.reason,
    };
  }
}
