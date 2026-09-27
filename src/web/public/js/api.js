// Запросы к серверу бота. Ошибки превращаются в понятные сообщения.

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
      throw new Error(data.message || 'Сервер бота вернул ошибку');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        'Бот слишком долго не отвечает. Проверьте, что программа запущена.',
      );
    }
    if (error instanceof TypeError) {
      throw new Error('Нет связи с ботом. Проверьте, что программа запущена.');
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
};
