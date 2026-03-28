import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { SymbolScannerService } from '../../scanner/symbol-scanner/symbol-scanner.service';
import { HigherTimeframeConfirmationService } from '../../strategy/higher-timeframe-confirmation/higher-timeframe-confirmation.service';
import { StrategyArbitrationService } from '../../strategy/strategy-arbitration/strategy-arbitration.service';
import { StrategyRegistryService } from '../../strategy/strategy-registry/strategy-registry.service';
import { ExecutionGatewayService } from '../../trader/execution-gateway/execution-gateway.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { RiskManagerService } from '../../trader/risk-manager/risk-manager.service';
import { BotRunnerService } from './bot-runner.service';

describe('BotRunnerService', () => {
  let service: BotRunnerService;
  const buildCandles = (count: number, interval: string, symbol = 'BTCUSDT') =>
    Array.from({ length: count }, (_, index) => {
      const base = 100 + index * 0.25;
      return {
        symbol,
        interval,
        openTime: index * 60_000,
        closeTime: index * 60_000 + 59_999,
        open: base,
        high: base + 0.4,
        low: base - 0.4,
        close: base + 0.2,
        volume: 100 + index,
        isClosed: true,
      };
    });
  const marketMock = {
    connectSymbols: jest.fn(),
    connectSymbolIntervals: jest.fn(),
    replaceSymbols: jest.fn(),
    replaceSymbolIntervals: jest.fn(),
    loadHistoricalCandles: jest.fn(),
  };
  const scannerMock = {
    scanBestSymbol: jest.fn().mockResolvedValue(null),
    scanTopSymbols: jest.fn().mockResolvedValue([]),
  };
  const strategyMock = {
    id: 'momentum_trend',
    name: 'Momentum Trend',
    getRequiredWarmupCandles: jest.fn().mockReturnValue(25),
    getConfirmationPolicy: jest.fn().mockReturnValue('align_with_signal'),
    seedHistory: jest.fn(),
    resetSymbol: jest.fn(),
    onNewCandle: jest.fn(),
    registerTradeClosed: jest.fn(),
  };
  const strategyRegistryMock = {
    getStrategies: jest.fn().mockReturnValue([strategyMock]),
    getStrategyById: jest.fn().mockImplementation((id: string) => {
      return id === strategyMock.id ? strategyMock : null;
    }),
  };
  const strategyArbitrationMock = {
    rankCandidates: jest.fn().mockImplementation((candidates: any[], executionStatus: any) => {
      return candidates
        .map((candidate: any) => ({
          ...candidate,
          entryScore: candidate.result?.entryScore ?? 0,
          arbitrationScore: candidate.result?.entryScore ?? 0,
          isAllowed: candidate.side === 'LONG' || executionStatus.canTradeShort,
        }))
        .sort((left: any, right: any) => right.arbitrationScore - left.arbitrationScore);
    }),
    selectCandidate: jest.fn().mockImplementation((_: unknown, candidates: any[]) => {
      if (candidates.length === 0) {
        return {
          symbol: 'BTCUSDT',
          selectedStrategyId: null,
          selectedStrategyName: null,
          selectedSide: null,
          selectedScore: null,
          reason: 'no candidates',
          candidates: [],
        };
      }

      return {
        symbol: 'BTCUSDT',
        selectedStrategyId: candidates[0].strategy.id,
        selectedStrategyName: candidates[0].strategy.name,
        selectedSide: candidates[0].side,
        selectedScore: candidates[0].result?.entryScore ?? 0,
        reason: 'test selection',
        candidates: candidates.map((candidate: any, index: number) => ({
          strategyId: candidate.strategy.id,
          strategyName: candidate.strategy.name,
          side: candidate.side,
          entryScore: candidate.result?.entryScore ?? 0,
          arbitrationScore: candidate.result?.entryScore ?? 0,
          marketRegime: candidate.result?.marketRegime ?? null,
          status: index === 0 ? 'selected' : 'rejected',
          reason: index === 0 ? 'winner' : 'loser',
        })),
      };
    }),
  };
  const traderMock = {
    checkStops: jest.fn().mockReturnValue([]),
    tryOpenLong: jest.fn(),
    tryOpenShort: jest.fn(),
    tryCloseLong: jest.fn(),
    tryCloseShort: jest.fn(),
    getExecutionStatus: jest.fn().mockReturnValue({
      mode: 'paper',
      marketType: 'spot',
      label: 'PAPER',
      canTradeShort: true,
      liveTradingEnabled: false,
      usingTestnet: false,
      allowLiveReal: false,
      apiConfigured: false,
      accountConnectivity: 'unknown',
      quoteAsset: 'USDT',
      quoteFree: 1000,
      quoteTotal: 1000,
      warnings: [],
    }),
    refreshExecutionStatus: jest.fn(),
    setExecutionMode: jest.fn(),
  };
  const confirmationMock = {
    getRequiredWarmupCandles: jest.fn().mockReturnValue(20),
    seedHistory: jest.fn(),
    resetSymbol: jest.fn(),
    onNewCandle: jest.fn().mockReturnValue({
      isReady: true,
      trend: 'BULLISH',
      trendStrengthPct: 0.01,
    }),
    getTrend: jest.fn().mockReturnValue({
      isReady: true,
      trend: 'BULLISH',
      trendStrengthPct: 0.01,
    }),
  };
  const portfolioMock = {
    hasOpenPosition: jest.fn().mockReturnValue(false),
    getOpenPositionsCount: jest.fn().mockReturnValue(0),
    getPositionsForSymbol: jest.fn().mockReturnValue([]),
    getPosition: jest.fn().mockReturnValue(null),
    getOpenPositions: jest.fn().mockReturnValue([]),
    getPositionUnrealizedPnl: jest.fn().mockReturnValue(0),
    getMarkPrice: jest.fn().mockReturnValue(101),
    getSnapshot: jest.fn().mockReturnValue({
      balance: 1000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: 1000,
      feesPaid: 0,
      peakEquity: 1000,
      maxDrawdownPct: 0,
      openPositions: [],
      openPositionsCount: 0,
      exposureByStrategy: {},
      totalTrades: 0,
      wins: 0,
      losses: 0,
      consecutiveLosses: 0,
    }),
    getEquity: jest.fn().mockReturnValue(1000),
    trackDrawdown: jest.fn(),
    getWinRate: jest.fn().mockReturnValue(0),
    updateMark: jest.fn(),
  };
  const riskManagerMock = {
    approveOpenPosition: jest.fn(),
    getRiskState: jest.fn().mockReturnValue({}),
  };
  const loggerMock = {
    logInfo: jest.fn(),
    logError: jest.fn(),
    logCandle: jest.fn(),
    logSignal: jest.fn(),
    logTrade: jest.fn(),
    logPortfolio: jest.fn(),
  };

  beforeEach(async () => {
    process.env.BOT_USE_SCANNER = 'false';
    process.env.BOT_SYMBOL = 'BTCUSDT';
    process.env.BOT_ALLOWED_SYMBOLS = 'BTCUSDT';
    process.env.BOT_INTERVAL = '1m';
    process.env.BOT_UNIVERSE_SIZE = '2';
    process.env.BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH = '2';
    process.env.BOT_DYNAMIC_TIMEFRAME_ENABLED = 'false';
    delete process.env.BOT_DYNAMIC_TIMEFRAME_CANDIDATES;
    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_CONFIRMATION_MODE;
    resetBotConfigCache();
    marketMock.loadHistoricalCandles.mockImplementation(
      async (_symbol: string, interval: string, limit = 200) => buildCandles(limit, interval),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyRegistryService, useValue: strategyRegistryMock },
        { provide: StrategyArbitrationService, useValue: strategyArbitrationMock },
        {
          provide: HigherTimeframeConfirmationService,
          useValue: confirmationMock,
        },
        { provide: ExecutionGatewayService, useValue: traderMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: RiskManagerService, useValue: riskManagerMock },
        { provide: BotLoggerService, useValue: loggerMock },
        { provide: SymbolScannerService, useValue: scannerMock },
      ],
    }).compile();

    service = module.get<BotRunnerService>(BotRunnerService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('preloads history and connects market stream on start', async () => {
    await service.start();

    expect(marketMock.loadHistoricalCandles).toHaveBeenCalledWith('BTCUSDT', '1m', 60);
    expect(strategyMock.seedHistory).toHaveBeenCalled();
    expect(marketMock.connectSymbols).toHaveBeenCalledWith(
      ['BTCUSDT'],
      '1m',
      expect.any(Function),
    );
  });

  it('uses higher timeframe subscription when confirmation interval is enabled', async () => {
    process.env.BOT_CONFIRMATION_INTERVAL = '5m';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyRegistryService, useValue: strategyRegistryMock },
        { provide: StrategyArbitrationService, useValue: strategyArbitrationMock },
        {
          provide: HigherTimeframeConfirmationService,
          useValue: confirmationMock,
        },
        { provide: ExecutionGatewayService, useValue: traderMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: RiskManagerService, useValue: riskManagerMock },
        { provide: BotLoggerService, useValue: loggerMock },
        { provide: SymbolScannerService, useValue: scannerMock },
      ],
    }).compile();

    const serviceWithConfirmation = module.get<BotRunnerService>(BotRunnerService);
    await serviceWithConfirmation.start();

    expect(marketMock.loadHistoricalCandles).toHaveBeenCalledWith('BTCUSDT', '1m', 60);
    expect(marketMock.loadHistoricalCandles).toHaveBeenCalledWith('BTCUSDT', '5m', 40);
    expect(marketMock.connectSymbolIntervals).toHaveBeenCalledWith(
      ['BTCUSDT'],
      ['1m', '5m'],
      expect.any(Function),
    );

    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_ALLOWED_SYMBOLS;
    resetBotConfigCache();
  });

  it('skips symbol when execution warmup history is insufficient', async () => {
    marketMock.loadHistoricalCandles.mockImplementation(
      async (_symbol: string, interval: string) => buildCandles(10, interval),
    );

    await service.start();

    expect(strategyMock.seedHistory).not.toHaveBeenCalled();
    expect(marketMock.connectSymbols).not.toHaveBeenCalled();
    expect(loggerMock.logInfo).toHaveBeenCalledWith(
      'Символ пропущен: не удалось безопасно прогреть историю',
      expect.objectContaining({
        символ: 'BTCUSDT',
      }),
    );
  });

  it('skips symbol when confirmation warmup history is insufficient', async () => {
    process.env.BOT_CONFIRMATION_INTERVAL = '5m';
    resetBotConfigCache();
    marketMock.loadHistoricalCandles.mockImplementation(
      async (_symbol: string, interval: string, limit = 200) =>
        interval === '5m' ? buildCandles(5, interval) : buildCandles(limit, interval),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyRegistryService, useValue: strategyRegistryMock },
        { provide: StrategyArbitrationService, useValue: strategyArbitrationMock },
        {
          provide: HigherTimeframeConfirmationService,
          useValue: confirmationMock,
        },
        { provide: ExecutionGatewayService, useValue: traderMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: RiskManagerService, useValue: riskManagerMock },
        { provide: BotLoggerService, useValue: loggerMock },
        { provide: SymbolScannerService, useValue: scannerMock },
      ],
    }).compile();

    const serviceWithConfirmation = module.get<BotRunnerService>(BotRunnerService);
    await serviceWithConfirmation.start();

    expect(confirmationMock.seedHistory).not.toHaveBeenCalled();
    expect(marketMock.connectSymbolIntervals).not.toHaveBeenCalled();
    expect(loggerMock.logInfo).toHaveBeenCalledWith(
      'Символ пропущен: не удалось безопасно прогреть историю',
      expect.objectContaining({
        символ: 'BTCUSDT',
        confirmationInterval: '5m',
      }),
    );

    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_ALLOWED_SYMBOLS;
    resetBotConfigCache();
  });

  it('selects adaptive timeframe when fast interval quality is weak', async () => {
    process.env.BOT_DYNAMIC_TIMEFRAME_ENABLED = 'true';
    process.env.BOT_DYNAMIC_TIMEFRAME_CANDIDATES = '5m,15m,30m';
    process.env.BOT_ALLOWED_SYMBOLS = 'BTCUSDT';
    process.env.BOT_USE_SCANNER = 'false';
    resetBotConfigCache();

    const buildCandles = (values: number[], interval: string) =>
      values.map((close, index) => ({
        symbol: 'BTCUSDT',
        interval,
        openTime: index * 60_000,
        closeTime: index * 60_000 + 59_999,
        open: index === 0 ? close : values[index - 1],
        high: Math.max(close, index === 0 ? close : values[index - 1]) + 0.2,
        low: Math.min(close, index === 0 ? close : values[index - 1]) - 0.2,
        close,
        volume: 100 + index,
        isClosed: true,
      }));
    const stretchSeries = (values: number[], targetLength: number) =>
      Array.from({ length: targetLength }, (_, index) => {
        const cycle = Math.floor(index / values.length);
        return values[index % values.length] + cycle * 0.8;
      });

    marketMock.loadHistoricalCandles.mockImplementation(
      async (_symbol: string, interval: string, limit = 200) => {
        if (interval === '5m') {
          return buildCandles(
            stretchSeries(
              [
                100, 101, 99.5, 101.5, 99.8, 101.8, 100.2, 102, 100.5, 102.2, 100.6, 102.1,
                100.7, 102.3, 100.8, 102.4, 101, 102.5, 101.1, 102.7, 101.2, 102.6, 101.3,
                102.8,
              ],
              limit,
            ),
            interval,
          );
        }

        if (interval === '15m') {
          return buildCandles(
            stretchSeries(
              [
                100, 100.4, 100.8, 101.2, 101.6, 102, 102.5, 103, 103.6, 104.1, 104.7, 105.2,
                105.8, 106.4, 107, 107.6, 108.3, 109, 109.8, 110.5, 111.2, 112, 112.7, 113.5,
              ],
              limit,
            ),
            interval,
          );
        }

        return buildCandles(
          stretchSeries(
            [
              100, 100.6, 101.2, 101.9, 102.5, 103.2, 103.9, 104.7, 105.4, 106.2, 107, 107.8,
              108.7, 109.5, 110.4, 111.3, 112.2, 113.1, 114, 115, 116, 117, 118, 119,
            ],
            limit,
          ),
          interval,
        );
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyRegistryService, useValue: strategyRegistryMock },
        { provide: StrategyArbitrationService, useValue: strategyArbitrationMock },
        {
          provide: HigherTimeframeConfirmationService,
          useValue: confirmationMock,
        },
        { provide: ExecutionGatewayService, useValue: traderMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: RiskManagerService, useValue: riskManagerMock },
        { provide: BotLoggerService, useValue: loggerMock },
        { provide: SymbolScannerService, useValue: scannerMock },
      ],
    }).compile();

    const adaptiveService = module.get<BotRunnerService>(BotRunnerService);
    await adaptiveService.start();

    expect(marketMock.connectSymbolIntervals).toHaveBeenCalledWith(
      ['BTCUSDT'],
      ['15m', '30m'],
      expect.any(Function),
    );
    expect(loggerMock.logInfo).toHaveBeenCalledWith(
      'Адаптивный timeframe обновлён',
      expect.objectContaining({
        executionInterval: '15m',
        confirmationInterval: '30m',
      }),
    );
  });

  it('allows short signal on neutral confirmation in lenient mode', async () => {
    process.env.BOT_CONFIRMATION_INTERVAL = '5m';
    process.env.BOT_CONFIRMATION_MODE = 'lenient';
    resetBotConfigCache();

    confirmationMock.getTrend.mockReturnValueOnce({
      isReady: true,
      trend: 'NEUTRAL',
      trendStrengthPct: 0.0005,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyRegistryService, useValue: strategyRegistryMock },
        { provide: StrategyArbitrationService, useValue: strategyArbitrationMock },
        {
          provide: HigherTimeframeConfirmationService,
          useValue: confirmationMock,
        },
        { provide: ExecutionGatewayService, useValue: traderMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: RiskManagerService, useValue: riskManagerMock },
        { provide: BotLoggerService, useValue: loggerMock },
        { provide: SymbolScannerService, useValue: scannerMock },
      ],
    }).compile();

    const serviceWithLenientMode = module.get<BotRunnerService>(BotRunnerService);
    const filtered = (serviceWithLenientMode as any).applyConfirmationFilter(
      'BTCUSDT',
      strategyMock,
      {
        signal: 'OPEN_SHORT',
        reason: 'test short',
      },
    );

    expect(filtered.signal).toBe('OPEN_SHORT');

    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_CONFIRMATION_MODE;
    delete process.env.BOT_ALLOWED_SYMBOLS;
    resetBotConfigCache();
  });

  it('blocks mean reversion short against strong bullish higher timeframe', () => {
    process.env.BOT_CONFIRMATION_INTERVAL = '5m';
    process.env.BOT_CONFIRMATION_MODE = 'lenient';
    process.env.BOT_MEAN_REVERSION_MAX_HIGHER_TREND_PCT = '0.002';
    resetBotConfigCache();

    confirmationMock.getTrend.mockReturnValueOnce({
      isReady: true,
      trend: 'BULLISH',
      trendStrengthPct: 0.003,
    });

    const meanReversionStrategy = {
      id: 'mean_reversion',
      name: 'Mean Reversion',
      getConfirmationPolicy: jest.fn().mockReturnValue('none'),
    };

    const refreshedService = new BotRunnerService(
      marketMock as any,
      strategyRegistryMock as any,
      strategyArbitrationMock as any,
      confirmationMock as any,
      traderMock as any,
      portfolioMock as any,
      riskManagerMock as any,
      loggerMock as any,
      scannerMock as any,
    );

    const filtered = (refreshedService as any).applyConfirmationFilter(
      'SOLUSDT',
      meanReversionStrategy,
      {
        signal: 'OPEN_SHORT',
        reason: 'mean reversion short',
      },
    );

    expect(filtered.signal).toBe('HOLD');
    expect(filtered.reason).toContain('против сильного bullish higher timeframe');

    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_CONFIRMATION_MODE;
    delete process.env.BOT_MEAN_REVERSION_MAX_HIGHER_TREND_PCT;
    resetBotConfigCache();
  });

  it('downgrades mean reversion reverse against strong bearish higher timeframe to close-only', () => {
    process.env.BOT_CONFIRMATION_INTERVAL = '5m';
    process.env.BOT_CONFIRMATION_MODE = 'lenient';
    process.env.BOT_MEAN_REVERSION_MAX_HIGHER_TREND_PCT = '0.002';
    resetBotConfigCache();

    confirmationMock.getTrend.mockReturnValueOnce({
      isReady: true,
      trend: 'BEARISH',
      trendStrengthPct: 0.003,
    });

    const meanReversionStrategy = {
      id: 'mean_reversion',
      name: 'Mean Reversion',
      getConfirmationPolicy: jest.fn().mockReturnValue('none'),
    };

    const refreshedService = new BotRunnerService(
      marketMock as any,
      strategyRegistryMock as any,
      strategyArbitrationMock as any,
      confirmationMock as any,
      traderMock as any,
      portfolioMock as any,
      riskManagerMock as any,
      loggerMock as any,
      scannerMock as any,
    );

    const filtered = (refreshedService as any).applyConfirmationFilter(
      'SOLUSDT',
      meanReversionStrategy,
      {
        signal: 'REVERSE_TO_LONG',
        reason: 'mean reversion reverse',
      },
    );

    expect(filtered.signal).toBe('CLOSE_SHORT');
    expect(filtered.forceClose).toBe(true);
    expect(filtered.reason).toContain('против сильного bearish higher timeframe');

    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_CONFIRMATION_MODE;
    delete process.env.BOT_MEAN_REVERSION_MAX_HIGHER_TREND_PCT;
    resetBotConfigCache();
  });

  it('rotates out idle symbols when scanner provides new candidates', () => {
    (service as any).watchedSymbols.add('BTCUSDT');
    (service as any).watchedSymbols.add('ETHUSDT');
    (service as any).candlesWithoutPosition.set('BTCUSDT', 2);
    (service as any).candlesWithoutPosition.set('ETHUSDT', 1);

    const nextUniverse = (service as any).buildTargetUniverse([
      {
        symbol: 'SOLUSDT',
        score: 5,
        priceChangePercent: 1,
        quoteVolume: 1_000_000,
        recentMovePct: 0.01,
        intradayVolatilityPct: 0.01,
        volumeAcceleration: 0.2,
      },
      {
        symbol: 'BNBUSDT',
        score: 4,
        priceChangePercent: 0.8,
        quoteVolume: 900_000,
        recentMovePct: 0.008,
        intradayVolatilityPct: 0.009,
        volumeAcceleration: 0.15,
      },
    ]);

    expect(nextUniverse).toContain('ETHUSDT');
    expect(nextUniverse).toContain('SOLUSDT');
    expect(nextUniverse).not.toContain('BTCUSDT');
  });

  it('closes one selected position separately', async () => {
    portfolioMock.getPosition.mockReturnValueOnce({
      symbol: 'BTCUSDT',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum Trend',
      side: 'LONG',
      entryPrice: 100,
    });
    traderMock.tryCloseLong.mockReturnValueOnce({
      status: 'EXECUTED',
      trade: {
        action: 'CLOSE_LONG',
        symbol: 'BTCUSDT',
        interval: '1m',
        strategyId: 'momentum_trend',
        strategyName: 'Momentum Trend',
        side: 'LONG',
        entryPrice: 100,
        exitPrice: 101,
        reason: 'manual close',
      },
    });

    const result = await service.closePosition(
      'BTCUSDT',
      'momentum_trend',
      'manual close',
    );

    expect(traderMock.tryCloseLong).toHaveBeenCalledWith(
      'BTCUSDT',
      'momentum_trend',
      101,
      expect.any(Number),
      'manual close',
    );
    expect(result.closed).toBe(true);
  });

  it('forces close when confirmation downgrades reverse into close-only', async () => {
    process.env.BOT_CONFIRMATION_INTERVAL = '5m';
    process.env.BOT_CONFIRMATION_MODE = 'strict';
    process.env.BOT_ALLOWED_SYMBOLS = 'BTCUSDT';
    resetBotConfigCache();

    const longPosition = {
      symbol: 'BTCUSDT',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum Trend',
      side: 'LONG',
      interval: '1m',
      entryPrice: 100,
      stopPrice: 99,
      takePrice: 102,
      quantity: 1,
      highestPrice: 100,
      lowestPrice: 100,
      openedAt: 1,
      marketType: 'spot',
    };
    portfolioMock.getPositionsForSymbol.mockReturnValue([longPosition]);
    portfolioMock.getPosition.mockReturnValue(longPosition);
    strategyMock.onNewCandle.mockReturnValue({
      signal: 'REVERSE_TO_SHORT',
      reason: 'reverse test',
    });
    confirmationMock.getTrend.mockReturnValue({
      isReady: false,
      trend: 'NEUTRAL',
      trendStrengthPct: 0,
    });
    traderMock.tryCloseLong.mockReturnValueOnce({
      status: 'EXECUTED',
      trade: {
        action: 'CLOSE_LONG',
        symbol: 'BTCUSDT',
        interval: '1m',
        strategyId: 'momentum_trend',
        strategyName: 'Momentum Trend',
        side: 'LONG',
        entryPrice: 100,
        exitPrice: 100,
        reason: 'forced close',
      },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyRegistryService, useValue: strategyRegistryMock },
        { provide: StrategyArbitrationService, useValue: strategyArbitrationMock },
        {
          provide: HigherTimeframeConfirmationService,
          useValue: confirmationMock,
        },
        { provide: ExecutionGatewayService, useValue: traderMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: RiskManagerService, useValue: riskManagerMock },
        { provide: BotLoggerService, useValue: loggerMock },
        { provide: SymbolScannerService, useValue: scannerMock },
      ],
    }).compile();
    const serviceWithConfirmation = module.get<BotRunnerService>(BotRunnerService);
    (serviceWithConfirmation as any).watchedSymbols.add('BTCUSDT');

    await (serviceWithConfirmation as any).handleCandle({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: 0,
      closeTime: 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      isClosed: true,
    });

    expect(traderMock.tryCloseLong).toHaveBeenCalled();
    expect(traderMock.tryOpenShort).not.toHaveBeenCalled();

    delete process.env.BOT_CONFIRMATION_INTERVAL;
    delete process.env.BOT_CONFIRMATION_MODE;
    delete process.env.BOT_ALLOWED_SYMBOLS;
    resetBotConfigCache();
  });
});
