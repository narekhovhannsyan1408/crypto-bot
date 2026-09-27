# crypto-bot — notes for Claude

A NestJS/TypeScript bot. The main mode is the **trend allocator** for BTC/ETH (plus SOL via
`BOT_ALLOCATOR_ASSETS`) in `src/allocator`, executing on Binance or on Solana through Jupiter
(`src/solana`, broker `solana-jupiter-broker.ts`), controlled from the web interface
(`src/web/public`). The legacy intraday strategies (`src/bot`, `src/strategy`, `src/trader`) run only
with `BOT_STRATEGY_MODE=intraday` and lose money on history.

## Commands

```bash
npm test                      # unit tests
npm run test:e2e              # full HTTP API (supertest)
npm run build                 # build into dist/
npm run start:dev             # run; dashboard at http://127.0.0.1:3200
npm run allocator:backtest    # backtest the allocator on Binance history
npm run diagnose -- --since 7d   # investigation report (see below)
npm run logs -- --help           # journal filter
```

Rules: never print the contents of `.env` (it holds Binance keys and the Solana wallet key), never
run `live_real` or `solana_real`, never delete the user's `.allocator-state.json` without consent.

## Interface languages

The interface is in English (default), Russian and Armenian. All texts live in the dictionaries
`src/web/public/i18n/{en,ru,hy}.json`, read by both the page (`js/i18n.js`) and the server
(`src/i18n/messages.ts`). The server never sends finished text: the activity feed, stop reasons, API
errors and mode readiness are `{ key, params }` messages (`msg()`, `LocalizedError`), and the page
translates them. Everything written for developers — the terminal output, the diagnostic journal, error
`message`s and the `title`/`details` fields of new entries — is in English (`en()`); entries saved before
that keep their Russian text.

- New text: add the key to all three dictionaries with the same placeholders — `src/i18n/i18n.spec.ts`
  checks this, and also that every key used in code exists in the dictionary.
- Entries saved before the translation are parsed back on load by the Russian templates
  (`src/i18n/legacy-text.ts`). If you change a Russian wording in `narr.*`, old entries with the
  previous text stay untranslated — add an alias to `ALIASES`.

## Investigating problems

When the user says "something went wrong", always start with the report:

```bash
npm run diagnose -- --since 7d
```

It contains the build and commit, settings without secrets, the session state from
`.allocator-state.json`, **hints**, grouped errors and warnings, process downtime and the decision
timeline. Then drill down with `npm run logs`:

```bash
npm run logs -- --op <opId> --full          # everything that happened in one operation
npm run logs -- --request <requestId> --full  # everything an HTTP request caused (X-Request-Id)
npm run logs -- --session <sessionId> --level info --limit 0
npm run logs -- --since 3d --event "allocator.rebalance.*,allocator.order.*"
npm run logs -- --since 7d --level warn
```

After `npm run build` the same tools are `node dist/diagnostics/diagnose-cli.js` and
`node dist/diagnostics/logs-cli.js`.

### Where the journal lives

- `logs/app-YYYY-MM-DD.jsonl` (UTC day), parts `app-YYYY-MM-DD.N.jsonl` above `BOT_LOG_MAX_FILE_MB`;
  kept for `BOT_LOG_RETENTION_DAYS` days (14 by default).
- The folder is set by `BOT_LOG_DIR`, the level by `BOT_LOG_LEVEL` (default `debug`; `trace` adds page
  polls, successful Binance requests and Nest internals).
- One line is one JSON: `ts, level, event, msg, pid, requestId?, op?, opId?, sessionId?, mode?, durationMs?, data?, err?`.
- Secrets are masked automatically (`src/observability/sanitize.ts`): keys containing
  secret/key/token/signature → `[REDACTED]`, and `signature=` in error text too. That is why on-chain
  transaction ids are logged as `txId`.

### How events are linked

- `opId` — one engine operation: `start-…`, `stop-…`, `autostop-…`, `tick-…` (every 5 minutes),
  `resume-…` (after a restart), `manual_rebalance-…`.
- `requestId` — one HTTP request; the same id is in the `X-Request-Id` response header. Start/stop
  from the interface have both `requestId` and `opId`.
- `sessionId` — a bot session (from Start to Stop), equal to `id` in the state file.

### Event catalogue

