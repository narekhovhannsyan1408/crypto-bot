import { Injectable } from '@nestjs/common';

export type Position = {
  side: 'LONG' | 'SHORT';
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
    if (!this.position || !currentPrice) {
      return this.balance;
    }

    let unrealized = 0;

    if (this.position.side === 'LONG') {
      unrealized =
        (currentPrice - this.position.entryPrice) * this.position.quantity;
    } else {
      unrealized =
        (this.position.entryPrice - currentPrice) * this.position.quantity;
    }

    return this.balance + unrealized;
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
