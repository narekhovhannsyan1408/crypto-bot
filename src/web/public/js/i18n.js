// Перевод интерфейса. Английский — всегда по умолчанию; выбранный язык запоминается
// в браузере. Словари общие с сервером: /i18n/<язык>.json (формат — src/i18n/messages.ts).

export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN', locale: 'en-US' },
  { code: 'ru', label: 'Русский', short: 'RU', locale: 'ru-RU' },
  { code: 'hy', label: 'Հայերեն', short: 'HY', locale: 'hy-AM' },
];

const DEFAULT_LANG = 'en';
const STORAGE_KEY = 'crypto-bot.lang';

let current = DEFAULT_LANG;
let dictionary = {};
let fallback = {};
const listeners = new Set();

const isKnown = (code) => LANGUAGES.some((item) => item.code === code);

function readStoredLang() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLang(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // без хранилища язык просто не запомнится
  }
}

async function loadDictionary(code) {
  const response = await fetch(`/i18n/${code}.json`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Dictionary ${code}: HTTP ${response.status}`);
  }
  return response.json();
}

export const lang = () => current;
export const locale = () =>
  LANGUAGES.find((item) => item.code === current)?.locale ?? 'en-US';

const nativeSupport = new Map();
/** Есть ли в браузере данные локали (во встроенных Chromium армянского может не быть). */
export const hasNativeLocale = () => {
  const code = locale();
  if (!nativeSupport.has(code)) {
    let supported = false;
    try {
      supported = Intl.DateTimeFormat.supportedLocalesOf([code]).length > 0;
    } catch {
      supported = false;
    }
    nativeSupport.set(code, supported);
  }
  return nativeSupport.get(code);
};

// Без данных армянской локали числа форматируем по тем же правилам, что и она:
// пробел между разрядами, запятая, «$» после суммы — как в русской
export const numberLocale = () =>
  hasNativeLocale() ? locale() : current === 'hy' ? 'ru-RU' : 'en-US';

const HY_MONTHS = {
  long: [
    'հունվարի',
    'փետրվարի',
    'մարտի',
    'ապրիլի',
    'մայիսի',
    'հունիսի',
    'հուլիսի',
    'օգոստոսի',
    'սեպտեմբերի',
    'հոկտեմբերի',
    'նոյեմբերի',
    'դեկտեմբերի',
  ],
  short: ['հնվ', 'փտվ', 'մրտ', 'ապր', 'մյս', 'հնս', 'հլս', 'օգս', 'սեպ', 'հոկ', 'նոյ', 'դեկ'],
};

const pad = (value) => String(value).padStart(2, '0');

/**
 * Дата по-местному: { month: 'long' | 'short', year, time, utc }.
 * Для армянского без данных локали собираем строку сами, как её пишет CLDR:
 * «26 սեպտեմբերի, 2026 թ.», «27 սեպ, 15:59».
 */
export function formatDate(ts, { month = 'short', year = false, time = false, utc = false } = {}) {
  const date = new Date(ts);
  if (hasNativeLocale() || current !== 'hy') {
    return date.toLocaleString(locale(), {
      day: 'numeric',
      month,
      ...(year ? { year: 'numeric' } : {}),
      ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
      ...(utc ? { timeZone: 'UTC' } : {}),
    });
  }
  const get = (local, universal) => (utc ? universal.call(date) : local.call(date));
  const day = get(Date.prototype.getDate, Date.prototype.getUTCDate);
  const monthIndex = get(Date.prototype.getMonth, Date.prototype.getUTCMonth);
  let text = `${day} ${HY_MONTHS[month][monthIndex]}`;
  if (year) text += `, ${get(Date.prototype.getFullYear, Date.prototype.getUTCFullYear)} թ.`;
  if (time) text += `, ${formatTime(ts)}`;
  return text;
}

export function formatTime(ts) {
  if (hasNativeLocale() || current !== 'hy') {
    return new Date(ts).toLocaleTimeString(locale(), {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** «A, B и C» по правилам языка; для армянского без данных локали — «A, B և C». */
export function formatList(items) {
  if (hasNativeLocale() || current !== 'hy') {
    return new Intl.ListFormat(locale(), { type: 'conjunction' }).format(items);
  }
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} և ${items[items.length - 1]}`;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const isMessage = (value) =>
  typeof value === 'object' && value !== null && typeof value.key === 'string';

const money = (value) =>
  new Intl.NumberFormat(numberLocale(), {
    style: 'currency',
    currency: 'USD',
  }).format(value);

function formatParam(value, format, html) {
  if (Array.isArray(value)) {
    return value
      .map((item) => formatParam(item, undefined, html))
      .join(format === 'semi' ? '; ' : ', ');
  }
  if (isMessage(value)) {
    const text = translate(value.key, value.params, html);
    return format === 'lower' ? text.toLocaleLowerCase(locale()) : text;
  }
  if (value === null || value === undefined) return '';
  let text;
  const number = Number(value);
  switch (format) {
    case 'money':
      text = money(number);
      break;
    case 'signedMoney':
      text = `${number > 0 ? '+' : number < 0 ? '−' : ''}${money(Math.abs(number))}`;
      break;
    case 'pct':
      text = `${Math.round(number * 100)}%`;
      break;
    case 'date':
      text = formatDate(value, { month: 'long', year: true, utc: true });
      break;
    case 'num':
      text = number.toLocaleString(numberLocale(), { maximumFractionDigits: 8 });
      break;
    default:
      text = String(value);
  }
  return html ? escapeHtml(text) : text;
}

function translate(key, params = {}, html = false) {
  const entry = dictionary[key] ?? fallback[key];
  if (entry === undefined) return key;
  const template =
    typeof entry === 'string'
      ? entry
      : (entry[new Intl.PluralRules(locale()).select(Number(params.count ?? 0))] ??
        entry.other ??
        '');
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, name, format) =>
    formatParam(params[name], format, html),
  );
}

