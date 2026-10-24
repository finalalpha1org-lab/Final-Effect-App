import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/* The artifact's footprint, measured rather than claimed.
 *
 * Every kernel in this module used to keep its working set in BSS. That made
 * boot cost 169.4 MB before a triangle was drawn, and the kernel worker — which
 * only bakes a 64x128 impostor atlas — reserved a second copy of all of it.
 * The buffers behind the path tracer, the surface-reconstruction grid, the
 * smoke solver and the Edit Mode undo pool now come from `fe::heap`, which
 * grows linear memory a page at a time from `__heap_base`.
 *
 * Two things are pinned here:
 *
 *   1. the boot reservation, so a new static array cannot quietly put 30 MB
 *      back into every session and every worker;
 *   2. that a kernel which has not been opened has allocated nothing, so the
 *      costing model stays "you pay for what you open".
 *
 * The third test is the boring but load-bearing one: a second allocator growing
 * the same region would hand out the same address twice, so the simulation
 * core's JavaScript arena has to go through fe_heap_alloc rather than carving
 * from the end of memory itself. */

const WASM = 'wasm/fe_core_engine.wasm';
const MiB = 1024 * 1024;

async function boot() {
  const bytes = readFileSync(WASM);
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, {});
  return { bytes, mod, exp: inst.exports };
}

const mb = (value) => value / MiB;

test('the artifact boots under 100 MiB and allocates nothing it was not asked for', async () => {
  const { exp } = await boot();
  const bootBytes = exp.memory.buffer.byteLength;
  assert.ok(mb(bootBytes) < 90, `boot reservation is ${mb(bootBytes).toFixed(2)} MiB, expected under 90`);

  /* Nothing has asked for a render target, a fluid grid or an undo snapshot. */
  assert.equal(exp.fe_heap_lazy_used(), 0, 'a fresh instance has handed out no heap');
  assert.ok(exp.__heap_base.value <= bootBytes, '__heap_base sits inside linear memory');

  /* The numbers the studio can read back agree with the instance: capacity is
     what is left between __heap_base and the end of linear memory, and used
     plus capacity can never exceed the memory the instance actually has. */
  const capacity = exp.fe_heap_lazy_capacity();
  assert.equal(capacity, bootBytes - exp.__heap_base.value);
  assert.ok(exp.fe_heap_lazy_used() + capacity <= bootBytes);
});

test('the path tracer pays for the frame it renders, not for the largest one it accepts', async () => {
  const { exp } = await boot();
  const bootBytes = exp.memory.buffer.byteLength;

  assert.equal(exp.fe_render_init_framebuffer(1280, 720), 1);
  const afterInit = exp.memory.buffer.byteLength;
  const used720 = exp.fe_heap_lazy_used();

  /* 1280x720 at 25 bytes per pixel: 21.97 MB, not the 48.65 MB of buffers that
     used to exist for 1280x1280 whether or not anything was rendered. */
  assert.ok(afterInit > bootBytes, 'the render targets grew linear memory');
  assert.ok(mb(used720) > 21 && mb(used720) < 23, `1280x720 targets are ${mb(used720).toFixed(2)} MiB`);

  /* A rendered frame comes back through the same pointer contract. */
  exp.fe_render_reset_accumulation();
  assert.equal(exp.fe_render_trace_samples(1, 2, 0, 0), 1);
  const ptr = exp.fe_render_resolve_rgba8(1, 1, 1, 1, 0, 0, 0, 0, 0);
  assert.ok(ptr > 0);
  assert.equal(exp.fe_render_get_rgba8_ptr(), ptr);
  const pixels = new Uint8Array(exp.memory.buffer, ptr, 4);
  assert.equal(pixels[3], 255, 'the resolved frame is opaque');

  /* A larger frame reallocates; a smaller one reuses what is already there. */
  assert.equal(exp.fe_render_init_framebuffer(1024, 1024), 1);
  const used1024 = exp.fe_heap_lazy_used();
  assert.ok(used1024 > used720);
  assert.equal(exp.fe_render_init_framebuffer(640, 480), 1);
  assert.equal(exp.fe_heap_lazy_used(), used1024, 'a smaller frame must not allocate again');

  /* Frames the tracer refuses still refuse, and they refuse without growing. */
  assert.equal(exp.fe_render_init_framebuffer(1920, 1080), -1);
  assert.equal(exp.fe_heap_lazy_used(), used1024);
});

