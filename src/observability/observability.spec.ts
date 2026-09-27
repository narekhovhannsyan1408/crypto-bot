import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppLogger } from './app-logger';
import { runWithLogContext } from './log-context';
import { LogRecord, LogSink } from './log.types';
import { MemorySink, RotatingFileSink } from './rotating-file-sink';
import { compactStack, sanitize, serializeError } from './sanitize';

const record = (ts: string, msg = 'x'): LogRecord => ({
  ts,
  level: 'info',
  event: 'test.event',
  msg,
  pid: 1,
});

describe('sanitize', () => {
  it('redacts secrets by key and inside text', () => {
    const result = sanitize({
      apiKey: 'AAA',
      nested: { BINANCE_API_SECRET: 'BBB', symbol: 'BTCUSDT' },
      url: 'https://api.binance.com/order?symbol=BTCUSDT&signature=abcdef123',
    }) as {
      apiKey: string;
      nested: { BINANCE_API_SECRET: string; symbol: string };
      url: string;
    };

    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.nested.BINANCE_API_SECRET).toBe('[REDACTED]');
    expect(result.nested.symbol).toBe('BTCUSDT');
    expect(result.url).toContain('signature=[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('abcdef123');
  });

  it('truncates large data and survives cycles', () => {
    const cyclic: Record<string, unknown> = {
      items: Array.from({ length: 80 }, (_, i) => i),
    };
    cyclic.self = cyclic;

    const result = sanitize(cyclic) as { items: unknown[]; self: unknown };

    expect(result.items).toHaveLength(51);
    expect(result.self).toBe('[circular]');
    expect((sanitize('a'.repeat(5000)) as string).length).toBeLessThan(2100);
  });

  it('keeps only project frames in stack traces', () => {
    const stack = [
      'Error: boom',
      '    at AxiosError.from (/app/node_modules/axios/lib/core/AxiosError.js:7:24)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at SignalService.computeSignals (/app/src/allocator/engine/signal.service.ts:30:9)',
    ].join('\n');

    const compact = compactStack(stack);

    expect(compact).toContain('signal.service.ts');
    expect(compact).not.toContain('node_modules');
    expect(compact).toContain('2 library frames hidden');
  });

  it('keeps request details of HTTP errors', () => {
    const error = Object.assign(
      new Error('Request failed with status code 418'),
      {
        config: {
          baseURL: 'https://api.binance.com',
          url: '/api/v3/klines',
          method: 'get',
        },
        response: { status: 418, data: { code: -1003, msg: 'IP banned' } },
      },
    );

    const serialized = serializeError(error);

    expect(serialized.status).toBe(418);
    expect(serialized.url).toBe('https://api.binance.com/api/v3/klines');
    expect(serialized.responseBody).toEqual({ code: -1003, msg: 'IP banned' });
  });
});

describe('AppLogger', () => {
  it('filters by level and attaches operation context', () => {
    const sink = new MemorySink();
    const logger = new AppLogger(sink, 'info');

    runWithLogContext({ op: 'tick', opId: 'tick-1', sessionId: 's-1' }, () => {
      logger.debug('ignored', 'не попадёт');
      logger.warn('test.warn', 'предупреждение', { a: 1 }, new Error('boom'));
    });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      level: 'warn',
      event: 'test.warn',
      op: 'tick',
      opId: 'tick-1',
      sessionId: 's-1',
      data: { a: 1 },
      err: { message: 'boom' },
    });
  });

  it('never throws when the sink fails', () => {
    const failing: LogSink = {
      write: () => {
        throw new Error('disk full');
      },
    };
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(() => new AppLogger(failing).error('x', 'y')).not.toThrow();
    stderr.mockRestore();
  });
});

describe('RotatingFileSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'logs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON line per record into a daily file', () => {
    const sink = new RotatingFileSink({
      dir,
      maxBytes: 1_000_000,
      retentionDays: 14,
    });
    sink.write(record('2026-09-27T10:00:00.000Z', 'first'));
    sink.write(record('2026-09-28T00:00:01.000Z', 'next day'));

    expect(readdirSync(dir).sort()).toEqual([
      'app-2026-09-27.jsonl',
      'app-2026-09-28.jsonl',
    ]);
    const line = readFileSync(join(dir, 'app-2026-09-27.jsonl'), 'utf8').trim();
    expect((JSON.parse(line) as LogRecord).msg).toBe('first');
  });

  it('rotates by size and continues the last part after a restart', () => {
    const options = { dir, maxBytes: 300, retentionDays: 14 };
    const sink = new RotatingFileSink(options);
    for (let index = 0; index < 6; index += 1) {
      sink.write(record('2026-09-27T10:00:00.000Z', `message ${index}`));
    }
    expect(readdirSync(dir).length).toBeGreaterThan(1);
    const firstPart = readFileSync(join(dir, 'app-2026-09-27.jsonl'), 'utf8');

    // После рестарта запись продолжает последнюю часть, а не переписывает первую
    new RotatingFileSink(options).write(
      record('2026-09-27T11:00:00.000Z', 'after restart'),
    );
    const partIndex = (file: string) =>
      Number(/\.(\d+)\.jsonl$/.exec(file)?.[1] ?? 0);
    const newest = readdirSync(dir)
      .sort((a, b) => partIndex(a) - partIndex(b))
      .at(-1)!;
    expect(readFileSync(join(dir, 'app-2026-09-27.jsonl'), 'utf8')).toBe(
      firstPart,
    );
    expect(readFileSync(join(dir, newest), 'utf8')).toContain('after restart');
  });

  it('removes files older than the retention period', () => {
    writeFileSync(join(dir, 'app-2026-09-01.jsonl'), '{}\n');
    writeFileSync(join(dir, 'app-2026-09-20.jsonl'), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'не трогать');

    new RotatingFileSink({ dir, maxBytes: 1_000_000, retentionDays: 14 }).write(
      record('2026-09-27T10:00:00.000Z'),
    );

    expect(readdirSync(dir).sort()).toEqual([
      'app-2026-09-20.jsonl',
      'app-2026-09-27.jsonl',
      'notes.txt',
    ]);
  });
});
