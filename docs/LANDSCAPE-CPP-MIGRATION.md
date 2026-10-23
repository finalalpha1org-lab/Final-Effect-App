# Landscape C++ migration — approved architecture

Approved: hybrid procedural stack + interactive sculpt; selectable high-resolution terrain up to 512 segments; migration of all landscape heavy systems; one unified `fe_core_engine.wasm`.

## Implemented foundation (now wired into the landscape UI)

`cpp/src/fe_landscape.cpp` provides persistent buffers, bounded 16–512 segment grids, deterministic warped/ridged generation, layered biome-colour shading, height sampling, continuous stroke brushes, dirty bounds, brush erosion, region/global normals and palette colours. Hydraulic/thermal full-map requests still return -2 rather than substituting smoothing. The ABI header also contains planned declarations; a declaration is NOT an implemented/exported feature.

Tests: `node --test tests/landscape-cpp.test.mjs tests/cpp-core-engine.test.mjs` — 9 passing. These validate computational behavior, not rendered appearance or viewport FPS.

## Ordered remaining work

1. Add worker-owned engine initialization and command queue, cancellation/versioning, buffer ownership and memory budgets. Connect island generation/brush/normal updates while preserving undo, autosave and Workspace export. Avoid sharing a resettable scratch arena with persistent buffers. **Open:** the landscape bridge still runs on the main thread and cancellation is not implemented; the per-command dirty-rectangle copies are the current mitigation.
2. Implement mass-accounted hydraulic erosion and conservative thermal transport; flow, sediment and talus masks. Validate conservation, border continuity, deterministic seeds and cancellation. Build a non-destructive parameter stack with cache invalidation.
3. Add selectable 128/256/512 resolution with resampling, correct texture dimensions, bounded upload ranges and seam-aware chunk neighbors. UI controls must report actual resolution.
4. Connect height-blended triplanar albedo/normal/roughness/AO materials. Preserve existing lighting/material authoring; use licensed high-quality assets. GPU shaders remain GPU code, not CPU C++ loops.
5. ~~Port spectral ocean FFT, priority-flood hydrology, chunk generation, spatial scatter~~ — landed, with parity/behavior tests and per-subsystem JS fallbacks (see the sections below). Still open from this item: the plant-placement solver inside `createChunkJob`, chunk mesh/instance buffer construction, seabed and planet generation. Remove heavy JS only after parity tests and integration checks pass.
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
used unchanged.

`fe_terrain_scatter_natural(count, spread, seed, water_level, max_slope, clump,
patch_scale)` is the ground-cover variant: it rejection-samples the resident
heightfield so a candidate is only accepted above the water margin and under the
species slope limit, then thins the accepted points through a value-noise patch
field (`clump` comes from the Grove-clustering slider, 22 m patches). The six
cover kinds (grass, tall grass, flower, daisy, tulip, lavender) use it; trees,
shrubs and rocks keep the jittered grid because their occupancy rules depend on
per-species footprints that stay in JS. Rejection is budget-bounded (16× the
requested count), seeded, and returns a short count instead of failing, so the
JS loop fills the remainder. Measured on the same 257² grid: about 6 % of an
8192-point clumped request is rejected on a 20° slope, and quadrat analysis over
an 8×8 grid shows the clumped field spreading ≈2.5× wider than the uniform grid
at 2000 points, i.e. visible groves rather than an even carpet. Measured on a 257² grid (Node 22, sandbox CPU): 40 ns per
candidate in C++ versus 161 ns in JS for the same bilinear height + central
difference slope, i.e. ≈8 ms versus ≈32 ms for 200k candidates. That is only the
sampling stage - instancing, tinting and occupancy still dominate total scatter
time, so this is a real but modest win, not a rewritten scatter pipeline.

Open World generation does not run through the single-grid `fe_terrain_*`
kernels at all: it has its own sampler and chunk kernels (below).

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

## Tessendorf ocean in C++

`cpp/src/fe_ocean.cpp` owns the three-cascade spectrum and both inverse FFTs.
`fe_ocean_configure(resolution, len0, len1, len2, wind_speed, wind_dir_deg, seed)`
rebuilds the seeded `h0(k)` tables, and
`fe_ocean_update(time, amplitude, choppiness, max_height_encode, max_displace_encode)`
advances the gravity-dispersion phase, runs the 2D IFFT for each cascade and
normalises the surface. Kernel outputs:

