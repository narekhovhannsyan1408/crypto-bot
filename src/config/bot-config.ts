const numberValue = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stringValue = (value: string | undefined, fallback: string) =>
  value?.trim() ? value.trim() : fallback;

export type BotConfig = {
  symbol: string;
  interval: string;
  confirmationInterval: string | null;
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
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  cooldownCandles: number;
  minTrendStrengthPct: number;
  minAtrPct: number;
  maxAtrPct: number;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiLongThreshold: number;
  rsiShortThreshold: number;
  scannerMinQuoteVolume: number;
  scannerShortlistSize: number;
  scannerKlineLookback: number;
  maxConcurrentPositions: number;
  maxPortfolioExposurePct: number;
  maxDrawdownStopPct: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  maxPositionsPerSymbol: number;
  maxPositionsPerStrategy: number;
  allowOppositePositionsSameSymbol: boolean;
  enabledStrategies: string[];
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  binanceRestBaseUrl: string;
  binanceWsBaseUrl: string;
  allowedSymbols: string[];
};

let cachedConfig: BotConfig | null = null;

export const getBotConfig = (): BotConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    symbol: stringValue(process.env.BOT_SYMBOL, 'BTCUSDT'),
    interval: stringValue(process.env.BOT_INTERVAL, '1m'),
    confirmationInterval: process.env.BOT_CONFIRMATION_INTERVAL?.trim() || null,
    useScanner: process.env.BOT_USE_SCANNER === 'true',
    scanIntervalMs: numberValue(process.env.BOT_SCAN_INTERVAL_MS, 60_000),
    maxCandlesWithoutPositionBeforeSwitch: numberValue(
      process.env.BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH,
      8,
    ),
    maxScannerCandidates: numberValue(process.env.BOT_SCANNER_SHORTLIST_SIZE, 8),
    universeSize: numberValue(process.env.BOT_UNIVERSE_SIZE, 5),
    minPositionSizeUsdt: numberValue(process.env.BOT_MIN_POSITION_SIZE_USDT, 25),
    initialBalance: numberValue(process.env.BOT_INITIAL_BALANCE, 1_000),
    maxPositionSizeUsdt: numberValue(process.env.BOT_POSITION_SIZE_USDT, 0),
    maxPositionSizePctOfEquity: numberValue(
      process.env.BOT_MAX_POSITION_SIZE_PCT_OF_EQUITY,
      0.1,
    ),
    riskPerTradePct: numberValue(process.env.BOT_RISK_PER_TRADE_PCT, 0.005),
    feePct: numberValue(process.env.BOT_FEE_PCT, 0.001),
    stopLossPct: numberValue(process.env.BOT_STOP_LOSS_PCT, 0.012),
    takeProfitPct: numberValue(process.env.BOT_TAKE_PROFIT_PCT, 0.02),
    trailingStopPct: numberValue(process.env.BOT_TRAILING_STOP_PCT, 0.008),
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
    scannerMinQuoteVolume: numberValue(
      process.env.BOT_MIN_QUOTE_VOLUME,
      1_000_000,
    ),
    scannerShortlistSize: numberValue(process.env.BOT_SCANNER_SHORTLIST_SIZE, 8),
    scannerKlineLookback: numberValue(process.env.BOT_SCANNER_KLINE_LOOKBACK, 30),
    maxConcurrentPositions: numberValue(process.env.BOT_MAX_CONCURRENT_POSITIONS, 3),
    maxPortfolioExposurePct: numberValue(
      process.env.BOT_MAX_PORTFOLIO_EXPOSURE_PCT,
      0.8,
    ),
    maxDrawdownStopPct: numberValue(process.env.BOT_MAX_DRAWDOWN_STOP_PCT, 0.15),
    maxDailyLossPct: numberValue(process.env.BOT_MAX_DAILY_LOSS_PCT, 0.04),
    maxConsecutiveLosses: numberValue(
      process.env.BOT_MAX_CONSECUTIVE_LOSSES,
      4,
    ),
    maxPositionsPerSymbol: numberValue(process.env.BOT_MAX_POSITIONS_PER_SYMBOL, 2),
    maxPositionsPerStrategy: numberValue(
      process.env.BOT_MAX_POSITIONS_PER_STRATEGY,
      3,
    ),
    allowOppositePositionsSameSymbol:
      process.env.BOT_ALLOW_OPPOSITE_POSITIONS_SAME_SYMBOL === 'true',
    enabledStrategies: (process.env.BOT_ENABLED_STRATEGIES ||
      'momentum_trend,mean_reversion')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    dashboardEnabled: process.env.BOT_DASHBOARD_ENABLED !== 'false',
    dashboardHost: stringValue(process.env.BOT_DASHBOARD_HOST, '127.0.0.1'),
    dashboardPort: numberValue(process.env.BOT_DASHBOARD_PORT, 3200),
    binanceRestBaseUrl: stringValue(
      process.env.BINANCE_REST_BASE_URL,
      'https://api.binance.com',
    ),
    binanceWsBaseUrl: stringValue(
      process.env.BINANCE_WS_BASE_URL,
      'wss://stream.binance.com/ws',
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
