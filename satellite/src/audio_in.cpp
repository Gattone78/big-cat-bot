#include "audio_in.h"
#include "config.h"
#include <driver/i2s.h>

// The mic task reads 32-bit I2S words (24-bit INMP441 data MSB-aligned),
// converts to 16-bit with software gain, and queues whole frames. The
// WebSocket send happens on the main loop task — the ws client is not
// thread-safe, so tasks only touch the queue.

static QueueHandle_t frameQueue; // items: MIC_FRAME_SAMPLES*2-byte frames

static void micTask(void *) {
  static int32_t raw[MIC_FRAME_SAMPLES];
  static int16_t out[MIC_FRAME_SAMPLES];
  for (;;) {
    size_t br = 0;
    i2s_read(I2S_NUM_0, raw, sizeof(raw), &br, portMAX_DELAY);
    const int n = br / 4;
    for (int i = 0; i < n; i++) {
      int32_t s = raw[i] >> MIC_GAIN_SHIFT;
      out[i] = (int16_t)constrain(s, -32768, 32767);
    }
    if (n == MIC_FRAME_SAMPLES) {
      // Drop the frame if the queue is full (Wi-Fi hiccup) — fresher is better.
      xQueueSend(frameQueue, out, 0);
    }
  }
}

void audioInBegin() {
  const i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
      .sample_rate = MIC_RATE,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
      .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 6,
      .dma_buf_len = 256,
      .use_apll = false,
      .tx_desc_auto_clear = false,
      .fixed_mclk = 0,
  };
  const i2s_pin_config_t pins = {
      .mck_io_num = I2S_PIN_NO_CHANGE,
      .bck_io_num = MIC_BCLK,
      .ws_io_num = MIC_WS,
      .data_out_num = I2S_PIN_NO_CHANGE,
      .data_in_num = MIC_SD,
  };
  ESP_ERROR_CHECK(i2s_driver_install(I2S_NUM_0, &cfg, 0, nullptr));
  ESP_ERROR_CHECK(i2s_set_pin(I2S_NUM_0, &pins));

  frameQueue = xQueueCreate(8, MIC_FRAME_SAMPLES * 2);
  xTaskCreatePinnedToCore(micTask, "mic", 4096, nullptr, 10, nullptr, 0);
}

bool audioInPop(uint8_t *frame) {
  return xQueueReceive(frameQueue, frame, 0) == pdTRUE;
}
