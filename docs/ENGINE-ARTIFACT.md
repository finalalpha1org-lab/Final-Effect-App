# Engine artifact health

The shell (`index.html`) never shows an engine/version label. The only place a
stale binary is reported is the **Performance Benchmark** sheet, and that report
is the contract below.

## What the loader does, in order

1. `./fe_core_engine.wasm` and `./wasm/fe_core_engine.wasm` are both fetched with
   `cache: 'no-cache'`. The artifact with the most exports wins, a *complete*
   artifact stops the search, and anything older never shadows anything newer.
2. `describeArtifact(exports, bytes)` compares the mounted exports against
   `REQUIRED_KERNELS` and returns `{ bytes, exports, missing, modules, complete }`.
3. If a kernel group is still missing, `ensureFreshArtifact()` re-fetches the
   winning URL once with a cache-busting `?v=` query so a browser or CDN copy
   from an earlier deploy cannot survive.
4. If it is *still* incomplete the artifact itself is old in the deployment:
   `warnStaleArtifact()` logs one line to the console (never to the UI).

## Required kernel groups

| Group | Exports checked |
| --- | --- |
| `animation` | `fe_anim_insert_keyframe`, `fe_anim_evaluate_channel`, `fe_anim_bake_samples` |
| `volumetrics` | `fe_vol_init`, `fe_vol_step`, `fe_vol_surface`, `fe_vol_stats_ptr`, `fe_vol_density_ptr`, `fe_vol_grid_size` |
| `modifiers` | `fe_mod_begin`, `fe_mod_subdivide`, `fe_mod_lattice_apply`, `fe_mod_shrinkwrap` |
| `simulation` | `fe_sim_bake_compress`, `fe_sim_xpbd_deformable_step`, `fe_sim_liquid_pbf_step`, `fe_sim_pyro_step` |
| `triangulate` | `fe_polyfill_begin`, `fe_polyfill_build`, `fe_polyfill_positions_ptr`, `fe_polyfill_ring_ptr`, `fe_polyfill_start_ptr`, `fe_polyfill_tris_ptr`, `fe_polyfill_quad_count`, `fe_polyfill_ngon_count`, `fe_polyfill_max_vertices`, `fe_polyfill_max_corners`, `fe_polyfill_max_faces`, `fe_polyfill_max_face_verts` |
| `flip-liquid` | `fe_flip_begin`, `fe_flip_step`, `fe_flip_grid_nx`, `fe_flip_grid_ny`, `fe_flip_grid_nz`, `fe_flip_cell_size`, `fe_flip_cell_count` |
| `export` | `fe_export_bake`, `fe_export_bake_instanced`, `fe_zip_crc32`, `fe_volatlas_pack`, `fe_volatlas_sample`, `fe_volatlas_parse_library`, `fe_writer_obj_mesh`, `fe_writer_mtl_material` |
| `render-maths` | `fe_taa_halton`, `fe_taa_jitter`, `fe_taa_project`, `fe_color_blackbody_rgb`, `fe_color_blackbody_lut` |
| `edit-mode` | `fe_edit_upload`, `fe_edit_build_render`, `fe_edit_pick`, `fe_edit_quad_pairs_ptr`, `fe_edit_quad_pair_count`, `fe_edit_set_pick_tolerance`, `fe_edit_set_faces`, `fe_edit_face_count`, `fe_edit_tri_tag_ptr`, `fe_edit_tri_tag_count` |
| `faces` | `fe_poly_begin`, `fe_poly_build`, `fe_poly_face_count`, `fe_poly_face_start_ptr`, `fe_poly_face_ring_ptr`, `fe_poly_edge_ptr`, `fe_poly_kind_counts_ptr`, `fe_poly_weld_rep_ptr` |

The shipped build is `1534331` bytes, ABI v1, **361 exports**; every group above
is satisfied, so `artifact.complete` is `true` and all eight benchmark rows pass.

Twenty-two of the exports are world-space baking, the volume atlas and the ZIP
CRC (`cpp/src/fe_export.cpp`, `cpp/src/fe_volatlas.cpp`): the exporters and the
sequence packer call those kernels instead of looping over vertices and bytes in
JavaScript.

Five more are the temporal anti-aliasing sampling maths and the Planck/CIE
blackbody colour that bakes the fire ramp (`cpp/src/fe_render_math.cpp`). Those
have no libm to lean on, so `cpp/include/fe_math64.hpp` carries the double
`exp`, `log`, `pow` and `mod` the freestanding build does not ship.

Eight are the Wavefront text writers (`cpp/src/fe_writer.cpp`): OBJ and MTL are
formatted into one append buffer in engine memory, including the six-decimal
number form the OBJ format uses, and decoded once on the JavaScript side.

