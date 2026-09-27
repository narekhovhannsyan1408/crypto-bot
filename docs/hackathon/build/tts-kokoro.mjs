// Нейросетевая озвучка Kokoro-82M (Apache-2.0), локально через onnxruntime.
// Модель (~325 МБ) скачивается с huggingface.co при первом запуске в work/models.
import { env } from '@huggingface/transformers';
import { join } from 'node:path';
import { KokoroTTS } from 'kokoro-js';

env.cacheDir = join(import.meta.dirname, 'work', 'models');

let ttsPromise = null;
const load = () =>
  (ttsPromise ??= KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'fp32',
    device: 'cpu',
  }));

/** Озвучивает текст в WAV (24 кГц). */
export async function speak(text, path, { voice = 'af_heart', speed = 1 } = {}) {
  const tts = await load();
  const audio = await tts.generate(text, { voice, speed });
  await audio.save(path);
}

// node tts-kokoro.mjs "Text" out.wav [voice] — быстрая проверка
if (process.argv[1] === import.meta.filename) {
  const [text = 'Meet Crypto Bot.', out = 'work/tts-test.wav', voice] = process.argv.slice(2);
  await speak(text, out, { voice });
  console.log('✓', out);
}
