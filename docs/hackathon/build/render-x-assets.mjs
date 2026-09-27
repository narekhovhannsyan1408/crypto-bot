// Картинки профиля X: аватар 400×400 и шапка 1500×500 из docs/hackathon/x/brand.html.
// Запуск: cd docs/hackathon/build && node render-x-assets.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const X_DIR = join(ROOT, 'x');
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1600, height: 1100, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(X_DIR, 'brand.html')).href, {
    waitUntil: 'networkidle0',
  });
  await page.evaluate(() => document.fonts.ready);
  for (const [id, file] of [
    ['avatar', 'avatar.png'],
    ['header', 'header.png'],
  ]) {
    const element = await page.$(`#${id}`);
    await element.screenshot({ path: join(X_DIR, file) });
    console.log(`✓ docs/hackathon/x/${file}`);
  }
} finally {
  await browser.close();
}
