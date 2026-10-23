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
