// Serves face/index.html and pushes state to every connected face over WebSocket.
// Any browser on the LAN can be the face: laptop now, Pi kiosk or tablet later.
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

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(last)); // late joiners get the current state
  });

  server.listen(port, () => {
    console.log(`[face] open http://localhost:${port} (or this machine's LAN IP) in a browser`);
  });

  function broadcast(msg) {
    if (msg.type === 'state') last = msg;
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  return {
    state: (state) => broadcast({ type: 'state', state }),
    level: (level) => broadcast({ type: 'level', level }),
    caption: (role, text) => broadcast({ type: 'caption', role, text }),
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
