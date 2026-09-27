// Короткие ролики для соцсетей из готового демо-видео (сначала node make-video.mjs).
// X: обычный аккаунт принимает видео до 2:20, поэтому делаем тизер ~30 с
// из целых сегментов — с субтитрами, потому что в ленте видео играет без звука.
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

// Отрезок сегмента без зон перехода к соседям
const piece = (id) => {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) throw new Error(`Нет сегмента ${id}`);
  const { start: from, length } = segments[index];
  return {
    from: index === 0 ? 0 : from + FADE,
    to: index === segments.length - 1 ? total : from + length - FADE,
  };
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