/** Текст по ключу. Для вставки в innerHTML используйте th — она экранирует параметры. */
export const t = (key, params) => translate(key, params, false);
export const th = (key, params) => translate(key, params, true);

/** Сообщение от сервера ({ key, params }) или старая строка как есть. */
export const tm = (message) =>
  isMessage(message) ? t(message.key, message.params) : String(message ?? '');

/**
 * Перевод статичной разметки: data-i18n — текст, data-i18n-html — разметка из
 * словаря, data-i18n-attr — атрибуты в виде «aria-label:ключ;placeholder:ключ».
 */
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((element) => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((element) => {
    for (const pair of element.dataset.i18nAttr.split(';')) {
      const [attribute, key] = pair.split(':');
      if (attribute && key) element.setAttribute(attribute.trim(), t(key.trim()));
    }
  });
}

async function applyLang(code) {
  dictionary =
    code === DEFAULT_LANG
      ? fallback
      : await loadDictionary(code).catch(() => fallback);
  current = code;
  document.documentElement.lang = code;
  translateDom();
  renderSwitchers();
}

/** Язык из ?lang=, затем сохранённый выбор, иначе английский. */
export async function initI18n() {
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (isKnown(fromUrl)) storeLang(fromUrl);
  const wanted = isKnown(fromUrl) ? fromUrl : readStoredLang();
  fallback = await loadDictionary(DEFAULT_LANG);
  await applyLang(isKnown(wanted) ? wanted : DEFAULT_LANG);
}

export async function setLang(code) {
  if (!isKnown(code) || code === current) return;
  storeLang(code);
  await applyLang(code);
  listeners.forEach((listener) => listener(code));
}

export const onLangChange = (listener) => listeners.add(listener);

const switchers = new Set();

function renderSwitchers() {
  for (const container of switchers) {
    container.setAttribute('aria-label', t('lang.label'));
    container.querySelectorAll('button').forEach((button) => {
      const active = button.dataset.lang === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
}

/** Переключатель EN / RU / HY в шапке. */
export function mountLangSwitch(container) {
  container.classList.add('lang-switch');
  container.setAttribute('role', 'group');
  container.innerHTML = LANGUAGES.map(
    (item) =>
      `<button type="button" data-lang="${item.code}" title="${item.label}" lang="${item.code}">${item.short}</button>`,
  ).join('');
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-lang]');
    if (button) void setLang(button.dataset.lang);
  });
  switchers.add(container);
  renderSwitchers();
}
