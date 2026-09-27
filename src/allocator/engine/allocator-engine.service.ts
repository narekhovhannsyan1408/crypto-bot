import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { AppLogger } from '../../observability/app-logger';
import {
  errorMsg,
  LocalizedError,
  Msg,
  msg,
  MsgParam,
  ru,
} from '../../i18n/messages';
import { newId, runWithLogContext } from '../../observability/log-context';
import { SolanaProofService } from '../../solana/solana-proof.service';
import {
  buildTokenRegistry,
  SolanaToken,
  unsupportedAssets,
} from '../../solana/solana-tokens';
import {
  AllocatorMode,
  hasExternalAccount,
  isSolanaMode,
  quoteAssetOf,
  venueOf,
} from '../allocator-mode';
import {
  AllocatorBroker,
  AllocatorFill,
  baseAssetOf,
} from '../brokers/allocator-broker';
import { BrokerFactory } from '../brokers/broker.factory';
import {
  planRebalance,
  RebalanceOrder,
  RebalancePlan,
} from '../domain/rebalance-planner';
import { appendActivity, appendEquityPoint } from '../session/session-helpers';
import { SessionStore } from '../session/session-store';
import { AllocatorSession, SignalSnapshot } from '../session/session.types';
import {
  AppState,
  buildAppState,
  buildChart,
  buildLegacySnapshot,
  ChartRange,
  PRICES_STALE_MS,
  Readiness,
  sessionEquity,
  SolanaInfo,
} from './app-state.view';
import {
  describeAutoStopReason,
  describeDecisionFailure,
  describeHoldingDecision,
  describeProof,
  describeReconcile,
  describeSellAll,
  describeStart,
  describeStop,
  explainOrder,
  modeLabelMsg,
  Narration,
} from './narrator';
import { SignalService } from './signal.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const EQUITY_POINT_INTERVAL_MS = 15 * 60_000;
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const STRATEGY_NAME = 'Trend Allocator';
export const MIN_CAPITAL_USDT = 100;
const MAX_PAPER_CAPITAL_USDT = 10_000_000;

export type StartOptions = {
  mode: AllocatorMode;
  capitalUsdt: number;
  // 0 — без автозащиты, 0.3 — продать всё при потере 30% от стартового капитала
  autoStopLossPct: number;
};

// message — ключ словаря: страница показывает его на выбранном языке
export type ActionResult = { success: boolean; message: Msg };

const lastClosedDay = (now: number) =>
  Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const rejected = (
  key: string,
  params?: Record<string, MsgParam>,
): ActionResult => ({ success: false, message: msg(key, params) });

/**
 * Жизненный цикл бота: запуск и остановка сессии, ежедневное решение по тренду,
 * автозащита и восстановление после перезапуска процесса.
 *
 * Все операции, меняющие сессию, выполняются строго по очереди (exclusive),
 * поэтому остановка не может пересечься с ребалансировкой.
 *
 * Журнал: каждая операция получает op/opId, а события внутри — sessionId и mode.
 * Имена событий начинаются с allocator.* (см. CLAUDE.md).
 */
