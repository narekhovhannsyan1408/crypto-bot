// Отрисовка состояния бота. Функции получают данные и обновляют DOM — без побочных запросов.

import {
  clamp,
  dayHeading,
  dayKey,
  escapeHtml,
  fmtDateTime,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtShortDate,
  fmtSignedMoney,
  fmtTime,
  humanDuration,
  plural,
} from './format.js';

const $ = (id) => document.getElementById(id);

export const el = {
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  offline: $('offline-banner'),
  loading: $('loading-view'),
  startView: $('start-view'),
  heroTitle: $('hero-title'),
  heroLead: $('hero-lead'),
  startTestBtn: $('start-test-btn'),
  startRealBtn: $('start-real-btn'),
  sessionView: $('session-view'),
  modeTag: $('mode-tag'),
  summaryLabel: $('summary-label'),
  equityValue: $('equity-value'),
  profitValue: $('profit-value'),
  benchmark: $('benchmark'),
  summaryMeta: $('summary-meta'),
  stopBtn: $('stop-btn'),
  protection: $('protection'),
  stoppedNote: $('stopped-note'),
  botError: $('bot-error'),
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
  showMore: $('show-more'),
  historyCard: $('history-card'),
  historyBody: $('history-body'),
};

const DEFAULT_HERO = {
  title: el.heroTitle.textContent,
  lead: el.heroLead.textContent,
};
const SHORT_MODE = {
  paper: 'Тест',
  live_testnet: 'Демо',
  live_real: 'Реальные деньги',
};
const ASSET_COLORS = {
  BTC: 'var(--btc)',
  ETH: 'var(--eth)',
  USDT: 'var(--usdt)',
};
const EVENT_ICONS = {
  buy: '↗',
  sell: '↘',
  start: '▶',
  stop: '■',
  autostop: '🛡',
  check: '✓',
  error: '!',
};

export function renderApp(app) {
  const session = app.session;
  const running = app.status === 'running';

  el.loading.hidden = true;
  renderHeader(app, session, running);
  renderStartView(app);

  el.sessionView.hidden = !session;
  if (session) {
    renderSummary(session, running);
    renderBotError(app, running);
    renderNow(session, running);
    renderActivity(session);
  }
  renderHistory(app.history, session);
}

function renderHeader(app, session, running) {
  if (running) {
    el.statusPill.dataset.tone = session.mode === 'live_real' ? 'real' : 'test';
    el.statusText.textContent = `Работает · ${SHORT_MODE[session.mode] ?? session.modeLabel}`;
    document.title = `${fmtMoney(session.equity)} · Крипто-бот`;
  } else {
    el.statusPill.dataset.tone = 'muted';
    el.statusText.textContent =
      app.status === 'stopped' ? 'Остановлен' : 'Не запущен';
    document.title = 'Крипто-бот';
  }
}

function renderStartView(app) {
  const running = app.status === 'running';
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

  el.startRealBtn.querySelector('.start-sub').textContent = app.readiness
    .live_real.available
    ? 'Бот торгует на вашем аккаунте Binance. Возможны убытки — вкладывайте только то, что готовы потерять.'
    : 'Сначала нужно подключить аккаунт Binance — нажмите, и мы покажем, как это сделать.';
}

