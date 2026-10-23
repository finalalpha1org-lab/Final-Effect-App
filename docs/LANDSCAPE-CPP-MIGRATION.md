# Landscape C++ migration — approved architecture

Approved: hybrid procedural stack + interactive sculpt; selectable high-resolution terrain up to 512 segments; migration of all landscape heavy systems; one unified `fe_core_engine.wasm`.

## Implemented foundation (now wired into the landscape UI)

`cpp/src/fe_landscape.cpp` provides persistent buffers, bounded 16–512 segment grids, deterministic warped/ridged generation, layered biome-colour shading, height sampling, continuous stroke brushes, dirty bounds, brush erosion, region/global normals and palette colours. Hydraulic/thermal full-map requests still return -2 rather than substituting smoothing. The ABI header also contains planned declarations; a declaration is NOT an implemented/exported feature.

Tests: `node --test tests/landscape-cpp.test.mjs tests/cpp-core-engine.test.mjs` — 9 passing. These validate computational behavior, not rendered appearance or viewport FPS.

## Ordered remaining work

1. Add worker-owned engine initialization and command queue, cancellation/versioning, buffer ownership and memory budgets. Connect island generation/brush/normal updates while preserving undo, autosave and Workspace export. Avoid sharing a resettable scratch arena with persistent buffers.
2. Implement mass-accounted hydraulic erosion and conservative thermal transport; flow, sediment and talus masks. Validate conservation, border continuity, deterministic seeds and cancellation. Build a non-destructive parameter stack with cache invalidation.
3. Add selectable 128/256/512 resolution with resampling, correct texture dimensions, bounded upload ranges and seam-aware chunk neighbors. UI controls must report actual resolution.
4. Connect height-blended triplanar albedo/normal/roughness/AO materials. Preserve existing lighting/material authoring; use licensed high-quality assets. GPU shaders remain GPU code, not CPU C++ loops.
5. Port spectral ocean FFT, priority-flood hydrology, chunk generation, spatial scatter, seabed and planet generation. Remove heavy JS only after parity tests and integration checks pass.
6. Port remaining Workspace geometry and scene processing in separately tested increments; locked studios are not implemented products and must not be reported as migrated.

## Acceptance and measurement

Measure CPU kernels, worker latency, upload bytes, GPU frame time, p50/p95 brush latency and full viewport frame time separately on named hardware. 60 FPS means a full-frame budget of 16.67 ms; kernel timings alone are not viewport FPS. C++ does not automatically provide Gaea/Unreal visual parity. Browser GPU rendering still requires a thin JS/WebGL or WebGPU bridge and shaders.

Baseline landscape suites before migration: 61 tests, 48 passing, 13 failing (including obsolete blank Open World expectations and mismatched LOD/reflection assertions). Reconcile behavior-based tests explicitly, not by hiding failures or removing functional Open World features.

## Live Studio wiring update

`terrain-main-01.js` now loads a dedicated instance of the shared WASM artifact.
The actual default-terrain sculpt entry point routes raise/lower/flatten/smooth/
terrace and brush hydraulic erosion to C++. The terrain GPU upload path receives
C++ finite-difference normals. Current JS height data is copied in before every
operation, so undo/import/external edits remain authoritative; GPU uploads, colour
calculation, history and surface-paint workflows remain JS. Erosion preserves the
existing droplet model, with seeded native randomness (not JS Math.random parity).

Inspect `FELandscapeCore.ready`, `.backend`, `.error`, and `.commands` in the studio
frame. Loading/unsupported tools/WASM failure retains the existing JS path, and a
load failure emits a warning. This instance runs on the main thread: this update
is **not** the terrain worker migration. Normal calculation uses height gradients,
not triangle-averaged Three.js normals, so shading may change slightly.

## Terrain core migration update

Generation, biome/paint shading, normals, height sampling copies and all sculpt
brushes now execute in C++:

- `fe_terrain_generate_layered` renders the warped four-octave ridge field plus
  island falloff (or continental mountains) directly into the persistent grid.
- `fe_terrain_compute_colors` reproduces the studio's grass/soil/rock/sand/snow
  blend, 12-layer PBR paint weights, material override and per-vertex variation.
- `fe_terrain_set_palette` / `fe_terrain_set_paint_colors` receive the active
  biome palette and PBR colours; JS remains the authoring surface for those.
- JS keeps undo/redo, autosave/export, paint authoring, Three.js buffers and the
  GPU upload path. It re-uploads the dirty height/weight/material rectangle
  before each C++ command, so undo, imports and the JS fallback stay coherent.
- The WASM binary is embedded in standalone builds, so the first generated
  terrain is already C++-produced; the network fetch is only a fallback.

**One-time realization change:** the C++ generator uses a new deterministic
integer hash instead of the old `sin()`-based JS hash. The same seed now produces
a different (but equally deterministic) terrain than builds before this change.
Saved projects keep their stored height/paint data, so they are unaffected.
There is no exact bit-for-bit JS/C++ parity test because the two hash families
differ; tests cover determinism, seed variation, island borders, continental
mode, paint blending and invalid-input rejection.

Still outstanding: worker-thread scheduling and cancellation, full-map hydraulic/
thermal erosion stacks, spectral ocean FFT, hydrology, scatter, planet/open-world
chunk generation and terrain LOD. Do not describe Landscaping as fully C++
migrated while those systems remain in JS.

### Build embedding and measurements

