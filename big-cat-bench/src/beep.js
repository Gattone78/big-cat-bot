// Tests only the Node -> ffplay playback leg: 2 seconds of 440 Hz at 24 kHz.
//   npm run beep
import { Player } from './media.js';

const player = new Player();
const rate = 24000, secs = 2;
const buf = Buffer.alloc(rate * secs * 2);
for (let i = 0; i < rate * secs; i++) {
  buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
}
// send in 100 ms chunks like the API does
for (let off = 0; off < buf.length; off += 4800) player.write(buf.subarray(off, off + 4800));
setTimeout(() => { player.close(); process.exit(0); }, (secs + 1) * 1000);
