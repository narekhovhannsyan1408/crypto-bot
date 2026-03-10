import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { RiskManagerService } from '../../trader/risk-manager/risk-manager.service';
import { BacktestInput, BacktestReport } from '../types';

@Injectable()
export class BacktestEngineService {
  private readonly config = getBotConfig();

  runBacktest(input: BacktestInput): BacktestReport {
    const portfolio = new PortfolioService();
    const strategy = new StrategyService();
    const riskManager = new RiskManagerService(portfolio);
    const trader = new PaperTraderService(portfolio);

    const sortedCandles = [...input.candles].sort((left, right) => {
      if (left.closeTime !== right.closeTime) {
        return left.closeTime - right.closeTime;
      }

      return left.symbol.localeCompare(right.symbol);
    });

    const seededBySymbol = new Set<string>();
    const equityCurve: BacktestReport['equityCurve'] = [];

    for (const candle of sortedCandles) {
      if (!candle.isClosed) {
        continue;
      }

      portfolio.updateMark(candle.symbol, candle.close);

      const symbolKey = `${candle.symbol}:${candle.interval}`;
      if (!seededBySymbol.has(symbolKey)) {
        strategy.seedHistory(candle.symbol, candle.interval, []);
        seededBySymbol.add(symbolKey);
      }

      const stopAction = trader.checkStops(candle);
      if (stopAction?.status === 'EXECUTED') {
        strategy.registerTradeClosed(candle.symbol, candle.interval);
      }

      const position = portfolio.getPosition(candle.symbol);
      const signal = strategy.onNewCandle(candle, position?.side ?? null);

      if (!position) {
        if (signal.signal === 'OPEN_LONG' || signal.signal === 'OPEN_SHORT') {
          const side = signal.signal === 'OPEN_LONG' ? 'LONG' : 'SHORT';
          const approval = riskManager.approveOpenPosition({
            symbol: candle.symbol,
            interval: candle.interval,
            side,
            entryPrice: candle.close,
            timestamp: candle.closeTime,
          });

          if (approval.status === 'APPROVED') {
            if (side === 'LONG') {
              trader.tryOpenLong(
                candle.symbol,
                candle.interval,
                candle.close,
                candle.closeTime,
                signal.reason,
                approval.approvedSizeUsdt,
              );
            } else {
              trader.tryOpenShort(
                candle.symbol,
                candle.interval,
                candle.close,
                candle.closeTime,
                signal.reason,
                approval.approvedSizeUsdt,
              );
            }
          }
        }
      } else if (position.side === 'LONG') {
        if (signal.signal === 'CLOSE_LONG') {
          trader.tryCloseLong(
            candle.symbol,
            candle.close,
            candle.closeTime,
            signal.reason,
          );
          strategy.registerTradeClosed(candle.symbol, candle.interval);
        }

        if (signal.signal === 'REVERSE_TO_SHORT') {
          trader.tryCloseLong(
            candle.symbol,
            candle.close,
            candle.closeTime,
            'Backtest: переворот из лонга в шорт',
          );
          strategy.registerTradeClosed(candle.symbol, candle.interval);

          const approval = riskManager.approveOpenPosition({
            symbol: candle.symbol,
            interval: candle.interval,
            side: 'SHORT',
            entryPrice: candle.close,
            timestamp: candle.closeTime,
          });

          if (approval.status === 'APPROVED') {
            trader.tryOpenShort(
              candle.symbol,
              candle.interval,
              candle.close,
              candle.closeTime,
              signal.reason,
              approval.approvedSizeUsdt,
            );
          }
        }
      } else {
        if (signal.signal === 'CLOSE_SHORT') {
          trader.tryCloseShort(
            candle.symbol,
            candle.close,
            candle.closeTime,
            signal.reason,
          );
          strategy.registerTradeClosed(candle.symbol, candle.interval);
        }

        if (signal.signal === 'REVERSE_TO_LONG') {
          trader.tryCloseShort(
            candle.symbol,
            candle.close,
            candle.closeTime,
            'Backtest: переворот из шорта в лонг',
          );
          strategy.registerTradeClosed(candle.symbol, candle.interval);

          const approval = riskManager.approveOpenPosition({
            symbol: candle.symbol,
            interval: candle.interval,
            side: 'LONG',
            entryPrice: candle.close,
            timestamp: candle.closeTime,
          });

          if (approval.status === 'APPROVED') {
            trader.tryOpenLong(
              candle.symbol,
              candle.interval,
              candle.close,
              candle.closeTime,
              signal.reason,
              approval.approvedSizeUsdt,
            );
          }
        }
      }

      const equity = portfolio.getEquity();
      portfolio.trackDrawdown(equity);
      equityCurve.push({
        timestamp: candle.closeTime,
        equity: Number(equity.toFixed(6)),
      });
    }

    const snapshot = portfolio.getSnapshot();

    return {
      startingBalance: this.config.initialBalance,
      endingEquity: Number(snapshot.equity.toFixed(6)),
      realizedResult: Number(snapshot.realizedPnl.toFixed(6)),
      unrealizedResult: Number(snapshot.unrealizedPnl.toFixed(6)),
      totalTrades: snapshot.totalTrades,
      wins: snapshot.wins,
      losses: snapshot.losses,
      winRate: Number(portfolio.getWinRate().toFixed(2)),
      maxDrawdownPct: Number(snapshot.maxDrawdownPct.toFixed(2)),
      feesPaid: Number(snapshot.feesPaid.toFixed(6)),
      closedTrades: portfolio.closedTrades,
      equityCurve,
    };
  }
}
