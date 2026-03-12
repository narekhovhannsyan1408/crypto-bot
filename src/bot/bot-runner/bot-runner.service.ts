import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { Candle } from '../../market/types';
import {
  ScannedSymbol,
  SymbolScannerService,
} from '../../scanner/symbol-scanner/symbol-scanner.service';
import { HigherTimeframeConfirmationService } from '../../strategy/higher-timeframe-confirmation/higher-timeframe-confirmation.service';
import {
  StrategyCandidateDecision,
  StrategyArbitrationService,
  StrategyOpenCandidate,
} from '../../strategy/strategy-arbitration/strategy-arbitration.service';
import { StrategyRegistryService } from '../../strategy/strategy-registry/strategy-registry.service';
import { StrategyResult, TradingStrategy } from '../../strategy/types';
import { ExecutionGatewayService } from '../../trader/execution-gateway/execution-gateway.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { RiskManagerService } from '../../trader/risk-manager/risk-manager.service';
import { ExecutedTrade, ExecutionResult } from '../../trader/types';

@Injectable()
export class BotRunnerService implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private readonly watchedSymbols = new Set<string>();
  private readonly candlesWithoutPosition = new Map<string, number>();
  private activeInterval = this.config.interval;
  private confirmationInterval =
    this.config.confirmationInterval &&
    this.config.confirmationInterval !== this.config.interval
      ? this.config.confirmationInterval
      : null;
  private lastScanTop: ScannedSymbol[] = [];
  private lastStrategySelection:
    | {
        timestamp: number;
        symbol: string;
        selectedStrategyId: string | null;
        selectedStrategyName: string | null;
        selectedSide: 'LONG' | 'SHORT' | null;
        selectedScore: number | null;
        reason: string;
        candidates: StrategyCandidateDecision[];
      }
    | null = null;
  private scannerInterval?: NodeJS.Timeout;
  private scannerInProgress = false;
  private marketStarted = false;

  constructor(
    private readonly market: BinanceMarketService,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly strategyArbitration: StrategyArbitrationService,
    private readonly confirmation: HigherTimeframeConfirmationService,
    private readonly trader: ExecutionGatewayService,
    private readonly portfolio: PortfolioService,
    private readonly riskManager: RiskManagerService,
    private readonly logger: BotLoggerService,
    private readonly scanner: SymbolScannerService,
  ) {}

  async start() {
    this.logger.logInfo('Запуск multi-pair торгового бота');
    await this.trader.refreshExecutionStatus();

    const initialUniverse = await this.resolveInitialUniverse();
    await this.syncUniverse(initialUniverse);

    this.connectMarketStreams();
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
    const protectedSymbols = new Set(
      this.portfolio.getOpenPositions().map((position) => position.symbol),
    );
    const desired = new Set<string>(protectedSymbols);
    const targetSize = Math.max(this.config.universeSize, protectedSymbols.size);

    // Keep non-idle watched symbols for a while to avoid unnecessary churn.
    for (const symbol of this.watchedSymbols) {
      if (desired.size >= targetSize) {
        break;
      }

      if (protectedSymbols.has(symbol)) {
        continue;
      }

      const idleCandles = this.candlesWithoutPosition.get(symbol) ?? 0;
      if (idleCandles < this.config.maxCandlesWithoutPositionBeforeSwitch) {
        desired.add(symbol);
      }
    }

    for (const item of top) {
      if (desired.size >= targetSize) {
        break;
      }

      desired.add(item.symbol);
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
      for (const strategy of this.strategyRegistry.getStrategies()) {
        strategy.resetSymbol(symbol, this.activeInterval);
      }
      if (this.confirmationInterval) {
        this.confirmation.resetSymbol(symbol, this.confirmationInterval);
      }
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
      this.replaceMarketStreams();
    }
  }

  private connectMarketStreams() {
    const symbols = [...this.watchedSymbols];
    const onCandle = (candle: Candle) => {
      void this.handleCandle(candle);
    };

    if (this.confirmationInterval) {
      this.market.connectSymbolIntervals(
        symbols,
        [this.activeInterval, this.confirmationInterval],
        onCandle,
      );
      return;
    }

    this.market.connectSymbols(symbols, this.activeInterval, onCandle);
  }

  private replaceMarketStreams() {
    const symbols = [...this.watchedSymbols];

    if (this.confirmationInterval) {
      this.market.replaceSymbolIntervals(symbols, [
        this.activeInterval,
        this.confirmationInterval,
      ]);
      return;
    }

    this.market.replaceSymbols(symbols, this.activeInterval);
  }

  private async handleCandle(candle: Candle) {
    try {
      if (!candle.isClosed) return;
      if (!this.watchedSymbols.has(candle.symbol)) return;

      if (this.confirmationInterval && candle.interval === this.confirmationInterval) {
        const confirmation = this.confirmation.onNewCandle(candle);
        this.logger.logInfo('Обновлён тренд подтверждения по старшему таймфрейму', {
          символ: candle.symbol,
          интервалПодтверждения: candle.interval,
          направление: this.translateConfirmationTrend(confirmation.trend),
          готовность: confirmation.isReady ? 'готов' : 'не готов',
          силаТрендаВПроцентах:
            typeof confirmation.trendStrengthPct === 'number'
              ? Number((confirmation.trendStrengthPct * 100).toFixed(3))
              : null,
        });
        return;
      }

      if (candle.interval !== this.activeInterval) {
        return;
      }

      this.logger.logCandle({
        символ: candle.symbol,
        интервал: candle.interval,
        времяЗакрытия: candle.closeTime,
        ценаЗакрытия: candle.close,
        объём: candle.volume,
      });

      const stopAction = await this.trader.checkStops(candle);
      for (const action of stopAction) {
        this.handleExecutionResult(action);
      }

      const strategies = this.strategyRegistry.getStrategies();
      let tradeHappened = false;
      const positionsOnSymbol = this.portfolio.getPositionsForSymbol(candle.symbol);
      const openCandidates: StrategyOpenCandidate[] = [];

      if (positionsOnSymbol.length === 0) {
        this.incrementIdleCounter(candle.symbol);
      } else {
        this.candlesWithoutPosition.set(candle.symbol, 0);
      }

      this.portfolio.updateMark(candle.symbol, candle.close);

      for (const strategy of strategies) {
        const position = this.portfolio.getPosition(candle.symbol, strategy.id);
        const strategyResult = strategy.onNewCandle(candle, position?.side ?? null);
        const result = this.applyConfirmationFilter(
          candle.symbol,
          strategy,
          strategyResult,
        );

        this.logger.logSignal({
          символ: candle.symbol,
          стратегия: strategy.name,
          strategyId: strategy.id,
          цена: candle.close,
          сигнал: this.translateSignal(result.signal),
          причина: result.reason,
          индикаторы: this.translateIndicators(result.indicators),
        });

        if (!position) {
          if (result.signal === 'OPEN_LONG') {
            openCandidates.push({
              strategy,
              result,
              side: 'LONG',
            });
          }

          if (result.signal === 'OPEN_SHORT') {
            openCandidates.push({
              strategy,
              result,
              side: 'SHORT',
            });
          }

          continue;
        }

        if (position.side === 'LONG') {
          if (
            result.signal === 'CLOSE_LONG' &&
            this.config.exitOnStrategySignal
          ) {
            tradeHappened =
              this.handleExecutionResult(
                await this.trader.tryCloseLong(
                  candle.symbol,
                  strategy.id,
                  candle.close,
                  candle.closeTime,
                  result.reason,
                ),
              ) || tradeHappened;
          }

          if (result.signal === 'REVERSE_TO_SHORT') {
            const closeExecuted = this.handleExecutionResult(
              await this.trader.tryCloseLong(
                candle.symbol,
                strategy.id,
                candle.close,
                candle.closeTime,
                'Переворот: закрываем лонг перед открытием шорта',
              ),
            );
            const openExecuted = await this.tryOpenWithRisk(
              candle,
              strategy,
              'SHORT',
              result.reason,
            );
            tradeHappened = closeExecuted || openExecuted || tradeHappened;
          }
        }

        if (position.side === 'SHORT') {
          if (
            result.signal === 'CLOSE_SHORT' &&
            this.config.exitOnStrategySignal
          ) {
            tradeHappened =
              this.handleExecutionResult(
                await this.trader.tryCloseShort(
                  candle.symbol,
                  strategy.id,
                  candle.close,
                  candle.closeTime,
                  result.reason,
                ),
              ) || tradeHappened;
          }

          if (result.signal === 'REVERSE_TO_LONG') {
            const closeExecuted = this.handleExecutionResult(
              await this.trader.tryCloseShort(
                candle.symbol,
                strategy.id,
                candle.close,
                candle.closeTime,
                'Переворот: закрываем шорт перед открытием лонга',
              ),
            );
            const openExecuted = await this.tryOpenWithRisk(
              candle,
              strategy,
              'LONG',
              result.reason,
            );
            tradeHappened = closeExecuted || openExecuted || tradeHappened;
          }
        }
      }

      if (openCandidates.length > 0) {
        const selectionDecision = this.strategyArbitration.selectCandidate(
          candle,
          openCandidates,
          this.trader.getExecutionStatus(),
        );
        const selectedCandidate =
          selectionDecision.selectedStrategyId === null
            ? null
            : openCandidates.find(
                (candidate) =>
                  candidate.strategy.id === selectionDecision.selectedStrategyId &&
                  candidate.side === selectionDecision.selectedSide,
              ) ?? null;

        this.lastStrategySelection = {
          timestamp: candle.closeTime,
          symbol: selectionDecision.symbol,
          selectedStrategyId: selectionDecision.selectedStrategyId,
          selectedStrategyName: selectionDecision.selectedStrategyName,
          selectedSide: selectionDecision.selectedSide,
          selectedScore: selectionDecision.selectedScore,
          reason: selectionDecision.reason,
          candidates: selectionDecision.candidates,
        };

        if (selectedCandidate) {
          this.logger.logInfo('Автовыбор стратегии для новой сделки', {
            символ: candle.symbol,
            стратегия: selectedCandidate.strategy.name,
            strategyId: selectedCandidate.strategy.id,
            сторона: selectedCandidate.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
            режимРынка: selectedCandidate.result.marketRegime ?? 'не определён',
            оценкаВхода: Number((selectionDecision.selectedScore ?? 0).toFixed(2)),
            причина: selectionDecision.reason,
            кандидаты: selectionDecision.candidates.map((candidate) => ({
              стратегия: candidate.strategyName,
              strategyId: candidate.strategyId,
              сторона: candidate.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
              статус: candidate.status === 'selected' ? 'выбрана' : 'отклонена',
              режимРынка: candidate.marketRegime ?? 'не определён',
              entryScore: Number(candidate.entryScore.toFixed(2)),
              arbitrationScore: Number(candidate.arbitrationScore.toFixed(2)),
              причина: candidate.reason,
            })),
          });

          tradeHappened =
            (await this.tryOpenWithRisk(
              candle,
              selectedCandidate.strategy,
              selectedCandidate.side,
              selectedCandidate.result.reason,
            )) || tradeHappened;
        } else {
          this.logger.logInfo('Автовыбор стратегии не нашёл допустимый вход', {
            символ: candle.symbol,
            кандидаты: selectionDecision.candidates.map((candidate) => ({
              стратегия: candidate.strategyName,
              strategyId: candidate.strategyId,
              сторона: candidate.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
              режимРынка: candidate.marketRegime ?? 'не определён',
              entryScore: Number(candidate.entryScore.toFixed(2)),
              arbitrationScore: Number(candidate.arbitrationScore.toFixed(2)),
              причина: candidate.reason,
            })),
            причина: selectionDecision.reason,
          });
        }
      }

      this.printPortfolio(candle.symbol);
    } catch (error) {
      this.logger.logError('Ошибка обработки свечи', error);
    }
  }

  private async tryOpenWithRisk(
    candle: Candle,
    strategy: TradingStrategy,
    side: 'LONG' | 'SHORT',
    reason: string,
  ) {
    const approval = this.riskManager.approveOpenPosition({
      symbol: candle.symbol,
      interval: candle.interval,
      strategyId: strategy.id,
      side,
      entryPrice: candle.close,
      timestamp: candle.closeTime,
    });

    if (approval.status === 'DENIED') {
      this.logger.logInfo('Риск-менеджер отклонил сделку', {
        символ: candle.symbol,
        стратегия: strategy.name,
        strategyId: strategy.id,
        сторона: side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
        причина: approval.reason,
      });
      return false;
    }

    const execution =
      side === 'LONG'
        ? await this.trader.tryOpenLong(
            candle.symbol,
            candle.interval,
            strategy.id,
            strategy.name,
            candle.close,
            candle.closeTime,
            reason,
            approval.approvedSizeUsdt,
          )
        : await this.trader.tryOpenShort(
            candle.symbol,
            candle.interval,
            strategy.id,
            strategy.name,
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
        стратегия: execution.strategyName ?? execution.strategyId ?? 'НЕИЗВЕСТНО',
        причина: execution.reason,
      });
      return false;
    }

    this.logger.logTrade(this.translateTrade(execution.trade));

    if (
      execution.trade.action === 'CLOSE_LONG' ||
      execution.trade.action === 'CLOSE_SHORT'
    ) {
      this.strategyRegistry
        .getStrategyById(execution.trade.strategyId)
        ?.registerTradeClosed(execution.trade.symbol, execution.trade.interval);
    }

    this.candlesWithoutPosition.set(execution.trade.symbol, 0);
    return true;
  }

  private async preloadSymbolHistory(symbol: string) {
    try {
      const requiredWarmupCandles = this.getRequiredWarmupCandles();
      const preloadCandles = Math.max(requiredWarmupCandles + 30, 60);
      const candles = await this.market.loadHistoricalCandles(
        symbol,
        this.activeInterval,
        preloadCandles,
      );
      for (const strategy of this.strategyRegistry.getStrategies()) {
        strategy.seedHistory(symbol, this.activeInterval, candles);
      }
      this.logger.logInfo('Прогрели историю по символу', {
        символ: symbol,
        свечей: candles.length,
        минимальноНужноСвечей: requiredWarmupCandles,
        запасСвечейДляСтарта: Math.max(candles.length - requiredWarmupCandles, 0),
      });

      if (this.confirmationInterval) {
        const confirmationWarmupCandles = this.confirmation.getRequiredWarmupCandles();
        const confirmationPreloadCandles = Math.max(
          confirmationWarmupCandles + 20,
          40,
        );
        const confirmationCandles = await this.market.loadHistoricalCandles(
          symbol,
          this.confirmationInterval,
          confirmationPreloadCandles,
        );
        this.confirmation.seedHistory(
          symbol,
          this.confirmationInterval,
          confirmationCandles,
        );
        this.logger.logInfo('Прогрели старший таймфрейм для подтверждения', {
          символ: symbol,
          интервалПодтверждения: this.confirmationInterval,
          свечей: confirmationCandles.length,
          минимальноНужноСвечей: confirmationWarmupCandles,
        });
      }
    } catch (error) {
      this.logger.logError('Не удалось прогреть историю по символу', {
        символ: symbol,
        error,
      });
      for (const strategy of this.strategyRegistry.getStrategies()) {
        strategy.resetSymbol(symbol, this.activeInterval);
      }
      if (this.confirmationInterval) {
        this.confirmation.resetSymbol(symbol, this.confirmationInterval);
      }
    }
  }

  private getRequiredWarmupCandles() {
    const strategies = this.strategyRegistry.getStrategies();

    if (strategies.length === 0) {
      return 0;
    }

    return Math.max(...strategies.map((strategy) => strategy.getRequiredWarmupCandles()));
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
        стратегия: position.strategyName,
        strategyId: position.strategyId,
        сторона: position.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
        рынокИсполнения: position.marketType === 'spot' ? 'SPOT' : 'FUTURES',
        ценаВхода: Number(position.entryPrice.toFixed(2)),
        количество: Number(position.quantity.toFixed(8)),
        стопЦена: Number(position.stopPrice.toFixed(2)),
        тейкЦена: Number(position.takePrice.toFixed(2)),
        времяВПозицииМинут: Number(
          ((Date.now() - position.openedAt) / 60_000).toFixed(1),
        ),
        breakevenАктивен: position.breakevenArmed ? 'да' : 'нет',
        максимумПослеВхода: Number(position.highestPrice.toFixed(2)),
        минимумПослеВхода: Number(position.lowestPrice.toFixed(2)),
        плавающийРезультат: Number(
          this.portfolio
            .getPositionUnrealizedPnl(position.symbol, position.strategyId)
            .toFixed(6),
        ),
      })),
      всегоСделок: snapshot.totalTrades,
      прибыльныхСделок: snapshot.wins,
      убыточныхСделок: snapshot.losses,
      подрядУбыточныхСделок: snapshot.consecutiveLosses,
      винрейт: Number(this.portfolio.getWinRate().toFixed(2)),
      экспозицияПоСтратегиям: Object.fromEntries(
        Object.entries(snapshot.exposureByStrategy).map(([strategyId, value]) => [
          strategyId,
          Number(value.toFixed(6)),
        ]),
      ),
      рискМенеджмент: {
        ...this.riskManager.getRiskState(),
        режимВыхода: this.config.exitOnStrategySignal
          ? 'по_сигналу_стратегии'
          : 'только_по_стопам',
      },
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
      стратегия: trade.strategyName,
      strategyId: trade.strategyId,
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

  private translateIndicators(indicators?: Record<string, number>) {
    if (!indicators) {
      return null;
    }

    const translated: Record<string, number> = {};

    for (const [key, value] of Object.entries(indicators)) {
      const mappedKey =
        {
          emaFast: 'быстраяСкользящаяСредняя',
          emaSlow: 'медленнаяСкользящаяСредняя',
          rsi: 'индексОтносительнойСилы',
          atr: 'среднийИстинныйДиапазон',
          atrPct: 'среднийИстинныйДиапазонВПроцентах',
          trendStrengthPct: 'силаТрендаВПроцентах',
          deviationPct: 'отклонениеОтСреднейВПроцентах',
        }[key] ?? key;

      translated[mappedKey] =
        key.toLowerCase().includes('pct') || key.toLowerCase().includes('deviation')
          ? Number((value * 100).toFixed(3))
          : Number(value.toFixed(6));
    }

    return translated;
  }

  private applyConfirmationFilter(
    symbol: string,
    strategy: TradingStrategy,
    result: StrategyResult,
  ): StrategyResult {
    if (!this.confirmationInterval) {
      return result;
    }

    if (this.config.confirmationMode === 'off') {
      return result;
    }

    if (strategy.getConfirmationPolicy() === 'none') {
      return result;
    }

    const confirmation = this.confirmation.getTrend(symbol, this.confirmationInterval);
    const signal = result.signal;
    const needsLongConfirmation =
      signal === 'OPEN_LONG' || signal === 'REVERSE_TO_LONG';
    const needsShortConfirmation =
      signal === 'OPEN_SHORT' || signal === 'REVERSE_TO_SHORT';

    if (!needsLongConfirmation && !needsShortConfirmation) {
      return result;
    }

    if (!confirmation.isReady) {
      if (this.config.confirmationMode === 'lenient') {
        return result;
      }

      if (signal === 'REVERSE_TO_LONG') {
        return {
          ...result,
          signal: 'CLOSE_SHORT',
          reason: `${result.reason}. Старший таймфрейм ещё не готов подтвердить long, поэтому закрываем шорт без переворота`,
        };
      }

      if (signal === 'REVERSE_TO_SHORT') {
        return {
          ...result,
          signal: 'CLOSE_LONG',
          reason: `${result.reason}. Старший таймфрейм ещё не готов подтвердить short, поэтому закрываем лонг без переворота`,
        };
      }

      return {
        ...result,
        signal: 'HOLD',
        reason: `${result.reason}. Ожидаем готовности подтверждения на старшем таймфрейме ${this.confirmationInterval}`,
      };
    }

    if (
      needsLongConfirmation &&
      !this.isConfirmationAllowed('LONG', confirmation.trend)
    ) {
      if (signal === 'REVERSE_TO_LONG') {
        return {
          ...result,
          signal: 'CLOSE_SHORT',
          reason: `${result.reason}. Старший таймфрейм не подтверждает long, поэтому выполняем только закрытие short`,
        };
      }

      return {
        ...result,
        signal: 'HOLD',
        reason: `${result.reason}. Старший таймфрейм ${this.confirmationInterval} не подтверждает long`,
      };
    }

    if (
      needsShortConfirmation &&
      !this.isConfirmationAllowed('SHORT', confirmation.trend)
    ) {
      if (signal === 'REVERSE_TO_SHORT') {
        return {
          ...result,
          signal: 'CLOSE_LONG',
          reason: `${result.reason}. Старший таймфрейм не подтверждает short, поэтому выполняем только закрытие long`,
        };
      }

      return {
        ...result,
        signal: 'HOLD',
        reason: `${result.reason}. Старший таймфрейм ${this.confirmationInterval} не подтверждает short`,
      };
    }

    return result;
  }

  private isConfirmationAllowed(
    direction: 'LONG' | 'SHORT',
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  ) {
    if (this.config.confirmationMode === 'strict') {
      return direction === 'LONG' ? trend === 'BULLISH' : trend === 'BEARISH';
    }

    if (this.config.confirmationMode === 'lenient') {
      return direction === 'LONG' ? trend !== 'BEARISH' : trend !== 'BULLISH';
    }

    return true;
  }

  private translateConfirmationTrend(trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL') {
    if (trend === 'BULLISH') return 'БЫЧИЙ';
    if (trend === 'BEARISH') return 'МЕДВЕЖИЙ';
    return 'НЕЙТРАЛЬНЫЙ';
  }

  onModuleDestroy() {
    if (this.scannerInterval) {
      clearInterval(this.scannerInterval);
    }
  }

  getDashboardSnapshot() {
    const snapshot = this.portfolio.getSnapshot();

    const now = Date.now();
    return {
      generatedAt: now,
      interval: this.activeInterval,
      executionInterval: this.activeInterval,
      confirmationInterval: this.confirmationInterval,
      confirmationMode: this.config.confirmationMode,
      strategySelectionMode: 'auto_best_signal',
      activeStrategies: this.strategyRegistry.getStrategies().map((strategy) => ({
        id: strategy.id,
        name: strategy.name,
      })),
      strategySelection: this.lastStrategySelection
        ? {
            время: this.lastStrategySelection.timestamp,
            символ: this.lastStrategySelection.symbol,
            выбраннаяСтратегия:
              this.lastStrategySelection.selectedStrategyName ??
              this.lastStrategySelection.selectedStrategyId ??
              'нет',
            strategyId: this.lastStrategySelection.selectedStrategyId,
            сторона:
              this.lastStrategySelection.selectedSide === 'LONG'
                ? 'ЛОНГ'
                : this.lastStrategySelection.selectedSide === 'SHORT'
                  ? 'ШОРТ'
                  : 'нет',
            оценка:
              typeof this.lastStrategySelection.selectedScore === 'number'
                ? Number(this.lastStrategySelection.selectedScore.toFixed(2))
                : null,
            причина: this.lastStrategySelection.reason,
            кандидаты: this.lastStrategySelection.candidates.map((candidate) => ({
              стратегия: candidate.strategyName,
              strategyId: candidate.strategyId,
              сторона: candidate.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
              статус: candidate.status === 'selected' ? 'выбрана' : 'отклонена',
              режимРынка: candidate.marketRegime ?? 'не определён',
              entryScore: Number(candidate.entryScore.toFixed(2)),
              arbitrationScore: Number(candidate.arbitrationScore.toFixed(2)),
              причина: candidate.reason,
            })),
          }
        : null,
      execution: this.trader.getExecutionStatus(),
      watchedSymbols: [...this.watchedSymbols],
      idleCountersBySymbol: Object.fromEntries(this.candlesWithoutPosition),
      confirmationBySymbol: this.confirmationInterval
        ? Object.fromEntries(
            [...this.watchedSymbols].map((symbol) => [
              symbol,
              (() => {
                const state = this.confirmation.getTrend(symbol, this.confirmationInterval!);
                return {
                  готовность: state.isReady ? 'готов' : 'не готов',
                  направление: this.translateConfirmationTrend(state.trend),
                  силаТрендаВПроцентах:
                    typeof state.trendStrengthPct === 'number'
                      ? Number((state.trendStrengthPct * 100).toFixed(3))
                      : null,
                };
              })(),
            ]),
          )
        : {},
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
          стратегия: position.strategyName,
          strategyId: position.strategyId,
          сторона: position.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
          рынокИсполнения: position.marketType === 'spot' ? 'SPOT' : 'FUTURES',
          ценаВхода: Number(position.entryPrice.toFixed(4)),
          количество: Number(position.quantity.toFixed(8)),
          стопЦена: Number(position.stopPrice.toFixed(4)),
          тейкЦена: Number(position.takePrice.toFixed(4)),
          текущаяЦена: Number(
            (this.portfolio.getMarkPrice(position.symbol) ?? position.entryPrice).toFixed(
              4,
            ),
          ),
          плавающийРезультат: Number(
            this.portfolio
              .getPositionUnrealizedPnl(position.symbol, position.strategyId)
              .toFixed(6),
          ),
          времяВПозицииМинут: Number(
            ((Date.now() - position.openedAt) / 60_000).toFixed(1),
          ),
          breakevenАктивен: position.breakevenArmed ? 'да' : 'нет',
          максимумПослеВхода: Number(position.highestPrice.toFixed(4)),
          минимумПослеВхода: Number(position.lowestPrice.toFixed(4)),
        })),
        экспозицияПоСтратегиям: Object.fromEntries(
          Object.entries(snapshot.exposureByStrategy).map(([strategyId, value]) => [
            strategyId,
            Number(value.toFixed(6)),
          ]),
        ),
      },
      рискМенеджмент: {
        ...this.riskManager.getRiskState(),
        режимВыхода: this.config.exitOnStrategySignal
          ? 'по_сигналу_стратегии'
          : 'только_по_стопам',
      },
      scannerTop: this.lastScanTop.map((item) => this.translateScannedSymbol(item)),
    };
  }

  async setExecutionMode(
    mode: 'paper' | 'live_testnet' | 'live_real',
    marketType: 'spot' | 'futures' | 'hybrid',
    confirmationPhrase?: string,
  ) {
    const result = await this.trader.setExecutionMode(
      mode,
      marketType,
      confirmationPhrase,
    );

    this.logger.logInfo('Обновление режима исполнения', {
      успех: result.success,
      режим: mode,
      рынок: marketType,
      сообщение: result.message,
    });

    return {
      ...result,
      snapshot: this.getDashboardSnapshot(),
    };
  }

  async refreshExecutionStatus() {
    const status = await this.trader.refreshExecutionStatus();

    this.logger.logInfo('Обновлён статус execution layer', {
      режим: status.mode,
      рынок: status.marketType,
      label: status.label,
      доступностьПодключения: status.accountConnectivity,
      свободныйБалансUSDT: status.quoteFree,
    });

    return {
      status,
      snapshot: this.getDashboardSnapshot(),
    };
  }

  async closePosition(
    symbol: string,
    strategyId: string,
    reason = 'Ручное закрытие позиции через dashboard',
  ) {
    const position = this.portfolio.getPosition(symbol, strategyId);

    if (!position) {
      return {
        closed: false,
        reason: 'Позиция не найдена',
        snapshot: this.getDashboardSnapshot(),
      };
    }

    this.logger.logInfo('Получена команда закрытия одной позиции', {
      символ: symbol,
      стратегия: position.strategyName,
      strategyId,
      сторона: position.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
      причина: reason,
    });

    const price = this.portfolio.getMarkPrice(position.symbol) ?? position.entryPrice;
    const execution =
      position.side === 'LONG'
        ? await this.trader.tryCloseLong(
            position.symbol,
            position.strategyId,
            price,
            Date.now(),
            reason,
          )
        : await this.trader.tryCloseShort(
            position.symbol,
            position.strategyId,
            price,
            Date.now(),
            reason,
          );

    const closed = this.handleExecutionResult(execution);
    const snapshot = this.getDashboardSnapshot();

    this.logger.logInfo(
      closed ? 'Позиция закрыта вручную' : 'Не удалось закрыть позицию вручную',
      {
        символ: symbol,
        стратегия: position.strategyName,
        strategyId,
        итоговыйБаланс: snapshot.portfolio.баланс,
        итоговыйКапитал: snapshot.portfolio.капитал,
      },
    );

    return {
      closed,
      reason: closed ? 'Позиция успешно закрыта' : 'Закрытие позиции не выполнено',
      snapshot,
    };
  }

  async emergencyCloseAllPositions(
    reason = 'Экстренное закрытие всех позиций через dashboard',
  ) {
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
          ? await this.trader.tryCloseLong(
              position.symbol,
              position.strategyId,
              price,
              Date.now(),
              reason,
            )
          : await this.trader.tryCloseShort(
              position.symbol,
              position.strategyId,
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

  async liquidateAllSpotAssets(
    reason = 'Ликвидация всех внешних spot-активов через dashboard',
  ) {
    this.logger.logInfo('Получена команда ликвидации всех внешних spot-активов', {
      причина: reason,
      execution: this.trader.getExecutionStatus().label,
    });

    const result = await this.trader.liquidateAllSpotAssets(reason);
    const refreshedStatus = await this.trader.refreshExecutionStatus();
    const snapshot = this.getDashboardSnapshot();

    this.logger.logInfo('Ликвидация внешних spot-активов завершена', {
      успех: result.success,
      проданоАктивов: result.soldAssets.length,
      пропущеноАктивов: result.skippedAssets.length,
      executionLabel: refreshedStatus.label,
    });

    return {
      ...result,
      status: refreshedStatus,
      snapshot,
    };
  }
}
