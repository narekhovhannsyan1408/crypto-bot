import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { Candle } from '../../market/types';
import {
  ScannedSymbol,
  SymbolScannerService,
} from '../../scanner/symbol-scanner/symbol-scanner.service';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { RiskManagerService } from '../../trader/risk-manager/risk-manager.service';
import { ExecutedTrade, ExecutionResult } from '../../trader/types';

@Injectable()
export class BotRunnerService implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private readonly watchedSymbols = new Set<string>();
  private readonly candlesWithoutPosition = new Map<string, number>();
  private activeInterval = this.config.interval;
  private lastScanTop: ScannedSymbol[] = [];
  private scannerInterval?: NodeJS.Timeout;
  private scannerInProgress = false;
  private marketStarted = false;

  constructor(
    private readonly market: BinanceMarketService,
    private readonly strategy: StrategyService,
    private readonly trader: PaperTraderService,
    private readonly portfolio: PortfolioService,
    private readonly riskManager: RiskManagerService,
    private readonly logger: BotLoggerService,
    private readonly scanner: SymbolScannerService,
  ) {}

  async start() {
    this.logger.logInfo('Запуск multi-pair торгового бота');

    const initialUniverse = await this.resolveInitialUniverse();
    await this.syncUniverse(initialUniverse);

    this.market.connectSymbols([...this.watchedSymbols], this.activeInterval, (candle) => {
      void this.handleCandle(candle);
    });
    this.marketStarted = true;

    if (this.config.useScanner) {
      this.startScannerLoop();
    }
  }

  private async resolveInitialUniverse() {
    if (!this.config.useScanner) {
      return this.getManualUniverse();
    }

    try {
      const top = await this.scanner.scanTopSymbols(this.config.universeSize);
      this.lastScanTop = top;

      if (top.length > 0) {
        this.logger.logInfo(
          'Стартовый universe выбран сканером',
          top.map((item) => this.translateScannedSymbol(item)),
        );
        return top.map((item) => item.symbol);
      }
    } catch (error) {
      this.logger.logError('Не удалось выбрать стартовый universe сканером', error);
    }

    return this.getManualUniverse();
  }

  private getManualUniverse() {
    if (this.config.allowedSymbols.length > 0) {
      return this.config.allowedSymbols.slice(0, this.config.universeSize);
    }

    return [this.config.symbol];
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
      const top = await this.scanner.scanTopSymbols(this.config.maxScannerCandidates);
      this.lastScanTop = top;

      this.logger.logInfo(
        'Топ пар по сканеру',
        top.map((item) => this.translateScannedSymbol(item)),
      );

      const nextUniverse = this.buildTargetUniverse(top);
      await this.syncUniverse(nextUniverse);
    } catch (error) {
      this.logger.logError('Ошибка сканера', error);
    } finally {
      this.scannerInProgress = false;
    }
  }

  private buildTargetUniverse(top: ScannedSymbol[]) {
    const desired = new Set<string>(
      top.slice(0, this.config.universeSize).map((item) => item.symbol),
    );

    for (const position of this.portfolio.getOpenPositions()) {
      desired.add(position.symbol);
    }

    if (desired.size === 0) {
      for (const symbol of this.getManualUniverse()) {
        desired.add(symbol);
      }
    }

    return [...desired];
  }

  private async syncUniverse(nextSymbols: string[]) {
    const normalized = [...new Set(nextSymbols)].filter(Boolean);
    const previousSymbols = [...this.watchedSymbols];
    const addedSymbols = normalized.filter((symbol) => !this.watchedSymbols.has(symbol));
    const removedSymbols = previousSymbols.filter(
      (symbol) => !normalized.includes(symbol) && !this.portfolio.hasOpenPosition(symbol),
    );

    for (const symbol of addedSymbols) {
      await this.preloadSymbolHistory(symbol);
      this.candlesWithoutPosition.set(symbol, 0);
      this.watchedSymbols.add(symbol);
    }

    for (const symbol of removedSymbols) {
      this.watchedSymbols.delete(symbol);
      this.candlesWithoutPosition.delete(symbol);
      this.strategy.resetSymbol(symbol, this.activeInterval);
    }

    if (!this.marketStarted) {
      return;
    }

    const previousUniverse = previousSymbols.sort().join(',');
    const currentUniverse = [...this.watchedSymbols].sort().join(',');

    if (previousUniverse !== currentUniverse) {
      this.logger.logInfo('Обновлён торговый universe', {
        символовВСлежении: this.watchedSymbols.size,
        списокСимволов: [...this.watchedSymbols],
      });
      this.market.replaceSymbols([...this.watchedSymbols], this.activeInterval);
    }
  }

  private async handleCandle(candle: Candle) {
    try {
      if (!candle.isClosed) return;
      if (!this.watchedSymbols.has(candle.symbol)) return;

      this.portfolio.updateMark(candle.symbol, candle.close);

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
        this.printPortfolio(candle.symbol);
        return;
      }

      const position = this.portfolio.getPosition(candle.symbol);
      const result = this.strategy.onNewCandle(candle, position?.side ?? null);

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

      let tradeHappened = false;

      if (!position) {
        this.incrementIdleCounter(candle.symbol);

        if (result.signal === 'OPEN_LONG') {
          tradeHappened = this.tryOpenWithRisk(candle, 'LONG', result.reason);
        }

        if (result.signal === 'OPEN_SHORT') {
          tradeHappened = this.tryOpenWithRisk(candle, 'SHORT', result.reason);
        }
      } else {
        this.candlesWithoutPosition.set(candle.symbol, 0);

        if (position.side === 'LONG') {
          if (result.signal === 'CLOSE_LONG') {
            tradeHappened = this.handleExecutionResult(
              this.trader.tryCloseLong(
                candle.symbol,
                candle.close,
                candle.closeTime,
                result.reason,
              ),
            );
          }

          if (result.signal === 'REVERSE_TO_SHORT') {
            const closeExecuted = this.handleExecutionResult(
              this.trader.tryCloseLong(
                candle.symbol,
                candle.close,
                candle.closeTime,
                'Переворот: закрываем лонг перед открытием шорта',
              ),
            );
            const openExecuted = this.tryOpenWithRisk(candle, 'SHORT', result.reason);
            tradeHappened = closeExecuted || openExecuted;
          }
        }

        if (position.side === 'SHORT') {
          if (result.signal === 'CLOSE_SHORT') {
            tradeHappened = this.handleExecutionResult(
              this.trader.tryCloseShort(
                candle.symbol,
                candle.close,
                candle.closeTime,
                result.reason,
              ),
            );
          }

          if (result.signal === 'REVERSE_TO_LONG') {
            const closeExecuted = this.handleExecutionResult(
              this.trader.tryCloseShort(
                candle.symbol,
                candle.close,
                candle.closeTime,
                'Переворот: закрываем шорт перед открытием лонга',
              ),
            );
            const openExecuted = this.tryOpenWithRisk(candle, 'LONG', result.reason);
            tradeHappened = closeExecuted || openExecuted;
          }
        }
      }

      if (!tradeHappened) {
        this.printPortfolio(candle.symbol);
      }
    } catch (error) {
      this.logger.logError('Ошибка обработки свечи', error);
    }
  }

  private tryOpenWithRisk(
    candle: Candle,
    side: 'LONG' | 'SHORT',
    reason: string,
  ) {
    const approval = this.riskManager.approveOpenPosition({
      symbol: candle.symbol,
      interval: candle.interval,
      side,
      entryPrice: candle.close,
      timestamp: candle.closeTime,
    });

    if (approval.status === 'DENIED') {
      this.logger.logInfo('Риск-менеджер отклонил сделку', {
        символ: candle.symbol,
        сторона: side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
        причина: approval.reason,
      });
      return false;
    }

    const execution =
      side === 'LONG'
        ? this.trader.tryOpenLong(
            candle.symbol,
            candle.interval,
            candle.close,
            candle.closeTime,
            reason,
            approval.approvedSizeUsdt,
          )
        : this.trader.tryOpenShort(
            candle.symbol,
            candle.interval,
            candle.close,
            candle.closeTime,
            reason,
            approval.approvedSizeUsdt,
          );

    return this.handleExecutionResult(execution);
  }

  private handleExecutionResult(execution: ExecutionResult | null) {
    if (!execution) {
      return false;
    }

    if (execution.status === 'REJECTED') {
      this.logger.logInfo('Сделка отклонена', {
        действие: this.translateAction(execution.action),
        символ: execution.symbol ?? 'НЕИЗВЕСТНО',
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

    this.candlesWithoutPosition.set(execution.trade.symbol, 0);
    return true;
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

  private printPortfolio(symbol: string) {
    const snapshot = this.portfolio.getSnapshot();
    this.portfolio.trackDrawdown(snapshot.equity);

    this.logger.logPortfolio({
      символКоторыйОбновился: symbol,
      баланс: Number(snapshot.balance.toFixed(6)),
      реализованныйРезультат: Number(snapshot.realizedPnl.toFixed(6)),
      плавающийРезультат: Number(snapshot.unrealizedPnl.toFixed(6)),
      капитал: Number(snapshot.equity.toFixed(6)),
      пиковыйКапитал: Number(snapshot.peakEquity.toFixed(6)),
      максимальнаяПросадкаВПроцентах: Number(
        snapshot.maxDrawdownPct.toFixed(2),
      ),
      уплаченоКомиссий: Number(snapshot.feesPaid.toFixed(6)),
      открытыхПозиций: snapshot.openPositionsCount,
      symbolsUniverse: [...this.watchedSymbols],
      позиций: snapshot.openPositions.map((position) => ({
        символ: position.symbol,
        сторона: position.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
        ценаВхода: Number(position.entryPrice.toFixed(2)),
        количество: Number(position.quantity.toFixed(8)),
        стопЦена: Number(position.stopPrice.toFixed(2)),
        тейкЦена: Number(position.takePrice.toFixed(2)),
        плавающийРезультат: Number(
          this.portfolio.getUnrealizedPnl(position.symbol).toFixed(6),
        ),
      })),
      всегоСделок: snapshot.totalTrades,
      прибыльныхСделок: snapshot.wins,
      убыточныхСделок: snapshot.losses,
      подрядУбыточныхСделок: snapshot.consecutiveLosses,
      винрейт: Number(this.portfolio.getWinRate().toFixed(2)),
      рискМенеджмент: this.riskManager.getRiskState(),
      свечейБезПозицииПоСимволам: Object.fromEntries(this.candlesWithoutPosition),
    });
  }

  private incrementIdleCounter(symbol: string) {
    const current = this.candlesWithoutPosition.get(symbol) ?? 0;
    this.candlesWithoutPosition.set(symbol, current + 1);
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

  getDashboardSnapshot() {
    const snapshot = this.portfolio.getSnapshot();

    return {
      generatedAt: Date.now(),
      interval: this.activeInterval,
      watchedSymbols: [...this.watchedSymbols],
      idleCountersBySymbol: Object.fromEntries(this.candlesWithoutPosition),
      portfolio: {
        баланс: Number(snapshot.balance.toFixed(6)),
        реализованныйРезультат: Number(snapshot.realizedPnl.toFixed(6)),
        плавающийРезультат: Number(snapshot.unrealizedPnl.toFixed(6)),
        капитал: Number(snapshot.equity.toFixed(6)),
        пиковыйКапитал: Number(snapshot.peakEquity.toFixed(6)),
        максимальнаяПросадкаВПроцентах: Number(
          snapshot.maxDrawdownPct.toFixed(2),
        ),
        уплаченоКомиссий: Number(snapshot.feesPaid.toFixed(6)),
        открытыхПозиций: snapshot.openPositionsCount,
        всегоСделок: snapshot.totalTrades,
        прибыльныхСделок: snapshot.wins,
        убыточныхСделок: snapshot.losses,
        подрядУбыточныхСделок: snapshot.consecutiveLosses,
        винрейт: Number(this.portfolio.getWinRate().toFixed(2)),
        позиций: snapshot.openPositions.map((position) => ({
          символ: position.symbol,
          сторона: position.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
          ценаВхода: Number(position.entryPrice.toFixed(2)),
          количество: Number(position.quantity.toFixed(8)),
          стопЦена: Number(position.stopPrice.toFixed(2)),
          тейкЦена: Number(position.takePrice.toFixed(2)),
          текущаяЦена: Number(
            (this.portfolio.getMarkPrice(position.symbol) ?? position.entryPrice).toFixed(
              2,
            ),
          ),
          плавающийРезультат: Number(
            this.portfolio.getUnrealizedPnl(position.symbol).toFixed(6),
          ),
        })),
      },
      рискМенеджмент: this.riskManager.getRiskState(),
      scannerTop: this.lastScanTop.map((item) => this.translateScannedSymbol(item)),
    };
  }

  emergencyCloseAllPositions(reason = 'Экстренное закрытие всех позиций через dashboard') {
    const openPositions = this.portfolio.getOpenPositions();
    let closedPositions = 0;

    this.logger.logInfo('Получена команда экстренного закрытия всех позиций', {
      открытыхПозицийДоЗакрытия: openPositions.length,
      причина: reason,
    });

    for (const position of openPositions) {
      const price = this.portfolio.getMarkPrice(position.symbol) ?? position.entryPrice;
      const execution =
        position.side === 'LONG'
          ? this.trader.tryCloseLong(
              position.symbol,
              price,
              Date.now(),
              reason,
            )
          : this.trader.tryCloseShort(
              position.symbol,
              price,
              Date.now(),
              reason,
            );

      if (this.handleExecutionResult(execution)) {
        closedPositions += 1;
      }
    }

    const snapshot = this.getDashboardSnapshot();
    this.logger.logInfo('Экстренное закрытие завершено', {
      закрытоПозиций: closedPositions,
      итоговыйБаланс: snapshot.portfolio.баланс,
      итоговыйКапитал: snapshot.portfolio.капитал,
    });

    return {
      closedPositions,
      snapshot,
    };
  }
}
