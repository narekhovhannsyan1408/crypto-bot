'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  offline: $('offline-banner'),
  startView: $('start-view'),
  heroTitle: $('hero-title'),
  heroLead: $('hero-lead'),
  startTestBtn: $('start-test-btn'),
  startRealBtn: $('start-real-btn'),
  sessionView: $('session-view'),
  summaryLabel: $('summary-label'),
  equityValue: $('equity-value'),
  profitValue: $('profit-value'),
  summaryMeta: $('summary-meta'),
  stopBtn: $('stop-btn'),
  protection: $('protection'),
  stoppedNote: $('stopped-note'),
  rangeButtons: $('range-buttons'),
  chart: $('chart'),
  nowTitle: $('now-title'),
  nowSummary: $('now-summary'),
  allocBar: $('alloc-bar'),
  allocLegend: $('alloc-legend'),
  assetList: $('asset-list'),
  nextDecision: $('next-decision'),
  activity: $('activity'),
  activityCount: $('activity-count'),
  historyCard: $('history-card'),
  historyBody: $('history-body'),
  startDialog: $('start-dialog'),
  startDialogTitle: $('start-dialog-title'),
  startDialogContent: $('start-dialog-content'),
  startForm: $('start-form'),
  startError: $('start-error'),
  startCancel: $('start-cancel'),
  startConfirm: $('start-confirm'),
  stopDialog: $('stop-dialog'),
  stopDialogText: $('stop-dialog-text'),
  stopForm: $('stop-form'),
  stopError: $('stop-error'),
  stopCancel: $('stop-cancel'),
  stopConfirm: $('stop-confirm'),
  toast: $('toast'),
};

const DEFAULT_HERO = {
  title: el.heroTitle.textContent,
  lead: el.heroLead.textContent,
};
const ASSET_COLORS = { BTC: 'var(--btc)', ETH: 'var(--eth)', USDT: 'var(--usdt)' };
const EVENT_ICONS = {
  buy: '↗',
  sell: '↘',
  start: '▶',
  stop: '■',
  autostop: '🛡',
  check: '✓',
  error: '!',
};
const RANGE_MS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
const AUTO_STOP_OPTIONS = [
  { value: 0, label: 'Без автозащиты' },
  { value: 0.2, label: '−20%' },
  { value: 0.3, label: '−30%' },
  { value: 0.4, label: '−40%' },
];

const state = {
  app: null,
  range: 'all',
  startKind: 'test',
  freeUsdt: null,
  busy: false,
};

// ---------- Форматирование ----------

const moneyFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtMoney = (value) => `${moneyFormat.format(value)} $`;
const fmtSignedMoney = (value) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${moneyFormat.format(Math.abs(value))} $`;
const fmtPct = (value) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
const fmtPrice = (value) =>
  `${value.toLocaleString('ru-RU', { maximumFractionDigits: value >= 100 ? 2 : 4 })} $`;
const fmtQty = (value) => value.toLocaleString('ru-RU', { maximumSignificantDigits: 6 });
const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (ts) =>
  new Date(ts).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const fmtShortDate = (ts) =>
  new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

const plural = (n, forms) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
};

const humanDuration = (ms) => {
  const minutes = Math.max(Math.floor(ms / 60_000), 0);
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${plural(hours, ['час', 'часа', 'часов'])}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
};

const dayKey = (ts) => new Date(ts).toDateString();
const dayHeading = (ts) => {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (dayKey(ts) === today.toDateString()) return 'Сегодня';
  if (dayKey(ts) === yesterday.toDateString()) return 'Вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// ---------- Сервер ----------

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'Сервер бота вернул ошибку');
  }
  return data;
}

async function refresh() {
  try {
    state.app = await request('/api/app/state');
    el.offline.hidden = true;
    render();
  } catch {
    el.offline.hidden = false;
  }
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4000);
}

// ---------- Отрисовка ----------

function render() {
  const app = state.app;
  if (!app) return;
  const session = app.session;
  const running = app.status === 'running';

  if (running) {
    el.statusPill.dataset.tone = session.mode === 'live_real' ? 'real' : 'test';
    const shortMode = { paper: 'Тест', live_testnet: 'Демо', live_real: 'Реальные деньги' };
    el.statusText.textContent = `Работает · ${shortMode[session.mode] || session.modeLabel}`;
  } else {
    el.statusPill.dataset.tone = 'muted';
    el.statusText.textContent = app.status === 'stopped' ? 'Остановлен' : 'Не запущен';
  }

  el.startView.hidden = running;
  el.startView.classList.toggle('compact', app.status === 'stopped');
  if (app.status === 'stopped') {
    el.heroTitle.textContent = 'Бот остановлен. Запустить снова?';
    el.heroLead.textContent =
      'Ниже — итог последнего запуска. Новый запуск начнётся с чистого листа.';
  } else {
    el.heroTitle.textContent = DEFAULT_HERO.title;
    el.heroLead.textContent = DEFAULT_HERO.lead;
  }

  const realReady = app.readiness.live_real.available;
  el.startRealBtn.querySelector('.start-sub').textContent = realReady
    ? 'Бот торгует на вашем аккаунте Binance. Возможны убытки — вкладывайте только то, что готовы потерять.'
    : 'Сначала нужно подключить аккаунт Binance — нажмите, и мы покажем, как это сделать.';

  el.sessionView.hidden = !session;
  if (session) {
    renderSummary(session, running);
    renderNow(session, running);
    renderChart();
    renderActivity(session);
  }
  renderHistory(app.history, session);
}

function renderSummary(session, running) {
  el.summaryLabel.textContent = running ? 'Сейчас у вас' : 'Итог запуска';
  el.equityValue.textContent = fmtMoney(session.equity);

  const tone = session.profit > 0.005 ? 'positive' : session.profit < -0.005 ? 'negative' : 'neutral';
  const arrow = tone === 'positive' ? '▲' : tone === 'negative' ? '▼' : '•';
  el.profitValue.className = `delta ${tone}`;
  el.profitValue.textContent = `${arrow} ${fmtSignedMoney(session.profit)} (${fmtPct(session.profitPct)}) ${running ? 'с начала' : 'за запуск'}`;

  const period = running
    ? `работает ${humanDuration(Date.now() - session.startedAt)}`
    : `${fmtDateTime(session.startedAt)} — ${fmtDateTime(session.stoppedAt)}`;
  const fees = session.feesPaid > 0 ? ` · комиссии биржи ${fmtMoney(session.feesPaid)}` : '';
  el.summaryMeta.textContent = `Начали с ${fmtMoney(session.initialCapital)} · ${period} · ${session.modeLabel}${fees}`;

  el.stopBtn.hidden = !running;
  el.protection.hidden = !running;
  el.stoppedNote.hidden = running;

  if (running) {
    if (session.autoStopEquity !== null) {
      const cushion = session.equity - session.autoStopEquity;
      const ratio = clamp(cushion / (session.initialCapital - session.autoStopEquity), 0, 1);
      const meterClass = ratio < 0.2 ? 'danger' : ratio < 0.5 ? 'warn' : '';
      el.protection.innerHTML = `
        🛡 <b>Автозащита включена.</b> Если капитал опустится до <b>${fmtMoney(session.autoStopEquity)}</b>
        (−${Math.round(session.autoStopLossPct * 100)}% от старта), бот сам продаст всё и остановится.
        Запас: <b>${fmtMoney(Math.max(cushion, 0))}</b>.
        <div class="meter ${meterClass}"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div>`;
    } else {
      el.protection.innerHTML =
        'Автозащита выключена: бот не остановится сам при убытке. Остановить его можно кнопкой выше.';
    }
  } else {
    el.stoppedNote.textContent = `Бот остановлен ${fmtDateTime(session.stoppedAt)}. ${session.stopReason || ''}`;
  }
}

function trendClass(votes, total) {
  if (votes === null || votes === undefined) return 'none';
  if (votes === total) return 'up';
  if (votes / total >= 0.5) return 'mid';
  return 'down';
}

function renderNow(session, running) {
  el.nowTitle.textContent = running ? 'Что сейчас делает бот' : 'Где были деньги в конце';

  const invested = session.assets.filter((asset) => asset.weightPct >= 1);
  let summary;
  if (running && session.lastDecisionDay === null) {
    summary = 'Бот анализирует рынок и принимает первое решение…';
  } else if (invested.length === 0) {
    summary = running
      ? 'Все деньги в USDT: рынок сейчас не растёт, бот ждёт восходящего тренда.'
      : 'Все монеты проданы, деньги в USDT.';
  } else {
    const parts = invested.map((asset) => `${Math.round(asset.weightPct)}% в ${asset.name}`);
    const cash = Math.round(session.cashWeightPct);
    summary = `Держит ${parts.join(' и ')}${cash >= 1 ? `, ${cash}% в USDT` : ''}.`;
  }
  el.nowSummary.textContent = summary;

  const segments = [
    ...session.assets.map((asset) => ({ key: asset.base, label: asset.name, pct: asset.weightPct })),
    { key: 'USDT', label: 'USDT', pct: session.cashWeightPct },
  ];
  el.allocBar.innerHTML = segments
    .filter((segment) => segment.pct > 0.05)
    .map(
      (segment) =>
        `<span style="width:${segment.pct}%;background:${ASSET_COLORS[segment.key] || 'var(--accent)'}" title="${escapeHtml(segment.label)}: ${segment.pct}%"></span>`,
    )
    .join('');
  el.allocLegend.innerHTML = segments
    .map(
      (segment) =>
        `<span><i style="background:${ASSET_COLORS[segment.key] || 'var(--accent)'}"></i>${escapeHtml(segment.label)} ${Math.round(segment.pct)}%</span>`,
    )
    .join('');

  const assetRows = session.assets.map((asset) => {
    const hasSignal = asset.targetWeightPct !== null;
    const badge = hasSignal
      ? `<span class="trend-badge ${trendClass(asset.trendVotes, asset.trendTotal)}" title="Цена выше ${asset.trendVotes} из ${asset.trendTotal} средних">${escapeHtml(asset.trendLabel)} · ${asset.trendVotes}/${asset.trendTotal}</span>`
      : '<span class="trend-badge none">Ждёт анализа</span>';
    const holding = asset.quantity > 0
      ? `${fmtQty(asset.quantity)} ${escapeHtml(asset.base)}${asset.price ? ` · курс ${fmtPrice(asset.price)}` : ''}`
      : `Не куплен${asset.price ? ` · курс ${fmtPrice(asset.price)}` : ''}`;
    return `
      <div class="asset">
        <span class="asset-icon" style="background:${ASSET_COLORS[asset.base] || 'var(--accent)'}">${escapeHtml(asset.base)}</span>
        <div class="asset-name">${escapeHtml(asset.name)}${badge}</div>
        <div class="asset-value">${fmtMoney(asset.value)}</div>
        <div class="asset-sub">${holding}</div>
        <div class="asset-sub asset-target">${hasSignal ? `цель ${Math.round(asset.targetWeightPct)}%` : ''}</div>
      </div>`;
  });
  assetRows.push(`
    <div class="asset">
      <span class="asset-icon" style="background:${ASSET_COLORS.USDT}">$</span>
      <div class="asset-name">Доллары (USDT)</div>
      <div class="asset-value">${fmtMoney(session.cash)}</div>
      <div class="asset-sub">Свободные деньги бота</div>
      <div class="asset-sub asset-target"></div>
    </div>`);
  el.assetList.innerHTML = assetRows.join('');

  el.nextDecision.hidden = !running;
  if (running && session.nextDecisionAt) {
    const next = new Date(session.nextDecisionAt);
    const isToday = next.toDateString() === new Date().toDateString();
    const when = `${isToday ? 'сегодня' : 'завтра'} около ${fmtTime(session.nextDecisionAt)}`;
    const prices = session.pricesUpdatedAt ? ` Цены обновлены в ${fmtTime(session.pricesUpdatedAt)}.` : '';
    el.nextDecision.innerHTML = `Следующее решение: <b>${when}</b> — после закрытия торгового дня. Между решениями бот следит за ценами и автозащитой.${prices}`;
  }
}

function renderActivity(session) {
  const items = session.activity.slice(0, 80);
  el.activityCount.textContent = `${session.activity.length} ${plural(session.activity.length, ['событие', 'события', 'событий'])}`;
  if (items.length === 0) {
    el.activity.innerHTML = '<li class="empty">Пока ничего не произошло.</li>';
    return;
  }

  let currentDay = null;
  const html = [];
  for (const entry of items) {
    const key = dayKey(entry.timestamp);
    if (key !== currentDay) {
      currentDay = key;
      html.push(`<li class="day">${escapeHtml(dayHeading(entry.timestamp))}</li>`);
    }
    let facts = '';
    if ((entry.kind === 'buy' || entry.kind === 'sell') && entry.quantity !== undefined) {
      const base = entry.symbol ? entry.symbol.replace(/USDT$/, '') : '';
      facts = `<div class="event-facts">${fmtQty(entry.quantity)} ${escapeHtml(base)} по ${fmtPrice(entry.price)} · ${entry.kind === 'buy' ? 'потрачено' : 'получено'} ${fmtMoney(entry.quoteAmount)} · комиссия ${fmtMoney(entry.fee || 0)}</div>`;
    }
    html.push(`
      <li class="event">
        <span class="event-icon ${escapeHtml(entry.kind)}" aria-hidden="true">${EVENT_ICONS[entry.kind] || '•'}</span>
        <div>
          <div class="event-title">${escapeHtml(entry.title)}</div>
          ${entry.details ? `<div class="event-details">${escapeHtml(entry.details)}</div>` : ''}
          ${facts}
        </div>
        <span class="event-time">${fmtTime(entry.timestamp)}</span>
      </li>`);
  }
  el.activity.innerHTML = html.join('');
}

function renderHistory(history, session) {
  const rows = (history || []).filter((item) => !session || item.id !== session.id);
  el.historyCard.hidden = rows.length === 0;
  el.historyBody.innerHTML = rows
    .map(
      (item) => `
      <tr>
        <td>${fmtShortDate(item.startedAt)} — ${fmtShortDate(item.stoppedAt)}</td>
        <td>${escapeHtml(item.modeLabel)}</td>
        <td>${fmtMoney(item.initialCapital)}</td>
        <td>${fmtMoney(item.finalEquity)}</td>
        <td class="${item.profit >= 0 ? 'positive-text' : 'negative-text'}">${fmtSignedMoney(item.profit)} (${fmtPct(item.profitPct)})</td>
      </tr>`,
    )
    .join('');
}

// ---------- График ----------

function niceTicks(min, max, count) {
  const span = max - min;
  if (span <= 0) return [min];
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) || rawStep;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function equityAt(points, timestamp) {
  if (timestamp <= points[0].timestamp) return points[0].equity;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (timestamp <= right.timestamp) {
      const left = points[index - 1];
      const span = right.timestamp - left.timestamp || 1;
      return left.equity + ((right.equity - left.equity) * (timestamp - left.timestamp)) / span;
    }
  }
  return points[points.length - 1].equity;
}

function renderChart() {
  const session = state.app?.session;
  const container = el.chart;
  if (!session) return;

  const all = session.equityHistory || [];
  let points = all;
  if (state.range !== 'all' && all.length > 1) {
    const cutoff = all[all.length - 1].timestamp - RANGE_MS[state.range];
    points = all.filter((point) => point.timestamp >= cutoff);
    if (points.length < 2) points = all.slice(-2);
  }

  if (points.length < 2 || points[points.length - 1].timestamp === points[0].timestamp) {
    container.innerHTML =
      '<div class="chart-empty">График появится через несколько минут работы бота — точки добавляются каждые 15 минут и после каждой сделки.</div>';
    return;
  }

  const width = container.clientWidth || 600;
  const height = container.clientHeight || 290;
  const pad = { top: 18, right: 14, bottom: 28, left: 70 };
  const base = session.initialCapital;
  const minX = points[0].timestamp;
  const maxX = points[points.length - 1].timestamp;
  const values = points.map((point) => point.equity).concat(base);
  let minY = Math.min(...values);
  let maxY = Math.max(...values);
  const span = Math.max(maxY - minY, base * 0.004);
  minY -= span * 0.15;
  maxY += span * 0.15;

  const x = (t) => pad.left + ((t - minX) / (maxX - minX)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + (1 - (v - minY) / (maxY - minY)) * (height - pad.top - pad.bottom);
  const baseY = y(base);

  const line = points
    .map((point, index) => `${index ? 'L' : 'M'}${x(point.timestamp).toFixed(1)},${y(point.equity).toFixed(1)}`)
    .join('');
  const area = `${line}L${x(maxX).toFixed(1)},${baseY.toFixed(1)}L${x(minX).toFixed(1)},${baseY.toFixed(1)}Z`;

  const yDigits = maxY - minY < 20 ? 2 : 0;
  const yLabel = (value) =>
    `${value.toLocaleString('ru-RU', { minimumFractionDigits: yDigits, maximumFractionDigits: yDigits })} $`;
  const yTicks = niceTicks(minY, maxY, 4)
    .map(
      (value) =>
        `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/>` +
        `<text class="axis-label" x="${pad.left - 8}" y="${y(value) + 4}" text-anchor="end">${yLabel(value)}</text>`,
    )
    .join('');

  const shortSpan = maxX - minX <= 2 * 86_400_000;
  const xTickCount = width < 480 ? 3 : 5;
  const seenLabels = new Set();
  const xTicks = Array.from({ length: xTickCount }, (_, index) => minX + ((maxX - minX) * index) / (xTickCount - 1))
    .map((t, index) => {
      const label = shortSpan ? fmtTime(t) : fmtShortDate(t);
      if (seenLabels.has(label)) return '';
      seenLabels.add(label);
      const anchor = index === 0 ? 'start' : index === xTickCount - 1 ? 'end' : 'middle';
      return `<text class="axis-label" x="${x(t)}" y="${height - 8}" text-anchor="${anchor}">${label}</text>`;
    })
    .join('');

  const trades = session.activity
    .filter((entry) => (entry.kind === 'buy' || entry.kind === 'sell') && entry.timestamp >= minX && entry.timestamp <= maxX)
    .map((entry) => ({ ...entry, cx: x(entry.timestamp), cy: y(equityAt(points, entry.timestamp)) }));
  const markers = trades
    .map((trade) => `<circle class="marker-${trade.kind}" cx="${trade.cx}" cy="${trade.cy}" r="5"/>`)
    .join('');

  const baseLabelY = baseY - 6 < pad.top + 8 ? baseY + 14 : baseY - 6;
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="График капитала">
      <defs>
        <clipPath id="clip-up"><rect x="0" y="0" width="${width}" height="${Math.max(baseY, 0)}"/></clipPath>
        <clipPath id="clip-down"><rect x="0" y="${baseY}" width="${width}" height="${Math.max(height - baseY, 0)}"/></clipPath>
      </defs>
      ${yTicks}
      <path class="area-up" d="${area}" clip-path="url(#clip-up)"/>
      <path class="area-down" d="${area}" clip-path="url(#clip-down)"/>
      <line class="base-line" x1="${pad.left}" x2="${width - pad.right}" y1="${baseY}" y2="${baseY}"/>
      <text class="base-label" x="${width - pad.right}" y="${baseLabelY}" text-anchor="end">Старт: ${fmtMoney(base)}</text>
      <path class="equity-line" d="${line}"/>
      ${markers}
      ${xTicks}
      <line class="hover-line" id="hover-line" y1="${pad.top}" y2="${height - pad.bottom}" visibility="hidden"/>
      <circle class="hover-dot" id="hover-dot" r="5" visibility="hidden"/>
      <rect id="hover-area" x="${pad.left}" y="0" width="${width - pad.left - pad.right}" height="${height}" fill="transparent"/>
    </svg>
    <div class="chart-tooltip" id="chart-tooltip" hidden></div>`;

  const hoverArea = container.querySelector('#hover-area');
  const hoverLine = container.querySelector('#hover-line');
  const hoverDot = container.querySelector('#hover-dot');
  const tooltip = container.querySelector('#chart-tooltip');
  const svg = container.querySelector('svg');

  const hide = () => {
    hoverLine.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };

  hoverArea.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const t = minX + ((px - pad.left) / (width - pad.left - pad.right)) * (maxX - minX);
    let nearest = points[0];
    for (const point of points) {
      if (Math.abs(point.timestamp - t) < Math.abs(nearest.timestamp - t)) nearest = point;
    }
    const cx = x(nearest.timestamp);
    const cy = y(nearest.equity);
    hoverLine.setAttribute('x1', cx);
    hoverLine.setAttribute('x2', cx);
    hoverLine.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', cx);
    hoverDot.setAttribute('cy', cy);
    hoverDot.setAttribute('visibility', 'visible');

    const diff = nearest.equity - base;
    const trade = trades.find((item) => Math.abs(item.cx - px) < 8);
    tooltip.innerHTML = `
      <div class="muted small">${fmtDateTime(nearest.timestamp)}</div>
      <b>${fmtMoney(nearest.equity)}</b>
      <span class="${diff >= 0 ? 'positive-text' : 'negative-text'}">${fmtSignedMoney(diff)}</span>
      ${trade ? `<div class="small">${escapeHtml(trade.title)}</div>` : ''}`;
    tooltip.style.left = `${(cx / width) * rect.width}px`;
    tooltip.style.top = `${(cy / height) * rect.height}px`;
    tooltip.hidden = false;
  });
  hoverArea.addEventListener('pointerleave', hide);
}

