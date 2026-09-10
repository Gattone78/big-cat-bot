# big-cat-bot — Local Brain (Phase 1b) Requirements

## Context

`big-cat-bench/` is a working Node 20 (ESM) project that runs a realtime voice+vision
assistant against the Gemini Live API. Read it first. Relevant files:

- `src/index.js` — Gemini Live session loop. **Being replaced**, keep as-is for A/B.
- `src/media.js` — ffmpeg mic capture (16 kHz s16le PCM chunks), webcam capture
  (JPEG frames at `VIDEO_FPS`), optional ffplay Player. **Reuse unchanged.**
- `src/face-server.js` — serves `face/index.html`, broadcasts JSON state/level/caption
  and binary 24 kHz s16le PCM audio over WebSocket; `flush()` for barge-in. **Reuse unchanged.**
- `src/ha.js` — Home Assistant REST client, `toolDeclarations` (Gemini schema),
  `toolHandlers`. **Reuse; add an OpenAI-format export.**
- `face/index.html` — the face; plays incoming PCM via Web Audio. **Reuse unchanged.**

The API round-trip is too slow. Goal: replace Gemini with a fully local pipeline on
my homelab GPU node, keeping the body (mic/camera/face) and the HA tools identical.

## Target infrastructure (do not redesign)

- Proxmox host on my LAN. The GPU (NVIDIA RTX PRO 6000 Blackwell, 96 GB) is PCIe-passed
  through to one VM, `gpu-vm` (Ubuntu 24.04). Host NVIDIA driver + NVIDIA Container
  Toolkit + containerd are already installed there because it's also a Kubernetes worker.
- **Requirement: the voice stack must run with only `gpu-vm` powered on.** The rest of
  the cluster (control plane, other worker) may be off. Therefore the services run as
  plain containers on that VM via **`nerdctl compose`** (containerd-native), NOT as
  Kubernetes workloads. Do not install Docker CE — its containerd package would replace
  the one kubelet depends on.
- The existing Kubernetes vLLM deployment (namespace `ai`) is not touched, but the README
  must state that it has to be scaled to 0 whenever the cluster is up and this stack is
  running, since both would claim the GPU.
- Caddy (LXC outside k8s) + UniFi DNS provide hostnames; make all base URLs configurable.
- The brain runs on my Windows workstation for now; keep it a plain Node process.

## Deliverables

### 1. Container stack — `deploy/` directory

- `deploy/compose.yaml` — three services, all with `gpus: all` (or the nerdctl equivalent),
  `restart: unless-stopped`, healthchecks, named volumes for model caches so nothing is
  re-downloaded on restart, and `127.0.0.1`-free bindings (services must be reachable
  from the LAN). Ports: vLLM 8000, STT 8001, TTS 8002.
  - `vllm` — image `vllm/vllm-openai:cu130-nightly` (required for Blackwell).
    Model **`Qwen/Qwen3.6-35B-A3B-FP8`** (natively multimodal MoE, 3B active). Args:
    ```
    --model Qwen/Qwen3.6-35B-A3B-FP8
    --max-model-len 16384
    --gpu-memory-utilization 0.6
    --reasoning-parser qwen3
    --default-chat-template-kwargs '{"enable_thinking": false}'
    --enable-auto-tool-choice --tool-call-parser qwen3_coder
    --limit-mm-per-prompt.video 0
    --speculative-config '{"method": "mtp", "num_speculative_tokens": 1}'
    ```
    No prefix caching (experimental for this architecture). If the tool-call parser name
    is rejected by that vLLM build, use the Qwen3 parser listed in `vllm serve --help`.
    Fallback model: `Qwen/Qwen3-VL-30B-A3B-Instruct-FP8` with `--tool-call-parser hermes`
    and no reasoning flags. `HF_TOKEN` from `deploy/.env` (never committed).
    Reuse the existing Hugging Face cache directory on the VM if one exists outside k8s;
    otherwise a named volume.
  - `stt` — `speaches` (faster-whisper server, OpenAI-compatible
    `/v1/audio/transcriptions`), model `Systran/faster-whisper-large-v3-turbo` (or current
    turbo id), CUDA. ~2 GB VRAM.
  - `tts` — **Chatterbox-Turbo** via `devnen/Chatterbox-TTS-Server` (OpenAI-compatible
    `/v1/audio/speech`, voice cloning). If no published image, add `deploy/tts.Dockerfile`
    built from the repo's NVIDIA Dockerfile and document the build. Bind-mount
    `deploy/voices/` for reference clips. Expose `TTS_VOICE` and `TTS_EXAGGERATION`
    (default 0.5) in the brain's `.env`. Verify whether the server streams; per-sentence
    requests are acceptable if not. ~4–6 GB VRAM.
  - `tts-kokoro` — optional fallback (`kokoro-fastapi` GPU image), behind a compose
    profile so it isn't started by default.
