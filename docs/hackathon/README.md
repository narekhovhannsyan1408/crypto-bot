# Solana Hackathon materials

Everything for the submission, in English.

| File | What it is |
| --- | --- |
| `crypto-bot-deck.pdf` | Pitch deck, 11 slides, 1920×1080 |
| `slides/slide-NN.png` | The same slides as images |
| `deck.html` | Source of the deck (open in a browser to view; edit the text here) |
| `video/crypto-bot-demo.mp4` | Pitch + live demo video, 3:00, narrated, no burned-in captions (not in git) |
| `video/crypto-bot-demo-captions.mp4` | The same video with captions burned in, for muted autoplay (not in git) |
| `video/captions.srt` | Captions to upload next to the clean video (YouTube, Loom…) |
| `video/voiceover.md` | Voice-over script with timings — read it to record your own voice |
| `video/script.json` | Source of the narration (segments, text, which slide or clip, voice) |
| `video/crypto-bot-x-teaser.mp4` | ~30-second teaser with captions for X: intro → live demo → end card (not in git) |
| `video/crypto-bot-story-9x16.mp4` | 11-second vertical story (1080×1920) for Instagram and Telegram Stories (not in git) |
| `stories/story.html` | Layers of the vertical story: frame, captions, end card |
| `x/` | X (Twitter) launch kit: avatar, header, profile texts, pinned thread and posting plan — see [`x/README.md`](x/README.md) |

The videos are ~35 MB each and are kept out of git; rebuild them with the steps below.

## Where the numbers and screens come from

- **Backtest** (Binance daily data, 2018-01-01 → 2026-09-26, 0.1% fee + 0.05% slippage per side):
  +42.1% a year vs +23.4% for buy & hold, max drawdown 48.8% vs 87.6%, ×21.6 vs ×6.3, Sharpe 1.06
  vs 0.66, beats 99.5% of 200 random timings — `npm run allocator:backtest`.
  Chart data: `npx ts-node --transpile-only docs/hackathon/export-backtest.ts`.
- **With SOL:** +34.3% vs +24.5% a year since 2021-06-01; +20.0% vs −5.0% in 2026 to date;
  +3.7% vs −32.2% over the last 12 months. DEX-level costs (0.03% per side): +45.5% a year.
- **Dashboard screens** (title slide, product slide, the language and advanced-mode parts of the video)
  show the real app running a *replay* of the strategy on real prices from 2026-01-01 to 2026-09-26
  (BTC, ETH, SOL; test-mode costs). The state is produced by `replay-state.ts` with the same simulator,
  signals and narration as live trading, and is labelled as a replay on the slides and in the voice-over.
- **Live start** in the video (Start on Solana → Simulation) is recorded on a fresh bot with live
  Jupiter quotes.
- **Jupiter round trip** USDC → cbBTC → USDC for $500: $0.038, measured on 2026-09-27.
- **Decision record:** one Memo transaction, 5,000 lamports base fee; the example on slide 5 is the
  output of `encodeDecisionMemo` for the 2026-09-26 decision (373 bytes).

## Rebuild

Tooling lives in `build/` (its `node_modules` and `work/` folder are git-ignored).

```bash
cd docs/hackathon/build && npm install

# 1. Slides → slides/*.png and crypto-bot-deck.pdf
node render-slides.mjs

# 2. Live start clip: run the bot with an empty separate state file (from the repo root)
#      BOT_ALLOCATOR_STATE_FILE=.tmp/demo-state.json BOT_DASHBOARD_PORT=3210 \
#      BOT_ALLOCATOR_ASSETS=BTCUSDT,ETHUSDT,SOLUSDT npm run start
SCENES=start BASE_URL=http://127.0.0.1:3210 node record-demo.mjs

# 3. Replay clips and screenshots: stop the bot, build the replay state, start it again
#      npx ts-node --transpile-only docs/hackathon/replay-state.ts 2026-01-01 .tmp/demo-state.json
SCENES=languages,advanced BASE_URL=http://127.0.0.1:3210 node record-demo.mjs
BASE_URL=http://127.0.0.1:3210 node capture-screens.mjs

# 4. Video
node make-video.mjs

# 5. Social: X teaser, 9:16 story, X avatar and header
node make-social-cuts.mjs
node render-x-assets.mjs
```

`record-demo.mjs` saves `.webm` clips to `work/clips/`; convert them to `.mp4` before step 4:

```bash
for f in work/clips/*.webm; do ffmpeg -y -i "$f" -vf fps=30,format=yuv420p -c:v libx264 -crf 18 "${f%.webm}.mp4"; done
```

## Voice

The narration uses **Kokoro-82M** (Apache-2.0), a local neural text-to-speech model, voice `af_heart`
at speed 1.13 (`video/script.json`). The model (~325 MB) is downloaded from Hugging Face into
`build/work/models` on the first run. Set `"engine": "say"` to use the macOS voice instead.

To use your own voice, record one WAV per block from `video/voiceover.md` into
`video/voice/<id>.wav` (for example `video/voice/01-intro.wav`) and run `node make-video.mjs` again —
the video is re-timed to your recording.
