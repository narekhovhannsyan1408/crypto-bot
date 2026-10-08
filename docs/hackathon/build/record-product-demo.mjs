// Записывает клипы продуктового демо для Colosseum: только живой интерфейс, без слайдов.
//   LIVE_URL  — бот с пустым состоянием (режим solana_sim: котировки Jupiter, виртуальные деньги)
//   REPLAY_URL — бот на состоянии из replay-state.ts (стратегия на реальных ценах 2026 года)
//   SCENES=start,now,advanced,replay,replay-advanced,stop  node record-product-demo.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const LIVE_URL = process.env.LIVE_URL ?? 'http://127.0.0.1:3210';
const REPLAY_URL = process.env.REPLAY_URL ?? 'http://127.0.0.1:3212';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(import.meta.dirname, 'work', 'clips');
const SCENES = new Set(
  (process.env.SCENES ?? 'start,now,advanced,replay,replay-advanced,stop').split(','),
);
const WIDTH = 1920;
const HEIGHT = 1080;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Видимый курсор: в headless-режиме системного курсора нет
const CURSOR_SCRIPT = `
  (() => {
    if (window.__demoCursor) return;
    const style = document.createElement('style');
    style.textContent = \`
      .demo-cursor { position: fixed; z-index: 2147483647; width: 26px; height: 26px; margin: -4px 0 0 -4px;
        pointer-events: none; transition: transform .08s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      .demo-ripple { position: fixed; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px;
        border-radius: 50%; background: rgba(59,91,219,.35); pointer-events: none; animation: demo-ripple .5s ease-out forwards; }
      @keyframes demo-ripple { from { transform: scale(.2); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }\`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.className = 'demo-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2l7.5 19 2.6-7.4L20.5 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    cursor.style.left = '960px'; cursor.style.top = '540px';
    document.body.appendChild(cursor);
    window.__demoCursor = cursor;
    addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      cursor.style.transform = 'scale(.85)';
      const ripple = document.createElement('div');
      ripple.className = 'demo-ripple'; ripple.style.left = e.clientX + 'px'; ripple.style.top = e.clientY + 'px';
      document.body.appendChild(ripple); setTimeout(() => ripple.remove(), 600);
    }, true);
    addEventListener('mouseup', () => { cursor.style.transform = ''; }, true);
  })();`;

let mouse = { x: WIDTH / 2, y: HEIGHT / 2 };

async function moveTo(page, selector) {
  const element = await page.waitForSelector(selector, { visible: true });
  await element.scrollIntoView();
  const box = await element.boundingBox();
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const steps = 28;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(
      mouse.x + (target.x - mouse.x) * ease,
      mouse.y + (target.y - mouse.y) * ease,
    );
    await sleep(14);
  }
  mouse = target;
  return element;
}

async function click(page, selector, pause = 500) {
  await moveTo(page, selector);
  await sleep(250);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(pause);
}

async function smoothScroll(page, top, duration = 1600) {
  await page.evaluate(
    async ({ top, duration }) => {
      const start = window.scrollY;
      const target =
        typeof top === 'string'
          ? document.querySelector(top).getBoundingClientRect().top + window.scrollY - 90
          : top;
      const begin = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const t = Math.min((now - begin) / duration, 1);
          const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
          window.scrollTo(0, start + (target - start) * ease);
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
    },
    { top, duration },
  );
}

