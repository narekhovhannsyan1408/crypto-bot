import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PositionSide, RiskApproval } from '../types';

type OpenRequest = {
  symbol: string;
  interval: string;
  strategyId: string;
  side: PositionSide;
  entryPrice: number;
  timestamp: number;
};

@Injectable()
export class RiskManagerService {
  private readonly config = getBotConfig();
  private dailyBaselineEquity = this.config.initialBalance;
  private currentTradingDay = '';

  constructor(private readonly portfolio: PortfolioService) {}

  approveOpenPosition(request: OpenRequest): RiskApproval {
    this.syncTradingDay(request.timestamp);

    if (this.portfolio.hasOpenPosition(request.symbol)) {
      const positionsOnSymbol = this.portfolio.getPositionsForSymbol(request.symbol);

      if (positionsOnSymbol.length >= this.config.maxPositionsPerSymbol) {
        return {
          status: 'DENIED',
          reason: 'Достигнут лимит числа стратегий на одном символе',
        };
      }

      if (
        positionsOnSymbol.some(
          (position) =>
            position.strategyId === request.strategyId && position.side === request.side,
        )
      ) {
        return {
          status: 'DENIED',
          reason: 'Эта стратегия уже держит позицию в ту же сторону по символу',
        };
      }

      if (
        !this.config.allowOppositePositionsSameSymbol &&
        positionsOnSymbol.some((position) => position.side !== request.side)
      ) {
        return {
          status: 'DENIED',
          reason: 'Запрещены противоположные позиции по одному символу',
        };
      }
    }

    if (this.portfolio.hasOpenPositionForStrategy(request.strategyId)) {
      const strategyPositions = this.portfolio.getPositionsForStrategy(request.strategyId);
      if (strategyPositions.length >= this.config.maxPositionsPerStrategy) {
        return {
          status: 'DENIED',
          reason: 'Достигнут лимит позиций для стратегии',
        };
      }
    }

    if (this.portfolio.hasOpenPosition(request.symbol, request.strategyId)) {
      return {
        status: 'DENIED',
        reason: 'По символу и стратегии уже есть открытая позиция',
      };
    }

    if (
      this.portfolio.getOpenPositionsCount() >= this.config.maxConcurrentPositions
    ) {
      return {
        status: 'DENIED',
        reason: 'Достигнут лимит одновременных позиций',
      };
    }

    if (this.portfolio.maxDrawdownPct / 100 >= this.config.maxDrawdownStopPct) {
      return {
        status: 'DENIED',
        reason: 'Достигнут лимит максимальной просадки',
      };
    }

    if (this.portfolio.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      return {
        status: 'DENIED',
        reason: 'Превышен лимит подряд убыточных сделок',
      };
    }

    const dailyRealizedPnl = this.portfolio.getDailyRealizedPnl(request.timestamp);
    const maxDailyLossAbs = this.dailyBaselineEquity * this.config.maxDailyLossPct;

    if (dailyRealizedPnl <= -maxDailyLossAbs) {
      return {
        status: 'DENIED',
        reason: 'Достигнут дневной лимит убытка',
      };
    }

    const currentEquity = this.portfolio.getEquity();
    const currentExposure = this.portfolio.getAllocatedCapital();
    const maxExposureAbs = currentEquity * this.config.maxPortfolioExposurePct;
    const remainingExposure = Math.max(maxExposureAbs - currentExposure, 0);

    if (remainingExposure <= 0) {
      return {
        status: 'DENIED',
        reason: 'Свободный риск бюджета портфеля исчерпан',
      };
    }

    const stopPrice =
      request.side === 'LONG'
        ? request.entryPrice * (1 - this.config.stopLossPct)
        : request.entryPrice * (1 + this.config.stopLossPct);
    const stopDistancePct =
      Math.abs(request.entryPrice - stopPrice) / request.entryPrice;
    const riskBudget = currentEquity * this.config.riskPerTradePct;
    const equityPctCap = currentEquity * this.config.maxPositionSizePctOfEquity;
    const hardCapUsdt =
      this.config.maxPositionSizeUsdt > 0
        ? this.config.maxPositionSizeUsdt
        : Number.POSITIVE_INFINITY;

    const riskSizedUsdt =
      stopDistancePct > 0 ? riskBudget / stopDistancePct : hardCapUsdt;

    const approvedSizeUsdt = Math.min(
      hardCapUsdt,
      equityPctCap,
      this.portfolio.balance,
      remainingExposure,
      riskSizedUsdt,
    );

    if (approvedSizeUsdt <= 0) {
      return {
        status: 'DENIED',
        reason: 'Риск-менеджер не разрешил размер позиции',
      };
    }

    if (approvedSizeUsdt < this.config.minPositionSizeUsdt) {
      return {
        status: 'DENIED',
        reason: 'Разрешённый размер позиции ниже минимально допустимого',
      };
    }

    return {
      status: 'APPROVED',
      approvedSizeUsdt: Number(approvedSizeUsdt.toFixed(8)),
      reason: 'Сделка одобрена риск-менеджером с динамическим position sizing',
    };
  }

