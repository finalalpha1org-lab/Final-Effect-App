#ifndef FE_ABI_H
#define FE_ABI_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(__wasm__)
  #define FE_EXPORT __attribute__((visibility("default")))
#elif defined(_WIN32)
  #define FE_EXPORT __declspec(dllexport)
#else
  #define FE_EXPORT __attribute__((visibility("default")))
#endif

/* =========================================================================
 * Final Effect 3D — Cross-Platform C++ Core Engine C ABI (v1)
 * Shared across WebAssembly (HTML/JS UI), Android NDK, iOS Clang & Desktop
 * ========================================================================= */

#define FE_CORE_ABI_VERSION 1u

/* Animation channel indices per scene object */
enum FEAnimChannel {
  FE_CH_POS_X = 0,
  FE_CH_POS_Y = 1,
  FE_CH_POS_Z = 2,
  FE_CH_ROT_X = 3, /* Euler degrees X */
  FE_CH_ROT_Y = 4, /* Euler degrees Y */
  FE_CH_ROT_Z = 5, /* Euler degrees Z */
  FE_CH_SCL_X = 6,
  FE_CH_SCL_Y = 7,
  FE_CH_SCL_Z = 8,
  FE_CH_EXTRA_A = 9,  /* Camera FOV or Light Intensity */
  FE_CH_EXTRA_B = 10, /* Roughness / Morph / Opacity */
  FE_CH_COUNT = 11
};

/* Keyframe interpolation modes */
enum FEInterpMode {
  FE_INTERP_BEZIER_SMOOTH = 0,
  FE_INTERP_LINEAR = 1,
  FE_INTERP_STEP = 2,
  FE_INTERP_EASE_IN = 3,
  FE_INTERP_EASE_OUT = 4,
  FE_INTERP_BOUNCE = 5
};

/* Track extrapolation modes */
enum FEExtrapolationMode {
  FE_EXTRAP_HOLD = 0,
  FE_EXTRAP_LOOP = 1,
  FE_EXTRAP_PINGPONG = 2
};

/* Procedural motion preset IDs */
enum FEMotionPreset {
  FE_PRESET_TURNTABLE = 0,
  FE_PRESET_FLOAT_HOVER = 1,
  FE_PRESET_BOUNCE = 2,
  FE_PRESET_PENDULUM = 3,
  FE_PRESET_CAMERA_ORBIT = 4,
  FE_PRESET_PULSE_SCALE = 5
};

/* Tone mapping operators */
enum FEToneMapMode {
  FE_TONEMAP_ACES = 0,
  FE_TONEMAP_AGX = 1,
  FE_TONEMAP_REINHARD = 2,
  FE_TONEMAP_FILMIC = 3,
  FE_TONEMAP_LINEAR = 4
};

/* Sculpt brush modes */
enum FESculptBrush {
  FE_BRUSH_DRAW = 0,
  FE_BRUSH_SMOOTH = 1,
  FE_BRUSH_INFLATE = 2,
  FE_BRUSH_PINCH = 3,
  FE_BRUSH_FLATTEN = 4,
  FE_BRUSH_GRAB = 5
};

/* ---- Core & Memory Management ---- */
FE_EXPORT uint32_t fe_core_abi_version(void);
FE_EXPORT uint32_t fe_malloc(uint32_t byte_size);
FE_EXPORT void     fe_free(uint32_t ptr);
FE_EXPORT void     fe_arena_reset(void);
FE_EXPORT uint32_t fe_heap_used_bytes(void);

