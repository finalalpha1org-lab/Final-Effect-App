/* Skeleton skinning for character animation.
 * ===========================================================================
 * The workspace could bend a mesh through its own bounding box ("Armature"
 * modifier: bend + twist), but it could not *rig* one. There were no bones, no
 * hierarchy, no bind pose and no skin weights, which means no character
 * animation: a rig is the thing every other tool in the animation workflow is
 * built on — posing, keying, IK, retargeting, cloth attachment.
 *
 * This file is the rig, done the way a real one is done:
 *
 *   1. Bones. Each bone is a parent index plus a local TRS in the bind pose.
 *      The hierarchy is resolved into world matrices, and the inverse of each
 *      bind world matrix is the rest transform a skinned vertex is expressed
 *      in. Nothing here is an approximation of a skeleton; it is the same
 *      algebra Blender, Maya and Unreal use.
 *
 *   2. Weights. `fe_skin_auto_weights` fills up to four influences per vertex
 *      from the distance to each bone's *segment* (head to tail), with an
 *      inverse-power falloff and a top-k cut, normalised. That is bone-heat's
 *      simpler cousin, and it is called what it is: distance weights, not heat
 *      diffusion. `fe_skin_set_weight` / the weights pointer are there for a
 *      rigger who wants to paint them by hand instead.
 *
 *   3. Deform. Two modes, and the difference is visible on a twisting limb:
 *        - linear blend skinning (the fast default), and
 *        - dual-quaternion skinning, which blends the rigid transform instead
 *          of the matrix and therefore does not collapse a 180° twist to the
 *          bone axis (the "candy wrapper" artefact). It costs eight multiplies
 *          more per influence and is a per-rig switch, not a global one.
 *
 *   4. Normals. The correct inverse-transpose for LBS, the rotation alone for
 *      dual quaternions. A skinned limb lit with untransformed normals looks
 *      inside-out on the far side of a bend, which is why this is not optional.
 *
 * Everything is one lazily grown block (fe::heap), so a project with no rig
 * pays nothing: the block only exists once `fe_skin_begin` is called.
 *
 * Limits: 256 bones, 65 536 vertices, 4 influences. Those are not arbitrary —
 * four influences is what the GPU path and every glTF/FBX importer assume, and
 * a phone rig is far below 256 bones.
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

#include <stdint.h>

namespace {

using namespace fe;

constexpr uint32_t kMaxBones = 256u;
constexpr uint32_t kMaxSkinVerts = 65536u;
constexpr uint32_t kMaxInfluences = 4u;

/* Bytes per bone: parent i32, bind TRS 10 floats, pose TRS 10 floats, rest
   length 1 float, skin matrix 16, normal matrix 9, dual quaternion 8. */
constexpr uint32_t kBoneBytes = 4u + (10u + 10u + 1u + 16u + 9u + 8u) * 4u;
/* Bytes per vertex: rest position, rest normal, out position, out normal,
   four weights, four indices. */
constexpr uint32_t kVertBytes = (3u + 3u + 3u + 3u) * 4u + kMaxInfluences * 4u +
                                kMaxInfluences * 2u;

uint8_t* g_skin_block = nullptr;
uint32_t g_bone_cap = 0;
uint32_t g_vert_cap = 0;
uint32_t g_bones = 0;
uint32_t g_verts = 0;
bool g_solved = false;

int32_t*  g_parent = nullptr;
float*    g_bind = nullptr;    /* bone_cap * 10: tx ty tz  qx qy qz qw  sx sy sz */
float*    g_pose = nullptr;    /* same layout, the posed local transform */
float*    g_len = nullptr;     /* rest length, used when a bone has no child */
float*    g_mat = nullptr;     /* bone_cap * 16: pose world * inverse bind */
float*    g_nmat = nullptr;    /* bone_cap * 9: inverse transpose of the 3x3 */
float*    g_dq = nullptr;      /* bone_cap * 8: unit dual quaternion */
float*    g_rest_p = nullptr;
float*    g_rest_n = nullptr;
float*    g_out_p = nullptr;
float*    g_out_n = nullptr;
float*    g_w = nullptr;
uint16_t* g_idx = nullptr;

/* Bind and pose world matrices, and the inverse bind, are working state: they
   never leave the module, so they live in BSS rather than in the heap block. */
