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
| `terrain` | `fe_terrain_erode_brush`, `fe_terrain_erode_hydraulic`, `fe_lod_visible`, `fe_lod_visible_index_ptr`, `fe_lod_visible_tier_ptr` |
| `surface` | `fe_surface_pbr`, `fe_surface_detail`, `fe_water_optical` |
| `flora` | `fe_flora_tree`, `fe_flora_rock`, `fe_flora_leaf_ptr`, `fe_flora_sway_ptr`, `fe_flora_phase_ptr`, `fe_flora_lsystem`, `fe_flora_lsystem_load`, `fe_flora_lsystem_run`, `fe_flora_lsystem_reset`, `fe_flora_lsystem_plant`, `fe_flora_set_shape` |
| `climate` | `fe_climate_at`, `fe_climate_weather`, `fe_climate_biome`, `fe_climate_biome_grid` |
| `volumetrics` | `fe_vol_init`, `fe_vol_step`, `fe_vol_surface`, `fe_vol_stats_ptr`, `fe_vol_density_ptr`, `fe_vol_grid_size` |
| `modifiers` | `fe_mod_begin`, `fe_mod_subdivide`, `fe_mod_lattice_apply`, `fe_mod_shrinkwrap` |
| `simulation` | `fe_sim_bake_compress`, `fe_sim_xpbd_deformable_step`, `fe_sim_liquid_pbf_step`, `fe_sim_pyro_step` |

The shipped build is `1121249` bytes, ABI v1, **242 exports**; every group above
is satisfied, so `artifact.complete` is `true` and all eight benchmark rows pass.

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
that passes `Validated fe_core_engine.wasm (1121249 bytes, ABI v1, 242 exports)`.

## Verification

```bash
node --test tests/cpp-live-diagnostics.test.mjs   # 6 tests
node --test tests/landscape-realism.test.mjs      # 14 tests
node --test tests/landscape-flora.test.mjs        # 18 tests
node --test tests/landscape-climate.test.mjs      # 15 tests
node --test tests/landscape-settings-persistence.test.mjs  # 7 tests
npm test                                          # 367 tests
npm run build                                     # revalidates + copies the artifact
```
