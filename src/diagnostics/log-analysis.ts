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
      'The journal is empty for this period: the process did not run, or BOT_LOG_DIR points to another folder.',
    );
  }

  const crashes =
    count('process.uncaught_exception') + count('process.bootstrap_failed');
  if (crashes > 0) {
    hints.push(
      `The process crashed ${crashes} time(s) — see the stack in the process.* error group.`,
    );
  }

  if (state?.status === 'running') {
    const expectedDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    if (
      state.lastRebalanceDay !== expectedDay &&
      now - (expectedDay + DAY_MS) > 30 * 60_000
    ) {
      hints.push(
        `No decision was made for ${new Date(expectedDay).toISOString().slice(0, 10)} — see allocator.rebalance.failed/deferred and the process downtime.`,
      );
    }
    const lastTs = analysis.lastTs ? Date.parse(analysis.lastTs) : null;
    if (lastTs !== null && now - lastTs > DEFAULT_GAP_MS) {
      hints.push(
        `The state file says the session is running, but the last journal entry was ${Math.round((now - lastTs) / 60_000)} min ago — the process does not seem to be running now.`,
      );
    }
  }

  const midnightGaps = analysis.gaps.filter((gap) => gap.crossesUtcMidnight);
  if (midnightGaps.length > 0) {
    hints.push(
      `The process was not running at the daily decision time (00:00 UTC) ${midnightGaps.length} time(s) — the computer was asleep or the app was closed.`,
    );
  } else if (analysis.gaps.length > 0) {
    hints.push(
      `Process downtime periods found: ${analysis.gaps.length} (see the Downtime section).`,
    );
  }

  if (count('binance.http.failed') > 0) {
    hints.push(
      `Failed Binance requests: ${count('binance.http.failed')}. Many in a row mean internet problems, or Binance is not reachable from this network.`,
    );
  }
  if (count('broker.binance.order_failed') > 0) {
    hints.push(
      'Binance rejected orders — see err.message in broker.binance.order_failed (common causes: InsufficientFunds, MIN_NOTIONAL, LOT_SIZE, wrong API key permissions).',
    );
  }
  if (count('broker.binance.connect_failed') > 0) {
    hints.push(
      'Could not connect to Binance with the keys — check the keys, their permissions and IP restrictions.',
    );
  }
  if (count('allocator.autostop.triggered') > 0) {
    hints.push(
      'Auto-protection triggered — the bot sold everything at the loss threshold (allocator.autostop.triggered).',
    );
  }
  if (count('allocator.autostop.skipped_stale_prices') > 0) {
    hints.push(
      'Auto-protection was skipped because of stale prices — there were problems getting prices.',
    );
  }
  if (count('allocator.reconcile.adjusted') > 0) {
    hints.push(
      'Session records were reduced to the exchange balance — funds were moved manually or the records were off.',
    );
  }
  if (count('session.store.persist_failed') > 0) {
    hints.push(
      'The state file could not be written — check the free disk space and folder permissions.',
    );
  }
  const lastStart = analysis.processStarts.at(-1);
  const startData = lastStart?.data as
    | { gitDirty?: boolean; gitCommit?: string }
    | undefined;
  if (startData?.gitDirty) {
    hints.push(
      `The last start had uncommitted changes (commit ${startData.gitCommit ?? '?'}) — the code may differ from the repository.`,
    );
  }

  return hints;
};
