import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getBotConfig } from '../config/bot-config';
import { BotLoggerService } from '../logger/bot-logger/bot-logger.service';
import { ExecutionMode } from '../trader/execution.types';
import {
  AllocatorBroker,
  AllocatorFill,
  BinanceSpotAllocatorBroker,
  baseAssetOf,
  PaperAllocatorBroker,
} from './allocator-broker';
import { AllocatorMarketDataService } from './allocator-market-data.service';
import {
  ActivityKind,
  AllocatorSession,
  AllocatorSignalSnapshot,
  AllocatorStateStore,
  appendActivity,
  appendEquityPoint,
} from './allocator-state';
import { assetName, trendLabel } from './asset-names';
import { planRebalance, RebalanceOrder } from './rebalance-planner';
import { computeTrendSignal, getRequiredHistoryDays } from './trend-signal';

const DAY_MS = 24 * 60 * 60 * 1000;
const STRATEGY_NAME = 'Trend Allocator';
const PAPER_DEFAULT_SLIPPAGE_PCT = 0.0005;
const MAX_ATTEMPTS_PER_DAY = 3;
const EQUITY_POINT_INTERVAL_MS = 15 * 60_000;
export const MIN_CAPITAL_USDT = 100;
const MAX_PAPER_CAPITAL_USDT = 10_000_000;

export type StartOptions = {
  mode: ExecutionMode;
  capitalUsdt: number;
  // 0 — без автозащиты, 0.3 — продать всё при потере 30% от стартового капитала
  autoStopLossPct: number;
};

export type ActionResult = { success: boolean; message: string };

