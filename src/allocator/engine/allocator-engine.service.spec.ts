import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetBotConfigCache } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { AppLogger } from '../../observability/app-logger';
import { ru } from '../../i18n/messages';
import { MemorySink } from '../../observability/rotating-file-sink';
import { JupiterClient } from '../../solana/jupiter-client';
import { SolanaProofService } from '../../solana/solana-proof.service';
import { USDC } from '../../solana/solana-tokens';
import { BrokerFactory } from '../brokers/broker.factory';
import { AllocatorMarketDataService } from '../market-data/allocator-market-data.service';
import { SessionStore } from '../session/session-store';
import { AllocatorEngine } from './allocator-engine.service';
import { AppState } from './app-state.view';
import { SignalService } from './signal.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

type FakeMarket = {
  trend: 'up' | 'down';
  price: number;
  failPrices: boolean;
  failKlines: number;
};

const createFakeMarketData = (market: FakeMarket) => ({
  getClosedDailyCloses: jest.fn(
    (_symbol: string, days: number, now: number) => {
      if (market.failKlines > 0) {
        market.failKlines -= 1;
        return Promise.reject(new Error('Binance недоступен'));
      }
      const lastClosedDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
      return Promise.resolve(
        Array.from({ length: days }, (_, index) => ({
          day: lastClosedDay - (days - 1 - index) * DAY_MS,
          close: market.trend === 'up' ? 50 + index : 200 - index,
        })),
      );
    },
  ),
  getPrice: jest.fn(() =>
    market.failPrices
      ? Promise.reject(new Error('нет связи'))
      : Promise.resolve(market.price),
  ),
  getPrices: jest.fn((symbols: string[]) =>
    market.failPrices
      ? Promise.reject(new Error('нет связи'))
      : Promise.resolve(
          Object.fromEntries(symbols.map((symbol) => [symbol, market.price])),
        ),
  ),
});

// Jupiter с той же ценой, что и рынок; маршрут берёт 0.1% (комиссия пулов)
const createFakeJupiter = (market: FakeMarket) => ({
  getUsdPrices: jest.fn((mints: string[]) =>
    market.failPrices
      ? Promise.reject(new Error('нет связи'))
      : Promise.resolve(
          Object.fromEntries(mints.map((mint) => [mint, market.price])),
        ),
  ),
  getQuote: jest.fn(
    (params: { inputMint: string; outputMint: string; amount: bigint }) => {
      const buying = params.inputMint === USDC.mint;
      const units = buying
        ? (Number(params.amount) / 1e6 / market.price) * 1e8
        : (Number(params.amount) / 1e8) * market.price * 1e6;
      return Promise.resolve({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amount.toString(),
        outAmount: String(Math.floor(units * 0.999)),
        otherAmountThreshold: '0',
        slippageBps: 50,
        priceImpactPct: '0.0001',
        routePlan: [
          { percent: 100, swapInfo: { label: 'Orca', ammKey: 'pool' } },
        ],
      });
    },
  ),
  buildSwapTransaction: jest.fn(),
});

type FakeProof = {
  status: () => ReturnType<SolanaProofService['status']>;
  publish: jest.Mock;
};

const disabledProof = (): FakeProof => ({
  status: () => ({
    enabled: false,
    cluster: 'devnet',
    address: null,
    problem: null,
  }),
  publish: jest.fn(() => Promise.resolve(null)),
});

const sessionOf = (state: AppState) => {
  if (!state.session) throw new Error('Нет сессии');
  return state.session;
};

