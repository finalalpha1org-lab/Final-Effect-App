import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';

const ARTIFACT = 'wasm/fe_core_engine.wasm';

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
  'cpp/src/fe_climate.cpp',
  'cpp/src/fe_editmesh.cpp',
  'cpp/src/fe_editmesh_tools.cpp'
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
  'fe_render_denoise',
  'fe_render_update_convergence',
  'fe_render_active_pixels',
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
  'fe_lod_visible',
  'fe_lod_visible_index_ptr',
  'fe_lod_visible_tier_ptr',
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
  'fe_build','fe_build_kind_count',
  /* Skeletal wind channels + the fern L-system (fe_flora.cpp) */
  'fe_flora_sway_ptr','fe_flora_phase_ptr','fe_flora_leaf_stride','fe_flora_part_ptr',
  'fe_flora_card_count','fe_flora_card_vert_count','fe_flora_card_index_count',
  'fe_flora_card_pos_ptr','fe_flora_card_nrm_ptr','fe_flora_card_col_ptr','fe_flora_card_uv_ptr',
  'fe_flora_card_rnd_ptr','fe_flora_card_cen_ptr','fe_flora_card_sway_ptr','fe_flora_card_phase_ptr',
  'fe_flora_card_part_ptr','fe_flora_card_idx_ptr',
  'fe_flora_lsystem','fe_flora_lsystem_len','fe_flora_lsystem_word','fe_flora_lsystem_rules',
  'fe_flora_lsystem_load','fe_flora_lsystem_run','fe_flora_lsystem_plant',
  /* Climate & weather: seeded temperature / moisture / fronts / hazards */
  'fe_climate_init','fe_climate_ready','fe_climate_set_clock','fe_climate_set_season',
  'fe_climate_step','fe_climate_clock','fe_climate_sea_level_temp','fe_climate_snow_line',
  'fe_climate_at','fe_climate_weather','fe_climate_biome','fe_climate_biome_count',
  'fe_climate_biome_on_slope','fe_climate_tornado','fe_climate_rankine','fe_climate_tsunami',
  'fe_lod_visible','fe_lod_visible_index_ptr','fe_lod_visible_tier_ptr','fe_ow_visible_count',
  /* Time-sliced erosion (fe_landscape.cpp) */
  'fe_erosion_begin','fe_erosion_set_region','fe_erosion_step','fe_erosion_dirty_ptr','fe_erosion_dirty_reset',
  'fe_erosion_remaining','fe_erosion_total','fe_erosion_active','fe_erosion_cancel',
  'fe_terrain_compute_normals_region',
  /* Edit Mode kernel (fe_editmesh.cpp / fe_editmesh_tools.cpp) */
  'fe_edit_reset','fe_edit_upload','fe_edit_vert_count','fe_edit_tri_count','fe_edit_edge_count',
  'fe_edit_max_verts','fe_edit_has_color','fe_edit_pos_ptr','fe_edit_idx_ptr','fe_edit_vert_sel_ptr',
  'fe_edit_color_interleaved_ptr',
  'fe_edit_edge_ptr','fe_edit_edge_b_ptr','fe_edit_edge_face_ptr','fe_edit_edge_sel_ptr',
  'fe_edit_face_sel_ptr','fe_edit_pos_interleaved_ptr',
  'fe_edit_set_mode','fe_edit_get_mode','fe_edit_select_all','fe_edit_select_none','fe_edit_select_invert',
  'fe_edit_sel_count','fe_edit_select_by_index','fe_edit_select_linked','fe_edit_select_more',
  'fe_edit_select_less','fe_edit_select_similar','fe_edit_select_random','fe_edit_select_box',
  'fe_edit_select_circle','fe_edit_pick','fe_edit_select_loop','fe_edit_set_proportional',
  'fe_edit_set_pivot','fe_edit_set_snap',
  'fe_edit_move','fe_edit_rotate','fe_edit_scale','fe_edit_shrink_fatten','fe_edit_shear',
  'fe_edit_to_sphere','fe_edit_bend','fe_edit_randomize','fe_edit_align','fe_edit_mirror',
  'fe_edit_slide','fe_edit_set_shade','fe_edit_get_shade','fe_edit_mark_sharp','fe_edit_mark_seam',
  'fe_edit_sharp_count','fe_edit_seam_count','fe_edit_recalc_normals','fe_edit_flip_normals',
  'fe_edit_stats_ptr','fe_edit_bounds_ptr','fe_edit_build_render','fe_edit_render_pos_ptr',
  'fe_edit_render_nrm_ptr','fe_edit_render_col_ptr','fe_edit_render_idx_ptr',
  'fe_edit_render_vert_count','fe_edit_render_idx_count','fe_edit_render_split_count',
  'fe_edit_undo_push','fe_edit_undo','fe_edit_redo','fe_edit_undo_depth','fe_edit_redo_depth',
  'fe_edit_undo_clear','fe_edit_clip_vert_count','fe_edit_clip_tri_count','fe_edit_clip_pos_ptr',
  'fe_edit_clip_idx_ptr',
  'fe_edit_extrude','fe_edit_inset','fe_edit_subdivide','fe_edit_merge_center','fe_edit_merge_distance',
  'fe_edit_delete','fe_edit_duplicate','fe_edit_poke','fe_edit_fill','fe_edit_bridge','fe_edit_bisect',
  'fe_edit_bevel','fe_edit_symmetrize','fe_edit_split','fe_edit_collapse'
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

