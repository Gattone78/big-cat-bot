// MAX98357A I2S amp: plays the brain's 24 kHz s16le mono stream.
#pragma once
#include <Arduino.h>

void audioOutBegin();
// Queue PCM from a WebSocket binary frame (drops if the buffer is full).
void audioOutWrite(const uint8_t *pcm, size_t len);
// Barge-in: drop everything queued.
void audioOutFlush();
// 0..1 loudness of what is playing right now — drives the mouth.
float audioOutLevel();
// True while audio is queued or playing.
bool audioOutActive();