@Injectable()
export class AllocatorEngine implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private readonly settings = this.config.allocator;
  private broker: AllocatorBroker | null = null;
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private activeTasks = 0;
  private tickInFlight = false;
  private prices: Record<string, number> = {};
  private pricesAt = 0;
  private lastError: Msg | null = null;
  private retry = { day: 0, failures: 0, nextAttemptAt: 0 };
  private staleAutoStopReported = false;
  private tokens?: {
    registry: Record<string, SolanaToken> | null;
    problem: Msg | null;
  };

  constructor(
    private readonly logger: BotLoggerService,
    private readonly journal: AppLogger,
    private readonly store: SessionStore,
    private readonly brokers: BrokerFactory,
    private readonly signals: SignalService,
    private readonly proof: SolanaProofService,
  ) {}

  onModuleDestroy() {
    this.clearTimer();
  }

  private get session() {
    return this.store.getCurrent();
  }

  /** Продолжает работу после перезапуска процесса, если сессия была запущена. */
  resumeIfRunning() {
    return this.operation('resume', async () => {
      const session = this.session;
      if (!session || session.status !== 'running') {
        this.logger.logInfo(
          'Бот ожидает запуска из веб-интерфейса',
          undefined,
          null,
        );
        this.journal.info(
          'allocator.idle',
          'Нет запущенной сессии, бот ждёт запуска',
          {
            lastSessionStatus: session?.status ?? null,
          },
        );
        return;
      }
      if (session.mode === 'live_real' && !this.config.allowLiveReal) {
        this.lastError = msg('resume.blockedLive');
        this.logger.logError(
          ru(this.lastError),
          undefined,
          'allocator.session.resume_blocked',
        );
        return;
      }
      if (session.mode === 'solana_real' && !this.config.solana.allowReal) {
        this.lastError = msg('resume.blockedSolana');
        this.logger.logError(
          ru(this.lastError),
          undefined,
          'allocator.session.resume_blocked',
        );
        return;
      }

      const broker = this.brokers.get(session.mode);
      this.broker = broker;
      await this.exclusive(async () => {
        try {
          const balances = await broker.getFreeBalances(this.settings.assets);
          if (balances) {
            this.reconcileWithExchange(session, balances);
          }
        } catch (error) {
          this.fail(
            'allocator.reconcile.failed',
            'Не удалось сверить баланс с биржей',
            error,
          );
        }
      });

      this.logger.logInfo(
        'Работа бота возобновлена после перезапуска',
        {
          режим: ru(modeLabelMsg(session.mode)),
          стартовыйКапитал: session.initialCapital,
          последнееРешение: session.lastRebalanceDay
            ? isoDay(session.lastRebalanceDay)
            : null,
          cash: session.cash,
          quantities: session.quantities,
        },
        'allocator.session.resumed',
      );
      this.schedule();
      await this.tick();
    });
  }

  start(options: StartOptions): Promise<ActionResult> {
    return this.operation('start', async () => {
      this.journal.info(
        'allocator.session.start_requested',
        'Запрос на запуск бота',
        options,
      );
      const result = await this.exclusive(() => this.startSession(options));
      if (!result.success) {
        this.journal.warn(
          'allocator.session.start_rejected',
          ru(result.message),
          options,
        );
      }
      return result;
    });
  }

  stop(
    reason: Msg = msg('stop.reason.user'),
    kind: 'stop' | 'autostop' = 'stop',
  ): Promise<ActionResult> {
    return this.operation(kind, () =>
      this.exclusive(() => this.stopSession(reason, kind)),
    );
  }

  /** Регулярная проверка: ежедневное решение, цены, точка графика и автозащита. */
  async tick(now = Date.now()) {
    if (this.tickInFlight) {
      this.journal.debug(
        'allocator.tick.skipped',
        'Предыдущая проверка ещё идёт',
      );
      return;
    }
    this.tickInFlight = true;
    try {
      await this.operation('tick', async () => {
        await this.exclusive(async () => {
          const session = this.session;
          if (session?.status === 'running') {
            await this.runCycle(session, now);
          }
        });
        await this.checkAutoStop();
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  rebalanceNow(): Promise<ActionResult> {
    return this.operation('manual_rebalance', () =>
      this.exclusive(async () => {
        const session = this.session;
        if (!session || session.status !== 'running') {
          return rejected('action.notRunning');
        }
        const now = Date.now();
        await this.rebalance(session, lastClosedDay(now), now);
        return { success: true, message: msg('action.rebalanced') };
      }),
    );
  }

  isRunning() {
    return this.session?.status === 'running';
  }

  async refreshPricesIfStale(maxAgeMs = 30_000) {
    if (
      this.session?.status !== 'running' ||
      this.activeTasks > 0 ||
      Date.now() - this.pricesAt < maxAgeMs
    ) {
      return;
    }
    await this.exclusive(() => this.refreshPrices()).catch((error: unknown) =>
      this.journal.debug(
        'allocator.prices.ui_refresh_failed',
        'Не удалось обновить цены для страницы',
        {
          error: describeError(error),
        },
      ),
    );
  }

  getModeReadiness(mode: AllocatorMode): Readiness {
    const missing: Msg[] = [];
    if (isSolanaMode(mode)) {
      missing.push(...this.solanaTokenProblems());
    }
    if (mode === 'solana_real') {
      const wallet = this.brokers.solanaWallet();
      if (wallet.problem) {
        missing.push(wallet.problem);
      } else if (!wallet.address) {
        missing.push(msg('err.solana.noWallet'));
      }
      if (!this.config.solana.allowReal) {
        missing.push(msg('ready.solanaFlag'));
      }
    }
    if (mode === 'live_real') {
      if (!this.config.binanceApiKey || !this.config.binanceApiSecret) {
        missing.push(msg('ready.binanceKeys'));
      }
      if (!this.config.allowLiveReal) {
        missing.push(msg('ready.liveFlag'));
      }
    }
    if (
      mode === 'live_testnet' &&
      (!this.config.binanceTestnetApiKey ||
        !this.config.binanceTestnetApiSecret)
    ) {
      missing.push(msg('ready.demoKeys'));
    }
    return { available: missing.length === 0, missing };
  }

  async getAvailableBalance(mode: AllocatorMode) {
    const quoteAsset = quoteAssetOf(mode);
    if (!hasExternalAccount(mode)) {
      return {
        success: true,
        freeUsdt: null as number | null,
        quoteAsset,
        message: null as Msg | null,
      };
    }
    const readiness = this.getModeReadiness(mode);
    if (!readiness.available) {
      return {
        success: false,
        freeUsdt: null,
        quoteAsset,
        message: msg('ready.missing', { items: readiness.missing }),
      };
    }
    try {
      const broker = this.brokers.get(mode);
      const balances = await broker.getFreeBalances(this.settings.assets);
      return {
        success: true,
        freeUsdt: balances?.[broker.quoteAsset] ?? 0,
        quoteAsset,
        message: null,
      };
    } catch (error) {
      this.journal.warn(
        'allocator.balance.failed',
        `Не удалось получить баланс ${venueOf(mode)}`,
        { mode },
        error,
      );
      return {
        success: false,
        freeUsdt: null,
        quoteAsset,
        message: msg('action.connectFailed', {
          venue: venueOf(mode),
          error: errorMsg(error),
        }),
      };
    }
  }

  getAppState(activityLimit = 30): AppState {
    return buildAppState({
      strategyMode: this.config.strategyMode,
      session: this.session,
      history: this.store.getHistory(),
      prices: this.prices,
      pricesAt: this.pricesAt,
      lastError: this.lastError,
      busy: this.activeTasks > 0,
      readiness: {
        paper: this.getModeReadiness('paper'),
        live_testnet: this.getModeReadiness('live_testnet'),
        live_real: this.getModeReadiness('live_real'),
        solana_sim: this.getModeReadiness('solana_sim'),
        solana_real: this.getModeReadiness('solana_real'),
      },
      solana: this.getSolanaInfo(),
      assets: this.settings.assets,
      smaPeriods: this.settings.smaPeriods,
      params: {
        rebalanceThresholdPct: this.settings.rebalanceThresholdPct,
        volTarget: this.settings.volTarget,
        minOrderUsdt: this.settings.minOrderUsdt,
        checkIntervalMs: this.settings.checkIntervalMs,
        slippageBps: this.config.solana.slippageBps,
      },
      minCapital: MIN_CAPITAL_USDT,
      now: Date.now(),
      activityLimit,
    });
  }

  getSolanaInfo(): SolanaInfo {
    const { registry } = this.tokenRegistry();
    return {
      walletAddress: this.brokers.solanaWallet().address,
      quoteAsset: quoteAssetOf('solana_sim'),
      tokens: this.settings.assets.flatMap((symbol) => {
        const base = baseAssetOf(symbol);
        const token = registry?.[base];
        return token ? [{ base, symbol: token.symbol, mint: token.mint }] : [];
      }),
      proof: this.proof.status(),
    };
  }

  getChart(range: ChartRange) {
    return buildChart(this.session, range);
  }

  getLegacySnapshot() {
    return buildLegacySnapshot(this.getAppState(), this.settings.smaPeriods);
  }

  // ---------- операции ----------

  private async startSession(options: StartOptions): Promise<ActionResult> {
    if (this.session?.status === 'running') {
      return rejected('action.alreadyRunning');
    }

    const capital = Number(options.capitalUsdt);
    const autoStop = Number(options.autoStopLossPct);
    const quoteAsset = quoteAssetOf(options.mode);
    const venue = venueOf(options.mode);
    if (!Number.isFinite(capital) || capital < MIN_CAPITAL_USDT) {
      return rejected('action.minCapital', {
        amount: MIN_CAPITAL_USDT,
        quote: quoteAsset,
      });
    }
    if (!hasExternalAccount(options.mode) && capital > MAX_PAPER_CAPITAL_USDT) {
      return rejected('action.paperTooLarge');
    }
    if (!Number.isFinite(autoStop) || autoStop < 0 || autoStop >= 1) {
      return rejected('action.badAutostop');
    }

    const readiness = this.getModeReadiness(options.mode);
    if (!readiness.available) {
      return rejected('ready.missing', { items: readiness.missing });
    }

    const broker = this.brokers.get(options.mode);
    if (hasExternalAccount(options.mode)) {
      try {
        const balances = await broker.getFreeBalances(this.settings.assets);
        const freeQuote = balances?.[broker.quoteAsset] ?? 0;
        if (capital > freeQuote) {
          return rejected('action.notEnoughFree', {
            amount: freeQuote,
            quote: quoteAsset,
            venue,
          });
        }
        await broker.assertCanTrade?.();
      } catch (error) {
        this.journal.warn(
          'allocator.balance.failed',
          'Не удалось проверить баланс при запуске',
          undefined,
          error,
        );
        return rejected('action.connectFailed', {
          venue,
          error: errorMsg(error),
        });
      }
    }

    const now = Date.now();
    const session: AllocatorSession = {
      id: `${now}`,
      mode: options.mode,
      status: 'running',
      startedAt: now,
      stoppedAt: null,
      stopReason: null,
      initialCapital: capital,
      autoStopLossPct: autoStop,
      cash: capital,
      quantities: Object.fromEntries(
        this.settings.assets.map((symbol) => [symbol, 0]),
      ),
      feesPaid: 0,
      lastRebalanceDay: null,
      lastSignals: [],
      benchmarkStartPrices: null,
      equityHistory: [{ timestamp: now, equity: capital }],
      activity: [],
    };
    appendActivity(session, {
      kind: 'start',
      ...describeStart(options.mode, capital, autoStop),
    });

    this.broker = broker;
    this.prices = {};
    this.pricesAt = 0;
    this.lastError = null;
    this.retry = { day: 0, failures: 0, nextAttemptAt: 0 };
    this.staleAutoStopReported = false;
    this.store.saveCurrent(session);

    return runWithLogContext(
      { sessionId: session.id, mode: session.mode },
      async () => {
        this.logger.logInfo(
          'Бот запущен из веб-интерфейса',
          {
            режим: ru(modeLabelMsg(options.mode)),
            капиталUSDT: capital,
            автозащита: autoStop > 0 ? `−${autoStop * 100}%` : 'выключена',
            assets: this.settings.assets,
            smaPeriods: this.settings.smaPeriods,
          },
          'allocator.session.started',
        );

        this.schedule();
        await this.runCycle(session, Date.now());
        if (this.hasFreshPrices()) {
          session.benchmarkStartPrices = { ...this.prices };
          this.store.saveCurrent(session);
        }
        return { success: true, message: msg('action.started') };
      },
    );
  }

  private async stopSession(
    reason: Msg,
    kind: 'stop' | 'autostop',
  ): Promise<ActionResult> {
    const session = this.session;
    if (!session || session.status !== 'running') {
      return rejected('action.notRunning');
    }

    // Сессия могла не возобновиться после перезапуска — остановить её всё равно можно
    this.broker ??= this.brokers.get(session.mode);
    this.clearTimer();
    const unsold = await this.sellEverything(session, reason);
    await this.refreshPrices().catch((error: unknown) =>
      this.fail(
        'allocator.prices.refresh_failed',
        'Не удалось обновить цены при остановке',
        error,
      ),
    );
    const equity = this.equity(session);
    const now = Date.now();
    session.status = 'stopped';
    session.stoppedAt = now;
    session.stopReason = ru(reason);
    session.stopReasonMsg = reason;
    appendEquityPoint(
      session.equityHistory,
      { timestamp: now, equity },
      0,
      true,
    );
    appendActivity(session, {
      kind,
      ...describeStop(
        kind === 'autostop',
        reason,
        equity,
        session.initialCapital,
        unsold,
      ),
    });
    this.store.saveCurrent(session);
    this.store.addToHistory({
      id: session.id,
      mode: session.mode,
      startedAt: session.startedAt,
      stoppedAt: now,
      initialCapital: session.initialCapital,
      finalEquity: equity,
      stopReason: ru(reason),
      stopReasonMsg: reason,
    });
    this.logger.logInfo(
      kind === 'autostop' ? 'Сработала автозащита' : 'Бот остановлен',
      {
        причина: ru(reason),
        итогUSDT: round(equity),
        initialCapital: session.initialCapital,
        cash: session.cash,
        quantities: session.quantities,
        unsold,
      },
      kind === 'autostop'
        ? 'allocator.session.autostopped'
        : 'allocator.session.stopped',
    );

    if (unsold.length) {
      this.journal.error(
        'allocator.session.stop_unsold',
        'Остановлено, но часть монет не продана',
        undefined,
        { unsold, quantities: session.quantities },
      );
      return rejected('action.stoppedUnsold', {
        assets: unsold,
        venue: venueOf(session.mode),
      });
    }
    return {
      success: true,
      message: msg('action.stopped', { quote: quoteAssetOf(session.mode) }),
    };
  }

  // ---------- внутреннее ----------

  /** Контекст журнала для операции: op, opId, текущая сессия. */
  private operation<T>(op: string, task: () => Promise<T>): Promise<T> {
    // Остановленная сессия не относится к новой операции (например, к новому запуску)
    const session = this.session?.status === 'running' ? this.session : null;
    return runWithLogContext(
      { op, opId: newId(op), sessionId: session?.id, mode: session?.mode },
      task,
    );
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.activeTasks += 1;
      try {
        return await task();
      } finally {
        this.activeTasks -= 1;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private schedule() {
    this.clearTimer();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.settings.checkIntervalMs);
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runCycle(session: AllocatorSession, now: number) {
    const startedAt = performance.now();
    const day = lastClosedDay(now);
    const needsDecision = session.lastRebalanceDay !== day;
    if (needsDecision) {
      if (this.canAttemptRebalance(day, now)) {
        try {
          await this.rebalance(session, day, now);
        } catch (error) {
          this.registerRebalanceFailure(session, day, now, error);
        }
      } else {
        this.journal.debug(
          'allocator.rebalance.deferred',
          'Ждём паузу перед повторной попыткой',
          {
            day: isoDay(day),
            failures: this.retry.failures,
            nextAttemptAt: new Date(this.retry.nextAttemptAt).toISOString(),
          },
        );
      }
    }

    try {
      await this.refreshPrices();
      appendEquityPoint(
        session.equityHistory,
        { timestamp: now, equity: this.equity(session) },
        EQUITY_POINT_INTERVAL_MS,
      );
      this.store.saveCurrent(session);
      const equity = this.equity(session);
      this.logger.logPortfolio({
        стратегия: STRATEGY_NAME,
        капитал: round(equity),
        баланс: round(session.cash),
        результатВПроцентах: round((equity / session.initialCapital - 1) * 100),
      });
    } catch (error) {
      this.fail(
        'allocator.prices.refresh_failed',
        'Не удалось обновить цены',
        error,
      );
    }

    this.journal.log(
      'debug',
      'allocator.cycle.completed',
      'Проверка завершена',
      {
        durationMs: performance.now() - startedAt,
        data: {
          decisionDay: isoDay(day),
          decisionDone: session.lastRebalanceDay === day,
          equity: round(this.equity(session)),
          cash: round(session.cash),
          quantities: session.quantities,
          prices: this.prices,
          pricesAgeMs: this.pricesAt ? Date.now() - this.pricesAt : null,
          lastError: this.lastError,
        },
      },
    );
  }

  private canAttemptRebalance(day: number, now: number) {
    if (this.retry.day !== day) {
      this.retry = { day, failures: 0, nextAttemptAt: 0 };
    }
    return now >= this.retry.nextAttemptAt;
  }

  // Повтор с нарастающей паузой: сбой связи в полночь не должен пропускать весь день
  private registerRebalanceFailure(
    session: AllocatorSession,
    day: number,
    now: number,
    error: unknown,
  ) {
    this.retry.failures += 1;
    const delay = Math.min(
      RETRY_BASE_MS * 2 ** (this.retry.failures - 1),
      RETRY_MAX_MS,
    );
    this.retry.nextAttemptAt = now + delay;
    this.lastError = errorMsg(error);
    this.logger.logError('Не удалось принять ежедневное решение', error, null);
    this.journal.warn(
      'allocator.rebalance.failed',
      'Не удалось принять ежедневное решение, будет повтор',
      {
        day: isoDay(day),
        failures: this.retry.failures,
        nextAttemptAt: new Date(this.retry.nextAttemptAt).toISOString(),
      },
      error,
    );
    if (this.retry.failures === 1) {
      appendActivity(session, {
        kind: 'error',
        ...describeDecisionFailure(errorMsg(error)),
      });
      this.store.saveCurrent(session);
    }
  }

  private async rebalance(session: AllocatorSession, day: number, now: number) {
    const startedAt = performance.now();
    const broker = this.broker!;
    const assets = this.settings.assets;
    this.journal.info(
      'allocator.rebalance.started',
      'Ежедневное решение: старт',
      {
        day: isoDay(day),
        attempt: this.retry.failures + 1,
      },
    );

    const signals = await this.signals.computeSignals(
      assets,
      this.settings,
      day,
      now,
    );
    this.journal.info(
      'allocator.rebalance.signals',
      'Сигналы тренда рассчитаны',
      {
        day: isoDay(day),
        signals,
      },
    );
    await this.refreshPrices();

    const allocationPerAsset = 1 / assets.length;
    const minOrderUsdt = Math.max(
      this.settings.minOrderUsdt,
      ...(await Promise.all(
        assets.map((symbol) => broker.getMinOrderUsdt(symbol)),
      )),
    );
    const targetWeights = Object.fromEntries(
      signals.map((signal) => [
        signal.symbol,
        signal.exposure * allocationPerAsset,
      ]),
    );
    const plan = planRebalance({
      cash: session.cash,
      holdings: assets.map((symbol) => ({
        symbol,
        quantity: session.quantities[symbol] ?? 0,
        price: this.prices[symbol],
      })),
      targetWeights,
      rebalanceThresholdPct: this.settings.rebalanceThresholdPct,
      minOrderUsdt,
      allocationPerAsset,
    });
    this.journal.info(
      'allocator.rebalance.plan',
      `План: ордеров ${plan.orders.length}`,
      {
        equity: plan.equity,
        cash: session.cash,
        quantities: session.quantities,
        prices: this.prices,
        targetWeights,
        minOrderUsdt,
        orders: plan.orders,
        skipped: plan.skipped,
      },
    );
    this.logger.logInfo(
      'Ежедневное решение бота',
      {
        день: isoDay(day),
        капитал: round(plan.equity),
        сигналы: signals.map((signal) => ({
          символ: signal.symbol,
          закрытие: signal.close,
          целеваяДоляВМонете: `${(signal.exposure * 100).toFixed(0)}%`,
        })),
        ордеров: plan.orders.length,
      },
      null,
    );

    const smaCount = this.settings.smaPeriods.length;
    const quoteAsset = broker.quoteAsset;
    await this.publishDecision(session, day, signals, targetWeights, plan);

    const previousSignals = session.lastSignals;
    const failedOrders: Msg[] = [];
    for (const order of plan.orders) {
      try {
        const fill =
          order.side === 'SELL'
            ? await broker.sell(
                order.symbol,
                Math.min(order.quantity, session.quantities[order.symbol] ?? 0),
              )
            : await broker.buy(
                order.symbol,
                Math.min(order.quoteAmount, session.cash),
              );
        this.applyFill(session, fill);
        const signal = signals.find((item) => item.symbol === order.symbol)!;
        const previous = previousSignals.find(
          (item) => item.symbol === order.symbol,
        );
        this.recordFill(
          session,
          fill,
          explainOrder(order, signal, previous, smaCount, quoteAsset),
          order,
        );
      } catch (error) {
        failedOrders.push(
          msg('err.orderItem', {
            side: msg(order.side === 'BUY' ? 'side.buy' : 'side.sell'),
            base: baseAssetOf(order.symbol),
            error: errorMsg(error),
          }),
        );
        this.logger.logError(
          `Не удалось исполнить ордер ${order.side} ${order.symbol}`,
          error,
          null,
        );
        this.journal.error(
          'allocator.order.failed',
          `Ордер ${order.side} ${order.symbol} не исполнен`,
          error,
          {
            order,
            cash: session.cash,
            quantity: session.quantities[order.symbol] ?? 0,
          },
        );
      }
    }

    if (plan.orders.length === 0) {
      appendActivity(session, {
        kind: 'check',
        ...describeHoldingDecision(
          signals,
          assets.length,
          smaCount,
          quoteAsset,
        ),
      });
    }
    session.lastSignals = signals;
    this.store.saveCurrent(session);

    if (failedOrders.length > 0) {
      throw new LocalizedError(
        msg('err.ordersFailed', { items: failedOrders }),
      );
    }
    session.lastRebalanceDay = day;
    this.retry.failures = 0;
    this.lastError = null;
    this.store.saveCurrent(session);
    this.journal.log(
      'info',
      'allocator.rebalance.completed',
      'Ежедневное решение принято',
      {
        durationMs: performance.now() - startedAt,
        data: {
          day: isoDay(day),
          orders: plan.orders.length,
          equity: round(this.equity(session)),
          cash: round(session.cash),
          quantities: session.quantities,
        },
      },
    );
  }

  private hasFreshPrices() {
    return (
      Date.now() - this.pricesAt < PRICES_STALE_MS &&
      this.settings.assets.every((symbol) => (this.prices[symbol] ?? 0) > 0)
    );
  }

  private async checkAutoStop() {
    const session = this.session;
    if (
      !session ||
      session.status !== 'running' ||
      session.autoStopLossPct <= 0
    ) {
      return;
    }
    // Без свежих цен капитал считается неверно — нельзя из-за сбоя связи продать всё
    if (!this.hasFreshPrices()) {
      if (!this.staleAutoStopReported) {
        this.staleAutoStopReported = true;
        this.journal.warn(
          'allocator.autostop.skipped_stale_prices',
          'Автозащита пропущена: нет свежих цен',
          {
            pricesAgeMs: this.pricesAt ? Date.now() - this.pricesAt : null,
            prices: this.prices,
          },
        );
      }
      return;
    }
    this.staleAutoStopReported = false;

    const equity = this.equity(session);
    const threshold = session.initialCapital * (1 - session.autoStopLossPct);
    this.journal.trace('allocator.autostop.checked', 'Проверка автозащиты', {
      equity,
      threshold,
    });
    if (equity > threshold) {
      return;
    }
    this.journal.warn(
      'allocator.autostop.triggered',
      'Капитал ниже порога автозащиты',
      {
        equity,
        threshold,
        prices: this.prices,
        quantities: session.quantities,
        cash: session.cash,
      },
    );
    await this.stop(
      describeAutoStopReason(equity, threshold, session.autoStopLossPct),
      'autostop',
    );
  }

  private async sellEverything(session: AllocatorSession, reason: Msg) {
    const unsold: string[] = [];
    for (const symbol of this.settings.assets) {
      const quantity = session.quantities[symbol] ?? 0;
      if (quantity <= 0) continue;
      try {
        const fill = await this.broker!.sell(symbol, quantity);
        this.applyFill(session, fill);
        this.recordFill(
          session,
          fill,
          describeSellAll(symbol, reason, this.broker!.quoteAsset),
        );
      } catch (error) {
        unsold.push(baseAssetOf(symbol));
        this.logger.logError(
          `Не удалось продать ${symbol} при остановке`,
          error,
          null,
        );
        this.journal.error(
          'allocator.order.failed',
          `Не удалось продать ${symbol} при остановке`,
          error,
          {
            symbol,
            quantity,
          },
        );
      }
    }
    return unsold;
  }

  // Если средства ушли с биржи вручную, сессия не может считать их своими
  private reconcileWithExchange(
    session: AllocatorSession,
    balances: Record<string, number>,
  ) {
    const adjustments: string[] = [];
    const before = {
      cash: session.cash,
      quantities: { ...session.quantities },
    };
    for (const symbol of this.settings.assets) {
      const free = balances[baseAssetOf(symbol)] ?? 0;
      const owned = session.quantities[symbol] ?? 0;
      if (owned > free) {
        adjustments.push(`${baseAssetOf(symbol)}: ${owned} → ${free}`);
        session.quantities[symbol] = free;
      }
    }
    const quoteAsset = quoteAssetOf(session.mode);
    const freeQuote = balances[quoteAsset] ?? 0;
    if (session.cash > freeQuote) {
      adjustments.push(
        `${quoteAsset}: ${session.cash.toFixed(2)} → ${freeQuote.toFixed(2)}`,
      );
      session.cash = freeQuote;
    }
    this.journal.debug(
      'allocator.reconcile.checked',
      'Сверка учёта с балансом биржи',
      {
        balances,
        adjustments,
      },
    );
    if (adjustments.length > 0) {
      this.journal.warn(
        'allocator.reconcile.adjusted',
        'Учёт бота уменьшен по балансу биржи',
        {
          before,
          after: { cash: session.cash, quantities: session.quantities },
          balances,
        },
      );
      appendActivity(session, {
        kind: 'error',
        ...describeReconcile(venueOf(session.mode), adjustments),
      });
      this.store.saveCurrent(session);
    }
  }

  private applyFill(session: AllocatorSession, fill: AllocatorFill) {
    if (fill.side === 'BUY') {
      session.cash -= fill.quoteAmount;
      session.quantities[fill.symbol] =
        (session.quantities[fill.symbol] ?? 0) + fill.quantity;
    } else {
      session.cash += fill.quoteAmount;
      session.quantities[fill.symbol] = Math.max(
        (session.quantities[fill.symbol] ?? 0) - fill.quantity,
        0,
      );
    }
    session.feesPaid += fill.fee;
    this.prices[fill.symbol] = fill.price;
    // Сохраняем после каждого исполнения, чтобы падение процесса не потеряло сделку
    this.store.saveCurrent(session);
  }

  private recordFill(
    session: AllocatorSession,
    fill: AllocatorFill,
    text: Narration,
    order?: RebalanceOrder,
  ) {
    appendActivity(session, {
      kind: fill.side === 'BUY' ? 'buy' : 'sell',
      ...text,
      symbol: fill.symbol,
      quantity: fill.quantity,
      price: fill.price,
      quoteAmount: fill.quoteAmount,
      fee: fill.fee,
      chainTx: fill.chainTx,
    });
    appendEquityPoint(
      session.equityHistory,
      { timestamp: Date.now(), equity: this.equity(session) },
      0,
      true,
    );
    this.store.saveCurrent(session);
    this.journal.info('allocator.order.filled', ru(text.title), {
      fill,
      order: order ?? null,
      after: {
        cash: session.cash,
        quantity: session.quantities[fill.symbol] ?? 0,
      },
    });
    this.logger.logTrade(
      {
        действие: fill.side === 'BUY' ? 'КУПИТЬ' : 'ПРОДАТЬ',
        символ: fill.symbol,
        стратегия: STRATEGY_NAME,
        strategyId: 'trend_allocator',
        сторона: 'ЛОНГ',
        цена: round(fill.price, 4),
        количество: round(fill.quantity, 8),
        суммаUSDT: round(fill.quoteAmount),
        комиссия: round(fill.fee, 6),
        причина: `${text.details ? ru(text.details) : ''} [${session.mode}]`,
      },
      null,
    );
  }

  /**
   * Публикует решение в Solana до исполнения ордеров. Ошибка публикации не
   * мешает торговле: решение всё равно исполняется, сбой пишется в журнал.
   * Одна запись на день: повторы после сбоя ордеров и ручная ребалансировка
   * не тратят комиссию сети на дубликаты.
   */
  private async publishDecision(
    session: AllocatorSession,
    day: number,
    signals: SignalSnapshot[],
    targetWeights: Record<string, number>,
    plan: RebalancePlan,
  ) {
    if (session.lastProofDay === day) {
      return;
    }
    const smaCount = this.settings.smaPeriods.length;
    try {
      const chainTx = await this.proof.publish({
        sessionId: session.id,
        mode: session.mode,
        day,
        equity: plan.equity,
        quote: quoteAssetOf(session.mode),
        signals: signals.map((signal) => ({
          asset: baseAssetOf(signal.symbol),
          close: signal.close,
          votes: Math.round(signal.trendScore * smaCount),
          total: smaCount,
          targetWeight: targetWeights[signal.symbol] ?? 0,
        })),
        orders: plan.orders.map((order) => ({
          side: order.side,
          asset: baseAssetOf(order.symbol),
          amount: order.quoteAmount,
        })),
      });
      if (chainTx) {
        session.lastProofDay = day;
        appendActivity(session, {
          kind: 'proof',
          ...describeProof(day, chainTx.cluster),
          chainTx,
        });
        this.store.saveCurrent(session);
      }
    } catch (error) {
      this.journal.warn(
        'solana.proof.failed',
        'Не удалось записать решение в Solana',
        { day: isoDay(day) },
        error,
      );
    }
  }

  // Настройки не меняются во время работы: реестр токенов строим один раз
  private tokenRegistry() {
    if (this.tokens === undefined) {
      try {
        this.tokens = {
          registry: buildTokenRegistry(this.config.solana.tokenMints),
          problem: null,
        };
      } catch (error) {
        this.tokens = { registry: null, problem: errorMsg(error) };
      }
    }
    return this.tokens;
  }

  private solanaTokenProblems() {
    const { registry, problem } = this.tokenRegistry();
    if (!registry) {
      return problem ? [problem] : [];
    }
    const missing = unsupportedAssets(
      registry,
      this.settings.assets.map(baseAssetOf),
    );
    return missing.length
      ? [msg('ready.solanaTokens', { assets: missing })]
      : [];
  }

  private async refreshPrices() {
    if (!this.broker) return;
    const prices = await this.broker.getPrices(this.settings.assets);
    this.prices = { ...this.prices, ...prices };
    this.pricesAt = Date.now();
  }

  private equity(session: AllocatorSession) {
    return sessionEquity(session, this.prices, this.settings.assets);
  }

  private fail(event: string, message: string, error: unknown) {
    this.lastError = errorMsg(error);
    this.logger.logError(message, error, null);
    this.journal.warn(event, message, undefined, error);
  }
}
