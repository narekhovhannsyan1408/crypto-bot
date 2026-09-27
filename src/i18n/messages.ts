import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Сообщение для интерфейса: ключ словаря и параметры. Сервер не отдаёт готовый
 * текст — страница переводит его на выбранный язык по тем же словарям
 * (src/web/public/i18n/*.json). Параметр может быть вложенным сообщением.
 *
 * Шаблон: «Капитал {capital:money}», формат после двоеточия — money, signedMoney,
 * pct (доля 0.3 → 30%), num, date (день в UTC), lower (со строчной буквы);
 * список склеивается через «, » или через «; » с форматом semi. Множественное
 * число — объект { one, few, many, other } с параметром count.
 */
export type MsgParam = string | number | null | Msg | MsgParam[];
export type Msg = { key: string; params?: Record<string, MsgParam> };

export const LANGS = ['en', 'ru', 'hy'] as const;
export type Lang = (typeof LANGS)[number];

const LOCALES: Record<Lang, string> = {
  en: 'en-US',
  ru: 'ru-RU',
  hy: 'hy-AM',
};

type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;
type Dictionary = Record<string, Entry>;

// И в src (ts-node, jest), и в dist словари лежат рядом: web/public/i18n
const DICTIONARY_DIR = join(__dirname, '..', 'web', 'public', 'i18n');
const dictionaries = new Map<Lang, Dictionary>();

const dictionary = (lang: Lang) => {
  let loaded = dictionaries.get(lang);
  if (!loaded) {
    loaded = JSON.parse(
      readFileSync(join(DICTIONARY_DIR, `${lang}.json`), 'utf8'),
    ) as Dictionary;
    dictionaries.set(lang, loaded);
  }
  return loaded;
};

/** Все записи словаря языка (для разбора старых сохранённых текстов). */
export const dictionaryEntries = (lang: Lang) =>
  Object.entries(dictionary(lang));

export const msg = (key: string, params?: Record<string, MsgParam>): Msg =>
  params ? { key, params } : { key };

export const isMsg = (value: unknown): value is Msg =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Msg).key === 'string';

const formatValue = (
  value: MsgParam,
  format: string | undefined,
  lang: Lang,
): string => {
  const locale = LOCALES[lang];
  if (Array.isArray(value)) {
    return value
      .map((item) => formatValue(item, undefined, lang))
      .join(format === 'semi' ? '; ' : ', ');
  }
  if (isMsg(value)) {
    const text = renderMsg(lang, value);
    return format === 'lower' ? text.toLocaleLowerCase(locale) : text;
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && format !== 'date') return value;
  const number = Number(value);
  switch (format) {
    case 'money':
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
      }).format(number);
    case 'signedMoney': {
      const text = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
      }).format(Math.abs(number));
      return `${number > 0 ? '+' : number < 0 ? '−' : ''}${text}`;
    }
    case 'pct':
      return `${Math.round(number * 100)}%`;
    case 'date':
      return new Date(value).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
    case 'num':
      return number.toLocaleString(locale, { maximumFractionDigits: 8 });
    default:
      return String(value);
  }
};

export const renderMsg = (lang: Lang, message: Msg): string => {
  const entry = dictionary(lang)[message.key] ?? dictionary('en')[message.key];
  if (entry === undefined) return message.key;
  const params = message.params ?? {};
  const template =
    typeof entry === 'string'
      ? entry
      : (entry[
          new Intl.PluralRules(LOCALES[lang]).select(Number(params.count ?? 0))
        ] ??
        entry.other ??
        '');
  return template.replace(
    /\{(\w+)(?::(\w+))?\}/g,
    (_, name: string, format: string | undefined) =>
      formatValue(params[name] ?? null, format, lang),
  );
};

/** Русский текст сообщения — для журнала, консоли и старых полей состояния. */
export const ru = (message: Msg) => renderMsg('ru', message);

/**
 * Ошибка, которую можно показать пользователю на любом языке. В журнал и в
 * error.message попадает русский текст, в интерфейс — ключ сообщения.
 */
export class LocalizedError extends Error {
  constructor(readonly msg: Msg) {
    super(ru(msg));
    this.name = 'LocalizedError';
  }
}

/** Сообщение об ошибке для интерфейса: переводимое или исходный текст как есть. */
export const errorMsg = (error: unknown): Msg =>
  error instanceof LocalizedError
    ? error.msg
    : msg('error.raw', {
        text: error instanceof Error ? error.message : String(error),
      });
