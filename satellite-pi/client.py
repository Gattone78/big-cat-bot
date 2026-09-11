#!/usr/bin/env python3
"""big-cat-bot Pi satellite: mic, camera, servo (and optionally speaker) over
the face WebSocket. The face itself runs in Chromium kiosk mode on the Pi's
display, as its own WebSocket client — this script is the rest of the body.

Protocol (client view):
  send  binary  0x01 + 16 kHz s16le mono mic PCM (512-sample frames)
                0x02 + one JPEG camera frame
  send  {"type":"hello"} once on connect
  recv  binary  24 kHz s16le mono voice PCM (only played with --speaker;
                normally the kiosk browser plays it)
  recv  {"type":"state"|"servo"|"flush"|...}

Everything degrades gracefully: no camera -> audio-only, no gpiozero -> no
servo, --fake -> synthetic mic tone for protocol testing on any machine.
"""
import argparse
import asyncio
import io
import json
import math
import signal
import sys
import time

import websockets

MIC_RATE = 16000
FRAME_SAMPLES = 512          # 32 ms, matches the brain's VAD frame
FRAME_BYTES = FRAME_SAMPLES * 2
SPK_RATE = 24000
TYPE_MIC = b"\x01"
TYPE_JPEG = b"\x02"


def log(tag, msg):
    print(f"[{tag}] {msg}", flush=True)


# ---- servo: same choreography as the ESP32 firmware ---------------------------
# The brain sets a base direction (pos -1..1); the state layers motion on top.

class ServoHead:
    def __init__(self, pin, left_deg, right_deg, speed_dps):
        self.left_deg, self.right_deg, self.speed_dps = left_deg, right_deg, speed_dps
        self.base = 0.0
        self.mode = "offline"
        self.current = self._pos_to_deg(0)
        self.servo = None
        if pin < 0:
            return
        try:
            from gpiozero import AngularServo
            lo, hi = min(left_deg, right_deg), max(left_deg, right_deg)
            self.servo = AngularServo(pin, min_angle=lo, max_angle=hi,
                                      min_pulse_width=0.0005, max_pulse_width=0.0024)
            log("servo", f"gpio {pin}, {left_deg}..{right_deg} deg")
        except Exception as e:  # not a Pi, or gpiozero missing
            log("servo", f"disabled ({e})")

    def _pos_to_deg(self, pos):
        center = (self.left_deg + self.right_deg) / 2
        half = (self.left_deg - self.right_deg) / 2
        return center - pos * half  # pos +1 (bot's right) -> right_deg

    async def run(self):
        last = time.monotonic()
        while True:
            await asyncio.sleep(0.02)  # 50 Hz
            now = time.monotonic()
            dt, last = min(now - last, 0.1), now
            t = now
            offset = {
                "idle": 12 * math.sin(t / 9 * 2 * math.pi),      # slow wander
                "listening": 0.0,                                 # attentive
                "thinking": -8.0,                                 # pondering tilt
                "speaking": 6 * math.sin(t / 0.7 * 2 * math.pi),  # sway
            }.get(self.mode, 0.0)
            target = self._pos_to_deg(self.base) + offset
            step = self.speed_dps * dt
            self.current += max(-step, min(step, target - self.current))
            if self.servo:
                lo, hi = min(self.left_deg, self.right_deg), max(self.left_deg, self.right_deg)
                self.servo.angle = max(lo, min(hi, self.current))


# ---- speaker (optional; the kiosk browser normally plays the voice) -----------

class Speaker:
    """aplay with kill-on-flush, mirroring the bench's ffplay Player."""

    def __init__(self, device):
        self.device = device
        self.proc = None

    async def write(self, pcm):
        if self.proc is None:
            cmd = ["aplay", "-q", "-f", "S16_LE", "-r", str(SPK_RATE), "-c", "1", "-t", "raw"]
            if self.device:
                cmd += ["-D", self.device]
            self.proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE)
        try:
            self.proc.stdin.write(pcm)
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            self.proc = None

    def flush(self):
        if self.proc:
            self.proc.kill()
            self.proc = None


# ---- mic ----------------------------------------------------------------------