/* A source change that nobody compiled is the one failure this script must not
 * hide: validating the previous artifact would ship code that is not in the
 * repository. So when no compiler is available and a source is newer than the
 * artifact, stop instead of printing a green check. */
function staleSources() {
  if (!existsSync(ARTIFACT)) return ['wasm/fe_core_engine.wasm is missing'];
  const built = statSync(ARTIFACT).mtimeMs;
  return CPP_SOURCES.filter((file) => {
    try { return statSync(file).mtimeMs > built; } catch { return false; }
  });
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
    /* New kernels are named explicitly so the linker keeps them even when
       nothing else references them inside the module. */
    '-Wl,--export=fe_lod_visible',
    '-Wl,--export=fe_erosion_begin',
    '-Wl,--export=fe_erosion_set_region',
    '-Wl,--export=fe_erosion_step',
    '-Wl,--export=fe_erosion_dirty_ptr',
    '-Wl,--export=fe_erosion_dirty_reset',
    '-Wl,--export=fe_erosion_remaining',
    '-Wl,--export=fe_erosion_total',
    '-Wl,--export=fe_erosion_active',
    '-Wl,--export=fe_erosion_cancel',
    '-Wl,--export=fe_render_denoise',
    '-Wl,--export=fe_render_update_convergence',
    '-Wl,--export=fe_render_active_pixels',
    '-Wl,--export=fe_render_denoise_config',
    '-Wl,--export=fe_terrain_compute_normals_region',
    /* Edit Mode topology is only reachable from JS, so the linker has to be
       told to keep every entry point. */
    '-Wl,--export=fe_edit_reset','-Wl,--export=fe_edit_upload','-Wl,--export=fe_edit_vert_count',
    '-Wl,--export=fe_edit_tri_count','-Wl,--export=fe_edit_edge_count','-Wl,--export=fe_edit_max_verts',
    '-Wl,--export=fe_edit_has_color','-Wl,--export=fe_edit_pos_ptr','-Wl,--export=fe_edit_idx_ptr',
    '-Wl,--export=fe_edit_color_interleaved_ptr',
    '-Wl,--export=fe_edit_vert_sel_ptr','-Wl,--export=fe_edit_edge_ptr','-Wl,--export=fe_edit_edge_b_ptr',
    '-Wl,--export=fe_edit_edge_face_ptr','-Wl,--export=fe_edit_edge_sel_ptr',
    '-Wl,--export=fe_edit_face_sel_ptr','-Wl,--export=fe_edit_pos_interleaved_ptr',
    '-Wl,--export=fe_edit_set_mode','-Wl,--export=fe_edit_get_mode','-Wl,--export=fe_edit_select_all',
    '-Wl,--export=fe_edit_select_none','-Wl,--export=fe_edit_select_invert','-Wl,--export=fe_edit_sel_count',
    '-Wl,--export=fe_edit_select_by_index','-Wl,--export=fe_edit_select_linked',
    '-Wl,--export=fe_edit_select_more','-Wl,--export=fe_edit_select_less',
    '-Wl,--export=fe_edit_select_similar','-Wl,--export=fe_edit_select_random',
    '-Wl,--export=fe_edit_select_box','-Wl,--export=fe_edit_select_circle','-Wl,--export=fe_edit_pick',
    '-Wl,--export=fe_edit_select_loop','-Wl,--export=fe_edit_set_proportional',
    '-Wl,--export=fe_edit_set_pivot','-Wl,--export=fe_edit_set_snap',
    '-Wl,--export=fe_edit_move','-Wl,--export=fe_edit_rotate','-Wl,--export=fe_edit_scale',
    '-Wl,--export=fe_edit_shrink_fatten','-Wl,--export=fe_edit_shear','-Wl,--export=fe_edit_to_sphere',
    '-Wl,--export=fe_edit_bend','-Wl,--export=fe_edit_randomize','-Wl,--export=fe_edit_align',
    '-Wl,--export=fe_edit_mirror','-Wl,--export=fe_edit_slide',
    '-Wl,--export=fe_edit_set_shade','-Wl,--export=fe_edit_get_shade','-Wl,--export=fe_edit_mark_sharp',
    '-Wl,--export=fe_edit_mark_seam','-Wl,--export=fe_edit_sharp_count','-Wl,--export=fe_edit_seam_count',
    '-Wl,--export=fe_edit_recalc_normals','-Wl,--export=fe_edit_flip_normals',
    '-Wl,--export=fe_edit_stats_ptr','-Wl,--export=fe_edit_bounds_ptr',
    '-Wl,--export=fe_edit_build_render','-Wl,--export=fe_edit_render_pos_ptr',
    '-Wl,--export=fe_edit_render_nrm_ptr','-Wl,--export=fe_edit_render_col_ptr',
    '-Wl,--export=fe_edit_render_idx_ptr','-Wl,--export=fe_edit_render_vert_count',
    '-Wl,--export=fe_edit_render_idx_count','-Wl,--export=fe_edit_render_split_count',
    '-Wl,--export=fe_edit_undo_push','-Wl,--export=fe_edit_undo','-Wl,--export=fe_edit_redo',
    '-Wl,--export=fe_edit_undo_depth','-Wl,--export=fe_edit_redo_depth','-Wl,--export=fe_edit_undo_clear',
    '-Wl,--export=fe_edit_clip_vert_count','-Wl,--export=fe_edit_clip_tri_count',
    '-Wl,--export=fe_edit_clip_pos_ptr','-Wl,--export=fe_edit_clip_idx_ptr',
    '-Wl,--export=fe_edit_extrude','-Wl,--export=fe_edit_inset','-Wl,--export=fe_edit_subdivide',
    '-Wl,--export=fe_edit_merge_center','-Wl,--export=fe_edit_merge_distance','-Wl,--export=fe_edit_delete',
    '-Wl,--export=fe_edit_duplicate','-Wl,--export=fe_edit_poke','-Wl,--export=fe_edit_fill',
    '-Wl,--export=fe_edit_bridge','-Wl,--export=fe_edit_bisect','-Wl,--export=fe_edit_bevel',
    '-Wl,--export=fe_edit_symmetrize','-Wl,--export=fe_edit_split','-Wl,--export=fe_edit_collapse',
    '-Wl,--export=fe_ow_visible_count',
    '-Wl,--export=fe_lod_visible_index_ptr',
    '-Wl,--export=fe_lod_visible_tier_ptr',
    ...CPP_SOURCES,
    '-o', 'wasm/fe_core_engine.wasm'
  ], { stdio: 'inherit' });
  copyFileSync('wasm/fe_core_engine.wasm', 'fe_core_engine.wasm');
  console.log('Compiled C++20 Core Engine to wasm/fe_core_engine.wasm via Clang/Zig.');
} else {
  const stale = staleSources();
  if (stale.length && !process.env.FE_ALLOW_STALE_CPP) {
    throw new Error(
      'No Zig compiler was found and these C++ sources are newer than the shipped artifact: ' +
      stale.join(', ') + '.\nInstall one (pip install --break-system-packages ziglang, or zig in PATH) ' +
      'so the engine can be rebuilt. Set FE_ALLOW_STALE_CPP=1 only to validate an artifact you know is current.'
    );
  }
  if (stale.length) console.warn('warning: validating a stale fe_core_engine.wasm (' + stale.join(', ') + ' newer)');
  if (!existsSync('fe_core_engine.wasm')) copyFileSync('wasm/fe_core_engine.wasm', 'fe_core_engine.wasm');
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