- `deploy/big-cat-stack.service` — systemd unit that runs `nerdctl compose up -d` from
  `deploy/` on boot and `down` on stop.
- `deploy/README.md` — install steps, start/stop, verification curls, expected VRAM per
  service, the "scale k8s vLLM to 0" warning, and rollback (just `nerdctl compose down`;
  nothing on the node is modified beyond nerdctl itself).

### 2. Local brain — `src/index-local.js`

`npm run local` starts it. Same UX as `npm start`: face at `:8787`, terminal transcript,
`toggle_light` works, Ctrl-C clean shutdown.

Pipeline:

1. **Mic → VAD.** Silero VAD in-process (`@ricky0123/vad-node` or equivalent ONNX
   runtime approach). Configurable `VAD_SILENCE_MS` (default 400) and threshold.
   Emit `speech_start` / `speech_end` with the captured 16 kHz PCM utterance.
2. **speech_start while the bot is speaking = barge-in.** Abort the in-flight LLM stream
   and TTS requests, call `face.flush()`, set face state `listening`.
3. **speech_end → STT.** POST the utterance as WAV to `STT_URL/v1/audio/transcriptions`.
   Print `You: ...`. Ignore empty/whitespace/very short transcripts.
4. **STT → LLM.** Streaming chat completion to `LLM_URL/v1/chat/completions` with:
   - system prompt = same text as `index.js` (short replies, known lights list from
     `listLights()` at startup),
   - rolling conversation history (last N turns, configurable),
   - the **most recent camera JPEG** attached as an `image_url` data URI on the user
     message (only the latest frame, not every frame),
   - `tools` in OpenAI function format (add `toolDeclarationsOpenAI` to `ha.js`
     derived from the existing declarations — one source of truth).
   Handle tool calls: execute via `toolHandlers`, append the tool result message,
   continue the completion, loop until a final text answer. Face state `thinking`
   during tool execution.
