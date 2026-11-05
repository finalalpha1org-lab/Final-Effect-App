# Faces

A mesh arrives in the editor as triangles, because that is what a GPU draws.
That is not the same thing as the faces the model has, and every part of the
editor that talks about a face - the Edit Mode cage, the selection, the Object
Mode wireframe - needs the second one.

## The problem

three.js gives a cube as twelve triangles. Six of those pairs are the six sides
of the cube, and the edge each pair shares is a diagonal that no one drew.
Blender does not show it; the wireframe of a cube has twelve edges, not
eighteen. Worse, a cylinder's cap is *one* thirty-two sided face in Blender and a
fan of thirty-two triangles around a middle vertex in the buffer, and a cone's
side is thirty-two triangles around its tip.

No shape test can recover those. A fan of coplanar triangles around a vertex is
identical to a disc that was genuinely modelled as a fan, so "these triangles
were one face" is information the buffer does not contain. The mesh library has
to say it.

## The face model

A face is a **corner ring** - three corners for a triangle, four for a quad,
n for an n-gon - plus the triangles it is made of. Two things build it, in this
order:

1. **The faces the app declared** (`fe_edit_set_faces`, and
   `geometry.userData.feFaces` for the shell). The app built the mesh, so it
   knows: `feRingAroundY` in `index.html` finds a cap's rim in angular order and
   declares it as one ring; `feFanRingsAroundY` declares the triangles of a fan
   (a cone's tip, a sphere's poles) one by one, so the pairing leaves them alone.
   A ring claims a triangle when either

   * every corner of the triangle is a corner of the ring (exact, and true of a
     face that has been bent since), or
   * the triangle lies in the ring's plane and its centroid is inside the ring -
     which is the fan a cap hides behind its middle vertex.

2. **The shape's own hints**, for everything left over: two triangles that share
   the longest edge of both, fold by less than sixty degrees, and form a convex
   quad are one face. That is `buildQuadGroups` in `cpp/src/fe_editmesh.cpp` and
   `fe-poly.js`, and the two implement the same rule on purpose: the Object Mode
   wireframe and the Edit Mode cage must agree, or a mesh changes shape the
   moment a user walks into Edit Mode.

What is left is a lone triangle - a face of its own.

## What the primitives declare

| Mesh | Faces in Edit Mode | Declared |
| --- | --- | --- |
| Cube | 6 quads | no |
| Plane | 1 quad | no |
| Grid | 64 quads | no |
| Ring | 48 quads | no |
| Torus | 512 quads | no |
| Knot | 1152 quads | no |
| Quad Sphere | 864 quads | no |
| Sphere | 960 quads + 64 pole triangles | the pole rows |
| Cylinder | 32 quads + 2 n-gons | both caps |
| Cone | 32 triangles + 1 n-gon | the tip fan and the base |

The seven undeclared ones are already right from their shape: their triangles
are paired, and the pairing agrees with the declaration the app would have made.
The three that declare are the three three.js builds from a fan.

`tests/primitives-quads.test.mjs` runs every mesh in the table through the real
wasm kernel and through `fe-poly.js` and asserts both answer the same faces.

## The wiring

* `fe_edit_set_faces(count, starts, corners)` - rings in the geometry's own
  vertex slots. The kernel welds the mesh first and maps the rings through the
  weld, so a ring may name any of the copies three.js gives a shared point.
  Declared faces are consumed once: an operation that changes the topology
  retires them, because a ring then describes vertices that may no longer
  exist.
* `fe_edit_face_count`, `fe_edit_face_start_ptr`, `fe_edit_face_ring_ptr`,
  `fe_edit_face_ring_count`, `fe_edit_ngon_count` - the table, for the shell and
  the tests.
* `fe_edit_interior_pairs_ptr`, `fe_edit_interior_pair_count` (the older names
  `fe_edit_quad_pairs_*` still answer) - the edges *inside* a face, as vertex
  pairs. These are what the wireframe hides: a quad's diagonal, the spokes of a
  cap.
* `edit-mode.js` hands the declaration over on upload (`declareFaces`) and
  writes the kernel's own table back onto the committed geometry on commit
  (`stashFaces`), which is what keeps the faces across an edit.
* `fe-poly.js` reads the same table for the Object Mode wireframe,
  the selection outline and the exports.

## Limits

* A declared face is bounded by `kMaxRingCorners` (256 corners) and the whole
  declaration by `kMaxDeclFaces` (4096) / `kMaxDeclCorners` (16384). Past that
  the kernel falls back to the shape's hints - which are right for a quad mesh,
  so a mesh too big to declare only loses its n-gons.
* The cap's middle vertex is still a vertex. Blender's cylinder has no centre
  vertex on a cap; ours does, because the GPU triangle fan needs one, and Edit
  Mode draws it in vertex mode. It is not part of any face and no wireframe line
  reaches it.