`scripts/build.mjs` now embeds the unified `fe_core_engine.wasm` as base64 in
both `build/client/Terrain_system_.html` and the standalone terrain page, before
the studio scripts. `FELandscapeCore` therefore binds synchronously on the first
frame; a network fetch is only used for direct source-file development.

Sandbox CPU measurements (Node 22 + WASM, not a phone or GPU benchmark):
128² ≈ 4 ms generate / 3 ms shade; 256² ≈ 15 ms / 6 ms; 512² ≈ 57 ms / 23 ms.
Shading timings include the JS↔WASM dirty-region copies and the colour download.
Brush frames copy only the dirty rectangle, so they are cheaper than a full-map
shade. These numbers say nothing about viewport FPS.

## Whole-map erosion and foliage LOD

`fe_terrain_erode_hydraulic` runs a seeded droplet model over the whole grid and
`fe_terrain_erode_thermal` performs mass-conserving talus slumping. Both are wired
to Terrain-tab buttons through `FELandscapeCore.erode`; the result is uploaded
to the same mesh and is undoable. Hydraulic droplets leave the map carrying
sediment, so the height sum is not conserved (measured ≈2%/100 droplets on a
41² test grid); do not describe it as a mass-balanced solver. Thermal transfer
is exactly conservative inside the border and deterministic.

Default-terrain foliage now has a distance LOD tier: ground cover/trees route to
`lowMeshes` with reduced grass geometry and map-free materials, with a stable
per-instance threshold and hysteresis band. A Quality-tab slider controls the
750 m default full-detail radius and persists it. Tier changes are deferred for
240 ms after camera movement, and low-shadow species remain governed by
`SHADOW_LOW_DETAIL`. Low batches mirror instance capacity, so memory roughly
doubles for LOD species - important on phones. This is not mesh decimation for
trees; their low tier reuses the same geometry with a cheaper material.

## Strata terracing and C++ scatter candidates

`fe_terrain_apply_strata` (previously declared in `fe_abi.h` but never
implemented) terraces the heightfield toward tilted, noise-warped band floors.
The pull is strongest mid-band and zero at band edges, so it blends into the
slope instead of tearing stepped discontinuities. It is exposed as a third
Terrain-tab button next to hydraulic and thermal erosion and is undoable.

`fe_terrain_scatter_batch` produces jittered-grid scatter candidates (x, z,
height, slope) from the resident heightfield. Auto-scatter now asks the C++ core
for candidates in 4096-point batches and only runs the biome/occupancy/instance
rules in JS; if the core is unavailable the original pure-JS random placement is
used unchanged. Measured on a 257² grid (Node 22, sandbox CPU): 40 ns per
candidate in C++ versus 161 ns in JS for the same bilinear height + central
difference slope, i.e. ≈8 ms versus ≈32 ms for 200k candidates. That is only the
sampling stage - instancing, tinting and occupancy still dominate total scatter
time, so this is a real but modest win, not a rewritten scatter pipeline.

Still JS: ocean configuration, Open World hydrology/river tracing, worker
scheduling and terrain LOD. Open World generation does not run through the
single-grid `fe_terrain_*` kernels at all.

## Open World generation, scheduling and hydrology

`cpp/src/fe_openworld.cpp` now owns the streamed Open World maths:

- `fe_ow_set_params` + `fe_ow_height_at` — the seeded chunk sampler. JS
  `OpenWorldGenerator.heightAt` asks C++ first, so brush placement, spawn search
  and generated chunks share one height field.
- `fe_ow_height_grid` / `fe_ow_surface_grid` — one call fills a whole chunk
  (193² vertices max) with heights, biome weights and the 12 blended surface
  weights. `createChunkJob` still steps in rows and plants in JS; only the maths
  moved. Segments above 192 fall back to the JS sampler.
- `fe_ow_plan_chunks` — nearest-first chunk ring with the world-bounds test, used
  by `owRefresh` to order the stream queue. The JS loop remains for fallback.
- `fe_ow_hydro_set_grid` / `fe_ow_hydro_trace` — two smoothing passes,
  priority-flood drainage and downhill river tracing (sources spread by spacing,
  minimum length, edge/sea/join termination). `open-world.js` feeds it the same
  `S.gs` grid the JS solver used and converts the returned polylines into the
  existing river records; the JS solver is untouched as the fallback.
- `fe_lod_classify` — bulk foliage terrain-LOD classification (0 full, 1 low,
  -1 culled) with the same hashed threshold and the 8 km ground / 14 km tree
  cutoffs. `sync()` uploads instance positions once and reads tiers per instance.

Measured on the sandbox CPU (Node 22, single wasm instance, 20-run average; the
JS baseline is `open-world-generator.js` without the C++ path):

| kernel | C++ | JS fallback | result |
| --- | --- | --- | --- |
| 65² chunk height grid | 3.5 ms | 94.8 ms | ≈27× faster |
| 65² chunk surface grid (12 weights/vertex) | 2.1 ms | 86.4 ms | ≈42× faster |
| hydrology set-grid, 288² (smooth + priority flood) | 13.4 ms | — | one call per world |
| river trace, 7 rivers | 1.4 ms | — | |
| chunk plan, 13×13 ring | 0.03 ms | — | |
| LOD classify, 30k instances | 0.5 ms | — | |

These are CPU numbers only — not a phone benchmark and not a viewport FPS claim.
The JS fallback still ships and is used whenever the core is unavailable.

Still JS: ocean (the Tessendorf bundle and its FFT textures), worker message
passing, chunk meshing/instancing, and the plant-placement solver inside
`createChunkJob`.
