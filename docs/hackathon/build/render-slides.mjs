// Рендер слайдов deck.html: PNG 1920×1080 на каждый слайд (для видео) и PDF.
//   node render-slides.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(import.meta.dirname, '..');
const SLIDES = join(ROOT, 'slides');
mkdirSync(SLIDES, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const url = `${pathToFileURL(join(ROOT, 'deck.html')).href}?render`;
await page.goto(url, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);

const slides = await page.$$('.slide');
for (const [index, slide] of slides.entries()) {
  const name = String(index + 1).padStart(2, '0');
  await slide.screenshot({ path: join(SLIDES, `slide-${name}.png`) });
}
console.log(`✓ ${slides.length} slides → slides/`);

await page.emulateMediaType('print');
await page.pdf({
  path: join(ROOT, 'crypto-bot-deck.pdf'),
  width: '1920px',
  height: '1080px',
  printBackground: true,
  pageRanges: `1-${slides.length}`,
});
console.log('✓ crypto-bot-deck.pdf');
await browser.close();
