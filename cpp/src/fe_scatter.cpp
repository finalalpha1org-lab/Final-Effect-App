/* Instance transforms for the instanced studios.
 * =========================================================================
 * The landscaping studio draws its plants with one `InstancedMesh` per species
 * part. Filling those buffers used to mean composing every visible instance's
 * matrix through a `THREE.Object3D`:
 *
 *     dm.quaternion.setFromUnitVectors(up, groundNormal)   // dsqrt, rsqrt
 *     dm.quaternion.multiply(axisAngle(Y, yaw))            // 2 trig calls
 *     dm.quaternion.multiply(euler(tiltX, 0, tiltZ))       // 2 trig calls
 *     dm.updateMatrix()                                    // 4x4 compose
 *     mesh.setMatrixAt(i, dm.matrix)                       // 16 float copy
 *
 * That is five quaternion operations, four transcendental calls and a matrix
 * compose per plant, through object property lookups. Measured on a desktop CPU
 * with three.js r128 the loop costs **18.2 ms for 30 000 instances**, and a
 * phone is three to five times slower — a 60-90 ms stutter every time a pan
 * settles, and the same stutter on every brush stroke that regrows a species.
 *
 * The arithmetic itself is trivial; the cost is the JavaScript object traffic.
 * Doing it here is one flat pass over a structure-of-arrays block with no
 * allocations, and the caller then blits the result into the instance buffer
 * with a single `TypedArray.set`.
 *
 * The result is the *same* transform three.js produced, not an approximation:
 * the shortest-arc quaternion from +Y to the terrain normal, the yaw about +Y,
 * the tilt Euler in `YXZ` order and the column-major compose are reproduced
 * exactly. tests/scatter-layout.test.mjs compares the kernel against the
 * three.js reference component by component.
 *
 * The core owns the block so the caller never has to allocate: `fe_scatter_begin`
 * returns a pointer to a `count * 11` float SoA, and `fe_scatter_matrices` reads
 * it back and writes `count * 16` floats directly behind it.
 *
 *   input, per instance (11 floats)
 *     x, y, z, scale_xz, scale_y, yaw, nx, ny, nz, hash_x, hash_z
 *   output, per instance (16 floats)
 *     a column-major 4x4, exactly what `InstancedMesh.instanceMatrix` wants
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

#include <stdint.h>

namespace {

using namespace fe;

/* A bump-grown pair of blocks. Grown, never moved: the caller may be holding a
   view into linear memory across the call. */
uint8_t* g_scatter_block = nullptr;
uint32_t g_scatter_count = 0;

constexpr uint32_t kInStride = 11u;
constexpr uint32_t kOutStride = 16u;

inline float* scatterIn() { return reinterpret_cast<float*>(g_scatter_block); }
inline float* scatterOut() { return reinterpret_cast<float*>(g_scatter_block) + g_scatter_count * kInStride; }

/* in | out | order: the order list is the compacted visible index list the
   quadtree just produced, handed straight back so the transform pass never
   re-walks the invisible instances. */
constexpr uint32_t kOrderStride = 1u;
/* A per-instance scratch the caller asked for rather than allocating in
   JavaScript: scale, x/z scale, root sink and the two placement hashes, all of
   which the studio needs again for the colour and the impostor quad. It is not
   read here; it exists so that a camera settle allocates nothing outside the
   module. */
constexpr uint32_t kAuxStride = 5u;

inline uint32_t bytes_for(uint32_t count) {
  return count * (kInStride + kOutStride + kOrderStride + kAuxStride) * 4u;
}

/* The core's freestanding sin/cos are sized for shading (max error ~2e-6 at
   the ends of the range) and that is not enough here: an instance transform is
   compared against what the browser produced, and a 2e-6 error in cos(0) turns
   into a 2e-6 scale error on every plant, which is a visible mismatch in a
   before/after screenshot even if it is invisible in the frame. These two are
   the same functions evaluated in double from a Taylor series that is accurate
   to 1e-14 over the reduced range; the result is rounded to float once, at the
   end, exactly where three.js writes it into the instance buffer. */
constexpr double kPiD = 3.14159265358979323846;
constexpr double kHalfPiD = 1.57079632679489661923;
constexpr double kTwoPiD = 6.28318530717958647692;

