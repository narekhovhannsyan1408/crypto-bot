const state = {
  recentEvents: [],
  recentTrades: [],
  equityHistory: [],
  runtime: null,
  socket: null,
  logFilter: 'ALL',
  logSearch: '',
};

const elements = {
  connectionStatus: document.getElementById('connection-status'),
  dataFreshness: document.getElementById('data-freshness'),
  metricsGrid: document.getElementById('metrics-grid'),
  executionStatus: document.getElementById('execution-status'),
  positionsTable: document.getElementById('positions-table'),
  positionsCount: document.getElementById('positions-count'),
  universeList: document.getElementById('universe-list'),
  riskState: document.getElementById('risk-state'),
  strategySelectionSummary: document.getElementById('strategy-selection-summary'),
  activeStrategiesList: document.getElementById('active-strategies-list'),
  strategyCandidatesList: document.getElementById('strategy-candidates-list'),
  tradesTable: document.getElementById('trades-table'),
  logsContainer: document.getElementById('logs-container'),
  logFilterGroup: document.getElementById('log-filter-group'),
  logSearchInput: document.getElementById('log-search-input'),
  chart: document.getElementById('equity-chart'),
  panicButton: document.getElementById('panic-button'),
  liquidateSpotAssetsButton: document.getElementById('liquidate-spot-assets-button'),
  refreshButton: document.getElementById('refresh-button'),
  refreshExecutionButton: document.getElementById('refresh-execution-button'),
  allocatorPanel: document.getElementById('allocator-panel'),
  allocatorStatus: document.getElementById('allocator-status'),
  allocatorMetrics: document.getElementById('allocator-metrics'),
  allocatorAssets: document.getElementById('allocator-assets'),
  allocatorRebalanceButton: document.getElementById('allocator-rebalance-button'),
  allocatorStopButton: document.getElementById('allocator-stop-button'),
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
      if (message.payload?.snapshot) {
        state.runtime = message.payload.snapshot;
        renderAll();
      }

      alert(
        typeof message.payload === 'object'
          ? JSON.stringify(message.payload, null, 2)
          : String(message.payload),
      );
    }
  });

  const sendAllocatorCommand = (payload) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      window.alert('Нет активного WebSocket-соединения с dashboard');
      return;
    }
    state.socket.send(JSON.stringify(payload));
  };

  elements.allocatorRebalanceButton.onclick = () => {
    sendAllocatorCommand({ type: 'allocator_rebalance_now' });
  };

  elements.allocatorStopButton.onclick = () => {
    const phrase = window.prompt(
      'Бот продаст все свои монеты в USDT и остановится. Для подтверждения введи SELL ALL',
    );
    if (phrase !== 'SELL ALL') {
      return;
    }
    sendAllocatorCommand({
      type: 'allocator_pause_liquidate',
      confirmationPhrase: phrase,
      reason: 'Остановка аллокатора из web dashboard',
    });
  };

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

  elements.liquidateSpotAssetsButton.onclick = () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      window.alert('Нет активного WebSocket-соединения с dashboard');
      return;
    }

    const execution = state.runtime?.execution;
    if (
      !execution ||
      (execution.marketType !== 'spot' && execution.marketType !== 'hybrid') ||
      execution.mode === 'paper'
    ) {
      window.alert('Команда доступна только для режимов live spot или hybrid');
      return;
    }

    const isConfirmed = window.confirm(
      'Продать все внешние non-USDT spot-активы в USDT market-ордерами?',
    );
    if (!isConfirmed) {
      return;
    }

    const confirmationPhrase = window.prompt(
      'Для подтверждения введи фразу LIQUIDATE SPOT',
      '',
    );

    if (confirmationPhrase !== 'LIQUIDATE SPOT') {
      window.alert('Подтверждение не прошло. Команда отменена.');
      return;
    }

    state.socket.send(
      JSON.stringify({
        type: 'liquidate_spot_assets',
        confirmationPhrase,
        reason: 'Ликвидация всех внешних spot-активов из web dashboard',
      }),
    );
  };

  elements.refreshButton.onclick = () => {
    socket.send(JSON.stringify({ type: 'request_snapshot' }));
  };

  elements.refreshExecutionButton.onclick = () => {
    socket.send(JSON.stringify({ type: 'refresh_execution_status' }));
  };

  document.querySelectorAll('[data-execution-mode]').forEach((button) => {
    button.onclick = () => {
      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        window.alert('Нет активного WebSocket-соединения с dashboard');
        return;
      }

      const mode = button.dataset.executionMode;
      const marketType = button.dataset.marketType;

      if (!mode || !marketType) {
        return;
      }

      let confirmationPhrase;
      if (mode === 'live_real') {
        const isConfirmed = window.confirm(
          `Включить ${mode} / ${marketType}? Это может отправлять реальные ордера.`,
        );
        if (!isConfirmed) {
          return;
        }

        confirmationPhrase = window.prompt(
          'Для подтверждения LIVE REAL введи фразу ENABLE LIVE',
          '',
        );
      }

      state.socket.send(
        JSON.stringify({
          type: 'set_execution_mode',
          mode,
          marketType,
          confirmationPhrase,
        }),
      );
    };
  });

  elements.logFilterGroup.onclick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest('[data-log-filter]');
    if (!button) {
      return;
    }

    state.logFilter = button.dataset.logFilter || 'ALL';
    renderLogs();
    renderLogFilters();
  };

  elements.logSearchInput.oninput = (event) => {
    const target = event.target;
    state.logSearch = target instanceof HTMLInputElement ? target.value : '';
    renderLogs();
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
  const ts = state.runtime?.generatedAt;
  if (elements.dataFreshness) {
    elements.dataFreshness.textContent = ts
      ? 'Обновлено: ' + new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : '—';
  }

  renderAllocator();
  renderMetrics();
  renderExecution();
  renderPositions();
  renderUniverse();
  renderRiskState();
  renderStrategySelection();
  renderTrades();
  renderLogFilters();
  renderLogs();
  renderChart();
}

