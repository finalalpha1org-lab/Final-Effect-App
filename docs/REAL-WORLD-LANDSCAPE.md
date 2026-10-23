# Real-world landscapes: what the Google Maps key can and cannot do

This note exists because the original goal — *photoreal terrain taken from the
real world, with real scanned trees, rocks and plants scattered naturally* — is
a good goal, but Google Maps Platform only covers one third of it. Being clear
about that is the difference between a demo that impresses and a demo that
disappoints.

## What is implemented now

| piece | where | status |
| --- | --- | --- |
| Google Elevation API fetch (one request per grid row, ≤ 512 samples/request) | `real-world-terrain.js` | working, network path |
| Response decoding + validation (`status`, sample count, numeric checks) | `real-world-terrain.js` | tested with mocked fetch |
| DEM → heightfield resample at metric scale, vertical exaggeration, datum offset | `cpp/src/fe_landscape.cpp: fe_terrain_apply_dem` | working, wasm |
| JS twin of that resample (fallback when wasm is unavailable) | `real-world-terrain.js: resampleToTerrain` | tested against the C++ kernel |
| UI: latitude/longitude/span/exaggeration, key kept in `localStorage`, "Use my location" | `terrain-main-07.js` (Import tab) | working |
| GLB / GLTF / OBJ import for a real-world model or city block | `terrain-main-04.js` | working (pre-existing) |
| Heightmap image import | `terrain-main-04.js` | working (pre-existing) |

The resample keeps the horizontal and vertical scale consistent: a 4 km box
mapped onto the 100-unit landscape gives `100/4000 = 0.025` world units per
metre, so a 300 m ridge becomes 7.5 units tall — unless you raise the
exaggeration slider, which is a *stylistic* choice, not the data.

### Cost and key handling

- Each grid row is one Elevation API request. A 65² grid is 65 requests; a 97²
  grid is 97. Google bills per request and rate-limits to 512 locations per
  request and 6,000 requests per minute.
- The key is entered in the UI, stored in `localStorage` only, and sent only to
  `maps.googleapis.com`. Restrict it to the Elevation API and to your HTTP
  referrers. Never commit it — `.env` was removed from this repo for that
  reason, and the previously committed example key should be rotated.
- Multi-point elevation requests can be returned at lower precision than a
  single-location request, which is why this client samples each row as a
  `path` instead of packing unrelated `locations`.

## What Google Maps Platform cannot give you

1. **Scanned vegetation and rocks.** There is no Google API that returns a
   tree, rock or plant mesh. Photorealistic 3D Tiles are streamed city/terrain
   meshes owned by Google; their terms allow displaying them inside your map,
   not extracting geometry or textures to scatter as your own assets.
2. **A terrain mesh you can freely derive from.** Elevation API gives numbers
   (heights), which is what we use. Satellite *raster* tiles come from the Map
   Tiles API with session tokens and caching/attribution restrictions; they are
   fine as a draped orthophoto inside the app, not as a redistributable asset.
3. **Photoreal shading.** Photorealism is decided by scanned PBR assets,
   physically-based lighting and post-processing, not by the heightfield. A
   real DEM with flat procedural materials still looks like a game.

## The asset side: how scanned meshes are supposed to enter

The scatter pipeline already supports instanced foliage (`KIND`/`InstancedMesh`
with LOD proxies) and the Open World generator places by biome, slope and
water distance. What it lacks is a *library of scanned meshes*:

1. Author/purchase a scan set: Poly Haven (CC0), Quixel Megascans (EULA),
   Sketchfab (per-asset licence). Each tree needs LOD0/LOD1/LOD2 + billboard
   impostor for the far tier, plus albedo/normal/roughness/AO.
2. Export as GLB (Draco optional). Keep the scan's real-world scale in metres;
   the scatter code converts metres to world units with the same metric scale
   as the terrain so trees are not 10× too big on a 4 km landscape.
3. Register the GLB as a scatter kind, and let the C++ placement kernels
   (`fe_terrain_scatter_batch`, Open World biome rules) choose position, yaw,
   scale jitter and tier. Ground snapping uses the resident heightfield, so
   assets sit on the real terrain, not on the original scan's flat plane.
4. Ship the LOD tiers as separate instanced meshes; the renderer swaps tiers by
   camera distance. This is the only way a few thousand scanned trees fit a
   phone GPU.

Steps 1–2 need assets the repository cannot download (licensing and size), so
this stays an **Experimental/Incomplete** path until a scan library is added.

## Honest expectations for "ultra photoreal" in this app

- The renderer is three.js 0.128 over WebGL2 with an ACES tone-map and bloom.
  It has no virtual texturing, no Nanite-style cluster LOD and no hardware
  ray-traced GI. Desktop can look photoreal-ish with good scans and lighting;
  a phone at 60 fps cannot look like a film frame of a forest.
- The realistic target: a 4–20 km landscape whose macro shape is genuinely the
  real place, with a believable vegetation palette and density, good sun/sky,
  and scanned hero assets near the camera.
- Anything short of that should be labelled **Experimental** in the UI, which
  is what the new panel does.

## Next steps (in order)

1. Satellite orthophoto drape: Map Tiles API session token, tile stitching, and
   triplanar blending under the existing splat weights.
2. Scan-library registration: GLB → kind, metric scaling, 3 LOD tiers,
   serialization in project files.
3. Slope/altitude/water masks from the DEM feeding the scatter density so
   vegetation follows the real landform (rock on cliffs, reeds at water's edge).
4. Water bodies from DEM depressions (priority flood on the imported grid).