inline double reducePi(double x) {
  const double k = static_cast<double>(static_cast<long long>((x * (1.0 / kTwoPiD)) + (x >= 0.0 ? 0.5 : -0.5)));
  return x - k * kTwoPiD;
}

inline double dsin(double x) {
  x = reducePi(x);
  if (x > kHalfPiD) x = kPiD - x;
  else if (x < -kHalfPiD) x = -kPiD - x;
  const double x2 = x * x;
  return x * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 +
         x2 * (1.0 / 362880.0 + x2 * (-1.0 / 39916800.0 + x2 * (1.0 / 6227020800.0 +
         x2 * (-1.0 / 1307674368000.0 + x2 * (1.0 / 355687428096000.0)))))))));
}

inline double dcos(double x) { return dsin(x + kHalfPiD); }

inline float sinApprox(float x) { return static_cast<float>(dsin(static_cast<double>(x))); }
inline float cosApprox(float x) { return static_cast<float>(dcos(static_cast<double>(x))); }

/* three.js `Quaternion.setFromUnitVectors(+Y, n)`: the shortest arc between the
   two directions. `r` is dot + 1, so it degenerates only for a normal pointing
   straight down — which a terrain normal never does, but the branch is kept so
   a hand-written normal cannot produce NaNs. */
struct InstQuat { float x, y, z, w; };

inline InstQuat shortestArcFromUp(float nx, float ny, float nz) {
  const float r = ny + 1.0f;
  InstQuat q;
  if (r < 1e-6f) { q.x = 0.0f; q.y = 0.0f; q.z = 1.0f; q.w = 0.0f; return q; }
  q.x = nz; q.y = 0.0f; q.z = -nx; q.w = r;
  const float len = q.x * q.x + q.z * q.z + q.w * q.w;
  if (len > 0.0f) {
    const float inv = 1.0f / (len > 0.0f ? sqrtf(len) : 1.0f);
    q.x *= inv; q.y *= inv; q.z *= inv; q.w *= inv;
  }
  return q;
}

/* `this * b`, the order three.js applies in `q.multiply(b)`. */
inline InstQuat mul(const InstQuat& a, const InstQuat& b) {
  InstQuat q;
  q.x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
  q.y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
  q.z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
  q.w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  return q;
}

inline InstQuat yawQuat(float angle) {
  const float h = angle * 0.5f;
  InstQuat q;
  q.x = 0.0f; q.y = sinApprox(h); q.z = 0.0f; q.w = cosApprox(h);
  return q;
}

/* three.js `Euler(tx, ty, tz, 'YXZ')` -> quaternion. Spelled out rather than
   composed from three axis rotations because the YXZ order is not the same as
   ZYX and the difference is visible on a slope. */
inline InstQuat eulerYXZ(float tx, float ty, float tz) {
  const float c1 = cosApprox(tx * 0.5f), c2 = cosApprox(ty * 0.5f), c3 = cosApprox(tz * 0.5f);
  const float s1 = sinApprox(tx * 0.5f), s2 = sinApprox(ty * 0.5f), s3 = sinApprox(tz * 0.5f);
  InstQuat q;
  q.x = s1 * c2 * c3 + c1 * s2 * s3;
  q.y = c1 * s2 * c3 - s1 * c2 * s3;
  q.z = c1 * c2 * s3 - s1 * s2 * c3;
  q.w = c1 * c2 * c3 + s1 * s2 * s3;
  return q;
}

/* three.js `Matrix4.compose(position, quaternion, scale)` — column-major, which
   is what `InstancedMesh.instanceMatrix` stores. */
inline void compose(float* te, float px, float py, float pz,
                    float sx, float sy, float sz, const InstQuat& q) {
  const float x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
  const float xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
  const float yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
  const float wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;

  te[0] = (1.0f - (yy + zz)) * sx;
  te[1] = (xy + wz) * sx;
  te[2] = (xz - wy) * sx;
  te[3] = 0.0f;
  te[4] = (xy - wz) * sy;
  te[5] = (1.0f - (xx + zz)) * sy;
  te[6] = (yz + wx) * sy;
  te[7] = 0.0f;
  te[8] = (xz + wy) * sz;
  te[9] = (yz - wx) * sz;
  te[10] = (1.0f - (xx + yy)) * sz;
  te[11] = 0.0f;
  te[12] = px;
  te[13] = py;
  te[14] = pz;
  te[15] = 1.0f;
}

}  // namespace

