import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../.env'),
];

const configuredEnvPath = process.env.BOT_ENV_FILE?.trim();

const resolveEnvPath = () => {
  if (configuredEnvPath) {
    const explicitEnvPath = resolve(configuredEnvPath);
    if (!existsSync(explicitEnvPath)) {
      throw new Error(
        `Указанный BOT_ENV_FILE не найден: ${explicitEnvPath}. Исправь путь или убери BOT_ENV_FILE.`,
      );
    }

    return explicitEnvPath;
  }

  return envCandidates.find((envPath, index) => {
    if (!existsSync(envPath)) {
      return false;
    }

    return envCandidates.indexOf(envPath) === index;
  });
};

const resolvedEnvPath = resolveEnvPath();
if (resolvedEnvPath) {
  loadEnv({ path: resolvedEnvPath, override: false });
}

const numberValue = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stringValue = (value: string | undefined, fallback: string) =>
  value?.trim() ? value.trim() : fallback;

const confirmationModeValue = (
  value: string | undefined,
): 'strict' | 'lenient' | 'off' => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'lenient') return 'lenient';
  if (normalized === 'off') return 'off';
  return 'strict';
};

const executionModeValue = (
  value: string | undefined,
): 'paper' | 'live_testnet' | 'live_real' => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'live_testnet') return 'live_testnet';
  if (normalized === 'live_real') return 'live_real';
  return 'paper';
};

// По умолчанию — трендовый аллокатор; старые внутридневные стратегии только явно
const strategyModeValue = (
  value: string | undefined,
): 'intraday' | 'trend_allocator' =>
  value?.trim().toLowerCase() === 'intraday' ? 'intraday' : 'trend_allocator';

const listValue = (value: string | undefined, fallback: string) =>
  (value?.trim() ? value : fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const executionMarketTypeValue = (
  value: string | undefined,
): 'spot' | 'futures' | 'hybrid' => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'hybrid') return 'hybrid';
  if (normalized === 'futures') return 'futures';
  return 'spot';
};

export type AllocatorConfig = {
  assets: string[];
  smaPeriods: number[];
  volTarget: number;
  volLookbackDays: number;
  rebalanceThresholdPct: number;
  minOrderUsdt: number;
  paperInitialBalance: number;
  stateFile: string;
  checkIntervalMs: number;
  dataRestBaseUrl: string;
};

export type LogLevelName =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

export type LoggingConfig = {
  dir: string;
  level: LogLevelName;
  maxFileMb: number;
  retentionDays: number;
  heartbeatMs: number;
};

const LOG_LEVELS: LogLevelName[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];
const logLevelValue = (value: string | undefined): LogLevelName => {
  const normalized = value?.trim().toLowerCase() as LogLevelName | undefined;
  return normalized && LOG_LEVELS.includes(normalized) ? normalized : 'debug';
};

export type BotConfig = {
  strategyMode: 'intraday' | 'trend_allocator';
  allocator: AllocatorConfig;
  logging: LoggingConfig;
  symbol: string;
  interval: string;
  confirmationInterval: string | null;
  confirmationMode: 'strict' | 'lenient' | 'off';
  executionMode: 'paper' | 'live_testnet' | 'live_real';
  executionMarketType: 'spot' | 'futures' | 'hybrid';
  allowLiveReal: boolean;
  useScanner: boolean;
  scanIntervalMs: number;
  maxCandlesWithoutPositionBeforeSwitch: number;
  maxScannerCandidates: number;
  universeSize: number;
  minPositionSizeUsdt: number;
  initialBalance: number;
  maxPositionSizeUsdt: number;
  maxPositionSizePctOfEquity: number;
  riskPerTradePct: number;
  feePct: number;
  slippagePct: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  breakevenTriggerPct: number;
  breakevenOffsetPct: number;
  maxPositionHoldMinutes: number;
  exitOnStrategySignal: boolean;
  cooldownCandles: number;
  minTrendStrengthPct: number;
  minAtrPct: number;
  maxAtrPct: number;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiLongThreshold: number;
  rsiShortThreshold: number;
  rsiLongMaxEntry: number;
  rsiShortMinEntry: number;
  momentumMaxEmaStretchPct: number;
  meanReversionMaxHigherTimeframeTrendPct: number;
  scannerMinQuoteVolume: number;
  scannerShortlistSize: number;
  scannerKlineLookback: number;
  maxConcurrentPositions: number;
  maxPortfolioExposurePct: number;
  maxDrawdownStopPct: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  consecutiveLossesCooldownMinutes: number;
  maxPositionsPerSymbol: number;
  maxPositionsPerStrategy: number;
  allowOppositePositionsSameSymbol: boolean;
  enabledStrategies: string[];
  dynamicTimeframeEnabled: boolean;
  dynamicTimeframeCandidates: string[];
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  binanceRestBaseUrl: string;
  binanceWsBaseUrl: string;
  binanceApiKey: string;
  binanceApiSecret: string;
  binanceTestnetApiKey: string;
  binanceTestnetApiSecret: string;
  binanceFuturesDemoApiKey: string;
  binanceFuturesDemoApiSecret: string;
  allowedSymbols: string[];
};

