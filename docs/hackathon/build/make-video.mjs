// Сборка видео для хакатона: слайды + записи интерфейса + озвучка + субтитры.
//   node render-slides.mjs && node record-demo.mjs && node make-video.mjs
//
// Озвучка: если есть docs/hackathon/video/voice/<id>.wav (ваш голос), берётся он,
// иначе — нейросеть Kokoro (engine: "kokoro", см. tts-kokoro.mjs) или macOS `say`
// (engine: "say") голосом из script.json. Результат:
// video/crypto-bot-demo.mp4 (чистый, субтитры — отдельным captions.srt),
// video/crypto-bot-demo-captions.mp4 (субтитры вшиты — для просмотра без звука),
// video/voiceover.md (текст для записи своим голосом).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { speak } from './tts-kokoro.mjs';

const ROOT = join(import.meta.dirname, '..');
const VIDEO = join(ROOT, 'video');
const SLIDES = join(ROOT, 'slides');
const CLIPS = join(import.meta.dirname, 'work', 'clips');
// SCRIPT=demo-script.json — другой ролик (например, продуктовое демо) из того же конвейера
const script = JSON.parse(
  readFileSync(join(VIDEO, process.env.SCRIPT ?? 'script.json'), 'utf8'),
);
// У каждого ролика свои озвучка и сегменты; основной ролик — в work/, как раньше
const NAME = script.output ?? 'crypto-bot-demo';
const WORK = script.output
  ? join(import.meta.dirname, 'work', script.output)
  : join(import.meta.dirname, 'work');
const LABEL_FONT = '/System/Library/Fonts/Helvetica.ttc';

const FPS = 30;
const LEAD = 0.5; // тишина перед репликой
const TAIL = 0.75; // пауза после реплики
const FADE = 0.5; // переход между сегментами
const MAX_CLIP_SPEEDUP = 1.8;

for (const dir of [join(WORK, 'audio'), join(WORK, 'segments'), VIDEO]) {
  mkdirSync(dir, { recursive: true });
}

const run = (args) =>
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

const duration = (file) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]).toString(),
  );

// 1. Озвучка каждого сегмента
async function narration(segment) {
  const custom = join(VIDEO, 'voice', `${segment.id}.wav`);
  const wav = join(WORK, 'audio', `${segment.id}.wav`);
  if (existsSync(custom)) {
    run(['-i', custom, '-ar', '48000', '-ac', '2', wav]);
  } else if (script.engine === 'kokoro') {
    const raw = join(WORK, 'audio', `${segment.id}.kokoro.wav`);
    await speak(segment.text, raw, script.kokoro);
    run(['-i', raw, '-ar', '48000', '-ac', '2', wav]);
  } else {
    const aiff = join(WORK, 'audio', `${segment.id}.aiff`);
    execFileSync('say', ['-v', script.voice, '-r', String(script.rate), '-o', aiff, segment.text]);
    run(['-i', aiff, '-ar', '48000', '-ac', '2', wav]);
  }
  return wav;
}

// 2. Видео сегмента нужной длины с озвучкой
async function buildSegment(segment, index) {
  const audio = await narration(segment);
  const spoken = duration(audio);
  const out = join(WORK, 'segments', `${String(index).padStart(2, '0')}.mp4`);
  const audioFilter = `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${LEAD * 1000}:all=1,apad[a]`;
  let length = spoken + LEAD + TAIL;
  let video;

  if (segment.visual.slide || segment.visual.image) {
    const frames = Math.round(length * FPS);
    // image — готовый кадр 1920×1080 (путь от docs/hackathon), slide — номер слайда
    const image = segment.visual.image
      ? join(ROOT, segment.visual.image)
      : join(SLIDES, `slide-${String(segment.visual.slide).padStart(2, '0')}.png`);
    // Медленный зум: изображение увеличено вдвое, чтобы движение было плавным; zoom: 0 — без зума
    const zoom = script.zoom ?? 0.035;
    video = [
      '-i', image,
      '-i', audio,
      '-filter_complex',
      `[0:v]scale=3840:2160,zoompan=z='1+${zoom}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${FPS},format=yuv420p[v];${audioFilter}`,
    ];
  } else {
    const clip = join(CLIPS, `${segment.visual.clip}.mp4`);
    const clipLength = duration(clip);
    // Длинный клип немного ускоряем, короткий — удерживаем на последнем кадре.
    // fit: клип записан ровно под озвучку, но запись экрана растягивает время —
    // сжимаем его точно до длины сегмента, чтобы действия совпали с репликами
    const speed = segment.visual.fit
      ? clipLength / length
      : Math.min(Math.max(clipLength / (length + 1.5), 1), MAX_CLIP_SPEEDUP);
    const played = clipLength / speed;
    length = Math.max(length, played);
    // Плашка поверх записи, например «Replay · …» для кадров не из живой сессии
    const label = segment.visual.label
      ? `,drawtext=fontfile=${LABEL_FONT}:text='${segment.visual.label.replace(/[':\\]/g, '')}':x=40:y=84:fontsize=34:fontcolor=white:box=1:boxcolor=0x3b5bdb@0.95:boxborderw=18`
      : '';
    video = [
      '-i', clip,
      '-i', audio,
      '-filter_complex',
      `[0:v]setpts=PTS/${speed.toFixed(4)},fps=${FPS},tpad=stop_mode=clone:stop_duration=${(length - played + 1).toFixed(2)},scale=1920:1080${label},format=yuv420p[v];${audioFilter}`,
    ];
  }

  run([
    ...video,
    '-map', '[v]', '-map', '[a]',
    '-t', length.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k',
    out,
  ]);
  console.log(`✓ ${segment.id}: ${length.toFixed(1)} s (voice ${spoken.toFixed(1)} s)`);
  return { file: out, length, spoken };
}

