// Local brain (Phase 1b): mic -> Silero VAD -> faster-whisper (speaches)
//                          -> vLLM (Qwen, OpenAI API) -> Chatterbox TTS -> face.
// Same body as the Gemini bench (media.js, face-server.js, ha.js); everything
// stays on the LAN — audio/images only ever go to the URLs configured in .env.
//
//   npm run check-local   (validate the GPU-VM services first)
//   npm run local
import 'dotenv/config';
import { listLights, toolDeclarationsOpenAI, toolHandlers } from './ha.js';
import { startMic, startCamera } from './media.js';
import { startFaceServer, pcmLevel } from './face-server.js';
import { createVad } from './vad.js';
import { float32ToWav, parseWav, resamplePcm16, SentenceSplitter } from './local-util.js';

// ---- config ------------------------------------------------------------------

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env (see .env.example)`);
  return v.replace(/\/$/, '');
}
const STT_URL = need('STT_URL');
const LLM_URL = need('LLM_URL');
const TTS_URL = need('TTS_URL');
const STT_MODEL = process.env.STT_MODEL ?? 'deepdml/faster-whisper-large-v3-turbo-ct2';
const LLM_MODEL = process.env.LLM_MODEL ?? 'Qwen/Qwen3.6-35B-A3B-FP8';
// TTS_API 'chatterbox' talks to Chatterbox-TTS-Server's /tts (per-request
// exaggeration, WAV out); 'openai' talks to /v1/audio/speech with pcm out
// (the kokoro fallback). Both end up as 24 kHz s16le toward the face.
const TTS_API = process.env.TTS_API ?? 'chatterbox';
const TTS_MODEL = process.env.TTS_MODEL ?? 'kokoro';            // openai path only
const TTS_VOICE = process.env.TTS_VOICE ?? 'Emily.wav';
const TTS_VOICE_MODE = process.env.TTS_VOICE_MODE ?? 'predefined'; // 'clone' for deploy/voices clips
const TTS_EXAGGERATION = Number(process.env.TTS_EXAGGERATION ?? 0.5);
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS ?? 400);
const VAD_THRESHOLD = Number(process.env.VAD_THRESHOLD ?? 0.5);
// Echo guard for open speakers (no AEC on the bench): while the bot's own
// audio is audible, the VAD needs this much confidence to trigger — speaker
// bleed stays below it, a direct voice talking over the bot still clears it.
const VAD_SPEAKING_THRESHOLD = Number(process.env.VAD_SPEAKING_THRESHOLD ?? 0.85);
const ECHO_TAIL_MS = 800;       // how long after the last audio slice the guard holds
const HISTORY_TURNS = Number(process.env.HISTORY_TURNS ?? 8);
const VIDEO_FPS = Number(process.env.VIDEO_FPS ?? 1);
// 'ffmpeg' = mic on this machine (the bench); 'satellite' = 16 kHz PCM pushed
// over the face WebSocket by the ESP32 satellite (see satellite/README.md).
const MIC_SOURCE = process.env.MIC_SOURCE ?? 'ffmpeg';
// The satellite has no camera; VIDEO_DEVICE=none runs the brain vision-free.
const CAMERA_OFF = (process.env.VIDEO_DEVICE ?? '').toLowerCase() === 'none';
const MAX_TOOL_HOPS = 4;
const FACE_RATE = 24000;        // what face/index.html plays
const SLICE_BYTES = 4800;       // 100 ms of 24 kHz s16le per level/pacing slice
const LEAD_MS = 300;            // how far ahead of playback we push audio

// ---- face + personas (same UX as the Gemini brain) ---------------------------

const face = startFaceServer();

// Optional per-persona voices via env (e.g. TTS_VOICE_HAL9000=hal.wav);
// every face falls back to TTS_VOICE.
const FACES = ['pepper', 'hal9000', 'terminator', 'r2d2'];
const voiceFor = (name) => process.env[`TTS_VOICE_${name.toUpperCase()}`] ?? TTS_VOICE;
let currentVoice = voiceFor('pepper');

const faceToolOpenAI = {
  type: 'function',
  function: {
    name: 'set_face',
    description:
      'Morph the on-screen robot face (and voice) to fit the current topic or mood. ' +
      'pepper: the default friendly robot face — everyday chat and home control. ' +
      'hal9000: calm red camera eye — space, AI, computers, deadpan moments. ' +
      'terminator: chrome skull — security, alarms, threats, action movies. ' +
      'r2d2: astromech dome — Star Wars, gadgets, tinkering, playful moods. ' +
      'Switch when the topic clearly shifts and return to pepper afterwards.',
    parameters: {
      type: 'object',
      properties: { face: { type: 'string', enum: FACES, description: 'Which face to show.' } },
      required: ['face'],
    },
  },
};
// The satellite's pan servo: the model can look around on request.
const HEAD_POSITIONS = { left: -1, 'slightly-left': -0.5, center: 0, 'slightly-right': 0.5, right: 1 };
const headToolOpenAI = {
  type: 'function',
  function: {
    name: 'move_head',
    description:
      'Turn your head (a pan servo on the satellite body) to face a direction. ' +
      'Use it when asked to look somewhere, to face the person talking to you, ' +
      'or for emphasis. Return to center when done.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: Object.keys(HEAD_POSITIONS),
          description: 'Where to turn, from your point of view.',
        },
      },
      required: ['direction'],
    },
  },
};

const localToolHandlers = {
  ...toolHandlers,
  set_face: ({ face: name }) => {
    if (!FACES.includes(name)) return { error: `unknown face: ${name}` };
    face.setFace(name);
    currentVoice = voiceFor(name); // voice rides each TTS request — takes effect immediately
    return { face: name, voice: currentVoice };
  },
  move_head: ({ direction }) => {
    const pos = HEAD_POSITIONS[direction];
    if (pos === undefined) return { error: `unknown direction: ${direction}` };
    face.servo(pos);
    return { direction };
  },
};
const tools = [...toolDeclarationsOpenAI, faceToolOpenAI, headToolOpenAI];

// ---- system prompt (same text as index.js, plus TTS plain-text rule) ---------

const lights = await listLights();
console.log(`[ha] ${lights.length} lights known`);

const SYSTEM_PROMPT =
  'You are a compact, friendly home assistant robot on a desk. ' +
  (CAMERA_OFF
    ? 'You can hear through a mic but have no camera. '
    : 'You can see through a webcam and hear through a mic. ') +
  'You have a head that can turn: call move_head to look toward a direction ' +
  'when asked or when it fits the moment. Keep spoken replies short. ' +
  'When asked to control a light, call toggle_light with the exact entity_id. ' +
  'If the request is ambiguous, ask which light. ' +
  'Your face is shown on a display and can morph between personas: call set_face ' +
  'when the conversation topic clearly fits one (see the tool description), and ' +
  'call it with "pepper" to return to normal when the topic passes. Do not ' +
  'announce the face change; just do it. ' +
  'Your reply is spoken aloud by a TTS engine: plain conversational text only, ' +
  'no markdown, no emoji, no lists. Speak only the reply itself — never narrate ' +
  'what the user said, your reasoning, or your intentions. Only call tools when ' +
  'the user clearly asks for that action; if they make a filler sound or brief ' +
  'acknowledgment (mm-hmm, okay, yeah), answer with a short word and no tool ' +
  'calls. Known lights (entity_id, name, state):\n' +
  lights.map((l) => `- ${l.entity_id} | ${l.name} | ${l.state}`).join('\n');

// ---- state -------------------------------------------------------------------

const history = [];      // rolling [{role:'user'|'assistant', content}] pairs
let latestJpeg = null;   // most recent webcam frame
let latestJpegAt = 0;
let activeTurn = null;   // { ac: AbortController }
let shuttingDown = false;
let audioActiveUntil = 0;        // wall-clock ms: bot audio audible until then
let utteranceDuringBotAudio = false;
const spokenLog = [];            // recent bot sentences, for self-echo detection

const botAudible = () => Date.now() < audioActiveUntil;

/** True when a transcript is mostly words the bot itself just spoke. */
function looksLikeEcho(text) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const words = norm(text);
  if (words.length < 3) return false;
  const spoken = new Set(norm(spokenLog.join(' ')));
  const hits = words.filter((w) => spoken.has(w)).length;
  return hits / words.length >= 0.8;
}

// ---- STT ---------------------------------------------------------------------

async function transcribe(audioF32, signal) {
  const fd = new FormData();
  fd.append('file', new Blob([float32ToWav(audioF32, 16000)], { type: 'audio/wav' }), 'utterance.wav');
  fd.append('model', STT_MODEL);
  const res = await fetch(`${STT_URL}/v1/audio/transcriptions`, { method: 'POST', body: fd, signal });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  return (await res.json()).text ?? '';
}

// ---- LLM (OpenAI chat completions, streaming, with tool calls) ----------------

async function chatOnce(messages, turn, onToken, timings) {
  const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: turn.ac.signal,
    body: JSON.stringify({ model: LLM_MODEL, messages, tools, stream: true, temperature: 0.6 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);

  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  const toolCalls = [];
  let finishReason = null;

  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop(); // keep the trailing partial line
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : null;
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const choice = json.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content || d.tool_calls?.length) timings.llmFirstToken ??= performance.now();
      if (d.content) { content += d.content; onToken(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const slot = (toolCalls[tc.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean), finishReason };
}

// ---- TTS pipeline -------------------------------------------------------------
// Sentences fire requests as soon as they exist; a single consumer streams the
// responses to the face strictly in order, so sentence 1 plays while 2+ generate.

function fetchTts(sentence, signal) {
  if (TTS_API === 'chatterbox') {
    // /tts rather than /v1/audio/speech: only /tts takes exaggeration per
    // request (the OpenAI endpoint always uses server config defaults).
    const voiceKey = TTS_VOICE_MODE === 'clone' ? 'reference_audio_filename' : 'predefined_voice_id';
    return fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        text: sentence,
        voice_mode: TTS_VOICE_MODE,
        [voiceKey]: currentVoice,
        output_format: 'wav',
        split_text: false,          // we already split per sentence
        exaggeration: TTS_EXAGGERATION,
        speed_factor: 1.0,
      }),
    });
  }
  // openai path (kokoro fallback): raw 24 kHz s16le PCM
  return fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: TTS_MODEL,
      input: sentence,
      voice: currentVoice,
      response_format: 'pcm',
      speed: 1.0,
    }),
  });
}

function createSpeaker(turn, timings) {
  const queue = [];
  let notify = null;
  let closed = false;
  let botLine = '';
  let playClock = 0; // ms timestamp up to which the face has audio scheduled

  const abortableSleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    turn.ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

  // Send PCM to the face in ~100 ms slices, paced just ahead of playback, so
  // the mouth level tracks the audio and a barge-in has almost nothing queued.
  async function emitPcm24k(pcm) {
    for (let off = 0; off < pcm.length; off += SLICE_BYTES) {
      if (turn.ac.signal.aborted) return;
      const slice = pcm.subarray(off, Math.min(off + SLICE_BYTES, pcm.length));
      if (!timings.ttsFirstAudio) {
        timings.ttsFirstAudio = performance.now();
        face.state('speaking');
        vad.setThreshold(VAD_SPEAKING_THRESHOLD); // echo guard while we're audible
      }
      face.audio(slice);
      face.level(pcmLevel(slice));
      const now = Date.now();
      playClock = Math.max(playClock, now) + (slice.length / 2 / FACE_RATE) * 1000;
      audioActiveUntil = playClock + ECHO_TAIL_MS;
      const wait = playClock - now - LEAD_MS;
      if (wait > 0) await abortableSleep(wait);
    }
  }

  const pump = (async () => {
    try {
      for (;;) {
        while (!queue.length && !closed) await new Promise((r) => { notify = r; });
        if (!queue.length && closed) return;
        const { promise } = queue.shift();
        let res;
        try { res = await promise; } catch (e) {
          if (turn.ac.signal.aborted) return;
          console.error('[tts]', e.message); continue;
        }
        if (!res.ok) { console.error('[tts]', res.status, await res.text()); continue; }

        if (TTS_API === 'chatterbox') {
          // whole WAV per sentence (a few hundred KB) — parse, resample if needed
          const body = Buffer.from(await res.arrayBuffer());
          if (turn.ac.signal.aborted) return;
          let parsed;
          try { parsed = parseWav(body); } catch (e) { console.error('[tts]', e.message); continue; }
          await emitPcm24k(resamplePcm16(parsed.pcm, parsed.sampleRate, FACE_RATE));
        } else {
          // streamed raw PCM; carry odd bytes so slices stay sample-aligned
          let odd = null;
          for await (const chunk of res.body) {
            if (turn.ac.signal.aborted) return;
            let buf = odd ? Buffer.concat([odd, Buffer.from(chunk)]) : Buffer.from(chunk);
            odd = null;
            if (buf.length % 2) { odd = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
            if (buf.length) await emitPcm24k(buf);
          }
        }
      }
    } catch (e) {
      if (!turn.ac.signal.aborted) console.error('[tts]', e.message);
    }
  })();

  return {
    say(sentence) {
      if (turn.ac.signal.aborted || !/\p{L}|\p{N}/u.test(sentence)) return;
      botLine += (botLine ? ' ' : '') + sentence;
      face.caption('bot', botLine);
      spokenLog.push(sentence);
      while (spokenLog.length > 24) spokenLog.shift();
      timings.ttsRequestAt ??= performance.now();
      const promise = fetchTts(sentence, turn.ac.signal);
      // A barge-in aborts the turn and the pump bails without consuming the
      // rest of the queue; observe every rejection here or the AbortError
      // becomes an unhandled rejection and kills the process.
      promise.catch(() => {});
      queue.push({ promise });
      notify?.();
    },
    async end() { closed = true; notify?.(); await pump; },
  };
}

// ---- turn loop ----------------------------------------------------------------

function abortTurn() {
  if (!activeTurn) return;
  activeTurn.ac.abort();
  activeTurn = null;
}

function onSpeechStart() {
  utteranceDuringBotAudio = botAudible(); // remember for the echo filter
  if (activeTurn) {       // barge-in: kill LLM + TTS in flight, silence the face
    abortTurn();
    face.flush();
    audioActiveUntil = 0;
  }
  vad.setThreshold(VAD_THRESHOLD); // capture the rest of the utterance normally
  face.state('listening');
}

async function onSpeechEnd(audioF32, { vadMs }) {
  abortTurn();
  const turn = { ac: new AbortController() };
  activeTurn = turn;
  const tSpeechEnd = performance.now();
  face.state('thinking');

  const timings = {};
  let text;
  try {
    text = await transcribe(audioF32, turn.ac.signal);
  } catch (e) {
    if (!turn.ac.signal.aborted) console.error('[stt]', e.message);
    return finishTurn(turn);
  }
  timings.sttDone = performance.now();
  const clean = (text ?? '').trim();
  if (clean.length < 2 || /^[\p{P}\s]+$/u.test(clean)) return finishTurn(turn); // noise / empty
  if (utteranceDuringBotAudio && looksLikeEcho(clean)) {
    console.log(`[echo] ignored own voice: ${clean}`);
    return finishTurn(turn);
  }
  console.log(`You: ${clean}`);

  const userContent = [{ type: 'text', text: clean }];
  if (latestJpeg && Date.now() - latestJpegAt < 15_000) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${latestJpeg.toString('base64')}` },
    });
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userContent },
  ];

  const splitter = new SentenceSplitter({ eagerFirst: true });
  const speaker = createSpeaker(turn, timings);
  let fullReply = '';
  const onToken = (tok) => {
    fullReply += tok;
    for (const s of splitter.push(tok)) speaker.say(s);
  };

  try {
    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      const r = await chatOnce(messages, turn, onToken, timings);
      if (!r.toolCalls.length) break;
      face.state('thinking');
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      for (const tc of r.toolCalls) {
        let out;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          const handler = localToolHandlers[tc.function.name];
          out = handler ? await handler(args) : { error: `unknown tool ${tc.function.name}` };
        } catch (err) {
          out = { error: String(err.message ?? err) };
        }
        console.log(`[tool] ${tc.function.name}(${tc.function.arguments}) ->`, out);
        messages.push({ role: 'tool', tool_call_id: tc.id || tc.function.name, content: JSON.stringify(out) });
      }
    }
    const rest = splitter.flush();
    if (rest) speaker.say(rest);
  } catch (e) {
    if (!turn.ac.signal.aborted) console.error('[llm]', e.message);
  }
  await speaker.end();
  if (turn.ac.signal.aborted) return; // barge-in already reset the face

  const reply = fullReply.trim();
  if (reply) {
    console.log(`Bot: ${reply}`);
    history.push({ role: 'user', content: clean }, { role: 'assistant', content: reply });
    while (history.length > HISTORY_TURNS * 2) history.splice(0, 2);
  }

  const dur = (a, b) => (a && b ? Math.round(a - b) : '-');
  console.log(
    `[latency] vad=${vadMs}ms stt=${dur(timings.sttDone, tSpeechEnd)}ms ` +
    `llm_first_token=${dur(timings.llmFirstToken, timings.sttDone)}ms ` +
    `tts_first_audio=${dur(timings.ttsFirstAudio, timings.ttsRequestAt)}ms ` +
    `total=${dur(timings.ttsFirstAudio, tSpeechEnd)}ms`,
  );
  finishTurn(turn);
}

