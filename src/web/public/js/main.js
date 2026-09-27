// Точка входа страницы: состояние, опрос сервера и обработчики событий.

import { api } from './api.js';
import { renderEquityChart } from './chart.js';
import { createDialogs } from './dialogs.js';
import { initI18n, mountLangSwitch, onLangChange } from './i18n.js';
import { el, renderApp } from './render.js';

const POLL_MS = 5_000;
const OFFLINE_POLL_MS = 10_000;
// Фоновая вкладка обновляется реже, но не замирает: заголовок вкладки показывает капитал
const HIDDEN_POLL_MS = 60_000;
const ACTIVITY_PAGE = 30;

const state = {
  app: null,
  range: 'all',
  chart: null,
  chartKey: null,
  activityLimit: ACTIVITY_PAGE,
  refreshing: false,
  failures: 0,
};

const toastEl = document.getElementById('toast');
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4_000);
}

function drawChart() {
  const session = state.app?.session;
  if (!session || !state.chart) return;
  const livePoint = session.stoppedAt
    ? null
    : { timestamp: state.app.generatedAt, equity: session.equity };
  renderEquityChart(el.chart, state.chart, livePoint);
}

// График запрашивается только когда на сервере появились новые точки или сменился период
async function syncChart() {
  const session = state.app?.session;
  if (!session) return;
  const key = `${session.chartVersion}|${state.range}`;
  if (key !== state.chartKey) {
    try {
      state.chart = await api.chart(state.range);
      state.chartKey = key;
    } catch {
      // оставляем прошлый график, следующий опрос попробует снова
    }
  }
  drawChart();
}

function applyState(app) {
  state.app = app;
  state.failures = 0;
  el.offline.hidden = true;
  renderApp(app);
  void syncChart();
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  let app;
  try {
    app = await api.state(state.activityLimit);
  } catch {
    state.failures += 1;
    el.offline.hidden = false;
    return;
  } finally {
    state.refreshing = false;
  }
  // Ошибка отрисовки — это баг страницы, а не потеря связи с ботом
  try {
    applyState(app);
  } catch (error) {
    console.error('Ошибка отрисовки', error);
  }
}

const dialogs = createDialogs({
  getApp: () => state.app,
  onChanged: (app) => applyState(app),
  toast,
});

let lastRefreshAt = 0;

async function pollLoop() {
  const interval = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
  const due = !state.app || Date.now() - lastRefreshAt >= interval;
  // Пока открыт диалог, не перерисовываем страницу под ним
  if (due && !dialogs.isOpen()) {
    lastRefreshAt = Date.now();
    await refresh();
  }
  setTimeout(pollLoop, state.failures > 0 ? OFFLINE_POLL_MS : POLL_MS);
}

el.startTestBtn.addEventListener('click', () => dialogs.openStart('test'));
el.startRealBtn.addEventListener('click', () => dialogs.openStart('real'));
el.startSolanaBtn.addEventListener('click', () => dialogs.openStart('solana'));
el.stopBtn.addEventListener('click', () => dialogs.openStop());

el.showMore.addEventListener('click', () => {
  state.activityLimit += ACTIVITY_PAGE * 2;
  void refresh();
});

el.rangeButtons.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button || button.dataset.range === state.range) return;
  state.range = button.dataset.range;
  el.rangeButtons.querySelectorAll('button').forEach((item) => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  void syncChart();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawChart, 150);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

// Смена языка: статичный текст переводит i18n, динамический — перерисовка
onLangChange(() => {
  if (state.app) renderApp(state.app);
  drawChart();
});

mountLangSwitch(document.getElementById('lang-switch'));
initI18n()
  .catch((error) => console.error('Не удалось загрузить словарь', error))
  .finally(() => void pollLoop());
