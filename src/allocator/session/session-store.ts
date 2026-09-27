import { Injectable } from '@nestjs/common';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getBotConfig } from '../../config/bot-config';
import { AllocatorSession, SessionSummary } from './session.types';

type StateFile = {
  version: 2;
  current: AllocatorSession | null;
  history: SessionSummary[];
};

const MAX_HISTORY = 50;

/**
 * Состояние сессий в памяти с атомарной записью на диск.
 * Файл читается один раз при старте — опросы веб-интерфейса диск не трогают.
 */
@Injectable()
export class SessionStore {
  private readonly filePath = getBotConfig().allocator.stateFile;
  private state: StateFile = this.load();

  getCurrent() {
    return this.state.current;
  }

  getHistory() {
    return this.state.history;
  }

  saveCurrent(session: AllocatorSession) {
    this.state.current = session;
    this.persist();
  }

  addToHistory(summary: SessionSummary) {
    this.state.history = [
      summary,
      ...this.state.history.filter((item) => item.id !== summary.id),
    ].slice(0, MAX_HISTORY);
    this.persist();
  }

  private load(): StateFile {
    const empty: StateFile = { version: 2, current: null, history: [] };
    if (!existsSync(this.filePath)) {
      return empty;
    }

    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<
      StateFile & { version: number }
    >;
    if (parsed.version !== 2) {
      // Файл старого формата сохраняем рядом и начинаем с чистого состояния
      copyFileSync(
        this.filePath,
        `${this.filePath}.v${parsed.version ?? 1}.bak`,
      );
      return empty;
    }

    const current = parsed.current ?? null;
    if (current) {
      current.benchmarkStartPrices ??= null;
    }
    return { version: 2, current, history: parsed.history ?? [] };
  }

  private persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Атомарная запись: сначала во временный файл, затем rename
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.state));
    renameSync(tempPath, this.filePath);
  }
}