async def mic_frames(device, fake):
    """Yield 0x01-prefixed 32 ms mic frames forever."""
    if fake:
        t = 0
        while True:
            samples = bytearray()
            for _ in range(FRAME_SAMPLES):
                samples += int(6000 * math.sin(2 * math.pi * 440 * t / MIC_RATE)).to_bytes(
                    2, "little", signed=True)
                t += 1
            yield TYPE_MIC + bytes(samples)
            await asyncio.sleep(FRAME_SAMPLES / MIC_RATE)
    else:
        cmd = ["arecord", "-q", "-f", "S16_LE", "-r", str(MIC_RATE), "-c", "1", "-t", "raw"]
        if device:
            cmd += ["-D", device]
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE)
        log("mic", "arecord running")
        try:
            while True:
                data = await proc.stdout.readexactly(FRAME_BYTES)
                yield TYPE_MIC + data
        finally:
            proc.kill()


# ---- camera -------------------------------------------------------------------

def open_camera(width, height):
    try:
        from picamera2 import Picamera2
        cam = Picamera2()
        cam.configure(cam.create_still_configuration(main={"size": (width, height)}))
        cam.start()
        log("cam", f"picamera2 {width}x{height}")
        return cam
    except Exception as e:
        log("cam", f"disabled ({e})")
        return None


async def camera_task(ws, fps, width, height):
    cam = await asyncio.to_thread(open_camera, width, height)
    if cam is None:
        return
    while True:
        buf = io.BytesIO()
        await asyncio.to_thread(cam.capture_file, buf, format="jpeg")
        await ws.send(TYPE_JPEG + buf.getvalue())
        await asyncio.sleep(1 / fps)


# ---- main loop ----------------------------------------------------------------

async def session(args, head):
    url = f"ws://{args.brain}:{args.port}/"
    async with websockets.connect(url, max_size=None) as ws:
        log("ws", f"connected to {url}")
        await ws.send(json.dumps({"type": "hello", "device": "pi-satellite"}))
        speaker = Speaker(args.speaker_device) if args.speaker else None

        async def uplink():
            async for frame in mic_frames(args.mic_device, args.fake):
                await ws.send(frame)

        async def downlink():
            async for msg in ws:
                if isinstance(msg, bytes):
                    if speaker:
                        await speaker.write(msg)
                    continue
                m = json.loads(msg)
                t = m.get("type")
                if t == "state":
                    head.mode = m.get("state", "idle")
                    log("state", head.mode)
                elif t == "servo":
                    head.base = max(-1.0, min(1.0, float(m.get("pos", 0))))
                    log("servo", f"pos {head.base:+.2f}")
                elif t == "flush":
                    if speaker:
                        speaker.flush()

        tasks = [asyncio.create_task(uplink()), asyncio.create_task(downlink())]
        if not args.fake and not args.no_camera:
            tasks.append(asyncio.create_task(camera_task(ws, args.fps, args.cam_width, args.cam_height)))
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for d in done:
                if d.exception():
                    raise d.exception()
        finally:
            for task in tasks:
                task.cancel()
            if speaker:
                speaker.flush()


async def main():
    p = argparse.ArgumentParser(description="big-cat-bot Pi satellite body")
    p.add_argument("--brain", required=True, help="host/IP running npm start / npm run local")
    p.add_argument("--port", type=int, default=8787, help="FACE_PORT (default 8787)")
    p.add_argument("--mic-device", default=None, help="ALSA capture device (default: system default)")
    p.add_argument("--speaker", action="store_true",
                   help="play the voice via aplay (headless build; normally the kiosk browser plays it)")
    p.add_argument("--speaker-device", default=None, help="ALSA playback device")
    p.add_argument("--servo-pin", type=int, default=18, help="BCM pin, -1 to disable (default 18)")
    p.add_argument("--servo-left", type=float, default=150)
    p.add_argument("--servo-right", type=float, default=30)
    p.add_argument("--servo-speed", type=float, default=120, help="max deg/s")
    p.add_argument("--fps", type=float, default=1, help="camera frames per second")
    p.add_argument("--cam-width", type=int, default=640)
    p.add_argument("--cam-height", type=int, default=480)
    p.add_argument("--no-camera", action="store_true")
    p.add_argument("--fake", action="store_true",
                   help="synthetic mic tone, no camera — protocol test on any machine")
    args = p.parse_args()

    head = ServoHead(args.servo_pin if not args.fake else -1,
                     args.servo_left, args.servo_right, args.servo_speed)
    asyncio.ensure_future(head.run())

    while True:  # reconnect forever; power-cycle either side freely
        try:
            await session(args, head)
        except (OSError, websockets.WebSocketException) as e:
            log("ws", f"disconnected ({e}); retrying in 2s")
        await asyncio.sleep(2)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