test('a kernel that has not been opened has allocated nothing', async () => {
  const { exp } = await boot();

  /* Smoke solver: no buffers until fe_vol_init, zeroed grid after it. */
  assert.equal(exp.fe_vol_density_ptr(), 0, 'the volume solver starts with no grid');
  assert.equal(exp.fe_heap_lazy_used(), 0, 'no kernel has allocated anything yet');
  const smoke = exp.fe_vol_init(24, 24, 24);
  assert.equal(smoke, 0);
  const density = exp.fe_vol_density_ptr();
  assert.ok(density > 0);
  const grid = new Float32Array(exp.memory.buffer, density, 40 * 40 * 40);
  assert.ok(grid.every((value) => value === 0), 'the lazily allocated grid arrives zeroed');

  /* Ocean cascades: nothing until configure, 10.8 MiB once, then reused. */
  const beforeOcean = exp.fe_heap_lazy_used();
  assert.equal(exp.fe_ocean_configure(128, 256, 1024, 4096, 14, 45, 7), 0);
  const afterOcean = exp.fe_heap_lazy_used();
  assert.ok(mb(afterOcean - beforeOcean) > 10 && mb(afterOcean - beforeOcean) < 11, 'the three cascades are 10.8 MiB');
  assert.ok(exp.fe_ocean_update(1.5, 1, 1, 3, 2) > 0, 'the cascade transforms run on the allocated block');
  assert.equal(exp.fe_ocean_resolution(), 128);
  assert.ok(exp.fe_ocean_get_cascade_rgba8_ptr(0) > 0, 'the upload pixels come from the same block');
  assert.equal(exp.fe_ocean_configure(64, 256, 1024, 4096, 12, 0, 7), 0);
  assert.equal(exp.fe_heap_lazy_used(), afterOcean, 'a smaller ocean must not allocate again');

  /* Surface detail: allocated for the size that was asked for, reused after. */
  const before = exp.fe_heap_lazy_used();
  assert.equal(exp.fe_surface_detail(0, 256, 256, 7, 1), 1);
  const detail = exp.fe_surface_detail_ptr();
  assert.ok(detail > 0);
  const afterFirst = exp.fe_heap_lazy_used();
  assert.ok(afterFirst - before >= 1024 * 1024, '256x256 RGBA floats is 1 MiB');
  assert.equal(exp.fe_surface_detail(0, 128, 128, 7, 1), 1);
  assert.equal(exp.fe_surface_detail_ptr(), detail, 'a smaller request keeps the existing block');
});

test('fe_heap_alloc is aligned, zeroed, disjoint and refuses the absurd', async () => {
  const { exp } = await boot();
  const floor = exp.__heap_base.value;

  const a = exp.fe_heap_alloc(1000, 4);
  const b = exp.fe_heap_alloc(64, 16);
  const c = exp.fe_heap_alloc(3, 1);
  assert.ok(a >= floor && b >= floor && c >= floor);
  assert.equal(a % 16, 0, 'fe_heap aligns to at least 16 bytes');
  assert.equal(b % 16, 0);
  assert.equal(c % 16, 0);
  assert.ok(b >= a + 1000, 'blocks never overlap');

  const bytes = new Uint8Array(exp.memory.buffer, a, 1000);
  assert.ok(bytes.every((value) => value === 0), 'a fresh block is zero');

  /* 256 MB in one request is a bug in a caller, not a frame: refuse it without
     growing the memory by a quarter of a gigabyte. */
  const before = exp.memory.buffer.byteLength;
  assert.equal(exp.fe_heap_alloc(300 * MiB, 16), 0);
  assert.equal(exp.memory.buffer.byteLength, before);
});

test('the simulation core asks the kernel for memory instead of carving its own', () => {
  const arena = readFileSync('simulationCore.js', 'utf8');
  assert.match(arena, /fe_heap_alloc/, 'WasmArena must allocate through the kernel heap');
  assert.doesNotMatch(arena, /this\.memory\.grow\(/, 'WasmArena must not grow memory behind the kernel allocator');

  /* And the kernel really exports it. */
  const mod = new WebAssembly.Module(readFileSync(WASM));
  const names = new Set(WebAssembly.Module.exports(mod).map((entry) => entry.name));
  for (const name of ['fe_heap_alloc', 'fe_heap_lazy_used', 'fe_heap_lazy_capacity', '__heap_base']) {
    assert.ok(names.has(name), `${name} must be exported`);
  }
});

test('the allocator is built by every build that links a kernel which uses it', () => {
  const allocate = readFileSync('cpp/src/fe_heap.cpp', 'utf8');
  assert.match(allocate, /__heap_base/, 'the wasm build starts the heap at __heap_base');
  assert.match(allocate, /__builtin_wasm_memory_grow/, 'the wasm build grows a page at a time');

  const build = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');
  assert.match(build, /'cpp\/src\/fe_heap\.cpp'/, 'fe_heap.cpp must be in CPP_SOURCES');
  const cmake = readFileSync('CMakeLists.txt', 'utf8');
  assert.match(cmake, /cpp\/src\/fe_heap\.cpp/, 'fe_heap.cpp must be in FE_CORE_SOURCES');

  /* The native suites compile a subset of the sources; a kernel that allocates
     has to bring the allocator with it or the link fails. */
  for (const suite of ['tests/cpp-core-engine.test.mjs', 'tests/cpp-editmesh.test.mjs']) {
    const source = readFileSync(suite, 'utf8');
    assert.match(source, /cpp\/src\/fe_heap\.cpp/, `${suite} must link fe_heap.cpp`);
  }

  /* Every kernel that allocates includes the header. */
  for (const file of [
    'cpp/src/fe_renderer.cpp',
    'cpp/src/fe_simulation.cpp',
    'cpp/src/fe_volumetrics.cpp',
    'cpp/src/fe_editmesh.cpp',
    'cpp/src/fe_surface.cpp',
    'cpp/src/fe_wasm_exports.cpp'
  ]) {
    assert.match(readFileSync(file, 'utf8'), /#include "\.\.\/include\/fe_heap\.hpp"/, `${file} must include fe_heap.hpp`);
  }
});

test('the documented artifact numbers are the shipped artifact', async () => {
  const { bytes, mod } = await boot();
  const exports = WebAssembly.Module.exports(mod).length;
  const doc = readFileSync('docs/ENGINE-ARTIFACT.md', 'utf8');
  assert.ok(
    doc.includes(`${bytes.length}`),
    `docs/ENGINE-ARTIFACT.md must quote the shipped size (${bytes.length} bytes)`
  );
  assert.ok(
    doc.includes(`${exports} exports`),
    `docs/ENGINE-ARTIFACT.md must quote the shipped export count (${exports})`
  );
});
