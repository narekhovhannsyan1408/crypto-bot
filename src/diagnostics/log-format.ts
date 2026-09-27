import { LogRecord } from '../observability/log.types';

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export const formatRecord = (record: LogRecord, full: boolean) => {
  const ids = [
    record.opId ? `op=${record.opId}` : null,
    record.requestId ? `req=${record.requestId}` : null,
    record.sessionId ? `session=${record.sessionId}` : null,
  ].filter(Boolean);
  const head = `${record.ts.replace('T', ' ').replace('Z', '')} ${record.level.toUpperCase().padEnd(5)} ${record.event}${ids.length ? ` [${ids.join(' ')}]` : ''}${record.durationMs !== undefined ? ` (${record.durationMs} мс)` : ''}`;
  const lines = [`${head}\n    ${record.msg}`];
  if (record.data !== undefined) {
    const data = full
      ? JSON.stringify(record.data, null, 2)
      : JSON.stringify(record.data);
    lines.push(
      `    data: ${full ? data.replace(/\n/g, '\n    ') : truncate(data, 400)}`,
    );
  }
  if (record.err) {
    lines.push(
      `    err: ${record.err.name}: ${record.err.message}${record.err.status ? ` (HTTP ${record.err.status})` : ''}${record.err.url ? ` ${record.err.method ?? ''} ${record.err.url}` : ''}`,
    );
    if (record.err.stack) {
      const stack = record.err.stack.split('\n').slice(1, full ? undefined : 4);
      lines.push(...stack.map((line) => `      ${line.trim()}`));
    }
  }
  return lines.join('\n');
};
