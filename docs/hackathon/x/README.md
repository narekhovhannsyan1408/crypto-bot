# X (Twitter) launch kit

Everything needed for the project's X page: profile images, profile texts, a pinned launch thread and a posting plan until the Crypto World's Fair deadline (Colosseum, Oct 12, 2026). Character counts follow X's rules (a link counts as 23, an emoji as 2); every post fits the 280 limit of a free account.

## Files

| File | Use |
| --- | --- |
| [`avatar.png`](avatar.png) | Profile photo, 400×400 (also works as the product logo in the Colosseum form) |
| [`header.png`](header.png) | Header, 1500×500 |
| `../video/crypto-bot-x-teaser.mp4` | ~30-second teaser with captions for the pinned post (git-ignored; build with `node make-social-cuts.mjs` in `../build`) |
| `../video/crypto-bot-story-9x16.mp4` | 11-second vertical story for Instagram and Telegram: the product, the Colosseum hackathon and @cryptobot1414 (same build step) |
| [`../slides/`](../slides) | Images for the posts (16:9) |
| [`brand.html`](brand.html) | Source of the avatar and header; rebuild with `node render-x-assets.mjs` in `../build` |

## Profile

| Field | Value |
| --- | --- |
| Name | `Crypto Bot · Proof-of-Trend` |
| Handle | [`@cryptobot1414`](https://x.com/cryptobot1414) |
| Bio (157/160) | Trend-following autopilot for BTC, ETH & SOL on @solana. One decision a day, swaps via @JupiterExchange from your own wallet, every decision proven on-chain. |
| Location | `On-chain · Solana` |
| Website | `https://github.com/narekhovhannsyan1408/crypto-bot` |

## Pinned launch thread

Post 1 with the video, then reply to it with posts 2–8 (the “+” button in the composer builds the whole thread at once). Pin post 1: **⋯ → Pin to your profile**.

**1/8** · 240/280 · media: `../video/crypto-bot-x-teaser.mp4 (30 s video)`

```text
Meet Crypto Bot: a trend-following autopilot that trades on @solana and proves every decision on-chain.

One slow decision a day. Swaps via @JupiterExchange straight from your own wallet.

Building it for @colosseum's Crypto World's Fair 🧵
```

**2/8** · 236/280 · media: `../slides/slide-02.png`

```text
Retail trading bots fail people in 3 ways:

- they overtrade and fees eat the returns (we built 7 intraday strategies first; none survived 0.1% fees)
- their track records can't be verified
- they want your keys

So we did the opposite.
```

**3/8** · 228/280 · media: `../slides/slide-03.png`

```text
The rule: after every daily close, compare the price with its 20, 50, 100 and 200-day averages.

Above 4 of 4: hold 100% of that coin's slice
Above 2 of 4: 50%
Above none: all in USDC

No leverage, no shorts, no screen-watching.
```

**4/8** · 232/280 · media: `../slides/slide-05.png`

```text
Proof-of-Trend: before any order is sent, the signals and the trade plan are written to Solana with the Memo program.

Block time can't be backdated, and anyone can recompute the signal from public prices.

Cost: under $0.001 a day.
```

**5/8** · 223/280 · media: `../slides/slide-06.png`

```text
Does it work? Backtest Jan 2018 to Sep 2026, BTC + ETH, 0.1% fees + slippage:

+42% a year vs +23% for buy & hold
49% max drawdown vs 88%
Beat 99.5% of random entry/exit timings

Past results don't guarantee future returns.
```

**6/8** · 219/280 · media: `../slides/slide-07.png`

```text
Why Solana? A $500 BTC round trip through Jupiter cost about $0.04, vs ~$1 in exchange fees. In the backtest that's +3.4 points of return a year.

cbBTC, WETH, SOL and USDC stay in your wallet. The bot only signs swaps.
```

**7/8** · 254/280 · media: `../slides/slide-09.png`

```text
Built to be trusted:

- non-custodial
- risk-free simulation on live Jupiter quotes
- fills booked from confirmed on-chain balances, not quotes
- auto-protection if capital drops
- 170+ automated tests

The interface speaks English, Russian and Armenian.
```

**8/8** · 207/280 · media: `../slides/slide-10.png`

```text
Next: a mainnet proof journal with a public verifier, then an on-chain vault that runs the strategy itself.

Code: github.com/narekhovhannsyan1408/crypto-bot

Follow along, we'll post every milestone until the Oct 12 deadline.
```

## Posting plan until the deadline

One post every two days keeps the page alive without spamming. Reply under @colosseum and @solana hackathon posts with a link to the pinned thread; that is where the first followers come from.

### Sep 29 · How we avoid double buys

276/280 · media: `../slides/slide-04.png`

```text
How do you make sure a lost network response never causes a double buy on Solana?

We know the transaction id (its signature) before sending, then check its status until the blockhash expires. Only then is a swap "not executed".

Fills come from on-chain balances, not quotes.
```

### Oct 1 · What a proof record looks like

247/280 · media: `../slides/slide-05.png`

```text
What a Proof-of-Trend record on Solana contains: the date, close prices, how many averages each coin is above, target weights and the planned orders.

~370 bytes, one Memo transaction a day.

A track record timestamped before the trade, not after.
```

### Oct 3 · The lesson

230/280 · media: `../slides/slide-02.png`

```text
Lesson from building this: we wrote 7 intraday strategies first (momentum, mean reversion, breakouts, scalping, ...).

On years of data, none had an edge after 0.1% fees.

So we threw them out and kept one rule that trades rarely.
```

### Oct 5 · The product

240/280 · media: `../assets/app-simple.png`

```text
Simple mode: pick test money, Binance or Solana and press Start. Every trade is explained in plain words.

Advanced mode: signals per coin, equity and drawdown charts, the decision journal and a live system log.

English, Russian, Armenian.
```

### Oct 8 · 2026 replay

238/280 · media: `../slides/slide-01.png`

```text
2026 so far, replayed on real prices: +20% for the strategy vs -5% for buy & hold (BTC, ETH, SOL, with fees).

Last 12 months: +3.7% vs -32.2%.

A replay on historical prices, not live trading. The rule sits in cash when the trend breaks.
```

### Oct 10 · Roadmap

212/280 · media: `../slides/slide-10.png`

```text
Where Crypto Bot goes next:

1. Proof journal on mainnet + a public verifier page
2. An Anchor vault: deposit USDC, the strategy runs on-chain
3. A marketplace of strategies ranked by proven, not claimed, results
```

### Oct 12 (after you submit) · Submission

245/280 · media: `../video/crypto-bot-x-teaser.mp4 (30 s video)`

```text
We just submitted Crypto Bot to @colosseum's Crypto World's Fair.

A trend-following autopilot that trades on @solana via @JupiterExchange and proves every decision on-chain.

Code: github.com/narekhovhannsyan1408/crypto-bot

Thanks to everyone who followed along!
```

## In the Colosseum submission

- **Project X / Twitter:** `https://x.com/cryptobot1414`
- **Logo:** `avatar.png`
- Add the link to the pinned thread in the description, so judges see the demo and the progress posts.

## Rules for honest posts

- Backtest and replay numbers are always labelled as such, with “past results don't guarantee future returns”.
- No promises of profit, no “financial advice”, no price predictions.
- Real-money screenshots only from real sessions; the deck screens come from a labelled replay.