/* ---- Keyframe Animation Engine ---- */
FE_EXPORT void     fe_anim_reset(void);
FE_EXPORT int32_t  fe_anim_ensure_object(uint32_t object_slot, const float* rest_channels_11);
FE_EXPORT int32_t  fe_anim_set_extrapolation(uint32_t object_slot, uint32_t extrap_mode);
FE_EXPORT uint32_t fe_anim_get_extrapolation(uint32_t object_slot);
FE_EXPORT int32_t  fe_anim_insert_keyframe(
  uint32_t object_slot,
  uint32_t channel,
  float frame,
  float value,
  uint32_t interp_mode
);
FE_EXPORT int32_t  fe_anim_remove_keyframe_at(
  uint32_t object_slot,
  uint32_t channel,
  float frame,
  float tolerance
);
FE_EXPORT void     fe_anim_clear_object(uint32_t object_slot);
FE_EXPORT uint32_t fe_anim_get_keyframe_count(uint32_t object_slot, uint32_t channel);
FE_EXPORT uint32_t fe_anim_get_total_keyframes(void);
FE_EXPORT uint32_t fe_anim_list_object_keyframes(
  uint32_t object_slot,
  uint32_t channel,
  float* out_frames_values_interp, /* [frame, value, interp] * max_out */
  uint32_t max_out
);
FE_EXPORT float    fe_anim_evaluate_channel(
  uint32_t object_slot,
  uint32_t channel,
  float frame,
  float range_start,
  float range_end
);
/* Evaluates all 11 channels + quaternion XYZW (15 floats total) for object_slot */
FE_EXPORT int32_t  fe_anim_evaluate_object(
  uint32_t object_slot,
  float frame,
  float range_start,
  float range_end,
  float* out_15
);
/* Generates editable keyframes for a motion preset */
FE_EXPORT int32_t  fe_anim_apply_preset(
  uint32_t object_slot,
  uint32_t preset_id,
  float start_frame,
  float end_frame,
  float amplitude,
  const float* base_channels_11
);
/* Serializes / restores all animation tracks to/from a compact float array */
FE_EXPORT uint32_t fe_anim_serialized_float_count(void);
FE_EXPORT uint32_t fe_anim_serialize(float* out_floats, uint32_t max_floats);
FE_EXPORT int32_t  fe_anim_deserialize(const float* in_floats, uint32_t float_count);

/* ---- Progressive C++ PBR Path Tracer & Post-Processing Render Engine ---- */
FE_EXPORT void     fe_render_scene_clear(void);
FE_EXPORT int32_t  fe_render_add_mesh(
  const float* positions_xyz,   /* vertex_count * 3 (world space) */
  const float* normals_xyz,     /* vertex_count * 3 (world space, nullable -> face normal) */
  const uint32_t* indices,      /* tri_count * 3 (nullable -> sequential triangles) */
  uint32_t vertex_count,
  uint32_t tri_count,
  float r, float g, float b,
  float roughness,
  float metalness,
  float emission,
  float opacity
);
FE_EXPORT void     fe_render_set_environment(
  uint32_t preset_id, /* 0=Studio, 1=City, 2=Forest, 3=Night, 4=Sunset */
  float sky_intensity,
  uint32_t shadow_catcher_enabled,
  float ground_y
);
FE_EXPORT void     fe_render_set_light(
  uint32_t light_index, /* 0..3 */
  uint32_t light_type,  /* 0=off, 1=point, 2=directional, 3=spot */
  float px, float py, float pz,
  float dx, float dy, float dz,
  float cr, float cg, float cb,
  float intensity,
  float radius_softness,
  float spot_cos_outer
);
FE_EXPORT void     fe_render_set_camera(
  float eye_x, float eye_y, float eye_z,
  float fwd_x, float fwd_y, float fwd_z,
  float right_x, float right_y, float right_z,
  float up_x, float up_y, float up_z,
  float fov_deg,
  float aspect,
  float aperture,
  float focus_dist
);
FE_EXPORT int32_t  fe_render_build_bvh(void);
FE_EXPORT uint32_t fe_render_get_triangle_count(void);
FE_EXPORT int32_t  fe_render_init_framebuffer(uint32_t width, uint32_t height);
FE_EXPORT void     fe_render_reset_accumulation(void);
FE_EXPORT uint32_t fe_render_trace_samples(
  uint32_t sample_count,
  uint32_t max_bounces,
  uint32_t tile_y_start,
  uint32_t tile_height
);
FE_EXPORT uint32_t fe_render_get_accum_samples(void);
FE_EXPORT uint32_t fe_render_resolve_rgba8(
  uint32_t tonemap_mode,
  float exposure,
  float contrast,
  float saturation,
  float temperature,
  float bloom_strength,
  float vignette,
  float chromatic_aberration,
  float film_grain
);
/* Returns byte offset to internal resolved RGBA8 pixel buffer (width * height * 4) */
FE_EXPORT uint32_t       fe_render_get_rgba8_ptr(void);
FE_EXPORT const uint8_t* fe_render_get_rgba8_native(void);

