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
/* Forest worker scratch buffers: 32768 xyz records (x,z,rotation), classifications
 * -1 = out of range/invalid, -2 = mesh LOD, 0..3 = impostor azimuth. */
FE_EXPORT float* fe_forest_input_ptr(void);
FE_EXPORT int32_t* fe_forest_output_ptr(void);
FE_EXPORT int32_t fe_forest_classify(uint32_t count, float camera_x, float camera_z,
                                    float mesh_distance, float far_distance);
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

/* =========================================================================
 * Real-Time C++20 Physics, XPBD Cloth/Soft-Body, FLIP/PBF Liquid,
 * Narrow-Band Smooth Marching-Cubes Mesher & Turbulent Pyro Solver (ABI v2 + v3)
 * ========================================================================= */

#define FE_SIM_CPP_BACKEND_MAGIC 0x43505033u /* "CPP3" */

FE_EXPORT uint32_t fe_sim_backend_magic(void);
FE_EXPORT uint32_t sim_solver_abi_version(void);

/* Backwards-compatible ABI v2 exports (now 100% C++20 accelerated) */
FE_EXPORT int32_t sim_solver_deformable_step(
  float* positions,
  float* previous,
  const float* rest,
  const uint8_t* pinned,
  const uint32_t* edges,
  float* rest_lengths,
  const float* edge_weights,
  uint32_t node_count,
  uint32_t edge_count,
  float dt,
  float gravity,
  float damping,
  float stiffness,
  float goal_strength,
  float stretch_resistance,
  float compression_resistance,
  float plasticity,
  float collision_margin,
  uint32_t iterations,
  const float* bounds_6,
  float restitution,
  float friction
);

FE_EXPORT int32_t sim_solver_sph_step(
  float* positions,
  float* velocities,
  float* densities,
  float* pressures,
  float* forces,
  uint8_t* active,
  uint32_t particle_count,
  float dt,
  float mass,
  float rest_density,
  float smoothing_length,
  float pressure_k,
  float viscosity,
  float surface_tension,
  float gravity_x,
  float gravity_y,
  float gravity_z,
  const float* bounds_6,
  float restitution,
  float damping,
  uint32_t outflow
);

FE_EXPORT int32_t sim_solver_buoyant_tracer_step(
  float* positions,
  float* velocities,
  float* temperatures,
  float* ages,
  uint32_t particle_count,
  float dt,
  float gravity,
  float buoyancy,
  float drag,
  float heat_decay,
  float max_age,
  const float* bounds_6,
  float restitution
);

/* Houdini Vellum-Style C++20 XPBD Cloth & Volume-Preserving Soft-Body Step */
FE_EXPORT int32_t fe_sim_xpbd_deformable_step(
  float* positions,
  float* previous,
  const float* rest,
  const uint8_t* pinned,
  const uint32_t* edges,
  float* rest_lengths,
  const float* edge_weights,
  uint32_t node_count,
  uint32_t edge_count,
  const uint32_t* faces_u32,      /* nullable: surface_tri_count * 3 */
  uint32_t surface_tri_count,
  const uint32_t* volume_tets_u32,/* nullable: tet_count * 4 */
  const float* volume_rest_f32,   /* nullable: tet_count */
  uint32_t tet_count,
  float dt,
  float gravity_x,
  float gravity_y,
  float gravity_z,
  float damping,
  float stiffness,
  float goal_strength,
  float stretch_resistance,
  float compression_resistance,
  float volume_stiffness,
  float plasticity,
  float self_collision_radius,
  float wind_x,
  float wind_y,
  float wind_z,
  float wind_turbulence,
  float time_sec,
  float air_drag,
  float collision_margin,
  uint32_t iterations,
  const float* bounds_6,
  float restitution,
  float friction
);

