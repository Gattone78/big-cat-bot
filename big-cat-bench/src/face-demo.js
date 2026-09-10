// Preview the face without Gemini or HA: cycles through states with fake audio
// levels. Also a satellite smoke test: sweeps the servo and reports mic audio.
//   npm run face   -> open http://localhost:8787 (or point the satellite here)
import { startFaceServer, pcmLevel } from './face-server.js';

const face = startFaceServer();

// If a satellite is connected, prove its mic path works: log a level meter
// once a second so you can see it react when you speak.
let micBytes = 0, micLevel = 0;
face.onMic((chunk) => { micBytes += chunk.length; micLevel = Math.max(micLevel, pcmLevel(chunk)); });
setInterval(() => {
  if (!micBytes) return;
  console.log(`[mic] ${micBytes} B/s  level ${'#'.repeat(Math.round(micLevel * 20)).padEnd(20, '.')}`);
  micBytes = 0; micLevel = 0;
}, 1000);

// Sweep the head: center -> left -> center -> right, one move per state change.
const servoScript = [0, -1, 0, 1];
let servoI = 0;
const script = [
  ['idle', 4000], ['listening', 2500], ['thinking', 1500],
  ['speaking', 4000], ['idle', 3000],
];
const faces = ['pepper', 'hal9000', 'terminator', 'r2d2'];

let i = 0;
(function step() {
  if (i % script.length === 0) face.setFace(faces[(i / script.length) % faces.length]);
  const [state, ms] = script[i++ % script.length];
  face.state(state);
  face.servo(servoScript[servoI++ % servoScript.length]);
  if (state === 'speaking') {
    face.caption('bot', 'The kitchen light is off now.');
    const t = setInterval(() => face.level(Math.abs(Math.sin(Date.now() / 90)) * 0.7), 60);
    setTimeout(() => clearInterval(t), ms);
  }
  setTimeout(step, ms);
})();
