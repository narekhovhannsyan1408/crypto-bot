// Панели старых внутридневных стратегий (BOT_STRATEGY_MODE=intraday) для расширенного режима.
// Данные приходят снимком по WebSocket; ключи снимка исторически на русском — подписи
// переводятся здесь, а свободный текст (причины, названия стратегий) показывается как есть.

import { escapeHtml, fmtDateTime, fmtNumber } from './format.js';
import { t } from './i18n.js';

const SIDES = { ЛОНГ: 'adv.intraday.side.long', ШОРТ: 'adv.intraday.side.short' };

const num = (value, digits = 6) =>
  value === null || value === undefined || value === ''
    ? '—'
    : typeof value === 'number'
      ? fmtNumber(value, digits)
      : escapeHtml(value);

const signed = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmtNumber(Math.abs(value), 4)}`
    : num(value);

const badge = (label, tone = '') =>
  `<span class="badge ${tone}">${escapeHtml(label)}</span>`;

const side = (value) =>
  SIDES[value] ? t(SIDES[value]) : (value ?? '—');

const empty = (titleKey, subtitle = '') =>
  `<div class="empty-state"><b>${escapeHtml(t(titleKey))}</b>${escapeHtml(subtitle)}</div>`;

const kv = (labelKey, value) =>
  `<div class="kv-row"><span>${escapeHtml(t(labelKey))}</span><strong>${value}</strong></div>`;

function metricsHtml(runtime) {
  const portfolio = runtime.portfolio;
  const execution = runtime.execution;
  if (!portfolio) return '';
  const totalPnl =
    Number(portfolio.реализованныйРезультат ?? 0) +
    Number(portfolio.плавающийРезультат ?? 0);
  const metrics = [
    ['balance', portfolio.баланс],
    ['equity', portfolio.капитал],
    ['spotFree', execution?.spotQuoteFree ?? null],
    ['spotTotal', execution?.spotQuoteTotal ?? null],
    ['futuresFree', execution?.futuresQuoteFree ?? null],
    ['futuresTotal', execution?.futuresQuoteTotal ?? null],
    ['realized', portfolio.реализованныйРезультат, 'pnl'],
    ['unrealized', portfolio.плавающийРезультат, 'pnl'],
    ['totalPnl', totalPnl, 'pnl'],
    ['fees', portfolio.уплаченоКомиссий],
    ['maxDrawdown', portfolio.максимальнаяПросадкаВПроцентах, 'drawdown'],
    ['openPositions', portfolio.открытыхПозиций],
    [
      'activeStrategies',
      Object.keys(portfolio.экспозицияПоСтратегиям || {}).length,
    ],
    ['winRate', portfolio.винрейт],
  ];
  return metrics
    .map(([key, value, kind]) => {
      const tone =
        typeof value !== 'number'
          ? ''
          : kind === 'pnl'
            ? value > 0
              ? 'positive'
              : value < 0
                ? 'negative'
                : ''
            : kind === 'drawdown' && value > 0
              ? 'warning'
              : '';
      return `
        <div class="kpi ${tone}">
          <div class="kpi-label">${escapeHtml(t(`adv.intraday.metric.${key}`))}</div>
          <div class="kpi-value">${kind === 'pnl' ? signed(value) : num(value, 4)}</div>
          <div class="kpi-sub">${escapeHtml(t(`adv.intraday.metric.${key}Hint`))}</div>
        </div>`;
    })
    .join('');
}

function executionHtml(execution) {
  if (!execution) return '';
  const streamKey = {
    connected: 'adv.intraday.stream.connected',
    disconnected: 'adv.intraday.stream.disconnected',
    error: 'adv.intraday.stream.error',
  }[execution.userDataStreamStatus] ?? 'adv.intraday.stream.unknown';
  const yes = (value) => t(value ? 'adv.yes' : 'adv.no');
  const balance = (free, total) =>
    free === null && total === null
      ? t('adv.intraday.unavailable')
      : `${num(free, 2)} / ${num(total, 2)} USDT`;
  const warnings = execution.warnings || [];
  return `
    <div class="card-head">
      <h2>${escapeHtml(t('adv.intraday.execution.title'))}</h2>
      <div class="chip-group">
        ${badge(execution.label ?? execution.mode)}
        ${badge(execution.marketType ?? '—')}
        ${badge(
          t(execution.accountConnectivity === 'ok' ? 'adv.intraday.binanceOk' : 'adv.intraday.binanceIssue'),
          execution.accountConnectivity === 'ok' ? 'success' : execution.accountConnectivity === 'error' ? 'danger' : '',
        )}
        ${badge(
          t(execution.canTradeShort ? 'adv.intraday.shortOn' : 'adv.intraday.shortOff'),
          execution.canTradeShort ? 'success' : 'warning',
        )}
      </div>
    </div>
    <div class="grid-2">
      <div class="kv-list">
        ${kv('adv.intraday.execution.spot', escapeHtml(balance(execution.spotQuoteFree, execution.spotQuoteTotal)))}
        ${kv('adv.intraday.execution.futures', escapeHtml(balance(execution.futuresQuoteFree, execution.futuresQuoteTotal)))}
        ${kv('adv.intraday.execution.total', `${num(execution.quoteTotal, 2)} USDT`)}
        ${kv(
          'adv.intraday.execution.routing',
          escapeHtml(
            execution.longMarketType && execution.shortMarketType
              ? `LONG → ${execution.longMarketType}, SHORT → ${execution.shortMarketType}`
              : '—',
          ),
        )}
        ${kv('adv.intraday.execution.demo', escapeHtml(yes(execution.usingTestnet)))}
        ${kv('adv.intraday.execution.api', escapeHtml(yes(execution.apiConfigured)))}
      </div>
      <div class="kv-list">
        ${kv('adv.intraday.execution.stream', escapeHtml(t(streamKey)))}
        ${kv('adv.intraday.execution.lastEvent', execution.userDataStreamLastEventAt ? escapeHtml(fmtDateTime(execution.userDataStreamLastEventAt)) : '—')}
        ${kv('adv.intraday.execution.lastReport', execution.userDataStreamLastExecutionReportAt ? escapeHtml(fmtDateTime(execution.userDataStreamLastExecutionReportAt)) : '—')}
        ${kv('adv.intraday.execution.openOrders', num(execution.openSpotOrdersCount))}
        ${kv('adv.intraday.execution.spotAssets', num(execution.spotAssetsCount))}
        ${kv('adv.intraday.execution.preview', escapeHtml((execution.spotAssetsPreview ?? []).join(', ') || '—'))}
      </div>
    </div>
    ${execution.lastError ? `<div class="bot-error"><b>${escapeHtml(t('adv.intraday.execution.lastError'))}</b> ${escapeHtml(execution.lastError)}</div>` : ''}
    ${
      warnings.length
        ? `<div class="info-box"><b>${escapeHtml(t('adv.intraday.execution.warnings'))}</b><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
        : ''
    }
    <div class="exec-groups">
      <div class="exec-group">
        <div class="exec-group-title">${escapeHtml(t('adv.intraday.modes.safe'))}</div>
        <button type="button" class="btn-secondary" data-execution-mode="paper" data-market-type="spot">Paper</button>
      </div>
      <div class="exec-group">
        <div class="exec-group-title">Demo</div>
        <button type="button" class="btn-secondary" data-execution-mode="live_testnet" data-market-type="spot">Demo Spot</button>
        <button type="button" class="btn-secondary" data-execution-mode="live_testnet" data-market-type="futures">Demo Futures</button>
        <button type="button" class="btn-secondary" data-execution-mode="live_testnet" data-market-type="hybrid">Demo Hybrid</button>
      </div>
      <div class="exec-group">
        <div class="exec-group-title">Live Real</div>
        <button type="button" class="btn-danger" data-execution-mode="live_real" data-market-type="spot">Live Spot</button>
        <button type="button" class="btn-danger" data-execution-mode="live_real" data-market-type="futures">Live Futures</button>
        <button type="button" class="btn-danger" data-execution-mode="live_real" data-market-type="hybrid">Live Hybrid</button>
      </div>
      <div class="exec-group">
        <div class="exec-group-title">${escapeHtml(t('adv.intraday.modes.service'))}</div>
        <button type="button" class="btn-secondary" data-command="refresh_execution_status">${escapeHtml(t('adv.intraday.modes.refresh'))}</button>
      </div>
    </div>`;
}

