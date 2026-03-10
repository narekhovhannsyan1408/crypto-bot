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
  const marketMock = {
    connectSymbols: jest.fn(),
    connectSymbolIntervals: jest.fn(),
    replaceSymbols: jest.fn(),
    replaceSymbolIntervals: jest.fn(),
    loadHistoricalCandles: jest.fn().mockResolvedValue([]),
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
    process.env.BOT_INTERVAL = '1m';
    process.env.BOT_UNIVERSE_SIZE = '2';
    process.env.BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH = '2';
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
    resetBotConfigCache();
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
});