/* Zero-copy scatter welded physics nodes -> render vertices + smooth normals + wrinkle strain */
FE_EXPORT int32_t fe_sim_scatter_mesh_and_normals(
  const float* node_positions,
  const float* node_rest,
  uint32_t node_count,
  const uint32_t* vertex_map,
  uint32_t render_vertex_count,
  const uint32_t* render_indices, /* nullable -> sequential triangles */
  uint32_t render_index_count,
  float* out_render_positions,
  float* out_render_normals,
  float* out_render_strain        /* nullable: render_vertex_count [-1..+1] */
);

/* LiquiGen / Houdini PBF-FLIP Spatial-Hashed C++20 Liquid + Whitewater Energy Step */
FE_EXPORT int32_t fe_sim_liquid_pbf_step(
  float* positions,
  float* velocities,
  float* densities,
  float* pressures,
  float* foam_energy,             /* nullable: particle_count [0..1] */
  uint8_t* active,
  uint32_t particle_count,
  float dt,
  float mass,
  float rest_density,
  float smoothing_length,
  float pressure_k,
  float viscosity,
  float surface_tension,
  float vorticity_strength,
  uint32_t pbf_iterations,
  float gravity_x,
  float gravity_y,
  float gravity_z,
  const float* bounds_6,
  float restitution,
  float damping,
  uint32_t outflow
);

/* C++20 Narrow-Band Filtered SDF + 256-Case Marching Cubes + Taubin Smoother */
FE_EXPORT int32_t fe_sim_reconstruct_liquid_mesh(
  const float* positions,
  const float* velocities,        /* nullable: particle_count * 3 */
  const float* foam_energy,       /* nullable: particle_count */
  const uint8_t* active,
  uint32_t particle_count,
  const float* bounds_6,
  float smoothing_length,
  float particle_mass,
  float iso_level,
  uint32_t target_cells,
  uint32_t smooth_iterations,
  uint32_t outflow_mode,
  float* out_positions,           /* max_vertices * 3 */
  float* out_normals,             /* max_vertices * 3 */
  float* out_foam_attr,           /* nullable: max_vertices * 2 [foam, speed] */
  uint32_t max_vertices,
  uint32_t* out_indices,          /* max_indices */
  uint32_t max_indices,
  uint32_t* out_counts_2          /* [vertex_count, index_count] */
);

/* EmberGen / LiquiGen-Style C++20 Curl-Noise Vorticity Pyro Step */
FE_EXPORT int32_t fe_sim_pyro_step(
  float* positions,
  float* velocities,
  float* temperatures,
  float* ages,
  uint8_t* active,
  uint32_t particle_count,
  float dt,
  float time_sec,
  float gravity,
  float buoyancy,
  float vorticity_turbulence,
  float drag,
  float heat_decay,
  float expansion_swirl,
  float max_age,
  const float* bounds_6,
  float restitution
);

/* =========================================================================
 * Gaea + Unreal Engine Class C++20 Landscaping, Geological Erosion,
 * 60Hz Tessendorf 2D-IFFT Ocean, Open-World Hydrology, Planet & Scatter Engine
 * ========================================================================= */

#define FE_LANDSCAPE_CPP_MAGIC 0x47414541u /* "GAEA" */

enum FETerrainBrushTool {
  FE_TERRAIN_BRUSH_RAISE = 0,
  FE_TERRAIN_BRUSH_LOWER = 1,
  FE_TERRAIN_BRUSH_FLATTEN = 2,
  FE_TERRAIN_BRUSH_SMOOTH = 3,
  FE_TERRAIN_BRUSH_TERRACE = 4,
  FE_TERRAIN_BRUSH_HYDRO_ERODE = 5,
  FE_TERRAIN_BRUSH_THERMAL_SCREE = 6,
  FE_TERRAIN_BRUSH_CLIFF_RIDGE = 7,
  FE_TERRAIN_BRUSH_ROCK_STAMP = 8,
  FE_TERRAIN_BRUSH_ROAD_RAMP = 9,
  FE_TERRAIN_BRUSH_PAINT = 10
};

FE_EXPORT uint32_t fe_landscape_backend_magic(void);

