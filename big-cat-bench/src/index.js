// Phase 1 bench: desk webcam + mic -> Gemini Live -> speaker, with one HA tool.
//
//   npm install && cp .env.example .env   (fill in keys)
//   npm run lights                        (sanity-check HA + see entity ids)
//   npm start                             (wear headphones — see README)
import 'dotenv/config';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { listLights, toolDeclarations, toolHandlers } from './ha.js';
import { startMic, startCamera, Player } from './media.js';
import { startFaceServer, pcmLevel } from './face-server.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-live-preview';
const VIDEO_FPS = Number(process.env.VIDEO_FPS ?? 1);
// 'ffmpeg' = mic on this machine (the bench); 'satellite' = 16 kHz PCM pushed
// over the face WebSocket by the ESP32 satellite (see satellite/README.md).
const MIC_SOURCE = process.env.MIC_SOURCE ?? 'ffmpeg';
// The satellite has no camera; VIDEO_DEVICE=none runs the brain vision-free.
const CAMERA_OFF = (process.env.VIDEO_DEVICE ?? '').toLowerCase() === 'none';

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY must be set in .env');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const AUDIO_OUT = process.env.AUDIO_OUT ?? 'face';   // 'face' (browser) or 'ffplay'
const player = AUDIO_OUT === 'ffplay' ? new Player() : null;
const face = startFaceServer();
if (AUDIO_OUT === 'face') console.log('[audio] playing through the face page — open it and click once to enable sound');
let botLine = '';          // accumulates output transcription for the caption
let lastLevelAt = 0;
let turnAudioBytes = 0, turnAudioChunks = 0;

// ---- face persona tool -------------------------------------------------------
// The model picks the face to match the topic; the page morphs between them.

const FACES = ['pepper', 'hal9000', 'terminator', 'r2d2'];
// Voice is fixed per connection in the Live API, so a face switch that changes
// voice schedules a reconnect at the end of the turn; session resumption keeps
// the conversation context across it.
const FACE_VOICES = {
  pepper: 'Leda',        // youthful, friendly
  hal9000: 'Charon',     // calm, even, informative
  terminator: 'Orus',    // firm, heavy
  r2d2: 'Puck',          // upbeat, playful
};
let currentFace = 'pepper';
let voiceReconnectPending = false;
const faceToolDeclarations = [
  {
    name: 'set_face',
    description:
      'Morph the on-screen robot face to fit the current topic or mood. ' +
      'pepper: the default friendly robot face — everyday chat and home control. ' +
      'hal9000: calm red camera eye — space, AI, computers, deadpan moments. ' +
      'terminator: chrome skull — security, alarms, threats, action movies. ' +
      'r2d2: astromech dome — Star Wars, gadgets, tinkering, playful moods. ' +
      'Switch when the topic clearly shifts and return to pepper afterwards.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        face: {
          type: Type.STRING,
          format: 'enum',
          enum: FACES,
          description: 'Which face to show.',
        },
      },
      required: ['face'],
    },
  },
  {
    name: 'move_head',
    description:
      'Turn your head (a pan servo on the satellite body) to face a direction. ' +
      'Use it when asked to look somewhere, to face the person talking to you, ' +
      'or for emphasis. Return to center when done.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          format: 'enum',
          enum: ['left', 'slightly-left', 'center', 'slightly-right', 'right'],
          description: 'Where to turn, from your point of view.',
        },
      },
      required: ['direction'],
    },
  },
];
const HEAD_POSITIONS = { left: -1, 'slightly-left': -0.5, center: 0, 'slightly-right': 0.5, right: 1 };
const faceToolHandlers = {
  set_face: ({ face: name }) => {
    if (!FACES.includes(name)) return { error: `unknown face: ${name}` };
    face.setFace(name);
    if (FACE_VOICES[name] !== FACE_VOICES[currentFace]) voiceReconnectPending = true;
    currentFace = name;
    return { face: name, voice: FACE_VOICES[name] };
  },
  move_head: ({ direction }) => {
    const pos = HEAD_POSITIONS[direction];
    if (pos === undefined) return { error: `unknown direction: ${direction}` };
    face.servo(pos);
    return { direction };
  },
};

let session = null;        // current live session
let ready = false;         // true once onopen fires
let resumeHandle = null;   // session-resumption token from the server
let shuttingDown = false;
let voiceSwitchClose = false; // this close is our own voice switch, not a failure

// ---- session -----------------------------------------------------------------

async function buildConfig() {
  const lights = await listLights();
  console.log(`[ha] ${lights.length} lights known`);

  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: FACE_VOICES[currentFace] } },
    },
    systemInstruction:
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
      'announce the face change; just do it. Known lights (entity_id, name, state):\n' +
      lights.map((l) => `- ${l.entity_id} | ${l.name} | ${l.state}`).join('\n'),
    tools: [{ functionDeclarations: [...toolDeclarations, ...faceToolDeclarations] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Ask the server for a resumable handle; pass it back on reconnect.
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    contextWindowCompression: { slidingWindow: {} },
  };
}