extern "C" {

/* Reserve the block for `count` instances and return a pointer to the input
   SoA. Returns 0 when the device refuses the memory, which the caller must
   treat as "keep using the JavaScript path" rather than draw garbage. */
FE_EXPORT uint32_t fe_scatter_begin(uint32_t count) {
  if (count == 0) return 0;
  if (g_scatter_block != nullptr && g_scatter_count >= count) {
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(scatterIn()));
  }
  /* Grow-only: the previous block stays alive so a view the caller already
     holds is never invalidated, only replaced on the next begin(). */
  void* block = fe::heap::alloc(bytes_for(count), 16);
  if (block == nullptr) return 0;
  g_scatter_block = reinterpret_cast<uint8_t*>(block);
  g_scatter_count = count;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(scatterIn()));
}

/* Transform `count` instances.
 *
 * `order` is a pointer to uint32 source indices (the compacted visible list);
 * pass 0 to transform every instance in source order. `tilt` is the species'
 * random-tilt amount, `bend` the extra lean applied on top of the ground
 * normal, and `mode` selects the rotation:
 *
 *   0  upright — one `Euler(tiltX, yaw, tiltZ, 'YXZ')`, used by buildings
 *   1  aligned — shortest arc to the ground normal, then yaw, then lean
 *
 * Returns a pointer to the `count * 16` output block, or 0 if the call is
 * malformed or `fe_scatter_begin` has not run at a large enough count. */
/* The compacted index list, `count` uint32s. Written by the caller, read by
   `fe_scatter_matrices` through the `order` argument. */
FE_EXPORT uint32_t fe_scatter_order_ptr(void) {
  if (g_scatter_block == nullptr) return 0;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
      g_scatter_block + g_scatter_count * (kInStride + kOutStride) * 4u));
}

/* Float scratch, `count * 5` per instance: scale, x/z scale, root sink, hash_x,
   hash_z. The caller writes and reads it; the kernel never touches it. */
FE_EXPORT uint32_t fe_scatter_aux_ptr(void) {
  if (g_scatter_block == nullptr) return 0;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
      g_scatter_block + g_scatter_count * (kInStride + kOutStride + kOrderStride) * 4u));
}

FE_EXPORT uint32_t fe_scatter_matrices(uint32_t count, uint32_t order, float tilt, float bend,
                                       uint32_t mode) {
  if (g_scatter_block == nullptr || count == 0 || count > g_scatter_count) return 0;
  const float* in = scatterIn();
  float* out = scatterOut();
  const uint32_t* src_order = reinterpret_cast<const uint32_t*>(static_cast<uintptr_t>(order));

  for (uint32_t i = 0; i < count; i++) {
    const uint32_t s = (src_order != nullptr) ? src_order[i] : i;
    if (s >= g_scatter_count) return 0;
    const float* r = in + s * kInStride;
    const float px = r[0], py = r[1], pz = r[2];
    const float sxz = r[3], sy = r[4], yaw = r[5];
    const float nx = r[6], ny = r[7], nz = r[8];
    const float h2 = r[9], h3 = r[10];

    InstQuat q;
    if (mode == 0) {
      q = eulerYXZ((h2 - 0.5f) * tilt, yaw, (h3 - 0.5f) * tilt);
    } else {
      /* The caller already folded its alignment factor into nx/nz, so the
         normal is re-normalised here exactly as `Vector3.normalize` would. */
      const float len = nx * nx + ny * ny + nz * nz;
      float ax = 0.0f, ay = 1.0f, az = 0.0f;
      if (len > 0.0f) {
        const float inv = 1.0f / sqrtf(len);
        ax = nx * inv; ay = ny * inv; az = nz * inv;
      }
      q = mul(mul(shortestArcFromUp(ax, ay, az), yawQuat(yaw)),
              eulerYXZ((h2 - 0.5f) * bend, 0.0f, (h3 - 0.5f) * bend));
    }
    compose(out + i * kOutStride, px, py, pz, sxz, sy, sxz, q);
  }
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(out));
}

}  // extern "C"
