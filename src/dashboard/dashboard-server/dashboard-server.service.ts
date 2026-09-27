import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { getBotConfig } from '../../config/bot-config';
import { AllocatorRunnerService } from '../../allocator/allocator-runner.service';
import { BotRunnerService } from '../../bot/bot-runner/bot-runner.service';
import { ExecutionMode } from '../../trader/execution.types';
import { LiveEvent, LiveStreamService } from '../../streaming/live-stream/live-stream.service';
import {
  buildAllowedHosts,
  isTrustedRequest,
  resolveStaticPath,
} from './request-guard';

const MAX_BODY_BYTES = 10_000;

class BadRequestError extends Error {}
const PAGE_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/advanced': 'advanced.html',
  '/advanced.html': 'advanced.html',
};

@Injectable()
export class DashboardServerService implements OnModuleInit, OnModuleDestroy {
  private readonly config = getBotConfig();
  private readonly assetRoots = [
    join(__dirname, '..', 'public'),
    join(process.cwd(), 'src', 'dashboard', 'public'),
  ];
  private httpServer?: ReturnType<typeof createServer>;
  private wsServer?: WebSocketServer;
  private unsubscribe?: () => void;
  private snapshotInterval?: NodeJS.Timeout;
  private readonly clients = new Set<WebSocket>();
  private readonly allowedHosts = buildAllowedHosts(
    this.config.dashboardHost,
    this.config.dashboardPort,
  );

  constructor(
    private readonly liveStream: LiveStreamService,
    private readonly botRunner: BotRunnerService,
    private readonly allocatorRunner: AllocatorRunnerService,
  ) {}

