# Frame budget: what reaches the GPU, and when

This page exists because "0 wasm imports" says nothing about a phone's frame
time. The bottleneck in a foliage scene is the cost of *submitting and shading*
geometry, not of calling into the core. Everything below is either measured in
this repository or explicitly marked as not done.

## How foliage is drawn today

* Every species is a `THREE.InstancedMesh` with a capacity fixed at build time
  (`mk()` in `terrain-main-01.js`). One grass quad, one leaf card and one tree
  trunk each go to the GPU **once**; a frame only writes matrices and colours
  into buffers that already exist.
* A species with two parts (wood + leaves) is two draw calls. The decimated LOD
  twin adds one more, and the grass/tall-grass shadow proxy one more. A studio
  with ~30 species therefore issues on the order of 45–70 instanced draw calls,
  not one per plant.
* `sync()` writes `setMatrixAt`/`setColorAt` in place and sets `m.count`. It
  never creates a mesh, a material or a typed array — the single scratch buffer
  it uses for the LoD call grows once and is then reused.
* The render loop allocates nothing per frame: index loops replace the two
  `forEach` closures that used to be created 60–120 times a second, the LoD kind
  list is cached until a species is added, and the per-instance classification
  is one core call.

## What this turn changed

| Change | Why |
| --- | --- |
| Index loops for clouds and per-frame callbacks | no closure allocated per frame |
| Cached LoD kind list (`foliageLodKinds`) | the list used to be rebuilt with `[...Set].filter()` every frame |
| One reused `lodScratch` buffer | a camera settle no longer allocates an `n×3` float array |
| Tsunami ↔ wind-sea blend (`uTsF`) | the two wave systems are mixed by one factor instead of being added together |
| `fe_lod_visible` in the core | the CPU no longer walks instances it will not draw |
| Ground-cover density falloff in the core | grass stops at the horizon instead of overdrawing it |
| Rain → PBR roughness + puddle ripples | wet surfaces are a shader uniform, not a particle system |
| Chunk-level *Fill unpainted ground only* | a painted 256 m tile is never speckled by a fill |

## The two stalls that were actually measurable

The landscaping studio had two costs that were large enough to measure on a
desktop CPU, and neither of them was the one that looked expensive. Both were
found by timing the call, not by reading the shader.

**`fe_surface_detail` ran five noise evaluations per texel.** It is the kernel
that bakes the triplanar detail normal/roughness field for every PBR surface
(terrain 256², foliage and leaf cards 128²). Every texel sampled the same height
noise five times — once for itself and once per Sobel neighbour — so a 512² bake
re-evaluated its own height field 1.3 million times.

It now runs two passes: pass one writes the height into a `w*h` float scratch
buffer, pass two reads that buffer through the *same* wrapped `iL/iR/jD/jU`
indices and the same 5-tap sign convention. The output is **bit-identical**, not
approximately equal — the 12 baseline hashes in `tests/surface-detail.test.mjs`
(4 surface kinds × 3 sizes) were compared byte for byte against the old build,
because a different kernel would silently change every surface in the app.

| Bake | Before | After |
| --- | --- | --- |
| 256 × 256 | 75.9 ms | **13.3 ms** |
| 512 × 512 | 302.6 ms | **43.1 ms** |

**The landscaping renderer was re-rendering the shadow map every frame.** The
3D workspace viewport already gated its shadow pass to 30 Hz, but the studio's
`renderer.shadowMap.autoUpdate` was still on, so a static scene paid for a full
2048² depth pass at display refresh rate. It now uses the workspace rule:

* `autoUpdate = false`; `shadowCadence(now)` arms `needsUpdate` when the light
  rig reports dirty or when 33 ms have passed since the last update;
* only `updateDirectionalShadowFocus` sets dirty, and it already throttles
  itself to 220 ms with a ±2 m snap, so panning the camera does not smear the
  shadow;
* latency when the user actually moves the sun is ≤ 33 ms, i.e. one or two
  frames — no visible lag, and no blur filter paying for a stale map.

`tests/shadow-cadence.test.mjs` slices the real function out of
`terrain-main-04.js` and drives it with a fake renderer, so the test fails if
someone raises the interval or forgets to arm the first update.

## Instance transforms: the settle stutter

Every plant in the studio is one instance in an `InstancedMesh`, and the matrix
that places it used to be composed in JavaScript through a `THREE.Object3D`:

