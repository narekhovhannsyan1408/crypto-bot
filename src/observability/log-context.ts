import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export type LogContext = {
  requestId?: string;
  op?: string;
  opId?: string;
  sessionId?: string;
  mode?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

export const getLogContext = (): LogContext => storage.getStore() ?? {};

/**
 * Выполняет fn с дополнительным контекстом логов. Все записи внутри fn (включая
 * асинхронные продолжения) автоматически получают эти поля.
 */
export const runWithLogContext = <T>(context: LogContext, fn: () => T): T =>
  storage.run({ ...getLogContext(), ...context }, fn);
