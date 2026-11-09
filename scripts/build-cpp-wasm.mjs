import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';

const ARTIFACT = 'wasm/fe_core_engine.wasm';

const CPP_SOURCES = [
  'cpp/src/fe_wasm_exports.cpp',
  'cpp/src/fe_heap.cpp',
  'cpp/src/fe_animation.cpp',
  'cpp/src/fe_renderer.cpp',
  'cpp/src/fe_sculpt_touch.cpp',
  'cpp/src/fe_simulation.cpp',
  'cpp/src/fe_flip.cpp',
  'cpp/src/fe_volumetrics.cpp',
  'cpp/src/fe_volatlas.cpp',
  'cpp/src/fe_export.cpp',
  'cpp/src/fe_render_math.cpp',
  'cpp/src/fe_writer.cpp',
  'cpp/src/fe_modifiers.cpp',
  'cpp/src/fe_skin.cpp',
  'cpp/src/fe_editmesh.cpp',
  'cpp/src/fe_editmesh_tools.cpp',
  'cpp/src/fe_poly.cpp'
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
  'fe_flip_begin','fe_flip_step','fe_flip_grid_nx','fe_flip_grid_ny','fe_flip_grid_nz',
  'fe_flip_cell_size','fe_flip_cell_count',
  'fe_skin_begin',
  'fe_skin_solve',
  'fe_skin_deform',
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
  'fe_mod_in_nrm_ptr','fe_mod_face_smooth_ptr','fe_mod_set_face_smooth',
  'fe_mod_derive_face_smooth','fe_mod_shade',
  'fe_mod_matrix_ptr','fe_mod_target_begin','fe_mod_target_counts_ptr','fe_mod_target_pos_ptr',
  'fe_mod_target_idx_ptr','fe_mod_sd_bind','fe_mod_sd_upload','fe_mod_sd_apply',
  'fe_mod_sd_ordinal_ptr','fe_mod_sd_bary_ptr','fe_mod_sd_scalars_ptr','fe_mod_sd_tris_ptr',
  'fe_mod_sd_tri_count','fe_mod_lattice_cage','fe_mod_lattice_alloc','fe_mod_lattice_rest_ptr',
  'fe_mod_lattice_deform_ptr','fe_mod_lattice_apply','fe_mod_armature','fe_mod_shrinkwrap',
  /* Export baking, volume atlas and the packaging CRC. */
  'fe_export_begin','fe_export_set_counts','fe_export_src_pos_ptr','fe_export_src_nrm_ptr',
  'fe_export_src_uv_ptr','fe_export_src_idx_ptr','fe_export_out_pos_ptr','fe_export_out_nrm_ptr',
  'fe_export_out_uv_ptr','fe_export_out_idx_ptr','fe_export_out_vertex_count',
  'fe_export_out_index_count','fe_export_instance_count','fe_export_bake',
  'fe_export_bake_instanced','fe_zip_crc32',
  'fe_volatlas_layout','fe_volatlas_bytes','fe_volatlas_pack','fe_volatlas_pack_library',
  'fe_volatlas_sample','fe_volatlas_frame_at','fe_volatlas_parse_library',
  'fe_writer_begin','fe_writer_reset','fe_writer_text_ptr','fe_writer_text_length',
  'fe_writer_obj_header','fe_writer_obj_mesh','fe_writer_mtl_header','fe_writer_mtl_material',
  'fe_taa_halton','fe_taa_jitter','fe_taa_project',
  'fe_color_blackbody_rgb','fe_color_blackbody_lut',
  'fe_anim_edit_key','fe_anim_delete_keys_in_range','fe_anim_move_keys_in_range',
  'fe_anim_duplicate_keys_in_range','fe_anim_catmull_rom',
  'fe_anim_sample_object','fe_anim_sample_channel','fe_anim_bake_samples','fe_sim_bake_compress',
  /* Edit Mode kernel (fe_editmesh.cpp / fe_editmesh_tools.cpp) */
  'fe_edit_reset','fe_edit_upload','fe_edit_vert_count','fe_edit_tri_count','fe_edit_edge_count',
  'fe_edit_max_verts','fe_edit_has_color','fe_edit_pos_ptr','fe_edit_idx_ptr','fe_edit_vert_sel_ptr',
  'fe_edit_color_interleaved_ptr',
  'fe_edit_edge_ptr','fe_edit_edge_b_ptr','fe_edit_edge_face_ptr','fe_edit_edge_sel_ptr',
  'fe_edit_quad_pairs_ptr','fe_edit_quad_pair_count',
  'fe_edit_interior_pairs_ptr','fe_edit_interior_pair_count',
  'fe_edit_set_faces','fe_edit_face_count','fe_edit_ngon_count',
  'fe_edit_face_ring_count','fe_edit_face_start_ptr','fe_edit_face_ring_ptr',
  'fe_edit_face_sel_ptr','fe_edit_pos_interleaved_ptr',
  'fe_edit_set_mode','fe_edit_get_mode','fe_edit_select_all','fe_edit_select_none','fe_edit_select_invert',
  'fe_edit_sel_count','fe_edit_select_by_index','fe_edit_select_linked','fe_edit_select_more',
  'fe_edit_select_less','fe_edit_select_similar','fe_edit_select_random','fe_edit_select_box',
  'fe_edit_select_circle','fe_edit_pick','fe_edit_set_pick_tolerance','fe_edit_select_loop','fe_edit_set_proportional',
  'fe_edit_set_pivot','fe_edit_set_snap',
  'fe_edit_move','fe_edit_rotate','fe_edit_scale','fe_edit_shrink_fatten','fe_edit_shear',
  'fe_edit_to_sphere','fe_edit_bend','fe_edit_randomize','fe_edit_align','fe_edit_mirror',
  'fe_edit_slide','fe_edit_set_shade','fe_edit_get_shade','fe_edit_mark_sharp','fe_edit_mark_seam',
  'fe_edit_shade_state','fe_edit_face_shade_ptr','fe_edit_face_shade_count',
  'fe_edit_render_weld_ptr','fe_edit_render_weld_count',
  'fe_edit_sharp_count','fe_edit_seam_count','fe_edit_recalc_normals','fe_edit_flip_normals',
  'fe_edit_stats_ptr','fe_edit_bounds_ptr','fe_edit_build_render','fe_edit_build_render_split',
  'fe_edit_flat_planar',
  'fe_edit_upload_face_shade','fe_edit_render_pos_ptr',
  'fe_edit_render_nrm_ptr','fe_edit_render_col_ptr','fe_edit_render_idx_ptr',
  'fe_edit_render_vert_count','fe_edit_render_idx_count','fe_edit_render_split_count',
  'fe_edit_undo_push','fe_edit_undo','fe_edit_redo','fe_edit_undo_depth','fe_edit_redo_depth',
  'fe_edit_undo_clear','fe_edit_clip_vert_count','fe_edit_clip_tri_count','fe_edit_clip_pos_ptr',
  'fe_edit_clip_idx_ptr',
  'fe_edit_extrude','fe_edit_inset','fe_edit_subdivide','fe_edit_merge_center','fe_edit_merge_distance',
  'fe_edit_delete','fe_edit_duplicate','fe_edit_poke','fe_edit_fill','fe_edit_bridge','fe_edit_bisect',
  'fe_edit_bevel','fe_edit_symmetrize','fe_edit_split','fe_edit_collapse',
  /* The face law (fe_poly.cpp): the face list of a mesh that has no edit
     session, measured once in the engine instead of twice in two languages. */
  'fe_poly_begin','fe_poly_positions_ptr','fe_poly_indices_ptr',
  'fe_poly_declared_start_ptr','fe_poly_declared_ring_ptr','fe_poly_set_declared_corners',
  'fe_poly_build','fe_poly_face_count','fe_poly_face_start_ptr','fe_poly_face_ring_ptr',
  'fe_poly_face_ring_count','fe_poly_face_tri_start_ptr','fe_poly_face_tri_ptr',
  'fe_poly_face_tri_count','fe_poly_weld_count','fe_poly_weld_rep_ptr','fe_poly_weld_of_slot_ptr',
  'fe_poly_edge_count','fe_poly_edge_ptr','fe_poly_kind_counts_ptr'
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
    /* Kernels are named explicitly so the linker keeps them even when nothing
       else references them inside the module. */
    '-Wl,--export=fe_render_denoise',
    '-Wl,--export=fe_render_update_convergence',
    '-Wl,--export=fe_render_active_pixels',
    '-Wl,--export=fe_render_denoise_config',
    /* Export baking, volume atlas and the ZIP CRC: kernels the shell calls
       through their pointers, so the linker must keep them named. */
    '-Wl,--export=fe_export_begin','-Wl,--export=fe_export_set_counts',
    '-Wl,--export=fe_export_src_pos_ptr','-Wl,--export=fe_export_src_nrm_ptr',
    '-Wl,--export=fe_export_src_uv_ptr','-Wl,--export=fe_export_src_idx_ptr',
    '-Wl,--export=fe_export_out_pos_ptr','-Wl,--export=fe_export_out_nrm_ptr',
    '-Wl,--export=fe_export_out_uv_ptr','-Wl,--export=fe_export_out_idx_ptr',
    '-Wl,--export=fe_export_out_vertex_count','-Wl,--export=fe_export_out_index_count',
    '-Wl,--export=fe_export_instance_count','-Wl,--export=fe_export_bake',
    '-Wl,--export=fe_export_bake_instanced','-Wl,--export=fe_zip_crc32',
    '-Wl,--export=fe_volatlas_layout','-Wl,--export=fe_volatlas_bytes',
    '-Wl,--export=fe_volatlas_pack','-Wl,--export=fe_volatlas_pack_library',
    '-Wl,--export=fe_volatlas_sample','-Wl,--export=fe_volatlas_frame_at',
    '-Wl,--export=fe_volatlas_parse_library',
    '-Wl,--export=fe_writer_begin','-Wl,--export=fe_writer_reset',
    '-Wl,--export=fe_writer_text_ptr','-Wl,--export=fe_writer_text_length',
    '-Wl,--export=fe_writer_obj_header','-Wl,--export=fe_writer_obj_mesh',
    '-Wl,--export=fe_writer_mtl_header','-Wl,--export=fe_writer_mtl_material',
    '-Wl,--export=fe_taa_halton','-Wl,--export=fe_taa_jitter','-Wl,--export=fe_taa_project',
    '-Wl,--export=fe_color_blackbody_rgb','-Wl,--export=fe_color_blackbody_lut',
    '-Wl,--export=fe_skin_begin',
    '-Wl,--export=fe_skin_solve',
    '-Wl,--export=fe_skin_deform',
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
    /* Edit Mode tap radius, set by the shell from the viewport height. */
    '-Wl,--export=fe_edit_set_pick_tolerance',
    '-Wl,--export=fe_edit_quad_pairs_ptr','-Wl,--export=fe_edit_quad_pair_count',
    '-Wl,--export=fe_edit_interior_pairs_ptr','-Wl,--export=fe_edit_interior_pair_count',
    /* Faces: the app declares its n-gons (a cylinder cap is one thirty-two-gon
       face in Blender and a fan of triangles in the buffer), and the shell
       reads the face table back to outline and stash them. */
    '-Wl,--export=fe_edit_set_faces','-Wl,--export=fe_edit_face_count',
    '-Wl,--export=fe_edit_ngon_count','-Wl,--export=fe_edit_face_ring_count',
    '-Wl,--export=fe_edit_face_start_ptr','-Wl,--export=fe_edit_face_ring_ptr',
    '-Wl,--export=fe_edit_select_loop','-Wl,--export=fe_edit_set_proportional',
    '-Wl,--export=fe_edit_set_pivot','-Wl,--export=fe_edit_set_snap',
    '-Wl,--export=fe_edit_move','-Wl,--export=fe_edit_rotate','-Wl,--export=fe_edit_scale',
    '-Wl,--export=fe_edit_shrink_fatten','-Wl,--export=fe_edit_shear','-Wl,--export=fe_edit_to_sphere',
    '-Wl,--export=fe_edit_bend','-Wl,--export=fe_edit_randomize','-Wl,--export=fe_edit_align',
    '-Wl,--export=fe_edit_mirror','-Wl,--export=fe_edit_slide',
    '-Wl,--export=fe_edit_set_shade','-Wl,--export=fe_edit_get_shade','-Wl,--export=fe_edit_mark_sharp',
    '-Wl,--export=fe_edit_shade_state','-Wl,--export=fe_edit_face_shade_ptr',
    '-Wl,--export=fe_edit_face_shade_count','-Wl,--export=fe_edit_render_weld_ptr',
    '-Wl,--export=fe_edit_render_weld_count',
    '-Wl,--export=fe_edit_mark_seam','-Wl,--export=fe_edit_sharp_count','-Wl,--export=fe_edit_seam_count',
    '-Wl,--export=fe_edit_recalc_normals','-Wl,--export=fe_edit_flip_normals',
    '-Wl,--export=fe_edit_stats_ptr','-Wl,--export=fe_edit_bounds_ptr',
    '-Wl,--export=fe_edit_build_render','-Wl,--export=fe_edit_build_render_split',
    '-Wl,--export=fe_edit_flat_planar',
    '-Wl,--export=fe_edit_upload_face_shade','-Wl,--export=fe_edit_render_pos_ptr',
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
    /* The face law: Object Mode asks the engine what the faces of a mesh are. */
    '-Wl,--export=fe_poly_begin','-Wl,--export=fe_poly_positions_ptr',
    '-Wl,--export=fe_poly_indices_ptr','-Wl,--export=fe_poly_declared_start_ptr',
    '-Wl,--export=fe_poly_declared_ring_ptr','-Wl,--export=fe_poly_set_declared_corners',
    '-Wl,--export=fe_poly_build','-Wl,--export=fe_poly_face_count',
    '-Wl,--export=fe_poly_face_start_ptr','-Wl,--export=fe_poly_face_ring_ptr',
    '-Wl,--export=fe_poly_face_ring_count','-Wl,--export=fe_poly_face_tri_start_ptr',
    '-Wl,--export=fe_poly_face_tri_ptr','-Wl,--export=fe_poly_face_tri_count',
    '-Wl,--export=fe_poly_weld_count','-Wl,--export=fe_poly_weld_rep_ptr',
    '-Wl,--export=fe_poly_weld_of_slot_ptr',
    '-Wl,--export=fe_poly_edge_count','-Wl,--export=fe_poly_edge_ptr',
    '-Wl,--export=fe_poly_kind_counts_ptr',
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
