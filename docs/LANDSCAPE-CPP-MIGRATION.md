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

That sentence used to continue "there is no quadtree over the foliage itself".
There is now: `fe_lod_tree_build`/`fe_lod_tree_cull` index each species once and
answer the same visible list and tiers as the flat kernel, exactly, with the
brute-force comparison in `tests/landscape-quadtree-lod.test.mjs` as the proof.
Beyond the far tier, species with a baked atlas are drawn as a single
camera-facing quad sampling eight baked azimuths (`fe_impostor_build`). Both are
described in `docs/LOD-QUADTREE.md`, including what they do not do.

The atlas bake is also the first payload of the off-thread kernel channel
(`kernel-worker.js`): a second instance of the same artifact runs the bake in a
Worker and transfers the pixels back, so a 20–36 ms rasterise never lands in a
frame. `docs/KERNEL-WORKER.md` has the numbers and the fallback rules.

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

## Chunk seams: heights were already shared, normals were not

Each chunk is sampled from the same world-space noise, `owHeightAt(x, z)`, over a
grid that starts at `origin − size/2` with a step of `size/segments`. Two
neighbours therefore evaluate the *same* world coordinates along their shared
edge, so the height seam has never existed — a test asserts bit equality, not an
epsilon.

The normal did pop. `fe_ow_surface_grid()` derives the slope from central
differences, but on the grid border the neighbour is outside the chunk, so it
used to clamp the difference to the edge value. That made the border slope
one-sided on both sides of the seam, with different results: measured on the
shared edge of two consecutive chunks, up to **0.17** of a surface weight
differed, which is a visible line in both the lighting and the biome blend.

The fix evaluates the missing neighbour straight from the noise:

```cpp
hl = i ? owHeights[j * row + i - 1] : owHeightAt(x - step, z);
hr = (i + 1 < row) ? owHeights[j * row + i + 1] : owHeightAt(x + step, z);
```

Cost is four extra noise evaluations on the border ring (128 of 1 089 vertices at
33²), and the shared edge is now bit-identical in height **and** surface weight
in both x and z — pinned by `tests/landscape-cpp.test.mjs`.

## Erosion a slice at a time

`fe_terrain_erode_hydraulic()` blocks: 50 000 droplets is 174 ms on a 256² field,
which is a dozen dropped frames. The droplet loop is now a shared function, and
the panel drives it through a second entry point:

| Call | What it does |
| --- | --- |
| `fe_erosion_begin(count, lifetime, …)` | validates, seeds the RNG, clears the rectangle |
| `fe_erosion_set_region(cx, cz, radius)` | the square of rain that is actually simulated (`radius ≤ 0` = whole map); a patch that would hang over the border is moved inwards instead of being clamped cell by cell |
| `fe_erosion_step(droplets)` | runs one slice, returns how many ran |
| `fe_erosion_dirty_ptr()` | `uint16[4]` = `min_i, min_j, max_i, max_j`, inclusive, one-cell halo |
| `fe_erosion_remaining()` / `_total()` / `_active()` | progress |
| `fe_erosion_cancel()` | stop; also implied by `fe_terrain_init()` |

The batch call and the live run share `eroRun()`, so they cannot drift apart.
Because a droplet is independent of every other droplet and draws its two random
numbers at birth, the split is exact: `700 + 700 + …` produces the same heights,
bit for bit, as one call. Tests assert that equality and that a different slice
size gives the same field.

The rectangle is why a live run is cheaper than a refresh: 65 rows out of 513 is
196 KB per attribute instead of 774 KB, and the three surface-weight attributes
and the height texture are not touched at all until the run ends. `updLive()`
in `terrain-main-01.js` writes `BufferAttribute.updateRange` so three uploads the
band with `gl.bufferSubData` rather than the whole array, and `updLiveHeight()`
patches the shader height texture in 32-row `texSubImage2D` blocks; `fe_terrain_compute_normals_region()`
rebuilds only the normals of that band and a test compares it cell for cell with
the full pass.

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

## Eulerian smoke & fire core

`cpp/src/fe_volumetrics.cpp` is the gas half of the solver stack. The land/ocean
kernels above are heightfield and spectral work; this one is a volumetric field:

- **Staggered MAC grid** (`fe_vol_init(nx,ny,nz)`, 8–40 cells per axis, at most
  40³). Face velocities `u/v/w`, cell-centred density, temperature and pressure.
- **Semi-Lagrangian transport** with RK2 backtracing for all three velocity
  components and both scalars, which keeps the step stable at any time step.
- **Temperature buoyancy** on the y faces, **vorticity confinement** from a
  centre-difference curl, and a **Jacobi pressure projection** with Neumann
  walls (`fe_vol_step(dt, buoyancy, vorticity, dissipation, cooling, iterations)`).
- **`fe_vol_source(cx,cy,cz,r,heat,density,lift)`** injects a smooth puff;
  `fe_vol_stats_ptr()` returns `[divBefore, divAfter, meanDensity, maxTemp,
  maxSpeed, steps]`; density, temperature and the centre velocity fields are
  exposed as raw pointers for the GPU volume texture.
- **`fe_vol_surface(iso, maxVerts)`** extracts the isosurface with a dual
  (surface-nets) pass: one vertex per crossed cube, then one quad per
  sign-changing sample edge, plus analytic gradient normals. It returns a vertex
  count, `-2` when a buffer would overflow and `-1` for invalid input. It is a
  smooth, closed manifold without the 256-case marching-cubes table; it is not
  adaptive and it caps at 36³ for meshing.

