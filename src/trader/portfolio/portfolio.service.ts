import { Injectable } from '@nestjs/common';

export type PositionSide = 'LONG' | 'SHORT';

export type Position = {
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  investedUsdt: number;
  openedAt: number;
};

@Injectable()
export class PortfolioService {
  balance = Number(process.env.BOT_INITIAL_BALANCE || 1000);
  realizedPnl = 0;
  position: Position | null = null;

  totalTrades = 0;
  wins = 0;
  losses = 0;

  hasOpenPosition() {
    return this.position !== null;
  }

  getEquity(currentPrice?: number) {
    if (!this.position || currentPrice === undefined) {
      return this.balance;
    }

    const feePct = Number(process.env.BOT_FEE_PCT || 0.001);
    const exitFee = currentPrice * this.position.quantity * feePct;

    let gross = 0;

    if (this.position.side === 'LONG') {
      gross = (currentPrice - this.position.entryPrice) * this.position.quantity;
    } else {
      gross = (this.position.entryPrice - currentPrice) * this.position.quantity;
    }

    const unrealizedNet = gross - exitFee;

    return this.balance + unrealizedNet;
  }

  registerClosedTrade(pnlNet: number) {
    this.totalTrades += 1;
    this.realizedPnl += pnlNet;

    if (pnlNet > 0) {
      this.wins += 1;
    } else if (pnlNet < 0) {
      this.losses += 1;
    }
  }

  getWinRate() {
    if (this.totalTrades === 0) {
      return 0;
    }

    return (this.wins / this.totalTrades) * 100;
  }
}
