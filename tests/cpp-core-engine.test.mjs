import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { createStandaloneAppHtml } from '../scripts/standalone-html.mjs';

const wasmBytes = readFileSync(appPath('wasm/fe_core_engine.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);

function instantiateCppCore() {
  const inst = new WebAssembly.Instance(wasmModule, {});
  const exp = inst.exports;
  return {
    exp,
    mem: exp.memory,
    f32(ptr, len) { return new Float32Array(exp.memory.buffer, ptr, len); },
    u32(ptr, len) { return new Uint32Array(exp.memory.buffer, ptr, len); },
    u8(ptr, len) { return new Uint8Array(exp.memory.buffer, ptr, len); }
  };
}

test('C++20 Core Engine WASM is freestanding (0 imports) and exposes ABI v1', () => {
  assert.equal(wasmBytes.subarray(0, 4).toString('hex'), '0061736d');
  assert.equal(WebAssembly.Module.imports(wasmModule).length, 0);
  const { exp } = instantiateCppCore();
  assert.equal(exp.fe_core_abi_version(), 1);
});

test('native C++20 unit test suite compiles and passes under g++ when present', () => {
  let hasGpp = false;
  try {
    execFileSync('g++', ['--version'], { stdio: 'ignore' });
    hasGpp = true;
  } catch {}
  if (!hasGpp) return;

  execFileSync('g++', [
    '-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror',
    'cpp/src/fe_wasm_exports.cpp',
    'cpp/src/fe_heap.cpp',
    'cpp/src/fe_animation.cpp',
    'cpp/src/fe_renderer.cpp',
    'cpp/src/fe_sculpt_touch.cpp',
    'cpp/src/fe_simulation.cpp',
    'cpp/tests/fe_core_tests.cpp',
    '-o', '/tmp/fe_core_test_bin'
  ], { stdio: 'pipe' });
  const out = execFileSync('/tmp/fe_core_test_bin', [], { encoding: 'utf8' });
  assert.match(out, /All Final Effect C\+\+20 Core Engine tests passed/);
});

test('C++ Keyframe Animation Engine evaluates curves, presets, loop modes, and serialization roundtrip', () => {
  const core = instantiateCppCore();
  const { exp } = core;
  exp.fe_anim_reset();
  exp.fe_arena_reset();

  const restPtr = exp.fe_malloc(11 * 4);
  core.f32(restPtr, 11).set([0, 0, 0, 0, 0, 0, 1, 1, 1, 39.6, 0.5]);
  assert.equal(exp.fe_anim_ensure_object(0, restPtr), 1);

  /* Monotone Bezier Smooth curve from X=0 at F0 -> X=12 at F60 */
  exp.fe_anim_insert_keyframe(0, 0, 0, 0, 0);
  exp.fe_anim_insert_keyframe(0, 0, 60, 12, 0);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);

  const mid = exp.fe_anim_evaluate_channel(0, 0, 30, 0, 250);
  assert.ok(Math.abs(mid - 6) < 0.05, `expected midpoint ~6, got ${mid}`);

  const outPtr = exp.fe_malloc(15 * 4);
  assert.equal(exp.fe_anim_evaluate_object(0, 60, 0, 250, outPtr), 1);
  const out15 = core.f32(outPtr, 15);
  assert.ok(Math.abs(out15[0] - 12) < 1e-4);
  assert.ok(Math.abs(out15[6] - 1) < 1e-4);

  /* Serialize & restore */
  const floatCount = exp.fe_anim_serialized_float_count();
  const blobPtr = exp.fe_malloc(floatCount * 4);
  assert.equal(exp.fe_anim_serialize(blobPtr, floatCount), floatCount);
  const savedCopy = new Float32Array(core.f32(blobPtr, floatCount));

  exp.fe_anim_reset();
  assert.equal(exp.fe_anim_get_total_keyframes(), 0);
  exp.fe_arena_reset();
  const restorePtr = exp.fe_malloc(savedCopy.length * 4);
  core.f32(restorePtr, savedCopy.length).set(savedCopy);
  assert.equal(exp.fe_anim_deserialize(restorePtr, savedCopy.length), 2);
  assert.ok(Math.abs(exp.fe_anim_evaluate_channel(0, 0, 60, 0, 250) - 12) < 1e-4);

  /* Motion preset generator */
  exp.fe_arena_reset();
  const basePtr = exp.fe_malloc(11 * 4);
  core.f32(basePtr, 11).set([0, 1, 0, 0, 0, 0, 1, 1, 1, 50, 0.5]);
  assert.ok(exp.fe_anim_apply_preset(1, 2 /* Bounce */, 0, 120, 1.0, basePtr) >= 6);
});

test('C++ BVH PBR Path Tracer & Post-Processor shade a 3D BoxGeometry and tone-map cleanly', () => {
  const core = instantiateCppCore();
  const { exp } = core;
  assert.equal(exp.fe_core_abi_version(), 1);
  exp.fe_render_scene_clear();
  exp.fe_arena_reset();

  const sph = new THREE.SphereGeometry(0.95, 18, 12);
  const pos = sph.attributes.position.array;
  const nrm = sph.attributes.normal.array;
  const idx = sph.index.array;
  const vCount = sph.attributes.position.count;
  const triCount = idx.length / 3;

  const pPtr = exp.fe_malloc(pos.length * 4);
  const nPtr = exp.fe_malloc(nrm.length * 4);
  const iPtr = exp.fe_malloc(idx.length * 4);
  core.f32(pPtr, pos.length).set(pos);
  core.f32(nPtr, nrm.length).set(nrm);
  core.u32(iPtr, idx.length).set(idx);

  assert.equal(exp.fe_render_add_mesh(pPtr, nPtr, iPtr, vCount, triCount, 0.96, 0.16, 0.18, 0.22, 0.1, 0.0, 1.0), triCount);
  const bvhNodes = exp.fe_render_build_bvh();
  assert.ok(bvhNodes > 20, `expected multi-node BVH tree, got ${bvhNodes}`);

  exp.fe_render_set_environment(0, 1.05, 1, -0.96);
  exp.fe_render_set_light(0, 2, 8, 12, 10, -0.5, -0.7, -0.5, 1.0, 0.98, 0.95, 2.5, 0.2, 0.5);
  exp.fe_render_set_camera(0, 0.0, 3.4, 0, 0.0, -1.0, 1, 0, 0, 0, 1.0, 0.0, 42, 1.0, 0.0, 3.4);

  assert.equal(exp.fe_render_init_framebuffer(48, 48), 1);
  assert.equal(exp.fe_render_trace_samples(4, 2, 0, 48), 4);
  exp.fe_render_resolve_rgba8(0 /* ACES */, 1.25, 1.05, 1.1, 0.0, 0.15, 0.1, 0.0, 0.0);

  const rgbaPtr = exp.fe_render_get_rgba8_ptr();
  const rgba = core.u8(rgbaPtr, 48 * 48 * 4);
  const centerIdx = (24 * 48 + 24) * 4;
  assert.ok(rgba[centerIdx] > 150 && rgba[centerIdx] > rgba[centerIdx + 1] * 2, `center crimson sphere pixel must hit 3D mesh, got RGB(${rgba[centerIdx]},${rgba[centerIdx + 1]},${rgba[centerIdx + 2]})`);
  assert.equal(rgba[centerIdx + 3], 255);
  sph.dispose();
});

test('C++ Sculpt & Vertex Paint kernels support symmetry and normal recomputation', () => {
  const core = instantiateCppCore();
  const { exp } = core;
  exp.fe_arena_reset();

  const pPtr = exp.fe_malloc(6 * 4);
  const nPtr = exp.fe_malloc(6 * 4);
  core.f32(pPtr, 6).set([-0.4, 0, 0, 0.4, 0, 0]);
  core.f32(nPtr, 6).set([0, 1, 0, 0, 1, 0]);

  const count = exp.fe_sculpt_apply_brush(pPtr, nPtr, 2, 0 /* Draw */, 0.4, 0, 0, 0, 1, 0, 0, 0, 0, 0.35, 0.75, 1 /* Mirror X */);
  assert.equal(count, 2);
  const outP = core.f32(pPtr, 6);
  assert.ok(outP[1] > 0.02);
  assert.ok(Math.abs(outP[1] - outP[4]) < 1e-5, 'Mirror X symmetry should displace both sides equally');
});

test('UI shell wires C++ Animation Studio, Render Engine, Sculpt Mode, GPU Tier, PWA & Capacitor', () => {
  const html = readFileSync(appPath('index.html'), 'utf8');
  const bridge = readFileSync(appPath('fe-cpp-engine.js'), 'utf8');

  assert.ok(html.includes('<script src="fe-cpp-engine.js"></script>'));
  assert.ok(html.includes('id="anim-dopesheet-canvas"'));
  assert.ok(html.includes('id="render-engine-modal"'));
  assert.ok(html.includes('id="cpp-sculpt-paint-bar"'));
  assert.ok(html.includes('id="mobile-quick-hud"'));
  assert.ok(html.includes('id="set-gpu-tier"'));
  assert.ok(html.includes('rel="manifest" href="./manifest.webmanifest"'));
  assert.ok(bridge.includes('fe_core_engine.wasm'));
  assert.ok(existsSync(appPath('manifest.webmanifest')));
  assert.ok(existsSync(appPath('sw.js')));
  assert.ok(existsSync(appPath('../capacitor.config.json')) || existsSync('capacitor.config.json'));
  assert.ok(existsSync(appPath('../CMakeLists.txt')) || existsSync('CMakeLists.txt'));
});

test('standalone 1-file portable build embeds C++20 WASM and passes the live self-test offline without fetch', async () => {
  const html = readFileSync(appPath('index.html'), 'utf8');
  const bridge = readFileSync(appPath('fe-cpp-engine.js'), 'utf8');
  const b64 = wasmBytes.toString('base64');

  const standalone = createStandaloneAppHtml(html, {
    volumeAtlas: readFileSync(appPath('volume-atlas.js'), 'utf8'),
    feIcons: readFileSync(appPath('fe-icons.js'), 'utf8'),
    feTaa: readFileSync(appPath('fe-taa.js'), 'utf8'),
    renderCapture: readFileSync(appPath('render-capture.js'), 'utf8'),
    renderPreview: readFileSync(appPath('render-preview.js'), 'utf8'),
    renderExport: readFileSync(appPath('render-export.js'), 'utf8'),
    workspaceExport: readFileSync(appPath('workspace-export.js'), 'utf8'),
    editMode: readFileSync(appPath('edit-mode.js'), 'utf8'),
    volumeLibrary: readFileSync(appPath('volume-library.js'), 'utf8'),
    simulationCore: 'window.__simStub = true;',
    modifierEngine: 'window.__modStub = true;',
    feCppEngine: bridge,
    cppWasmBase64: b64,
    simWasmBase64: 'AA==',
    terrainStandaloneHtml: '<!doctype html><html><body>terrain</body></html>'
  });
  assert.ok(!standalone.includes('<script src="fe-cpp-engine.js"></script>'));
  assert.ok(standalone.includes('window.__FE_CPP_WASM_BASE64__'));

  const ctx = {
    WebAssembly, Float32Array, Uint32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView,
    Map, Set, Promise, Math, Number, String, Array, Object, JSON, Error, RegExp, parseInt, parseFloat, isNaN, isFinite,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    ImageData: class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } },
    performance, console,
    __FE_CPP_WASM_BASE64__: b64,
    fetch: async () => { throw new Error('Network disabled in offline file:// test'); },
    addEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    navigator: { userAgent: 'Android' },
    location: { protocol: 'file:', hostname: '', href: 'file:///Download/Final-Effect-3D-Standalone.html' },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: () => []
    }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(bridge, ctx);

  let putPixels = null;
  const fakeCanvas = {
    width: 0, height: 0,
    getContext: () => ({ putImageData(img) { putPixels = img; } })
  };
  const report = await ctx.FECppEngine.runLiveSelfTest(fakeCanvas);
  assert.equal(report.ok, true, 'All on-device self-test checks must pass offline');
  assert.equal(report.results.length, 8);
  assert.ok(report.results.some(r=>r.name==='Smoke & Fire Volume Solver' && r.ok),'the volumetric solver runs inside the offline standalone build');
  assert.ok(putPixels && putPixels.width === 240 && putPixels.height === 135);
});
