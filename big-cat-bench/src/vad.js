// Realtime Silero VAD over the 16 kHz mic stream.
//
// @ricky0123/vad-node only exports a non-realtime API, but it ships the Silero
// ONNX model plus the streaming FrameProcessor it uses internally — we wire
// those together here (an "equivalent ONNX runtime approach"). onnxruntime-node
// has prebuilt Windows/macOS/Linux binaries, so there is no native build step.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const { FrameProcessor, Message } = require('@ricky0123/vad-node');
const { Silero } = require('@ricky0123/vad-node/dist/_common/models.js');

const FRAME_SAMPLES = 512;                        // 32 ms @ 16 kHz
const MS_PER_FRAME = (FRAME_SAMPLES / 16000) * 1000;

/**
 * Streaming VAD. feed() raw 16 kHz s16le PCM as it arrives from the mic;
 * onSpeechStart fires within ~1 frame of speech onset (barge-in),
 * onSpeechEnd fires after `silenceMs` of silence with the whole utterance
 * (Float32Array, includes ~`preSpeechPadMs` of lead-in).
 */
export async function createVad({
  threshold = 0.5,
  silenceMs = 400,
  preSpeechPadMs = 320,
  minSpeechMs = 128,
  onSpeechStart,
  onSpeechEnd, // (audioFloat32, { vadMs }) — vadMs: time from last speech to the decision
} = {}) {
  const modelPath = require.resolve('@ricky0123/vad-node/dist/silero_vad.onnx');
  const model = await Silero.new(ort, async () => (await readFile(modelPath)).buffer);

  const fp = new FrameProcessor(model.process, model.reset_state, {
    frameSamples: FRAME_SAMPLES,
    positiveSpeechThreshold: threshold,
    negativeSpeechThreshold: Math.max(0.15, threshold - 0.15),
    preSpeechPadFrames: Math.max(1, Math.round(preSpeechPadMs / MS_PER_FRAME)),
    redemptionFrames: Math.max(1, Math.round(silenceMs / MS_PER_FRAME)),
    minSpeechFrames: Math.max(1, Math.round(minSpeechMs / MS_PER_FRAME)),
    submitUserSpeechOnPause: false,
  });
  fp.resume();

  let carry = Buffer.alloc(0);   // partial s16le samples between mic chunks
  let lastSpeechAt = 0;
  let chain = Promise.resolve(); // frames must reach the model strictly in order
  let closed = false;

  async function processFrame(frame) {
    if (closed) return;
    const r = await fp.process(frame);
    if (r.probs?.isSpeech >= threshold) lastSpeechAt = performance.now();
    if (r.msg === Message.SpeechStart) onSpeechStart?.();
    else if (r.msg === Message.SpeechEnd) {
      onSpeechEnd?.(r.audio, { vadMs: Math.round(performance.now() - lastSpeechAt) });
    }
  }

  return {
    feed(pcm) {
      if (closed) return;
      carry = carry.length ? Buffer.concat([carry, pcm]) : pcm;
      const frameBytes = FRAME_SAMPLES * 2;
      while (carry.length >= frameBytes) {
        const slice = carry.subarray(0, frameBytes);
        carry = carry.subarray(frameBytes);
        const frame = new Float32Array(FRAME_SAMPLES);
        for (let i = 0; i < FRAME_SAMPLES; i++) frame[i] = slice.readInt16LE(i * 2) / 32768;
        chain = chain.then(() => processFrame(frame)).catch((e) => console.error('[vad]', e.message));
      }
    },
    close() { closed = true; fp.pause(); },
  };
}
