import { LogLevelName } from '../config/bot-config';

export type LogLevel = LogLevelName;

export const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  status?: number;
  url?: string;
  method?: string;
  responseBody?: unknown;
  cause?: SerializedError;
};

/**
 * Одна строка в logs/app-YYYY-MM-DD.jsonl.
 * Поля контекста (requestId, op, opId, sessionId, mode) подставляются автоматически
 * из текущей операции — по ним можно восстановить всю цепочку событий.
 */
export type LogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  pid: number;
  requestId?: string;
  op?: string;
  opId?: string;
  sessionId?: string;
  mode?: string;
  durationMs?: number;
  data?: unknown;
  err?: SerializedError;
};

export interface LogSink {
  write(record: LogRecord): void;
}