function renderSummary(session, running) {
  const real = session.mode === 'live_real';
  el.modeTag.textContent = real
    ? 'Реальные деньги · Binance'
    : session.mode === 'live_testnet'
      ? 'Демо-счёт Binance · деньги ненастоящие'
      : 'Тестовый режим · деньги виртуальные';
  el.modeTag.dataset.tone = real ? 'real' : 'test';

  el.summaryLabel.textContent = running ? 'Сейчас у вас' : 'Итог запуска';
  el.equityValue.textContent = fmtMoney(session.equity);

  const tone =
    session.profit > 0.005
      ? 'positive'
      : session.profit < -0.005
        ? 'negative'
        : 'neutral';
  const arrow = tone === 'positive' ? '▲' : tone === 'negative' ? '▼' : '•';
  el.profitValue.className = `delta ${tone}`;
  el.profitValue.textContent = `${arrow} ${fmtSignedMoney(session.profit)} (${fmtPct(session.profitPct)}) ${running ? 'с начала' : 'за запуск'}`;

  el.benchmark.hidden = !session.benchmark;
  if (session.benchmark) {
    const diff = session.equity - session.benchmark.equity;
    const verdict =
      Math.abs(diff) < session.initialCapital * 0.002
        ? 'примерно столько же, сколько у бота'
        : diff > 0
          ? `бот впереди на ${fmtMoney(diff)}`
          : `бот позади на ${fmtMoney(-diff)}`;
    el.benchmark.innerHTML = `Для сравнения: если бы просто купили ${escapeHtml(
      session.assets.map((asset) => asset.base).join(' и '),
    )} на старте — <b>${fmtMoney(session.benchmark.equity)}</b> (${fmtPct(session.benchmark.profitPct)}), ${verdict}.`;
  }

  const period = running
    ? `работает ${humanDuration(Date.now() - session.startedAt)}`
    : `${fmtDateTime(session.startedAt)} — ${fmtDateTime(session.stoppedAt)}`;
  const fees =
    session.feesPaid > 0
      ? ` · комиссии биржи ${fmtMoney(session.feesPaid)}`
      : '';
  el.summaryMeta.textContent = `Начали с ${fmtMoney(session.initialCapital)} · ${period}${fees}`;

  el.stopBtn.hidden = !running;
  el.protection.hidden = !running;
  el.stoppedNote.hidden = running;

  if (!running) {
    el.stoppedNote.textContent = `Бот остановлен ${fmtDateTime(session.stoppedAt)}. ${session.stopReason || ''}`;
    return;
  }

  if (session.autoStopEquity === null) {
    el.protection.innerHTML =
      'Автозащита выключена: бот не остановится сам при убытке. Остановить его можно кнопкой выше.';
    return;
  }

  const cushion = session.equity - session.autoStopEquity;
  const ratio = clamp(
    cushion / (session.initialCapital - session.autoStopEquity),
    0,
    1,
  );
  const meterClass = ratio < 0.2 ? 'danger' : ratio < 0.5 ? 'warn' : '';
  el.protection.innerHTML = `
    🛡 <b>Автозащита включена.</b> Если капитал опустится до <b>${fmtMoney(session.autoStopEquity)}</b>
    (−${Math.round(session.autoStopLossPct * 100)}% от старта), бот сам продаст всё и остановится.
    Запас: <b>${fmtMoney(Math.max(cushion, 0))}</b>.
    <div class="meter ${meterClass}" role="progressbar" aria-label="Запас до автозащиты"
      aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}">
      <span style="width:${(ratio * 100).toFixed(1)}%"></span>
    </div>`;
}

function renderBotError(app, running) {
  el.botError.hidden = !(running && app.lastError);
  if (running && app.lastError) {
    el.botError.innerHTML = `<b>Бот не смог связаться с биржей.</b> ${escapeHtml(
      app.lastError,
    )}. Он повторит попытку сам — делать ничего не нужно. Если сообщение не пропадает долго, проверьте интернет.`;
  }
}

function trendClass(votes, total) {
  if (votes === null || votes === undefined) return 'none';
  if (votes === total) return 'up';
  if (votes / total >= 0.5) return 'mid';
  return 'down';
}