```js
dm.quaternion.setFromUnitVectors(UP, groundNormal(x, z, align)); // sqrt + rsqrt
dm.quaternion.multiply(axisAngle(UP, o.r));                      // 2 trig calls
dm.quaternion.multiply(euler(tiltX, 0, tiltZ, 'YXZ'));           // 2 trig calls
dm.scale.set(bw, s, bw);
dm.updateMatrix();                                               // 4x4 compose
mesh.setMatrixAt(i, dm.matrix);                                  // 16 float copy
```

That is correct, and it was measured: **18.2 ms for 30 000 instances** on a
desktop CPU, and a phone is three to five times slower. It runs on every camera
settle (the quadtree re-culls 240 ms after the camera stops) and after every
edit that regrows a species — so it is felt as a stutter, not as a lower frame
rate. Two things were wrong with it beyond the raw cost:

* it ran **once per mesh**. A species with a wood mesh and a leaf mesh walked
  its whole instance list twice, so the terrain sampling for the root sink (24
  `hgt()` lookups per tree) was done twice as well;
* it allocated and wrote through JS objects — property lookups, a shared
  `Object3D`, a `Matrix4` — for arithmetic that is a pure function of the
  instance and the ground under it.

It is now `fe_scatter_begin` / `fe_scatter_matrices` (`cpp/src/fe_scatter.cpp`):

* one pre-pass per species fills a structure-of-arrays block — position, both
  scales, yaw, the terrain normal it is aligned to, and the two placement
  hashes — while it writes the per-instance scratch the colour and the impostor
  quad need (`fe_scatter_aux_ptr`). **No JavaScript allocation**, and the root
  sink is sampled once instead of once per mesh;
* the kernel turns that block into `count * 16` floats in one flat loop, reading
  the compacted visible index list the quadtree just produced
  (`fe_scatter_order_ptr`) so invisible instances are never touched;
* the caller blits the block into `instanceMatrix.array` with a single `set()`.

| | before | after |
| --- | --- | --- |
| 30 000 instances, transform only | 12.1 ms | **3.8 ms** |
| 30 000 instances, two meshes, with root-sink sampling | 84.4 ms | **34.9 ms** |

The second row is a worst case, not a typical scene: it puts the root-sink loop
on all 30 000 instances, while in a real world it runs only for woody species
(a few thousand trees). The row that matters for the frame is the first one —
ground cover is where the instance counts are.

The kernel reproduces the three.js transform, it does not approximate it:
`tests/scatter-layout.test.mjs` compares every one of the 16 components against
an `Object3D` driven the old way, for both rotation modes, and checks scale,
orthogonality and the compacted order. The tolerance is 6e-5 because the module
is compiled freestanding and cannot call a platform libm — `cpp/src/fe_scatter.cpp`
therefore carries its own double-precision sin/cos, which brings the difference
down to float32 rounding. Anything actually wrong (a flipped sign, tilt before
yaw) shows up at 1e-1 and fails the test.

**What is still in JavaScript, honestly:** the root-sink sampling in that second
row is now the dominant cost, and it is still a per-instance loop of 24 `hgt()`
lookups. It is the next candidate for the kernel — it needs the height grid
uploaded once per settle (1 MB) and then 720 000 bilinear samples become 720 000
adds inside the module.

## The compacted visible-instance list

