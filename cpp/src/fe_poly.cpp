#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

/* =========================================================================
 * The face law, in the engine (C++20, freestanding wasm)
 *
 * A triangle buffer cannot say what a face is. A cube's six sides arrive as
 * twelve triangles; a cylinder's cap arrives as a fan of thirty-two. The model
 * has faces, the GPU has triangles, and something has to hold the difference -
 * otherwise every wireframe, outline, See-through view and export grows a
 * diagonal down the middle of a flat face, which is the bug the user reported
 * as "the faces are split into triangles".
 *
 * That rule used to live twice: the edit kernel measured it here in C++
 * (fe_editmesh.cpp, buildQuadGroups), and Object Mode measured it again in
 * JavaScript (fe-poly.js, ~340 lines of it) because a mesh that is merely
 * selected has no edit session to ask. Two implementations of one law drift:
 * a fix in one shows up as a mismatch between what Object Mode draws and what
 * Edit Mode lets you grab.
 *
 * So the measurement is here now and JavaScript only moves buffers:
 *
 *   fe_poly_begin(verts, tris, declaredFaces, indexed)
 *   <write positions / indices / declared rings>
 *   fe_poly_build()            -> face count, or a negative error
 *   <read fe_poly_face_*>, <read the weld table>
 *
 * What the law is (unchanged from the JS it replaces, which is what the models
 * in this app were measured against):
 *
 *   - vertices are welded by position, because a Boolean or modifier result and
 *     most glTF exports are non-indexed: two triangles that share an edge share
 *     a *position* and nothing else;
 *   - the faces the app declared come first. A cap's fan cannot be told from a
 *     flat quad mesh by any shape test, so the library that built the shape
 *     says what its faces are and the ring claims the triangles inside it;
 *   - what is left: two triangles that share an edge and face the same way are
 *     one quad, and the edge between them is not an edge of the model;
 *   - "face the same way" is measured twice, because a quad on a curved surface
 *     is not flat: coplanar to within the wireframe angle (0.6 degrees), or the
 *     shared edge is the longest side of both triangles and the two halves fold
 *     by less than 60 degrees. The second rule is the edit kernel's, so a Quad
 *     Sphere or a knot draws the same faces in Object Mode as in Edit Mode;
 *   - candidates are taken longest shared edge first (the diagonal of a quad is
 *     longer than the sides it shares with its neighbours), each triangle is
 *     used once, and a pair is only accepted when the four corners are convex;
 *   - everything left over stays a triangle.
 * ========================================================================= */

extern "C" uint32_t fe_malloc(uint32_t byte_size);
extern "C" void fe_arena_reset(void);

