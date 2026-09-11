# big-cat-bot

A local voice + vision house robot: desk webcam and mic, an animated face in
the browser, Home Assistant tools, and a fully self-hosted brain on a single
homelab GPU. Talk over it and it stops; ask what it sees and it looks.

| directory | what it is |
|---|---|
| [`big-cat-bench/`](big-cat-bench/README.md) | the robot: mic/camera capture, the face, Home Assistant tools, and two interchangeable brains — Gemini Live API (`npm start`) or fully local (`npm run local`) |
| [`deploy/`](deploy/README.md) | the local brain's GPU services as a `nerdctl compose` stack: vLLM (Qwen3.6 MoE), faster-whisper STT, Chatterbox-Turbo TTS — plus scripts to power the stack and the VM on/off from the workstation |
| [`satellite/`](satellite/README.md) | the portable body: ESP32-S3 firmware for a mic + speaker + LCD-face + pan-servo unit you can place anywhere in the house; it talks to the brain over the face WebSocket |
| [`satellite-pi/`](satellite-pi/README.md) | the full-fat body: Raspberry Pi with Camera Module 3, a 7″/tablet-class kiosk face, mic and servo — same protocol, plus vision ("what do you see?" works anywhere) |

The local pipeline is mic → Silero VAD (in-process) → whisper STT → streaming
LLM with tool calls → per-sentence TTS → browser face, with barge-in
interruption end to end. Warm voice-to-voice latency lands around a second.

The face morphs between personas to match the conversation topic (Pepper by
default; HAL 9000, a chrome skull, or an astromech dome when the model decides
the moment calls for it), and the voice follows the face.

Start with [`big-cat-bench/README.md`](big-cat-bench/README.md); for the
self-hosted brain, the full deployment runbook is
[`deploy/README.md`](deploy/README.md). Audio and images never leave your LAN
when running the local brain.
