# Edit Mode

Edit Mode edits the active object's **vertices, edges and faces** on the phone.
All topology and geometry work runs in the C++20 kernel
(`cpp/src/fe_editmesh.cpp`, `cpp/src/fe_editmesh_tools.cpp`); `edit-mode.js` is a
bridge plus a touch UI, and it decides nothing about the mesh.

Nothing in the interface names the engine, the compiler or WebAssembly.

## Entry points: the Edit tool is not Edit Mode

They are two different things and stay that way.

* **✏️ Edit** — the tool in the main bar of the 3D Workspace. It opens the
  object bar (Move, Rotate, Scale, Transform, Annotate, Measure, 3D Cursor,
  Delete) exactly as before. It does not touch the mode dropdown and does not
  enter Edit Mode.
* **Edit Mode** — chosen on the mode dropdown (`Object Mode → Edit Mode`). The
  studio's normal main toolbar steps aside, a new main toolbar appears in the
  same place, and choosing one of its entries opens that category's
  sub-toolbar in the sheet above it.

Leaving is the same in reverse: `Done` on the bar, the dropdown, or leaving the
3D Workspace all put the mode dropdown back to `Object Mode`.

## What the mode does

| Area | Tools |
| --- | --- |
| Select | Tap, box, circle, all, none, invert, linked, expand, shrink, similar, random, edge loop |
| Transform | Move, rotate, scale (one-finger drag), shrink/fatten, slide, shear, to-sphere, bend, randomize, align, mirror, exact numeric entry |
| Mesh | Extrude, inset, subdivide, bevel, poke, duplicate, split, fill, bridge, merge, weld, collapse, bisect, symmetrize, delete |
| Shading | Recalculate outside, flip faces, shade smooth, shade flat, mark sharp, mark seam |

Selection is stored **on vertices only**. Edge and face selection are derived from
it, so the three modes can never disagree after an operation. A face counts as
selected only when all three of its corners are selected.

Every mutating tool pushes one undo snapshot before it changes anything, and a
tool that turns out to change nothing removes its own snapshot again, so the undo
button never "does nothing" once.

## The UI is this app's own

The bottom toolbar stops being the object toolbar and becomes a **left-to-right
bar of four categories** — Select, Transform, Mesh, Shading — followed by the
vertex/edge/face switch, undo/redo, see-through, snap and Done. Tapping a
category opens **its own sub-toolbar** in a scrollable sheet directly above the
bar, in the same sheet language as every other panel in the app: a header with
live counts, a grid of tools with SVG icons, the amount slider for the current
tool, the axis lock, proportional editing and one line of help.

The sheet is a bottom sheet in portrait and docks to the right edge in landscape,
exactly like the camera and light sheets.

## Touch rules

- **Select** does not capture the drag: a tap picks, a swipe still orbits. That
  keeps the viewport usable in the mode people spend most time in.
- **Box**, **Circle**, **Move**, **Rotate** and **Scale** do capture the drag;
  a second finger is left to the orbit controls.
- A refused drag (for example Move with nothing selected) is not captured at all
  and falls through to orbiting.

## The viewport geometry

Inside the mode the object draws the kernel's **render mesh**: positions,
normals, colours and indices from `fe_edit_build_render`. That mesh splits
vertices on sharp edges, so it is the shaded surface a render or an export will
produce.

Leaving the mode writes the **canonical mesh** back into the object — one shared
vertex per corner, the kernel's triangles, its vertex colours — and rebuilds the
geometry, so the exporter, the physics bridge and the scene registry all see the
edit.

Flat shading is a material property, not extra geometry: the kernel keeps the
indexed mesh and the bridge sets `material.flatShading` from
`fe_edit_get_shade()`.

## Kernel ABI

Lifecycle and readback:

```
fe_edit_reset            fe_edit_upload(vc, pos, tc, idx, colors)
fe_edit_vert_count       fe_edit_tri_count        fe_edit_edge_count
fe_edit_max_verts        fe_edit_has_color
fe_edit_pos_interleaved_ptr   fe_edit_color_interleaved_ptr
fe_edit_idx_ptr          fe_edit_edge_ptr         fe_edit_edge_b_ptr
fe_edit_edge_face_ptr    fe_edit_edge_sel_ptr     fe_edit_vert_sel_ptr
fe_edit_face_sel_ptr     fe_edit_stats_ptr        fe_edit_bounds_ptr
```

Selection (`kind`: 0 vertex, 1 edge, 2 face; `op`: 0 replace, 1 add, 2 subtract,
3 toggle):

