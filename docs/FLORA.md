# Grown flora — the tree and rock kernel

The Landscaping Studio used to *draw* its trees: `oakTreeJs()` pushed a trunk,
then called a recursive `grow()` that split into two or three children at
`r * 0.6` with a fixed jitter, four levels deep, and hung four leaf cards on
every tip. Every oak in a row therefore had the same silhouette, and the
recursion could not express the one thing real trees do — branches reach for the
light that is *not* already claimed by another branch.

`cpp/src/fe_flora.cpp` replaces that with two growth systems, compiled into the
same `fe_core_engine.wasm` as the rest of the core:

* **woody species** — space colonisation (Runions et al. 2007), the skeleton a
  tree would grow toward light;
* **herbaceous species** — a strict parametric **L-system**, because a fern is a
  frond grammar, not a search for light.

JavaScript keeps only the job it should have: turning the engine's anchors into
the leaf cards the existing PBR material already knows how to shade.

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

### The grammar (`fern`, `treefern`)

A real string-rewriting system, not a recursive splitter:

```
axiom  X
X -> F[+X]F[-X]+X        (or the mirrored branch, chosen per seed)
F -> FF
```

The rewrite runs in the kernel (`lsExpand`), the result is walked by a 3D turtle
(`lsInterpret`) that understands `F + - & ^ / \ [ ]`. It is **parametric**:
every `[` scales step length, radius and the colour ramp by `0.62`, and raises
the sway compliance, so the word does not produce a uniform wire frame but a
frond that thins and softens toward its pinnae. Gravity (`droop` radians per
segment) turns the rachis into an arch.

Measured on the shipped artifact: 3 passes → 156 symbols → 14 main-rachis
segments; 10 fronds at `detail = 2` build a 0.50 m × 0.52 m bracken with 760
pinnae. The tree fern adds a 1.6 m trunk and 4 passes.

**The rules are editable at runtime.** `fe_flora_lsystem_load` accepts an axiom
plus up to 8 productions (2 alternatives each) packed as bytes; `lsystem_run`
expands them and `lsystem_plant` grows a rosette from the result — the same
turtle, same buffers, same budget. `FELandscapeFlora.plant({axiom, rules, …})`
is the JS entry point. There is **no rule editor in the UI yet** (see
*What this does not do yet*).

Species profiles (measured from the shipped artifact at `detail = 2`):

| # | Species | Height | Crown radius | Leaf size | Cards / anchor |
| --- | --- | --- | --- | --- | --- |
| 0 | oak | 8.2 m | 3.8 m | 1.05 | 4 |
| 1 | birch | 9.1 m | 2.4 m | 0.80 | 3 |
| 2 | acacia | 5.8 m | 3.9 m | 0.72 | 4 |
| 3 | shrub | 1.2 m | 0.9 m | 0.50 | 3 |
| 4 | ash bush | 1.8 m | 1.2 m | 0.60 | 3 |
| 5 | dead tree | 7.5 m | 2.7 m | 0 | 0 |
| 6 | fern | 0.50 m | 0.52 m | 0.16 | 2 (L-system) |
| 7 | tree fern | 2.93 m | 1.04 m | 0.22 | 2 (L-system) |

Heights and radii are the envelope of the vertex buffers at `detail = 2` for
seed 2024.

Rocks: `0` granite (6 planes + lichen), `1` sandstone (6 planes, warm strata),
`2` basalt (9 planes, almost no moss). All three build 1107 vertices and 6000
indices at `detail = 2`; `detail 0` builds the 32×20 grid used by the low
quality tier.

## ABI

```c
int   fe_flora_species_count(void);       /* 8  */
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
int   fe_flora_leaf_ptr(void);  /* float[leaves*10] */
int   fe_flora_species_info(int kind, float *out8);
float *fe_flora_sway_ptr(void);   /* float[verts] 0..1 compliance      */
float *fe_flora_phase_ptr(void);  /* float[verts] radians, per branch  */
int   fe_flora_leaf_stride(void); /* 10 */
/* grammar */
int   fe_flora_lsystem(int iterations, uint32_t seed);   /* -> symbols   */
int   fe_flora_lsystem_len(void);
const char *fe_flora_lsystem_word(void);
int   fe_flora_lsystem_rules(void);                        /* 2 built-in   */
int   fe_flora_lsystem_load(const uint8_t *buf, int bytes);/* -> accepted  */
int   fe_flora_lsystem_run(int iterations, uint32_t seed); /* uploaded set */
int   fe_flora_lsystem_plant(int fronds, float step, float tilt, float droop,
                             float leafSize, int iterations, uint32_t seed,
                             int detail);
int   fe_flora_lsystem_reset(void);                        /* built-in back   */
int   fe_flora_set_shape(float height, float density);      /* 30..250/100     */
```

