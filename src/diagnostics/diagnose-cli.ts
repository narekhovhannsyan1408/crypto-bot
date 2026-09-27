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
        'Использование: npm run diagnose -- [--since 48h|7d|2026-09-27] [--dir logs]',
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
    ? '_нет_'
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
              : `\n  данные: \`${JSON.stringify(sample.data).slice(0, 300)}\``;
          return (
            `- **${group.count}×** \`${group.event}\` — ${sample.msg}` +
            (sample.err ? ` → ${sample.err.name}: ${sample.err.message}` : '') +
            data +
            `\n  первый ${group.firstTs}, последний ${group.lastTs}${ids ? `, пример: ${ids}` : ''}` +
            stack
          );
        })
        .join('\n');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = getBotConfig();
  const now = Date.now();
  const out: string[] = [];

  out.push('# Диагностика crypto-bot');
  out.push(
    `Сформировано: ${iso(now)} · период журнала: с ${iso(options.since)} · время везде UTC`,
  );

  out.push(section('Сборка и настройки'));
  out.push('```json');
  out.push(
    JSON.stringify(
      { build: getBuildInfo(), config: describeConfig(config) },
      null,
      2,
    ),
  );
  out.push('```');

  out.push(section('Состояние бота (файл состояния)'));
  const state = readState(config.allocator.stateFile);
  let stateSummary: StateSummary | null = null;
  if (!state) {
    out.push(
      `Файл ${config.allocator.stateFile} не найден — бот ещё ни разу не запускался в этом режиме.`,
    );
  } else if (state.version !== 2) {
    out.push(
      `Файл состояния не читается или старого формата (version=${state.version}).`,
    );
  } else if (!state.current) {
    out.push('Сессий ещё не было.');
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
        `- сессия \`${session.id}\`, режим **${session.mode}**, статус **${session.status}**`,
        `- запущена ${iso(session.startedAt)}${session.stoppedAt ? `, остановлена ${iso(session.stoppedAt)}: ${session.stopReason}` : ''}`,
        `- стартовый капитал ${session.initialCapital} USDT, автозащита ${session.autoStopLossPct > 0 ? `−${session.autoStopLossPct * 100}%` : 'выключена'}`,
        `- сейчас в учёте: USDT ${session.cash.toFixed(2)}, монеты ${JSON.stringify(session.quantities)}, комиссии ${session.feesPaid.toFixed(2)}`,
        `- последнее ежедневное решение: ${day(session.lastRebalanceDay)} (ожидается ${day(expectedDay)})`,
        `- последняя точка капитала: ${iso(lastPoint?.timestamp)} = ${lastPoint?.equity.toFixed(2) ?? '—'} USDT (всего точек ${session.equityHistory.length})`,
      ].join('\n'),
    );
    out.push('\nПоследние события ленты (новые сверху):');
    for (const entry of session.activity.slice(0, 10)) {
      out.push(
        `- ${iso(entry.timestamp)} [${entry.kind}] ${entry.title}${entry.details ? ` — ${entry.details}` : ''}`,
      );
    }
    if (state.history?.length) {
      out.push(
        `\nПрошлых сессий: ${state.history.length}. Последняя: ${JSON.stringify(state.history[0])}`,
      );
    }
  }

  const { records, files, malformedLines } = await readLogs({
    dir: options.dir,
    since: options.since,
    minLevel: 'debug',
  });
  const analysis = analyzeLogs(records);

  out.push(section('Подсказки'));
  const hints = buildHints(analysis, stateSummary, now);
  out.push(
    hints.length
      ? hints.map((hint) => `- ${hint}`).join('\n')
      : '- Явных проблем не найдено.',
  );

  out.push(section('Сводка журнала'));
  out.push(
    [
      `- папка: ${options.dir}, файлов: ${files.length}, записей: ${analysis.total}${malformedLines ? `, битых строк: ${malformedLines}` : ''}`,
      `- с ${analysis.firstTs ?? '—'} по ${analysis.lastTs ?? '—'}`,
      `- по уровням: ${JSON.stringify(analysis.byLevel)}`,
      `- частые события: ${analysis.topEvents.map(([event, count]) => `${event} ${count}`).join(', ') || '—'}`,
    ].join('\n'),
  );

  out.push(section('Ошибки (сгруппированы)'));
  out.push(renderGroups(analysis.errorGroups, 15));

  out.push(section('Предупреждения (сгруппированы)'));
  out.push(renderGroups(analysis.warningGroups, 15));

  out.push(section('Простои процесса (нет записей дольше 15 минут)'));
  out.push(
    analysis.gaps.length
      ? analysis.gaps
          .map(
            (gap) =>
              `- ${gap.from} → ${gap.to} (${gap.minutes} мин)${gap.crossesUtcMidnight ? ' — **пропущено ежедневное решение в 00:00 UTC**' : ''}`,
          )
          .join('\n')
      : '_нет_',
  );

  out.push(section('Запуски процесса'));
  out.push(
    analysis.processStarts.length
      ? analysis.processStarts
          .map((record) => {
            const data = record.data as {
              gitCommit?: string;
              gitDirty?: boolean;
              version?: string;
            };
            return `- ${record.ts} pid=${record.pid} commit=${data?.gitCommit ?? '?'}${data?.gitDirty ? ' (есть незакоммиченные изменения)' : ''} version=${data?.version ?? '?'}`;
          })
          .join('\n')
      : '_нет_',
  );

  out.push(section('Хронология ключевых событий (последние 40)'));
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

  out.push(section('Как копать дальше'));
  out.push(
    [
      '- все события одной операции: `npm run logs -- --op <opId> --full`',
      '- все, что вызвал HTTP-запрос: `npm run logs -- --request <requestId> --full`',
      '- решения бота за неделю: `npm run logs -- --since 7d --event "allocator.rebalance.*,allocator.order.*"`',
      '- только проблемы: `npm run logs -- --since 7d --level warn`',
    ].join('\n'),
  );

  console.log(out.join('\n'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