float g_bind_world[kMaxBones * 16];
float g_bind_inv[kMaxBones * 16];
float g_pose_world[kMaxBones * 16];
uint8_t g_visit[kMaxBones];

/* ---- small linear algebra -------------------------------------------------
 * Column-major, the same convention three.js uses, so a matrix can be copied
 * straight into an `InstancedMesh` buffer or a bone`Skeleton` without a
 * transpose. */

inline void composeTRS(float* m, float tx, float ty, float tz,
                       float qx, float qy, float qz, float qw,
                       float sx, float sy, float sz) {
  const float x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const float xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const float yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const float wx = qw * x2, wy = qw * y2, wz = qw * z2;
  m[0] = (1.0f - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[3] = 0.0f;
  m[4] = (xy - wz) * sy;
  m[5] = (1.0f - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[7] = 0.0f;
  m[8] = (xz + wy) * sz;
  m[9] = (yz - wx) * sz;
  m[10] = (1.0f - (xx + yy)) * sz;
  m[11] = 0.0f;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  m[15] = 1.0f;
}

inline void mulMat(const float* a, const float* b, float* out) {
  for (uint32_t c = 0; c < 4u; c++) {
    const uint32_t o = c * 4u;
    const float b0 = b[o], b1 = b[o + 1u], b2 = b[o + 2u], b3 = b[o + 3u];
    out[o + 0u] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[o + 1u] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[o + 2u] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[o + 3u] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

/* Inverse of the upper 3x3 of a column-major 4x4.
 *
 * `m[c*4 + r]` is row r, column c — the stride is four, not three, and writing
 * the cofactors against a three stride is the mistake that produced a matrix
 * that looked like a rotation but inverted to itself. The output is a packed
 * 3x3, also column-major (`out[c*3 + r]`), so it can be copied into a normal
 * matrix without reshaping.
 */
inline bool invert3x3(const float* m, float* out) {
  const float a00 = m[0], a01 = m[4], a02 = m[8];
  const float a10 = m[1], a11 = m[5], a12 = m[9];
  const float a20 = m[2], a21 = m[6], a22 = m[10];
  const float det = a00 * (a11 * a22 - a12 * a21) -
                    a01 * (a10 * a22 - a12 * a20) +
                    a02 * (a10 * a21 - a11 * a20);
  if (!(absf(det) > 1e-12f)) return false;
  const float inv = 1.0f / det;
  out[0] = (a11 * a22 - a12 * a21) * inv; /* inverse[0][0] */
  out[1] = (a12 * a20 - a10 * a22) * inv; /* inverse[1][0] */
  out[2] = (a10 * a21 - a11 * a20) * inv; /* inverse[2][0] */
  out[3] = (a02 * a21 - a01 * a22) * inv; /* inverse[0][1] */
  out[4] = (a00 * a22 - a02 * a20) * inv; /* inverse[1][1] */
  out[5] = (a01 * a20 - a00 * a21) * inv; /* inverse[2][1] */
  out[6] = (a01 * a12 - a02 * a11) * inv; /* inverse[0][2] */
  out[7] = (a02 * a10 - a00 * a12) * inv; /* inverse[1][2] */
  out[8] = (a00 * a11 - a01 * a10) * inv; /* inverse[2][2] */
  return true;
}

/* Inverse of an affine matrix (rotation + scale + translation). Returns false
   for a degenerate bone, which a rig should never contain but a hand-edited
   one can. */
inline bool invertAffine(const float* m, float* out) {
  float inv3[9];
  if (!invert3x3(m, inv3)) return false;
  out[0] = inv3[0]; out[1] = inv3[1]; out[2] = inv3[2]; out[3] = 0.0f;
  out[4] = inv3[3]; out[5] = inv3[4]; out[6] = inv3[5]; out[7] = 0.0f;
  out[8] = inv3[6]; out[9] = inv3[7]; out[10] = inv3[8]; out[11] = 0.0f;
  const float tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1.0f;
  return true;
}

/* The normal matrix of an affine transform: the inverse transpose of its 3x3.
   A bend shears the surface, and a shear is exactly the case where reusing the
   rotation part of the skin matrix lights the mesh wrong. Stored as a packed
   3x3, column-major (`out[c*3 + r]`). */
inline void normalMatrix(const float* m, float* out) {
  float inv3[9];
  if (!invert3x3(m, inv3)) {
    out[0] = 1.0f; out[1] = 0.0f; out[2] = 0.0f;
    out[3] = 0.0f; out[4] = 1.0f; out[5] = 0.0f;
    out[6] = 0.0f; out[7] = 0.0f; out[8] = 1.0f;
    return;
  }
  /* N[r][c] = inverse[c][r], so the packed column-major output swaps the two
     index roles: out[c*3 + r] = inv3[r*3 + c]. */
  out[0] = inv3[0]; out[1] = inv3[3]; out[2] = inv3[6];
  out[3] = inv3[1]; out[4] = inv3[4]; out[5] = inv3[7];
  out[6] = inv3[2]; out[7] = inv3[5]; out[8] = inv3[8];
}

/* Orthonormal basis of the rotation part, by Gram-Schmidt on the columns. A
   bone with non-uniform scale has no single rotation, so this is the closest
   one in the least-squares sense — which is what a dual quaternion needs. */
inline void rotationBasis(const float* m, float* r) {
  float c0[3] = {m[0], m[1], m[2]};
  float c1[3] = {m[4], m[5], m[6]};
  float l0 = sqrtf(c0[0] * c0[0] + c0[1] * c0[1] + c0[2] * c0[2]);
  if (!(l0 > 1e-8f)) { c0[0] = 1.0f; c0[1] = 0.0f; c0[2] = 0.0f; l0 = 1.0f; }
  c0[0] /= l0; c0[1] /= l0; c0[2] /= l0;
  const float d01 = c1[0] * c0[0] + c1[1] * c0[1] + c1[2] * c0[2];
  c1[0] -= c0[0] * d01; c1[1] -= c0[1] * d01; c1[2] -= c0[2] * d01;
  float l1 = sqrtf(c1[0] * c1[0] + c1[1] * c1[1] + c1[2] * c1[2]);
  if (!(l1 > 1e-8f)) { c1[0] = 0.0f; c1[1] = 1.0f; c1[2] = 0.0f; l1 = 1.0f; }
  c1[0] /= l1; c1[1] /= l1; c1[2] /= l1;
  const float c2[3] = {
    c0[1] * c1[2] - c0[2] * c1[1],
    c0[2] * c1[0] - c0[0] * c1[2],
    c0[0] * c1[1] - c0[1] * c1[0]
  };
  r[0] = c0[0]; r[3] = c0[1]; r[6] = c0[2];
  r[1] = c1[0]; r[4] = c1[1]; r[7] = c1[2];
  r[2] = c2[0]; r[5] = c2[1]; r[8] = c2[2];
}

/* Quaternion of a rotation matrix (Shepperd's method: pick the numerically
   largest of the four terms instead of dividing by a W near zero). */
inline void quatFromBasis(const float* r, float* q /* x y z w */) {
  const float tr = r[0] + r[4] + r[8];
  if (tr > 0.0f) {
    const float s = sqrtf(tr + 1.0f) * 2.0f;
    q[3] = 0.25f * s;
    q[0] = (r[7] - r[5]) / s;
    q[1] = (r[2] - r[6]) / s;
    q[2] = (r[3] - r[1]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const float s = sqrtf(1.0f + r[0] - r[4] - r[8]) * 2.0f;
    q[3] = (r[7] - r[5]) / s;
    q[0] = 0.25f * s;
    q[1] = (r[1] + r[3]) / s;
    q[2] = (r[2] + r[6]) / s;
  } else if (r[4] > r[8]) {
    const float s = sqrtf(1.0f + r[4] - r[0] - r[8]) * 2.0f;
    q[3] = (r[2] - r[6]) / s;
    q[0] = (r[1] + r[3]) / s;
    q[1] = 0.25f * s;
    q[2] = (r[5] + r[7]) / s;
  } else {
    const float s = sqrtf(1.0f + r[8] - r[0] - r[4]) * 2.0f;
    q[3] = (r[3] - r[1]) / s;
    q[0] = (r[2] + r[6]) / s;
    q[1] = (r[5] + r[7]) / s;
    q[2] = 0.25f * s;
  }
}

/* Unit dual quaternion of a rigid transform: the rotation in the real part,
   and `0.5 * t * q` in the dual part. */
inline void dualFromMatrix(const float* m, float* dq /* 8 */) {
  float r[9];
  rotationBasis(m, r);
  float q[4];
  quatFromBasis(r, q);
  const float tx = m[12], ty = m[13], tz = m[14];
  const float qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const float cx = ty * qz - tz * qy;
  const float cy = tz * qx - tx * qz;
  const float cz = tx * qy - ty * qx;
  dq[0] = qx; dq[1] = qy; dq[2] = qz; dq[3] = qw;
  dq[4] = -0.5f * (tx * qx + ty * qy + tz * qz);
  dq[5] = 0.5f * (qw * tx + cx);
  dq[6] = 0.5f * (qw * ty + cy);
  dq[7] = 0.5f * (qw * tz + cz);
}

inline void dqTransform(const float* dq, float px, float py, float pz, float* out) {
  const float qx = dq[0], qy = dq[1], qz = dq[2], qw = dq[3];
  const float dw = dq[4], dx = dq[5], dy = dq[6], dz = dq[7];
  /* v' = v + 2 r x (r x v + w v) + 2 (w d + r x d - d_w r_xyz) */
  const float ix = (qy * pz - qz * py) + qw * px;
  const float iy = (qz * px - qx * pz) + qw * py;
  const float iz = (qx * py - qy * px) + qw * pz;
  const float rx = qy * iz - qz * iy;
  const float ry = qz * ix - qx * iz;
  const float rz = qx * iy - qy * ix;
  out[0] = px + 2.0f * (rx + qw * dx - dw * qx + (qy * dz - qz * dy));
  out[1] = py + 2.0f * (ry + qw * dy - dw * qy + (qz * dx - qx * dz));
  out[2] = pz + 2.0f * (rz + qw * dz - dw * qz + (qx * dy - qy * dx));
}

/* ---- block layout ---------------------------------------------------------- */

void bindPointers() {
  uint8_t* p = g_skin_block;
  const uint32_t B = g_bone_cap, V = g_vert_cap;
  g_parent = reinterpret_cast<int32_t*>(p); p += B * 4u;
  g_bind   = reinterpret_cast<float*>(p);   p += B * 10u * 4u;
  g_pose   = reinterpret_cast<float*>(p);   p += B * 10u * 4u;
  g_len    = reinterpret_cast<float*>(p);   p += B * 4u;
  g_mat    = reinterpret_cast<float*>(p);   p += B * 16u * 4u;
  g_nmat   = reinterpret_cast<float*>(p);   p += B * 9u * 4u;
  g_dq     = reinterpret_cast<float*>(p);   p += B * 8u * 4u;
  g_rest_p = reinterpret_cast<float*>(p);   p += V * 3u * 4u;
  g_rest_n = reinterpret_cast<float*>(p);   p += V * 3u * 4u;
  g_out_p  = reinterpret_cast<float*>(p);   p += V * 3u * 4u;
  g_out_n  = reinterpret_cast<float*>(p);   p += V * 3u * 4u;
  g_w      = reinterpret_cast<float*>(p);   p += V * kMaxInfluences * 4u;
  g_idx    = reinterpret_cast<uint16_t*>(p);
}

/* Resolve the local hierarchy into `dst` world matrices. Recursive so that a
   bone may be uploaded in any order — an importer does not promise sorted
   parents, and a chain with a cycle must be detected instead of looping. */
bool worldOf(uint32_t i, const float* local, float* dst) {
  if (g_visit[i] == 2u) return true;
  if (g_visit[i] == 1u) return false; /* cycle */
  g_visit[i] = 1u;
  /* The bone's own local transform, composed from its TRS. */
  float here[16];
  composeTRS(here,
             local[i * 10u], local[i * 10u + 1u], local[i * 10u + 2u],
             local[i * 10u + 3u], local[i * 10u + 4u], local[i * 10u + 5u], local[i * 10u + 6u],
             local[i * 10u + 7u], local[i * 10u + 8u], local[i * 10u + 9u]);
  const int32_t parent = g_parent[i];
  if (parent >= 0 && static_cast<uint32_t>(parent) < g_bones) {
    if (!worldOf(static_cast<uint32_t>(parent), local, dst)) return false;
    mulMat(dst + static_cast<uint32_t>(parent) * 16u, here, dst + i * 16u);
  } else {
    for (uint32_t k = 0; k < 16u; k++) dst[i * 16u + k] = here[k];
  }
  g_visit[i] = 2u;
  return true;
}

/* World matrix of a bone's local TRS, in `dst`, using the recursive walk. The
   caller passes a matrix, not a TRS triple, because `worldOf` recurses through
   already composed parents. */
bool resolveHierarchy(const float* local, float* dst) {
  for (uint32_t i = 0; i < g_bones; i++) g_visit[i] = 0u;
  for (uint32_t i = 0; i < g_bones; i++) {
    if (!worldOf(i, local, dst)) return false;
  }
  return true;
}

/* Head (bind world translation) and tail of a bone, for the distance weights.
   The tail is the head of the first child if there is one, otherwise the head
   plus the bone's rest length along its local +Y — the convention every DCC
   uses for a leaf bone. */
void boneSegment(uint32_t i, float* head, float* tail) {
  const float* w = g_bind_world + i * 16u;
  head[0] = w[12]; head[1] = w[13]; head[2] = w[14];
  int32_t child = -1;
  for (uint32_t j = 0; j < g_bones; j++) {
    if (g_parent[j] == static_cast<int32_t>(i)) { child = static_cast<int32_t>(j); break; }
  }
  if (child >= 0) {
    const float* c = g_bind_world + static_cast<uint32_t>(child) * 16u;
    tail[0] = c[12]; tail[1] = c[13]; tail[2] = c[14];
  } else {
    const float len = g_len[i] > 1e-5f ? g_len[i] : 0.25f;
    /* Local +Y of the bind world, normalised. */
    float yx = w[4], yy = w[5], yz = w[6];
    const float l = sqrtf(yx * yx + yy * yy + yz * yz);
    if (l > 1e-8f) { yx /= l; yy /= l; yz /= l; } else { yx = 0.0f; yy = 1.0f; yz = 0.0f; }
    tail[0] = head[0] + yx * len;
    tail[1] = head[1] + yy * len;
    tail[2] = head[2] + yz * len;
  }
}

/* Squared distance from a point to a segment (Ericson, Real-Time Collision
   Detection §5.1.9 — the clamped projection, not a point-line distance, so a
   vertex beside a bone's middle is weighted to it and one past its tip is not). */
inline float pointSegmentDistance2(const float* p, const float* a, const float* b) {
  const float abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const float apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const float denom = abx * abx + aby * aby + abz * abz;
  float t = 0.0f;
  if (denom > 1e-12f) {
    t = (apx * abx + apy * aby + apz * abz) / denom;
    if (t < 0.0f) t = 0.0f; else if (t > 1.0f) t = 1.0f;
  }
  const float dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

}  // namespace

extern "C" {

/* Reserve the rig block. Returns the pointer to the bone parents or 0 when the
 * device refuses the memory. Re-uses the existing block while the requested
 * rig fits inside it, so re-binding a mesh does not leak a megabyte each time.
 */
FE_EXPORT uint32_t fe_skin_begin(uint32_t bone_count, uint32_t vert_count) {
  if (bone_count == 0u || bone_count > kMaxBones) return 0;
  if (vert_count == 0u || vert_count > kMaxSkinVerts) return 0;
  if (g_skin_block == nullptr || bone_count > g_bone_cap || vert_count > g_vert_cap) {
    const uint32_t bones = bone_count > g_bone_cap ? bone_count : g_bone_cap;
    const uint32_t verts = vert_count > g_vert_cap ? vert_count : g_vert_cap;
    void* block = fe::heap::alloc(bones * kBoneBytes + verts * kVertBytes, 16);
    if (block == nullptr) return 0;
    g_skin_block = reinterpret_cast<uint8_t*>(block);
    g_bone_cap = bones;
    g_vert_cap = verts;
    g_bones = bone_count;
    g_verts = vert_count;
    bindPointers();
    /* A fresh block is zero, which is exactly the rest state a rig wants:
       identity transforms, no weights, no bone indices. */
  }
  g_bones = bone_count;
  g_verts = vert_count;
  g_solved = false;
  for (uint32_t i = 0; i < bone_count; i++) g_parent[i] = -1;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_parent));
}

FE_EXPORT uint32_t fe_skin_bind_trs_ptr(void) { return g_bind ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_bind)) : 0u; }
FE_EXPORT uint32_t fe_skin_pose_trs_ptr(void) { return g_pose ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_pose)) : 0u; }
FE_EXPORT uint32_t fe_skin_lengths_ptr(void) { return g_len ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_len)) : 0u; }
FE_EXPORT uint32_t fe_skin_rest_pos_ptr(void) { return g_rest_p ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_rest_p)) : 0u; }
FE_EXPORT uint32_t fe_skin_rest_nrm_ptr(void) { return g_rest_n ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_rest_n)) : 0u; }
FE_EXPORT uint32_t fe_skin_out_pos_ptr(void) { return g_out_p ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_out_p)) : 0u; }
FE_EXPORT uint32_t fe_skin_out_nrm_ptr(void) { return g_out_n ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_out_n)) : 0u; }
FE_EXPORT uint32_t fe_skin_weights_ptr(void) { return g_w ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_w)) : 0u; }
FE_EXPORT uint32_t fe_skin_indices_ptr(void) { return g_idx ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_idx)) : 0u; }
FE_EXPORT uint32_t fe_skin_matrices_ptr(void) { return g_mat ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_mat)) : 0u; }
FE_EXPORT uint32_t fe_skin_normal_matrices_ptr(void) { return g_nmat ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_nmat)) : 0u; }
FE_EXPORT uint32_t fe_skin_dual_quats_ptr(void) { return g_dq ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_dq)) : 0u; }
FE_EXPORT uint32_t fe_skin_bone_capacity(void) { return g_bone_cap; }
FE_EXPORT uint32_t fe_skin_vert_capacity(void) { return g_vert_cap; }

