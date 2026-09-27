import { HttpStatus } from '@nestjs/common';
import { localizedHttpError } from '../../i18n/http-errors';
import { msg } from '../../i18n/messages';
import { ALLOCATOR_MODES, AllocatorMode } from '../allocator-mode';
import { ChartRange } from '../engine/app-state.view';
import { StartOptions } from '../engine/allocator-engine.service';

const RANGES: ChartRange[] = ['day', 'week', 'month', 'all'];
const MAX_ACTIVITY_LIMIT = 500;

const badRequest = (key: string) =>
  localizedHttpError(HttpStatus.BAD_REQUEST, msg(key));

export const parseMode = (value: unknown): AllocatorMode => {
  if (ALLOCATOR_MODES.includes(value as AllocatorMode)) {
    return value as AllocatorMode;
  }
  throw badRequest('req.unknownMode');
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
    throw badRequest('req.empty');
  }
  const { mode, capitalUsdt, autoStopLossPct } = body as Record<
    string,
    unknown
  >;
  const capital = Number(capitalUsdt);
  const autoStop = Number(autoStopLossPct ?? 0);
  if (!Number.isFinite(capital)) {
    throw badRequest('req.amount');
  }
  if (!Number.isFinite(autoStop)) {
    throw badRequest('action.badAutostop');
  }
  return {
    mode: parseMode(mode),
    capitalUsdt: capital,
    autoStopLossPct: autoStop,
  };
};
