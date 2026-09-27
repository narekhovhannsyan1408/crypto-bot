import { ExecutionMode } from '../../trader/execution.types';

export type SignalSnapshot = {
  symbol: string;
  day: number;
  close: number;
  trendScore: number;
  exposure: number;
  annualizedVol: number | null;
  smaValues: Record<number, number>;
};

export type ActivityKind =
  | 'start'
  | 'stop'
  | 'autostop'
  | 'buy'
  | 'sell'
  | 'check'
  | 'error';

export type ActivityEntry = {
  id: string;
  timestamp: number;
  kind: ActivityKind;
  title: string;
  details?: string;
  symbol?: string;
  quantity?: number;
  price?: number;
  quoteAmount?: number;
  fee?: number;
};

export type EquityPoint = { timestamp: number; equity: number };

/**
 * Сессия работы бота: от нажатия «Начать» до «Остановить».
 * Бот управляет только капиталом сессии и купленными им монетами —
 * чужие средства на аккаунте он не трогает.
 */
export type AllocatorSession = {
  id: string;
  mode: ExecutionMode;
  status: 'running' | 'stopped';
  startedAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  initialCapital: number;
  // Доля потери от стартового капитала, при которой бот сам всё продаёт (0 — выключено)
  autoStopLossPct: number;
  cash: number;
  quantities: Record<string, number>;
  feesPaid: number;
  // openTime дневной свечи, по которой уже принято решение
  lastRebalanceDay: number | null;
  lastSignals: SignalSnapshot[];
  // Цены в момент старта — для сравнения с «просто купить и держать»
  benchmarkStartPrices: Record<string, number> | null;
  equityHistory: EquityPoint[];
  activity: ActivityEntry[];
};

export type SessionSummary = {
  id: string;
  mode: ExecutionMode;
  startedAt: number;
  stoppedAt: number;
  initialCapital: number;
  finalEquity: number;
  stopReason: string;
};