/* Persistent Zero-Copy Terrain Grid Arena (supports up to 512x512 -> 513x513 = 263,169 vertices) */
FE_EXPORT int32_t  fe_terrain_init(uint32_t segments_n, float world_size);
FE_EXPORT uint32_t fe_terrain_get_segments(void);
FE_EXPORT uint32_t fe_terrain_get_grid_width(void);
FE_EXPORT float*   fe_terrain_get_height_ptr(void);
FE_EXPORT float*   fe_terrain_get_normal_ptr(void);
FE_EXPORT float*   fe_terrain_get_color_ptr(void);
FE_EXPORT uint8_t* fe_terrain_get_splat_rgba_ptr(void);
FE_EXPORT uint8_t* fe_terrain_get_mat_index_ptr(void);
FE_EXPORT float*   fe_terrain_get_surf_weights_a_ptr(void);
FE_EXPORT float*   fe_terrain_get_surf_weights_b_ptr(void);
FE_EXPORT float*   fe_terrain_get_surf_weights_c_ptr(void);

/* Multi-Scale Gaea Geological Terrain Synthesis */
FE_EXPORT int32_t  fe_terrain_generate_gaea(
  float seed,
  uint32_t preset_mode, /* 0=Classic, 1=Alpine, 2=CanyonStrata, 3=Highlands, 4=Caldera, 5=Badlands */
  float height_scale,
  float ridge_sharpness,
  float warp_strength,
  float strata_strength,
  float strata_freq,
  uint32_t continental_mode,
  float base_lift,
  float mountain_boost
);

/* Lagrangian-Grid Droplet + Pipe Hydraulic Erosion with Flow & Alluvial Deposition Masks */
FE_EXPORT int32_t  fe_terrain_erode_hydraulic(
  uint32_t droplet_count,
  uint32_t max_lifetime,
  float inertia,
  float sediment_capacity,
  float erode_speed,
  float deposit_speed,
  float evaporation,
  float gravity,
  uint32_t brush_radius_cells,
  uint32_t seed
);

/* Angle-of-Repose Thermal Weathering & Talus / Scree Slumping */
FE_EXPORT int32_t  fe_terrain_erode_thermal(
  uint32_t iterations,
  float talus_angle_tan,
  float slump_rate
);

/* Tilted / Warped Sedimentary Strata & Canyon Outcrop Terracing */
/* ---- Eulerian smoke & fire (MAC grid) + dual isosurface ---- */
FE_EXPORT int32_t   fe_vol_init(uint32_t nx, uint32_t ny, uint32_t nz);
FE_EXPORT int32_t   fe_vol_reset(void);
FE_EXPORT uint32_t  fe_vol_grid_size(void);
FE_EXPORT int32_t   fe_vol_source(float cx, float cy, float cz, float radius, float heat, float density, float lift);
FE_EXPORT int32_t   fe_vol_step(float dt, float buoyancy, float vorticity, float dissipation, float cooling, uint32_t iterations);
FE_EXPORT float*    fe_vol_density_ptr(void);
FE_EXPORT float*    fe_vol_temperature_ptr(void);
FE_EXPORT float*    fe_vol_velocity_x_ptr(void);
FE_EXPORT float*    fe_vol_velocity_y_ptr(void);
FE_EXPORT float*    fe_vol_velocity_z_ptr(void);
FE_EXPORT float*    fe_vol_stats_ptr(void);
FE_EXPORT int32_t   fe_vol_surface(float iso, uint32_t max_verts);
FE_EXPORT float*    fe_vol_surface_positions_ptr(void);
FE_EXPORT float*    fe_vol_surface_normals_ptr(void);
FE_EXPORT uint32_t* fe_vol_surface_indices_ptr(void);
FE_EXPORT uint32_t  fe_vol_surface_index_count(void);

/* Temporal filter applied to the accepted density / temperature fields.
   0 disables it, 0.95 is the softest setting. */
FE_EXPORT int32_t   fe_vol_set_temporal(float amount);
FE_EXPORT float     fe_vol_temporal(void);