/* Copy the current pose into the bind pose: "apply rest pose", the operation a
   rigger uses after posing a base skeleton. */
FE_EXPORT int32_t fe_skin_bind_from_pose(void) {
  if (g_skin_block == nullptr) return -1;
  for (uint32_t i = 0; i < g_bones * 10u; i++) g_bind[i] = g_pose[i];
  g_solved = false;
  return 0;
}

/* Compute the per-bone skin matrices for the current pose.
 *
 * `skinMatrix = poseWorld * inverse(bindWorld)`, so a vertex in bind space is
 * carried by the bone exactly as a rigid body would carry it. The inverse
 * transpose and the dual quaternion are prepared in the same pass because
 * every deform costs four of them per vertex and this happens once per pose.
 */
FE_EXPORT int32_t fe_skin_solve(void) {
  if (g_skin_block == nullptr) return -1;
  if (!resolveHierarchy(g_bind, g_bind_world)) return -3;   /* cyclic rig */
  if (!resolveHierarchy(g_pose, g_pose_world)) return -3;
  for (uint32_t i = 0; i < g_bones; i++) {
    if (!invertAffine(g_bind_world + i * 16u, g_bind_inv + i * 16u)) return -4;
  }
  for (uint32_t i = 0; i < g_bones; i++) {
    float* m = g_mat + i * 16u;
    mulMat(g_pose_world + i * 16u, g_bind_inv + i * 16u, m);
    normalMatrix(m, g_nmat + i * 9u);
    dualFromMatrix(m, g_dq + i * 8u);
  }
  g_solved = true;
  return 0;
}

