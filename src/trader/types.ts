export type PositionSide = 'LONG' | 'SHORT';

export type PositionKey = string;

export type Position = {
  symbol: string;
  interval: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  investedUsdt: number;
  openedAt: number;
  entryFeePaid: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  stopPrice: number;
  takePrice: number;
  highestPrice: number;
  lowestPrice: number;
};

export type ClosedTrade = {
  symbol: string;
  interval: string;
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  investedUsdt: number;
  grossPnl: number;
  pnlNet: number;
  totalFees: number;
  exitFee: number;
  openedAt: number;
  closedAt: number;
  reason: string;
};

export type ExecutedTrade = {
  action: 'OPEN_LONG' | 'CLOSE_LONG' | 'OPEN_SHORT' | 'CLOSE_SHORT';
  symbol: string;
  interval: string;
  side: PositionSide;
  price?: number;
  entryPrice?: number;
  exitPrice?: number;
  quantity?: number;
  fee?: number;
  totalFees?: number;
  grossPnl?: number;
  pnlNet?: number;
  openedAt?: number;
  closedAt?: number;
  reason: string;
};

export type ExecutionResult =
  | {
      status: 'EXECUTED';
      trade: ExecutedTrade;
    }
  | {
      status: 'REJECTED';
      action:
        | 'OPEN_LONG'
        | 'CLOSE_LONG'
        | 'OPEN_SHORT'
        | 'CLOSE_SHORT'
        | 'CHECK_STOPS';
      symbol?: string;
      interval?: string;
      reason: string;
    };

export type RiskApproval =
  | {
      status: 'APPROVED';
      approvedSizeUsdt: number;
      reason: string;
    }
  | {
      status: 'DENIED';
      reason: string;
    };

export type PortfolioSnapshot = {
  balance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  feesPaid: number;
  peakEquity: number;
  maxDrawdownPct: number;
  openPositions: Position[];
  openPositionsCount: number;
  totalTrades: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
};
