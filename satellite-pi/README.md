# big-cat-bot — Raspberry Pi satellite

The full-fat portable body: real camera, tablet-class screen, better audio —
one power cable. The display runs the **existing browser face** in Chromium
kiosk mode (it's just another WebSocket client, and it plays the voice), while
[`client.py`](client.py) is the rest of the body: mic upstream, camera frames
upstream, servo choreography. The brain doesn't distinguish this from the
ESP32 satellite — same protocol, same `.env` settings.

```
Chromium kiosk ──► face page ◄── state/face/captions/voice PCM ── brain
client.py ───────► 0x01+mic PCM, 0x02+JPEG ──────────────────────► brain
client.py ◄─────── servo messages ◄──────────────────────────────  brain
```

## Parts

| part | role | ~price |
|---|---|---|
| Raspberry Pi Zero 2 W (or Pi 4/5 for a smoother kiosk) | body | $15+ |
| Camera Module 3 (IMX708, autofocus) | eyes | $25 |
| Official 7″ touchscreen, or any HDMI display | the face | $60 |
| USB mic (or I2S mic HAT) | ears | $8 |
| MG996R/DS3218 servo + lazy-susan bearing | neck (see below) | $12 |
| 5 V ≥3 A supply | power | — |

Audio out comes from the display's speakers/HDMI or a small USB speaker —
Chromium plays the voice, so whatever the desktop's default sink is, works.

## Setup (Raspberry Pi OS Bookworm)

```bash
sudo apt install python3-websockets python3-picamera2 python3-gpiozero alsa-utils
git clone <this repo> ~/big-cat-bot
python3 ~/big-cat-bot/satellite-pi/client.py --brain <brain ip>
```

`client.py` degrades gracefully: no camera → audio-only, no servo wired →
skipped, so you can bring it up piece by piece. `--fake` sends a synthetic
mic tone from any machine (even the workstation) to test the protocol.

**Kiosk face** — autostart Chromium on the Pi's desktop (Bookworm/labwc:
`~/.config/labwc/autostart`, older X11: `~/.config/lxsession/LXDE-pi/autostart`):

```
chromium-browser --kiosk --noerrdialogs --autoplay-policy=no-user-gesture-required http://<brain ip>:8787 &
```

`--autoplay-policy=no-user-gesture-required` replaces the "click once to
enable audio" gesture the bench needs.

**Run at boot:** see [`satellite-pi.service`](satellite-pi.service).

## Point the brain at it

In `big-cat-bench/.env`:

```
MIC_SOURCE=satellite
VIDEO_SOURCE=satellite    # the Pi has a camera — "what do you see?" works
```

`npm run face` remains the keyless smoke test (servo sweep, states on the
kiosk, mic level meter in the console).

## Servo notes

Default pin BCM 18 (`--servo-pin`, `-1` to disable). Same choreography as the
ESP32 (idle wander, attentive snap, thinking tilt, speaking sway) layered on
the brain's `move_head` direction. Power the servo from its own 5 V rail,
common ground. If the servo is turning the whole display ("tablet head"), use
a standard-size metal-gear servo on a turntable bearing and slow it down
(`--servo-speed 60`). For jitter-free pulses install pigpio and run
`GPIOZERO_PIN_FACTORY=pigpio` (not needed on Pi 5, whose default backend is
already hardware-timed).

## Echo

Mic and speakers share a room with no AEC; the brain's echo guard covers
open-speaker use. If it self-triggers, raise `VAD_SPEAKING_THRESHOLD` or use
PulseAudio's `module-echo-cancel` on the Pi and select it as the default source.
