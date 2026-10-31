#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PixelEngine PixelEngine;

typedef struct {
  const uint8_t *rgba;
  uint32_t width;
  uint32_t height;
  bool premultiplied;
  const uint32_t *rects;
  uint32_t rect_count;
} PixelFrame;

typedef struct {
  void *context;
  void (*event)(void *context, const char *json);
  void (*present)(void *context, const PixelFrame *frame);
  void (*write)(void *context, const char *data);
} PixelCallbacks;

uint32_t pixel_abi_version(void);
PixelEngine *pixel_engine_new(const char *config_json);
char *pixel_engine_info(PixelEngine *engine);
void pixel_engine_start(PixelEngine *engine, PixelCallbacks callbacks);
void pixel_engine_apply_ops(PixelEngine *engine, const char *ops_json);
void pixel_engine_input(PixelEngine *engine, const char *input_json);
void pixel_engine_resize(PixelEngine *engine, uint32_t width_px, uint32_t height_px, uint32_t cell_width,
                         uint32_t cell_height);
void pixel_engine_stop(PixelEngine *engine);
void pixel_engine_free(PixelEngine *engine);
char *pixel_call(const char *name, const char *args_json);
void pixel_string_free(char *string);

#ifdef __cplusplus
}
#endif
