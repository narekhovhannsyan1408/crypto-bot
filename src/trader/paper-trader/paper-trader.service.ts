import { Injectable } from '@nestjs/common';
import { Candle } from '../../market/types';
import { getBotConfig } from '../../config/bot-config';
import { PortfolioService } from '../portfolio/portfolio.service';
import {
  armBreakeven,
  hasExceededMaxHoldTime,
  shouldArmBreakeven,
  updateTrailingStop,
} from '../trade-protection.utils';
import {
  ClosedTrade,
  ExecutionResult,
  makePositionKey,
  Position,
  PositionSide,
} from '../types';

@Injectable()
export class PaperTraderService {
  private readonly config = getBotConfig();

  constructor(private readonly portfolio: PortfolioService) {}

  private readonly defaultLongMarketType: 'spot' | 'futures' = 'spot';
  private readonly defaultShortMarketType: 'spot' | 'futures' = 'futures';

  tryOpenLong(
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
    marketType: 'spot' | 'futures' = this.defaultLongMarketType,
  ): ExecutionResult {
    return this.tryOpenPosition(
      'LONG',
      symbol,
      interval,
      strategyId,
      strategyName,
      price,
      timestamp,
      reason,
      positionSizeUsdt,
      marketType,
    );
  }

  tryCloseLong(
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
    marketType?: 'spot' | 'futures',
  ): ExecutionResult | null {
    return this.tryClosePosition(
      'LONG',
      symbol,
      strategyId,
      price,
      timestamp,
      reason,
      marketType,
    );
  }

  tryOpenShort(
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
    marketType: 'spot' | 'futures' = this.defaultShortMarketType,
  ): ExecutionResult {
    return this.tryOpenPosition(
      'SHORT',
      symbol,
      interval,
      strategyId,
      strategyName,
      price,
      timestamp,
      reason,
      positionSizeUsdt,
      marketType,
    );
  }

  tryCloseShort(
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
    marketType?: 'spot' | 'futures',
  ): ExecutionResult | null {
    return this.tryClosePosition(
      'SHORT',
      symbol,
      strategyId,
      price,
      timestamp,
      reason,
      marketType,
    );
  }

  checkStops(candle: Candle): ExecutionResult[] {
    const positions = this.portfolio.getPositionsForSymbol(candle.symbol);
    const actions: ExecutionResult[] = [];

    for (const position of positions) {
      if (position.side === 'LONG') {
        if (candle.low <= position.stopPrice) {
          const action = this.tryCloseLong(
            candle.symbol,
            position.strategyId,
            position.stopPrice,
            candle.closeTime,
            'Стоп-лосс/трейлинг по лонгу',
          );
          if (action) actions.push(action);
          continue;
        }

        if (candle.high >= position.takePrice) {
          const action = this.tryCloseLong(
            candle.symbol,
            position.strategyId,
            position.takePrice,
            candle.closeTime,
            'Тейк-профит по лонгу',
          );
          if (action) actions.push(action);
          continue;
        }

        if (
          shouldArmBreakeven(
            position,
            candle.close,
            this.config.breakevenTriggerPct,
          )
        ) {
          armBreakeven(
            position,
            this.config.feePct,
            this.config.breakevenOffsetPct,
          );
        }

        if (
          hasExceededMaxHoldTime(
            position,
            candle.closeTime,
            this.config.maxPositionHoldMinutes,
          )
        ) {
          const action = this.tryCloseLong(
            candle.symbol,
            position.strategyId,
            candle.close,
            candle.closeTime,
            'Time stop по лонгу: превышено максимальное время удержания',
          );
          if (action) actions.push(action);
          continue;
        }

        updateTrailingStop(position, candle);
        continue;
      }

      if (candle.high >= position.stopPrice) {
        const action = this.tryCloseShort(
          candle.symbol,
          position.strategyId,
          position.stopPrice,
          candle.closeTime,
          'Стоп-лосс/трейлинг по шорту',
        );
        if (action) actions.push(action);
        continue;
      }

      if (candle.low <= position.takePrice) {
        const action = this.tryCloseShort(
          candle.symbol,
          position.strategyId,
          position.takePrice,
          candle.closeTime,
          'Тейк-профит по шорту',
        );
        if (action) actions.push(action);
        continue;
      }

      if (
        shouldArmBreakeven(
          position,
          candle.close,
          this.config.breakevenTriggerPct,
        )
      ) {
        armBreakeven(position, this.config.feePct, this.config.breakevenOffsetPct);
      }

      if (
        hasExceededMaxHoldTime(
          position,
          candle.closeTime,
          this.config.maxPositionHoldMinutes,
        )
      ) {
        const action = this.tryCloseShort(
          candle.symbol,
          position.strategyId,
          candle.close,
          candle.closeTime,
          'Time stop по шорту: превышено максимальное время удержания',
        );
        if (action) actions.push(action);
        continue;
      }

      updateTrailingStop(position, candle);
    }

    return actions;
  }

  private tryOpenPosition(
    side: PositionSide,
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
    marketType: 'spot' | 'futures',
  ): ExecutionResult {
    if (this.portfolio.hasOpenPosition(symbol, strategyId)) {
      return {
        status: 'REJECTED',
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        key: makePositionKey(symbol, strategyId),
        symbol,
        interval,
        strategyId,
        strategyName,
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
        key: makePositionKey(symbol, strategyId),
        symbol,
        interval,
        strategyId,
        strategyName,
        reason: 'Размер позиции рассчитался как ноль',
      };
    }

    if (this.portfolio.balance < positionSizeUsdt) {
      return {
        status: 'REJECTED',
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        key: makePositionKey(symbol, strategyId),
        symbol,
        interval,
        strategyId,
        strategyName,
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
        key: makePositionKey(symbol, strategyId),
        symbol,
        interval,
        strategyId,
        strategyName,
        reason: 'Количество позиции получилось некорректным',
      };
    }

    this.portfolio.balance -= positionSizeUsdt;
    this.portfolio.registerOpenedPosition({
      key: makePositionKey(symbol, strategyId),
      symbol,
      interval,
      strategyId,
      strategyName,
      side,
      marketType,
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
      breakevenArmed: false,
    });

    return {
      status: 'EXECUTED',
      trade: {
        action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        key: makePositionKey(symbol, strategyId),
        symbol,
        interval,
        strategyId,
        strategyName,
        side,
        marketType,
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
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
    marketType?: 'spot' | 'futures',
  ): ExecutionResult | null {
    const position = this.portfolio.getPosition(symbol, strategyId);

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
    this.portfolio.clearPosition(symbol, strategyId);

    const closedTrade: ClosedTrade = {
      key: position.key,
      symbol: position.symbol,
      interval: position.interval,
      strategyId: position.strategyId,
      strategyName: position.strategyName,
      side: position.side,
      marketType: marketType ?? position.marketType,
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
        key: position.key,
        symbol: position.symbol,
        interval: position.interval,
        strategyId: position.strategyId,
        strategyName: position.strategyName,
        side: position.side,
        marketType: marketType ?? position.marketType,
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

}
