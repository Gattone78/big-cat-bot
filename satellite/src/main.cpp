// big-cat-bot satellite: the body, portable. Streams its mic to the brain and
// plays back the voice, renders the face on the LCD, and moves its head —
// all over the face-server WebSocket (see ../big-cat-bench/src/face-server.js).
//
// Protocol (client view):
//   send  binary        0x01 + 16 kHz s16le mono mic PCM (512-sample frames)
//                       (0x02 + JPEG = camera frame, from satellites that have one)
//   send  {type:hello}  once on connect
//   recv  binary        24 kHz s16le mono voice PCM (no prefix)
//   recv  {type:state|face|caption|servo|flush|level}
#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "config.h"
#include "secrets.h"
#include "audio_in.h"
#include "audio_out.h"
#include "face_render.h"
#include "servo_head.h"

static WebSocketsClient ws;
static bool wsUp = false;
static char lastState[16] = "offline";

static void handleJson(uint8_t *payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  const char *type = doc["type"] | "";

  if (!strcmp(type, "state")) {
    const char *s = doc["state"] | "idle";
    strlcpy(lastState, s, sizeof(lastState));
    faceSetState(s);
    servoOnState(s);
    if (strcmp(s, "speaking") != 0) faceSetCaption("");
  } else if (!strcmp(type, "face")) {
    faceSetPersona(doc["face"] | "pepper");
  } else if (!strcmp(type, "caption")) {
    if (!strcmp(doc["role"] | "", "bot")) faceSetCaption(doc["text"] | "");
  } else if (!strcmp(type, "servo")) {
    servoSetBase(doc["pos"] | 0.0f);
  } else if (!strcmp(type, "flush")) {
    audioOutFlush(); // barge-in: silence immediately
  }
  // 'level' is ignored — the mouth tracks the audio we actually play.
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      wsUp = true;
      faceSetConnected(true);
      ws.sendTXT("{\"type\":\"hello\",\"device\":\"esp32s3-satellite\"}");
      Serial.printf("[ws] connected to %s:%d\n", BRAIN_HOST, BRAIN_PORT);
      break;
    case WStype_DISCONNECTED:
      if (wsUp) Serial.println("[ws] disconnected");
      wsUp = false;
      faceSetConnected(false);
      audioOutFlush();
      break;
    case WStype_TEXT:
      handleJson(payload, len);
      break;
    case WStype_BIN:
      audioOutWrite(payload, len);
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  faceBegin();
  faceTick(0); // show "connecting..." right away
  servoBegin();
  audioOutBegin();
  audioInBegin();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // Wi-Fi power save adds tens of ms of audio jitter
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print('.'); }
  Serial.printf("\n[wifi] %s\n", WiFi.localIP().toString().c_str());

  ws.begin(BRAIN_HOST, BRAIN_PORT, WS_PATH);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  ws.loop();

  // mic frames -> brain, 0x01-prefixed (only when connected; otherwise drop)
  static uint8_t frame[1 + MIC_FRAME_SAMPLES * 2] = {0x01};
  while (audioInPop(frame + 1)) {
    if (wsUp) ws.sendBIN(frame, sizeof(frame));
  }

  // face at ~20 fps, servo at ~50 Hz
  const uint32_t now = millis();
  static uint32_t nextFace = 0, nextServo = 0;
  const float level = audioOutLevel();
  if (now >= nextFace) {
    nextFace = now + 50;
    faceTick(!strcmp(lastState, "speaking") ? level : 0.0f);
  }
  if (now >= nextServo) {
    nextServo = now + 20;
    servoTick(level);
  }
}
