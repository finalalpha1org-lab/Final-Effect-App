# Grown flora — the tree and rock kernel

The Landscaping Studio used to *draw* its trees: `oakTreeJs()` pushed a trunk,
then called a recursive `grow()` that split into two or three children at
`r * 0.6` with a fixed jitter, four levels deep, and hung four leaf cards on
every tip. Every oak in a row therefore had the same silhouette, and the
recursion could not express the one thing real trees do — branches reach for the
light that is *not* already claimed by another branch.

`cpp/src/fe_flora.cpp` replaces that with a growth simulation, compiled into the
same `fe_core_engine.wasm` as the rest of the core. JavaScript keeps only the
job it should have: turning the engine's anchors into the leaf cards the
existing PBR material already knows how to shade.

Nothing from ProcTree, Botanica-cpp or tree-gen is vendored. ProcTree is a
droppable BSD-3 generator but its last change is 2015 and its output is a
one-shot skeleton; Botanica-cpp is a desktop OpenGL application rather than a
library. Growing in-house means mobile sizes, wasm-safe allocation, and an ABI
that matches `fe_abi.h` like every other kernel.

## What the kernel does

| Step | Method |
| --- | --- |
| Crown volume | attraction points sampled inside an ellipsoid (`crownRX`, `crownRY`) |
| Skeleton | space colonisation, Runions et al. 2007 — 48 iterations, attractor killed inside `0.17 · crownRX`, influence radius `0.46 · crownRX` |
| Branch radius | da Vinci's rule, `r ≈ r_top · sqrt(tips / total tips)`, so a fork conserves cross-section |
| Leaf placement | golden angle `2.39996323 rad` phyllotaxis around each tip, `cards` cards per anchor |
| Root flare | detail-gated basal thickening below `y = 0` so a trunk meets the ground and never floats |
| Rock body | a sphere clipped by 6–9 random half-spaces (soft-min), displaced by 5 octaves of product-of-sines |
| Rock normals | finite differences (`eps = 0.012`) over the displaced surface, not summed facet normals |
| Rock colour | mineral base + strata banding; lichen only on upward faces, and only for granite |

Species profiles (measured from the shipped artifact at `detail = 2`):

| # | Species | Height | Crown radius | Leaf size | Cards / anchor |
| --- | --- | --- | --- | --- | --- |
| 0 | oak | 8.2 m | 3.8 m | 1.05 | 4 |
| 1 | birch | 9.1 m | 2.4 m | 0.80 | 3 |
| 2 | acacia | 5.8 m | 3.9 m | 0.72 | 4 |
| 3 | shrub | 1.2 m | 0.9 m | 0.50 | 3 |
| 4 | ash bush | 1.8 m | 1.2 m | 0.60 | 3 |
| 5 | dead tree | 7.3 m | 2.6 m | 0 | 0 |

Rocks: `0` granite (6 planes + lichen), `1` sandstone (6 planes, warm strata),
`2` basalt (9 planes, almost no moss). All three build 1107 vertices and 6000
indices at `detail = 2`; `detail 0` builds the 32×20 grid used by the low
quality tier.

## ABI

```c
int   fe_flora_species_count(void);       /* 6  */
int   fe_flora_rock_kind_count(void);     /* 3  */
int   fe_flora_tree(int kind, uint32_t seed, int detail);   /* -> verts, 0 = fail */
int   fe_flora_rock(int kind, uint32_t seed, int detail);
int   fe_flora_vert_count(void);
int   fe_flora_index_count(void);
int   fe_flora_leaf_count(void);
int   fe_flora_pos_ptr(void);   /* float[verts*3]   */
int   fe_flora_nrm_ptr(void);   /* float[verts*3]   */
int   fe_flora_uv_ptr(void);    /* float[verts*2]   */
int   fe_flora_col_ptr(void);   /* float[verts*3]   */
int   fe_flora_rnd_ptr(void);   /* float[verts]     */
int   fe_flora_cen_ptr(void);   /* float[verts*3]   */
int   fe_flora_idx_ptr(void);   /* uint32[indices]  */
int   fe_flora_leaf_ptr(void);  /* float[leaves*8]  */
int   fe_flora_species_info(int kind, float *out8);
```

