// Отрисовка состояния бота. Функции получают данные и обновляют DOM — без побочных запросов.
// Все тексты — из словаря (t, th), сообщения сервера — через tm.

import {
  ASSET_COLORS,
  CLUSTER_NAMES,
  historyRows,
  REAL_MODES,
  renderTimeline,
  stopReasonText,
  trendClass,
  trendKey,
} from './common.js';
import {
  clamp,
  escapeHtml,
  fmtDateTime,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtSignedMoney,
  fmtTime,
  humanDuration,
  joinList,
  shortAddress,
} from './format.js';
import { t, th, tm } from './i18n.js';

const $ = (id) => document.getElementById(id);

export const el = {
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  offline: $('offline-banner'),
  loading: $('loading-view'),
  startView: $('start-view'),
  heroTitle: $('hero-title'),
  heroLead: $('hero-lead'),
  step1: $('step-1'),
  explainerWhat: $('explainer-what'),
  startTestBtn: $('start-test-btn'),
  startRealBtn: $('start-real-btn'),
  startRealSub: $('start-real-sub'),
  startSolanaBtn: $('start-solana-btn'),
  startSolanaSub: $('start-solana-sub'),
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
    renderNow(session, running, app.solana);
    renderActivity(session);
  }
  renderHistory(app.history, session);
}

function renderHeader(app, session, running) {
  if (running) {
    el.statusPill.dataset.tone = REAL_MODES.has(session.mode) ? 'real' : 'test';
    el.statusText.textContent = t('status.running', {
      mode: t(`mode.short.${session.mode}`),
    });
    document.title = `${fmtMoney(session.equity)} · ${t('app.name')}`;
  } else {
    el.statusPill.dataset.tone = 'muted';
    el.statusText.textContent = t(
      app.status === 'stopped' ? 'status.stopped' : 'status.idle',
    );
    document.title = t('app.name');
  }
}

