// Расширенный режим: подробности решений, графики капитала и просадки, журнал,
// живой системный лог (WebSocket) и панели внутридневного режима.

import { renderIntraday } from './advanced-intraday.js';
import { api } from './api.js';
import {
  drawdownSeries,
  renderDrawdownChart,
  renderEquityChart,
} from './chart.js';
import {
  ASSET_COLORS,
  CLUSTER_NAMES,
  historyRows,
  REAL_MODES,
  renderTimeline,
  trendClass,
  trendKey,
} from './common.js';
import {
  escapeHtml,
  explorerAddressUrl,
  explorerTxUrl,
  fmtDateTime,
  fmtMoney,
  fmtNumber,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtSignedMoney,
  fmtTime,
  fmtUtcDay,
  humanDuration,
  shortAddress,
} from './format.js';
import {
  initI18n,
  mountLangSwitch,
  onLangChange,
  t,
  th,
  tm,
} from './i18n.js';

const POLL_MS = 5_000;
const OFFLINE_POLL_MS = 10_000;
const HIDDEN_POLL_MS = 60_000;
const JOURNAL_PAGE = 60;
const MAX_LOGS = 200;

const $ = (id) => document.getElementById(id);
const el = {
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  offline: $('offline-banner'),
  loading: $('loading-view'),
  allocatorView: $('allocator-view'),
  intradayView: $('intraday-view'),
  idle: $('idle-view'),
  sessionCard: $('session-card'),
  modeTag: $('mode-tag'),
  facts: $('session-facts'),
  rebalanceBtn: $('rebalance-btn'),
  stopBtn: $('stop-btn'),
  botError: $('bot-error'),
  kpis: $('kpis'),
  chartsCard: $('charts-card'),
  rangeButtons: $('range-buttons'),
  equityChart: $('equity-chart'),
  drawdownChart: $('drawdown-chart'),
  drawdownNow: $('drawdown-now'),
  signalsCard: $('signals-card'),
  signalsSub: $('signals-sub'),
  signalsTable: $('signals-table'),
  allocationCard: $('allocation-card'),
  chainCard: $('chain-card'),
  allocCompare: $('alloc-compare'),
  allocLegend: $('alloc-legend'),
  chainInfo: $('chain-info'),
  params: $('params'),
  journalCard: $('journal-card'),
  journalFilters: $('journal-filters'),
  journal: $('journal'),
  journalMore: $('journal-more'),
  historyCard: $('history-card'),
  historyBody: $('history-body'),
  socketStatus: $('socket-status'),
  socketText: $('socket-text'),
  logFilters: $('log-filters'),
  logSearch: $('log-search'),
  logs: $('logs'),
  toast: $('toast'),
  confirm: {
    dialog: $('confirm-dialog'),
    form: $('confirm-form'),
    title: $('confirm-title'),
    text: $('confirm-text'),
    phraseField: $('confirm-phrase-field'),
    phraseLabel: $('confirm-phrase-label'),
    phrase: $('confirm-phrase'),
    error: $('confirm-error'),
    cancel: $('confirm-cancel'),
    ok: $('confirm-ok'),
  },
};

const state = {
  app: null,
  range: 'all',
  chart: null,
  chartKey: null,
  fullChart: null,
  fullChartKey: null,
  journalFilter: 'all',
  journalLimit: JOURNAL_PAGE,
  refreshing: false,
  refreshAgain: false,
  failures: 0,
  busy: false,
  runtime: null,
  logs: [],
  trades: [],
  logFilter: 'all',
  logSearch: '',
  openLogs: new Set(),
  socket: null,
};

// ---------- Общее ----------

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 5_000);
}

/** Модальное подтверждение; phrase — фраза, которую нужно ввести для опасных действий. */
function confirmAction({ title, text, okLabel, phrase = null }) {
  const c = el.confirm;
  c.title.textContent = title;
  c.text.textContent = text;
  c.ok.textContent = okLabel;
  c.error.hidden = true;
  c.phraseField.hidden = !phrase;
  c.phrase.value = '';
  if (phrase) {
    c.phraseLabel.textContent = t('adv.confirm.typePhrase', { phrase });
  }
  c.dialog.showModal();
  if (phrase) c.phrase.focus();
  return new Promise((resolve) => {
    const finish = (result) => {
      c.form.removeEventListener('submit', onSubmit);
      c.cancel.removeEventListener('click', onCancel);
      c.dialog.removeEventListener('close', onClose);
      if (c.dialog.open) c.dialog.close();
      resolve(result);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      if (phrase && c.phrase.value.trim() !== phrase) {
        c.error.textContent = t('adv.confirm.phraseMismatch');
        c.error.hidden = false;
        return;
      }
      finish(true);
    };
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    c.form.addEventListener('submit', onSubmit);
    c.cancel.addEventListener('click', onCancel);
    c.dialog.addEventListener('close', onClose);
  });
}

