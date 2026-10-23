# Landscape C++ migration — approved architecture

Approved: hybrid procedural stack + interactive sculpt; selectable high-resolution terrain up to 512 segments; migration of all landscape heavy systems; one unified `fe_core_engine.wasm`.

## Implemented foundation (not yet connected to the landscape UI)

`cpp/src/fe_landscape.cpp` provides persistent buffers, bounded 16–512 segment grids, deterministic warped/ridged generation, height sampling, continuous stroke brushes, dirty bounds, region normals and basic palette colors/cavity mask. Hydraulic/thermal brush requests return -2 rather than substituting smoothing. The ABI header also contains planned declarations; a declaration is NOT an implemented/exported feature.

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

Still outstanding: UI wiring for C++ terrain generation, surface paint/colour,
full erosion stack, ocean, hydrology, scatter, planet/open-world generation and
worker scheduling. Do not describe Landscaping as fully C++ migrated.