/* Post-processes an external RGBA8 buffer (e.g. WebGL Eevee capture) in-place in C++ */
FE_EXPORT int32_t  fe_postprocess_rgba8(
  uint8_t* rgba_pixels,
  uint32_t width,
  uint32_t height,
  uint32_t tonemap_mode,
  float exposure,
  float contrast,
  float saturation,
  float temperature,
  float bloom_strength,
  float vignette,
  float chromatic_aberration,
  float film_grain,
  uint32_t frame_seed
);

/* ---- Real-Time C++ Sculpt & Vertex/Weight Paint Kernel ---- */
FE_EXPORT uint32_t fe_sculpt_apply_brush(
  float* positions_xyz,
  float* normals_xyz,
  uint32_t vertex_count,
  uint32_t brush_mode,
  float hit_x, float hit_y, float hit_z,
  float normal_x, float normal_y, float normal_z,
  float delta_x, float delta_y, float delta_z,
  float radius,
  float strength,
  uint32_t symmetry_mask /* bit0=X, bit1=Y, bit2=Z */
);
FE_EXPORT void     fe_mesh_recompute_vertex_normals(
  const float* positions_xyz,
  const uint32_t* indices,
  uint32_t vertex_count,
  uint32_t tri_count,
  float* out_normals_xyz
);
FE_EXPORT uint32_t fe_vertex_paint_apply(
  const float* positions_xyz,
  float* colors_rgb,
  uint32_t vertex_count,
  float hit_x, float hit_y, float hit_z,
  float radius,
  float strength,
  float r, float g, float b,
  uint32_t symmetry_mask
);

/* ---- Mobile Multi-Touch Gesture Filter & Adaptive GPU Performance Governor ---- */
FE_EXPORT void     fe_touch_reset(void);
/* Feeds active touch points (1 or 2 pointers) and outputs smoothed gesture deltas:
 * out_8 = [orbit_dx, orbit_dy, pan_dx, pan_dy, pinch_scale_delta, twist_rad_delta, gesture_kind, confidence]
 */
FE_EXPORT int32_t  fe_touch_update(
  uint32_t pointer_count,
  float p0_x, float p0_y,
  float p1_x, float p1_y,
  float viewport_w, float viewport_h,
  float dt_sec,
  float* out_8
);

FE_EXPORT void     fe_perf_reset(void);
FE_EXPORT void     fe_perf_push_frame_ms(float frame_ms);
/* Returns recommended tier: 0 = Low (Battery/Mobile 60fps), 1 = Medium (Balanced), 2 = High (Pro/Desktop) */
FE_EXPORT uint32_t fe_perf_recommend_tier(uint32_t mode_override /* 0=auto, 1=low, 2=med, 3=high */);
/* out_6 = [avg_frame_ms, est_fps, recommended_dpr_scale, shadow_map_size, physics_substeps, recommended_tier] */
FE_EXPORT void     fe_perf_query_metrics(uint32_t mode_override, float device_dpr, float* out_6);

#ifdef __cplusplus
}
#endif

#endif /* FE_ABI_H */