| Event | Level | Meaning |
| --- | --- | --- |
| `process.started` / `process.ready` | info | Start: version, commit, `gitDirty`, settings |
| `process.heartbeat` | debug | Every 5 min: uptime, memory, event-loop delay. Gaps = the process was not running |
| `process.shutdown` / `process.exit` | info | Normal shutdown |
| `process.uncaught_exception` / `process.unhandled_rejection` / `process.bootstrap_failed` | fatal/error | Crashes |
| `session.store.loaded` / `session.store.persist_failed` | info/error | State file |
| `session.store.texts_migrated` | info | Old Russian feed entries got dictionary keys (`unparsed` — not recognized) |
| `allocator.idle` / `allocator.session.resumed` / `allocator.session.resume_blocked` | info/error | Behaviour after a restart |
| `allocator.session.start_requested` / `started` / `start_rejected` | info/warn | Start and why it was refused |
| `allocator.rebalance.started` / `signals` / `plan` / `completed` | info | Daily decision: SMA signals, prices, order plan |
| `allocator.rebalance.failed` / `deferred` | warn/debug | No decision yet; `nextAttemptAt` — when it retries |
| `allocator.order.filled` / `allocator.order.failed` | info/error | Order execution (fill, order, balances after) |
| `allocator.cycle.completed` | debug | Check summary: equity, prices, price age, lastError |
| `allocator.autostop.triggered` / `skipped_stale_prices` | warn | Auto-protection: triggered / skipped without fresh prices |
| `allocator.session.stopped` / `autostopped` / `stop_unsold` | info/error | Stop and what could not be sold |
| `allocator.reconcile.adjusted` | warn | Records reduced to the exchange/wallet balance (funds moved manually) |
| `allocator.prices.refresh_failed` | warn | Prices could not be fetched |
| `binance.http.failed` | warn | Public Binance REST: url, params, code, response |
| `broker.binance.connected` / `connect_failed` | info/error | Connection with keys (live_testnet/live_real) |
| `broker.binance.order_request` / `order_response` / `order_failed` | info/error | Real order: what was sent and what the exchange answered |
| `broker.binance.balance` / `broker.paper.fill` | debug | Exchange balances / virtual fills |
| `broker.solana.sim_fill` | debug | Virtual swap on a Jupiter quote (solana_sim) |
| `broker.solana.swap_request` / `swap_sent` / `swap_confirmed` | info | Real swap: quote and route, txId, actual balance changes |
| `broker.solana.swap_failed` | error | Swap not executed; `definitelyNotExecuted=true` — funds were certainly not debited |
| `broker.solana.send_uncertain` / `meta_unavailable` | warn | No answer to the send (status resolved by txId) / fill booked from the quote |
| `broker.solana.balance` | debug | Solana wallet balances (USDC and tokens) |
| `solana.jupiter.failed` | warn | Jupiter API request failed: url, code, response |
| `solana.proof.sent` / `confirmed` | info | Decision written to Solana (Memo): txId, explorer link |
| `solana.proof.failed` / `unconfirmed` / `unavailable` | warn | Decision record not sent / not confirmed / journal wallet not loaded |
| `http.request` | info/warn/error | API commands; 4xx/5xx; for 403 — host/origin/contentType |
| `nest.*` | warn/error | NestJS errors (exceptions in controllers and so on) |
| `bot.info` / `bot.error` / `trade.executed` / `strategy.signal` / `market.candle` / `portfolio.snapshot` | various | Intraday mode (legacy strategies) |

### Symptom → where to look

- **The bot bought nothing.** `allocator.rebalance.signals` (exposure = 0 → no trend, which is
  normal), `allocator.rebalance.plan` (`skipped` — below the minimum order), `allocator.rebalance.failed`.
- **No decision for the day.** Downtime in the report marked "daily decision missed" (the computer
  slept), `allocator.rebalance.failed` / `deferred`, `binance.http.failed`.
- **The bot suddenly sold everything.** `allocator.autostop.triggered` (equity, threshold, prices);
  `allocator.session.stopped` with a `requestId` means it was stopped from the interface.
- **A Solana swap failed.** `broker.solana.swap_failed` (`definitelyNotExecuted`), next to it
  `broker.solana.swap_sent` with the `txId` and a link — check the transaction in Solana Explorer.
- **A decision was not written on-chain.** `solana.proof.failed` (usually no SOL in the journal wallet —
  `npm run solana:proof-wallet`), `solana.proof.unavailable`.
- **The exchange rejects orders.** `broker.binance.order_failed` → `err.name/message`
  (InsufficientFunds, MIN_NOTIONAL, LOT_SIZE, key permissions), with `allocator.order.failed` and the plan.
- **Records don't match Binance.** `allocator.reconcile.adjusted`, `broker.binance.balance`.
- **The page doesn't open / 403.** `http.request` at warn level: host/origin — the check in
  `src/web/security`.
- **The process crashed or hung.** `process.uncaught_exception`, `process.bootstrap_failed`, a large
  `eventLoopDelayMaxMs` in `process.heartbeat`, downtime.
- **Behaviour doesn't match the code.** `process.started.data.gitCommit` and `gitDirty`.

### When the logs are not enough

Add events through `AppLogger` (`src/observability/app-logger.ts`), named
`<area>.<object>.<action>`, with an English message, data in `data` and the error as a separate argument. Inside engine
operations the context (`opId`, `sessionId`) is added automatically. Add every new event to the table
above. Don't log keys or full balance responses without a reason.

## Hackathon materials

`docs/hackathon/` holds the Solana Hackathon deck (`deck.html` → PDF/PNG), the demo video build
(`build/`: puppeteer screen recordings, Kokoro voice-over, ffmpeg assembly) and `replay-state.ts`,
which builds a session state by replaying the real strategy on historical prices for screenshots.
Screens made from a replay must be labelled as such.