```
fe_edit_set_mode   fe_edit_get_mode   fe_edit_select_all   fe_edit_select_none
fe_edit_select_invert   fe_edit_sel_count   fe_edit_select_by_index
fe_edit_select_linked   fe_edit_select_more   fe_edit_select_less
fe_edit_select_similar  fe_edit_select_random
fe_edit_select_box(clip, x0, y0, x1, y1, op, xray)
fe_edit_select_circle(clip, cx, cy, radius, op, xray, aspect)
fe_edit_pick(clip, cx, cy)
fe_edit_select_loop(seedEdge)
```

Screen-space selectors take **normalised** coordinates: `(0,0)` is the top-left
of the viewport, `(1,1)` the bottom-right. `clip` is a column-major
projection × view × model matrix, the same array `THREE.Matrix4.elements`
provides. The circle takes the viewport's width/height ratio so a circle dragged
on a portrait phone selects a circle, not an ellipse.

Transforms (`axis`: 0 all, 1 X, 2 Y, 3 Z, 4 XY, 5 YZ, 6 XZ):

```
fe_edit_move(dx, dy, dz, axis)      fe_edit_rotate(angleDeg, axis)
fe_edit_scale(sx, sy, sz, axis)     fe_edit_shrink_fatten(amount)
fe_edit_shear(amount, axis, dir)    fe_edit_to_sphere(factor)
fe_edit_bend(angleDeg, axis)        fe_edit_randomize(amount, seed)
fe_edit_align(axis)                 fe_edit_mirror(axis, merge)
fe_edit_slide(amount)
fe_edit_set_proportional(enabled, falloff, radius, connected)
fe_edit_set_pivot(mode, x, y, z)    fe_edit_set_snap(mode, increment)
```

Topology:

```
fe_edit_extrude(distance, individual)   fe_edit_inset(thickness, individual)
fe_edit_subdivide(mode, smooth)         fe_edit_bevel(width, aroundVertices)
fe_edit_poke        fe_edit_duplicate        fe_edit_split
fe_edit_fill        fe_edit_bridge
fe_edit_merge_center                     fe_edit_merge_distance(threshold)
fe_edit_collapse    fe_edit_delete(kind)
fe_edit_bisect(px,py,pz, nx,ny,nz, keepPositive, fillCut, clearOther)
fe_edit_symmetrize(axis)
```

Shading and history:

```
fe_edit_set_shade   fe_edit_get_shade   fe_edit_mark_sharp   fe_edit_mark_seam
fe_edit_sharp_count fe_edit_seam_count  fe_edit_recalc_normals(outside)
fe_edit_flip_normals
fe_edit_undo_push   fe_edit_undo   fe_edit_redo
fe_edit_undo_depth  fe_edit_redo_depth   fe_edit_undo_clear
```

## Limits

- 16 384 vertices, 32 768 triangles, 65 536 edges. A larger mesh is refused by
  `fe_edit_upload` (return 0) and the UI says so instead of truncating the model.
- 48 undo steps, in a 6 MB byte pool that compacts when full.
- One selection mode at a time; the selection survives a topology change only
  where the vertices survive it.

## What is not here, on purpose

- **N-gon dissolve / triangulate.** The kernel stores triangles. Dissolving an
  edge of two coplanar triangles and re-splitting the result along a different
  diagonal is visually identical and topologically pointless, so the mesh tools
  offer *collapse* and *weld* instead of pretending to have polygons.
- **Multi-segment bevel.** Bevel is one chamfer segment. Segments would need a
  ring of parallel edge loops that a triangle mesh cannot express without a
  half-edge structure.
- **Edge loops where the topology has none.** Edge Loop Select walks through
  valence-4 vertices; on a triangulated cube it correctly selects nothing rather
  than inventing a loop.
- **UV unwrap, vertex groups, weight paint.** Those are Object Mode features, not
  mesh editing, and are not wired to this kernel yet.

## Tests

- `cpp/tests/fe_editmesh_tests.cpp` — native suite over the kernel (topology
  invariants, volume preservation, undo/redo, render-mesh splitting, picking),
  built by `tests/cpp-editmesh.test.mjs` and by CMake/ctest.
- `tests/cpp-editmesh.test.mjs` — the same kernel through the shipped
  `wasm/fe_core_engine.wasm`, plus a check that every tool in the UI maps to a
  real export and to a real icon.
- `tests/edit-mode-bridge.test.mjs` — drives `edit-mode.js` against the real
  kernel with a stub three.js: upload, tool calls, geometry write-back, flat
  shading, undo, and the canonical mesh coming back on exit.
