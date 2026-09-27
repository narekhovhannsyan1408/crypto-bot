// Форматирование чисел, дат и текста для русского интерфейса.

const moneyFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const fmtMoney = (value) => `${moneyFormat.format(value)} $`;

export const fmtSignedMoney = (value) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${moneyFormat.format(Math.abs(value))} $`;

export const fmtPct = (value) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString(
    'ru-RU',
    {
      maximumFractionDigits: 2,
    },
  )}%`;

export const fmtPrice = (value) =>
  `${value.toLocaleString('ru-RU', { maximumFractionDigits: value >= 100 ? 2 : 4 })} $`;

export const fmtQty = (value) =>
  value.toLocaleString('ru-RU', { maximumSignificantDigits: 6 });

export const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

export const fmtDateTime = (ts) =>
  new Date(ts).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const fmtShortDate = (ts) =>
  new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

export const plural = (n, forms) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20))
    return forms[1];
  return forms[2];
};

export const humanDuration = (ms) => {
  const minutes = Math.max(Math.floor(ms / 60_000), 0);
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60)
    return `${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    const hoursText = `${hours} ${plural(hours, ['час', 'часа', 'часов'])}`;
    return hours < 6 && rest > 0
      ? `${hoursText} ${rest} ${plural(rest, ['минуту', 'минуты', 'минут'])}`
      : hoursText;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
};

export const dayKey = (ts) => new Date(ts).toDateString();

export const dayHeading = (ts) => {
  if (dayKey(ts) === new Date().toDateString()) return 'Сегодня';
  if (dayKey(ts) === new Date(Date.now() - 86_400_000).toDateString())
    return 'Вчера';
  return new Date(ts).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
};

export const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