function renderNow(session, running) {
  el.nowTitle.textContent = running
    ? 'Что сейчас делает бот'
    : 'Где были деньги в конце';

  const invested = session.assets.filter((asset) => asset.weightPct >= 1);
  if (running && session.lastDecisionDay === null) {
    el.nowSummary.textContent =
      'Бот анализирует рынок и принимает первое решение…';
  } else if (invested.length === 0) {
    el.nowSummary.textContent = running
      ? 'Все деньги в USDT: рынок сейчас не растёт, бот ждёт восходящего тренда.'
      : 'Все монеты проданы, деньги в USDT.';
  } else {
    const parts = invested.map(
      (asset) => `${Math.round(asset.weightPct)}% в ${asset.name}`,
    );
    const cash = Math.round(session.cashWeightPct);
    el.nowSummary.textContent = `Держит ${parts.join(' и ')}${cash >= 1 ? `, ${cash}% в USDT` : ''}.`;
  }

  const segments = [
    ...session.assets.map((asset) => ({
      key: asset.base,
      label: asset.name,
      pct: asset.weightPct,
    })),
    { key: 'USDT', label: 'USDT', pct: session.cashWeightPct },
  ];
  el.allocBar.innerHTML = segments
    .filter((segment) => segment.pct > 0.05)
    .map(
      (segment) =>
        `<span style="width:${segment.pct}%;background:${ASSET_COLORS[segment.key] ?? 'var(--accent)'}" title="${escapeHtml(segment.label)}: ${segment.pct}%"></span>`,
    )
    .join('');
  el.allocLegend.innerHTML = segments
    .map(
      (segment) =>
        `<span><i style="background:${ASSET_COLORS[segment.key] ?? 'var(--accent)'}"></i>${escapeHtml(segment.label)} ${Math.round(segment.pct)}%</span>`,
    )
    .join('');

  const rows = session.assets.map((asset) => {
    const hasSignal = asset.targetWeightPct !== null;
    const badge = hasSignal
      ? `<span class="trend-badge ${trendClass(asset.trendVotes, asset.trendTotal)}" title="Цена выше ${asset.trendVotes} из ${asset.trendTotal} средних">${escapeHtml(asset.trendLabel)} · ${asset.trendVotes}/${asset.trendTotal}</span>`
      : '<span class="trend-badge none">Ждёт анализа</span>';
    const course = asset.price ? ` · курс ${fmtPrice(asset.price)}` : '';
    const holding =
      asset.quantity > 0
        ? `${fmtQty(asset.quantity)} ${escapeHtml(asset.base)}${course}`
        : `Не куплен${course}`;
    return `
      <div class="asset">
        <span class="asset-icon" style="background:${ASSET_COLORS[asset.base] ?? 'var(--accent)'}">${escapeHtml(asset.base)}</span>
        <div class="asset-name">${escapeHtml(asset.name)}${badge}</div>
        <div class="asset-value">${fmtMoney(asset.value)}</div>
        <div class="asset-sub">${holding}</div>
        <div class="asset-sub asset-target">${hasSignal ? `цель ${Math.round(asset.targetWeightPct)}%` : ''}</div>
      </div>`;
  });
  rows.push(`
    <div class="asset">
      <span class="asset-icon" style="background:${ASSET_COLORS.USDT}">$</span>
      <div class="asset-name">Доллары (USDT)</div>
      <div class="asset-value">${fmtMoney(session.cash)}</div>
      <div class="asset-sub">Свободные деньги бота</div>
      <div class="asset-sub asset-target"></div>
    </div>`);
  el.assetList.innerHTML = rows.join('');

  el.nextDecision.hidden = !running || !session.nextDecisionAt;
  if (running && session.nextDecisionAt) {
    const next = new Date(session.nextDecisionAt);
    const day =
      next.toDateString() === new Date().toDateString() ? 'сегодня' : 'завтра';
    const prices = session.pricesStale
      ? ` <span class="warning-text">⚠ Цены не обновлялись с ${fmtTime(session.pricesUpdatedAt ?? Date.now())} — проверьте интернет.</span>`
      : session.pricesUpdatedAt
        ? ` Цены обновлены в ${fmtTime(session.pricesUpdatedAt)}.`
        : '';
    el.nextDecision.innerHTML = `Следующее решение: <b>${day} около ${fmtTime(session.nextDecisionAt)}</b> (через ${humanDuration(session.nextDecisionAt - Date.now())}). Между решениями бот следит за ценами и автозащитой.${prices}`;
  }
}

function renderActivity(session) {
  const items = session.activity;
  el.activityCount.textContent = `${session.activityTotal} ${plural(session.activityTotal, ['событие', 'события', 'событий'])}`;
  el.showMore.hidden = items.length >= session.activityTotal;

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
      html.push(
        `<li class="day">${escapeHtml(dayHeading(entry.timestamp))}</li>`,
      );
    }
    let facts = '';
    if (
      (entry.kind === 'buy' || entry.kind === 'sell') &&
      entry.quantity !== undefined
    ) {
      const base = entry.symbol ? entry.symbol.replace(/USDT$/, '') : '';
      facts = `<div class="event-facts">${fmtQty(entry.quantity)} ${escapeHtml(base)} по ${fmtPrice(entry.price)} · ${entry.kind === 'buy' ? 'потрачено' : 'получено'} ${fmtMoney(entry.quoteAmount)} · комиссия ${fmtMoney(entry.fee || 0)}</div>`;
    }
    html.push(`
      <li class="event">
        <span class="event-icon ${escapeHtml(entry.kind)}" aria-hidden="true">${EVENT_ICONS[entry.kind] ?? '•'}</span>
        <div>
          <div class="event-title">${escapeHtml(entry.title)}</div>
          ${entry.details ? `<div class="event-details">${escapeHtml(entry.details)}</div>` : ''}
          ${facts}
        </div>
        <time class="event-time" datetime="${new Date(entry.timestamp).toISOString()}">${fmtTime(entry.timestamp)}</time>
      </li>`);
  }
  el.activity.innerHTML = html.join('');
}

function renderHistory(history, session) {
  const rows = (history ?? []).filter(
    (item) => !session || item.id !== session.id,
  );
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
