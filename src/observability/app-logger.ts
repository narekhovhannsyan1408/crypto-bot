import { getBotConfig } from '../config/bot-config';
import { getLogContext } from './log-context';
import { LEVEL_WEIGHT, LogLevel, LogRecord, LogSink } from './log.types';
import { RotatingFileSink } from './rotating-file-sink';
import { sanitize, serializeError } from './sanitize';

export type LogFields = {
  data?: unknown;
  err?: unknown;
  durationMs?: number;
};

/**
 * Диагностический журнал: структурированные события в JSON Lines.
 *
 * event — стабильное машиночитаемое имя (например, allocator.order.filled),
 * msg — короткое описание на английском. Контекст текущей операции добавляется сам.
 * Логгер никогда не бросает исключений: сбой записи не должен ронять бота.
 */
export class AppLogger {
  private writeFailed = false;

  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel = 'debug',
  ) {}

  isEnabled(level: LogLevel) {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.minLevel];
  }

  log(level: LogLevel, event: string, msg: string, fields: LogFields = {}) {
    if (!this.isEnabled(level)) {
      return;
    }

    try {
      const context = getLogContext();
      const record: LogRecord = {
        ts: new Date().toISOString(),
        level,
        event,
        msg,
        pid: process.pid,
        ...context,
      };
      if (fields.durationMs !== undefined) {
        record.durationMs = Math.round(fields.durationMs);
      }
      if (fields.data !== undefined) {
        record.data = sanitize(fields.data);
      }
      if (fields.err !== undefined && fields.err !== null) {
        record.err = serializeError(fields.err);
      }
      this.sink.write(record);
    } catch (error) {
      if (!this.writeFailed) {
        this.writeFailed = true;
        process.stderr.write(
          `[LOGS] Failed to write the log: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  trace(event: string, msg: string, data?: unknown) {
    this.log('trace', event, msg, { data });
  }

  debug(event: string, msg: string, data?: unknown) {
    this.log('debug', event, msg, { data });
  }

  info(event: string, msg: string, data?: unknown) {
    this.log('info', event, msg, { data });
  }

  warn(event: string, msg: string, data?: unknown, err?: unknown) {
    this.log('warn', event, msg, { data, err });
  }

  error(event: string, msg: string, err?: unknown, data?: unknown) {
    this.log('error', event, msg, { data, err });
  }

  fatal(event: string, msg: string, err?: unknown, data?: unknown) {
    this.log('fatal', event, msg, { data, err });
  }

  /** Замеряет длительность асинхронной операции и пишет событие с durationMs. */
  async timed<T>(
    event: string,
    msg: string,
    task: () => Promise<T>,
    level: LogLevel = 'debug',
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await task();
      this.log(level, event, msg, {
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.log('warn', `${event}_failed`, `${msg}: failed`, {
        durationMs: performance.now() - startedAt,
        err: error,
      });
      throw error;
    }
  }
}

let sharedLogger: AppLogger | null = null;

/** Общий логгер процесса (один файл для Nest, CLI, обработчиков падений). */
export const getAppLogger = () => {
  if (!sharedLogger) {
    const { logging } = getBotConfig();
    sharedLogger = new AppLogger(
      new RotatingFileSink({
        dir: logging.dir,
        maxBytes: Math.max(logging.maxFileMb, 1) * 1024 * 1024,
        retentionDays: Math.max(logging.retentionDays, 1),
      }),
      logging.level,
    );
  }
  return sharedLogger;
};

export const setAppLoggerForTests = (logger: AppLogger | null) => {
  sharedLogger = logger;
};
