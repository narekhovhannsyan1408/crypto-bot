import { Injectable } from '@nestjs/common';
import { PortfolioService } from '../portfolio/portfolio.service';

@Injectable()
export class PaperTraderService {
  constructor(private readonly portfolio: PortfolioService) {}

  tryOpenLong(price: number, timestamp: number, reason: string) {
    if (this.portfolio.position) {
      return { action: 'SKIP', reason: 'Позиция уже открыта' };
    }

    const positionSizeUsdt = Number(process.env.BOT_POSITION_SIZE_USDT || 100);
    const feePct = Number(process.env.BOT_FEE_PCT || 0.001);

    if (this.portfolio.balance < positionSizeUsdt) {
      return { action: 'SKIP', reason: 'Недостаточно баланса' };
    }

    const entryFee = positionSizeUsdt * feePct;
    const netUsdt = positionSizeUsdt - entryFee;
    const quantity = netUsdt / price;

    this.portfolio.balance -= positionSizeUsdt;

    this.portfolio.position = {
      side: 'LONG',
      entryPrice: price,
      quantity,
      investedUsdt: positionSizeUsdt,
      openedAt: timestamp,
    };

    return {
      action: 'OPEN_LONG',
      side: 'LONG',
      price,
      quantity,
      fee: entryFee,
      reason,
    };
  }

  tryCloseLong(price: number, timestamp: number, reason: string) {
    const position = this.portfolio.position;

    if (!position || position.side !== 'LONG') {
      return null;
    }

    const feePct = Number(process.env.BOT_FEE_PCT || 0.001);

    const grossValue = position.quantity * price;
    const exitFee = grossValue * feePct;
    const netValue = grossValue - exitFee;

    const pnlNet = netValue - position.investedUsdt;

    this.portfolio.balance += netValue;
    this.portfolio.registerClosedTrade(pnlNet);
    this.portfolio.position = null;

    return {
      action: 'CLOSE_LONG',
      side: 'LONG',
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity: position.quantity,
      pnlNet,
      fee: exitFee,
      openedAt: position.openedAt,
      closedAt: timestamp,
      reason,
    };
  }

  tryOpenShort(price: number, timestamp: number, reason: string) {
    if (this.portfolio.position) {
      return { action: 'SKIP', reason: 'Позиция уже открыта' };
    }

    const positionSizeUsdt = Number(process.env.BOT_POSITION_SIZE_USDT || 100);
    const feePct = Number(process.env.BOT_FEE_PCT || 0.001);

    if (this.portfolio.balance < positionSizeUsdt) {
      return { action: 'SKIP', reason: 'Недостаточно баланса' };
    }

    const entryFee = positionSizeUsdt * feePct;
    const netUsdt = positionSizeUsdt - entryFee;
    const quantity = netUsdt / price;

    this.portfolio.balance -= positionSizeUsdt;

    this.portfolio.position = {
      side: 'SHORT',
      entryPrice: price,
      quantity,
      investedUsdt: positionSizeUsdt,
      openedAt: timestamp,
    };

    return {
      action: 'OPEN_SHORT',
      side: 'SHORT',
      price,
      quantity,
      fee: entryFee,
      reason,
    };
  }

  tryCloseShort(price: number, timestamp: number, reason: string) {
    const position = this.portfolio.position;

    if (!position || position.side !== 'SHORT') {
      return null;
    }

    const feePct = Number(process.env.BOT_FEE_PCT || 0.001);

    const grossPnl = (position.entryPrice - price) * position.quantity;
    const exitNotional = position.quantity * price;
    const exitFee = exitNotional * feePct;

    const pnlNet = grossPnl - exitFee;
    const returnedCapital = position.investedUsdt + pnlNet;

    this.portfolio.balance += returnedCapital;
    this.portfolio.registerClosedTrade(pnlNet);
    this.portfolio.position = null;

    return {
      action: 'CLOSE_SHORT',
      side: 'SHORT',
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity: position.quantity,
      pnlNet,
      fee: exitFee,
      openedAt: position.openedAt,
      closedAt: timestamp,
      reason,
    };
  }

  checkStops(price: number, timestamp: number) {
    const position = this.portfolio.position;

    if (!position) {
      return null;
    }

    const stopLossPct = Number(process.env.BOT_STOP_LOSS_PCT || 0.012);
    const takeProfitPct = Number(process.env.BOT_TAKE_PROFIT_PCT || 0.02);

    if (position.side === 'LONG') {
      const stopPrice = position.entryPrice * (1 - stopLossPct);
      const takePrice = position.entryPrice * (1 + takeProfitPct);

      if (price <= stopPrice) {
        return this.tryCloseLong(price, timestamp, 'Стоп-лосс по лонгу');
      }

      if (price >= takePrice) {
        return this.tryCloseLong(price, timestamp, 'Тейк-профит по лонгу');
      }
    }

    if (position.side === 'SHORT') {
      const stopPrice = position.entryPrice * (1 + stopLossPct);
      const takePrice = position.entryPrice * (1 - takeProfitPct);

      if (price >= stopPrice) {
        return this.tryCloseShort(price, timestamp, 'Стоп-лосс по шорту');
      }

      if (price <= takePrice) {
        return this.tryCloseShort(price, timestamp, 'Тейк-профит по шорту');
      }
    }

    return null;
  }
}