Eight of them are faces in `cpp/src/fe_editmesh.cpp`. The kernel groups the
triangles that make one face and hands the table out through `fe_edit_face_*`
(one corner ring per face: three corners for a triangle, four for a quad, n for
an n-gon), with the edges *inside* a face - a quad's diagonal, the spokes of a
cap - through `fe_edit_quad_pairs_ptr` / `fe_edit_quad_pair_count` (also
`fe_edit_interior_pair_*`). A shape that cannot describe its own faces in
triangles - a cylinder's cap is one thirty-two-gon in Blender and a fan of
triangles in the buffer - declares them with `fe_edit_set_faces`, and
`fe_edit_set_pick_tolerance` takes the screen-space radius a tap is judged by.
The mesh library in `index.html` is where the declarations come from; see
`docs/FACES.md`.

Twenty of the exports are the rig (`cpp/src/fe_skin.cpp`): `fe_skin_begin`,
`fe_skin_solve`, `fe_skin_deform`, `fe_skin_auto_weights`, the pointer getters
and `fe_skin_bind_from_pose`. They are documented in `docs/SKELETON.md`.

Twenty of them are the face law (`cpp/src/fe_poly.cpp`): `fe_poly_begin` takes a
mesh in (positions, triangle indices, and the faces the app declared), and
`fe_poly_build` returns the model's faces, the triangles behind each face, the
model's edges and the weld table. Edit Mode has measured its own faces in C++ for
a long time (`buildQuadGroups`); Object Mode's wireframe, See through view and
selection outline used to measure them again in JavaScript (`fe-poly.js`), and
two measurements of one law drift - a fix in one showed up as a diagonal Object
Mode drew and Edit Mode did not. `fe-poly.js` is now the marshaller only: it
copies the buffers in, copies the tables out and caches them on the geometry.
`tests/fe-poly.test.mjs` and `tests/primitives-quads.test.mjs` run the module
against the shipped artifact and pin the same face counts for both views.

## Memory: you pay for the studios you open

The artifact boots in **52.9 MiB** of linear memory. It used to boot in 169.4,
because every kernel kept its working set in BSS whether or not anything used
it.

Those buffers now come from `fe::heap` (`cpp/include/fe_heap.hpp`,
`cpp/src/fe_heap.cpp`): a bump allocator that starts at `__heap_base` and grows
linear memory a page at a time with `memory.grow`. WebAssembly memory is zero
filled, so an allocation never has to be cleared, and a pointer never moves.

| Buffer | Was (BSS) | Now |
| --- | --- | --- |
| Path tracer targets (1280x720) | 48.65 MiB at every boot | 21.97 MiB on the first still |
| Surface-reconstruction grid (97³ × 4) | 14.6 MiB | on the first liquid mesh |
| Smoke solver (40³ lattice) | 9.5 MiB | on `fe_vol_init` |
| Edit Mode undo pool | 6.0 MiB | on the first Edit Mode snapshot |
| **Boot** | **169.4 MiB** | **52.9 MiB** |

`fe_heap_lazy_used()` reports what has been handed out and
`fe_heap_lazy_capacity()` the room left before the next grow, so the working set
is a measurement rather than a claim. `fe_heap_alloc` is also the single owner
of that region: the simulation core's JavaScript arena used to be a second bump
allocator starting at the end of memory, which after this change would have
handed out the same address twice, so it now asks the kernel.

What is deliberately still static is the JavaScript marshalling arena (24 MiB)
and the Edit Mode and renderer working sets. The arena is a ring that callers
keep long-lived pointers into, so splitting it or regrowing it is a redesign,
not a one-line change. `tests/engine-memory.test.mjs` pins the boot reservation
at under 100 MiB and asserts that a kernel nobody opened has allocated
nothing.

## When a row is red

The benchmark has no row for a subsystem the build does not ship. The
Landscaping Studio was removed from this build, so its terrain, ocean, flora,
climate, LoD, impostor and surface kernels are gone with it.

`Smoke & Fire Volume Solver` fails only when `fe_vol_*` is absent or the 16³ MAC
grid does not project its divergence down.

In both cases the sheet shows a red *Engine artifact is outdated* banner naming
the missing exports and the **Repair Engine** button:

`window.repairEngineArtifact()` → `ensureFreshArtifact({ force: true })` →
re-runs the benchmark in place.

If the banner survives a repair, the deployed file is old - redeploy the build
that passes `Validated fe_core_engine.wasm (1534331 bytes, ABI v1, 361 exports)`.

## Verification

```bash
node --test tests/cpp-live-diagnostics.test.mjs   # 4 tests
node --test tests/engine-memory.test.mjs           # 7 tests
npm test                                          # the whole suite
npm run build                                     # revalidates + copies the artifact
```