const MODE_LABELS: Record<ExecutionMode, string> = {
  paper: 'Тестовый режим',
  live_testnet: 'Binance Demo',
  live_real: 'Реальные деньги',
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const usd = (value: number) =>
  `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

@Injectable()
export class AllocatorRunnerService implements OnModuleDestroy {
  private readonly config = getBotConfig();
  private readonly allocator = this.config.allocator;
  private readonly store = new AllocatorStateStore(this.allocator.stateFile);
  private broker: AllocatorBroker | null = null;
  private session: AllocatorSession | null = null;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastPrices: Record<string, number> = {};
  private lastPricesAt = 0;
  private lastError: string | null = null;
  private attempts = { day: 0, count: 0 };

  constructor(
    private readonly logger: BotLoggerService,
    private readonly marketData: AllocatorMarketDataService,
  ) {
    this.session = this.store.loadCurrent();
  }

  onModuleDestroy() {
    this.clearTimer();
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

    this.broker = this.createBroker(session.mode);
    try {
      const balances = await this.broker.getFreeBalances(this.allocator.assets);
      if (balances) {
        this.reconcileWithExchange(session, balances);
      }
    } catch (error) {
      this.lastError = this.describeError(error);
      this.logger.logError('Не удалось сверить баланс с биржей', error);
    }

    this.logger.logInfo('Работа бота возобновлена после перезапуска', {
      режим: MODE_LABELS[session.mode],
      стартовыйКапитал: session.initialCapital,
    });
    this.schedule();
    await this.tick();
  }

  async start(options: StartOptions): Promise<ActionResult> {
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
    if (!Number.isFinite(autoStop) || autoStop < 0 || autoStop >= 1) {
      return { success: false, message: 'Некорректный уровень автозащиты' };
    }

    const readiness = this.getModeReadiness(options.mode);
    if (!readiness.available) {
      return { success: false, message: readiness.missing.join('. ') };
    }

    const broker = this.createBroker(options.mode);
    if (options.mode === 'paper') {
      if (capital > MAX_PAPER_CAPITAL_USDT) {
        return { success: false, message: 'Слишком большая тестовая сумма' };
      }
    } else {
      try {
        const balances = await broker.getFreeBalances(this.allocator.assets);
        const freeUsdt = balances?.USDT ?? 0;
        if (capital > freeUsdt) {
          return {
            success: false,
            message: `На Binance свободно только ${usd(freeUsdt)}`,
          };
        }
      } catch (error) {
        return {
          success: false,
          message: `Не удалось подключиться к Binance: ${this.describeError(error)}`,
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
        this.allocator.assets.map((symbol) => [symbol, 0]),
      ),
      feesPaid: 0,
      lastRebalanceDay: null,
      lastSignals: [],
      equityHistory: [{ timestamp: now, equity: capital }],
      activity: [],
    };
    appendActivity(session, {
      kind: 'start',
      title: `Бот запущен: ${MODE_LABELS[options.mode].toLowerCase()}`,
      details:
        `Стартовый капитал ${usd(capital)}. ` +
        (autoStop > 0
          ? `Автозащита: если капитал упадёт до ${usd(capital * (1 - autoStop))} (−${(autoStop * 100).toFixed(0)}%), бот всё продаст и остановится.`
          : 'Автозащита выключена.'),
    });

    this.session = session;
    this.broker = broker;
    this.lastError = null;
    this.attempts = { day: 0, count: 0 };
    this.store.saveCurrent(session);
    this.logger.logInfo('Бот запущен из веб-интерфейса', {
      режим: MODE_LABELS[options.mode],
      капиталUSDT: capital,
      автозащита: autoStop > 0 ? `−${autoStop * 100}%` : 'выключена',
    });

    this.schedule();
    await this.tick();
    return { success: true, message: 'Бот запущен' };
  }

  async stop(
    reason = 'Остановлен вами',
    kind: Extract<ActivityKind, 'stop' | 'autostop'> = 'stop',
  ): Promise<ActionResult> {
    const session = this.session;
    if (!session || session.status !== 'running') {
      return { success: false, message: 'Бот сейчас не работает' };
    }

    let unsold: string[] = [];
    await this.runExclusive(async () => {
      this.clearTimer();
      unsold = await this.sellEverything(session, reason);
      await this.refreshPrices(true);
      const equity = this.getEquity(session);
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
        title: kind === 'autostop' ? 'Сработала автозащита' : 'Бот остановлен',
        details:
          `${reason}. Итог: ${usd(equity)} (${this.formatSigned(equity - session.initialCapital)}).` +
          (unsold.length ? ` Не удалось продать: ${unsold.join(', ')}.` : ''),
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
    });

    return unsold.length
      ? {
          success: false,
          message: `Бот остановлен, но не удалось продать: ${unsold.join(', ')}. Проверьте Binance.`,
        }
      : { success: true, message: 'Бот остановлен, всё продано в USDT' };
  }

  async tick(now = Date.now()) {
    const session = this.session;
    if (this.busy || !session || session.status !== 'running') {
      return;
    }

    this.busy = true;
    try {
      const lastClosedDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
      if (session.lastRebalanceDay !== lastClosedDay) {
        await this.rebalance(session, lastClosedDay, now);
      }
      await this.refreshPrices(true);
      const equity = this.getEquity(session);
      appendEquityPoint(
        session.equityHistory,
        { timestamp: now, equity },
        EQUITY_POINT_INTERVAL_MS,
      );
      this.store.saveCurrent(session);
      this.logger.logPortfolio({
        стратегия: STRATEGY_NAME,
        капитал: round(equity),
        баланс: round(session.cash),
        результатВПроцентах: round((equity / session.initialCapital - 1) * 100),
      });
    } catch (error) {
      this.lastError = this.describeError(error);
      this.logger.logError('Ошибка цикла бота', error);
    } finally {
      this.busy = false;
    }

    await this.checkAutoStop(session);
  }

  async rebalanceNow(): Promise<ActionResult> {
    const session = this.session;
    if (!session || session.status !== 'running') {
      return { success: false, message: 'Бот сейчас не работает' };
    }
    const now = Date.now();
    await this.runExclusive(() =>
      this.rebalance(
        session,
        Math.floor(now / DAY_MS) * DAY_MS - DAY_MS,
        now,
        true,
      ),
    );
    return { success: true, message: 'Ребалансировка выполнена' };
  }

  async refreshPricesIfStale(maxAgeMs = 30_000) {
    if (
      this.session?.status === 'running' &&
      !this.busy &&
      Date.now() - this.lastPricesAt > maxAgeMs
    ) {
      await this.refreshPrices(false);
    }
  }

  getModeReadiness(mode: ExecutionMode) {
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
    if (mode === 'live_testnet') {
      if (
        !this.config.binanceTestnetApiKey ||
        !this.config.binanceTestnetApiSecret
      ) {
        missing.push(
          'Не заданы BINANCE_TESTNET_API_KEY и BINANCE_TESTNET_API_SECRET в файле .env',
        );
      }
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
      const balances = await this.createBroker(mode).getFreeBalances(
        this.allocator.assets,
      );
      return { success: true, freeUsdt: balances?.USDT ?? 0, message: '' };
    } catch (error) {
      return {
        success: false,
        freeUsdt: null,
        message: `Не удалось подключиться к Binance: ${this.describeError(error)}`,
      };
    }
  }

  /** Состояние для простого веб-интерфейса. */
  getAppState() {
    const session = this.session;
    const now = Date.now();
    const base = {
      generatedAt: now,
      busy: this.busy,
      lastError: this.lastError,
      history: this.store.getHistory().map((item) => ({
        ...item,
        modeLabel: MODE_LABELS[item.mode],
        profit: round(item.finalEquity - item.initialCapital),
        profitPct: round((item.finalEquity / item.initialCapital - 1) * 100),
      })),
      readiness: {
        paper: this.getModeReadiness('paper'),
        live_testnet: this.getModeReadiness('live_testnet'),
        live_real: this.getModeReadiness('live_real'),
      },
      strategy: {
        assets: this.allocator.assets.map((symbol) => ({
          symbol,
          base: baseAssetOf(symbol),
          name: assetName(symbol),
        })),
        smaPeriods: this.allocator.smaPeriods,
        minCapital: MIN_CAPITAL_USDT,
      },
    };

    if (!session) {
      return { ...base, status: 'idle' as const, session: null };
    }

    const equity = this.getEquity(session);
    const smaCount = this.allocator.smaPeriods.length;
    const assets = this.allocator.assets.map((symbol) => {
      const signal = session.lastSignals.find((item) => item.symbol === symbol);
      const quantity = session.quantities[symbol] ?? 0;
      const price = this.lastPrices[symbol] ?? signal?.close ?? 0;
      const value = quantity * price;
      const votes = signal ? Math.round(signal.trendScore * smaCount) : null;
      return {
        symbol,
        base: baseAssetOf(symbol),
        name: assetName(symbol),
        quantity,
        price,
        value: round(value),
        weightPct: equity > 0 ? round((value / equity) * 100, 1) : 0,
        targetWeightPct: signal
          ? round((signal.exposure / this.allocator.assets.length) * 100, 1)
          : null,
        trendVotes: votes,
        trendTotal: smaCount,
        trendLabel: votes === null ? 'Нет данных' : trendLabel(votes, smaCount),
      };
    });
    const nextDecisionAt = (Math.floor(now / DAY_MS) + 1) * DAY_MS;

    return {
      ...base,
      status: session.status,
      session: {
        id: session.id,
        mode: session.mode,
        modeLabel: MODE_LABELS[session.mode],
        startedAt: session.startedAt,
        stoppedAt: session.stoppedAt,
        stopReason: session.stopReason,
        initialCapital: session.initialCapital,
        equity: round(equity),
        profit: round(equity - session.initialCapital),
        profitPct: round((equity / session.initialCapital - 1) * 100),
        cash: round(session.cash),
        cashWeightPct:
          equity > 0 ? round((session.cash / equity) * 100, 1) : 100,
        feesPaid: round(session.feesPaid),
        autoStopLossPct: session.autoStopLossPct,
        autoStopEquity:
          session.autoStopLossPct > 0
            ? round(session.initialCapital * (1 - session.autoStopLossPct))
            : null,
        assets,
        lastDecisionDay: session.lastRebalanceDay,
        nextDecisionAt: session.status === 'running' ? nextDecisionAt : null,
        pricesUpdatedAt: this.lastPricesAt || null,
        equityHistory: [
          ...session.equityHistory,
          ...(session.status === 'running'
            ? [{ timestamp: now, equity: round(equity) }]
            : []),
        ],
        activity: session.activity.slice(0, 200),
      },
    };
  }

  /** Снимок для расширенного дашборда (/advanced). */
  getDashboardSnapshot() {
    const state = this.getAppState();
    if (!state.session) {
      return { статус: 'не запущен', ошибка: state.lastError };
    }
    const { session } = state;
    return {
      статус: session.stoppedAt ? 'остановлен' : 'работает',
      режим: session.modeLabel,
      капитал: session.equity,
      стартовыйКапитал: session.initialCapital,
      результатВПроцентах: session.profitPct,
      usdt: session.cash,
      активы: session.assets.map((asset) => ({
        символ: asset.symbol,
        количество: round(asset.quantity, 8),
        цена: asset.price,
        стоимость: asset.value,
        текущийВес: asset.weightPct,
        целевойВес: asset.targetWeightPct,
        тренд:
          asset.trendVotes === null
            ? 'нет данных'
            : `выше ${asset.trendVotes}/${asset.trendTotal} SMA`,
      })),
      последнийСигнал: session.lastDecisionDay
        ? new Date(session.lastDecisionDay).toISOString().slice(0, 10)
        : null,
      сигнал: `ансамбль SMA ${this.allocator.smaPeriods.join('/')}`,
      ошибка: state.lastError,
    };
  }

  protected createBroker(mode: ExecutionMode): AllocatorBroker {
    if (mode === 'paper') {
      return new PaperAllocatorBroker(
        this.marketData,
        this.config.feePct,
        this.config.slippagePct || PAPER_DEFAULT_SLIPPAGE_PCT,
      );
    }
    return new BinanceSpotAllocatorBroker(mode, this.config);
  }

  private schedule() {
    this.clearTimer();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.allocator.checkIntervalMs);
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runExclusive(task: () => Promise<void>) {
    while (this.busy) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.busy = true;
    try {
      await task();
    } finally {
      this.busy = false;
    }
  }

  private async checkAutoStop(session: AllocatorSession) {
    if (session.status !== 'running' || session.autoStopLossPct <= 0) {
      return;
    }
    const equity = this.getEquity(session);
    const threshold = session.initialCapital * (1 - session.autoStopLossPct);
    if (equity > threshold) {
      return;
    }
    await this.stop(
      `Автозащита: капитал упал до ${usd(equity)} — ниже порога ${usd(threshold)} (−${(session.autoStopLossPct * 100).toFixed(0)}%)`,
      'autostop',
    );
  }

  private async sellEverything(session: AllocatorSession, reason: string) {
    const unsold: string[] = [];
    for (const symbol of this.allocator.assets) {
      const quantity = session.quantities[symbol] ?? 0;
      if (quantity <= 0) continue;
      try {
        const fill = await this.broker!.sell(symbol, quantity);
        this.applyFill(session, fill);
        this.recordFill(
          session,
          fill,
          `Продал весь ${baseAssetOf(symbol)}`,
          `${reason}: перевожу всё в USDT.`,
        );
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
    for (const symbol of this.allocator.assets) {
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

  private async rebalance(
    session: AllocatorSession,
    day: number,
    now: number,
    force = false,
  ) {
    const broker = this.broker!;

    if (this.attempts.day !== day) {
      this.attempts = { day, count: 0 };
    }
    if (!force && this.attempts.count >= MAX_ATTEMPTS_PER_DAY) {
      return;
    }
    this.attempts.count += 1;

    const historyDays = getRequiredHistoryDays(this.allocator) + 5;
    const signals: AllocatorSignalSnapshot[] = [];
    for (const symbol of this.allocator.assets) {
      const closes = await this.marketData.getClosedDailyCloses(
        symbol,
        historyDays,
        now,
      );
      if (closes.at(-1)?.day !== day) {
        throw new Error(
          `Дневная свеча ${symbol} за ${new Date(day).toISOString().slice(0, 10)} ещё не доступна`,
        );
      }
      const signal = computeTrendSignal(
        closes.map((item) => item.close),
        this.allocator,
      );
      if (!signal.isReady) {
        throw new Error(
          `Недостаточно истории для сигнала ${symbol}: ${closes.length} дней`,
        );
      }
      signals.push({
        symbol,
        day,
        close: signal.close,
        trendScore: signal.trendScore,
        exposure: signal.exposure,
        annualizedVol: signal.annualizedVol,
        smaValues: signal.smaValues,
      });
    }

    await this.refreshPrices(true);
    const allocationPerAsset = 1 / this.allocator.assets.length;
    const minOrderUsdt = Math.max(
      this.allocator.minOrderUsdt,
      ...(await Promise.all(
        this.allocator.assets.map((symbol) => broker.getMinOrderUsdt(symbol)),
      )),
    );
    const plan = planRebalance({
      cash: session.cash,
      holdings: this.allocator.assets.map((symbol) => ({
        symbol,
        quantity: session.quantities[symbol] ?? 0,
        price: this.lastPrices[symbol],
      })),
      targetWeights: Object.fromEntries(
        signals.map((signal) => [
          signal.symbol,
          signal.exposure * allocationPerAsset,
        ]),
      ),
      rebalanceThresholdPct: this.allocator.rebalanceThresholdPct,
      minOrderUsdt,
      allocationPerAsset,
    });

    this.logger.logInfo('Ежедневное решение бота', {
      день: new Date(day).toISOString().slice(0, 10),
      капитал: round(plan.equity),
      сигналы: signals.map((signal) => ({
        символ: signal.symbol,
        закрытие: signal.close,
        тренд: `цена выше ${Math.round(signal.trendScore * this.allocator.smaPeriods.length)}/${this.allocator.smaPeriods.length} SMA`,
        целеваяДоляВМонете: `${(signal.exposure * 100).toFixed(0)}%`,
      })),
      ордеров: plan.orders.length,
    });

    const previousSignals = session.lastSignals;
    let failed = false;
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
        const explanation = this.explainOrder(order, signal, previous);
        this.recordFill(session, fill, explanation.title, explanation.details);
      } catch (error) {
        failed = true;
        this.lastError = this.describeError(error);
        appendActivity(session, {
          kind: 'error',
          title: `Не удалось ${order.side === 'BUY' ? 'купить' : 'продать'} ${baseAssetOf(order.symbol)}`,
          details: `${this.lastError}. Бот повторит попытку при следующей проверке.`,
          symbol: order.symbol,
        });
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
        details: this.describeHoldingDecision(signals),
      });
    }

    session.lastSignals = signals;
    if (!failed) {
      session.lastRebalanceDay = day;
      this.lastError = null;
    }
    this.store.saveCurrent(session);
  }

  private explainOrder(
    order: RebalanceOrder,
    signal: AllocatorSignalSnapshot,
    previous: AllocatorSignalSnapshot | undefined,
  ) {
    const base = baseAssetOf(order.symbol);
    const name = `${assetName(order.symbol)} (${base})`;
    const total = this.allocator.smaPeriods.length;
    const votes = Math.round(signal.trendScore * total);
    const target = (order.targetWeight * 100).toFixed(0);
    const sameSignal =
      previous !== undefined &&
      Math.abs(previous.exposure - signal.exposure) < 1e-9;

    if (order.side === 'BUY') {
      if (sameSignal) {
        return {
          title: `Докупил ${base}`,
          details: `Цена изменилась, и доля ${base} стала меньше плана — выравниваю до ${target}% капитала.`,
        };
      }
      return {
        title: `Купил ${name}`,
        details:
          votes === total
            ? `Рынок растёт: цена выше всех ${total} средних. Держу ${target}% капитала в ${base}.`
            : `Тренд усиливается: цена выше ${votes} из ${total} средних. Увеличиваю долю ${base} до ${target}% капитала.`,
      };
    }

    if (order.targetWeight === 0) {
      return {
        title: `Продал весь ${name}`,
        details: `Рынок падает: цена ниже всех ${total} средних. Перевожу долю ${base} в USDT, чтобы переждать.`,
      };
    }
    if (sameSignal) {
      return {
        title: `Продал часть ${base}`,
        details: `Цена выросла, и доля ${base} стала больше плана — фиксирую часть прибыли, выравниваю до ${target}% капитала.`,
      };
    }
    return {
      title: `Продал часть ${name}`,
      details: `Тренд ослаб: цена выше только ${votes} из ${total} средних. Уменьшаю долю ${base} до ${target}% капитала.`,
    };
  }

  private describeHoldingDecision(signals: AllocatorSignalSnapshot[]) {
    const total = this.allocator.smaPeriods.length;
    const parts = signals.map((signal) => {
      const votes = Math.round(signal.trendScore * total);
      const share = (
        (signal.exposure / this.allocator.assets.length) *
        100
      ).toFixed(0);
      return `${assetName(signal.symbol)}: ${trendLabel(votes, total).toLowerCase()} (${votes} из ${total}) — держу ${share}% капитала`;
    });
    const invested = signals.some((signal) => signal.exposure > 0);
    return `${parts.join('; ')}.${invested ? '' : ' Всё в USDT — жду восходящего тренда.'}`;
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
    this.lastPrices[fill.symbol] = fill.price;
    // Сохраняем после каждого исполнения, чтобы падение процесса не потеряло сделку
    this.store.saveCurrent(session);
  }

  private recordFill(
    session: AllocatorSession,
    fill: AllocatorFill,
    title: string,
    details: string,
  ) {
    appendActivity(session, {
      kind: fill.side === 'BUY' ? 'buy' : 'sell',
      title,
      details,
      symbol: fill.symbol,
      quantity: fill.quantity,
      price: fill.price,
      quoteAmount: fill.quoteAmount,
      fee: fill.fee,
    });
    appendEquityPoint(
      session.equityHistory,
      { timestamp: Date.now(), equity: this.getEquity(session) },
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
      причина: `${details} [${session.mode}]`,
    });
  }

  private async refreshPrices(throwOnFailure: boolean) {
    const broker = this.broker;
    if (!broker) return;
    try {
      for (const symbol of this.allocator.assets) {
        this.lastPrices[symbol] = await broker.getPrice(symbol);
      }
      this.lastPricesAt = Date.now();
    } catch (error) {
      if (throwOnFailure) throw error;
    }
  }

  private getEquity(session: AllocatorSession) {
    return this.allocator.assets.reduce(
      (sum, symbol) =>
        sum +
        (session.quantities[symbol] ?? 0) * (this.lastPrices[symbol] ?? 0),
      session.cash,
    );
  }

  private formatSigned(value: number) {
    return `${value >= 0 ? '+' : '−'}${usd(Math.abs(value))}`;
  }

  private describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
