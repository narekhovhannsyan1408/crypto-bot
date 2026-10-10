# Crypto Bot

A trend-following autopilot for crypto that trades on **Binance** or on **Solana** (through the
Jupiter aggregator) — and can publish every decision on-chain, so its track record can't be faked.

![Crypto Bot dashboard](docs/dashboard.png)

<sub>The dashboard replaying 2026 on real prices (Jan 1 → Sep 26, 2026): +20% vs −5% for buy & hold.
See [Results](#results) for how these numbers are produced.</sub>

- **One slow decision a day.** After each daily close the bot compares the price with its 20, 50,
  100 and 200-day moving averages and holds more of a coin the stronger its trend. No leverage, no
  shorts, few trades.
- **Binance or Solana.** Trade on a Binance spot account, or swap USDC ↔ cbBTC / WETH / SOL on
  Solana through Jupiter straight from your own wallet.
- **Risk-free modes.** A virtual account on real Binance prices, Binance Demo, or a Solana
  simulation on live Jupiter quotes — no keys needed to try it.
- **Proof-of-Trend.** Every daily decision can be written to Solana with the Memo program *before*
  any order executes. Block time can't be backdated, and anyone can recompute the signal.
- **Made for people.** A calm web interface in English, Russian and Armenian that explains every
  trade in plain words, plus an advanced mode with charts, signals and a live system log.

## Contents

1. [How it works](#how-it-works)
2. [Results](#results)
3. [Quick start](#quick-start)
4. [Trading modes](#trading-modes)
5. [Configuration](#configuration)
6. [Real money on Binance](#real-money-on-binance)
7. [Solana: swaps and the on-chain decision journal](#solana-swaps-and-the-on-chain-decision-journal)
8. [Using the web interface](#using-the-web-interface)
9. [Commands](#commands)
10. [Logs and diagnostics](#logs-and-diagnostics)
11. [Project structure](#project-structure)
12. [Development](#development)
13. [Safety](#safety)

## How it works

1. **Signal.** Once a day, after the 00:00 UTC close, the bot takes the daily closes of each asset
   (`BTCUSDT`, `ETHUSDT` by default, `SOLUSDT` optional) and counts how many of the 20/50/100/200-day
   simple moving averages the close is above.
2. **Target.** The capital is split equally between the assets. The share of an asset's slice held in
   the coin equals the share of averages below the price: 4 of 4 → fully in the coin, 2 of 4 → half,
   0 of 4 → fully in dollars (USDT on Binance, USDC on Solana).
3. **Rebalance.** The bot trades only when the portfolio drifted more than 10% of an asset's slice
   from the target. The decision is idempotent: restarts never trade twice on the same day.
4. **Protection.** Optional auto-protection sells everything and stops when capital falls below a
   chosen threshold (−20%, −30% or −40% from the start).

The bot manages only the amount you give it and the coins it bought itself; other funds on the
account or in the wallet are never touched.

## Results

Backtest on Binance daily data with the same code as live trading
(`src/allocator/domain/allocator-simulator.ts`), 0.1% fee + 0.05% slippage per side:

| $1,000 in BTC + ETH, 2018-01-01 → 2026-09-26 | Per year | Max drawdown | Growth | Sharpe |
| --- | --- | --- | --- | --- |
| Trend allocator | **+42.1%** | **48.8%** | ×21.6 | 1.06 |
| Buy & hold | +23.4% | 87.6% | ×6.3 | 0.66 |
| Random timing (median of 200) | +10.0% | 71.7% | — | 0.44 |

- The allocator beats 99.5% of random entry/exit timings with the same trading frequency.
- By year: 2018 −25% (buy & hold −76%), 2022 −30% (−65%), 2025 +11% (−5%).
- With SOL (2021-06-01 →): +34.3% a year vs +24.5%. In 2026 to date: +20.0% vs −5.0%.
  Last 12 months: +3.7% vs −32.2%.
- With DEX-level execution costs (0.03% per side, Jupiter), the same signals give +45.5% a year.

Reproduce with `npm run allocator:backtest` (options: `--from`, `--assets`, `--sma`, `--vol-target`,
`--help`). **Past performance does not guarantee future results.** The strategy earns on long trends
and loses on false signals in sideways markets; drawdowns of ~50% happened historically.

## Quick start

Requirements: **Node.js 22 or newer** (tested on 25) and npm. No exchange account or wallet is needed
for the test and simulation modes.

```bash
git clone https://github.com/narekhovhannsyan1408/crypto-bot.git
cd crypto-bot
npm install
cp .env.example .env        # optional: every setting has a safe default
npm run start
```

Open **http://127.0.0.1:3200** and press **Start in test mode** (virtual money on real Binance
prices) or **Start on Solana → Simulation** (live Jupiter quotes). The first decision is made right
away; after that the bot checks prices every 5 minutes and decides once a day.

Other ways to run:

```bash
npm run start:dev                      # watch mode for development
npm run build && npm run start:prod    # compiled build from dist/
```

The session survives restarts: state is kept in `.allocator-state.json` and the bot resumes where it
stopped. Stop it with **Stop and sell everything** in the interface.

## Trading modes

| Mode | Where | Money | What you need |
| --- | --- | --- | --- |
| Test mode (`paper`) | Virtual account on real Binance prices | Virtual | Nothing |
| Binance Demo (`live_testnet`) | Binance demo account | Not real | `BINANCE_TESTNET_API_KEY/SECRET` |
| Real money (`live_real`) | Your Binance spot account | Real | `BINANCE_API_KEY/SECRET`, `BOT_ALLOW_LIVE_REAL=true` |
| Solana simulation (`solana_sim`) | Live Jupiter quotes, no transactions | Virtual | Nothing |
| Solana real (`solana_real`) | Your Solana wallet, mainnet swaps via Jupiter | Real | `SOLANA_PRIVATE_KEY`, `BOT_ALLOW_SOLANA_REAL=true` |

Signals are always computed from Binance daily candles; the mode only decides where orders go.

## Configuration

All settings are environment variables, read from `.env` in the project root (or the file in
`BOT_ENV_FILE`). Values already set in the environment win over the file; if a name appears twice in
`.env`, the last line wins. Names the code does not read are ignored. See
[`.env.example`](.env.example) for a commented template. Restart the bot after changing `.env`.

Fractions are written as decimals: `0.1` means 10%.

### General

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `BOT_STRATEGY_MODE` | `trend_allocator`, `intraday` | `trend_allocator` | `intraday` runs the legacy strategies (see below) instead of the allocator |
| `BOT_ENV_FILE` | path | `./.env` | Use another settings file; the bot refuses to start if it does not exist |
| `BOT_DASHBOARD_ENABLED` | `true`, `false` | `true` | `false` runs without the web interface |
| `BOT_DASHBOARD_HOST` / `BOT_DASHBOARD_PORT` | address / port | `127.0.0.1` / `3200` | Keep `127.0.0.1` unless you know why you need another address |

### Trend allocator

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `BOT_ALLOCATOR_ASSETS` | comma list: `BTC` or `BTCUSDT` | `BTCUSDT,ETHUSDT` | Add `SOL` to trade Solana; any Binance `…USDT` pair works for signals |
| `BOT_ALLOCATOR_SMA_PERIODS` | comma list of days > 1 | `20,50,100,200` | Moving averages that vote on the trend |
| `BOT_ALLOCATOR_REBALANCE_THRESHOLD_PCT` | `0`–`1` | `0.1` | Minimum drift from the target (share of an asset's slice) before trading |
| `BOT_ALLOCATOR_MIN_ORDER_USDT` | USDT | `10` | Smaller orders are skipped; Binance's own minimum also applies |
| `BOT_ALLOCATOR_VOL_TARGET` | yearly volatility, `0` = off | `0` | E.g. `0.6` scales positions down when an asset is wilder than 60% a year |
| `BOT_ALLOCATOR_VOL_LOOKBACK_DAYS` | days | `30` | Window for the volatility estimate |
| `BOT_ALLOCATOR_CHECK_INTERVAL_MS` | ms, at least `10000` | `300000` | How often prices and auto-protection are checked (the decision itself is daily) |
| `BOT_ALLOCATOR_STATE_FILE` | path | `./.allocator-state.json` | Session state; do not delete it while a session is running |
| `BOT_ALLOCATOR_DATA_URL` | URL | `https://api.binance.com` | Public Binance market data used for the signals in every mode |
| `BOT_ALLOCATOR_PAPER_BALANCE` | USDT | `BOT_INITIAL_BALANCE` or `1000` | Starting capital of `npm run allocator:backtest` (the interface asks for the amount itself) |
| `BOT_FEE_PCT` / `BOT_SLIPPAGE_PCT` | fraction per side | `0.001` / `0.0005` | Costs modelled in test mode and backtests; real modes pay the actual costs |

The trading mode of the allocator (test, Binance Demo, real, Solana) is chosen in the web interface,
not in `.env`: `BOT_EXECUTION_MODE` and `BOT_EXECUTION_MARKET_TYPE` only affect the intraday mode.

### Keys and accounts

Test mode and the Solana simulation need no keys. Keys are only read from `.env`; never commit it.

| Variable | Needed for | Where to get it |
| --- | --- | --- |
| `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` | Binance Demo (`live_testnet`) | Sign in at <https://demo.binance.com> with your Binance account → **API Management** → create a key. Demo keys only work with demo money |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Real money on Binance (`live_real`) | binance.com → profile → **API Management** → **Create API** → *System generated*. Enable **Reading** and **Spot & Margin Trading** only, never withdrawals; restricting the key to your IP is recommended |
| `BOT_ALLOW_LIVE_REAL` | Real money on Binance | Set to `true` yourself as an explicit second switch (default `false`) |
| `SOLANA_PRIVATE_KEY` | Real Solana swaps (`solana_real`) | Base58 secret key of a **separate** wallet. Phantom: Settings → Manage Accounts → the account → **Show Private Key**; Solflare: account menu → **Export Private Key** |
| `SOLANA_KEYPAIR_PATH` | Alternative to `SOLANA_PRIVATE_KEY` | Path to a JSON keypair file, e.g. created with `solana-keygen new -o wallet.json` |
| `BOT_ALLOW_SOLANA_REAL` | Real Solana swaps | Set to `true` yourself as an explicit second switch (default `false`) |
| `SOLANA_RPC_URL` | Solana modes | Optional. The public `https://api.mainnet-beta.solana.com` is rate-limited; a free endpoint from Helius, QuickNode or Triton is more reliable |
| `JUPITER_API_KEY` | Solana modes | Optional, only for the paid `https://api.jup.ag` (key from <https://portal.jup.ag>); the default `lite-api.jup.ag` needs none |
| `SOLANA_PROOF_KEYPAIR_PATH` | On-chain decision journal | Created by `npm run solana:proof-wallet` |

### Solana

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `SOLANA_JUPITER_API_URL` | URL | `https://lite-api.jup.ag` | Jupiter prices, quotes and swap transactions |
| `SOLANA_SLIPPAGE_BPS` | basis points | `50` (0.5%) | Maximum slippage per swap |
| `SOLANA_MAX_PRIORITY_FEE_LAMPORTS` | lamports | `500000` | Cap on the priority fee per swap (0.0005 SOL) |
| `SOLANA_MIN_SOL_FOR_FEES` | SOL | `0.02` | SOL the bot never trades so it can always pay network fees |
| `SOLANA_TOKEN_MINTS` | `ASSET:mint:decimals,…` | cbBTC, WETH, SOL | Trade other tokens, e.g. `BTC:<WBTC mint>:8` |
| `SOLANA_PROOF_ENABLED` | `true`, `false` | `false` | Publish every daily decision with the Memo program |
| `SOLANA_PROOF_CLUSTER` | `devnet`, `testnet`, `mainnet-beta` | `devnet` | Network of the decision journal |
| `SOLANA_PROOF_RPC_URL` | URL | public RPC of the cluster | RPC for the decision journal |

### Diagnostic journal

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `BOT_LOG_DIR` | path | `./logs` | Where the JSON Lines journal is written |
| `BOT_LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error` | `debug` | `trace` also records page polls and successful Binance requests |
| `BOT_LOG_RETENTION_DAYS` / `BOT_LOG_MAX_FILE_MB` | days / MB | `14` / `10` | Journal rotation |
| `BOT_LOG_HEARTBEAT_MS` | ms | `300000` | Heartbeat interval; gaps in heartbeats show when the process was not running |

### Intraday mode (legacy)

These variables are read only with `BOT_STRATEGY_MODE=intraday`. The intraday strategies lose money on
historical data and are kept for reference; the trend allocator ignores all of them.

<details>
<summary>Intraday variables</summary>

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `BOT_EXECUTION_MODE` | `paper`, `live_testnet`, `live_real` | `paper` | Where intraday orders go (`live_testnet` = Binance Demo) |
| `BOT_EXECUTION_MARKET_TYPE` | `spot`, `futures`, `hybrid` | `spot` | `hybrid`: longs on spot, shorts on futures |
| `BINANCE_FUTURES_DEMO_API_KEY` / `BINANCE_FUTURES_DEMO_API_SECRET` | keys | — | Futures leg on Binance Demo; created on <https://demo.binance.com> like the spot demo key |
| `BINANCE_REST_BASE_URL` / `BINANCE_WS_BASE_URL` | URL | chosen by `BOT_EXECUTION_MODE` | Market data endpoints; demo endpoints for `live_testnet`, main ones otherwise |
| `BOT_INITIAL_BALANCE` | USDT | `1000` | Starting balance of the intraday paper portfolio and backtest |
| `BOT_SYMBOL` | Binance pair | `BTCUSDT` | Traded pair when the scanner is off |
| `BOT_INTERVAL` | `1m`, `5m`, `15m`, … | `1m` | Candle interval of the strategies |
| `BOT_CONFIRMATION_INTERVAL` | interval or empty | — | Higher timeframe that must confirm an entry |
| `BOT_CONFIRMATION_MODE` | `strict`, `lenient`, `off` | `strict` | How strictly the higher timeframe is required |
| `BOT_MIN_TREND_STRENGTH_PCT` | fraction | `0.0015` | Minimum EMA spread for the higher timeframe to count as a trend |
| `BOT_DYNAMIC_TIMEFRAME_ENABLED` | `true`, `false` | `false` | Pick the fastest interval with good enough signals |
| `BOT_DYNAMIC_TIMEFRAME_CANDIDATES` | comma list | `5m,15m,30m` | Intervals to choose from |
| `BOT_USE_SCANNER` | `true`, `false` | `false` | Choose pairs automatically by movement and liquidity |
| `BOT_SCAN_INTERVAL_MS` | ms | `60000` | How often the scanner re-ranks pairs |
| `BOT_MIN_QUOTE_VOLUME` | USDT | `1000000` | Minimum 24h volume for a pair to be considered |
| `BOT_ALLOWED_SYMBOLS` | comma list | all | Whitelist of pairs for the scanner and universe |
| `BOT_UNIVERSE_SIZE` | number | `5` | How many pairs are watched at once |
| `BOT_MAX_CANDLES_WITHOUT_POSITION_BEFORE_SWITCH` | candles | `8` | Replace a watched pair after this many candles without a trade |
| `BOT_ENABLED_STRATEGIES` | comma list | all seven | `momentum_trend`, `mean_reversion`, `breakout_volatility`, `trend_pullback`, `range_scalping`, `volume_spike_reversal`, `market_regime_switcher` |
| `BOT_RSI_LONG_MAX_ENTRY` / `BOT_RSI_SHORT_MIN_ENTRY` | RSI | `68` / `32` | No new long above / short below this RSI |
| `BOT_MOMENTUM_MAX_EMA_STRETCH_PCT` | fraction | `0.0022` | Skip momentum entries this far from the fast EMA |
| `BOT_MEAN_REVERSION_MAX_HIGHER_TREND_PCT` | fraction | `0.0025` | Skip mean-reversion entries against a stronger higher-timeframe trend |
| `BOT_RISK_PER_TRADE_PCT` | fraction of equity | `0.005` | Risk per trade; the position size follows from the stop distance |
| `BOT_POSITION_SIZE_USDT` | USDT, `0` = no cap | `0` | Hard cap on one position |
| `BOT_MAX_POSITION_SIZE_PCT_OF_EQUITY` | fraction | `0.1` | Cap on one position as a share of equity |
| `BOT_MIN_POSITION_SIZE_USDT` | USDT | `25` | Smaller positions are not opened |
| `BOT_STOP_LOSS_PCT` / `BOT_TAKE_PROFIT_PCT` | fraction | `0.012` / `0.02` | Stop loss and take profit from the entry price |
| `BOT_TRAILING_STOP_PCT` | fraction | `0.008` | Trailing stop distance |
| `BOT_BREAKEVEN_TRIGGER_PCT` / `BOT_BREAKEVEN_OFFSET_PCT` | fraction, `0` = off | `0` / `0` | Move the stop to breakeven (plus offset) after this gain |
| `BOT_MAX_POSITION_HOLD_MINUTES` | minutes, `0` = no limit | `0` | Close positions held longer than this |
| `BOT_EXIT_ON_STRATEGY_SIGNAL` | `true`, `false` | `false` | Also close on strategy exit signals, not only on stops |
| `BOT_MAX_CONCURRENT_POSITIONS` | number | `3` | Open positions at once |
| `BOT_MAX_POSITIONS_PER_SYMBOL` / `BOT_MAX_POSITIONS_PER_STRATEGY` | number | `2` / `3` | Limits per pair and per strategy |
| `BOT_MAX_PORTFOLIO_EXPOSURE_PCT` | fraction | `0.8` | Share of equity that may be in positions |
| `BOT_MAX_DRAWDOWN_STOP_PCT` / `BOT_MAX_DAILY_LOSS_PCT` | fraction | `0.15` / `0.04` | Stop trading after this drawdown / daily loss |
| `BOT_MAX_CONSECUTIVE_LOSSES` | number | `4` | Block new entries after this many losses in a row |
| `BOT_CONSECUTIVE_LOSSES_COOLDOWN_MINUTES` | minutes | `30` | Lift that block after this long without trades |

Fine-tuning of the indicators (`BOT_EMA_FAST_PERIOD`, `BOT_EMA_SLOW_PERIOD`, `BOT_RSI_PERIOD`,
`BOT_RSI_LONG_THRESHOLD`, `BOT_RSI_SHORT_THRESHOLD`, `BOT_MIN_ATR_PCT`, `BOT_MAX_ATR_PCT`,
`BOT_COOLDOWN_CANDLES`, `BOT_SCANNER_SHORTLIST_SIZE`, `BOT_SCANNER_KLINE_LOOKBACK`,
`BOT_ALLOW_OPPOSITE_POSITIONS_SAME_SYMBOL`) is documented by its defaults in
[`src/config/bot-config.ts`](src/config/bot-config.ts).

</details>

## Real money on Binance

1. On Binance open **API Management**, create a key and allow **spot trading only**. Never enable
   withdrawals. A separate sub-account is recommended.
2. Add to `.env`:

   ```
   BINANCE_API_KEY=your_key
   BINANCE_API_SECRET=your_secret
   BOT_ALLOW_LIVE_REAL=true
   ```

3. Restart the bot, press **Start with real money**, choose the amount and confirm the risk notice.
   The interface shows your free USDT and refuses to start with more than that.

## Solana: swaps and the on-chain decision journal

**Swaps.** The Solana modes swap USDC for cbBTC, WETH (Wormhole) and native SOL through Jupiter.
In `solana_real` the bot signs the swap with your key, sends it to mainnet, waits for confirmation and
books the fill from the actual balance changes in the confirmed transaction. If the RPC loses the
response, the bot resolves the transaction by its signature until the blockhash expires, so a
network hiccup can never cause a double buy.

1. Create a **separate** wallet (for example a new account in Phantom) with USDC and ~0.05 SOL for
   network fees.
2. Add to `.env`:

   ```
   SOLANA_PRIVATE_KEY=your_base58_secret_key
   BOT_ALLOW_SOLANA_REAL=true
   SOLANA_RPC_URL=https://your-rpc-endpoint   # optional, recommended
   ```

3. Restart the bot and press **Start on Solana → Own wallet**.

**Proof-of-Trend journal.** Each daily decision (close prices, SMA votes, targets and planned orders)
is written to Solana with the Memo program before orders are sent — about 300–400 bytes and
5,000 lamports per day. It works with every mode, including Binance.

```bash
npm run solana:proof-wallet   # creates .solana/proof-keypair.json and asks devnet for free SOL
```

Then set `SOLANA_PROOF_ENABLED=true` and restart. If the faucet refuses, top the printed address up at
<https://faucet.solana.com>. The journal wallet lives in `.solana/` (git-ignored). Records appear in the
activity feed with a link to Solana Explorer.

## Using the web interface

- **Simple mode** (`/`): start and stop the bot, see capital and result, a comparison with buy & hold,
  the equity chart with every trade, what the bot holds now and why, and a plain-words activity feed.
- **Advanced mode** (`/advanced`): key metrics, equity and drawdown charts, the distance of the price
  to every moving average, allocation now vs target, execution and on-chain details, the decision
  journal with filters and a live system log.
- **Languages:** English (default), Russian and Armenian — switch in the header or open
  `http://127.0.0.1:3200/?lang=hy`. The choice is remembered in the browser.

The dashboard accepts commands only from its own page (Host and Origin checks), so another website
open in the same browser can't start or stop the bot.

## Commands

| Command | What it does |
| --- | --- |
| `npm run start` / `start:dev` / `start:prod` | Run the bot (dev watch mode / compiled build) |
| `npm run build` | Compile to `dist/` |
| `npm test` | Unit tests |
| `npm run test:e2e` | HTTP API end-to-end tests |
| `npm run lint` / `npm run format` | ESLint with fixes / Prettier |
| `npm run allocator:backtest -- --help` | Backtest the trend allocator on Binance history |
| `npm run solana:proof-wallet` | Create and fund the decision-journal wallet |
| `npm run diagnose -- --since 7d` | Incident report from the diagnostic journal |
| `npm run logs -- --help` | Filter the diagnostic journal |

## Logs and diagnostics

The bot writes a structured JSON journal to `logs/app-YYYY-MM-DD.jsonl` (one line per event, UTC days,
kept for 14 days): process start with version and settings (never keys), every daily decision with
signals and the order plan, every order and exchange or blockchain response, connection failures,
commands from the interface and crashes. Secrets are masked automatically.

If something went wrong, start with the report — it can be shared safely (never share `.env`):

```bash
npm run diagnose -- --since 7d > diagnose.md
npm run logs -- --since 3d --level warn
```

The event catalogue and investigation playbook are in [CLAUDE.md](CLAUDE.md).

## Project structure

```
src/
  allocator/        trend allocator: signal, rebalance planner, simulator, engine, brokers
    brokers/        paper, Binance spot (ccxt), Solana via Jupiter
  solana/           Jupiter client, tokens, wallet, swap accounting, Memo decision journal
  i18n/             message keys shared with the web dictionaries, legacy text migration
  web/public/       simple and advanced pages, i18n dictionaries (en, ru, hy)
  web/security/     Host/Origin guard for the dashboard
  observability/    structured journal, process monitor
  diagnostics/      diagnose and logs CLIs
  config/           environment configuration
  bot, strategy, trader, market, scanner, streaming, backtest/
                    legacy intraday strategies (research only, see below)
test/               end-to-end API tests
```

**Legacy intraday mode.** `BOT_STRATEGY_MODE=intraday` runs the original intraday strategies. They
showed no edge before costs on Binance history and lose money after fees, so they are kept only for
research and are not recommended.

## Development

- Tests: `npm test` (unit) and `npm run test:e2e`. Solana code is tested against a fake RPC and fake
  Jupiter, including blockhash expiry, lost sends and memo size limits.
- Translations: every visible text is a key in `src/web/public/i18n/{en,ru,hy}.json`. Server messages
  are `{ key, params }` objects (`msg()` / `LocalizedError` in `src/i18n/messages.ts`). The test
  `src/i18n/i18n.spec.ts` fails if a key is missing or placeholders differ between languages.
- Keep secrets out of logs: the journal masks fields named like `key`, `secret`, `token`, `signature`,
  so on-chain transaction ids are logged as `txId`.

## Safety

- Real money requires an explicit flag (`BOT_ALLOW_LIVE_REAL` or `BOT_ALLOW_SOLANA_REAL`) and a
  confirmation in the interface. Use a separate account or wallet with an amount you can afford to
  lose.
- Binance keys should allow spot trading only, without withdrawals. The Solana key stays on your
  machine; the bot only signs swaps and memo records.
- This is an automated trading program, not investment advice.