`fe_lod_visible(count, xyz, vp, camX, camY, camZ, fullDistance, cullRadius,
margin, options)` takes the placement positions (already in the core's memory),
a **pointer** to the 16-float column-major view-projection matrix three.js
already keeps, and returns the number of visible instances. The visible slots
are left in `fe_lod_visible_index_ptr()` as `Uint32` and the tier per slot in
`fe_lod_visible_tier_ptr()` as `Uint8`, both ascending and both valid until the
next call.

* Frustum planes come from the Gribb-Hartmann rows; an instance is dropped when
  any plane test is below `-margin`.
* `margin` is not padding for its own sake: a caster just outside the view still
  lands in the 60 m shadow box, so `sync()` passes at least the shadow radius
  for a species whose meshes cast shadows.
* `options` bit 0 adds the ground-cover falloff: full density inside 55 % of the
  radius, then `keep = 1 − t²(3−2t)` hashed per instance against `owHash` of the
  world position. The same blade is always on the same side of the threshold, so
  nothing flickers as the camera moves.
* `options` bit 1 skips the frustum (used when the caller has already culled).
* Out-of-range arguments (`count > 65536`, `fullDistance ∉ [10, 20000]`,
  `cullRadius ∉ [10, 40000]`, `margin ∉ [0, 96]`, a non-finite camera) return a
  negative code instead of writing garbage.

Measured in this repository (Node, one 65 536-instance list, 60° frustum):

| Case | Result | Time |
| --- | --- | --- |
| 20 000 ground-cover blades, 190 m radius, falloff on | 887 kept (4.4 %) | 1.8 ms |
| 65 536 mixed instances, 20 km radius, frustum only | 38 299 kept | 2.5 ms |
| Same call twice | identical list | — |

`sync()` then sets `InstancedMesh.count = visibleCount` and writes the matrices
of those slots only; the geometry and the instance buffers are never
re-allocated.

## What is *not* done, and why

**One draw call for the whole world.** A single `InstancedMesh` can only be
frustum-culled as a whole, so merging every grass quad into one mesh trades
per-kind draw calls for never culling anything. Doing both needs either
GPU-driven indirect draws (`drawArraysIndirect` with a compute-written instance
count), which is **WebGPU only**, or per-tile instanced meshes — more draw calls
but each one cullable. Neither is implemented; the current design (one mesh per
kind and part) is the intermediate point that keeps the studio working on
WebGL2.

**A visible list every frame.** The compacted list above is rebuilt on a camera
settle (240 ms after the camera stops moving), not per frame: re-packing every
instance each frame costs more CPU than it saves on a mid-range phone, and a
list computed for a moving camera is stale before the draw. A per-frame version
needs a GPU-drawn indirect buffer, not a JS loop.

**Quadtree foliage LoD.** The terrain already streams 256 m chunks with a 3×3
resident ring, and foliage has distance tiers (`fe_lod_classify`, 750 m full
detail by default). There is no quadtree over the foliage itself.

**Erosion in a worker.** Hydraulic erosion is time-sliced (below), so it no
longer needs a worker. A worker would still be the only way to run the *whole*
50 000 droplets in the background: a `WebAssembly` instance cannot be shared with
the main thread and `SharedArrayBuffer` needs COOP/COEP headers that a static
host does not send, so a worker would need its own instance and a copied
heightmap back. Not done, and no longer on the critical path.

**GPU compute.** WebGL2 has no compute shaders. The two real options are WebGPU
compute or fragment/transform-feedback ping-pong; neither exists in this build.

**Screen-space reflections.** Not implemented. The water uses a real reflection
probe plus Fresnel and a procedural normal field; SSR would add another full
pass and is not in this budget.

**Real-device profiling.** RenderDoc and Tracy cannot run in this sandbox (no
GPU, no device). The in-page frame timings are the only measurements taken, so
"120 FPS on a phone" is an unverified claim and is not made here.

## Render time: why a cube took ten minutes

A path-traced still used to be the slowest thing in the app by a wide margin,
and the reasons were not subtle. Measured on the default cube scene at
450x800 (the `hd` vertical preset), in node on a desktop CPU:

| | before | after |
| --- | --- | --- |
| samples | 24 (32 if the dialog had not synced yet) | 8, denoised |
| bloom | full pyramid **every** sample pass | once, on the final pass |
| pixels already converged | traced again | frozen (`fe_render_update_convergence`) |
| driving loop | `requestAnimationFrame` | message-port ticks |
| total | **4.3 s** | **1.4 s** |

Three times faster on a desktop. On a phone the ratio is better, because the
fix removes a fixed cost rather than a scaling one.

**`requestAnimationFrame` was the ten minutes.** A render is exactly the
workload that leaves the tab hidden — opening the Render Result window does it
on a phone — and rAF stops dead in a hidden tab. The render then advanced one
slice each time the user came back to look at it. A message port keeps
delivering when rAF does not, so the render finishes whether or not anyone is
watching; when the tab *is* hidden the slices get longer (40 ms instead of 9 ms)
because the browser is throttling scheduling anyway.

### The denoiser is the reason 8 samples look finished

24 samples of a path tracer is a noisy image that took three times as long as
it needed to. Eight samples plus an edge-aware filter of the accumulation
buffer is cleaner *and* cheaper:

* separable: 5 taps per axis, three à-trous iterations (radii 1, 2 and 4). Two leaves low-frequency blotches on a large flat face — the one thing a cube makes impossible to hide — so stills get three; animation frames get two, because there are hundreds of them;
* guides: **depth** (16-bit, 0–64 m) and **albedo** (8-bit RGB) recorded on the
  primary hit, exactly as production denoisers use them;
* the weight falls off on the combined error of depth, albedo and luminance, so
  it never blends across a silhouette or a material boundary.

Measured against a 64-sample reference at 220x308: raw 8 samples is 23.4 dB,
filtered 8 samples is 32.4 dB. Three passes cost about 200 ms at 450x800 —
roughly one and a half samples' worth of time for sixteen samples' worth of
cleanliness.

That albedo guide is not decoration. Without it the filter cannot tell the
studio floor grid from noise — both are thin luminance steps — and the grid
disappears, which is the exact complaint this pass started from. The test for
it compares against a 5x5 box blur: the cube's top edge keeps 100% of its
sharpness where the blur keeps 24%.

### What is still slow, honestly

* **Resolution is linear in time and there are no threads.** This wasm build has
  no `pthreads`, so a still uses one core. 720x1280 (`fhd`) is 2.5x the pixels
  of `hd` and takes 2.5x as long.
* **SIMD is not used.** A `-msimd128` build was measured and was ~2% faster:
  the ray loop is scalar and does not autovectorise, so it was reverted rather
  than shipped as an unearned claim.
* **The animation exporter is still CPU-bound** at `spp/4` samples per frame.
  At 30 fps a 10-second range is 300 frames; that is minutes, not seconds, and
  the EEVEE-style raster engine is the right choice for that job today.

## Time-sliced erosion

The batch call `fe_terrain_erode_hydraulic(count, …)` still exists — the
benchmark and the tests use it — but the studio no longer calls it for hydraulic
erosion. A run starts with `fe_erosion_begin(count, …)` and is advanced by
`fe_erosion_step(droplets)` once per frame:

* The kernel owns the run: seed, droplet cursor and RNG state. A droplet
  finishes before the next one starts and draws exactly two numbers at birth, so
  **the same run split into 700 + 700 + … droplets is bit-identical to one
  blocking call**. `tests/landscape-cpp.test.mjs` asserts array equality, not a
  tolerance, and also that a different split size (137) agrees.
* `fe_erosion_dirty_ptr()` returns `uint16[4]` — `min_i, min_j, max_i, max_j`,
  inclusive, with a one-cell halo so the caller can rebuild the normals of the
  ring it uploads. Empty when `min_i > max_i`.
* `fe_erosion_set_region(cx, cz, radius)` narrows where droplets start and where
  they may still change the field. That is what keeps the rectangle small: rain
  outside the patch is not simulated, and the patch edge is feathered over its
  outer quarter so a run does not end in a square wall. A patch whose centre is
  near the border is moved inwards instead of clamped cell by cell — otherwise a
  camera aimed at the coast would concentrate the whole run into a stripe along
  the last column.

Measured end to end through the real bridge and controller, 257² island,
50 000 droplets, the default 120 m area (a 60 m radius patch):

| Quantity | Result |
| --- | --- |
| Frames to finish | 111–126 (≈1 s at 120 Hz) |
| Mean frame cost | 1.8–2.0 ms, uploads included |
| Worst frame | 4.7–8.3 ms (first slice, cold) |
| Droplets per frame after adaptation | ≈400–450 (`trim` settled at 0.64–0.68) |
| Uploaded band | 65 rows × 257 verts = **196 KB per attribute** |
| Shader heightmap patch | 3 `gl.texSubImage2D` blocks of 32 rows (≈200 KB), not the 1 MB texture |
| Full refresh (`upd`) | 774 KB per attribute, plus 4.2 MB of surface weights and 1 MB of height texture |

A live run therefore pushes position, colour and normal row bands and **skips the
three surface-weight attributes**; the height texture is patched in 32-row blocks
through `copyTextureToTexture` (a `gl.texSubImage2D`) rather than re-uploaded,
because the shaders that sample it — shore wetness, snow line, grass placement —
would otherwise lag a second behind the geometry. The whole terrain, height
texture included, is refreshed once when the run ends. `updLive()` sets
`BufferAttribute.updateRange` before `needsUpdate`, so three r128 issues
`gl.bufferSubData` for that band instead of re-uploading the array.

The slice size is not a constant: the controller times the whole tick — the
droplet loop *and* the band upload on the frames that carry one — and trims the
droplet budget (0.18×–1.8×) toward ~2 ms, so a slow phone simulates fewer
droplets instead of dropping frames. A run also pauses rather than burning frames
when it cannot be seen: hidden tab, another sheet open, the patch off screen, or
a brush stroke in progress.

## The order that would actually help a phone

1. **Fill rate first.** On a 390×844 screen at DPR 2, a million instanced grass
   fragments cost more than their vertex data ever will. The density falloff is
   now in the core; smaller cards and fewer overdraw layers would go further.
2. **WebGPU path** for indirect draws and compute erosion, kept behind a feature
   flag next to the WebGL2 renderer.
3. **Quadtree foliage LoD** over the resident chunks.
4. **Impostor tier** for trees past a kilometre, where the vertices stop being
   worth anything on screen.
