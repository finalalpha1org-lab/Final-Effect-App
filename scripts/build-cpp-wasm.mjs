import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const CPP_SOURCES = [
  'cpp/src/fe_wasm_exports.cpp',
  'cpp/src/fe_animation.cpp',
  'cpp/src/fe_renderer.cpp',
  'cpp/src/fe_sculpt_touch.cpp',
  'cpp/src/fe_simulation.cpp',
  'cpp/src/fe_landscape.cpp',
  'cpp/src/fe_openworld.cpp',
  'cpp/src/fe_ocean.cpp',
  'cpp/src/fe_volumetrics.cpp',
  'cpp/src/fe_modifiers.cpp',
  'cpp/src/fe_surface.cpp',
  'cpp/src/fe_flora.cpp',
  'cpp/src/fe_climate.cpp'
];

const REQUIRED_EXPORTS = [
  'memory',
  'fe_core_abi_version',
  'fe_malloc',
  'fe_arena_reset',
  'fe_anim_reset',
  'fe_anim_insert_keyframe',
  'fe_anim_evaluate_object',
  'fe_anim_apply_preset',
  'fe_anim_serialize',
  'fe_anim_deserialize',
  'fe_render_scene_clear',
  'fe_render_add_mesh',
  'fe_render_build_bvh',
  'fe_render_init_framebuffer',
  'fe_render_trace_samples',
  'fe_render_resolve_rgba8',
  'fe_postprocess_rgba8',
  'fe_sculpt_apply_brush',
  'fe_mesh_recompute_vertex_normals',
  'fe_vertex_paint_apply',
  'fe_touch_update',
  'fe_perf_push_frame_ms',
  'fe_perf_query_metrics',
  'fe_sim_backend_magic',
  'sim_solver_abi_version',
  'sim_solver_deformable_step',
  'sim_solver_sph_step',
  'sim_solver_buoyant_tracer_step',
  'fe_sim_xpbd_deformable_step',
  'fe_sim_scatter_mesh_and_normals',
  'fe_sim_liquid_pbf_step',
  'fe_sim_reconstruct_liquid_mesh',
  'fe_sim_pyro_step',
  'fe_forest_input_ptr',
  'fe_forest_output_ptr',
  'fe_forest_classify',
  'fe_terrain_erode_brush',
  'fe_terrain_compute_normals',
  'fe_terrain_set_palette',
  'fe_terrain_set_paint_colors',
  'fe_terrain_generate_layered',
  'fe_terrain_compute_colors',
  'fe_terrain_erode_hydraulic',
  'fe_terrain_erode_thermal',
  'fe_terrain_scatter_out_ptr',
  'fe_terrain_scatter_batch',
  'fe_terrain_apply_strata',
  'fe_terrain_scatter_natural',
  'fe_ow_height_ptr',
  'fe_ow_surface_ptr',
  'fe_ow_set_params',
  'fe_ow_height_at',
  'fe_ow_biome_weights_at',
  'fe_ow_height_grid',
  'fe_ow_surface_grid',
  'fe_ow_plan_chunks',
  'fe_ow_hydro_set_grid',
  'fe_ow_hydro_trace',
  'fe_lod_classify',
  'fe_lod_out_ptr',
  'fe_ocean_field_ptr',
  'fe_ocean_configure',
  'fe_ocean_update',
  'fe_ocean_get_cascade_foam_ptr',
  'fe_vol_init','fe_vol_reset','fe_vol_grid_size','fe_vol_source','fe_vol_step',
  'fe_vol_density_ptr','fe_vol_temperature_ptr','fe_vol_velocity_x_ptr','fe_vol_velocity_y_ptr',
  'fe_vol_velocity_z_ptr','fe_vol_stats_ptr','fe_vol_surface','fe_vol_surface_positions_ptr',
  'fe_vol_surface_normals_ptr','fe_vol_surface_indices_ptr','fe_vol_surface_index_count',
  'fe_vol_noise_generate','fe_vol_noise_ptr','fe_vol_noise_size',
  'fe_vol_set_temporal','fe_vol_temporal',
  'fe_mod_begin','fe_mod_counts_ptr','fe_mod_in_pos_ptr','fe_mod_in_uv_ptr','fe_mod_in_idx_ptr',
  'fe_mod_normals_ptr','fe_mod_set_counts','fe_mod_weld','fe_mod_smooth','fe_mod_mirror',
  'fe_mod_solidify','fe_mod_displace','fe_mod_wave','fe_mod_cast','fe_mod_twist','fe_mod_array',
  'fe_mod_subdivide','fe_mod_decimate',
  'fe_mod_matrix_ptr','fe_mod_target_begin','fe_mod_target_counts_ptr','fe_mod_target_pos_ptr',
  'fe_mod_target_idx_ptr','fe_mod_sd_bind','fe_mod_sd_upload','fe_mod_sd_apply',
  'fe_mod_sd_ordinal_ptr','fe_mod_sd_bary_ptr','fe_mod_sd_scalars_ptr','fe_mod_sd_tris_ptr',
  'fe_mod_sd_tri_count','fe_mod_lattice_cage','fe_mod_lattice_alloc','fe_mod_lattice_rest_ptr',
  'fe_mod_lattice_deform_ptr','fe_mod_lattice_apply','fe_mod_armature','fe_mod_shrinkwrap',
  'fe_anim_edit_key','fe_anim_delete_keys_in_range','fe_anim_move_keys_in_range',
  'fe_anim_duplicate_keys_in_range','fe_anim_catmull_rom',
  'fe_anim_sample_object','fe_anim_sample_channel','fe_anim_bake_samples','fe_sim_bake_compress',
  /* Landscape surface realism: measured PBR + tileable micro-structure */
  'fe_surface_pbr','fe_surface_count','fe_surface_detail','fe_surface_detail_ptr',
  'fe_surface_detail_size','fe_water_optical','fe_surface_wind_roughness','fe_surface_snow_albedo',
  /* Flora realism: grown trees and ported rock meshes */
  'fe_flora_tree','fe_flora_rock','fe_flora_vert_count','fe_flora_index_count','fe_flora_leaf_count',
  'fe_flora_pos_ptr','fe_flora_nrm_ptr','fe_flora_uv_ptr','fe_flora_col_ptr','fe_flora_rnd_ptr',
  'fe_flora_cen_ptr','fe_flora_idx_ptr','fe_flora_leaf_ptr','fe_flora_species_info',
  'fe_flora_species_count','fe_flora_rock_kind_count',
  /* Skeletal wind channels + the fern L-system (fe_flora.cpp) */
  'fe_flora_sway_ptr','fe_flora_phase_ptr','fe_flora_leaf_stride',
  'fe_flora_lsystem','fe_flora_lsystem_len','fe_flora_lsystem_word','fe_flora_lsystem_rules',
  'fe_flora_lsystem_load','fe_flora_lsystem_run','fe_flora_lsystem_plant',
  /* Climate & weather: seeded temperature / moisture / fronts / hazards */
  'fe_climate_init','fe_climate_ready','fe_climate_set_clock','fe_climate_set_season',
  'fe_climate_step','fe_climate_clock','fe_climate_sea_level_temp','fe_climate_snow_line',
  'fe_climate_at','fe_climate_weather','fe_climate_biome','fe_climate_biome_count',
  'fe_climate_biome_on_slope','fe_climate_tornado','fe_climate_rankine','fe_climate_tsunami'
];