/* Seamless detail-noise tile for the volume shader (RGBA8, size x size).
   size 16..128, octaves 1..6; returns 0 ok / -3 invalid size. */
FE_EXPORT int32_t   fe_vol_noise_generate(uint32_t size, uint32_t seed, uint32_t octaves);
FE_EXPORT uint32_t  fe_vol_noise_ptr(void);
FE_EXPORT uint32_t  fe_vol_noise_size(void);

/* Terrain-aware natural scatter candidates (water/slope filtered, clumped) */
FE_EXPORT int32_t  fe_terrain_scatter_natural(
  uint32_t count,
  float spread,
  uint32_t seed,
  float water_level,
  float max_slope,
  float clump,
  float patch_scale
);

FE_EXPORT int32_t  fe_terrain_apply_strata(
  float strata_height,
  float strata_strength,
  float tilt_x,
  float tilt_z,
  float warp_amp
);

/* Dirty-Rect Sub-Millisecond Normal, Gaea Splat (Flow/Deposit/Talus/Curvature) & Biome Color Rebuilder */
FE_EXPORT int32_t  fe_terrain_rebuild_region(
  uint32_t x0,
  uint32_t x1,
  uint32_t z0,
  uint32_t z1,
  float seed,
  float water_level,
  float rock_slope,
  float snow_line,
  uint32_t biome_id,
  const float* palette_18 /* 6 * RGB */
);

FE_EXPORT void fe_terrain_compute_normals(void);
FE_EXPORT int32_t fe_terrain_set_palette(const float* pal, uint32_t count, float seed, float water, float rock, float snow, uint32_t desert);
FE_EXPORT int32_t fe_terrain_set_paint_colors(const uint8_t* rgb, uint32_t count);
FE_EXPORT int32_t fe_terrain_generate_layered(float seed, float hs, uint32_t continental, float base, float mountain);
FE_EXPORT int32_t fe_terrain_compute_colors(uint32_t x0, uint32_t x1, uint32_t z0, uint32_t z1);
FE_EXPORT int32_t fe_terrain_erode_brush(float x,float z,float radius,float strength,float seed);
/* Jittered scatter candidate batch: C++ samples the heightfield + slopes so the
   JS side only runs biome/occupancy rules per point. Writes 4 floats per point:
   x, z, height, slope. */
FE_EXPORT float*   fe_terrain_scatter_out_ptr(void);
FE_EXPORT int32_t  fe_terrain_scatter_batch(uint32_t count, float spread, uint32_t seed);
FE_EXPORT float    fe_terrain_sample_height(float world_x, float world_z);
FE_EXPORT void     fe_terrain_sample_normal(float world_x, float world_z, float alignment, float* out_n3);

/* --- Open World streamed generation, scheduling and hydrology (C++ kernels) --- */
FE_EXPORT float*  fe_ow_height_ptr(void);
FE_EXPORT float*  fe_ow_surface_ptr(void);
FE_EXPORT int32_t* fe_ow_plan_cells_ptr(void);
FE_EXPORT float*  fe_ow_plan_distance_ptr(void);
FE_EXPORT int32_t* fe_ow_river_meta_ptr(void);
FE_EXPORT float*  fe_ow_river_points_ptr(void);
FE_EXPORT float*  fe_ow_hydro_input_ptr(void);
FE_EXPORT float*  fe_ow_hydro_field_ptr(void);

FE_EXPORT int32_t fe_ow_set_params(float seed, float mountain_height, float water_coverage,
                                   float world_half, float sea_level, float blend,
                                   const float* biome_mix4);
FE_EXPORT float   fe_ow_height_at(float world_x, float world_z);
FE_EXPORT int32_t fe_ow_biome_weights_at(float world_x, float world_z, float height, float* out4);
/* Fills the resident (segments+1)^2 height grid for one streamed chunk. */
FE_EXPORT int32_t fe_ow_height_grid(uint32_t segments, float origin_x, float origin_z, float chunk_size);
/* Fills 12 blended surface weights per vertex from the resident height grid. */
FE_EXPORT int32_t fe_ow_surface_grid(uint32_t segments, float origin_x, float origin_z, float chunk_size);
/* Nearest-first chunk ring for the stream scheduler: cx, cz, ring distance^2. */
FE_EXPORT int32_t fe_ow_plan_chunks(int32_t center_cx, int32_t center_cz, uint32_t radius,
                                    float chunk_size, float world_half);
