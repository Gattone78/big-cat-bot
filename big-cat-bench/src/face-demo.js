// Preview the face without Gemini or HA: cycles through states with fake audio levels.
//   npm run face   -> open http://localhost:8787
import { startFaceServer } from './face-server.js';

const face = startFaceServer();
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
  if (state === 'speaking') {
    face.caption('bot', 'The kitchen light is off now.');
    const t = setInterval(() => face.level(Math.abs(Math.sin(Date.now() / 90)) * 0.7), 60);
    setTimeout(() => clearInterval(t), ms);
  }
  setTimeout(step, ms);
})();