function renderAllocator() {
  const allocator = state.runtime?.allocator;
  const isAllocatorMode = state.runtime?.strategyMode === 'trend_allocator';
  document.body.classList.toggle('allocator-mode', isAllocatorMode);
  elements.allocatorPanel.hidden = !isAllocatorMode;
  if (!isAllocatorMode || !allocator) {
    return;
  }

  elements.allocatorStatus.textContent = [allocator.статус, allocator.режим, allocator.сигнал]
    .filter(Boolean)
    .join(' · ');
  const metrics = [
    ['Капитал аллокатора', allocator.капитал, 'USDT + стоимость монет в кармане'],
    ['Стартовый капитал', allocator.стартовыйКапитал, 'С чего начал карман'],
    ['Результат %', allocator.результатВПроцентах, 'Изменение капитала с начала'],
    ['USDT в кармане', allocator.usdt, 'Свободные средства аллокатора'],
    ['Последний сигнал', allocator.последнийСигнал || '—', 'Дневная свеча (UTC), по которой выставлены доли'],
  ];
  if (allocator.ошибка) {
    metrics.push(['Ошибка', allocator.ошибка, 'Последняя ошибка цикла']);
  }

  elements.allocatorMetrics.innerHTML = metrics
    .map(([label, value, hint]) => {
      const tone =
        label === 'Результат %' && typeof value === 'number'
          ? value >= 0
            ? 'positive'
            : 'negative'
          : '';
      const formatted =
        label === 'Результат %' && typeof value === 'number'
          ? formatSignedNumber(value)
          : typeof value === 'number'
            ? formatNumber(value)
            : escapeHtml(value ?? '—');
      return `
        <div class="metric-card ${tone}">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${formatted}</div>
          <div class="metric-subtitle">${escapeHtml(hint)}</div>
        </div>
      `;
    })
    .join('');

  elements.allocatorAssets.innerHTML =
    (allocator.активы || [])
      .map(
        (asset) => `
        <tr>
          <td>${escapeHtml(asset.символ)}</td>
          <td>${escapeHtml(asset.тренд)}</td>
          <td>${asset.целевойВес === null ? '—' : `${formatNumber(asset.целевойВес)}%`}</td>
          <td>${formatNumber(asset.текущийВес)}%</td>
          <td>${formatNumber(asset.количество)}</td>
          <td>${formatNumber(asset.цена)}</td>
          <td>${formatNumber(asset.стоимость)}</td>
        </tr>
      `,
      )
      .join('') ||
    `<tr><td colspan="7">${renderEmptyState('Сигналы ещё не рассчитаны.', 'Первая ребалансировка произойдёт сразу после запуска.')}</td></tr>`;
}

