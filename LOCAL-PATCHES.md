# Local patches on top of `finalalpha1org-lab/Final-Effect-App`

This project tracks upstream `main`, but the deployment keeps a few local
adaptations. Re-apply these when pulling a new upstream revision.

Synced upstream revision: **`ab50dfa0`** (merge of PR #32; head of `main` at
`2026-11-01T15:34:58Z`). This is a *restructuring* revision, not a feature PR:

- the Landscaping Studio is removed and locked — `Terrain_system_.html`,
  `terrain-main-01..09.js`, `landscape-*.js`, `open-world*.js`,
  `celestial-math.js`, `scatter-spacing.js`, `kernel-worker.js`,
  `tessendorf-ocean.js` and their tests/docs are gone (94 files deleted), and
  the home shell lists the studio as "In development / Coming later"; the
  browser assets shrink to the workspace shell (`index.html`, `edit-mode.js`,
  `modifier-engine.js`, `simulationCore.js`, `workspace-export.js`, the
  `render-*.js` sheets);
- export baking, the OBJ/MTL writers, the volume atlas, the TAA/colour maths and
  the ZIP CRC move into the C++ kernel (`cpp/src/fe_export.cpp`,
  `fe_render_math.cpp`, `fe_writer.cpp`, `fe_volatlas.cpp`,
  `cpp/include/fe_math64.hpp`) — the engine source list drops from 20 to 15
  files and the artifact from 1.94 MB to 1.08 MB;
- `README.md`, `docs/VOLUME-LOOK-SETTINGS.md`, `docs/ENGINE-ARTIFACT.md`,
  `docs/RENDER-CAPTURE.md` follow.

Local patches at this revision:

- **re-applied** on top of upstream's new `scripts/build.mjs`: publish the
  checked engine and solver into `build/client` (with the solver's WASM magic
  check), stage `vendor/three/*` (falling back to `node_modules/three` for
  `three.min.js`), inline the vendored three.js into the standalone download,
  and write the camelAI worker manifest (`build/server/wrangler.json` +
  `build/server/worker.js`) from `wrangler.jsonc`;
- **re-applied** in `public/index.html`: `initGlobalSettingsEvents()` from
  `openWorkspaceSettings()` (the workspace sheet still forwards its rows to the
  legacy `#set-*` controls through `forward(...)`, which needs those controls'
  behaviours bound) and the touch-sized transform gizmo (`gizmoTouchSize()`);
- **dropped**: the whole studio-side patch set (the engine-bridge guards, the
  non-finite guards and the `onLand()` backstop) — those files no longer exist;
- **dropped**: `public/export-fbx.js` and its script tag, see below.

