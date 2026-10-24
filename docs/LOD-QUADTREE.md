# Quadtree LoD and foliage impostors

Two pieces of the Landscaping Studio that decide *what to draw*, both compiled
into `fe_core_engine.wasm`:

* `cpp/src/fe_lod.cpp` — a pooled quadtree that indexes one species' placements
  once and answers "which of these are on screen, and at which detail" after
  that;
* `cpp/src/fe_impostor.cpp` — a baker that renders a species' own grown mesh
  into an eight-azimuth atlas so the far band can be one quad per plant.

They sit on top of the models the kernel already grows (`cpp/src/fe_flora.cpp`).
No geometry is authored here, nothing is decimated, and no texture ships with
the repository.

## Why an index at all

Before this, every settled camera frame walked the whole instance list and
projected each plant. That is fine at 3 000 trees and hopeless at 100 000 blades
of grass: the loop cost was proportional to the world, not to the screen. The
quadtree makes the cost proportional to what is visible.

| case | instances | nodes | scanned | tree cull | flat loop |
|---|---|---|---|---|---|
| trees, far field | 40 000 | 1 365 | 1 591 | **0.039 ms** | 0.258 ms |
| typical tree count | 4 000 | 85 | 1 165 | **0.017 ms** | 0.041 ms |
| shrubs, view radius 600 m | 60 000 | 1 365 | 8 660 | **0.160 ms** | 1.189 ms |
| dense meadow, radius 190 m | 100 000 | 3 637 | 4 542 | 0.224 ms | **0.104 ms** |
| wide angle, radius 2 200 m | 100 000 | 3 637 | 20 205 | 0.456 ms | **0.083 ms** |

The build runs once per species and then only when a plant moves; a camera move
alone re-walks the existing tree (0.002–0.008 ms for the cache check). Building a
100 000-instance species costs about 8 ms, which happens once, on a settled
camera, in slices of a sweep that already runs off the critical path.

**The tree is not always faster, and the table says so.** When the view contains
a large fraction of the list — a meadow 190 m deep inside a 1 km world, or a wide
angle over a dense field — the flat loop's single distance test already rejects
96 % of instances for almost nothing, and the tree's node walk is pure overhead.
It wins by 2–7× as soon as the world is bigger than the view: far cameras, sparse
forests, big `World size`, streamed Open World. All of these are sub-millisecond
either way and a species is only re-synced after the camera has been still for
240 ms, so neither path touches the frame budget; the tree is used for every
species because its cost tracks what is *visible* instead of what is *stored*,
which is the property that survives a 50 km world.

## The tree

Each species owns a slot (0–25). The pool holds up to 20 000 nodes and 240 000
order entries across all species, so twenty-six species never each reserve their
own worst case. A node stores its centre, radius, first/count into the order
array, and four child indices.

Children are **absolute pool indices**, not offsets — an early version added a
node base to them and descended into the wrong subtrees, which is exactly the
kind of bug a "looks about right" screenshot hides.

The generation argument is a checksum of the placements, computed in JavaScript
in the same loop that already copies positions:

```
gen = Math.imul(gen ^ (o.x * 8 | 0), 16777619) ^ Math.imul(gen ^ (o.z * 8 | 0), 2246822519)
```

Same checksum, same tree. A plant that moved changes it; a camera that moved
does not. This is why a settled camera costs a walk and not a rebuild.

## Exactness

A spatial index that culls a plant it should have kept is worse than no index,
so the tree is required to return *exactly* what the flat kernel returns — same
visible set, same tier per instance. `tests/landscape-quadtree-lod.test.mjs`
recomputes the answer with a brute-force pass over every instance (its own
frustum planes, its own distance tiers, its own hash) and compares. Four
camera/species cases: `missing 0 / extra 0 / tier mismatch 0`, with the walk
still visiting under a quarter of the nodes and scanning under 75 % of the
instances.

That test is also what caught the second bug worth recording: the tier hash was
`fract(sin(...))`, and freestanding `sinf` in the wasm build does not agree with
V8's `Math.sin` — 1 040 of 3 000 instances landed in a different tier than the
JavaScript reference. It is now an integer bit hash (`__builtin_bit_cast` to the
bit pattern, then a Murmur finaliser) that both sides compute identically.

## Tiers in the Studio

`sync(kind)` asks the kernel for the visible list, then routes each instance:

| tier | what the studio draws |
|---|---|
| 0 | the grown mesh, full material |
| 1 | the low-detail twin (one detail step down, lighter material) |
| 2 | the impostor quad |

