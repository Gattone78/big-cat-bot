# Reference voice clips

Drop voice-cloning reference clips here; compose mounts this directory into the
TTS container at `/app/reference_audio`.

Convention:

- One WAV per voice, named however you like: `phil.wav`, `narrator.wav`, …
- 8–15 s of clean speech, 24 kHz mono WAV. No music, no room echo.
- The brain selects a clip with `TTS_VOICE=<filename>.wav` and
  `TTS_VOICE_MODE=clone` in `big-cat-bench/.env`.
- Only clone voices you have the rights to use.

Clips are gitignored (`*.wav` / `*.mp3`) — they are personal recordings and do
not belong in the repo.
