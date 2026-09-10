#include "audio_out.h"
#include "config.h"
#include <driver/i2s.h>
#include <freertos/stream_buffer.h>
#include <math.h>

// WebSocket binary frames land in a stream buffer; the playback task drains
// it, duplicates mono -> stereo (the MAX98357A averages L+R with its SD pin
// floating), applies volume, and blocks on i2s_write. tx_desc_auto_clear
// outputs silence on underrun, so gaps are quiet, not repeated DMA garbage.

static StreamBufferHandle_t buf;
static volatile bool flushReq = false;
static volatile float level = 0.0f;
static volatile uint32_t lastAudioMs = 0;

static void playTask(void *) {
  static int16_t mono[240];      // 10 ms at 24 kHz
  static int16_t stereo[480];
  for (;;) {
    if (flushReq) {
      // Reader is the only consumer and is not blocked here, so reset is safe.
      xStreamBufferReset(buf);
      flushReq = false;
      level = 0.0f;
    }
    size_t got = xStreamBufferReceive(buf, mono, sizeof(mono), pdMS_TO_TICKS(20));
    if (!got) { level *= 0.8f; continue; }
    const int n = got / 2;
    float sum = 0;
    for (int i = 0; i < n; i++) {
      int16_t s = (int16_t)(mono[i] * SPK_VOLUME);
      stereo[i * 2] = s;
      stereo[i * 2 + 1] = s;
      const float f = s / 32768.0f;
      sum += f * f;
    }
    level = fminf(1.0f, sqrtf(sum / n) * 4.0f); // same boost as the browser face
    lastAudioMs = millis();
    size_t bw = 0;
    i2s_write(I2S_NUM_1, stereo, n * 4, &bw, portMAX_DELAY);
  }
}

void audioOutBegin() {
  const i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = SPK_RATE,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
      .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 8,
      .dma_buf_len = 240,
      .use_apll = false,
      .tx_desc_auto_clear = true,
      .fixed_mclk = 0,
  };
  const i2s_pin_config_t pins = {
      .mck_io_num = I2S_PIN_NO_CHANGE,
      .bck_io_num = AMP_BCLK,
      .ws_io_num = AMP_LRC,
      .data_out_num = AMP_DIN,
      .data_in_num = I2S_PIN_NO_CHANGE,
  };
  ESP_ERROR_CHECK(i2s_driver_install(I2S_NUM_1, &cfg, 0, nullptr));
  ESP_ERROR_CHECK(i2s_set_pin(I2S_NUM_1, &pins));
  ESP_ERROR_CHECK(i2s_zero_dma_buffer(I2S_NUM_1));

  buf = xStreamBufferCreate(SPK_BUF_BYTES, 1);
  xTaskCreatePinnedToCore(playTask, "spk", 4096, nullptr, 10, nullptr, 0);
}

void audioOutWrite(const uint8_t *pcm, size_t len) {
  // Never block the WebSocket task; the brain paces, so a full buffer means
  // something is badly wrong anyway.
  xStreamBufferSend(buf, pcm, len, 0);
}

void audioOutFlush() { flushReq = true; }

float audioOutLevel() { return level; }

bool audioOutActive() {
  return xStreamBufferBytesAvailable(buf) > 0 || millis() - lastAudioMs < 150;
}
