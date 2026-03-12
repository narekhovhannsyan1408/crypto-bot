import { resetBotConfigCache } from '../../config/bot-config';
import { BinanceExecutionService } from '../binance-execution/binance-execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { ExecutionGatewayService } from './execution-gateway.service';
import { PaperTraderService } from '../paper-trader/paper-trader.service';
import { PortfolioService } from '../portfolio/portfolio.service';

describe('ExecutionGatewayService', () => {
  beforeEach(() => {
    process.env.BOT_INITIAL_BALANCE = '1000';
    resetBotConfigCache();
  });

  it('blocks execution mode switching when live account still has external spot exposure', async () => {
    const paperTrader = {} as jest.Mocked<PaperTraderService>;
    let currentStatus = {
      mode: 'live_testnet' as const,
      marketType: 'hybrid' as const,
      label: 'LIVE DEMO HYBRID',
      canTradeShort: true,
      longMarketType: 'spot' as const,
      shortMarketType: 'futures' as const,
      liveTradingEnabled: true,
      usingTestnet: true,
      allowLiveReal: false,
      apiConfigured: true,
      accountConnectivity: 'ok' as const,
      quoteAsset: 'USDT',
      warnings: [] as string[],
    };
    const liveTrader = {
      refreshAccountStatus: jest
        .fn()
        .mockResolvedValueOnce({
          mode: 'live_testnet',
          marketType: 'spot',
          label: 'LIVE DEMO SPOT',
          canTradeShort: false,
          longMarketType: 'spot',
          shortMarketType: 'spot',
          liveTradingEnabled: true,
          usingTestnet: true,
          allowLiveReal: false,
          apiConfigured: true,
          accountConnectivity: 'ok',
          quoteAsset: 'USDT',
          quoteFree: 1000,
          quoteTotal: 1000,
          openSpotOrdersCount: 1,
          spotAssetsCount: 2,
          spotAssetsPreview: ['BTC'],
          warnings: ['Есть открытые spot-ордера'],
        })
        .mockResolvedValueOnce({
          mode: 'live_testnet',
          marketType: 'futures',
          label: 'LIVE DEMO FUTURES',
          canTradeShort: true,
          longMarketType: 'futures',
          shortMarketType: 'futures',
          liveTradingEnabled: true,
          usingTestnet: true,
          allowLiveReal: false,
          apiConfigured: true,
          accountConnectivity: 'ok',
          quoteAsset: 'USDT',
          quoteFree: 1000,
          quoteTotal: 1000,
          warnings: [],
        }),
      syncPortfolioBalance: jest.fn(),
    } as unknown as jest.Mocked<BinanceExecutionService>;
    const executionControl = {
      getMode: jest.fn().mockReturnValue('live_testnet'),
      getMarketType: jest.fn().mockReturnValue('hybrid'),
      getStatus: jest.fn().mockImplementation(() => currentStatus),
      updateStatus: jest.fn().mockImplementation((nextStatus) => {
        currentStatus = { ...currentStatus, ...nextStatus };
      }),
      setExecutionMode: jest.fn(),
    } as unknown as jest.Mocked<ExecutionControlService>;
    const portfolio = {
      getOpenPositionsCount: jest.fn().mockReturnValue(0),
      balance: 1000,
      getEquity: jest.fn().mockReturnValue(1000),
    } as unknown as jest.Mocked<PortfolioService>;

    const service = new ExecutionGatewayService(
      paperTrader,
      liveTrader,
      executionControl,
      portfolio,
    );

    const result = await service.setExecutionMode('paper', 'spot');

    expect(result.success).toBe(false);
    expect(result.message).toContain('внешние spot-ордера');
    expect(executionControl.setExecutionMode).not.toHaveBeenCalled();
  });

  it('disables hybrid shorts when futures leg is unavailable', async () => {
    let currentStatus = {
      mode: 'live_testnet' as const,
      marketType: 'hybrid' as const,
      label: 'LIVE DEMO HYBRID',
      canTradeShort: true,
      longMarketType: 'spot' as const,
      shortMarketType: 'futures' as const,
      liveTradingEnabled: true,
      usingTestnet: true,
      allowLiveReal: false,
      apiConfigured: true,
      accountConnectivity: 'ok' as const,
      quoteAsset: 'USDT',
      warnings: [] as string[],
    };
    const paperTrader = {} as jest.Mocked<PaperTraderService>;
    const liveTrader = {
      refreshAccountStatus: jest
        .fn()
        .mockResolvedValueOnce({
          mode: 'live_testnet',
          marketType: 'spot',
          label: 'LIVE DEMO SPOT',
          canTradeShort: false,
          longMarketType: 'spot',
          shortMarketType: 'spot',
          liveTradingEnabled: true,
          usingTestnet: true,
          allowLiveReal: false,
          apiConfigured: true,
          accountConnectivity: 'ok',
          quoteAsset: 'USDT',
          quoteFree: 500,
          quoteTotal: 500,
          warnings: [],
        })
        .mockResolvedValueOnce({
          mode: 'live_testnet',
          marketType: 'futures',
          label: 'LIVE DEMO FUTURES',
          canTradeShort: true,
          longMarketType: 'futures',
          shortMarketType: 'futures',
          liveTradingEnabled: true,
          usingTestnet: true,
          allowLiveReal: false,
          apiConfigured: false,
          accountConnectivity: 'error',
          quoteAsset: 'USDT',
          quoteFree: null,
          quoteTotal: null,
          lastError: 'missing futures credentials',
          warnings: [],
        }),
      syncPortfolioBalance: jest.fn(),
    } as unknown as jest.Mocked<BinanceExecutionService>;
    const executionControl = {
      getMode: jest.fn().mockReturnValue('live_testnet'),
      getMarketType: jest.fn().mockReturnValue('hybrid'),
      getStatus: jest.fn().mockImplementation(() => currentStatus),
      updateStatus: jest.fn().mockImplementation((nextStatus) => {
        currentStatus = { ...currentStatus, ...nextStatus };
      }),
      setExecutionMode: jest.fn(),
    } as unknown as jest.Mocked<ExecutionControlService>;
    const portfolio = {
      getOpenPositionsCount: jest.fn().mockReturnValue(0),
      balance: 1000,
      getEquity: jest.fn().mockReturnValue(1000),
    } as unknown as jest.Mocked<PortfolioService>;

    const service = new ExecutionGatewayService(
      paperTrader,
      liveTrader,
      executionControl,
      portfolio,
    );

    const status = await service.refreshExecutionStatus();

    expect(status.canTradeShort).toBe(false);
    expect(status.accountConnectivity).toBe('ok');
    expect((status.warnings ?? []).join(' | ')).toContain(
      'Hybrid short временно отключён',
    );
    expect(liveTrader.syncPortfolioBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteFree: 500,
        quoteTotal: 500,
        accountConnectivity: 'ok',
      }),
    );
  });
});
