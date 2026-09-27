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
    process.env.BOT_BREAKEVEN_TRIGGER_PCT = '0';
    process.env.BOT_BREAKEVEN_OFFSET_PCT = '0';
    process.env.BOT_MAX_POSITION_HOLD_MINUTES = '0';
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
    const open = service.tryOpenShort(
      'BTCUSDT',
      '1m',
      'momentum_trend',
      'Momentum Trend',
      100,
      1,
      'test short',
      100,
    );
    expect(open.status).toBe('EXECUTED');

    const close = service.tryCloseShort(
      'BTCUSDT',
      'momentum_trend',
      100,
      2,
      'flat close',
    );
    expect(close?.status).toBe('EXECUTED');
    expect(portfolio.balance).toBeCloseTo(999.8001, 6);
    expect(portfolio.realizedPnl).toBeCloseTo(-0.1999, 6);
  });

  it('does not count capital locked in other open positions as drawdown on close', () => {
    for (const symbol of ['ETHUSDT', 'SOLUSDT', 'BNBUSDT']) {
      service.tryOpenLong(
        symbol,
        '1m',
        'momentum_trend',
        'Momentum Trend',
        100,
        1,
        'hold',
        100,
      );
    }
    service.tryOpenLong(
      'BTCUSDT',
      '1m',
      'mean_reversion',
      'Mean Reversion',
      100,
      1,
      'test',
      100,
    );

    service.tryCloseLong('BTCUSDT', 'mean_reversion', 100, 2, 'flat close');

    // Реальные потери — только комиссии (~0.8 USDT), а не 300 USDT в других позициях
    expect(portfolio.maxDrawdownPct).toBeLessThan(0.1);
  });

  it('applies adverse slippage to entry and exit prices when configured', () => {
    process.env.BOT_SLIPPAGE_PCT = '0.001';
    resetBotConfigCache();
    const slippagePortfolio = new PortfolioService();
    const slippageTrader = new PaperTraderService(slippagePortfolio);
    delete process.env.BOT_SLIPPAGE_PCT;
    resetBotConfigCache();

    const open = slippageTrader.tryOpenLong(
      'BTCUSDT',
      '1m',
      'momentum_trend',
      'Momentum Trend',
      100,
      1,
      'test',
      100,
    );
    const close = slippageTrader.tryCloseLong(
      'BTCUSDT',
      'momentum_trend',
      100,
      2,
      'flat close',
    );

    expect(open.status === 'EXECUTED' && open.trade.price).toBeCloseTo(
      100.1,
      6,
    );
    expect(close?.status === 'EXECUTED' && close.trade.exitPrice).toBeCloseTo(
      99.9,
      6,
    );
    expect(slippagePortfolio.realizedPnl).toBeLessThan(-0.3);
  });

  it('rejects spot-mode short positions in paper trading', () => {
    const open = service.tryOpenShort(
      'BTCUSDT',
      '1m',
      'momentum_trend',
      'Momentum Trend',
      100,
      1,
      'spot short test',
      100,
      'spot',
    );

    expect(open.status).toBe('REJECTED');
    if (open.status === 'REJECTED') {
      expect(open.reason).toContain('Spot');
    }
  });

  it('moves trailing stop after a favorable candle', () => {
    const open = service.tryOpenLong(
      'BTCUSDT',
      '1m',
      'momentum_trend',
      'Momentum Trend',
      100,
      1,
      'test long',
      100,
    );
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

    expect(portfolio.getPosition('BTCUSDT', 'momentum_trend')?.stopPrice).toBeGreaterThan(100);
  });

  it('arms breakeven after a sufficiently favorable close', async () => {
    process.env.BOT_BREAKEVEN_TRIGGER_PCT = '0.006';
    process.env.BOT_BREAKEVEN_OFFSET_PCT = '0.0005';
    resetBotConfigCache();

    const moduleRef = await Test.createTestingModule({
      providers: [PaperTraderService, PortfolioService],
    }).compile();
    const svc = moduleRef.get<PaperTraderService>(PaperTraderService);
    const port = moduleRef.get<PortfolioService>(PortfolioService);

    const open = svc.tryOpenLong(
      'BTCUSDT',
      '1m',
      'momentum_trend',
      'Momentum Trend',
      100,
      1,
      'test long',
      100,
    );
    expect(open.status).toBe('EXECUTED');

    svc.checkStops({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: 0,
      closeTime: 60_000,
      open: 100,
      high: 101.1,
      low: 100.2,
      close: 100.7,
      volume: 10,
      isClosed: true,
    });

    const position = port.getPosition('BTCUSDT', 'momentum_trend');
    expect(position?.breakevenArmed).toBe(true);
    expect(position?.stopPrice ?? 0).toBeGreaterThan(100);
  });

  it('closes a position when max hold time is exceeded', async () => {
    process.env.BOT_MAX_POSITION_HOLD_MINUTES = '30';
    resetBotConfigCache();

    const moduleRef = await Test.createTestingModule({
      providers: [PaperTraderService, PortfolioService],
    }).compile();
    const svc = moduleRef.get<PaperTraderService>(PaperTraderService);
    const port = moduleRef.get<PortfolioService>(PortfolioService);

    const open = svc.tryOpenLong(
      'BTCUSDT',
      '1m',
      'momentum_trend',
      'Momentum Trend',
      100,
      1,
      'test long',
      100,
    );
    expect(open.status).toBe('EXECUTED');

    const actions = svc.checkStops({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: 0,
      closeTime: 31 * 60_000,
      open: 100,
      high: 100.5,
      low: 99.9,
      close: 100.2,
      volume: 10,
      isClosed: true,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe('EXECUTED');
    expect(port.getPosition('BTCUSDT', 'momentum_trend')).toBeNull();
  });

  it('records external live fills with actual quantity and supports partial close accounting', () => {
    const open = service.recordExternalOpenPosition({
      side: 'LONG',
      symbol: 'BTCUSDT',
      interval: '1m',
      strategyId: 'momentum_trend',
      strategyName: 'Momentum Trend',
      price: 100,
      timestamp: 1,
      reason: 'live fill',
      quantity: 0.987,
      investedUsdt: 98.8,
      entryFeePaid: 0.1,
      marketType: 'spot',
    });
    expect(open.status).toBe('EXECUTED');
    expect(portfolio.getPosition('BTCUSDT', 'momentum_trend')?.quantity).toBeCloseTo(
      0.987,
      8,
    );

    const partialClose = service.recordExternalClosePosition({
      expectedSide: 'LONG',
      symbol: 'BTCUSDT',
      strategyId: 'momentum_trend',
      price: 101,
      timestamp: 2,
      reason: 'partial live close',
      executedQuantity: 0.5,
      exitFeePaid: 0.05,
      marketType: 'spot',
    });
    expect(partialClose?.status).toBe('EXECUTED');

    const remainingPosition = portfolio.getPosition('BTCUSDT', 'momentum_trend');
    expect(remainingPosition).not.toBeNull();
    expect(remainingPosition?.quantity).toBeCloseTo(0.487, 8);
    expect(portfolio.closedTrades.at(-1)?.quantity).toBeCloseTo(0.5, 8);
  });
});
