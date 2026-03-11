import { Candle } from '../market/types';
import { Position } from './types';

export const shouldArmBreakeven = (
  position: Position,
  candleClose: number,
  breakevenTriggerPct: number,
) => {
  if (position.breakevenArmed || breakevenTriggerPct <= 0) {
    return false;
  }

  if (position.side === 'LONG') {
    return candleClose >= position.entryPrice * (1 + breakevenTriggerPct);
  }

  return candleClose <= position.entryPrice * (1 - breakevenTriggerPct);
};

export const getBreakevenStopPrice = (
  position: Position,
  feePct: number,
  breakevenOffsetPct: number,
) => {
  if (position.side === 'LONG') {
    const denominator = position.quantity * (1 - feePct);
    const rawBreakeven =
      denominator > 0 ? position.investedUsdt / denominator : position.entryPrice;

    return rawBreakeven * (1 + Math.max(breakevenOffsetPct, 0));
  }

  const denominator = 1 + feePct;
  const rawBreakeven =
    denominator > 0
      ? (2 * position.entryPrice - position.investedUsdt / position.quantity) /
        denominator
      : position.entryPrice;

  return rawBreakeven * (1 - Math.max(breakevenOffsetPct, 0));
};

export const armBreakeven = (
  position: Position,
  feePct: number,
  breakevenOffsetPct: number,
) => {
  const breakevenStop = getBreakevenStopPrice(position, feePct, breakevenOffsetPct);
  position.breakevenArmed = true;

  if (position.side === 'LONG') {
    position.stopPrice = Math.max(position.stopPrice, breakevenStop);
    return;
  }

  position.stopPrice = Math.min(position.stopPrice, breakevenStop);
};

export const updateTrailingStop = (position: Position, candle: Candle) => {
  if (position.trailingStopPct <= 0) {
    return;
  }

  if (position.side === 'LONG') {
    if (candle.high <= position.highestPrice) {
      return;
    }

    position.highestPrice = candle.high;
    const trailingStop = position.highestPrice * (1 - position.trailingStopPct);
    position.stopPrice = Math.max(position.stopPrice, trailingStop);
    return;
  }

  if (candle.low >= position.lowestPrice) {
    return;
  }

  position.lowestPrice = candle.low;
  const trailingStop = position.lowestPrice * (1 + position.trailingStopPct);
  position.stopPrice = Math.min(position.stopPrice, trailingStop);
};

export const hasExceededMaxHoldTime = (
  position: Position,
  closeTimestamp: number,
  maxPositionHoldMinutes: number,
) => {
  if (maxPositionHoldMinutes <= 0) {
    return false;
  }

  return closeTimestamp - position.openedAt >= maxPositionHoldMinutes * 60_000;
};