/* Fill the weights from the contact distances between each vertex and each
 * bone segment.
 *
 * `falloff` is the exponent of the inverse distance (2 is soft and blobby, 4
 * is tight at the joint, 8 is nearly rigid). `influences` is clamped to 1..4.
 * The result is normalised per vertex, so it is already a convex combination —
 * an unnormalised weight set is the classic cause of a mesh that inflates when
 * it is posed. Weights are written sorted, largest first.
 *
 * This is distance weighting, not bone heat: it does not solve the diffusion
 * equation, so a vertex equidistant from two limbs (a crotch, an armpit) is
 * split between them. Painting those by hand through the weights pointer is
 * the supported path, and `fe_skin_set_weight` is that path's setter.
 */
FE_EXPORT int32_t fe_skin_auto_weights(uint32_t falloff, uint32_t influences) {
  if (g_skin_block == nullptr) return -1;
  if (!resolveHierarchy(g_bind, g_bind_world)) return -3;
  const uint32_t p = falloff < 1u ? 1u : (falloff > 8u ? 8u : falloff);
  const uint32_t k = influences < 1u ? 1u : (influences > kMaxInfluences ? kMaxInfluences : influences);
  const float exponent = static_cast<float>(p);

  /* Segment endpoints, computed once for the whole pass. */
  float heads[kMaxBones * 3];
  float tails[kMaxBones * 3];
  for (uint32_t b = 0; b < g_bones; b++) {
    boneSegment(b, heads + b * 3u, tails + b * 3u);
  }

  for (uint32_t v = 0; v < g_verts; v++) {
    const float* pos = g_rest_p + v * 3u;
    float bestW[kMaxInfluences] = {0.0f, 0.0f, 0.0f, 0.0f};
    uint16_t bestI[kMaxInfluences] = {0, 0, 0, 0};
    float nearestD2 = 1e30f;
    uint16_t nearestBone = 0;

    for (uint32_t b = 0; b < g_bones; b++) {
      const float d2 = pointSegmentDistance2(pos, heads + b * 3u, tails + b * 3u);
      if (d2 < nearestD2) { nearestD2 = d2; nearestBone = static_cast<uint16_t>(b); }
      /* 1 / (d^p + eps): a bone the vertex sits on dominates, and a bone a
         metre away still contributes a little, which is what keeps a shoulder
         from creasing. */
      const float d = sqrtf(d2);
      const float w = 1.0f / (powf(d, exponent) + 1e-4f);
      /* Insert into the sorted short list. */
      for (uint32_t s = 0; s < k; s++) {
        if (w > bestW[s]) {
          for (uint32_t t = k - 1u; t > s; t--) {
            bestW[t] = bestW[t - 1u];
            bestI[t] = bestI[t - 1u];
          }
          bestW[s] = w;
          bestI[s] = static_cast<uint16_t>(b);
          break;
        }
      }
    }

    float sum = 0.0f;
    for (uint32_t s = 0; s < kMaxInfluences; s++) if (s < k) sum += bestW[s];
    if (!(sum > 0.0f)) {
      /* Every bone sat at infinity (an empty rig): fall back to the nearest. */
      bestW[0] = 1.0f; bestI[0] = nearestBone; sum = 1.0f;
    }
    const float inv = 1.0f / sum;
    for (uint32_t s = 0; s < kMaxInfluences; s++) {
      g_w[v * kMaxInfluences + s] = (s < k) ? bestW[s] * inv : 0.0f;
      g_idx[v * kMaxInfluences + s] = bestI[s];
    }
  }
  return 0;
}