/* Bulk foliage terrain-LOD classification: 0 = full, 1 = low tier, -1 = culled. */
FE_EXPORT int8_t* fe_lod_out_ptr(void);
FE_EXPORT int32_t fe_lod_classify(uint32_t count, const float* xyz, float cam_x, float cam_y,
                                  float cam_z, float full_distance, uint32_t ground_cover);
/* Copies the JS height grid, smooths it and builds a priority-flood drainage graph. */
FE_EXPORT int32_t fe_ow_hydro_set_grid(uint32_t n, float span, float sea_level);
/* Traces downhill river polylines; returns the river count (-1 on bad input). */
FE_EXPORT int32_t fe_ow_hydro_trace(uint32_t max_rivers, float min_length, float spacing, uint32_t seed);

/* Unreal Engine 5 / Gaea Continuous Stroke Terrain Sculpt & Surface Brush */
FE_EXPORT int32_t  fe_terrain_brush_stroke(
  uint32_t tool_id,
  float from_x,
  float from_z,
  float to_x,
  float to_z,
  float radius,
  float strength,
  float dt,
  float flatten_target,
  uint32_t paint_id,
  uint32_t pbr_paint_mode,
  float seed,
  uint32_t* out_dirty_rect_4 /* [x0, x1, z0, z1] */
);

/* 60Hz C++20 3-Cascade Tessendorf Phillips/JONSWAP 2D-IFFT Ocean + Jacobian Crest Foam */
FE_EXPORT int32_t  fe_ocean_configure(
  uint32_t resolution,
  float len0,
  float len1,
  float len2,
  float wind_speed,
  float wind_dir_deg,
  uint32_t seed
);
FE_EXPORT int32_t  fe_ocean_update(
  float time_sec,
  float amplitude,
  float choppiness,
  float max_height_encode,
  float max_displace_encode
);
FE_EXPORT float*   fe_ocean_field_ptr(void);
FE_EXPORT uint32_t fe_ocean_resolution(void);
FE_EXPORT uint8_t* fe_ocean_get_cascade_rgba8_ptr(uint32_t cascade_idx);
FE_EXPORT float*   fe_ocean_get_cascade_foam_ptr(uint32_t cascade_idx);
FE_EXPORT float*   fe_ocean_get_cascade_float4_ptr(uint32_t cascade_idx);
FE_EXPORT int32_t  fe_ocean_ifft2d_f32(float* real, float* imag, uint32_t n);

/* C++20 Open-World Chunk Height + 12-Surface Splat + Priority-Flood Watershed Hydrology */
FE_EXPORT int32_t  fe_ow_generate_chunk(
  int32_t cx,
  int32_t cz,
  float chunk_size,
  uint32_t segments,
  float world_half,
  float seed,
  float mountain_height,
  float water_coverage,
  float sea_level,
  float blend,
  const float* biome_mix_4,
  float* out_heights,
  float* out_surface_weights_12,
  float* out_min_max_2
);

FE_EXPORT int32_t  fe_ow_priority_flood_hydrology(
  const float* in_heights,
  uint32_t grid_n,
  float cell_size,
  float sea_level,
  float* out_filled_heights,
  int32_t* out_parent_idx,
  float* out_flow_accum
);

/* C++20 Spatial-Hashed Biome Scatter & Seabed / Spherical Planet / Celestial Kernels */
FE_EXPORT uint32_t fe_scatter_generate_biome(
  const float* heights,
  uint32_t grid_w,
  float origin_x,
  float origin_z,
  float span_size,
  float sea_level,
  float snow_line,
  float clustering,
  uint32_t seed,
  const float* species_rules_4, /* [max_slope, spacing_radius, weight, base_scale] * species_count */
  uint32_t species_count,
  uint32_t target_budget,
  float* out_instances_8,       /* [x, y, z, scale, rotY, aspect, brightness, species_idx] */
  uint32_t max_instances
);

