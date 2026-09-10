#include "face_render.h"
#include "config.h"
#define LGFX_USE_V1
#include <LovyanGFX.hpp>

// ST7789 over SPI2. Boards without a CS pin (common on 240x240 modules): set
// LCD_CS to -1 in config.h — LovyanGFX then needs SPI mode 3, handled below.
class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7789 _panel;
  lgfx::Bus_SPI _bus;
  lgfx::Light_PWM _light;

 public:
  LGFX() {
    {
      auto cfg = _bus.config();
      cfg.spi_host = SPI2_HOST;
      cfg.spi_mode = (LCD_CS < 0) ? 3 : 0;
      cfg.freq_write = 40000000;
      cfg.pin_sclk = LCD_SCK;
      cfg.pin_mosi = LCD_MOSI;
      cfg.pin_miso = -1;
      cfg.pin_dc = LCD_DC;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs = LCD_CS;
      cfg.pin_rst = LCD_RST;
      cfg.panel_width = LCD_W;
      cfg.panel_height = LCD_H;
      cfg.invert = true; // typical for these ST7789 modules; flip if colors look negative
      _panel.config(cfg);
    }
    if (LCD_BLK >= 0) {
      auto cfg = _light.config();
      cfg.pin_bl = LCD_BLK;
      cfg.freq = 12000;
      cfg.pwm_channel = 7;
      _light.config(cfg);
      _panel.setLight(&_light);
    }
    setPanel(&_panel);
  }
};

static LGFX lcd;
static LGFX_Sprite canvas(&lcd); // 8-bit sprite: 240*240 = 57.6 KB in SRAM

enum State { IDLE, LISTENING, THINKING, SPEAKING, OFFLINE };
enum Persona { PEPPER, HAL9000, TERMINATOR, R2D2 };

static State state = OFFLINE;
static Persona persona = PEPPER;
static char caption[64] = "";
static bool connected = false;

// blink animation: eyes shut for ~120 ms every few seconds
static uint32_t nextBlinkAt = 0;
static uint32_t blinkStart = 0;

static float eyeOpen() { // 0 shut .. 1 open
  const uint32_t now = millis();
  if (now > nextBlinkAt) {
    blinkStart = now;
    nextBlinkAt = now + 2000 + (esp_random() % 4000);
  }
  const uint32_t t = now - blinkStart;
  if (t < 60) return 1.0f - t / 60.0f;
  if (t < 120) return (t - 60) / 60.0f;
  return 1.0f;
}

// ---- personas -----------------------------------------------------------------
// Each draws eyes+mouth for the current state onto the canvas. cx=120 center.

static void drawPepper(float mouth) {
  const bool off = state == OFFLINE;
  const uint16_t eyeCol = off               ? TFT_DARKGREY
                          : state == LISTENING ? (uint16_t)0x07FF /* aqua */
                          : state == THINKING  ? (uint16_t)0xFD20 /* orange */
                                               : TFT_WHITE;
  float open = off ? 0.25f : eyeOpen();
  if (state == THINKING) open *= 0.45f; // squint
  const int eh = max(4, (int)(52 * open));
  const int ew = state == LISTENING ? 40 : 34; // leans in: wider eyes
  canvas.fillSmoothRoundRect(70 - ew / 2, 96 - eh / 2, ew, eh, 10, eyeCol);
  canvas.fillSmoothRoundRect(170 - ew / 2, 96 - eh / 2, ew, eh, 10, eyeCol);

  if (state == SPEAKING) {
    const int mh = 6 + (int)(mouth * 44);
    canvas.fillSmoothRoundRect(120 - 34, 168 - mh / 2, 68, mh, 8, eyeCol);
  } else if (state == THINKING) {
    const int ph = (millis() / 220) % 3; // three walking dots
    for (int i = 0; i < 3; i++)
      canvas.fillSmoothCircle(96 + i * 24, 168, i == ph ? 7 : 4, eyeCol);
  } else {
    canvas.fillSmoothRoundRect(120 - 28, 166, 56, 6, 3, off ? TFT_DARKGREY : eyeCol);
  }
}

static void drawHal(float mouth) {
  const bool off = state == OFFLINE;
  // breathing glow: slow in idle, fast+loud while speaking
  const float breathe = 0.5f + 0.5f * sinf(millis() / (state == SPEAKING ? 140.0f : 900.0f));
  const float amp = off ? 0.15f : (state == SPEAKING ? 0.5f + mouth * 0.5f : 0.35f + breathe * 0.3f);
  canvas.fillSmoothCircle(120, 120, 78, canvas.color565(40, 40, 44)); // housing
  canvas.fillSmoothCircle(120, 120, 66, canvas.color565((int)(120 * amp) + 40, 0, 0));
  canvas.fillSmoothCircle(120, 120, 40, canvas.color565((int)(200 * amp) + 55, (int)(30 * amp), 0));
  canvas.fillSmoothCircle(120, 120, 14, canvas.color565(255, (int)(180 * amp), (int)(80 * amp)));
  canvas.fillSmoothCircle(104, 104, 6, canvas.color565(255, 230, 200)); // specular
  if (state == LISTENING) {
    canvas.drawCircle(120, 120, 84, (uint16_t)0x07FF);
    canvas.drawCircle(120, 120, 85, (uint16_t)0x07FF);
  }
  if (state == THINKING) {
    const int ph = (millis() / 220) % 3;
    for (int i = 0; i < 3; i++)
      canvas.fillSmoothCircle(96 + i * 24, 218, i == ph ? 6 : 3, canvas.color565(200, 40, 20));
  }
}

