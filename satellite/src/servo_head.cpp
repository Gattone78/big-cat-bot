#include "servo_head.h"
#include "config.h"
#include <ESP32Servo.h>

static Servo servo;
static float basePos = 0;      // -1..1 from the brain
static float current = 90;     // degrees actually commanded
static uint32_t lastTick = 0;
static enum { S_IDLE, S_LISTEN, S_THINK, S_SPEAK, S_OFF } mode = S_OFF;

static float posToDeg(float pos) {
  const float center = (SERVO_LEFT_DEG + SERVO_RIGHT_DEG) / 2.0f;
  const float half = (SERVO_LEFT_DEG - SERVO_RIGHT_DEG) / 2.0f;
  return center - pos * half; // pos +1 (bot's right) -> SERVO_RIGHT_DEG
}

void servoBegin() {
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US);
  current = posToDeg(0);
  servo.write((int)current);
  lastTick = millis();
}

void servoSetBase(float pos) { basePos = constrain(pos, -1.0f, 1.0f); }

void servoOnState(const char *state) {
  if (!strcmp(state, "listening")) mode = S_LISTEN;
  else if (!strcmp(state, "thinking")) mode = S_THINK;
  else if (!strcmp(state, "speaking")) mode = S_SPEAK;
  else if (!strcmp(state, "idle")) mode = S_IDLE;
  else mode = S_OFF;
}

void servoTick(float level) {
  const uint32_t now = millis();
  const float dt = min((now - lastTick) / 1000.0f, 0.1f);
  lastTick = now;

  float offset = 0; // degrees around the base direction
  switch (mode) {
    case S_IDLE:   offset = 12.0f * sinf(now / 9000.0f * TWO_PI); break; // slow wander
    case S_LISTEN: offset = 0; break;                                    // attentive
    case S_THINK:  offset = -8.0f; break;                                // pondering tilt
    case S_SPEAK:  offset = level * 6.0f * sinf(now / 700.0f * TWO_PI); break;
    case S_OFF:    offset = 0; break;
  }
  const float target = posToDeg(basePos) + offset;

  // ease toward the target, capped at SERVO_SPEED_DPS
  const float maxStep = SERVO_SPEED_DPS * dt;
  current += constrain(target - current, -maxStep, maxStep);
  servo.write((int)roundf(constrain(current, (float)min(SERVO_LEFT_DEG, SERVO_RIGHT_DEG),
                                    (float)max(SERVO_LEFT_DEG, SERVO_RIGHT_DEG))));
}
