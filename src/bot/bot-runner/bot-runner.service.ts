import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { Candle } from '../../market/types';
import { ExecutedTrade, ExecutionResult } from '../../trader/types';
import {
  ScannedSymbol,
  SymbolScannerService,
} from '../../scanner/symbol-scanner/symbol-scanner.service';

@Injectable()
export class BotRunnerService implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private activeSymbol = this.config.symbol;
  private activeInterval = this.config.interval;
  private candlesWithoutPosition = 0;
  private lastScanTop: ScannedSymbol[] = [];
  private scannerInterval?: NodeJS.Timeout;
  private scannerInProgress = false;

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

    if (this.config.useScanner) {
      await this.selectInitialSymbol();
      this.startScannerLoop();
    }

    await this.preloadSymbolHistory(this.activeSymbol);

    const stream = `${this.activeSymbol.toLowerCase()}@kline_${this.activeInterval}`;
    this.market.connect(stream, (candle) => {
      void this.handleCandle(candle);
    });
  }

  private async selectInitialSymbol() {
    try {
      const best = await this.scanner.scanBestSymbol();
      if (best) {
        this.activeSymbol = best.symbol;
        this.logger.logInfo('Выбрана стартовая пара', this.translateScannedSymbol(best));
      }
    } catch (error) {
      this.logger.logError('Не удалось выбрать стартовую пару', error);
    }
  }

  private startScannerLoop() {
    if (this.scannerInterval) {
      clearInterval(this.scannerInterval);
    }

    this.scannerInterval = setInterval(() => {
      void this.runScannerIteration();
    }, this.config.scanIntervalMs);
  }

  private async runScannerIteration() {
    if (this.scannerInProgress) {
      this.logger.logInfo('Пропускаем цикл сканера: предыдущий ещё выполняется');
      return;
    }

    this.scannerInProgress = true;

    try {
      const top = await this.scanner.scanTopSymbols(5);
      this.lastScanTop = top;

      this.logger.logInfo(
        'Топ пар по сканеру',
        top.map((item) => this.translateScannedSymbol(item)),
      );

      if (this.portfolio.hasOpenPosition()) {
        return;
      }

      const best = top[0];
      if (!best) {
        return;
      }

      const current = top.find((item) => item.symbol === this.activeSymbol);
      const currentScore = current?.score ?? 0;
      const bestScore = best.score;

      const shouldSwitch =
        best.symbol !== this.activeSymbol &&
        (this.candlesWithoutPosition >=
          this.config.maxCandlesWithoutPositionBeforeSwitch ||
          bestScore > currentScore * 1.15);

      if (shouldSwitch) {
        await this.activateSymbol(best.symbol, 'Переключаемся на более активную пару');
      }
    } catch (error) {
      this.logger.logError('Ошибка сканера', error);
    } finally {
      this.scannerInProgress = false;
    }
  }

  private async handleCandle(candle: Candle) {
    try {
      if (!candle.isClosed) return;
      if (candle.symbol !== this.activeSymbol) return;

      this.logger.logCandle({
        символ: candle.symbol,
        интервал: candle.interval,
        времяЗакрытия: candle.closeTime,
        ценаЗакрытия: candle.close,
        объём: candle.volume,
      });

      const stopAction = this.trader.checkStops(candle);
      if (stopAction?.status === 'EXECUTED') {
        this.handleExecutionResult(stopAction);
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
        сигнал: this.translateSignal(result.signal),
        причина: result.reason,
        индикаторы: result.indicators
          ? {
              быстраяСкользящаяСредняя: Number(
                result.indicators.emaFast.toFixed(6),
              ),
              медленнаяСкользящаяСредняя: Number(
                result.indicators.emaSlow.toFixed(6),
              ),
              индексОтносительнойСилы: Number(result.indicators.rsi.toFixed(2)),
              среднийИстинныйДиапазонВПроцентах: Number(
                (result.indicators.atrPct * 100).toFixed(3),
              ),
              силаТрендаВПроцентах: Number(
                (result.indicators.trendStrengthPct * 100).toFixed(3),
              ),
            }
          : null,
      });

      const position = this.portfolio.position;
      let tradeHappened = false;

      if (!position) {
        this.candlesWithoutPosition += 1;

        if (result.signal === 'OPEN_LONG') {
          tradeHappened = this.handleExecutionResult(
            this.trader.tryOpenLong(
              candle.symbol,
              candle.interval,
              candle.close,
              candle.closeTime,
              result.reason,
            ),
          );
        }

        if (result.signal === 'OPEN_SHORT') {
          tradeHappened = this.handleExecutionResult(
            this.trader.tryOpenShort(
              candle.symbol,
              candle.interval,
              candle.close,
              candle.closeTime,
              result.reason,
            ),
          );
        }
      } else {
        this.candlesWithoutPosition = 0;

        if (position.side === 'LONG') {
          if (result.signal === 'CLOSE_LONG') {
            tradeHappened = this.handleExecutionResult(
              this.trader.tryCloseLong(candle.close, candle.closeTime, result.reason),
            );
          }

          if (result.signal === 'REVERSE_TO_SHORT') {
            const closeExecuted = this.handleExecutionResult(
              this.trader.tryCloseLong(
                candle.close,
                candle.closeTime,
                'Переворот: закрываем лонг перед открытием шорта',
              ),
            );
            const openExecuted = this.handleExecutionResult(
              this.trader.tryOpenShort(
                candle.symbol,
                candle.interval,
                candle.close,
                candle.closeTime,
                result.reason,
              ),
            );
            tradeHappened = closeExecuted || openExecuted;
          }
        }

        if (position.side === 'SHORT') {
          if (result.signal === 'CLOSE_SHORT') {
            tradeHappened = this.handleExecutionResult(
              this.trader.tryCloseShort(candle.close, candle.closeTime, result.reason),
            );
          }

          if (result.signal === 'REVERSE_TO_LONG') {
            const closeExecuted = this.handleExecutionResult(
              this.trader.tryCloseShort(
                candle.close,
                candle.closeTime,
                'Переворот: закрываем шорт перед открытием лонга',
              ),
            );
            const openExecuted = this.handleExecutionResult(
              this.trader.tryOpenLong(
                candle.symbol,
                candle.interval,
                candle.close,
                candle.closeTime,
                result.reason,
              ),
            );
            tradeHappened = closeExecuted || openExecuted;
          }
        }
      }

      if (!tradeHappened && !this.portfolio.hasOpenPosition()) {
        await this.trySwitchByWeakness();
      }

      this.printPortfolio(candle.close);
    } catch (error) {
      this.logger.logError('Ошибка обработки свечи', error);
    }
  }

  private async trySwitchByWeakness() {
    if (this.lastScanTop.length === 0) return;

    const best = this.lastScanTop[0];
    if (!best) return;
    if (best.symbol === this.activeSymbol) return;
    if (this.portfolio.hasOpenPosition()) return;

    if (
      this.candlesWithoutPosition <
      this.config.maxCandlesWithoutPositionBeforeSwitch
    ) {
      return;
    }

    await this.activateSymbol(best.symbol, 'Текущая пара ослабла, переключаемся');
  }

  private handleExecutionResult(execution: ExecutionResult | null) {
    if (!execution) {
      return false;
    }

    if (execution.status === 'REJECTED') {
      this.logger.logInfo('Сделка отклонена', {
        действие: this.translateAction(execution.action),
        символ: execution.symbol ?? this.activeSymbol,
        причина: execution.reason,
      });
      return false;
    }

    this.logger.logTrade(this.translateTrade(execution.trade));

    if (
      execution.trade.action === 'CLOSE_LONG' ||
      execution.trade.action === 'CLOSE_SHORT'
    ) {
      this.strategy.registerTradeClosed(
        execution.trade.symbol,
        execution.trade.interval,
      );
    }

    this.candlesWithoutPosition = 0;
    return true;
  }

  private async activateSymbol(symbol: string, message: string) {
    if (symbol === this.activeSymbol) {
      return;
    }

    const previousSymbol = this.activeSymbol;

    await this.preloadSymbolHistory(symbol);

    this.activeSymbol = symbol;
    this.candlesWithoutPosition = 0;

    this.logger.logInfo(message, {
      стараяПара: previousSymbol,
      новаяПара: symbol,
    });

    this.market.switchSymbol(symbol, this.activeInterval);
  }

  private async preloadSymbolHistory(symbol: string) {
    try {
      const candles = await this.market.loadHistoricalCandles(
        symbol,
        this.activeInterval,
        250,
      );
      this.strategy.seedHistory(symbol, this.activeInterval, candles);
      this.logger.logInfo('Прогрели историю по символу', {
        символ: symbol,
        свечей: candles.length,
      });
    } catch (error) {
      this.logger.logError('Не удалось прогреть историю по символу', {
        символ: symbol,
        error,
      });
      this.strategy.resetSymbol(symbol, this.activeInterval);
    }
  }

  private printPortfolio(currentPrice: number) {
    const position = this.portfolio.position;
    const unrealizedPnl = this.portfolio.getUnrealizedPnl(currentPrice);
    const equity = this.portfolio.getEquity(currentPrice);
    this.portfolio.trackDrawdown(equity);

    this.logger.logPortfolio({
      активнаяПара: this.activeSymbol,
      баланс: Number(this.portfolio.balance.toFixed(6)),
      реализованныйРезультат: Number(this.portfolio.realizedPnl.toFixed(6)),
      накопленныйРезультат: Number(this.portfolio.realizedPnl.toFixed(6)),
      уплаченоКомиссий: Number(this.portfolio.feesPaid.toFixed(6)),
      капитал: Number(equity.toFixed(6)),
      пиковыйКапитал: Number(this.portfolio.peakEquity.toFixed(6)),
      максимальнаяПросадкаВПроцентах: Number(
        this.portfolio.maxDrawdownPct.toFixed(2),
      ),
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
      плавающийРезультат: Number(unrealizedPnl.toFixed(6)),
      стопЦена: position ? Number(position.stopPrice.toFixed(2)) : null,
      тейкЦена: position ? Number(position.takePrice.toFixed(2)) : null,
      всегоСделок: this.portfolio.totalTrades,
      прибыльныхСделок: this.portfolio.wins,
      убыточныхСделок: this.portfolio.losses,
      подрядУбыточныхСделок: this.portfolio.consecutiveLosses,
      винрейт: Number(this.portfolio.getWinRate().toFixed(2)),
      свечейБезПозиции: this.candlesWithoutPosition,
    });
  }

  private translateTrade(trade: ExecutedTrade) {
    const actionMap: Record<string, string> = {
      OPEN_LONG: 'ОТКРЫТЬ_ЛОНГ',
      CLOSE_LONG: 'ЗАКРЫТЬ_ЛОНГ',
      OPEN_SHORT: 'ОТКРЫТЬ_ШОРТ',
      CLOSE_SHORT: 'ЗАКРЫТЬ_ШОРТ',
    };

    const sideMap: Record<string, string> = {
      LONG: 'ЛОНГ',
      SHORT: 'ШОРТ',
    };

    return {
      действие: actionMap[trade.action] ?? trade.action,
      символ: trade.symbol,
      интервал: trade.interval,
      сторона: sideMap[trade.side] ?? trade.side,
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
      валовыйРезультат:
        typeof trade.grossPnl === 'number'
          ? Number(trade.grossPnl.toFixed(6))
          : trade.grossPnl,
      чистыйРезультат:
        typeof trade.pnlNet === 'number'
          ? Number(trade.pnlNet.toFixed(6))
          : trade.pnlNet,
      комиссия:
        typeof trade.fee === 'number'
          ? Number(trade.fee.toFixed(6))
          : trade.fee,
      суммарныеКомиссии:
        typeof trade.totalFees === 'number'
          ? Number(trade.totalFees.toFixed(6))
          : trade.totalFees,
      открытаВ: trade.openedAt,
      закрытаВ: trade.closedAt,
      причина: trade.reason,
    };
  }

  private translateSignal(signal: string) {
    const signalMap: Record<string, string> = {
      OPEN_LONG: 'ОТКРЫТЬ_ЛОНГ',
      CLOSE_LONG: 'ЗАКРЫТЬ_ЛОНГ',
      OPEN_SHORT: 'ОТКРЫТЬ_ШОРТ',
      CLOSE_SHORT: 'ЗАКРЫТЬ_ШОРТ',
      REVERSE_TO_LONG: 'ПЕРЕВОРОТ_В_ЛОНГ',
      REVERSE_TO_SHORT: 'ПЕРЕВОРОТ_В_ШОРТ',
      HOLD: 'УДЕРЖИВАТЬ',
    };

    return signalMap[signal] ?? signal;
  }

  private translateAction(action: string) {
    const actionMap: Record<string, string> = {
      OPEN_LONG: 'ОТКРЫТЬ_ЛОНГ',
      CLOSE_LONG: 'ЗАКРЫТЬ_ЛОНГ',
      OPEN_SHORT: 'ОТКРЫТЬ_ШОРТ',
      CLOSE_SHORT: 'ЗАКРЫТЬ_ШОРТ',
      CHECK_STOPS: 'ПРОВЕРКА_СТОПОВ',
    };

    return actionMap[action] ?? action;
  }

  private translateScannedSymbol(item: ScannedSymbol) {
    return {
      символ: item.symbol,
      оценка: Number(item.score.toFixed(4)),
      изменениеЗа24ЧасаВПроцентах: Number(item.priceChangePercent.toFixed(2)),
      объёмВКотируемойВалюте: Number(item.quoteVolume.toFixed(2)),
      недавнееДвижениеВПроцентах: Number((item.recentMovePct * 100).toFixed(2)),
      внутридневнаяВолатильностьВПроцентах: Number(
        (item.intradayVolatilityPct * 100).toFixed(2),
      ),
      ускорениеОбъёмаВПроцентах: Number(
        (item.volumeAcceleration * 100).toFixed(2),
      ),
    };
  }

  onModuleDestroy() {
    if (this.scannerInterval) {
      clearInterval(this.scannerInterval);
    }
  }
}
