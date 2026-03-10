const state = {
  recentEvents: [],
  recentTrades: [],
  equityHistory: [],
  runtime: null,
  socket: null,
};

const elements = {
  connectionStatus: document.getElementById('connection-status'),
  metricsGrid: document.getElementById('metrics-grid'),
  positionsTable: document.getElementById('positions-table'),
  positionsCount: document.getElementById('positions-count'),
  universeList: document.getElementById('universe-list'),
  riskState: document.getElementById('risk-state'),
  tradesTable: document.getElementById('trades-table'),
  logsContainer: document.getElementById('logs-container'),
  chart: document.getElementById('equity-chart'),
  panicButton: document.getElementById('panic-button'),
  refreshButton: document.getElementById('refresh-button'),
};

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    elements.connectionStatus.textContent = 'Подключено';
    elements.connectionStatus.style.borderColor = 'rgba(34, 197, 94, 0.4)';
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    elements.connectionStatus.textContent = 'Нет соединения';
    elements.connectionStatus.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    setTimeout(connect, 1500);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'initial_state') {
      state.recentEvents = message.payload.stream.recentEvents || [];
      state.recentTrades = message.payload.stream.recentTrades || [];
      state.equityHistory = message.payload.stream.equityHistory || [];
      state.runtime = message.payload.runtime;
      renderAll();
      return;
    }

    if (message.type === 'event') {
      handleLiveEvent(message.payload);
      return;
    }

    if (message.type === 'runtime_snapshot') {
      state.runtime = message.payload;
      renderAll();
      return;
    }

    if (message.type === 'command_result') {
      alert(
        typeof message.payload === 'object'
          ? JSON.stringify(message.payload, null, 2)
          : String(message.payload),
      );
    }
  });

  elements.panicButton.onclick = () => {
    const isConfirmed = window.confirm(
      'Экстренно закрыть все позиции и вернуть весь капитал в баланс?',
    );

    if (!isConfirmed) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'emergency_close_all',
        reason: 'Экстренное закрытие всех позиций из web dashboard',
      }),
    );
  };

  elements.refreshButton.onclick = () => {
    socket.send(JSON.stringify({ type: 'request_snapshot' }));
  };

  elements.positionsTable.onclick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest('[data-close-position]');
    if (!button) {
      return;
    }

    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      window.alert('Нет активного WebSocket-соединения с dashboard');
      return;
    }

    const symbol = button.dataset.symbol;
    const strategyId = button.dataset.strategyId;
    const strategyName = button.dataset.strategyName || strategyId || 'неизвестная стратегия';

    if (!symbol || !strategyId) {
      window.alert('Не удалось определить, какую позицию закрыть');
      return;
    }

    const isConfirmed = window.confirm(
      `Закрыть позицию ${symbol} (${strategyName}) отдельно?`,
    );

    if (!isConfirmed) {
      return;
    }

    state.socket.send(
      JSON.stringify({
        type: 'close_position',
        symbol,
        strategyId,
        reason: `Ручное закрытие позиции ${symbol} (${strategyName}) из web dashboard`,
      }),
    );
  };
}

function handleLiveEvent(event) {
  state.recentEvents.unshift(event);
  state.recentEvents = state.recentEvents.slice(0, 150);

  if (event.type === 'trade') {
    state.recentTrades.unshift(event);
    state.recentTrades = state.recentTrades.slice(0, 200);
  }

  if (event.type === 'portfolio') {
    const equity = event.payload?.капитал;
    if (typeof equity === 'number') {
      state.equityHistory.push({
        timestamp: event.timestamp,
        equity,
      });
      state.equityHistory = state.equityHistory.slice(-300);
    }
  }

  renderAll();
}

function renderAll() {
  renderMetrics();
  renderPositions();
  renderUniverse();
  renderRiskState();
  renderTrades();
  renderLogs();
  renderChart();
}

function renderMetrics() {
  const portfolio = state.runtime?.portfolio;
  if (!portfolio) {
    elements.metricsGrid.innerHTML = '';
    return;
  }

  const metrics = [
    ['Баланс', portfolio.баланс],
    ['Капитал', portfolio.капитал],
    ['Реализованный результат', portfolio.реализованныйРезультат],
    ['Плавающий результат', portfolio.плавающийРезультат],
    ['Уплачено комиссий', portfolio.уплаченоКомиссий],
    ['Макс. просадка %', portfolio.максимальнаяПросадкаВПроцентах],
    ['Открытых позиций', portfolio.открытыхПозиций],
    [
      'Активных стратегий',
      Object.keys(portfolio.экспозицияПоСтратегиям || {}).length,
    ],
    ['Винрейт %', portfolio.винрейт],
  ];

  elements.metricsGrid.innerHTML = metrics
    .map(([label, value]) => {
      const cssClass =
        typeof value === 'number' && value > 0
          ? 'positive'
          : typeof value === 'number' && value < 0
            ? 'negative'
            : '';

      return `
        <div class="metric-card ${cssClass}">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${formatNumber(value)}</div>
        </div>
      `;
    })
    .join('');
}