// ---------- Запуск ----------

function autoStopChoices(selected) {
  return AUTO_STOP_OPTIONS.map(
    (option) => `
      <label class="choice">
        <input type="radio" name="autostop" value="${option.value}" ${option.value === selected ? 'checked' : ''}/>
        <span><b>${option.label}</b><small class="muted" data-autostop-hint="${option.value}"></small></span>
      </label>`,
  ).join('');
}

function updateAutoStopHints() {
  const amount = Number(el.startForm.querySelector('#capital-input')?.value || 0);
  el.startForm.querySelectorAll('[data-autostop-hint]').forEach((hint) => {
    const pct = Number(hint.dataset.autostopHint);
    hint.textContent =
      pct === 0
        ? 'Бот не остановится сам'
        : amount > 0
          ? `Продать всё при ${fmtMoney(amount * (1 - pct))}`
          : '';
  });
}

function capitalField(label, value, hint) {
  return `
    <label class="field">
      <span class="field-label">${label}</span>
      <span class="money-input">
        <input id="capital-input" type="number" inputmode="decimal" min="${state.app.strategy.minCapital}" step="1" value="${value}" required/>
        <span>USDT</span>
      </span>
      <span class="field-hint" id="capital-hint">${hint}</span>
    </label>`;
}

function autoStopField() {
  return `
    <div class="field">
      <span class="field-label">Автозащита от больших потерь</span>
      <div class="choice-grid">${autoStopChoices(0.3)}</div>
      <span class="field-hint">На истории временные просадки доходили почти до половины капитала, после чего рынок восстанавливался. Слишком строгий порог может остановить бота раньше времени.</span>
    </div>`;
}

