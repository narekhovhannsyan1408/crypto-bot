import { LogLevel, LogRecord } from '../observability/log.types';

const DAY_MS = 86_400_000;
export const DEFAULT_GAP_MS = 15 * 60_000;

export type RecordGroup = {
  event: string;
  message: string;
  count: number;
  firstTs: string;
  lastTs: string;
  sample: LogRecord;
};

export type Gap = {
  from: string;
  to: string;
  minutes: number;
  crossesUtcMidnight: boolean;
};

export type LogAnalysis = {
  total: number;
  firstTs: string | null;
  lastTs: string | null;
  byLevel: Partial<Record<LogLevel, number>>;
  topEvents: Array<[string, number]>;
  errorGroups: RecordGroup[];
  warningGroups: RecordGroup[];
  gaps: Gap[];
  processStarts: LogRecord[];
  decisions: LogRecord[];
  eventCounts: Record<string, number>;
};

/** Сведения о текущей сессии из файла состояния (для подсказок). */
export type StateSummary = {
  status: 'running' | 'stopped' | null;
  lastRebalanceDay: number | null;
  lastEquityPointTs: number | null;
};

const DECISION_EVENTS = new Set([
  'allocator.session.started',
  'allocator.session.resumed',
  'allocator.session.stopped',
  'allocator.session.autostopped',
  'allocator.rebalance.completed',
  'allocator.rebalance.failed',
  'allocator.order.filled',
  'allocator.order.failed',
  'allocator.autostop.triggered',
  'allocator.reconcile.adjusted',
  'process.started',
  'process.shutdown',
  'process.uncaught_exception',
  'process.bootstrap_failed',
]);

// Одинаковые ошибки с разными числами/идентификаторами — одна группа
const normalize = (text: string) =>
  text
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d+([.,]\d+)?/g, '#')
    .slice(0, 200);

