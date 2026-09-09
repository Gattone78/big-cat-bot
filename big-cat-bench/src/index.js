// Phase 1 bench: desk webcam + mic -> Gemini Live -> speaker, with one HA tool.
//
//   npm install && cp .env.example .env   (fill in keys)
//   npm run lights                        (sanity-check HA + see entity ids)
//   npm start                             (wear headphones — see README)
import 'dotenv/config';
import { GoogleGenAI, Modality } from '@google/genai';
import { listLights, toolDeclarations, toolHandlers } from './ha.js';
import { startMic, startCamera, Player } from './media.js';
import { startFaceServer, pcmLevel } from './face-server.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-live-preview';
const VIDEO_FPS = Number(process.env.VIDEO_FPS ?? 1);

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY must be set in .env');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const AUDIO_OUT = process.env.AUDIO_OUT ?? 'face';   // 'face' (browser) or 'ffplay'
const player = AUDIO_OUT === 'ffplay' ? new Player() : null;
const face = startFaceServer();
if (AUDIO_OUT === 'face') console.log('[audio] playing through the face page — open it and click once to enable sound');
let botLine = '';          // accumulates output transcription for the caption
let lastLevelAt = 0;
let turnAudioBytes = 0, turnAudioChunks = 0;

let session = null;        // current live session
let ready = false;         // true once onopen fires
let resumeHandle = null;   // session-resumption token from the server
let shuttingDown = false;

// ---- session -----------------------------------------------------------------

async function buildConfig() {
  const lights = await listLights();
  console.log(`[ha] ${lights.length} lights known`);

  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction:
      'You are a compact, friendly home assistant robot on a desk. You can see ' +
      'through a webcam and hear through a mic. Keep spoken replies short. ' +
      'When asked to control a light, call toggle_light with the exact entity_id. ' +
      'If the request is ambiguous, ask which light. Known lights (entity_id, name, state):\n' +
      lights.map((l) => `- ${l.entity_id} | ${l.name} | ${l.state}`).join('\n'),
    tools: [{ functionDeclarations: toolDeclarations }],
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
        face.state('offline');
        console.log(`[live] closed: ${e?.reason || '(no reason)'}`);
        if (!shuttingDown) setTimeout(connect, 1000);
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
    }
  }

  if (msg.toolCall) {
    face.state('thinking');
    const functionResponses = [];
    for (const fc of msg.toolCall.functionCalls) {
      const handler = toolHandlers[fc.name];
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

const stopMic = startMic((chunk) => {
  if (!ready) return;
  session.sendRealtimeInput({
    audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
  });
});

const stopCam = startCamera((jpeg) => {
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
console.log('[bench] talking. Try: "what do you see?" or "turn off the hall bathroom light".');