Tier 2 only exists for kinds the atlas can bake. If a species has no atlas yet,
those instances stay on tier 1 and the species is queued; when the atlas
finishes, the queue routes that species immediately instead of waiting for the
next camera move. Nothing is ever dropped while an atlas is being drawn.

An impostor is one quad for the whole plant, so only the first material slot
owns it — the second slot skips tier 2 entirely, or a two-slot tree would be
drawn twice.

## The atlas

`fe_impostor_build(kind, seed, detail, views)` grows the species with the same
`fe_flora_tree()` call the studio uses, then rasterises it eight times at 2×
supersampling into a 64 × 128 tile per azimuth, z-buffered and barycentric, with
a key light matching the studio's sun. **Both buffers are drawn** — the wood
`fe_flora_tree()` returns *and* the leaf-card buffer it grows alongside, because
on a broadleaf the entire canopy lives in the cards. Drawing only the wood
produced a bare trunk with roots, which is what the first probe showed.

Colour is coverage-weighted at the downsample so edge texels do not darken
toward black, and stored display-encoded (`pow(c, 1/2.2)`), so the billboard
needs no decode on WebGL1 or WebGL2.

The quad size is measured from the pixels that were actually painted, not from
the model bounds. A wide canopy never fills a 1:2 tile, and sizing from bounds
drew every tree at the wrong height — the atlas now returns a crop rectangle
(`cropU`, `cropV`, `offU`) and the billboard maps only that rectangle.

`fe_impostor_column(dx, dz)` reports which baked azimuth a camera sees the plant
from; it is the CPU-side convention, tested for wrapping and continuity.

## The billboard

* one quad per plant, billboarded around **Y only** — foliage that tips over as
  the camera tilts looks wrong at every distance;
* the column comes from the camera azimuth and **cross-fades** to the next
  column with the sub-view angle, so an orbit dissolves between azimuths
  instead of snapping through eight poses;
* the alpha mask is the silhouette (`alpha < 0.30` is discarded), and the atlas
  has a power-of-two mip chain so a plant 2 km away does not boil;
* the canopy sways with the same wind the near meshes use, anchored at the base;
* the baked key light is corrected per frame by the *ratio* of the live sun and
  sky to the light the atlas was baked under, so a dusk impostor darkens with
  the trees beside it instead of glowing.

It is a user setting (`Foliage impostors`, persisted as
`final3d.impostors.v1`): turning it off puts the far band back on the
low-detail mesh. If the billboard shader fails to compile, the same setting is
turned off automatically rather than leaving distant trees invisible.

Changing the quality preset regrows every plant at a new detail level, so the
atlases baked from the old meshes are dropped and rebaked on demand.

## Honest limits

* **One variant per species.** Species with several grown variants (different
  seeds for variety) share the atlas baked from the seed the studio recorded for
  that species — variant 0 as far as the studio is concerned. At the far tier a
  tree is a handful of pixels, but this is a real difference, not a rounding
  error.
* **Baked lighting.** The key light is fixed at bake time. The per-frame ratio
  keeps day/night honest in brightness, but a moving shadow cannot fall across
  an impostor, and shadow direction on the canopy does not follow the sun.
* **No shadow proxy.** Impostors do not cast shadows. They are only used beyond
  the far tier, which is well outside the shadow focus, so this is invisible in
  practice rather than by construction.
* **Eight azimuths, no elevation.** A camera looking straight down at a plant
  still samples a side view.
* **No real-device measurement.** The timings above are Node numbers on a
  desktop CPU for the kernel alone. Nothing here is a phone FPS claim, and the
  Studio remains a **Very Early Demo**.
* **The Open World uses a different path.** `docs/FOREST-IMPOSTORS.md` describes
  the streaming Open World's card impostors; this document is the Landscaping
  Studio's own tier and the two are not shared code.

## Check it

```
npm run build:cpp
npm run build
npm test
```

`tests/landscape-quadtree-lod.test.mjs` covers the ABI, the brute-force
exactness comparison, the cache/rebuild rules, the atlas (not blank, not a
solid card, views differ, cached per seed), the sync routing (a real three.js
`sync()` run: one tier per instance, nothing lost while an atlas is pending),
and the GLSL — the billboard shaders are expanded with three's own prefix and
fog chunks and parsed, because this sandbox has no WebGL context and a syntax
error here is a black screen on a device.
