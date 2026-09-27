import { SerializedError } from './log.types';

const SECRET_KEY =
  /(secret|password|passphrase|token|api[-_]?key|apikey|signature|authorization|cookie|private)/i;
// Подписанные URL и заголовки Binance могут попасть в текст ошибок
const SECRET_IN_TEXT =
  /((?:signature|apiKey|api_key|X-MBX-APIKEY|secret)[=:]\s*)[^&\s"',}]+/gi;

const MAX_STRING = 2_000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
const MAX_STACK_LINES = 15;

export const scrubText = (text: string) => {
  const scrubbed = text.replace(SECRET_IN_TEXT, '$1[REDACTED]');
  return scrubbed.length > MAX_STRING
    ? `${scrubbed.slice(0, MAX_STRING)}…[+${scrubbed.length - MAX_STRING} chars]`
    : scrubbed;
};

/**
 * Оставляет в стеке кадры кода проекта: строки из node_modules и внутренностей
 * Node почти никогда не помогают понять, где ошибка в нашей логике.
 */
export const compactStack = (stack: string) => {
  const [head, ...frames] = stack.split('\n');
  const own = frames.filter(
    (line) => !line.includes('node_modules') && !/\(node:|at node:/.test(line),
  );
  const kept = (own.length > 0 ? own : frames.slice(0, 4)).slice(
    0,
    MAX_STACK_LINES,
  );
  const hidden = frames.length - kept.length;
  return [
    head,
    ...kept,
    ...(hidden > 0 ? [`    … ${hidden} library frames hidden`] : []),
  ].join('\n');
};

type ErrorLike = Error & {
  code?: string | number;
  status?: number;
  cause?: unknown;
  config?: { url?: string; baseURL?: string; method?: string };
  response?: { status?: number; data?: unknown };
};

export const serializeError = (error: unknown, depth = 0): SerializedError => {
  if (!(error instanceof Error)) {
    return {
      name: 'NonError',
      message: scrubText(typeof error === 'string' ? error : safeJson(error)),
    };
  }

  const candidate = error as ErrorLike;
  const serialized: SerializedError = {
    name: candidate.name || candidate.constructor?.name || 'Error',
    message: scrubText(candidate.message),
    stack: candidate.stack
      ? scrubText(compactStack(candidate.stack))
      : undefined,
  };
  if (candidate.code !== undefined) serialized.code = candidate.code;
  // Ошибки axios: куда шёл запрос и что ответил сервер
  if (candidate.config?.url) {
    serialized.url = scrubText(
      `${candidate.config.baseURL ?? ''}${candidate.config.url}`,
    );
    serialized.method = candidate.config.method?.toUpperCase();
  }
  const status = candidate.response?.status ?? candidate.status;
  if (typeof status === 'number') serialized.status = status;
  if (candidate.response?.data !== undefined) {
    serialized.responseBody = sanitize(candidate.response.data);
  }
  if (candidate.cause !== undefined && depth < 3) {
    serialized.cause = serializeError(candidate.cause, depth + 1);
  }
  return serialized;
};

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Готовит данные к записи в лог: маскирует секреты, обрезает большие строки и
 * массивы, разрывает циклические ссылки. Никогда не бросает исключений.
 */
export const sanitize = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[too deep]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY)
        .map((item) => sanitize(item, depth + 1, seen));
      if (value.length > MAX_ARRAY)
        items.push(`[…${value.length - MAX_ARRAY} more]`);
      return items;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key)
        ? '[REDACTED]'
        : sanitize(item, depth + 1, seen);
    }
    return result;
  }

  return `[${typeof value}]`;
};
