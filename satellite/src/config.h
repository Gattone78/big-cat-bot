// Satellite hardware + tuning. Pins below are for an ESP32-S3-DevKitC-1 with:
//   INMP441 I2S mic, MAX98357A I2S amp + 4Ω speaker, ST7789 240x240 SPI LCD,
//   SG90 pan servo. Rewire freely — everything routes through here.
// Wi-Fi credentials and the brain's address live in secrets.h (copy
// secrets.example.h and fill it in; it is gitignored).
#pragma once

// ---- brain --------------------------------------------------------------------
// The face WebSocket served by `npm start` / `npm run local` (FACE_PORT).
#define WS_PATH "/"

// ---- LCD (ST7789 240x240, SPI2) ----------------------------------------------
#define LCD_SCK   12
#define LCD_MOSI  11
#define LCD_DC     9
#define LCD_CS    10
#define LCD_RST   13
#define LCD_BLK   14    // backlight; -1 if wired to 3V3
#define LCD_W    240
#define LCD_H    240

// ---- mic (INMP441, I2S0) — tie its L/R pin to GND -----------------------------
#define MIC_BCLK   4
#define MIC_WS     5
#define MIC_SD     6
#define MIC_RATE   16000     // what the brain's VAD/STT expect
#define MIC_FRAME_SAMPLES 512   // 32 ms per WebSocket frame, matches the VAD frame
// Software gain: raw 24-bit sample >> MIC_GAIN_SHIFT -> 16-bit (16 = unity from
// the top bits; each step down doubles gain). 12 suits a voice at ~1-3 m.
#define MIC_GAIN_SHIFT 12

// ---- speaker (MAX98357A, I2S1) — leave its SD pin unconnected -----------------
#define AMP_BCLK  15
#define AMP_LRC   16
#define AMP_DIN    7
#define SPK_RATE  24000      // what the brain streams (s16le mono)
// Playback ring buffer: the brain paces audio ~300 ms ahead, so ~0.7 s is ample.
#define SPK_BUF_BYTES (32 * 1024)
// 0.0-1.0 software volume applied before the DAC
#define SPK_VOLUME 0.9f

// ---- servo (SG90 on its own 5V supply; common ground with the ESP32) ----------
#define SERVO_PIN      8
#define SERVO_MIN_US 500
#define SERVO_MAX_US 2400
// Servo angles for head pos -1 (full left) .. +1 (full right); center is the mean.
#define SERVO_LEFT_DEG   150
#define SERVO_RIGHT_DEG   30
#define SERVO_SPEED_DPS  120   // max slew rate, degrees per second (eased)
