import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { getBotConfig } from '../../config/bot-config';
import { createTrustChecker } from './request-guard';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Глобальная защита API дашборда:
 * - запрос должен прийти со страницы самого дашборда (Host/Origin);
 * - изменяющие запросы — только application/json: такой запрос со стороннего
 *   сайта браузер не отправит без CORS preflight, который сервер не разрешает.
 */
@Injectable()
export class TrustedRequestGuard implements CanActivate {
  private readonly isTrusted = createTrustChecker(
    getBotConfig().dashboardHost,
    getBotConfig().dashboardPort,
  );

  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const trusted = this.isTrusted({
      host: request.headers.host,
      origin: request.headers.origin,
    });
    const jsonBody =
      request.headers['content-type']?.startsWith('application/json');
    if (!trusted || (!SAFE_METHODS.has(request.method) && !jsonBody)) {
      throw new ForbiddenException('Запрос отклонён');
    }
    return true;
  }
}
