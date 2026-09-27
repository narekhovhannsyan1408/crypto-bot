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
import { en, Msg, msg } from '../../i18n/messages';
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
          'Stopping the bot needs the confirmation phrase SELL ALL',
        );
      }
      return this.toPayload(
        await this.allocator.stop(msg('stop.reason.advanced')),
      );
    },
    emergency_close_all: async (message) => {
      const result = await this.intraday().emergencyCloseAllPositions(
        message.reason || 'Emergency close from the live dashboard',
      );
      return { status: 'ok', closedPositions: result.closedPositions };
    },
    liquidate_spot_assets: async (message) => {
      if (message.confirmationPhrase !== 'LIQUIDATE SPOT') {
        return this.error(
          'Liquidating all external spot assets needs the confirmation phrase LIQUIDATE SPOT',
        );
      }
      const result = await this.intraday().liquidateAllSpotAssets(
        message.reason ||
          'Liquidation of all external spot assets from the live dashboard',
      );
      return {
        status: result.success ? 'ok' : 'failed',
        message: result.message,
        soldAssets: result.soldAssets,
        skippedAssets: result.skippedAssets,
        execution: result.status,
      };
    },
    close_position: async (message) => {
      if (!message.symbol || !message.strategyId) {
        return this.error('Closing a position needs symbol and strategyId');
      }
      const result = await this.intraday().closePosition(
        message.symbol,
        message.strategyId,
        message.reason || 'Manual close from the live dashboard',
      );
      return {
        status: result.closed ? 'ok' : 'failed',
        message: result.reason,
      };
    },
    set_execution_mode: async (message) => {
      if (!message.mode || !message.marketType) {
        return this.error('Switching the mode needs mode and marketType');
      }
      const result = await this.intraday().setExecutionMode(
        message.mode,
        message.marketType,
        message.confirmationPhrase,
      );
      return {
        status: result.success ? 'ok' : 'failed',
        message: result.message,
        execution: result.status,
      };
    },
    refresh_execution_status: async () => {
      const result = await this.intraday().refreshExecutionStatus();
      return { status: 'ok', execution: result.status };
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
        : this.error(`Unknown command: ${message.type ?? '—'}`);
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
        'This command is only available with BOT_STRATEGY_MODE=intraday',
      );
    }
    return runner;
  }

  private toPayload(result: { success: boolean; message: Msg }) {
    return {
      status: result.success ? 'ok' : 'failed',
      message: en(result.message),
      i18n: result.message,
    };
  }

  private error(message: string) {
    return { status: 'error', message };
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