namespace {

using namespace fe;

/* Room for the working set of one build inside the 24 MB session arena. The
 * caller marshals a mesh in and reads the faces out; nothing survives the call,
 * so the arena is reset at the start of each build the way the modifier kernels
 * reset it. */
constexpr uint32_t POLY_ARENA_BUDGET = 22u * 1024u * 1024u;

/* A phone does not need a face list for a two-million-triangle sculpture, and
 * the shell's wireframe path stops at 60 000 anyway. The ceiling is where the
 * working set stops fitting the arena, not a policy. */
constexpr uint32_t POLY_MAX_VERTS = 262144u;
constexpr uint32_t POLY_MAX_TRIS = 131072u;
constexpr uint32_t POLY_MAX_DECLARED = 65536u;
constexpr uint32_t POLY_NO_FACE = 0xFFFFFFFFu;
constexpr uint32_t POLY_NON_MANIFOLD = 0xFFFFFFFEu;

/* The wireframe angle: two faces within 0.6 degrees of each other are one
 * surface, so the edge between them is internal structure. The same number
 * fe_poly.js declared and the same one the shell draws with. */
constexpr float COS_FLAT = 0.99994516936f;   /* cos(0.6 deg) */
constexpr float COS_QUAD = 0.5f;             /* cos(60 deg)  */

/* Vertices within a tenth of a millimetre at unit scale are the same vertex. */
constexpr double QUANT = 1.0e4;

uint32_t g_used = 0;

inline void* polyAlloc(uint32_t bytes) {
  if (bytes == 0) return nullptr;
  const uint32_t aligned = (bytes + 15u) & ~15u;
  if (g_used + aligned > POLY_ARENA_BUDGET) return nullptr;
  const uint32_t raw = fe_malloc(aligned);
  if (raw == 0) return nullptr;
  g_used += aligned;
  return reinterpret_cast<void*>(static_cast<uintptr_t>(raw));
}

/* -------------------------------------------------------------- session --- */

uint32_t g_vertexCount = 0;
uint32_t g_triCount = 0;
uint32_t g_declCount = 0;
uint32_t g_indexed = 0;
uint32_t g_declRingCount = 0;
uint32_t g_declRingCap = 0;

float* g_pos = nullptr;
uint32_t* g_idx = nullptr;
uint32_t* g_declStart = nullptr;
uint32_t* g_declRing = nullptr;

/* --------------------------------------------------------------- result --- */

uint32_t g_weldCount = 0;
uint32_t* g_weldOfSlot = nullptr;   /* geometry slot -> welded id        */
uint32_t* g_weldRep = nullptr;      /* welded id     -> first real slot  */

uint32_t g_faceCount = 0;
uint32_t* g_faceStart = nullptr;    /* faceCount + 1 offsets into ring   */
uint32_t* g_faceRing = nullptr;     /* welded ids, face after face       */
uint32_t g_faceRingCount = 0;
uint32_t* g_faceTriStart = nullptr; /* faceCount + 1 offsets into tris   */
uint32_t* g_faceTri = nullptr;      /* geometry triangle indices         */
uint32_t g_faceTriCount = 0;

/* The model's edges: every side of every face, counted once. A face's sides are
 * its ring's consecutive corners, so the edge list follows from the face list
 * and nothing else - which is the whole point of holding faces. */
uint64_t* g_edgePair = nullptr;
uint32_t g_edgePairCount = 0;
/* Faces of three, four and more than four corners. */
uint32_t g_kindCount[3] = {0, 0, 0};

/* Math.floor(x + 0.5), which is what JavaScript's Math.round is. A different
 * tie-break here would weld a different set of vertices and produce a face list
 * that disagrees with the shell's cached one. */
inline int64_t jsRound(double v) {
  const double shifted = v + 0.5;
  int64_t t = static_cast<int64_t>(shifted);
  if (static_cast<double>(t) > shifted) --t;
  return t;
}

inline void pointOf(const uint32_t* weldRep, const float* pos, uint32_t id, Vec3& out) {
  const uint32_t slot = weldRep ? weldRep[id] : id;
  out.x = pos[slot * 3];
  out.y = pos[slot * 3 + 1];
  out.z = pos[slot * 3 + 2];
}

inline uint32_t mix32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

inline uint32_t hashQuant(int64_t qx, int64_t qy, int64_t qz) {
  uint32_t h = mix32(static_cast<uint32_t>(qx) ^ 0x9e3779b9u);
  h = mix32(h ^ static_cast<uint32_t>(qx >> 32));
  h = mix32(h ^ static_cast<uint32_t>(qy) ^ 0x85ebca6bu);
  h = mix32(h ^ static_cast<uint32_t>(qy >> 32));
  h = mix32(h ^ static_cast<uint32_t>(qz) ^ 0xc2b2ae35u);
  h = mix32(h ^ static_cast<uint32_t>(qz >> 32));
  return h ? h : 1u;
}

inline uint32_t mix64(uint64_t x) {
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  x *= 0xc4ceb9fe1a85ec53ULL;
  x ^= x >> 33;
  return static_cast<uint32_t>(x);
}

struct Edge {
  uint32_t a, b, t0, t1;
};

struct Candidate {
  uint32_t a, b, t0, t1;
  float len;
};

/* Stable merge sort, longest first. Stability is part of the contract: equal
 * lengths are common on a symmetric mesh, and the order they arrive in is the
 * order the edges were first seen, which decides which pairs win. Array#sort in
 * the JS this replaces had the same property. */
void sortCandidates(Candidate* list, Candidate* scratch, uint32_t count) {
  if (count < 2) return;
  for (uint32_t width = 1; width < count; width <<= 1) {
    for (uint32_t start = 0; start < count; start += width << 1) {
      const uint32_t mid = start + width < count ? start + width : count;
      const uint32_t end = start + (width << 1) < count ? start + (width << 1) : count;
      uint32_t i = start, j = mid, out = start;
      while (i < mid && j < end) {
        if (list[j].len > list[i].len) scratch[out++] = list[j++];
        else scratch[out++] = list[i++];
      }
      while (i < mid) scratch[out++] = list[i++];
      while (j < end) scratch[out++] = list[j++];
    }
    for (uint32_t i = 0; i < count; ++i) list[i] = scratch[i];
  }
}

/* In-place heapsort of 64-bit keys, ascending. Used where a few ten thousand
 * keys have to be deduplicated and a second buffer would be the larger cost. */
void sortKeys(uint64_t* keys, uint32_t count) {
  if (count < 2) return;
  auto sift = [&](uint32_t root, uint32_t end) {
    for (;;) {
      uint32_t child = root * 2u + 1u;
      if (child >= end) return;
      if (child + 1u < end && keys[child + 1u] > keys[child]) ++child;
      if (keys[root] >= keys[child]) return;
      const uint64_t swap = keys[root];
      keys[root] = keys[child];
      keys[child] = swap;
      root = child;
    }
  };
  for (uint32_t start = count / 2u; start > 0; --start) sift(start - 1u, count);
  for (uint32_t end = count; end > 1u; --end) {
    const uint64_t swap = keys[0];
    keys[0] = keys[end - 1u];
    keys[end - 1u] = swap;
    sift(0, end - 1u);
  }
}

} // namespace

/* ============================================================ the exports == */

