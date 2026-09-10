# big-cat-bot — ESP32 satellite

The body, portable: an ESP32-S3 with a mic, speaker, round-the-house-able LCD
face, and a pan servo. It speaks the same WebSocket protocol as the browser
face, so the brain doesn't care which one is connected — the satellite just
also streams its mic upstream and gets `servo` messages.

```
mic (I2S) ──► WebSocket ──► brain (npm run local / npm start, on the LAN)
LCD face ◄── state/face/captions/servo ◄──┘
speaker ◄──── 24 kHz voice PCM ◄──────────┘
```

All processing stays on the brain: the satellite is a dumb, cheap terminal.
Latency budget is unchanged (the Wi-Fi hop adds ~10-20 ms each way).

## Parts (~$25 + the servo bracket)

| part | role | ~price |
|---|---|---|
| ESP32-S3-DevKitC-1 (N8R2 or better) | the body's brain stem | $8 |
| INMP441 | I2S MEMS mic | $3 |
| MAX98357A breakout | I2S amp, 3 W | $4 |
| 4 Ω 3 W speaker (~40 mm) | voice | $3 |
| ST7789 240×240 SPI LCD (1.3–1.54″) | the face | $5 |
| SG90 / MG90S servo | head pan | $3 |
| 5 V ≥2 A USB supply | power | — |

Or an **ESP32-S3-BOX-3** (~$50) replaces the first five rows with one boxed
unit (better mic + AEC-capable, though this firmware doesn't use ESP-SR);
you'd only re-pin `config.h` for its LCD/codec and add the servo.

## Wiring (defaults in `src/config.h` — rewire freely, it's all there)

| device | pin | GPIO |
|---|---|---|
| LCD ST7789 | SCK / MOSI / DC / CS / RST / BLK | 12 / 11 / 9 / 10 / 13 / 14 |
| mic INMP441 | BCLK / WS / SD, **L/R→GND** | 4 / 5 / 6 |
| amp MAX98357A | BCLK / LRC / DIN, **SD unconnected** | 15 / 16 / 7 |
| servo | signal (5 V supply, common GND) | 8 |

Notes:
- No-CS LCD modules: set `LCD_CS -1` (switches to SPI mode 3 automatically).
- Power the servo from 5 V (VIN/USB rail), not 3V3; share ground. An SG90
  stall can brown out a weak USB port — use a 2 A supply.
- Mic and speaker want physical separation (opposite sides of the enclosure);
  there's no AEC, the brain's echo guard does the rest.

## Build & flash

```bash
pip install platformio          # once
cd satellite
cp src/secrets.example.h src/secrets.h   # fill in Wi-Fi + the brain's IP:port
pio run -t upload               # or: python -m platformio run -t upload
pio device monitor              # watch it join Wi-Fi and connect
```

## Point the brain at it

In `big-cat-bench/.env`:

```
MIC_SOURCE=satellite     # mic comes from the satellite, not ffmpeg
VIDEO_DEVICE=none        # no camera on the satellite
```

then `npm run local` (or `npm start`) as usual. The satellite shows
"connecting…" until the brain is up, and reconnects on its own — power-cycle
either side freely.

**Hardware smoke test without any keys:** `npm run face` now also sweeps the
servo, cycles states/personas on the LCD, and prints a level meter from the
satellite's mic — if all three work, the whole loop will.

## What runs where

| satellite (`src/`) | role |
|---|---|
| `main.cpp` | Wi-Fi, WebSocket client, message dispatch, render/servo cadence |
| `audio_in.cpp` | I2S mic task → 512-sample frames → queue → WebSocket |
| `audio_out.cpp` | ring buffer → I2S amp; flush on barge-in; mouth level |
| `face_render.cpp` | the four personas redrawn at 240×240 (LovyanGFX sprite) |
| `servo_head.cpp` | eased pan: brain direction + per-state choreography |
| `config.h` | every pin and tuning knob |

The brain's `move_head` tool lets the model look around (`servo` messages,
pos −1…1); the firmware layers idle wander / attentive snap / speaking sway
on top of that base direction.