function renderPositions() {
  const positions = state.runtime?.portfolio?.позиций || [];
  elements.positionsCount.textContent = String(positions.length);

  elements.positionsTable.innerHTML = positions
    .map((position) => {
      const pnlClass = position.плавающийРезультат >= 0 ? 'profit' : 'loss';
      return `
        <tr>
          <td>${escapeHtml(position.символ)}</td>
          <td>${escapeHtml(position.стратегия || position.strategyId || '-')}</td>
          <td>${escapeHtml(position.сторона)}</td>
          <td>${formatNumber(position.ценаВхода)}</td>
          <td>${formatNumber(position.текущаяЦена)}</td>
          <td class="${pnlClass}">${formatNumber(position.плавающийРезультат)}</td>
          <td>${formatNumber(position.стопЦена)}</td>
          <td>${formatNumber(position.тейкЦена)}</td>
          <td>
            <button
              class="table-action-button"
              data-close-position="true"
              data-symbol="${escapeHtml(position.символ)}"
              data-strategy-id="${escapeHtml(position.strategyId || '')}"
              data-strategy-name="${escapeHtml(
                position.стратегия || position.strategyId || '-',
              )}"
            >
              Закрыть
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderUniverse() {
  const symbols = state.runtime?.watchedSymbols || [];
  elements.universeList.innerHTML = symbols
    .map((symbol) => `<li>${escapeHtml(symbol)}</li>`)
    .join('');
}

function renderRiskState() {
  const riskState = state.runtime?.рискМенеджмент || {};
  elements.riskState.innerHTML = Object.entries(riskState)
    .map(
      ([key, value]) => `
        <div class="kv-row">
          <span>${escapeHtml(key)}</span>
          <strong>${formatValue(value)}</strong>
        </div>
      `,
    )
    .join('');
}

function renderTrades() {
  const rows = state.recentTrades
    .slice()
    .sort((left, right) => right.timestamp - left.timestamp)
    .map((entry) => {
      const trade = entry.payload || {};
      const pnl = Number(trade.чистыйРезультат ?? 0);
      const pnlClass = pnl >= 0 ? 'profit' : 'loss';
      return `
        <tr>
          <td>${formatDate(entry.timestamp)}</td>
          <td>${escapeHtml(trade.символ || '-')}</td>
          <td>${escapeHtml(trade.стратегия || trade.strategyId || '-')}</td>
          <td>${escapeHtml(trade.действие || '-')}</td>
          <td>${escapeHtml(trade.сторона || '-')}</td>
          <td>${formatNumber(trade.ценаВхода ?? trade.цена)}</td>
          <td>${formatNumber(trade.ценаВыхода)}</td>
          <td class="${pnlClass}">${formatNumber(trade.чистыйРезультат)}</td>
          <td>${formatNumber(trade.суммарныеКомиссии ?? trade.комиссия)}</td>
          <td>${escapeHtml(trade.причина || '-')}</td>
        </tr>
      `;
    });

  elements.tradesTable.innerHTML = rows.join('');
}

function renderLogs() {
  elements.logsContainer.innerHTML = state.recentEvents
    .slice(0, 80)
    .map((entry) => {
      return `
        <div class="log-entry">
          <div class="log-header">
            <strong>${escapeHtml(entry.tag)}: ${escapeHtml(entry.title)}</strong>
            <span class="muted">${formatDate(entry.timestamp)}</span>
          </div>
          <pre>${escapeHtml(JSON.stringify(entry.payload, null, 2))}</pre>
        </div>
      `;
    })
    .join('');
}

function renderChart() {
  const points = state.equityHistory;
  if (!points.length) {
    elements.chart.innerHTML = '';
    return;
  }

  const values = points.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const polyline = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * 1000;
      const y = 300 - ((point.equity - min) / range) * 260;
      return `${x},${y}`;
    })
    .join(' ');

  elements.chart.innerHTML = `
    <rect x="0" y="0" width="1000" height="320" fill="rgba(2, 6, 23, 0.15)"></rect>
    <line x1="0" y1="300" x2="1000" y2="300" stroke="rgba(148, 163, 184, 0.14)" />
    <polyline
      fill="none"
      stroke="#38bdf8"
      stroke-width="4"
      stroke-linejoin="round"
      stroke-linecap="round"
      points="${polyline}"
    />
    <text x="12" y="22" fill="#94a3b8" font-size="14">Мин: ${formatNumber(min)}</text>
    <text x="12" y="42" fill="#94a3b8" font-size="14">Макс: ${formatNumber(max)}</text>
  `;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatNumber(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? value.toString()
      : value.toFixed(6).replace(/\.?0+$/, '');
  }

  return String(value);
}

function formatValue(value) {
  if (value && typeof value === 'object') {
    return escapeHtml(JSON.stringify(value));
  }

  return escapeHtml(formatNumber(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

connect();
