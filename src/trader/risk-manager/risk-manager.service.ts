import { Injectable } from '@nestjs/common';
import { getBotConfig } from '../../config/bot-config';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PositionSide, RiskApproval } from '../types';

type OpenRequest = {
  symbol: string;
  interval: string;
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
      return {
        status: 'DENIED',
        reason: 'По символу уже есть открытая позиция',
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

    const riskSizedUsdt =
      stopDistancePct > 0 ? riskBudget / stopDistancePct : this.config.maxPositionSizeUsdt;

    const approvedSizeUsdt = Math.min(
      this.config.maxPositionSizeUsdt,
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

    return {
      status: 'APPROVED',
      approvedSizeUsdt: Number(approvedSizeUsdt.toFixed(8)),
      reason: 'Сделка одобрена риск-менеджером',
    };
  }

  getRiskState(timestamp = Date.now()) {
    this.syncTradingDay(timestamp);

    const dailyRealizedPnl = this.portfolio.getDailyRealizedPnl(timestamp);
    const currentEquity = this.portfolio.getEquity();
    const currentExposure = this.portfolio.getAllocatedCapital();
    const exposurePct =
      currentEquity > 0 ? (currentExposure / currentEquity) * 100 : 0;

    return {
      дневнойБазовыйКапитал: Number(this.dailyBaselineEquity.toFixed(6)),
      дневнойРеализованныйРезультат: Number(dailyRealizedPnl.toFixed(6)),
      капитал: Number(currentEquity.toFixed(6)),
      использованныйКапитал: Number(currentExposure.toFixed(6)),
      использованиеКапиталаВПроцентах: Number(exposurePct.toFixed(2)),
      лимитПараллельныхПозиций: this.config.maxConcurrentPositions,
      лимитДневногоУбыткаВПроцентах: Number(
        (this.config.maxDailyLossPct * 100).toFixed(2),
      ),
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
