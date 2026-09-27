# crypto-bot — заметки для Claude

Бот для Binance на NestJS/TypeScript. Основной режим — **трендовый аллокатор** BTC/ETH
(`src/allocator`), управление из веб-интерфейса (`src/web/public`). Старые внутридневные
стратегии (`src/bot`, `src/strategy`, `src/trader`) включаются только `BOT_STRATEGY_MODE=intraday`
и на истории убыточны.

## Команды

```bash
npm test                      # юнит-тесты
npm run test:e2e              # HTTP API целиком (supertest)
npm run build                 # сборка в dist/
npm run start:dev             # запуск, дашборд http://127.0.0.1:3200
npm run allocator:backtest    # бэктест аллокатора на истории Binance
npm run diagnose -- --since 7d   # отчёт для расследования (см. ниже)
npm run logs -- --help           # фильтр журнала
```

Правила: не печатать содержимое `.env` (там ключи Binance), не запускать `live_real`,
не удалять `.allocator-state.json` пользователя без его согласия.

## Расследование проблем

Если пользователь пишет «что-то пошло не так», начинать всегда с отчёта:

```bash
npm run diagnose -- --since 7d
```

В нём: сборка и коммит, настройки без секретов, состояние сессии из `.allocator-state.json`,
**подсказки**, сгруппированные ошибки и предупреждения, простои процесса, хронология решений.
Дальше — точечно через `npm run logs`:

```bash
npm run logs -- --op <opId> --full          # всё, что произошло в одной операции
npm run logs -- --request <requestId> --full  # всё, что вызвал HTTP-запрос (X-Request-Id)
npm run logs -- --session <sessionId> --level info --limit 0
npm run logs -- --since 3d --event "allocator.rebalance.*,allocator.order.*"
npm run logs -- --since 7d --level warn
```

После `npm run build` те же инструменты: `node dist/diagnostics/diagnose-cli.js`,
`node dist/diagnostics/logs-cli.js`.

### Где лежит журнал

- `logs/app-YYYY-MM-DD.jsonl` (день по UTC), части `app-YYYY-MM-DD.N.jsonl` при превышении
  `BOT_LOG_MAX_FILE_MB`; хранится `BOT_LOG_RETENTION_DAYS` дней (по умолчанию 14).
- Папка меняется через `BOT_LOG_DIR`, уровень — `BOT_LOG_LEVEL` (по умолчанию `debug`;
  `trace` добавляет опросы страницы, успешные запросы к Binance и служебные сообщения Nest).
- Одна строка — один JSON: `ts, level, event, msg, pid, requestId?, op?, opId?, sessionId?, mode?, durationMs?, data?, err?`.
- Секреты маскируются автоматически (`src/observability/sanitize.ts`): ключи с
  secret/key/token/signature → `[REDACTED]`, `signature=` в тексте ошибок тоже.

### Как связаны события

- `opId` — одна операция движка: `start-…`, `stop-…`, `autostop-…`, `tick-…` (раз в 5 минут),
  `resume-…` (после рестарта), `manual_rebalance-…`.
- `requestId` — один HTTP-запрос; тот же id в заголовке ответа `X-Request-Id`.
  Запуск/остановка из интерфейса дают и `requestId`, и `opId`.
- `sessionId` — сессия бота (от «Начать» до «Остановить»), совпадает с `id` в файле состояния.

### Каталог событий

