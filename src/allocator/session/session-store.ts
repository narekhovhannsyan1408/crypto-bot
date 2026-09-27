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
import { AppLogger } from '../../observability/app-logger';
import { migrateLegacyTexts } from './legacy-migration';
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
  private state: StateFile;

  constructor(private readonly journal: AppLogger) {
    this.state = this.load();
    const current = this.state.current;
    this.journal.info('session.store.loaded', 'Session state loaded', {
      path: this.filePath,
      sessionId: current?.id ?? null,
      status: current?.status ?? null,
      mode: current?.mode ?? null,
      lastRebalanceDay: current?.lastRebalanceDay
        ? new Date(current.lastRebalanceDay).toISOString().slice(0, 10)
        : null,
      historyCount: this.state.history.length,
    });
  }

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

    let parsed: Partial<StateFile & { version: number }>;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as typeof parsed;
    } catch (error) {
      // Молча начать с чистого листа нельзя: в файле может быть сессия с реальными деньгами
      throw new Error(
        `The bot state file is corrupted: ${this.filePath}. Fix it, or rename it to start from a clean state (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    if (parsed.version !== 2) {
      // Файл старого формата сохраняем рядом и начинаем с чистого состояния
      this.journal.warn(
        'session.store.legacy_format',
        'Old-format state file saved as .bak',
        {
          path: this.filePath,
          version: parsed.version ?? 1,
        },
      );
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
    const state: StateFile = {
      version: 2,
      current,
      history: parsed.history ?? [],
    };
    const { migrated, unparsed } = migrateLegacyTexts(state);
    if (migrated || unparsed) {
      this.journal.info(
        'session.store.texts_migrated',
        'Old feed entries migrated to dictionary keys',
        { migrated, unparsed },
      );
    }
    return state;
  }

  private persist() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Атомарная запись: сначала во временный файл, затем rename
      const tempPath = `${this.filePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(this.state));
      renameSync(tempPath, this.filePath);
    } catch (error) {
      this.journal.error(
        'session.store.persist_failed',
        'Failed to save the state to disk',
        error,
        {
          path: this.filePath,
        },
      );
      throw error;
    }
  }
}
