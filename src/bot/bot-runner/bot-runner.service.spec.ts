import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { BotLoggerService } from '../../logger/bot-logger/bot-logger.service';
import { BinanceMarketService } from '../../market/binance-market/binance-market.service';
import { SymbolScannerService } from '../../scanner/symbol-scanner/symbol-scanner.service';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { RiskManagerService } from '../../trader/risk-manager/risk-manager.service';
import { BotRunnerService } from './bot-runner.service';

describe('BotRunnerService', () => {
  let service: BotRunnerService;
  const marketMock = {
    connectSymbols: jest.fn(),
    replaceSymbols: jest.fn(),
    loadHistoricalCandles: jest.fn().mockResolvedValue([]),
  };
  const scannerMock = {
    scanBestSymbol: jest.fn().mockResolvedValue(null),
    scanTopSymbols: jest.fn().mockResolvedValue([]),
  };
  const strategyMock = {
    seedHistory: jest.fn(),
    resetSymbol: jest.fn(),
    onNewCandle: jest.fn(),
    registerTradeClosed: jest.fn(),
  };
  const traderMock = {
    checkStops: jest.fn(),
    tryOpenLong: jest.fn(),
    tryOpenShort: jest.fn(),
    tryCloseLong: jest.fn(),
    tryCloseShort: jest.fn(),
  };
  const portfolioMock = {
    hasOpenPosition: jest.fn().mockReturnValue(false),
    getPosition: jest.fn().mockReturnValue(null),
    getOpenPositions: jest.fn().mockReturnValue([]),
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
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotRunnerService,
        { provide: BinanceMarketService, useValue: marketMock },
        { provide: StrategyService, useValue: strategyMock },
        { provide: PaperTraderService, useValue: traderMock },
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

    expect(marketMock.loadHistoricalCandles).toHaveBeenCalledWith('BTCUSDT', '1m', 250);
    expect(strategyMock.seedHistory).toHaveBeenCalled();
    expect(marketMock.connectSymbols).toHaveBeenCalledWith(
      ['BTCUSDT'],
      '1m',
      expect.any(Function),
    );
  });
});
