import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LEVEL_WEIGHT, LogLevel, LogRecord } from '../observability/log.types';
import { LOG_FILE_PATTERN } from '../observability/rotating-file-sink';

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const DAY_MS = 86_400_000;

export type LogQuery = {
  dir: string;
  since?: number;
  until?: number;
  minLevel?: LogLevel;
  // Шаблоны имён событий, * — любая подстрока: allocator.*, *.failed
  events?: string[];
  sessionId?: string;
  opId?: string;
  requestId?: string;
  text?: string;
};

export type LogReadResult = {
  records: LogRecord[];
  files: string[];
  malformedLines: number;
};

/** «30m», «6h», «7d» — назад от now; иначе ISO-дата/время («2026-09-27», «2026-09-27 10:00»). */
export const parseTimeArg = (value: string, now = Date.now()) => {
  const relative = /^(\d+)([mhd])$/.exec(value.trim());
  if (relative) {
    return now - Number(relative[1]) * UNIT_MS[relative[2]];
  }
  const parsed = Date.parse(value.trim().replace(' ', 'T'));
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Не понимаю время «${value}». Примеры: 30m, 6h, 2d, 2026-09-27T10:00`,
    );
  }
  return parsed;
};

export const matchesEventPattern = (event: string, pattern: string) => {
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(event);
};

/** Файлы журнала по порядку: день, затем номер части. */
export const listLogFiles = (dir: string) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => ({ file, match: LOG_FILE_PATTERN.exec(file) }))
    .filter(
      (item): item is { file: string; match: RegExpExecArray } =>
        item.match !== null,
    )
    .sort((left, right) =>
      left.match[1] === right.match[1]
        ? Number(left.match[2] ?? 0) - Number(right.match[2] ?? 0)
        : left.match[1].localeCompare(right.match[1]),
    )
    .map((item) => ({ path: join(dir, item.file), day: item.match[1] }));
};

export const matchesQuery = (record: LogRecord, query: LogQuery) => {
  const ts = Date.parse(record.ts);
  if (query.since !== undefined && ts < query.since) return false;
  if (query.until !== undefined && ts > query.until) return false;
  if (
    query.minLevel &&
    LEVEL_WEIGHT[record.level] < LEVEL_WEIGHT[query.minLevel]
  )
    return false;
  if (query.sessionId && record.sessionId !== query.sessionId) return false;
  if (query.opId && record.opId !== query.opId) return false;
  if (query.requestId && record.requestId !== query.requestId) return false;
  if (
    query.events?.length &&
    !query.events.some((pattern) => matchesEventPattern(record.event, pattern))
  ) {
    return false;
  }
  if (query.text) {
    const haystack = JSON.stringify(record).toLowerCase();
    if (!haystack.includes(query.text.toLowerCase())) return false;
  }
  return true;
};

/** Потоково читает журнал, пропуская файлы вне периода. */
export const readLogs = async (query: LogQuery): Promise<LogReadResult> => {
  const result: LogReadResult = { records: [], files: [], malformedLines: 0 };

  for (const { path, day } of listLogFiles(query.dir)) {
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    if (query.since !== undefined && dayStart + DAY_MS < query.since) continue;
    if (query.until !== undefined && dayStart > query.until) continue;
    result.files.push(path);

    const lines = createInterface({
      input: createReadStream(path, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: LogRecord;
      try {
        record = JSON.parse(line) as LogRecord;
      } catch {
        result.malformedLines += 1;
        continue;
      }
      if (matchesQuery(record, query)) {
        result.records.push(record);
      }
    }
  }

  result.records.sort((left, right) => left.ts.localeCompare(right.ts));
  return result;
};
