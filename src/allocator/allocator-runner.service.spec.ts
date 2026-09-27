import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetBotConfigCache } from '../config/bot-config';
import { BotLoggerService } from '../logger/bot-logger/bot-logger.service';
import { AllocatorMarketDataService } from './allocator-market-data.service';
import { AllocatorRunnerService } from './allocator-runner.service';

const DAY_MS = 24 * 60 * 60 * 1000;

const makeLogger = () =>
  ({
    logInfo: jest.fn(),
    logError: jest.fn(),
    logTrade: jest.fn(),
    logPortfolio: jest.fn(),
  }) as unknown as BotLoggerService & { logTrade: jest.Mock };

const makeMarket = (trend: 'up' | 'down') => {
  const lastClosedDay = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
  const market: { price: number; service: AllocatorMarketDataService } = {
    price: 100,
    service: {
      getClosedDailyCloses: jest.fn((_symbol: string, days: number) =>
        Promise.resolve(
          Array.from({ length: days }, (_, index) => ({
            day: lastClosedDay - (days - 1 - index) * DAY_MS,
            close: trend === 'up' ? 50 + index : 200 - index,
          })),
        ),
      ),
      getPrice: jest.fn(() => Promise.resolve(market.price)),
    } as unknown as AllocatorMarketDataService,
  };
  return market;
};

type AppState = ReturnType<AllocatorRunnerService['getAppState']>;
const sessionOf = (state: AppState) => {
  if (!state.session) throw new Error('Нет сессии');
  return state.session;
};

describe('AllocatorRunnerService', () => {
  let dir: string;
  let stateFile: string;
  const runners: AllocatorRunnerService[] = [];
  const envKeys = [
    'BOT_ALLOCATOR_STATE_FILE',
    'BOT_ALLOCATOR_ASSETS',
    'BOT_ALLOCATOR_SMA_PERIODS',
    'BOT_ALLOCATOR_CHECK_INTERVAL_MS',
    'BOT_ALLOW_LIVE_REAL',
  ];

  const createRunner = (
    market: AllocatorMarketDataService,
    logger = makeLogger(),
  ) => {
    resetBotConfigCache();
    const runner = new AllocatorRunnerService(logger, market);
    runners.push(runner);
    return { runner, logger };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'allocator-'));
    stateFile = join(dir, 'state.json');
    process.env.BOT_ALLOCATOR_STATE_FILE = stateFile;
    process.env.BOT_ALLOCATOR_ASSETS = 'BTCUSDT,ETHUSDT';
    process.env.BOT_ALLOCATOR_SMA_PERIODS = '5,10';
    process.env.BOT_ALLOCATOR_CHECK_INTERVAL_MS = '3600000';
    process.env.BOT_ALLOW_LIVE_REAL = 'false';
  });

  afterEach(() => {
    for (const runner of runners.splice(0)) runner.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    for (const key of envKeys) delete process.env[key];
    resetBotConfigCache();
  });

  it('is idle until started', () => {
    const { runner } = createRunner(makeMarket('up').service);

    expect(runner.getAppState().status).toBe('idle');
  });

  it('starts in test mode, buys in an uptrend and explains each trade', async () => {
    const { runner, logger } = createRunner(makeMarket('up').service);

    const result = await runner.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0.3,
    });
    const session = sessionOf(runner.getAppState());

    expect(result.success).toBe(true);
    expect(logger.logTrade).toHaveBeenCalledTimes(2);
    expect(session.cash).toBeLessThan(10);
    expect(session.equity).toBeGreaterThan(990);
    expect(session.autoStopEquity).toBe(700);
    expect(session.assets.map((asset) => asset.trendLabel)).toEqual([
      'Сильный рост',
      'Сильный рост',
    ]);
    const buys = session.activity.filter((entry) => entry.kind === 'buy');
    expect(buys).toHaveLength(2);
    expect(buys[0].details).toContain('Рынок растёт');
    expect(session.equityHistory.length).toBeGreaterThanOrEqual(3);
  });

  it('does not trade twice for the same day and resumes after a restart', async () => {
    const first = createRunner(makeMarket('up').service);
    await first.runner.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    await first.runner.tick();
    expect(first.logger.logTrade).toHaveBeenCalledTimes(2);
    first.runner.onModuleDestroy();

    const second = createRunner(makeMarket('up').service);
    await second.runner.resumeIfRunning();

    expect(second.logger.logTrade).not.toHaveBeenCalled();
    expect(second.runner.getAppState().status).toBe('running');
  });

  it('stays in USDT in a downtrend and says so', async () => {
    const { runner, logger } = createRunner(makeMarket('down').service);

    await runner.start({ mode: 'paper', capitalUsdt: 500, autoStopLossPct: 0 });
    const session = sessionOf(runner.getAppState());

    expect(logger.logTrade).not.toHaveBeenCalled();
    expect(session.cash).toBe(500);
    expect(session.activity[0].kind).toBe('check');
    expect(session.activity[0].details).toContain('Всё в USDT');
  });

  it('stops by user request, sells everything and records history', async () => {
    const { runner } = createRunner(makeMarket('up').service);
    await runner.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });

    const result = await runner.stop();
    const state = runner.getAppState();
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
    const market = makeMarket('up');
    const { runner } = createRunner(market.service);
    await runner.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0.3,
    });

    market.price = 60;
    await runner.tick();
    const state = runner.getAppState();
    const session = sessionOf(state);

    expect(state.status).toBe('stopped');
    expect(session.stopReason).toContain('Автозащита');
    expect(session.activity[0].kind).toBe('autostop');
    expect(session.assets.every((asset) => asset.quantity === 0)).toBe(true);
  });

  it('validates the start request', async () => {
    const { runner } = createRunner(makeMarket('up').service);

    const tooSmall = await runner.start({
      mode: 'paper',
      capitalUsdt: 50,
      autoStopLossPct: 0,
    });
    expect(tooSmall.success).toBe(false);

    const real = await runner.start({
      mode: 'live_real',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    expect(real.success).toBe(false);
    expect(real.message).toContain('BOT_ALLOW_LIVE_REAL');

    await runner.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    const second = await runner.start({
      mode: 'paper',
      capitalUsdt: 1000,
      autoStopLossPct: 0,
    });
    expect(second.success).toBe(false);
  });
});
