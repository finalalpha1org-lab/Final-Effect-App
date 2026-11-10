/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Polygon tessellation: an ear-clipping triangulator for a single boundary
 * polygon, ported from the Blender tree.
 *
 * Upstream: blender/blender, source/blender/blenlib/intern/polyfill_2d.cc
 *           (revision e240930f046045145f0e03ba237caa7192ccf449, GPL-2.0-or-later)
 *           and BLI_polyfill_calc() from the same file.
 * Original copyright: 2023 Blender Authors.
 *
 * The algorithm below is Blender's, kept pass for pass so that a quad or an
 * n-gon is cut the same way the Blender Triangulate modifier cuts it:
 *
 *   - the ear is clipped from the last vertex first and the search advances
 *     after every clip (USE_CLIP_EVEN), so a convex shape is not fan filled;
 *   - the search sweeps back and forth about the convex ears (USE_CLIP_SWEEP),
 *     which stops the last few triangles from piling up on one side;
 *   - one pass accepts only convex ears and a second pass accepts tangential
 *     ones, so a degenerate ring still produces n-2 triangles instead of
 *     stopping half way (the two-pass rule from Blender bug #103913);
 *   - a ring with no concave point short-circuits the containment test
 *     (USE_CONVEX_SKIP), and a ring with concave points only tests those.
 *
 * What was changed, and why:
 *
 *   - Blender's KD-tree over the concave points is not ported. It exists so a
 *     face with thousands of corners does not go quadratic; the linear scan it
 *     replaces is the same test with the same early exit, and the per-face cap
 *     here is 8192 corners. A face bigger than that falls back to a fan, which
 *     is Blender's own behaviour above its 8192-point threshold.
 *   - The MemArena and the alloca are replaced by one scratch block sized once
 *     on first use: the engine's heap has no free, so a per-call arena would
 *     leak a block per frame.
 *   - The linked list of PolyIndex keeps Blender's shape (prev/next/index/sign)
 *     but is stored as slots in an array, so the same operations are index
 *     arithmetic rather than pointer chasing.
 *   - faces arrive in 3D. The ring is projected onto the plane of its Newell
 *     normal and the winding is compared back against that normal, so the
 *     triangles come out facing the same way as the face they came from no
 *     matter which axis the projection dropped.
 *
 * This file is part of Final Effect and is distributed under the same licence
 * as Blender's: GPL-3.0-or-later. See NOTICE.
 * ========================================================================= */

#ifndef FE_POLYFILL_CPP
#define FE_POLYFILL_CPP

#include "../include/fe_heap.hpp"
#include "../include/fe_abi.h"

namespace {

using namespace fe;

/* The engine's face layer caps a mesh at 65 536 triangles; these follow it. */
constexpr uint32_t kPolyfillMaxVerts = 65536u;
constexpr uint32_t kPolyfillMaxCorners = 131072u;
constexpr uint32_t kPolyfillMaxFaces = 32768u;
/* Above this a single face is tessellated as a fan. Blender switches its own
 * allocation strategy at 8192 points for the same reason: past it the cost of
 * the exact cut stops being worth the difference on screen. */
constexpr uint32_t kPolyfillMaxFaceVerts = 8192u;

/* Blender's eSign. CONVEX is +1 because the sign test compares with `>=`. */
constexpr int8_t PF_CONCAVE = -1;
constexpr int8_t PF_TANGENTIAL = 0;
constexpr int8_t PF_CONVEX = 1;

struct PolyIndex {
  uint32_t next;   /* slot of the next corner, circular */
  uint32_t prev;   /* slot of the previous corner, circular */
  uint32_t index;  /* vertex this corner refers to */
  int8_t sign;
};

struct PolyFill {
  PolyIndex* indices;
  const float* coords;   /* 2 floats per corner of the face being cut */
  uint32_t coords_num;
  uint32_t coords_num_concave;
  uint32_t* tris;        /* 3 per triangle, into vertex indices */
  uint32_t tris_num;
  uint32_t head;         /* slot the list starts at, Blender's pf->indices */
};

struct PolyfillJob {
  bool ready = false;
  float* positions = nullptr;   /* kPolyfillMaxVerts * 3 */
  uint32_t* ring = nullptr;     /* kPolyfillMaxCorners */
  uint32_t* start = nullptr;    /* kPolyfillMaxFaces + 1 */
  uint32_t* tris = nullptr;     /* kPolyfillMaxCorners * 3 */
  PolyIndex* indices = nullptr; /* kPolyfillMaxFaceVerts */
  float* coords = nullptr;      /* kPolyfillMaxFaceVerts * 2 */

  uint32_t vertexCount = 0;
  uint32_t faceCount = 0;
  uint32_t cornerCount = 0;
  uint32_t quadCount = 0;
  uint32_t ngonCount = 0;
};

PolyfillJob g_job;

inline float sub_mul(float ax, float ay, float bx, float by) {
  return ax * by - bx * ay;
}

/* BLI_math_geom: `area_tri_signed_v2_alt_2x`, without the /2 because only the
 * sign is ever used. */
inline float area_tri_signed_v2_alt_2x(const float* v1, const float* v2, const float* v3) {
  const float d2x = v2[0] - v1[0], d2y = v2[1] - v1[1];
  const float d3x = v3[0] - v1[0], d3y = v3[1] - v1[1];
  return d2x * d3y - d3x * d2y;
}

inline int8_t signum_enum(float a) {
  if (a > 0.0f) return PF_CONVEX;
  if (a == 0.0f) return PF_TANGENTIAL;
  return PF_CONCAVE;
}

/* Note the argument reversal: Blender asks for the sign of (v3, v2, v1), which
 * makes CONVEX mean "the ring turns left here" for its clockwise convention. */
inline int8_t span_tri_v2_sign(const float* v1, const float* v2, const float* v3) {
  return signum_enum(area_tri_signed_v2_alt_2x(v3, v2, v1));
}

/* BLI_math_geom `cross_poly_v2`, the trapezium rule. Positive is one winding,
 * negative the other; the caller only compares it with zero. */
float cross_poly_v2(const float* coords, uint32_t num) {
  float cross = 0.0f;
  const float* prev = coords + (num - 1u) * 2u;
  for (uint32_t i = 0; i < num; ++i) {
    const float* curr = coords + i * 2u;
    cross += (prev[0] - curr[0]) * (curr[1] + prev[1]);
    prev = curr;
  }
  return cross;
}

inline const float* coordOf(const PolyFill& pf, uint32_t slot) {
  return pf.coords + static_cast<size_t>(pf.indices[slot].index) * 2u;
}

void pfCoordSignCalc(const PolyFill& pf, uint32_t slot) {
  const PolyIndex& pi = pf.indices[slot];
  pf.indices[slot].sign = span_tri_v2_sign(coordOf(pf, pi.prev), coordOf(pf, slot), coordOf(pf, pi.next));
}

inline uint32_t* pfTriAdd(PolyFill& pf) {
  return pf.tris + static_cast<size_t>(pf.tris_num++) * 3u;
}

void pfCoordRemove(PolyFill& pf, uint32_t slot) {
  const uint32_t next = pf.indices[slot].next;
  const uint32_t prev = pf.indices[slot].prev;
  pf.indices[prev].next = next;
  pf.indices[next].prev = prev;
  if (pf.head == slot) pf.head = next;
  pf.coords_num -= 1u;
}

/* The linear form of Blender's `pf_ear_tip_check`. Same tests, same order, and
 * the same early exit once every concave corner has been looked at. */
bool pfEarTipCheck(const PolyFill& pf, uint32_t tip, int8_t sign_accept) {
  if (pf.coords_num_concave == 0u) return true;   /* fast path for circles */
  if (pf.indices[tip].sign != sign_accept) return false;

  const float* v1 = coordOf(pf, pf.indices[tip].prev);
  const float* v2 = coordOf(pf, tip);
  const float* v3 = coordOf(pf, pf.indices[tip].next);

  const uint32_t next2 = pf.indices[pf.indices[tip].next].next;
  const uint32_t prev_slot = pf.indices[tip].prev;
  uint32_t checked = 0u;
  for (uint32_t slot = next2; slot != prev_slot; slot = pf.indices[slot].next) {
    if (pf.indices[slot].sign != PF_CONVEX) {
      const float* v = coordOf(pf, slot);
      /* Checked in the order Blender checks them: (v3, v1) fails far more often
         than the other two, so it rejects a blocking point soonest. A point on
         the edge counts as inside - that is a tangential corner, and clipping
         the ear would leave a zero-area triangle behind. */
      if (span_tri_v2_sign(v3, v1, v) != PF_CONCAVE &&
          span_tri_v2_sign(v1, v2, v) != PF_CONCAVE &&
          span_tri_v2_sign(v2, v3, v) != PF_CONCAVE) {
        return false;
      }
      if (++checked == pf.coords_num_concave) break;
    }
  }
  return true;
}

/* Blender's `pf_ear_tip_find`, with the same three tiers: convex, tangential,
 * and the desperate pass for a ring that has no ear left at all. */
uint32_t pfEarTipFind(PolyFill& pf, uint32_t ear_init, bool reverse) {
  const uint32_t coords_num = pf.coords_num;
  uint32_t ear = 0u;

  for (int8_t sign_accept = PF_CONVEX; sign_accept >= PF_TANGENTIAL; --sign_accept) {
    ear = ear_init;
    uint32_t i = coords_num;
    while (i--) {
      if (pfEarTipCheck(pf, ear, sign_accept)) return ear;
      ear = reverse ? pf.indices[ear].prev : pf.indices[ear].next;
    }
  }

  /* Desperate mode: a degenerate ring (nearly collinear corners, or a ring that
     became so after clipping). Take a convex or tangential corner if one is
     left, from Martin Held's FIST paper. */
  ear = ear_init;
  uint32_t i = coords_num;
  while (i--) {
    if (pf.indices[ear].sign != PF_CONCAVE) return ear;
    ear = pf.indices[ear].next;
  }
  return ear;
}

void pfEarTipCut(PolyFill& pf, uint32_t tip) {
  uint32_t* tri = pfTriAdd(pf);
  tri[0] = pf.indices[pf.indices[tip].prev].index;
  tri[1] = pf.indices[tip].index;
  tri[2] = pf.indices[pf.indices[tip].next].index;
  pfCoordRemove(pf, tip);
}

void pfTriangulate(PolyFill& pf) {
  uint32_t ear_init = pf.head;
  bool reverse = false;

  while (pf.coords_num > 3u) {
    const uint32_t ear = pfEarTipFind(pf, ear_init, reverse);

    if (pf.indices[ear].sign != PF_CONVEX) pf.coords_num_concave -= 1u;

    const uint32_t prev = pf.indices[ear].prev;
    const uint32_t next = pf.indices[ear].next;
    const int8_t sign_orig_prev = pf.indices[prev].sign;
    const int8_t sign_orig_next = pf.indices[next].sign;

    pfEarTipCut(pf, ear);

    /* Clipping an ear can turn either neighbour from concave to convex. */
    if (sign_orig_prev != PF_CONVEX) {
      pfCoordSignCalc(pf, prev);
      if (pf.indices[prev].sign == PF_CONVEX) pf.coords_num_concave -= 1u;
    }
    if (sign_orig_next != PF_CONVEX) {
      pfCoordSignCalc(pf, next);
      if (pf.indices[next].sign == PF_CONVEX) pf.coords_num_concave -= 1u;
    }

    ear_init = reverse ? pf.indices[prev].prev : pf.indices[next].next;
    if (pf.indices[ear_init].sign != PF_CONVEX) {
      /* Take one more step in the sweep direction, then turn around: this is
         what keeps the fan from growing lop-sided. */
      ear_init = reverse ? pf.indices[ear_init].prev : pf.indices[ear_init].next;
      reverse = !reverse;
    }
  }

  if (pf.coords_num == 3u) {
    uint32_t* tri = pfTriAdd(pf);
    uint32_t slot = pf.head;
    tri[0] = pf.indices[slot].index;
    slot = pf.indices[slot].next;
    tri[1] = pf.indices[slot].index;
    slot = pf.indices[slot].next;
    tri[2] = pf.indices[slot].index;
  }
}

/* Blender's `polyfill_prepare` + `polyfill_calc`, for one face. Returns false
 * if the face cannot be prepared (fewer than three corners). */
bool polyfillFace(PolyFill& pf, const float* coords, uint32_t coords_num, int32_t coords_sign) {
  if (coords_num < 3u) return false;
  pf.coords = coords;
  pf.coords_num = coords_num;
  pf.coords_num_concave = 0u;
  pf.head = 0u;

  if (coords_sign == 0) {
    coords_sign = (cross_poly_v2(coords, coords_num) <= 0.0f) ? 1 : -1;
  }

  if (coords_sign == 1) {
    for (uint32_t i = 0; i < coords_num; ++i) {
      pf.indices[i].next = (i + 1u) % coords_num;
      pf.indices[i].prev = (i + coords_num - 1u) % coords_num;
      pf.indices[i].index = i;
    }
  } else {
    const uint32_t n = coords_num - 1u;
    for (uint32_t i = 0; i < coords_num; ++i) {
      pf.indices[i].next = (i + 1u) % coords_num;
      pf.indices[i].prev = (i + coords_num - 1u) % coords_num;
      pf.indices[i].index = n - i;
    }
  }

  for (uint32_t i = 0; i < coords_num; ++i) {
    pfCoordSignCalc(pf, i);
    if (pf.indices[i].sign != PF_CONVEX) pf.coords_num_concave += 1u;
  }

  pfTriangulate(pf);
  return true;
}

/* Newell's normal of a 3D ring, in the ring's own vertex order. */
void ringNormal(const float* positions, const uint32_t* ring, uint32_t count, float* out) {
  float nx = 0.0f, ny = 0.0f, nz = 0.0f;
  const float* prev = positions + static_cast<size_t>(ring[count - 1u]) * 3u;
  for (uint32_t i = 0; i < count; ++i) {
    const float* curr = positions + static_cast<size_t>(ring[i]) * 3u;
    nx += (prev[1] - curr[1]) * (prev[2] + curr[2]);
    ny += (prev[2] - curr[2]) * (prev[0] + curr[0]);
    nz += (prev[0] - curr[0]) * (prev[1] + curr[1]);
    prev = curr;
  }
  out[0] = nx; out[1] = ny; out[2] = nz;
}

/* Project a 3D ring onto the plane of its normal by dropping the axis the
 * normal leans on hardest. Which two axes survive does not matter: the winding
 * is re-checked against the 3D normal after the cut. */
void projectRing(const float* positions, const uint32_t* ring, uint32_t count,
                 const float* normal, float* out2d) {
  const float ax = normal[0] < 0.0f ? -normal[0] : normal[0];
  const float ay = normal[1] < 0.0f ? -normal[1] : normal[1];
  const float az = normal[2] < 0.0f ? -normal[2] : normal[2];
  uint32_t drop = 2u;
  if (ax >= ay && ax >= az) drop = 0u;
  else if (ay >= az) drop = 1u;
  for (uint32_t i = 0; i < count; ++i) {
    const float* p = positions + static_cast<size_t>(ring[i]) * 3u;
    if (drop == 0u) { out2d[i * 2u] = p[1]; out2d[i * 2u + 1u] = p[2]; }
    else if (drop == 1u) { out2d[i * 2u] = p[0]; out2d[i * 2u + 1u] = p[2]; }
    else { out2d[i * 2u] = p[0]; out2d[i * 2u + 1u] = p[1]; }
  }
}

/* A quad cut along its shorter diagonal - Blender's SHORTEST_DIAGONAL quad
 * method, and the only one of the three that looks the same from both sides. */
void cutQuad(const uint32_t* ring, const float* positions, uint32_t* out, uint32_t& count) {
  const float* p0 = positions + static_cast<size_t>(ring[0]) * 3u;
  const float* p1 = positions + static_cast<size_t>(ring[1]) * 3u;
  const float* p2 = positions + static_cast<size_t>(ring[2]) * 3u;
  const float* p3 = positions + static_cast<size_t>(ring[3]) * 3u;
  const float d02 = (p0[0] - p2[0]) * (p0[0] - p2[0]) + (p0[1] - p2[1]) * (p0[1] - p2[1]) + (p0[2] - p2[2]) * (p0[2] - p2[2]);
  const float d13 = (p1[0] - p3[0]) * (p1[0] - p3[0]) + (p1[1] - p3[1]) * (p1[1] - p3[1]) + (p1[2] - p3[2]) * (p1[2] - p3[2]);
  if (d02 <= d13) {
    out[0] = ring[0]; out[1] = ring[1]; out[2] = ring[2];
    out[3] = ring[0]; out[4] = ring[2]; out[5] = ring[3];
  } else {
    out[0] = ring[1]; out[1] = ring[2]; out[2] = ring[3];
    out[3] = ring[1]; out[4] = ring[3]; out[5] = ring[0];
  }
  count = 2u;
}

void cutFan(const uint32_t* ring, uint32_t n, uint32_t* out, uint32_t& count) {
  count = n - 2u;
  for (uint32_t i = 0; i < count; ++i) {
    out[i * 3u] = ring[0];
    out[i * 3u + 1u] = ring[i + 1u];
    out[i * 3u + 2u] = ring[i + 2u];
  }
}

inline float triangleFacing(const float* positions, const uint32_t* tri, const float* normal) {
  const float* a = positions + static_cast<size_t>(tri[0]) * 3u;
  const float* b = positions + static_cast<size_t>(tri[1]) * 3u;
  const float* c = positions + static_cast<size_t>(tri[2]) * 3u;
  const float ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const float vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const float nx = uy * vz - uz * vy;
  const float ny = uz * vx - ux * vz;
  const float nz = ux * vy - uy * vx;
  return nx * normal[0] + ny * normal[1] + nz * normal[2];
}

} // namespace

extern "C" {

/* Sizes the scratch block on first use. Nothing is allocated until a
 * Triangulate modifier actually runs, and nothing is freed afterwards: the
 * engine's heap cannot free, so the block is sized once for the largest mesh
 * the face layer accepts. */
FE_EXPORT int32_t fe_polyfill_begin(void) {
  PolyfillJob& job = g_job;
  if (job.ready) return 0;
  job.positions = static_cast<float*>(fe::heap::alloc(kPolyfillMaxVerts * 3u * sizeof(float), 16));
  job.ring = static_cast<uint32_t*>(fe::heap::alloc(kPolyfillMaxCorners * sizeof(uint32_t), 16));
  job.start = static_cast<uint32_t*>(fe::heap::alloc((kPolyfillMaxFaces + 1u) * sizeof(uint32_t), 16));
  job.tris = static_cast<uint32_t*>(fe::heap::alloc(kPolyfillMaxCorners * 3u * sizeof(uint32_t), 16));
  job.indices = static_cast<PolyIndex*>(fe::heap::alloc(kPolyfillMaxFaceVerts * sizeof(PolyIndex), 16));
  job.coords = static_cast<float*>(fe::heap::alloc(kPolyfillMaxFaceVerts * 2u * sizeof(float), 16));
  if (!job.positions || !job.ring || !job.start || !job.tris || !job.indices || !job.coords) return -2;
  job.ready = true;
  return 0;
}

FE_EXPORT uint32_t fe_polyfill_max_vertices(void) { return kPolyfillMaxVerts; }
FE_EXPORT uint32_t fe_polyfill_max_corners(void) { return kPolyfillMaxCorners; }
FE_EXPORT uint32_t fe_polyfill_max_faces(void) { return kPolyfillMaxFaces; }
FE_EXPORT uint32_t fe_polyfill_max_face_verts(void) { return kPolyfillMaxFaceVerts; }

FE_EXPORT float* fe_polyfill_positions_ptr(void) { return g_job.positions; }
FE_EXPORT uint32_t* fe_polyfill_ring_ptr(void) { return g_job.ring; }
FE_EXPORT uint32_t* fe_polyfill_start_ptr(void) { return g_job.start; }
FE_EXPORT uint32_t* fe_polyfill_tris_ptr(void) { return g_job.tris; }
FE_EXPORT uint32_t fe_polyfill_quad_count(void) { return g_job.quadCount; }
FE_EXPORT uint32_t fe_polyfill_ngon_count(void) { return g_job.ngonCount; }

/* Cuts every face in the buffer.
 *
 *   quad_method  0 = ear clip (the tessellator decides), 1 = shortest diagonal,
 *                2 = fixed (fan from the first corner).
 *   ngon_method  0 = ear clip, 1 = fan.
 *
 * Returns the triangle count, or a negative code the caller falls back on. */
FE_EXPORT int32_t fe_polyfill_build(uint32_t vertex_count, uint32_t face_count, uint32_t corner_count,
                                    uint32_t quad_method, uint32_t ngon_method) {
  if (fe_polyfill_begin() != 0) return -2;
  PolyfillJob& job = g_job;
  if (vertex_count > kPolyfillMaxVerts) return -3;
  if (face_count > kPolyfillMaxFaces) return -3;
  if (corner_count > kPolyfillMaxCorners) return -3;
  if (face_count == 0u || corner_count == 0u) return 0;

  job.vertexCount = vertex_count;
  job.faceCount = face_count;
  job.cornerCount = corner_count;
  job.quadCount = 0u;
  job.ngonCount = 0u;

  PolyFill pf;
  pf.indices = job.indices;
  pf.coords = job.coords;
  pf.tris = job.tris;
  pf.tris_num = 0u;

  for (uint32_t f = 0; f < face_count; ++f) {
    const uint32_t begin = job.start[f];
    const uint32_t end = job.start[f + 1u];
    if (end <= begin || end > corner_count) continue;
    const uint32_t n = end - begin;
    const uint32_t* ring = job.ring + begin;
    if (n < 3u) continue;

    if (n == 3u) {
      uint32_t* tri = pfTriAdd(pf);
      tri[0] = ring[0];
      tri[1] = ring[1];
      tri[2] = ring[2];
      continue;
    }

    /* Local frame for the winding check, and the 2D ring for the cut. */
    const float* normalSrc = job.positions;
    float normal[3];
    ringNormal(normalSrc, ring, n, normal);

    const uint32_t triBegin = pf.tris_num;

    if (n == 4u && quad_method == 1u) {
      ++job.quadCount;
      uint32_t count = 0u;
      cutQuad(ring, normalSrc, pf.tris + static_cast<size_t>(pf.tris_num) * 3u, count);
      pf.tris_num += count;
    } else if (n > 4u && ngon_method == 1u) {
      ++job.ngonCount;
      uint32_t count = 0u;
      cutFan(ring, n, pf.tris + static_cast<size_t>(pf.tris_num) * 3u, count);
      pf.tris_num += count;
    } else if ((n > 4u && n > kPolyfillMaxFaceVerts) || (n == 4u && quad_method == 2u)) {
      /* A face past the scratch block, or a quad asked to fan: fan either way. */
      if (n > 4u) ++job.ngonCount; else ++job.quadCount;
      uint32_t count = 0u;
      cutFan(ring, n, pf.tris + static_cast<size_t>(pf.tris_num) * 3u, count);
      pf.tris_num += count;
    } else {
      /* Ear clip. The face is cut from its own projected ring, and the
         tessellator writes straight into the job's triangle buffer. */
      if (n == 4u) ++job.quadCount; else ++job.ngonCount;
      const float len2 = normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
      if (len2 < 1e-20f) {
        /* Degenerate face (no area at all): a fan at least keeps its corners. */
        uint32_t count = 0u;
        cutFan(ring, n, pf.tris + static_cast<size_t>(pf.tris_num) * 3u, count);
        pf.tris_num += count;
        continue;
      }
      projectRing(job.positions, ring, n, normal, job.coords);
      PolyFill face;
      face.indices = job.indices;
      face.coords = job.coords;
      face.tris = job.tris + static_cast<size_t>(triBegin) * 3u;
      face.tris_num = 0u;
      if (!polyfillFace(face, job.coords, n, 0)) continue;
      pf.tris_num = triBegin + face.tris_num;
      /* polyfillFace indexes the corners of the face it was handed, which is
         Blender's convention: the caller maps them back. Here that is the ring,
         so a slot becomes the vertex the ring holds at that slot. */
      for (uint32_t t = triBegin; t < pf.tris_num; ++t) {
        uint32_t* tri = job.tris + static_cast<size_t>(t) * 3u;
        tri[0] = ring[tri[0]];
        tri[1] = ring[tri[1]];
        tri[2] = ring[tri[2]];
      }
    }

    /* The cut is made in a projected plane, so a triangle can come out facing
       away from the face it belongs to. Flip it rather than hand the renderer
       a normal it did not ask for. */
    for (uint32_t t = triBegin; t < pf.tris_num; ++t) {
      uint32_t* tri = job.tris + static_cast<size_t>(t) * 3u;
      if (triangleFacing(job.positions, tri, normal) < 0.0f) {
        const uint32_t swap = tri[1];
        tri[1] = tri[2];
        tri[2] = swap;
      }
    }
  }

  return static_cast<int32_t>(pf.tris_num);
}

} // extern "C"
#endif /* FE_POLYFILL_CPP */
