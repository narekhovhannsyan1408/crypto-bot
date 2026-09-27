// Скриншоты интерфейса для слайдов (2x). Нужен запущенный бот с активной сессией.
//   BASE_URL=http://127.0.0.1:3210 node capture-screens.mjs
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSETS = join(import.meta.dirname, '..', 'assets');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  args: ['--hide-scrollbars'],
});
const page = await browser.newPage();

async function open(path, lang = 'en') {
  await page.goto(`${BASE_URL}${path}?lang=${lang}`, { waitUntil: 'networkidle0' });
  await sleep(2500);
}

async function viewport(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await page.screenshot({ path: join(ASSETS, `${name}.png`) });
  console.log('✓', name);
}

async function element(selector, name, padding = 0) {
  const handle = await page.waitForSelector(selector, { visible: true });
  await handle.scrollIntoView();
  await sleep(400);
  await handle.screenshot({
    path: join(ASSETS, `${name}.png`),
    ...(padding ? { clip: undefined } : {}),
  });
  console.log('✓', name);
}

await open('/');
await viewport('app-simple');
await element('.now-card', 'app-now');
await element('#activity', 'app-activity');

await open('/advanced');
await viewport('app-advanced');
await element('#kpis', 'app-kpis');
await element('#signals-card', 'app-signals');
await element('#chain-card', 'app-chain');

for (const lang of ['ru', 'hy']) {
  await open('/', lang);
  await viewport(`app-${lang}`);
}

await browser.close();
