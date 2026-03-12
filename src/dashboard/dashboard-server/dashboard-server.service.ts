import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { getBotConfig } from '../../config/bot-config';
import { BotRunnerService } from '../../bot/bot-runner/bot-runner.service';
import { LiveEvent, LiveStreamService } from '../../streaming/live-stream/live-stream.service';

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

  constructor(
    private readonly liveStream: LiveStreamService,
    private readonly botRunner: BotRunnerService,
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
    });

    this.wsServer.on('connection', (socket) => {
      this.clients.add(socket);
      this.sendJson(socket, {
        type: 'initial_state',
        payload: {
          stream: this.liveStream.getSnapshot(),
          runtime: this.botRunner.getDashboardSnapshot(),
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
          payload: this.botRunner.getDashboardSnapshot(),
        });
      }
    });

    this.snapshotInterval = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast({
          type: 'runtime_snapshot',
          payload: this.botRunner.getDashboardSnapshot(),
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
    const url = req.url || '/';

    if (url === '/api/state') {
      this.writeJson(res, {
        stream: this.liveStream.getSnapshot(),
        runtime: this.botRunner.getDashboardSnapshot(),
      });
      return;
    }

    const fileName = url === '/' || url === '/index.html' ? 'index.html' : url.replace(/^\/+/, '');

    for (const assetRoot of this.assetRoots) {
      const filePath = join(assetRoot, fileName);

      try {
        const content = await readFile(filePath);
        res.writeHead(200, {
          'Content-Type': this.getContentType(filePath),
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
          payload: this.botRunner.getDashboardSnapshot(),
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

  private getContentType(filePath: string) {
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
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

  private writeJson(res: ServerResponse, payload: unknown) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
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
