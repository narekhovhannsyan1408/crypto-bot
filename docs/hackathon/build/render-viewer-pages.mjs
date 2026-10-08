// Кадры для питч-видео: каждый слайд внутри окна просмотрщика PDF
// («открыли crypto-bot-deck.pdf и рассказывают»). Результат: work/pitch/page-NN.png.
// Запуск: cd docs/hackathon/build && node render-viewer-pages.mjs
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = join(import.meta.dirname, '..');
const SLIDES = join(ROOT, 'slides');
const OUT = join(import.meta.dirname, 'work', 'pitch');
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const slides = readdirSync(SLIDES)
  .filter((name) => /^slide-\d+\.png$/.test(name))
  .sort();

const icon = (path) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#c9cbd1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const page = (image, index, total) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1920px; height: 1080px; overflow: hidden; background: #2a2b2f;
    font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #e6e7ea; }
  .bar { height: 60px; background: #37383d; border-bottom: 1px solid #1f2023; display: flex;
    align-items: center; padding: 0 22px; gap: 18px; font-size: 18px; }
  .file { display: flex; align-items: center; gap: 12px; font-weight: 600; }
  .doc { width: 26px; height: 32px; border-radius: 4px; background: #e8473d; color: #fff;
    font-size: 9px; font-weight: 800; display: grid; place-items: end center; padding-bottom: 4px; }
  .center { margin: 0 auto; display: flex; align-items: center; gap: 14px; }
  .pill { background: #2a2b2f; border: 1px solid #4a4b52; border-radius: 6px; padding: 5px 12px;
    font-variant-numeric: tabular-nums; }
  .muted { color: #a6a8b0; }
  .right { display: flex; gap: 20px; }
  .view { position: absolute; top: 61px; left: 0; right: 0; bottom: 0; display: grid; place-items: center; }
  .sheet { width: 1648px; height: 927px; box-shadow: 0 10px 40px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04); }
  .sheet img { width: 100%; height: 100%; display: block; }
</style></head><body>
  <div class="bar">
    ${icon('<path d="M4 6h16M4 12h16M4 18h16"/>')}
    <div class="file"><div class="doc">PDF</div>crypto-bot-deck.pdf</div>
    <div class="center">
      ${icon('<path d="M15 18l-6-6 6-6"/>')}
      <span class="pill">${index}</span><span class="muted">/ ${total}</span>
      ${icon('<path d="M9 18l6-6-6-6"/>')}
      <span class="muted" style="margin-left:18px">−</span><span class="pill">100%</span><span class="muted">+</span>
    </div>
    <div class="right">
      ${icon('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>')}
      ${icon('<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z"/>')}
    </div>
  </div>
  <div class="view"><div class="sheet"><img src="data:image/png;base64,${readFileSync(join(SLIDES, image)).toString('base64')}"></div></div>
</body></html>`;

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
try {
  const tab = await browser.newPage();
  for (const [index, image] of slides.entries()) {
    await tab.setContent(page(image, index + 1, slides.length), { waitUntil: 'load' });
    const name = `page-${String(index + 1).padStart(2, '0')}.png`;
    await tab.screenshot({ path: join(OUT, name) });
    console.log(`✓ work/pitch/${name}`);
  }
} finally {
  await browser.close();
}
