# Modifier kernels — C++ core

The Workspace modifier stack is evaluated by the C++ core. HTML/JS keeps the
panel, the parameter form and the GPU upload; the geometry maths runs in
`cpp/src/fe_modifiers.cpp` and is exported through `fe_core_engine.wasm`.

## Session ABI

One modifier evaluation owns a mesh session. JS writes the indexed triangle mesh
straight into the core's linear memory and reads the result back from the same
buffers, so there is no intermediate copy on either side.

| Export | Purpose |
| --- | --- |
| `fe_mod_begin(vcap, tcap, has_uv)` | resets the scratch arena and lays out the session |
| `fe_mod_in_pos_ptr` / `fe_mod_in_uv_ptr` / `fe_mod_in_idx_ptr` | where JS writes the mesh |
| `fe_mod_set_counts(v, t)` | declares the incoming mesh size |
| `fe_mod_counts_ptr` | `[vertex_count, triangle_count]` after a kernel |
| `fe_mod_normals_ptr` | recalculated area-weighted normals |
| `fe_mod_matrix_ptr` | 16-float column-major relative matrix (target/rig space) |
| `fe_mod_target_begin(v,t)` + pointers | optional target mesh for shrinkwrap / surface deform |
| `fe_mod_sd_bind` / `_upload` / `_apply` + `_ordinal/_bary/_scalars/_tris` pointers | barycentric surface-deform binding |
| `fe_mod_lattice_cage` / `_alloc` / `_apply` + rest/deform pointers | Bernstein FFD cage and evaluator |
| `fe_mod_armature` | heat-weighted dual-quaternion / LBS skinning |
| `fe_mod_shrinkwrap(mode, offset)` | on-surface / above-surface / outside-surface projection |
| kernels | `fe_mod_weld`, `_smooth`, `_mirror`, `_solidify`, `_displace`, `_wave`, `_cast`, `_twist`, `_array`, `_subdivide`, `_decimate` |

Return codes: `0` ok, `-1` no session, `-2` capacity exceeded, `-3` invalid
input, `-4` empty result. Any non-zero code makes the bridge fall back to the JS
reference implementation, so a modifier never silently produces garbage.

`fe_mod_begin` calls `fe_arena_reset()` first. A modifier evaluation is a single
synchronous step, so it may own the full 24 MB scratch arena while it runs.

## What runs in C++

| Modifier | Kernel behaviour |
| --- | --- |
| Weld | grid-quantised vertex merge, open-addressing hash, degenerate faces dropped |
| Smooth | weld → unique-edge Laplacian; optional Taubin (`λ`/`μ`) pass keeps volume; fixed or smooth boundary |
| Mirror | copies per enabled axis, winding reversed for odd reflections, optional weld merge |
| Solidify | two offset shells along vertex normals, rim filled from unique boundary edges |
| Displace | 1–6 octave value-noise fBm, normal or X/Y/Z direction, seed |
| Wave | radial sine along X/Y/Z with phase |
| Cast | sphere / cylinder / cuboid projection with factor, radius and size |
| Warp (twist) | Rodrigues rotation about the chosen axis |
| Array | per-copy translation + Y rotation, attribute replication |
| Subdivision | 4-1 midpoint split, welded, Loop vertex rule relaxation |
| Decimate | vertex clustering at a bisected grid resolution, optional boundary lock |
| Lattice | Bernstein free-form deformation; cage fitted to mesh bounds, rest vs deformed control points |
| Armature | smoothstep heat weights down the bone chain; dual-quaternion blend (Preserve Volume) or LBS |
| Shrinkwrap | exact nearest-triangle projection with AABB rejection; On Surface / Above Surface / Outside Surface |
| Surface Deform | nearest-triangle bind → barycentric weights + normal offset + scale ratio, re-evaluated against the live target |

Everything above is driven from `src/modifier-geometry.mjs`, which is bundled
into `modifier-engine.js`. Each exported modifier first calls
`runCppKernel(...)`; only if the core is missing, the kernel rejects the input
or the mesh carries unsupported attributes does the JS reference path run.

## Attribute contract

The session carries `position`, `normal` and `uv`. A mesh with any other
attribute (custom `tag` buffers, vertex colours, tangents) takes the JS path so
no data is dropped, and mesh groups are not preserved by the C++ path.

## Advanced settings

`modifiersData` in `index.html` carries an optional trailing
`{advanced: true}` marker per field. `renderModifierStack` collects those fields
into a collapsed **⚙ Advanced Settings** section, so the main card stays short
while every kernel parameter is still reachable. Wired settings:

- Array — Rotation Per Step
- Decimate — Preserve Boundaries
- Mirror — Merge Distance
- Solidify — Rim Fill, Even Thickness
- Cast — Size
- Displace — Direction, Octaves, Seed
- Smooth — Preserve Volume, Boundary
- Wave — Axis, Phase
- Warp — Axis

## Still JS

Bevel (hull + concave crease relaxation), Boolean (CSG solid), Triangulate
(upload-friendly non-indexed conversion), Wireframe (strut builder) and Weighted
Normal (angle-weighted corner accumulation) still run their JS implementations
and are the next kernels to move. Cloth, Soft Body, Fluid and Collision never
leave the simulation core.

The JS shrinkwrap reference now scans every triangle instead of trusting a
3-cell spatial hash. The old hash could stop at a face that was merely *near*
the query cell, so an interior vertex could snap to the wrong side of a sphere;
the C++ path always scanned exactly, and the reference now agrees with it.

## Known limits

- Subdivision uses midpoint edge placement plus the Loop vertex rule. It keeps
  flat faces flat and rounds curved ones, but it is not a full Loop limit
  surface (no 3/8–1/8 edge weights).
- Decimate uses vertex clustering above 12k triangles and the JS QEM collapse
  below that, so quality is higher on small meshes and speed is higher on large
  ones.
- The session is capped at 131,072 vertices / 262,144 triangles. Larger meshes
  take the JS path.

## Verification

- `tests/modifier-cpp.test.mjs` installs the real wasm as `FECppEngine` and
  drives every kernel through the bridge (topology, volume, uv coverage,
  volume-preserving smoothing, fallback without the core).
- `tests/modifier-geometry.test.mjs` and
  `tests/ultra-modifiers-cpp-simulation.test.mjs` keep covering the JS reference
  implementations.
- `tests/modifier-registry.test.mjs` pins the 24 modifier names and the
  Collision/Boolean contracts.
