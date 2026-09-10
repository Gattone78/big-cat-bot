# big-cat-bot — voice stack on gpu-vm (nerdctl compose)

Three GPU services as plain containers on the GPU VM, so the voice pipeline
runs with **only `gpu-vm` powered on** — no control plane, no kubelet needed.
containerd-native via `nerdctl compose`; **Docker CE is never installed** (its
containerd package would replace the one kubelet depends on).

| service | image | host port | API | expected VRAM |
|---|---|---|---|---|
| `vllm` | `vllm/vllm-openai:cu130-nightly` (Blackwell) | 8000 | `/v1/chat/completions` | ~58 GB (0.6 × 96 GB) |
| `stt` | `ghcr.io/speaches-ai/speaches:latest-cuda` | 8001 | `/v1/audio/transcriptions` | ~2 GB (large-v3-turbo) |
| `tts` | built from `tts.Dockerfile` (Chatterbox-Turbo) | 8002 | `/tts` + `/v1/audio/speech` | ~4–6 GB |
| `tts-kokoro` | optional fallback, profile `kokoro` | 8003 | `/v1/audio/speech` | ~1–2 GB |

LLM: `Qwen/Qwen3.6-35B-A3B-FP8` — natively multimodal MoE, ~3B active params,
FP8 (~35 GB weights), MTP speculative decoding. Fallback if it misbehaves:
`Qwen/Qwen3-VL-30B-A3B-Instruct-FP8` with `--tool-call-parser hermes` and the
reasoning flags removed.

> **⚠️ One GPU, one owner.** The Kubernetes vLLM deployment in namespace `ai`
> claims the same GPU. Whenever the cluster is up **and** this stack is running,
> scale it away first:
>
> ```
> kubectl -n ai scale deploy/vllm --replicas=0
> ```

**Day-to-day on/off** (from the workstation, no manual SSH — uses the
passwordless nerdctl rule):

```
.\deploy\stack.ps1 status        # containers + GPU memory
.\deploy\stack.ps1 down          # stop the stack (VM stays up; reboot restarts it)
.\deploy\stack.ps1 up            # start it again
.\deploy\stack.ps1 down vllm     # stop one service (frees its VRAM)
.\deploy\stack.ps1 logs vllm     # tail logs
```

