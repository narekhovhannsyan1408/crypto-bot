import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { ClosedTrade, PortfolioSnapshot, Position } from '../types';

@Injectable()
export class PortfolioService {
  private readonly config = getBotConfig();
  private readonly positions = new Map<string, Position>();
  private readonly marks = new Map<string, number>();

  balance = this.config.initialBalance;
  realizedPnl = 0;
  feesPaid = 0;
  closedTrades: ClosedTrade[] = [];

  totalTrades = 0;
  wins = 0;
  losses = 0;
  consecutiveWins = 0;
  consecutiveLosses = 0;
  peakEquity = this.config.initialBalance;
  maxDrawdownPct = 0;

  get position() {
    return this.getOpenPositions()[0] ?? null;
  }

  hasOpenPosition(symbol?: string) {
    if (symbol) {
      return this.positions.has(symbol);
    }

    return this.positions.size > 0;
  }

  getPosition(symbol: string) {
    return this.positions.get(symbol) ?? null;
  }

  getOpenPositions() {
    return [...this.positions.values()];
  }

  getOpenPositionsCount() {
    return this.positions.size;
  }

  registerOpenedPosition(position: Position) {
    this.positions.set(position.symbol, position);
    this.marks.set(position.symbol, position.entryPrice);
  }

  clearPosition(symbol: string) {
    this.positions.delete(symbol);
  }

  updateMark(symbol: string, price: number) {
    if (!Number.isFinite(price)) {
      return;
    }

    this.marks.set(symbol, price);
  }

  getAllocatedCapital() {
    return this.getOpenPositions().reduce(
      (sum, position) => sum + position.investedUsdt,
      0,
    );
  }

  getUnrealizedPnl(symbol?: string, currentPrice?: number) {
    if (symbol) {
      const position = this.getPosition(symbol);
      if (!position) {
        return 0;
      }

      const markPrice = currentPrice ?? this.getMark(symbol);
      if (markPrice === undefined) {
        return 0;
      }

      return this.getPositionLiquidationValue(symbol, markPrice) - position.investedUsdt;
    }

    return this.getOpenPositions().reduce((sum, position) => {
      const markPrice = this.getMark(position.symbol);
      if (markPrice === undefined) {
        return sum;
      }

      return (
        sum +
        (this.getPositionLiquidationValue(position.symbol, markPrice) -
          position.investedUsdt)
      );
    }, 0);
  }

  getPositionLiquidationValue(symbol: string, currentPrice?: number) {
    const position = this.getPosition(symbol);

    if (!position) {
      return 0;
    }

    const markPrice = currentPrice ?? this.getMark(symbol);
    if (markPrice === undefined) {
      return 0;
    }

    const exitFee = markPrice * position.quantity * this.config.feePct;

    if (position.side === 'LONG') {
      return position.quantity * markPrice - exitFee;
    }

    const grossPnl = (position.entryPrice - markPrice) * position.quantity;
    const shortEntryProceeds = position.quantity * position.entryPrice;

    return shortEntryProceeds + grossPnl - exitFee;
  }

  getEquity() {
    return (
      this.balance +
      this.getOpenPositions().reduce((sum, position) => {
        return sum + this.getPositionLiquidationValue(position.symbol);
      }, 0)
    );
  }

  registerClosedTrade(trade: ClosedTrade, equityAfterClose: number) {
    this.totalTrades += 1;
    this.realizedPnl += trade.pnlNet;
    this.feesPaid += trade.totalFees;
    this.closedTrades.push(trade);

    if (trade.pnlNet > 0) {
      this.wins += 1;
      this.consecutiveWins += 1;
      this.consecutiveLosses = 0;
    } else if (trade.pnlNet < 0) {
      this.losses += 1;
      this.consecutiveLosses += 1;
      this.consecutiveWins = 0;
    } else {
      this.consecutiveWins = 0;
      this.consecutiveLosses = 0;
    }

    this.trackDrawdown(equityAfterClose);
  }

  getDailyRealizedPnl(timestamp: number) {
    const dayStart = new Date(timestamp);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayStartTimestamp = dayStart.getTime();

    return this.closedTrades.reduce((sum, trade) => {
      if (trade.closedAt < dayStartTimestamp) {
        return sum;
      }

      return sum + trade.pnlNet;
    }, 0);
  }

  getSnapshot(): PortfolioSnapshot {
    const equity = this.getEquity();
    const unrealizedPnl = this.getUnrealizedPnl();

    return {
      balance: this.balance,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      equity,
      feesPaid: this.feesPaid,
      peakEquity: this.peakEquity,
      maxDrawdownPct: this.maxDrawdownPct,
      openPositions: this.getOpenPositions(),
      openPositionsCount: this.getOpenPositionsCount(),
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  trackDrawdown(equity: number) {
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }

    if (this.peakEquity <= 0) {
      return;
    }

    const drawdownPct = ((this.peakEquity - equity) / this.peakEquity) * 100;
    this.maxDrawdownPct = Math.max(this.maxDrawdownPct, drawdownPct);
  }

  getLastClosedTrade() {
    return this.closedTrades.at(-1) ?? null;
  }

  getWinRate() {
    if (this.totalTrades === 0) {
      return 0;
    }

    return (this.wins / this.totalTrades) * 100;
  }

  private getMark(symbol: string) {
    return this.marks.get(symbol);
  }
}
