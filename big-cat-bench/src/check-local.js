// npm run check-local — hit STT, LLM, and TTS with one trivial request each and
// print OK/FAIL + timing, so the GPU-VM side can be validated before `npm run local`.
import 'dotenv/config';
import { float32ToWav, parseWav } from './local-util.js';

const STT_URL = (process.env.STT_URL ?? '').replace(/\/$/, '');
const LLM_URL = (process.env.LLM_URL ?? '').replace(/\/$/, '');
const TTS_URL = (process.env.TTS_URL ?? '').replace(/\/$/, '');
const STT_MODEL = process.env.STT_MODEL ?? 'Systran/faster-whisper-large-v3-turbo';
const LLM_MODEL = process.env.LLM_MODEL ?? 'Qwen/Qwen3.6-35B-A3B-FP8';
const TTS_API = process.env.TTS_API ?? 'chatterbox';
const TTS_MODEL = process.env.TTS_MODEL ?? 'kokoro';
const TTS_VOICE = process.env.TTS_VOICE ?? 'Emily.wav';
const TTS_VOICE_MODE = process.env.TTS_VOICE_MODE ?? 'predefined';
const TTS_EXAGGERATION = Number(process.env.TTS_EXAGGERATION ?? 0.5);
const TIMEOUT_MS = 60_000; // first calls may pull a model

async function checkStt() {
  if (!STT_URL) throw new Error('STT_URL not set');
  const fd = new FormData();
  fd.append('file', new Blob([float32ToWav(new Float32Array(8000), 16000)], { type: 'audio/wav' }), 'silence.wav');
  fd.append('model', STT_MODEL);
  const res = await fetch(`${STT_URL}/v1/audio/transcriptions`, {
    method: 'POST', body: fd, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return `${STT_MODEL} -> "${(j.text ?? '').trim() || '(silence)'}"`;
}

async function checkLlm() {
  if (!LLM_URL) throw new Error('LLM_URL not set');
  const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 8,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return `${LLM_MODEL} -> "${(j.choices?.[0]?.message?.content ?? '').trim()}"`;
}

async function checkTts() {
  if (!TTS_URL) throw new Error('TTS_URL not set');
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  if (TTS_API === 'chatterbox') {
    const voiceKey = TTS_VOICE_MODE === 'clone' ? 'reference_audio_filename' : 'predefined_voice_id';
    const res = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        text: 'Local brain check.',
        voice_mode: TTS_VOICE_MODE,
        [voiceKey]: TTS_VOICE,
        output_format: 'wav',
        split_text: false,
        exaggeration: TTS_EXAGGERATION,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const wav = parseWav(Buffer.from(await res.arrayBuffer()));
    const secs = wav.pcm.length / 2 / wav.sampleRate;
    return `${TTS_VOICE_MODE}:${TTS_VOICE} -> ${secs.toFixed(1)}s of ${wav.sampleRate} Hz WAV`;
  }
  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model: TTS_MODEL, input: 'Local brain check.', voice: TTS_VOICE, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const bytes = (await res.arrayBuffer()).byteLength;
  if (bytes < 1000) throw new Error(`suspiciously small PCM response (${bytes} bytes)`);
  return `${TTS_VOICE} -> ${bytes} bytes of PCM (~${(bytes / 2 / 24000).toFixed(1)}s @ 24 kHz)`;
}

let failed = 0;
for (const [name, url, fn] of [
  ['stt', STT_URL, checkStt],
  ['llm', LLM_URL, checkLlm],
  ['tts', TTS_URL, checkTts],
]) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    console.log(`[ ok ] ${name.padEnd(3)} ${String(Math.round(performance.now() - t0)).padStart(5)}ms  ${url}  ${detail}`);
  } catch (e) {
    failed++;
    console.log(`[FAIL] ${name.padEnd(3)} ${String(Math.round(performance.now() - t0)).padStart(5)}ms  ${url}  ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
