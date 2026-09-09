// Mic in, webcam in, speaker out — all via ffmpeg/ffplay so the bench is
// portable and there are no native Node modules to build.
//
//   mic    -> 16 kHz mono s16le PCM chunks   (what the Live API wants)
//   camera -> JPEG frames at VIDEO_FPS       (max 1 fps per the API)
//   player <- 24 kHz mono s16le PCM          (what the Live API returns)
import { spawn } from 'node:child_process';
import os from 'node:os';
import net from 'node:net';

const platform = os.platform();
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || undefined;
const VIDEO_DEVICE = process.env.VIDEO_DEVICE || undefined;

function audioInputArgs() {
  switch (platform) {
    case 'darwin':
      return ['-f', 'avfoundation', '-i', `:${AUDIO_DEVICE ?? '0'}`];
    case 'win32':
      if (!AUDIO_DEVICE) throw new Error('Set AUDIO_DEVICE on Windows (dshow name)');
      return ['-f', 'dshow', '-i', `audio=${AUDIO_DEVICE}`];
    default:
      return ['-f', 'pulse', '-i', AUDIO_DEVICE ?? 'default'];
  }
}

function videoInputArgs() {
  switch (platform) {
    case 'darwin':
      return ['-f', 'avfoundation', '-framerate', '30', '-i', `${VIDEO_DEVICE ?? '0'}:none`];
    case 'win32':
      if (!VIDEO_DEVICE) throw new Error('Set VIDEO_DEVICE on Windows (dshow name)');
      return ['-f', 'dshow', '-i', `video=${VIDEO_DEVICE}`];
    default:
      return ['-f', 'v4l2', '-i', VIDEO_DEVICE ?? '/dev/video0'];
  }
}

function spawnFfmpeg(args, label) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  p.on('exit', (code) => console.log(`[${label}] exited (${code})`));
  return p;
}

/** Start the mic. Calls onChunk(Buffer) with raw 16 kHz PCM. Returns a stop(). */
export function startMic(onChunk) {
  const p = spawnFfmpeg(
    [...audioInputArgs(), '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    'mic',
  );
  p.stdout.on('data', onChunk);
  return () => p.kill('SIGTERM');
}

/** Start the webcam. Calls onFrame(Buffer) with a complete JPEG. Returns a stop(). */
export function startCamera(onFrame, fps = 1) {
  const p = spawnFfmpeg(
    [
      ...videoInputArgs(),
      '-vf', 'scale=640:-2',
      '-r', String(fps),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ],
    'cam',
  );

  // ffmpeg writes whole JPEGs, but pipe chunks can split them. Scan for SOI/EOI.
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { buf = Buffer.alloc(0); return; }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { buf = buf.subarray(start); return; }
      onFrame(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
    }
  });
  return () => p.kill('SIGTERM');
}

/** Plays 24 kHz mono PCM. flush() drops anything queued (used on interruption).
 *  Node listens on a local TCP port and ffplay connects to it — stdin pipes into
 *  ffplay are unreliable on Windows, TCP is not. */
export class Player {
  #server = null;
  #sock = null;
  #proc = null;
  #pending = [];      // chunks written before ffplay connected
  #bytes = 0;
  #port = Number(process.env.PLAYER_PORT ?? 24001);

  #start() {
    if (this.#server) return;
    this.#server = net.createServer((sock) => {
      this.#sock = sock;
      sock.on('error', () => {});
      for (const c of this.#pending) sock.write(c);
      this.#pending = [];
    });
    this.#server.on('error', (e) => console.error('[play] server error:', e.message));
    this.#server.listen(this.#port, '127.0.0.1', () => {
      this.#proc = spawn(
        'ffplay',
        ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit',
         '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
         '-f', 's16le', '-sample_rate', '24000', '-ch_layout', 'mono',
         '-i', `tcp://127.0.0.1:${this.#port}`],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      this.#proc.stderr.on('data', (d) => process.stderr.write(`[play] ${d}`));
      this.#proc.on('error', (e) => console.error('[play] cannot start ffplay:', e.message));
      this.#proc.on('exit', (code) => {
        if (code && code !== 0) console.log(`[play] ffplay exited (${code})`);
        this.#teardown();
      });
    });
  }

  #teardown() {
    this.#sock?.destroy();
    this.#server?.close();
    this.#proc?.kill('SIGKILL');
    this.#sock = null; this.#server = null; this.#proc = null;
    this.#pending = [];
    this.#bytes = 0;
  }

  write(pcm) {
    this.#start();
    this.#bytes += pcm.length;
    if (this.#bytes === pcm.length) console.log(`[play] first chunk ${pcm.length} bytes`);
    if (this.#sock) this.#sock.write(pcm);
    else this.#pending.push(pcm);
  }

  flush() { this.#teardown(); }

  close() { this.#teardown(); }
}
