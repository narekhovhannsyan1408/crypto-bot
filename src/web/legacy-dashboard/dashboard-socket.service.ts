import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { AllocatorEngine } from '../../allocator/engine/allocator-engine.service';
import { getBotConfig } from '../../config/bot-config';
import { Msg, msg, ru } from '../../i18n/messages';
import { LiveStreamService } from '../../streaming/live-stream/live-stream.service';
import { createTrustChecker } from '../security/request-guard';
import { LegacyRuntimeService } from './legacy-runtime.service';

type SocketMessage = {
  type?: string;
  reason?: string;
  symbol?: string;
  strategyId?: string;
  mode?: 'paper' | 'live_testnet' | 'live_real';
  marketType?: 'spot' | 'futures' | 'hybrid';
  confirmationPhrase?: string;
};

type CommandPayload = Record<string, unknown>;

const SNAPSHOT_BROADCAST_MS = 30_000;

/** WebSocket расширенного дашборда: живые логи, снимки состояния и ручные команды. */
@Injectable()
export class DashboardSocketService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly config = getBotConfig();
  private readonly isTrusted = createTrustChecker(
    this.config.dashboardHost,
    this.config.dashboardPort,
  );
  private readonly clients = new Set<WebSocket>();
  private wsServer?: WebSocketServer;
  private unsubscribe?: () => void;
  private snapshotTimer?: NodeJS.Timeout;

  private readonly commands: Record<
    string,
    (message: SocketMessage) => Promise<CommandPayload>
  > = {
    allocator_rebalance_now: async () =>
      this.toPayload(await this.allocator.rebalanceNow()),
    allocator_pause_liquidate: async (message) => {
      if (message.confirmationPhrase !== 'SELL ALL') {
        return this.error(
          'Для остановки бота нужно подтверждение фразой SELL ALL',
        );
      }
      return this.toPayload(
        await this.allocator.stop(msg('stop.reason.advanced')),
      );
    },
    emergency_close_all: async (message) => {
      const result = await this.intraday().emergencyCloseAllPositions(
        message.reason || 'Экстренное закрытие через live dashboard',
      );
      return { статус: 'успешно', закрытоПозиций: result.closedPositions };
    },
    liquidate_spot_assets: async (message) => {
      if (message.confirmationPhrase !== 'LIQUIDATE SPOT') {
        return this.error(
          'Для ликвидации всех внешних spot-активов нужно подтверждение фразой LIQUIDATE SPOT',
        );
      }
      const result = await this.intraday().liquidateAllSpotAssets(
        message.reason ||
          'Ликвидация всех внешних spot-активов через live dashboard',
      );
      return {
        статус: result.success ? 'успешно' : 'не выполнено',
        сообщение: result.message,
        проданныеАктивы: result.soldAssets,
        пропущенныеАктивы: result.skippedAssets,
        execution: result.status,
      };
    },
    close_position: async (message) => {
      if (!message.symbol || !message.strategyId) {
        return this.error('Для закрытия позиции нужны symbol и strategyId');
      }
      const result = await this.intraday().closePosition(
        message.symbol,
        message.strategyId,
        message.reason || 'Ручное закрытие позиции через live dashboard',
      );
      return {
        статус: result.closed ? 'успешно' : 'не выполнено',
        сообщение: result.reason,
      };
    },
    set_execution_mode: async (message) => {
      if (!message.mode || !message.marketType) {
        return this.error('Для переключения режима нужны mode и marketType');
      }
      const result = await this.intraday().setExecutionMode(
        message.mode,
        message.marketType,
        message.confirmationPhrase,
      );
      return {
        статус: result.success ? 'успешно' : 'не выполнено',
        сообщение: result.message,
        execution: result.status,
      };
    },
    refresh_execution_status: async () => {
      const result = await this.intraday().refreshExecutionStatus();
      return { статус: 'успешно', execution: result.status };
    },
  };

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly liveStream: LiveStreamService,
    private readonly runtime: LegacyRuntimeService,
    private readonly allocator: AllocatorEngine,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined;
    if (!server) {
      return;
    }

    this.wsServer = new WebSocketServer({
      server,
      path: '/ws',
      // WebSocket не защищён same-origin политикой браузера — проверяем источник сами
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        this.isTrusted({ host: req.headers.host, origin: req.headers.origin }),
    });

    this.wsServer.on('connection', (socket) => {
      this.clients.add(socket);
      this.send(socket, {
        type: 'initial_state',
        payload: {
          stream: this.liveStream.getSnapshot(),
          runtime: this.runtime.build(),
        },
      });
      socket.on('message', (raw: RawData) => {
        void this.handleMessage(socket, raw);
      });
      socket.on('close', () => this.clients.delete(socket));
    });

    this.unsubscribe = this.liveStream.subscribe((event) => {
      this.broadcast({ type: 'event', payload: event });
      if (event.type !== 'log') {
        this.broadcast({
          type: 'runtime_snapshot',
          payload: this.runtime.build(),
        });
      }
    });

    this.snapshotTimer = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast({
          type: 'runtime_snapshot',
          payload: this.runtime.build(),
        });
      }
    }, SNAPSHOT_BROADCAST_MS);
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
    }
    for (const client of this.clients) {
      client.terminate();
    }
    this.wsServer?.close();
  }

  private async handleMessage(socket: WebSocket, raw: RawData) {
    try {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(raw as ArrayBuffer).toString('utf8');
      const message = JSON.parse(text) as SocketMessage;

      if (message.type === 'request_snapshot') {
        this.send(socket, {
          type: 'runtime_snapshot',
          payload: this.runtime.build(),
        });
        return;
      }

      const handler = message.type ? this.commands[message.type] : undefined;
      const payload = handler
        ? await handler(message)
        : this.error(`Неизвестная команда: ${message.type ?? '—'}`);
      this.send(socket, {
        type: 'command_result',
        payload: { ...payload, snapshot: this.runtime.build() },
      });
    } catch (error) {
      this.send(socket, {
        type: 'command_result',
        payload: this.error(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  private intraday() {
    const runner = this.runtime.intradayRunner;
    if (!runner) {
      throw new Error(
        'Команда доступна только в режиме BOT_STRATEGY_MODE=intraday',
      );
    }
    return runner;
  }

  private toPayload(result: { success: boolean; message: Msg }) {
    return {
      статус: result.success ? 'успешно' : 'не выполнено',
      сообщение: ru(result.message),
      i18n: result.message,
    };
  }

  private error(message: string) {
    return { статус: 'ошибка', сообщение: message };
  }

  private broadcast(message: unknown) {
    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  private send(socket: WebSocket, payload: unknown) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
