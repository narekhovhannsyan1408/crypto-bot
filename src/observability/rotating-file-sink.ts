import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { LogRecord, LogSink } from './log.types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LOG_FILE_PATTERN = /^app-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

export type RotatingFileSinkOptions = {
  dir: string;
  maxBytes: number;
  retentionDays: number;
};

/**
 * Пишет записи в logs/app-YYYY-MM-DD.jsonl (день по UTC). Если файл превысил
 * maxBytes, продолжает в app-YYYY-MM-DD.1.jsonl и т.д. Файлы старше retentionDays удаляет.
 *
 * Запись синхронная: при падении процесса последние строки не теряются —
 * именно они нужнее всего для разбора.
 */
export class RotatingFileSink implements LogSink {
  private day = '';
  private index = 0;
  private size = 0;

  constructor(private readonly options: RotatingFileSinkOptions) {
    mkdirSync(options.dir, { recursive: true });
  }

  write(record: LogRecord) {
    const line = `${JSON.stringify(record)}\n`;
    const day = record.ts.slice(0, 10);
    if (day !== this.day) {
      this.openDay(day);
    }

    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.options.maxBytes) {
      this.index += 1;
      this.size = 0;
    }
    appendFileSync(this.currentPath(), line);
    this.size += bytes;
  }

  currentPath() {
    const suffix = this.index === 0 ? '' : `.${this.index}`;
    return join(this.options.dir, `app-${this.day}${suffix}.jsonl`);
  }

  private openDay(day: string) {
    this.day = day;
    this.index = 0;
    this.size = 0;

    // После рестарта продолжаем последний файл дня, а не начинаем с нуля
    for (const file of readdirSync(this.options.dir)) {
      const match = LOG_FILE_PATTERN.exec(file);
      if (!match || match[1] !== day) continue;
      const index = Number(match[2] ?? 0);
      if (index >= this.index) {
        this.index = index;
        this.size = statSync(join(this.options.dir, file)).size;
      }
    }
    this.removeExpired(day);
  }

  private removeExpired(today: string) {
    const cutoff =
      Date.parse(`${today}T00:00:00Z`) - this.options.retentionDays * DAY_MS;
    for (const file of readdirSync(this.options.dir)) {
      const match = LOG_FILE_PATTERN.exec(file);
      if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) {
        unlinkSync(join(this.options.dir, file));
      }
    }
  }
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord) {
    this.records.push(record);
  }

  events() {
    return this.records.map((record) => record.event);
  }
}