let cachedConfig: BotConfig | null = null;

export const getBotConfig = (): BotConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    strategyMode: strategyModeValue(process.env.BOT_STRATEGY_MODE),
    logging: {
      dir: stringValue(process.env.BOT_LOG_DIR, resolve(process.cwd(), 'logs')),
      level: logLevelValue(process.env.BOT_LOG_LEVEL),
      maxFileMb: numberValue(process.env.BOT_LOG_MAX_FILE_MB, 10),
      retentionDays: numberValue(process.env.BOT_LOG_RETENTION_DAYS, 14),
      heartbeatMs: numberValue(process.env.BOT_LOG_HEARTBEAT_MS, 5 * 60_000),
    },
    allocator: {
      assets: listValue(
        process.env.BOT_ALLOCATOR_ASSETS,
        'BTCUSDT,ETHUSDT',
      ).map((asset) => asset.toUpperCase()),
      smaPeriods: listValue(
        process.env.BOT_ALLOCATOR_SMA_PERIODS,
        '20,50,100,200',
      )
        .map(Number)
        .filter((period) => Number.isInteger(period) && period > 1),
      volTarget: numberValue(process.env.BOT_ALLOCATOR_VOL_TARGET, 0),
      volLookbackDays: numberValue(
        process.env.BOT_ALLOCATOR_VOL_LOOKBACK_DAYS,
        30,
      ),
      rebalanceThresholdPct: numberValue(
        process.env.BOT_ALLOCATOR_REBALANCE_THRESHOLD_PCT,
        0.1,
      ),
      minOrderUsdt: numberValue(process.env.BOT_ALLOCATOR_MIN_ORDER_USDT, 10),
      paperInitialBalance: numberValue(
        process.env.BOT_ALLOCATOR_PAPER_BALANCE,
        numberValue(process.env.BOT_INITIAL_BALANCE, 1_000),
      ),
      stateFile: stringValue(
        process.env.BOT_ALLOCATOR_STATE_FILE,
        resolve(process.cwd(), '.allocator-state.json'),
      ),
      checkIntervalMs: numberValue(
        process.env.BOT_ALLOCATOR_CHECK_INTERVAL_MS,
        5 * 60_000,
      ),
      dataRestBaseUrl: stringValue(
        process.env.BOT_ALLOCATOR_DATA_URL,
        'https://api.binance.com',
      ),
    },
    symbol: stringValue(process.env.BOT_SYMBOL, 'BTCUSDT'),
    interval: stringValue(process.env.BOT_INTERVAL, '1m'),
    confirmationInterval: process.env.BOT_CONFIRMATION_INTERVAL?.trim() || null,
    confirmationMode: confirmationModeValue(process.env.BOT_CONFIRMATION_MODE),
    executionMode: executionModeValue(process.env.BOT_EXECUTION_MODE),
    executionMarketType: executionMarketTypeValue(
      process.env.BOT_EXECUTION_MARKET_TYPE,
    ),
    allowLiveReal: process.env.BOT_ALLOW_LIVE_REAL === 'true',
    useScanner: process.env.BOT_USE_SCANNER === 'true',
    scanIntervalMs: numberValue(process.env.BOT_SCAN_INTERVAL_MS, 60_000),
    maxCandlesWithoutPositionBeforeSwitch: numberValue(
      process.env.BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH,
      8,
    ),
    maxScannerCandidates: numberValue(
      process.env.BOT_SCANNER_SHORTLIST_SIZE,
      8,
    ),
    universeSize: numberValue(process.env.BOT_UNIVERSE_SIZE, 5),
    minPositionSizeUsdt: numberValue(
      process.env.BOT_MIN_POSITION_SIZE_USDT,
      25,
    ),
    initialBalance: numberValue(process.env.BOT_INITIAL_BALANCE, 1_000),
    maxPositionSizeUsdt: numberValue(process.env.BOT_POSITION_SIZE_USDT, 0),
    maxPositionSizePctOfEquity: numberValue(
      process.env.BOT_MAX_POSITION_SIZE_PCT_OF_EQUITY,
      0.1,
    ),
    riskPerTradePct: numberValue(process.env.BOT_RISK_PER_TRADE_PCT, 0.005),
    feePct: numberValue(process.env.BOT_FEE_PCT, 0.001),
    slippagePct: numberValue(process.env.BOT_SLIPPAGE_PCT, 0),
    stopLossPct: numberValue(process.env.BOT_STOP_LOSS_PCT, 0.012),
    takeProfitPct: numberValue(process.env.BOT_TAKE_PROFIT_PCT, 0.02),
    trailingStopPct: numberValue(process.env.BOT_TRAILING_STOP_PCT, 0.008),
    breakevenTriggerPct: numberValue(process.env.BOT_BREAKEVEN_TRIGGER_PCT, 0),
    breakevenOffsetPct: numberValue(process.env.BOT_BREAKEVEN_OFFSET_PCT, 0),
    maxPositionHoldMinutes: numberValue(
      process.env.BOT_MAX_POSITION_HOLD_MINUTES,
      0,
    ),
    exitOnStrategySignal: process.env.BOT_EXIT_ON_STRATEGY_SIGNAL === 'true',
    cooldownCandles: numberValue(process.env.BOT_COOLDOWN_CANDLES, 2),
    minTrendStrengthPct: numberValue(
      process.env.BOT_MIN_TREND_STRENGTH_PCT,
      0.0015,
    ),
    minAtrPct: numberValue(process.env.BOT_MIN_ATR_PCT, 0.001),
    maxAtrPct: numberValue(process.env.BOT_MAX_ATR_PCT, 0.03),
    emaFastPeriod: numberValue(process.env.BOT_EMA_FAST_PERIOD, 9),
    emaSlowPeriod: numberValue(process.env.BOT_EMA_SLOW_PERIOD, 21),
    rsiPeriod: numberValue(process.env.BOT_RSI_PERIOD, 14),
    rsiLongThreshold: numberValue(process.env.BOT_RSI_LONG_THRESHOLD, 55),
    rsiShortThreshold: numberValue(process.env.BOT_RSI_SHORT_THRESHOLD, 45),
    rsiLongMaxEntry: numberValue(process.env.BOT_RSI_LONG_MAX_ENTRY, 68),
    rsiShortMinEntry: numberValue(process.env.BOT_RSI_SHORT_MIN_ENTRY, 32),
    momentumMaxEmaStretchPct: numberValue(
      process.env.BOT_MOMENTUM_MAX_EMA_STRETCH_PCT,
      0.0022,
    ),
    meanReversionMaxHigherTimeframeTrendPct: numberValue(
      process.env.BOT_MEAN_REVERSION_MAX_HIGHER_TREND_PCT,
      0.0025,
    ),
    scannerMinQuoteVolume: numberValue(
      process.env.BOT_MIN_QUOTE_VOLUME,
      1_000_000,
    ),
    scannerShortlistSize: numberValue(
      process.env.BOT_SCANNER_SHORTLIST_SIZE,
      8,
    ),
    scannerKlineLookback: numberValue(
      process.env.BOT_SCANNER_KLINE_LOOKBACK,
      30,
    ),
    maxConcurrentPositions: numberValue(
      process.env.BOT_MAX_CONCURRENT_POSITIONS,
      3,
    ),
    maxPortfolioExposurePct: numberValue(
      process.env.BOT_MAX_PORTFOLIO_EXPOSURE_PCT,
      0.8,
    ),
    maxDrawdownStopPct: numberValue(
      process.env.BOT_MAX_DRAWDOWN_STOP_PCT,
      0.15,
    ),
    maxDailyLossPct: numberValue(process.env.BOT_MAX_DAILY_LOSS_PCT, 0.04),
    maxConsecutiveLosses: numberValue(
      process.env.BOT_MAX_CONSECUTIVE_LOSSES,
      4,
    ),
    consecutiveLossesCooldownMinutes: numberValue(
      process.env.BOT_CONSECUTIVE_LOSSES_COOLDOWN_MINUTES,
      30,
    ),
    maxPositionsPerSymbol: numberValue(
      process.env.BOT_MAX_POSITIONS_PER_SYMBOL,
      2,
    ),
    maxPositionsPerStrategy: numberValue(
      process.env.BOT_MAX_POSITIONS_PER_STRATEGY,
      3,
    ),
    allowOppositePositionsSameSymbol:
      process.env.BOT_ALLOW_OPPOSITE_POSITIONS_SAME_SYMBOL === 'true',
    enabledStrategies: (
      process.env.BOT_ENABLED_STRATEGIES ||
      'momentum_trend,mean_reversion,breakout_volatility,trend_pullback,range_scalping,volume_spike_reversal,market_regime_switcher'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    dynamicTimeframeEnabled:
      process.env.BOT_DYNAMIC_TIMEFRAME_ENABLED === 'true',
    dynamicTimeframeCandidates: (
      process.env.BOT_DYNAMIC_TIMEFRAME_CANDIDATES || '5m,15m,30m'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    dashboardEnabled: process.env.BOT_DASHBOARD_ENABLED !== 'false',
    dashboardHost: stringValue(process.env.BOT_DASHBOARD_HOST, '127.0.0.1'),
    dashboardPort: numberValue(process.env.BOT_DASHBOARD_PORT, 3200),
    binanceRestBaseUrl: stringValue(
      process.env.BINANCE_REST_BASE_URL,
      process.env.BOT_EXECUTION_MODE?.trim().toLowerCase() === 'live_testnet'
        ? 'https://demo-api.binance.com'
        : 'https://api.binance.com',
    ),
    binanceWsBaseUrl: stringValue(
      process.env.BINANCE_WS_BASE_URL,
      process.env.BOT_EXECUTION_MODE?.trim().toLowerCase() === 'live_testnet'
        ? 'wss://demo-stream.binance.com/ws'
        : 'wss://stream.binance.com/ws',
    ),
    binanceApiKey: stringValue(process.env.BINANCE_API_KEY, ''),
    binanceApiSecret: stringValue(process.env.BINANCE_API_SECRET, ''),
    binanceTestnetApiKey: stringValue(process.env.BINANCE_TESTNET_API_KEY, ''),
    binanceTestnetApiSecret: stringValue(
      process.env.BINANCE_TESTNET_API_SECRET,
      '',
    ),
    binanceFuturesDemoApiKey: stringValue(
      process.env.BINANCE_FUTURES_DEMO_API_KEY,
      '',
    ),
    binanceFuturesDemoApiSecret: stringValue(
      process.env.BINANCE_FUTURES_DEMO_API_SECRET,
      '',
    ),
    allowedSymbols: (process.env.BOT_ALLOWED_SYMBOLS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };

  return cachedConfig;
};

export const resetBotConfigCache = () => {
  cachedConfig = null;
};

export const intervalToMs = (interval: string) => {
  const match = interval.match(/^(\d+)([mhd])$/i);
  if (!match) {
    return 60_000;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 60 * 60_000;
  if (unit === 'd') return amount * 24 * 60 * 60_000;

  return 60_000;
};
