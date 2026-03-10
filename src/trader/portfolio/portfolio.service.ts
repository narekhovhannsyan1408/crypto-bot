import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { ClosedTrade, Position } from '../types';

@Injectable()
export class PortfolioService {
  private readonly config = getBotConfig();

  balance = this.config.initialBalance;
  realizedPnl = 0;
  feesPaid = 0;
  position: Position | null = null;
  closedTrades: ClosedTrade[] = [];

  totalTrades = 0;
  wins = 0;
  losses = 0;
  consecutiveWins = 0;
  consecutiveLosses = 0;
  peakEquity = this.config.initialBalance;
  maxDrawdownPct = 0;

  hasOpenPosition() {
    return this.position !== null;
  }

  getUnrealizedPnl(currentPrice?: number) {
    if (!this.position || currentPrice === undefined) {
      return 0;
    }

    const liquidationValue = this.getPositionLiquidationValue(currentPrice);
    return liquidationValue - this.position.investedUsdt;
  }

  getPositionLiquidationValue(currentPrice?: number) {
    if (!this.position || currentPrice === undefined) {
      return 0;
    }

    const exitFee = currentPrice * this.position.quantity * this.config.feePct;

    if (this.position.side === 'LONG') {
      return this.position.quantity * currentPrice - exitFee;
    }

    const grossPnl =
      (this.position.entryPrice - currentPrice) * this.position.quantity;
    const shortEntryProceeds = this.position.quantity * this.position.entryPrice;

    return shortEntryProceeds + grossPnl - exitFee;
  }

  getEquity(currentPrice?: number) {
    if (!this.position || currentPrice === undefined) {
      return this.balance;
    }

    return this.balance + this.getPositionLiquidationValue(currentPrice);
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
}