async function loadBalance(mode) {
  const info = el.startForm.querySelector('#balance-info');
  const input = el.startForm.querySelector('#capital-input');
  state.freeUsdt = null;
  if (!info) return;
  if (mode === 'paper') {
    info.hidden = true;
    return;
  }
  info.hidden = false;
  info.innerHTML = 'Проверяем баланс на Binance…';
  el.startConfirm.disabled = true;
  try {
    const result = await request(`/api/app/balance?mode=${mode}`);
    if (!result.success) throw new Error(result.message);
    state.freeUsdt = result.freeUsdt;
    info.innerHTML = `Свободно на ${mode === 'live_real' ? 'вашем аккаунте' : 'демо-счёте'} Binance: <b>${fmtMoney(result.freeUsdt)}</b>. Бот будет управлять только суммой, которую вы укажете.`;
    if (input && Number(input.value) > result.freeUsdt) {
      input.value = Math.floor(result.freeUsdt);
    }
    el.startConfirm.disabled = result.freeUsdt < state.app.strategy.minCapital;
    if (el.startConfirm.disabled) {
      info.innerHTML += `<br>Этого мало: минимум ${fmtMoney(state.app.strategy.minCapital)}.`;
    }
  } catch (error) {
    info.innerHTML = `<span class="form-error">${escapeHtml(error.message)}</span>`;
  }
  updateAutoStopHints();
}

