import { dictionaryEntries, Msg, MsgParam } from './messages';

/**
 * Записи, сохранённые до перевода интерфейса, хранят только русский текст.
 * Здесь он разбирается обратно в сообщение словаря по русским шаблонам:
 * «Продал весь SOL» → { key: 'narr.sellAll.title', params: { base: 'SOL' } } —
 * после этого запись показывается на любом языке. Что не распознано, остаётся как было.
 */

type Placeholder = { name: string; format?: string };
type Matcher = {
  key: string;
  template: string;
  regex: RegExp;
  placeholders: Placeholder[];
  // Сколько в шаблоне постоянного текста: конкретные шаблоны проверяются первыми
  literalLength: number;
};

// Какие сообщения может содержать вложенный параметр
const NESTED: Record<string, string[]> = {
  reason: ['stop.reason.'],
  mode: ['mode.inline.'],
  trend: ['trend.'],
  cluster: ['narr.proof.cluster.'],
  side: ['side.'],
  error: ['err.'],
};
// Списки: разделитель и, если элементы — сообщения, их ключи. strict — элемент
// обязан распознаться (иначе общий шаблон «{parts}.» поймал бы любую фразу)
const LISTS: Record<
  string,
  { separator: string; item?: string[]; strict?: boolean }
> = {
  parts: { separator: '; ', item: ['narr.hold.part'], strict: true },
  // Ошибки ордеров или строки сверки баланса («BTC: 1 → 0.5»)
  items: { separator: '; ', item: ['err.orderItem'] },
  assets: { separator: ', ' },
};
// Формулировки прошлых версий, которых уже нет в словаре
const ALIASES: Record<string, Msg> = {
  'остановлен из расширенного дашборда': { key: 'stop.reason.advanced' },
};

const RU_MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

// \s в JS включает и неразрывные пробелы, которыми Intl разделяет разряды
const MONEY = String.raw`([+−-]?[\d\s]+(?:,\d+)?\s?\$)`;
const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let matchers: Matcher[] | null = null;

const buildMatchers = () => {
  const result: Matcher[] = [];
  for (const [key, entry] of dictionaryEntries('ru')) {
    const templates =
      typeof entry === 'string'
        ? [entry]
        : [...new Set(Object.values(entry))].filter(Boolean);
    for (const template of templates) {
      const placeholders: Placeholder[] = [];
      let pattern = '';
      let last = 0;
      for (const match of template.matchAll(/\{(\w+)(?::(\w+))?\}/g)) {
        pattern += escapeRegex(template.slice(last, match.index));
        placeholders.push({ name: match[1], format: match[2] });
        pattern +=
          match[2] === 'money' || match[2] === 'signedMoney'
            ? MONEY
            : match[2] === 'pct'
              ? String.raw`(\d+)%`
              : '(.+?)';
        last = (match.index ?? 0) + match[0].length;
      }
      pattern += escapeRegex(template.slice(last));
      result.push({
        key,
        template,
        regex: new RegExp(`^${pattern}$`, 's'),
        placeholders,
        literalLength: template.replace(/\{\w+(?::\w+)?\}/g, '').length,
      });
    }
  }
  return result.sort((a, b) => b.literalLength - a.literalLength);
};

const parseMoney = (text: string) =>
  Number(text.replace(/[\s$]/g, '').replace('−', '-').replace(',', '.'));

const parseDay = (text: string) => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const ru = /^(\d{1,2}) (\S+) (\d{4})/.exec(text);
  const month = ru ? RU_MONTHS.indexOf(ru[2]) : -1;
  return ru && month >= 0 ? Date.UTC(+ru[3], month, +ru[1]) : text;
};

const convert = (
  placeholder: Placeholder,
  raw: string,
): MsgParam | undefined => {
  switch (placeholder.format) {
    case 'money':
    case 'signedMoney':
      return parseMoney(raw);
    case 'pct':
      return Number(raw) / 100;
    case 'date':
      return parseDay(raw);
  }
  const list = LISTS[placeholder.name];
  if (list) {
    const items = raw.split(list.separator);
    if (!list.item) return items;
    const parsed = items.map((item) => parseLegacyText(item, list.item!));
    if (list.strict) {
      return parsed.every(Boolean) ? (parsed as Msg[]) : undefined;
    }
    return parsed.map((item, index) => item ?? items[index]);
  }
  const nested = NESTED[placeholder.name];
  if (nested) {
    const parsed = parseLegacyText(raw, nested);
    if (parsed) return parsed;
    // Неизвестная причина ошибки остаётся исходным текстом, как делает errorMsg
    return placeholder.name === 'error'
      ? { key: 'error.raw', params: { text: raw } }
      : undefined;
  }
  return raw;
};

/**
 * Разбирает русский текст в сообщение. prefixes ограничивает круг ключей
 * (например, только narr.* для записей ленты). null — текст не распознан.
 */
export function parseLegacyText(text: string, prefixes: string[]): Msg | null {
  const alias = ALIASES[text.trim().toLowerCase()];
  if (alias && prefixes.some((prefix) => alias.key.startsWith(prefix))) {
    return alias;
  }
  matchers ??= buildMatchers();
  const lower = text.toLowerCase();
  for (const matcher of matchers) {
    if (!prefixes.some((prefix) => matcher.key.startsWith(prefix))) continue;
    // Сообщения без параметров сравниваем без учёта регистра: старые версии
    // писали «Бот запущен: binance demo» строчными
    if (matcher.placeholders.length === 0) {
      if (matcher.template.toLowerCase() === lower) {
        return { key: matcher.key };
      }
      continue;
    }
    const match = matcher.regex.exec(text);
    if (!match) continue;
    const params: Record<string, MsgParam> = {};
    let ok = true;
    matcher.placeholders.forEach((placeholder, index) => {
      const value = convert(placeholder, match[index + 1]);
      if (value === undefined) ok = false;
      else params[placeholder.name] = value;
    });
    if (ok) return { key: matcher.key, params };
  }
  return null;
}