async function record(page, name, scene) {
  const recorder = await page.screencast({
    path: join(OUT, `${name}.webm`),
    fps: 30,
    quality: 20,
  });
  try {
    await scene();
  } finally {
    await recorder.stop();
  }
  console.log(`✓ ${name}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: WIDTH, height: HEIGHT },
    args: [`--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars', '--lang=en-US'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    `addEventListener('DOMContentLoaded', () => { ${CURSOR_SCRIPT} })`,
  );

  // Действия идут по таймингу озвучки (секунды от начала клипа, голос начинается с 0.5 с),
  // чтобы картинка совпадала с тем, о чём говорится
  const timeline = () => {
    const t0 = Date.now();
    return (seconds) => sleep(Math.max(0, t0 + seconds * 1000 - Date.now()));
  };

  // 1. Главная и выбор режима: голос про свой кошелёк и симуляцию звучит при открытом окне
  if (SCENES.has('start')) {
    await page.goto(`${LIVE_URL}/?lang=en`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#start-view:not([hidden])', { timeout: 20_000 });
    await sleep(800);
    await record(page, 'product-1-start', async () => {
      const at = timeline();
      await at(2.8);
      await moveTo(page, '#start-solana-btn');
      await at(5.2);
      await moveTo(page, '#start-test-btn');
      await at(8.0);
      await click(page, '#start-solana-btn', 0);
      await at(10.0);
      await moveTo(page, 'input[value="solana_real"] + span');
      await at(12.7);
      await moveTo(page, 'input[value="solana_sim"] + span');
      await at(17.6);
      await click(page, '#start-confirm', 0);
      await at(18.8);
    });
    await page.waitForSelector('#session-view:not([hidden])', { timeout: 90_000 });
    await sleep(300);
  }

  // 2. Первое решение, доли и лента с объяснением сделок
  if (SCENES.has('now')) {
    await record(page, 'product-2-now', async () => {
      const at = timeline();
      await at(3.1);
      await smoothScroll(page, '.now-card', 1400);
      await at(10.5);
      await smoothScroll(page, '#activity', 1400);
      await at(17.3);
    });
  }

  // 3. Расширенный режим живой сессии: таблица сигналов, пока о ней говорится, потом настройки, журнал, лог
  if (SCENES.has('advanced')) {
    await page.goto(`${LIVE_URL}/advanced?lang=en`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#session-card:not([hidden])', { timeout: 20_000 });
    await sleep(1500);
    await record(page, 'product-3-advanced', async () => {
      const at = timeline();
      await at(2.4);
      await smoothScroll(page, '#signals-card', 1400);
      await moveTo(page, '#signals-table tbody tr:first-child td:nth-child(2)');
      await at(10.4);
      await moveTo(page, '#signals-table tbody tr:first-child td:nth-child(3)');
      await at(14.4);
      await smoothScroll(page, '.adv-grid', 1300);
      await moveTo(page, '#chain-info');
      await at(17.0);
      await smoothScroll(page, '#journal-card', 1000);
      await at(18.3);
      await smoothScroll(page, '#logs-card', 1000);
      await at(21.7);
    });
  }

  // 4. Реплей 2026 года: цифры на английском экране, языки — ровно под фразу о языках
  if (SCENES.has('replay')) {
    await page.goto(`${REPLAY_URL}/?lang=en`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#session-view:not([hidden])', { timeout: 20_000 });
    await sleep(1500);
    await record(page, 'product-4-replay', async () => {
      const at = timeline();
      await at(6.6);
      await moveTo(page, '#profit-value');
      await at(8.9);
      await moveTo(page, '#benchmark');
      await at(14.4);
      await click(page, '#lang-switch button[data-lang="ru"]', 0);
      await at(16.2);
      await click(page, '#lang-switch button[data-lang="hy"]', 0);
      await at(18.0);
      await click(page, '#lang-switch button[data-lang="en"]', 0);
      await at(19.0);
    });
  }

  // 5. Реплей в расширенном режиме: капитал и просадка, журнал решений
  if (SCENES.has('replay-advanced')) {
    await page.goto(`${REPLAY_URL}/advanced?lang=en`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#session-card:not([hidden])', { timeout: 20_000 });
    await sleep(1500);
    await record(page, 'product-5-replay-advanced', async () => {
      await sleep(1500);
      await moveTo(page, '#kpis .kpi:nth-child(4)');
      await sleep(1500);
      await smoothScroll(page, '#charts-card', 1600);
      await sleep(3500);
      await smoothScroll(page, '#journal-card', 1600);
      await click(page, '#journal-filters button[data-filter="trades"]', 2000);
      await click(page, '#journal-filters button[data-filter="all"]', 1000);
    });
  }

  // 6. Остановка живой сессии: кнопка, подтверждение, итог рядом с «просто держать»
  if (SCENES.has('stop')) {
    await page.goto(`${LIVE_URL}/?lang=en`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#session-view:not([hidden])', { timeout: 20_000 });
    await sleep(1200);
    await record(page, 'product-6-stop', async () => {
      const at = timeline();
      await at(1.9);
      await click(page, '#stop-btn', 0);
      await at(3.3);
      await click(page, '#stop-confirm', 0);
      await page.waitForSelector('#stopped-note:not([hidden])', { timeout: 90_000 });
      await moveTo(page, '#benchmark');
      await at(9.6);
      await smoothScroll(page, '#activity', 1600);
      await at(15.2);
    });
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