FE_EXPORT int32_t  fe_seabed_build(
  uint32_t radial_rings,
  uint32_t angular_segs,
  uint32_t continental_mode,
  float seed,
  float depth_offset,
  float sandbars,
  float roughness,
  float base_lift,
  float mtn_boost,
  float height_scale,
  float rock_slope,
  float snow_line,
  const float* palette_18,
  float* out_pos_xyz,
  float* out_norm_xyz,
  float* out_col_rgb,
  float* out_bathymetry_257
);

FE_EXPORT int32_t  fe_planet_generate_rgba(
  uint32_t width,
  uint32_t height,
  float seed,
  float continent_scale,
  float mountain_amp,
  uint8_t* out_rgba
);

FE_EXPORT void     fe_celestial_moon_ephemeris(
  float time_angle,
  float global_az_deg,
  float az_offset_deg,
  float orbit_pos_deg,
  float phase_deg,
  float* out_7
);

/* ---- Modifier Kernel Session (C++ geometry modifiers) ----
 * The JS editor writes an indexed triangle mesh into this session and calls a
 * kernel. Every kernel reads the session mesh, writes the result back into the
 * session (positions, uv, indices, normals) and updates the counts. JS only
 * marshals buffers and uploads the result to the GPU.
 *
 * Session buffers live in a dedicated arena inside the core, so they never
 * invalidate pointers handed to the renderer or the simulation.
 * Return codes: 0 = ok, -1 = session missing, -2 = capacity exceeded,
 *               -3 = invalid input, -4 = kernel produced an empty mesh.
 */
FE_EXPORT int32_t  fe_mod_begin(uint32_t vert_capacity, uint32_t tri_capacity, uint32_t has_uv);
FE_EXPORT uint32_t fe_mod_counts_ptr(void);
FE_EXPORT uint32_t fe_mod_in_pos_ptr(void);
FE_EXPORT uint32_t fe_mod_in_uv_ptr(void);
FE_EXPORT uint32_t fe_mod_in_idx_ptr(void);
FE_EXPORT uint32_t fe_mod_normals_ptr(void);
FE_EXPORT void     fe_mod_set_counts(uint32_t vert_count, uint32_t tri_count);
FE_EXPORT int32_t  fe_mod_weld(float epsilon);
FE_EXPORT int32_t  fe_mod_smooth(uint32_t iterations, float factor, int32_t volume_preserving, int32_t boundary_mode);
FE_EXPORT int32_t  fe_mod_mirror(uint32_t axis_mask, int32_t clipping, float merge_epsilon);
FE_EXPORT int32_t  fe_mod_solidify(float thickness, float offset, int32_t rim, int32_t even_thickness);
FE_EXPORT int32_t  fe_mod_displace(float strength, float midlevel, float frequency, uint32_t seed, uint32_t octaves, uint32_t direction);
FE_EXPORT int32_t  fe_mod_wave(float height, float width, float speed, float time, uint32_t axis, float phase);
FE_EXPORT int32_t  fe_mod_cast(uint32_t shape, float factor, float radius, float size);
FE_EXPORT int32_t  fe_mod_twist(float strength, uint32_t axis);
FE_EXPORT int32_t  fe_mod_array(uint32_t count, float ox, float oy, float oz, float rx, float ry, float rz, float rotate_per_step_deg);
FE_EXPORT int32_t  fe_mod_subdivide(uint32_t levels);
FE_EXPORT int32_t  fe_mod_decimate(float ratio, int32_t preserve_boundary);

/* ---- Session deformation kernels: FFD lattice, armature skinning, surface
 * deform and shrinkwrap. JS only copies buffers; all vertex maths runs here.
 *
 * The editor uploads the deforming mesh into the modifier session, uploads an
 * optional target mesh and a 4x4 relative matrix, then calls one kernel.
 * Return codes match the session kernels above (0 ok, -1 missing session,
 * -2 capacity, -3 invalid input, -4 empty result).
 */
