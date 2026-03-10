import { Injectable } from '@nestjs/common';
import { Candle } from '../../market/types';
import { getBotConfig } from '../../config/bot-config';
import { PortfolioService } from '../portfolio/portfolio.service';
import { ClosedTrade, ExecutionResult, Position, PositionSide } from '../types';

@Injectable()
export class PaperTraderService {
  private readonly config = getBotConfig();

  constructor(private readonly portfolio: PortfolioService) {}

  tryOpenLong(
    symbol: string,
    interval: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): ExecutionResult {
    return this.tryOpenPosition(
      'LONG',
      symbol,
      interval,
      price,
      timestamp,
      reason,
      positionSizeUsdt,
    );
  }

  tryCloseLong(
    symbol: string,
    price: number,
    timestamp: number,
    reason: string,
  ): ExecutionResult | null {
    return this.tryClosePosition('LONG', symbol, price, timestamp, reason);
  }

  tryOpenShort(
    symbol: string,
    interval: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): ExecutionResult {
    return this.tryOpenPosition(
      'SHORT',
      symbol,
      interval,
      price,
      timestamp,
      reason,
      positionSizeUsdt,
    );
  }

  tryCloseShort(
    symbol: string,
    price: number,
    timestamp: number,
    reason: string,
  ): ExecutionResult | null {
    return this.tryClosePosition('SHORT', symbol, price, timestamp, reason);
  }

  checkStops(candle: Candle): ExecutionResult | null {
    const position = this.portfolio.getPosition(candle.symbol);

    if (!position) {
      return null;
    }

    if (position.side === 'LONG') {
      if (candle.low <= position.stopPrice) {
        return this.tryCloseLong(
          candle.symbol,
          position.stopPrice,
          candle.closeTime,
          'Стоп-лосс/трейлинг по лонгу',
        );
      }

      if (candle.high >= position.takePrice) {
        return this.tryCloseLong(
          candle.symbol,
          position.takePrice,
          candle.closeTime,
          'Тейк-профит по лонгу',
        );
      }

      this.updateTrailingLevels(position, candle);
      return null;
    }

    if (candle.high >= position.stopPrice) {
      return this.tryCloseShort(
        candle.symbol,
        position.stopPrice,
        candle.closeTime,
        'Стоп-лосс/трейлинг по шорту',
      );
    }

    if (candle.low <= position.takePrice) {
      return this.tryCloseShort(
        candle.symbol,
        position.takePrice,
        candle.closeTime,
        'Тейк-профит по шорту',
      );
    }

    this.updateTrailingLevels(position, candle);
    return null;
  }

  private tryOpenPosition(
    side: PositionSide,
    symbol: string,
    interval: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): ExecutionResult {
    if (this.portfolio.hasOpenPosition(symbol)) {
      return {
        status: 'REJECTED',
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol,
        interval,
        reason: 'Позиция уже открыта',
      };
    }

    const stopPrice =
      side === 'LONG'
        ? price * (1 - this.config.stopLossPct)
        : price * (1 + this.config.stopLossPct);

    const takePrice =
      side === 'LONG'
        ? price * (1 + this.config.takeProfitPct)
        : price * (1 - this.config.takeProfitPct);

    if (positionSizeUsdt <= 0) {
      return {
        status: 'REJECTED',
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol,
        interval,
        reason: 'Размер позиции рассчитался как ноль',
      };
    }

    if (this.portfolio.balance < positionSizeUsdt) {
      return {
        status: 'REJECTED',
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol,
        interval,
        reason: 'Недостаточно свободного баланса',
      };
    }

    const entryFee = positionSizeUsdt * this.config.feePct;
    const netUsdt = positionSizeUsdt - entryFee;
    const quantity = netUsdt / price;

    if (quantity <= 0) {
      return {
        status: 'REJECTED',
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol,
        interval,
        reason: 'Количество позиции получилось некорректным',
      };
    }

    this.portfolio.balance -= positionSizeUsdt;
    this.portfolio.registerOpenedPosition({
      symbol,
      interval,
      side,
      entryPrice: price,
      quantity,
      investedUsdt: positionSizeUsdt,
      openedAt: timestamp,
      entryFeePaid: entryFee,
      stopLossPct: this.config.stopLossPct,
      takeProfitPct: this.config.takeProfitPct,
      trailingStopPct: this.config.trailingStopPct,
      stopPrice,
      takePrice,
      highestPrice: price,
      lowestPrice: price,
    });

    return {
      status: 'EXECUTED',
      trade: {
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol,
        interval,
        side,
        price,
        quantity,
        fee: entryFee,
        reason,
        openedAt: timestamp,
      },
    };
  }

  private tryClosePosition(
    expectedSide: PositionSide,
    symbol: string,
    price: number,
    timestamp: number,
    reason: string,
  ): ExecutionResult | null {
    const position = this.portfolio.getPosition(symbol);

    if (!position || position.side !== expectedSide) {
      return null;
    }

    const exitFee = price * position.quantity * this.config.feePct;
    const grossPnl =
      position.side === 'LONG'
        ? (price - position.entryPrice) * position.quantity
        : (position.entryPrice - price) * position.quantity;
    const shortEntryProceeds = position.quantity * position.entryPrice;

    const returnedCapital =
      position.side === 'LONG'
        ? position.quantity * price - exitFee
        : shortEntryProceeds + grossPnl - exitFee;

    const pnlNet = returnedCapital - position.investedUsdt;
    const totalFees = position.entryFeePaid + exitFee;

    this.portfolio.balance += returnedCapital;
    this.portfolio.clearPosition(symbol);

    const closedTrade: ClosedTrade = {
      symbol: position.symbol,
      interval: position.interval,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity: position.quantity,
      investedUsdt: position.investedUsdt,
      grossPnl,
      pnlNet,
      totalFees,
      exitFee,
      openedAt: position.openedAt,
      closedAt: timestamp,
      reason,
    };

    this.portfolio.registerClosedTrade(closedTrade, this.portfolio.balance);

    return {
      status: 'EXECUTED',
      trade: {
        action: position.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
        symbol: position.symbol,
        interval: position.interval,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: price,
        quantity: position.quantity,
        fee: exitFee,
        totalFees,
        grossPnl,
        pnlNet,
        openedAt: position.openedAt,
        closedAt: timestamp,
        reason,
      },
    };
  }

  private updateTrailingLevels(position: Position, candle: Candle) {
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
  }
}