Leaf stride is 10: `[x, y, z, dirX, dirY, dirZ, size, shade, sway, phase]`. `species_info`
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
* The adapter sets the attribute layout `gaGeo()` used — `position`, `normal`,
  `color`, `uv`, `aRnd`, `aCen`, `aSway`, `aPhase`, `index` — and the two extra
  channels are what drive the skeletal wind below. Geometry without them reads
  `0` and keeps the old height-only bend.
* Leaf cards inherit `sway`/`phase` from the twig they sit on
  (`L.sw = a[i+8]`, `L.phv = a[i+9]`), so a leaf cannot stay behind while its
  branch swings.
* Leaf anchors become the same `lcard()` quads as before, with the kernel's own
  `shade` value overriding the random `t` so leaf colour follows the crown.
* If the artifact is older than the kernel, `treeBuilder()` returns the old
  `*Js` builder; when the artifact finishes loading, `applyGrown()` swaps the
  grown geometry into the existing `InstancedMesh`es in place — no rebuild, no
  lost instance transforms. It also re-points the LOD twin
  (`K.lowMeshes[i].geometry`) and clears the cached selection bounds.
* `ensure()` calls `window.__feGrowSpecies()` so a species first built after the
  swap is grown too.

## Skeletal wind

`wind()` in `terrain-main-01.js` never knew which part of a tree a vertex
belonged to: every vertex bent by `y²`, so a trunk and a twig at the same height
moved identically. The kernel now bakes two channels per vertex:

* **compliance** — `0` at the trunk collar, `1` at a terminal twig, accumulated
  along the branch path and thinned by the local radius:

  ```
  path = clamp((len − trunkTop·0.5) / (treeHeight·0.55), 0, 1)
  thin = clamp(1 − radius / (0.60 · trunkRadius), 0, 1)
  sway = clamp(path · (0.55 + 0.45·thin), 0, 1)          // swayOf() in fe_flora.cpp
  ```

  Because it follows the *path*, not the height, a low side limb can be more
  compliant than the stiff upper trunk — a height law can never produce that —
  and because a limb as thick as the trunk keeps only 55 % of its path
  compliance, a whip swings further than a bough of the same length.
* **phase** — accumulated down the path (`Σ 1.6 · segmentLength`), so two limbs
  of the same length still swing out of step.

The shader bends by

```glsl
float skH = max(position.y, 0.0);
float skA = aSway * aSway * clamp(skH * 0.34, 0.12, 1.0);
float skW = 0.55 + 1.25 * aSway;          // stiff limbs are slow, tips are fast
float skB = (sin(uT * skW + aPhase) + 0.42 * sin(uT * skW * 2.1 + aPhase * 1.6 + 1.1))
          * (0.35 + 0.65 * gust);
transformed.xz += wd * (skA * uW * 0.550) * skB;
transformed.y  -= skA * skA * abs(skB) * uW * 0.05;   // the tip dips as it swings
```

Compliance therefore drives three things at once: how far a limb moves
(`skA`), how fast it moves (`skW`) and when it moves (`aPhase`). A thick low limb
is stiff, slow and out of step with a thin tip that whips — which is the part of
"mass" a vertex shader can honestly express. The `clamp` on height keeps a
0.5 m bracken from swaying as far as an 8 m oak. The leaf cards carry the same
channels, and `depthFx()` applies the identical bend in the shadow pass so a
cast shadow does not stay still while the branch moves.

What a vertex shader cannot do is collide branches against each other or
integrate mass: a limb does not push its neighbour, and there is no Verlet or
rigid-body chain. That needs a CPU skeleton (or a compute pass) and is recorded
below as incomplete rather than implied.

