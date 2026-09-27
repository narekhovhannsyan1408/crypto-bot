// SVG-график капитала относительно стартовой суммы, без внешних библиотек.

import {
  escapeHtml,
  fmtDateTime,
  fmtMoney,
  fmtShortDate,
  fmtSignedMoney,
  fmtTime,
} from './format.js';
import { numberLocale, t, tm } from './i18n.js';

const PAD = { top: 18, right: 14, bottom: 28, left: 72 };
const DAY_MS = 86_400_000;

function niceTicks(min, max, count) {
  const span = max - min;
  if (span <= 0) return [min];
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ||
    rawStep;
  const ticks = [];
  for (
    let value = Math.ceil(min / step) * step;
    value <= max + 1e-9;
    value += step
  ) {
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
      return (
        left.equity +
        ((right.equity - left.equity) * (timestamp - left.timestamp)) / span
      );
    }
  }
  return points[points.length - 1].equity;
}

/**
 * @param {HTMLElement} container
 * @param {{initialCapital:number, points:{timestamp:number,equity:number}[], trades:{timestamp:number,kind:string,title:string}[]}} chart
 * @param {{timestamp:number, equity:number} | null} livePoint текущий капитал, добавляется в конец линии
 */
export function renderEquityChart(container, chart, livePoint) {
  const points = [...(chart?.points ?? [])];
  if (
    livePoint &&
    (!points.length ||
      livePoint.timestamp > points[points.length - 1].timestamp)
  ) {
    points.push(livePoint);
  }

  if (
    points.length < 2 ||
    points[points.length - 1].timestamp === points[0].timestamp
  ) {
    container.innerHTML = `<div class="chart-empty">${escapeHtml(t('chart.empty'))}</div>`;
    return;
  }

  const width = container.clientWidth || 600;
  const height = container.clientHeight || 290;
  const base = chart.initialCapital;
  const minX = points[0].timestamp;
  const maxX = points[points.length - 1].timestamp;
  const values = points.map((point) => point.equity).concat(base);
  let minY = Math.min(...values);
  let maxY = Math.max(...values);
  const span = Math.max(maxY - minY, base * 0.004);
  minY -= span * 0.15;
  maxY += span * 0.15;

  const x = (t) =>
    PAD.left + ((t - minX) / (maxX - minX)) * (width - PAD.left - PAD.right);
  const y = (v) =>
    PAD.top +
    (1 - (v - minY) / (maxY - minY)) * (height - PAD.top - PAD.bottom);
  const baseY = y(base);

  const line = points
    .map(
      (point, index) =>
        `${index ? 'L' : 'M'}${x(point.timestamp).toFixed(1)},${y(point.equity).toFixed(1)}`,
    )
    .join('');
  const area = `${line}L${x(maxX).toFixed(1)},${baseY.toFixed(1)}L${x(minX).toFixed(1)},${baseY.toFixed(1)}Z`;

  const yDigits = maxY - minY < 20 ? 2 : 0;
  const yLabel = (value) =>
    new Intl.NumberFormat(numberLocale(), {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: yDigits,
      maximumFractionDigits: yDigits,
    }).format(value);
  const yTicks = niceTicks(minY, maxY, 4)
    .map(
      (value) =>
        `<line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(value)}" y2="${y(value)}"/>` +
        `<text class="axis-label" x="${PAD.left - 8}" y="${y(value) + 4}" text-anchor="end">${yLabel(value)}</text>`,
    )
    .join('');

  const shortSpan = maxX - minX <= 2 * DAY_MS;
  const xTickCount = width < 480 ? 3 : 5;
  const seen = new Set();
  const xTicks = Array.from(
    { length: xTickCount },
    (_, index) => minX + ((maxX - minX) * index) / (xTickCount - 1),
  )
    .map((t, index) => {
      const label = shortSpan ? fmtTime(t) : fmtShortDate(t);
      if (seen.has(label)) return '';
      seen.add(label);
      const anchor =
        index === 0 ? 'start' : index === xTickCount - 1 ? 'end' : 'middle';
      return `<text class="axis-label" x="${x(t)}" y="${height - 8}" text-anchor="${anchor}">${label}</text>`;
    })
    .join('');

  const trades = (chart.trades ?? [])
    .filter((trade) => trade.timestamp >= minX && trade.timestamp <= maxX)
    .map((trade) => ({
      ...trade,
      cx: x(trade.timestamp),
      cy: y(equityAt(points, trade.timestamp)),
    }));
  const markers = trades
    .map(
      (trade) =>
        `<circle class="marker-${trade.kind}" cx="${trade.cx}" cy="${trade.cy}" r="5"/>`,
    )
    .join('');

  const baseLabelY = baseY - 6 < PAD.top + 8 ? baseY + 14 : baseY - 6;
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t('chart.aria'))}">
      <defs>
        <clipPath id="chart-clip-up"><rect x="0" y="0" width="${width}" height="${Math.max(baseY, 0)}"/></clipPath>
        <clipPath id="chart-clip-down"><rect x="0" y="${baseY}" width="${width}" height="${Math.max(height - baseY, 0)}"/></clipPath>
      </defs>
      ${yTicks}
      <path class="area-up" d="${area}" clip-path="url(#chart-clip-up)"/>
      <path class="area-down" d="${area}" clip-path="url(#chart-clip-down)"/>
      <line class="base-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${baseY}" y2="${baseY}"/>
      <text class="base-label" x="${width - PAD.right}" y="${baseLabelY}" text-anchor="end">${escapeHtml(t('chart.start', { amount: fmtMoney(base) }))}</text>
      <path class="equity-line" d="${line}"/>
      ${markers}
      ${xTicks}
      <line class="hover-line" y1="${PAD.top}" y2="${height - PAD.bottom}" visibility="hidden"/>
      <circle class="hover-dot" r="5" visibility="hidden"/>
      <rect class="hover-area" x="${PAD.left}" y="0" width="${width - PAD.left - PAD.right}" height="${height}" fill="transparent"/>
    </svg>
    <div class="chart-tooltip" hidden></div>`;

  const svg = container.querySelector('svg');
  const hoverArea = container.querySelector('.hover-area');
  const hoverLine = container.querySelector('.hover-line');
  const hoverDot = container.querySelector('.hover-dot');
  const tooltip = container.querySelector('.chart-tooltip');

  const hide = () => {
    hoverLine.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };

  hoverArea.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const t =
      minX + ((px - PAD.left) / (width - PAD.left - PAD.right)) * (maxX - minX);
    let nearest = points[0];
    for (const point of points) {
      if (Math.abs(point.timestamp - t) < Math.abs(nearest.timestamp - t))
        nearest = point;
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
      ${trade ? `<div class="small">${escapeHtml(trade.titleMsg ? tm(trade.titleMsg) : trade.title)}</div>` : ''}`;
    tooltip.style.left = `${(cx / width) * rect.width}px`;
    tooltip.style.top = `${(cy / height) * rect.height}px`;
    tooltip.hidden = false;
  });
  hoverArea.addEventListener('pointerleave', hide);
}