Measured in Node 22 on the sandbox CPU (single wasm instance, 40 Jacobi
iterations, source injected every ten frames):

| grid | step | divergence before → after | notes |
| --- | --- | --- | --- |
| 24³ | 9.3 ms | 14.6 → 1.05 | real-time budget at 30 Hz |
| 32³ | 19.0 ms | 49.3 → 4.70 | 30 Hz with a reduced iteration count |
| 40³ | 38.2 ms | 84.9 → 4.06 | offline / heavy preset |

Surface extraction on a noisy 32³ sphere: 1762 vertices, 10560 indices, 1.2 ms.
The tests assert a >75 % divergence reduction, temperature-driven rise,
dissipation, bit-identical determinism and a watertight manifold (every edge
shared by exactly two triangles, unit outward normals).

**Rendered as a voxel volume in the Fluid modifier.** `Fire`, `Smoke` and
`Fire + Smoke` domains now default to the voxel solver and are drawn by a
raymarch pass; the particle tracers stay as the fallback.

- `simulationCore.createVolumeSimulation` maps `Resolution` (32–96) onto a
  16–28³ grid (default 24³), calls `fe_vol_init`, and builds the volume mesh from
  the domain bounds.
- `volume-atlas.js` tiles the z slices of the density/temperature grid into one
  RGBA8 2D atlas (R density, G temperature), so the shader works on WebGL1 and
  WebGL2 without `sampler3D`. `stepVolumeSimulation` runs `fe_vol_step` at 30 Hz
  (accumulated from the fixed simulation step), repacks the atlas and marks the
  texture dirty.
- The raymarch shader intersects the domain box from `cameraPosition`, samples
  four neighbouring slices with Catmull–Rom and composites emissive fire plus
  absorbing smoke (Beer–Lambert) with a per-pixel dither offset.
- Fire colour comes from a Planckian ramp (dull ember → orange → white-hot) and
  a two-tap march toward `uSunDir` shadows it: smoke in front of the flame
  darkens it and the flame lights the smoke around it.
- The grid target is device-tiered: 24³ on coarse-pointer or ≤4-core devices,
  28³ on larger desktops, scaled by the modifier's `Resolution` field.
- Mapping: `Heat Emission`/`Fuel` → source heat, `Smoke Density` → source
  density, `Buoyancy` → y acceleration, `Dissipation Rate` → density decay and
  cooling, `Vorticity Confinement` → confinement, `Time Scale` → step rate.
  `Gravity` does not act on the gas (buoyancy is applied directly), which is a
  limitation, not a physical gravity solve.
- The `Volume Solver` checkbox (default on, shown only for fire/smoke domains)
  turns the voxel path off; `createBuoyantParticles` then renders the previous
  tracers unchanged. The C++ grid is static, so a second simultaneous volume
  domain also falls back to particles.

The ⚙ diagnostics self-test keeps its eighth row, "Smoke & Fire Volume Solver"
(16³, four steps, divergence + a meshed sphere), so a phone can prove the kernel
runs even without opening the viewport.

**Verification boundary:** the C++ field, the atlas packing, the record plumbing
and the shader source are covered by tests against the real wasm
(`tests/fire-smoke-volume.test.mjs`, `tests/volume-atlas.test.mjs`), but no GPU
renders in CI or in the sandbox. Colour, opacity and step count are tuned from
sampled field ranges (max density ≈0.34, max temperature ≈1.3 at 24³ with the
default presets) and still need a device check before this is called
photorealistic. Browser volume rendering also costs fill rate: the 24³ grid at
30 Hz is roughly 5 ms of CPU on the sandbox and the raymarch is 48–64 samples per
pixel.

### Sparse volumes (VDB) — what is realistic here

OpenVDB's value is a sparse hierarchical grid (root → internal nodes → 8³ leaf
tiles) with narrow-band level sets, multiresolution sampling and fast filters.
That is what lets Houdini hold a 1024³-looking plume while touching only the
band of cells that contains smoke. Two things follow for this project:

1. **The library itself cannot be linked into this build.** OpenVDB needs TBB,
   Blosc, Boost/IMath and threads; the wasm core is freestanding C++20 with no
   OS, no threads and no external dependencies. Vendoring and porting it is a
   project of its own, not a change. A VDB-*style* tiled grid written in this
   codebase is feasible; OpenVDB is not.
2. **A sparse grid alone does not make the image photoreal.** The visible
   difference between "voxel smoke" and "Houdini smoke" is mostly resolution
   *where smoke exists*, filtering, lighting and renderer quality (multiple
   scattering, self-shadowing, motion blur, path-traced offline renders). The
   current pass attacks the cheap half of that (cubic filtering, Planckian
   emission, sun shadowing, tiered resolution); the expensive half is the next
   milestone.

A real sparse solver would need active-tile tracking for advection, a sparse
pressure solve with correct boundary conditions and tile-aware meshing, plus
tests that compare sparse and dense results where the fields overlap. That is a
multi-step change, not a shader tweak, and it should land behind the same
particle fallback.

The kernel is deliberately absent from `FELandscapeCore.missing` because the
landscape bridge does not consume it.

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
the occupancy/capacity rules that accept or reject a scatter candidate, the
plant-placement solver inside `createChunkJob`, and the volume raymarch shader
plus its 2D atlas packing (a GPU bridge concern). The ocean math, its foam field,
strata, both scatter candidate generators and the smoke/fire grid are C++.