  onModuleInit() {
    if (!this.config.dashboardEnabled) {
      return;
    }

    this.startServer();
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
    }

    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore close errors
      }
    }

    this.wsServer?.close();
    this.httpServer?.close();
  }

  private startServer() {
    this.httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      path: '/ws',
      // WebSocket не защищён same-origin политикой браузера — проверяем источник сами
      verifyClient: ({ req }: { req: IncomingMessage }) => this.isTrusted(req),
    });

    this.wsServer.on('connection', (socket) => {
      this.clients.add(socket);
      this.sendJson(socket, {
        type: 'initial_state',
        payload: {
          stream: this.liveStream.getSnapshot(),
          runtime: this.buildRuntimeSnapshot(),
        },
      });

      socket.on('message', (raw) => {
        void this.handleSocketMessage(socket, raw.toString());
      });

      socket.on('close', () => {
        this.clients.delete(socket);
      });
    });

    this.unsubscribe = this.liveStream.subscribe((event) => {
      this.broadcast({
        type: 'event',
        payload: event,
      });

      if (event.type === 'portfolio' || event.type === 'trade' || event.type === 'system') {
        this.broadcast({
          type: 'runtime_snapshot',
          payload: this.buildRuntimeSnapshot(),
        });
      }
    });

    this.snapshotInterval = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast({
          type: 'runtime_snapshot',
          payload: this.buildRuntimeSnapshot(),
        });
      }
    }, 30_000);

    this.httpServer.listen(this.config.dashboardPort, this.config.dashboardHost, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[DASHBOARD] Live dashboard доступен на http://${this.config.dashboardHost}:${this.config.dashboardPort}`,
      );
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    if (!this.isTrusted(req)) {
      this.writeJson(res, { success: false, message: 'Запрос отклонён' }, 403);
      return;
    }

    const url = new URL(req.url || '/', 'http://dashboard.local');
    const pathname = url.pathname;

    try {
      if (pathname.startsWith('/api/')) {
        await this.handleApiRequest(req, res, pathname, url.searchParams);
        return;
      }
    } catch (error) {
      this.writeJson(
        res,
        { success: false, message: this.describeUnknownError(error) },
        error instanceof BadRequestError ? 400 : 500,
      );
      return;
    }

    const fileName = PAGE_ROUTES[pathname] ?? pathname;
    for (const assetRoot of this.assetRoots) {
      const filePath = resolveStaticPath(assetRoot, fileName);
      if (!filePath) {
        continue;
      }

      try {
        const content = await readFile(filePath);
        res.writeHead(200, {
          'Content-Type': this.getContentType(filePath),
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      } catch {
        // try next asset root
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Файл не найден');
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ) {
    if (req.method === 'GET' && pathname === '/api/state') {
      this.writeJson(res, {
        stream: this.liveStream.getSnapshot(),
        runtime: this.buildRuntimeSnapshot(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/app/state') {
      await this.allocatorRunner.refreshPricesIfStale();
      this.writeJson(res, this.allocatorRunner.getAppState());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/app/balance') {
      const mode = this.parseMode(query.get('mode'));
      if (!mode) {
        this.writeJson(res, { success: false, message: 'Неизвестный режим' }, 400);
        return;
      }
      this.writeJson(res, await this.allocatorRunner.getAvailableBalance(mode));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/app/start') {
      const body = await this.readJsonBody(req);
      const mode = this.parseMode(body.mode);
      if (!mode) {
        this.writeJson(res, { success: false, message: 'Неизвестный режим' }, 400);
        return;
      }
      const result = await this.allocatorRunner.start({
        mode,
        capitalUsdt: Number(body.capitalUsdt),
        autoStopLossPct: Number(body.autoStopLossPct ?? 0),
      });
      this.writeJson(res, { ...result, state: this.allocatorRunner.getAppState() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/app/stop') {
      await this.readJsonBody(req);
      const result = await this.allocatorRunner.stop();
      this.writeJson(res, { ...result, state: this.allocatorRunner.getAppState() });
      return;
    }

    this.writeJson(res, { success: false, message: 'Не найдено' }, 404);
  }

  private isTrusted(req: IncomingMessage) {
    return isTrustedRequest(
      { host: req.headers.host, origin: req.headers.origin },
      this.config.dashboardHost,
      this.allowedHosts,
    );
  }

  private parseMode(value: unknown): ExecutionMode | null {
    return value === 'paper' || value === 'live_testnet' || value === 'live_real'
      ? value
      : null;
  }

  /** Только application/json: такой запрос со стороннего сайта требует CORS preflight. */
  private readJsonBody(req: IncomingMessage) {
    return new Promise<Record<string, unknown>>((resolveBody, reject) => {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        reject(new BadRequestError('Ожидается Content-Type: application/json'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new BadRequestError('Слишком большой запрос'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsed: unknown = text ? JSON.parse(text) : {};
          resolveBody(
            parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
          );
        } catch {
          reject(new BadRequestError('Некорректный JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private async handleSocketMessage(socket: WebSocket, rawMessage: string) {
    try {
      const message = JSON.parse(rawMessage) as {
        type?: string;
        reason?: string;
        symbol?: string;
        strategyId?: string;
        mode?: 'paper' | 'live_testnet' | 'live_real';
        marketType?: 'spot' | 'futures' | 'hybrid';
        confirmationPhrase?: string;
      };

      if (message.type === 'emergency_close_all') {
        const result = await this.botRunner.emergencyCloseAllPositions(
          message.reason || 'Экстренное закрытие через live dashboard',
        );

        this.sendJson(socket, {
          type: 'command_result',
          payload: {
            статус: 'успешно',
            закрытоПозиций: result.closedPositions,
            snapshot: result.snapshot,
          },
        });
        return;
      }

      if (message.type === 'liquidate_spot_assets') {
        if (message.confirmationPhrase !== 'LIQUIDATE SPOT') {
          this.sendJson(socket, {
            type: 'command_result',
            payload: {
              статус: 'ошибка',
              сообщение:
                'Для ликвидации всех внешних spot-активов нужно подтверждение фразой LIQUIDATE SPOT',
            },
          });
          return;
        }

        const result = await this.botRunner.liquidateAllSpotAssets(
          message.reason || 'Ликвидация всех внешних spot-активов через live dashboard',
        );

        this.sendJson(socket, {
          type: 'command_result',
          payload: {
            статус: result.success ? 'успешно' : 'не выполнено',
            сообщение: result.message,
            проданоАктивов: result.soldAssets.length,
            проданныеАктивы: result.soldAssets,
            пропущеноАктивов: result.skippedAssets.length,
            пропущенныеАктивы: result.skippedAssets,
            execution: result.status,
            snapshot: result.snapshot,
          },
        });
        return;
      }

      if (message.type === 'request_snapshot') {
        this.sendJson(socket, {
          type: 'runtime_snapshot',
          payload: this.buildRuntimeSnapshot(),
        });
        return;
      }

      if (message.type === 'close_position') {
        if (!message.symbol || !message.strategyId) {
          this.sendJson(socket, {
            type: 'command_result',
            payload: {
              статус: 'ошибка',
              сообщение: 'Для закрытия позиции нужны symbol и strategyId',
            },
          });
          return;
        }

        const result = await this.botRunner.closePosition(
          message.symbol,
          message.strategyId,
          message.reason || 'Ручное закрытие позиции через live dashboard',
        );

        this.sendJson(socket, {
          type: 'command_result',
          payload: {
            статус: result.closed ? 'успешно' : 'не выполнено',
            сообщение: result.reason,
            symbol: message.symbol,
            strategyId: message.strategyId,
            snapshot: result.snapshot,
          },
        });
        return;
      }

      if (message.type === 'set_execution_mode') {
        if (!message.mode || !message.marketType) {
          this.sendJson(socket, {
            type: 'command_result',
            payload: {
              статус: 'ошибка',
              сообщение: 'Для переключения режима нужны mode и marketType',
            },
          });
          return;
        }

        const result = await this.botRunner.setExecutionMode(
          message.mode,
          message.marketType,
          message.confirmationPhrase,
        );

        this.sendJson(socket, {
          type: 'command_result',
          payload: {
            статус: result.success ? 'успешно' : 'не выполнено',
            сообщение: result.message,
            execution: result.status,
            snapshot: result.snapshot,
          },
        });
        return;
      }

      if (
        message.type === 'allocator_rebalance_now' ||
        message.type === 'allocator_pause_liquidate'
      ) {
        if (
          message.type === 'allocator_pause_liquidate' &&
          message.confirmationPhrase !== 'SELL ALL'
        ) {
          this.sendJson(socket, {
            type: 'command_result',
            payload: {
              статус: 'ошибка',
              сообщение: 'Для остановки бота нужно подтверждение фразой SELL ALL',
            },
          });
          return;
        }

        const result =
          message.type === 'allocator_rebalance_now'
            ? await this.allocatorRunner.rebalanceNow()
            : await this.allocatorRunner.stop('Остановлен из расширенного дашборда');

        this.sendJson(socket, {
          type: 'command_result',
          payload: {
            статус: result.success ? 'успешно' : 'не выполнено',
            сообщение: result.message,
            snapshot: this.buildRuntimeSnapshot(),
          },
        });
        return;
      }

      if (message.type === 'refresh_execution_status') {
        const result = await this.botRunner.refreshExecutionStatus();
        this.sendJson(socket, {
          type: 'command_result',
          payload: {
            статус: 'успешно',
            execution: result.status,
            snapshot: result.snapshot,
          },
        });
      }
    } catch (error) {
      this.sendJson(socket, {
        type: 'command_result',
        payload: {
          статус: 'ошибка',
          сообщение: this.describeUnknownError(error),
        },
      });
    }
  }

  private buildRuntimeSnapshot() {
    const strategyMode = this.config.strategyMode;
    return {
      ...this.botRunner.getDashboardSnapshot(),
      strategyMode,
      allocator:
        strategyMode === 'trend_allocator'
          ? this.allocatorRunner.getDashboardSnapshot()
          : null,
    };
  }

  private getContentType(filePath: string) {
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
    if (filePath.endsWith('.svg')) return 'image/svg+xml';
    return 'text/html; charset=utf-8';
  }

  private broadcast(message: unknown) {
    for (const client of this.clients) {
      this.sendJson(client, message);
    }
  }

  private sendJson(socket: WebSocket, payload: unknown) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(payload));
  }

  private writeJson(res: ServerResponse, payload: unknown, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  private describeUnknownError(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }

    if (typeof error === 'object' && error !== null) {
      const candidate = error as Record<string, unknown>;
      const directMessage = [
        candidate.message,
        candidate.msg,
        candidate.error,
        candidate.body,
      ].find((value) => typeof value === 'string' && value.trim());

      if (typeof directMessage === 'string' && directMessage.trim()) {
        return directMessage.trim();
      }
    }

    return 'Неизвестная ошибка';
  }
}
