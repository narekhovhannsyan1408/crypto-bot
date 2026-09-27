// Запросы к серверу бота. Ошибки превращаются в понятные сообщения на языке страницы.

import { t, tm } from './i18n.js';

const GET_TIMEOUT_MS = 15_000;
// Запуск и остановка ждут биржу — даём больше времени
const POST_TIMEOUT_MS = 60_000;

async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    method === 'GET' ? GET_TIMEOUT_MS : POST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // i18n — ключ словаря от сервера; message — английский текст для других клиентов
      throw new Error(
        data.i18n ? tm(data.i18n) : data.message || t('api.error'),
      );
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(t('api.timeout'));
    }
    if (error instanceof TypeError) {
      throw new Error(t('api.offline'));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  state: (activityLimit) => request(`/api/app/state?activity=${activityLimit}`),
  chart: (range) =>
    request(`/api/app/chart?range=${encodeURIComponent(range)}`),
  balance: (mode) =>
    request(`/api/app/balance?mode=${encodeURIComponent(mode)}`),
  start: (options) =>
    request('/api/app/start', { method: 'POST', body: options }),
  stop: () => request('/api/app/stop', { method: 'POST', body: {} }),
  rebalance: () => request('/api/app/rebalance', { method: 'POST', body: {} }),
};
