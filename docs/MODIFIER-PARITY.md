# Modifier settings parity

Every modifier in the app is measured against the properties that
`source/blender/makesrna/intern/rna_modifier.cc` defines for it. This page is
the audit: what is carried today, what is not, and — for each missing entry —
whether it is real work still to do, or a property whose data model does not
exist on this pipeline yet.

The kernels live in `cpp/src/fe_modifiers.cpp`; the panel fields are in the
`modifiersData` registry in `index.html`; the JavaScript that binds them is
`src/modifier-geometry.mjs`. A property listed as **carried** is read from the
panel, handed to a kernel, and changes the geometry — not merely displayed.

Legend:

| Mark | Meaning |
| --- | --- |
| ✅ | Carried: panel value reaches the kernel and changes the result. |
| 🟡 | Carried, but the underlying data is a stand-in (see the note). |
| ⛔ | Missing because the app has no such data model yet. |
| ❌ | Missing, and it is real work — no data-model blocker. |
| ◻︎ | Has no effect on this pipeline: the geometry it would act on cannot occur. |

The data-model blockers, once, so the tables can just say which one applies:

- **V** — vertex groups. There is no named-weight layer, no object-level group
  list, and no UI to paint or inspect weights.
- **M** — per-face material index / material slots.
- **E** — per-edge flags (seam, sharp, crease, bevel weight) and per-corner
  (loop) UVs; this pipeline has one UV and no edge attributes.
- **O** — object / collection / curve slots beyond the single operand object
  that Boolean, Lattice, Shrinkwrap, Surface Deform and Armature already use.
- **A** — custom normals (harden normals, weighted normal modes, normal edit).

## Generate

### Array — `MOD_array.cc`
✅ `fit_type`, `count`, `fit_length`, `use_constant_offset`,
`constant_offset_displace`, `use_relative_offset`, `relative_offset_displace`,
`use_merge_vertices`, `merge_threshold`, `use_object_offset`, `offset_object`,
`offset_u`, `offset_v`.

⛔ `curve` (O), `start_cap` / `end_cap` / `use_merge_vertices_cap` (O: each cap
is a second mesh merged into the result, which needs a multi-mesh kernel),
`vertex_group` (V).

### Bevel — `bmesh_bevel.cc`
✅ `width`, `segments`, `limit_method` (None / Angle), `angle_limit`,
`use_clamp_overlap`, `offset_type`, `profile`.