// 3. Субтитры: реплика делится на фразы, время — пропорционально длине фразы
const srtTime = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

const MAX_CAPTION = 64;

// Режет фразу на части примерно равной длины по границам слов (без «висячих» хвостов)
function balancedSplit(sentence) {
  const parts = Math.ceil(sentence.length / MAX_CAPTION);
  if (parts <= 1) return [sentence];
  const words = sentence.split(' ');
  const target = sentence.length / parts;
  const result = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > target && result.length < parts - 1) {
      result.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) result.push(line);
  return result;
}

function phrases(text) {
  // Граница предложения — знак препинания и пробел: «99.5» не режется
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  // Короткий обрывок («Meet Crypto Bot:») читается вместе со следующей фразой
  const merged = [];
  for (const sentence of sentences) {
    const last = merged[merged.length - 1];
    if (last && last.length < 28 && `${last} ${sentence}`.length <= MAX_CAPTION) {
      merged[merged.length - 1] = `${last} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  // Длинную фразу сначала делим по запятым и двоеточиям, чтобы строки не рвались посреди смысла
  return merged.flatMap((sentence) => {
    if (sentence.length <= MAX_CAPTION) return [sentence];
    const clauses = sentence.split(/(?<=[,:;])\s+/);
    const lines = [];
    for (const clause of clauses) {
      const last = lines[lines.length - 1];
      if (last && `${last} ${clause}`.length <= MAX_CAPTION) {
        lines[lines.length - 1] = `${last} ${clause}`;
      } else {
        lines.push(clause);
      }
    }
    return lines.flatMap(balancedSplit);
  });
}

function captions(segments) {
  const cues = [];
  let start = 0;
  segments.forEach(({ segment, length, spoken }) => {
    const parts = phrases(segment.text);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    let cursor = start + LEAD;
    for (const part of parts) {
      const span = (part.length / total) * spoken;
      cues.push({ from: cursor, to: cursor + span - 0.05, text: part });
      cursor += span;
    }
    start += length - FADE;
  });
  return cues
    .map((cue, index) => `${index + 1}\n${srtTime(cue.from)} --> ${srtTime(cue.to)}\n${cue.text}\n`)
    .join('\n');
}

// 4. Склейка с переходами, нормализация громкости и вшитые субтитры
function assemble(built, srtPath, { burn, name }) {
  const inputs = built.flatMap(({ file }) => ['-i', file]);
  const filters = [];
  let video = '[0:v]';
  let audio = '[0:a]';
  let offset = 0;
  built.slice(1).forEach((item, index) => {
    offset += built[index].length - FADE;
    const v = `[v${index + 1}]`;
    const a = `[a${index + 1}]`;
    filters.push(`${video}[${index + 1}:v]xfade=transition=${script.transition ?? 'fade'}:duration=${FADE}:offset=${offset.toFixed(3)}${v}`);
    filters.push(`${audio}[${index + 1}:a]acrossfade=d=${FADE}${a}`);
    video = v;
    audio = a;
  });
  const total = built.reduce((sum, item) => sum + item.length, 0) - FADE * (built.length - 1);
  const style =
    "FontName=Helvetica Neue,FontSize=10,PrimaryColour=&H00FFFFFF,OutlineColour=&H20101828,BorderStyle=3,Outline=6,Shadow=0,MarginV=26";
  const subtitles = burn ? `,subtitles=${srtPath}:force_style='${style}'` : '';
  filters.push(
    `${video}fade=t=in:st=0:d=0.6,fade=t=out:st=${(total - 1).toFixed(3)}:d=1${subtitles}[vout]`,
  );
  filters.push(
    `${audio}loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${(total - 1).toFixed(3)}:d=1[aout]`,
  );
  const out = join(VIDEO, name);
  run([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ]);
  console.log(`✓ ${out} — ${total.toFixed(1)} s`);
}

function voiceoverDoc(built) {
  let start = 0;
  const rows = built.map(({ segment, length }) => {
    const visual = segment.visual.slide
      ? `slide ${segment.visual.slide}`
      : `screen recording: ${segment.visual.clip}`;
    const row = `### ${srtTime(start).slice(3, 8)} · ${segment.id} (${visual})\n\n${segment.text}\n`;
    start += length - FADE;
    return row;
  });
  writeFileSync(
    join(VIDEO, 'voiceover.md'),
    `# ${script.title} — voice-over script\n\n` +
      'Read each block at a calm pace. To replace the synthetic voice, record a WAV per block ' +
      'into `video/voice/<id>.wav` (for example `video/voice/01-intro.wav`) and run ' +
      '`node make-video.mjs` in `docs/hackathon/build` — the video is re-timed to your recording.\n\n' +
      rows.join('\n'),
  );
}

const built = [];
for (const [index, segment] of script.segments.entries()) {
  built.push({ segment, ...(await buildSegment(segment, index)) });
}
const srtPath = join(VIDEO, script.output ? `${NAME}.srt` : 'captions.srt');
writeFileSync(srtPath, captions(built));
if (!script.output) voiceoverDoc(built);
assemble(built, srtPath, { burn: false, name: `${NAME}.mp4` });
assemble(built, srtPath, { burn: true, name: `${NAME}-captions.mp4` });
