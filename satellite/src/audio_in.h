// INMP441 I2S mic -> 16 kHz s16le frames, queued for the WebSocket sender.
#pragma once
#include <Arduino.h>

void audioInBegin();
// Pop one MIC_FRAME_SAMPLES*2-byte frame if available (non-blocking).
// Returns true and fills `frame` (must hold MIC_FRAME_SAMPLES*2 bytes).
bool audioInPop(uint8_t *frame);
