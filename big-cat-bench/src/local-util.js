// Small pure helpers for the local brain (index-local.js, check-local.js).

/** Float32 [-1,1] samples -> mono 16-bit WAV file buffer. */
export function float32ToWav(f32, sampleRate = 16000) {
  const data = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);              // PCM
  h.writeUInt16LE(1, 22);              // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32);              // block align
  h.writeUInt16LE(16, 34);             // bits per sample
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Mono 16-bit WAV file -> { sampleRate, pcm } (pcm = raw s16le Buffer). */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let off = 12, sampleRate = 0, bits = 0, channels = 0, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV: no data chunk');
  if (bits !== 16 || channels !== 1) throw new Error(`WAV: expected 16-bit mono, got ${bits}-bit ${channels}ch`);
  return { sampleRate, pcm: data };
}

/** Linear resample of s16le mono PCM. Returns the input untouched if rates match. */
export function resamplePcm16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * fromRate) / toRate;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const s = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.round(s), i * 2);
  }
  return out;
}

/**
 * Accumulates streamed LLM tokens and emits complete sentences, so TTS can
 * start on sentence one while the model is still writing sentence three.
 * push() returns zero or more finished sentences; flush() returns the tail.
 */
export class SentenceSplitter {
  #buf = '';
  #emitted = false;
  #eagerFirst;
  // sentence enders (+ closing quotes/brackets) followed by whitespace
  static #BOUNDARY = /([.!?…]+["')”\]]*)\s+/;
  static #CLAUSE = /([,;:])\s+/;

  /** eagerFirst: emit the FIRST chunk at a clause boundary (>= 24 chars) so
   *  TTS starts sooner; later chunks wait for full sentence boundaries. */
  constructor({ eagerFirst = false } = {}) {
    this.#eagerFirst = eagerFirst;
  }

  push(text) {
    this.#buf += text;
    const out = [];
    for (;;) {
      const m = SentenceSplitter.#BOUNDARY.exec(this.#buf);
      if (this.#eagerFirst && !this.#emitted) {
        const c = SentenceSplitter.#CLAUSE.exec(this.#buf);
        if (c && c.index >= 24 && (!m || c.index < m.index)) {
          out.push(this.#buf.slice(0, c.index + c[1].length).trim());
          this.#buf = this.#buf.slice(c.index + c[0].length);
          this.#emitted = true;
          continue;
        }
      }
      if (m) {
        this.#emitted = true;
        const sentence = this.#buf.slice(0, m.index + m[1].length).trim();
        this.#buf = this.#buf.slice(m.index + m[0].length);
        if (sentence) out.push(sentence);
        continue;
      }
      // no boundary but the buffer is getting long — cut at a space so TTS
      // never waits on a run-on sentence
      if (this.#buf.length > 240) {
        const cut = this.#buf.lastIndexOf(' ', 220);
        if (cut > 80) {
          out.push(this.#buf.slice(0, cut).trim());
          this.#buf = this.#buf.slice(cut + 1);
          continue;
        }
      }
      break;
    }
    return out;
  }

  flush() {
    const rest = this.#buf.trim();
    this.#buf = '';
    return rest || null;
  }
}
