# big-cat-bot — Phase 1 bench

Desk webcam + mic → Gemini Live API → speaker, with one Home Assistant tool
(`toggle_light`). Proves the whole loop before any Pi hardware arrives.

## Prereqs

- Node 20+
- `ffmpeg` and `ffplay` on PATH (macOS: `brew install ffmpeg`, Ubuntu: `apt install ffmpeg`, Windows: gyan.dev build)
- A Gemini API key (aistudio.google.com/apikey)
- An HA long-lived access token — create a dedicated `robot` user first so its actions are auditable

## Run

```bash
npm install
cp .env.example .env     # fill in GEMINI_API_KEY, HA_URL, HA_TOKEN
npm run lights           # prints every light.* entity — confirms the token works
npm start
```

**The bot's voice plays through the face page.** Open http://localhost:8787,
click once (browsers require a gesture before they'll play audio), and leave it
open. Set `AUDIO_OUT=ffplay` in `.env` to use ffplay instead.

**Wear headphones.** There's no echo cancellation on the bench, so open speakers
make the model hear itself and interrupt its own turns. The ReSpeaker fixes this
in Phase 2.

## Layout

| file | role |
|---|---|
| `src/index.js` | Gemini brain: Live session, message loop, tool dispatch, resumption/reconnect |
| `src/index-local.js` | local brain: VAD → STT → vLLM → TTS against homelab services (`npm run local`) |
| `src/vad.js` | realtime Silero VAD (ONNX, in-process) over the mic stream |
| `src/local-util.js` | WAV encoding + streaming sentence splitter for the local brain |
| `src/check-local.js` | `npm run check-local` — one trivial request to each local service |
| `src/media.js` | ffmpeg mic + webcam capture, ffplay PCM playback |
| `src/ha.js` | HA REST client + tool declarations (Gemini and OpenAI formats) / `toolHandlers` |
| `src/face-server.js` | serves the face page, broadcasts state/level/captions over WebSocket |
| `src/face-demo.js` | `npm run face` — preview the face with fake states, no keys needed |
| `face/index.html` | the face itself; open in any browser on the LAN |

In Phase 2 the body moves off this machine along that seam: the ESP32 satellite
([`../satellite/`](../satellite/README.md)) replaces `media.js`'s mic and the
browser face with a mic + speaker + LCD + pan servo over the same face
WebSocket. Set `MIC_SOURCE=satellite` and `VIDEO_DEVICE=none` in `.env` and
either brain uses it unchanged; the model also gets a `move_head` tool.

## The face

`npm start` also serves the face at `http://<this machine>:8787`. Open it in a
browser (full-screen it with F11). States: idle (blinks, glances), listening
(aqua, leans in), thinking (squints, during a tool call), speaking (mouth follows
the audio), offline (dim). The bot's words appear as a caption while it speaks.

The face morphs between personas to match the topic — the model picks one with
the `set_face` tool: `pepper` (default friendly robot), `hal9000` (red camera
eye — space/AI), `terminator` (chrome skull — security/action), `r2d2`
(astromech dome — Star Wars/tinkering). Each persona maps the same states onto
its own anatomy (HAL's glow breathes, the skull's jaw talks, R2's lights flicker).

The voice follows the face: Leda for pepper, Charon for hal9000, Orus for
terminator, Puck for r2d2. The Live API fixes the voice per connection, so a
face switch quietly reconnects at the end of the turn — session resumption
carries the conversation across, and the face shows "thinking" for the ~1s gap.

Try `npm run face` first to see it cycle through states and faces without any keys.

Later this same page runs in Chromium kiosk mode on the Pi's display:
`chromium --kiosk --noerrdialogs http://brain.lan:8787`

## Local brain (Phase 1b)

`npm run local` runs the same bot fully locally: mic → Silero VAD (in-process)
→ faster-whisper (`speaches`) → vLLM (Qwen3.6 MoE) → Chatterbox-Turbo TTS →
face. The body (`media.js`), face, and HA tools are identical to the Gemini
brain; audio and images never leave the LAN.

**GPU-VM prerequisites:** the three services in [`../deploy/`](../deploy/README.md)
running on `gpu-vm` via `nerdctl compose` (that README has the full runbook:
nerdctl install, build/start order, verification curls, systemd unit, Caddy
snippets, voice-clip setup, VRAM budget). They run as plain containers so the
whole voice stack works with only that VM powered on — but if the k8s cluster
is up, scale its vLLM to 0 first (both would claim the GPU). The brain itself
is a plain Node process on this machine — no k8s dependency.

**Env vars** (see `.env.example`): `STT_URL`, `STT_MODEL`, `LLM_URL`,
`LLM_MODEL`, `TTS_URL`, `TTS_API`, `TTS_VOICE`, `TTS_VOICE_MODE`,
`TTS_EXAGGERATION`, `VAD_SILENCE_MS` (silence that ends a turn, default 400),
`VAD_THRESHOLD`, `HISTORY_TURNS`, plus the usual `AUDIO_DEVICE` /
`VIDEO_DEVICE` / `VIDEO_FPS` / `FACE_PORT` / `HA_URL` / `HA_TOKEN`.

**Run order:**

```bash
npm run check-local      # three [ ok ] lines = GPU-VM side is good
npm run local
```

Talking over the bot interrupts it (VAD speech-start aborts the in-flight LLM
stream and TTS, flushes the face audio). After every turn a latency line prints:
`[latency] vad=… stt=… llm_first_token=… tts_first_audio=… total=…`.

**Switching brains:** `npm start` = Gemini, `npm run local` = local. Same face,
same tools, same personas. The local brain speaks with your cloned voice
(`TTS_VOICE=<clip>.wav`, `TTS_VOICE_MODE=clone` — clips live in
`deploy/voices/`), and can give personas their own clips via
`TTS_VOICE_HAL9000=…` etc.

## Adding a tool (Phase 4)

Add a declaration to `toolDeclarations` and a matching entry in `toolHandlers`
in `src/ha.js`. Nothing else changes.

## Device selection

Defaults: macOS avfoundation index 0, Linux PulseAudio `default` + `/dev/video0`.
Windows needs explicit dshow names in `.env`. List devices with:

```
macOS:   ffmpeg -f avfoundation -list_devices true -i ""
Windows: ffmpeg -list_devices true -f dshow -i dummy
Linux:   pactl list short sources ; v4l2-ctl --list-devices
```
