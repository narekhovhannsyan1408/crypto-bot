/**
 * Сводный отчёт для расследования проблем: сборка, настройки, состояние бота,
 * ошибки и предупреждения из журнала, простои процесса и подсказки.
 *
 *   npm run diagnose                 # за последние 48 часов
 *   npm run diagnose -- --since 7d
 *
 * Отчёт — markdown, его можно целиком вставить в разговор с разработчиком.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getBotConfig } from '../config/bot-config';
import { getBuildInfo } from '../observability/build-info';
import { LogRecord } from '../observability/log.types';
import { describeConfig } from '../observability/process-monitor';
import {
  analyzeLogs,
  buildHints,
  RecordGroup,
  StateSummary,
} from './log-analysis';
import { formatRecord } from './log-format';
import { parseTimeArg, readLogs } from './log-reader';

type StoredSession = {
  id: string;
  mode: string;
  status: 'running' | 'stopped';
  startedAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  initialCapital: number;
  autoStopLossPct: number;
  cash: number;
  quantities: Record<string, number>;
  feesPaid: number;
  lastRebalanceDay: number | null;
  equityHistory: Array<{ timestamp: number; equity: number }>;
  activity: Array<{
    timestamp: number;
    kind: string;
    title: string;
    details?: string;
  }>;
};

type StoredState = {
  version?: number;
  current?: StoredSession | null;
  history?: Array<{
    id: string;
    mode: string;
    startedAt: number;
    stoppedAt: number;
    initialCapital: number;
    finalEquity: number;
    stopReason: string;
  }>;
};

const DAY_MS = 86_400_000;
const iso = (ts: number | null | undefined) =>
  ts ? new Date(ts).toISOString().replace('.000Z', 'Z') : '—';
const day = (ts: number | null | undefined) =>
  ts ? new Date(ts).toISOString().slice(0, 10) : '—';

const parseArgs = (argv: string[]) => {
  const options = {
    since: parseTimeArg('48h'),
    dir: getBotConfig().logging.dir,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--since' && value) {
      options.since = parseTimeArg(value);
      index += 1;
    } else if (flag === '--dir' && value) {
      options.dir = value;
      index += 1;
    } else {
      throw new Error(
        'Usage: npm run diagnose -- [--since 48h|7d|2026-09-27] [--dir logs]',
      );
    }
  }
  return options;
};

const readState = (path: string): StoredState | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredState;
  } catch {
    return { version: -1 };
  }
};

const section = (title: string) => `\n## ${title}\n`;

const renderGroups = (groups: RecordGroup[], limit: number) =>
  groups.length === 0
    ? '_none_'
    : groups
        .slice(0, limit)
        .map((group) => {
          const sample = group.sample;
          const ids = [
            sample.opId && `op=${sample.opId}`,
            sample.requestId && `req=${sample.requestId}`,
          ]
            .filter(Boolean)
            .join(' ');
          const stack = sample.err?.stack
            ? `\n  \`\`\`\n  ${sample.err.stack.split('\n').slice(0, 6).join('\n  ')}\n  \`\`\``
            : '';
          const data =
            sample.data === undefined
              ? ''
              : `\n  data: \`${JSON.stringify(sample.data).slice(0, 300)}\``;
          return (
            `- **${group.count}×** \`${group.event}\` — ${sample.msg}` +
            (sample.err ? ` → ${sample.err.name}: ${sample.err.message}` : '') +
            data +
            `\n  first ${group.firstTs}, last ${group.lastTs}${ids ? `, example: ${ids}` : ''}` +
            stack
          );
        })
        .join('\n');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = getBotConfig();
  const now = Date.now();
  const out: string[] = [];

  out.push('# crypto-bot diagnostics');
  out.push(
    `Generated: ${iso(now)} · journal since ${iso(options.since)} · all times in UTC`,
  );

  out.push(section('Build and settings'));
  out.push('```json');
  out.push(
    JSON.stringify(
      { build: getBuildInfo(), config: describeConfig(config) },
      null,
      2,
    ),
  );
  out.push('```');

  out.push(section('Bot state (state file)'));
  const state = readState(config.allocator.stateFile);
  let stateSummary: StateSummary | null = null;
  if (!state) {
    out.push(
      `${config.allocator.stateFile} not found — the bot has never run in this mode.`,
    );
  } else if (state.version !== 2) {
    out.push(
      `The state file is unreadable or has an old format (version=${state.version}).`,
    );
  } else if (!state.current) {
    out.push('No sessions yet.');
  } else {
    const session = state.current;
    const lastPoint = session.equityHistory.at(-1);
    const expectedDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    stateSummary = {
      status: session.status,
      lastRebalanceDay: session.lastRebalanceDay,
      lastEquityPointTs: lastPoint?.timestamp ?? null,
    };
    out.push(
      [
        `- session \`${session.id}\`, mode **${session.mode}**, status **${session.status}**`,
        `- started ${iso(session.startedAt)}${session.stoppedAt ? `, stopped ${iso(session.stoppedAt)}: ${session.stopReason}` : ''}`,
        `- starting capital ${session.initialCapital} USDT, auto-protection ${session.autoStopLossPct > 0 ? `−${session.autoStopLossPct * 100}%` : 'off'}`,
        `- in the records now: cash ${session.cash.toFixed(2)}, coins ${JSON.stringify(session.quantities)}, fees ${session.feesPaid.toFixed(2)}`,
        `- last daily decision: ${day(session.lastRebalanceDay)} (expected ${day(expectedDay)})`,
        `- last equity point: ${iso(lastPoint?.timestamp)} = ${lastPoint?.equity.toFixed(2) ?? '—'} (${session.equityHistory.length} points in total)`,
      ].join('\n'),
    );
    out.push('\nLatest feed entries (newest first):');
    for (const entry of session.activity.slice(0, 10)) {
      out.push(
        `- ${iso(entry.timestamp)} [${entry.kind}] ${entry.title}${entry.details ? ` — ${entry.details}` : ''}`,
      );
    }
    if (state.history?.length) {
      out.push(
        `\nPast sessions: ${state.history.length}. The last one: ${JSON.stringify(state.history[0])}`,
      );
    }
  }

  const { records, files, malformedLines } = await readLogs({
    dir: options.dir,
    since: options.since,
    minLevel: 'debug',
  });
  const analysis = analyzeLogs(records);

  out.push(section('Hints'));
  const hints = buildHints(analysis, stateSummary, now);
  out.push(
    hints.length
      ? hints.map((hint) => `- ${hint}`).join('\n')
      : '- No obvious problems found.',
  );

  out.push(section('Journal summary'));
  out.push(
    [
      `- folder: ${options.dir}, files: ${files.length}, records: ${analysis.total}${malformedLines ? `, malformed lines: ${malformedLines}` : ''}`,
      `- from ${analysis.firstTs ?? '—'} to ${analysis.lastTs ?? '—'}`,
      `- by level: ${JSON.stringify(analysis.byLevel)}`,
      `- frequent events: ${analysis.topEvents.map(([event, count]) => `${event} ${count}`).join(', ') || '—'}`,
    ].join('\n'),
  );

  out.push(section('Errors (grouped)'));
  out.push(renderGroups(analysis.errorGroups, 15));

  out.push(section('Warnings (grouped)'));
  out.push(renderGroups(analysis.warningGroups, 15));

  out.push(section('Process downtime (no records for more than 15 minutes)'));
  out.push(
    analysis.gaps.length
      ? analysis.gaps
          .map(
            (gap) =>
              `- ${gap.from} → ${gap.to} (${gap.minutes} min)${gap.crossesUtcMidnight ? ' — **the 00:00 UTC daily decision was missed**' : ''}`,
          )
          .join('\n')
      : '_none_',
  );

  out.push(section('Process starts'));
  out.push(
    analysis.processStarts.length
      ? analysis.processStarts
          .map((record) => {
            const data = record.data as {
              gitCommit?: string;
              gitDirty?: boolean;
              version?: string;
            };
            return `- ${record.ts} pid=${record.pid} commit=${data?.gitCommit ?? '?'}${data?.gitDirty ? ' (uncommitted changes)' : ''} version=${data?.version ?? '?'}`;
          })
          .join('\n')
      : '_none_',
  );

  out.push(section('Timeline of key events (last 40)'));
  out.push('```');
  out.push(
    analysis.decisions
      .slice(-40)
      .map((record: LogRecord) =>
        formatRecord(record, false).split('\n').slice(0, 2).join(' | '),
      )
      .join('\n') || '—',
  );
  out.push('```');

  out.push(section('How to dig deeper'));
  out.push(
    [
      '- everything in one operation: `npm run logs -- --op <opId> --full`',
      '- everything an HTTP request caused: `npm run logs -- --request <requestId> --full`',
      '- the bot\'s decisions for a week: `npm run logs -- --since 7d --event "allocator.rebalance.*,allocator.order.*"`',
      '- problems only: `npm run logs -- --since 7d --level warn`',
    ].join('\n'),
  );

  console.log(out.join('\n'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