function openStartDialog(kind) {
  const app = state.app;
  if (!app) return;
  state.startKind = kind;
  el.startError.hidden = true;
  el.startConfirm.disabled = false;
  el.startConfirm.hidden = false;
  el.startCancel.textContent = 'Отмена';

  if (kind === 'real' && !app.readiness.live_real.available) {
    el.startDialogTitle.textContent = 'Как подключить реальные деньги';
    el.startConfirm.hidden = true;
    el.startCancel.textContent = 'Понятно';
    el.startDialogContent.innerHTML = `
      <p>Чтобы бот мог торговать на вашем аккаунте, нужно один раз его подключить:</p>
      <ol class="setup-steps">
        <li>На сайте Binance откройте «Управление API» и создайте ключ. Разрешите только <b>спотовую торговлю</b>. Право вывода средств <b>не включайте</b>.</li>
        <li>Откройте файл <code>.env</code> в папке бота и добавьте строки:
          <span class="code-block">BINANCE_API_KEY=ваш_ключ
BINANCE_API_SECRET=ваш_секрет
BOT_ALLOW_LIVE_REAL=true</span></li>
        <li>Перезапустите бота и обновите эту страницу.</li>
      </ol>
      <div class="info-box">Сейчас не хватает: <b>${app.readiness.live_real.missing.map(escapeHtml).join('; ')}</b></div>
      <p>Пока можно запустить тестовый режим — он работает без подключения.</p>`;
    el.startDialog.showModal();
    return;
  }

  if (kind === 'real') {
    el.startDialogTitle.textContent = 'Запуск с реальными деньгами';
    el.startConfirm.textContent = 'Запустить с реальными деньгами';
    el.startConfirm.className = 'btn-danger';
    el.startDialogContent.innerHTML = `
      <div class="info-box" id="balance-info">Проверяем баланс на Binance…</div>
      ${capitalField('Сколько USDT доверить боту', 100, 'Остальные деньги на аккаунте бот не тронет.')}
      ${autoStopField()}
      <label class="consent">
        <input type="checkbox" id="consent-input"/>
        <span>Я понимаю, что бот торгует моими реальными деньгами, результат не гарантирован и возможны убытки.</span>
      </label>`;
    el.startDialog.showModal();
    void loadBalance('live_real');
  } else {
    const demoReady = app.readiness.live_testnet.available;
    el.startDialogTitle.textContent = 'Запуск в тестовом режиме';
    el.startConfirm.textContent = 'Начать тест';
    el.startConfirm.className = 'btn-primary';
    el.startDialogContent.innerHTML = `
      <p>Бот будет работать так же, как с настоящими деньгами, но деньги виртуальные. Цены — настоящие, с биржи Binance.</p>
      ${
        demoReady
          ? `<div class="field">
              <span class="field-label">Где тестировать</span>
              <div class="choice-grid">
                <label class="choice"><input type="radio" name="test-mode" value="paper" checked/><span><b>Виртуальный счёт</b><small class="muted">Рекомендуется</small></span></label>
                <label class="choice"><input type="radio" name="test-mode" value="live_testnet"/><span><b>Binance Demo</b><small class="muted">Демо-счёт биржи</small></span></label>
              </div>
            </div>
            <div class="info-box" id="balance-info" hidden></div>`
          : ''
      }
      ${capitalField('Сколько виртуальных денег дать боту', 1000, 'Можно любую сумму — это не настоящие деньги.')}
      ${autoStopField()}`;
    el.startDialog.showModal();
  }

  el.startForm.querySelector('#capital-input').addEventListener('input', updateAutoStopHints);
  el.startForm.querySelectorAll('input[name="test-mode"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      el.startConfirm.disabled = false;
      void loadBalance(radio.value);
    }),
  );
  updateAutoStopHints();
}

