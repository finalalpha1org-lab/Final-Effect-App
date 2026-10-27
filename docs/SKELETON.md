# Skeleton and skinning

`cpp/src/fe_skin.cpp` — the rig. Bones, a bind pose, skin weights, and the
deform that carries a mesh from one pose to the next, all in the core.

Before this file the workspace could only bend a mesh through its own bounding
box (the Armature *modifier*: bend + twist about the mesh centre). There were no
bones, no hierarchy, no bind pose and no weights, which means no character
animation — every other animation tool is built on a rig.

## Limits

| | |
| --- | --- |
| bones per rig | 256 |
| vertices per skin | 65 536 |
| influences per vertex | 4 |

Four influences is not a compromise: it is what glTF, FBX and every GPU
skinning path assume. A phone rig is far below 256 bones.

## The model

A bone is a parent index and a local TRS (`tx ty tz | qx qy qz qw | sx sy sz`),
exactly the transform a `THREE.Object3D` carries. Two of those sets exist per
bone:

* the **bind** TRS — the pose the mesh was modelled in;
* the **pose** TRS — where the bone is now.

Skinning matrices are `poseWorld × inverse(bindWorld)`. That is the whole of
skeleton animation, and it is the same algebra Blender, Maya and Unreal use.

## API

All memory lives in one lazily grown block (`fe::heap`), so a project with no
rig pays nothing. A pointer is fetched *after* `fe_skin_begin`, because growing
linear memory detaches a JavaScript typed-array view.

| Export | Meaning |
| --- | --- |
| `fe_skin_begin(bones, verts)` | reserve the block; returns the parent array or 0 |
| `fe_skin_bone_capacity()` / `fe_skin_vert_capacity()` | what the block can hold |
| `fe_skin_bind_trs_ptr()` / `fe_skin_pose_trs_ptr()` | `bones × 10` floats each |
| `fe_skin_lengths_ptr()` | `bones` floats — rest length, used for a leaf bone's tail |
| `fe_skin_rest_pos_ptr()` / `fe_skin_rest_nrm_ptr()` | `verts × 3` floats — the bind mesh |
| `fe_skin_out_pos_ptr()` / `fe_skin_out_nrm_ptr()` | `verts × 3` floats — the deformed mesh |
| `fe_skin_weights_ptr()` / `fe_skin_indices_ptr()` | `verts × 4` float / `u16` |
| `fe_skin_matrices_ptr()` | `bones × 16` skin matrices |
| `fe_skin_normal_matrices_ptr()` | `bones × 9` packed inverse-transpose |
| `fe_skin_dual_quats_ptr()` | `bones × 8` unit dual quaternions |
| `fe_skin_solve()` | rebuild every derived matrix for the current pose |
| `fe_skin_deform(mode)` | 0 = linear blend, 1 = dual quaternion |
| `fe_skin_auto_weights(falloff, influences)` | fill weights from bone distance |
| `fe_skin_set_weight(vertex, bone, weight)` | the painting path |
| `fe_skin_bind_from_pose()` | "apply rest pose" — bind the current pose |

Return codes are negative on refusal: `-1` no block, `-2` bad argument,
`-3` cyclic hierarchy, `-4` degenerate (zero-scale) bone.

## What the weights are, and are not

`fe_skin_auto_weights` measures the distance from each vertex to each bone's
**segment** (head to tail, where the tail is the child's head or the rest length
along the bone's local +Y), then weights it by `1 / (d^falloff + ε)`, keeps the
four largest, and normalises.

That is distance weighting. It is **not** bone heat: it does not solve the
diffusion equation, so a vertex equidistant from two limbs — a crotch, an
armpit — is split between them. On a shared joint that split is the correct
answer, not a bug. Painting those few vertices by hand through the weights
pointer is the supported path.

## Two deform modes, and why both exist

**Linear blend skinning** (mode 0) sums the matrices. It is what every GPU
shader does, it is a four-tap accumulate per vertex, and it collapses a joint
twisting past ~90°: two nearly opposite rotations average to a shrunken matrix,
so the surface pinches to the bone axis — the "candy wrapper" artefact.

**Dual-quaternion skinning** (mode 1) blends the rigid transform instead,
sign-correcting against the accumulator (`q` and `-q` are the same rotation;
summing without the fix cancels the pair and pulls the mesh to the origin) and
re-orthogonalising the dual part. It costs about eight more multiplies per
influence and keeps a half-turned joint on its radius.

`tests/skinning.test.mjs` demonstrates the difference rather than describing it:
one vertex, two bones 180° apart, weights 0.5 / 0.5. Linear blending leaves it at
radius 0; dual quaternions leave it at radius 1. Six other tests hold the
kinematics to three.js's own matrix stack, to hand-worked analytic rotations, and
to the weight invariants (sum 1, indices in range, dominance near the bone).

## Normals

Mode 0 transforms normals by the inverse transpose of the skin matrix (a bend
shears the surface, and a shear is exactly where reusing the rotation lights the
mesh wrong); mode 1 uses the blended rotation, which is rigid by construction.
Both renormalise.

## Measured

`65 536` vertices, four influences, including `fe_skin_solve()`: measured in
`tests/skinning.test.mjs` on the CI machine against a 40 ms budget. A phone is
several times slower, so this is a *one mesh per frame* kernel, not a crowd.

## Not done, honestly

* **No IK, no constraints, no retargeting.** Bones are posed by rotation, which
  is what the existing keyframe system already animates.
* **No facial rig** — a blend-shape path is a separate system.
* **No GPU skinning.** The deform runs on the CPU and writes into the geometry
  attributes. At 65 k vertices that is affordable; a crowd would need the shader
  path, which needs a custom material per character.
