import { Msg, msg } from '../../i18n/messages';
import { AllocatorMode } from '../allocator-mode';
import { baseAssetOf } from '../brokers/allocator-broker';
import { RebalanceOrder } from '../domain/rebalance-planner';
import { SignalSnapshot } from '../session/session.types';
import { assetName, trendKey } from './asset-names';

/**
 * Все тексты, которые видит пользователь, — сообщения словаря (src/web/public/i18n):
 * страница показывает их на выбранном языке, журнал и консоль — на английском.
 * Держим их отдельно от торговой логики, чтобы их можно было править и тестировать.
 */

export type Narration = { title: Msg; details?: Msg };

// «Бот запущен: тестовый режим» — название режима внутри фразы
export const modeMsg = (mode: AllocatorMode) => msg(`mode.inline.${mode}`);
export const modeLabelMsg = (mode: AllocatorMode) => msg(`mode.label.${mode}`);

export const describeStart = (
  mode: AllocatorMode,
  capital: number,
  autoStopLossPct: number,
): Narration => ({
  title: msg('narr.start.title', { mode: modeMsg(mode) }),
  details:
    autoStopLossPct > 0
      ? msg('narr.start.detailsOn', {
          capital,
          threshold: capital * (1 - autoStopLossPct),
          pct: autoStopLossPct,
        })
      : msg('narr.start.detailsOff', { capital }),
});

export const describeStop = (
  autoStop: boolean,
  reason: Msg,
  equity: number,
  initialCapital: number,
  unsold: string[],
): Narration => ({
  title: msg(autoStop ? 'narr.autostop.title' : 'narr.stop.title'),
  details: msg(
    unsold.length ? 'narr.stop.detailsUnsold' : 'narr.stop.details',
    {
      reason,
      equity,
      diff: equity - initialCapital,
      assets: unsold,
    },
  ),
});

export const describeAutoStopReason = (
  equity: number,
  threshold: number,
  autoStopLossPct: number,
) => msg('stop.reason.autostop', { equity, threshold, pct: autoStopLossPct });

export const explainOrder = (
  order: RebalanceOrder,
  signal: SignalSnapshot,
  previous: SignalSnapshot | undefined,
  smaCount: number,
  quote = 'USDT',
): Narration => {
  const params = {
    base: baseAssetOf(order.symbol),
    name: assetName(order.symbol),
    votes: Math.round(signal.trendScore * smaCount),
    total: smaCount,
    target: order.targetWeight,
    quote,
  };
  // Сигнал не изменился — значит, сделка только выравнивает доли после движения цены
  const sameSignal =
    previous !== undefined &&
    Math.abs(previous.exposure - signal.exposure) < 1e-9;

  if (order.side === 'BUY') {
    if (sameSignal) {
      return {
        title: msg('narr.buy.rebalanceTitle', params),
        details: msg('narr.buy.rebalanceDetails', params),
      };
    }
    return {
      title: msg('narr.buy.title', params),
      details: msg(
        params.votes === smaCount
          ? 'narr.buy.allUpDetails'
          : 'narr.buy.strengtheningDetails',
        params,
      ),
    };
  }

  if (order.targetWeight === 0) {
    return {
      title: msg('narr.sell.allTitle', params),
      details: msg('narr.sell.allDetails', params),
    };
  }
  if (sameSignal) {
    return {
      title: msg('narr.sell.rebalanceTitle', params),
      details: msg('narr.sell.rebalanceDetails', params),
    };
  }
  return {
    title: msg('narr.sell.weakeningTitle', params),
    details: msg('narr.sell.weakeningDetails', params),
  };
};

export const describeHoldingDecision = (
  signals: SignalSnapshot[],
  assetCount: number,
  smaCount: number,
  quote = 'USDT',
): Narration => {
  const parts = signals.map((signal) => {
    const votes = Math.round(signal.trendScore * smaCount);
    return msg('narr.hold.part', {
      name: assetName(signal.symbol),
      trend: msg(trendKey(votes, smaCount)),
      votes,
      total: smaCount,
      share: signal.exposure / assetCount,
    });
  });
  const invested = signals.some((signal) => signal.exposure > 0);
  return {
    title: msg('narr.check.title'),
    details: msg(invested ? 'narr.hold.details' : 'narr.hold.detailsAllCash', {
      parts,
      quote,
    }),
  };
};

export const describeSellAll = (
  symbol: string,
  reason: Msg,
  quote = 'USDT',
): Narration => ({
  title: msg('narr.sellAll.title', { base: baseAssetOf(symbol) }),
  details: msg('narr.sellAll.details', { reason, quote }),
});

export const describeProof = (day: number, cluster: string): Narration => ({
  title: msg('narr.proof.title'),
  details: msg('narr.proof.details', {
    day,
    cluster: msg(`narr.proof.cluster.${cluster}`),
  }),
});

export const describeDecisionFailure = (error: Msg): Narration => ({
  title: msg('narr.decisionFailed.title'),
  details: msg('narr.decisionFailed.details', { error }),
});

export const describeReconcile = (
  venue: string,
  adjustments: string[],
): Narration => ({
  title: msg('narr.reconcile.title', { venue }),
  details: msg('narr.reconcile.details', { items: adjustments }),
});