5. **LLM → TTS.** As tokens stream, split on sentence boundaries and send each sentence
   to `TTS_URL/v1/audio/speech` (`response_format: pcm`, 24 kHz mono s16le — resample
   if the server can't emit 24 kHz). Stream the PCM to `face.audio()` as it arrives, in
   order, so the first sentence plays while later ones are still generating. Emit
   `face.level()` and `face.caption()` like `index.js` does. Face state `speaking`, then
   `idle` when the last chunk is sent.
6. **Latency log** after every turn:
   `[latency] vad=…ms stt=…ms llm_first_token=…ms tts_first_audio=…ms total=…ms`.

Config via `.env` (extend `.env.example`): `STT_URL`, `LLM_URL`, `LLM_MODEL`, `TTS_URL`,
`TTS_VOICE`, `VAD_SILENCE_MS`, `HISTORY_TURNS`, plus the existing `AUDIO_DEVICE`,
`VIDEO_DEVICE`, `VIDEO_FPS`, `FACE_PORT`, `HA_URL`, `HA_TOKEN`.

### 3. `npm run check-local`

Script that hits all three services with a trivial request and prints OK/FAIL + timing
for each, so I can validate the cluster side before running the brain.

## Deployment instructions (Claude Code writes these into `deploy/README.md`; I run them)

Which machine each step runs on:
- **gpu-vm** = `gpu-vm`. Key-based SSH is configured from the workstation as
  `ssh gpu` (alias in `~/.ssh/config`; VM user is `youruser`, home `/home/youruser`), so run
  gpu-vm commands as `ssh gpu '<cmd>'` and
  copy files with `scp <file> gpu:~/big-cat/deploy/`. Passwordless `sudo` is only granted
  for `nerdctl` (`/etc/sudoers.d/nerdctl` → `/usr/local/bin/nerdctl`); if another command needs sudo, print it for me to run instead of blocking.
- **workstation** = my Windows PC (PowerShell) running the brain and this Claude Code session.

### 0. Pre-flight (gpu-vm)
```
ssh gpu 'hostname && uname -a'      # alias works
nvidia-smi                                  # driver OK, GPU idle (no k8s vLLM running)
nvidia-ctk --version                        # container toolkit present
sudo ctr version                            # containerd present
```
If the cluster is up, first from a kubectl shell: `kubectl -n ai scale deploy/vllm --replicas=0`.

### 1. Install nerdctl (gpu-vm)
Install the **full** nerdctl release (it bundles buildkit and the CNI plugins) from the
containerd/nerdctl GitHub releases into `/usr/local`; do not install Docker CE. Verify:
```
sudo nerdctl --version
sudo nerdctl run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```
That last command must show the GPU from inside a container. If it fails, the toolkit
runtime isn't wired for nerdctl — README must give the `nvidia-ctk runtime configure`
step for this case and note that kubelet's containerd config must remain intact.

### 2. Bring up STT and TTS first (gpu-vm)
Small services first, so GPU/runtime problems surface before a 36 GB download.
```
cd ~/big-cat/deploy && cp .env.example .env    # set HF_TOKEN
sudo nerdctl compose up -d stt tts
sudo nerdctl compose ps
curl -s http://localhost:8001/v1/models
curl -s http://localhost:8002/v1/audio/speech -H "Content-Type: application/json" \
  -d '{"input":"Hello Phil, I can see you.","voice":"<voice>","response_format":"wav"}' -o hello.wav
```
Copy `hello.wav` to the workstation and play it.

### 3. Bring up vLLM (gpu-vm)
```
sudo nerdctl compose up -d vllm
sudo nerdctl compose logs -f vllm        # wait for "Application startup complete"
nvidia-smi                               # three processes
curl -s http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3.6-35B-A3B-FP8","messages":[{"role":"user","content":"Say hi in five words."}]}'
```
Then a tool-call smoke test with a `toggle_light` definition — must return `tool_calls`.

### 4. Make it boot with the VM (gpu-vm)
```
sudo cp deploy/big-cat-stack.service /etc/systemd/system/
sudo systemctl enable --now big-cat-stack
```
Reboot the VM once and confirm all three come back without intervention.

### 5. Expose to the workstation
Preferred: Caddy entries + UniFi DNS → `vllm.lan`, `stt.lan`, `tts.lan` pointing at
`gpu-vm:8000/8001/8002` (document the Caddyfile snippets). Quick alternative: use
`http://<gpu-vm ip>:800x` directly.

### 6. Run the brain (workstation)
```
STT_URL=http://stt.lan
LLM_URL=http://vllm.lan
LLM_MODEL=Qwen/Qwen3.6-35B-A3B-FP8
TTS_URL=http://tts.lan
TTS_VOICE=<clip or voice name>
TTS_EXAGGERATION=0.5
```
```
npm run check-local     # three OK lines with timings
npm run local
```

### 7. Voice setup
Reference clip: 8–15 s of clean speech, 24 kHz mono WAV, no music, in `deploy/voices/`.
The README must state the exact path/name convention the server expects. Only clone
voices I have the rights to use.

## Constraints

- Node 20+, ESM, no native build steps beyond what the VAD package needs; if a native
  module is unavoidable, confirm it has prebuilt Windows binaries.
- No new frameworks (no Pipecat/LiveKit). Plain `fetch`, streams, and `ws`.
- Windows is the dev workstation: PowerShell-friendly scripts, no bash-isms in
  `package.json`.
- Keep `src/index.js` (Gemini) working; the two brains share `media.js`,
  `face-server.js`, `ha.js`.
- Never send audio or images anywhere except the configured local URLs.
- Update `README.md` with a "Local brain" section: GPU-VM prerequisites, env vars,
  run order, how to switch between Gemini and local.

## Acceptance

- With only gpu-vm powered on, all three services start on boot and every curl in the deployment steps succeeds; `nvidia-smi` shows all three.
- `npm run check-local` → three OKs.
- `npm run local`, say "what do you see?" → spoken answer describing the webcam view,
  total latency under 1.5 s on the first try, under 1 s typical.
- "turn off the <name> light" → light toggles, bot confirms the new state.
- Talking over the bot cuts it off within ~300 ms and it listens to the new request.
- Ctrl-C exits cleanly with no orphaned ffmpeg processes.