FE_EXPORT uint32_t fe_mod_matrix_ptr(void);        /* 16 floats, column-major */
FE_EXPORT uint32_t fe_mod_target_counts_ptr(void); /* [vertex_count, tri_count] */
FE_EXPORT uint32_t fe_mod_target_pos_ptr(void);    /* vertex_count * 3 */
FE_EXPORT uint32_t fe_mod_target_idx_ptr(void);    /* tri_count * 3 */
FE_EXPORT int32_t  fe_mod_target_begin(uint32_t vert_count, uint32_t tri_count);

/* Barycentric surface deform: bind the session mesh to the target surface. */
FE_EXPORT int32_t  fe_mod_sd_bind(void);
/* Restore a previously bound surface-deform state for the session mesh. */
FE_EXPORT int32_t  fe_mod_sd_upload(uint32_t vert_count, uint32_t tri_count);
FE_EXPORT int32_t  fe_mod_sd_apply(float strength);
FE_EXPORT uint32_t fe_mod_sd_ordinal_ptr(void); /* u32 per vertex */
FE_EXPORT uint32_t fe_mod_sd_bary_ptr(void);    /* 3 floats per vertex */
FE_EXPORT uint32_t fe_mod_sd_scalars_ptr(void); /* [normal_offset, ref_scale] per vertex */
FE_EXPORT uint32_t fe_mod_sd_tris_ptr(void);    /* compact triangle list, 3 u32 each */
FE_EXPORT uint32_t fe_mod_sd_tri_count(void);

/* Bernstein free-form-deformation lattice cage + evaluator. */
FE_EXPORT int32_t  fe_mod_lattice_cage(uint32_t nx, uint32_t ny, uint32_t nz, float pad_ratio);
FE_EXPORT int32_t  fe_mod_lattice_alloc(uint32_t point_count);
FE_EXPORT uint32_t fe_mod_lattice_rest_ptr(void);   /* (nx+1)(ny+1)(nz+1) * 3 */
FE_EXPORT uint32_t fe_mod_lattice_deform_ptr(void); /* (nx+1)(ny+1)(nz+1) * 3 */
FE_EXPORT int32_t  fe_mod_lattice_apply(uint32_t nx, uint32_t ny, uint32_t nz, float strength);

/* Heat-weighted dual-quaternion armature skinning around the mesh mid joint. */
FE_EXPORT int32_t  fe_mod_armature(float influence, int32_t preserve_volume, float bend_deg, float twist_deg);

/* Nearest-surface / above-surface / outside-surface shrinkwrap projection.
 * mode: 0 = On Surface, 1 = Above Surface, 2 = Outside Surface. */
FE_EXPORT int32_t  fe_mod_shrinkwrap(uint32_t mode, float offset);

/* ---- Heavy 3D Workspace Geometry Kernels (QEM Decimation & Spatial Shrinkwrap) ---- */
FE_EXPORT int32_t  fe_geo_qem_decimate(
  const float* in_pos_xyz,
  uint32_t in_vert_count,
  const uint32_t* in_tris_u32,
  uint32_t in_tri_count,
  float target_ratio,
  float* out_pos_xyz,
  uint32_t* out_tris_u32,
  uint32_t* out_counts_2 /* [out_vert_count, out_tri_count] */
);

FE_EXPORT int32_t  fe_geo_spatial_shrinkwrap(
  const float* src_pos_xyz,
  const float* src_norm_xyz, /* nullable */
  uint32_t src_vert_count,
  const float* tgt_tri_abc_9, /* tgt_tri_count * 9 floats */
  uint32_t tgt_tri_count,
  uint32_t mode,              /* 0=NearestSurface, 1=AboveSurface, 2=NearestVertex */
  float offset,
  float* out_pos_xyz
);

#ifdef __cplusplus
}
#endif

#endif /* FE_ABI_H */
