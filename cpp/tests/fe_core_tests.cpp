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

  /* 6. C++20 XPBD Cloth, Soft-Body Volume, PBF Liquid, Smooth Isosurface & Pyro */
  assert(fe_sim_backend_magic() == FE_SIM_CPP_BACKEND_MAGIC);
  assert(sim_solver_abi_version() == 2u);

  /* 6a. XPBD Cloth with aerodynamic wind & pinned top edge */
  float cloth_pos[12]  = {-1.0f, 1.0f, 0.0f,  1.0f, 1.0f, 0.0f, -1.0f, 0.0f, 0.0f,  1.0f, 0.0f, 0.0f};
  float cloth_prev[12] = {-1.0f, 1.0f, 0.0f,  1.0f, 1.0f, 0.0f, -1.0f, 0.0f, 0.0f,  1.0f, 0.0f, 0.0f};
  const float cloth_rest[12] = {-1.0f, 1.0f, 0.0f,  1.0f, 1.0f, 0.0f, -1.0f, 0.0f, 0.0f,  1.0f, 0.0f, 0.0f};
  const uint8_t cloth_pins[4] = {1, 1, 0, 0};
  const uint32_t cloth_edges[10] = {0, 1,  2, 3,  0, 2,  1, 3,  0, 3};
  float cloth_lens[5] = {2.0f, 2.0f, 1.0f, 1.0f, 2.2360679f};
  const float cloth_w[5] = {1.0f, 1.0f, 1.0f, 1.0f, 0.5f};
  const uint32_t cloth_faces[6] = {0, 2, 1,  1, 2, 3};
  const float cloth_bounds[6] = {-5.0f, -5.0f, -5.0f, 5.0f, 5.0f, 5.0f};

  for (int step = 0; step < 20; ++step) {
    assert(fe_sim_xpbd_deformable_step(
      cloth_pos, cloth_prev, cloth_rest, cloth_pins,
      cloth_edges, cloth_lens, cloth_w, 4, 5,
      cloth_faces, 2, nullptr, nullptr, 0,
      1.0f / 120.0f, 0.0f, -9.8f, 0.0f,
      0.04f, 0.85f, 0.0f, 0.95f, 0.9f, 0.0f, 0.0f, 0.08f,
      0.0f, 0.0f, 3.5f, 0.25f, step * 0.01f, 0.15f,
      0.01f, 8, cloth_bounds, 0.05f, 0.3f
    ) == 1);
  }
  /* Pinned vertices stay fixed; unpinned bottom billows forward (+Z) from wind */
  assert(nearf(cloth_pos[1], 1.0f, 1e-5f));
  assert(cloth_pos[8] > 0.002f && cloth_pos[11] > 0.002f);

  /* Scatter + welded smooth normals + wrinkle strain */
  const uint32_t vmap[4] = {0, 1, 2, 3};
  float r_pos[12] = {}, r_nrm[12] = {}, r_strain[4] = {};
  assert(fe_sim_scatter_mesh_and_normals(cloth_pos, cloth_rest, 4, vmap, 4, cloth_faces, 6, r_pos, r_nrm, r_strain) == 1);
  assert(fe::isfinitef(r_nrm[0] + r_nrm[1] + r_nrm[2]));

  /* 6b. PBF Liquid + Smooth Isosurface Reconstruction */
  float liq_pos[24] = {
    -0.12f, 0.0f, -0.12f,   0.12f, 0.0f, -0.12f,
    -0.12f, 0.0f,  0.12f,   0.12f, 0.0f,  0.12f,
    -0.12f, 0.22f,-0.12f,   0.12f, 0.22f,-0.12f,
    -0.12f, 0.22f, 0.12f,   0.12f, 0.22f, 0.12f
  };
  float liq_vel[24] = {};
  float liq_den[8] = {}, liq_prs[8] = {}, liq_foam[8] = {};
  uint8_t liq_act[8] = {1, 1, 1, 1, 1, 1, 1, 1};
  const float liq_bounds[6] = {-1.0f, -0.5f, -1.0f, 1.0f, 1.5f, 1.0f};

  assert(fe_sim_liquid_pbf_step(
    liq_pos, liq_vel, liq_den, liq_prs, liq_foam, liq_act,
    8, 1.0f / 60.0f, 0.08f, 1.0f, 0.45f, 1.8f, 0.02f, 0.25f, 0.15f, 2,
    0.0f, -9.8f, 0.0f, liq_bounds, 0.3f, 0.03f, 0
  ) == 1);

  float surf_pos[4096 * 3] = {};
  float surf_nrm[4096 * 3] = {};
  float surf_foam[4096 * 2] = {};
  uint32_t surf_idx[8192 * 3] = {};
  uint32_t surf_counts[2] = {};
  assert(fe_sim_reconstruct_liquid_mesh(
    liq_pos, liq_vel, liq_foam, liq_act, 8, liq_bounds,
    0.55f, 0.22f, 0.25f, 24, 2, 0,
    surf_pos, surf_nrm, surf_foam, 4096, surf_idx, 8192 * 3, surf_counts
  ) == 1);
  assert(surf_counts[0] >= 12 && surf_counts[1] >= 12);

  /* Timeline editing kernels */
  fe_anim_reset();
  assert(fe_anim_ensure_object(4, rest) == 1);
  fe_anim_insert_keyframe(4, FE_CH_POS_X, 0.0f, 0.0f, FE_INTERP_LINEAR);
  fe_anim_insert_keyframe(4, FE_CH_POS_X, 30.0f, 3.0f, FE_INTERP_LINEAR);
  fe_anim_insert_keyframe(4, FE_CH_POS_X, 60.0f, 6.0f, FE_INTERP_LINEAR);
  assert(fe_anim_edit_key(4, FE_CH_POS_X, 30.0f, 45.0f, 9.0f, 0.45f) == 1);
  assert(fe_anim_get_keyframe_count(4, FE_CH_POS_X) == 3);
  assert(nearf(fe_anim_evaluate_channel(4, FE_CH_POS_X, 45.0f, 0.0f, 250.0f), 9.0f, 1e-3f));
  assert(fe_anim_move_keys_in_range(4, 1u << FE_CH_POS_X, 40.0f, 50.0f, 5.0f) == 1);
  assert(nearf(fe_anim_evaluate_channel(4, FE_CH_POS_X, 50.0f, 0.0f, 250.0f), 9.0f, 1e-3f));
  assert(fe_anim_duplicate_keys_in_range(4, 1u << FE_CH_POS_X, 70.0f, 70.0f, 10.0f) == 0);
  assert(fe_anim_duplicate_keys_in_range(4, 1u << FE_CH_POS_X, 50.0f, 50.0f, 20.0f) == 1);
  assert(fe_anim_get_keyframe_count(4, FE_CH_POS_X) == 4);
  assert(fe_anim_delete_keys_in_range(4, 0xFFFFFFFFu, 0.0f, 10.0f) == 1);
  assert(fe_anim_get_keyframe_count(4, FE_CH_POS_X) == 3);

  const float curve_pts[9] = {0, 0, 0, 1, 2, 0, 2, 0, 0};
  float curve_out[64] = {};
  const uint32_t curve_n = fe_anim_catmull_rom(curve_pts, 3, 4, curve_out, 64);
  assert(curve_n == 9);
  assert(nearf(curve_out[0], 0.0f) && nearf(curve_out[4 * 3 + 1], 2.0f));
  assert(nearf(curve_out[8 * 3 + 0], 2.0f));

  /* Sampling, baking and simulation keyframe reduction */
  fe_anim_reset();
  assert(fe_anim_ensure_object(7, rest) == 1);
  fe_anim_insert_keyframe(7, FE_CH_POS_X, 0.0f, 0.0f, FE_INTERP_LINEAR);
  fe_anim_insert_keyframe(7, FE_CH_POS_X, 60.0f, 10.0f, FE_INTERP_LINEAR);

  float sampled[11 * 5] = {};
  assert(fe_anim_sample_object(7, 0.0f, 60.0f, 5, sampled, 55) == 5);
  assert(nearf(sampled[0], 0.0f));
  assert(nearf(sampled[4 * 11 + 0], 10.0f));
  assert(nearf(sampled[2 * 11 + 0], 5.0f, 0.05f));

  float channel_samples[3] = {};
  assert(fe_anim_sample_channel(7, FE_CH_POS_X, 0.0f, 60.0f, 3, channel_samples, 3) == 3);
  assert(nearf(channel_samples[2], 10.0f));

  float bake_input[11 * 3] = {};
  for (uint32_t i = 0; i < 3; ++i) {
    bake_input[i * 11 + FE_CH_POS_X] = static_cast<float>(i) * 5.0f;
    bake_input[i * 11 + FE_CH_SCL_X] = 1.0f;
  }
  assert(fe_anim_bake_samples(8, (1u << FE_CH_POS_X), 0.0f, 10.0f, bake_input, 3, FE_INTERP_LINEAR, 1e-3f) == 3);
  assert(fe_anim_get_keyframe_count(8, FE_CH_POS_X) == 3);
  assert(nearf(fe_anim_evaluate_channel(8, FE_CH_POS_X, 20.0f, 0.0f, 60.0f), 10.0f));

  const float sim_frames[3 * 2 * 3] = {
    0, 0, 0, 0, 0, 0,
    0.001f, 0, 0, 0, 0.001f, 0,
    0.5f, 0, 0, 0, 0.5f, 0
  };
  uint32_t kept_frames[8] = {};
  assert(fe_sim_bake_compress(sim_frames, 3, 2, 0.01f, kept_frames, 8) == 2);
  assert(kept_frames[0] == 0 && kept_frames[1] == 2);

  printf("All Final Effect C++20 Core Engine tests passed!\n");
  return 0;
}
