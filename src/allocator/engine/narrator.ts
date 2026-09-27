import { ExecutionMode } from '../../trader/execution.types';
import { baseAssetOf } from '../brokers/allocator-broker';
import { RebalanceOrder } from '../domain/rebalance-planner';
import { SignalSnapshot } from '../session/session.types';
import { assetName, trendLabel } from './asset-names';

/**
 * Все тексты, которые видит пользователь: простым языком, без терминов.
 * Держим их отдельно от торговой логики, чтобы их можно было править и тестировать.
 */

export const MODE_LABELS: Record<ExecutionMode, string> = {
  paper: 'Тестовый режим',
  live_testnet: 'Binance Demo',
  live_real: 'Реальные деньги',
};

const moneyFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const usd = (value: number) => `${moneyFormat.format(value)} $`;

export const signedUsd = (value: number) =>
  `${value >= 0 ? '+' : '−'}${usd(Math.abs(value))}`;

const pct = (value: number) => `${Math.round(value * 100)}%`;

export const describeStart = (
  mode: ExecutionMode,
  capital: number,
  autoStopLossPct: number,
) => ({
  title: `Бот запущен: ${MODE_LABELS[mode].toLowerCase()}`,
  details:
    `Стартовый капитал ${usd(capital)}. ` +
    (autoStopLossPct > 0
      ? `Автозащита: если капитал упадёт до ${usd(capital * (1 - autoStopLossPct))} (−${pct(autoStopLossPct)}), бот всё продаст и остановится.`
      : 'Автозащита выключена.'),
});

export const describeStop = (
  autoStop: boolean,
  reason: string,
  equity: number,
  initialCapital: number,
  unsold: string[],
) => ({
  title: autoStop ? 'Сработала автозащита' : 'Бот остановлен',
  details:
    `${reason}. Итог: ${usd(equity)} (${signedUsd(equity - initialCapital)}).` +
    (unsold.length ? ` Не удалось продать: ${unsold.join(', ')}.` : ''),
});

export const describeAutoStopReason = (
  equity: number,
  threshold: number,
  autoStopLossPct: number,
) =>
  `Автозащита: капитал упал до ${usd(equity)} — ниже порога ${usd(threshold)} (−${pct(autoStopLossPct)})`;

export const explainOrder = (
  order: RebalanceOrder,
  signal: SignalSnapshot,
  previous: SignalSnapshot | undefined,
  smaCount: number,
) => {
  const base = baseAssetOf(order.symbol);
  const name = `${assetName(order.symbol)} (${base})`;
  const votes = Math.round(signal.trendScore * smaCount);
  const target = pct(order.targetWeight);
  // Сигнал не изменился — значит, сделка только выравнивает доли после движения цены
  const sameSignal =
    previous !== undefined &&
    Math.abs(previous.exposure - signal.exposure) < 1e-9;

  if (order.side === 'BUY') {
    if (sameSignal) {
      return {
        title: `Докупил ${base}`,
        details: `Цена изменилась, и доля ${base} стала меньше плана — выравниваю до ${target} капитала.`,
      };
    }
    return {
      title: `Купил ${name}`,
      details:
        votes === smaCount
          ? `Рынок растёт: цена выше всех ${smaCount} средних. Держу ${target} капитала в ${base}.`
          : `Тренд усиливается: цена выше ${votes} из ${smaCount} средних. Увеличиваю долю ${base} до ${target} капитала.`,
    };
  }

  if (order.targetWeight === 0) {
    return {
      title: `Продал весь ${name}`,
      details: `Рынок падает: цена ниже всех ${smaCount} средних. Перевожу долю ${base} в USDT, чтобы переждать.`,
    };
  }
  if (sameSignal) {
    return {
      title: `Продал часть ${base}`,
      details: `Цена выросла, и доля ${base} стала больше плана — фиксирую часть прибыли, выравниваю до ${target} капитала.`,
    };
  }
  return {
    title: `Продал часть ${name}`,
    details: `Тренд ослаб: цена выше только ${votes} из ${smaCount} средних. Уменьшаю долю ${base} до ${target} капитала.`,
  };
};

export const describeHoldingDecision = (
  signals: SignalSnapshot[],
  assetCount: number,
  smaCount: number,
) => {
  const parts = signals.map((signal) => {
    const votes = Math.round(signal.trendScore * smaCount);
    return `${assetName(signal.symbol)}: ${trendLabel(votes, smaCount).toLowerCase()} (${votes} из ${smaCount}) — держу ${pct(signal.exposure / assetCount)} капитала`;
  });
  const invested = signals.some((signal) => signal.exposure > 0);
  return `${parts.join('; ')}.${invested ? '' : ' Всё в USDT — жду восходящего тренда.'}`;
};

export const describeSellAll = (symbol: string, reason: string) => ({
  title: `Продал весь ${baseAssetOf(symbol)}`,
  details: `${reason}: перевожу всё в USDT.`,
});
