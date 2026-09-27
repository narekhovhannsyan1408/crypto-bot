import { getBotConfig, resetBotConfigCache } from './bot-config';

describe('getBotConfig: allocator settings', () => {
  const keys = [
    'BOT_ALLOCATOR_ASSETS',
    'BOT_ALLOCATOR_SMA_PERIODS',
    'BOT_ALLOCATOR_CHECK_INTERVAL_MS',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  const load = (env: Record<string, string>) => {
    Object.assign(process.env, env);
    resetBotConfigCache();
    return getBotConfig().allocator;
  };

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetBotConfigCache();
  });

  it('accepts bare coin names and removes duplicates', () => {
    const config = load({ BOT_ALLOCATOR_ASSETS: 'btc, ETHUSDT, sol, BTC' });

    expect(config.assets).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('sorts moving averages and falls back to the standard set when none are valid', () => {
    expect(load({ BOT_ALLOCATOR_SMA_PERIODS: '0, x, 1' }).smaPeriods).toEqual([
      20, 50, 100, 200,
    ]);
    expect(load({ BOT_ALLOCATOR_SMA_PERIODS: '50,20,50' }).smaPeriods).toEqual([
      20, 50,
    ]);
  });

  it('never checks prices more often than every 10 seconds', () => {
    expect(load({ BOT_ALLOCATOR_CHECK_INTERVAL_MS: '0' }).checkIntervalMs).toBe(
      10_000,
    );
    expect(
      load({ BOT_ALLOCATOR_CHECK_INTERVAL_MS: '60000' }).checkIntervalMs,
    ).toBe(60_000);
  });
});
