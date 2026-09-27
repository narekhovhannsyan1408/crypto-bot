import { Msg, ru } from '../../i18n/messages';
import { ActivityEntry, AllocatorSession, EquityPoint } from './session.types';

const MAX_ACTIVITY = 500;
const MAX_EQUITY_POINTS = 4000;

export const appendActivity = (
  session: AllocatorSession,
  entry: Omit<
    ActivityEntry,
    'id' | 'timestamp' | 'title' | 'details' | 'text'
  > & {
    title: Msg;
    details?: Msg;
    timestamp?: number;
  },
) => {
  const { title, details, timestamp = Date.now(), ...facts } = entry;
  session.activity.unshift({
    ...facts,
    timestamp,
    id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    title: ru(title),
    details: details ? ru(details) : undefined,
    text: { title, details },
  });
  session.activity.length = Math.min(session.activity.length, MAX_ACTIVITY);
};

/**
 * Добавляет точку капитала не чаще minIntervalMs (force — всегда, например после сделки).
 * Когда точек слишком много, прореживает старую половину, сохраняя форму графика.
 */
export const appendEquityPoint = (
  history: EquityPoint[],
  point: EquityPoint,
  minIntervalMs: number,
  force = false,
) => {
  const last = history.at(-1);
  if (!force && last && point.timestamp - last.timestamp < minIntervalMs) {
    return;
  }

  history.push(point);
  if (history.length > MAX_EQUITY_POINTS) {
    const half = Math.floor(history.length / 2);
    const thinned = history
      .slice(0, half)
      .filter((_, index) => index % 2 === 0);
    history.splice(0, half, ...thinned);
  }
};

/**
 * Сжимает ряд до maxPoints для графика: в каждой корзине оставляет минимум и
 * максимум, чтобы не потерять провалы и пики.
 */
export const downsampleEquity = (points: EquityPoint[], maxPoints: number) => {
  if (points.length <= maxPoints || maxPoints < 4) {
    return points;
  }

  const buckets = Math.floor((maxPoints - 2) / 2);
  const inner = points.slice(1, -1);
  const size = inner.length / buckets;
  const result: EquityPoint[] = [points[0]];

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const slice = inner.slice(
      Math.floor(bucket * size),
      Math.floor((bucket + 1) * size),
    );
    if (slice.length === 0) continue;
    let min = slice[0];
    let max = slice[0];
    for (const point of slice) {
      if (point.equity < min.equity) min = point;
      if (point.equity > max.equity) max = point;
    }
    result.push(...(min.timestamp <= max.timestamp ? [min, max] : [max, min]));
  }

  result.push(points[points.length - 1]);
  return result.filter(
    (point, index) => index === 0 || point !== result[index - 1],
  );
};