describe('AllocatorEngine', () => {
  let dir: string;
  let stateFile: string;
  const engines: AllocatorEngine[] = [];
  const envKeys = [
    'BOT_ALLOCATOR_STATE_FILE',
    'BOT_ALLOCATOR_ASSETS',
    'BOT_ALLOCATOR_SMA_PERIODS',
    'BOT_ALLOCATOR_CHECK_INTERVAL_MS',
    'BOT_ALLOW_LIVE_REAL',
    'BOT_ALLOW_SOLANA_REAL',
    'SOLANA_PRIVATE_KEY',
    'SOLANA_KEYPAIR_PATH',
    'SOLANA_TOKEN_MINTS',
  ];

  const createEngine = async (
    market: FakeMarket,
    proof: FakeProof = disabledProof(),
  ) => {
    resetBotConfigCache();
    const logger = {
      logInfo: jest.fn(),
      logError: jest.fn(),
      logTrade: jest.fn(),
      logPortfolio: jest.fn(),
    };
    const journal = new MemorySink();
    const jupiter = createFakeJupiter(market);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AllocatorEngine,
        SessionStore,
        BrokerFactory,
        SignalService,
        { provide: AppLogger, useValue: new AppLogger(journal, 'trace') },
        {
          provide: AllocatorMarketDataService,
          useValue: createFakeMarketData(market),
        },
        { provide: BotLoggerService, useValue: logger },
        { provide: JupiterClient, useValue: jupiter },
        { provide: SolanaProofService, useValue: proof },
      ],
    }).compile();
    const engine = moduleRef.get(AllocatorEngine);
    engines.push(engine);
    return { engine, logger, journal, jupiter };
  };

  const market = (overrides: Partial<FakeMarket> = {}): FakeMarket => ({
    trend: 'up',
    price: 100,
    failPrices: false,
    failKlines: 0,
    ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'allocator-'));
    stateFile = join(dir, 'state.json');
    process.env.BOT_ALLOCATOR_STATE_FILE = stateFile;
    process.env.BOT_ALLOCATOR_ASSETS = 'BTCUSDT,ETHUSDT';
    process.env.BOT_ALLOCATOR_SMA_PERIODS = '5,10';
    process.env.BOT_ALLOCATOR_CHECK_INTERVAL_MS = '3600000';
    process.env.BOT_ALLOW_LIVE_REAL = 'false';
    // Пустые значения не дают .env разработчика повлиять на тесты
    process.env.BOT_ALLOW_SOLANA_REAL = 'false';
    process.env.SOLANA_PRIVATE_KEY = '';
    process.env.SOLANA_KEYPAIR_PATH = '';
    process.env.SOLANA_TOKEN_MINTS = '';
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    for (const key of envKeys) delete process.env[key];
    resetBotConfigCache();
  });

  it('is idle until started', async () => {
    const { engine } = await createEngine(market());

    expect(engine.getAppState().status).toBe('idle');
  });

  it('starts in test mode, buys in an uptrend and explains each trade', async () => {
    const { engine, logger } = await createEngine(market());

    const result = await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0.3,
    });
    const session = sessionOf(engine.getAppState());

    expect(result.success).toBe(true);
    expect(logger.logTrade).toHaveBeenCalledTimes(2);
    expect(session.cash).toBeLessThan(10);
    expect(session.equity).toBeGreaterThan(990);
    expect(session.autoStopEquity).toBe(700);
    expect(session.benchmark?.equity).toBe(1000);
    expect(session.assets.map((asset) => asset.trendVotes)).toEqual([2, 2]);
    const buys = session.activity.filter((entry) => entry.kind === 'buy');
    expect(buys).toHaveLength(2);
    expect(buys[0].details).toContain('The market is rising');
  });

  it('writes a traceable journal for every decision and order', async () => {
    const { engine, journal } = await createEngine(market());

    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    const sessionId = sessionOf(engine.getAppState()).id;
    const fills = journal.records.filter(
      (record) => record.event === 'allocator.order.filled',
    );

    expect(journal.events()).toEqual(
      expect.arrayContaining([
        'session.store.loaded',
        'allocator.session.start_requested',
        'allocator.rebalance.signals',
        'allocator.rebalance.plan',
        'allocator.rebalance.completed',
        'allocator.cycle.completed',
      ]),
    );
    expect(fills).toHaveLength(2);
    // Все события операции связаны одним opId и сессией
    expect(new Set(fills.map((record) => record.opId)).size).toBe(1);
    expect(
      fills.every(
        (record) => record.sessionId === sessionId && record.op === 'start',
      ),
    ).toBe(true);
  });

  it('does not trade twice for the same day and resumes after a restart', async () => {
    const first = await createEngine(market());
    await first.engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    await first.engine.tick();
    expect(first.logger.logTrade).toHaveBeenCalledTimes(2);
    first.engine.onModuleDestroy();

    const second = await createEngine(market());
    await second.engine.resumeIfRunning();

    expect(second.logger.logTrade).not.toHaveBeenCalled();
    expect(second.engine.getAppState().status).toBe('running');
  });

  it('does not trigger auto-protection when prices are unavailable after a restart', async () => {
    const first = await createEngine(market());
    await first.engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0.3,
    });
    first.engine.onModuleDestroy();

    // После рестарта цен нет: без защиты монеты посчитались бы по нулевой цене
    const second = await createEngine(market({ failPrices: true }));
    await second.engine.resumeIfRunning();
    const state = second.engine.getAppState();

    expect(state.status).toBe('running');
    expect(second.logger.logTrade).not.toHaveBeenCalled();
    expect(state.lastError).toEqual({
      key: 'error.raw',
      params: { text: 'нет связи' },
    });
    expect(second.journal.events()).toContain(
      'allocator.autostop.skipped_stale_prices',
    );
    // Страница оценивает монеты по последним известным ценам, а не по нулю
    const session = sessionOf(state);
    expect(session.equity).toBeGreaterThan(500);
    expect(session.assets.every((asset) => asset.price > 0)).toBe(true);
    expect(session.pricesStale).toBe(true);
  });

  it('stays in USDT in a downtrend and says so', async () => {
    const { engine, logger } = await createEngine(market({ trend: 'down' }));

    await engine.start({ mode: 'paper', capitalUsdt: 500, autoStopLossPct: 0 });
    const session = sessionOf(engine.getAppState());

    expect(logger.logTrade).not.toHaveBeenCalled();
    expect(session.cash).toBe(500);
    expect(session.activity[0].kind).toBe('check');
    expect(session.activity[0].details).toContain('Everything is in USDT');
  });

  it('retries the daily decision with a growing pause when Binance is unavailable', async () => {
    const fake = market({ failKlines: 1 });
    const { engine, logger, journal } = await createEngine(fake);
    const now = Date.now();

    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    expect(logger.logTrade).not.toHaveBeenCalled();
    const errors = sessionOf(engine.getAppState()).activity.filter(
      (entry) => entry.kind === 'error',
    );
    expect(errors).toHaveLength(1);

    const failure = journal.records.find(
      (record) => record.event === 'allocator.rebalance.failed',
    );
    expect(failure?.level).toBe('warn');
    expect(failure?.err?.message).toBe('Binance недоступен');
    expect(failure?.data).toMatchObject({ failures: 1 });

    await engine.tick(now + MINUTE);
    expect(logger.logTrade).not.toHaveBeenCalled();
    expect(journal.events()).toContain('allocator.rebalance.deferred');

    await engine.tick(now + 6 * MINUTE);
    expect(logger.logTrade).toHaveBeenCalledTimes(2);
    expect(engine.getAppState().lastError).toBeNull();
  });

  it('stops by user request, sells everything and records history', async () => {
    const { engine } = await createEngine(market());
    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });

    const result = await engine.stop();
    const state = engine.getAppState();
    const session = sessionOf(state);

    expect(result.success).toBe(true);
    expect(state.status).toBe('stopped');
    expect(session.assets.every((asset) => asset.quantity === 0)).toBe(true);
    expect(session.cash).toBeGreaterThan(990);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].profitPct).toBeLessThan(0);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      current: { status: string };
    };
    expect(saved.current.status).toBe('stopped');
  });

  it('triggers auto-protection when the capital falls below the threshold', async () => {
    const fake = market();
    const { engine } = await createEngine(fake);
    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0.3,
    });

    fake.price = 60;
    await engine.tick();
    const state = engine.getAppState();
    const session = sessionOf(state);

    expect(state.status).toBe('stopped');
    expect(session.stopReason).toContain('Auto-protection');
    expect(session.activity[0].kind).toBe('autostop');
    expect(session.benchmark?.profitPct).toBe(-40);
  });

  it('validates the start request', async () => {
    const { engine } = await createEngine(market());

    const tooSmall = await engine.start({
      mode: 'paper',
      capitalUsdt: 50,
      autoStopLossPct: 0,
    });
    expect(tooSmall.success).toBe(false);

    const real = await engine.start({
      mode: 'live_real',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    expect(real.success).toBe(false);
    expect(ru(real.message)).toContain('BOT_ALLOW_LIVE_REAL');

    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    const second = await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    expect(second.success).toBe(false);
  });

  it('serves a compact chart with trade markers', async () => {
    const { engine } = await createEngine(market());
    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });

    const chart = engine.getChart('all');

    expect(chart.initialCapital).toBe(1000);
    expect(chart.points.length).toBeGreaterThanOrEqual(3);
    expect(chart.trades.map((trade) => trade.kind)).toEqual(['buy', 'buy']);
    expect(chart.version).toBe(sessionOf(engine.getAppState()).chartVersion);
  });

  it('trades on Solana through Jupiter quotes without sending transactions', async () => {
    const { engine, logger, jupiter } = await createEngine(market());

    const result = await engine.start({
      mode: 'solana_sim',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    const session = sessionOf(engine.getAppState());

    expect(result.success).toBe(true);
    expect(session.modeLabel).toBe('Solana · simulation');
    expect(session.quoteAsset).toBe('USDC');
    expect(logger.logTrade).toHaveBeenCalledTimes(2);
    expect(jupiter.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inputMint: USDC.mint, slippageBps: 50 }),
    );
    expect(jupiter.buildSwapTransaction).not.toHaveBeenCalled();
    // Котировка уже включает комиссию маршрута: капитал чуть меньше стартового
    expect(session.equity).toBeLessThan(1000);
    expect(session.equity).toBeGreaterThan(995);

    const stopped = await engine.stop();
    expect(ru(stopped.message)).toBe('Бот остановлен, всё продано в USDC');
  });

  it('says USDC instead of USDT when waiting out a downtrend on Solana', async () => {
    const { engine } = await createEngine(market({ trend: 'down' }));

    await engine.start({
      mode: 'solana_sim',
      capitalUsdt: 500,
      autoStopLossPct: 0,
    });
    const session = sessionOf(engine.getAppState());

    expect(session.cash).toBe(500);
    expect(session.activity[0].details).toContain('Everything is in USDC');
  });

  it('publishes each daily decision to Solana before trading', async () => {
    const proof = disabledProof();
    proof.publish.mockResolvedValue({ txId: 'memo-tx', cluster: 'devnet' });
    const { engine } = await createEngine(market(), proof);

    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    const session = sessionOf(engine.getAppState());

    expect(proof.publish).toHaveBeenCalledTimes(1);
    const [published] = proof.publish.mock.calls[0] as [
      {
        mode: string;
        quote: string;
        signals: Array<{ asset: string; votes: number; targetWeight: number }>;
        orders: Array<{ side: string; asset: string }>;
      },
    ];
    expect(published).toMatchObject({ mode: 'paper', quote: 'USDT' });
    expect(published.signals).toEqual([
      expect.objectContaining({ asset: 'BTC', votes: 2, targetWeight: 0.5 }),
      expect.objectContaining({ asset: 'ETH', votes: 2, targetWeight: 0.5 }),
    ]);
    expect(published.orders.map((order) => order.side)).toEqual(['BUY', 'BUY']);

    // Лента идёт от новых к старым: запись решения раньше покупок
    const kinds = session.activity.map((entry) => entry.kind);
    const proofEntry = session.activity.find((entry) => entry.kind === 'proof');
    expect(kinds.indexOf('proof')).toBeGreaterThan(kinds.lastIndexOf('buy'));
    expect(proofEntry?.chainTx).toEqual({ txId: 'memo-tx', cluster: 'devnet' });
  });

  it('writes one decision per day to Solana, even after a manual rebalance', async () => {
    const proof = disabledProof();
    proof.publish.mockResolvedValue({ txId: 'memo-tx', cluster: 'devnet' });
    const { engine } = await createEngine(market(), proof);
    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });

    await engine.rebalanceNow();
    await engine.rebalanceNow();

    expect(proof.publish).toHaveBeenCalledTimes(1);
    const proofs = sessionOf(engine.getAppState()).activity.filter(
      (entry) => entry.kind === 'proof',
    );
    expect(proofs).toHaveLength(1);
  });

  it('retries the Solana record on the next attempt when it failed', async () => {
    const proof = disabledProof();
    proof.publish
      .mockRejectedValueOnce(new Error('devnet недоступен'))
      .mockResolvedValue({ txId: 'memo-tx', cluster: 'devnet' });
    const { engine } = await createEngine(market(), proof);
    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });

    await engine.rebalanceNow();
    await engine.rebalanceNow();

    expect(proof.publish).toHaveBeenCalledTimes(2);
  });

  it('keeps trading when the decision cannot be written to Solana', async () => {
    const proof = disabledProof();
    proof.publish.mockRejectedValue(new Error('devnet недоступен'));
    const { engine, logger, journal } = await createEngine(market(), proof);

    await engine.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });

    expect(logger.logTrade).toHaveBeenCalledTimes(2);
    expect(engine.getAppState().lastError).toBeNull();
    const failure = journal.records.find(
      (record) => record.event === 'solana.proof.failed',
    );
    expect(failure?.err?.message).toBe('devnet недоступен');
  });

  it('needs a wallet and an explicit flag for real Solana trading', async () => {
    const { engine } = await createEngine(market());

    const readiness = engine.getAppState().readiness;
    expect(readiness.solana_sim.available).toBe(true);
    expect(readiness.solana_real.available).toBe(false);
    const missing = readiness.solana_real.missing.map(ru).join(' ');
    expect(missing).toContain('SOLANA_PRIVATE_KEY');
    expect(missing).toContain('BOT_ALLOW_SOLANA_REAL');

    const result = await engine.start({
      mode: 'solana_real',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    expect(result.success).toBe(false);
  });

  it('explains which assets have no token on Solana', async () => {
    process.env.BOT_ALLOCATOR_ASSETS = 'BTCUSDT,DOGEUSDT';
    const { engine } = await createEngine(market());

    const state = engine.getAppState();

    expect(state.readiness.solana_sim.available).toBe(false);
    expect(ru(state.readiness.solana_sim.missing[0])).toContain('DOGE');
    expect(state.solana.tokens).toEqual([
      expect.objectContaining({ base: 'BTC', symbol: 'cbBTC' }),
    ]);
  });
});