function finishTurn(turn) {
  if (activeTurn === turn) {
    activeTurn = null;
    face.state('idle');
    // hold the raised threshold until the speaker tail has faded, then relax
    setTimeout(() => { if (!activeTurn && !botAudible()) vad.setThreshold(VAD_THRESHOLD); }, ECHO_TAIL_MS);
  }
}

// ---- media + lifecycle --------------------------------------------------------

const vad = await createVad({
  threshold: VAD_THRESHOLD,
  silenceMs: VAD_SILENCE_MS,
  onSpeechStart,
  onSpeechEnd: (audio, meta) => { onSpeechEnd(audio, meta).catch((e) => console.error('[turn]', e)); },
});

let stopMic = () => {};
if (MIC_SOURCE === 'satellite') {
  face.onMic((chunk) => vad.feed(chunk));
  console.log('[local] mic source: satellite (waiting for it to connect to the face port)');
} else {
  stopMic = startMic((chunk) => vad.feed(chunk));
}
const stopCam = CAMERA_OFF
  ? () => {}
  : startCamera((jpeg) => { latestJpeg = jpeg; latestJpegAt = Date.now(); }, VIDEO_FPS);

face.state('idle');
face.servo(0); // head to center on startup
console.log(`[local] brain up — stt=${STT_URL} llm=${LLM_URL} (${LLM_MODEL}) tts=${TTS_URL} (${TTS_API}, ${TTS_VOICE_MODE}:${TTS_VOICE})`);
console.log('[local] talking. Try: "what do you see?" or "turn off the hall bathroom light".');

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[local] shutting down');
  abortTurn();
  vad.close();
  stopMic();
  stopCam();
  face.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