async function submitStart(event) {
  event.preventDefault();
  if (state.busy) return;
  const form = el.startForm;
  const amount = Number(form.querySelector('#capital-input')?.value);
  const autoStop = Number(form.querySelector('input[name="autostop"]:checked')?.value || 0);
  const mode =
    state.startKind === 'real'
      ? 'live_real'
      : form.querySelector('input[name="test-mode"]:checked')?.value || 'paper';
  const fail = (message) => {
    el.startError.textContent = message;
    el.startError.hidden = false;
  };

  if (!Number.isFinite(amount) || amount < state.app.strategy.minCapital) {
    fail(`Минимальная сумма — ${fmtMoney(state.app.strategy.minCapital)}`);
    return;
  }
  if (mode !== 'paper' && state.freeUsdt !== null && amount > state.freeUsdt) {
    fail(`На Binance свободно только ${fmtMoney(state.freeUsdt)}`);
    return;
  }
  if (mode === 'live_real' && !form.querySelector('#consent-input')?.checked) {
    fail('Подтвердите, что понимаете риски');
    return;
  }

  state.busy = true;
  el.startConfirm.disabled = true;
  const previousLabel = el.startConfirm.textContent;
  el.startConfirm.textContent = 'Запускаем…';
  try {
    const result = await request('/api/app/start', {
      method: 'POST',
      body: JSON.stringify({ mode, capitalUsdt: amount, autoStopLossPct: autoStop }),
    });
    if (!result.success) throw new Error(result.message);
    state.app = result.state;
    el.startDialog.close();
    render();
    showToast('Бот запущен. Первое решение уже принято — смотрите ниже.');
  } catch (error) {
    fail(error.message);
  } finally {
    state.busy = false;
    el.startConfirm.disabled = false;
    el.startConfirm.textContent = previousLabel;
  }
}

