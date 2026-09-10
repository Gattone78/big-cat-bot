// Serves face/index.html and pushes state to every connected face over WebSocket.
// Any browser on the LAN can be the face: laptop now, Pi kiosk or tablet later.
//
// The ESP32 satellite (satellite/) speaks the same protocol as the browser face
// and adds two things: binary frames *from* the client are 16 kHz s16le mic
// audio (browsers never send binary), and a {type:'servo'} broadcast drives its
// pan servo. A satellite announces itself with {type:'hello'}.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

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
  let lastServo = null;
  let onMic = null; // (Buffer of 16 kHz s16le PCM) — set via the returned handle

  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify(last)); // late joiners get the current state
    if (lastFace) ws.send(JSON.stringify(lastFace)); // ...and the current face
    if (lastServo) ws.send(JSON.stringify(lastServo)); // ...and the head position
    ws.on('message', (data, isBinary) => {
      if (isBinary) { onMic?.(data); return; } // satellite mic audio
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'hello') {
          console.log(`[face] satellite connected: ${msg.device ?? 'unknown'} (${req.socket.remoteAddress})`);
        }
      } catch { /* not for us */ }
    });
  });

  server.listen(port, () => {
    console.log(`[face] open http://localhost:${port} (or this machine's LAN IP) in a browser`);
  });

  function broadcast(msg) {
    if (msg.type === 'state') last = msg;
    if (msg.type === 'face') lastFace = msg;
    if (msg.type === 'servo') lastServo = msg;
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
    /** Drop anything the page has queued (interruption). */
    flush: () => broadcast({ type: 'flush' }),
    /** Point the satellite's head. pos is -1 (full left) .. 0 (center) .. 1
     *  (full right); the firmware maps it onto its servo's travel. */
    servo: (pos) => broadcast({ type: 'servo', pos: Math.max(-1, Math.min(1, pos)) }),
    /** Receive mic audio (16 kHz s16le PCM Buffers) from a connected satellite. */
    onMic: (cb) => { onMic = cb; },
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
