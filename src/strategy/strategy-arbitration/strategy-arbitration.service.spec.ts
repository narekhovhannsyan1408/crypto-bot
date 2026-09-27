import { StrategyArbitrationService } from './strategy-arbitration.service';

describe('StrategyArbitrationService', () => {
  const service = new StrategyArbitrationService();

  const candle = {
    symbol: 'BTCUSDT',
    interval: '1m',
  } as any;

  const momentum = {
    id: 'momentum_trend',
    name: 'Momentum Trend',
  } as any;

  const breakout = {
    id: 'breakout_volatility',
    name: 'Breakout Volatility',
  } as any;

  it('selects candidate with highest arbitration score', () => {
    const selected = service.selectCandidate(
      candle,
      [
        {
          strategy: momentum,
          side: 'LONG',
          result: {
            signal: 'OPEN_LONG',
            reason: 'a',
            entryScore: 20,
            marketRegime: 'trend_bullish',
          },
        },
        {
          strategy: breakout,
          side: 'LONG',
          result: {
            signal: 'OPEN_LONG',
            reason: 'b',
            entryScore: 18,
            marketRegime: 'breakout_bullish',
          },
        },
      ],
      {
        mode: 'paper',
        marketType: 'futures',
        label: 'PAPER',
        canTradeShort: true,
        liveTradingEnabled: false,
        usingTestnet: false,
        allowLiveReal: false,
        apiConfigured: false,
        accountConnectivity: 'unknown',
        quoteAsset: 'USDT',
        warnings: [],
      },
    );

    expect(selected.selectedStrategyId).toBe('breakout_volatility');
    expect(selected.candidates[0]?.strategyId).toBe('breakout_volatility');
    expect(selected.candidates[0]?.status).toBe('selected');
  });

  it('filters out short candidates when execution mode cannot trade short', () => {
    const selected = service.selectCandidate(
      candle,
      [
        {
          strategy: breakout,
          side: 'SHORT',
          result: {
            signal: 'OPEN_SHORT',
            reason: 'short',
            entryScore: 99,
            marketRegime: 'breakout_bearish',
          },
        },
        {
          strategy: momentum,
          side: 'LONG',
          result: {
            signal: 'OPEN_LONG',
            reason: 'long',
            entryScore: 10,
            marketRegime: 'trend_bullish',
          },
        },
      ],
      {
        mode: 'live_testnet',
        marketType: 'spot',
        label: 'TESTNET SPOT',
        canTradeShort: false,
        liveTradingEnabled: true,
        usingTestnet: true,
        allowLiveReal: false,
        apiConfigured: true,
        accountConnectivity: 'ok',
        quoteAsset: 'USDT',
        warnings: [],
      },
    );

    expect(selected.selectedStrategyId).toBe('momentum_trend');
    expect(selected.selectedSide).toBe('LONG');
    expect(
      selected.candidates.find(
        (candidate) => candidate.strategyId === 'breakout_volatility',
      )?.reason,
    ).toContain('Short недоступен');
  });
});
