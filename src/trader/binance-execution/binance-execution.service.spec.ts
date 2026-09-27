import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { PaperTraderService } from '../paper-trader/paper-trader.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { BinanceExecutionService } from './binance-execution.service';

describe('BinanceExecutionService', () => {
  let service: BinanceExecutionService;

  beforeEach(async () => {
    process.env.BOT_EXECUTION_MODE = 'live_testnet';
    process.env.BINANCE_TESTNET_API_KEY = 'spot-key';
    process.env.BINANCE_TESTNET_API_SECRET = 'spot-secret';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BinanceExecutionService,
        {
          provide: PortfolioService,
          useValue: {
            balance: 1000,
            getEquity: jest.fn().mockReturnValue(1000),
            syncExternalUsdtWallet: jest.fn(),
          },
        },
        {
          provide: PaperTraderService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<BinanceExecutionService>(BinanceExecutionService);
  });

  it('returns readable status error when spot SDK throws a plain object', async () => {
    jest
      .spyOn(service as any, 'refreshSpotAccountStatus')
      .mockRejectedValue({ body: 'Binance spot denied request' });

    const status = await service.refreshAccountStatus('live_testnet', 'spot');

    expect(status.accountConnectivity).toBe('error');
    expect(status.lastError).toContain('Binance spot denied request');
  });

  it('uses REST fallback messaging for spot demo user-data stream', async () => {
    jest.spyOn(service as any, 'getSpotRestClient').mockReturnValue({
      getAccountInformation: jest.fn().mockResolvedValue({
        balances: [{ asset: 'USDT', free: '321.5', locked: '10.5' }],
      }),
      getOpenOrders: jest.fn().mockResolvedValue([]),
    });

    const status = await service.refreshAccountStatus('live_testnet', 'spot');

    expect(status.accountConnectivity).toBe('ok');
    expect(status.quoteFree).toBe(321.5);
    expect(status.quoteTotal).toBe(332);
    expect(status.warnings).toContain(
      'Spot Demo private user-data stream недоступен у Binance. Используем REST fallback для spot account sync.',
    );
    expect((status.warnings ?? []).join(' | ')).not.toContain(
      'Private user-data stream Binance не подтверждён',
    );
  });

  it('falls back to shared spot demo key for futures demo when dedicated futures key is missing', async () => {
    jest.spyOn(service as any, 'getClient').mockResolvedValue({
      fetchBalance: jest.fn().mockResolvedValue({
        USDT: {
          free: 150,
          total: 175,
        },
      }),
    });

    const status = await service.refreshAccountStatus(
      'live_testnet',
      'futures',
    );

    expect(status.accountConnectivity).toBe('ok');
    expect(status.quoteFree).toBe(150);
    expect(status.quoteTotal).toBe(175);
    expect(status.futuresQuoteFree).toBe(150);
    expect(status.futuresQuoteTotal).toBe(175);
    expect((status.warnings ?? []).join(' | ')).toContain(
      'общий demo key из BINANCE_TESTNET_API_*',
    );
  });
});
