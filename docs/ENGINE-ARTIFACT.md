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
| `ocean` | `fe_ocean_configure`, `fe_ocean_update`, `fe_ocean_resolution` |
| `terrain` | `fe_terrain_erode_brush`, `fe_terrain_erode_hydraulic`, `fe_erosion_begin`, `fe_erosion_step`, `fe_erosion_dirty_ptr`, `fe_lod_visible`, `fe_lod_visible_index_ptr`, `fe_lod_visible_tier_ptr` |
| `lod` | `fe_lod_tree_build`, `fe_lod_tree_cull`, `fe_lod_tree_index_ptr`, `fe_lod_tree_tier_ptr`, `fe_lod_tree_stats_ptr`, `fe_lod_tree_pool_ptr` |
| `impostor` | `fe_impostor_build`, `fe_impostor_pixels_ptr`, `fe_impostor_bounds_ptr`, `fe_impostor_column` |
| `surface` | `fe_surface_pbr`, `fe_surface_detail`, `fe_water_optical` |
| `flora` | `fe_flora_tree`, `fe_flora_rock`, `fe_flora_card_pos_ptr`, `fe_flora_card_idx_ptr`, `fe_flora_part_ptr`, `fe_flora_leaf_ptr`, `fe_flora_sway_ptr`, `fe_flora_phase_ptr`, `fe_flora_lsystem`, `fe_flora_lsystem_load`, `fe_flora_lsystem_run`, `fe_flora_lsystem_reset`, `fe_flora_lsystem_plant`, `fe_flora_set_shape`, `fe_build`, `fe_build_kind_count` |
| `climate` | `fe_climate_at`, `fe_climate_weather`, `fe_climate_biome`, `fe_climate_biome_grid` |
| `volumetrics` | `fe_vol_init`, `fe_vol_step`, `fe_vol_surface`, `fe_vol_stats_ptr`, `fe_vol_density_ptr`, `fe_vol_grid_size` |
| `modifiers` | `fe_mod_begin`, `fe_mod_subdivide`, `fe_mod_lattice_apply`, `fe_mod_shrinkwrap` |
| `simulation` | `fe_sim_bake_compress`, `fe_sim_xpbd_deformable_step`, `fe_sim_liquid_pbf_step`, `fe_sim_pyro_step` |

The shipped build is `1829120` bytes, ABI v1, **409 exports**; every group above
is satisfied, so `artifact.complete` is `true` and all eight benchmark rows pass.

Twenty of the exports are the rig (`cpp/src/fe_skin.cpp`): `fe_skin_begin`,
`fe_skin_solve`, `fe_skin_deform`, `fe_skin_auto_weights`, the pointer getters
and `fe_skin_bind_from_pose`. They are documented in `docs/SKELETON.md`.

Five of the exports are not a kernel group: `fe_scatter_begin`,
`fe_scatter_matrices`, `fe_scatter_order_ptr`, `fe_scatter_aux_ptr` and
`fe_scatter_terrain` are the instance-transform block the studio fills every
time a camera pan settles. They are documented in `docs/PERFORMANCE.md`.

## Memory: you pay for the studios you open

The artifact boots in **86.6 MiB** of linear memory. It used to boot in 169.4,
because every kernel kept its working set in BSS whether or not anything used
it — and the kernel worker, whose only job is baking a 64x128 impostor atlas,
reserved a second copy of all of it.

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
| Surface detail map (512²) | 4.0 MiB | on the requested size |
| Ocean FFT cascades (3 × 256²) | 10.8 MiB | on `fe_ocean_configure` |
| **Boot** | **169.4 MiB** | **86.6 MiB** |

`fe_heap_lazy_used()` reports what has been handed out and
`fe_heap_lazy_capacity()` the room left before the next grow, so the working set
is a measurement rather than a claim. `fe_heap_alloc` is also the single owner
of that region: the simulation core's JavaScript arena used to be a second bump
allocator starting at the end of memory, which after this change would have
handed out the same address twice, so it now asks the kernel.

What is deliberately still static is the working set both studios share: the
terrain grid is 22 MiB of it and the JavaScript marshalling arena 24 MiB — the
arena is a ring that callers keep long-lived pointers into, so splitting it or
regrowing it is a redesign, not a one-line change, and it is the next largest
block after the terrain. `tests/engine-memory.test.mjs` pins the boot
reservation at under 100 MiB and asserts that a kernel nobody opened has
allocated nothing.

## When a row is red

`Landscape & Ocean Kernels` fails only when the **ocean kernel** is missing or
returns a bad wave field. The terrain bridge (`window.FELandscapeCore`) lives in
the Landscaping Studio frame, so its absence on the home screen is *not* a
failure - the row says `terrain bridge runs in the Landscaping Studio frame`.

`Smoke & Fire Volume Solver` fails only when `fe_vol_*` is absent or the 16³ MAC
grid does not project its divergence down.

In both cases the sheet shows a red *Engine artifact is outdated* banner naming
the missing exports and the **Repair Engine** button:

`window.repairEngineArtifact()` → `ensureFreshArtifact({ force: true })` →
re-runs the benchmark in place.

If the banner survives a repair, the deployed file is old - redeploy the build
that passes `Validated fe_core_engine.wasm (1829120 bytes, ABI v1, 409 exports)`.

## Verification

```bash
node --test tests/cpp-live-diagnostics.test.mjs   # 6 tests
node --test tests/landscape-realism.test.mjs      # 14 tests
node --test tests/landscape-flora.test.mjs        # 24 tests
node --test tests/buildings.test.mjs               # 7 tests
node --test tests/landscape-climate.test.mjs      # 15 tests
node --test tests/landscape-settings-persistence.test.mjs  # 7 tests
node --test tests/engine-memory.test.mjs           # 7 tests
npm test                                          # 539 tests
npm run build                                     # revalidates + copies the artifact
```