## Runtime shape controls and the rule editor

Two kernel globals (`gShapeH`, `gShapeD`) scale a **copy** of the species table
in `generateTree()` / `generateFern()`, so the botanical reference stays intact:

| Slider | Kernel effect |
| --- | --- |
| Tree height × (0.5–1.8) | `trunkTop`, `crownY`, `crownRY` × h; the stem thickens by `0.55 + 0.45h` (elastic similarity) |
| Branch density × (0.4–1.6) | attraction points × d (clamped 16–380), trunk segments × `0.85 + 0.15d`, frond count × d (clamped 4–24) |

`FELandscapeFlora.setShape(h, d)` clamps and re-pushes the pair before every
build, and `window.__feRegrowFlora(kinds)` drops the cached parts for those
species and lets `applyGrown()` refill them: instances keep their matrices, only
the geometry is replaced.

The **rule editor** in the Foliage sheet is a textarea with one production per
line:

```
X -> F[+X]F[-X]+X | F[-X]F[+X]-X
F -> FF
```

`parseGrammar()` in `terrain-main-07.js` accepts `->`, `→` or `=`, `#` comments
and an optional `axiom: X` line, and refuses anything outside
`F X + - & ^ / [ ]`. The accepted text is packed by the bridge into the kernel's
byte layout and uploaded with `fe_flora_lsystem_load`; from then on
`generateFern()` expands **that** rule set, so the ferns in the world change —
the rewrite still happens in C++. *Restore built-in grammar* calls
`fe_flora_lsystem_reset()` and regrows. The text and the two sliders are part of
the persisted studio document (`floraHeight`, `floraDensity`, `floraRules`), so a
reload resumes the same plant shapes and the same grammar.

## Cost

Measured in Node against the shipped artifact (`detail = 2`):

| Job | Time |
| --- | --- |
| oak (3621 v / 9033 i / 408 leaves) | 2.9 ms |
| birch (3589 v / 8928 i / 324 leaves) | 2.7 ms |
| acacia (2471 v / 6018 i / 200 leaves) | 1.2 ms |
| shrub / ash bush | 0.7–1.0 ms |
| dead tree | 1.2 ms, 0 leaves |
| fern (3800 v / 9120 i / 760 leaves) | 0.5 ms |
| tree fern (10 491 v / 25 224 i / 2 080 leaves) | 0.6 ms |
| rock (1107 v / 6000 i) | < 1 ms |

Three variants per species are grown at boot, so the whole swap costs roughly
20–40 ms once, off the render path.

## What this does not do yet

* The wind is a vertex bend, not a rigid-body simulation of each limb; a limb
  swings with its own compliance, frequency and phase, but branch mass is a
  proxy and branches do not collide with each other. Verlet or a rigid-body
  chain would need a CPU skeleton per tree.
* The uploaded grammar replaces the *frond* grammar only (`fern`, `treefern`).
  Broadleaves are space colonisation, not a rewriting system, so a rule set does
  not reshape them — only the height/density sliders do.
* No bark-unwrap UVs from the kernel; the trunk samples the tiling bark texture
  by triplanar-ish UV already stored per vertex.
* LOD is still the existing twin mesh (no decimated branch graph yet).
* `applyGrown()` is the only path that regenerates geometry; editing a species
  seed is not exposed in the UI.

These are recorded as incomplete rather than finished.

## Verification

```bash
node --test tests/landscape-flora.test.mjs    # 21 tests
npm test                                      # 367 tests
```

The tests grow all eight species and all three rocks from the shipped artifact,
assert the L-system's exact symbol counts (`F = 2(3ⁿ − 2ⁿ)`, `X = 3ⁿ`), that a
custom rule set uploaded at runtime is rewritten and grown, that every vertex
carries a bounded compliance and a finite phase, that a single height band
contains both stiff and compliant wood (the property a `y²` law cannot have),
and that: no degenerate triangles, finite normals, no black vertices, plausible
proportions (a birch is slender, an acacia is wide, a shrub is not a small oak,
a dead tree carries no leaves), da Vinci taper with a root flare below `y = 0`,
deterministic replay per seed but distinct trees per seed, lichen only on
granite, and the adapter/wiring/fallback contract above.