  getRiskState(timestamp = Date.now()) {
    this.syncTradingDay(timestamp);

    const dailyRealizedPnl = this.portfolio.getDailyRealizedPnl(timestamp);
    const currentEquity = this.portfolio.getEquity();
    const currentExposure = this.portfolio.getAllocatedCapital();
    const exposurePct =
      currentEquity > 0 ? (currentExposure / currentEquity) * 100 : 0;
    const riskBudget = currentEquity * this.config.riskPerTradePct;
    const positionCapByEquity = currentEquity * this.config.maxPositionSizePctOfEquity;
    const positionsByStrategy = this.portfolio
      .getOpenPositions()
      .reduce<Record<string, number>>((acc, position) => {
        acc[position.strategyId] = (acc[position.strategyId] ?? 0) + 1;
        return acc;
      }, {});

    return {
      дневнойБазовыйКапитал: Number(this.dailyBaselineEquity.toFixed(6)),
      дневнойРеализованныйРезультат: Number(dailyRealizedPnl.toFixed(6)),
      капитал: Number(currentEquity.toFixed(6)),
      использованныйКапитал: Number(currentExposure.toFixed(6)),
      использованиеКапиталаВПроцентах: Number(exposurePct.toFixed(2)),
      рискБюджетНаСделку: Number(riskBudget.toFixed(6)),
      минимальныйРазмерПозиции: Number(this.config.minPositionSizeUsdt.toFixed(6)),
      лимитПозицииКакПроцентОтКапитала: Number(
        (this.config.maxPositionSizePctOfEquity * 100).toFixed(2),
      ),
      лимитПозицииПоКапиталу: Number(positionCapByEquity.toFixed(6)),
      абсолютныйЛимитПозиции:
        this.config.maxPositionSizeUsdt > 0
          ? Number(this.config.maxPositionSizeUsdt.toFixed(6))
          : 'отключён',
      лимитПараллельныхПозиций: this.config.maxConcurrentPositions,
      лимитПозицийНаОдинСимвол: this.config.maxPositionsPerSymbol,
      лимитПозицийНаСтратегию: this.config.maxPositionsPerStrategy,
      лимитДневногоУбыткаВПроцентах: Number(
        (this.config.maxDailyLossPct * 100).toFixed(2),
      ),
      активныеСтратегии: this.config.enabledStrategies,
      открытыеПозицииПоСтратегиям: positionsByStrategy,
      лимитПросадкиВПроцентах: Number(
        (this.config.maxDrawdownStopPct * 100).toFixed(2),
      ),
      лимитПодрядУбыточныхСделок: this.config.maxConsecutiveLosses,
    };
  }

  private syncTradingDay(timestamp: number) {
    const dayKey = new Date(timestamp).toISOString().slice(0, 10);

    if (this.currentTradingDay === dayKey) {
      return;
    }

    this.currentTradingDay = dayKey;
    this.dailyBaselineEquity = this.portfolio.getEquity();
  }
}