extern "C" {

FE_EXPORT int32_t fe_poly_begin(uint32_t vertex_count, uint32_t triangle_count,
                                uint32_t declared_face_count, uint32_t declared_corner_count,
                                uint32_t indexed) {
  g_vertexCount = g_triCount = g_declCount = 0;
  g_indexed = indexed ? 1u : 0u;
  g_declRingCount = 0;
  g_declRingCap = 0;
  g_weldCount = g_faceCount = g_faceRingCount = g_faceTriCount = 0;
  g_pos = nullptr;
  g_idx = nullptr;
  g_declStart = nullptr;
  g_declRing = nullptr;
  g_weldOfSlot = nullptr;
  g_weldRep = nullptr;
  g_faceStart = nullptr;
  g_faceRing = nullptr;
  g_faceTriStart = nullptr;
  g_faceTri = nullptr;
  g_edgePair = nullptr;
  g_edgePairCount = 0;
  g_kindCount[0] = g_kindCount[1] = g_kindCount[2] = 0;

  if (vertex_count == 0 || vertex_count > POLY_MAX_VERTS) return -1;
  if (triangle_count == 0 || triangle_count > POLY_MAX_TRIS) return -2;
  if (declared_face_count > POLY_MAX_DECLARED) return -3;
  if (declared_face_count == 0 && declared_corner_count != 0) return -3;
  if (declared_corner_count > triangle_count * 3u) return -3;

  fe_arena_reset();
  g_used = 0;

  g_pos = static_cast<float*>(polyAlloc(vertex_count * 3u * 4u));
  if (!g_pos) return -4;
  if (indexed) {
    g_idx = static_cast<uint32_t*>(polyAlloc(triangle_count * 3u * 4u));
    if (!g_idx) return -4;
  }
  if (declared_face_count > 0) {
    g_declStart = static_cast<uint32_t*>(polyAlloc((declared_face_count + 1u) * 4u));
    if (!g_declStart) return -4;
    g_declRing = static_cast<uint32_t*>(polyAlloc(declared_corner_count * 4u + 4u));
    if (!g_declRing) return -4;
    g_declRingCap = declared_corner_count;
  }

  g_vertexCount = vertex_count;
  g_triCount = triangle_count;
  g_declCount = declared_face_count;
  return 0;
}

FE_EXPORT float* fe_poly_positions_ptr(void) { return g_pos; }
FE_EXPORT uint32_t* fe_poly_indices_ptr(void) { return g_idx; }
FE_EXPORT uint32_t* fe_poly_declared_start_ptr(void) { return g_declStart; }
FE_EXPORT uint32_t* fe_poly_declared_ring_ptr(void) { return g_declRing; }

/* How many ring corners the caller actually wrote, so a table shorter than the
 * arena is not read past its end. The corner count is given to fe_poly_begin,
 * which sizes the table - a guess here would either waste the arena or let the
 * caller write past its end. */
FE_EXPORT uint32_t fe_poly_set_declared_corners(uint32_t corners) {
  if (corners > g_declRingCap) return 0;
  g_declRingCount = corners;
  return 1;
}

/* ----------------------------------------------------------------- results -- */

FE_EXPORT uint32_t fe_poly_weld_count(void) { return g_weldCount; }
FE_EXPORT uint32_t* fe_poly_weld_rep_ptr(void) { return g_weldRep; }
FE_EXPORT uint32_t* fe_poly_weld_of_slot_ptr(void) { return g_weldOfSlot; }

FE_EXPORT uint32_t fe_poly_face_count(void) { return g_faceCount; }
FE_EXPORT uint32_t* fe_poly_face_start_ptr(void) { return g_faceStart; }
FE_EXPORT uint32_t* fe_poly_face_ring_ptr(void) { return g_faceRing; }
FE_EXPORT uint32_t fe_poly_face_ring_count(void) { return g_faceRingCount; }
FE_EXPORT uint32_t* fe_poly_face_tri_start_ptr(void) { return g_faceTriStart; }
FE_EXPORT uint32_t* fe_poly_face_tri_ptr(void) { return g_faceTri; }
FE_EXPORT uint32_t fe_poly_face_tri_count(void) { return g_faceTriCount; }

/* The model's edges as welded-id pairs, low id first, each pair once. */
FE_EXPORT uint32_t fe_poly_edge_count(void) { return g_edgePairCount; }
FE_EXPORT uint64_t* fe_poly_edge_ptr(void) { return g_edgePair; }
/* {three corner faces, four corner faces, five or more} in one record. */
FE_EXPORT uint32_t* fe_poly_kind_counts_ptr(void) { return g_kindCount; }

/* ================================================================ the law == */

FE_EXPORT int32_t fe_poly_build(void) {
  if (!g_pos || g_vertexCount == 0 || g_triCount == 0) return -10;

  const uint32_t V = g_vertexCount;
  const uint32_t T = g_triCount;
  const uint32_t F = g_declCount;
  const bool hasDeclared = F > 0 && g_declStart && g_declRing && g_declRingCount > 0;

  /* ---- 1. weld ------------------------------------------------------- */
  /* An indexed mesh keeps its own numbering unless the app declared faces: a
   * cylinder's cap has its own copies of the rim points, and a declared ring
   * names one copy while the cap's triangles name another, so the ring would
   * match nothing. The edit kernel welds before it reads a declared face for
   * the same reason. */
  const bool weld = (!g_indexed) || hasDeclared;
  uint8_t* weldOfSlotBytes = static_cast<uint8_t*>(polyAlloc(V));
  g_weldOfSlot = static_cast<uint32_t*>(polyAlloc(V * 4u));
  g_weldRep = static_cast<uint32_t*>(polyAlloc(V * 4u));
  if (!weldOfSlotBytes || !g_weldOfSlot || !g_weldRep) return -11;
  (void)weldOfSlotBytes;

  if (!weld) {
    g_weldCount = V;
    for (uint32_t i = 0; i < V; ++i) { g_weldOfSlot[i] = i; g_weldRep[i] = i; }
  } else {
    uint32_t capacity = 16;
    while (capacity < V * 2u) capacity <<= 1u;
    uint32_t* slots = static_cast<uint32_t*>(polyAlloc(capacity * 4u));   /* id + 1 */
    uint32_t* hashes = static_cast<uint32_t*>(polyAlloc(capacity * 4u));
    if (!slots || !hashes) return -11;
    for (uint32_t i = 0; i < capacity; ++i) slots[i] = 0;

    auto quantOf = [&](uint32_t id, int64_t& qx, int64_t& qy, int64_t& qz) {
      const uint32_t s = g_weldRep[id];
      qx = jsRound(static_cast<double>(g_pos[s * 3]) * QUANT);
      qy = jsRound(static_cast<double>(g_pos[s * 3 + 1]) * QUANT);
      qz = jsRound(static_cast<double>(g_pos[s * 3 + 2]) * QUANT);
    };

    uint32_t welded = 0;
    const uint32_t mask = capacity - 1u;
    for (uint32_t i = 0; i < V; ++i) {
      const int64_t qx = jsRound(static_cast<double>(g_pos[i * 3]) * QUANT);
      const int64_t qy = jsRound(static_cast<double>(g_pos[i * 3 + 1]) * QUANT);
      const int64_t qz = jsRound(static_cast<double>(g_pos[i * 3 + 2]) * QUANT);
      const uint32_t h = hashQuant(qx, qy, qz);
      uint32_t at = h & mask;
      for (;;) {
        const uint32_t entry = slots[at];
        if (entry == 0) {
          slots[at] = welded + 1u;
          hashes[at] = h;
          g_weldRep[welded] = i;
          g_weldOfSlot[i] = welded;
          ++welded;
          break;
        }
        const uint32_t id = entry - 1u;
        if (hashes[at] == h) {
          int64_t ex, ey, ez;
          quantOf(id, ex, ey, ez);
          if (ex == qx && ey == qy && ez == qz) { g_weldOfSlot[i] = id; break; }
        }
        at = (at + 1u) & mask;
      }
    }
    g_weldCount = welded;
  }

  const uint32_t W = g_weldCount;
  const uint32_t* weldOfSlot = g_weldOfSlot;
  auto slotOfCorner = [&](uint32_t t, uint32_t k) -> uint32_t {
    return g_idx ? g_idx[t * 3u + k] : (t * 3u + k);
  };

  /* ---- 2. triangles --------------------------------------------------- */
  uint32_t* corners = static_cast<uint32_t*>(polyAlloc(T * 3u * 4u));
  float* normals = static_cast<float*>(polyAlloc(T * 3u * 4u));
  uint8_t* degenerate = static_cast<uint8_t*>(polyAlloc(T));
  if (!corners || !normals || !degenerate) return -12;

  for (uint32_t t = 0; t < T; ++t) {
    const uint32_t s0 = slotOfCorner(t, 0), s1 = slotOfCorner(t, 1), s2 = slotOfCorner(t, 2);
    if (s0 >= V || s1 >= V || s2 >= V) return -13;
    corners[t * 3] = weldOfSlot[s0];
    corners[t * 3 + 1] = weldOfSlot[s1];
    corners[t * 3 + 2] = weldOfSlot[s2];
    const float ax = g_pos[s0 * 3], ay = g_pos[s0 * 3 + 1], az = g_pos[s0 * 3 + 2];
    const float ux = g_pos[s1 * 3] - ax, uy = g_pos[s1 * 3 + 1] - ay, uz = g_pos[s1 * 3 + 2] - az;
    const float vx = g_pos[s2 * 3] - ax, vy = g_pos[s2 * 3 + 1] - ay, vz = g_pos[s2 * 3 + 2] - az;
    const float nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const float length = sqrtf(nx * nx + ny * ny + nz * nz);
    const float inv = length > 0.0f ? 1.0f / length : 0.0f;
    normals[t * 3] = nx * inv;
    normals[t * 3 + 1] = ny * inv;
    normals[t * 3 + 2] = nz * inv;
    const uint32_t a = corners[t * 3], b = corners[t * 3 + 1], c = corners[t * 3 + 2];
    /* Three builds a cone's side as a quad whose top edge has no length and
     * half of it collapses. The weld drops those corners onto each other; a
     * face list that kept them would grow faces of two corners and edges that
     * are not edges. They keep their triangle number (the editor picks by it)
     * and belong to no face. */
    degenerate[t] = (a == b || b == c || a == c) ? 1u : 0u;
  }

  /* ---- 3. shared edges ------------------------------------------------- */
  uint32_t edgeCapacity = 16;
  const uint32_t edgeUpper = T * 3u;
  while (edgeCapacity < edgeUpper * 2u) edgeCapacity <<= 1u;

  /* The records keep their insertion order - first sighting wins the slot -
   * because the greedy pairing below depends on it once the sort is stable.
   * The hash table only points at them. */
  Edge* edges = static_cast<Edge*>(polyAlloc(edgeUpper * sizeof(Edge)));
  /* The table holds `record index + 1` and nothing else: a hit is confirmed by
   * comparing the record's own corner ids, so the key does not have to be
   * stored twice. That is two megabytes back at the largest mesh. */
  uint32_t* edgeSlots = static_cast<uint32_t*>(polyAlloc(edgeCapacity * 4u));
  if (!edges || !edgeSlots) return -14;
  for (uint32_t i = 0; i < edgeCapacity; ++i) edgeSlots[i] = 0;

  const uint32_t edgeMask = edgeCapacity - 1u;
  uint32_t edgeCount = 0;
  for (uint32_t t = 0; t < T; ++t) {
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t a = corners[t * 3 + k];
      const uint32_t b = corners[t * 3 + ((k + 1u) % 3u)];
      if (a == b) continue;
      const uint32_t lo = a < b ? a : b, hi = a < b ? b : a;
      const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
      const uint32_t h = mix64(key);
      uint32_t at = h & edgeMask;
      for (;;) {
        const uint32_t entry = edgeSlots[at];
        if (entry == 0) {
          edgeSlots[at] = edgeCount + 1u;
          Edge& e = edges[edgeCount++];
          e.a = lo; e.b = hi; e.t0 = t; e.t1 = POLY_NO_FACE;
          break;
        }
        Edge& e = edges[entry - 1u];
        if (e.a == lo && e.b == hi) {
          /* A third triangle on the same edge is non-manifold: nothing may be
           * fused across it. */
          if (e.t1 == POLY_NO_FACE) { if (e.t0 != t) e.t1 = t; }
          else if (e.t0 != t && e.t1 != t) e.t1 = POLY_NON_MANIFOLD;
          break;
        }
        at = (at + 1u) & edgeMask;
      }
    }
  }

  /* ---- 4. faces -------------------------------------------------------- */
  uint8_t* claimed = static_cast<uint8_t*>(polyAlloc(T));
  uint8_t* done = static_cast<uint8_t*>(polyAlloc(T));
  uint32_t* claimGroup = static_cast<uint32_t*>(polyAlloc(T * 4u));
  if (!claimed || !done || !claimGroup) return -15;
  for (uint32_t t = 0; t < T; ++t) { claimed[t] = 0; done[t] = 0; claimGroup[t] = POLY_NO_FACE; }

  /* A declared n-gon is kept as it is, so a ring can be longer than four. The
   * worst case is every triangle unpaired plus every declared corner. */
  const uint32_t ringCapacity = T * 3u + g_declRingCount + 8u;
  const uint32_t faceCapacity = T + F + 1u;
  g_faceRing = static_cast<uint32_t*>(polyAlloc(ringCapacity * 4u));
  g_faceStart = static_cast<uint32_t*>(polyAlloc(faceCapacity * 4u));
  g_faceTri = static_cast<uint32_t*>(polyAlloc((T + 8u) * 4u));
  g_faceTriStart = static_cast<uint32_t*>(polyAlloc(faceCapacity * 4u));
  if (!g_faceRing || !g_faceStart || !g_faceTri || !g_faceTriStart) return -16;
  g_faceCount = 0;
  g_faceRingCount = 0;
  g_faceTriCount = 0;
  g_faceStart[0] = 0;
  g_faceTriStart[0] = 0;

  /* Room for every side of every face: the rings are bounded by ringCapacity. */
  g_edgePair = static_cast<uint64_t*>(polyAlloc(ringCapacity * 8u));
  if (!g_edgePair) return -16;

  auto pushFace = [&](const uint32_t* ring, uint32_t ringLen,
                      const uint32_t* tris, uint32_t triLen) -> bool {
    if (g_faceCount + 1u >= faceCapacity) return false;
    if (g_faceRingCount + ringLen > ringCapacity) return false;
    if (g_faceTriCount + triLen > T + 8u) return false;
    for (uint32_t i = 0; i < ringLen; ++i) {
      const uint32_t a = ring[i], b = ring[(i + 1u) % ringLen];
      if (a == b) continue;
      g_edgePair[g_edgePairCount++] = (static_cast<uint64_t>(a < b ? a : b) << 32) |
                                      (a < b ? b : a);
    }
    if (ringLen == 3u) ++g_kindCount[0];
    else if (ringLen == 4u) ++g_kindCount[1];
    else ++g_kindCount[2];
    for (uint32_t i = 0; i < ringLen; ++i) g_faceRing[g_faceRingCount + i] = ring[i];
    g_faceRingCount += ringLen;
    for (uint32_t i = 0; i < triLen; ++i) g_faceTri[g_faceTriCount + i] = tris[i];
    g_faceTriCount += triLen;
    ++g_faceCount;
    g_faceStart[g_faceCount] = g_faceRingCount;
    g_faceTriStart[g_faceCount] = g_faceTriCount;
    return true;
  };

  /* ---- 4a. the faces the app declared ---------------------------------- */
  if (hasDeclared) {
    /* Per-ring frame: the Newell normal, the centroid, and the 2D projection a
     * centroid test is done in. Mirrors ringFrame / ringClaimsTriangle in the
     * edit kernel. */
    struct Frame { float nx, ny, nz, d, eps; uint32_t axis; uint8_t valid; };
    Frame* frames = static_cast<Frame*>(polyAlloc((F + 1u) * sizeof(Frame)));
    uint32_t* ringIdStart = static_cast<uint32_t*>(polyAlloc((F + 2u) * 4u));
    uint32_t* ringIds = static_cast<uint32_t*>(polyAlloc((g_declRingCount + 4u) * 4u));
    float* ringU = static_cast<float*>(polyAlloc((g_declRingCount + 4u) * 4u));
    float* ringV = static_cast<float*>(polyAlloc((g_declRingCount + 4u) * 4u));
    if (!frames || !ringIdStart || !ringIds || !ringU || !ringV) return -17;

    uint32_t cursor = 0;
    for (uint32_t f = 0; f < F; ++f) {
      frames[f].valid = 0;
      ringIdStart[f] = cursor;
      const uint32_t s = g_declStart[f], e = g_declStart[f + 1];
      const uint32_t n = (e > s && e <= g_declRingCount) ? (e - s) : 0;
      if (n < 3) { ringIdStart[f + 1] = cursor; continue; }
      for (uint32_t i = 0; i < n; ++i) {
        const uint32_t slot = g_declRing[s + i];
        ringIds[cursor + i] = slot < V ? weldOfSlot[slot] : POLY_NO_FACE;
      }
      cursor += n;
      ringIdStart[f + 1] = cursor;

      float nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
      Vec3 p, q;
      const uint32_t base = ringIdStart[f];
      for (uint32_t i = 0; i < n; ++i) {
        pointOf(g_weldRep, g_pos, ringIds[base + i], p);
        pointOf(g_weldRep, g_pos, ringIds[base + (i + 1u) % n], q);
        nx += (p.y - q.y) * (p.z + q.z);
        ny += (p.z - q.z) * (p.x + q.x);
        nz += (p.x - q.x) * (p.y + q.y);
        cx += p.x; cy += p.y; cz += p.z;
      }
      const float inv = 1.0f / static_cast<float>(n);
      cx *= inv; cy *= inv; cz *= inv;
      const float len = sqrtf(nx * nx + ny * ny + nz * nz);
      if (!(len > 1e-9f)) continue;
      nx /= len; ny /= len; nz /= len;
      float extent = 0;
      for (uint32_t i = 0; i < n; ++i) {
        pointOf(g_weldRep, g_pos, ringIds[base + i], p);
        const float dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
        const float r = sqrtf(dx * dx + dy * dy + dz * dz);
        if (r > extent) extent = r;
      }
      if (!(extent > 1e-9f)) continue;

      const float ax = absf(nx), ay = absf(ny), az = absf(nz);
      const uint32_t axis = (az >= ax && az >= ay) ? 0u : (ay >= ax ? 1u : 2u);
      for (uint32_t i = 0; i < n; ++i) {
        pointOf(g_weldRep, g_pos, ringIds[base + i], p);
        ringU[base + i] = (axis == 2u) ? p.y : p.x;
        ringV[base + i] = (axis == 0u) ? p.y : p.z;
      }
      frames[f].nx = nx; frames[f].ny = ny; frames[f].nz = nz;
      frames[f].d = nx * cx + ny * cy + nz * cz;
      frames[f].eps = extent * 1e-3f;
      frames[f].axis = axis;
      frames[f].valid = 1;
    }

    /* Which rings a welded vertex touches, so a triangle finds its candidates
     * through its own corners instead of scanning every face. */
    uint32_t* touchCount = static_cast<uint32_t*>(polyAlloc((W + 2u) * 4u));
    uint32_t* touchStart = static_cast<uint32_t*>(polyAlloc((W + 2u) * 4u));
    if (!touchCount || !touchStart) return -18;
    for (uint32_t v = 0; v < W; ++v) touchCount[v] = 0;
    for (uint32_t f = 0; f < F; ++f) {
      if (!frames[f].valid) continue;
      const uint32_t s = ringIdStart[f], e = ringIdStart[f + 1];
      uint32_t prev = POLY_NO_FACE;
      for (uint32_t i = s; i < e; ++i) {
        const uint32_t id = ringIds[i];
        if (id >= W || id == prev) continue;   /* a repeated corner is one touch */
        prev = id;
        ++touchCount[id];
      }
    }
    uint32_t running = 0;
    for (uint32_t v = 0; v < W; ++v) { touchStart[v] = running; running += touchCount[v]; }
    touchStart[W] = running;
    uint32_t* touchFlat = static_cast<uint32_t*>(polyAlloc((running + 1u) * 4u));
    uint32_t* touchCursor = static_cast<uint32_t*>(polyAlloc((W + 2u) * 4u));
    if (!touchFlat || !touchCursor) return -18;
    for (uint32_t v = 0; v < W; ++v) touchCursor[v] = touchStart[v];
    for (uint32_t f = 0; f < F; ++f) {
      if (!frames[f].valid) continue;
      const uint32_t s = ringIdStart[f], e = ringIdStart[f + 1];
      uint32_t prev = POLY_NO_FACE;
      for (uint32_t i = s; i < e; ++i) {
        const uint32_t id = ringIds[i];
        if (id >= W || id == prev) continue;
        prev = id;
        touchFlat[touchCursor[id]++] = f;
      }
    }

    auto claimsTriangle = [&](uint32_t t, uint32_t f) -> bool {
      const Frame& frame = frames[f];
      if (!frame.valid) return false;
      const uint32_t a = corners[t * 3], b = corners[t * 3 + 1], c = corners[t * 3 + 2];
      const uint32_t s = ringIdStart[f], e = ringIdStart[f + 1];
      /* 1. the triangle's corners are the ring's own corners. */
      bool allCorners = true;
      const uint32_t tri[3] = {a, b, c};
      for (uint32_t want : tri) {
        bool found = false;
        for (uint32_t i = s; i < e; ++i) if (ringIds[i] == want) { found = true; break; }
        if (!found) { allCorners = false; break; }
      }
      if (allCorners) return true;
      /* 2. it lies in the ring's plane and its centroid is inside the ring,
       *    which is the fan a cap hides behind its middle vertex. */
      Vec3 p;
      for (uint32_t id : tri) {
        pointOf(g_weldRep, g_pos, id, p);
        const float side = frame.nx * p.x + frame.ny * p.y + frame.nz * p.z - frame.d;
        if (side > frame.eps || side < -frame.eps) return false;
      }
      Vec3 pa, pb, pc;
      pointOf(g_weldRep, g_pos, a, pa);
      pointOf(g_weldRep, g_pos, b, pb);
      pointOf(g_weldRep, g_pos, c, pc);
      const float u = (frame.axis == 2u)
        ? (pa.x + pb.x + pc.x) / 3.0f
        : (pa.x + pb.x + pc.x) / 3.0f;
      const float v3x = (pa.x + pb.x + pc.x) / 3.0f;
      const float v3y = (pa.y + pb.y + pc.y) / 3.0f;
      const float v3z = (pa.z + pb.z + pc.z) / 3.0f;
      const float uu = (frame.axis == 2u) ? v3y : v3x;
      const float vv = (frame.axis == 0u) ? v3y : v3z;
      (void)u;
      bool inside = false;
      const uint32_t n = e - s;
      for (uint32_t i = 0, j = n - 1u; i < n; j = i++) {
        const float yi = ringV[s + i], yj = ringV[s + j];
        if ((yi > vv) == (yj > vv)) continue;
        const float k = (vv - yi) / (yj - yi);
        if (uu < ringU[s + i] + k * (ringU[s + j] - ringU[s + i])) inside = !inside;
      }
      return inside;
    };

    uint32_t* claimCount = static_cast<uint32_t*>(polyAlloc((F + 2u) * 4u));
    uint32_t* claimStart = static_cast<uint32_t*>(polyAlloc((F + 2u) * 4u));
    uint32_t* claimCursor = static_cast<uint32_t*>(polyAlloc((F + 2u) * 4u));
    uint32_t* triedAt = static_cast<uint32_t*>(polyAlloc((F + 2u) * 4u));
    if (!claimCount || !claimStart || !claimCursor || !triedAt) return -19;
    for (uint32_t f = 0; f < F; ++f) { claimCount[f] = 0; triedAt[f] = POLY_NO_FACE; }

    for (uint32_t t = 0; t < T; ++t) {
      if (degenerate[t]) continue;
      uint32_t group = POLY_NO_FACE;
      for (uint32_t k = 0; k < 3 && group == POLY_NO_FACE; ++k) {
        const uint32_t id = corners[t * 3 + k];
        if (id >= W) continue;
        for (uint32_t at = touchStart[id]; at < touchStart[id + 1]; ++at) {
          const uint32_t f = touchFlat[at];
          if (triedAt[f] == t) continue;
          triedAt[f] = t;
          if (claimsTriangle(t, f)) { group = f; break; }
        }
      }
      if (group == POLY_NO_FACE) continue;
      claimed[t] = 1;
      claimGroup[t] = group;
      ++claimCount[group];
    }

    uint32_t run = 0;
    for (uint32_t f = 0; f < F; ++f) { claimStart[f] = run; claimCursor[f] = run; run += claimCount[f]; }
    claimStart[F] = run;
    uint32_t* claimFlat = static_cast<uint32_t*>(polyAlloc((run + 1u) * 4u));
    if (!claimFlat) return -19;
    for (uint32_t t = 0; t < T; ++t) {
      if (!claimed[t]) continue;
      claimFlat[claimCursor[claimGroup[t]]++] = t;
    }

    for (uint32_t f = 0; f < F; ++f) {
      const uint32_t first = claimStart[f], last = claimCursor[f];
      if (last <= first || !frames[f].valid) continue;
      const uint32_t n = ringIdStart[f + 1] - ringIdStart[f];
      if (n < 3) continue;
      if (!pushFace(&ringIds[ringIdStart[f]], n, &claimFlat[first], last - first)) return -20;
    }
  }

  /* ---- 4b. pairs of triangles that are one quad ------------------------- */
  Candidate* candidates = static_cast<Candidate*>(polyAlloc((edgeCount + 1u) * sizeof(Candidate)));
  if (!candidates) return -21;
  uint32_t candidateCount = 0;

  auto dist2 = [&](uint32_t a, uint32_t b) {
    Vec3 pa, pb;
    pointOf(g_weldRep, g_pos, a, pa);
    pointOf(g_weldRep, g_pos, b, pb);
    const float dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z;
    return dx * dx + dy * dy + dz * dz;
  };
  auto normalDot = [&](uint32_t t0, uint32_t t1) {
    return normals[t0 * 3] * normals[t1 * 3] +
           normals[t0 * 3 + 1] * normals[t1 * 3 + 1] +
           normals[t0 * 3 + 2] * normals[t1 * 3 + 2];
  };
  /* The shared edge is a quad's diagonal when it is the longest side of both
   * triangles: in a rectangle the diagonal is the hypotenuse, and the sides two
   * quads share are shorter than the diagonals that touch them. The 2% tolerance
   * stops a deformation that brings a side close to the diagonal's length from
   * tearing the face in two. */
  auto diagonalEdge = [&](uint32_t t0, uint32_t t1, uint32_t a, uint32_t b) {
    const float limit = dist2(a, b) * 1.02f;
    const uint32_t pair[2] = {t0, t1};
    for (uint32_t t : pair) {
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v = corners[t * 3 + k];
        const uint32_t w = corners[t * 3 + ((k + 1u) % 3u)];
        if ((v == a && w == b) || (v == b && w == a)) continue;
        if (dist2(v, w) > limit) return false;
      }
    }
    return true;
  };
  /* Convexity: going round a-c-b-d every turn has to bend the same way, so the
   * four corners enclose a real quad and not a folded or arrow-shaped one. */
  auto convex = [&](uint32_t a, uint32_t c, uint32_t b, uint32_t d) {
    Vec3 quad[4];
    pointOf(g_weldRep, g_pos, a, quad[0]);
    pointOf(g_weldRep, g_pos, c, quad[1]);
    pointOf(g_weldRep, g_pos, b, quad[2]);
    pointOf(g_weldRep, g_pos, d, quad[3]);
    const float ux = quad[2].x - quad[0].x, uy = quad[2].y - quad[0].y, uz = quad[2].z - quad[0].z;
    const float vx = quad[3].x - quad[1].x, vy = quad[3].y - quad[1].y, vz = quad[3].z - quad[1].z;
    const float nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const float normalLength = sqrtf(nx * nx + ny * ny + nz * nz);
    if (!(normalLength > 1e-12f)) return false;
    int positive = 0, counted = 0;
    for (uint32_t i = 0; i < 4; ++i) {
      const Vec3& p0 = quad[i];
      const Vec3& p1 = quad[(i + 1u) % 4u];
      const Vec3& p2 = quad[(i + 2u) % 4u];
      const float wx = p1.x - p0.x, wy = p1.y - p0.y, wz = p1.z - p0.z;
      const float zx = p2.x - p1.x, zy = p2.y - p1.y, zz = p2.z - p1.z;
      const float cx = wy * zz - wz * zy, cy = wz * zx - wx * zz, cz = wx * zy - wy * zx;
      const float length = sqrtf(cx * cx + cy * cy + cz * cz);
      if (length < 1e-12f) continue;
      ++counted;
      if ((cx * nx + cy * ny + cz * nz) / length > 0.0f) ++positive;
    }
    return counted >= 3 && (positive == 0 || positive == counted);
  };

  for (uint32_t e = 0; e < edgeCount; ++e) {
    const Edge& edge = edges[e];
    if (edge.t1 == POLY_NO_FACE || edge.t1 == POLY_NON_MANIFOLD) continue;
    const uint32_t t0 = edge.t0, t1 = edge.t1;
    const float dot = normalDot(t0, t1);
    if (!(dot >= COS_FLAT)) {
      if (dot < COS_QUAD) continue;
      if (!diagonalEdge(t0, t1, edge.a, edge.b)) continue;
    }
    Candidate& candidate = candidates[candidateCount++];
    candidate.a = edge.a;
    candidate.b = edge.b;
    candidate.t0 = t0;
    candidate.t1 = t1;
    candidate.len = dist2(edge.a, edge.b);
  }

  if (candidateCount > 1) {
    Candidate* scratch = static_cast<Candidate*>(polyAlloc(candidateCount * sizeof(Candidate)));
    if (!scratch) return -21;
    sortCandidates(candidates, scratch, candidateCount);
  }

  for (uint32_t i = 0; i < candidateCount; ++i) {
    const Candidate& candidate = candidates[i];
    const uint32_t t0 = candidate.t0, t1 = candidate.t1;
    if (done[t0] || done[t1] || claimed[t0] || claimed[t1] || degenerate[t0] || degenerate[t1]) continue;
    auto apex = [&](uint32_t t) -> uint32_t {
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v = corners[t * 3 + k];
        if (v != candidate.a && v != candidate.b) return v;
      }
      return POLY_NO_FACE;
    };
    const uint32_t c = apex(t0), d = apex(t1);
    if (c == POLY_NO_FACE || d == POLY_NO_FACE || c == d) continue;
    if (!convex(candidate.a, c, candidate.b, d)) continue;
    done[t0] = 1;
    done[t1] = 1;
    const uint32_t ring[4] = { candidate.a, c, candidate.b, d };
    const uint32_t tris[2] = { t0, t1 };
    if (!pushFace(ring, 4, tris, 2)) return -22;
  }

  /* ---- 4c. what is left is a triangle --------------------------------- */
  for (uint32_t t = 0; t < T; ++t) {
    if (done[t] || claimed[t] || degenerate[t]) continue;
    const uint32_t ring[3] = { corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2] };
    if (!pushFace(ring, 3, &t, 1)) return -22;
  }

  /* The ring sides arrive face after face, so a shared edge is in the list
   * twice. Sorting and keeping the first of each run is the cheapest dedupe
   * there is - no table, no allocation, and the result is in a fixed order so
   * the wireframe a mesh draws is the same on every run. */
  sortKeys(g_edgePair, g_edgePairCount);
  uint32_t unique = 0;
  for (uint32_t i = 0; i < g_edgePairCount; ++i) {
    if (unique > 0 && g_edgePair[unique - 1u] == g_edgePair[i]) continue;
    g_edgePair[unique++] = g_edgePair[i];
  }
  g_edgePairCount = unique;

  return static_cast<int32_t>(g_faceCount);
}

} // extern "C"
