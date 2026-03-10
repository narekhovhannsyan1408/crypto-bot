import { Test, TestingModule } from '@nestjs/testing';
import { resetBotConfigCache } from '../../config/bot-config';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PaperTraderService } from './paper-trader.service';

describe('PaperTraderService', () => {
  let service: PaperTraderService;
  let portfolio: PortfolioService;

  beforeEach(async () => {
    process.env.BOT_INITIAL_BALANCE = '1000';
    process.env.BOT_POSITION_SIZE_USDT = '100';
    process.env.BOT_FEE_PCT = '0.001';
    process.env.BOT_RISK_PER_TRADE_PCT = '1';
    process.env.BOT_STOP_LOSS_PCT = '0.012';
    process.env.BOT_TAKE_PROFIT_PCT = '0.02';
    process.env.BOT_TRAILING_STOP_PCT = '0.008';
    resetBotConfigCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [PaperTraderService, PortfolioService],
    }).compile();

    service = module.get<PaperTraderService>(PaperTraderService);
    portfolio = module.get<PortfolioService>(PortfolioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('charges both entry and exit fees for a flat short trade', () => {
    const open = service.tryOpenShort('BTCUSDT', '1m', 100, 1, 'test short');
    expect(open.status).toBe('EXECUTED');

    const close = service.tryCloseShort(100, 2, 'flat close');
    expect(close?.status).toBe('EXECUTED');
    expect(portfolio.balance).toBeCloseTo(999.8001, 6);
    expect(portfolio.realizedPnl).toBeCloseTo(-0.1999, 6);
  });

  it('moves trailing stop after a favorable candle', () => {
    const open = service.tryOpenLong('BTCUSDT', '1m', 100, 1, 'test long');
    expect(open.status).toBe('EXECUTED');

    service.checkStops({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: 0,
      closeTime: 60_000,
      open: 100,
      high: 101.5,
      low: 100,
      close: 101.2,
      volume: 10,
      isClosed: true,
    });

    expect(portfolio.position?.stopPrice).toBeGreaterThan(100);
  });
});