function renderExecution() {
  const execution = state.runtime?.execution;
  if (!execution) {
    elements.executionStatus.innerHTML = '';
    return;
  }

  const streamStatusMap = {
    connected: 'подключён',
    disconnected: 'не подтверждён',
    error: 'ошибка',
    unknown: 'неизвестно',
  };
  const spotAssetsPreview =
    execution.spotAssetsPreview && execution.spotAssetsPreview.length > 0
      ? execution.spotAssetsPreview.join(', ') +
        (execution.spotAssetsCount > execution.spotAssetsPreview.length ? ' ...' : '')
      : '-';

  const chipClass =
    execution.mode === 'paper'
      ? 'paper'
      : execution.mode === 'live_testnet'
        ? 'testnet'
        : 'live';
  const modeLabel =
    execution.mode === 'paper'
      ? 'paper'
      : execution.mode === 'live_testnet'
        ? 'live_demo'
        : 'live_real';
  const routeSummary =
    execution.longMarketType && execution.shortMarketType
      ? `LONG -> ${execution.longMarketType}, SHORT -> ${execution.shortMarketType}`
      : '-';
  const spotBalanceSummary =
    execution.spotQuoteFree === null &&
    execution.spotQuoteTotal === null
      ? 'недоступно'
      : `${formatNumber(execution.spotQuoteFree)} / ${formatNumber(execution.spotQuoteTotal)} USDT`;
  const futuresBalanceSummary =
    execution.futuresQuoteFree === null &&
    execution.futuresQuoteTotal === null
      ? 'недоступно'
      : `${formatNumber(execution.futuresQuoteFree)} / ${formatNumber(execution.futuresQuoteTotal)} USDT`;
  const warnings = execution.warnings || [];
  const statusTone =
    execution.accountConnectivity === 'ok'
      ? 'success'
      : execution.accountConnectivity === 'error'
        ? 'danger'
        : 'neutral';

  elements.executionStatus.innerHTML = `
    <div class="execution-topline">
      <div class="execution-chip ${chipClass}">${escapeHtml(execution.label)}</div>
      <div class="badge-row">
        ${renderBadge(modeLabel, 'neutral')}
        ${renderBadge(execution.marketType, 'neutral')}
        ${renderBadge(
          execution.accountConnectivity === 'ok' ? 'Binance OK' : 'Binance issue',
          statusTone,
        )}
        ${renderBadge(execution.canTradeShort ? 'Short enabled' : 'Short disabled', execution.canTradeShort ? 'success' : 'warning')}
      </div>
    </div>
    <div class="execution-balance-grid">
      <div class="info-card">
        <div class="info-card-label">Spot</div>
        <div class="info-card-value">${escapeHtml(spotBalanceSummary)}</div>
        <div class="info-card-subtitle">free / total USDT</div>
      </div>
      <div class="info-card">
        <div class="info-card-label">Futures</div>
        <div class="info-card-value">${escapeHtml(futuresBalanceSummary)}</div>
        <div class="info-card-subtitle">free / total USDT</div>
      </div>
      <div class="info-card">
        <div class="info-card-label">Итого</div>
        <div class="info-card-value">${formatNumber(execution.quoteTotal)}</div>
        <div class="info-card-subtitle">total USDT по всем venue</div>
      </div>
    </div>
    <div class="execution-kv">
      <div class="kv-row"><span>Routing</span><strong>${escapeHtml(routeSummary)}</strong></div>
      <div class="kv-row"><span>Demo mode</span><strong>${execution.usingTestnet ? 'да' : 'нет'}</strong></div>
      <div class="kv-row"><span>API configured</span><strong>${execution.apiConfigured ? 'да' : 'нет'}</strong></div>
      <div class="kv-row"><span>Private stream</span><strong>${escapeHtml(streamStatusMap[execution.userDataStreamStatus || 'unknown'] || 'неизвестно')}</strong></div>
      <div class="kv-row"><span>Последнее user-data событие</span><strong>${execution.userDataStreamLastEventAt ? escapeHtml(formatDate(execution.userDataStreamLastEventAt)) : '-'}</strong></div>
      <div class="kv-row"><span>Последний execution report</span><strong>${execution.userDataStreamLastExecutionReportAt ? escapeHtml(formatDate(execution.userDataStreamLastExecutionReportAt)) : '-'}</strong></div>
      <div class="kv-row"><span>Открытых spot-ордеров</span><strong>${formatNumber(execution.openSpotOrdersCount)}</strong></div>
      <div class="kv-row"><span>Spot активов</span><strong>${formatNumber(execution.spotAssetsCount)}</strong></div>
      <div class="kv-row"><span>Превью активов</span><strong>${escapeHtml(spotAssetsPreview)}</strong></div>
    </div>
    ${execution.lastError ? `<div class="status-banner danger"><strong>Последняя ошибка:</strong> ${escapeHtml(execution.lastError)}</div>` : ''}
    ${
      warnings.length > 0
        ? `<div class="status-section">
            <div class="status-section-title">Предупреждения</div>
            <ul class="status-list">
              ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}
            </ul>
          </div>`
        : ''
    }
  `;
}

