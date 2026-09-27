import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { ExecutionMode } from '../../trader/execution.types';
import {
  AllocatorBroker,
  AllocatorFill,
  baseAssetOf,
} from '../brokers/allocator-broker';
import { BrokerFactory } from '../brokers/broker.factory';
import { planRebalance } from '../domain/rebalance-planner';
import { appendActivity, appendEquityPoint } from '../session/session-helpers';
import { SessionStore } from '../session/session-store';
import { AllocatorSession } from '../session/session.types';
import {
  AppState,
  buildAppState,
  buildChart,
  buildLegacySnapshot,
  ChartRange,
  PRICES_STALE_MS,
  Readiness,
  sessionEquity,
} from './app-state.view';
import {
  describeAutoStopReason,
  describeHoldingDecision,
  describeSellAll,
  describeStart,
  describeStop,
  explainOrder,
  MODE_LABELS,
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
  mode: ExecutionMode;
  capitalUsdt: number;
  // 0 — без автозащиты, 0.3 — продать всё при потере 30% от стартового капитала
  autoStopLossPct: number;
};

export type ActionResult = { success: boolean; message: string };

const lastClosedDay = (now: number) =>
  Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Жизненный цикл бота: запуск и остановка сессии, ежедневное решение по тренду,
 * автозащита и восстановление после перезапуска процесса.
 *
 * Все операции, меняющие сессию, выполняются строго по очереди (exclusive),
 * поэтому остановка не может пересечься с ребалансировкой.
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
  private lastError: string | null = null;
  private retry = { day: 0, failures: 0, nextAttemptAt: 0 };

  constructor(
    private readonly logger: BotLoggerService,
    private readonly store: SessionStore,
    private readonly brokers: BrokerFactory,
    private readonly signals: SignalService,
  ) {}

  onModuleDestroy() {
    this.clearTimer();
  }

  private get session() {
    return this.store.getCurrent();
  }

  /** Продолжает работу после перезапуска процесса, если сессия была запущена. */
  async resumeIfRunning() {
    const session = this.session;
    if (!session || session.status !== 'running') {
      this.logger.logInfo('Бот ожидает запуска из веб-интерфейса');
      return;
    }
    if (session.mode === 'live_real' && !this.config.allowLiveReal) {
      this.lastError =
        'Сессия с реальными деньгами не возобновлена: BOT_ALLOW_LIVE_REAL не равен true';
      this.logger.logError(this.lastError);
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
        this.fail('Не удалось сверить баланс с биржей', error);
      }
    });

    this.logger.logInfo('Работа бота возобновлена после перезапуска', {
      режим: MODE_LABELS[session.mode],
      стартовыйКапитал: session.initialCapital,
    });
    this.schedule();
    await this.tick();
  }

  start(options: StartOptions): Promise<ActionResult> {
    return this.exclusive(async () => {
      if (this.session?.status === 'running') {
        return {
          success: false,
          message: 'Бот уже работает. Сначала остановите текущую сессию.',
        };
      }

      const capital = Number(options.capitalUsdt);
      const autoStop = Number(options.autoStopLossPct);
      if (!Number.isFinite(capital) || capital < MIN_CAPITAL_USDT) {
        return {
          success: false,
          message: `Минимальная сумма — ${MIN_CAPITAL_USDT} USDT`,
        };
      }
      if (options.mode === 'paper' && capital > MAX_PAPER_CAPITAL_USDT) {
        return { success: false, message: 'Слишком большая тестовая сумма' };
      }
      if (!Number.isFinite(autoStop) || autoStop < 0 || autoStop >= 1) {
        return { success: false, message: 'Некорректный уровень автозащиты' };
      }

      const readiness = this.getModeReadiness(options.mode);
      if (!readiness.available) {
        return { success: false, message: readiness.missing.join('. ') };
      }

      const broker = this.brokers.get(options.mode);
      if (options.mode !== 'paper') {
        try {
          const balances = await broker.getFreeBalances(this.settings.assets);
          const freeUsdt = balances?.USDT ?? 0;
          if (capital > freeUsdt) {
            return {
              success: false,
              message: `На Binance свободно только ${freeUsdt.toFixed(2)} USDT`,
            };
          }
        } catch (error) {
          return {
            success: false,
            message: `Не удалось подключиться к Binance: ${describeError(error)}`,
          };
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
      this.store.saveCurrent(session);
      this.logger.logInfo('Бот запущен из веб-интерфейса', {
        режим: MODE_LABELS[options.mode],
        капиталUSDT: capital,
        автозащита: autoStop > 0 ? `−${autoStop * 100}%` : 'выключена',
      });

      this.schedule();
      await this.runCycle(session, Date.now());
      if (this.hasFreshPrices()) {
        session.benchmarkStartPrices = { ...this.prices };
        this.store.saveCurrent(session);
      }
      return { success: true, message: 'Бот запущен' };
    });
  }

  stop(
    reason = 'Остановлен вами',
    kind: 'stop' | 'autostop' = 'stop',
  ): Promise<ActionResult> {
    return this.exclusive(async () => {
      const session = this.session;
      if (!session || session.status !== 'running') {
        return { success: false, message: 'Бот сейчас не работает' };
      }

      // Сессия могла не возобновиться после перезапуска — остановить её всё равно можно
      this.broker ??= this.brokers.get(session.mode);
      this.clearTimer();
      const unsold = await this.sellEverything(session, reason);
      await this.refreshPrices().catch((error: unknown) =>
        this.fail('Не удалось обновить цены при остановке', error),
      );
      const equity = this.equity(session);
      const now = Date.now();
      session.status = 'stopped';
      session.stoppedAt = now;
      session.stopReason = reason;
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
        stopReason: reason,
      });
      this.logger.logInfo(
        kind === 'autostop' ? 'Сработала автозащита' : 'Бот остановлен',
        { причина: reason, итогUSDT: round(equity) },
      );

      return unsold.length
        ? {
            success: false,
            message: `Бот остановлен, но не удалось продать: ${unsold.join(', ')}. Проверьте Binance.`,
          }
        : { success: true, message: 'Бот остановлен, всё продано в USDT' };
    });
  }

  /** Регулярная проверка: ежедневное решение, цены, точка графика и автозащита. */
  async tick(now = Date.now()) {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      await this.exclusive(async () => {
        const session = this.session;
        if (session?.status === 'running') {
          await this.runCycle(session, now);
        }
      });
      await this.checkAutoStop();
    } finally {
      this.tickInFlight = false;
    }
  }

  rebalanceNow(): Promise<ActionResult> {
    return this.exclusive(async () => {
      const session = this.session;
      if (!session || session.status !== 'running') {
        return { success: false, message: 'Бот сейчас не работает' };
      }
      const now = Date.now();
      await this.rebalance(session, lastClosedDay(now), now);
      return { success: true, message: 'Ребалансировка выполнена' };
    });
  }

  async refreshPricesIfStale(maxAgeMs = 30_000) {
    if (
      this.session?.status !== 'running' ||
      this.activeTasks > 0 ||
      Date.now() - this.pricesAt < maxAgeMs
    ) {
      return;
    }
    await this.exclusive(() => this.refreshPrices()).catch(() => undefined);
  }

  getModeReadiness(mode: ExecutionMode): Readiness {
    const missing: string[] = [];
    if (mode === 'live_real') {
      if (!this.config.binanceApiKey || !this.config.binanceApiSecret) {
        missing.push(
          'Не заданы BINANCE_API_KEY и BINANCE_API_SECRET в файле .env',
        );
      }
      if (!this.config.allowLiveReal) {
        missing.push(
          'Не включена реальная торговля: BOT_ALLOW_LIVE_REAL=true в файле .env',
        );
      }
    }
    if (
      mode === 'live_testnet' &&
      (!this.config.binanceTestnetApiKey ||
        !this.config.binanceTestnetApiSecret)
    ) {
      missing.push(
        'Не заданы BINANCE_TESTNET_API_KEY и BINANCE_TESTNET_API_SECRET в файле .env',
      );
    }
    return { available: missing.length === 0, missing };
  }

  async getAvailableBalance(mode: ExecutionMode) {
    if (mode === 'paper') {
      return { success: true, freeUsdt: null as number | null, message: '' };
    }
    const readiness = this.getModeReadiness(mode);
    if (!readiness.available) {
      return {
        success: false,
        freeUsdt: null,
        message: readiness.missing.join('. '),
      };
    }
    try {
      const balances = await this.brokers
        .get(mode)
        .getFreeBalances(this.settings.assets);
      return { success: true, freeUsdt: balances?.USDT ?? 0, message: '' };
    } catch (error) {
      return {
        success: false,
        freeUsdt: null,
        message: `Не удалось подключиться к Binance: ${describeError(error)}`,
      };
    }
  }

  getAppState(activityLimit = 30): AppState {
    return buildAppState({
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
      },
      assets: this.settings.assets,
      smaPeriods: this.settings.smaPeriods,
      minCapital: MIN_CAPITAL_USDT,
      now: Date.now(),
      activityLimit,
    });
  }

  getChart(range: ChartRange) {
    return buildChart(this.session, range);
  }

  getLegacySnapshot() {
    return buildLegacySnapshot(this.getAppState(), this.settings.smaPeriods);
  }

  // ---------- внутреннее ----------

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
    const day = lastClosedDay(now);
    if (
      session.lastRebalanceDay !== day &&
      this.canAttemptRebalance(day, now)
    ) {
      try {
        await this.rebalance(session, day, now);
      } catch (error) {
        this.registerRebalanceFailure(session, now, error);
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
      this.logger.logPortfolio({
        стратегия: STRATEGY_NAME,
        капитал: round(this.equity(session)),
        баланс: round(session.cash),
        результатВПроцентах: round(
          (this.equity(session) / session.initialCapital - 1) * 100,
        ),
      });
    } catch (error) {
      this.fail('Не удалось обновить цены', error);
    }
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
    now: number,
    error: unknown,
  ) {
    this.retry.failures += 1;
    const delay = Math.min(
      RETRY_BASE_MS * 2 ** (this.retry.failures - 1),
      RETRY_MAX_MS,
    );
    this.retry.nextAttemptAt = now + delay;
    this.fail('Не удалось принять ежедневное решение', error);
    if (this.retry.failures === 1) {
      appendActivity(session, {
        kind: 'error',
        title: 'Не удалось принять ежедневное решение',
        details: `${describeError(error)}. Бот повторит попытку автоматически.`,
      });
      this.store.saveCurrent(session);
    }
  }

  private async rebalance(session: AllocatorSession, day: number, now: number) {
    const broker = this.broker!;
    const assets = this.settings.assets;
    const signals = await this.signals.computeSignals(
      assets,
      this.settings,
      day,
      now,
    );
    await this.refreshPrices();

    const allocationPerAsset = 1 / assets.length;
    const minOrderUsdt = Math.max(
      this.settings.minOrderUsdt,
      ...(await Promise.all(
        assets.map((symbol) => broker.getMinOrderUsdt(symbol)),
      )),
    );
    const plan = planRebalance({
      cash: session.cash,
      holdings: assets.map((symbol) => ({
        symbol,
        quantity: session.quantities[symbol] ?? 0,
        price: this.prices[symbol],
      })),
      targetWeights: Object.fromEntries(
        signals.map((signal) => [
          signal.symbol,
          signal.exposure * allocationPerAsset,
        ]),
      ),
      rebalanceThresholdPct: this.settings.rebalanceThresholdPct,
      minOrderUsdt,
      allocationPerAsset,
    });

    this.logger.logInfo('Ежедневное решение бота', {
      день: new Date(day).toISOString().slice(0, 10),
      капитал: round(plan.equity),
      сигналы: signals.map((signal) => ({
        символ: signal.symbol,
        закрытие: signal.close,
        целеваяДоляВМонете: `${(signal.exposure * 100).toFixed(0)}%`,
      })),
      ордеров: plan.orders.length,
    });

    const smaCount = this.settings.smaPeriods.length;
    const previousSignals = session.lastSignals;
    const failedOrders: string[] = [];
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
          explainOrder(order, signal, previous, smaCount),
        );
      } catch (error) {
        failedOrders.push(
          `${order.side === 'BUY' ? 'покупка' : 'продажа'} ${baseAssetOf(order.symbol)}: ${describeError(error)}`,
        );
        this.logger.logError(
          `Не удалось исполнить ордер ${order.side} ${order.symbol}`,
          error,
        );
      }
    }

    if (plan.orders.length === 0) {
      appendActivity(session, {
        kind: 'check',
        title: 'Ежедневная проверка рынка: изменений не нужно',
        details: describeHoldingDecision(signals, assets.length, smaCount),
      });
    }
    session.lastSignals = signals;
    this.store.saveCurrent(session);

    if (failedOrders.length > 0) {
      throw new Error(
        `Не удалось исполнить ордера (${failedOrders.join('; ')})`,
      );
    }
    session.lastRebalanceDay = day;
    this.retry.failures = 0;
    this.lastError = null;
    this.store.saveCurrent(session);
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
      return;
    }
    const equity = this.equity(session);
    const threshold = session.initialCapital * (1 - session.autoStopLossPct);
    if (equity > threshold) {
      return;
    }
    await this.stop(
      describeAutoStopReason(equity, threshold, session.autoStopLossPct),
      'autostop',
    );
  }

  private async sellEverything(session: AllocatorSession, reason: string) {
    const unsold: string[] = [];
    for (const symbol of this.settings.assets) {
      const quantity = session.quantities[symbol] ?? 0;
      if (quantity <= 0) continue;
      try {
        const fill = await this.broker!.sell(symbol, quantity);
        this.applyFill(session, fill);
        this.recordFill(session, fill, describeSellAll(symbol, reason));
      } catch (error) {
        unsold.push(baseAssetOf(symbol));
        this.logger.logError(
          `Не удалось продать ${symbol} при остановке`,
          error,
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
    for (const symbol of this.settings.assets) {
      const free = balances[baseAssetOf(symbol)] ?? 0;
      const owned = session.quantities[symbol] ?? 0;
      if (owned > free) {
        adjustments.push(`${baseAssetOf(symbol)}: ${owned} → ${free}`);
        session.quantities[symbol] = free;
      }
    }
    const freeUsdt = balances.USDT ?? 0;
    if (session.cash > freeUsdt) {
      adjustments.push(
        `USDT: ${session.cash.toFixed(2)} → ${freeUsdt.toFixed(2)}`,
      );
      session.cash = freeUsdt;
    }
    if (adjustments.length > 0) {
      appendActivity(session, {
        kind: 'error',
        title: 'Баланс на Binance меньше, чем учёт бота',
        details: `Похоже, средства перемещались вручную. Учёт скорректирован: ${adjustments.join('; ')}.`,
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
    text: { title: string; details: string },
  ) {
    appendActivity(session, {
      kind: fill.side === 'BUY' ? 'buy' : 'sell',
      ...text,
      symbol: fill.symbol,
      quantity: fill.quantity,
      price: fill.price,
      quoteAmount: fill.quoteAmount,
      fee: fill.fee,
    });
    appendEquityPoint(
      session.equityHistory,
      { timestamp: Date.now(), equity: this.equity(session) },
      0,
      true,
    );
    this.store.saveCurrent(session);
    this.logger.logTrade({
      действие: fill.side === 'BUY' ? 'КУПИТЬ' : 'ПРОДАТЬ',
      символ: fill.symbol,
      стратегия: STRATEGY_NAME,
      strategyId: 'trend_allocator',
      сторона: 'ЛОНГ',
      цена: round(fill.price, 4),
      количество: round(fill.quantity, 8),
      суммаUSDT: round(fill.quoteAmount),
      комиссия: round(fill.fee, 6),
      причина: `${text.details} [${session.mode}]`,
    });
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

  private fail(message: string, error: unknown) {
    this.lastError = describeError(error);
    this.logger.logError(message, error);
  }
}
