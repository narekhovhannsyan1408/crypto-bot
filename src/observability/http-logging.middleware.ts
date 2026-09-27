import type { NextFunction, Request, Response } from 'express';
import { AppLogger } from './app-logger';
import { newId, runWithLogContext } from './log-context';
import { LogLevel } from './log.types';

const levelFor = (request: Request, status: number): LogLevel => {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  // Команды (запуск, остановка) важны всегда; частые опросы страницы — только в trace
  if (request.path.startsWith('/api/') && request.method !== 'GET')
    return 'info';
  return 'trace';
};

/**
 * Каждому HTTP-запросу присваивается requestId: он попадает в заголовок ответа
 * X-Request-Id и во все записи журнала, сделанные во время обработки запроса.
 */
export const createHttpLoggingMiddleware =
  (logger: AppLogger) =>
  (request: Request, response: Response, next: NextFunction) => {
    const requestId = newId('req');
    const startedAt = performance.now();
    response.setHeader('X-Request-Id', requestId);

    runWithLogContext({ requestId }, () => {
      response.on('finish', () => {
        const status = response.statusCode;
        const level = levelFor(request, status);
        if (!logger.isEnabled(level)) return;
        logger.log(
          level,
          'http.request',
          `${request.method} ${request.originalUrl} → ${status}`,
          {
            durationMs: performance.now() - startedAt,
            data: {
              method: request.method,
              path: request.originalUrl,
              status,
              ...(request.method !== 'GET'
                ? { body: request.body as unknown }
                : {}),
              // Для отклонённых запросов важно, откуда они пришли
              ...(status === 403
                ? {
                    host: request.headers.host,
                    origin: request.headers.origin,
                    contentType: request.headers['content-type'],
                  }
                : {}),
            },
          },
        );
      });
      next();
    });
  };