function renderMetrics() {
  const portfolio = state.runtime?.portfolio;
  const execution = state.runtime?.execution;
  if (!portfolio) {
    elements.metricsGrid.innerHTML = '';
    return;
  }

  const totalPnl =
    Number(portfolio.реализованныйРезультат ?? 0) + Number(portfolio.плавающийРезультат ?? 0);
  const metrics = [
    ['Баланс бота', portfolio.баланс, 'Баланс, который бот сейчас использует в портфеле'],
    ['Капитал бота', portfolio.капитал, 'Баланс + стоимость открытых позиций'],
    [
      'Spot свободно',
      execution?.spotQuoteFree ?? null,
      'Свободный USDT на Binance Spot',
    ],
    [
      'Spot всего',
      execution?.spotQuoteTotal ?? null,
      'Свободный + locked USDT на Binance Spot',
    ],
    [
      'Futures свободно',
      execution?.futuresQuoteFree ?? null,
      'Свободный USDT на Binance Futures',
    ],
    [
      'Futures всего',
      execution?.futuresQuoteTotal ?? null,
      'Общий USDT на Binance Futures',
    ],
    [
      'Реализованный PnL',
      portfolio.реализованныйРезультат,
      'Прибыль/убыток по уже закрытым сделкам',
    ],
    [
      'Плавающий PnL',
      portfolio.плавающийРезультат,
      'Текущий нереализованный результат по открытым позициям',
    ],
    ['Суммарный PnL', totalPnl, 'Реализованный + плавающий результат'],
    ['Комиссии', portfolio.уплаченоКомиссий, 'Все комиссии, уже учтённые ботом'],
    ['Макс. просадка %', portfolio.максимальнаяПросадкаВПроцентах, 'Историческая просадка'],
    ['Открытых позиций', portfolio.открытыхПозиций, 'Активные позиции сейчас'],
    [
      'Активных стратегий',
      Object.keys(portfolio.экспозицияПоСтратегиям || {}).length,
      'Сколько стратегий сейчас задействовано в портфеле',
    ],
    ['Винрейт %', portfolio.винрейт, 'Доля прибыльных закрытых сделок'],
  ];

  elements.metricsGrid.innerHTML = metrics
    .map(([label, value, hint]) => {
      const cssClass =
        typeof value === 'number' &&
        isPnlMetric(label) &&
        value > 0
          ? 'positive'
          : typeof value === 'number' &&
              (isPnlMetric(label) || label === 'Макс. просадка %') &&
              value < 0
            ? 'negative'
            : '';
      const valueClass =
        label === 'Макс. просадка %' && typeof value === 'number' && value > 0 ? 'warning' : '';
      const formattedValue =
        typeof value === 'number' && isPnlMetric(label) ? formatSignedNumber(value) : formatNumber(value);

      return `
        <div class="metric-card ${cssClass}">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value ${valueClass}">${formattedValue}</div>
          <div class="metric-subtitle">${escapeHtml(hint || '')}</div>
        </div>
      `;
    })
    .join('');
}

