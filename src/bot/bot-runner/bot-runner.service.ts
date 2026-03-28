import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig, intervalToMs } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { Candle } from '../../market/types';
import {
  ScannedSymbol,
  SymbolScannerService,
} from '../../scanner/symbol-scanner/symbol-scanner.service';
import { HigherTimeframeConfirmationService } from '../../strategy/higher-timeframe-confirmation/higher-timeframe-confirmation.service';
import {
  RankedStrategyCandidate,
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

type AdaptiveIntervalAssessment = {
  interval: string;
  score: number;
  efficiency: number;
  trendQuality: number;
  atrPct: number;
  volumeAcceleration: number;
  sampleSize: number;
};

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
  private lastAdaptiveTimeframeSelection:
    | {
        selectedAt: number;
        executionInterval: string;
        confirmationInterval: string | null;
        sampleSymbols: string[];
        assessments: AdaptiveIntervalAssessment[];
        reason: string;
      }
    | null = null;

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
    await this.refreshAdaptiveTimeframe(initialUniverse);
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
      await this.refreshAdaptiveTimeframe(nextUniverse, top);
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

  private async refreshAdaptiveTimeframe(
    targetUniverse: string[],
    topCandidates: ScannedSymbol[] = this.lastScanTop,
  ) {
    if (!this.config.dynamicTimeframeEnabled) {
      return;
    }

    const openPositionsCount = this.portfolio.getOpenPositionsCount();
    if (openPositionsCount > 0) {
      return;
    }

    const decision = await this.selectAdaptiveTimeframe(targetUniverse, topCandidates);
    if (!decision) {
      return;
    }

    if (
      decision.executionInterval === this.activeInterval &&
      decision.confirmationInterval === this.confirmationInterval
    ) {
      this.lastAdaptiveTimeframeSelection = {
        ...decision,
        selectedAt: Date.now(),
      };
      return;
    }

    const previousActiveInterval = this.activeInterval;
    const previousConfirmationInterval = this.confirmationInterval;

    this.activeInterval = decision.executionInterval;
    this.confirmationInterval = decision.confirmationInterval;
    this.lastAdaptiveTimeframeSelection = {
      ...decision,
      selectedAt: Date.now(),
    };

    this.logger.logInfo('Адаптивный timeframe обновлён', {
      executionInterval: decision.executionInterval,
      confirmationInterval: decision.confirmationInterval ?? 'нет',
      прошлыйExecutionInterval: previousActiveInterval,
      прошлыйConfirmationInterval: previousConfirmationInterval ?? 'нет',
      sampleSymbols: decision.sampleSymbols,
      причина: decision.reason,
      оценки: decision.assessments.map((assessment) => ({
        интервал: assessment.interval,
        score: Number(assessment.score.toFixed(3)),
        efficiency: Number(assessment.efficiency.toFixed(3)),
        trendQuality: Number(assessment.trendQuality.toFixed(3)),
        atrPct: Number((assessment.atrPct * 100).toFixed(3)),
        volumeAccelerationPct: Number((assessment.volumeAcceleration * 100).toFixed(2)),
        sampleSize: assessment.sampleSize,
      })),
    });

    if (this.watchedSymbols.size === 0) {
      return;
    }

    for (const symbol of [...this.watchedSymbols]) {
      for (const strategy of this.strategyRegistry.getStrategies()) {
        strategy.resetSymbol(symbol, previousActiveInterval);
      }
      if (previousConfirmationInterval) {
        this.confirmation.resetSymbol(symbol, previousConfirmationInterval);
      }
      const preloaded = await this.preloadSymbolHistory(symbol);
      if (!preloaded) {
        this.watchedSymbols.delete(symbol);
        this.candlesWithoutPosition.delete(symbol);
        this.logger.logInfo(
          'Символ удалён из watched universe: не удалось перепрогреть историю после смены timeframe',
          {
            символ: symbol,
            executionInterval: this.activeInterval,
            confirmationInterval: this.confirmationInterval ?? 'нет',
          },
        );
      }
    }

    if (this.marketStarted) {
      this.replaceMarketStreams();
    }
  }

  private async selectAdaptiveTimeframe(
    targetUniverse: string[],
    topCandidates: ScannedSymbol[],
  ) {
    const candidateIntervals = this.getAdaptiveTimeframeCandidates();
    if (candidateIntervals.length === 0) {
      return null;
    }

    const sampleSymbols = [
      ...new Set([
        ...topCandidates.map((candidate) => candidate.symbol),
        ...targetUniverse,
      ]),
    ].slice(0, 3);

    if (sampleSymbols.length === 0) {
      return null;
    }

    const assessments: AdaptiveIntervalAssessment[] = [];
    for (const interval of candidateIntervals) {
      const intervalMetrics = (
        await Promise.all(
          sampleSymbols.map((symbol) => this.buildAdaptiveIntervalMetrics(symbol, interval)),
        )
      ).filter((value): value is Omit<AdaptiveIntervalAssessment, 'interval' | 'score' | 'sampleSize'> => value !== null);

      if (intervalMetrics.length === 0) {
        continue;
      }

      const efficiency = this.median(intervalMetrics.map((item) => item.efficiency));
      const trendQuality = this.median(intervalMetrics.map((item) => item.trendQuality));
      const atrPct = this.median(intervalMetrics.map((item) => item.atrPct));
      const volumeAcceleration = this.median(
        intervalMetrics.map((item) => item.volumeAcceleration),
      );
      const score =
        efficiency * 0.45 +
        trendQuality * 0.35 +
        this.clamp((volumeAcceleration + 0.2) / 0.8, 0, 1) * 0.1 +
        this.clamp(atrPct / 0.003, 0, 1) * 0.1;

      assessments.push({
        interval,
        score,
        efficiency,
        trendQuality,
        atrPct,
        volumeAcceleration,
        sampleSize: intervalMetrics.length,
      });
    }

    if (assessments.length === 0) {
      return null;
    }

    const selectedAssessment =
      assessments.find((assessment, index) =>
        assessment.score >= this.getAdaptiveThresholdForIndex(index),
      ) ?? assessments.at(-1)!;

    const selectedIndex = candidateIntervals.indexOf(selectedAssessment.interval);
    const confirmationInterval =
      selectedIndex >= 0 && selectedIndex < candidateIntervals.length - 1
        ? candidateIntervals[selectedIndex + 1]
        : candidateIntervals.length > 0
          ? this.getHigherConfirmationInterval(candidateIntervals.at(-1)!)
          : null;

    return {
      executionInterval: selectedAssessment.interval,
      confirmationInterval:
        confirmationInterval === selectedAssessment.interval ? null : confirmationInterval,
      sampleSymbols,
      assessments,
      reason:
        selectedAssessment === assessments.at(-1)
          ? 'Более быстрые интервалы не прошли порог качества сигнала, поэтому выбран более медленный execution timeframe'
          : 'Выбран самый быстрый timeframe, который проходит порог качества сигнала по эффективности и направленности рынка',
    };
  }

  private async buildAdaptiveIntervalMetrics(symbol: string, interval: string) {
    try {
      const candles = await this.market.loadHistoricalCandles(symbol, interval, 48);
      if (candles.length < 20) {
        return null;
      }

      const closes = candles.map((candle) => candle.close);
      const volumes = candles.map((candle) => candle.volume);
      const firstClose = closes[0];
      const lastClose = closes.at(-1) ?? firstClose;
      const netMovePct = firstClose > 0 ? Math.abs(lastClose - firstClose) / firstClose : 0;
      const pathLengthPct = closes.slice(1).reduce((sum, close, index) => {
        const prev = closes[index];
        return sum + (prev > 0 ? Math.abs(close - prev) / prev : 0);
      }, 0);
      const efficiency =
        pathLengthPct > 0 ? this.clamp(netMovePct / pathLengthPct, 0, 1) : 0;
      const atrPct = this.calculateAtrPct(candles);
      const trendQuality = this.clamp(netMovePct / Math.max(atrPct * 3, 0.0001), 0, 1);
      const recentVolume = this.average(volumes.slice(-5));
      const baselineVolume = this.average(volumes.slice(-15, -5));
      const volumeAcceleration =
        baselineVolume > 0 ? recentVolume / baselineVolume - 1 : 0;

      return {
        efficiency,
        trendQuality,
        atrPct,
        volumeAcceleration,
      };
    } catch {
      return null;
    }
  }

  private async syncUniverse(nextSymbols: string[]) {
    const normalized = [...new Set(nextSymbols)].filter(Boolean);
    const previousSymbols = [...this.watchedSymbols];
    const addedSymbols = normalized.filter((symbol) => !this.watchedSymbols.has(symbol));
    const removedSymbols = previousSymbols.filter(
      (symbol) => !normalized.includes(symbol) && !this.portfolio.hasOpenPosition(symbol),
    );

    for (const symbol of addedSymbols) {
      const preloaded = await this.preloadSymbolHistory(symbol);
      if (!preloaded) {
        this.logger.logInfo('Символ пропущен: не удалось безопасно прогреть историю', {
          символ: symbol,
          executionInterval: this.activeInterval,
          confirmationInterval: this.confirmationInterval ?? 'нет',
        });
        continue;
      }
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
    if (symbols.length === 0) {
      this.logger.logInfo('Старт отложен: нет символов с готовым warmup для подключения market streams');
      return;
    }

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
            this.shouldExecuteCloseSignal(result)
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
            if (!this.isSideAllowedByExecution('SHORT')) {
              tradeHappened =
                this.handleExecutionResult(
                  await this.trader.tryCloseLong(
                    candle.symbol,
                    strategy.id,
                    candle.close,
                    candle.closeTime,
                    `${result.reason}. Short недоступен в текущем execution-режиме, поэтому выполняем только закрытие long`,
                  ),
                ) || tradeHappened;
              continue;
            }

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
            this.shouldExecuteCloseSignal(result)
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
        const executionStatus = this.trader.getExecutionStatus();
        const rankedCandidates = this.strategyArbitration.rankCandidates(
          openCandidates,
          executionStatus,
        );
        const selectionDecision = this.strategyArbitration.selectCandidate(
          candle,
          openCandidates,
          executionStatus,
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

          const openedCandidate = await this.tryOpenRankedCandidates(
            candle,
            rankedCandidates,
          );
          if (openedCandidate) {
            if (
              openedCandidate.strategy.id !== selectedCandidate.strategy.id ||
              openedCandidate.side !== selectedCandidate.side
            ) {
              this.lastStrategySelection = {
                ...this.lastStrategySelection,
                selectedStrategyId: openedCandidate.strategy.id,
                selectedStrategyName: openedCandidate.strategy.name,
                selectedSide: openedCandidate.side,
                selectedScore: Number(openedCandidate.arbitrationScore.toFixed(2)),
                reason:
                  'Первый кандидат не прошёл проверку риска/исполнения, поэтому открыт следующий допустимый кандидат по приоритету',
                candidates: selectionDecision.candidates,
              };
              this.logger.logInfo('Использован запасной кандидат после отклонения лидера', {
                символ: candle.symbol,
                стратегия: openedCandidate.strategy.name,
                strategyId: openedCandidate.strategy.id,
                сторона: openedCandidate.side === 'LONG' ? 'ЛОНГ' : 'ШОРТ',
                arbitrationScore: Number(openedCandidate.arbitrationScore.toFixed(2)),
              });
            }

            tradeHappened = true;
          }
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

  private async tryOpenRankedCandidates(
    candle: Candle,
    rankedCandidates: RankedStrategyCandidate[],
  ) {
    for (const candidate of rankedCandidates) {
      if (!candidate.isAllowed) {
        continue;
      }

      const executed = await this.tryOpenWithRisk(
        candle,
        candidate.strategy,
        candidate.side,
        candidate.result.reason,
      );
      if (executed) {
        return candidate;
      }
    }

    return null;
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

  private async preloadSymbolHistory(symbol: string): Promise<boolean> {
    try {
      const requiredWarmupCandles = this.getRequiredWarmupCandles();
      const preloadCandles = Math.max(requiredWarmupCandles + 30, 60);
      const candles = await this.market.loadHistoricalCandles(
        symbol,
        this.activeInterval,
        preloadCandles,
      );
      if (candles.length < requiredWarmupCandles) {
        throw new Error(
          `Недостаточно execution history для прогрева: получено ${candles.length}, требуется минимум ${requiredWarmupCandles}`,
        );
      }
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
        if (confirmationCandles.length < confirmationWarmupCandles) {
          throw new Error(
            `Недостаточно higher-timeframe history для прогрева: получено ${confirmationCandles.length}, требуется минимум ${confirmationWarmupCandles}`,
          );
        }
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
      return false;
    }

    return true;
  }

  private getRequiredWarmupCandles() {
    const strategies = this.strategyRegistry.getStrategies();

    if (strategies.length === 0) {
      return 0;
    }

    return Math.max(...strategies.map((strategy) => strategy.getRequiredWarmupCandles()));
  }

  private getAdaptiveTimeframeCandidates() {
    return [...new Set(this.config.dynamicTimeframeCandidates)]
      .filter(Boolean)
      .sort((left, right) => intervalToMs(left) - intervalToMs(right));
  }

  private getAdaptiveThresholdForIndex(index: number) {
    if (index <= 0) {
      return 0.58;
    }
    if (index === 1) {
      return 0.46;
    }
    return 0;
  }

  private getHigherConfirmationInterval(interval: string) {
    const orderedIntervals = ['3m', '5m', '15m', '30m', '1h', '4h'];
    const currentIndex = orderedIntervals.indexOf(interval);
    if (currentIndex === -1 || currentIndex === orderedIntervals.length - 1) {
      return null;
    }

    return orderedIntervals[currentIndex + 1];
  }

  private calculateAtrPct(candles: Candle[]) {
    if (candles.length < 2) {
      return 0;
    }

    const recent = candles.slice(-14);
    const ranges = recent.map((candle, index) => {
      const prevClose =
        index === 0 ? recent[0].close : recent[index - 1].close;
      const tr = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevClose),
        Math.abs(candle.low - prevClose),
      );
      return candle.close > 0 ? tr / candle.close : 0;
    });

    return this.average(ranges);
  }

  private average(values: number[]) {
    if (values.length === 0) {
      return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private median(values: number[]) {
    if (values.length === 0) {
      return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
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

    const confirmation = this.confirmation.getTrend(symbol, this.confirmationInterval);

    if (strategy.id === 'mean_reversion') {
      return this.applyMeanReversionHigherTimeframeGuard(result, confirmation);
    }

    if (strategy.getConfirmationPolicy() === 'none') {
      return result;
    }
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
          forceClose: true,
          reason: `${result.reason}. Старший таймфрейм ещё не готов подтвердить long, поэтому закрываем шорт без переворота`,
        };
      }

      if (signal === 'REVERSE_TO_SHORT') {
        return {
          ...result,
          signal: 'CLOSE_LONG',
          forceClose: true,
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
          forceClose: true,
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
          forceClose: true,
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

  private applyMeanReversionHigherTimeframeGuard(
    result: StrategyResult,
    confirmation: {
      isReady: boolean;
      trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
      trendStrengthPct?: number;
    },
  ): StrategyResult {
    const signal = result.signal;
    const trendStrengthPct = confirmation.trendStrengthPct ?? 0;
    const strongHigherTimeframeTrend =
      confirmation.isReady &&
      trendStrengthPct >= this.config.meanReversionMaxHigherTimeframeTrendPct;

    if (!strongHigherTimeframeTrend) {
      return result;
    }

    if (
      (signal === 'OPEN_SHORT' || signal === 'REVERSE_TO_SHORT') &&
      confirmation.trend === 'BULLISH'
    ) {
      if (signal === 'REVERSE_TO_SHORT') {
        return {
          ...result,
          signal: 'CLOSE_LONG',
          forceClose: true,
          reason: `${result.reason}. Mean reversion не переворачивает позицию в short против сильного bullish higher timeframe`,
        };
      }

      return {
        ...result,
        signal: 'HOLD',
        reason: `${result.reason}. Mean reversion пропускает short против сильного bullish higher timeframe`,
      };
    }

    if (
      (signal === 'OPEN_LONG' || signal === 'REVERSE_TO_LONG') &&
      confirmation.trend === 'BEARISH'
    ) {
      if (signal === 'REVERSE_TO_LONG') {
        return {
          ...result,
          signal: 'CLOSE_SHORT',
          forceClose: true,
          reason: `${result.reason}. Mean reversion не переворачивает позицию в long против сильного bearish higher timeframe`,
        };
      }

      return {
        ...result,
        signal: 'HOLD',
        reason: `${result.reason}. Mean reversion пропускает long против сильного bearish higher timeframe`,
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

  private shouldExecuteCloseSignal(result: StrategyResult) {
    return this.config.exitOnStrategySignal || result.forceClose === true;
  }

  private isSideAllowedByExecution(side: 'LONG' | 'SHORT') {
    if (side === 'LONG') {
      return true;
    }

    return this.trader.getExecutionStatus().canTradeShort;
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
      timeframeSelection: this.lastAdaptiveTimeframeSelection
        ? {
            режим: this.config.dynamicTimeframeEnabled ? 'adaptive' : 'static',
            executionInterval: this.lastAdaptiveTimeframeSelection.executionInterval,
            confirmationInterval:
              this.lastAdaptiveTimeframeSelection.confirmationInterval ?? 'нет',
            selectedAt: this.lastAdaptiveTimeframeSelection.selectedAt,
            sampleSymbols: this.lastAdaptiveTimeframeSelection.sampleSymbols,
            reason: this.lastAdaptiveTimeframeSelection.reason,
            assessments: this.lastAdaptiveTimeframeSelection.assessments.map((assessment) => ({
              interval: assessment.interval,
              score: Number(assessment.score.toFixed(3)),
              efficiency: Number(assessment.efficiency.toFixed(3)),
              trendQuality: Number(assessment.trendQuality.toFixed(3)),
              atrPct: Number((assessment.atrPct * 100).toFixed(3)),
              volumeAccelerationPct: Number((assessment.volumeAcceleration * 100).toFixed(2)),
              sampleSize: assessment.sampleSize,
            })),
          }
        : {
            режим: this.config.dynamicTimeframeEnabled ? 'adaptive' : 'static',
            executionInterval: this.activeInterval,
            confirmationInterval: this.confirmationInterval ?? 'нет',
            selectedAt: null,
            sampleSymbols: [],
            reason: this.config.dynamicTimeframeEnabled
              ? 'Адаптивный timeframe ещё не вычислялся'
              : 'Используется статический timeframe из конфига',
            assessments: [],
          },
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
