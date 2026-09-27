// Короткие ролики для соцсетей из готового демо-видео (сначала node make-video.mjs).
// X: обычный аккаунт принимает видео до 2:20, поэтому делаем тизер ~30 с,
// а для Instagram и Telegram — вертикальную историю 9:16 на 11 с.
// Тизер собирается из целых сегментов с субтитрами: в ленте видео играет без звука.
// Запуск: cd docs/hackathon/build && node make-social-cuts.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, 'build', 'work');
const VIDEO = join(ROOT, 'video');
const SOURCE = join(VIDEO, 'crypto-bot-demo-captions.mp4');
// Те же значения, что в make-video.mjs
const FADE = 0.5;
const CUT_FADE = 0.4;

const run = (args) => {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`ffmpeg завершился с кодом ${result.status}`);
};

const duration = (file) =>
  Number(
    spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]).stdout.toString(),
  );

if (!existsSync(SOURCE)) {
  throw new Error(`Нет ${SOURCE}: сначала соберите видео (node make-video.mjs)`);
}

// Где каждый сегмент лежит в итоговом ролике: сегменты склеены с переходом FADE
const script = JSON.parse(readFileSync(join(ROOT, 'video', 'script.json'), 'utf8'));
const segments = [];
let start = 0;
script.segments.forEach((segment, index) => {
  const length = duration(join(WORK, 'segments', `${String(index).padStart(2, '0')}.mp4`));
  segments.push({ id: segment.id, start, length });
  start += length - FADE;
});
const total = duration(SOURCE);

// Реплики с таймингом из субтитров: по ним режем так, чтобы не задеть слова
const seconds = (text) => {
  const [h, m, rest] = text.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
};
const cues = readFileSync(join(VIDEO, 'captions.srt'), 'utf8')
  .trim()
  .split(/\n\s*\n/)
  .map((block) => {
    const [, time, ...text] = block.split('\n');
    const [from, to] = time.split(' --> ').map(seconds);
    return { from, to, text: text.join(' ') };
  });
const SPEECH_PAD = 0.15;
const TAIL = 0.6;

// Отрезок сегмента: без переходов к соседям, но и без обрезанных слов —
// голос в сегменте начинается чуть позже его начала и заканчивается чуть раньше конца
const piece = (id) => {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) throw new Error(`Нет сегмента ${id}`);
  const { start: from, length } = segments[index];
  const end = from + length;
  // Соседние сегменты перекрываются на FADE: реплика принадлежит тому, в чьём интервале начинается
  const next = segments[index + 1]?.start ?? total;
  const spoken = cues.filter((cue) => cue.from >= from && cue.from < next);
  const first = spoken[0]?.from ?? from + FADE;
  const last = spoken.at(-1)?.to ?? end - FADE;
  // Хвост тишины после последней фразы сокращаем до TAIL — тизер не должен «зависать»
  const tail = Math.min(end - FADE, last + TAIL);
  return {
    from: index === 0 ? 0 : Math.max(from + 0.05, Math.min(from + FADE, first - SPEECH_PAD)),
    to: index === segments.length - 1 ? total : Math.min(end - 0.05, Math.max(tail, last + SPEECH_PAD)),
  };
};

/** Реплика по началу текста — для точной вырезки голоса. */
const cue = (startsWith) => {
  const found = cues.find((item) => item.text.startsWith(startsWith));
  if (!found) throw new Error(`Нет реплики «${startsWith}»`);
  return found;
};