/* Zig can be installed as a binary (brew/ziglang pip shim) or only as the
 * `ziglang` Python module used by CI. Probe both so a checkout can always
 * rebuild the full engine instead of silently validating an older artifact. */
function findZigCompiler() {
  const candidates = [
    { cmd: '/tmp/zig_pkg/ziglang/zig', args: [] },
    { cmd: 'zig', args: [] },
    { cmd: 'python3', args: ['-m', 'ziglang'] },
    { cmd: 'python', args: ['-m', 'ziglang'] }
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.cmd, [...candidate.args, 'version'], { stdio: 'ignore' });
      return candidate;
    } catch {}
  }
  return null;
}

const zig = findZigCompiler();
if (zig) {
  execFileSync(zig.cmd, [...zig.args, 'c++',
    '-std=c++20',
    '-O3',
    '-fno-builtin',
    '-target', 'wasm32-freestanding',
    '-nostdlib',
    '-fno-exceptions',
    '-fno-rtti',
    '-Wl,--no-entry',
    '-Wl,--export-dynamic',
    '-Wl,--export-memory',
    '-Wl,--export=__heap_base',
    '-Wl,--export=__wasm_call_ctors',
    ...CPP_SOURCES,
    '-o', 'wasm/fe_core_engine.wasm'
  ], { stdio: 'inherit' });
  copyFileSync('wasm/fe_core_engine.wasm', 'fe_core_engine.wasm');
  console.log('Compiled C++20 Core Engine to wasm/fe_core_engine.wasm via Clang/Zig.');
} else if (existsSync('wasm/fe_core_engine.wasm') && !existsSync('fe_core_engine.wasm')) {
  copyFileSync('wasm/fe_core_engine.wasm', 'fe_core_engine.wasm');
}

const wasmBytes = readFileSync('wasm/fe_core_engine.wasm');
if (wasmBytes.length < 8 || wasmBytes.subarray(0, 4).toString('hex') !== '0061736d') {
  throw new Error('fe_core_engine.wasm failed WebAssembly magic header check.');
}
const mod = new WebAssembly.Module(wasmBytes);
const imports = WebAssembly.Module.imports(mod);
if (imports.length !== 0) {
  throw new Error(`fe_core_engine.wasm must be freestanding (0 imports), got ${imports.length}.`);
}
const expNames = new Set(WebAssembly.Module.exports(mod).map(e => e.name));
for (const req of REQUIRED_EXPORTS) {
  if (!expNames.has(req)) throw new Error(`fe_core_engine.wasm missing required export: ${req}`);
}
const inst = new WebAssembly.Instance(mod, {});
const abi = inst.exports.fe_core_abi_version();
if (abi !== 1) throw new Error(`Unsupported C++ Core Engine ABI version: ${abi}`);
console.log(`Validated fe_core_engine.wasm (${wasmBytes.length} bytes, ABI v${abi}, ${expNames.size} exports).`);
