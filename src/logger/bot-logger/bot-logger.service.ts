import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../observability/app-logger';
import { LogLevel } from '../../observability/log.types';
import { LiveStreamService } from '../../streaming/live-stream/live-stream.service';

@Injectable()
export class BotLoggerService {
  private readonly reset = '\x1b[0m';
  private readonly colors: Record<string, string> = {
    candle: '\x1b[36m',
    signal: '\x1b[35m',
    trade: '\x1b[32m',
    portfolio: '\x1b[33m',
    info: '\x1b[34m',
    error: '\x1b[31m',
  };

  constructor(
    private readonly liveStream: LiveStreamService,
    // Диагностический журнал; в юнит-тестах может отсутствовать
    @Optional() private readonly journal?: AppLogger,
  ) {}

  private normalizePayload(
    payload: unknown,
    seen = new WeakSet<object>(),
    depth = 0,
  ): unknown {
    if (depth > 6) {
      return '[max-depth-reached]';
    }

    if (payload instanceof Error) {
      return {
        name: payload.name,
        message: payload.message,
        stack: payload.stack,
      };
    }

    if (payload === null || payload === undefined) {
      return payload;
    }

    if (Array.isArray(payload)) {
      return payload.map((item) =>
        this.normalizePayload(item, seen, depth + 1),
      );
    }

    if (typeof payload === 'object') {
      if (seen.has(payload)) {
        return '[circular]';
      }

      seen.add(payload);
      return Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [
          key,
          this.normalizePayload(value, seen, depth + 1),
        ]),
      );
    }

    return payload;
  }

  logCandle(payload: unknown) {
    this.printBlock('CANDLE', 'New closed candle', payload, 'candle');
    this.journal?.debug('market.candle', 'New closed candle', payload);
  }

  logSignal(payload: unknown) {
    this.printBlock('SIGNAL', 'Strategy result', payload, 'signal');
    this.journal?.debug('strategy.signal', 'Strategy result', payload);
  }

  // event = null: только консоль и дашборд (структурированную запись в журнал делает вызывающий)
  logTrade(payload: unknown, event: string | null = 'trade.executed') {
    this.printBlock('TRADE', 'Trade executed', payload, 'trade');
    if (event) this.journal?.info(event, 'Trade executed', payload);
  }

  logPortfolio(payload: unknown) {
    this.printBlock('PORTFOLIO', 'Portfolio state', payload, 'portfolio');
    this.journal?.debug('portfolio.snapshot', 'Portfolio state', payload);
  }

  /** event — машиночитаемое имя события для журнала, например allocator.session.started */
  logInfo(
    message: string,
    payload?: unknown,
    event: string | null = 'bot.info',
  ) {
    this.printBlock('INFO', message, payload, 'info');
    if (event) this.journal?.info(event, message, payload);
  }

  logError(
    message: string,
    payload?: unknown,
    event: string | null = 'bot.error',
  ) {
    this.printBlock('ERROR', message, payload, 'error', true);
    if (event) this.persistError(event, message, payload, 'error');
  }

  // Ошибка может прийти сама по себе или внутри объекта ({ symbol, error })
  private persistError(
    event: string,
    message: string,
    payload: unknown,
    level: LogLevel,
  ) {
    if (!this.journal) return;
    if (payload instanceof Error) {
      this.journal.log(level, event, message, { err: payload });
      return;
    }
    const nested =
      payload && typeof payload === 'object'
        ? Object.values(payload as Record<string, unknown>).find(
            (value) => value instanceof Error,
          )
        : undefined;
    this.journal.log(level, event, message, { data: payload, err: nested });
  }

  private printBlock(
    tag: string,
    title: string,
    payload: unknown,
    colorKey: keyof BotLoggerService['colors'],
    isError = false,
  ) {
    const normalized =
      payload !== undefined ? this.normalizePayload(payload) : undefined;
    const divider = this.colorize(
      colorKey,
      '============================================================',
    );
    const lines = [
      divider,
      `${this.colorize(colorKey, `[${this.getTimestamp()}] [${tag}]`)} ${title}`,
    ];

    if (payload !== undefined) {
      const formatted = this.formatValue(normalized, 0);

      if (formatted.length > 0) {
        lines.push(...formatted);
      }
    }

    lines.push(divider);

    const output = `${lines.join('\n')}\n`;

    if (isError) {
      console.error(output);
    } else {
      console.log(output);
    }

    this.liveStream.publish({
      type: this.mapTagToEventType(tag),
      tag,
      title,
      payload: normalized,
    });
  }

  private formatValue(value: unknown, indentLevel: number): string[] {
    const indent = '  '.repeat(indentLevel + 1);

    if (value === null || value === undefined) {
      return [`${indent}${String(value)}`];
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return [`${indent}(empty)`];
      }

      return value.flatMap((item) => {
        const itemLines = this.formatValue(item, indentLevel + 1);
        if (itemLines.length === 0) {
          return [`${indent}-`];
        }

        const [firstLine, ...rest] = itemLines;
        return [`${indent}- ${firstLine.trimStart()}`, ...rest];
      });
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);

      if (entries.length === 0) {
        return [`${indent}(empty object)`];
      }

      return entries.flatMap(([key, entryValue]) => {
        if (
          entryValue === null ||
          entryValue === undefined ||
          typeof entryValue !== 'object'
        ) {
          return [`${indent}${key}: ${this.formatPrimitive(entryValue)}`];
        }

        return [
          `${indent}${key}:`,
          ...this.formatValue(entryValue, indentLevel + 1),
        ];
      });
    }

    return [`${indent}${this.formatPrimitive(value)}`];
  }

  private formatPrimitive(value: unknown) {
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return value.toString();
      }

      return value.toFixed(6).replace(/\.?0+$/, '');
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'boolean') {
      return value ? 'yes' : 'no';
    }

    if (value === null || value === undefined) {
      return String(value);
    }

    return JSON.stringify(value);
  }

  private getTimestamp() {
    // 2026-09-27 20:23:41 — местное время в формате, понятном на любом языке
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  private colorize(colorKey: keyof BotLoggerService['colors'], text: string) {
    return `${this.colors[colorKey]}${text}${this.reset}`;
  }

  private mapTagToEventType(tag: string) {
    if (tag === 'TRADE') return 'trade' as const;
    if (tag === 'PORTFOLIO') return 'portfolio' as const;
    if (tag === 'INFO') return 'system' as const;
    return 'log' as const;
  }
}
