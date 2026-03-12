import { Injectable } from '@nestjs/common';
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

  constructor(private readonly liveStream: LiveStreamService) {}

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
      return payload.map((item) => this.normalizePayload(item, seen, depth + 1));
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
    this.printBlock('СВЕЧА', 'Новая закрытая свеча', payload, 'candle');
  }

  logSignal(payload: unknown) {
    this.printBlock('СИГНАЛ', 'Результат стратегии', payload, 'signal');
  }

  logTrade(payload: unknown) {
    this.printBlock('СДЕЛКА', 'Исполнение торгового действия', payload, 'trade');
  }

  logPortfolio(payload: unknown) {
    this.printBlock('ПОРТФЕЛЬ', 'Состояние портфеля', payload, 'portfolio');
  }

  logInfo(message: string, payload?: unknown) {
    this.printBlock('ИНФО', message, payload, 'info');
  }

  logError(message: string, payload?: unknown) {
    this.printBlock('ОШИБКА', message, payload, 'error', true);
  }

  private printBlock(
    tag: string,
    title: string,
    payload: unknown,
    colorKey: keyof BotLoggerService['colors'],
    isError = false,
  ) {
    const normalized = payload !== undefined ? this.normalizePayload(payload) : undefined;
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
        return [`${indent}(пусто)`];
      }

      return value.flatMap((item, index) => {
        const itemLines = this.formatValue(item, indentLevel + 1);
        if (itemLines.length === 0) {
          return [`${indent}-`];
        }

        const [firstLine, ...rest] = itemLines;
        return [
          `${indent}- ${firstLine.trimStart()}`,
          ...rest,
        ];
      });
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);

      if (entries.length === 0) {
        return [`${indent}(пустой объект)`];
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
      return value ? 'да' : 'нет';
    }

    if (value === null || value === undefined) {
      return String(value);
    }

    return JSON.stringify(value);
  }

  private getTimestamp() {
    return new Date().toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  private colorize(colorKey: keyof BotLoggerService['colors'], text: string) {
    return `${this.colors[colorKey]}${text}${this.reset}`;
  }

  private mapTagToEventType(tag: string) {
    if (tag === 'СДЕЛКА') return 'trade' as const;
    if (tag === 'ПОРТФЕЛЬ') return 'portfolio' as const;
    if (tag === 'ИНФО') return 'system' as const;
    return 'log' as const;
  }
}
