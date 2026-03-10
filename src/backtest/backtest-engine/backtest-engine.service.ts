import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { Candle } from '../../market/types';
import { BreakoutVolatilityStrategyService } from '../../strategy/breakout-volatility/breakout-volatility.strategy.service';
import { MarketRegimeSwitcherStrategyService } from '../../strategy/market-regime-switcher/market-regime-switcher.strategy.service';
import { MeanReversionStrategyService } from '../../strategy/mean-reversion/mean-reversion.strategy.service';
import { RangeScalpingStrategyService } from '../../strategy/range-scalping/range-scalping.strategy.service';
import { StrategyArbitrationService, StrategyOpenCandidate } from '../../strategy/strategy-arbitration/strategy-arbitration.service';
import { StrategyService } from '../../strategy/strategy/strategy.service';
import { TrendPullbackStrategyService } from '../../strategy/trend-pullback/trend-pullback.strategy.service';
import { TradingStrategy } from '../../strategy/types';
import { VolumeSpikeReversalStrategyService } from '../../strategy/volume-spike-reversal/volume-spike-reversal.strategy.service';
import { PaperTraderService } from '../../trader/paper-trader/paper-trader.service';
import { PortfolioService } from '../../trader/portfolio/portfolio.service';
import { RiskManagerService } from '../../trader/risk-manager/risk-manager.service';
import { BacktestInput, BacktestReport } from '../types';

@Injectable()
export class BacktestEngineService {
  private readonly config = getBotConfig();

  runBacktest(input: BacktestInput): BacktestReport {
    const portfolio = new PortfolioService();
    const strategies = this.buildStrategies();
    const arbitration = new StrategyArbitrationService();
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
        for (const strategy of strategies) {
          strategy.seedHistory(candle.symbol, candle.interval, []);
        }
        seededBySymbol.add(symbolKey);
      }

      const stopActions = trader.checkStops(candle);
      for (const action of stopActions) {
        if (action.status === 'EXECUTED') {
          strategies
            .find((strategy) => strategy.id === action.trade.strategyId)
            ?.registerTradeClosed(candle.symbol, candle.interval);
        }
      }

      const openCandidates: StrategyOpenCandidate[] = [];

      for (const strategy of strategies) {
        const position = portfolio.getPosition(candle.symbol, strategy.id);
        const signal = strategy.onNewCandle(candle, position?.side ?? null);

        if (!position) {
          if (signal.signal === 'OPEN_LONG' || signal.signal === 'OPEN_SHORT') {
            openCandidates.push({
              strategy,
              result: signal,
              side: signal.signal === 'OPEN_LONG' ? 'LONG' : 'SHORT',
            });
          }

          continue;
        }

        if (position.side === 'LONG') {
          if (signal.signal === 'CLOSE_LONG') {
            trader.tryCloseLong(
              candle.symbol,
              strategy.id,
              candle.close,
              candle.closeTime,
              signal.reason,
            );
            strategy.registerTradeClosed(candle.symbol, candle.interval);
          }

          if (signal.signal === 'REVERSE_TO_SHORT') {
            trader.tryCloseLong(
              candle.symbol,
              strategy.id,
              candle.close,
              candle.closeTime,
              'Backtest: переворот из лонга в шорт',
            );
            strategy.registerTradeClosed(candle.symbol, candle.interval);

            const approval = riskManager.approveOpenPosition({
              symbol: candle.symbol,
              interval: candle.interval,
              strategyId: strategy.id,
              side: 'SHORT',
              entryPrice: candle.close,
              timestamp: candle.closeTime,
            });

            if (approval.status === 'APPROVED') {
              trader.tryOpenShort(
                candle.symbol,
                candle.interval,
                strategy.id,
                strategy.name,
                candle.close,
                candle.closeTime,
                signal.reason,
                approval.approvedSizeUsdt,
              );
            }
          }

          continue;
        }

        if (signal.signal === 'CLOSE_SHORT') {
          trader.tryCloseShort(
            candle.symbol,
            strategy.id,
            candle.close,
            candle.closeTime,
            signal.reason,
          );
          strategy.registerTradeClosed(candle.symbol, candle.interval);
        }

        if (signal.signal === 'REVERSE_TO_LONG') {
          trader.tryCloseShort(
            candle.symbol,
            strategy.id,
            candle.close,
            candle.closeTime,
            'Backtest: переворот из шорта в лонг',
          );
          strategy.registerTradeClosed(candle.symbol, candle.interval);

          const approval = riskManager.approveOpenPosition({
            symbol: candle.symbol,
            interval: candle.interval,
            strategyId: strategy.id,
            side: 'LONG',
            entryPrice: candle.close,
            timestamp: candle.closeTime,
          });

          if (approval.status === 'APPROVED') {
            trader.tryOpenLong(
              candle.symbol,
              candle.interval,
              strategy.id,
              strategy.name,
              candle.close,
              candle.closeTime,
              signal.reason,
              approval.approvedSizeUsdt,
            );
          }
        }
      }

      const selectionDecision = arbitration.selectCandidate(
        candle,
        openCandidates,
        {
          mode: 'paper',
          marketType: 'futures',
          label: 'PAPER',
          canTradeShort: true,
          liveTradingEnabled: false,
          usingTestnet: false,
          allowLiveReal: false,
          apiConfigured: false,
          accountConnectivity: 'unknown',
          quoteAsset: 'USDT',
          warnings: [],
        },
      );
      const selectedCandidate =
        selectionDecision.selectedStrategyId === null
          ? null
          : openCandidates.find(
              (candidate) =>
                candidate.strategy.id === selectionDecision.selectedStrategyId &&
                candidate.side === selectionDecision.selectedSide,
            ) ?? null;

      if (selectedCandidate) {
        const approval = riskManager.approveOpenPosition({
          symbol: candle.symbol,
          interval: candle.interval,
          strategyId: selectedCandidate.strategy.id,
          side: selectedCandidate.side,
          entryPrice: candle.close,
          timestamp: candle.closeTime,
        });

        if (approval.status === 'APPROVED') {
          if (selectedCandidate.side === 'LONG') {
            trader.tryOpenLong(
              candle.symbol,
              candle.interval,
              selectedCandidate.strategy.id,
              selectedCandidate.strategy.name,
              candle.close,
              candle.closeTime,
              selectedCandidate.result.reason,
              approval.approvedSizeUsdt,
            );
          } else {
            trader.tryOpenShort(
              candle.symbol,
              candle.interval,
              selectedCandidate.strategy.id,
              selectedCandidate.strategy.name,
              candle.close,
              candle.closeTime,
              selectedCandidate.result.reason,
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

  private buildStrategies(): TradingStrategy[] {
    const strategies: TradingStrategy[] = [
      new StrategyService(),
      new MeanReversionStrategyService(),
      new BreakoutVolatilityStrategyService(),
      new TrendPullbackStrategyService(),
      new RangeScalpingStrategyService(),
      new VolumeSpikeReversalStrategyService(),
      new MarketRegimeSwitcherStrategyService(),
    ];
    const enabled = new Set(this.config.enabledStrategies);

    return strategies.filter((strategy) => enabled.has(strategy.id));
  }
}
