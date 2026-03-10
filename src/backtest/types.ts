import { Candle } from '../market/types';
import { ClosedTrade } from '../trader/types';

export type BacktestInput = {
  candles: Candle[];
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
