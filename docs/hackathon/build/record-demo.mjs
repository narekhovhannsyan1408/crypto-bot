// Записывает клипы для видео: сценарий в настоящем интерфейсе бота (headless Chrome).
// Нужен запущенный бот с отдельным файлом состояния, например:
//   BOT_ALLOCATOR_STATE_FILE=.tmp/demo-state.json BOT_DASHBOARD_PORT=3210 npm run start
//   BASE_URL=http://127.0.0.1:3210 npm run demo
// Бот стартует в режиме solana_sim: настоящие котировки Jupiter, виртуальные деньги.
// SCENES=start — только запуск (нужен пустой бот); SCENES=languages,advanced — обзор
// (для видео — на состоянии из replay-state.ts: стратегия на реальных ценах 2026 года).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(import.meta.dirname, 'work', 'clips');
const SCENES = new Set(
  (process.env.SCENES ?? 'start,languages,advanced').split(','),
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

async function moveTo(page, selector, { offsetY = 0 } = {}) {
  const element = await page.waitForSelector(selector, { visible: true });
  await element.scrollIntoView();
  const box = await element.boundingBox();
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 + offsetY };
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
      const target = typeof top === 'string'
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

async function setLang(page, code) {
  await click(page, `#lang-switch button[data-lang="${code}"]`, 1400);
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
  await page.evaluateOnNewDocument(`addEventListener('DOMContentLoaded', () => { ${CURSOR_SCRIPT} })`);
  // Английский по умолчанию; сбрасываем выбранный ранее язык
  await page.goto(`${BASE_URL}/?lang=en`, { waitUntil: 'networkidle0' });
  await sleep(800);

  // 1. Запуск на Solana: симуляция на настоящих котировках Jupiter
  if (SCENES.has('start')) await record(page, 'demo-1-start-solana', async () => {
    await page.waitForSelector('#start-view:not([hidden])', { timeout: 20_000 });
    await sleep(1200);
    await moveTo(page, '#start-test-btn');
    await sleep(500);
    await moveTo(page, '#start-real-btn');
    await sleep(500);
    await click(page, '#start-solana-btn', 1200);
    await moveTo(page, 'input[value="solana_real"] + span');
    await sleep(900);
    await moveTo(page, 'input[value="solana_sim"] + span');
    await sleep(700);
    await click(page, '#start-confirm', 200);
    await page.waitForSelector('#session-view:not([hidden])', { timeout: 60_000 });
    await sleep(1200);
    await smoothScroll(page, '.now-card', 1800);
    await sleep(2800);
    await smoothScroll(page, '#activity', 1800);
    await sleep(4000);
  });

  // 2. Три языка: английский по умолчанию, русский и армянский на лету
  if (SCENES.has('languages')) await record(page, 'demo-2-languages', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1500);
    await moveTo(page, '#profit-value');
    await sleep(1200);
    await setLang(page, 'ru');
    await sleep(1800);
    await setLang(page, 'hy');
    await sleep(1800);
    await smoothScroll(page, '#activity', 1600);
    await sleep(2000);
    await setLang(page, 'en');
    await sleep(1200);
    await smoothScroll(page, 0, 1200);
    await sleep(600);
  });

  // 3. Расширенный режим: сигналы, графики, журнал решений, блокчейн
  if (SCENES.has('advanced')) {
  await page.goto(`${BASE_URL}/advanced?lang=en`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#session-card:not([hidden])', { timeout: 20_000 });
  await sleep(1500);
  await record(page, 'demo-3-advanced', async () => {
    await sleep(2000);
    await moveTo(page, '#kpis .kpi:nth-child(3)');
    await sleep(1200);
    await smoothScroll(page, '#charts-card', 1600);
    await sleep(2200);
    await smoothScroll(page, '#signals-card', 1600);
    await moveTo(page, '#signals-table tbody tr:first-child td:nth-child(3)');
    await sleep(2800);
    await smoothScroll(page, '.adv-grid', 1600);
    await moveTo(page, '#chain-info');
    await sleep(2800);
    await smoothScroll(page, '#journal-card', 1600);
    await click(page, '#journal-filters button[data-filter="trades"]', 1500);
    await click(page, '#journal-filters button[data-filter="all"]', 800);
    await smoothScroll(page, '#logs-card', 1600);
    await sleep(2500);
  });
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
