import { parseLegacyText } from '../../i18n/legacy-text';
import { AllocatorSession, SessionSummary } from './session.types';

/**
 * Записи, созданные до перевода интерфейса, хранят только русский текст.
 * Добавляет к ним ключи словаря, чтобы лента и история показывались на любом
 * языке. Исходный текст остаётся (его читает диагностика); нераспознанное не трогаем.
 */
export const migrateLegacyTexts = (state: {
  current: AllocatorSession | null;
  history: SessionSummary[];
}) => {
  let migrated = 0;
  let unparsed = 0;

  for (const entry of state.current?.activity ?? []) {
    if (entry.text) continue;
    const title = parseLegacyText(entry.title, ['narr.']);
    if (!title) {
      unparsed += 1;
      continue;
    }
    const details = entry.details
      ? (parseLegacyText(entry.details, ['narr.']) ?? {
          // Заголовок переведём, а нераспознанные подробности покажем как есть
          key: 'error.raw',
          params: { text: entry.details },
        })
      : undefined;
    entry.text = { title, details };
    migrated += 1;
  }

  const reasonHolders = [
    ...(state.current ? [state.current] : []),
    ...state.history,
  ];
  for (const holder of reasonHolders) {
    if (!holder.stopReason || holder.stopReasonMsg) continue;
    const reason = parseLegacyText(holder.stopReason, ['stop.reason.']);
    if (reason) {
      holder.stopReasonMsg = reason;
      migrated += 1;
    } else {
      unparsed += 1;
    }
  }
  return { migrated, unparsed };
};