const groupRecords = (records: LogRecord[]) => {
  const groups = new Map<string, RecordGroup>();
  for (const record of records) {
    const message = normalize(
      `${record.msg}${record.err ? ` | ${record.err.message}` : ''}`,
    );
    const key = `${record.event}::${message}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.lastTs = record.ts;
    } else {
      groups.set(key, {
        event: record.event,
        message,
        count: 1,
        firstTs: record.ts,
        lastTs: record.ts,
        sample: record,
      });
    }
  }
  return [...groups.values()].sort((left, right) => right.count - left.count);
};

/** Промежутки без единой записи: процесс не работал или завис. */
export const findGaps = (
  records: LogRecord[],
  gapMs = DEFAULT_GAP_MS,
): Gap[] => {
  const gaps: Gap[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const from = Date.parse(records[index - 1].ts);
    const to = Date.parse(records[index].ts);
    if (to - from > gapMs) {
      gaps.push({
        from: records[index - 1].ts,
        to: records[index].ts,
        minutes: Math.round((to - from) / 60_000),
        crossesUtcMidnight:
          Math.floor(from / DAY_MS) !== Math.floor(to / DAY_MS),
      });
    }
  }
  return gaps;
};

export const analyzeLogs = (
  records: LogRecord[],
  gapMs = DEFAULT_GAP_MS,
): LogAnalysis => {
  const byLevel: Partial<Record<LogLevel, number>> = {};
  const eventCounts: Record<string, number> = {};
  for (const record of records) {
    byLevel[record.level] = (byLevel[record.level] ?? 0) + 1;
    eventCounts[record.event] = (eventCounts[record.event] ?? 0) + 1;
  }

  return {
    total: records.length,
    firstTs: records[0]?.ts ?? null,
    lastTs: records.at(-1)?.ts ?? null,
    byLevel,
    topEvents: Object.entries(eventCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 15),
    errorGroups: groupRecords(
      records.filter(
        (record) => record.level === 'error' || record.level === 'fatal',
      ),
    ),
    warningGroups: groupRecords(
      records.filter((record) => record.level === 'warn'),
    ),
    gaps: findGaps(records, gapMs),
    processStarts: records.filter(
      (record) => record.event === 'process.started',
    ),
    decisions: records.filter((record) => DECISION_EVENTS.has(record.event)),
    eventCounts,
  };
};

/** Подсказки: с чего начать расследование. */
export const buildHints = (
  analysis: LogAnalysis,
  state: StateSummary | null,
  now = Date.now(),
): string[] => {
  const hints: string[] = [];
  const count = (event: string) => analysis.eventCounts[event] ?? 0;

  if (analysis.total === 0) {
    hints.push(
      'Журнал за период пуст: процесс не запускался, либо BOT_LOG_DIR указывает на другую папку.',
    );
  }

  const crashes =
    count('process.uncaught_exception') + count('process.bootstrap_failed');
  if (crashes > 0) {
    hints.push(
      `Процесс падал ${crashes} раз — смотри стек в группе ошибок process.*.`,
    );
  }

  if (state?.status === 'running') {
    const expectedDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    if (
      state.lastRebalanceDay !== expectedDay &&
      now - (expectedDay + DAY_MS) > 30 * 60_000
    ) {
      hints.push(
        `Решение за ${new Date(expectedDay).toISOString().slice(0, 10)} не принято — смотри allocator.rebalance.failed/deferred и простои процесса.`,
      );
    }
    const lastTs = analysis.lastTs ? Date.parse(analysis.lastTs) : null;
    if (lastTs !== null && now - lastTs > DEFAULT_GAP_MS) {
      hints.push(
        `Сессия в файле состояния «running», но последняя запись журнала была ${Math.round((now - lastTs) / 60_000)} мин назад — процесс, похоже, сейчас не запущен.`,
      );
    }
  }

  const midnightGaps = analysis.gaps.filter((gap) => gap.crossesUtcMidnight);
  if (midnightGaps.length > 0) {
    hints.push(
      `Процесс не работал в момент ежедневного решения (00:00 UTC) ${midnightGaps.length} раз — компьютер спал или программа была закрыта.`,
    );
  } else if (analysis.gaps.length > 0) {
    hints.push(
      `Найдено простоев процесса: ${analysis.gaps.length} (см. раздел «Простои»).`,
    );
  }

  if (count('binance.http.failed') > 0) {
    hints.push(
      `Сбои запросов к Binance: ${count('binance.http.failed')}. Если их много подряд — проблемы с интернетом или Binance недоступен из этой сети.`,
    );
  }
  if (count('broker.binance.order_failed') > 0) {
    hints.push(
      'Binance отклонял ордера — смотри err.message в broker.binance.order_failed (частые причины: InsufficientFunds, MIN_NOTIONAL, LOT_SIZE, неверные права API-ключа).',
    );
  }
  if (count('broker.binance.connect_failed') > 0) {
    hints.push(
      'Не удавалось подключиться к Binance с ключами — проверь ключи, права и IP-ограничения.',
    );
  }
  if (count('allocator.autostop.triggered') > 0) {
    hints.push(
      'Срабатывала автозащита — бот продал всё по порогу убытка (allocator.autostop.triggered).',
    );
  }
  if (count('allocator.autostop.skipped_stale_prices') > 0) {
    hints.push(
      'Автозащита пропускалась из-за устаревших цен — были проблемы с получением цен.',
    );
  }
  if (count('allocator.reconcile.adjusted') > 0) {
    hints.push(
      'Учёт бота уменьшался по балансу биржи — средства перемещали вручную или был сбой учёта.',
    );
  }
  if (count('session.store.persist_failed') > 0) {
    hints.push(
      'Не удавалось записать файл состояния — проверь место на диске и права на папку.',
    );
  }
  const lastStart = analysis.processStarts.at(-1);
  const startData = lastStart?.data as
    | { gitDirty?: boolean; gitCommit?: string }
    | undefined;
  if (startData?.gitDirty) {
    hints.push(
      `Последний запуск был с незакоммиченными изменениями (коммит ${startData.gitCommit ?? '?'}) — код мог отличаться от репозитория.`,
    );
  }

  return hints;
};