| Событие | Уровень | Что значит |
| --- | --- | --- |
| `process.started` / `process.ready` | info | Старт: версия, коммит, `gitDirty`, настройки |
| `process.heartbeat` | debug | Каждые 5 мин: uptime, память, задержка event loop. Пропуски = процесс не работал |
| `process.shutdown` / `process.exit` | info | Штатная остановка |
| `process.uncaught_exception` / `process.unhandled_rejection` / `process.bootstrap_failed` | fatal/error | Падения |
| `session.store.loaded` / `session.store.persist_failed` | info/error | Файл состояния |
| `allocator.idle` / `allocator.session.resumed` / `allocator.session.resume_blocked` | info/error | Поведение после рестарта |
| `allocator.session.start_requested` / `started` / `start_rejected` | info/warn | Запуск и причина отказа |
| `allocator.rebalance.started` / `signals` / `plan` / `completed` | info | Ежедневное решение: сигналы SMA, цены, план ордеров |
| `allocator.rebalance.failed` / `deferred` | warn/debug | Решение не принято; `nextAttemptAt` — когда повтор |
| `allocator.order.filled` / `allocator.order.failed` | info/error | Исполнение ордера (fill, order, остатки после) |
| `allocator.cycle.completed` | debug | Итог проверки: капитал, цены, возраст цен, lastError |
| `allocator.autostop.triggered` / `skipped_stale_prices` | warn | Автозащита: сработала / пропущена без свежих цен |
| `allocator.session.stopped` / `autostopped` / `stop_unsold` | info/error | Остановка и что не удалось продать |
| `allocator.reconcile.adjusted` | warn | Учёт уменьшен по балансу Binance (деньги двигали вручную) |
| `allocator.prices.refresh_failed` | warn | Не удалось получить цены |
| `binance.http.failed` | warn | Публичный REST Binance: url, params, код, ответ |
| `broker.binance.connected` / `connect_failed` | info/error | Подключение с ключами (live_testnet/live_real) |
| `broker.binance.order_request` / `order_response` / `order_failed` | info/error | Реальный ордер: что отправили и что ответила биржа |
| `broker.binance.balance` / `broker.paper.fill` | debug | Остатки на бирже / виртуальные сделки |
| `http.request` | info/warn/error | Команды API; 4xx/5xx; для 403 — host/origin/contentType |
| `nest.*` | warn/error | Ошибки NestJS (исключения в контроллерах и т.п.) |
| `bot.info` / `bot.error` / `trade.executed` / `strategy.signal` / `market.candle` / `portfolio.snapshot` | разные | Режим intraday (старые стратегии) |

### Симптом → куда смотреть

- **Бот ничего не купил.** `allocator.rebalance.signals` (exposure = 0 → рынок не в тренде, это норма),
  `allocator.rebalance.plan` (`skipped` — меньше минимального ордера), `allocator.rebalance.failed`.
- **Решение за день не принято.** Простои в отчёте с пометкой «пропущено ежедневное решение»
  (компьютер спал), `allocator.rebalance.failed` / `deferred`, `binance.http.failed`.
- **Бот неожиданно продал всё.** `allocator.autostop.triggered` (equity, threshold, prices),
  `allocator.session.stopped` с `requestId` — значит, остановили из интерфейса.
- **Биржа отклоняет ордера.** `broker.binance.order_failed` → `err.name/message`
  (InsufficientFunds, MIN_NOTIONAL, LOT_SIZE, права ключа), рядом `allocator.order.failed` с планом.
- **Учёт не совпадает с Binance.** `allocator.reconcile.adjusted`, `broker.binance.balance`.
- **Страница не открывается / 403.** `http.request` уровня warn: host/origin — проверка
  `src/web/security`.
- **Процесс падал или зависал.** `process.uncaught_exception`, `process.bootstrap_failed`,
  большой `eventLoopDelayMaxMs` в `process.heartbeat`, простои.
- **Поведение не совпадает с кодом.** `process.started.data.gitCommit` и `gitDirty`.

### Если логов не хватает

Добавляй события через `AppLogger` (`src/observability/app-logger.ts`), имя —
`<область>.<объект>.<действие>`, данные — в `data`, ошибку — отдельным аргументом.
Внутри операций движка контекст (`opId`, `sessionId`) добавится сам. Новое событие
допиши в таблицу выше. Не пиши в журнал ключи и полные ответы с балансами без нужды.