const fact = (labelKey, value) => `
  <div class="fact">
    <span class="fact-label">${escapeHtml(t(labelKey))}</span>
    <span class="fact-value">${value}</span>
  </div>`;

const kpi = (labelKey, value, sub = '', tone = '') => `
  <div class="kpi ${tone}">
    <div class="kpi-label">${escapeHtml(t(labelKey))}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;

const kvRow = (labelKey, value) =>
  `<div class="kv-row"><span>${escapeHtml(t(labelKey))}</span><strong>${value}</strong></div>`;

const link = (href, text) =>
  `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)} ↗</a>`;

const toneOf = (value, epsilon = 0.005) =>
  value > epsilon ? 'positive' : value < -epsilon ? 'negative' : '';

// ---------- Шапка ----------

function renderHeader(app) {
  const session = app.session;
  if (app.status === 'running') {
    el.statusPill.dataset.tone = REAL_MODES.has(session.mode) ? 'real' : 'test';
    el.statusText.textContent = t('status.running', {
      mode: t(`mode.short.${session.mode}`),
    });
    document.title = `${fmtMoney(session.equity)} · ${t('app.advancedTitle')}`;
  } else {
    el.statusPill.dataset.tone = 'muted';
    el.statusText.textContent = t(
      app.status === 'stopped' ? 'status.stopped' : 'status.idle',
    );
    document.title = t('app.advancedTitle');
  }
}

// ---------- Сессия и KPI ----------

function renderSession(app) {
  const session = app.session;
  const running = app.status === 'running';
  el.idle.hidden = Boolean(session);
  el.sessionCard.hidden = !session;
  if (!session) return;

  el.modeTag.textContent = t(`mode.tag.${session.mode}`);
  el.modeTag.dataset.tone = REAL_MODES.has(session.mode) ? 'real' : 'test';
  const facts = [
    fact('adv.session.started', escapeHtml(fmtDateTime(session.startedAt))),
    running
      ? fact(
          'adv.session.uptime',
          escapeHtml(humanDuration(Date.now() - session.startedAt)),
        )
      : fact('adv.session.stopped', escapeHtml(fmtDateTime(session.stoppedAt))),
    fact(
      'adv.session.lastDecision',
      session.lastDecisionDay
        ? escapeHtml(fmtUtcDay(session.lastDecisionDay))
        : '—',
    ),
  ];
  if (running && session.nextDecisionAt) {
    facts.push(
      fact(
        'adv.session.nextDecision',
        escapeHtml(
          t('adv.session.inDuration', {
            time: fmtTime(session.nextDecisionAt),
            duration: humanDuration(session.nextDecisionAt - Date.now()),
          }),
        ),
      ),
    );
  }
  if (running) {
    facts.push(
      fact(
        'adv.session.prices',
        session.pricesStale
          ? `<span class="warning-text">⚠ ${escapeHtml(fmtTime(session.pricesUpdatedAt ?? Date.now()))}</span>`
          : session.pricesUpdatedAt
            ? escapeHtml(fmtTime(session.pricesUpdatedAt))
            : '—',
      ),
    );
  }
  el.facts.innerHTML = facts.join('');
  el.rebalanceBtn.hidden = !running;
  el.stopBtn.hidden = !running;

  el.botError.hidden = !(running && app.lastError);
  if (running && app.lastError) {
    el.botError.innerHTML = th('botError.text', {
      venue: t(session.venue === 'Solana' ? 'venue.solana' : 'venue.exchange'),
      detail: tm(app.lastError),
    });
  }
}

function renderKpis(app) {
  const session = app.session;
  if (!session) {
    el.kpis.innerHTML = '';
    return;
  }
  const tiles = [
    kpi(
      'adv.kpi.capital',
      fmtMoney(session.equity),
      escapeHtml(t('adv.kpi.capitalSub', { amount: fmtMoney(session.initialCapital) })),
    ),
    kpi(
      'adv.kpi.result',
      fmtSignedMoney(session.profit),
      escapeHtml(fmtPct(session.profitPct)),
      toneOf(session.profit),
    ),
  ];
  if (session.benchmark) {
    const diff = session.equity - session.benchmark.equity;
    tiles.push(
      kpi(
        'adv.kpi.vsHold',
        fmtSignedMoney(diff),
        escapeHtml(
          t('adv.kpi.vsHoldSub', {
            pct: fmtPct(session.benchmark.profitPct),
          }),
        ),
        toneOf(diff),
      ),
    );
  }
  const points = state.fullChart?.points ?? [];
  if (points.length > 1) {
    const series = drawdownSeries([
      ...points,
      { timestamp: app.generatedAt, equity: session.equity },
    ]);
    const worst = Math.min(...series.map((item) => item.pct));
    const now = series[series.length - 1].pct;
    tiles.push(
      kpi(
        'adv.kpi.maxDrawdown',
        fmtPct(worst),
        escapeHtml(t('adv.kpi.drawdownNow', { pct: fmtPct(now) })),
        worst < -0.05 ? 'warning' : '',
      ),
    );
  }
  tiles.push(
    kpi(
      'adv.kpi.cash',
      fmtMoney(session.cash),
      escapeHtml(
        t('adv.kpi.cashSub', {
          pct: fmtNumber(session.cashWeightPct, 1),
          quote: session.quoteAsset,
        }),
      ),
    ),
    kpi(
      'adv.kpi.fees',
      fmtMoney(session.feesPaid),
      escapeHtml(
        t(session.venue === 'Solana' ? 'adv.kpi.feesNetwork' : 'adv.kpi.feesExchange', {
          count: state.fullChart?.trades?.length ?? 0,
        }),
      ),
    ),
  );
  el.kpis.innerHTML = tiles.join('');
}

// ---------- Графики ----------

function drawCharts() {
  const session = state.app?.session;
  el.chartsCard.hidden = !session;
  if (!session || !state.chart) return;
  const livePoint = session.stoppedAt
    ? null
    : { timestamp: state.app.generatedAt, equity: session.equity };
  renderEquityChart(el.equityChart, state.chart, livePoint);
  renderDrawdownChart(el.drawdownChart, state.chart, livePoint);
  const points = [...state.chart.points, ...(livePoint ? [livePoint] : [])];
  const series = points.length > 1 ? drawdownSeries(points) : [];
  el.drawdownNow.textContent = series.length
    ? t('adv.kpi.drawdownNow', { pct: fmtPct(series[series.length - 1].pct) })
    : '';
}

async function syncCharts() {
  const session = state.app?.session;
  if (!session) return;
  const version = session.chartVersion;
  try {
    if (`${version}|all` !== state.fullChartKey) {
      state.fullChart = await api.chart('all');
      state.fullChartKey = `${version}|all`;
      renderKpis(state.app);
    }
    const range = state.range;
    const key = `${version}|${range}`;
    if (key !== state.chartKey) {
      const chart = range === 'all' ? state.fullChart : await api.chart(range);
      // Пока шёл запрос, могли выбрать другой период: старый ответ не рисуем
      if (range !== state.range) return;
      state.chart = chart;
      state.chartKey = key;
    }
  } catch {
    // оставляем прошлые данные, следующий опрос попробует снова
  }
  drawCharts();
}

// ---------- Сигналы ----------

function renderSignals(app) {
  const session = app.session;
  el.signalsCard.hidden = !session;
  if (!session) return;
  const periods = app.strategy.smaPeriods;
  const signals = session.signals ?? [];
  el.signalsSub.textContent = signals.length
    ? t('adv.signals.sub', { day: fmtUtcDay(signals[0].day) })
    : t('adv.signals.pending');

  const head = `
    <thead><tr>
      <th>${escapeHtml(t('adv.signals.asset'))}</th>
      <th class="num">${escapeHtml(t('adv.signals.close'))}</th>
      ${periods.map((period) => `<th>${escapeHtml(t('adv.signals.sma', { period }))}</th>`).join('')}
      <th>${escapeHtml(t('adv.signals.trend'))}</th>
      <th>${escapeHtml(t('adv.signals.weight'))}</th>
      <th class="num">${escapeHtml(t('adv.signals.holding'))}</th>
    </tr></thead>`;

  const rows = session.assets.map((asset) => {
    const signal = signals.find((item) => item.symbol === asset.symbol);
    const token = app.solana.tokens.find((item) => item.base === asset.base);
    const assetCell = `
      <div class="asset-cell">
        <span class="asset-icon" style="background:${ASSET_COLORS[asset.base] ?? 'var(--accent)'}">${escapeHtml(asset.base)}</span>
        <span>${escapeHtml(asset.name)}${
          session.venue === 'Solana' && token
            ? `<small>${escapeHtml(t('adv.signals.onSolana', { token: token.symbol }))}</small>`
            : ''
        }</span>
      </div>`;
    if (!signal) {
      return `<tr><td>${assetCell}</td><td class="num">—</td>${periods.map(() => '<td>—</td>').join('')}<td><span class="trend-badge none">${escapeHtml(t('asset.waiting'))}</span></td><td>—</td><td class="num">—</td></tr>`;
    }
    const smaCells = signal.sma
      .map((sma) => {
        if (sma.value === null) return '<td>—</td>';
        const distance = (signal.close / sma.value - 1) * 100;
        return `
          <td>
            <div class="sma-cell">
              <span class="sma-chip ${sma.above ? 'above' : 'below'}">${sma.above ? '▲' : '▼'} ${escapeHtml(fmtPct(distance))}</span>
              <span class="sma-value">${escapeHtml(fmtPrice(sma.value))}</span>
            </div>
          </td>`;
      })
      .join('');
    const votes = Array.from(
      { length: signal.total },
      (_, index) => `<i class="${index < signal.votes ? 'on' : ''}"></i>`,
    ).join('');
    const target = signal.targetWeightPct;
    const current = asset.weightPct;
    return `
      <tr>
        <td>${assetCell}</td>
        <td class="num">${escapeHtml(fmtPrice(signal.close))}</td>
        ${smaCells}
        <td>
          <span class="trend-badge ${trendClass(signal.votes, signal.total)}">${escapeHtml(t(trendKey(signal.votes, signal.total)))} · ${signal.votes}/${signal.total}</span>
          <div class="votes" aria-hidden="true">${votes}</div>
        </td>
        <td class="weight-cell">
          <span class="small">${escapeHtml(t('adv.signals.weightValue', { current: fmtNumber(current, 1), target: fmtNumber(target, 1) }))}</span>
          <div class="weight-bar" title="${escapeHtml(t('adv.signals.weightValue', { current: fmtNumber(current, 1), target: fmtNumber(target, 1) }))}">
            <span class="current" style="width:${Math.min(current, 100)}%"></span>
            <span class="target" style="left:calc(${Math.min(target, 100)}% - 1px)"></span>
          </div>
        </td>
        <td class="num">
          <div>${escapeHtml(fmtMoney(asset.value))}</div>
          <div class="small muted">${asset.quantity > 0 ? escapeHtml(`${fmtQty(asset.quantity)} ${asset.base}`) : '—'}</div>
        </td>
      </tr>`;
  });
  el.signalsTable.innerHTML = `${head}<tbody>${rows.join('')}</tbody>`;
}

// ---------- Распределение и on-chain ----------

function allocationBar(segments) {
  return `<div class="alloc-bar">${segments
    .filter((segment) => segment.pct > 0.05)
    .map(
      (segment) =>
        `<span style="width:${segment.pct}%;background:${ASSET_COLORS[segment.key] ?? 'var(--accent)'}" title="${escapeHtml(segment.label)}: ${fmtNumber(segment.pct, 1)}%"></span>`,
    )
    .join('')}</div>`;
}

function renderAllocation(app) {
  const session = app.session;
  el.allocationCard.hidden = !session;
  el.chainCard.hidden = !session;
  if (!session) return;
  const quote = session.quoteAsset;
  const now = [
    ...session.assets.map((asset) => ({
      key: asset.base,
      label: asset.name,
      pct: asset.weightPct,
    })),
    { key: quote, label: quote, pct: session.cashWeightPct },
  ];
  const targets = session.assets.map((asset) => ({
    key: asset.base,
    label: asset.name,
    pct: asset.targetWeightPct ?? 0,
  }));
  const targetCash = Math.max(
    100 - targets.reduce((sum, item) => sum + item.pct, 0),
    0,
  );
  const hasTarget = session.assets.some((asset) => asset.targetWeightPct !== null);
  el.allocCompare.innerHTML = `
    <div class="alloc-row"><span class="alloc-row-label">${escapeHtml(t('adv.alloc.now'))}</span>${allocationBar(now)}</div>
    <div class="alloc-row"><span class="alloc-row-label">${escapeHtml(t('adv.alloc.target'))}</span>${
      hasTarget
        ? allocationBar([...targets, { key: quote, label: quote, pct: targetCash }])
        : `<span class="small muted">${escapeHtml(t('adv.signals.pending'))}</span>`
    }</div>`;
  el.allocLegend.innerHTML = now
    .map(
      (segment) =>
        `<span><i style="background:${ASSET_COLORS[segment.key] ?? 'var(--accent)'}"></i>${escapeHtml(segment.label)} ${fmtNumber(segment.pct, 1)}%</span>`,
    )
    .join('');

  const solana = app.solana;
  const proof = solana.proof;
  const rows = [
    kvRow(
      'adv.chain.venue',
      escapeHtml(t(session.venue === 'Solana' ? 'adv.chain.venueSolana' : 'adv.chain.venueBinance')),
    ),
    kvRow('adv.chain.mode', escapeHtml(t(`mode.label.${session.mode}`))),
    kvRow('adv.chain.quote', escapeHtml(quote)),
  ];
  if (session.venue === 'Solana') {
    rows.push(
      kvRow(
        'adv.chain.slippage',
        escapeHtml(t('adv.chain.slippageValue', { bps: app.strategy.params.slippageBps })),
      ),
    );
    if (session.mode === 'solana_real' && solana.walletAddress) {
      rows.push(
        kvRow(
          'adv.chain.wallet',
          link(explorerAddressUrl(solana.walletAddress), shortAddress(solana.walletAddress)),
        ),
      );
    }
    for (const token of solana.tokens) {
      rows.push(
        `<div class="kv-row"><span>${escapeHtml(`${token.base} → ${token.symbol}`)}</span><strong class="mono">${link(explorerAddressUrl(token.mint), shortAddress(token.mint))}</strong></div>`,
      );
    }
  }
  // В строке — короткий статус; подробности проблемы и что делать — отдельным блоком ниже
  rows.push(
    kvRow(
      'adv.chain.proof',
      proof.enabled && proof.address
        ? `<span class="badge success">${escapeHtml(t('adv.chain.proofOn', { cluster: CLUSTER_NAMES[proof.cluster] ?? proof.cluster }))}</span>`
        : proof.enabled && proof.problem
          ? `<span class="badge warning">${escapeHtml(t('adv.chain.proofNeedsSetup'))}</span>`
          : `<span class="badge">${escapeHtml(t('adv.chain.proofOff'))}</span>`,
    ),
  );
  if (proof.address) {
    rows.push(
      kvRow(
        'adv.chain.proofWallet',
        link(explorerAddressUrl(proof.address, proof.cluster), shortAddress(proof.address)),
      ),
    );
  }
  const lastProof = session.activity.find((entry) => entry.kind === 'proof' && entry.chainTx);
  if (lastProof) {
    rows.push(
      kvRow(
        'adv.chain.lastProof',
        link(explorerTxUrl(lastProof.chainTx), fmtDateTime(lastProof.timestamp)),
      ),
    );
  }
  if (proof.enabled && proof.problem) {
    rows.push(
      `<div class="chain-problem"><b>${escapeHtml(tm(proof.problem))}</b><span>${th('adv.chain.proofSetup')}</span></div>`,
    );
  } else if (!proof.enabled) {
    rows.push(`<p class="small muted chain-hint">${th('adv.chain.proofHow')}</p>`);
  }
  el.chainInfo.innerHTML = rows.join('');
}

function renderParams(app) {
  const params = app.strategy.params;
  const items = [
    ['adv.params.assets', app.strategy.assets.map((asset) => asset.base).join(' · ')],
    ['adv.params.sma', t('adv.params.smaValue', { periods: app.strategy.smaPeriods.join(' · ') })],
    ['adv.params.decision', t('adv.params.decisionValue')],
    ['adv.params.threshold', t('adv.params.thresholdValue', { pct: fmtNumber(params.rebalanceThresholdPct * 100, 1) })],
    ['adv.params.minOrder', fmtMoney(params.minOrderUsdt)],
    ['adv.params.check', t('adv.params.checkValue', { duration: humanDuration(params.checkIntervalMs) })],
    [
      'adv.params.volTarget',
      params.volTarget > 0
        ? t('adv.params.volTargetValue', { pct: fmtNumber(params.volTarget * 100, 0) })
        : t('adv.params.off'),
    ],
    ['adv.params.minCapital', fmtMoney(app.strategy.minCapital)],
  ];
  el.params.innerHTML = items
    .map(
      ([key, value]) => `
      <div class="param">
        <span class="param-label">${escapeHtml(t(key))}</span>
        <span class="param-value">${escapeHtml(value)}</span>
      </div>`,
    )
    .join('');
}

// ---------- Журнал решений ----------

const JOURNAL_FILTERS = {
  all: () => true,
  trades: (entry) => entry.kind === 'buy' || entry.kind === 'sell',
  checks: (entry) => entry.kind === 'check',
  onchain: (entry) => Boolean(entry.chainTx),
  errors: (entry) => entry.kind === 'error' || entry.kind === 'autostop',
};

function renderJournal(app) {
  const session = app.session;
  el.journalCard.hidden = !session;
  if (!session) return;
  const items = session.activity;
  el.journalFilters.innerHTML = Object.entries(JOURNAL_FILTERS)
    .map(([key, test]) => {
      const count = items.filter(test).length;
      return `<button type="button" class="chip ${state.journalFilter === key ? 'active' : ''}" data-filter="${key}" aria-pressed="${state.journalFilter === key}">${escapeHtml(t(`adv.journal.filter.${key}`))}<span class="count">${count}</span></button>`;
    })
    .join('');
  const filtered = items.filter(JOURNAL_FILTERS[state.journalFilter]);
  el.journal.innerHTML = renderTimeline(filtered, session.venue);
  el.journalMore.hidden = items.length >= session.activityTotal;
}

function renderHistory(app) {
  const rows = (app.history ?? []).filter(
    (item) => !app.session || item.id !== app.session.id,
  );
  el.historyCard.hidden = rows.length === 0;
  el.historyBody.innerHTML = historyRows(rows);
}

// ---------- Системный журнал ----------

// Русские метки — события старого внутридневного режима и записи до перевода журнала
const LOG_TYPES = {
  TRADE: 'trade',
  PORTFOLIO: 'portfolio',
  SIGNAL: 'signal',
  INFO: 'info',
  ERROR: 'error',
  CANDLE: 'candle',
  СДЕЛКА: 'trade',
  ПОРТФЕЛЬ: 'portfolio',
  СИГНАЛ: 'signal',
  ИНФО: 'info',
  ОШИБКА: 'error',
  СВЕЧА: 'candle',
};
// Постоянные заголовки событий переводятся, свободный текст остаётся как есть
const LOG_TITLES = {
  'Trade executed': 'adv.logs.titles.trade',
  'Portfolio state': 'adv.logs.titles.portfolio',
  'Strategy result': 'adv.logs.titles.signal',
  'New closed candle': 'adv.logs.titles.candle',
  'Bot is waiting to be started from the web interface': 'adv.logs.titles.idle',
  'Bot started from the web interface': 'adv.logs.titles.started',
  'Bot stopped': 'adv.logs.titles.stopped',
  'Auto-protection triggered': 'adv.logs.titles.autostop',
  'Daily decision': 'adv.logs.titles.decision',
  'Failed to make the daily decision': 'adv.logs.titles.decisionFailed',
  'Bot resumed after a restart': 'adv.logs.titles.resumed',
  'Failed to refresh prices': 'adv.logs.titles.pricesFailed',
  'Failed to reconcile the balance with the exchange': 'adv.logs.titles.reconcileFailed',
  'Исполнение торгового действия': 'adv.logs.titles.trade',
  'Состояние портфеля': 'adv.logs.titles.portfolio',
  'Результат стратегии': 'adv.logs.titles.signal',
  'Новая закрытая свеча': 'adv.logs.titles.candle',
  'Бот ожидает запуска из веб-интерфейса': 'adv.logs.titles.idle',
  'Бот запущен из веб-интерфейса': 'adv.logs.titles.started',
  'Бот остановлен': 'adv.logs.titles.stopped',
  'Сработала автозащита': 'adv.logs.titles.autostop',
  'Ежедневное решение бота': 'adv.logs.titles.decision',
  'Не удалось принять ежедневное решение': 'adv.logs.titles.decisionFailed',
  'Работа бота возобновлена после перезапуска': 'adv.logs.titles.resumed',
  'Не удалось обновить цены': 'adv.logs.titles.pricesFailed',
  'Не удалось сверить баланс с биржей': 'adv.logs.titles.reconcileFailed',
};
const logType = (entry) => LOG_TYPES[entry.tag] ?? 'info';

function renderLogFilters() {
  const types = ['all', 'trade', 'portfolio', 'signal', 'info', 'error'];
  el.logFilters.innerHTML = types
    .map((type) => {
      const count =
        type === 'all'
          ? state.logs.length
          : state.logs.filter((entry) => logType(entry) === type).length;
      return `<button type="button" class="chip ${state.logFilter === type ? 'active' : ''}" data-log-filter="${type}" aria-pressed="${state.logFilter === type}">${escapeHtml(t(`adv.logs.tag.${type}`))}<span class="count">${count}</span></button>`;
    })
    .join('');
}

function renderLogs() {
  renderLogFilters();
  const search = state.logSearch.trim().toLowerCase();
  const items = state.logs
    .filter((entry) => state.logFilter === 'all' || logType(entry) === state.logFilter)
    .filter(
      (entry) =>
        !search ||
        `${entry.tag} ${entry.title} ${JSON.stringify(entry.payload ?? '')}`
          .toLowerCase()
          .includes(search),
    )
    .slice(0, 120);
  if (!items.length) {
    el.logs.innerHTML = `<div class="empty-state"><b>${escapeHtml(t('adv.logs.empty'))}</b>${escapeHtml(t('adv.logs.emptySub'))}</div>`;
    return;
  }
  el.logs.innerHTML = items
    .map((entry) => {
      const type = logType(entry);
      const title = LOG_TITLES[entry.title] ? t(LOG_TITLES[entry.title]) : entry.title;
      return `
        <details class="log-entry" data-id="${escapeHtml(entry.id)}" ${state.openLogs.has(entry.id) ? 'open' : ''}>
          <summary>
            <span class="tag ${type}">${escapeHtml(t(`adv.logs.tag.${type}`))}</span>
            <span class="log-title">${escapeHtml(title)}</span>
            <time class="log-time">${escapeHtml(fmtDateTime(entry.timestamp))}</time>
          </summary>
          <pre>${escapeHtml(JSON.stringify(entry.payload, null, 2) ?? '')}</pre>
        </details>`;
    })
    .join('');
}

function setSocketStatus(connected) {
  el.socketStatus.dataset.tone = connected ? 'real' : 'muted';
  el.socketText.textContent = t(connected ? 'adv.logs.live' : 'adv.logs.offline');
  state.socketConnected = connected;
}

function commandResultText(payload) {
  if (payload?.i18n) return tm(payload.i18n);
  // Русские поля — ответы сервера до перевода журнала на английский
  const status = {
    ok: t('adv.command.ok'),
    failed: t('adv.command.failed'),
    error: t('adv.command.error'),
    успешно: t('adv.command.ok'),
    'не выполнено': t('adv.command.failed'),
    ошибка: t('adv.command.error'),
  }[payload?.status ?? payload?.статус];
  const message = payload?.message ?? payload?.сообщение;
  return [status, message].filter(Boolean).join(': ') || t('adv.command.done');
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.socket = socket;
  socket.addEventListener('open', () => setSocketStatus(true));
  socket.addEventListener('close', () => {
    state.socket = null;
    setSocketStatus(false);
    setTimeout(connectSocket, 2_000);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'initial_state') {
      // Сервер хранит события от старых к новым — показываем новые сверху
      state.logs = [...(message.payload.stream.recentEvents ?? [])]
        .reverse()
        .slice(0, MAX_LOGS);
      state.trades = [...(message.payload.stream.recentTrades ?? [])].reverse();
      state.runtime = message.payload.runtime;
      renderLogs();
      renderIntradayView();
      return;
    }
    if (message.type === 'event') {
      state.logs.unshift(message.payload);
      state.logs.length = Math.min(state.logs.length, MAX_LOGS);
      if (message.payload.type === 'trade') state.trades.unshift(message.payload);
      renderLogs();
      return;
    }
    if (message.type === 'runtime_snapshot') {
      state.runtime = message.payload;
      renderIntradayView();
      return;
    }
    if (message.type === 'command_result') {
      if (message.payload?.snapshot) state.runtime = message.payload.snapshot;
      renderIntradayView();
      toast(commandResultText(message.payload));
    }
  });
}

function sendCommand(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    toast(t('adv.logs.offline'));
    return;
  }
  state.socket.send(JSON.stringify(payload));
}

// ---------- Внутридневной режим ----------

function renderIntradayView() {
  const intraday = state.app?.strategyMode === 'intraday';
  el.intradayView.hidden = !intraday;
  if (intraday) renderIntraday(el.intradayView, state.runtime, state.trades);
}

async function handleIntradayClick(event) {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.command === 'request_snapshot') {
    sendCommand({ type: 'request_snapshot' });
    return;
  }
  if (button.dataset.command === 'refresh_execution_status') {
    sendCommand({ type: 'refresh_execution_status' });
    return;
  }
  if (button.dataset.command === 'emergency_close_all') {
    const ok = await confirmAction({
      title: t('adv.intraday.panic'),
      text: t('adv.intraday.panicConfirm'),
      okLabel: t('adv.intraday.panic'),
    });
    if (ok) sendCommand({ type: 'emergency_close_all', reason: 'Экстренное закрытие из расширенного режима' });
    return;
  }
  if (button.dataset.command === 'liquidate_spot_assets') {
    const ok = await confirmAction({
      title: t('adv.intraday.liquidate'),
      text: t('adv.intraday.liquidateConfirm'),
      okLabel: t('adv.intraday.liquidate'),
      phrase: 'LIQUIDATE SPOT',
    });
    if (ok) {
      sendCommand({
        type: 'liquidate_spot_assets',
        confirmationPhrase: 'LIQUIDATE SPOT',
        reason: 'Ликвидация spot-активов из расширенного режима',
      });
    }
    return;
  }
  if (button.dataset.closePosition !== undefined) {
    const { symbol, strategyId } = button.dataset;
    const ok = await confirmAction({
      title: t('adv.intraday.positions.close'),
      text: t('adv.intraday.positions.closeConfirm', { symbol }),
      okLabel: t('adv.intraday.positions.close'),
    });
    if (ok) {
      sendCommand({
        type: 'close_position',
        symbol,
        strategyId,
        reason: `Ручное закрытие позиции ${symbol} из расширенного режима`,
      });
    }
    return;
  }
  if (button.dataset.executionMode) {
    const mode = button.dataset.executionMode;
    const marketType = button.dataset.marketType;
    let confirmationPhrase;
    if (mode === 'live_real') {
      const ok = await confirmAction({
        title: `${mode} / ${marketType}`,
        text: t('adv.intraday.modes.liveConfirm'),
        okLabel: t('adv.intraday.modes.enable'),
        phrase: 'ENABLE LIVE',
      });
      if (!ok) return;
      confirmationPhrase = 'ENABLE LIVE';
    }
    sendCommand({ type: 'set_execution_mode', mode, marketType, confirmationPhrase });
  }
}

// ---------- Действия аллокатора ----------

async function rebalanceNow() {
  if (state.busy) return;
  const ok = await confirmAction({
    title: t('adv.rebalance'),
    text: t('adv.rebalanceConfirm'),
    okLabel: t('adv.rebalance'),
  });
  if (!ok) return;
  state.busy = true;
  el.rebalanceBtn.disabled = true;
  try {
    const result = await api.rebalance();
    applyState(result.state);
    toast(tm(result.message));
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    el.rebalanceBtn.disabled = false;
  }
}

async function stopBot() {
  const session = state.app?.session;
  if (state.busy || !session) return;
  const whereKey = `stop.where.${session.mode}`;
  const ok = await confirmAction({
    title: t('stop.title'),
    text: t('stop.text', {
      quote: session.quoteAsset,
      equity: fmtMoney(session.equity),
      profit: fmtSignedMoney(session.profit),
      where: t(whereKey) === whereKey ? '' : t(whereKey),
    }),
    okLabel: t('stop.confirm'),
    // Для реальных денег — как в старом дашборде: нужно ввести фразу
    phrase: REAL_MODES.has(session.mode) ? 'SELL ALL' : null,
  });
  if (!ok) return;
  state.busy = true;
  el.stopBtn.disabled = true;
  try {
    const result = await api.stop();
    applyState(result.state);
    toast(tm(result.message));
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    el.stopBtn.disabled = false;
  }
}

// ---------- Цикл ----------

function renderAll() {
  const app = state.app;
  if (!app) return;
  el.loading.hidden = true;
  renderHeader(app);
  const allocator = app.strategyMode !== 'intraday';
  el.allocatorView.hidden = !allocator;
  if (allocator) {
    renderSession(app);
    renderKpis(app);
    renderSignals(app);
    renderAllocation(app);
    renderParams(app);
    renderJournal(app);
    renderHistory(app);
    drawCharts();
  }
  renderIntradayView();
  renderLogs();
  setSocketStatus(Boolean(state.socketConnected));
}

function applyState(app) {
  state.app = app;
  state.failures = 0;
  el.offline.hidden = true;
  renderAll();
  void syncCharts();
}

async function refresh() {
  // Запрос уже идёт: повторим сразу после него (например, после «Показать ещё»)
  if (state.refreshing) {
    state.refreshAgain = true;
    return;
  }
  state.refreshing = true;
  let app;
  try {
    app = await api.state(state.journalLimit);
  } catch {
    state.failures += 1;
    el.offline.hidden = false;
    return;
  } finally {
    state.refreshing = false;
    if (state.refreshAgain) {
      state.refreshAgain = false;
      setTimeout(() => void refresh(), 0);
    }
  }
  try {
    applyState(app);
  } catch (error) {
    console.error('Ошибка отрисовки', error);
  }
}

let lastRefreshAt = 0;
async function pollLoop() {
  const interval = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
  const due = !state.app || Date.now() - lastRefreshAt >= interval;
  if (due && !el.confirm.dialog.open) {
    lastRefreshAt = Date.now();
    await refresh();
  }
  setTimeout(pollLoop, state.failures > 0 ? OFFLINE_POLL_MS : POLL_MS);
}

el.rebalanceBtn.addEventListener('click', () => void rebalanceNow());
el.stopBtn.addEventListener('click', () => void stopBot());
el.intradayView.addEventListener('click', (event) => void handleIntradayClick(event));

el.rangeButtons.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button || button.dataset.range === state.range) return;
  state.range = button.dataset.range;
  el.rangeButtons.querySelectorAll('button').forEach((item) => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  void syncCharts();
});

el.journalFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.journalFilter = button.dataset.filter;
  if (state.app) renderJournal(state.app);
});

el.journalMore.addEventListener('click', () => {
  state.journalLimit += JOURNAL_PAGE * 2;
  void refresh();
});

el.logFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-log-filter]');
  if (!button) return;
  state.logFilter = button.dataset.logFilter;
  renderLogs();
});

el.logSearch.addEventListener('input', () => {
  state.logSearch = el.logSearch.value;
  renderLogs();
});

// Раскрытые записи журнала остаются раскрытыми при обновлении списка
el.logs.addEventListener(
  'toggle',
  (event) => {
    const id = event.target.dataset?.id;
    if (!id) return;
    if (event.target.open) state.openLogs.add(id);
    else state.openLogs.delete(id);
  },
  true,
);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 150);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

onLangChange(() => renderAll());

mountLangSwitch($('lang-switch'));
initI18n()
  .catch((error) => console.error('Не удалось загрузить словарь', error))
  .finally(() => {
    connectSocket();
    void pollLoop();
  });
