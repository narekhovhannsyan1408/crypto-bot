# Crypto Bot

Production-oriented алгоритмический крипто-бот на `Node.js`, `NestJS` и `TypeScript` с:

- получением рыночных данных через `Binance WebSocket`
- multi-pair runtime
- paper trading execution
- risk management на уровне портфеля
- market scanner для построения universe
- каркасом backtesting engine
- подробными русскоязычными логами

Этот `README.md` является главным и единственным документом проекта.

## Содержание

1. [Назначение проекта](#назначение-проекта)
2. [Текущий статус](#текущий-статус)
3. [Что умеет бот](#что-умеет-бот)
4. [Как устроена система](#как-устроена-система)
5. [Бизнес-логика бота](#бизнес-логика-бота)
6. [Стратегия](#стратегия)
7. [Risk management](#risk-management)
8. [Market scanner и universe](#market-scanner-и-universe)
9. [Paper trading](#paper-trading)
10. [Backtesting engine](#backtesting-engine)
11. [Требования](#требования)
12. [Установка](#установка)
13. [Быстрый старт за 5 минут](#быстрый-старт-за-5-минут)
14. [Настройка окружения](#настройка-окружения)
15. [Таблица переменных окружения](#таблица-переменных-окружения)
16. [Как правильно использовать бота](#как-правильно-использовать-бота)
17. [Команды проекта](#команды-проекта)
18. [Логи](#логи)
19. [Пример реального лога](#пример-реального-лога)
20. [Пример backtest report](#пример-backtest-report)
21. [Типичные ошибки и как их диагностировать](#типичные-ошибки-и-как-их-диагностировать)
22. [Структура проекта](#структура-проекта)
23. [Ограничения текущей версии](#ограничения-текущей-версии)
24. [Что улучшать дальше](#что-улучшать-дальше)
25. [Практические рекомендации](#практические-рекомендации)

## Назначение проекта

Проект предназначен для разработки и эволюции алгоритмической торговой системы для крипторынка.

Основная цель бота:

- искать торговые возможности в ликвидных крипто-парах
- входить в рынок только при наличии допустимого риска
- управлять несколькими символами одновременно
- считать честный результат торговли
- давать базу для дальнейшего перехода от paper trading к production execution

Важно: на текущем этапе бот не торгует реальными деньгами. Он симулирует сделки.

## Текущий статус

Система находится на стадии `research / paper trading / architecture hardening`.

Что уже реализовано:

- multi-pair runtime
- per-symbol strategy state
- отдельный `RiskManager`
- multi-position portfolio
- trailing stop
- volatility filter
- trend strength filter
- cooldown между сделками
- market scanner с short-horizon enrichment
- каркас historical backtesting

Что ещё не реализовано полностью:

- реальные ордера на Binance
- persistent storage для сделок и equity history
- slippage model production-grade уровня
- correlation-aware risk management
- walk-forward optimization и batch research pipeline

## Что умеет бот

На текущий момент бот умеет:

- подключаться к Binance WebSocket
- загружать исторические свечи через REST
- строить рабочий universe символов
- анализировать рынок по нескольким инструментам одновременно
- рассчитывать сигналы стратегии на базе EMA, RSI, ATR и trend filter
- открывать и закрывать long/short позиции в paper trading
- сопровождать позиции через stop loss, take profit и trailing stop
- ограничивать сделки через `RiskManager`
- считать:
  - баланс
  - realized result
  - unrealized result
  - equity
  - fees paid
  - peak equity
  - max drawdown
  - total trades
  - wins / losses
  - win rate
- прогонять стратегию по историческим свечам через backtesting scaffold

## Как устроена система

Система разделена на несколько логических слоёв.

### `Market`

Слой рыночных данных.

Отвечает за:

- WebSocket-подключение к Binance
- подписку на несколько потоков свечей
- переподключение при разрывах
- загрузку истории через REST

### `Scanner`

Слой формирования universe.

Отвечает за:

- выбор торгуемых символов
- фильтрацию по ликвидности
- ранжирование по score
- обновление рабочего списка символов

### `Strategy`

Сигнальный слой.

Отвечает за:

- хранение истории свечей по каждому `symbol:interval`
- расчёт индикаторов
- фильтрацию шума
- выдачу торгового сигнала

### `Risk`

Слой допуска сделки.

Отвечает за:

- максимальное число позиций
- дневной лимит убытка
- ограничение просадки
- ограничение общей загрузки капитала
- ограничение после серии убытков
- допустимый размер новой позиции

### `Trader`

Слой исполнения.

Отвечает за:

- paper execution
- открытие/закрытие позиций
- комиссию
- сопровождение позиции
- stop / take / trailing behavior

### `Portfolio`

Финансовый слой.

Отвечает за:

- хранение баланса
- хранение открытых позиций
- mark-to-market оценку
- equity calculation
- trade history
- drawdown accounting

### `Backtest`

Исторический replay layer.

Отвечает за:

- прогон свечей на истории
- повторное использование стратегии, риска и исполнения
- построение отчёта

## Бизнес-логика бота

Ниже описан фактический рабочий цикл системы.

### 1. Старт приложения

При запуске бот:

- читает конфигурацию из переменных окружения
- определяет интервал торговли
- строит стартовый universe
- загружает исторические свечи по каждому символу
- прогревает индикаторы стратегии
- подписывается на рыночные потоки

### 2. Получение свечей

Бот работает на закрытых свечах.

Для каждой закрытой свечи:

- обновляется mark price по символу
- логируется новая свеча
- проверяется открытая позиция по этому символу

### 3. Проверка stop / take / trailing

Если по символу есть позиция:

- сначала проверяется stop loss
- затем take profit
- затем при необходимости обновляется trailing stop

Это важно, потому что защита капитала приоритетнее нового входа.

### 4. Анализ стратегии

Если позиция не была закрыта защитными условиями, бот рассчитывает сигнал.

Стратегия использует:

- быструю EMA
- медленную EMA
- RSI
- ATR
- оценку силы тренда
- cooldown после закрытия сделки

После этого стратегия отдаёт одно из решений:

- `OPEN_LONG`
- `OPEN_SHORT`
- `CLOSE_LONG`
- `CLOSE_SHORT`
- `REVERSE_TO_LONG`
- `REVERSE_TO_SHORT`
- `HOLD`

### 5. Проверка риска

Если стратегия предлагает открыть новую сделку, решение проходит через `RiskManager`.

`RiskManager` проверяет:

- нет ли уже позиции по символу
- не превышен ли лимит позиций
- не превышен ли лимит загрузки капитала
- не превышен ли лимит дневного убытка
- не достигнут ли лимит просадки
- не превышен ли лимит подряд убыточных сделок

Только после одобрения сделка может быть исполнена.

### 6. Исполнение paper trade

После одобрения:

- рассчитывается размер позиции
- удерживается входная комиссия
- открывается позиция
- фиксируются уровни stop / take / trailing

При закрытии:

- удерживается выходная комиссия
- считается валовый и чистый результат
- результат записывается в портфель

### 7. Обновление портфеля

После каждой торговой операции и каждой новой свечи система обновляет:

- realized result
- unrealized result
- equity
- fees
- drawdown
- статистику сделок

### 8. Пересборка universe

При активном сканере бот периодически:

- пересчитывает рейтинг символов
- обновляет рабочий набор инструментов
- добавляет новые интересные пары
- удаляет слабые пары, если по ним нет открытых позиций

## Стратегия

Текущая стратегия ближе к краткосрочному `trend-following / momentum intraday` подходу.

### Вход в long

Long рассматривается, если:

- fast EMA выше slow EMA
- RSI подтверждает бычий импульс
- волатильность находится в допустимом диапазоне
- сила тренда выше минимального порога
- завершён cooldown

### Вход в short

Short рассматривается, если:

- fast EMA ниже slow EMA
- RSI подтверждает медвежий импульс
- волатильность находится в допустимом диапазоне
- сила тренда выше минимального порога
- завершён cooldown

### Выход из позиции

Позиция закрывается при одном из условий:

- stop loss
- take profit
- trailing stop
- поломка рыночной структуры
- переворот сигнала стратегии

### Что важно понимать

Эта стратегия:

- лучше чувствует себя в направленных движениях
- хуже чувствует себя в пилящем боковике
- зависит от качества фильтра волатильности и режима рынка

## Risk management

Сейчас risk management уже выделен в отдельный слой.

### Что контролируется

- `BOT_RISK_PER_TRADE_PCT`
- `BOT_MAX_CONCURRENT_POSITIONS`
- `BOT_MAX_PORTFOLIO_EXPOSURE_PCT`
- `BOT_MAX_DRAWDOWN_STOP_PCT`
- `BOT_MAX_DAILY_LOSS_PCT`
- `BOT_MAX_CONSECUTIVE_LOSSES`

### Логика размера позиции

Размер позиции рассчитывается не просто как фиксированная сумма, а как ограниченный риск-бюджетом размер с дополнительными капами:

- max position size
- free balance
- remaining portfolio exposure
- risk-per-trade budget

### Что это даёт

- более стабильное поведение портфеля
- меньше риска разрушения капитала от одной идеи
- контроль торговли на уровне всей системы, а не только одного символа

## Market scanner и universe

Сканер оценивает символы по нескольким признакам:

- 24h изменение цены
- ликвидность
- недавнее движение
- внутридневная волатильность
- ускорение объёма
- эффективность движения

### Как использовать scanner правильно

Если бот работает в режиме сканера:

- ограничь universe через `BOT_ALLOWED_SYMBOLS`
- не задавай слишком большой `BOT_UNIVERSE_SIZE`
- следи, чтобы universe состоял из ликвидных пар
- не смешивай малоликвидные и топовые символы без необходимости

Рекомендуемый стартовый подход:

- universe size: `3-8`
- allowed symbols: только крупные ликвидные пары
- 1m или 5m интервал

## Paper trading

Paper trading симулирует:

- `OPEN_LONG`
- `CLOSE_LONG`
- `OPEN_SHORT`
- `CLOSE_SHORT`

### Что учитывается

- входная комиссия
- выходная комиссия
- стоп-уровни
- тейк-профит
- trailing stop
- PnL

### Что пока не учитывается полностью

- реальное проскальзывание
- частичное исполнение
- отклонённые биржей ордера
- биржевые фильтры по lot size / tick size

## Backtesting engine

В проекте уже есть каркас backtesting engine.

### Что он умеет сейчас

- принимать исторические свечи
- сортировать их
- прогонять через strategy + risk + paper execution
- строить equity curve
- возвращать итоговый отчёт

### Что он пока не умеет в полном объёме

- batch optimization
- walk-forward analysis
- Monte Carlo
- parameter sweep
- slippage model высокого качества
- сохранение результатов в БД

### Как использовать backtest сейчас

На текущем этапе это программный API, а не отдельная CLI-команда.

Пример использования:

```ts
import { BacktestEngineService } from './src/backtest/backtest-engine/backtest-engine.service';

const engine = new BacktestEngineService();

const report = engine.runBacktest({
  candles: historicalCandles,
});

console.log(report);
```

Важно: для production-level research этого ещё недостаточно. Это каркас, который нужно развивать дальше.

## Требования

Минимальные требования:

- `Node.js` 20+
- `npm` 10+
- доступ к Binance REST и WebSocket

Рекомендуется:

- `Node.js` 22+
- стабильный интернет
- отдельный `.env` для paper / test / production research режимов

## Установка

### 1. Клонируй проект

```bash
git clone <your-repo-url>
cd crypto-bot
```

### 2. Установи зависимости

```bash
npm install
```

### 3. Создай `.env`

Если файла `.env` ещё нет, создай его в корне проекта.

### 4. Заполни конфигурацию

Используй шаблон ниже как стартовую точку.

```env
BOT_SYMBOL=BTCUSDT
BOT_INTERVAL=1m
BOT_USE_SCANNER=true
BOT_SCAN_INTERVAL_MS=60000
BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH=8
BOT_UNIVERSE_SIZE=5

BOT_ALLOWED_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,LINKUSDT,AVAXUSDT,ATOMUSDT,NEARUSDT
BOT_MIN_QUOTE_VOLUME=1000000
BOT_SCANNER_SHORTLIST_SIZE=8
BOT_SCANNER_KLINE_LOOKBACK=30

BOT_INITIAL_BALANCE=1000
BOT_POSITION_SIZE_USDT=100
BOT_RISK_PER_TRADE_PCT=0.005
BOT_FEE_PCT=0.001
BOT_STOP_LOSS_PCT=0.012
BOT_TAKE_PROFIT_PCT=0.02
BOT_TRAILING_STOP_PCT=0.008
BOT_COOLDOWN_CANDLES=2

BOT_MIN_TREND_STRENGTH_PCT=0.0015
BOT_MIN_ATR_PCT=0.001
BOT_MAX_ATR_PCT=0.03
BOT_EMA_FAST_PERIOD=9
BOT_EMA_SLOW_PERIOD=21
BOT_RSI_PERIOD=14
BOT_RSI_LONG_THRESHOLD=55
BOT_RSI_SHORT_THRESHOLD=45

BOT_MAX_CONCURRENT_POSITIONS=3
BOT_MAX_PORTFOLIO_EXPOSURE_PCT=0.8
BOT_MAX_DRAWDOWN_STOP_PCT=0.15
BOT_MAX_DAILY_LOSS_PCT=0.04
BOT_MAX_CONSECUTIVE_LOSSES=4

BOT_DASHBOARD_ENABLED=true
BOT_DASHBOARD_HOST=127.0.0.1
BOT_DASHBOARD_PORT=3200

BINANCE_REST_BASE_URL=https://api.binance.com
BINANCE_WS_BASE_URL=wss://stream.binance.com/ws
```

## Быстрый старт за 5 минут

Если тебе нужно быстро запустить бота в безопасном paper trading режиме, используй такой порядок:

### 1. Установи зависимости

```bash
npm install
```

### 2. Создай `.env`

Минимальный рабочий пример:

```env
BOT_USE_SCANNER=true
BOT_INTERVAL=1m
BOT_UNIVERSE_SIZE=3
BOT_ALLOWED_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,LINKUSDT

BOT_INITIAL_BALANCE=1000
BOT_POSITION_SIZE_USDT=75
BOT_RISK_PER_TRADE_PCT=0.0025
BOT_FEE_PCT=0.001
BOT_STOP_LOSS_PCT=0.012
BOT_TAKE_PROFIT_PCT=0.02
BOT_TRAILING_STOP_PCT=0.008

BOT_MAX_CONCURRENT_POSITIONS=2
BOT_MAX_PORTFOLIO_EXPOSURE_PCT=0.5
BOT_MAX_DRAWDOWN_STOP_PCT=0.08
BOT_MAX_DAILY_LOSS_PCT=0.02
BOT_MAX_CONSECUTIVE_LOSSES=3

BOT_DASHBOARD_ENABLED=true
BOT_DASHBOARD_HOST=127.0.0.1
BOT_DASHBOARD_PORT=3200

BOT_EMA_FAST_PERIOD=9
BOT_EMA_SLOW_PERIOD=21
BOT_RSI_PERIOD=14
BOT_RSI_LONG_THRESHOLD=55
BOT_RSI_SHORT_THRESHOLD=45
BOT_MIN_TREND_STRENGTH_PCT=0.0015
BOT_MIN_ATR_PCT=0.001
BOT_MAX_ATR_PCT=0.03
BOT_COOLDOWN_CANDLES=2

BOT_SCAN_INTERVAL_MS=60000
BOT_SCANNER_SHORTLIST_SIZE=8
BOT_SCANNER_KLINE_LOOKBACK=30
BOT_MIN_QUOTE_VOLUME=1000000

BINANCE_REST_BASE_URL=https://api.binance.com
BINANCE_WS_BASE_URL=wss://stream.binance.com/ws
```

### 3. Запусти бота

```bash
npm run start:dev
```

### 4. Убедись, что бот работает правильно

Проверь в логах:

- строится ли universe
- приходят ли свечи
- прогревается ли история
- не режет ли `RiskManager` все сделки
- меняется ли `капитал`
- не улетает ли `максимальнаяПросадкаВПроцентах` слишком быстро

### 5. Прогони проверки проекта

```bash
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

## Настройка окружения

Ниже краткое объяснение ключевых параметров.

### Базовые параметры

- `BOT_SYMBOL`
  Стартовый символ, если сканер отключён.

- `BOT_INTERVAL`
  Торговый интервал свечей.

- `BOT_USE_SCANNER`
  Включает или выключает market scanner.

- `BOT_UNIVERSE_SIZE`
  Сколько символов одновременно держать в рабочем universe.

### Параметры стратегии

- `BOT_EMA_FAST_PERIOD`
- `BOT_EMA_SLOW_PERIOD`
- `BOT_RSI_PERIOD`
- `BOT_RSI_LONG_THRESHOLD`
- `BOT_RSI_SHORT_THRESHOLD`
- `BOT_MIN_TREND_STRENGTH_PCT`
- `BOT_MIN_ATR_PCT`
- `BOT_MAX_ATR_PCT`
- `BOT_COOLDOWN_CANDLES`

### Параметры исполнения

- `BOT_POSITION_SIZE_USDT`
- `BOT_FEE_PCT`
- `BOT_STOP_LOSS_PCT`
- `BOT_TAKE_PROFIT_PCT`
- `BOT_TRAILING_STOP_PCT`

### Параметры риска

- `BOT_RISK_PER_TRADE_PCT`
- `BOT_MAX_CONCURRENT_POSITIONS`
- `BOT_MAX_PORTFOLIO_EXPOSURE_PCT`
- `BOT_MAX_DRAWDOWN_STOP_PCT`
- `BOT_MAX_DAILY_LOSS_PCT`
- `BOT_MAX_CONSECUTIVE_LOSSES`

### Параметры scanner

- `BOT_ALLOWED_SYMBOLS`
- `BOT_MIN_QUOTE_VOLUME`
- `BOT_SCANNER_SHORTLIST_SIZE`
- `BOT_SCANNER_KLINE_LOOKBACK`
- `BOT_SCAN_INTERVAL_MS`

### Параметры Binance

- `BINANCE_REST_BASE_URL`
- `BINANCE_WS_BASE_URL`
- `BOT_DASHBOARD_ENABLED`
- `BOT_DASHBOARD_HOST`
- `BOT_DASHBOARD_PORT`

## Таблица переменных окружения

Ниже собраны все ключевые переменные окружения в одном месте.

| Переменная | Назначение | Типичное значение | Комментарий |
| --- | --- | --- | --- |
| `BOT_SYMBOL` | Стартовый символ при отключённом scanner | `BTCUSDT` | Используется как fallback |
| `BOT_INTERVAL` | Интервал свечей | `1m` | Базовый рабочий интервал |
| `BOT_USE_SCANNER` | Включить scanner | `true` | Если `false`, используется ручной режим |
| `BOT_SCAN_INTERVAL_MS` | Частота пересчёта scanner | `60000` | В миллисекундах |
| `BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH` | Старый порог простоя пары | `8` | Сохраняется для логики idle-state |
| `BOT_UNIVERSE_SIZE` | Размер рабочего universe | `3-8` | Не делай слишком большим на старте |
| `BOT_ALLOWED_SYMBOLS` | Белый список символов | `BTCUSDT,ETHUSDT,...` | Очень рекомендуется ограничивать |
| `BOT_MIN_QUOTE_VOLUME` | Минимальная ликвидность | `1000000` | Защита от малоликвидных пар |
| `BOT_SCANNER_SHORTLIST_SIZE` | Сколько кандидатов анализирует scanner | `8` | Обычно больше universe |
| `BOT_SCANNER_KLINE_LOOKBACK` | Сколько свечей брать для scanner enrichment | `30` | Влияет на short-horizon score |
| `BOT_INITIAL_BALANCE` | Стартовый paper balance | `1000` | Баланс симуляции |
| `BOT_POSITION_SIZE_USDT` | Верхний cap размера позиции | `100` | Не единственный фактор размера позиции |
| `BOT_RISK_PER_TRADE_PCT` | Риск на сделку | `0.0025-0.01` | Доля от капитала |
| `BOT_FEE_PCT` | Комиссия на сделку | `0.001` | В расчётах входа и выхода |
| `BOT_STOP_LOSS_PCT` | Базовый stop loss | `0.012` | 1.2% |
| `BOT_TAKE_PROFIT_PCT` | Базовый take profit | `0.02` | 2% |
| `BOT_TRAILING_STOP_PCT` | Трейлинг-стоп | `0.008` | 0.8% |
| `BOT_COOLDOWN_CANDLES` | Пауза после сделки | `2` | Снижает overtrading |
| `BOT_EMA_FAST_PERIOD` | Быстрая EMA | `9` | Базовый импульс |
| `BOT_EMA_SLOW_PERIOD` | Медленная EMA | `21` | Базовый фильтр тренда |
| `BOT_RSI_PERIOD` | Период RSI | `14` | Осциллятор импульса |
| `BOT_RSI_LONG_THRESHOLD` | Long threshold RSI | `55` | Подтверждение bullish impulse |
| `BOT_RSI_SHORT_THRESHOLD` | Short threshold RSI | `45` | Подтверждение bearish impulse |
| `BOT_MIN_TREND_STRENGTH_PCT` | Минимальная сила тренда | `0.0015` | Фильтр боковика |
| `BOT_MIN_ATR_PCT` | Минимальная волатильность | `0.001` | Не торговать мёртвый рынок |
| `BOT_MAX_ATR_PCT` | Максимальная волатильность | `0.03` | Не торговать слишком хаотичный рынок |
| `BOT_MAX_CONCURRENT_POSITIONS` | Максимум открытых позиций | `2-4` | Ограничение multi-pair нагрузки |
| `BOT_MAX_PORTFOLIO_EXPOSURE_PCT` | Максимальная загрузка капитала | `0.5-0.8` | Доля equity |
| `BOT_MAX_DRAWDOWN_STOP_PCT` | Лимит максимальной просадки | `0.08-0.15` | После достижения новые входы режутся |
| `BOT_MAX_DAILY_LOSS_PCT` | Дневной лимит убытка | `0.02-0.04` | Важная страховка |
| `BOT_MAX_CONSECUTIVE_LOSSES` | Лимит подряд убыточных сделок | `3-4` | Защита от плохого режима |
| `BOT_DASHBOARD_ENABLED` | Включить live dashboard | `true` | Можно отключить для headless режима |
| `BOT_DASHBOARD_HOST` | Хост dashboard-сервера | `127.0.0.1` | Локальный доступ по умолчанию |
| `BOT_DASHBOARD_PORT` | Порт dashboard-сервера | `3200` | Открой в браузере |
| `BINANCE_REST_BASE_URL` | REST endpoint Binance | `https://api.binance.com` | Можно заменить на test/testnet endpoint |
| `BINANCE_WS_BASE_URL` | WebSocket endpoint Binance | `wss://stream.binance.com/ws` | База для stream subscriptions |

## Как правильно использовать бота

Ниже рекомендованный порядок работы.

### Шаг 1. Начни только с paper trading

Не подключай реальные деньги, пока:

- не проверил корректность логики
- не просмотрел логи
- не убедился, что risk management работает как ожидается
- не протестировал стратегию на истории

### Шаг 2. Ограничь universe

На старте используй только ликвидные пары:

- `BTCUSDT`
- `ETHUSDT`
- `BNBUSDT`
- `SOLUSDT`
- `LINKUSDT`

Не стоит сразу включать десятки символов.

### Шаг 3. Используй умеренные параметры

Для первого безопасного режима:

- `BOT_UNIVERSE_SIZE=3`
- `BOT_MAX_CONCURRENT_POSITIONS=2`
- `BOT_RISK_PER_TRADE_PCT=0.0025`
- `BOT_MAX_DAILY_LOSS_PCT=0.02`
- `BOT_MAX_DRAWDOWN_STOP_PCT=0.08`

### Шаг 4. Запусти бота в dev-режиме

```bash
npm run start:dev
```

Если dashboard включён, открой в браузере:

```text
http://127.0.0.1:3200
```

Смотри на:

- корректность логов
- какие символы выбрал scanner
- как часто стратегия генерирует сигналы
- не слишком ли часто бот торгует
- не срабатывают ли risk limits слишком рано или слишком поздно

### Шаг 5. Проверь портфельные метрики

Обязательно смотри на:

- капитал
- максимальную просадку
- количество открытых позиций
- уплаченные комиссии
- подряд убыточные сделки
- дневной результат

### Шаг 6. Прогони тесты

```bash
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

### Шаг 7. Только после этого исследуй параметры

Не меняй сразу всё подряд.

Меняй параметры группами:

1. параметры стратегии
2. параметры риска
3. параметры scanner
4. universe

Иначе ты не поймёшь, что именно улучшило или ухудшило результат.

## Команды проекта

### Разработка

```bash
npm run start
npm run start:dev
npm run start:debug
```

### Сборка

```bash
npm run build
```

### Тесты

```bash
npm run test
npm run test:e2e
npm run test:cov
```

### Форматирование и lint

```bash
npm run format
npm run lint
```

## Логи

Бот пишет детальные русскоязычные логи.

Типы логов:

- `СВЕЧА`
- `СИГНАЛ`
- `СДЕЛКА`
- `ПОРТФЕЛЬ`
- `ИНФО`
- `ОШИБКА`

Что ты увидишь в логах:

- какой символ дал свечу
- какой сигнал сгенерировала стратегия
- почему сделка была открыта или отклонена
- текущее состояние портфеля
- состояние риск-менеджера
- состав universe

Дополнительно доступен live web dashboard:

- график капитала в реальном времени
- таблица открытых позиций
- таблица сделок с прибылью и убытком
- live-лента логов
- состояние risk manager
- кнопка экстренного закрытия всех позиций

## Пример реального лога

Ниже пример того, как примерно выглядит лог в рабочем режиме:

```text
============================================================
[10.03.2026, 14:22:01] [ИНФО] Стартовый universe выбран сканером
  - символ: BTCUSDT
    оценка: 7.8124
    изменениеЗа24ЧасаВПроцентах: 3.41
    объёмВКотируемойВалюте: 248173912.12
    недавнееДвижениеВПроцентах: 0.86
    внутридневнаяВолатильностьВПроцентах: 0.22
    ускорениеОбъёмаВПроцентах: 41.5
  - символ: ETHUSDT
    оценка: 6.9472
    изменениеЗа24ЧасаВПроцентах: 2.18
    объёмВКотируемойВалюте: 183912221.41
============================================================

============================================================
[10.03.2026, 14:23:00] [СИГНАЛ] Результат стратегии
  символ: BTCUSDT
  цена: 68425.31
  сигнал: ОТКРЫТЬ_ЛОНГ
  причина: Long: fast EMA выше slow EMA, RSI подтверждает импульс
  индикаторы:
    быстраяСкользящаяСредняя: 68410.128441
    медленнаяСкользящаяСредняя: 68377.991228
    индексОтносительнойСилы: 58.41
    среднийИстинныйДиапазонВПроцентах: 0.19
    силаТрендаВПроцентах: 0.05
============================================================

============================================================
[10.03.2026, 14:23:00] [СДЕЛКА] Исполнение торгового действия
  действие: ОТКРЫТЬ_ЛОНГ
  символ: BTCUSDT
  интервал: 1m
  сторона: ЛОНГ
  цена: 68425.31
  количество: 0.001094
  комиссия: 0.074999
  причина: Long: fast EMA выше slow EMA, RSI подтверждает импульс
============================================================

============================================================
[10.03.2026, 14:23:00] [ПОРТФЕЛЬ] Состояние портфеля
  баланс: 925.000001
  реализованныйРезультат: 0
  плавающийРезультат: 0
  капитал: 999.925001
  пиковыйКапитал: 1000
  максимальнаяПросадкаВПроцентах: 0.01
  открытыхПозиций: 1
  рискМенеджмент:
    использованиеКапиталаВПроцентах: 7.5
    лимитПараллельныхПозиций: 2
============================================================
```

## Пример backtest report

Ниже пример структуры отчёта, который логично ожидать от текущего backtest scaffold:

```ts
{
  startingBalance: 1000,
  endingEquity: 1084.37,
  realizedResult: 79.92,
  unrealizedResult: 4.45,
  totalTrades: 47,
  wins: 27,
  losses: 20,
  winRate: 57.45,
  maxDrawdownPct: 6.82,
  feesPaid: 18.73,
  closedTrades: [
    {
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 67120.14,
      exitPrice: 67641.83,
      pnlNet: 1.82,
      reason: 'Тейк-профит по лонгу',
    },
    // ...
  ],
  equityCurve: [
    { timestamp: 1710000000000, equity: 1000 },
    { timestamp: 1710000060000, equity: 1000.41 },
    { timestamp: 1710000120000, equity: 999.87 },
  ],
}
```

Это не гарантированный результат, а пример формата отчёта.

## Типичные ошибки и как их диагностировать

### 1. Бот запустился, но не открывает сделки

Что проверить:

- не слишком ли жёсткие `BOT_MIN_TREND_STRENGTH_PCT`
- не слишком ли узкий `BOT_MAX_ATR_PCT`
- не слишком ли консервативный `BOT_RISK_PER_TRADE_PCT`
- не режет ли сделки `BOT_MAX_DAILY_LOSS_PCT`
- не достигнут ли `BOT_MAX_CONSECUTIVE_LOSSES`
- прогрелась ли история по символам

На что смотреть в логах:

- `СИГНАЛ`
- `Риск-менеджер отклонил сделку`
- `Сделка отклонена`

### 2. Бот слишком часто торгует

Что проверить:

- уменьшить `BOT_UNIVERSE_SIZE`
- увеличить `BOT_COOLDOWN_CANDLES`
- поднять `BOT_MIN_TREND_STRENGTH_PCT`
- сузить список `BOT_ALLOWED_SYMBOLS`

Признаки проблемы:

- слишком много сделок за короткий период
- комиссии быстро растут
- equity “пилится” без прогресса

### 3. Просадка слишком большая

Что проверить:

- уменьшить `BOT_RISK_PER_TRADE_PCT`
- уменьшить `BOT_MAX_CONCURRENT_POSITIONS`
- уменьшить `BOT_MAX_PORTFOLIO_EXPOSURE_PCT`
- усилить фильтр universe
- расширить research на истории

Признаки:

- `максимальнаяПросадкаВПроцентах` быстро растёт
- equity curve уходит в длительный нисходящий режим

### 4. Scanner выбирает “странные” пары

Что проверить:

- `BOT_ALLOWED_SYMBOLS`
- `BOT_MIN_QUOTE_VOLUME`
- `BOT_SCANNER_KLINE_LOOKBACK`
- `BOT_SCANNER_SHORTLIST_SIZE`

Практика:

- на старте жёстко ограничь scanner белым списком

### 5. Логи есть, но свечи не приходят

Что проверить:

- `BINANCE_WS_BASE_URL`
- доступ к интернету
- не блокируется ли WebSocket на стороне окружения
- корректен ли interval

### 6. Build и тесты проходят, но поведение на paper trading плохое

Это нормально: корректный код не означает прибыльную стратегию.

В таком случае:

1. смотри на структуру сделок
2. смотри на drawdown и fees
3. смотри на режимы рынка, где стратегия умирает
4. не “крути” сразу все параметры
5. усиливай backtesting и regime filtering

## Структура проекта

```text
src/
  backtest/
    backtest-engine/
  bot/
    bot-runner/
  config/
  logger/
    bot-logger/
  market/
    binance-market/
  scanner/
    symbol-scanner/
  strategy/
    strategy/
  trader/
    paper-trader/
    portfolio/
    risk-manager/
```

## Ограничения текущей версии

Система уже заметно сильнее прототипа, но ограничения остаются.

### Нет live execution

Пока нет:

- настоящих ордеров
- синхронизации с биржевыми fills
- обработки exchange filters
- частичных исполнений

### Нет постоянного хранилища

Пока не сохраняются в БД:

- сделки
- equity curve
- риск-события
- snapshots портфеля

### Backtesting пока каркасный

Есть фундамент, но нет полноценного research toolchain.

## Что улучшать дальше

Следующие сильные направления развития:

- persistent trade ledger
- PostgreSQL / TimescaleDB
- live Binance execution layer
- correlation-aware portfolio risk
- parameter optimization
- walk-forward analysis
- Monte Carlo
- slippage model
- metrics dashboard
- alerts и monitoring

## Практические рекомендации

### Не начинай с агрессивных настроек

Лучше начать с меньшего риска и меньшего universe.

### Не оценивай бота по 10 сделкам

Смотри на:

- десятки и сотни сделок
- equity curve
- drawdown behavior
- устойчивость на разных рыночных режимах

### Не улучшай стратегию вслепую

Любое изменение должно проходить через:

1. логическую проверку
2. unit tests
3. backtest
4. paper trading наблюдение

### Отделяй research от production-ready изменений

Сначала проверяй идею на истории и paper trading, потом думай о live execution.

## Итог

Сейчас это уже не просто NestJS-стартер и не примитивный single-pair бот, а довольно серьёзный paper trading framework для исследования и постепенного перехода к production-grade crypto trading system.

Если использовать его правильно, рекомендуемый путь такой:

1. настроить безопасный `.env`
2. запустить paper trading
3. проверить логи и риск-метрики
4. прогнать тесты
5. протестировать идеи через backtesting
6. только потом переходить к следующей фазе архитектуры