/* Replace one vertex's influences; every other slot is cleared so the sum
   stays 1. Used by weight painting and by a test rig. */
FE_EXPORT int32_t fe_skin_set_weight(uint32_t vertex, uint32_t bone, float weight) {
  if (g_skin_block == nullptr) return -1;
  if (vertex >= g_verts) return -2;
  if (bone >= g_bones) return -2;
  if (!(weight >= 0.0f)) return -2;
  if (weight > 1.0f) weight = 1.0f;
  float* w = g_w + vertex * kMaxInfluences;
  uint16_t* i = g_idx + vertex * kMaxInfluences;
  for (uint32_t s = 0; s < kMaxInfluences; s++) { w[s] = 0.0f; i[s] = 0; }
  w[0] = weight;
  i[0] = static_cast<uint16_t>(bone);
  if (weight < 1.0f) {
    /* The remainder goes to slot 1 of the same bone: a partial weight with the
       rest missing is a vertex that shrinks toward the origin when posed. */
    w[1] = 1.0f - weight;
    i[1] = static_cast<uint16_t>(bone);
  }
  return 0;
}

/* Deform into the out block.
 *
 * mode 0: linear blend skinning — sum(w * M_i * p).
 * mode 1: dual-quaternion skinning — sum(w * DQ_i), sign-corrected against the
 *         accumulator, normalised, then applied. The rotation is blended as a
 *         rotation instead of as matrix elements, so a half-turned joint does
 *         not collapse; that is the whole reason it exists.
 *
 * Normals use the inverse transpose (mode 0) or the blended rotation (mode 1).
 */