function renderPositions() {
  const positions = state.runtime?.portfolio?.позиций || [];
  elements.positionsCount.textContent = String(positions.length);

  if (positions.length === 0) {
    const portfolio = state.runtime?.portfolio || {};
    const riskState = state.runtime?.рискМенеджмент || {};
    const selection = state.runtime?.strategySelection;
    const consecutiveLosses = portfolio.подрядУбыточныхСделок ?? 0;
    const maxLosses = riskState.лимитПодрядУбыточныхСделок ?? 4;
    const lastReason = selection?.причина || (consecutiveLosses >= maxLosses
      ? `Подряд убытков: ${consecutiveLosses}/${maxLosses} — блокировка новых входов до cooldown`
      : '');
    elements.positionsTable.innerHTML = `
      <tr>
        <td colspan="12">${renderEmptyState('Нет открытых позиций.', lastReason || 'Проверь блоки «Автоподбор стратегии» и «Риск-менеджмент».')}</td>
      </tr>`;
    return;
  }

  elements.positionsTable.innerHTML = positions
    .map((position) => {
      const pnlClass = position.плавающийРезультат >= 0 ? 'profit' : 'loss';
      return `
        <tr>
          <td>${escapeHtml(position.символ)}</td>
          <td>${escapeHtml(position.стратегия || position.strategyId || '-')}</td>
          <td>${renderBadge(position.сторона, position.сторона === 'ЛОНГ' ? 'success' : 'danger')}</td>
          <td>${renderBadge(position.рынокИсполнения || '-', 'neutral')}</td>
          <td>${formatNumber(position.ценаВхода)}</td>
          <td>${formatNumber(position.текущаяЦена)}</td>
          <td>${formatNumber(position.времяВПозицииМинут)}</td>
          <td class="${pnlClass}">${formatSignedNumber(position.плавающийРезультат)}</td>
          <td>${formatNumber(position.стопЦена)}</td>
          <td>${formatNumber(position.тейкЦена)}</td>
          <td>${renderBadge(position.breakevenАктивен === 'да' ? 'Breakeven' : 'Стандарт', position.breakevenАктивен === 'да' ? 'success' : 'neutral')}</td>
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
  elements.universeList.innerHTML = symbols.length
    ? symbols.map((symbol) => `<li>${escapeHtml(symbol)}</li>`).join('')
    : '<li class="tag-list-empty">Пока нет активного universe</li>';
}

function renderRiskState() {
  const riskState = state.runtime?.рискМенеджмент || {};
  elements.riskState.innerHTML = Object.entries(riskState)
    .map(
      ([key, value]) => `
        <div class="kv-row">
          <span>${escapeHtml(humanizeKey(key))}</span>
          <strong>${formatValue(value)}</strong>
        </div>
      `,
    )
    .join('');
}

function renderStrategySelection() {
  const selection = state.runtime?.strategySelection;
  const activeStrategies = state.runtime?.activeStrategies || [];

  elements.activeStrategiesList.innerHTML = activeStrategies
    .map((strategy) => `<li>${escapeHtml(strategy.name || strategy.id || '-')}</li>`)
    .join('') || '<li class="tag-list-empty">Стратегии не активированы</li>';

  if (!selection) {
    elements.strategySelectionSummary.innerHTML = `
      <div class="strategy-summary-card">
        <div class="muted">Автоподбор ещё не делал выбор. Блок заполнится после первого конфликта кандидатов или первого входа.</div>
      </div>
    `;
    elements.strategyCandidatesList.innerHTML = `
      <div class="candidate-card">
        <div class="muted">Пока нет данных по кандидатам.</div>
      </div>
    `;
    return;
  }

  elements.strategySelectionSummary.innerHTML = `
    <div class="strategy-summary-card">
      <div class="strategy-summary-head">
        <div class="selection-badge ${selection.сторона === 'ЛОНГ' ? 'long' : selection.сторона === 'ШОРТ' ? 'short' : 'neutral'}">
          ${escapeHtml(selection.сторона || 'нет сигнала')}
        </div>
        <div class="muted">${formatDate(selection.время)}</div>
      </div>
      <div class="strategy-summary-title">${escapeHtml(selection.выбраннаяСтратегия || 'нет')}</div>
      <div class="kv-list">
        <div class="kv-row"><span>Символ</span><strong>${escapeHtml(selection.символ || '-')}</strong></div>
        <div class="kv-row"><span>Strategy ID</span><strong>${escapeHtml(selection.strategyId || '-')}</strong></div>
        <div class="kv-row"><span>Итоговая оценка</span><strong>${formatNumber(selection.оценка)}</strong></div>
        <div class="kv-row"><span>Режим выбора</span><strong>${escapeHtml(state.runtime?.strategySelectionMode || '-')}</strong></div>
      </div>
      <div class="strategy-summary-reason">${escapeHtml(selection.причина || '-')}</div>
    </div>
  `;

  elements.strategyCandidatesList.innerHTML = (selection.кандидаты || [])
    .map((candidate) => {
      const statusClass = candidate.статус === 'выбрана' ? 'selected' : 'rejected';
      return `
        <div class="candidate-card ${statusClass}">
          <div class="candidate-head">
            <strong>${escapeHtml(candidate.стратегия || candidate.strategyId || '-')}</strong>
            <span class="candidate-status">${escapeHtml(candidate.статус || '-')}</span>
          </div>
          <div class="candidate-grid">
            <div class="kv-row"><span>Сторона</span><strong>${escapeHtml(candidate.сторона || '-')}</strong></div>
            <div class="kv-row"><span>Режим рынка</span><strong>${escapeHtml(candidate.режимРынка || '-')}</strong></div>
            <div class="kv-row"><span>Entry score</span><strong>${formatNumber(candidate.entryScore)}</strong></div>
            <div class="kv-row"><span>Arbitration score</span><strong>${formatNumber(candidate.arbitrationScore)}</strong></div>
          </div>
          <div class="candidate-reason">${escapeHtml(candidate.причина || '-')}</div>
        </div>
      `;
    })
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
          <td>${renderBadge(trade.действие || '-', 'neutral')}</td>
          <td>${renderBadge(trade.сторона || '-', trade.сторона === 'ЛОНГ' ? 'success' : trade.сторона === 'ШОРТ' ? 'danger' : 'neutral')}</td>
          <td>${formatNumber(trade.ценаВхода ?? trade.цена)}</td>
          <td>${formatNumber(trade.ценаВыхода)}</td>
          <td class="${pnlClass}">${formatSignedNumber(trade.чистыйРезультат)}</td>
          <td>${formatNumber(trade.суммарныеКомиссии ?? trade.комиссия)}</td>
          <td>${escapeHtml(trade.причина || '-')}</td>
        </tr>
      `;
    });

  elements.tradesTable.innerHTML =
    rows.join('') ||
    `<tr><td colspan="10">${renderEmptyState('Пока нет завершённых сделок.', 'После первых открытий и закрытий история появится здесь.')}</td></tr>`;
}

