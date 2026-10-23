# Open World forest impostors

Implemented in `open-world.js` and the shared `fe_landscape.cpp` WASM backend.

- Existing near foliage remains unchanged. Distant tree-category assets beyond
  `max(tree radius + 160, 500)` world units can use a two-triangle card.
- Four orthographic azimuth views of a species' first procedural variant are baked
  into a 1024 × 256 RGBA atlas. Position/scale, colour and yaw variations remain.
- Cards batch by species, view and 128-unit streaming cell. Existing per-instance
  CPU view rejection remains: Three r128 does not automatically compute suitable
  per-instance bounding spheres. Cards deliberately do not use the source plane's
  incorrect frustum bounds.
- At most one species is baked per active world frame, with a hard 24-atlas cap.
  One bake still has four GPU submissions and may cause a frame spike. A full cap
  uses approximately 24 MiB color plus depth buffers (driver dependent).
- Dithered screen-door crossfade spans 120 world units, centered on the LOD
  distance. Complementary mesh/card shader discard masks retain opaque depth
  writes and avoid transparent-object sorting. Shared camera/distance uniforms
  update every active world frame, independently of streaming rebuilds.
- Warm atlas requests begin 220 units before the center. Existing source meshes
  are already resident in KIND. Mesh/card batches overlap with hysteresis: card
  enter/exit at center−100/−140; mesh enter/exit at center+100/+140. The visible
  fade is center±60. Source materials are never modified: owned shader clones
  are released on pool eviction. This prewarms residency, not an explicit async
  GPU shader compile or a guarantee against first-use compilation stalls.
- Unready/failed/cap-exceeded atlases retain full-mesh rendering; no missing trees.
  Resource clearing removes instance buffers before disposing owned atlas assets.
- A lazily started Blob worker instantiates the same unified C++ WASM artifact in
  an independent memory and classifies candidate distance/azimuth in bounded
  32,768-record scratch chunks. No wrapping arena allocations. Rendering is not
  blocked on the worker. JS distance/frustum checks and angle fallback remain;
  procedural terrain/foliage generation itself has **not** migrated to this worker.
- `OW_API.forestImpostors.stats` exposes atlas/card/triangle counts and worker state.
  The Open World HUD reports card instances and whether the C++ worker is ready.

## Known limitations / next phases

This is a distant-tree optimization, not a complete forest renderer or asset
retopology pipeline. Midrange meshes retain existing geometry. Four-angle views
switch discretely; no elevation atlas, seasonal rebake, near-tree mesh decimation
or impostor shadow proxy is implemented. Crossfade reduces the distance switch
but different silhouettes/lighting can still be perceptible. Camera teleports
may bypass the overlap before the next streaming tick. Atlas lighting
is baked neutral rather than dynamically relit. Source procedural variant zero is
used; distant silhouettes have less variation than nearby meshes. Plants, rocks,
and the default non-open-world terrain are not switched to this new card path.

GPU baking and browser integration need visual validation on the target phone.
Node tests exercise geometry, renderer-state restoration with a renderer double,
worker execution with real WASM, scratch bounds and fallback logic. They are not a
real WebGL/phone FPS benchmark. No 30/60 FPS or photorealism guarantee is implied.