/** Склеивает куски исходного ролика с короткими переходами. */
const cut = (ids, name) => {
  const parts = ids.map(piece);
  const inputs = parts.flatMap(({ from, to }) => [
    '-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', SOURCE,
  ]);
  const filters = [];
  let video = '[0:v]';
  let audio = '[0:a]';
  let offset = 0;
  parts.slice(1).forEach((_, index) => {
    offset += parts[index].to - parts[index].from - CUT_FADE;
    filters.push(
      `${video}[${index + 1}:v]xfade=transition=fade:duration=${CUT_FADE}:offset=${offset.toFixed(3)}[v${index + 1}]`,
      `${audio}[${index + 1}:a]acrossfade=d=${CUT_FADE}[a${index + 1}]`,
    );
    video = `[v${index + 1}]`;
    audio = `[a${index + 1}]`;
  });
  const out = join(VIDEO, name);
  run([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', video, '-map', audio,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ]);
  console.log(`✓ ${out} — ${duration(out).toFixed(1)} s`);
  return out;
};

// X: знакомство → живое демо на Solana → финальный кадр
cut(['01-intro', '05-demo-start', '13-outro'], 'crypto-bot-x-teaser.mp4');

// ---------- История 9:16 для Instagram и Telegram (11 с) ----------
// Картинка — живое демо из того же ролика без вшитых субтитров, голос — вступление
// тизера; в конце карточка «Trend-following you can verify» с финальной фразой.
const CLEAN = join(VIDEO, 'crypto-bot-demo.mp4');
const STORY_LAYERS = join(WORK, 'story');
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Контент страницы в кадре 1920×1080 занимает x 416–1503: вырезаем его с полями
const CROP = { x: 396, width: 1128 };
const PANEL = { x: 40, y: 430, width: 1000, height: 958 };
const CAPTION_Y = 1420;
const INTRO = 7.4; // «Meet Crypto Bot … proves every decision on-chain.»
const END = 4.0; // карточка с фразой «Crypto Bot. Trend-following you can verify.»
const STORY_FADE = 0.4;

const renderStoryLayers = async () => {
  const { mkdirSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const puppeteer = (await import('puppeteer-core')).default;
  mkdirSync(STORY_LAYERS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(ROOT, 'stories', 'story.html')).href, {
      waitUntil: 'networkidle0',
    });
    await page.evaluate(() => document.fonts.ready);
    for (const id of ['frame', 'cap1', 'cap2', 'end']) {
      const element = await page.$(`#${id}`);
      await element.screenshot({
        path: join(STORY_LAYERS, `${id}.png`),
        omitBackground: true,
      });
    }
  } finally {
    await browser.close();
  }
};

const story = async (name) => {
  if (!existsSync(CLEAN)) throw new Error(`Нет ${CLEAN}`);
  await renderStoryLayers();
  const intro = piece('01-intro');
  // Коротко диалог «Start on Solana», затем первые покупки
  const demoFrom = cue("Let's see it live").from + 5.6;
  // Финальная фраза целиком, но без «Thank you», которое идёт следом
  const tagline = cue('Crypto Bot. Trend-following');
  const taglineFrom = tagline.from - SPEECH_PAD;
  const taglineLength = tagline.to + 0.03 - taglineFrom;
  // Пауза после вступления: голос финала звучит, когда карточка уже видна
  const taglineAt = INTRO + 0.2;
  const total = INTRO + END - STORY_FADE;
  const layer = (file) => [
    '-loop', '1', '-framerate', '30', '-t', total.toFixed(2), '-i', join(STORY_LAYERS, file),
  ];
  const out = join(VIDEO, name);
  run([
    '-ss', demoFrom.toFixed(3), '-t', INTRO.toFixed(2), '-i', CLEAN,
    '-ss', intro.from.toFixed(3), '-t', INTRO.toFixed(2), '-i', CLEAN,
    '-ss', taglineFrom.toFixed(3), '-t', taglineLength.toFixed(3), '-i', CLEAN,
    ...layer('frame.png'),
    ...layer('cap1.png'),
    ...layer('cap2.png'),
    ...layer('end.png'),
    '-filter_complex',
    [
      `[0:v]crop=${CROP.width}:1080:${CROP.x}:0,scale=${PANEL.width}:${PANEL.height},setsar=1,fps=30[demo]`,
      `color=c=0x0b1020:s=1080x1920:r=30:d=${INTRO}[base]`,
      `[base][demo]overlay=${PANEL.x}:${PANEL.y}[s1]`,
      '[s1][3:v]overlay=0:0:shortest=1[s2]',
      `[s2][4:v]overlay=0:${CAPTION_Y}:enable='between(t,0.25,3.7)'[s3]`,
      `[s3][5:v]overlay=0:${CAPTION_Y}:enable='gte(t,3.7)',trim=duration=${INTRO},setpts=PTS-STARTPTS,fps=30[a]`,
      `[6:v]format=rgba,trim=duration=${END},setpts=PTS-STARTPTS,fps=30[b]`,
      `[a]format=yuv420p[a2];[b]format=yuv420p[b2]`,
      `[a2][b2]xfade=transition=fade:duration=${STORY_FADE}:offset=${(INTRO - STORY_FADE).toFixed(2)},fade=t=in:st=0:d=0.25[v]`,
      `[1:a]atrim=0:${INTRO - 0.1},apad=whole_dur=${total}[voice1]`,
      `[2:a]adelay=${Math.round((taglineAt - SPEECH_PAD) * 1000)}|${Math.round((taglineAt - SPEECH_PAD) * 1000)},apad=whole_dur=${total}[voice2]`,
      `[voice1][voice2]amix=inputs=2:normalize=0,atrim=0:${total},afade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5[aout]`,
    ].join(';'),
    '-map', '[v]', '-map', '[aout]',
    '-t', total.toFixed(2),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ]);
  console.log(`✓ ${out} — ${duration(out).toFixed(1)} s, 1080×1920`);
};

await story('crypto-bot-story-9x16.mp4');
