import { ConsoleLogger } from '@nestjs/common';
import { AppLogger } from './app-logger';

const contextOf = (params: unknown[]) => {
  const last = params.at(-1);
  return typeof last === 'string' ? last : 'Nest';
};

/**
 * Внутренние сообщения NestJS (ошибки контроллеров, старт модулей) печатаются
 * в консоль как раньше и дополнительно попадают в диагностический журнал.
 */
export class NestLoggerBridge extends ConsoleLogger {
  constructor(private readonly journal: AppLogger) {
    super();
  }

  log(message: unknown, ...params: unknown[]) {
    super.log(message, ...params);
    // Служебные сообщения старта (модули, маршруты) — только на уровне trace
    this.journal.trace(`nest.${contextOf(params)}`, String(message));
  }

  warn(message: unknown, ...params: unknown[]) {
    super.warn(message, ...params);
    this.journal.warn(`nest.${contextOf(params)}`, String(message));
  }

  error(message: unknown, ...params: unknown[]) {
    super.error(message, ...params);
    const stack = params.find(
      (param) => typeof param === 'string' && param.includes('\n    at '),
    );
    this.journal.error(
      `nest.${contextOf(params)}`,
      message instanceof Error ? message.message : String(message),
      message instanceof Error ? message : undefined,
      stack ? { stack } : undefined,
    );
  }
}
