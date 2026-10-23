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
| The `-1` tier from `fe_lod_classify` is honoured | instances past the far plane no longer reach the GPU at all |
| Tsunami ↔ wind-sea blend (`uTsF`) | the two wave systems are mixed by one factor instead of being added together |

## What is *not* done, and why

**One draw call for the whole world.** A single `InstancedMesh` can only be
frustum-culled as a whole, so merging every grass quad into one mesh trades
per-kind draw calls for never culling anything. Doing both needs either
GPU-driven indirect draws (`drawArraysIndirect` with a compute-written instance
count), which is **WebGPU only**, or per-tile instanced meshes — more draw calls
but each one cullable. Neither is implemented; the current design (one mesh per
kind and part) is the intermediate point that keeps the studio working on
WebGL2.

**Per-instance frustum culling.** `fe_lod_classify` already returns a tier per
instance, and `sync()` now skips the `-1` tier. But `sync()` runs on a camera
settle, not every frame: re-packing every instance each frame costs more CPU
than it saves on a mid-range phone. A proper version is a compacted visible-index
buffer written by the core and uploaded as a small `Uint32` index attribute —
planned, not built.

**Quadtree foliage LoD.** The terrain already streams 256 m chunks with a 3×3
resident ring, and foliage has distance tiers (`fe_lod_classify`, 750 m full
detail by default). There is no quadtree over the foliage itself.

**Erosion off the main thread.** Hydraulic and thermal erosion run in the core
(measured on a 257² field in Node: 2 000 droplets 15 ms, 10 000 43 ms,
50 000 202 ms, thermal ×20 12.5 ms). Those numbers are why the panel applies
erosion as a discrete action rather than per frame. Moving it to a worker is
possible, but a `WebAssembly` instance cannot be shared with the main thread and
`SharedArrayBuffer` needs COOP/COEP headers that a static host does not send, so
a worker would need its own instance and a copied heightmap back. Not done.

**GPU compute.** WebGL2 has no compute shaders. The two real options are WebGPU
compute or fragment/transform-feedback ping-pong; neither exists in this build.

**Screen-space reflections.** Not implemented. The water uses a real reflection
probe plus Fresnel and a procedural normal field; SSR would add another full
pass and is not in this budget.

**Real-device profiling.** RenderDoc and Tracy cannot run in this sandbox (no
GPU, no device). The in-page frame timings are the only measurements taken, so
"120 FPS on a phone" is an unverified claim and is not made here.

## The order that would actually help a phone

1. **Fill rate first.** On a 390×844 screen at DPR 2, a million instanced grass
   fragments cost more than their vertex data ever will. Cheaper: tighter
   density falloff, smaller cards, fewer overdraw layers.
2. **Compacted visible instances** (core-written index buffer) — removes the
   work for everything behind the camera without giving up culling.
3. **WebGPU path** for indirect draws and compute erosion, kept behind a feature
   flag next to the WebGL2 renderer.
4. **Worker erosion** with a copied heightmap, once 2 and 3 exist.
