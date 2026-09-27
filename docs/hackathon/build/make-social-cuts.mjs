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
// Три сцены: продукт (живое демо в окне) → участие в хакатоне Colosseum →
// страница проекта в X. Озвучка — тот же локальный голос Kokoro, что и в демо.
const CLEAN = join(VIDEO, 'crypto-bot-demo.mp4');
const STORY_LAYERS = join(WORK, 'story');
const STORY_VOICE = join(WORK, 'story-voice');
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Контент страницы в кадре 1920×1080 занимает x 416–1503: вырезаем его с полями
const CROP = { x: 396, width: 1128 };
const PANEL = { x: 40, y: 470, width: 1000, height: 958 };
const STORY_FADE = 0.3;
// Длительность сцен с учётом переходов: 4.65 + 3.55 + 3.4 − 2 × 0.3 = 11 с.
// speechAt — когда звучит начало фразы: паузы между фразами ~0.35 с,
// смена сцены приходится на паузу
const SCENES = [
  {
    id: 'product',
    length: 4.65,
    speechAt: 0.2,
    voice: 'Crypto Bot: trend-following on Solana, with every decision proven on-chain.',
  },
  {
    id: 'colosseum',
    length: 3.55,
    speechAt: 4.66,
    voice: "We're competing in the Colosseum hackathon, Crypto World's Fair.",
  },
  {
    id: 'follow',
    length: 3.4,
    speechAt: 7.95,
    // Ник читается словами: «cryptobot1414» синтезатор произносит неразборчиво
    voice: 'Follow the build on X: crypto bot fourteen fourteen.',
  },
];
const VOICE = { voice: 'af_heart', speed: 1.2 };

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
    for (const { id } of SCENES) {
      const element = await page.$(`#${id}`);
      // У сцены продукта прозрачное окно, под ним будет видео
      await element.screenshot({
        path: join(STORY_LAYERS, `${id}.png`),
        omitBackground: true,
      });
    }
  } finally {
    await browser.close();
  }
};

const renderStoryVoice = async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { speak } = await import('./tts-kokoro.mjs');
  mkdirSync(STORY_VOICE, { recursive: true });
  for (const scene of SCENES) {
    // Озвучка пересобирается, только если поменялся текст или голос
    const key = JSON.stringify({ text: scene.voice, ...VOICE });
    const keyFile = join(STORY_VOICE, `${scene.id}.json`);
    const wav = join(STORY_VOICE, `${scene.id}.wav`);
    if (existsSync(wav) && existsSync(keyFile) && readFileSync(keyFile, 'utf8') === key) {
      continue;
    }
    await speak(scene.voice, wav, VOICE);
    writeFileSync(keyFile, key);
  }
};

const story = async (name) => {
  if (!existsSync(CLEAN)) throw new Error(`Нет ${CLEAN}`);
  await renderStoryLayers();
  await renderStoryVoice();
  // Демо: только что запущенный бот покупает монеты и объясняет сделки
  const demoFrom = cue("Let's see it live").from + 8.0;
  const starts = [];
  let at = 0;
  for (const scene of SCENES) {
    starts.push(at);
    at += scene.length - STORY_FADE;
  }
  const total = at + STORY_FADE;
  const [product, colosseum, follow] = SCENES;
  const still = (scene) => [
    '-loop', '1', '-framerate', '30', '-t', scene.length.toFixed(2),
    '-i', join(STORY_LAYERS, `${scene.id}.png`),
  ];
  const out = join(VIDEO, name);
  const filters = [
    // Сцена 1: демо в окне под рамкой
    `[0:v]crop=${CROP.width}:1080:${CROP.x}:0,scale=${PANEL.width}:${PANEL.height},setsar=1,fps=30[demo]`,
    `color=c=0x0b1020:s=1080x1920:r=30:d=${product.length}[base]`,
    `[base][demo]overlay=${PANEL.x}:${PANEL.y}[p1]`,
    `[p1][1:v]overlay=0:0,trim=duration=${product.length},setpts=PTS-STARTPTS,fps=30,format=yuv420p[s0]`,
    `[2:v]trim=duration=${colosseum.length},setpts=PTS-STARTPTS,fps=30,format=yuv420p[s1]`,
    `[3:v]trim=duration=${follow.length},setpts=PTS-STARTPTS,fps=30,format=yuv420p[s2]`,
    `[s0][s1]xfade=transition=smoothup:duration=${STORY_FADE}:offset=${(starts[1]).toFixed(2)}[x1]`,
    `[x1][s2]xfade=transition=smoothup:duration=${STORY_FADE}:offset=${(starts[2]).toFixed(2)},fade=t=in:st=0:d=0.25[v]`,
    // Тишина в начале файла озвучки убирается, фраза ставится точно на speechAt
    ...SCENES.map((scene, index) => {
      const delay = Math.round(scene.speechAt * 1000);
      return `[${4 + index}:a]aresample=48000,silenceremove=start_periods=1:start_threshold=-45dB,adelay=${delay}|${delay},apad=whole_dur=${total}[voice${index}]`;
    }),
    `[voice0][voice1][voice2]amix=inputs=3:normalize=0,atrim=0:${total},loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${(total - 0.4).toFixed(2)}:d=0.4[aout]`,
  ];
  run([
    '-ss', demoFrom.toFixed(3), '-t', product.length.toFixed(2), '-i', CLEAN,
    ...still(product),
    ...still(colosseum),
    ...still(follow),
    ...SCENES.flatMap((scene) => ['-i', join(STORY_VOICE, `${scene.id}.wav`)]),
    '-filter_complex', filters.join(';'),
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
