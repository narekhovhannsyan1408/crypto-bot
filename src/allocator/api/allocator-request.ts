import { BadRequestException } from '@nestjs/common';
import { ExecutionMode } from '../../trader/execution.types';
import { ChartRange } from '../engine/app-state.view';
import { StartOptions } from '../engine/allocator-engine.service';

const MODES: ExecutionMode[] = ['paper', 'live_testnet', 'live_real'];
const RANGES: ChartRange[] = ['day', 'week', 'month', 'all'];
const MAX_ACTIVITY_LIMIT = 500;

export const parseMode = (value: unknown): ExecutionMode => {
  if (MODES.includes(value as ExecutionMode)) {
    return value as ExecutionMode;
  }
  throw new BadRequestException('Неизвестный режим');
};

export const parseRange = (value: unknown): ChartRange =>
  RANGES.includes(value as ChartRange) ? (value as ChartRange) : 'all';

export const parseActivityLimit = (value: unknown) => {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_ACTIVITY_LIMIT)
    : 30;
};

export const parseStartRequest = (body: unknown): StartOptions => {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Пустой запрос');
  }
  const { mode, capitalUsdt, autoStopLossPct } = body as Record<
    string,
    unknown
  >;
  const capital = Number(capitalUsdt);
  const autoStop = Number(autoStopLossPct ?? 0);
  if (!Number.isFinite(capital)) {
    throw new BadRequestException('Укажите сумму');
  }
  if (!Number.isFinite(autoStop)) {
    throw new BadRequestException('Некорректный уровень автозащиты');
  }
  return {
    mode: parseMode(mode),
    capitalUsdt: capital,
    autoStopLossPct: autoStop,
  };
};
