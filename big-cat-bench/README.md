# housebot — Phase 1 bench

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
| `src/index.js` | Live session, message loop, tool dispatch, resumption/reconnect |
| `src/media.js` | ffmpeg mic + webcam capture, ffplay PCM playback |
| `src/ha.js` | HA REST client + `toolDeclarations` / `toolHandlers` |
| `src/face-server.js` | serves the face page, broadcasts state/level/captions over WebSocket |
| `src/face-demo.js` | `npm run face` — preview the face with fake states, no keys needed |
| `face/index.html` | the face itself; open in any browser on the LAN |

In Phase 2 `media.js` moves to the Pi ("body") and `index.js` + `ha.js` stay on
the Proxmox VM ("brain"); the split is already along that seam.

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
