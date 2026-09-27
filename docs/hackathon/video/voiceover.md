# Crypto Bot — Solana Hackathon demo — voice-over script

Read each block at a calm pace. To replace the synthetic voice, record a WAV per block into `video/voice/<id>.wav` (for example `video/voice/01-intro.wav`) and run `node make-video.mjs` in `docs/hackathon/build` — the video is re-timed to your recording.

### 00:00 · 01-intro (slide 1)

Meet Crypto Bot: a trend-following autopilot that trades on Solana, and proves every decision on-chain.

### 00:07 · 02-problem (slide 2)

Retail trading bots fail people in three ways. They overtrade, and fees eat the returns. We built seven intraday strategies ourselves, and none survived fees. Their track records can't be verified. And they want your keys.

### 00:21 · 03-solution (slide 3)

So we did the opposite: one slow decision a day. After the daily close, the bot compares the price with its 20, 50, 100 and 200-day averages, and holds more of a coin the stronger its trend. It trades on Solana through Jupiter, and publishes every decision on-chain before trading.

### 00:41 · 04-pipeline (slide 4)

The pipeline: daily close, signal, rebalance plan, a memo proof, then a Jupiter quote, a signed swap and confirmation. Fills come from real on-chain balances, and a lost response can never cause a double buy.

### 00:55 · 05-demo-start (screen recording: demo-1-start-solana)

Let's see it live. Start on Solana, in simulation mode: real Jupiter quotes, virtual money, zero risk. Within seconds the bot makes its first decision. All three coins are in an uptrend, so it buys Bitcoin, Ethereum and Solana, and explains each trade in plain words.

### 01:15 · 06-demo-languages (screen recording: demo-2-languages)

Here is the same dashboard replaying 2026 on real prices: up twenty percent, while simply holding lost about five. And the whole interface speaks English, Russian and Armenian.

### 01:29 · 07-demo-advanced (screen recording: demo-3-advanced)

Advanced mode shows the full picture: the equity curve with every trade, drawdown from the peak, the distance to every moving average, allocation versus target, and a journal of every decision.

### 01:46 · 08-proof (slide 5)

This is Proof-of-Trend. Every decision, with close prices, moving-average votes, targets and planned orders, is written to Solana with the memo program. Block time can't be backdated, and anyone can recompute the signal. It costs less than a tenth of a cent a day.

### 02:03 · 09-results (slide 6)

Does the rule work? Over eight and a half years of Bitcoin and Ethereum, it made 42 percent a year versus 23 for buy and hold, at about half the drawdown, and beat 99.5 percent of random timings. Past results are no guarantee.

### 02:19 · 10-solana (slide 7)

Solana makes it practical. A five-hundred-dollar bitcoin round trip through Jupiter cost about four cents, versus roughly a dollar in exchange fees. That is worth over three points of return a year. And your coins stay in your own wallet.

### 02:34 · 11-safety (slide 9)

It's built to be trusted: non-custodial, with risk-free simulation, exact accounting, auto-protection, and over 170 automated tests.

### 02:44 · 12-roadmap (slide 10)

Next: a mainnet proof journal with a public verifier, an Anchor vault that runs the strategy on-chain, and a marketplace of strategies ranked by proven results.

### 02:54 · 13-outro (slide 11)

Crypto Bot. Trend-following you can verify. Thank you.