- `fe_ocean_get_cascade_float4_ptr(i)` — raw `[height, dx, dz, 1]` floats.
- `fe_ocean_get_cascade_rgba8_ptr(i)` — the packed RGBA8 bytes the water shader
  samples, encoded exactly like the JS shader packing.
- `fe_ocean_ifft2d_f32(real, imag, n)` — the shared inverse transform.

The inverse transform precomputes twiddle factors per resolution and the
configure step stores one unit wave direction per cell, so the per-frame loops do
no trigonometric work. Foam is a C++ Jacobian pass: `fe_ocean_get_cascade_foam_ptr(i)`
returns a 0–1 field that marks folded crests, using an adaptive per-frame
mean/σ threshold (`z0 = 2.05 − 0.65 · strength`, with strength from choppiness
and wind) because a fixed threshold produced no foam at any tested amplitude.
The shader samples cascade 0 through `uFFTFoam` and takes
`max(analytic crest foam, C++ foam)`.

The shore band is a depth-driven sheet, not a fixed plateau: a travelling wave
set (`sin(t·1.05 − k·uWindDir)`, plus a slower cross-set) drives a smoothstep
run-up that widens the band with `uShoreFoam` and the live amplitude, adds a
bright waterline lip and is broken by two octaves of lace noise before it feeds
the shared foam mask. Foam amount, Crest threshold and Shore foam width remain
live uniforms, and the water program cache key moved to
`terrain-water-pbr-v9-triplanar-fft-foam-shore-sets` so a cached shader cannot
hide the change.

The bridge (`FELandscapeCore.oceanConfigure / oceanUpdate / oceanCascade /
oceanCascadeRgba / oceanCascadeFoam`) drives `updateTessendorfOcean`, which keeps its per-quality
update interval and its minified JS bundle as the fallback. Parity is pinned by
`tests/ocean-cpp.test.mjs`: all three cascades are compared with
`tessendorf-ocean.js` for three configurations, and the packed bytes are
compared with the JS encoder.

| ocean update, 3 cascades | C++ | JS fallback | result |
| --- | --- | --- | --- |
| 64² | 2.7 ms | 57.7 ms | ≈21× faster |
| 128² | 12.5 ms | 277.6 ms | ≈22× faster |
| 256² | 58.0 ms | 1245.4 ms | ≈21× faster |

A later interleaved A/B run against the previous C++ build (twiddles + cached
wave directions, foam excluded) measured 2.54 → 1.73 ms at 64² (1.46×),
11.10 → 7.86 ms at 128² (1.41×) and 56.07 → 40.74 ms at 256² (1.38×). The
Jacobian foam pass was added after that measurement and is not included in
those numbers.

Max deviation from the reference is 4e-7 on amplitudes around 1.5 (float32
storage rounding) and the packed RGBA8 bytes match exactly. CPU numbers only.

## Degraded / stale artifacts

The landscape bridge treats only the nine original terrain kernels as mandatory.
Everything newer (strata, scatter, Open World, terrain LOD, ocean) is optional,
is listed in `FELandscapeCore.missing`, and falls back per subsystem instead of
failing the whole bridge. The on-device benchmark now includes a "Landscape &
Ocean Kernels" row that runs a 32² ocean update inside the engine and names any
kernel that is missing, so an older cached wasm shows exactly which subsystem is
degraded rather than reporting a generic failure. Since a single new optional
kernel (for example `fe_terrain_scatter_natural`) makes `missing` non-empty, the
self-test row lists the kernel names in its detail line - "2 kernels on JS
fallback: fe_ocean_update, fe_lod_classify" - and its own test stubs a partial
bridge to pin that wording.

A degraded row after an app update therefore means the page is running against a
stale cached `fe_core_engine.wasm`, not that the kernel is broken. The service
worker cache name moved to `final-effect-cpp-v3` in the same change as the new
kernel, so a normal reload re-precaches the matching wasm; `refreshAppCache()` in
the ⚙ sheet clears caches and service-worker registrations for an install that is
still stuck.

Still JS: worker message passing, chunk mesh/instance buffer construction and the
GPU uploads themselves (three.js buffers and WebGL calls cannot move into wasm),
the occupancy/capacity rules that accept or reject a scatter candidate, and the
plant-placement solver inside `createChunkJob`. The ocean math, its foam field,
strata and both scatter candidate generators are C++.