Synced upstream revision: **`467128e7`** (merge of PR #26, "Landscape: trees
actually reach the screen, and the rule editor is gone").

What `467128e7` adds over `8189110`:

- `sync()` no longer aborts a variant mesh after the first instance that does not
  belong to it (`return` -> `continue`), so every tree, rock and house is
  submitted to a mesh instead of only the matching prefix of the list;
- the species catalogue builds behind per-species guards: `basicSpecies()` and
  `safeSpecies()` in `public/terrain-main-01.js`, `safe()` around each eager
  species in `public/terrain-main-02.js`, and a guarded `lazyBuild()`. One
  throwing species costs one species, not the whole wood;
- `TREE_SET` in `public/terrain-main-03.js`: the tree budget goes to the tree
  species a biome's table lists instead of to whatever clears a footprint
  threshold, and the volcanic table seeds pine and juniper again;
- the foliage sheet drops the by-hand grammar editor and its explanatory hints
  (`public/terrain-main-07.js`, plus its CSS in `public/Terrain_system_.html`).
  The parser and `loadGrammar()` stay: stored rules and the kernel still speak
  that format. Only the two shape sliders remain in the sheet;
- five test files are added or updated (`tests/foliage-instancing`,
  `tests/terrain-colour-pass` new; `tests/landscape-flora`,
  `tests/scatter-yield`, `tests/terrain-content` updated).

This revision changes no C++, so the engine artifact from `8189110` still
matches its sources.

Synced upstream revision: **`8189110`** (merge of PR #23, #24 and #25).

What `8189110` adds over `6588ddd`:

- PR #23 "Trees bend from a planted trunk, and the home shell is phone-only" -
  the skeletal wind law is rewritten (`SKEL`), the script tags move below the
  home-screen markup so a phone paints before 1.8 MB of JavaScript lands, and
  the home/settings copy is phone-first.
- PR #24 "The ground cannot go black, and palms can grow on sand" -
  `coloursLookReal()` fails a colour command that wrote nothing, the JS
  `col()` fallback shades ground-then-paint in linear light like the kernel,
  palms accept grass and sand, and groves/rock placement are rewritten.
- PR #25 "Landscape: fill the island with a wood, and stop painting the frame
  rate" - `cpp/src/fe_landscape.cpp`, the scatter sampler (crown/trunk radii,
  `ScatterSpacing.plantClash`), the FPS readout moves into the settings sheet,
  and seven new test files.

Local patches that this revision **supersedes**, and which were therefore
dropped instead of re-applied:

- the `SKEL` constants tweak in `public/terrain-main-01.js` - upstream's new
  wind law already pins the collar and scales the bend with `aSway`;
- the local `scatterFill()` clump options (`clump:.2/patch:30`) - upstream now
  passes per-kind options and samples every kind on land;
- the duplicated "trust but verify" colour blocks in `upd()` - replaced by
  upstream's `coloursLookReal()`, with the local one-shot warning folded into
  the same conditional.

Local patches **kept and re-applied** on top of `8189110`:

- `public/terrain-main-01.js` - the guarded engine-bridge calls in `upd()`,
  `updLive()`, `sculpt()` and `gen()` (a throw inside the render loop leaves
  the brush looking dead), the non-finite height repair, plus the local
  warning when the kernel reports success but writes nothing;
- `public/terrain-main-03.js` - the non-finite scale guard in `add()` and the
  `onLand()` backstop in `scatterFill()`;
- `public/index.html` - `export-fbx.js` in the (relocated) workspace script
  block, `initGlobalSettingsEvents()` from `openWorkspaceSettings()`, and the
  touch-sized transform gizmo;
- `scripts/build.mjs` / `scripts/standalone-html.mjs` - unchanged by this
  revision.

Earlier this project tracked `6588ddd` (PR #21 + PR #22), `d81024a` (PR #20),
`35fa56f` (PR #19) and `5de16fa` (PR #17).

What `6588ddd` adds over `d81024a`:

- PR #21 “Edit Mode edits elements, and a trunk is one shell” — `fe_editmesh.cpp`,
  `fe_flora.cpp`, `edit-mode.js`, `index.html`, `sw.js`, `terrain-main-01/03/07.js`,
  docs and five test files.
- PR #22 “Give the ground its material back” — shader injections now stack
  instead of overwriting (`open-world.js`, `terrain-main-01.js`,
  `terrain-main-04.js`, `tests/ground-material.test.mjs`, `tests/shader-stack.test.mjs`).

`public/index.html` equals that blob plus the single local `export-fbx.js` script
tag. Every other synced file is byte-identical to the upstream head blob (checked
by `git hash-object`-style SHA-1 of the file contents); `index.html` is the only
file that cannot be fetched whole through the GitHub MCP tool because of its
result-size bound, so its identity rests on pre-state hash equality plus a patch
that applied with no context mismatches.

## Build

- `scripts/build.mjs`
  - publishes the checked engine and solver: `copyFileSync("wasm/fe_core_engine.wasm", "build/client/fe_core_engine.wasm")`
    and the same for `wasm/simulation_solver.wasm`, whose WASM magic is checked.
  - stages `vendor/three/*` into `build/client/vendor/three`, preferring the
    checked-in `vendor/three/<name>` and falling back to `node_modules/three`
    (only `three.min.js` is missing from the checkout, and the package copy —
    three@0.128.0 — matches the upstream vendored file at 603,445 bytes).
  - inlines that vendored three.js into both standalone single-file builds.
  - the two `export-fbx.js` hooks (minifiable, bundled) are gone with that
    patch itself — upstream defines `exportFBX()` now.
  - writes the camelAI worker manifest (`build/server/wrangler.json` +
    `build/server/worker.js`) from `wrangler.jsonc`.
- `scripts/standalone-html.mjs` — upstream's, unpatched again: the local
  `exportFbx` / `terrainStandaloneHtml` parameters went with the terrain
  standalone page.
- Upstream browser assets live at the repository root; this project keeps them
  under `public/`. Root-level page scripts and assets map to `public/` when
  pulling.

## Runtime fix: missing `exportFBX`

Upstream `index.html` runs `window.exportFBX = exportFBX;` but never defines
`exportFBX`. That ReferenceError aborted the rest of the inline script, so
`FE.register('core', ...)` never ran and the 3D Workspace showed
"3D Workspace engine not connected".

- `public/export-fbx.js` (ASCII FBX 7.4 writer that reuses the collected
  `workspaceExportNodes` data) is loaded from `index.html` right after
  `workspace-export.js`.
- Delete this patch only if upstream starts defining `exportFBX` itself.

**Dropped at `ab50dfa0`.** Upstream now defines `exportFBX()` in `index.html`
and routes the writers through the C++ kernel, so `public/export-fbx.js` is
deleted and the `<script src="export-fbx.js">` tag is gone.

## Bug fixes on top of the synced revision

### Ground material (`public/terrain-main-01.js`)

The terrain fragment shader injection added `ambientOcclusion *= ...` right after
`#include <aomap_fragment>`. three declares `ambientOcclusion` only inside
`#ifdef USE_AOMAP`, and the terrain material has no `aoMap`, so the variable did
not exist: the whole program failed to compile and the land rendered with no
material on every generation path that uses this material. The injection now
writes to `reflectedLight.indirectDiffuse` / `reflectedLight.indirectSpecular`
instead (specular occlusion guarded by `#if defined( USE_ENVMAP ) && defined( STANDARD )`).

Compile-checked against the vendored three r128 in a browser: the old line gives
`ERROR: 'ambientOcclusion' : undeclared identifier`, the new block compiles with
and without an `envMap`. In r128 the `PhysicalMaterial` field is
`specularRoughness` (a “fix” to `material.roughness` fails with “no such field in
structure”) — verified the same way, do not change it back.

### Viewport settings sheet (`public/index.html`)

`openWorkspaceSettings()` now calls `initGlobalSettingsEvents()`. The sheet’s rows
(Exposure, Orbit Speed, Floor Grid, Shadows, Temporal AA + blend, Navigation
Gizmo, Quality tier) forward their value to the legacy `#set-*` controls and
dispatch their event; those controls only got their behaviours when the old
Global Settings modal was opened, so on a fresh session the whole sheet moved its
sliders and changed nothing. Verified in the deployed app: exposure 1.25 → 2.2,
orbit speed 1 → 2, floor grid visible → hidden, shadows off → on.

### Transform gizmo (`public/index.html`)

`transformControls.size` is no longer the constant `1.15`; `gizmoTouchSize()`
returns `2.6` on touch/small viewports (`min(innerWidth,innerHeight) < 760`, or a
touch pointer with `< 900`) and `1.7` otherwise, and the resize handler re-applies
it.

## Binary artifacts

The engine is compiled from the checked-out C++ sources, so it can never drift
from them:

```
/venvs/project-*/bin/python3 -m ziglang c++ <flags from scripts/build-cpp-wasm.mjs> \
  <CPP_SOURCES> -o wasm/fe_core_engine.wasm
```

The `ziglang` PyPI package is a project Python dependency, so `python3 -m
ziglang` exists in the project venv. An `-O3` build of the 20 sources takes
about 20 seconds.

Current artifact (rebuilt from the `ab50dfa0` sources, 15 C++ sources):
**1,083,369 bytes, 292 exports, 0 imports**, ABI v1, covering all 233 entries in
`REQUIRED_EXPORTS`. Upstream's committed artifact for the same revision is
1,083,169 bytes (md5 of ours `8f9eb92731fe73873601262521c00051`); the 200-byte
difference is Zig codegen. `scripts/build.mjs` re-validates the artifact on
every build — the deploy log of this revision reads `Validated
fe_core_engine.wasm (1083369 bytes, ABI v1, 292 exports)`.

Note for the next pull: no Zig/clang toolchain is present in this workspace's
build environment, so `npm run build` validates the checked-in artifact instead
of recompiling it, and the staleness guard only compares mtimes. Rebuild with
`uv pip install --python /opt/analysis-venv/bin/python3 ziglang` in the project
shell before deploying a revision that touches `cpp/`.

Upstream's committed artifact for the same commit is **1,930,940 bytes, blob
`782ad89ee37340b3774dfa5edf74366ae4dc0bf4`** — the 1,280-byte difference is
Zig codegen (the maintainers build with whatever `pip install ziglang` gives
them). The upstream bytes cannot be moved into this project: the GitHub MCP
tool refuses results that large, and scratch files cannot be imported into a
project. Rebuild locally, or ask the user to upload the artifact so it can be
copied in from `/uploads`.

`wasm/simulation_solver.wasm` is tracked upstream (625,755 bytes, blob
`57d230c8ae71d20f81d0bb42c051d67ff317aa21`) and is copied as-is.

## 2026-0X — runtime-crash fixes (reported: Classic/PBR material dead, brush dead, errors, material lost on generate, zoom flicker)

All four were **unguarded engine-bridge calls / a malformed ShaderMaterial**, each of which threw
inside the render loop. A throw there stops the frame, so the symptom was never local: the ground
came back with no material, brush strokes did nothing, the view flickered.

1. `public/terrain-main-03.js` — `impostorMaterial()`: the billboard `THREE.ShaderMaterial` set
   `fog:true` and included the fog chunks but its `uniforms` object had no `fogColor`/`fogNear`/
   `fogFar`/`fogDensity`. three r128 calls `refreshFogUniforms()` for any `material.fog===true`,
   which dereferences `uniforms.fogColor.value` → `TypeError` every frame (reproduced live:
   "Runtime (render): refreshFogUniforms@three.min.js"). Three refreshes these each draw, so the
   declared values are placeholders. **Keep them.**
2. `public/terrain-main-01.js` `sculpt()` — `window.FELandscapeCore.brush(...)` was called unguarded,
   so any stroke before the WASM bridge landed threw ("Runtime (erosion)": updLive → liveErosionFlush
   → liveErosionTick) and the Brush button looked dead. Now `typeof …brush==="function"` inside
   try/catch, and the JS erosion path runs instead.
3. `public/terrain-main-01.js` `gen()` — `window.FELandscapeCore.generate(...)` unguarded; generating
   before the engine was ready aborted generation halfway, leaving the previous heights/colours with
   no material. Guarded, with the JS height generator as the fallback.
4. `public/terrain-main-01.js` `upd()` and `updLive()` — `colors()`/`normals()` guarded the same way;
   these run per brush stroke and per band upload.

Verified in a real browser against the deployed bundle: all four guards present in
`landscape-app.js`, the impostor material carries the fog uniforms, and `/` loads with
0 console errors / 0 page errors / 0 request failures.

## Local patch: small gizmos, wide touch targets (`public/index.html`)

`gizmoTouchSize()` returned **2.6** on a phone and **1.7** on desktop, so the
move/rotate/scale handles covered the mesh being transformed. It now returns
1.1 / 0.9, and the grabbing difficulty is handled where it belongs: the
TransformControls *pick volumes* (the 15%-opacity meshes the pointer actually
hit-tests) are cloned, scaled 2x about their own centre and set to fully
transparent, plus `depthWrite: false`. Only the target size changes; the gizmo
reads as thin arrows.

Rotate and scale build their gizmos lazily the first time the mode is shown, so
the widening runs from a hook around `transformControls.updateMatrixWorld`
(idempotent per mesh via `userData.feWideTarget`) rather than a single pass at
construction.

## Local fix: Edit Mode picking (`cpp/src/fe_editmesh.cpp`, `public/edit-mode.js`)

Taps selected the wrong thing, and taps on empty space selected something anyway.
`selectByRay()` ran a vertex pass in **every** mode with no distance limit:

- tapping far outside the mesh still took the nearest vertex - the reported
  "tap off the mesh and something on that side gets selected";
- in **face** mode that vertex index was returned as a *face* index, so an empty
  tap selected an unrelated face;
- the edge pass then required `d < bestDist * 0.8` of that stray vertex, which is
  why most edges could not be picked at all.

Now:

- only the active element kind is tested, and only inside a screen-space radius;
- `fe_edit_set_pick_tolerance()` (new export, added to the export list and the
  required-exports check in `scripts/build-cpp-wasm.mjs` so a rebuild keeps it)
  takes the radius in NDC units; `edit-mode.js` computes it from the canvas height
  and the pointer type - ~22 px for a fingertip, ~11 px for a mouse, scaled to
  0.8x for edges and 0.45x for faces (a face is a big target, and a tight face
  radius is what stops a tap next to the mesh from grabbing it);
- a tap that hits nothing within the radius selects nothing - no fallback;
- occlusion is judged under the **candidate**, not under the finger, so a vertex
  on the silhouette is no longer discarded for the surface depth at the tap;
- a face takes a tap just outside it by measuring to its closest edge, but only
  within the face radius;
- edges the wireframe does not draw (a quad's diagonal - an edge of the triangle
  soup, not of the surface) are no longer pickable, in the tap pick *and* in the
  box/circle region selector. What you can see is what you can select;
- vertex dots get a couple of pixels more on a phone-sized viewport.

Verified against the shipped wasm with wasmtime (cube: front vertex taps select
their vertex, back vertices are occluded, a 0.02-NDC offset still lands, 0.08 NDC
and empty space give -1, an edge taps its edge and the hidden diagonal gives -1,
a face tap reports one face for the two triangles of a quad).

## Local change: Object Mode and Edit Mode only (`public/index.html`, `public/fe-cpp-engine.js`)

Sculpt Mode, Vertex Paint, Weight Paint and Texture Paint were offered by the
mode dropdown, but their brush pipeline was never finished and kept fighting the
rest of the app. They are gone rather than left half-alive:

- `STUDIOS.core.modes` lists only `object` and `edit`;
- the `fe:mode` listener refuses anything else, says so and puts the dropdown
  back, so a cached page cannot half-enter a mode that has no tools;
- the `#cpp-sculpt-paint-bar` markup and its CSS are removed, and the listener
  that showed it is down to restoring the object outline;
- `FECppEngine.applySculptOrPaintAtPointer()` and the brush stroke handling in the
  pointer listeners are removed (155,215 -> 148,004 bytes in `fe-cpp-engine.js`).

Kept deliberately: the kernel brush primitives (`fe_sculpt_apply_brush`,
`fe_vertex_paint_apply`) - still exercised by the benchmark dialog - and
`subdivideActiveMeshForSculpt()`. A future sculpt feature should start from a
working kernel core, not from the lost half-finished brush layer.

## Local fix: Edit Mode with a modifier stack (`public/edit-mode.js`)

Reported: with a deform-style modifier (Cast / Lattice / Surface Deform) on the
object, editing the mesh left it bugged, with stray triangles and edits that
came back wrong.

Two halves of one mistake. While a stack is enabled `object.geometry` is the
*evaluated* output (`updateModifiersOnScene` runs the stack from
`userData.baseGeometry` and then puts `currentGeo` on the object), and
`commitToObject()` wrote the edited mesh only into `target.geometry`:

- entering Edit Mode uploaded the deformed mesh, so a Cast or Lattice was fed
  its own output and applied a second time;
- the stack rebuilds from `userData.baseGeometry`, which the edit never
  reached, so the next stack update replaced the edited mesh with a fresh
  evaluation of the pre-edit cage. With no *enabled* modifier the same function
  restores `baseGeometry` outright (`enabledMods.length === 0`), which threw the
  edit away on the spot.

Now:

- `upload()` edits `userData.baseGeometry` (the cage) when there is one;
- `enter()` puts that cage on screen for the duration, so the overlay the kernel
  draws lines up with the surface under the finger, and parks the evaluated
  output;
- `commitToObject()` publishes the edited mesh as the new cage and keeps the
  object's own geometry a separate copy - the invariant the stack relies on
  (`target.geometry` is always a clone of `baseGeometry`, never the same
  object, so the stack's dispose guard does not free the cage);
- `exit()` disposes the parked output and, when the stack has an enabled entry,
  calls `updateModifiersOnScene(target)` so the deformation is applied exactly
  once, to the mesh the user just changed.

Behaviour note: this matches Blender with "Display modifier in Edit Mode" off -
while editing you see the cage and the deformation returns on exit. Deforming
the cage *inside* Edit Mode would mean evaluating the stack against the kernel
mesh, a different and much larger piece of work.

## Local feature: quad faces in Edit Mode (`cpp/src/fe_editmesh.cpp`, `cpp/include/fe_editmesh_internal.hpp`, rebuilt `wasm/fe_core_engine.wasm`)

Reported: tapping a face in Edit Mode selected half of a cube side, and a tool
acted on that half, because the kernel's faces are triangles.

The kernel keeps selection on vertices only and derives edges and faces from it
(`faceSelected(t)`: all three of a triangle's vertices are selected), and every
tool goes through that one test - so the fix is to move a *face's* vertices
together. `buildQuadGroups()`, called at the end of `rebuildEdges`, pairs two
triangles that share an edge the wireframe already hides (`g_edgeDisplay`) into
one face: the same 0.6 degree coplanar test the display uses, so display and
selection cannot disagree. Candidates are taken longest edge first, because in
a triangulated quad mesh the drawn quad's diagonal is the longest edge of both
of its triangles while the edges two quads share are the shortest - a
subdivided plane therefore comes back as the quads it was drawn with instead of
being paired across them. Each triangle takes at most one partner, so a face
never grows past two triangles, and a triangle with no hidden edge - a
sphere's - is a face of its own.

- `selectFaceVerts` / `deselectFaceVerts` set the vertices of every triangle of
  the face, so picking one triangle picks all four corners of the side;
- `selectedFaceCount` counts faces, not triangles (a cube reports 6, not 12);
- `quadFaceSelected(t)` is available to tools that want the face test;
- no new exports and no JS change: `fe_edit_select_by_index` and
  `fe_edit_sel_count` are the entry points `public/edit-mode.js` already used.

Verified before shipping, three ways: a native build of the kernel (`zig c++`)
with a driver over a cube, a subdivided plane, a cylinder and a UV sphere; the
same cases expressed against the shipped wasm through wasmtime; and the live
file after deploy. Numbers: a cube's 12 triangles become 6 faces, tapping one
triangle reports 1 face with 2 triangles flagged and 4 vertices selected,
select-all reports 6 (not 12), extruding one face gives the expected 10 faces
(a cube side pushed out with four clean side quads), inset keeps them, bevel
gives 20 vertices / 28 triangles / 20 faces, deleting one face leaves 5, an
8 segment cylinder gives 8 side quads, and a UV sphere merges nothing into >2
triangles.

Artifact: `wasm/fe_core_engine.wasm` 1 092 158 bytes, md5 `47642d5bba1c0010e89a589b2098fab7`,
sha256 `f55519ad671d97a8d8f5794eed3d6eeff5d62f4de01a3d52cd1d96001697abb6`,
0 imports, 292 exports, all 233 REQUIRED_EXPORTS (unchanged list). Rebuild with
the arg list from `scripts/build-cpp-wasm.mjs` - note the extracted `'c++'`
literal has to be dropped before it is passed to `python3 -m ziglang c++`. The
previous engine is kept at `outputs/fe3d-engine-pre-quad.wasm` for rollback.

Known limit: these are quads for *selection and display*; the tools still run on
the triangles underneath (which is why loop cut remains unsupported - see the
note at the top of `fe_editmesh_tools.cpp`).

## Local feature: quad-clean Wireframe shading (`public/index.html`)

Reported: "every object's faces are cut in the middle" - a cube drawn in
Wireframe shading showed a diagonal across all six sides.  Blender does not,
because a Blender cube's faces are quads; ours are triangles.

The kernel already knew this for Edit Mode (`g_edgeDisplay` in
`cpp/src/fe_editmesh.cpp`, threshold `g_displayAngle = 0.6` degrees: an edge
whose two faces nearly agree is internal structure, not a silhouette).  The
viewport's Wireframe shading used `material.wireframe`, which can only draw
*every* triangle edge, so it was the one place that disagreed with Edit Mode.

`feApplyWireframeDisplay()` (inserted just above `applyShadingMode`) now draws
the shape as an `EdgesGeometry(geometry, 0.6)` overlay - the same 0.6 degrees -
while the mesh's own material stops writing colour and depth, so the fill is
invisible but the mesh stays in the scene and on the raycaster: picking, the
selection outline, the transform gizmo and history snapshots are unaffected.

- `feApplyWireframeDisplay` / `feRemoveWireframeDisplay` / `feClearWireframeDisplays`
  own the state; `applyShadingMode` clears it before every shading change and
  the Wireframe branch re-applies it per mesh.
- The two modifier paths that used to write `material.wireframe` by hand
  (the "no modifiers" restore and the end of the modifier stack) now go through
  the same helpers, with a Fluid domain keeping the raw triangle wireframe.
- Cached edges are invalidated by geometry uuid, checked by the 500 ms sweep,
  which also removes a stray overlay that a history restore brought back after
  Wireframe shading was left.  The table itself is built by
  `feBuildQuadWireGeometry`, an in-house equivalent of `EdgesGeometry(0.6)` that
  also honours the kernel's quad pairing - see "quads that stay quads" below.
- Solver surfaces (cloth / soft body / ultra-sim) and `InstancedMesh` shapes
  keep `material.wireframe`: their geometry is rebuilt every frame or shared
  between instances, so a cached edge table would be wrong.

Known limit: Edit Mode *displays* quad edges, but the edit mesh's face table is
still triangles, so tapping a face highlights one half of a cube side.  Real
quad faces would mean a quad/half-edge core in `fe_editmesh`, not a patch.

## Local fix: the object gizmo after leaving Edit Mode (`public/edit-mode.js`)

Reported: after editing vertices / edges / faces and switching back to Object
Mode, the transform gizmo "bugs and never goes away".

`enter()` detached the app's `TransformControls` and set `visible = false`,
but `exit()` set `visible = true` again.  In three r128 `detach()` owns that
flag (it clears `object` *and* hides the control), so a detached control forced
visible keeps drawing its handles at the last world matrix it had - a ghost
gizmo with nothing to move.

Now `enter()` records which object the gizmo held and in which mode, and
`exit()` gives it back only when a transform panel (`#panel-move`,
`#panel-rotate`, `#panel-scale`, `#panel-transform`) is still visible and the
object still exists and is unlocked; otherwise it calls `detach()`.  It asks
the panels rather than `window.activeObject`, because `activeObject` is a
script-scoped `let` in the workspace script and is not readable from
`edit-mode.js`.

## Vendored three.js touch fix (`vendor/three/OrbitControls.js`)

Reported from a phone in Edit Mode:

```
TypeError: undefined is not an object (evaluating 'event.touches[1].pageX')
(OrbitControls.js:666)
```

Third-party bug in three r128's `OrbitControls`: the touch state machine sticks
in `TOUCH_DOLLY_PAN` / `TOUCH_DOLLY_ROTATE` when one of the two fingers of a
pinch lifts, and the next `touchmove` calls `handleTouchMoveDolly()` with a
single touch, which reads `event.touches[ 1 ]` unconditionally. The app's global
error banner then reports it as "Something failed to load".

Fix, in the checked-in vendored file (nothing else changed):

- `handleTouchStartRotate/Pan` and `handleTouchMoveRotate/Pan` return early when
  `event.touches.length === 0`;
- `handleTouchStartDolly`, `handleTouchStartDollyPan`,
  `handleTouchStartDollyRotate`, `handleTouchMoveDolly`,
  `handleTouchMoveDollyPan` and `handleTouchMoveDollyRotate` return early when
  `event.touches.length < 2`;
- `onTouchMove` no longer falls through into a two-finger handler with one
  finger: it resets to `NONE` when no touch is left, and otherwise downgrades a
  `TOUCH_DOLLY_PAN` to `TOUCH_PAN` / a `TOUCH_DOLLY_ROTATE` to `TOUCH_ROTATE`,
  so the remaining finger keeps panning or orbiting instead of throwing.

`public/vendor/three/OrbitControls.js` carries the same bytes; the build stages
`vendor/three/*` into `build/client/vendor/three`, and the standalone download
inlines that file, so both the served app and the single-file build are covered.
Upstream's file is otherwise untouched — re-apply this when the vendored three
is bumped.

## Local feature: per-axis sliders and per-axis keyframes (2026-11-02)

Asked for in the Edit tool's panels — the Object Tools bar opened by `Edit` /
`Object Tools`, which is **not** Edit Mode. Two files:

- `public/index.html`
  - every axis row is now `label · slider · number box · ◆ key button`, so a
    value can be dragged or typed. The slider writes into the matching number
    box and then calls the same `applyTransformChange()` the box does, so both
    paths share one implementation (`applyAxisSlider()`); `syncAxisSliders()`
    keeps the sliders on the object's real transform while the gizmo moves it,
    and never fights the control the finger is on;
  - ranges: move −20…20 (0.1), rotate −180…180 (1°), scale 0.05…5 (0.05); the
    number boxes stay unbounded, so an out-of-range value still types in;
  - the Scale panel gets a slider for `Uniform:` as well. (This entry first
    greyed out *and* disabled every row the axis restriction excluded; see
    "Local fix: the axis restriction belongs to the gizmo" below for why that
    had to go.);
  - `◆` on a row keys **one channel**: location X/Y/Z = channels 0/1/2,
    rotation 3/4/5, scale 6/7/8 — so one axis animates while the other two keep
    their values at other frames (Blender/Maya style). `◆ Key X·Y·Z` at the
    bottom of each panel keys the whole group (`loc` / `rot` / `scale`).
- `public/fe-cpp-engine.js`
  - `insertKeyframeForActive()` also accepts an explicit channel array;
  - `FECppEngine.insertAxisKeyframeForActive('loc'|'rot'|'scale', 'x'|'y'|'z')`
    keys that single channel through `fe_anim_insert_keyframe(slot, channel,
    frame, value, interp)` — the same kernel call the existing `+ Loc` / `+ Rot`
    / `+ Scale` buttons use — and toasts which axis was keyed at which frame.
    Keys land on the current timeline frame; scale is refused for Camera/Light,
    exactly like the panel already does.

The root copies of both files stay upstream-pure: the deployment reads `public/`
(the build's `hasPublicDir` branch).

## Local fix: the axis restriction belongs to the gizmo, not to the numbers

Reported as "when I move the object, some axes cannot move it". Two causes, both
in the Move / Rotate / Scale panels:

1. **A restriction disabled two thirds of the panel.** `updateAxisRestrictionUI()`
   set `disabled` on the slider, the number box and the ◆ button of every row the
   restriction excluded. Picking "X Axis Only" therefore left a panel where Y and
   Z could not move the object at all — and the `<select>` that caused it is the
   first row of a sheet that scrolls, so on a phone it is often out of sight. The
   restriction now drives the gizmo only (`showX/showY/showZ`, which already
   hid the handles) exactly as Blender's axis constraint applies to the
   interactive grab and not to the numeric fields: the rows stay live. A chip in
   the panel's title bar names the locked axis and unlocks it in one tap
   (`releaseAxisRestriction()`), so the state cannot be hidden behind a scrolled
   select again.

2. **A slider pinned an object that was outside its range.** The Move sliders run
   over ±20 m and the Scale sliders over 0.05–5×. An object typed, animated or
   imported past those limits sat at the end of the track, and the next drag on
   that axis snapped it back to the limit instead of moving it. `feSliderFitValue()`
   widens the track to hold the object's real value and returns to the range the
   markup declares once the object is back inside it; `syncAxisSliders()` still
   never writes to the control the finger is holding.

Tests: `tests/axis-controls.test.mjs` runs the shipped functions against a DOM
stub — every axis is driven through every restriction for all three panels, an
out-of-range object is placed on its slider, and the gizmo lock itself is still
checked. The other half was measured outside the suite against the vendored
`TransformControls` with a real camera: each of X, Y and Z is grabbable, moves the
object along its own axis, and a handle hidden with `showX/Y/Z` is not pickable.

## Pulling the next revision (the GitHub channel)

Nothing in this workspace can reach `github.com` (the sandbox egress filter
answers 520, and the workspace's analysis sandbox only reaches PyPI), so the
repository is pulled by a workspace **workflow**, which runs on the platform
side and does have network access:

- workflow **`fe3d upstream sync`** (`edf5e7cf-a94a-4ae8-97c7-e625adbf2e8e`,
  disabled by default, run it with `run_workflow_now`). It resolves
  `main`, fetches the codeload tarball, verifies **every** file against its git
  blob SHA-1 from the tree API, and writes the text files into this project
  through `env.TOOLS.write({ location: "project", ... })`. Binary artifacts
  (`wasm/fe_core_engine.wasm`, `wasm/simulation_solver.wasm`,
  `volume-library.bin`, `vendor/three/three.min.js`) are skipped; the engine is
  rebuilt here, the solver and the volume library are already byte-identical.
  The run writes `tmp/fe3d-sync-report.json` (and a copy to R2
  `outputs/fe3d-sync-report.json`) plus `outputs/fe3d-tree.json`, the tree
  manifest (path → blob SHA) used for the byte-identity check.
- after a run: delete the files upstream deleted (compare the old tree against
  `outputs/fe3d-removed.json`), rebuild the engine (see below), re-apply the
  local patches listed above, refresh `public/` from the repository root, then
  `deploy_project`.


## Local fix: Wireframe that stays on the object (2026-11-03)

Reported as "while editing, the wireframe comes loose from the object — and in
Object Mode too". Three separate causes, all of them about drawing a wireframe
for something that is not the model, or for a shape that has already changed:

1. **Helper furniture was wireframed** (`public/index.html`,
   `feWireframeIsHelper`). `getAllSceneMeshes()` returns the transform gizmo's
   own handles (`X`, `XY`, `XYZ`, …), which are meshes, so Wireframe shading
   turned the move/rotate/scale gizmo into a wireframe sitting next to the
   object. The check now compares each node against the engine's own helper
   objects (`eng.transformControls`, `eng.selectionBox`, `eng.grid`, the floors)
   before falling back to names, and honours `userData.isHelper` /
   `userData.isEditorHelper` on any ancestor.
2. **A second overlay in Edit Mode** (`public/index.html`). The object's
   three.js geometry is a frame behind the kernel's `EditEdges`, so the JS
   `FEQuadWireframe` copy read as lines that no longer belonged to the shape.
   `applyShadingMode('wireframe')` now only re-applies materials while Edit Mode
   is open (the kernel overlay is the only wireframe), and the 500 ms sweep
   removes any stray overlay instead of rebuilding one.
3. **The modifier stack re-evaluated the mesh during Edit Mode**
   (`public/index.html`, `updateModifiersOnScene`). Edit Mode uploads the
   *cage*, edits it, and publishes it on exit. Evaluating the stack mid-session
   replaced the mesh on screen with the deformed output while the editor's
   wireframe and handles still followed the cage — two shapes in two places.
   The function now returns early while `FEEditMode.isActive()`, marks
   `userData.forceModUpdate` instead, and the commit on exit re-runs it.

Also: `feSyncWireframeOverlay` compares the position attribute's **version and
vertex count** as well as the geometry uuid, because a modifier can rewrite the
same buffer in place, which leaves a stale overlay that never rebuilds.

Verified live: with a moved / rotated / scaled object in Wireframe shading the
only overlays left are the model's own (`Cube:24` quad-clean segments — 24 = 4
per face × 6 faces, no diagonal); in Edit Mode the kernel overlay shows **12**
segments for a cube (the 6 quad outlines, triangles gone), and
`updateModifiersOnScene` during an Edit Mode session leaves the geometry
untouched.

## Local fix: quads that stay quads (`cpp/src/fe_editmesh.cpp`,
`public/edit-mode.js`, `public/index.html`)

The report was "the triangles are still there" after editing, and a wireframe
that "does not render properly". Two different faults:

1. **The quad pairing was re-derived from the current shape.** The kernel
   decides which two triangles are the two halves of one quad, and it used to
   decide that from geometry alone (the shared edge longest in both triangles,
   plus a fold limit). A deformation changes exactly those numbers, so a quad
   that had been bent grew its diagonal back and the face read as two
   triangles. The pairing is now measured once, when the mesh is first uploaded
   - the only moment the shape still describes what was drawn - kept across
   uploads while the triangle table is unchanged, and handed to the shell
   through two new exports (`fe_edit_quad_pairs_ptr`, `fe_edit_quad_pair_count`)
   as vertex index pairs. `edit-mode.js` writes those pairs onto the committed
   geometry (`userData.feQuadDiagonals`), and `index.html` uses them for
   Wireframe shading in Object Mode, so both modes draw the faces the editor
   worked with.
2. **Object Mode guessed quads too.** `feBuildQuadWireGeometry` had grown the
   same longest-edge rule, and it cannot tell a quad from a sphere: a sphere's
   own adjacent triangles share their longest edge and fold by less than 15
   degrees, so a third of a sphere's edges were being swallowed as "diagonals".
   The builder now hides only what is measured: the stashed pairing, plus edges
   whose two faces lie within `FE_WIREFRAME_EDGE_ANGLE` (0.6 degrees) of each
   other.

Live checks: a `BoxGeometry` draws 24 segments (its 6 diagonals hidden), a
24x16 `SphereGeometry` keeps every edge but its own quad diagonals (806 of 1142
unique pairs drawn, all 336 hidden ones being cell diagonals), a cube drawn in
Edit Mode stays at **12** segments after one of its corners is dragged 0.55
away, and the cage committed from that edit carries `6/8` diagonals so Object
Mode draws 12 as well.

`scripts/rebuild-wasm-local.py` rebuilds the engine when Node (and therefore
`scripts/build-cpp-wasm.mjs`) is not available: it reads the compiler flags out
of that script and runs zig directly.

## Local fix: the GPU Performance Tier used to make the viewport worse
(`public/fe-cpp-engine.js`, `public/index.html`, `public/fe-taa.js`)

Reported as "when I set this to High the viewport bugs out", with the settings
panel showing `35.4 ms · 28 FPS · Low (Mobile 60fps) quality · 0.85x` while the
tier select read "High (Flagship Phone)" - the readout and the selector
disagreeing was the clue. Three separate faults, all of them about who owns the
render scale:

1. **Two writers for the pixel ratio.** `applyHighRefreshMode()` set
   `clamp(devicePixelRatio, 1, cap)` itself, and `tickPerformanceGovernor()` set
   it from the kernel's frame-time recommendation (`recDpr`). On a 3x phone the
   first asked for 2 device pixels per CSS pixel - nine device pixels per CSS
   pixel - while the kernel was recommending 0.85. Each writer change reallocates
   the drawing buffer *and* its temporal AA targets, so the viewport visibly
   jumped. The governor is the single writer now; High Refresh Mode only sets
   its 1.5x ceiling and asks for an immediate re-decision.
2. **A stale temporal AA target is a stretched frame.** The pass re-sizes its
   targets on the next frame, so a resize that lands mid-frame draws one frame
   into the old target and stretches it to the new one. A phone changes its
   viewport height every time the browser chrome slides away, so this showed up
   constantly. The governor now calls `taa.setSize(drawingBuffer)` +
   `taa.reset()` in the same tick as the resize. Verified: targets equal the
   drawing buffer in every sample, tier switches included.
3. **A fixed tier forced temporal AA on.** `if (!isAuto) eng._autoTaa = true`
   meant picking *any* fixed tier - including Low - pinned TAA on regardless of
   cost, the opposite of "adapts resolution and shadow quality to keep the
   viewport smooth". The tier is now a preference (Low opts out, the rest opt in)
   and the frame times keep the last word, with the existing hysteresis. The
   governor also falls fast (to the kernel's level, never up) when a frame costs
   more than 28 ms and climbs one 0.15 step per 2.5 s when frames cost less than
   17 ms, which cannot oscillate the way chasing the recommendation did.
4. The settings tier select now mirrors its value into the workspace Quality
   tier (it was left stale) and re-syncs the viewport through the app's own path
   instead of only writing the engine's override.

`fe-taa.js`: re-enabling the pass clears the history, so a pause/resume cannot
blend in a frame from a different camera.

Measured on the deployed build at 1280x450, devicePixelRatio 1.5: High used to
settle at 1.5x (2.25x the pixels) with temporal AA forced on and 15 FPS in the
settings readout; it now holds 1.0x at 48-60 FPS with the same quality tier, Low
holds 1.0x at 51-60 FPS with TAA off, and Auto follows the kernel down to 0.85x
when frames are expensive and back up when they are not.

## Local fix: nothing of the old shape is left on screen in Edit Mode
(`public/edit-mode.js`, `public/index.html`)

Reported as "there are still triangles in the mesh, you can see it clearly when
editing vertices" and "the wireframe still comes away from the object", with a
screenshot showing a grey wedge, a dark line across one face, and an amber
outline box sitting beside the model. Two different objects, one cause: the
helpers that describe a whole object, still describing the shape it had before
the edit.

1. **The amber box is the selection outline, not a wireframe.** It is an
   `EdgesGeometry` copy of the geometry as it was when the object was selected,
   attached to the mesh and refreshed from the app's own paths. In Edit Mode the
   mesh on screen is the cage and the cage moves with every drag, so the outline
   stays where the old silhouette was - which reads as "the wireframe came away
   from the object". The mode now takes it out (removed, not hidden: hiding loses
   to whichever app path re-applies it) and `applyMeshSelectionOutline` draws
   nothing while the mode is active. Exit rebuilds it from the cage just
   committed.

2. **The dark line across the face is the object gizmo.** The engine attaches its
   TransformControls whenever a Move / Rotate / Scale panel opens or the
   selection changes, and three.js makes the gizmo visible inside `attach()`. It
   is a whole-object transform control with long axis lines that run through the
   model, and a line like that over a face is exactly what a stray triangle looks
   like. A small guard holds `transformControls.visible` down for the length of
   the session (the cage has its own `EditGizmo`, which is untouched) and stops
   at exit, where the object gizmo behaves normally again.

Measured on the deployed build: with a Move panel path simulated by calling
`attach()` + `applyMeshSelectionOutline()` repeatedly during a session, the scene
held 0 selection outlines and the gizmo stayed hidden; after exit the outline was
back and the gizmo worked again. Separately, the kernel's quad masking was
re-measured through a vertex drag, an edge drag and a face drag - drawn edges
12 = the cube's real edges, 6 diagonals hidden, and 0 of the stashed diagonals
ever drawn - so what remains over a face is either a real cage edge crossing it
after a large drag or the shading crease of a bent quad, not a triangle.

## Local fix: sharp, steady render scale (viewport flicker + low resolution)
(`public/fe-cpp-engine.js`, `tests/high-refresh-mode.test.mjs`)

Reported as "the resolution in the viewport is low" and "the view looks buggy
and flickers, I cannot even grab a clean screenshot of it". Both came from the
governor, and both are about how often it is allowed to change its mind.

1. **The scale had no floor worth the name.** One drawing-buffer pixel per CSS
   pixel is a ninth of the pixels on a screen that reports three device pixels
   per CSS pixel, so a viewport that settles at 1x there is soft by
   construction. The tiers now have floors: Low 1x (that is the tier that trades
   sharpness for speed), Medium 1.25x, Auto 1.5x, High 2x of the CSS size, with
   no floor above the ceiling, and High may climb to the device's own ratio -
   the sharpest a screen can show. On a 3x phone the scale now starts at the
   device ratio and settles at 2x (four ninths of the native pixels, twice what
   the previous build left on screen) instead of sliding to 1x.

2. **Every change is a visible flash, so there are far fewer of them.** A
   resize reallocates the drawing buffer and its temporal AA targets, and
   changing a shadow map disposes and rebuilds it. The old rules allowed a
   0.25 step every 1.2 s and a shadow resize every tick, and switched temporal AA
   off and on around 22 ms - the toggle alone made the frame time cross the
   threshold, so it ping-ponged every few seconds, which is the flicker. Now:
   the scale falls only below 25 fps (40 ms) and at most once every four seconds,
   with the first fall after a load or a tier change allowed to happen sooner and
   taken straight to the floor when the device is at 17 fps or worse (one flash
   instead of six); temporal AA comes on only after eight consecutive ticks -
   about ten seconds - under 16 ms and goes off above 24 ms; the shadow map only
   follows a difference of 25% or more and at most once every six seconds.

Measured on the deployed build, sampling the scale, the drawing buffer, the
temporal AA state and its target size every 250 ms for about forty seconds:
five scale changes in total, every one of them the response to a tier switch or
to a deliberately slowed device, none of them spontaneous at a steady 20-22 ms;
temporal AA never toggled; and the AA target matched the drawing buffer in every
sample, so no frame is drawn into a stale target and stretched - which is what
"an instant screenshot comes out wrong" was.

## Local change: two entries for one panel became one
(`public/index.html`, `tests/edit-mode-bridge.test.mjs`, `docs/EDIT-MODE.md`)

The main bar of the 3D Workspace carried `✏️ Edit` and `✋ Object Tools`, and
both branches called `renderObjectTools()` - the same object bar (Move, Rotate,
Scale, Transform, Annotate, Measure, 3D Cursor, Delete). Two entries for one
panel, with the word "Edit" on one of them, is what kept being taken for Edit
Mode (which is the dropdown's job and edits vertices, edges and faces in the C++
kernel). Object Tools stays and the `✏️ Edit` entry is gone, with its branch
removed rather than left dormant; the object bar is unchanged and Edit Mode is
still entered from the mode dropdown.

Verified on the deployed build: the bar reads Add 3D, Object Tools, Modification,
Animation Studio, Character Studio, VFX Studio, Light, Camera, Render Engine;
Object Tools opens Move / Rotate / Scale / Transform as before; the mode dropdown
still lists Object Mode and Edit Mode, entering and leaving Edit Mode works.

(Only `public/` is built and served - the copy of `index.html` at the repository
root is a stale snapshot from before the split and is not touched.)

## Local fix: keyframes on one axis are visible as one axis (Move/Rotate/Scale)
(`public/index.html`, `public/fe-cpp-engine.js`)

Reported as "if you key X and then key Y, the fact that X was keyed is ignored",
"the key button does not stay highlighted", and "the keys do not stack on the
timeline like Blender's do".

The keys themselves were never the problem. Measured on the live build: key
Location X at frame 10, then Location Y at frame 20 - channel 0 holds a key at
10, channel 1 at 20, and keying X again at 30 leaves channel 1's key at 20 alone.
Per-axis keying stores per-axis channels exactly as the panels claim. What was
missing was anything on screen saying so:

1. **The ◆ buttons kept no state.** `keyAxisChannel` flashed `.keyed` for 450 ms
   and removed it, so after keying Y only the last button was ever lit and the X
   key looked overwritten. The buttons now show the channel: lit when the channel
   has a key on the current frame, tinted amber when the channel is animated
   somewhere else, plain when it has no keys - re-evaluated on every timeline
   redraw, every key and every panel visit, with a tooltip that says which of the
   three it is. (The rotate panel's buttons are `key-rot-x` where the others spell
   the panel name out, so the id is a map, not a concatenation.)

2. **The dope sheet had four summary rows**, so a key on Location X at frame 10
   and one on Location Y at frame 20 drew both diamonds on the same line and the
   second read as a replacement for the first. It is one row per channel now -
   Location X/Y/Z, Rotation X/Y/Z, Scale X/Y/Z, Lens, Light - each with its own
   diamonds, its own faint curve behind them and its label dimmed while the
   channel has no keys, the way a dope sheet stacks them. The hit test that
   picks a key when you tap the sheet follows the same rows.

Verified on the deployed build: with keys on rotation Y at 10, rotation Z at 30
and scale X at 30, at frame 30 the buttons read animated / keyed / keyed and at
frame 10 they read keyed / animated / animated, while the kernel lists 10 on
channel 4, 30 on channel 5 and 30 on channel 6. Tapping the row centre of channel
0 finds its key at frame 10 and of channel 1 finds its key at frame 20, and empty
rows miss.

## Local fix: the ◆ key buttons are a toggle (press again removes the key)
(`public/index.html`, `public/fe-cpp-engine.js`)

Follows from the ◆ buttons now showing their channel's state: a lit button means
"this channel has a key on this frame", so pressing it again has to be the way to
take that key back, the way Blender's Key button toggles. Before this, every press
only ever added.

`hasKeyOnChannelAtFrame(slot, channel, frame)` answers the question,
`toggleAxisKeyframeForActive(prop, axis)` removes the key on the current frame if
there is one and inserts it otherwise, and `toggleKeyframeForActive(group)`
does the same for a whole group (all three of the group's keys on this frame come
off on a second press). The timeline and the dope sheet refresh either way, and
the toast says which happened.

One kernel detail that cost a round: `fe_anim_remove_keyframe_at` takes a single
channel index (or `0xFFFFFFFF` for all of them), **not** a bitmask - the mask form
belongs to the range calls (`fe_anim_delete_keys_in_range` and friends). Passing
`1 << channel` removed the wrong channel's key at that frame and passing a
combined mask was rejected as out of range, so the press looked like it did
nothing.

Verified on the deployed build: key Location X at frame 12 -> channel 0 holds 12
and the button is lit; press it again -> channel 0 is empty and the button goes
back to plain. With a key on Y at frame 24, removing X at frame 12 leaves the Y
key (and its amber "animated" button) alone. The group ◆ Key button at frame 40
lights all three, and pressing it again removes frame 40 from all three while
frame 24 on Y stays.

## Local fix: "Underlying ArrayBuffer has been detached from the view or out-of-bounds"
(`public/fe-cpp-engine.js`, `public/index.html`)

The banner is the page's global error reporter: the prefix "Unhandled:" means an
unhandled promise rejection, and the message is a TypedArray whose WebAssembly
buffer was detached - which happens when the wasm memory grows and a view made
against the old buffer is used afterwards. `scratch()` in the engine says the
rule out loud: "Never cache a view - memory growth detaches it; make views from
`ptr` when you need one."

The ◆ button state query added just before this broke that rule in the worst
place. It ran on every timeline redraw - every scrub, every key, every panel
visit - and each call did `fe_arena_reset()` and then asked the heap for a fresh
1536-byte block. The bump allocator never returns a byte, so that is a steady
drip of allocations on a hot path: it walks the heap towards the next grow, and
the grow lands in the middle of whatever else is building a view, the render
readback included.

- `channelKeyState(slot, channel, frame)` replaces the inline query: one named
  scratch block (`this.scratch('animKeyQuery', ...)`) that survives between
  calls, a view built from its pointer *after* the kernel call so a growth during
  that call cannot leave us holding the old buffer, and no view stored anywhere.
  It returns plain `{ count, here }`.
- `hasKeyOnChannelAtFrame` now reads that, and `syncKeyButtonStates` in
  `index.html` calls it instead of touching the arena and the heap itself.

Measured on the deployed build: 200 timeline redraws now make **0** heap
allocations (they made 200 before) and the memory size does not move; key,
un-key and the ◆ states all still behave; console and page errors stay empty.

## Local fix: modifier target lists, and saying which object a stack belongs to
(`public/index.html`)

Reported as "the Boolean cuts, but not always on the object I selected".

`modifierTargetOptions` listed **every** mesh in the scene. The viewport's own
furniture is made of meshes - the move gizmo's X / Y / Z / XY / YZ / XZ / XYZ
handles, the camera body and its lens ring, the light and its ring, the grid, the
floor, the selection box, the annotation group - so on a two-object scene the
Operand Object and Cage/Rig/Target lists held 51 entries, mostly named "X", "Y",
"Z", and picking one of those ran the Boolean against a gizmo bar: it either cut
something that was not the object the user meant or threw "Boolean needs a
different closed mesh selected as Operand Object" into a toast that scrolled away,
leaving the card looking healthy. Measured on the live build before the change:
51 options in a fresh scene, of which 0 were editable solids.

The list now excludes the furniture (by walking up from each mesh to see whether
it or an ancestor is the transform controls, selection box, 3D cursor, grid,
floor, shadow floor, camera, light or annotation group, plus SelectionOutlineHelper
and ModifierHelper), and only real movable solids remain. Measured after: 0
options in a fresh scene, and a second cube added by the user appears in the list.

While there, two things that made the stack hard to read were added, both in
`feModifierNotice`:

- the sheet header now says **which object** the stack belongs to ("on Cube"), so
  a Boolean added to the wrong object cannot look like the right one;
- when a stage throws, the reason stays on the panel in red ("Cube will not be
  changed - Boolean: ...") instead of only a toast, and the toast now names the
  modifier that refused.

Verified on the deployed build: a Boolean Difference onto the cube gives 16
triangles and a cut bounding box (0.7, -0.2, 0.7) against the base 12 triangles
and (0.7, 0.7, 0.7); changing the operand re-evaluates live; clearing the stack
restores the base mesh exactly, so the stack is non-destructive as it stands.

## Local fix: triangles drawn down the middle of flat faces
(`public/index.html`, `feBuildQuadWireGeometry`)

Reported as "the triangle is not an edge" - a diagonal across a flat face that
the model does not have, which is the right way to describe it.

`feBuildQuadWireGeometry` keys every edge by the pair of **vertex indices** its
two triangles use, so that a shared edge can be recognised, and then drops the
edges whose two triangles face the same way: two coplanar triangles are one quad
of the model and their shared edge is internal structure, not an edge. That
reasoning only holds for an *indexed* mesh. A Boolean or modifier result, a
decimated model, and most glTF exports are non-indexed: every triangle carries
its own three vertices, so two triangles that share an edge share a position but
not an index. No edge was ever seen as shared, no pair was ever called coplanar,
and the whole triangulation was drawn - the diagonal across the face, in the
wireframe, in See through, and in the edit cage's sibling overlays.

Vertices are now welded **by position** (quantised to 4 decimals) into canonical
ids for that table, and only for that table: indexed meshes keep their indices
unchanged, the actual vertex slot for each id is remembered so positions are
still read from the right place, and the pairing the kernel measured is mapped
through the same ids. Measured on the deployed build:

- a cube forced non-indexed (the shape a Boolean gives you) now draws **12**
  lines, its twelve edges, where it drew **18** - six face diagonals;
- a Boolean Difference cube (33 triangles, non-indexed) now draws **35** lines -
  its own edges and the notch - where it drew **99**, every triangle edge of the
  mesh;
- an indexed cube is unchanged (24 line segments over a split-vertex cube, which
  is the same twelve edges drawn twice).

The edit cage was never the problem: measured in Edit Mode on the cube, the
kernel reports 18 edges, 6 quad pairs, and hides exactly the 6 flat diagonals,
so the cage already draws the model's 12 edges.

## Local change: a polygon model for every mesh (quads and n-gons)
(`public/fe-poly.js` new, `public/index.html`)

Decision, after the report that a mesh is vertices and faces and that triangles
are only how a GPU draws one: keep the face list in the app, above the kernel,
with faces of any size (quads and n-gons), and recover faces for the meshes that
only exist as triangles. The wasm kernel keeps working on triangles underneath;
what changes is that nothing which *looks at* the shape has to guess any more,
and existing projects migrate the first time a geometry is looked at.

`fe-poly.js` (`window.FEPoly`) builds a face list from a BufferGeometry, measured
once per geometry and remembered on `geometry.userData.fePoly`, keyed to the
position attribute's version so a modifier that rewrites the buffer gets a fresh
one, and to the position count so it cannot be mistaken for another shape:

- vertices are welded by position (quantised to 4 decimals), because a Boolean or
  modifier result, a decimated model and most glTF exports are non-indexed and
  carry their own copy of each vertex;
- two triangles sharing an edge that face the same way (within the app's own
  0.6 degrees) are one quad, taken shortest shared edge first, each triangle used
  at most once, and only when the four corners are convex - so a sphere's
  neighbouring triangles, which differ in angle, are never fused and curved
  surfaces stay triangulated;
- everything left over stays a triangle, and a face that arrives with more than
  four vertices stays an n-gon.

`feBuildQuadWireGeometry` now asks the face list first and draws **the faces'
boundary edges** - the model's own edges - falling back to the older index-based
edge table only for shapes the face builder declines (over its triangle budget).
That ends the whole diagonal question at the root rather than hiding it.

Measured on the deployed build (fresh page, no errors on the console):

- a cube: **6 faces, all quads**, 12 triangles underneath - and the wire built
  from it is unchanged;
- the same cube forced non-indexed, which is the shape a Boolean hands you:
  **6 quads**, 8 welded vertices, **12 edges**;
- a Boolean Difference cube: 33 triangles underneath become **21 faces - 12
  quads and 9 triangles** - 23 welded vertices, and the wire drawn from those
  faces has no diagonals across any flat face.

Still to come in this direction: Edit Mode tools acting on faces (select /
extrude / inset / bevel per face) instead of triangles, face picking, glTF and
OBJ export written back out in quads and n-gons, and modifiers/loaders handing
their own faces to the model instead of relying on the recovery pass.

## Local fix: the edit sheet's height, and a face tap selecting a whole face
(`public/index.html`, `public/fe-poly.js`, `public/edit-mode.js`)

Two reports: the Edit tools panel climbed too far up the screen and left a hand's
width of empty space under its last row, and faces in Edit Mode were still
triangles - "the triangle system has not changed".

Height: `#edit-sheet` was capped only in viewport units (`42vh`, `46vh` on a small
screen), which on a tall phone is most of the screen. It now has a pixel ceiling
as well - `max-height: min(40dvh, 330px)`, and `min(38dvh, 300px)` under 640px -
and its tools strip is capped and scrolls (`min(26dvh, 210px)`), so the panel
stops at a strip of tools and never stretches. Measured: 288px and 187px in a
720px-tall viewport.

Faces: the edit mesh stores triangles, and a tap in face mode selected the one
triangle the ray landed on, so half of a quad lit up and the selection read as a
triangle. `FEPoly` now keeps `faceTris` - which triangles each of its faces is
made of, in the geometry's triangle numbering - and the selector asks it for the
face a kernel triangle belongs to and selects all of that face's triangles in one
call. The two triangle numberings are matched by centroid (the upload is free to
reorder triangles), and if fewer than 90% of the triangles match, the mesh on
screen is not the mesh FEPoly measured and a tap stays a single triangle rather
than grouping the wrong ones.

Measured in Edit Mode on a cube: FEPoly reports 6 faces of 2 triangles each, and
all 12 kernel triangles match a geometry triangle by centroid, 2 of 2 per face -
so a tap now lights the whole quad. Face *operations* (extrude, inset, bevel) are
still the kernel's per-triangle ones and are the next step.

## Local fix: Shade Smooth turning a face black (broken smoothed normals)
(`public/edit-mode.js`)

Report: pressing Shade Smooth in the Shading tab left the object looking dark and
wrong - "why does this happen when I apply Shade Smooth".

Shade Smooth cannot move a vertex: `fe_edit_set_shade` only sets a flag, and the
flag tells the kernel's render mesh to hand the GPU smoothed vertex normals
instead of letting the fragment shader derive a normal per face. What it can do
is make an already-broken normal visible. A smoothed normal is an average, and a
face with no area - a zero-area triangle left behind by a Boolean cut or a
collapsed edge, which every model collects - has no normal to contribute. Its
three vertices average to a non-number or to zero, so those vertices end up
facing nowhere and the surface around them renders black. Flat shading never
reads vertex normals, so the mesh looked fine until Shade Smooth was pressed.

`syncViewport` now runs `sanitizeRenderNormals` on every copy of the render
normals: any normal that is not a number, not a direction, not unit length, or
far from unit length is rebuilt as the average of the faces that vertex actually
belongs to. It works in render space against the kernel's own live counts (the
attribute counts are only updated afterwards, so reading them flags the stale
tail), so it needs no mapping back to the edit mesh, and a healthy mesh is left
untouched. The panel also says when it happened - "Shade Smooth: rebuilt N broken
normals" - which tells a dark surface caused by a broken normal apart from a dark
surface caused by something else.

Measured in Edit Mode on a cube: flat and smooth both report 0 repairs, every
normal is unit length, Shade Smooth / Shade Flat round-trip cleanly, no console
errors. The exact mesh from the report could not be reproduced, so the degenerate
face itself is still there - this only stops it from being visible as a black
patch.

## Local feature: project files — .fe3d and .fe3a, and opening them back
(`public/fe-project.js` (new), `public/index.html`)

The export sheet offered one native file: "Project Binary (.final3d)", and that
file could not hold a project. It wrote objects as a name, a transform and four
material numbers - no meshes at all - and nothing could read it back, so a
project that left the app could never return to it.

There are now two project files and both carry the whole project: `.fe3d` (the
current one) and `.fe3a` (the same project with the companion tag). Either one
opens back into the app from the sheet's "Open project" card, and the older
`.final3d` files still open too.

The format does not describe the scene a second time. A project is captured with
the two round trips the app already trusts for its own session recovery: the
engine's autosave (every scene object with its geometry, materials, userData and
the cameras, through THREE's ObjectLoader) and the core engine's animation blob
(every keyframe plus the object-to-slot map, straight from the C++ side). Opening
a file feeds both back through their own deserializers, so the parts of the app
that restore autosaves do the work.

An object's material is also listed separately, by the object's own uuid, because
the app's object registration puts a default material on a freshly restored
object - measured: a probe mesh exported orange came back grey before this was
added, orange after. Materials are re-applied after the scene, the animation and
the modifiers are back in place, and any object that cannot be found is named in
a warning instead of being passed over silently.

Container: 4 magic bytes ("FE3D" or "FE3A", or "F3D" + version for the old
files), a little-endian uint32 payload length, then the UTF-8 JSON.

Measured in the workspace, through a real File object exactly as the file picker
hands one over:

- `.fe3d` and `.fe3a` both: 15 materials in the file, 15 applied, scene counts
  identical before and after (15 meshes, 577 triangles, 783 vertices), 9
  keyframes preserved, and a hand-built BufferGeometry probe (no procedural
  parameters behind it) came back with its 12 vertices, its 30 indices, its
  vertex colours and its exact positions - and its orange material.
- `.final3d`: opens, applies the camera (both cameras, fov 45, near 0.2) and the
  lighting (exposure 1.4), and reports one warning that the file has no mesh
  data.
- The old `.final3d` writer is gone, not disabled; the export sheet no longer
  offers it.
