import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ExecutionMode } from '../trader/execution.types';

export type AllocatorSignalSnapshot = {
  symbol: string;
  day: number;
  close: number;
  trendScore: number;
  exposure: number;
  annualizedVol: number | null;
  smaValues: Record<number, number>;
};

export type ActivityKind =
  | 'start'
  | 'stop'
  | 'autostop'
  | 'buy'
  | 'sell'
  | 'check'
  | 'error';

export type ActivityEntry = {
  id: string;
  timestamp: number;
  kind: ActivityKind;
  title: string;
  details?: string;
  symbol?: string;
  quantity?: number;
  price?: number;
  quoteAmount?: number;
  fee?: number;
};

export type EquityPoint = { timestamp: number; equity: number };

/**
 * Сессия работы бота: от нажатия «Начать» до «Остановить».
 * Бот управляет только капиталом сессии и купленными им монетами —
 * чужие средства на аккаунте он не трогает.
 */
export type AllocatorSession = {
  id: string;
  mode: ExecutionMode;
  status: 'running' | 'stopped';
  startedAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  initialCapital: number;
  // Автозащита: доля потери от стартового капитала, при которой бот сам всё продаёт (0 — выключено)
  autoStopLossPct: number;
  cash: number;
  quantities: Record<string, number>;
  feesPaid: number;
  // openTime дневной свечи, по которой уже принято решение
  lastRebalanceDay: number | null;
  lastSignals: AllocatorSignalSnapshot[];
  equityHistory: EquityPoint[];
  activity: ActivityEntry[];
};

export type SessionSummary = {
  id: string;
  mode: ExecutionMode;
  startedAt: number;
  stoppedAt: number;
  initialCapital: number;
  finalEquity: number;
  stopReason: string;
};

type AllocatorStateFile = {
  version: 2;
  current: AllocatorSession | null;
  history: SessionSummary[];
};

const MAX_HISTORY = 50;
const MAX_ACTIVITY = 500;
const MAX_EQUITY_POINTS = 4000;

export class AllocatorStateStore {
  constructor(private readonly filePath: string) {}

  loadCurrent(): AllocatorSession | null {
    return this.readFile().current;
  }

  getHistory(): SessionSummary[] {
    return this.readFile().history;
  }

  saveCurrent(session: AllocatorSession) {
    const state = this.readFile();
    state.current = session;
    this.writeFile(state);
  }

  addToHistory(summary: SessionSummary) {
    const state = this.readFile();
    state.history = [
      summary,
      ...state.history.filter((item) => item.id !== summary.id),
    ].slice(0, MAX_HISTORY);
    this.writeFile(state);
  }

  private readFile(): AllocatorStateFile {
    if (!existsSync(this.filePath)) {
      return { version: 2, current: null, history: [] };
    }

    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<
      AllocatorStateFile & { version: number }
    >;
    if (parsed.version !== 2) {
      // Файл старого формата сохраняем рядом и начинаем с чистого состояния
      copyFileSync(
        this.filePath,
        `${this.filePath}.v${parsed.version ?? 1}.bak`,
      );
      return { version: 2, current: null, history: [] };
    }

    return {
      version: 2,
      current: parsed.current ?? null,
      history: parsed.history ?? [],
    };
  }

  private writeFile(state: AllocatorStateFile) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Атомарная запись: сначала во временный файл, затем rename
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state));
    renameSync(tempPath, this.filePath);
  }
}

export const appendActivity = (
  session: AllocatorSession,
  entry: Omit<ActivityEntry, 'id' | 'timestamp'> & { timestamp?: number },
) => {
  const timestamp = entry.timestamp ?? Date.now();
  session.activity.unshift({
    ...entry,
    timestamp,
    id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  });
  session.activity = session.activity.slice(0, MAX_ACTIVITY);
};

/**
 * Добавляет точку капитала не чаще minIntervalMs. Когда точек становится слишком
 * много, прореживает старую половину истории, сохраняя форму графика.
 */
export const appendEquityPoint = (
  history: EquityPoint[],
  point: EquityPoint,
  minIntervalMs: number,
  force = false,
) => {
  const last = history.at(-1);
  if (!force && last && point.timestamp - last.timestamp < minIntervalMs) {
    return history;
  }

  history.push(point);
  if (history.length > MAX_EQUITY_POINTS) {
    const half = Math.floor(history.length / 2);
    const thinned = history
      .slice(0, half)
      .filter((_, index) => index % 2 === 0);
    history.splice(0, half, ...thinned);
  }
  return history;
};
