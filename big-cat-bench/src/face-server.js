// Serves face/index.html and pushes state to every connected face over WebSocket.
// Any browser on the LAN can be the face: laptop now, Pi kiosk or tablet later.
//
// The same socket can also carry the mic UPLINK (MIC_SOURCE=face): the page
// captures its own mic with the browser's echo cancellation — which removes
// the bot's voice because the same browser is playing it — and sends raw PCM
// back as binary frames. That's what makes open speakers work without
// headphones: speaker and mic live in one process, so the AEC sees both.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { resamplePcm16 } from './local-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACE_HTML = path.join(__dirname, '..', 'face', 'index.html');

export function startFaceServer(port = Number(process.env.FACE_PORT ?? 8787)) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(FACE_HTML));
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ server });
  let last = { type: 'state', state: 'idle' };
  let lastFace = null;
  let micCb = null;      // set via mic(); null = nobody consuming mic audio
  let micWs = null;      // the one page whose mic we listen to
  let micRate = 16000;   // sample rate that page captures at

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(last)); // late joiners get the current state
    if (lastFace) ws.send(JSON.stringify(lastFace)); // ...and the current face
    ws.send(JSON.stringify({ type: 'mic', enabled: !!micCb }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // mic PCM from the page; only the claiming page is the mic
        if (micCb && ws === micWs) micCb(resamplePcm16(data, micRate, 16000));
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'mic-start') {
        // last page to (re)announce wins — there's normally exactly one face
        if (micWs && micWs !== ws) console.log('[face] mic moved to a newer page');
        micWs = ws;
        micRate = Number(msg.rate) || 16000;
        console.log(`[face] mic uplink from page at ${micRate} Hz (browser AEC)`);
      }
    });
    ws.on('close', () => { if (ws === micWs) micWs = null; });
  });

  server.listen(port, () => {
    console.log(`[face] open http://localhost:${port} (or this machine's LAN IP) in a browser`);
  });

  function broadcast(msg) {
    if (msg.type === 'state') last = msg;
    if (msg.type === 'face') lastFace = msg;
    send(JSON.stringify(msg));
  }
  function send(data) {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  return {
    state: (state) => broadcast({ type: 'state', state }),
    level: (level) => broadcast({ type: 'level', level }),
    caption: (role, text) => broadcast({ type: 'caption', role, text }),
    /** 'pepper' (default) | 'hal9000' | 'terminator' | 'r2d2' */
    setFace: (name) => broadcast({ type: 'face', face: name }),
    /** Raw 24 kHz s16le PCM; sent as a binary frame, played by the page. */
    audio: (pcm) => send(pcm),
    /** Use the face page as the microphone (MIC_SOURCE=face). onChunk gets
     *  16 kHz s16le PCM Buffers, echo-cancelled by the browser. Returns stop(). */
    mic: (onChunk) => {
      micCb = onChunk;
      broadcast({ type: 'mic', enabled: true });
      return () => { micCb = null; broadcast({ type: 'mic', enabled: false }); };
    },
    /** Drop anything the page has queued (interruption). */
    flush: () => broadcast({ type: 'flush' }),
    clients: () => wss.clients.size,
    close: () => { wss.close(); server.close(); },
  };
}

/** RMS loudness of a 16-bit PCM buffer, 0..1, lightly boosted for expressiveness. */
export function pcmLevel(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / n) * 4);
}
