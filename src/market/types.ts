export type Candle = {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
};

export type TradeSignal =
  | 'OPEN_LONG'
  | 'CLOSE_LONG'
  | 'OPEN_SHORT'
  | 'CLOSE_SHORT'
  | 'REVERSE_TO_LONG'
  | 'REVERSE_TO_SHORT'
  | 'HOLD';