Leaf stride is 8: `[x, y, z, dirX, dirY, dirZ, size, shade]`. `species_info`
returns `[trunkTop, trunkRadius, crownY, crownRX, crownRY, leafSize, cards,
leaves]`. Caps: 24 000 vertices, 72 000 indices, 3 200 leaf anchors, 420 branch
nodes, 420 attraction points — a phone cannot be made to allocate more.

The node pool (`gNodeN`, `gAttN`) is reset at the top of `generateTree()`, not in
`resetMesh()`: the counters are declared after that function, and a stale pool
is exactly the bug that once made five of six species return zero vertices.

## Integration

```
fe_flora.cpp ──▶ FELandscapeCore.floraTree()   (terrain-main-01.js, deep copies the buffers)
            └──▶ FELandscapeFlora.tree()       (landscape-flora.js, BufferGeometry)
            └──▶ treeBuilder()/rockBuilder()   (terrain-main-02.js, called by every mk()/LZ())
```

* The bridge copies every buffer out of `memory.buffer` before it returns, so a
  later wasm allocation cannot invalidate a geometry that is already uploaded.
* The adapter sets the exact attribute layout `gaGeo()` used — `position`,
  `normal`, `color`, `uv`, `aRnd`, `aCen`, `index` — which is why the PBR bark,
  wind, translucency and shadow materials needed no change at all.
* Leaf anchors become the same `lcard()` quads as before, with the kernel's own
  `shade` value overriding the random `t` so leaf colour follows the crown.
* If the artifact is older than the kernel, `treeBuilder()` returns the old
  `*Js` builder; when the artifact finishes loading, `applyGrown()` swaps the
  grown geometry into the existing `InstancedMesh`es in place — no rebuild, no
  lost instance transforms. It also re-points the LOD twin
  (`K.lowMeshes[i].geometry`) and clears the cached selection bounds.
* `ensure()` calls `window.__feGrowSpecies()` so a species first built after the
  swap is grown too.

## Cost

Measured in Node against the shipped artifact (`detail = 2`):

| Job | Time |
| --- | --- |
| oak (3659 v / 9120 i / 416 leaves) | 3 ms |
| birch (3583 v / 8874 i / 306 leaves) | 2 ms |
| acacia (2295 v / 5568 i / 168 leaves) | 2 ms |
| shrub / ash bush | 1 ms each |
| dead tree | 1 ms, 0 leaves |
| rock (1107 v / 6000 i) | < 1 ms |

Three variants per species are grown at boot, so the whole swap costs roughly
20–40 ms once, off the render path.

## What this does not do yet

* No per-branch skeletal wind: leaves still use the existing card wind shader,
  so the trunk does not sway as a rigid body would.
* No bark-unwrap UVs from the kernel; the trunk samples the tiling bark texture
  by triplanar-ish UV already stored per vertex.
* LOD is still the existing twin mesh (no decimated branch graph yet).
* `applyGrown()` is the only path that regenerates geometry; editing a species
  seed is not exposed in the UI.

These are recorded as incomplete rather than finished.

## Verification

```bash
node --test tests/landscape-flora.test.mjs    # 8 tests
npm test                                      # 320 tests
```

The tests grow all six species and all three rocks from the shipped artifact and
assert: no degenerate triangles, finite normals, no black vertices, plausible
proportions (a birch is slender, an acacia is wide, a shrub is not a small oak,
a dead tree carries no leaves), da Vinci taper with a root flare below `y = 0`,
deterministic replay per seed but distinct trees per seed, lichen only on
granite, and the adapter/wiring/fallback contract above.
