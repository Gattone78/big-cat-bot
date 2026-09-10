// Pan servo: the brain sets a base direction; state choreography animates
// around it (idle wander, attentive snap, speaking sway).
#pragma once
#include <Arduino.h>

void servoBegin();
void servoSetBase(float pos);            // -1 (left) .. 1 (right) from the brain
void servoOnState(const char *state);    // idle|listening|thinking|speaking|offline
void servoTick(float level);             // call at ~50 Hz; level drives the sway
