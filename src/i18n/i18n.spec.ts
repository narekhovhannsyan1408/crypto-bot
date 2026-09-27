import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeAutoStopReason,
  describeDecisionFailure,
  describeHoldingDecision,
  describeProof,
  describeReconcile,
  describeSellAll,
  describeStart,
  describeStop,
  explainOrder,
} from '../allocator/engine/narrator';
import { parseLegacyText } from './legacy-text';
import { LANGS, msg, Msg, renderMsg, ru } from './messages';

const SRC = join(__dirname, '..');
const PUBLIC = join(SRC, 'web', 'public');

type Dictionary = Record<string, string | Record<string, string>>;
const load = (lang: string) =>
  JSON.parse(
    readFileSync(join(PUBLIC, 'i18n', `${lang}.json`), 'utf8'),
  ) as Dictionary;

const placeholders = (entry: Dictionary[string]) =>
  [...new Set(JSON.stringify(entry).match(/\{\w+(?::\w+)?\}/g) ?? [])].sort();

const filesIn = (dir: string, extensions: string[]): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return filesIn(path, extensions);
    return extensions.some((ext) => item.name.endsWith(ext)) &&
      !item.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });

describe('dictionaries', () => {
  const en = load('en');

  it.each(LANGS.filter((lang) => lang !== 'en'))(
    '%s has exactly the English keys with the same placeholders',
    (lang) => {
      const dictionary = load(lang);
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort());
      const mismatched = Object.keys(en).filter(
        (key) =>
          JSON.stringify(placeholders(en[key])) !==
          JSON.stringify(placeholders(dictionary[key])),
      );
      expect(mismatched).toEqual([]);
    },
  );

  it('has an "other" form for every plural entry', () => {
    for (const lang of LANGS) {
      const plurals = Object.entries(load(lang)).filter(
        ([, entry]) => typeof entry !== 'string',
      );
      expect(
        plurals.filter(([, entry]) => !(entry as Record<string, string>).other),
      ).toEqual([]);
    }
  });

  it('contains every key the server and the pages use', () => {
    const used = new Set<string>();
    for (const file of filesIn(SRC, ['.ts'])) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /\bmsg\(\s*'([\w.-]+)'/g,
      )) {
        used.add(match[1]);
      }
    }
    for (const file of filesIn(PUBLIC, ['.js', '.html'])) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt[hm]?\(\s*'([\w.-]+)'/g)) {
        used.add(match[1]);
      }
      for (const match of text.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)) {
        used.add(match[1]);
      }
      for (const match of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        for (const pair of match[1].split(';')) used.add(pair.split(':')[1]);
      }
    }
    expect([...used].filter((key) => !(key in en)).sort()).toEqual([]);
  });

  it('renders messages with locale formats and nested messages', () => {
    const message = msg('narr.stop.details', {
      reason: msg('stop.reason.user'),
      equity: 1000.07,
      diff: -12.5,
      assets: [],
    });

    expect(renderMsg('en', message)).toBe(
      'Stopped by you. Result: $1,000.07 (−$12.50).',
    );
    expect(ru(message)).toMatch(
      /^Остановлен вами\. Итог: 1\s000,07\s\$ \(−12,50\s\$\)\.$/,
    );
    expect(renderMsg('hy', message)).toContain('Կանգնեցված է ձեր կողմից');
  });
});

describe('legacy texts', () => {
  const signal = (exposure: number, trendScore: number) => ({
    symbol: 'BTCUSDT',
    day: Date.UTC(2026, 8, 26),
    close: 84000,
    trendScore,
    exposure,
    annualizedVol: null,
    smaValues: {},
  });
  const order = (side: 'BUY' | 'SELL', targetWeight: number) => ({
    symbol: 'BTCUSDT',
    side,
    quoteAmount: 250,
    quantity: 0.003,
    price: 84000,
    currentWeight: 0.1,
    targetWeight,
  });

  // Всё, что бот пишет в ленту: сохранённый русский текст должен разбираться обратно
  const narrations: Msg[] = [
    ...Object.values(describeStart('paper', 1000, 0.3)),
    ...Object.values(describeStart('solana_sim', 1234.5, 0)),
    ...Object.values(
      describeStop(false, msg('stop.reason.user'), 1000.07, 1000, []),
    ),
    ...Object.values(
      describeStop(
        true,
        describeAutoStopReason(690.12, 700, 0.3),
        690.12,
        1000,
        ['BTC', 'ETH'],
      ),
    ),
    ...Object.values(
      explainOrder(order('BUY', 0.5), signal(1, 1), undefined, 4),
    ),
    ...Object.values(
      explainOrder(order('BUY', 0.25), signal(0.5, 0.5), undefined, 4),
    ),
    ...Object.values(
      explainOrder(order('SELL', 0), signal(0, 0), signal(1, 1), 4, 'USDC'),
    ),
    ...Object.values(
      explainOrder(order('SELL', 0.25), signal(0.5, 0.5), signal(0.5, 0.5), 4),
    ),
    ...Object.values(
      explainOrder(order('BUY', 0.5), signal(1, 1), signal(1, 1), 4),
    ),
    ...Object.values(
      describeHoldingDecision(
        [signal(1, 1), { ...signal(0, 0.25), symbol: 'ETHUSDT' }],
        2,
        4,
      ),
    ),
    ...Object.values(describeHoldingDecision([signal(0, 0)], 1, 4, 'USDC')),
    ...Object.values(
      describeSellAll('SOLUSDT', msg('stop.reason.user'), 'USDC'),
    ),
    ...Object.values(describeProof(Date.UTC(2026, 8, 26), 'devnet')),
    ...Object.values(
      describeDecisionFailure(
        msg('err.ordersFailed', {
          items: [
            msg('err.orderItem', {
              side: msg('side.buy'),
              base: 'BTC',
              error: msg('error.raw', { text: 'timeout' }),
            }),
          ],
        }),
      ),
    ),
    ...Object.values(
      describeReconcile('Binance', ['BTC: 1 → 0.5', 'USDT: 10.00 → 5.00']),
    ),
  ].filter((item): item is Msg => Boolean(item));

  it.each(narrations.map((message): [string, Msg] => [ru(message), message]))(
    'reads back «%s»',
    (text, message) => {
      const parsed = parseLegacyText(text, ['narr.']);

      expect(parsed).not.toBeNull();
      for (const lang of LANGS) {
        expect(renderMsg(lang, parsed!)).toBe(renderMsg(lang, message));
      }
    },
  );

  it('understands texts written by earlier versions', () => {
    expect(parseLegacyText('Бот запущен: binance demo', ['narr.'])).toEqual({
      key: 'narr.start.title',
      params: { mode: { key: 'mode.inline.live_testnet' } },
    });
    expect(
      parseLegacyText('Остановлен из расширенного дашборда', ['stop.reason.']),
    ).toEqual({ key: 'stop.reason.advanced' });
    expect(
      renderMsg(
        'en',
        parseLegacyText(
          'Дневная свеча BTCUSDT за 2026-09-26 ещё не доступна. Бот повторит попытку автоматически.',
          ['narr.'],
        )!,
      ),
    ).toBe(
      "The BTCUSDT daily candle for September 26, 2026 isn't available yet. The bot will retry automatically.",
    );
    expect(parseLegacyText('Что-то совсем другое', ['narr.'])).toBeNull();
  });
});