// ---------- Остановка ----------

function openStopDialog() {
  const session = state.app?.session;
  if (!session) return;
  el.stopError.hidden = true;
  el.stopDialogText.textContent =
    `Бот продаст все свои монеты в USDT и остановится. Сейчас у вас ${fmtMoney(session.equity)} ` +
    `(${fmtSignedMoney(session.profit)} с начала).` +
    (session.mode === 'paper' ? '' : ' Деньги останутся на вашем аккаунте Binance в USDT.');
  el.stopDialog.showModal();
}

async function submitStop(event) {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  el.stopConfirm.disabled = true;
  el.stopConfirm.textContent = 'Продаём…';
  try {
    const result = await request('/api/app/stop', { method: 'POST', body: '{}' });
    state.app = result.state;
    el.stopDialog.close();
    render();
    showToast(result.message);
  } catch (error) {
    el.stopError.textContent = error.message;
    el.stopError.hidden = false;
  } finally {
    state.busy = false;
    el.stopConfirm.disabled = false;
    el.stopConfirm.textContent = 'Да, остановить и продать всё';
  }
}

// ---------- События ----------

el.startTestBtn.addEventListener('click', () => openStartDialog('test'));
el.startRealBtn.addEventListener('click', () => openStartDialog('real'));
el.startCancel.addEventListener('click', () => el.startDialog.close());
el.startForm.addEventListener('submit', submitStart);
el.stopBtn.addEventListener('click', openStopDialog);
el.stopCancel.addEventListener('click', () => el.stopDialog.close());
el.stopForm.addEventListener('submit', submitStop);

el.rangeButtons.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button) return;
  state.range = button.dataset.range;
  el.rangeButtons
    .querySelectorAll('button')
    .forEach((item) => item.classList.toggle('active', item === button));
  renderChart();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChart, 150);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

setInterval(() => {
  if (!document.hidden && !el.startDialog.open && !el.stopDialog.open) {
    void refresh();
  }
}, 5000);

void refresh();