function renderStartView(app) {
  const stopped = app.status === 'stopped';
  el.startView.hidden = app.status === 'running';
  el.startView.classList.toggle('compact', stopped);
  // Названия активов из настроек: BTC и ETH по умолчанию, SOL — если добавлен
  const assets = joinList(app.strategy.assets.map((asset) => asset.name));
  el.heroTitle.textContent = stopped
    ? t('hero.stoppedTitle')
    : t('hero.title', { assets });
  el.step1.innerHTML = th('steps.1', { assets });
  el.explainerWhat.innerHTML = th('explainer.what', { assets });
  el.heroLead.textContent = t(stopped ? 'hero.stoppedLead' : 'hero.lead');

  el.startRealSub.textContent = t(
    app.readiness.live_real.available
      ? 'start.real.subReady'
      : 'start.real.subSetup',
  );

  const proof = app.solana.proof;
  el.startSolanaSub.textContent = [
    t('start.solana.sub'),
    t(
      app.readiness.solana_real.available
        ? 'start.solana.subBoth'
        : 'start.solana.subSim',
    ),
    proof.enabled && proof.address
      ? t('start.solana.subProof', {
          cluster: CLUSTER_NAMES[proof.cluster] ?? proof.cluster,
        })
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function renderSummary(session, running) {
  el.modeTag.textContent = t(`mode.tag.${session.mode}`);
  el.modeTag.dataset.tone = REAL_MODES.has(session.mode) ? 'real' : 'test';

  el.summaryLabel.textContent = t(running ? 'summary.now' : 'summary.result');
  el.equityValue.textContent = fmtMoney(session.equity);

  const tone =
    session.profit > 0.005
      ? 'positive'
      : session.profit < -0.005
        ? 'negative'
        : 'neutral';
  const arrow = tone === 'positive' ? '▲' : tone === 'negative' ? '▼' : '•';
  el.profitValue.className = `delta ${tone}`;
  el.profitValue.textContent = `${arrow} ${fmtSignedMoney(session.profit)} (${fmtPct(session.profitPct)}) ${t(running ? 'summary.sinceStart' : 'summary.forRun')}`;

  el.benchmark.hidden = !session.benchmark;
  if (session.benchmark) {
    const diff = session.equity - session.benchmark.equity;
    const verdict =
      Math.abs(diff) < session.initialCapital * 0.002
        ? t('benchmark.same')
        : diff > 0
          ? t('benchmark.ahead', { amount: fmtMoney(diff) })
          : t('benchmark.behind', { amount: fmtMoney(-diff) });
    el.benchmark.innerHTML = th('benchmark.text', {
      assets: joinList(session.assets.map((asset) => asset.base)),
      equity: fmtMoney(session.benchmark.equity),
      pct: fmtPct(session.benchmark.profitPct),
      verdict,
    });
  }

  const period = running
    ? t('summary.runningFor', {
        duration: humanDuration(Date.now() - session.startedAt),
      })
    : `${fmtDateTime(session.startedAt)} — ${fmtDateTime(session.stoppedAt)}`;
  const fees =
    session.feesPaid > 0
      ? t(session.venue === 'Solana' ? 'summary.networkFees' : 'summary.fees', {
          amount: fmtMoney(session.feesPaid),
        })
      : '';
  el.summaryMeta.textContent = t('summary.meta', {
    capital: fmtMoney(session.initialCapital),
    period,
    fees,
  });

  el.stopBtn.hidden = !running;
  el.protection.hidden = !running;
  el.stoppedNote.hidden = running;

  if (!running) {
    el.stoppedNote.textContent = t('stopped.note', {
      time: fmtDateTime(session.stoppedAt),
      reason: stopReasonText(session),
    });
    return;
  }

  if (session.autoStopEquity === null) {
    el.protection.textContent = t('protection.off');
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
    ${th('protection.on', {
      threshold: fmtMoney(session.autoStopEquity),
      pct: Math.round(session.autoStopLossPct * 100),
      cushion: fmtMoney(Math.max(cushion, 0)),
    })}
    <div class="meter ${meterClass}" role="progressbar" aria-label="${escapeHtml(t('protection.meterLabel'))}"
      aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}">
      <span style="width:${(ratio * 100).toFixed(1)}%"></span>
    </div>`;
}

function renderBotError(app, running) {
  const session = app.session;
  el.botError.hidden = !(running && app.lastError);
  if (running && app.lastError) {
    el.botError.innerHTML = th('botError.text', {
      venue: t(session.venue === 'Solana' ? 'venue.solana' : 'venue.exchange'),
      detail: tm(app.lastError),
    });
  }
}

function renderNow(session, running, solana) {
  const quote = session.quoteAsset ?? 'USDT';
  el.nowTitle.textContent = t(running ? 'now.titleRunning' : 'now.titleStopped');

  const invested = session.assets.filter((asset) => asset.weightPct >= 1);
  if (running && session.lastDecisionDay === null) {
    el.nowSummary.textContent = t('now.firstDecision');
  } else if (invested.length === 0) {
    el.nowSummary.textContent = t(
      running ? 'now.allCashRunning' : 'now.allCashStopped',
      { quote },
    );
  } else {
    const cash = Math.round(session.cashWeightPct);
    el.nowSummary.textContent = t('now.holds', {
      parts: joinList(
        invested.map((asset) =>
          t('now.holdPart', {
            pct: Math.round(asset.weightPct),
            name: asset.name,
          }),
        ),
      ),
      cash: cash >= 1 ? t('now.cashPart', { pct: cash, quote }) : '',
    });
  }

  const segments = [
    ...session.assets.map((asset) => ({
      key: asset.base,
      label: asset.name,
      pct: asset.weightPct,
    })),
    { key: quote, label: quote, pct: session.cashWeightPct },
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
      ? `<span class="trend-badge ${trendClass(asset.trendVotes, asset.trendTotal)}" title="${escapeHtml(t('trend.tooltip', { votes: asset.trendVotes, total: asset.trendTotal }))}">${escapeHtml(t(trendKey(asset.trendVotes, asset.trendTotal)))} · ${asset.trendVotes}/${asset.trendTotal}</span>`
      : `<span class="trend-badge none">${escapeHtml(t('asset.waiting'))}</span>`;
    const rate = asset.price
      ? t('asset.rate', { price: fmtPrice(asset.price) })
      : '';
    const holding =
      asset.quantity > 0
        ? `${fmtQty(asset.quantity)} ${asset.base}${rate}`
        : t('asset.notBought', { rate });
    return `
      <div class="asset">
        <span class="asset-icon" style="background:${ASSET_COLORS[asset.base] ?? 'var(--accent)'}">${escapeHtml(asset.base)}</span>
        <div class="asset-name">${escapeHtml(asset.name)}${badge}</div>
        <div class="asset-value">${fmtMoney(asset.value)}</div>
        <div class="asset-sub">${escapeHtml(holding)}</div>
        <div class="asset-sub asset-target">${hasSignal ? escapeHtml(t('asset.target', { pct: Math.round(asset.targetWeightPct) })) : ''}</div>
      </div>`;
  });
  rows.push(`
    <div class="asset">
      <span class="asset-icon" style="background:${ASSET_COLORS[quote] ?? ASSET_COLORS.USDT}">$</span>
      <div class="asset-name">${escapeHtml(t('asset.cash', { quote }))}</div>
      <div class="asset-value">${fmtMoney(session.cash)}</div>
      <div class="asset-sub">${escapeHtml(t('asset.cashSub'))}</div>
      <div class="asset-sub asset-target"></div>
    </div>`);
  if (session.venue === 'Solana') {
    const tokens = th('now.solanaTokens', {
      tokens: solana.tokens
        .map((token) => `${token.base} → ${token.symbol}`)
        .join(', '),
    });
    const wallet =
      session.mode === 'solana_real' && solana.walletAddress
        ? ` ${th('now.wallet', { address: shortAddress(solana.walletAddress) })}`
        : '';
    rows.push(`<div class="chain-note">${tokens}${wallet}</div>`);
  }
  el.assetList.innerHTML = rows.join('');

  el.nextDecision.hidden = !running || !session.nextDecisionAt;
  if (running && session.nextDecisionAt) {
    const next = new Date(session.nextDecisionAt);
    const today = next.toDateString() === new Date().toDateString();
    const proof = solana.proof;
    const proofNote =
      proof.enabled && proof.address
        ? ` ${th('next.proof', {
            cluster: CLUSTER_NAMES[proof.cluster] ?? proof.cluster,
          })}`
        : '';
    const prices = session.pricesStale
      ? ` <span class="warning-text">${th('next.pricesStale', {
          time: fmtTime(session.pricesUpdatedAt ?? Date.now()),
        })}</span>`
      : session.pricesUpdatedAt
        ? ` ${th('next.pricesUpdated', { time: fmtTime(session.pricesUpdatedAt) })}`
        : '';
    el.nextDecision.innerHTML = `${th('next.decision', {
      day: t(today ? 'next.today' : 'next.tomorrow'),
      time: fmtTime(session.nextDecisionAt),
      duration: humanDuration(session.nextDecisionAt - Date.now()),
    })}${proofNote}${prices}`;
  }
}

function renderActivity(session) {
  el.activityCount.textContent = t('activity.count', {
    count: session.activityTotal,
  });
  el.showMore.hidden = session.activity.length >= session.activityTotal;
  el.activity.innerHTML = renderTimeline(session.activity, session.venue);
}

function renderHistory(history, session) {
  const rows = (history ?? []).filter(
    (item) => !session || item.id !== session.id,
  );
  el.historyCard.hidden = rows.length === 0;
  el.historyBody.innerHTML = historyRows(rows);
}