static void drawTerminator(float mouth) {
  const bool off = state == OFFLINE;
  const float open = off ? 0.3f : eyeOpen();
  const uint8_t r = off ? 90 : (state == SPEAKING ? 200 + (int)(mouth * 55) : 220);
  const uint16_t eye = canvas.color565(r, state == LISTENING ? 60 : 10, 10);
  const uint16_t steel = canvas.color565(120, 125, 135);
  // brow ridges
  canvas.fillTriangle(38, 72, 108, 84, 38, 96, steel);
  canvas.fillTriangle(202, 72, 132, 84, 202, 96, steel);
  // deep-set eyes
  const int eh = max(3, (int)(18 * open));
  canvas.fillSmoothRoundRect(58, 102 - eh / 2, 40, eh, 4, eye);
  canvas.fillSmoothRoundRect(142, 102 - eh / 2, 40, eh, 4, eye);
  // cheek plates + jaw
  canvas.drawLine(52, 130, 78, 150, steel);
  canvas.drawLine(188, 130, 162, 150, steel);
  const int jaw = state == SPEAKING ? 6 + (int)(mouth * 30) : (state == THINKING ? 4 : 8);
  canvas.fillRect(84, 168, 72, 3, steel);
  canvas.fillRect(84, 168 + 3 + jaw, 72, 3, steel);        // lower jaw drops
  for (int i = 0; i < 5; i++) canvas.drawFastVLine(90 + i * 15, 168, 3 + jaw, steel); // teeth bars
}

static void drawR2(float mouth) {
  const bool off = state == OFFLINE;
  const uint16_t blue = off ? canvas.color565(40, 60, 90) : canvas.color565(30, 90, 200);
  const uint16_t white = off ? TFT_DARKGREY : canvas.color565(225, 228, 235);
  // dome
  canvas.fillSmoothCircle(120, 150, 105, white);
  canvas.fillRect(0, 150, 240, 90, TFT_BLACK);
  canvas.fillSmoothRoundRect(30, 132, 180, 26, 8, blue); // dome band
  // main eye
  canvas.fillSmoothCircle(120, 96, 26, blue);
  canvas.fillSmoothCircle(120, 96, 18, TFT_BLACK);
  const float open = off ? 0.3f : eyeOpen();
  canvas.fillSmoothCircle(120, 96, (int)(9 * open) + 2, state == LISTENING ? (uint16_t)0x07FF : canvas.color565(200, 40, 40));
  // status lights: flicker while speaking/thinking, steady otherwise
  const bool busy = state == SPEAKING || state == THINKING;
  const bool flick = busy && ((millis() / 120 + 1) % 2 || mouth > 0.35f);
  canvas.fillSmoothRoundRect(58, 138, 26, 14, 4, flick ? canvas.color565(230, 60, 50) : canvas.color565(90, 30, 25));
  canvas.fillSmoothRoundRect(156, 138, 26, 14, 4, (busy && !flick) ? (uint16_t)0x07FF : canvas.color565(25, 60, 80));
  // projector
  canvas.fillSmoothCircle(78, 108, 8, canvas.color565(60, 60, 65));
}

// ---- public API ----------------------------------------------------------------

void faceBegin() {
  lcd.init();
  lcd.setRotation(0);
  canvas.setColorDepth(8);
  canvas.createSprite(LCD_W, LCD_H);
  lcd.setBrightness(200);
}

static State parseState(const char *s) {
  if (!strcmp(s, "idle")) return IDLE;
  if (!strcmp(s, "listening")) return LISTENING;
  if (!strcmp(s, "thinking")) return THINKING;
  if (!strcmp(s, "speaking")) return SPEAKING;
  return OFFLINE;
}

void faceSetState(const char *s) { state = parseState(s); }

void faceSetPersona(const char *name) {
  if (!strcmp(name, "hal9000")) persona = HAL9000;
  else if (!strcmp(name, "terminator")) persona = TERMINATOR;
  else if (!strcmp(name, "r2d2")) persona = R2D2;
  else persona = PEPPER;
}

void faceSetCaption(const char *text) {
  strlcpy(caption, text, sizeof(caption));
}

void faceSetConnected(bool up) {
  connected = up;
  if (!up) { state = OFFLINE; caption[0] = 0; }
}

void faceTick(float mouth) {
  canvas.fillSprite(TFT_BLACK);
  switch (persona) {
    case PEPPER:     drawPepper(mouth); break;
    case HAL9000:    drawHal(mouth); break;
    case TERMINATOR: drawTerminator(mouth); break;
    case R2D2:       drawR2(mouth); break;
  }
  if (!connected) {
    canvas.setTextDatum(textdatum_t::top_center);
    canvas.setTextColor(TFT_DARKGREY);
    canvas.drawString("connecting...", LCD_W / 2, 6, 2);
  } else if (caption[0] && (state == SPEAKING || persona != HAL9000)) {
    // caption strip: last line of what the bot is saying, truncated to fit
    canvas.setTextDatum(textdatum_t::bottom_center);
    canvas.setTextColor(TFT_SILVER, TFT_BLACK);
    char shown[36];
    const size_t len = strlen(caption);
    strlcpy(shown, len > 34 ? caption + (len - 34) : caption, sizeof(shown));
    canvas.drawString(shown, LCD_W / 2, LCD_H - 4, 1);
  }
  canvas.pushSprite(0, 0);
}
