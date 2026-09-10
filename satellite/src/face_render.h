// The face on the satellite's LCD: same states and personas as face/index.html,
// redrawn procedurally at LCD scale.
#pragma once
#include <Arduino.h>

void faceBegin();
void faceSetState(const char *state);     // idle|listening|thinking|speaking|offline
void faceSetPersona(const char *name);    // pepper|hal9000|terminator|r2d2
void faceSetCaption(const char *text);
void faceSetConnected(bool up);           // Wi-Fi/WS status chip
void faceTick(float mouthLevel);          // render one frame; call at ~20 fps
