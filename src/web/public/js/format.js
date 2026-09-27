// Форматирование чисел, дат и текста под выбранный язык интерфейса.

import {
  formatDate,
  formatList,
  formatTime,
  numberLocale,
  t,
} from './i18n.js';

export const fmtMoney = (value) =>
  new Intl.NumberFormat(numberLocale(), {
    style: 'currency',
    currency: 'USD',
  }).format(value);

// Знак ставим после округления: −0,001 → «0,00 $», а не «−0,00 $»
const roundTo = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const sign = (value) => (value > 0 ? '+' : value < 0 ? '−' : '');

export const fmtSignedMoney = (value) => {
  const rounded = roundTo(value, 2);
  return `${sign(rounded)}${fmtMoney(Math.abs(rounded))}`;
};

// Значение уже в процентах: 12.5 → «+12,5%»
export const fmtPct = (value) => {
  const rounded = roundTo(value, 2);
  return `${sign(rounded)}${Math.abs(rounded).toLocaleString(numberLocale(), {
    maximumFractionDigits: 2,
  })}%`;
};

export const fmtNumber = (value, digits = 2) =>
  Number(value).toLocaleString(numberLocale(), {
    maximumFractionDigits: digits,
  });

export const fmtPrice = (value) =>
  new Intl.NumberFormat(numberLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 2 : 4,
  }).format(value);

export const fmtQty = (value) =>
  value.toLocaleString(numberLocale(), { maximumSignificantDigits: 6 });

export const fmtTime = (ts) => formatTime(ts);

export const fmtDateTime = (ts) =>
  formatDate(ts, { month: 'short', time: true });

export const fmtShortDate = (ts) => formatDate(ts, { month: 'short' });

// День дневной свечи хранится как полночь UTC — показываем его без сдвига пояса
export const fmtUtcDay = (ts) =>
  formatDate(ts, { month: 'short', year: true, utc: true });

export const humanDuration = (ms) => {
  const minutes = Math.max(Math.floor(ms / 60_000), 0);
  if (minutes < 1) return t('duration.lessThanMinute');
  if (minutes < 60) return t('duration.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    const hoursText = t('duration.hours', { count: hours });
    return hours < 6 && rest > 0
      ? t('duration.hoursMinutes', {
          hours: hoursText,
          minutes: t('duration.minutes', { count: rest }),
        })
      : hoursText;
  }
  return t('duration.days', { count: Math.floor(hours / 24) });
};

export const dayKey = (ts) => new Date(ts).toDateString();

export const dayHeading = (ts) => {
  if (dayKey(ts) === new Date().toDateString()) return t('day.today');
  if (dayKey(ts) === new Date(Date.now() - 86_400_000).toDateString())
    return t('day.yesterday');
  return formatDate(ts, { month: 'long', year: true });
};

export const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Ссылка на транзакцию Solana в обозревателе (для devnet/testnet — с параметром сети)
export const explorerTxUrl = (chainTx) =>
  `https://explorer.solana.com/tx/${encodeURIComponent(chainTx.txId)}${
    chainTx.cluster === 'mainnet-beta'
      ? ''
      : `?cluster=${encodeURIComponent(chainTx.cluster)}`
  }`;

export const explorerAddressUrl = (address, cluster = 'mainnet-beta') =>
  `https://explorer.solana.com/address/${encodeURIComponent(address)}${
    cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster)}`
  }`;

export const shortAddress = (address) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;

// «BTC», «BTC and ETH», «BTC, ETH и SOL» — по правилам выбранного языка
export const joinList = (items) => formatList(items);
