// Общие части простого и расширенного режимов: цвета, тренды, лента событий, история.

import {
  dayHeading,
  dayKey,
  escapeHtml,
  explorerTxUrl,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtShortDate,
  fmtSignedMoney,
  fmtTime,
} from './format.js';
import { t, tm } from './i18n.js';

export const REAL_MODES = new Set(['live_real', 'solana_real']);
export const ASSET_COLORS = {
  BTC: 'var(--btc)',
  ETH: 'var(--eth)',
  SOL: 'var(--sol)',
  USDT: 'var(--usdt)',
  USDC: 'var(--usdc)',
};
export const EVENT_ICONS = {
  buy: '↗',
  sell: '↘',
  start: '▶',
  stop: '■',
  autostop: '🛡',
  check: '✓',
  proof: '⛓',
  error: '!',
};
export const CLUSTER_NAMES = {
  'mainnet-beta': 'mainnet',
  devnet: 'devnet',
  testnet: 'testnet',
};

// Сила тренда по числу средних ниже цены — те же пороги, что на сервере
export const trendKey = (votes, total) => {
  if (votes === null || votes === undefined || total <= 0) return 'trend.none';
  const share = votes / total;
  if (share === 1) return 'trend.strongUp';
  if (share >= 0.75) return 'trend.up';
  if (share >= 0.5) return 'trend.mixed';
  if (share > 0) return 'trend.weak';
  return 'trend.down';
};

export function trendClass(votes, total) {
  if (votes === null || votes === undefined) return 'none';
  if (votes === total) return 'up';
  if (votes / total >= 0.5) return 'mid';
  return 'down';
}

// Запись ленты: новые записи переводятся по ключам, старые показываются как сохранены
export const entryTitle = (entry) =>
  entry.text?.title ? tm(entry.text.title) : entry.title;
export const entryDetails = (entry) =>
  entry.text?.details ? tm(entry.text.details) : (entry.details ?? '');

export const stopReasonText = (item) =>
  item.stopReasonMsg ? tm(item.stopReasonMsg) : (item.stopReason ?? '');

/** Строка фактов под записью: количество, цена, сумма, комиссия и ссылка на транзакцию. */
export function entryFacts(entry, venue) {
  let facts = '';
  if (
    (entry.kind === 'buy' || entry.kind === 'sell') &&
    entry.quantity !== undefined
  ) {
    facts = escapeHtml(
      t('activity.facts', {
        qty: fmtQty(entry.quantity),
        base: entry.symbol ? entry.symbol.replace(/USDT$/, '') : '',
        price: fmtPrice(entry.price),
        verb: t(entry.kind === 'buy' ? 'activity.spent' : 'activity.received'),
        amount: fmtMoney(entry.quoteAmount),
        // На Solana комиссия пулов уже в цене обмена; отдельно платится только комиссия сети
        feeLabel: t(venue === 'Solana' ? 'activity.networkFee' : 'activity.fee'),
        fee: fmtMoney(entry.fee || 0),
      }),
    );
  }
  if (entry.chainTx) {
    const link = `<a class="chain-link" href="${escapeHtml(explorerTxUrl(entry.chainTx))}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(entry.kind === 'proof' ? 'activity.proofLink' : 'activity.txLink'))} ↗</a>`;
    facts = facts ? `${facts} · ${link}` : link;
  }
  return facts ? `<div class="event-facts">${facts}</div>` : '';
}

/** Лента событий, сгруппированная по дням. */
export function renderTimeline(items, venue) {
  if (items.length === 0) {
    return `<li class="empty">${escapeHtml(t('activity.empty'))}</li>`;
  }
  let currentDay = null;
  const html = [];
  for (const entry of items) {
    const key = dayKey(entry.timestamp);
    if (key !== currentDay) {
      currentDay = key;
      html.push(
        `<li class="day">${escapeHtml(dayHeading(entry.timestamp))}</li>`,
      );
    }
    const details = entryDetails(entry);
    html.push(`
      <li class="event">
        <span class="event-icon ${escapeHtml(entry.kind)}" aria-hidden="true">${EVENT_ICONS[entry.kind] ?? '•'}</span>
        <div>
          <div class="event-title">${escapeHtml(entryTitle(entry))}</div>
          ${details ? `<div class="event-details">${escapeHtml(details)}</div>` : ''}
          ${entryFacts(entry, venue)}
        </div>
        <time class="event-time" datetime="${new Date(entry.timestamp).toISOString()}">${fmtTime(entry.timestamp)}</time>
      </li>`);
  }
  return html.join('');
}

export function historyRows(history) {
  return history
    .map(
      (item) => `
      <tr>
        <td>${fmtShortDate(item.startedAt)} — ${fmtShortDate(item.stoppedAt)}</td>
        <td>${escapeHtml(t(`mode.label.${item.mode}`))}</td>
        <td>${fmtMoney(item.initialCapital)}</td>
        <td>${fmtMoney(item.finalEquity)}</td>
        <td class="${item.profit >= 0 ? 'positive-text' : 'negative-text'}">${fmtSignedMoney(item.profit)} (${fmtPct(item.profitPct)})</td>
      </tr>`,
    )
    .join('');
}
