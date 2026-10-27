# Importing a studio scene into the 3D Workspace

The Landscaping studio and the 3D Workspace are two pages. **Import** posts one
scene payload from the studio to the Workspace, and the Workspace rebuilds it as
`ImportedLandscape` — one group, one camera framing, one environment, however
the scene was made.

Before this pass the exporter always packed the root 100 m grid, so a generated
open world or a procedural planet arrived as the default terrain. The payload
now names its `source`, and there are three of them.

## `source: 'terrain'`

The root grid: `S × S` metres at `N` segments, plus the studio's placed
objects and its 26 species of instanced plants (geometry + instance matrices,
not placeholder primitives). A planetary region produced by *touching down* on
a planet also lands here, because `planetLand()` writes it into the root
terrain.

## `source: 'world'`

Sent when the Open World is the visible mode. Every resident chunk is merged
into **one** heightfield instead of nine separate meshes:

* `measureChunks()` returns the world-space box the resident chunks cover.
* `mergedGridPlan()` picks a square grid over that box, never coarser than the
  finest source chunk (a 3×3 world of 96-segment, 256 m chunks becomes a 192²
  grid) and never larger than `maxSegments` so a handset cannot be asked to
  rebuild a million vertices.
* `sampleWorldField()` bilinearly resamples each chunk's heights and its
  12-channel surface weights onto that grid. Vertices that fall outside every
  chunk borrow the nearest one rather than opening a hole.
* Colours are computed where the chunk was generated, with `owColor()` — the
  same function that paints the studio's chunks — so the imported world has the
  same biome palette.
* Plants travel as their **own geometry and world-space transforms**.
  `matricesToTransforms()` folds each chunk group's centre into the instance
  translation and decomposes the matrix into position + quaternion + scale
  (10 floats) with the per-instance colour. The Workspace recomposes the
  matrix, so the trees that arrive are the trees that were grown.

The tile grid is +X then +Z in both studios, which is also the order
`PlaneGeometry` lays out after `rotateX(-PI/2)`; `tests/landscape-export-pack`
pins that by regenerating four real chunks with `OpenWorldGenerator` and
comparing the merged heightfield against `heightAt()` at every sample.

## `source: 'planet'`

A planet is not a heightfield, so it is not flattened into one. The exporter
tessellates the globe with the studio's own `planetRelief()` and surface
classifier (`pClass()` over the elevation/temperature/moisture/volcano map),
then sends:

* `radii` — one radius per sphere vertex,
* `normals` — quantised to `Int8`,
* `colors` — quantised to `Uint8`, sRGB decoded to linear on the way in.

The vertex order is exactly three.js `SphereGeometry`'s, so the Workspace
rebuilds `new SphereGeometry(radius, segments, rings)` and displaces it index
for index — no triangle soup, no seam crease (normals are computed across the
date line and clamped at the poles rather than by `computeVertexNormals()`).

## What both sides share

`terrain`, `water`, `sky`, `weather`, `foliage`, `map` and `objects` keep their
existing shape in every mode, so `buildLandscapeFromPayload()` only gained the
globe branch. Water follows the scene: the open world exports its own sea level
and radii, the planet sets `water.visible = false` (its ocean is the globe's
lowest band), the root grid keeps the studio's water.

## Limits

* Only **resident** chunks are exported. Chunks that were brushed and then
  streamed out live in `OW.editStore` and are regenerated if you walk back to
  them; they are not part of the payload.
* The merged grid is square, so a non-square resident set is fitted to its
  bounding box and the region outside the chunks is filled from the nearest
  edge. Resident sets are square in practice (3×3 or a quadtree patch).
* No real device has measured the import of a large world yet; the transfer is
  typed arrays over `postMessage`, and the Workspace still converts the
  imported terrain to a non-indexed geometry, which multiplies its vertex
  count by six.
