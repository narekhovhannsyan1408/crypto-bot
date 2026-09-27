import { Candle } from '../market/types';
import { TradingStrategy } from '../strategy/types';
import { ClosedTrade } from '../trader/types';

export type BacktestInput = {
  candles: Candle[];
  // Если не задано, используются стратегии из BOT_ENABLED_STRATEGIES
  strategies?: TradingStrategy[];
};

export type BacktestEquityPoint = {
  timestamp: number;
  equity: number;
};

export type BacktestReport = {
  startingBalance: number;
  endingEquity: number;
  realizedResult: number;
  unrealizedResult: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdownPct: number;
  feesPaid: number;
  closedTrades: ClosedTrade[];
  equityCurve: BacktestEquityPoint[];
};
