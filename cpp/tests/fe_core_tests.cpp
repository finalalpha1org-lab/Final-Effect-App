#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"
#include <assert.h>
#include <stdio.h>

static bool nearf(float a, float b, float eps = 1e-3f) {
  return fe::absf(a - b) <= eps;
}

int main() {
  /* 1. ABI & Math accuracy */
  assert(fe_core_abi_version() == FE_CORE_ABI_VERSION);
  assert(nearf(fe::sinf(0.0f), 0.0f, 1e-5f));
  assert(nearf(fe::sinf(fe::kHalfPi), 1.0f, 1e-5f));
  assert(nearf(fe::cosf(fe::kPi), -1.0f, 1e-5f));
  assert(nearf(fe::powf(2.0f, 3.0f), 8.0f, 1e-3f));

  /* 2. Keyframe Animation Engine */
  fe_anim_reset();
  float rest[FE_CH_COUNT] = {0, 0, 0, 0, 0, 0, 1, 1, 1, 50, 0.5f};
  assert(fe_anim_ensure_object(0, rest) == 1);
  fe_anim_insert_keyframe(0, FE_CH_POS_X, 0.0f, 0.0f, FE_INTERP_BEZIER_SMOOTH);
  fe_anim_insert_keyframe(0, FE_CH_POS_X, 60.0f, 10.0f, FE_INTERP_BEZIER_SMOOTH);
  assert(fe_anim_get_keyframe_count(0, FE_CH_POS_X) == 2);

  float mid_x = fe_anim_evaluate_channel(0, FE_CH_POS_X, 30.0f, 0.0f, 250.0f);
  assert(nearf(mid_x, 5.0f, 0.05f));

  float eval15[15] = {};
  assert(fe_anim_evaluate_object(0, 60.0f, 0.0f, 250.0f, eval15) == 1);
  assert(nearf(eval15[FE_CH_POS_X], 10.0f, 1e-3f));
  assert(nearf(eval15[FE_CH_SCL_X], 1.0f, 1e-3f));

  /* Serialization roundtrip */
  uint32_t needed = fe_anim_serialized_float_count();
  assert(needed > 3);
  float blob[512];
  uint32_t written = fe_anim_serialize(blob, 512);
  assert(written == needed);
  fe_anim_reset();
  assert(fe_anim_get_total_keyframes() == 0);
  assert(fe_anim_deserialize(blob, written) == 2);
  assert(nearf(fe_anim_evaluate_channel(0, FE_CH_POS_X, 60.0f, 0.0f, 250.0f), 10.0f, 1e-3f));

  /* Preset generation */
  assert(fe_anim_apply_preset(1, FE_PRESET_BOUNCE, 0.0f, 120.0f, 1.0f, rest) > 0);
  assert(fe_anim_get_extrapolation(1) == FE_EXTRAP_LOOP);

  /* 3. BVH PBR Path Tracer & Post-Processing */
  fe_render_scene_clear();
  const float tri_pos[9] = {-1.5f, 0.0f, 0.0f,  1.5f, 0.0f, 0.0f,  0.0f, 2.5f, 0.0f};
  const uint32_t tri_idx[3] = {0, 1, 2};
  assert(fe_render_add_mesh(tri_pos, nullptr, tri_idx, 3, 1, 0.85f, 0.25f, 0.2f, 0.35f, 0.1f, 0.0f, 1.0f) == 1);
  assert(fe_render_get_triangle_count() == 1);
  assert(fe_render_build_bvh() >= 1);
  fe_render_set_environment(0, 1.1f, 1, -0.002f);
  fe_render_set_light(0, 2, 0.0f, 10.0f, 10.0f, -0.4f, -0.8f, -0.4f, 1.0f, 0.96f, 0.9f, 2.4f, 0.25f, 0.5f);
  fe_render_set_camera(0.0f, 1.2f, 5.0f,  0.0f, 0.0f, -1.0f,  1.0f, 0.0f, 0.0f,  0.0f, 1.0f, 0.0f, 45.0f, 1.0f, 0.0f, 5.0f);
  assert(fe_render_init_framebuffer(32, 32) == 1);
  assert(fe_render_trace_samples(2, 2, 0, 32) == 2);
  fe_render_resolve_rgba8(FE_TONEMAP_ACES, 1.25f, 1.05f, 1.1f, 0.05f, 0.25f, 0.2f, 0.0f, 0.02f);
  const uint8_t* px = fe_render_get_rgba8_native();
  uint32_t non_black = 0;
  for (uint32_t i = 0; i < 32 * 32; ++i) {
    if (px[i * 4 + 0] > 5 || px[i * 4 + 1] > 5 || px[i * 4 + 2] > 5) ++non_black;
    assert(px[i * 4 + 3] == 255);
  }
  assert(non_black > 900);

  /* 4. Sculpt & Symmetry Brush */
  float vpos[6] = {-0.5f, 0.0f, 0.0f,  0.5f, 0.0f, 0.0f};
  float vnrm[6] = { 0.0f, 1.0f, 0.0f,  0.0f, 1.0f, 0.0f};
  uint32_t moved = fe_sculpt_apply_brush(vpos, vnrm, 2, FE_BRUSH_DRAW, 0.5f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.4f, 0.8f, 1u);
  assert(moved == 2);
  assert(vpos[1] > 0.01f && nearf(vpos[1], vpos[4], 1e-4f));

  /* 5. Mobile Multi-Touch & GPU Governor */
  fe_touch_reset();
  float g8[8] = {};
  fe_touch_update(2, 100.0f, 200.0f, 200.0f, 200.0f, 400.0f, 800.0f, 0.016f, g8);
  fe_touch_update(2, 90.0f,  200.0f, 210.0f, 200.0f, 400.0f, 800.0f, 0.016f, g8);
  assert(g8[4] > 0.0f && nearf(g8[6], 2.0f));

  fe_perf_reset();
  for (int i = 0; i < 20; ++i) fe_perf_push_frame_ms(33.0f);
  assert(fe_perf_recommend_tier(0) == 0);
  for (int i = 0; i < 40; ++i) fe_perf_push_frame_ms(12.0f);
  assert(fe_perf_recommend_tier(0) == 2);

  printf("All Final Effect C++20 Core Engine tests passed!\n");
  return 0;
}