async function connect() {
  const config = await buildConfig();
  session = await ai.live.connect({
    model: MODEL,
    config,
    callbacks: {
      onopen: () => {
        ready = true;
        face.state('idle');
        console.log(`[live] connected (${MODEL})${resumeHandle ? ' [resumed]' : ''}`);
      },
      onmessage: handleMessage,
      onerror: (e) => console.error('[live] error:', e.message),
      onclose: (e) => {
        ready = false;
        face.state(voiceSwitchClose ? 'thinking' : 'offline');
        console.log(`[live] closed: ${e?.reason || '(no reason)'}`);
        if (!shuttingDown) setTimeout(connect, voiceSwitchClose ? 250 : 1000);
        voiceSwitchClose = false;
      },
    },
  });
}

async function handleMessage(msg) {
  // Keep the newest resumable handle so reconnects pick up where we left off.
  const sru = msg.sessionResumptionUpdate;
  if (sru?.resumable && sru.newHandle) resumeHandle = sru.newHandle;

  // Server is about to drop the connection; onclose will reconnect with the handle.
  if (msg.goAway) console.log(`[live] goAway in ${msg.goAway.timeLeft ?? '?'}`);

  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) {
      player?.flush();
      face.flush();
      face.state('listening');
      process.stdout.write('\n[you interrupted]\n');
    }
    if (sc.inputTranscription?.text) {
      face.state('listening');
      process.stdout.write(`\nYou: ${sc.inputTranscription.text}`);
    }
    if (sc.outputTranscription?.text) {
      botLine += sc.outputTranscription.text;
      face.caption('bot', botLine);
      process.stdout.write(`\nBot: ${sc.outputTranscription.text}`);
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        const pcm = Buffer.from(part.inlineData.data, 'base64');
        face.state('speaking');
        const now = Date.now();
        if (now - lastLevelAt > 50) { face.level(pcmLevel(pcm)); lastLevelAt = now; }
        turnAudioBytes += pcm.length; turnAudioChunks++;
        if (player) player.write(pcm); else face.audio(pcm);
      }
    }
    if (sc.turnComplete) {
      console.log(`\n[audio] turn: ${turnAudioChunks} chunks, ${turnAudioBytes} bytes, ${(turnAudioBytes / 48000).toFixed(1)}s, ${face.clients()} face(s) connected`);
      turnAudioBytes = 0; turnAudioChunks = 0;
      botLine = '';
      face.state('idle');
      process.stdout.write('\n');
      // A face switch changed the voice: cycle the connection now that the turn
      // is over. Resumption restores the conversation; buildConfig picks the voice.
      if (voiceReconnectPending) {
        voiceReconnectPending = false;
        voiceSwitchClose = true;
        console.log(`[live] switching voice -> ${FACE_VOICES[currentFace]} (reconnecting)`);
        try { session.close(); } catch { /* onclose reconnects either way */ }
      }
    }
  }

  if (msg.toolCall) {
    face.state('thinking');
    const functionResponses = [];
    for (const fc of msg.toolCall.functionCalls) {
      const handler = toolHandlers[fc.name] ?? faceToolHandlers[fc.name];
      let response;
      try {
        response = handler ? await handler(fc.args ?? {}) : { error: `unknown tool ${fc.name}` };
      } catch (err) {
        response = { error: String(err.message ?? err) };
      }
      console.log(`[tool] ${fc.name}(${JSON.stringify(fc.args)}) ->`, response);
      functionResponses.push({ name: fc.name, id: fc.id, response });
    }
    session.sendToolResponse({ functionResponses });
  }
}

// ---- media -------------------------------------------------------------------

const onMicChunk = (chunk) => {
  if (!ready) return;
  session.sendRealtimeInput({
    audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
  });
};
let stopMic = () => {};
if (MIC_SOURCE === 'satellite') {
  face.onMic(onMicChunk);
  console.log('[audio] mic source: satellite (waiting for it to connect to the face port)');
} else {
  stopMic = startMic(onMicChunk);
}

const stopCam = CAMERA_OFF ? () => {} : startCamera((jpeg) => {
  if (!ready) return;
  session.sendRealtimeInput({
    video: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
  });
}, VIDEO_FPS);

// ---- lifecycle ---------------------------------------------------------------

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[bench] shutting down');
  stopMic();
  stopCam();
  player?.close();
  face.close();
  try { session?.close(); } catch { /* already closed */ }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await connect();
face.servo(0); // head to center on startup
console.log('[bench] talking. Try: "what do you see?" or "turn off the hall bathroom light".');
