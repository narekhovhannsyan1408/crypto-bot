import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AllocatorMarketDataService } from '../src/allocator/market-data/allocator-market-data.service';
import { AppModule } from '../src/app.module';
import { BotRunnerService } from '../src/bot/bot-runner/bot-runner.service';
import { LegacyRuntimeService } from '../src/web/legacy-dashboard/legacy-runtime.service';
import { setupHttpApp } from '../src/app.setup';
import { resetBotConfigCache } from '../src/config/bot-config';
import { BotLoggerService } from '../src/logger/bot-logger/bot-logger.service';
import { AppLogger } from '../src/observability/app-logger';
import { MemorySink } from '../src/observability/rotating-file-sink';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOST = '127.0.0.1:3200';

type StateBody = {
  status: string;
  session: { assets: Array<{ quantity: number }> } | null;
};
type ActionBody = { state: StateBody };

const fakeMarketData = {
  getClosedDailyCloses: (_symbol: string, days: number, now: number) => {
    const lastClosedDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    return Promise.resolve(
      Array.from({ length: days }, (_, index) => ({
        day: lastClosedDay - (days - 1 - index) * DAY_MS,
        close: 50 + index,
      })),
    );
  },
  getPrice: () => Promise.resolve(100),
  getPrices: (symbols: string[]) =>
    Promise.resolve(Object.fromEntries(symbols.map((symbol) => [symbol, 100]))),
};

const silentLogger = {
  logInfo: () => undefined,
  logError: () => undefined,
  logTrade: () => undefined,
  logPortfolio: () => undefined,
  logSignal: () => undefined,
  logCandle: () => undefined,
};

describe('Web API (e2e)', () => {
  let app: NestExpressApplication;
  let dir: string;
  const journal = new MemorySink();
  const appLogger = new AppLogger(journal, 'trace');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crypto-bot-e2e-'));
    process.env.BOT_ALLOCATOR_STATE_FILE = join(dir, 'state.json');
    process.env.BOT_ALLOCATOR_SMA_PERIODS = '5,10';
    // Список активов из .env разработчика не должен влиять на тест
    process.env.BOT_ALLOCATOR_ASSETS = 'BTCUSDT,ETHUSDT';
    process.env.BOT_DASHBOARD_HOST = '127.0.0.1';
    process.env.BOT_DASHBOARD_PORT = '3200';
    resetBotConfigCache();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot('trend_allocator')],
    })
      .overrideProvider(AllocatorMarketDataService)
      .useValue(fakeMarketData)
      .overrideProvider(BotLoggerService)
      .useValue(silentLogger)
      .overrideProvider(AppLogger)
      .useValue(appLogger)
      .compile();

    app = setupHttpApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
      appLogger,
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    resetBotConfigCache();
  });

  const api = () => request(app.getHttpServer());

  it('serves the simple and advanced pages', async () => {
    const home = await api().get('/').set('Host', HOST).expect(200);
    expect(home.text).toContain('Crypto Bot');

    const advanced = await api().get('/advanced').set('Host', HOST).expect(200);
    expect(advanced.text).toContain('advanced mode');
  });

  it('never serves files outside the public folder', async () => {
    const response = await api().get('/..%2f..%2f..%2f.env').set('Host', HOST);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('BINANCE');
  });

  it('runs a full test-mode session through the API', async () => {
    const idle = await api()
      .get('/api/app/state')
      .set('Host', HOST)
      .expect(200);
    expect((idle.body as StateBody).status).toBe('idle');

    const started = await api()
      .post('/api/app/start')
      .set('Host', HOST)
      .set('Origin', `http://${HOST}`)
      .send({ mode: 'paper', capitalUsdt: 1000, autoStopLossPct: 0.3 })
      .expect(200);
    const startedState = (started.body as ActionBody).state;
    expect(startedState.status).toBe('running');
    expect(startedState.session?.assets[0].quantity).toBeGreaterThan(0);

    // HTTP-запрос и все решения бота внутри него связаны одним requestId
    const requestId: unknown = started.headers['x-request-id'];
    const related = journal.records.filter(
      (record) => record.requestId === requestId,
    );
    expect(related.map((record) => record.event)).toEqual(
      expect.arrayContaining(['allocator.order.filled', 'http.request']),
    );

    await api()
      .post('/api/app/start')
      .set('Host', HOST)
      .send({ mode: 'paper', capitalUsdt: 1000 })
      .expect(400);

    const chart = await api()
      .get('/api/app/chart?range=week')
      .set('Host', HOST)
      .expect(200);
    expect((chart.body as { trades: unknown[] }).trades).toHaveLength(2);

    const legacy = await api().get('/api/state').set('Host', HOST).expect(200);
    const runtime = (
      legacy.body as {
        runtime: { strategyMode: string; allocator: { status: string } };
      }
    ).runtime;
    expect(runtime.strategyMode).toBe('trend_allocator');
    expect(runtime.allocator.status).toBe('running');

    const stopped = await api()
      .post('/api/app/stop')
      .set('Host', HOST)
      .send({})
      .expect(200);
    expect((stopped.body as ActionBody).state.status).toBe('stopped');

    await api().post('/api/app/stop').set('Host', HOST).send({}).expect(409);
  });

  it('rejects invalid input', async () => {
    await api()
      .post('/api/app/start')
      .set('Host', HOST)
      .send({ mode: 'margin', capitalUsdt: 1000 })
      .expect(400);
    await api()
      .get('/api/app/balance?mode=unknown')
      .set('Host', HOST)
      .expect(400);
  });

  it('rejects commands from other websites and DNS rebinding', async () => {
    await api()
      .post('/api/app/stop')
      .set('Host', HOST)
      .set('Origin', 'https://evil.example')
      .send({})
      .expect(403);
    await api()
      .post('/api/app/start')
      .set('Host', HOST)
      .set('Content-Type', 'text/plain')
      .send('{"mode":"paper","capitalUsdt":1000}')
      .expect(403);
    await api()
      .get('/api/app/state')
      .set('Host', 'evil.example:3200')
      .expect(403);

    const rejected = journal.records.filter(
      (record) => record.event === 'http.request' && record.level === 'warn',
    );
    expect(
      rejected.some((record) =>
        JSON.stringify(record.data).includes('evil.example'),
      ),
    ).toBe(true);
  });
});

describe('Intraday mode (e2e)', () => {
  it('still wires the legacy intraday runner into the dashboard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot('intraday')],
    })
      .overrideProvider(AppLogger)
      .useValue(new AppLogger(new MemorySink()))
      .compile();

    expect(moduleRef.get(BotRunnerService)).toBeDefined();
    expect(moduleRef.get(LegacyRuntimeService).intradayRunner).not.toBeNull();
    await moduleRef.close();
  });
});
