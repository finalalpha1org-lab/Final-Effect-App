import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const CPP_SOURCES = [
  'cpp/src/fe_wasm_exports.cpp',
  'cpp/src/fe_animation.cpp',
  'cpp/src/fe_renderer.cpp',
  'cpp/src/fe_sculpt_touch.cpp',
  'cpp/src/fe_simulation.cpp',
  'cpp/src/fe_landscape.cpp'
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
  'fe_terrain_erode_thermal'
];

function findZigCompiler() {
  const candidates = ['/tmp/zig_pkg/ziglang/zig', 'zig'];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {}
  }
  return null;
}

const zig = findZigCompiler();
if (zig) {
  execFileSync(zig, [
    'c++',
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