function renderLogs() {
  const search = state.logSearch.trim().toLowerCase();
  const logsMarkup = state.recentEvents
    .slice(0, 80)
    .filter((entry) => matchesLogFilter(entry, state.logFilter))
    .filter((entry) => {
      if (!search) {
        return true;
      }

      const haystack = [
        entry.tag,
        entry.title,
        safeStringify(entry.payload),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(search);
    })
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
  elements.logsContainer.innerHTML =
    logsMarkup || renderEmptyState('Нет логов для текущего фильтра.', 'Смени фильтр или дождись новых событий.');
}

function renderLogFilters() {
  const buttons = elements.logFilterGroup.querySelectorAll('[data-log-filter]');
  for (const button of buttons) {
    const isActive = button.dataset.logFilter === state.logFilter;
    button.classList.toggle('active', isActive);
  }
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

function formatSignedNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return formatNumber(value);
  }

  const formatted = formatNumber(Math.abs(value));
  if (value > 0) {
    return `+${formatted}`;
  }
  if (value < 0) {
    return `-${formatted}`;
  }
  return formatted;
}

function isPnlMetric(label) {
  return (
    label === 'Реализованный PnL' ||
    label === 'Плавающий PnL' ||
    label === 'Суммарный PnL'
  );
}

function formatValue(value) {
  if (value && typeof value === 'object') {
    return escapeHtml(JSON.stringify(value));
  }

  return escapeHtml(formatNumber(value));
}

function humanizeKey(value) {
  return String(value)
    .replace(/([a-zа-я])([A-ZА-Я])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderBadge(label, tone = 'neutral') {
  return `<span class="inline-badge ${tone}">${escapeHtml(label)}</span>`;
}

function renderEmptyState(title, subtitle = '') {
  return `
    <div class="empty-state">
      <div class="empty-state-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="empty-state-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;
}

function matchesLogFilter(entry, filter) {
  if (filter === 'ALL') {
    return true;
  }

  if (filter === 'RISK') {
    const haystack = `${entry.tag} ${entry.title} ${safeStringify(entry.payload)}`.toLowerCase();
    return (
      haystack.includes('риск') ||
      haystack.includes('risk') ||
      haystack.includes('лимит') ||
      haystack.includes('отклонил сделку')
    );
  }

  return entry.tag === filter;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