❌ `affect` (vertex-only bevel), `miter_outer`, `miter_inner`, `spread`,
`profile_type` (Superellipse needs Blender's superellipse parameterisation),
`loop_slide`, `width_pct`, `use_quality_normals`.

⛔ `edge_weight`, `vertex_weight` (E), `vertex_group` (V), `material` (M),
`mark_seam`, `mark_sharp`, `face_strength_mode` (E), `harden_normals` (A),
`custom_profile` (a curve widget with no equivalent), `vmesh_method` (needs
vertex bevel first).

### Boolean — `MOD_boolean.cc`
✅ `object`, `operation` (Difference / Union / Intersection).

❌ `operand_type` (collection operands), `double_threshold` (the kernel's cut
is exact, so there is no near-coincident pair for it to widen), `use_self`
(self-intersection solve), `use_hole_tolerant`, `solver` (Exact / Fast).

⛔ `collection` (O), `material_mode` (M).

### Build — `MOD_build.cc`
🟡 `use_reverse`, `use_random_order`, `seed`. Upstream's `frame_start` and
`frame_duration` are replaced by a single Progress slider, because this stack
is evaluated on demand rather than per frame — the same `frac` from the other
end. The shuffle uses splitmix64 seeded like `BLI_array_randomize`, not
bit-identical to it.

### Decimate — `bmesh_decimate_collapse.cc`, `_unsubdivide.cc`, `_dissolve.cc`
✅ `decimate_type` (Collapse / Un-Subdivide / Planar), `ratio`, `iterations`,
`angle_limit`, `use_symmetry` + `symmetry_axis`.

The symmetry pass is upstream's own design now: `bm_edge_symmetry_map()` pairs
every vertex with its mirror across the axis, and the collapse loop collapses
the twin edges together at mirrored targets.

✅ `use_dissolve_boundaries` (All Boundaries): the straight runs of a border
are joined, so a flat grid's outer rectangle keeps its four corners and loses
the vertices the tessellation put between them.

❌ `delimit`: NORMAL is the angle test already, and the other choices (UV,
SEAM, SHARP, MATERIAL) need E and M.

⛔ `vertex_group`, `vertex_group_factor`, `invert_vertex_group` (V).
◻︎ `use_collapse_triangulate` — the pipeline is triangles in and triangles out,
so there is never a face for it to triangulate. `face_count` is display-only in
Blender and is not a setting here.

### Mirror — `MOD_mirror.cc`
✅ `use_axis`, `use_bisect_axis`, `use_bisect_flip_axis`, `use_clip`,
`merge_threshold`, `use_mirror_u`, `use_mirror_v`, `use_mirror_udim`,
`mirror_offset_u`, `mirror_offset_v`.

🟡 `use_mirror_merge`: the merge distance is carried, but the merge always
runs — the toggle that would turn it off is not exposed.

⛔ `use_mirror_vertex_groups` (V), `mirror_object` (O).

### Screw — `MOD_screw.cc`
✅ `steps`, `iterations`, `axis`, `angle`, `screw_offset`,
`use_merge_vertices`, `merge_threshold`, `use_normal_flip`.

❌ `use_normal_calculate`, `use_smooth_shade`.

⛔ `object` / `use_object_screw_offset` (O), `use_stretch_u` / `use_stretch_v`
(needs per-loop UVs, E).

### Solidify — `MOD_solidify.cc` / `MOD_solidify_extrude.cc`
✅ `thickness`, `offset`, `use_rim`, `use_even_offset`, `use_flip_normals`,
`use_rim_only`, `thickness_clamp`, `use_thickness_angle_clamp`.

Both clamp branches are upstream's: the edge-length form, and the
half-dihedral form gated behind the angle clamp.

❌ `solidify_mode` (Complex / non-manifold mode), `use_quality_normals`.

⛔ `thickness_vertex_group`, `shell_vertex_group`, `rim_vertex_group` (V),
`material_offset`, `material_offset_rim` (M), `edge_crease_*` (E),
`use_flat_faces` (needs the modifier's own normals policy, A).

### Edge Split — `MOD_edgesplit.cc`
✅ `split_angle`, `use_edge_angle`.

⛔ `use_edge_sharp` (E: the toggle reaches the kernel, but no edge in this
pipeline carries a sharp flag, so there is nothing for it to find).

### Subdivision Surface — `MOD_subsurf.cc`
🟡 `levels`, `subdivision_type` (Catmull-Clark / Simple) through
`fe_mod_subdivide()`. Blender's own implementation is OpenSubdiv and cannot be
dropped into a freestanding wasm module; this is the same limit-surface
arithmetic without the adaptive/GPU paths.

⛔ `use_creases` (E), `use_custom_normals` (A).

### Triangulate — `MOD_triangulate.cc`
✅ `quad_method`, `ngon_method`, `min_vertices`, `keep_custom_normals`
(as Keep Normals).

### Weld — `MOD_weld.cc`
✅ `mode` (All / Connected), `merge_threshold`.

✅ `vertex_group` + `invert_vertex_group`. The selection is membership, not
weight - `(weight > 0) != invert`, upstream's
`selection_array_from_vertex_group()` - so inverting picks the vertices that
are *not* in the group. In All mode the unselected vertices never enter the
KD-tree (they keep their own slot); in Connected mode an edge with an end
outside the selection does not collapse (tested on the cluster roots).

⛔ `loose_edges` (E: the flag only ever collapses edges that belong to no
face, and this pipeline's meshes are triangle soups - there are no such
edges to collapse, so the toggle would be dead).

### Wireframe — `bmesh_wireframe.cc`
✅ `thickness`, `offset`, `use_replace`, `use_boundary`, `use_even_offset`,
`use_relative_offset`.

⛔ `thickness_vertex_group`, `vertex_group` (V), `use_crease`, `crease_weight`
(E), `material_offset` (M).

## Deform

### Cast — `MOD_cast.cc`
✅ `cast_type`, `factor`, `radius`, `size`, `vertex_group` + `invert_vertex_group`.

❌ `use_radius_as_size`, `use_transform`, `use_x` / `use_y` / `use_z`
(this app has one Cast shape, not three axes).

⛔ `object` (O).

### Displace — `MOD_displace.cc`
🟡 `strength`, `mid_level`, `direction`; the texture input is a procedural
value-noise field (`frequency`, `octaves`, `seed`) instead of a texture
datablock.

✅ `vertex_group` + `invert_vertex_group` (weight zero skips the vertex
entirely, as `MOD_displace.cc` does).

⛔ `texture_coords` / `uv_layer` (E), `space` (needs an object or bone frame, O).

### Lattice — `MOD_lattice.cc`
✅ `object`, `strength`, and the U/V/W cage resolution.

⛔ `vertex_group` (V).

### Laplacian Smooth — `MOD_laplaciansmooth.cc`
✅ `iterations`, `lambda_factor`, `lambda_border`, `use_volume_preserve`,
`use_normalized`, `use_x`, `use_y`, `use_z`.

✅ `vertex_group` + `invert_vertex_group`: `wpaint` scales every entry of the
vertex's row (`-|lambda| * wpaint / w`, `-|lambda_border| * wpaint * 2 / w`)
and the diagonal (`1 + |lambda| * wpaint`). A zero weight makes the row the
identity, and the vertex is pinned.

### Simple Deform — `MOD_simpledeform.cc`
✅ `deform_method`, `deform_axis`, `angle`, `factor`, `limits`,
`lock_x`, `lock_y`, `lock_z`.

✅ `vertex_group` + `invert_vertex_group`: `simple_helper()` ends with
`interp_v3_v3v3(vertexCos, vertexCos, co, weight)`, so the weight blends the
vertex between where it was and where the deform puts it.

⛔ `origin` (O).

### Shrinkwrap — `MOD_shrinkwrap.cc`
✅ `wrap_method`, `wrap_mode`, `target`, `offset`.

❌ `project_limit`, `subsurf_levels`, `use_project_x/y/z`,
`use_negative_direction`, `use_positive_direction`, `use_invert_cull`.

⛔ `vertex_group` (V), `auxiliary_target` (O).

### Smooth — `MOD_smooth.cc`
✅ `factor`, `iterations`, boundary handling as a Smooth / Fixed choice.

✅ `vertex_group` + `invert_vertex_group`: `f_new = f_vgroup * fac`, and a
vertex with `f_vgroup <= 0` is skipped. The kernel welds the triangle soup
first so the smoothing has real neighbours, and the weights are carried
through that remap.

### Surface Deform — `MOD_surfacedeform.cc`
✅ `target`, `strength`, `is_bound` (Bind button).

⛔ `vertex_group` (V), `falloff` (O).

### Armature — `MOD_armature.cc`
✅ `object`, `use_deform_preserve_volume`; the bend/twist sliders are this
app's own rig control, not RNA.

⛔ `use_vertex_groups`, `use_bone_envelopes`, `vertex_group` (V/O: bone
deform groups).

### Wave — `MOD_wave.cc`
✅ `speed`, `height`, `width`, `narrowness`, `falloff`, `time_offset`,
`lifetime`, `damping_time`, `use_cyclic`, `use_normal`, `start_position_x`,
`start_position_y`. The kernel is `waveModifier_do` transcribed: the phase is
`amplit - (ctime - timeoffs) * speed` (distance from the start point along the
plane axis, or the radius for `MOD_WAVE_X | MOD_WAVE_Y`), the profile is
`1/exp((amplit*narrow)^2) - minfac` with `minfac = 1/exp((width*narrow)^2)`,
the band is `|amplit| < width`, cyclic wraps with `fmodf` (sign of the
dividend, not floor-modulo), and a wave older than `lifetime` decays as
`height * (1 - sqrt(x / damping))`. `use_normal` moves along the vertex normal
instead of local Z; without it the vertex moves on Z for every plane, exactly
as upstream.

✅ `vertex_group` + `invert_vertex_group` (`invert ? 1 - w : w`, zero skips).

✅ The deform plane: X, Y, or the X|Y radial circle mode. This app keeps one
Wave axis instead of upstream's three per-axis flags, so `use_normal_x/y/z`
collapse to one `use_normal`.

✅ `object` (`objectcenter`): the picker's location, converted into the
modified object's local space with `invert_m4_m4` + `mul_m4_m4m4` as upstream
does, replaces `startx` / `starty`.

⛔ `texture` / `texture_coords` / `texture_name` (T).

## Normals

### Weighted Normal — `MOD_weighted_normal.cc`
✅ `weight`, `keep_sharp`.

❌ `mode`, `thresh`.

⛔ `vertex_group` (V), `use_face_influence` (M).

## Modifier types not in the app

These have no entry at all yet: **Curve**, **Explode**, **Hook**,
**Mesh Cache**, **Mesh Deform**, **Multiresolution**, **Normal Edit**, **Ocean**,
**Particle Instance**, **Skin**, **Smooth Corrective**, **Vertex Weight Edit /
Mix / Proximity**, **Warp** (an app-side stand-in exists), and the physics
modifiers (Cloth, Collision, Fluid, Soft Body, Dynamic Paint) whose panels are
present but whose solvers are separate work.

## What this means in practice

Every property marked ⛔ is blocked by one of the remaining data models, not by
the kernels. **Vertex groups are open**: Solidify, Wireframe, Displace, Wave,
Cast, Decimate, Weld, Smooth, Laplacian Smooth and Simple Deform read them
today; Bevel is the next kernel with an argument to grow.
Next in line, **per-edge flags and per-corner UVs** unlock the delimit / crease
/ seam family, and **per-face material indices** unlock the material offset
family.
