import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogLevel, LogRecord } from '../observability/log.types';
import { analyzeLogs, buildHints, findGaps } from './log-analysis';
import { formatRecord } from './log-format';
import { matchesEventPattern, parseTimeArg, readLogs } from './log-reader';

const DAY_MS = 86_400_000;

const rec = (
  ts: string,
  event: string,
  level: LogLevel = 'info',
  extra: Partial<LogRecord> = {},
): LogRecord => ({ ts, event, level, msg: event, pid: 1, ...extra });

describe('log reader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diag-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses relative and absolute times', () => {
    const now = Date.UTC(2026, 8, 27, 12);
    expect(parseTimeArg('6h', now)).toBe(now - 6 * 3_600_000);
    expect(parseTimeArg('2d', now)).toBe(now - 2 * DAY_MS);
    expect(parseTimeArg('2026-09-27 10:00')).toBe(
      Date.parse('2026-09-27T10:00'),
    );
    expect(() => parseTimeArg('yesterday')).toThrow();
  });

  it('matches event patterns with wildcards', () => {
    expect(
      matchesEventPattern('allocator.rebalance.failed', 'allocator.*'),
    ).toBe(true);
    expect(matchesEventPattern('binance.http.failed', '*.failed')).toBe(true);
    expect(
      matchesEventPattern('allocator.order.filled', 'allocator.rebalance.*'),
    ).toBe(false);
  });

  it('reads records across files, in order, with filters', async () => {
    const lines = (records: LogRecord[]) =>
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    writeFileSync(
      join(dir, 'app-2026-09-26.jsonl'),
      lines([
        rec('2026-09-26T23:00:00.000Z', 'allocator.order.filled', 'info', {
          opId: 'tick-1',
        }),
      ]),
    );
    writeFileSync(
      join(dir, 'app-2026-09-27.jsonl'),
      `${lines([
        rec('2026-09-27T01:00:00.000Z', 'binance.http.failed', 'warn'),
        rec('2026-09-27T02:00:00.000Z', 'process.heartbeat', 'debug'),
      ])}not json\n`,
    );

    const all = await readLogs({ dir });
    const warnings = await readLogs({ dir, minLevel: 'warn' });
    const byOp = await readLogs({ dir, opId: 'tick-1' });
    const byEvent = await readLogs({
      dir,
      events: ['*.failed'],
      since: Date.parse('2026-09-27'),
    });

    expect(all.records.map((r) => r.event)).toEqual([
      'allocator.order.filled',
      'binance.http.failed',
      'process.heartbeat',
    ]);
    expect(all.malformedLines).toBe(1);
    expect(warnings.records).toHaveLength(1);
    expect(byOp.records).toHaveLength(1);
    expect(byEvent.records.map((r) => r.event)).toEqual([
      'binance.http.failed',
    ]);
  });
});

describe('log analysis', () => {
  it('finds downtime and marks gaps over the daily decision time', () => {
    const gaps = findGaps([
      rec('2026-09-26T23:50:00.000Z', 'process.heartbeat'),
      rec('2026-09-26T23:55:00.000Z', 'process.heartbeat'),
      rec('2026-09-27T07:10:00.000Z', 'process.started'),
    ]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ minutes: 435, crossesUtcMidnight: true });
  });

  it('groups identical errors that differ only by numbers', () => {
    const analysis = analyzeLogs([
      rec('2026-09-27T01:00:00.000Z', 'allocator.order.failed', 'error', {
        msg: 'Order BUY BTCUSDT not executed',
        err: { name: 'InsufficientFunds', message: 'balance 12.5 < 500' },
      }),
      rec('2026-09-27T01:05:00.000Z', 'allocator.order.failed', 'error', {
        msg: 'Order BUY BTCUSDT not executed',
        err: { name: 'InsufficientFunds', message: 'balance 3.1 < 500' },
      }),
    ]);

    expect(analysis.errorGroups).toHaveLength(1);
    expect(analysis.errorGroups[0].count).toBe(2);
  });

  it('hints at a missed daily decision and a dead process', () => {
    const now = Date.UTC(2026, 8, 27, 12);
    const analysis = analyzeLogs([
      rec('2026-09-26T20:00:00.000Z', 'process.started', 'info', {
        data: { gitCommit: 'abc123', gitDirty: true },
      }),
      rec('2026-09-26T21:00:00.000Z', 'broker.binance.order_failed', 'error'),
    ]);

    const hints = buildHints(
      analysis,
      {
        status: 'running',
        lastRebalanceDay: Date.UTC(2026, 8, 25),
        lastEquityPointTs: null,
      },
      now,
    ).join('\n');

    expect(hints).toContain('No decision was made for 2026-09-26');
    expect(hints).toContain('the process does not seem to be running now');
    expect(hints).toContain('Binance rejected orders');
    expect(hints).toContain('uncommitted changes');
  });

  it('formats a record compactly with correlation ids', () => {
    const text = formatRecord(
      rec('2026-09-27T01:00:00.000Z', 'allocator.order.failed', 'error', {
        opId: 'tick-1',
        sessionId: 's-1',
        err: {
          name: 'Error',
          message: 'boom',
          stack: 'Error: boom\n    at a\n    at b',
        },
      }),
      false,
    );

    expect(text).toContain(
      'ERROR allocator.order.failed [op=tick-1 session=s-1]',
    );
    expect(text).toContain('err: Error: boom');
  });
});
