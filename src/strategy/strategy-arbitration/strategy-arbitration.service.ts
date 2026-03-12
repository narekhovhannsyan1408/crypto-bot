import { Injectable } from '@nestjs/common';
import { Candle } from '../../market/types';
import { ExecutionStatus } from '../../trader/execution.types';
import { TradingStrategy, StrategyResult } from '../types';

export type StrategyOpenCandidate = {
  strategy: TradingStrategy;
  result: StrategyResult;
  side: 'LONG' | 'SHORT';
};

export type StrategyCandidateDecision = {
  strategyId: string;
  strategyName: string;
  side: 'LONG' | 'SHORT';
  entryScore: number;
  arbitrationScore: number;
  marketRegime: string | null;
  status: 'selected' | 'rejected';
  reason: string;
};

export type StrategySelectionDecision = {
  symbol: string;
  selectedStrategyId: string | null;
  selectedStrategyName: string | null;
  selectedSide: 'LONG' | 'SHORT' | null;
  selectedScore: number | null;
  reason: string;
  candidates: StrategyCandidateDecision[];
};

export type RankedStrategyCandidate = StrategyOpenCandidate & {
  entryScore: number;
  arbitrationScore: number;
  isAllowed: boolean;
};

@Injectable()
export class StrategyArbitrationService {
  rankCandidates(
    candidates: StrategyOpenCandidate[],
    executionStatus: ExecutionStatus,
  ): RankedStrategyCandidate[] {
    return candidates
      .map((candidate) => ({
        ...candidate,
        entryScore: candidate.result.entryScore ?? 0,
        arbitrationScore: this.getArbitrationScore(candidate),
        isAllowed: this.isSideAllowed(candidate.side, executionStatus),
      }))
      .sort((left, right) => right.arbitrationScore - left.arbitrationScore);
  }

  selectCandidate(
    candle: Candle,
    candidates: StrategyOpenCandidate[],
    executionStatus: ExecutionStatus,
  ): StrategySelectionDecision {
    const rankedCandidates = this.rankCandidates(candidates, executionStatus);

    const winner = rankedCandidates.find((candidate) => candidate.isAllowed) ?? null;

    const decisions: StrategyCandidateDecision[] = rankedCandidates.map((candidate) => {
      const blockedByExecution = !candidate.isAllowed;
      const losesByScore = !!winner && candidate.strategy.id !== winner.strategy.id;

      return {
        strategyId: candidate.strategy.id,
        strategyName: candidate.strategy.name,
        side: candidate.side,
        entryScore: candidate.entryScore,
        arbitrationScore: candidate.arbitrationScore,
        marketRegime: candidate.result.marketRegime ?? null,
        status: winner && candidate.strategy.id === winner.strategy.id ? 'selected' : 'rejected',
        reason: blockedByExecution
          ? this.getExecutionRejectReason(candidate.side, executionStatus)
          : losesByScore
            ? `Проиграла по совокупному arbitration score лидеру ${winner.strategy.name}`
            : 'Лучшая допустимая стратегия для текущей сделки',
      };
    });

    if (!winner) {
      return {
        symbol: candle.symbol,
        selectedStrategyId: null,
        selectedStrategyName: null,
        selectedSide: null,
        selectedScore: null,
        reason: `Нет допустимой стратегии для ${candle.symbol} в текущем execution-режиме`,
        candidates: decisions,
      };
    }

    return {
      symbol: candle.symbol,
      selectedStrategyId: winner.strategy.id,
      selectedStrategyName: winner.strategy.name,
      selectedSide: winner.side,
      selectedScore: winner.arbitrationScore,
      reason:
        rankedCandidates.filter((candidate) => candidate.isAllowed).length === 1
          ? `Единственный допустимый кандидат для ${candle.symbol}`
          : `Выбран лучший кандидат из ${rankedCandidates.filter((candidate) => candidate.isAllowed).length} стратегий`,
      candidates: decisions,
    };
  }

  private getArbitrationScore(candidate: StrategyOpenCandidate) {
    const baseScore = candidate.result.entryScore ?? 0;
    const regimeBonus = this.getRegimeBonus(candidate.result.marketRegime);
    const strategyBonus = this.getStrategyBonus(candidate.strategy.id, candidate.side);

    return baseScore + regimeBonus + strategyBonus;
  }

  private getRegimeBonus(marketRegime?: string) {
    if (!marketRegime) {
      return 0;
    }

    if (marketRegime.includes('breakout')) {
      return 18;
    }

    if (marketRegime.includes('pullback')) {
      return 14;
    }

    if (marketRegime.includes('range')) {
      return 10;
    }

    if (marketRegime.includes('reversal')) {
      return 8;
    }

    if (marketRegime.includes('adaptive')) {
      return 12;
    }

    return 0;
  }

  private getStrategyBonus(strategyId: string, side: 'LONG' | 'SHORT') {
    if (strategyId === 'market_regime_switcher') {
      return 6;
    }

    if (strategyId === 'breakout_volatility') {
      return side === 'LONG' ? 4 : 5;
    }

    if (strategyId === 'trend_pullback') {
      return 4;
    }

    return 0;
  }

  private isSideAllowed(side: 'LONG' | 'SHORT', executionStatus: ExecutionStatus) {
    if (side === 'LONG') {
      return true;
    }

    return executionStatus.canTradeShort;
  }

  private getExecutionRejectReason(
    side: 'LONG' | 'SHORT',
    executionStatus: ExecutionStatus,
  ) {
    if (side === 'SHORT' && !executionStatus.canTradeShort) {
      return `Short недоступен в режиме ${executionStatus.mode}/${executionStatus.marketType}`;
    }

    return 'Кандидат отклонён execution-слоем';
  }
}
