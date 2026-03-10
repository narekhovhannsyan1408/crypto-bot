import { Injectable } from '@nestjs/common';

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

  private normalizePayload(payload: unknown): unknown {
    if (payload instanceof Error) {
      return {
        name: payload.name,
        message: payload.message,
        stack: payload.stack,
      };
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
    const lines = [
      `${this.colorize(colorKey, `[${this.getTimestamp()}] [${tag}]`)} ${title}`,
    ];

    if (payload !== undefined) {
      const normalized = this.normalizePayload(payload);
      const formatted = this.formatValue(normalized, 0);

      if (formatted.length > 0) {
        lines.push(...formatted);
      }
    }

    const output = lines.join('\n');

    if (isError) {
      console.error(output);
      return;
    }

    console.log(output);
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
}