**Rollback:** `sudo nerdctl compose down` from `~/big-cat/deploy`. Nothing on
the node is modified beyond nerdctl itself (and, if step 1 needed it, one added
runtime entry in containerd's config).

Machines: **gpu-vm** = the GPU VM (reachable as `ssh gpu`; adjust the VM
username in paths and `big-cat-stack.service` to yours); **workstation** = the
Windows PC running the brain.

---

## 0. Pre-flight (gpu-vm)

```
ssh gpu 'hostname && uname -a'
ssh gpu 'nvidia-smi'            # driver OK, GPU idle (no k8s vLLM!)
ssh gpu 'nvidia-ctk --version'  # NVIDIA container toolkit present
ssh gpu 'sudo ctr version'      # containerd present (needs your sudo password)
```

If the cluster is up, from a kubectl shell: `kubectl -n ai scale deploy/vllm --replicas=0`.

## 1. Install nerdctl (gpu-vm)

Install the **full** release (bundles buildkit + CNI plugins) into `/usr/local`.
Check https://github.com/containerd/nerdctl/releases for the latest 2.x and set
the version below. These need real sudo — run them in an SSH session:

```
NERDCTL_VERSION=2.1.6
curl -fsSL -o /tmp/nerdctl-full.tgz "https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-full-${NERDCTL_VERSION}-linux-amd64.tar.gz"
sudo tar Cxzvf /usr/local /tmp/nerdctl-full.tgz
sudo systemctl enable --now buildkit     # unit ships in the tarball (/usr/local/lib/systemd/system)
```

Verify, including GPU access from inside a container:

```
sudo nerdctl --version
sudo nerdctl run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

**If the GPU test fails**, the NVIDIA runtime isn't wired for containerd's
non-k8s namespace. Fix (needs real sudo):

```
sudo cp /etc/containerd/config.toml /etc/containerd/config.toml.bak
sudo nvidia-ctk runtime configure --runtime=containerd
sudo systemctl restart containerd
```

This *adds* an `nvidia` runtime entry; it must not change the default runtime —
diff against the backup to confirm, because **kubelet shares this containerd
config**. Restarting containerd briefly restarts running containers, so do it
while the cluster side of this node is idle. Then rerun the GPU test.

## 2. Copy the deploy dir + bring up STT and TTS first (gpu-vm)

Small services first, so GPU/runtime problems surface before a 35 GB download.

From the workstation:

```
ssh gpu 'mkdir -p ~/big-cat/deploy'
scp -r deploy/* gpu:~/big-cat/deploy/
```

On the VM (`ssh gpu`):

```
cd ~/big-cat/deploy && cp .env.example .env    # then edit: set HF_TOKEN
sudo nerdctl compose build tts                 # builds Chatterbox from tts.Dockerfile (~10 min)
sudo nerdctl compose up -d stt tts
sudo nerdctl compose ps
curl -s http://localhost:8001/v1/models        # speaches answers
# one-time: install the whisper model into the cache volume (~1.6 GB)
curl -s -X POST http://localhost:8001/v1/models/deepdml/faster-whisper-large-v3-turbo-ct2
curl -s http://localhost:8002/api/model-info   # chatterbox answers once the model is loaded
```

First TTS sound (uses a predefined voice shipped with the server; your cloned
voices come in step 7):

```
curl -s http://localhost:8002/v1/audio/speech -H "Content-Type: application/json" \
  -d '{"model":"chatterbox","input":"Hello Phil, I can see you.","voice":"Emily.wav","response_format":"wav"}' -o hello.wav
```

Copy it to the workstation and play it: `scp gpu:~/big-cat/deploy/hello.wav . ; start hello.wav`

## 3. Bring up vLLM (gpu-vm)

```
sudo nerdctl compose up -d vllm
sudo nerdctl compose logs -f vllm     # wait for "Application startup complete"
nvidia-smi                            # three processes on the GPU
curl -s http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3.6-35B-A3B-FP8","messages":[{"role":"user","content":"Say hi in five words."}]}'
```

If vLLM rejects `--tool-call-parser qwen3_coder`, list what this nightly knows
(`sudo nerdctl compose run --rm vllm --help | grep -A3 tool-call-parser`) and
use the Qwen3 parser it names, editing `compose.yaml`.

Tool-call smoke test — must return a `tool_calls` array, not text:

```
curl -s http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "Qwen/Qwen3.6-35B-A3B-FP8",
  "messages": [{"role": "user", "content": "Turn off the kitchen light"}],
  "tools": [{"type": "function", "function": {"name": "toggle_light",
    "description": "Toggle a Home Assistant light on or off.",
    "parameters": {"type": "object", "properties": {"entity_id": {"type": "string",
      "description": "e.g. light.kitchen"}}, "required": ["entity_id"]}}}]
}'
```

## 4. Make it boot with the VM (gpu-vm)

```
sudo cp ~/big-cat/deploy/big-cat-stack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now big-cat-stack
```

(The `cp`/`systemctl` need real sudo — run in an SSH session.) Reboot the VM
once (`sudo reboot`) and confirm all three come back without intervention:
`sudo nerdctl compose ps` + the three curls above.

## 5. Expose to the workstation

Preferred — Caddy (LXC) + UniFi DNS. DNS: point `vllm.lan`, `stt.lan`,
`tts.lan` at the Caddy host. Caddyfile (plain HTTP on the LAN — the `http://`
prefix stops Caddy trying to mint certificates):

```
http://vllm.lan {
    reverse_proxy gpu-vm:8000
}
http://stt.lan {
    reverse_proxy gpu-vm:8001
}
http://tts.lan {
    reverse_proxy gpu-vm:8002
}
```

Quick alternative: skip Caddy and use `http://<gpu-vm ip>:8000/8001/8002`
directly in the brain's `.env`.

## 6. Run the brain (workstation)

In `big-cat-bench/.env` (see `.env.example`):

```
STT_URL=http://stt.lan
LLM_URL=http://vllm.lan
LLM_MODEL=Qwen/Qwen3.6-35B-A3B-FP8
TTS_URL=http://tts.lan
TTS_VOICE=phil.wav        # a clip from step 7 (or Emily.wav + TTS_VOICE_MODE=predefined)
TTS_VOICE_MODE=clone
TTS_EXAGGERATION=0.5
```

```
npm run check-local     # three [ ok ] lines with timings
npm run local
```

## 7. Voice setup

Reference clip: 8–15 s of clean speech, **24 kHz mono WAV**, no music, no room
echo. Put it in `deploy/voices/` on the workstation and copy it up (the compose
file mounts `deploy/voices/` at `/app/reference_audio` in the container):

```
scp deploy/voices/phil.wav gpu:~/big-cat/deploy/voices/
```

No restart needed — the server reads clips per request. Select it with
`TTS_VOICE=phil.wav` + `TTS_VOICE_MODE=clone`. Predefined voices that ship with
the server also work: `TTS_VOICE_MODE=predefined` and pick a name from
`curl http://tts.lan/v1/audio/voices`. Only clone voices you have the rights
to use.

---

## Notes

- **Exaggeration:** the brain talks to Chatterbox's `/tts` endpoint (not
  `/v1/audio/speech`) because only `/tts` accepts `exaggeration` per request;
  the OpenAI endpoint always uses the server's config defaults. `TTS_EXAGGERATION`
  in the brain's `.env` therefore works per request. Range 0.25–2.0, default 0.5.
- **Streaming:** Chatterbox's OpenAI endpoint does not stream, and `/tts` only
  streams multi-chunk WAV for long texts. The brain sends one request per
  sentence instead — sentence 1 is playing while sentence 2 synthesizes, which
  is the same pipelining with simpler failure modes.
- **Sample rate:** the server outputs 24 kHz WAV (its `audio_output.sample_rate`
  default). The brain parses the WAV header anyway and resamples to 24 kHz if a
  different rate ever comes back.
- **Kokoro fallback:** `sudo nerdctl compose --profile kokoro up -d tts-kokoro`,
  then on the workstation: `TTS_URL=http://<vm-ip>:8003`, `TTS_API=openai`,
  `TTS_MODEL=kokoro`, `TTS_VOICE=af_heart`.
- **Chatterbox UI:** http://gpu-vm:8002 has a web UI for auditioning voices
  and tuning generation defaults. Settings saved there live inside the
  container; add a bind mount for `/app/config.yaml` if you want them to
  survive recreation.