function positionsHtml(runtime) {
  const positions = runtime.portfolio?.позиций || [];
  const columns = [
    'symbol',
    'strategy',
    'side',
    'market',
    'entry',
    'current',
    'age',
    'unrealized',
    'stop',
    'take',
    'protection',
    'action',
  ];
  const head = columns
    .map((key) => `<th>${escapeHtml(t(`adv.intraday.positions.${key}`))}</th>`)
    .join('');
  const rows = positions.length
    ? positions
        .map(
          (position) => `
        <tr>
          <td>${escapeHtml(position.символ)}</td>
          <td>${escapeHtml(position.стратегия || position.strategyId || '—')}</td>
          <td>${badge(side(position.сторона), position.сторона === 'ЛОНГ' ? 'success' : 'danger')}</td>
          <td>${badge(position.рынокИсполнения || '—')}</td>
          <td class="num">${num(position.ценаВхода)}</td>
          <td class="num">${num(position.текущаяЦена)}</td>
          <td class="num">${num(position.времяВПозицииМинут, 0)}</td>
          <td class="num ${position.плавающийРезультат >= 0 ? 'positive-text' : 'negative-text'}">${signed(position.плавающийРезультат)}</td>
          <td class="num">${num(position.стопЦена)}</td>
          <td class="num">${num(position.тейкЦена)}</td>
          <td>${badge(t(position.breakevenАктивен === 'да' ? 'adv.intraday.positions.breakeven' : 'adv.intraday.positions.standard'), position.breakevenАктивен === 'да' ? 'success' : '')}</td>
          <td><button type="button" class="table-action" data-close-position data-symbol="${escapeHtml(position.символ)}" data-strategy-id="${escapeHtml(position.strategyId || '')}">${escapeHtml(t('adv.intraday.positions.close'))}</button></td>
        </tr>`,
        )
        .join('')
    : `<tr class="empty-row"><td colspan="${columns.length}">${escapeHtml(t('adv.intraday.positions.empty'))}</td></tr>`;
  return `
    <div class="card-head">
      <h2>${escapeHtml(t('adv.intraday.positions.title'))}</h2>
      <span class="badge">${positions.length}</span>
    </div>
    <div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function riskHtml(runtime) {
  const symbols = runtime.watchedSymbols || [];
  const risk = runtime.рискМенеджмент || {};
  const humanize = (key) =>
    String(key)
      .replace(/([a-zа-я])([A-ZА-Я])/g, '$1 $2')
      .replace(/_/g, ' ');
  return `
    <div class="grid-2">
      <div>
        <h2>${escapeHtml(t('adv.intraday.universe'))}</h2>
        <ul class="tag-list">${
          symbols.length
            ? symbols.map((symbol) => `<li class="badge">${escapeHtml(symbol)}</li>`).join('')
            : `<li class="muted small">${escapeHtml(t('adv.intraday.universeEmpty'))}</li>`
        }</ul>
      </div>
      <div>
        <h2>${escapeHtml(t('adv.intraday.risk'))}</h2>
        <div class="kv-list">${Object.entries(risk)
          .map(
            ([key, value]) =>
              `<div class="kv-row"><span>${escapeHtml(humanize(key))}</span><strong>${
                value && typeof value === 'object'
                  ? escapeHtml(JSON.stringify(value))
                  : num(value)
              }</strong></div>`,
          )
          .join('')}</div>
      </div>
    </div>`;
}

function selectionHtml(runtime) {
  const selection = runtime.strategySelection;
  const active = runtime.activeStrategies || [];
  const activeHtml = active.length
    ? active.map((item) => `<li class="badge">${escapeHtml(item.name || item.id || '—')}</li>`).join('')
    : `<li class="muted small">${escapeHtml(t('adv.intraday.selection.noActive'))}</li>`;
  if (!selection) {
    return `
      <h2>${escapeHtml(t('adv.intraday.selection.title'))}</h2>
      <p class="muted small">${escapeHtml(t('adv.intraday.selection.none'))}</p>
      <ul class="tag-list">${activeHtml}</ul>`;
  }
  const candidates = (selection.кандидаты || [])
    .map(
      (candidate) => `
      <div class="candidate ${candidate.статус === 'выбрана' ? 'selected' : ''}">
        <div class="card-head"><b>${escapeHtml(candidate.стратегия || candidate.strategyId || '—')}</b>${badge(t(candidate.статус === 'выбрана' ? 'adv.intraday.selection.selected' : 'adv.intraday.selection.rejected'), candidate.статус === 'выбрана' ? 'success' : '')}</div>
        <div class="kv-list">
          ${kv('adv.intraday.selection.side', escapeHtml(side(candidate.сторона)))}
          ${kv('adv.intraday.selection.regime', escapeHtml(candidate.режимРынка || '—'))}
          ${kv('adv.intraday.selection.entryScore', num(candidate.entryScore, 3))}
          ${kv('adv.intraday.selection.arbitrationScore', num(candidate.arbitrationScore, 3))}
        </div>
        <div class="small muted">${escapeHtml(candidate.причина || '')}</div>
      </div>`,
    )
    .join('');
  return `
    <div class="card-head">
      <h2>${escapeHtml(t('adv.intraday.selection.title'))}</h2>
      ${badge(side(selection.сторона), selection.сторона === 'ЛОНГ' ? 'success' : selection.сторона === 'ШОРТ' ? 'danger' : '')}
    </div>
    <div class="grid-2">
      <div>
        <div class="kv-list">
          ${kv('adv.intraday.selection.strategy', escapeHtml(selection.выбраннаяСтратегия || '—'))}
          ${kv('adv.intraday.positions.symbol', escapeHtml(selection.символ || '—'))}
          ${kv('adv.intraday.selection.score', num(selection.оценка, 3))}
          ${kv('adv.intraday.selection.mode', escapeHtml(runtime.strategySelectionMode || '—'))}
          ${kv('adv.intraday.selection.time', selection.время ? escapeHtml(fmtDateTime(selection.время)) : '—')}
        </div>
        <p class="small muted">${escapeHtml(selection.причина || '')}</p>
        <ul class="tag-list">${activeHtml}</ul>
      </div>
      <div class="candidate-list">${candidates}</div>
    </div>`;
}

function tradesHtml(trades) {
  const columns = [
    'time',
    'symbol',
    'strategy',
    'action',
    'side',
    'entry',
    'exit',
    'net',
    'fees',
    'reason',
  ];
  const rows = trades.length
    ? trades
        .map((entry) => {
          const trade = entry.payload || {};
          const pnl = Number(trade.чистыйРезультат ?? 0);
          return `
          <tr>
            <td>${escapeHtml(fmtDateTime(entry.timestamp))}</td>
            <td>${escapeHtml(trade.символ || '—')}</td>
            <td>${escapeHtml(trade.стратегия || trade.strategyId || '—')}</td>
            <td>${badge(trade.действие || '—')}</td>
            <td>${badge(side(trade.сторона), trade.сторона === 'ЛОНГ' ? 'success' : trade.сторона === 'ШОРТ' ? 'danger' : '')}</td>
            <td class="num">${num(trade.ценаВхода ?? trade.цена)}</td>
            <td class="num">${num(trade.ценаВыхода)}</td>
            <td class="num ${pnl >= 0 ? 'positive-text' : 'negative-text'}">${signed(trade.чистыйРезультат)}</td>
            <td class="num">${num(trade.суммарныеКомиссии ?? trade.комиссия)}</td>
            <td class="wrap">${escapeHtml(trade.причина || '—')}</td>
          </tr>`;
        })
        .join('')
    : `<tr class="empty-row"><td colspan="${columns.length}">${escapeHtml(t('adv.intraday.trades.empty'))}</td></tr>`;
  return `
    <h2>${escapeHtml(t('adv.intraday.trades.title'))}</h2>
    <div class="table-wrap"><table class="data-table"><thead><tr>${columns
      .map((key) => `<th>${escapeHtml(t(`adv.intraday.trades.${key}`))}</th>`)
      .join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Все панели внутридневного режима; кнопки — через data-атрибуты, обработчики вешает advanced.js. */
export function renderIntraday(container, runtime, trades) {
  if (!runtime) {
    container.innerHTML = `<section class="card">${empty('adv.intraday.waiting')}</section>`;
    return;
  }
  container.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div>
          <h2>${escapeHtml(t('adv.intraday.title'))}</h2>
          <p class="card-sub muted small">${escapeHtml(t('adv.intraday.sub'))}</p>
        </div>
        <div class="intraday-actions">
          <button type="button" class="btn-secondary" data-command="request_snapshot">${escapeHtml(t('adv.intraday.refresh'))}</button>
          <button type="button" class="btn-danger" data-command="liquidate_spot_assets">${escapeHtml(t('adv.intraday.liquidate'))}</button>
          <button type="button" class="btn-danger" data-command="emergency_close_all">${escapeHtml(t('adv.intraday.panic'))}</button>
        </div>
      </div>
    </section>
    <section class="kpi-grid">${metricsHtml(runtime)}</section>
    <section class="card">${executionHtml(runtime.execution)}</section>
    <section class="card">${positionsHtml(runtime)}</section>
    <section class="card">${riskHtml(runtime)}</section>
    <section class="card">${selectionHtml(runtime)}</section>
    <section class="card">${tradesHtml(trades)}</section>`;
}