/** Просадка от пика в процентах для каждой точки капитала. */
export function drawdownSeries(points) {
  let peak = -Infinity;
  return points.map((point) => {
    peak = Math.max(peak, point.equity);
    return {
      timestamp: point.timestamp,
      pct: peak > 0 ? (point.equity / peak - 1) * 100 : 0,
    };
  });
}

/**
 * Область просадки под графиком капитала: 0% — новый максимум, ниже — насколько
 * капитал сейчас меньше своего пика. Ось X совпадает с графиком капитала.
 */
export function renderDrawdownChart(container, chart, livePoint) {
  const points = [...(chart?.points ?? [])];
  if (
    livePoint &&
    (!points.length ||
      livePoint.timestamp > points[points.length - 1].timestamp)
  ) {
    points.push(livePoint);
  }
  if (
    points.length < 2 ||
    points[points.length - 1].timestamp === points[0].timestamp
  ) {
    container.innerHTML = '';
    return;
  }

  const series = drawdownSeries(points);
  const width = container.clientWidth || 600;
  const height = container.clientHeight || 120;
  const pad = { top: 8, right: PAD.right, bottom: 8, left: PAD.left };
  const minX = series[0].timestamp;
  const maxX = series[series.length - 1].timestamp;
  const worst = Math.min(...series.map((item) => item.pct));
  const minY = Math.min(worst * 1.15, -1);

  const x = (t) =>
    pad.left + ((t - minX) / (maxX - minX)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + (v / minY) * (height - pad.top - pad.bottom);

  const line = series
    .map(
      (item, index) =>
        `${index ? 'L' : 'M'}${x(item.timestamp).toFixed(1)},${y(item.pct).toFixed(1)}`,
    )
    .join('');
  const area = `${line}L${x(maxX).toFixed(1)},${y(0).toFixed(1)}L${x(minX).toFixed(1)},${y(0).toFixed(1)}Z`;
  const pctLabel = (value) =>
    `${value < 0 ? '−' : ''}${Math.abs(value).toLocaleString(numberLocale(), { maximumFractionDigits: Math.abs(minY) < 5 ? 1 : 0 })}%`;
  const ticks = [0, minY / 2, minY]
    .map(
      (value) =>
        `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/>` +
        `<text class="axis-label" x="${pad.left - 8}" y="${y(value) + 4}" text-anchor="end">${pctLabel(value)}</text>`,
    )
    .join('');
  const worstPoint = series.reduce((a, b) => (b.pct < a.pct ? b : a));

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t('adv.charts.drawdown'))}">
      ${ticks}
      <path class="drawdown-area" d="${area}"/>
      <path class="drawdown-line" d="${line}"/>
      ${
        worstPoint.pct < -0.05
          ? `<circle class="drawdown-worst" cx="${x(worstPoint.timestamp)}" cy="${y(worstPoint.pct)}" r="4"/>`
          : ''
      }
    </svg>`;
}