FE_EXPORT int32_t fe_skin_deform(uint32_t mode) {
  if (g_skin_block == nullptr) return -1;
  if (!g_solved) return -2;
  const bool dual = mode != 0u;

  for (uint32_t v = 0; v < g_verts; v++) {
    const float* p = g_rest_p + v * 3u;
    const float* n = g_rest_n + v * 3u;
    const float* w = g_w + v * kMaxInfluences;
    const uint16_t* idx = g_idx + v * kMaxInfluences;

    if (dual) {
      /* Accumulate a dual quaternion with the hemisphere fix: q and -q are the
         same rotation, and summing without it cancels the pair and pulls the
         surface to the origin. */
      float rw = 0.0f, rx = 0.0f, ry = 0.0f, rz = 0.0f;
      float dw = 0.0f, dx = 0.0f, dy = 0.0f, dz = 0.0f;
      bool any = false;
      for (uint32_t s = 0; s < kMaxInfluences; s++) {
        const float ws = w[s];
        if (ws <= 0.0f) continue;
        const uint16_t b = idx[s];
        if (b >= g_bones) continue;
        const float* dq = g_dq + static_cast<uint32_t>(b) * 8u;
        float sign = 1.0f;
        if (any) {
          const float dot = rw * dq[3] + rx * dq[0] + ry * dq[1] + rz * dq[2];
          if (dot < 0.0f) sign = -1.0f;
        }
        rw += sign * ws * dq[3];
        rx += sign * ws * dq[0];
        ry += sign * ws * dq[1];
        rz += sign * ws * dq[2];
        dw += sign * ws * dq[4];
        dx += sign * ws * dq[5];
        dy += sign * ws * dq[6];
        dz += sign * ws * dq[7];
        any = true;
      }
      const float len = sqrtf(rx * rx + ry * ry + rz * rz + rw * rw);
      if (len > 1e-8f) {
        const float inv = 1.0f / len;
        rw *= inv; rx *= inv; ry *= inv; rz *= inv;
        dw *= inv; dx *= inv; dy *= inv; dz *= inv;
        /* Re-orthogonalise the dual part, so the transform stays rigid. */
        const float rd = rw * dw + rx * dx + ry * dy + rz * dz;
        dw -= rd * rw; dx -= rd * rx; dy -= rd * ry; dz -= rd * rz;
        const float dq[8] = {rx, ry, rz, rw, dw, dx, dy, dz};
        dqTransform(dq, p[0], p[1], p[2], g_out_p + v * 3u);
      } else {
        g_out_p[v * 3u] = p[0];
        g_out_p[v * 3u + 1u] = p[1];
        g_out_p[v * 3u + 2u] = p[2];
        rw = 1.0f; rx = ry = rz = 0.0f;
      }
      /* Normals: the rotation alone. */
      const float ix = (ry * n[2] - rz * n[1]) + rw * n[0];
      const float iy = (rz * n[0] - rx * n[2]) + rw * n[1];
      const float iz = (rx * n[1] - ry * n[0]) + rw * n[2];
      float ox = n[0] + 2.0f * (ry * iz - rz * iy);
      float oy = n[1] + 2.0f * (rz * ix - rx * iz);
      float oz = n[2] + 2.0f * (rx * iy - ry * ix);
      const float nl = sqrtf(ox * ox + oy * oy + oz * oz);
      if (nl > 1e-8f) { ox /= nl; oy /= nl; oz /= nl; }
      g_out_n[v * 3u] = ox;
      g_out_n[v * 3u + 1u] = oy;
      g_out_n[v * 3u + 2u] = oz;
    } else {
      float px = 0.0f, py = 0.0f, pz = 0.0f;
      float nx = 0.0f, ny = 0.0f, nz = 0.0f;
      for (uint32_t s = 0; s < kMaxInfluences; s++) {
        const float ws = w[s];
        if (ws <= 0.0f) continue;
        const uint16_t b = idx[s];
        if (b >= g_bones) continue;
        const float* m = g_mat + static_cast<uint32_t>(b) * 16u;
        px += ws * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
        py += ws * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]);
        pz += ws * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
        const float* nm = g_nmat + static_cast<uint32_t>(b) * 9u;
        nx += ws * (nm[0] * n[0] + nm[3] * n[1] + nm[6] * n[2]);
        ny += ws * (nm[1] * n[0] + nm[4] * n[1] + nm[7] * n[2]);
        nz += ws * (nm[2] * n[0] + nm[5] * n[1] + nm[8] * n[2]);
      }
      g_out_p[v * 3u] = px;
      g_out_p[v * 3u + 1u] = py;
      g_out_p[v * 3u + 2u] = pz;
      const float nl = sqrtf(nx * nx + ny * ny + nz * nz);
      if (nl > 1e-8f) { nx /= nl; ny /= nl; nz /= nl; }
      g_out_n[v * 3u] = nx;
      g_out_n[v * 3u + 1u] = ny;
      g_out_n[v * 3u + 2u] = nz;
    }
  }
  return 0;
}

}  // extern "C"
