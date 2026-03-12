import { Candle, TradeSignal } from '../market/types';
import { PositionSide } from '../trader/types';

export type StrategyIndicators = Record<string, number>;
export type ConfirmationPolicy = 'align_with_signal' | 'none';

export type StrategyResult = {
  signal: TradeSignal;
  reason: string;
  indicators?: StrategyIndicators;
  entryScore?: number;
  marketRegime?: string;
  forceClose?: boolean;
};

export type TradingStrategy = {
  readonly id: string;
  readonly name: string;
  getRequiredWarmupCandles(): number;
  getConfirmationPolicy(): ConfirmationPolicy;
  seedHistory(symbol: string, interval: string, candles: Candle[]): void;
  resetSymbol(symbol: string, interval: string): void;
  registerTradeClosed(symbol: string, interval: string): void;
  onNewCandle(candle: Candle, positionSide: PositionSide | null): StrategyResult;
};
