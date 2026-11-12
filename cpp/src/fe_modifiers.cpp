#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

/* =========================================================================
 * Geometry modifier kernels (C++20, freestanding wasm)
 *
 * The JS editor only marshals buffers: it writes an indexed triangle mesh into
 * the session, calls one kernel, and uploads the returned positions/uv/indices.
 * Weld, Laplacian smoothing, mirror, solidify, displacement, wave, cast, twist,
 * array, subdivision and decimation all run here.
 *
 * Session memory comes from the core scratch arena. fe_mod_begin() resets the
 * arena first, so a modifier evaluation owns the whole 24 MB while it runs.
 * ========================================================================= */

extern "C" void fe_arena_reset(void);

namespace {

using namespace fe;

/* Deformation kernels can additionally request a target mesh, a binding and an
 * FFD cage, so keep 2 MB of the 24 MB arena as headroom instead of 6 MB. */
constexpr uint32_t MOD_ARENA_BUDGET = 22u * 1024u * 1024u;
constexpr uint32_t MOD_MAX_VERTS = 131072u;
constexpr uint32_t MOD_MAX_TRIS = 262144u;

uint32_t g_mod_used = 0;

inline void* modAlloc(uint32_t bytes) {
  if (bytes == 0) return nullptr;
  const uint32_t aligned = (bytes + 15u) & ~15u;
  if (g_mod_used + aligned > MOD_ARENA_BUDGET) return nullptr;
  const uint32_t ptr = fe_malloc(aligned);
  if (ptr == 0) return nullptr;
  g_mod_used += aligned;
  return reinterpret_cast<void*>(static_cast<uintptr_t>(ptr));
}

template <typename T>
inline T* modArray(uint32_t count) {
  return static_cast<T*>(modAlloc(count * static_cast<uint32_t>(sizeof(T))));
}


struct ModSession {
  bool ready = false;
  bool hasUv = false;
  uint32_t vcap = 0, tcap = 0, vc = 0, tc = 0;
  float* inPos = nullptr;
  float* inUv = nullptr;
  float* inNrm = nullptr;      /* the normals the mesh arrived with */
  uint32_t* inIdx = nullptr;
  /* Per-face shading, 1 = smooth / 0 = flat, one byte per triangle. The whole
     point of carrying it here is that a modifier is not allowed to decide how
     the model is shaded: a flat-shaded cube subdivided four times is four
     thousand small flat facets, not a sphere. */
  uint8_t* inSmooth = nullptr;
  uint8_t* outSmooth = nullptr;
  uint32_t flagMode = 0;       /* 0 = this kernel does not keep the flags */
  float* outPos = nullptr;
  float* outUv = nullptr;
  uint32_t* outIdx = nullptr;
  float* nrm = nullptr;
  uint32_t* counts = nullptr;
  /* Deformation kernels share the session arena: 4x4 relative matrix, an
   * optional target mesh, the surface-deform binding and the FFD cage. */
  float* matrix = nullptr;
  float* tgtPos = nullptr;
  uint32_t* tgtIdx = nullptr;
  float* tgtUv = nullptr;
  float* tgtWorld = nullptr;
  uint32_t* tgtCounts = nullptr;
  uint32_t* sdOrd = nullptr;
  float* sdBary = nullptr;
  float* sdScalars = nullptr;
  uint32_t* sdTris = nullptr;
  uint32_t sdBound = 0;
  uint32_t sdTriN = 0;
  float* latRest = nullptr;
  float* latDef = nullptr;
  uint32_t latN = 0;
  /* The active vertex group's weight per vertex, 0..1. A modifier that has a
     vertex_group reads it; kernels that do not are not allowed to care. vgOn
     is 0 when no group was uploaded, which is the "no group" case upstream
     spells as dvert == nullptr: the factor then has no effect at all. */
  float* vg = nullptr;
  uint32_t vgOn = 0;
};

ModSession g_s;

inline uint32_t hashU32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

inline uint32_t nextPow2(uint32_t v) {
  uint32_t p = 16;
  while (p < v) p <<= 1;
  return p;
}

struct SplitEdges {
  uint64_t* key = nullptr;
  uint32_t* a = nullptr;
  uint32_t* b = nullptr;
  uint32_t* f0 = nullptr;
  uint32_t* f1 = nullptr;
  uint8_t* nf = nullptr;
  uint8_t* split = nullptr;
  uint32_t mask = 0;
};

bool splitEdgesInit(SplitEdges& e, uint32_t triCount) {
  const uint32_t cap = nextPow2(triCount * 3u + 8u);
  e.key = modArray<uint64_t>(cap);
  e.a = modArray<uint32_t>(cap);
  e.b = modArray<uint32_t>(cap);
  e.f0 = modArray<uint32_t>(cap);
  e.f1 = modArray<uint32_t>(cap);
  e.nf = modArray<uint8_t>(cap);
  e.split = modArray<uint8_t>(cap);
  if (!e.key || !e.a || !e.b || !e.f0 || !e.f1 || !e.nf || !e.split) return false;
  for (uint32_t i = 0; i < cap; ++i) { e.nf[i] = 0u; e.split[i] = 0u; }
  e.mask = cap - 1u;
  return true;
}

inline uint32_t splitEdgeSlot(const SplitEdges& e, uint32_t va, uint32_t vb, bool insert,
                              uint32_t tri, bool* added) {
  const uint32_t lo = va < vb ? va : vb, hi = va < vb ? vb : va;
  const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
  uint32_t i = hashU32(lo * 2654435761u ^ hi * 2246822519u) & e.mask;
  for (uint32_t probe = 0; probe <= e.mask; ++probe) {
    if (e.nf[i] == 0u) {
      if (!insert) return 0xFFFFFFFFu;
      e.key[i] = key; e.a[i] = va; e.b[i] = vb;
      e.f0[i] = tri; e.f1[i] = 0xFFFFFFFFu; e.nf[i] = 1u;
      if (added) *added = true;
      return i;
    }
    if (e.key[i] == key) {
      if (insert) {
        if (e.nf[i] == 1u) { e.f1[i] = tri; e.nf[i] = 2u; }
        else if (e.nf[i] < 255u) { e.nf[i] = static_cast<uint8_t>(e.nf[i] + 1u); }
      }
      return i;
    }
    i = (i + 1u) & e.mask;
  }
  return 0xFFFFFFFFu;
}

inline Vec3 readPos(const float* p, uint32_t i) { return {p[i * 3], p[i * 3 + 1], p[i * 3 + 2]}; }
inline void writePos(float* p, uint32_t i, const Vec3& v) {
  p[i * 3] = v.x; p[i * 3 + 1] = v.y; p[i * 3 + 2] = v.z;
}

struct Box {
  Vec3 lo{1e30f, 1e30f, 1e30f};
  Vec3 hi{-1e30f, -1e30f, -1e30f};
  void expand(const Vec3& p) { lo = minv(lo, p); hi = maxv(hi, p); }
  Vec3 size() const { return hi - lo; }
  Vec3 center() const { return (lo + hi) * 0.5f; }
};

Box meshBounds(const float* p, uint32_t n) {
  Box b;
  for (uint32_t i = 0; i < n; ++i) b.expand(readPos(p, i));
  return b;
}

/* Area-weighted vertex normals, matching BufferGeometry.computeVertexNormals. */
void computeNormals(const float* pos, const uint32_t* idx, uint32_t vCount, uint32_t triCount, float* out) {
  for (uint32_t i = 0; i < vCount * 3u; ++i) out[i] = 0.0f;
  for (uint32_t t = 0; t < triCount; ++t) {
    const uint32_t a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a >= vCount || b >= vCount || c >= vCount) continue;
    const Vec3 pa = readPos(pos, a), pb = readPos(pos, b), pc = readPos(pos, c);
    const Vec3 n = cross(pb - pa, pc - pa);
    writePos(out, a, readPos(out, a) + n);
    writePos(out, b, readPos(out, b) + n);
    writePos(out, c, readPos(out, c) + n);
  }
  for (uint32_t i = 0; i < vCount; ++i) writePos(out, i, normalize(readPos(out, i)));
}

/* Writes the per-face flags into the normals the caller will read: every corner
   of a flat face points along that face. A vertex shared between a flat face and
   a face with a different normal has to become two vertices - the split every
   modeller does when it hands out a normal per corner - and that is what this
   allocates, in the same buffers, while the vertex budget lasts. Past it the
   face normals are written where the corners already are: an all-flat mesh still
   looks right (its corners all agree), and a mixed one is only wrong on the
   edge between the two, instead of losing the whole shading. */
uint32_t applyFaceShading(uint32_t v, uint32_t t) {
  if (!g_s.inSmooth || t == 0) return v;
  static float fn[3 * 4096];
  float* faceN = fn;
  if (t > 4096u) {
    /* Fall back to a re-read of the face normal when the mesh is large: the
       split below only needs the face it is on, so nothing is stored. */
    faceN = nullptr;
  }
  auto normalAt = [&](uint32_t f, float& nx, float& ny, float& nz) {
    const uint32_t a = g_s.inIdx[f * 3], b = g_s.inIdx[f * 3 + 1], c = g_s.inIdx[f * 3 + 2];
    const Vec3 pa = readPos(g_s.inPos, a), pb = readPos(g_s.inPos, b), pc = readPos(g_s.inPos, c);
    const Vec3 n = normalize(cross(pb - pa, pc - pa));
    nx = n.x; ny = n.y; nz = n.z;
  };
  if (faceN) {
    for (uint32_t f = 0; f < t; ++f) normalAt(f, faceN[f * 3], faceN[f * 3 + 1], faceN[f * 3 + 2]);
  }

  /* How many triangles actually need their corners broken away. */
  uint32_t needed = 0;
  for (uint32_t f = 0; f < t; ++f) {
    if (g_s.inSmooth[f]) continue;
    float nx, ny, nz;
    if (faceN) { nx = faceN[f * 3]; ny = faceN[f * 3 + 1]; nz = faceN[f * 3 + 2]; }
    else normalAt(f, nx, ny, nz);
    bool split = false;
    for (uint32_t k = 0; k < 3 && !split; ++k) {
      const uint32_t c = g_s.inIdx[f * 3 + k];
      const float dot = nx * g_s.nrm[c * 3] + ny * g_s.nrm[c * 3 + 1] + nz * g_s.nrm[c * 3 + 2];
      if (dot < 0.9995f) split = true;
    }
    if (split) ++needed;
  }

  if (needed == 0) {
    /* Nothing to break apart: write the face normal where each flat corner
       already is. Coplanar neighbours agree, so this is exact. */
    for (uint32_t f = 0; f < t; ++f) {
      if (g_s.inSmooth[f]) continue;
      float nx, ny, nz;
      if (faceN) { nx = faceN[f * 3]; ny = faceN[f * 3 + 1]; nz = faceN[f * 3 + 2]; }
      else normalAt(f, nx, ny, nz);
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t c = g_s.inIdx[f * 3 + k];
        g_s.nrm[c * 3] = nx; g_s.nrm[c * 3 + 1] = ny; g_s.nrm[c * 3 + 2] = nz;
      }
    }
    return v;
  }

  if (v + needed * 3u > g_s.vcap || v + needed * 3u > MOD_MAX_VERTS) {
    /* No room to split: still shade the flat faces flat. */
    for (uint32_t f = 0; f < t; ++f) {
      if (g_s.inSmooth[f]) continue;
      float nx, ny, nz;
      if (faceN) { nx = faceN[f * 3]; ny = faceN[f * 3 + 1]; nz = faceN[f * 3 + 2]; }
      else normalAt(f, nx, ny, nz);
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t c = g_s.inIdx[f * 3 + k];
        g_s.nrm[c * 3] = nx; g_s.nrm[c * 3 + 1] = ny; g_s.nrm[c * 3 + 2] = nz;
      }
    }
    return v;
  }

  uint32_t next = v;
  for (uint32_t f = 0; f < t; ++f) {
    if (g_s.inSmooth[f]) continue;
    float nx, ny, nz;
    if (faceN) { nx = faceN[f * 3]; ny = faceN[f * 3 + 1]; nz = faceN[f * 3 + 2]; }
    else normalAt(f, nx, ny, nz);
    bool split = false;
    for (uint32_t k = 0; k < 3 && !split; ++k) {
      const uint32_t c = g_s.inIdx[f * 3 + k];
      const float dot = nx * g_s.nrm[c * 3] + ny * g_s.nrm[c * 3 + 1] + nz * g_s.nrm[c * 3 + 2];
      if (dot < 0.9995f) split = true;
    }
    if (!split) {
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t c = g_s.inIdx[f * 3 + k];
        g_s.nrm[c * 3] = nx; g_s.nrm[c * 3 + 1] = ny; g_s.nrm[c * 3 + 2] = nz;
      }
      continue;
    }
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t c = g_s.inIdx[f * 3 + k];
      const uint32_t nv = next++;
      g_s.inPos[nv * 3] = g_s.inPos[c * 3];
      g_s.inPos[nv * 3 + 1] = g_s.inPos[c * 3 + 1];
      g_s.inPos[nv * 3 + 2] = g_s.inPos[c * 3 + 2];
      if (g_s.hasUv) {
        g_s.inUv[nv * 2] = g_s.inUv[c * 2];
        g_s.inUv[nv * 2 + 1] = g_s.inUv[c * 2 + 1];
      }
      g_s.nrm[nv * 3] = nx; g_s.nrm[nv * 3 + 1] = ny; g_s.nrm[nv * 3 + 2] = nz;
      g_s.inIdx[f * 3 + k] = nv;
    }
  }
  return next;
}

/* The UV of an unchanged vertex, for the kernels that move only some of them. */
inline bool copyUv(uint32_t i) {
  if (!g_s.hasUv) return false;
  g_s.outUv[i * 2] = g_s.inUv[i * 2];
  g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1];
  return true;
}

void copyOutToIn(uint32_t v, uint32_t t) {
  for (uint32_t i = 0; i < v * 3u; ++i) g_s.inPos[i] = g_s.outPos[i];
  if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.inUv[i] = g_s.outUv[i];
  for (uint32_t i = 0; i < t * 3u; ++i) g_s.inIdx[i] = g_s.outIdx[i];
  if (g_s.inSmooth && g_s.outSmooth) for (uint32_t i = 0; i < t; ++i) g_s.inSmooth[i] = g_s.outSmooth[i];
  g_s.vc = v;
  g_s.tc = t;
}

int32_t commit(uint32_t v, uint32_t t) {
  if (v == 0 || t == 0) return -4;
  if (v > g_s.vcap || t > g_s.tcap) return -2;
  copyOutToIn(v, t);
  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  /* The normal-split pass: a kernel that kept the flags hands out split normals
     here, so every caller - the viewport, the next modifier, the exporter -
     reads shading the way the model was authored. */
  if (g_s.flagMode) v = applyFaceShading(v, t);
  g_s.vc = v;
  g_s.counts[0] = v;
  g_s.counts[1] = t;
  return 0;
}

/* ---- Vertex weld map (open addressing) ---- */
struct WeldMap {
  int32_t* cx;
  int32_t* cy;
  int32_t* cz;
  uint32_t* slot; /* 0 = empty, else unique + 1 */
  uint32_t mask;
  uint32_t unique;
};

bool weldMapInit(WeldMap& m, uint32_t vertexCount) {
  const uint32_t cap = nextPow2(vertexCount * 2u + 8u);
  m.cx = modArray<int32_t>(cap);
  m.cy = modArray<int32_t>(cap);
  m.cz = modArray<int32_t>(cap);
  m.slot = modArray<uint32_t>(cap);
  if (!m.cx || !m.cy || !m.cz || !m.slot) return false;
  for (uint32_t i = 0; i < cap; ++i) { m.cx[i] = 0; m.cy[i] = 0; m.cz[i] = 0; m.slot[i] = 0; }
  m.mask = cap - 1u;
  m.unique = 0;
  return true;
}

inline int32_t quantize(float v, float inv) {
  return static_cast<int32_t>(floorf(v * inv + 0.5f));
}

/* Weld the session mesh from input into output. `sel`, when given, is
   mesh_merge_by_distance_all()'s IndexMask: only the selected vertices enter
   the KD-tree, so an unselected vertex can neither be merged nor absorb
   another one. It keeps its own position and its own slot. */
int32_t weldSession(float epsilon, uint32_t* outV, uint32_t* outT, uint32_t* remap,
                    const uint8_t* sel = nullptr) {
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (v == 0 || t == 0) return -3;
  const float eps = epsilon > 1e-9f ? epsilon : 1e-9f;
  const float inv = 1.0f / eps;

  WeldMap map;
  if (!weldMapInit(map, v)) return -2;
  uint32_t newV = 0;
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    if (sel && !sel[i]) {
      /* Out of the mask: untouched, and invisible to the merge. */
      const uint32_t id = newV++;
      writePos(g_s.outPos, id, p);
      if (g_s.hasUv) { g_s.outUv[id * 2] = g_s.inUv[i * 2]; g_s.outUv[id * 2 + 1] = g_s.inUv[i * 2 + 1]; }
      remap[i] = id;
      continue;
    }
    const int32_t qx = quantize(p.x, inv), qy = quantize(p.y, inv), qz = quantize(p.z, inv);
    uint32_t slot = hashU32(static_cast<uint32_t>(qx) * 73856093u ^
                            static_cast<uint32_t>(qy) * 19349663u ^
                            static_cast<uint32_t>(qz) * 83492791u) & map.mask;
    for (;;) {
      if (map.slot[slot] == 0) {
        map.slot[slot] = ++map.unique;
        map.cx[slot] = qx; map.cy[slot] = qy; map.cz[slot] = qz;
        const uint32_t id = newV++;
        writePos(g_s.outPos, id, p);
        if (g_s.hasUv) { g_s.outUv[id * 2] = g_s.inUv[i * 2]; g_s.outUv[id * 2 + 1] = g_s.inUv[i * 2 + 1]; }
        remap[i] = id;
        break;
      }
      if (map.cx[slot] == qx && map.cy[slot] == qy && map.cz[slot] == qz) {
        remap[i] = map.slot[slot] - 1u;
        break;
      }
      slot = (slot + 1u) & map.mask;
    }
  }

  uint32_t newT = 0;
  for (uint32_t i = 0; i < t; ++i) {
    const uint32_t a = remap[g_s.inIdx[i * 3]], b = remap[g_s.inIdx[i * 3 + 1]], c = remap[g_s.inIdx[i * 3 + 2]];
    if (a == b || b == c || c == a) continue;
    g_s.outIdx[newT * 3] = a; g_s.outIdx[newT * 3 + 1] = b; g_s.outIdx[newT * 3 + 2] = c;
    if (g_s.outSmooth && g_s.inSmooth) g_s.outSmooth[newT] = g_s.inSmooth[i];
    ++newT;
  }
  if (newV == 0 || newT == 0) return -4;
  *outV = newV; *outT = newT;
  return 0;
}

/* Weld's Connected mode, ported from mesh_merge_by_distance_connected() in
 * geometry/intern/mesh_merge_verts.cc. It does not look for coincident points
 * at all: it walks the edges and collapses the ones shorter than the
 * distance, carrying a running weighted centre for each cluster:
 *
 *   influence = (merged_b + 1) / (merged_a + merged_b + 2)
 *   co_a += (co_b - co_a) * influence
 *
 * so a fan of short edges ends up as the average of everything it absorbed
 * rather than as whichever vertex happened to come first. */
int32_t weldConnectedSession(float epsilon, uint32_t* outV, uint32_t* outT, uint32_t* remap,
                             const uint8_t* sel = nullptr) {
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (v == 0 || t == 0) return -3;
  const float eps = epsilon > 1e-9f ? epsilon : 1e-9f;
  const float eps2 = eps * eps;
  uint32_t* parent = modArray<uint32_t>(v);
  uint32_t* merged = modArray<uint32_t>(v);
  float* co = modArray<float>(v * 3u);
  if (!parent || !merged || !co) return -2;
  for (uint32_t i = 0; i < v; ++i) {
    parent[i] = i;
    merged[i] = 0u;
    writePos(co, i, readPos(g_s.inPos, i));
  }
  auto rootOf = [&](uint32_t i) -> uint32_t {
    while (parent[i] != i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  SplitEdges se;
  if (!splitEdgesInit(se, t)) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      splitEdgeSlot(se, g_s.inIdx[f * 3 + k], g_s.inIdx[f * 3 + (k + 1u) % 3u], true, f, nullptr);
    }
  }
  for (uint32_t sIdx = 0; sIdx <= se.mask; ++sIdx) {
    if (!se.nf[sIdx]) continue;
    uint32_t v1 = rootOf(se.a[sIdx]), v2 = rootOf(se.b[sIdx]);
    if (v1 == v2) continue;
    /* mesh_merge_by_distance_connected(): an edge with an end outside the
       selection does not collapse, tested on the cluster roots. */
    if (sel && (!sel[v1] || !sel[v2])) continue;
    if (v1 > v2) { const uint32_t tmp = v1; v1 = v2; v2 = tmp; }
    const Vec3 d = readPos(co, v2) - readPos(co, v1);
    if (length_sq(d) > eps2) continue;
    const float influence = static_cast<float>(merged[v2] + 1u) /
                            static_cast<float>(merged[v1] + merged[v2] + 2u);
    writePos(co, v1, readPos(co, v1) + d * influence);
    merged[v1] += merged[v2] + 1u;
    parent[v2] = v1;
  }
  /* Compact: a cluster keeps the slot of its smallest vertex, which is its
     root, so the roots are met in increasing order and remap is ready. */
  uint32_t newV = 0;
  for (uint32_t i = 0; i < v; ++i) {
    if (rootOf(i) != i) continue;
    if (newV >= g_s.vcap) return -2;
    writePos(g_s.outPos, newV, readPos(co, i));
    if (g_s.hasUv) { g_s.outUv[newV * 2] = g_s.inUv[i * 2]; g_s.outUv[newV * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    remap[i] = newV++;
  }
  uint32_t newT = 0;
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t a = remap[rootOf(g_s.inIdx[f * 3])];
    const uint32_t b = remap[rootOf(g_s.inIdx[f * 3 + 1])];
    const uint32_t c = remap[rootOf(g_s.inIdx[f * 3 + 2])];
    if (a == b || b == c || c == a) continue;
    g_s.outIdx[newT * 3] = a; g_s.outIdx[newT * 3 + 1] = b; g_s.outIdx[newT * 3 + 2] = c;
    if (g_s.outSmooth && g_s.inSmooth) g_s.outSmooth[newT] = g_s.inSmooth[f];
    ++newT;
  }
  if (newV == 0 || newT == 0) return -4;
  *outV = newV; *outT = newT;
  return 0;
}

/* ---- Unique edge table (parallel arrays, count == 0 marks a free slot) ---- */
struct EdgeTable {
  uint64_t* key = nullptr;
  uint32_t* a = nullptr;
  uint32_t* b = nullptr;
  uint32_t* count = nullptr;
  uint32_t* tri = nullptr; /* optional */
  uint32_t mask = 0;
};

bool edgeTableInit(EdgeTable& t, uint32_t triCount, bool wantTri) {
  const uint32_t cap = nextPow2(triCount * 3u + 8u);
  t.key = modArray<uint64_t>(cap);
  t.a = modArray<uint32_t>(cap);
  t.b = modArray<uint32_t>(cap);
  t.count = modArray<uint32_t>(cap);
  t.tri = wantTri ? modArray<uint32_t>(cap) : nullptr;
  if (!t.key || !t.a || !t.b || !t.count || (wantTri && !t.tri)) return false;
  for (uint32_t i = 0; i < cap; ++i) t.count[i] = 0;
  t.mask = cap - 1u;
  return true;
}

bool edgeTableAdd(EdgeTable& t, uint32_t va, uint32_t vb, uint32_t tri) {
  const uint32_t lo = va < vb ? va : vb, hi = va < vb ? vb : va;
  const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
  uint32_t i = hashU32(lo * 2654435761u ^ hi * 2246822519u) & t.mask;
  for (uint32_t probe = 0; probe <= t.mask; ++probe) {
    if (t.count[i] == 0) {
      t.count[i] = 1;
      t.key[i] = key;
      t.a[i] = va; t.b[i] = vb;
      if (t.tri) t.tri[i] = tri;
      return true;
    }
    if (t.key[i] == key) {
      if (t.count[i] < 0xFFFFu) t.count[i]++;
      return true;
    }
    i = (i + 1u) & t.mask;
  }
  return false;
}

/* How many faces use this edge: the wireframe has to know whether the edge a
   loop is walking is on the border before it adds a boundary strip. */
uint32_t edgeTableCount(const EdgeTable& t, uint32_t va, uint32_t vb) {
  const uint32_t lo = va < vb ? va : vb, hi = va < vb ? vb : va;
  const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
  uint32_t i = hashU32(lo * 2654435761u ^ hi * 2246822519u) & t.mask;
  for (uint32_t probe = 0; probe <= t.mask; ++probe) {
    if (t.count[i] == 0) return 0u;
    if (t.key[i] == key) return t.count[i];
    i = (i + 1u) & t.mask;
  }
  return 0u;
}

/* Same lookup, but hands back the first face that used the edge; the solidify
   angle clamp needs the pair of faces either side of a manifold edge. */
uint32_t edgeTableFind(const EdgeTable& t, uint32_t va, uint32_t vb, uint32_t& first) {
  const uint32_t lo = va < vb ? va : vb, hi = va < vb ? vb : va;
  const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
  uint32_t i = hashU32(lo * 2654435761u ^ hi * 2246822519u) & t.mask;
  for (uint32_t probe = 0; probe <= t.mask; ++probe) {
    if (t.count[i] == 0) return 0u;
    if (t.key[i] == key) { first = t.tri ? t.tri[i] : 0u; return t.count[i]; }
    i = (i + 1u) & t.mask;
  }
  return 0u;
}

/* ---- Value noise (freestanding, deterministic) ---- */
inline float noiseHash(int32_t x, int32_t y, int32_t z, uint32_t seed) {
  const uint32_t h = static_cast<uint32_t>(x) * 374761393u ^ static_cast<uint32_t>(y) * 668265263u ^
                     static_cast<uint32_t>(z) * 2147483647u ^ (seed * 1274126177u);
  return static_cast<float>(hashU32(h) & 0xFFFFFFu) * (1.0f / 16777216.0f);
}

float valueNoise3(float x, float y, float z, uint32_t seed) {
  const float fx = floorf(x), fy = floorf(y), fz = floorf(z);
  const int32_t ix = static_cast<int32_t>(fx), iy = static_cast<int32_t>(fy), iz = static_cast<int32_t>(fz);
  const float tx = x - fx, ty = y - fy, tz = z - fz;
  const float sx = tx * tx * (3.0f - 2.0f * tx);
  const float sy = ty * ty * (3.0f - 2.0f * ty);
  const float sz = tz * tz * (3.0f - 2.0f * tz);
  float v = 0.0f;
  for (int32_t dz = 0; dz < 2; ++dz)
    for (int32_t dy = 0; dy < 2; ++dy)
      for (int32_t dx = 0; dx < 2; ++dx) {
        const float w = (dx ? sx : 1.0f - sx) * (dy ? sy : 1.0f - sy) * (dz ? sz : 1.0f - sz);
        v += noiseHash(ix + dx, iy + dy, iz + dz, seed) * w;
      }
  return v;
}

float fbm3(float x, float y, float z, uint32_t seed, uint32_t octaves) {
  float sum = 0.0f, amp = 0.5f, norm = 0.0f;
  const uint32_t n = octaves < 1u ? 1u : (octaves > 6u ? 6u : octaves);
  for (uint32_t o = 0; o < n; ++o) {
    sum += valueNoise3(x, y, z, seed + o * 101u) * amp;
    norm += amp;
    x *= 2.03f; y *= 2.01f; z *= 1.99f;
    amp *= 0.5f;
  }
  return norm > 0.0f ? sum / norm : 0.0f;
}

inline Vec3 axisVector(uint32_t axis) {
  if (axis == 1) return {1.0f, 0.0f, 0.0f};
  if (axis == 2) return {0.0f, 0.0f, 1.0f};
  return {0.0f, 1.0f, 0.0f};
}

inline Vec3 rotateAxis(const Vec3& v, const Vec3& axis, float angle) {
  const float c = cosf(angle), s = sinf(angle);
  return v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0f - c));
}

/* Loop vertex rule: q = (1 - n*beta) * p + beta * sum(neighbours) with
   beta = 3/16 for valence 3 and 3/(8n) otherwise. Midpoint vertices sit
   symmetrically between their neighbours, so flat faces stay flat and a cube
   keeps its corners, while curved surfaces round off like the Loop limit. */
int32_t loopRelax() {
  const uint32_t v = g_s.vc, t = g_s.tc;
  EdgeTable edges;
  if (!edgeTableInit(edges, t, false)) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    if (!edgeTableAdd(edges, g_s.inIdx[f * 3], g_s.inIdx[f * 3 + 1], f)) return -2;
    if (!edgeTableAdd(edges, g_s.inIdx[f * 3 + 1], g_s.inIdx[f * 3 + 2], f)) return -2;
    if (!edgeTableAdd(edges, g_s.inIdx[f * 3 + 2], g_s.inIdx[f * 3], f)) return -2;
  }
  float* acc = modArray<float>(v * 3u);
  uint32_t* cnt = modArray<uint32_t>(v);
  float* next = modArray<float>(v * 3u);
  if (!acc || !cnt || !next) return -2;
  for (uint32_t i = 0; i < v; ++i) {
    cnt[i] = 0;
    writePos(acc, i, Vec3(0.0f, 0.0f, 0.0f));
    writePos(next, i, readPos(g_s.inPos, i));
  }
  for (uint32_t s2 = 0; s2 <= edges.mask; ++s2) {
    if (edges.count[s2] == 0) continue;
    const uint32_t a = edges.a[s2], b = edges.b[s2];
    writePos(acc, a, readPos(acc, a) + readPos(g_s.inPos, b));
    writePos(acc, b, readPos(acc, b) + readPos(g_s.inPos, a));
    cnt[a]++; cnt[b]++;
  }
  for (uint32_t i = 0; i < v; ++i) {
    const uint32_t n = cnt[i];
    if (!n) continue;
    const float beta = n == 3u ? 0.1875f : 3.0f / (8.0f * static_cast<float>(n));
    const Vec3 p = readPos(g_s.inPos, i);
    writePos(next, i, p * (1.0f - static_cast<float>(n) * beta) + readPos(acc, i) * beta);
  }
  for (uint32_t i = 0; i < v * 3u; ++i) g_s.inPos[i] = next[i];
  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  return 0;
}


/* =========================================================================
 * Deformation kernels: FFD lattice, dual-quaternion armature, surface deform
 * and shrinkwrap. All per-vertex maths lives here; JS only marshals buffers.
 * ========================================================================= */

/* Column-major 4x4 matrix matching THREE.Matrix4.elements. */
struct Mat4 { float e[16]; };

inline Mat4 matIdentity() {
  Mat4 m{};
  m.e[0] = m.e[5] = m.e[10] = m.e[15] = 1.0f;
  return m;
}

inline Mat4 matMultiply(const Mat4& a, const Mat4& b) {
  Mat4 o{};
  for (uint32_t c = 0; c < 4u; ++c) {
    for (uint32_t r = 0; r < 4u; ++r) {
      float sum = 0.0f;
      for (uint32_t k = 0; k < 4u; ++k) sum += a.e[k * 4u + r] * b.e[c * 4u + k];
      o.e[c * 4u + r] = sum;
    }
  }
  return o;
}

/* invert_m4_m4(): the adjugate over the determinant, column-major like the
   rest of this file. Returns false for a singular matrix, which upstream
   tolerates by leaving the identity in place. */
inline bool matInvert(const Mat4& m, Mat4& out) {
  const float* a = m.e;
  float inv[16];
  inv[0]  =  a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10];
  inv[4]  = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10];
  inv[8]  =  a[4]*a[9]*a[15]  - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9];
  inv[12] = -a[4]*a[9]*a[14]  + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9];
  inv[1]  = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10];
  inv[5]  =  a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10];
  inv[9]  = -a[0]*a[9]*a[15]  + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9];
  inv[13] =  a[0]*a[9]*a[14]  - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9];
  inv[2]  =  a[1]*a[6]*a[15]  - a[1]*a[7]*a[14]  - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7]  - a[13]*a[3]*a[6];
  inv[6]  = -a[0]*a[6]*a[15]  + a[0]*a[7]*a[14]  + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7]  + a[12]*a[3]*a[6];
  inv[10] =  a[0]*a[5]*a[15]  - a[0]*a[7]*a[13]  - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7]  - a[12]*a[3]*a[5];
  inv[14] = -a[0]*a[5]*a[14]  + a[0]*a[6]*a[13]  + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6]  + a[12]*a[2]*a[5];
  inv[3]  = -a[1]*a[6]*a[11]  + a[1]*a[7]*a[10]  + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7]   + a[9]*a[3]*a[6];
  inv[7]  =  a[0]*a[6]*a[11]  - a[0]*a[7]*a[10]  - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7]   - a[8]*a[3]*a[6];
  inv[11] = -a[0]*a[5]*a[11]  + a[0]*a[7]*a[9]   + a[4]*a[1]*a[11] - a[4]*a[3]*a[9]  - a[8]*a[1]*a[7]   + a[8]*a[3]*a[5];
  inv[15] =  a[0]*a[5]*a[10]  - a[0]*a[6]*a[9]   - a[4]*a[1]*a[10] + a[4]*a[2]*a[9]  + a[8]*a[1]*a[6]   - a[8]*a[2]*a[5];
  const float det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12];
  if (absf(det) < 1e-20f) { out = matIdentity(); return false; }
  const float invDet = 1.0f / det;
  for (uint32_t i = 0; i < 16u; ++i) out.e[i] = inv[i] * invDet;
  return true;
}

inline Vec3 matPoint(const Mat4& m, const Vec3& p) {
  return {
    m.e[0] * p.x + m.e[4] * p.y + m.e[8] * p.z + m.e[12],
    m.e[1] * p.x + m.e[5] * p.y + m.e[9] * p.z + m.e[13],
    m.e[2] * p.x + m.e[6] * p.y + m.e[10] * p.z + m.e[14]
  };
}

Mat4 sessionMatrix() {
  Mat4 m = matIdentity();
  if (g_s.matrix) for (uint32_t i = 0; i < 16u; ++i) m.e[i] = g_s.matrix[i];
  return m;
}

void transformTargetWorld() {
  const uint32_t verts = g_s.tgtCounts ? g_s.tgtCounts[0] : 0u;
  if (!verts || !g_s.tgtPos || !g_s.tgtWorld) return;
  const Mat4 m = sessionMatrix();
  for (uint32_t i = 0; i < verts; ++i) writePos(g_s.tgtWorld, i, matPoint(m, readPos(g_s.tgtPos, i)));
}

/* Ericson, Real-Time Collision Detection: closest point on a triangle. */
Vec3 closestPointTriangle(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
  const Vec3 ab = b - a, ac = c - a, ap = p - a;
  const float d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0.0f && d2 <= 0.0f) return a;
  const Vec3 bp = p - b;
  const float d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0.0f && d4 <= d3) return b;
  const float vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0f && d1 >= 0.0f && d3 <= 0.0f) {
    const float denom = d1 - d3;
    return a + ab * (absf(denom) > 1e-20f ? d1 / denom : 0.0f);
  }
  const Vec3 cp = p - c;
  const float d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0.0f && d5 <= d6) return c;
  const float vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0f && d2 >= 0.0f && d6 <= 0.0f) {
    const float denom = d2 - d6;
    return a + ac * (absf(denom) > 1e-20f ? d2 / denom : 0.0f);
  }
  const float va = d3 * d6 - d5 * d4;
  if (va <= 0.0f && (d4 - d3) >= 0.0f && (d5 - d6) >= 0.0f) {
    const float denom = (d4 - d3) + (d5 - d6);
    return b + (c - b) * (absf(denom) > 1e-20f ? (d4 - d3) / denom : 0.0f);
  }
  const float denom = va + vb + vc;
  if (absf(denom) < 1e-20f) return a;
  const float inv = 1.0f / denom;
  return a + ab * (vb * inv) + ac * (vc * inv);
}

/* Three.js Triangle.getBarycoord ordering: returns (weight_a, weight_b, weight_c). */
Vec3 barycentricCoords(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
  const Vec3 v0 = c - a, v1 = b - a, v2 = p - a;
  const float d00 = dot(v0, v0), d01 = dot(v0, v1), d02 = dot(v0, v2);
  const float d11 = dot(v1, v1), d12 = dot(v1, v2);
  const float denom = d00 * d11 - d01 * d01;
  if (absf(denom) < 1e-20f) return {1.0f, 0.0f, 0.0f};
  const float inv = 1.0f / denom;
  const float u = (d11 * d02 - d01 * d12) * inv;
  const float v = (d00 * d12 - d01 * d02) * inv;
  return {1.0f - u - v, v, u};
}

inline float powi(float x, uint32_t n) {
  float r = 1.0f;
  for (uint32_t i = 0; i < n; ++i) r *= x;
  return r;
}

float bernstein(uint32_t n, uint32_t i, float t) {
  t = clampf(t, 0.0f, 1.0f);
  float binom = 1.0f;
  for (uint32_t k = 1; k <= i; ++k) binom *= static_cast<float>(n - k + 1u) / static_cast<float>(k);
  return binom * powi(1.0f - t, n - i) * powi(t, i);
}

/* Squared distance from p to the triangle AABB for broadphase rejection. */
inline float triangleBoxDistanceSq(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
  const float loX = minf(a.x, minf(b.x, c.x)), hiX = maxf(a.x, maxf(b.x, c.x));
  const float loY = minf(a.y, minf(b.y, c.y)), hiY = maxf(a.y, maxf(b.y, c.y));
  const float loZ = minf(a.z, minf(b.z, c.z)), hiZ = maxf(a.z, maxf(b.z, c.z));
  const float dx = p.x < loX ? loX - p.x : (p.x > hiX ? p.x - hiX : 0.0f);
  const float dy = p.y < loY ? loY - p.y : (p.y > hiY ? p.y - hiY : 0.0f);
  const float dz = p.z < loZ ? loZ - p.z : (p.z > hiZ ? p.z - hiZ : 0.0f);
  return dx * dx + dy * dy + dz * dz;
}

inline uint32_t readTriIndex(const uint32_t* idx, uint32_t tri, uint32_t corner) {
  return idx ? idx[tri * 3u + corner] : tri * 3u + corner;
}

int32_t latticeCageFromBounds(uint32_t nx, uint32_t ny, uint32_t nz, float padRatio) {
  nx = nx < 1u ? 1u : (nx > 4u ? 4u : nx);
  ny = ny < 1u ? 1u : (ny > 4u ? 4u : ny);
  nz = nz < 1u ? 1u : (nz > 4u ? 4u : nz);
  if (g_s.vc == 0) return -4;
  const Box b = meshBounds(g_s.inPos, g_s.vc);
  const Vec3 size = b.size();
  float pad = length(size) * (padRatio > 0.0f ? padRatio : 0.04f);
  if (pad < 0.04f) pad = 0.04f;
  const uint32_t points = (nx + 1u) * (ny + 1u) * (nz + 1u);
  float* rest = modArray<float>(points * 3u);
  float* def = modArray<float>(points * 3u);
  if (!rest || !def) return -2;
  uint32_t w = 0;
  for (uint32_t k = 0; k <= nz; ++k) {
    const float tz = static_cast<float>(k) / static_cast<float>(nz);
    for (uint32_t j = 0; j <= ny; ++j) {
      const float ty = static_cast<float>(j) / static_cast<float>(ny);
      for (uint32_t i = 0; i <= nx; ++i) {
        const float tx = static_cast<float>(i) / static_cast<float>(nx);
        rest[w++] = b.lo.x - pad + (size.x + pad * 2.0f) * tx;
        rest[w++] = b.lo.y - pad + (size.y + pad * 2.0f) * ty;
        rest[w++] = b.lo.z - pad + (size.z + pad * 2.0f) * tz;
      }
    }
  }
  for (uint32_t i = 0; i < points * 3u; ++i) def[i] = rest[i];
  g_s.latRest = rest;
  g_s.latDef = def;
  g_s.latN = points;
  return static_cast<int32_t>(points);
}

int32_t latticeApply(uint32_t nx, uint32_t ny, uint32_t nz, float strength) {
  if (!g_s.latRest || !g_s.latDef) return -3;
  nx = nx < 1u ? 1u : (nx > 4u ? 4u : nx);
  ny = ny < 1u ? 1u : (ny > 4u ? 4u : ny);
  nz = nz < 1u ? 1u : (nz > 4u ? 4u : nz);
  const uint32_t points = (nx + 1u) * (ny + 1u) * (nz + 1u);
  if (points != g_s.latN) return -3;
  Box b;
  for (uint32_t i = 0; i < points; ++i) b.expand(readPos(g_s.latRest, i));
  const Vec3 size(
    maxf(b.hi.x - b.lo.x, 1e-5f),
    maxf(b.hi.y - b.lo.y, 1e-5f),
    maxf(b.hi.z - b.lo.z, 1e-5f)
  );
  const Mat4 m = sessionMatrix();
  float* defWorld = modArray<float>(points * 3u);
  if (!defWorld) return -2;
  for (uint32_t i = 0; i < points; ++i) writePos(defWorld, i, matPoint(m, readPos(g_s.latDef, i)));
  const float blend = clampf(strength, 0.0f, 2.0f);
  for (uint32_t v = 0; v < g_s.vc; ++v) {
    const Vec3 p = readPos(g_s.inPos, v);
    const float u = clampf((p.x - b.lo.x) / size.x, 0.0f, 1.0f);
    const float w = clampf((p.y - b.lo.y) / size.y, 0.0f, 1.0f);
    const float t = clampf((p.z - b.lo.z) / size.z, 0.0f, 1.0f);
    float fx = 0.0f, fy = 0.0f, fz = 0.0f;
    for (uint32_t k = 0; k <= nz; ++k) {
      const float bz = bernstein(nz, k, t);
      for (uint32_t j = 0; j <= ny; ++j) {
        const float by = bernstein(ny, j, w);
        for (uint32_t i = 0; i <= nx; ++i) {
          const float weight = bernstein(nx, i, u) * by * bz;
          const uint32_t id = (i + (nx + 1u) * (j + (ny + 1u) * k)) * 3u;
          fx += defWorld[id] * weight;
          fy += defWorld[id + 1u] * weight;
          fz += defWorld[id + 2u] * weight;
        }
      }
    }
    writePos(g_s.outPos, v, Vec3(
      p.x + (fx - p.x) * blend,
      p.y + (fy - p.y) * blend,
      p.z + (fz - p.z) * blend
    ));
  }
  computeNormals(g_s.outPos, g_s.inIdx, g_s.vc, g_s.tc, g_s.nrm);
  return commit(g_s.vc, g_s.tc);
}

int32_t armatureApply(float influence, int32_t preserveVolume, float bendDeg, float twistDeg) {
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v) return -4;
  const float inf = clampf(influence, 0.0f, 1.0f);
  if (inf <= 1e-6f) {
    for (uint32_t i = 0; i < v; ++i) writePos(g_s.outPos, i, readPos(g_s.inPos, i));
    computeNormals(g_s.outPos, g_s.inIdx, v, t, g_s.nrm);
    return commit(v, t);
  }
  const Box b = meshBounds(g_s.inPos, v);
  const float minY = b.lo.y, maxY = b.hi.y;
  const float spanY = maxf(maxY - minY, 1e-4f);
  const float midY = minY + spanY * 0.5f;
  const Vec3 center = b.center();

  const float bendRad = bendDeg * kDeg2Rad * inf;
  const float twistRad = twistDeg * kDeg2Rad * inf;

  Mat4 pivotToOrigin = matIdentity();
  pivotToOrigin.e[12] = -center.x;
  pivotToOrigin.e[13] = -midY;
  pivotToOrigin.e[14] = -center.z;
  Mat4 originToPivot = matIdentity();
  originToPivot.e[12] = center.x;
  originToPivot.e[13] = midY;
  originToPivot.e[14] = center.z;
  Mat4 bend = matIdentity();
  bend.e[0] = cosf(bendRad);  bend.e[1] = sinf(bendRad);
  bend.e[4] = -sinf(bendRad); bend.e[5] = cosf(bendRad);
  Mat4 twist = matIdentity();
  twist.e[0] = cosf(twistRad); twist.e[2] = -sinf(twistRad);
  twist.e[8] = sinf(twistRad); twist.e[10] = cosf(twistRad);

  const Mat4 bone = matMultiply(
    sessionMatrix(),
    matMultiply(
      matMultiply(originToPivot, bend),
      matMultiply(twist, pivotToOrigin)
    )
  );

  const float* e = bone.e;
  const float trace = e[0] + e[5] + e[10];
  float qx, qy, qz, qw;
  if (trace > 0.0f) {
    const float s = 0.5f / sqrtf(trace + 1.0f);
    qw = 0.25f / s; qx = (e[6] - e[9]) * s; qy = (e[8] - e[2]) * s; qz = (e[1] - e[4]) * s;
  } else if (e[0] > e[5] && e[0] > e[10]) {
    const float s = 2.0f * sqrtf(1.0f + e[0] - e[5] - e[10]);
    qw = (e[6] - e[9]) / s; qx = 0.25f * s; qy = (e[4] + e[1]) / s; qz = (e[8] + e[2]) / s;
  } else if (e[5] > e[10]) {
    const float s = 2.0f * sqrtf(1.0f + e[5] - e[0] - e[10]);
    qw = (e[8] - e[2]) / s; qx = (e[4] + e[1]) / s; qy = 0.25f * s; qz = (e[9] + e[6]) / s;
  } else {
    const float s = 2.0f * sqrtf(1.0f + e[10] - e[0] - e[5]);
    qw = (e[1] - e[4]) / s; qx = (e[8] + e[2]) / s; qy = (e[9] + e[6]) / s; qz = 0.25f * s;
  }
  {
    const float qLen = sqrtf(qx * qx + qy * qy + qz * qz + qw * qw);
    const float inv = qLen > 1e-8f ? 1.0f / qLen : 1.0f;
    qx *= inv; qy *= inv; qz *= inv; qw *= inv;
    if (qw < 0.0f) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
  }
  const float tx = e[12], ty = e[13], tz = e[14];
  const float dqx = 0.5f * (tx * qw + ty * qz - tz * qy);
  const float dqy = 0.5f * (-tx * qz + ty * qw + tz * qx);
  const float dqz = 0.5f * (tx * qy - ty * qx + tz * qw);
  const float dqw = 0.5f * (-tx * qx - ty * qy - tz * qz);

  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const float tNorm = clampf((p.y - minY) / spanY, 0.0f, 1.0f);
    const float w1 = tNorm * tNorm * (3.0f - 2.0f * tNorm);
    const float w0 = 1.0f - w1;
    if (!preserveVolume) {
      const Vec3 moved = matPoint(bone, p);
      writePos(g_s.outPos, i, lerpv(p, moved, w1));
      continue;
    }
    float rx = qx * w1, ry = qy * w1, rz = qz * w1, rw = w0 + qw * w1;
    float ex = dqx * w1, ey = dqy * w1, ez = dqz * w1, ew = dqw * w1;
    const float n = sqrtf(rx * rx + ry * ry + rz * rz + rw * rw);
    const float invN = 1.0f / (n > 1e-8f ? n : 1.0f);
    rx *= invN; ry *= invN; rz *= invN; rw *= invN;
    ex *= invN; ey *= invN; ez *= invN; ew *= invN;
    const float btx = 2.0f * (-ew * rx + ex * rw - ey * rz + ez * ry);
    const float bty = 2.0f * (-ew * ry + ex * rz + ey * rw - ez * rx);
    const float btz = 2.0f * (-ew * rz - ex * ry + ey * rx + ez * rw);
    const float ix = rw * p.x + ry * p.z - rz * p.y;
    const float iy = rw * p.y + rz * p.x - rx * p.z;
    const float iz = rw * p.z + rx * p.y - ry * p.x;
    const float iw = -rx * p.x - ry * p.y - rz * p.z;
    writePos(g_s.outPos, i, Vec3(
      ix * rw + iw * -rx + iy * -rz - iz * -ry + btx,
      iy * rw + iw * -ry + iz * -rx - ix * -rz + bty,
      iz * rw + iw * -rz + ix * -ry - iy * -rx + btz
    ));
  }
  computeNormals(g_s.outPos, g_s.inIdx, v, t, g_s.nrm);
  return commit(v, t);
}

int32_t shrinkwrapApply(uint32_t mode, float offset) {
  if (!g_s.tgtCounts || !g_s.tgtPos || !g_s.tgtIdx || !g_s.tgtWorld) return -3;
  const uint32_t tv = g_s.tgtCounts[0], tt = g_s.tgtCounts[1];
  if (tv < 3u || tt == 0u) return -3;
  transformTargetWorld();

  float* normals = modArray<float>(tt * 3u);
  float* scales = modArray<float>(tt);
  if (!normals || !scales) return -2;
  uint32_t validTris = 0;
  for (uint32_t tri = 0; tri < tt; ++tri) {
    const uint32_t ia = g_s.tgtIdx[tri * 3u], ib = g_s.tgtIdx[tri * 3u + 1u], ic = g_s.tgtIdx[tri * 3u + 2u];
    if (ia >= tv || ib >= tv || ic >= tv) { scales[tri] = 0.0f; continue; }
    const Vec3 a = readPos(g_s.tgtWorld, ia), b = readPos(g_s.tgtWorld, ib), c = readPos(g_s.tgtWorld, ic);
    const Vec3 cr = cross(b - a, c - a);
    const float len = length(cr);
    if (len <= 1e-10f) { scales[tri] = 0.0f; continue; }
    writePos(normals, tri, cr * (1.0f / len));
    scales[tri] = sqrtf(len * 0.5f);
    validTris++;
  }
  if (!validTris) return -4;

  for (uint32_t v = 0; v < g_s.vc; ++v) {
    const Vec3 q = readPos(g_s.inPos, v);
    float bestD = 1e30f;
    Vec3 best{0.0f, 0.0f, 0.0f};
    uint32_t bestTri = 0xFFFFFFFFu;
    for (uint32_t tri = 0; tri < tt; ++tri) {
      if (scales[tri] <= 0.0f) continue;
      const Vec3 a = readPos(g_s.tgtWorld, g_s.tgtIdx[tri * 3u]);
      const Vec3 b = readPos(g_s.tgtWorld, g_s.tgtIdx[tri * 3u + 1u]);
      const Vec3 c = readPos(g_s.tgtWorld, g_s.tgtIdx[tri * 3u + 2u]);
      if (triangleBoxDistanceSq(q, a, b, c) > bestD) continue;
      const Vec3 cp = closestPointTriangle(q, a, b, c);
      const float d = length_sq(q - cp);
      if (d < bestD) { bestD = d; best = cp; bestTri = tri; }
    }
    if (bestTri == 0xFFFFFFFFu) { writePos(g_s.outPos, v, q); continue; }
    Vec3 n = readPos(normals, bestTri);
    const Vec3 delta = q - best;
    if (mode == 2u && dot(delta, n) < 0.0f) n = n * -1.0f;
    if (mode == 1u) {
      if (dot(delta, n) < offset) writePos(g_s.outPos, v, best + n * offset);
      else writePos(g_s.outPos, v, q);
    } else {
      writePos(g_s.outPos, v, best + n * offset);
    }
  }
  computeNormals(g_s.outPos, g_s.inIdx, g_s.vc, g_s.tc, g_s.nrm);
  return commit(g_s.vc, g_s.tc);
}

int32_t surfaceDeformBind() {
  if (!g_s.tgtCounts || !g_s.tgtPos || !g_s.tgtIdx || !g_s.tgtWorld) return -3;
  const uint32_t tv = g_s.tgtCounts[0], tt = g_s.tgtCounts[1];
  if (tv < 3u || tt == 0u || g_s.vc == 0u) return -3;
  transformTargetWorld();

  uint32_t* triList = modArray<uint32_t>(tt * 3u);
  float* triNormals = modArray<float>(tt * 3u);
  float* triScale = modArray<float>(tt);
  if (!triList || !triNormals || !triScale) return -2;
  uint32_t kept = 0;
  for (uint32_t tri = 0; tri < tt; ++tri) {
    const uint32_t ia = g_s.tgtIdx[tri * 3u], ib = g_s.tgtIdx[tri * 3u + 1u], ic = g_s.tgtIdx[tri * 3u + 2u];
    if (ia >= tv || ib >= tv || ic >= tv) continue;
    const Vec3 a = readPos(g_s.tgtWorld, ia), b = readPos(g_s.tgtWorld, ib), c = readPos(g_s.tgtWorld, ic);
    const Vec3 cr = cross(b - a, c - a);
    const float len = length(cr);
    if (len <= 1e-10f) continue;
    triList[kept * 3u] = ia; triList[kept * 3u + 1u] = ib; triList[kept * 3u + 2u] = ic;
    writePos(triNormals, kept, cr * (1.0f / len));
    triScale[kept] = sqrtf(len * 0.5f);
    kept++;
  }
  if (kept == 0u) return -4;

  uint32_t* ord = modArray<uint32_t>(g_s.vc);
  float* bary = modArray<float>(g_s.vc * 3u);
  float* scalars = modArray<float>(g_s.vc * 2u);
  if (!ord || !bary || !scalars) return -2;

  for (uint32_t v = 0; v < g_s.vc; ++v) {
    const Vec3 q = readPos(g_s.inPos, v);
    float bestD = 1e30f;
    Vec3 best{0.0f, 0.0f, 0.0f};
    uint32_t bestTri = 0u;
    for (uint32_t k = 0; k < kept; ++k) {
      const Vec3 a = readPos(g_s.tgtWorld, triList[k * 3u]);
      const Vec3 b = readPos(g_s.tgtWorld, triList[k * 3u + 1u]);
      const Vec3 c = readPos(g_s.tgtWorld, triList[k * 3u + 2u]);
      if (triangleBoxDistanceSq(q, a, b, c) > bestD) continue;
      const Vec3 cp = closestPointTriangle(q, a, b, c);
      const float d = length_sq(q - cp);
      if (d < bestD) { bestD = d; best = cp; bestTri = k; }
    }
    const Vec3 bc = barycentricCoords(best, readPos(g_s.tgtWorld, triList[bestTri * 3u]),
      readPos(g_s.tgtWorld, triList[bestTri * 3u + 1u]), readPos(g_s.tgtWorld, triList[bestTri * 3u + 2u]));
    const Vec3 n = readPos(triNormals, bestTri);
    ord[v] = bestTri;
    bary[v * 3u] = bc.x; bary[v * 3u + 1u] = bc.y; bary[v * 3u + 2u] = bc.z;
    scalars[v * 2u] = dot(q - best, n);
    scalars[v * 2u + 1u] = maxf(triScale[bestTri], 1e-5f);
  }

  g_s.sdOrd = ord; g_s.sdBary = bary; g_s.sdScalars = scalars;
  g_s.sdTris = triList; g_s.sdTriN = kept; g_s.sdBound = g_s.vc;
  return 0;
}

int32_t surfaceDeformApply(float strength) {
  if (!g_s.sdOrd || !g_s.sdBary || !g_s.sdScalars || !g_s.sdTris) return -3;
  if (g_s.sdBound != g_s.vc || g_s.sdTriN == 0u) return -3;
  if (!g_s.tgtCounts || !g_s.tgtWorld) return -3;
  transformTargetWorld();
  const float blend = clampf(strength, 0.0f, 1.0f);
  for (uint32_t v = 0; v < g_s.vc; ++v) {
    const uint32_t t = g_s.sdOrd[v];
    if (t >= g_s.sdTriN) { writePos(g_s.outPos, v, readPos(g_s.inPos, v)); continue; }
    const Vec3 a = readPos(g_s.tgtWorld, g_s.sdTris[t * 3u]);
    const Vec3 b = readPos(g_s.tgtWorld, g_s.sdTris[t * 3u + 1u]);
    const Vec3 c = readPos(g_s.tgtWorld, g_s.sdTris[t * 3u + 2u]);
    Vec3 n = cross(b - a, c - a);
    const float len = length(n);
    const float refScale = maxf(g_s.sdScalars[v * 2u + 1u], 1e-5f);
    const float curScale = len > 1e-10f ? sqrtf(len * 0.5f) : refScale;
    if (len > 1e-10f) n = n * (1.0f / len); else n = Vec3(0.0f, 1.0f, 0.0f);
    const float ratio = clampf(curScale / refScale, 0.25f, 4.0f);
    const float bu = g_s.sdBary[v * 3u], bv = g_s.sdBary[v * 3u + 1u], bw = g_s.sdBary[v * 3u + 2u];
    const float off = g_s.sdScalars[v * 2u] * ratio;
    const Vec3 target(
      a.x * bu + b.x * bv + c.x * bw + n.x * off,
      a.y * bu + b.y * bv + c.y * bw + n.y * off,
      a.z * bu + b.z * bv + c.z * bw + n.z * off
    );
    const Vec3 p = readPos(g_s.inPos, v);
    writePos(g_s.outPos, v, lerpv(p, target, blend));
  }
  computeNormals(g_s.outPos, g_s.inIdx, g_s.vc, g_s.tc, g_s.nrm);
  return commit(g_s.vc, g_s.tc);
}


} // namespace


/* =========================================================================
 * Boolean - ported from mesh_boolean.cc's construction
 *
 *   source/blender/blenlib/intern/mesh_boolean.cc  (BLI_mesh_boolean)
 *   source/blender/modifiers/intern/MOD_boolean.cc
 *
 * Upstream's float solver does three things, and so does this:
 *
 *   1. find the pairs of triangles that intersect, with a BVH over each mesh
 *      (upstream's KDopBVH holds the same data);
 *   2. cut every intersecting triangle along the segment where it meets the
 *      other mesh, so the two surfaces share a boundary curve exactly;
 *   3. decide, for every resulting piece, whether its centre is inside the
 *      other mesh - by counting crossings of a ray - and keep the pieces the
 *      operation asks for. Difference keeps A outside B and B inside A, with
 *      B's winding reversed; Union keeps both outsides; Intersection both
 *      insides.
 *
 * Upstream's Exact solver uses GMP rationals and the floating solver here
 * mirrors the "Fast" one. Coplanar face pairs (two cubes sharing a wall) are
 * not special-cased: they are detected and left whole, which is what the fast
 * solver does too.
 *
 * Not ported: self-intersection (`use_self`), the hole-tolerant winding
 * numbers and material transfer.
 * ========================================================================= */
constexpr uint32_t BOOL_MAX_PIECES = 12u;
constexpr uint32_t BOOL_MAX_POLY_VERTS = 16u;

struct BoolBvh {
  float* lo = nullptr;        /* 3 per node */
  float* hi = nullptr;
  uint32_t* start = nullptr;  /* leaf: first triangle, internal: 0xFFFFFFFF */
  uint32_t* count = nullptr;  /* leaf: triangle count */
  uint32_t* right = nullptr;  /* internal: right child; left is node + 1 */
  uint32_t* order = nullptr;
  uint32_t nodes = 0, tn = 0;
};

inline void triBounds(const float* pos, const uint32_t* idx, uint32_t t, Vec3& lo, Vec3& hi) {
  const Vec3 a = readPos(pos, idx[t * 3]), b = readPos(pos, idx[t * 3 + 1]), c = readPos(pos, idx[t * 3 + 2]);
  lo = minv(minv(a, b), c);
  hi = maxv(maxv(a, b), c);
}

/* ---- quickselect on the centroid of a triangle along one axis ---- */
void selectTri(uint32_t* order, uint32_t lo, uint32_t hi, uint32_t k, const float* cen, uint32_t axis) {
  while (hi - lo > 1u) {
    const uint32_t mid = lo + (hi - lo) / 2u;
    /* median of three */
    const float a = cen[order[lo] * 3u + axis], b = cen[order[mid] * 3u + axis], c = cen[order[hi - 1u] * 3u + axis];
    const float pivot = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));
    uint32_t i = lo, j = hi - 1u;
    while (true) {
      while (cen[order[i] * 3u + axis] < pivot) ++i;
      while (cen[order[j] * 3u + axis] > pivot) { if (j == lo) break; --j; }
      if (i >= j) break;
      const uint32_t tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      ++i;
      if (j) --j;
    }
    const uint32_t split = i;
    if (k < split) hi = split;
    else if (k > split) lo = split;
    else return;
    if (hi <= lo + 1u) return;
  }
}

uint32_t bvhBuildNode(BoolBvh& b, uint32_t lo, uint32_t hi, const float* cen, const float* tlo, const float* thi) {
  const uint32_t node = b.nodes++;
  Vec3 blo(1e30f, 1e30f, 1e30f), bhi(-1e30f, -1e30f, -1e30f);
  for (uint32_t i = lo; i < hi; ++i) {
    const uint32_t t = b.order[i];
    blo = minv(blo, Vec3(tlo[t * 3], tlo[t * 3 + 1], tlo[t * 3 + 2]));
    bhi = maxv(bhi, Vec3(thi[t * 3], thi[t * 3 + 1], thi[t * 3 + 2]));
  }
  b.lo[node * 3] = blo.x; b.lo[node * 3 + 1] = blo.y; b.lo[node * 3 + 2] = blo.z;
  b.hi[node * 3] = bhi.x; b.hi[node * 3 + 1] = bhi.y; b.hi[node * 3 + 2] = bhi.z;
  if (hi - lo <= 4u) {
    b.start[node] = lo;
    b.count[node] = hi - lo;
    b.right[node] = 0xFFFFFFFFu;
    return node;
  }
  const Vec3 ext = bhi - blo;
  const uint32_t axis = ext.x >= ext.y ? (ext.x >= ext.z ? 0u : 2u) : (ext.y >= ext.z ? 1u : 2u);
  const uint32_t mid = lo + (hi - lo) / 2u;
  selectTri(b.order, lo, hi, mid, cen, axis);
  b.start[node] = 0xFFFFFFFFu;
  b.count[node] = 0;
  const uint32_t left = bvhBuildNode(b, lo, mid, cen, tlo, thi);
  (void)left;
  const uint32_t r = bvhBuildNode(b, mid, hi, cen, tlo, thi);
  b.right[node] = r;
  return node;
}

bool bvhBuild(BoolBvh& b, const float* pos, const uint32_t* idx, uint32_t tn) {
  b.tn = tn;
  const uint32_t maxNodes = tn * 2u + 4u;
  b.lo = modArray<float>(maxNodes * 3u);
  b.hi = modArray<float>(maxNodes * 3u);
  b.start = modArray<uint32_t>(maxNodes);
  b.count = modArray<uint32_t>(maxNodes);
  b.right = modArray<uint32_t>(maxNodes);
  b.order = modArray<uint32_t>(tn);
  float* cen = modArray<float>(tn * 3u);
  float* tlo = modArray<float>(tn * 3u);
  float* thi = modArray<float>(tn * 3u);
  if (!b.lo || !b.hi || !b.start || !b.count || !b.right || !b.order || !cen || !tlo || !thi) return false;
  for (uint32_t t = 0; t < tn; ++t) {
    b.order[t] = t;
    Vec3 lo, hi;
    triBounds(pos, idx, t, lo, hi);
    tlo[t * 3] = lo.x; tlo[t * 3 + 1] = lo.y; tlo[t * 3 + 2] = lo.z;
    thi[t * 3] = hi.x; thi[t * 3 + 1] = hi.y; thi[t * 3 + 2] = hi.z;
    cen[t * 3] = (lo.x + hi.x) * 0.5f;
    cen[t * 3 + 1] = (lo.y + hi.y) * 0.5f;
    cen[t * 3 + 2] = (lo.z + hi.z) * 0.5f;
  }
  b.nodes = 0;
  bvhBuildNode(b, 0u, tn, cen, tlo, thi);
  return b.nodes > 0u;
}

inline bool boxHit(const float* lo, const float* hi, const Vec3& o, const Vec3& d, float tmax) {
  float t0 = 0.0f, t1 = tmax;
  for (uint32_t a = 0; a < 3u; ++a) {
    const float oa = a == 0u ? o.x : (a == 1u ? o.y : o.z);
    const float da = a == 0u ? d.x : (a == 1u ? d.y : d.z);
    const float la = lo[a], ha = hi[a];
    if (absf(da) < 1e-12f) {
      if (oa < la || oa > ha) return false;
    } else {
      const float inv = 1.0f / da;
      float tn = (la - oa) * inv, tf = (ha - oa) * inv;
      if (tn > tf) { const float tmp = tn; tn = tf; tf = tmp; }
      if (tn > t0) t0 = tn;
      if (tf < t1) t1 = tf;
      if (t0 > t1) return false;
    }
  }
  return true;
}

/* Möller-Trumbore, front and back faces. */
inline bool rayTri(const Vec3& o, const Vec3& d, const Vec3& a, const Vec3& b, const Vec3& c, float& tOut) {
  const Vec3 e1 = b - a, e2 = c - a;
  const Vec3 p = cross(d, e2);
  const float det = Vec3::dot(e1, p);
  if (absf(det) < 1e-12f) return false;
  const float inv = 1.0f / det;
  const Vec3 tv = o - a;
  const float u = Vec3::dot(tv, p) * inv;
  if (u < 0.0f || u > 1.0f) return false;
  const Vec3 q = cross(tv, e1);
  const float v = Vec3::dot(d, q) * inv;
  if (v < 0.0f || u + v > 1.0f) return false;
  tOut = Vec3::dot(e2, q) * inv;
  return tOut > 1e-6f;
}

/* How many triangles of the tree a ray crosses. */
uint32_t bvhHits(const BoolBvh& b, const float* pos, const uint32_t* idx, const Vec3& o, const Vec3& d) {
  uint32_t hits = 0;
  uint32_t stack[64];
  uint32_t sp = 0;
  stack[sp++] = 0u;
  while (sp) {
    const uint32_t n = stack[--sp];
    if (!boxHit(b.lo + n * 3u, b.hi + n * 3u, o, d, 1e30f)) continue;
    if (b.start[n] != 0xFFFFFFFFu) {
      for (uint32_t i = 0; i < b.count[n]; ++i) {
        const uint32_t t = b.order[b.start[n] + i];
        float tt;
        if (rayTri(o, d, readPos(pos, idx[t * 3]), readPos(pos, idx[t * 3 + 1]), readPos(pos, idx[t * 3 + 2]), tt)) ++hits;
      }
      continue;
    }
    if (sp + 2u < 64u) {
      stack[sp++] = n + 1u;
      stack[sp++] = b.right[n];
    }
  }
  return hits;
}

/* The segment where two triangles meet, or false when they do not. */
bool triTriSegment(const Vec3& a0, const Vec3& a1, const Vec3& a2,
                   const Vec3& b0, const Vec3& b1, const Vec3& b2, Vec3& s0, Vec3& s1) {
  const Vec3 nA = cross(a1 - a0, a2 - a0);
  const float lenA = nA.length();
  if (lenA < 1e-12f) return false;
  const Vec3 nA1 = nA * (1.0f / lenA);
  const float dA = Vec3::dot(nA1, a0);
  const Vec3 nB = cross(b1 - b0, b2 - b0);
  const float lenB = nB.length();
  if (lenB < 1e-12f) return false;
  const Vec3 nB1 = nB * (1.0f / lenB);
  const float dB = Vec3::dot(nB1, b0);

  const float da[3] = {Vec3::dot(nB1, a0) - dB, Vec3::dot(nB1, a1) - dB, Vec3::dot(nB1, a2) - dB};
  const float db[3] = {Vec3::dot(nA1, b0) - dA, Vec3::dot(nA1, b1) - dA, Vec3::dot(nA1, b2) - dA};
  if ((da[0] > 1e-7f && da[1] > 1e-7f && da[2] > 1e-7f) || (da[0] < -1e-7f && da[1] < -1e-7f && da[2] < -1e-7f)) return false;
  if ((db[0] > 1e-7f && db[1] > 1e-7f && db[2] > 1e-7f) || (db[0] < -1e-7f && db[1] < -1e-7f && db[2] < -1e-7f)) return false;

  const Vec3 A[3] = {a0, a1, a2};
  const Vec3 B[3] = {b0, b1, b2};
  /* The part of A on B's plane. */
  Vec3 pa[4];
  uint32_t nPA = 0;
  for (uint32_t i = 0; i < 3u; ++i) {
    const uint32_t j = (i + 1u) % 3u;
    if (absf(da[i]) < 1e-9f) { pa[nPA++] = A[i]; }
    if ((da[i] < 0.0f && da[j] > 0.0f) || (da[i] > 0.0f && da[j] < 0.0f)) {
      const float t = da[i] / (da[i] - da[j]);
      pa[nPA++] = A[i] + (A[j] - A[i]) * t;
    }
    if (nPA >= 4u) break;
  }
  if (nPA < 2u) return false;

  Vec3 pb[4];
  uint32_t nPB = 0;
  for (uint32_t i = 0; i < 3u; ++i) {
    const uint32_t j = (i + 1u) % 3u;
    if (absf(db[i]) < 1e-9f) { pb[nPB++] = B[i]; }
    if ((db[i] < 0.0f && db[j] > 0.0f) || (db[i] > 0.0f && db[j] < 0.0f)) {
      const float t = db[i] / (db[i] - db[j]);
      pb[nPB++] = B[i] + (B[j] - B[i]) * t;
    }
    if (nPB >= 4u) break;
  }
  if (nPB < 2u) return false;

  /* Both cuts lie on the planes' intersection line: compare their extents
     along it and keep the overlap. */
  Vec3 dir = cross(nA1, nB1);
  const float dl = dir.length();
  if (dl < 1e-9f) return false;   /* parallel (or coplanar) planes: left whole */
  dir = dir * (1.0f / dl);
  const Vec3 ref = pa[0];
  float loA = 1e30f, hiA = -1e30f;
  for (uint32_t i = 0; i < nPA; ++i) {
    const float t = Vec3::dot(pa[i] - ref, dir);
    loA = minf(loA, t); hiA = maxf(hiA, t);
  }
  float loB = 1e30f, hiB = -1e30f;
  for (uint32_t i = 0; i < nPB; ++i) {
    const float t = Vec3::dot(pb[i] - ref, dir);
    loB = minf(loB, t); hiB = maxf(hiB, t);
  }
  const float lo = maxf(loA, loB), hi = minf(hiA, hiB);
  if (hi - lo < 1e-7f) return false;
  s0 = ref + dir * lo;
  s1 = ref + dir * hi;
  return true;
}

/* A convex polygon in the plane of a triangle, as 2D points plus the
   barycentrics needed to carry the UV across a cut. */
struct BoolPoly {
  float x[BOOL_MAX_POLY_VERTS];
  float y[BOOL_MAX_POLY_VERTS];
  uint32_t n;
};

/* Split one convex polygon by the line through two 2D points. */
void polySplit(const BoolPoly& in, float ax, float ay, float bx, float by,
               BoolPoly& left, BoolPoly& right, bool& anyLeft, bool& anyRight) {
  const float dx = bx - ax, dy = by - ay;
  float s[BOOL_MAX_POLY_VERTS + 2];
  for (uint32_t i = 0; i < in.n; ++i) s[i] = dx * (in.y[i] - ay) - dy * (in.x[i] - ax);
  left.n = 0; right.n = 0;
  for (uint32_t i = 0; i < in.n; ++i) {
    const uint32_t j = (i + 1u) % in.n;
    const float si = s[i], sj = s[j];
    if (si >= -1e-9f && left.n < BOOL_MAX_POLY_VERTS) { left.x[left.n] = in.x[i]; left.y[left.n] = in.y[i]; ++left.n; }
    if (si <= 1e-9f && right.n < BOOL_MAX_POLY_VERTS) { right.x[right.n] = in.x[i]; right.y[right.n] = in.y[i]; ++right.n; }
    if ((si > 1e-9f && sj < -1e-9f) || (si < -1e-9f && sj > 1e-9f)) {
      const float t = si / (si - sj);
      const float px = in.x[i] + (in.x[j] - in.x[i]) * t;
      const float py = in.y[i] + (in.y[j] - in.y[i]) * t;
      if (left.n < BOOL_MAX_POLY_VERTS) { left.x[left.n] = px; left.y[left.n] = py; ++left.n; }
      if (right.n < BOOL_MAX_POLY_VERTS) { right.x[right.n] = px; right.y[right.n] = py; ++right.n; }
    }
  }
  anyLeft = left.n >= 3u;
  anyRight = right.n >= 3u;
}

template <typename Emit>
void boolCutTriangle(const Vec3& p0, const Vec3& p1, const Vec3& p2,
                     const float* uv0, const float* uv1, const float* uv2,
                     const Vec3* segA, const Vec3* segB, uint32_t segN,
                     Emit&& emit) {
  const Vec3 n = cross(p1 - p0, p2 - p0);
  const float len = n.length();
  Vec3 e1 = p1 - p0;
  if (len < 1e-12f || e1.length() < 1e-12f) return;
  const Vec3 nUnit = n * (1.0f / len);
  e1 = normalize(e1);
  const Vec3 e2 = cross(nUnit, e1);

  auto to2 = [&](const Vec3& p, float& x, float& y) {
    const Vec3 d = p - p0;
    x = Vec3::dot(d, e1);
    y = Vec3::dot(d, e2);
  };

  BoolPoly work[BOOL_MAX_PIECES * 2u];
  uint32_t workN = 1u;
  work[0].n = 3u;
  to2(p0, work[0].x[0], work[0].y[0]);
  to2(p1, work[0].x[1], work[0].y[1]);
  to2(p2, work[0].x[2], work[0].y[2]);

  for (uint32_t sgi = 0; sgi < segN && workN < BOOL_MAX_PIECES * 2u; ++sgi) {
    float ax, ay, bx, by;
    to2(segA[sgi], ax, ay);
    to2(segB[sgi], bx, by);
    if ((ax - bx) * (ax - bx) + (ay - by) * (ay - by) < 1e-14f) continue;

    BoolPoly next[BOOL_MAX_PIECES * 2u];
    uint32_t nextN = 0;
    for (uint32_t i = 0; i < workN; ++i) {
      BoolPoly left, right;
      bool anyLeft = false, anyRight = false;
      polySplit(work[i], ax, ay, bx, by, left, right, anyLeft, anyRight);
      if (!anyLeft && !anyRight) continue;
      if (anyLeft && nextN < BOOL_MAX_PIECES * 2u) next[nextN++] = left;
      if (anyRight && nextN < BOOL_MAX_PIECES * 2u) next[nextN++] = right;
    }
    if (!nextN) break;
    for (uint32_t i = 0; i < nextN; ++i) work[i] = next[i];
    workN = nextN;
  }

  float ax0, ay0, ax1, ay1, ax2, ay2;
  to2(p0, ax0, ay0);
  to2(p1, ax1, ay1);
  to2(p2, ax2, ay2);
  const float d20 = (ay1 - ay2) * (ax0 - ax2) + (ax2 - ax1) * (ay0 - ay2);
  const float denom = absf(d20) > 1e-12f ? 1.0f / d20 : 0.0f;

  auto bary = [&](float x, float y, float* out) {
    const float w0 = ((ay1 - ay2) * (x - ax2) + (ax2 - ax1) * (y - ay2)) * denom;
    const float w1 = ((ay2 - ay0) * (x - ax2) + (ax0 - ax2) * (y - ay2)) * denom;
    out[0] = w0;
    out[1] = w1;
    out[2] = 1.0f - w0 - w1;
  };

  for (uint32_t i = 0; i < workN; ++i) {
    const uint32_t npoly = work[i].n;
    if (npoly < 3u) continue;
    for (uint32_t k = 1; k + 1u < npoly; ++k) {
      Vec3 tri[3];
      float uvs[3][2];
      const float xs[3] = {work[i].x[0], work[i].x[k], work[i].x[k + 1u]};
      const float ys[3] = {work[i].y[0], work[i].y[k], work[i].y[k + 1u]};
      for (uint32_t c = 0; c < 3u; ++c) {
        tri[c] = p0 + e1 * xs[c] + e2 * ys[c];
        float w[3];
        bary(xs[c], ys[c], w);
        uvs[c][0] = w[0] * uv0[0] + w[1] * uv1[0] + w[2] * uv2[0];
        uvs[c][1] = w[0] * uv0[1] + w[1] * uv1[1] + w[2] * uv2[1];
      }
      /* Slivers are what a cut produces by the dozen; they carry no surface. */
      if (cross(tri[1] - tri[0], tri[2] - tri[0]).length() < 1e-10f) continue;
      emit(tri, uvs);
    }
  }
}

extern "C" {

FE_EXPORT int32_t fe_mod_begin(uint32_t vert_capacity, uint32_t tri_capacity, uint32_t has_uv) {
  g_s.ready = false;
  g_s.hasUv = has_uv != 0;
  g_s.matrix = nullptr;
  g_s.tgtPos = nullptr; g_s.tgtIdx = nullptr; g_s.tgtWorld = nullptr; g_s.tgtCounts = nullptr;
  g_s.sdOrd = nullptr; g_s.sdBary = nullptr; g_s.sdScalars = nullptr; g_s.sdTris = nullptr;
  g_s.sdBound = 0; g_s.sdTriN = 0;
  g_s.latRest = nullptr; g_s.latDef = nullptr; g_s.latN = 0;
  g_s.vg = nullptr; g_s.vgOn = 0;
  if (vert_capacity == 0 || tri_capacity == 0) return -3;
  if (vert_capacity > MOD_MAX_VERTS || tri_capacity > MOD_MAX_TRIS) return -2;

  const uint32_t v = vert_capacity, t = tri_capacity;
  const uint32_t uvCap = g_s.hasUv ? v * 2u : 1u;
  uint64_t bytes = static_cast<uint64_t>(v) * 3u * 4u * 3u;
  bytes += static_cast<uint64_t>(uvCap) * 4u * 2u;
  bytes += static_cast<uint64_t>(t) * 3u * 4u * 2u;
  bytes += 8u;
  if (bytes > MOD_ARENA_BUDGET - 2u * 1024u * 1024u) return -2;

  fe_arena_reset();
  g_mod_used = 0;
  g_s.vcap = v;
  g_s.tcap = t;
  g_s.vc = 0;
  g_s.tc = 0;
  g_s.inPos = modArray<float>(v * 3u);
  g_s.inUv = modArray<float>(uvCap);
  g_s.inNrm = modArray<float>(v * 3u);
  g_s.inIdx = modArray<uint32_t>(t * 3u);
  g_s.inSmooth = modArray<uint8_t>(t);
  g_s.outSmooth = modArray<uint8_t>(t);
  g_s.flagMode = 0;
  g_s.outPos = modArray<float>(v * 3u);
  g_s.outUv = modArray<float>(uvCap);
  g_s.outIdx = modArray<uint32_t>(t * 3u);
  g_s.nrm = modArray<float>(v * 3u);
  g_s.counts = modArray<uint32_t>(2u);
  g_s.vg = modArray<float>(v);
  if (g_s.vg) for (uint32_t i = 0; i < v; ++i) g_s.vg[i] = 0.0f;
  g_s.matrix = modArray<float>(16u);
  if (g_s.matrix) {
    for (uint32_t i = 0; i < 16u; ++i) g_s.matrix[i] = 0.0f;
    g_s.matrix[0] = 1.0f; g_s.matrix[5] = 1.0f; g_s.matrix[10] = 1.0f; g_s.matrix[15] = 1.0f;
  }
  if (!g_s.inPos || !g_s.inUv || !g_s.inNrm || !g_s.inIdx || !g_s.inSmooth || !g_s.outSmooth ||
      !g_s.outPos || !g_s.outUv || !g_s.outIdx || !g_s.nrm || !g_s.counts || !g_s.matrix || !g_s.vg) {
    g_s.ready = false;
    return -2;
  }
  g_s.counts[0] = 0;
  g_s.counts[1] = 0;
  g_s.ready = true;
  return 0;
}

FE_EXPORT uint32_t fe_mod_counts_ptr(void) { return g_s.counts ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.counts)) : 0u; }
FE_EXPORT uint32_t fe_mod_in_pos_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.inPos)); }
FE_EXPORT uint32_t fe_mod_in_uv_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.inUv)); }
FE_EXPORT uint32_t fe_mod_in_idx_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.inIdx)); }
FE_EXPORT uint32_t fe_mod_in_nrm_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.inNrm)); }
/* One byte per triangle, 1 = smooth, 0 = flat. The bridge writes it when the
   geometry carries its own flags, or calls fe_mod_derive_face_smooth() to have
   them read off the normals the mesh arrived with. */
FE_EXPORT uint32_t fe_mod_face_smooth_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.inSmooth)); }

/* The active vertex group, one float per input vertex. The bridge copies the
   weights in before the kernel runs; fe_mod_set_vgroup(0) means "no group",
   which every kernel reads as a factor of one. */
FE_EXPORT uint32_t fe_mod_vgroup_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.vg)); }
FE_EXPORT uint32_t fe_mod_set_vgroup(uint32_t count) {
  if (!g_s.ready || !g_s.vg) return 0;
  if (count == 0u) { g_s.vgOn = 0; return 1; }
  if (count != g_s.vc) { g_s.vgOn = 0; return 0; }
  for (uint32_t i = 0; i < count; ++i) {
    float w = g_s.vg[i];
    if (!(w >= 0.0f)) w = 0.0f;
    if (w > 1.0f) w = 1.0f;
    g_s.vg[i] = w;
  }
  g_s.vgOn = 1;
  return 1;
}

inline float deformWeight(uint32_t i, int32_t invert) {
  if (!g_s.vgOn) return 1.0f;
  float w = g_s.vg[i];
  return invert ? 1.0f - w : w;
}

FE_EXPORT uint32_t fe_mod_set_face_smooth(uint32_t count) {
  if (!g_s.ready || !g_s.inSmooth) return 0;
  if (count > g_s.tcap) return 0;
  for (uint32_t t = count; t < g_s.tcap; ++t) g_s.inSmooth[t] = 1u;
  g_s.flagMode = 1;
  return 1;
}

/* Flat comes from the model, not from a modifier default: a face is flat when
   its three corner normals already point where the face does. Read from the
   normals the shell uploaded, so a cube straight out of three is flat and a UV
   sphere is smooth without either of them saying so. */
FE_EXPORT uint32_t fe_mod_derive_face_smooth(void) {
  if (!g_s.ready || !g_s.inSmooth) return 0;
  const uint32_t t = g_s.tc;
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t a = g_s.inIdx[f * 3], b = g_s.inIdx[f * 3 + 1], c = g_s.inIdx[f * 3 + 2];
    const Vec3 pa = readPos(g_s.inPos, a), pb = readPos(g_s.inPos, b), pc = readPos(g_s.inPos, c);
    const Vec3 n = cross(pb - pa, pc - pa);
    const float len = sqrtf(n.x * n.x + n.y * n.y + n.z * n.z);
    uint8_t flat = 1u;
    if (len > 1e-20f) {
      const Vec3 unit = n * (1.0f / len);
      const uint32_t corners[3] = {a, b, c};
      for (uint32_t k = 0; k < 3 && flat; ++k) {
        const float dot = unit.x * g_s.inNrm[corners[k] * 3] + unit.y * g_s.inNrm[corners[k] * 3 + 1] +
                          unit.z * g_s.inNrm[corners[k] * 3 + 2];
        if (dot < 0.9995f) flat = 0u;
      }
    } else {
      flat = 0u;
    }
    g_s.inSmooth[f] = flat ? 0u : 1u;
  }
  for (uint32_t f = t; f < g_s.tcap; ++f) g_s.inSmooth[f] = 1u;
  g_s.flagMode = 1;
  return 1;
}
FE_EXPORT uint32_t fe_mod_normals_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.nrm)); }

FE_EXPORT void fe_mod_set_counts(uint32_t vert_count, uint32_t tri_count) {
  if (!g_s.ready) return;
  g_s.vc = vert_count > g_s.vcap ? g_s.vcap : vert_count;
  g_s.tc = tri_count > g_s.tcap ? g_s.tcap : tri_count;
  /* A kernel that moves vertices and leaves the faces where they are keeps the
     shading for free: the flags it will commit are the ones it was given. */
  g_s.flagMode = 1;
  if (g_s.inSmooth && g_s.outSmooth) {
    for (uint32_t t = 0; t < g_s.tc; ++t) g_s.outSmooth[t] = g_s.inSmooth[t];
  }
  g_s.counts[0] = g_s.vc;
  g_s.counts[1] = g_s.tc;
}

/* Rebuild the normals of the mesh already in the session, with the per-face
   shading applied. This is the normal-split pass on its own: no geometry moves,
   the corners a flat face cannot share are broken apart and the rest is left
   alone. The shell uses it to give Object Mode the same shading Edit Mode shows,
   and the modifier stack runs it through commit() at the end of every kernel. */
FE_EXPORT int32_t fe_mod_shade(void) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  /* Start from the normals the mesh arrived with, not from a fresh average of
     its corners. A smoothed surface reaches here with its corners already
     carrying the averaged direction, but the corners are *split* - three hands
     a UV sphere over as one normal per corner, a welded cage as one per point -
     and averaging each corner on its own would find the single face that owns
     it and call the whole surface flat. Nothing moved, so nothing needs
     recomputing; only the faces flagged flat are rewritten below. */
  bool seeded = false;
  if (g_s.inNrm) {
    for (uint32_t i = 0; i < v * 3u; ++i) {
      const float value = g_s.inNrm[i];
      g_s.nrm[i] = value;
      if (value != 0.0f) seeded = true;
    }
    if (seeded) {
      for (uint32_t i = 0; i < v; ++i) {
        const Vec3 n = normalize(readPos(g_s.nrm, i));
        writePos(g_s.nrm, i, n);
      }
    }
  }
  if (!seeded) computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  uint32_t outV = v;
  if (g_s.flagMode) outV = applyFaceShading(v, t);
  g_s.vc = outV;
  g_s.counts[0] = outV;
  g_s.counts[1] = t;
  return 0;
}

FE_EXPORT int32_t fe_mod_weld(float epsilon, int32_t mode, int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  const uint32_t v0 = g_s.vc, t0 = g_s.tc;
  if (!v0 || !t0) return -3;
  uint32_t* remap = modArray<uint32_t>(v0 + 1u);
  if (!remap) return -2;

  /* MOD_weld.cc: selection_array_from_vertex_group() is
       (BKE_defvert_find_weight(...) > 0.0f) != invert
     - membership, not the weight. Inverting therefore selects the vertices
     that are *not* in the group, which is why this cannot go through
     deformWeight() (that would give 0.5 for a half-weighted vertex instead of
     "selected"). */
  uint8_t* sel = nullptr;
  if (g_s.vgOn) {
    sel = modArray<uint8_t>(v0);
    if (!sel) return -2;
    for (uint32_t i = 0; i < v0; ++i) {
      const bool in_group = g_s.vg[i] > 0.0f;
      sel[i] = (in_group != (invert_vgroup != 0)) ? 1u : 0u;
    }
  }

  /* Weld's Mode. "All" merges vertices by distance wherever they are;
     "Connected" collapses only edges shorter than the distance, which is what
     keeps two coincident-but-separate surfaces from fusing. */
  uint32_t v = 0, t = 0;
  const int32_t rc = mode == 1 ? weldConnectedSession(epsilon, &v, &t, remap, sel)
                              : weldSession(epsilon, &v, &t, remap, sel);
  if (rc != 0) return rc;
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_smooth(uint32_t iterations, float factor, int32_t volume_preserving,
                                int32_t boundary_mode, int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  const uint32_t v0 = g_s.vc, t0 = g_s.tc;
  if (v0 == 0 || t0 == 0) return -3;

  uint32_t* remap = modArray<uint32_t>(v0 + 1u);
  if (!remap) return -2;
  uint32_t v = 0, t = 0;
  int32_t rc = weldSession(1e-6f, &v, &t, remap);
  if (rc != 0) return rc;
  copyOutToIn(v, t);

  /* That weld renumbered the vertices; carry the group through it so the
     weight still belongs to the vertex it was authored on. */
  if (g_s.vgOn) {
    float* carried = modArray<float>(v);
    if (!carried) return -2;
    for (uint32_t i = 0; i < v0; ++i) carried[remap[i]] = g_s.vg[i];
    g_s.vg = carried;
  }

  EdgeTable edges;
  if (!edgeTableInit(edges, t, false)) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    if (!edgeTableAdd(edges, g_s.inIdx[f * 3], g_s.inIdx[f * 3 + 1], f)) return -2;
    if (!edgeTableAdd(edges, g_s.inIdx[f * 3 + 1], g_s.inIdx[f * 3 + 2], f)) return -2;
    if (!edgeTableAdd(edges, g_s.inIdx[f * 3 + 2], g_s.inIdx[f * 3], f)) return -2;
  }

  uint8_t* boundary = modArray<uint8_t>(v);
  float* acc = modArray<float>(v * 3u);
  uint32_t* cnt = modArray<uint32_t>(v);
  if (!boundary || !acc || !cnt) return -2;
  for (uint32_t i = 0; i < v; ++i) boundary[i] = 0;
  for (uint32_t s = 0; s <= edges.mask; ++s) {
    if (edges.count[s] != 1u) continue;
    boundary[edges.a[s]] = 1;
    boundary[edges.b[s]] = 1;
  }

  const uint32_t iters = iterations < 1u ? 1u : (iterations > 20u ? 20u : iterations);
  const float lambda = clampf(factor, 0.0f, 1.0f);
  const float mu = volume_preserving ? -lambda / (1.0f - 0.06f * lambda) : 0.0f;
  const uint32_t passes = volume_preserving ? iters * 2u : iters;

  for (uint32_t pass = 0; pass < passes; ++pass) {
    const float step = (volume_preserving && (pass & 1u)) ? mu : lambda;
    for (uint32_t i = 0; i < v; ++i) { cnt[i] = 0; writePos(acc, i, Vec3(0.0f, 0.0f, 0.0f)); }
    for (uint32_t s = 0; s <= edges.mask; ++s) {
      if (edges.count[s] == 0) continue;
      const uint32_t a = edges.a[s], b = edges.b[s];
      writePos(acc, a, readPos(acc, a) + readPos(g_s.inPos, b));
      writePos(acc, b, readPos(acc, b) + readPos(g_s.inPos, a));
      cnt[a]++; cnt[b]++;
    }
    for (uint32_t i = 0; i < v; ++i) {
      if (!cnt[i]) continue;
      if (boundary_mode == 0 && boundary[i]) continue;
      /* MOD_smooth.cc: f_vgroup <= 0 leaves the vertex alone, otherwise
         f_new = f_vgroup * fac and the vertex is pulled by that much. */
      const float w = deformWeight(i, invert_vgroup);
      if (w <= 0.0f) continue;
      const Vec3 p = readPos(g_s.inPos, i);
      const Vec3 avg = readPos(acc, i) * (1.0f / static_cast<float>(cnt[i]));
      writePos(g_s.inPos, i, lerpv(p, avg, step * w));
    }
  }

  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  g_s.vc = v;
  g_s.tc = t;
  g_s.counts[0] = v;
  g_s.counts[1] = t;
  return 0;
}

FE_EXPORT int32_t fe_mod_mirror(uint32_t axis_mask, int32_t clipping, float merge_epsilon,
                                uint32_t bisect_mask, uint32_t bisect_flip_mask,
                                float bisect_threshold, int32_t use_mirror_u, int32_t use_mirror_v,
                                float mirror_offset_u, float mirror_offset_v, int32_t use_mirror_udim) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  uint32_t axesEnabled = 0;
  for (uint32_t a = 0; a < 3; ++a) if (axis_mask & (1u << a)) axesEnabled++;
  const uint32_t copies = 1u << axesEnabled;

  /* ---- bisect: cut away everything on the wrong side of a mirror plane ----
     Upstream does this with BM_mesh_bisect_plane() before it mirrors, which is
     what lets a half-modelled mesh be completed: the half that is kept is the
     one the artist modelled. A triangle that straddles the plane is cut, so
     the seam is exact and the mirror then meets itself. */
  uint32_t bv = 0, bt = 0;
  const float* srcPos = g_s.inPos;
  const uint32_t* srcIdx = g_s.inIdx;
  float* cutPos = nullptr;
  uint32_t* cutIdx = nullptr;
  if (bisect_mask) {
    cutPos = modArray<float>(v * 3u + t * 3u * 3u);
    cutIdx = modArray<uint32_t>(t * 3u * 3u);
    if (!cutPos || !cutIdx) return -2;
    for (uint32_t i = 0; i < v; ++i) writePos(cutPos, i, readPos(g_s.inPos, i));
    bv = v;
    auto keepSide = [&](uint32_t a, float da, uint32_t b, float db, uint32_t& oa, uint32_t& ob) {
      oa = a; ob = b;
      if ((da < 0.0f) != (db < 0.0f) && absf(da - db) > 1e-12f) {
        const float tt = da / (da - db);
        const Vec3 pa = readPos(g_s.inPos, a), pb = readPos(g_s.inPos, b);
        if (bv < g_s.vcap) {
          writePos(cutPos, bv, pa + (pb - pa) * tt);
          /* The crossing replaces the endpoint that is on the cut-away side:
             a survives, so b takes the new vertex. */
          if (da > 0.0f) ob = bv; else oa = bv;
          ++bv;
        }
      }
    };
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t ia[3] = {g_s.inIdx[f * 3], g_s.inIdx[f * 3 + 1], g_s.inIdx[f * 3 + 2]};
      Vec3 p[3] = {readPos(g_s.inPos, ia[0]), readPos(g_s.inPos, ia[1]), readPos(g_s.inPos, ia[2])};
      float d[3];
      for (uint32_t c = 0; c < 3u; ++c) {
        /* Every enabled axis is a plane, and a vertex has to be on the kept
           side of all of them: upstream bisects once per axis, so the region
           that survives is the intersection, not the union. */
        float side = 1e30f;
        for (uint32_t a = 0; a < 3u; ++a) {
          if (!(bisect_mask & (1u << a))) continue;
          const float val = (a == 0u ? p[c].x : (a == 1u ? p[c].y : p[c].z));
          side = minf(side, (bisect_flip_mask & (1u << a)) ? -val : val);
        }
        d[c] = side - bisect_threshold;
      }
      const bool in[3] = {d[0] >= 0.0f, d[1] >= 0.0f, d[2] >= 0.0f};
      const uint32_t nIn = static_cast<uint32_t>(in[0]) + static_cast<uint32_t>(in[1]) + static_cast<uint32_t>(in[2]);
      if (nIn == 0u) continue;
      if (nIn == 3u) {
        if (bt >= g_s.tcap) return -2;
        cutIdx[bt * 3] = ia[0]; cutIdx[bt * 3 + 1] = ia[1]; cutIdx[bt * 3 + 2] = ia[2];
        ++bt;
        continue;
      }
      if (nIn == 1u) {
        /* One corner survives: the triangle becomes the corner plus the two
           points where its edges cross the plane. keepSide writes the crossing
           into the *outside* corner's slot, so those are the second result. */
        const uint32_t i = in[0] ? 0u : (in[1] ? 1u : 2u);
        const uint32_t j = (i + 1u) % 3u, k2 = (i + 2u) % 3u;
        uint32_t keepI = 0, cutJ = 0, keepI2 = 0, cutK = 0;
        keepSide(ia[i], d[i], ia[j], d[j], keepI, cutJ);
        keepSide(ia[i], d[i], ia[k2], d[k2], keepI2, cutK);
        if (bt >= g_s.tcap) return -2;
        cutIdx[bt * 3] = ia[i]; cutIdx[bt * 3 + 1] = cutJ; cutIdx[bt * 3 + 2] = cutK;
        ++bt;
        continue;
      }
      /* Two corners survive: the corner at outI is cut off, leaving the quad
         a1 -> a2 -> cut2 -> cut1, which is two triangles. */
      uint32_t outI = 0;
      for (uint32_t c = 0; c < 3u; ++c) if (!in[c]) outI = c;
      const uint32_t a1 = (outI + 1u) % 3u, a2 = (outI + 2u) % 3u;
      uint32_t keep1 = 0, cut1 = 0, keep2 = 0, cut2 = 0;
      keepSide(ia[a1], d[a1], ia[outI], d[outI], keep1, cut1);
      keepSide(ia[a2], d[a2], ia[outI], d[outI], keep2, cut2);
      if (bt + 1u >= g_s.tcap) return -2;
      cutIdx[bt * 3] = ia[a1]; cutIdx[bt * 3 + 1] = ia[a2]; cutIdx[bt * 3 + 2] = cut2;
      ++bt;
      cutIdx[bt * 3] = ia[a1]; cutIdx[bt * 3 + 1] = cut2; cutIdx[bt * 3 + 2] = cut1;
      ++bt;
    }
    if (!bv || !bt) return -4;
    /* The cut leaves vertices behind that no surviving triangle uses - the
       corners of the removed half. Compact them away before mirroring: a loose
       vertex at x = -1 would otherwise widen the result's bounds and get
       duplicated into every copy. */
    uint8_t* used = modArray<uint8_t>(bv);
    uint32_t* dense = modArray<uint32_t>(bv);
    if (!used || !dense) return -2;
    for (uint32_t i = 0; i < bv; ++i) used[i] = 0u;
    for (uint32_t i = 0; i < bt * 3u; ++i) used[cutIdx[i]] = 1u;
    uint32_t kept = 0;
    for (uint32_t i = 0; i < bv; ++i) {
      if (!used[i]) continue;
      dense[i] = kept;
      if (kept != i) writePos(cutPos, kept, readPos(cutPos, i));
      ++kept;
    }
    for (uint32_t i = 0; i < bt * 3u; ++i) cutIdx[i] = dense[cutIdx[i]];
    bv = kept;
    srcPos = cutPos;
    srcIdx = cutIdx;
  }
  const uint32_t vUse = bisect_mask ? bv : v;
  const uint32_t tUse = bisect_mask ? bt : t;
  if (vUse * copies > g_s.vcap || tUse * copies > g_s.tcap) return -2;

  for (uint32_t k = 0; k < copies; ++k) {
    float sign[3] = {1.0f, 1.0f, 1.0f};
    uint32_t bit = 0;
    for (uint32_t a = 0; a < 3; ++a) {
      if (axis_mask & (1u << a)) {
        if (k & (1u << bit)) sign[a] = -1.0f;
        bit++;
      }
    }
    const uint32_t base = k * vUse;
    for (uint32_t i = 0; i < vUse; ++i) {
      const Vec3 p = readPos(srcPos, i);
      writePos(g_s.outPos, base + i, Vec3(p.x * sign[0], p.y * sign[1], p.z * sign[2]));
      if (g_s.hasUv) {
        float u = g_s.inUv[i * 2], vv = g_s.inUv[i * 2 + 1];
        /* use_mirror_u / use_mirror_v only touch the copies, never the
           original: upstream runs its flip over the second set of loops.
             u -> 1 - u + mirror_offset_u          (plain)
             u -> ceil(u) - frac(u) + offset       (use_mirror_udim: the tile
                                                    centre is the flip point) */
        if (k > 0) {
          if (use_mirror_u) {
            u = use_mirror_udim
                  ? -floorf(-u) - (u - floorf(u)) + mirror_offset_u
                  : 1.0f - u + mirror_offset_u;
          }
          if (use_mirror_v) {
            vv = use_mirror_udim
                   ? -floorf(-vv) - (vv - floorf(vv)) + mirror_offset_v
                   : 1.0f - vv + mirror_offset_v;
          }
        }
        g_s.outUv[(base + i) * 2] = u;
        g_s.outUv[(base + i) * 2 + 1] = vv;
      }
    }
    const bool flip = sign[0] * sign[1] * sign[2] < 0.0f;
    for (uint32_t f = 0; f < tUse; ++f) {
      const uint32_t a = srcIdx[f * 3], b = srcIdx[f * 3 + 1], c = srcIdx[f * 3 + 2];
      const uint32_t o = (k * tUse + f) * 3;
      if (flip) { g_s.outIdx[o] = base + c; g_s.outIdx[o + 1] = base + b; g_s.outIdx[o + 2] = base + a; }
      else { g_s.outIdx[o] = base + a; g_s.outIdx[o + 1] = base + b; g_s.outIdx[o + 2] = base + c; }
      if (g_s.outSmooth && g_s.inSmooth) g_s.outSmooth[k * tUse + f] = g_s.inSmooth[f];
    }
  }

  const uint32_t outV = vUse * copies, outT = tUse * copies;
  int32_t rc = commit(outV, outT);
  if (rc != 0) return rc;
  if (clipping && copies > 1) {
    uint32_t* remap = modArray<uint32_t>(outV + 1u);
    if (!remap) return -2;
    uint32_t wv = 0, wt = 0;
    rc = weldSession(merge_epsilon, &wv, &wt, remap);
    if (rc != 0) return rc;
    rc = commit(wv, wt);
  }
  return rc;
}

/* =========================================================================
 * Solidify - ported from modifiers/intern/MOD_solidify_extrude.cc
 *
 *   source/blender/modifiers/intern/MOD_solidify.cc          (the dispatcher)
 *   source/blender/modifiers/intern/MOD_solidify_extrude.cc  (the algorithm)
 *
 * The shell is Blender's: every vertex is copied, the original ring is pushed
 * along the vertex normals by ofs_orig and the copy by ofs_new, where
 *
 *   ofs_orig = -(((-offset_fac + 1.0f) * 0.5f) * thickness)
 *   ofs_new  = thickness + ofs_orig
 *
 * is the same pair the modifier builds from its two sliders. The copied faces
 * are emitted with reversed winding so their normals point the other way, and
 * each boundary edge gets a rim quad, wound against the face normal so it
 * closes the shell rather than folding into it.
 *
 * Even thickness is MOD_SOLIDIFY_EVEN: for every corner, the angle at that
 * corner is accumulated both raw (vert_accum) and scaled by
 * shell_v3v3_normalized_to_dist(vert_normal, face_normal) = 1 / |dot| - the
 * factor by which a vertex normal has to stretch to reach the face's plane -
 * and the offset is multiplied by their ratio. That is what keeps a shell on a
 * pyramid or a bevelled edge from thinning out at the corners.
 *
 * Not ported, and named so nobody has to guess: the Non Manifold mode
 * (MOD_solidify_nonmanifold.cc, 113 341 bytes, a different algorithm entirely),
 * vertex-group weights, material offsets, the
 * bevel-convex edge weight, the degenerate-length clamp and complex mode, and
 * n-gons - the modifier stack hands this kernel triangles.
 * ========================================================================= */
/* acos through the engine's own atan2: the freestanding build carries no libm. */
inline float cornerAngle(float cosang);

/* Angle-weighted vertex normals: the weighting a mesh carries into a modifier
   (every face contributes its normal, scaled by the angle it subtends at the
   vertex). Used by Solidify and Wireframe, which both offset along it. */
void vertexNormalsAngleWeighted(const float* pos, const uint32_t* idx, uint32_t vCount,
                                uint32_t triCount, const float* faceNormal, float* out) {
  for (uint32_t i = 0; i < vCount * 3u; ++i) out[i] = 0.0f;
  for (uint32_t f = 0; f < triCount; ++f) {
    const Vec3 p[3] = { readPos(pos, idx[f * 3]), readPos(pos, idx[f * 3 + 1]), readPos(pos, idx[f * 3 + 2]) };
    const Vec3 n(faceNormal[f * 3], faceNormal[f * 3 + 1], faceNormal[f * 3 + 2]);
    for (uint32_t k = 0; k < 3u; ++k) {
      const Vec3 e0 = p[(k + 1u) % 3u] - p[k];
      const Vec3 e1 = p[(k + 2u) % 3u] - p[k];
      const float l0 = length(e0), l1 = length(e1);
      if (l0 <= 0.0f || l1 <= 0.0f) continue;
      const float ang = cornerAngle(dot(e0 * (1.0f / l0), e1 * (1.0f / l1)));
      const uint32_t vi = idx[f * 3 + k];
      writePos(out, vi, readPos(out, vi) + n * ang);
    }
  }
  for (uint32_t i = 0; i < vCount; ++i) {
    const Vec3 n = readPos(out, i);
    writePos(out, i, length_sq(n) == 0.0f ? Vec3(0.0f, 1.0f, 0.0f) : normalize(n));
  }
}


inline float cornerAngle(float cosang) {
  const float c = clampf(cosang, -1.0f, 1.0f);
  return atan2f(sqrtf(maxf(0.0f, 1.0f - c * c)), c);
}

FE_EXPORT int32_t fe_mod_solidify(float thickness, float offset, int32_t rim, int32_t even_thickness,
                                  int32_t flip_normals, int32_t rim_only, float thickness_clamp,
                                  int32_t use_angle_clamp, float thickness_vgroup_fac,
                                  int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  /* The shell has twice the faces and none of them is the one it came from, so
     the per-face smooth flags cannot be carried: the new surface is smooth. */
  g_s.flagMode = 0;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  if (v * 2u > g_s.vcap) return -2;
  const float th = clampf(thickness, -1.0f, 1.0f);
  if (absf(th) < 1e-9f) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    return commit(v, t);
  }
  const float offset_fac = clampf(offset, -1.0f, 1.0f);
  const float ofs_orig = -(((-offset_fac + 1.0f) * 0.5f) * th);
  const float ofs_new = th + ofs_orig;
  /* INIT_VERT_ARRAY_OFFSETS: the vertices that keep the original winding take
     the *larger* of the two offsets, so the shell faces outward whatever the
     sign of the thickness. Flip Normals swaps the two, which is exactly what
     turns a shell inside-out - the positions never move. */
  float ofsFront = ofs_orig, ofsBack = ofs_new;
  const bool frontLarger = ofsFront >= ofsBack;
  if (frontLarger == flip_normals) {
    const float tmp = ofsFront; ofsFront = ofsBack; ofsBack = tmp;
  }

  float* fn = modArray<float>(t * 3u);
  float* vn = modArray<float>(v * 3u);
  float* accum = modArray<float>(v);
  float* angles = modArray<float>(v);
  if (!fn || !vn || !accum || !angles) return -2;

  /* Face normals, unit. */
  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 a = readPos(g_s.inPos, g_s.inIdx[f * 3]);
    const Vec3 b = readPos(g_s.inPos, g_s.inIdx[f * 3 + 1]);
    const Vec3 c = readPos(g_s.inPos, g_s.inIdx[f * 3 + 2]);
    const Vec3 n = normalize(cross(b - a, c - a));
    fn[f * 3] = n.x; fn[f * 3 + 1] = n.y; fn[f * 3 + 2] = n.z;
  }

  /* mesh vertex normals, angle weighted: the same weighting the mesh would
     carry into the modifier. */
  vertexNormalsAngleWeighted(g_s.inPos, g_s.inIdx, v, t, fn, vn);

  /* MOD_SOLIDIFY_EVEN. shell_v3v3_normalized_to_dist() is |dot| based and
     clamps a near-perpendicular pair to 1, exactly as upstream. */
  for (uint32_t i = 0; i < v; ++i) { accum[i] = 0.0f; angles[i] = 0.0f; }
  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 p[3] = { readPos(g_s.inPos, g_s.inIdx[f * 3]),
                        readPos(g_s.inPos, g_s.inIdx[f * 3 + 1]),
                        readPos(g_s.inPos, g_s.inIdx[f * 3 + 2]) };
    const Vec3 n(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]);
    for (uint32_t k = 0; k < 3u; ++k) {
      const Vec3 e0 = p[(k + 1u) % 3u] - p[k];
      const Vec3 e1 = p[(k + 2u) % 3u] - p[k];
      const float l0 = length(e0), l1 = length(e1);
      if (l0 <= 0.0f || l1 <= 0.0f) continue;
      const float cosang = clampf(dot(e0 * (1.0f / l0), e1 * (1.0f / l1)), -1.0f, 1.0f);
      const float ang = cornerAngle(cosang);
      const uint32_t vi = g_s.inIdx[f * 3 + k];
      const float cosvn = absf(dot(readPos(vn, vi), n));
      const float dist = cosvn < 1e-8f ? 1.0f : 1.0f / cosvn;
      accum[vi] += ang;
      angles[vi] += (even_thickness ? dist : 1.0f) * ang;
    }
  }

  /* thickness_clamp / use_thickness_angle_clamp, MOD_solidify_extrude.cc's
     clamp block (the even-thickness branch, which is what this kernel is).
     A shell may not travel further than the shortest edge around the vertex
     allows: the offset is scaled back per vertex, and with the angle clamp on,
     also by the half-dihedral of the sharpest manifold edge there. */
  float* clampScale = nullptr;
  const float clamp_fac_in = clampf(thickness_clamp, 0.0f, 100.0f);
  if (clamp_fac_in > 0.0f) {
    const float clamp_fac = 1.0f + (use_angle_clamp ? absf(offset_fac) : 0.0f);
    const float clamp_off = absf(th) * clamp_fac_in * clamp_fac;
    if (clamp_off > 1e-9f) {
      float* vert_lens = modArray<float>(v);
      clampScale = modArray<float>(v);
      if (!vert_lens || !clampScale) return -2;
      for (uint32_t i = 0; i < v; ++i) { vert_lens[i] = 3.4e38f; clampScale[i] = 1.0f; }
      EdgeTable et;
      if (!edgeTableInit(et, t, true)) return -2;
      for (uint32_t f = 0; f < t; ++f) {
        const uint32_t i0 = g_s.inIdx[f * 3], i1 = g_s.inIdx[f * 3 + 1], i2 = g_s.inIdx[f * 3 + 2];
        if (!edgeTableAdd(et, i0, i1, f) || !edgeTableAdd(et, i1, i2, f) || !edgeTableAdd(et, i2, i0, f))
          return -2;
      }
      for (uint32_t s = 0; s <= et.mask; ++s) {
        if (et.count[s] == 0u) continue;
        const float len = length_sq(readPos(g_s.inPos, et.a[s]) - readPos(g_s.inPos, et.b[s]));
        if (len < vert_lens[et.a[s]]) vert_lens[et.a[s]] = len;
        if (len < vert_lens[et.b[s]]) vert_lens[et.b[s]] = len;
      }
      if (use_angle_clamp) {
        /* vert_angs starts at a right angle and takes the sharpest manifold
           edge at the vertex: M_PI - the angle between the two face normals. */
        float* vert_angs = modArray<float>(v);
        if (!vert_angs) return -2;
        for (uint32_t i = 0; i < v; ++i) vert_angs[i] = 0.5f * 3.14159265358979f;
        for (uint32_t f = 0; f < t; ++f) {
          const uint32_t i0 = g_s.inIdx[f * 3], i1 = g_s.inIdx[f * 3 + 1], i2 = g_s.inIdx[f * 3 + 2];
          const uint32_t tri[3][2] = { { i0, i1 }, { i1, i2 }, { i2, i0 } };
          for (uint32_t k = 0; k < 3u; ++k) {
            uint32_t other = 0u;
            if (edgeTableFind(et, tri[k][0], tri[k][1], other) != 2u) continue;
            if (other == f) continue;   /* each edge is handled from its second face */
            const Vec3 n0(fn[other * 3], fn[other * 3 + 1], fn[other * 3 + 2]);
            const Vec3 n1(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]);
            const float ang = 3.14159265358979f - cornerAngle(clampf(dot(n0, n1), -1.0f, 1.0f));
            if (ang > vert_angs[tri[k][0]]) vert_angs[tri[k][0]] = ang;
            if (ang > vert_angs[tri[k][1]]) vert_angs[tri[k][1]] = ang;
          }
        }
        for (uint32_t i = 0; i < v; ++i) {
          const float cos_ang = cosf(vert_angs[i] * 0.5f);
          if (cos_ang > 0.0f) {
            const float max_off = sqrtf(vert_lens[i]) * 0.5f / cos_ang;
            if (max_off < clamp_off * 0.5f) clampScale[i] = max_off / clamp_off * 2.0f;
          }
        }
      }
      else {
        const float clamp_sq = clamp_off * clamp_off;
        for (uint32_t i = 0; i < v; ++i) {
          if (vert_lens[i] < clamp_sq) clampScale[i] = sqrtf(vert_lens[i]) / clamp_off;
        }
      }
    }
  }

  /* thickness_vertex_group (offset_fac_vg): the weight scales the offset, and
     the factor says how much a vertex outside the group still gets:

       ofs_vgroup = (factor + weight * (1 - factor)) * ofs

     so factor 0 is "the group is the whole story" and factor 1 is "the group
     changes nothing" - the same curve upstream uses. */
  const float vgFacIn = clampf(thickness_vgroup_fac, 0.0f, 1.0f);
  auto weightOf = [&](uint32_t i) {
    if (!g_s.vgOn) return 1.0f;
    float w = g_s.vg[i];
    if (invert_vgroup) w = 1.0f - w;
    return vgFacIn + (w * (1.0f - vgFacIn));
  };

  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const Vec3 n = readPos(vn, i);
    float scale = accum[i] > 1e-12f ? angles[i] / accum[i] : 1.0f;
    if (clampScale) scale *= clampScale[i];
    scale *= weightOf(i);
    writePos(g_s.outPos, i, p + n * (ofsFront * scale));
    writePos(g_s.outPos, v + i, p + n * (ofsBack * scale));
    if (g_s.hasUv) {
      g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1];
      g_s.outUv[(v + i) * 2] = g_s.inUv[i * 2]; g_s.outUv[(v + i) * 2 + 1] = g_s.inUv[i * 2 + 1];
    }
  }

  uint32_t outT = 0u;
  /* Rim Only drops both skins and keeps the border strip, which is how a
     surface gets a clean edge loop without doubling its faces. */
  for (uint32_t f = 0; f < t && !rim_only && outT + 2u <= g_s.tcap; ++f) {
    const uint32_t a = g_s.inIdx[f * 3], b = g_s.inIdx[f * 3 + 1], c = g_s.inIdx[f * 3 + 2];
    g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = c; ++outT;
    /* The copy is the same face with the winding reversed, so the two skins
       face away from each other. */
    g_s.outIdx[outT * 3] = v + c; g_s.outIdx[outT * 3 + 1] = v + b; g_s.outIdx[outT * 3 + 2] = v + a; ++outT;
  }

  if (rim) {
    EdgeTable edges;
    if (!edgeTableInit(edges, t, true)) return -2;
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t i0 = g_s.inIdx[f * 3], i1 = g_s.inIdx[f * 3 + 1], i2 = g_s.inIdx[f * 3 + 2];
      if (!edgeTableAdd(edges, i0, i1, f) || !edgeTableAdd(edges, i1, i2, f) || !edgeTableAdd(edges, i2, i0, f)) return -2;
    }
    for (uint32_t sIdx = 0; sIdx <= edges.mask; ++sIdx) {
      if (edges.count[sIdx] != 1u) continue;
      if (outT + 2u > g_s.tcap) return -2;
      const uint32_t a = edges.a[sIdx], b = edges.b[sIdx];
      const Vec3 pa = readPos(g_s.inPos, a), pb = readPos(g_s.inPos, b);
      const Vec3 oa = readPos(g_s.outPos, a), ob = readPos(g_s.outPos, b);
      const Vec3 ib = readPos(g_s.outPos, v + b);
      const Vec3 fv = readPos(g_s.inPos, g_s.inIdx[edges.tri[sIdx] * 3]);
      const Vec3 fv1 = readPos(g_s.inPos, g_s.inIdx[edges.tri[sIdx] * 3 + 1]);
      const Vec3 fv2 = readPos(g_s.inPos, g_s.inIdx[edges.tri[sIdx] * 3 + 2]);
      const Vec3 n = cross(fv1 - fv, fv2 - fv);
      /* The rim has to face the way the shell faces. Blender's rim follows the
         same side test as the faces it closes, so when the shell is turned
         inside out the wall turns with it. */
      const Vec3 want = flip_normals ? cross(pb - pa, n) * -1.0f : cross(pb - pa, n);
      const Vec3 got = cross(ob - oa, ib - oa);
      if (dot(got, want) >= 0.0f) {
        g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = v + b; ++outT;
        g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = v + b; g_s.outIdx[outT * 3 + 2] = v + a; ++outT;
      } else {
        g_s.outIdx[outT * 3] = b; g_s.outIdx[outT * 3 + 1] = a; g_s.outIdx[outT * 3 + 2] = v + a; ++outT;
        g_s.outIdx[outT * 3] = b; g_s.outIdx[outT * 3 + 1] = v + a; g_s.outIdx[outT * 3 + 2] = v + b; ++outT;
      }
    }
  }

  return commit(v * 2u, outT);
}

/* vertex_group on the deform kernels: MOD_displace.cc does
 *   weight = invert ? 1 - w : w;   if (weight == 0) skip;   strength *= weight;
 * and the other deformers weight the same way, so one helper covers them. */
FE_EXPORT int32_t fe_mod_displace(float strength, float midlevel, float frequency, uint32_t seed, uint32_t octaves, uint32_t direction, int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const float freq = clampf(frequency, 0.01f, 40.0f);
  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  const Vec3 fixedAxis = axisVector(direction > 0u ? direction - 1u : 0u);
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const float n = fbm3(p.x * freq + 11.0f, p.y * freq + 17.0f, p.z * freq + 23.0f, seed, octaves);
    const float w = deformWeight(i, invert_vgroup);
    if (w == 0.0f) {
      writePos(g_s.outPos, i, p);
      if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
      continue;
    }
    const float d = (n - clampf(midlevel, 0.0f, 1.0f)) * strength * w;
    const Vec3 dir = direction == 0u ? readPos(g_s.nrm, i) : fixedAxis;
    writePos(g_s.outPos, i, p + dir * d);
    if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
  }
  for (uint32_t f = 0; f < t * 3u; ++f) g_s.outIdx[f] = g_s.inIdx[f];
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_wave(float height, float width, float speed, float time, uint32_t plane, float phase,
                              int32_t invert_vgroup, float narrowness, float time_offset, float lifetime,
                              float damping, float start_x, float start_y, float falloff, int32_t cyclic,
                              int32_t use_normal) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;

  /* fbm-style sines are not what the Wave modifier is. MOD_wave.cc is a
     travelling gaussian: the distance from a start point minus the elapsed
     time times the speed is the phase, the phase falls off as exp(-(narrow *
     phase)^2), and the result moves the vertex along local Z (or along its
     normal). Everything below is that function, term for term. */
  const float w = maxf(width, 1e-6f);
  const float narrow = narrowness;
  const float minfac = 1.0f / expf(w * narrow * w * narrow);
  const float falloffAmt = maxf(falloff, 0.0f);
  float lifefac = height;
  const float damp = damping == 0.0f ? 10.0f : damping;
  /* The clock: `time` is the frame time Blender reads from the depsgraph, and
     `phase` is this app's extra offset for callers that want a moving wave
     without touching the clock. */
  const float ctime = time + phase;

  if (lifetime != 0.0f) {
    const float x = ctime - time_offset;
    if (x > lifetime) {
      lifefac = x - lifetime;
      if (lifefac > damp) lifefac = 0.0f;
      else lifefac = height * (1.0f - sqrtf(lifefac / damp));
    }
  }

  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  if (lifefac != 0.0f) {
    const float falloff_inv = falloffAmt != 0.0f ? 1.0f / falloffAmt : 1.0f;
    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(g_s.inPos, i);
      const float x = p.x - start_x;
      const float y = p.y - start_y;
      Vec3 q = p;
      float falloff_fac = 1.0f;

      const float weight = deformWeight(i, invert_vgroup);
      if (weight == 0.0f) {
        writePos(g_s.outPos, i, q);
        if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
        continue;
      }

      float amplit;
      float dist;
      if (plane == 2u) {          /* MOD_WAVE_X | MOD_WAVE_Y: circles */
        amplit = sqrtf(x * x + y * y);
        dist = amplit;
      }
      else if (plane == 1u) {     /* MOD_WAVE_Y */
        amplit = y;
        dist = absf(y);
      }
      else {                      /* MOD_WAVE_X */
        amplit = x;
        dist = absf(x);
      }

      amplit -= (ctime - time_offset) * speed;
      if (cyclic) {
        /* fmodf(amplit - width, 2 * width) + width, exactly as written. */
        amplit = fmodf(amplit - w, 2.0f * w) + w;
      }

      if (falloffAmt != 0.0f) {
        falloff_fac = clampf(1.0f - (dist * falloff_inv), 0.0f, 1.0f);
      }

      if (falloff_fac != 0.0f && amplit > -w && amplit < w) {
        float a = amplit * narrow;
        a = 1.0f / expf(a * a) - minfac;
        a *= weight * falloff_fac;
        const float move = lifefac * a;
        if (use_normal) q = q + readPos(g_s.nrm, i) * move;
        else q.z += move;
      }

      writePos(g_s.outPos, i, q);
      if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    }
  }
  else {
    for (uint32_t i = 0; i < v; ++i) {
      writePos(g_s.outPos, i, readPos(g_s.inPos, i));
      if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    }
  }
  for (uint32_t f = 0; f < t * 3u; ++f) g_s.outIdx[f] = g_s.inIdx[f];
  return commit(v, t);
}

/* =========================================================================
 * Cast - ported from modifiers/intern/MOD_cast.cc
 *
 *   source/blender/modifiers/intern/MOD_cast.cc  (sphere_do, cuboid_do)
 *
 * The old kernel treated `radius` as a scale and cast around the bounding-box
 * centre. Neither is what the modifier does:
 *
 *   - the centre is the object's own origin, {0, 0, 0} in local space, unless
 *     an object is assigned, in which case it is that object's location
 *     converted into the modified object's space;
 *   - `radius` is a *limit*: with radius > FLT_EPSILON a vertex further than
 *     radius from the centre is skipped, not scaled;
 *   - `size` is the distance the cast pulls a vertex to; when it is zero the
 *     size is the mean distance of the vertices from the centre (and 10 if
 *     that is zero too), and with use_radius_as_size the radius *is* the size;
 *   - use_x / use_y / use_z choose which components move, and Cylinder clears
 *     Z from the flags, so a cylinder never moves along its own axis.
 *
 * Cuboid is cuboid_do(): the octant's corner of the (symmetric) bound box is
 * the apex, the coordinate whose ratio to that apex is largest picks the wall,
 * and the vertex is projected onto it by fbb = apex[coord] / co[coord].
 * ========================================================================= */

FE_EXPORT int32_t fe_mod_cast(uint32_t shape, float factor, float radius, float size,
                              int32_t invert_vgroup, uint32_t axis_mask,
                              int32_t size_from_radius, int32_t use_transform,
                              int32_t has_object) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;

  uint32_t flags = axis_mask & 7u;
  const bool cylinder = shape == 1u;
  if (cylinder) flags &= ~4u;             /* MOD_CAST_Z is cleared for cylinders */

  const Mat4 rel = sessionMatrix();
  const Vec3 center = has_object ? Vec3(rel.e[12], rel.e[13], rel.e[14]) : Vec3(0.0f, 0.0f, 0.0f);
  Mat4 to_ctrl, from_ctrl;
  const bool use_tf = has_object && use_transform != 0;
  if (use_tf) {
    /* mat = inverse(inverse(ob) * ctrl), so a point goes ob-local -> ctrl-local
       with mat and back with its inverse, exactly as sphere_do() does. */
    matInvert(rel, to_ctrl);
    matInvert(to_ctrl, from_ctrl);
  }

  const bool has_radius = radius > 1.1920929e-7f;   /* FLT_EPSILON */
  const float fac_orig = clampf(factor, 0.0f, 1.0f);

  if (shape != 2u) {
    /* ---- sphere_do(): Sphere and Cylinder ---- */
    float len = size_from_radius ? radius : size;
    if (len <= 0.0f) {
      len = 0.0f;
      for (uint32_t i = 0; i < v; ++i) len += length(readPos(g_s.inPos, i) - center);
      len /= static_cast<float>(v);
      if (len == 0.0f) len = 10.0f;
    }
    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(g_s.inPos, i);
      Vec3 tmp = use_tf ? matPoint(to_ctrl, p) : (has_object ? p - center : p);
      Vec3 vec = tmp;
      if (cylinder) vec.z = 0.0f;
      if (has_radius && length(vec) > radius) { writePos(g_s.outPos, i, p); copyUv(i); continue; }
      const float w = deformWeight(i, invert_vgroup);
      if (w == 0.0f) { writePos(g_s.outPos, i, p); copyUv(i); continue; }
      const float fac = fac_orig * w;
      const float facm = 1.0f - fac;
      const float l = maxf(length(vec), 1e-20f);
      vec = vec * (1.0f / l);
      if (flags & 1u) tmp.x = fac * vec.x * len + facm * tmp.x;
      if (flags & 2u) tmp.y = fac * vec.y * len + facm * tmp.y;
      if (flags & 4u) tmp.z = fac * vec.z * len + facm * tmp.z;
      const Vec3 out = use_tf ? matPoint(from_ctrl, tmp) : (has_object ? tmp + center : tmp);
      writePos(g_s.outPos, i, out);
      copyUv(i);
    }
  }
  else {
    /* ---- cuboid_do() ---- */
    float mn[3], mx[3];
    if (size_from_radius && has_radius) {
      for (uint32_t a = 0; a < 3u; ++a) { mn[a] = -radius; mx[a] = radius; }
    }
    else if (!size_from_radius && size > 0.0f) {
      for (uint32_t a = 0; a < 3u; ++a) { mn[a] = -size; mx[a] = size; }
    }
    else {
      for (uint32_t a = 0; a < 3u; ++a) { mn[a] = 3.402823466e+38f; mx[a] = -3.402823466e+38f; }
      auto expand = [&](const Vec3& q) {
        if (q.x < mn[0]) { mn[0] = q.x; }
        if (q.x > mx[0]) { mx[0] = q.x; }
        if (q.y < mn[1]) { mn[1] = q.y; }
        if (q.y > mx[1]) { mx[1] = q.y; }
        if (q.z < mn[2]) { mn[2] = q.z; }
        if (q.z > mx[2]) { mx[2] = q.z; }
      };
      if (has_object) expand(center);
      for (uint32_t i = 0; i < v; ++i) {
        const Vec3 p = readPos(g_s.inPos, i);
        expand(has_object ? p - center : p);
      }
      /* A symmetric box about the origin. */
      for (uint32_t a = 0; a < 3u; ++a) {
        const float lo = absf(mn[a]), hi = absf(mx[a]);
        mx[a] = lo > hi ? lo : hi;
        mn[a] = -mx[a];
      }
    }

    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(g_s.inPos, i);
      Vec3 tmp = use_tf ? matPoint(to_ctrl, p) : (has_object ? p - center : p);
      if (has_radius && (absf(tmp.x) > radius || absf(tmp.y) > radius || absf(tmp.z) > radius)) {
        writePos(g_s.outPos, i, p); copyUv(i); continue;
      }
      const float w = deformWeight(i, invert_vgroup);
      if (w == 0.0f) { writePos(g_s.outPos, i, p); copyUv(i); continue; }
      const float fac = fac_orig * w;
      const float facm = 1.0f - fac;

      /* the octant the vertex is in picks the box corner it is aimed at */
      const uint32_t octant = (tmp.x > 0.0f ? 1u : 0u) | (tmp.y > 0.0f ? 2u : 0u) | (tmp.z > 0.0f ? 4u : 0u);
      const float apex[3] = { (octant & 1u) ? mx[0] : mn[0], (octant & 2u) ? mx[1] : mn[1], (octant & 4u) ? mx[2] : mn[2] };
      const float co[3] = { tmp.x, tmp.y, tmp.z };
      float dmax = co[0] / apex[0];
      uint32_t coord = 0u;
      if (co[1] / apex[1] > dmax) { dmax = co[1] / apex[1]; coord = 1u; }
      if (co[2] / apex[2] > dmax) { coord = 2u; }
      if (absf(co[coord]) < 1.1920929e-7f) { writePos(g_s.outPos, i, p); copyUv(i); continue; }
      const float fbb = apex[coord] / co[coord];
      if (flags & 1u) tmp.x = facm * tmp.x + fac * tmp.x * fbb;
      if (flags & 2u) tmp.y = facm * tmp.y + fac * tmp.y * fbb;
      if (flags & 4u) tmp.z = facm * tmp.z + fac * tmp.z * fbb;
      const Vec3 out = use_tf ? matPoint(from_ctrl, tmp) : (has_object ? tmp + center : tmp);
      writePos(g_s.outPos, i, out);
      copyUv(i);
    }
  }

  for (uint32_t f = 0; f < t * 3u; ++f) g_s.outIdx[f] = g_s.inIdx[f];
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_twist(float strength, uint32_t axis) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const Vec3 ax = axisVector(axis > 2u ? 0u : axis);
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    writePos(g_s.outPos, i, rotateAxis(p, ax, dot(p, ax) * strength * 0.5f));
    if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
  }
  for (uint32_t f = 0; f < t * 3u; ++f) g_s.outIdx[f] = g_s.inIdx[f];
  return commit(v, t);
}

/* =========================================================================
 * Array - ported from modifiers/intern/MOD_array.cc
 *
 *   source/blender/modifiers/intern/MOD_array.cc (arrayModifier_doArray)
 *
 * The old kernel translated copy c by step * c and spun it about the object
 * origin, which is not what Blender does. Blender builds one offset matrix and
 * keeps multiplying it into a running matrix:
 *
 *   unit_m4(offset);
 *   if (OFF_CONST)   offset[3] += constant;
 *   if (OFF_RELATIVE) offset[3][j] += scale[j] * (bounds_max[j] - bounds_min[j]);
 *   if (OFF_OBJ)     offset = offset * inverse(object) * offset_object;
 *   ...
 *   mul_m4_m4m4(current_offset, current_offset, offset);   per copy
 *
 * so a rotated offset makes the copies spiral around each other, and a scaled
 * offset grows the spacing, both of which fall out of the matrix for free here.
 * This kernel carries that structure: constant and relative offsets build the
 * translation, a per-step rotation (our stand-in for Blender's offset empty,
 * which this app has no way to give the modifier) is composed on top, and the
 * running matrix is multiplied out copy by copy.
 *
 * Fit Type is arrayModifier_doArray's own arithmetic:
 *
 *   count = (length + 1e-6f) / len_v3(offset[3]) + 1
 *
 * with a single copy when the offset is degenerate. Fit Curve in Blender reads
 * the length off a curve object's evaluated path; there are no curve objects
 * here, so the same number is supplied directly as Length and the arithmetic is
 * identical.
 *
 * Merge is the seam weld: Blender's dm_mvert_map_doubles() maps the vertices of
 * chunk c onto chunk c-1 within the merge distance, and a mapping chain is
 * followed transitively. That is a union-find over the copies, done here with a
 * grid keyed by the merge distance so it stays linear.
 *
 * Not ported: the start/end cap objects, material index offsets, and the
 * per-attribute interpolation (position, normal, UV and the face smoothing flag
 * are carried; nothing else exists on this pipeline).
 * ========================================================================= */
FE_EXPORT int32_t fe_mod_array_ex(uint32_t count, uint32_t fit_type, float fit_length,
                                  uint32_t offset_type,
                                  float cx, float cy, float cz,
                                  float rx, float ry, float rz,
                                  float rot_x_deg, float rot_y_deg, float rot_z_deg,
                                  uint32_t merge, float merge_dist,
                                  float uv_u, float uv_v, int32_t use_object_offset) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  if (g_s.inSmooth && g_s.outSmooth) g_s.flagMode = 1;   /* one flag per copy per face */

  const Box box = meshBounds(g_s.inPos, v);
  const Vec3 ext = box.size();

  /* The offset matrix's translation, exactly as upstream accumulates it. */
  Vec3 translation(0.0f, 0.0f, 0.0f);
  if (offset_type & 1u) translation = translation + Vec3(cx, cy, cz);
  if (offset_type & 2u) translation = translation + Vec3(rx * ext.x, ry * ext.y, rz * ext.z);

  /* Per-step rotation, the offset-empty stand-in: R = Rz * Ry * Rx. */
  const float ax = rot_x_deg * kDeg2Rad, ay = rot_y_deg * kDeg2Rad, az = rot_z_deg * kDeg2Rad;
  const bool anySpin = rot_x_deg != 0.0f || rot_y_deg != 0.0f || rot_z_deg != 0.0f;
  /* fe::cosf is a fast approximation (about 3e-6 at zero), and this matrix is
     multiplied into itself once per copy - at forty copies that error would be
     visible. A step with no rotation is exactly the identity, so it never goes
     near the trigonometry. */
  const float cxs = anySpin ? cosf(ax) : 1.0f, sxs = anySpin ? sinf(ax) : 0.0f;
  const float cys = anySpin ? cosf(ay) : 1.0f, sys = anySpin ? sinf(ay) : 0.0f;
  const float czs = anySpin ? cosf(az) : 1.0f, szs = anySpin ? sinf(az) : 0.0f;
  /* Column-major 4x4: element (row r, column c) lives at m[c * 4 + r]. */
  float R[16] = {
    1.0f, 0.0f, 0.0f, 0.0f,
    0.0f, 1.0f, 0.0f, 0.0f,
    0.0f, 0.0f, 1.0f, 0.0f,
    0.0f, 0.0f, 0.0f, 1.0f
  };
  {
    /* Rx */
    float mx[16] = { 1, 0, 0, 0,  0, cxs, sxs, 0,  0, -sxs, cxs, 0,  0, 0, 0, 1 };
    /* Ry */
    float my[16] = { cys, 0, -sys, 0,  0, 1, 0, 0,  sys, 0, cys, 0,  0, 0, 0, 1 };
    /* Rz */
    float mz[16] = { czs, szs, 0, 0,  -szs, czs, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1 };
    auto mul = [](const float* a, const float* b, float* out) {
      for (uint32_t col = 0; col < 4u; ++col) {
        for (uint32_t row = 0; row < 4u; ++row) {
          float acc = 0.0f;
          for (uint32_t k = 0; k < 4u; ++k) acc += a[k * 4u + row] * b[col * 4u + k];
          out[col * 4u + row] = acc;
        }
      }
    };
    float tmp[16];
    mul(my, mx, tmp);      /* Ry * Rx */
    mul(mz, tmp, R);       /* Rz * (Ry * Rx) */
  }
  /* The offset matrix: rotate, then translate. */
  float M[16];
  for (uint32_t i = 0; i < 16u; ++i) M[i] = R[i];
  M[12] = translation.x; M[13] = translation.y; M[14] = translation.z;

  /* use_object_offset: offset = offset * inverse(object) * offset_object. The
     caller has already reduced that to matrix_world(object)^-1 *
     matrix_world(offset object), so the whole relative transform arrives in
     the session matrix. */
  if (use_object_offset && g_s.matrix) {
    float rel[16];
    for (uint32_t i = 0; i < 16u; ++i) rel[i] = g_s.matrix[i];
    float out[16];
    for (uint32_t col = 0; col < 4u; ++col) {
      for (uint32_t row = 0; row < 4u; ++row) {
        float acc = 0.0f;
        for (uint32_t k = 0; k < 4u; ++k) acc += M[k * 4u + row] * rel[col * 4u + k];
        out[col * 4u + row] = acc;
      }
    }
    for (uint32_t i = 0; i < 16u; ++i) M[i] = out[i];
  }

  const float eps = 1e-6f;
  const float dist = sqrtf(M[12] * M[12] + M[13] * M[13] + M[14] * M[14]);
  uint32_t copies = count < 1u ? 1u : count;
  if (fit_type == 1u || fit_type == 2u) {
    /* arrayModifier_doArray: (length + epsilon) / dist + 1, truncated. */
    copies = dist > eps ? static_cast<uint32_t>((fit_length + eps) / dist) + 1u : 1u;
  }
  if (copies > 4096u) copies = 4096u;
  if (copies > 1u && (v * copies > g_s.vcap || t * copies > g_s.tcap)) {
    /* Fit Length can ask for more copies than the session holds; build as many
       as fit instead of losing the whole modifier. */
    const uint32_t byVerts = g_s.vcap / v, byTris = g_s.tcap / t;
    copies = byVerts < byTris ? byVerts : byTris;
    if (copies < 1u) copies = 1u;
  }
  if (copies == 1u) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    if (g_s.flagMode && g_s.inSmooth && g_s.outSmooth) for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i];
    return commit(v, t);
  }

  const uint32_t totalV = v * copies;
  float* cur = modArray<float>(16u);   /* the running offset matrix */
  uint32_t* parent = nullptr;
  if (merge) {
    parent = modArray<uint32_t>(totalV);
    if (!parent) return -2;
    for (uint32_t i = 0; i < totalV; ++i) parent[i] = i;
  }
  if (!cur) return -2;
  for (uint32_t i = 0; i < 16u; ++i) cur[i] = (i % 5u == 0u) ? 1.0f : 0.0f;

  for (uint32_t c = 0; c < copies; ++c) {
    if (c > 0u) {
      float next[16];
      for (uint32_t col = 0; col < 4u; ++col) {
        for (uint32_t row = 0; row < 4u; ++row) {
          float acc = 0.0f;
          for (uint32_t k = 0; k < 4u; ++k) acc += cur[k * 4u + row] * M[col * 4u + k];
          next[col * 4u + row] = acc;
        }
      }
      for (uint32_t i = 0; i < 16u; ++i) cur[i] = next[i];
    }
    const uint32_t base = c * v;
    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(g_s.inPos, i);
      const Vec3 q(p.x * cur[0] + p.y * cur[4] + p.z * cur[8] + cur[12],
                   p.x * cur[1] + p.y * cur[5] + p.z * cur[9] + cur[13],
                   p.x * cur[2] + p.y * cur[6] + p.z * cur[10] + cur[14]);
      writePos(g_s.outPos, base + i, q);
      if (g_s.hasUv) {
        g_s.outUv[(base + i) * 2] = g_s.inUv[i * 2] + uv_u * static_cast<float>(c);
        g_s.outUv[(base + i) * 2 + 1] = g_s.inUv[i * 2 + 1] + uv_v * static_cast<float>(c);
      }
    }
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t o = (c * t + f) * 3;
      g_s.outIdx[o] = base + g_s.inIdx[f * 3];
      g_s.outIdx[o + 1] = base + g_s.inIdx[f * 3 + 1];
      g_s.outIdx[o + 2] = base + g_s.inIdx[f * 3 + 2];
      if (g_s.flagMode && g_s.inSmooth && g_s.outSmooth) g_s.outSmooth[c * t + f] = g_s.inSmooth[f];
    }
  }

  /* ---- merge: weld the seam between each copy and the one before it ---- */
  if (merge && merge_dist > 0.0f) {
    auto findRoot = [&](uint32_t i) {
      while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    /* Chain c -> c-1 through a grid keyed by the merge distance. */
    const float cell = merge_dist;
    const float inv = 1.0f / cell;
    const uint32_t cap = nextPow2(v * 2u + 8u);
    int32_t* head = modArray<int32_t>(cap);
    int32_t* next = modArray<int32_t>(v);
    int32_t* gx = modArray<int32_t>(v);
    int32_t* gy = modArray<int32_t>(v);
    int32_t* gz = modArray<int32_t>(v);
    if (!head || !next || !gx || !gy || !gz) return -2;
    for (uint32_t c = 1; c < copies; ++c) {
      for (uint32_t i = 0; i < cap; ++i) head[i] = -1;
      for (uint32_t i = 0; i < v; ++i) {
        const Vec3 p = readPos(g_s.outPos, (c - 1u) * v + i);
        const int32_t qx = quantize(p.x, inv), qy = quantize(p.y, inv), qz = quantize(p.z, inv);
        const uint32_t slot = hashU32(static_cast<uint32_t>(qx) * 73856093u ^
                                      static_cast<uint32_t>(qy) * 19349663u ^
                                      static_cast<uint32_t>(qz) * 83492791u) & (cap - 1u);
        gx[i] = qx; gy[i] = qy; gz[i] = qz;
        next[i] = head[slot];
        head[slot] = static_cast<int32_t>(i);
      }
      for (uint32_t i = 0; i < v; ++i) {
        const uint32_t here = c * v + i;
        const Vec3 p = readPos(g_s.outPos, here);
        const int32_t qx = quantize(p.x, inv), qy = quantize(p.y, inv), qz = quantize(p.z, inv);
        bool matched = false;
        for (int32_t dz = -1; dz <= 1 && !matched; ++dz) {
          for (int32_t dy = -1; dy <= 1 && !matched; ++dy) {
            for (int32_t dx = -1; dx <= 1 && !matched; ++dx) {
              const uint32_t slot = hashU32(static_cast<uint32_t>(qx + dx) * 73856093u ^
                                            static_cast<uint32_t>(qy + dy) * 19349663u ^
                                            static_cast<uint32_t>(qz + dz) * 83492791u) & (cap - 1u);
              for (int32_t j = head[slot]; j >= 0; j = next[j]) {
                if (gx[j] != qx + dx || gy[j] != qy + dy || gz[j] != qz + dz) continue;
                const Vec3 other = readPos(g_s.outPos, (c - 1u) * v + static_cast<uint32_t>(j));
                if (length(p - other) > merge_dist) continue;
                const uint32_t ra = findRoot(here);
                const uint32_t rb = findRoot((c - 1u) * v + static_cast<uint32_t>(j));
                if (ra != rb) parent[ra] = rb;
                matched = true;
                break;
              }
            }
          }
        }
      }
    }
    /* Compact: one vertex per root, keeping the first copy's position. */
    uint32_t* remap = modArray<uint32_t>(totalV);
    if (!remap) return -2;
    uint32_t outV = 0u;
    for (uint32_t i = 0; i < totalV; ++i) {
      if (findRoot(i) != i) { remap[i] = 0xFFFFFFFFu; continue; }
      remap[i] = outV;
      writePos(g_s.outPos, outV, readPos(g_s.outPos, i));
      if (g_s.hasUv) {
        g_s.outUv[outV * 2] = g_s.outUv[i * 2];
        g_s.outUv[outV * 2 + 1] = g_s.outUv[i * 2 + 1];
      }
      ++outV;
    }
    for (uint32_t i = 0; i < totalV; ++i) if (remap[i] != 0xFFFFFFFFu) remap[i] = remap[findRoot(i)];
    uint32_t outT = 0u;
    for (uint32_t f = 0; f < t * copies; ++f) {
      const uint32_t a = remap[g_s.outIdx[f * 3]], b = remap[g_s.outIdx[f * 3 + 1]], c2 = remap[g_s.outIdx[f * 3 + 2]];
      if (a == 0xFFFFFFFFu || b == 0xFFFFFFFFu || c2 == 0xFFFFFFFFu) continue;
      if (a == b || b == c2 || c2 == a) continue;
      g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = c2;
      if (g_s.flagMode && g_s.inSmooth && g_s.outSmooth) g_s.outSmooth[outT] = g_s.outSmooth[f];
      ++outT;
    }
    if (outT == 0u || outV == 0u) return -4;
    return commit(outV, outT);
  }

  return commit(totalV, t * copies);
}

FE_EXPORT int32_t fe_mod_array(uint32_t count, float ox, float oy, float oz, float rx, float ry, float rz, float rotate_per_step_deg) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const uint32_t copies = count < 1u ? 1u : (count > 100u ? 100u : count);
  if (copies == 1u) return 0;
  if (v * copies > g_s.vcap || t * copies > g_s.tcap) return -2;

  const Box box = meshBounds(g_s.inPos, v);
  const Vec3 ext = box.size();
  const Vec3 step = Vec3(ox, oy, oz) + Vec3(rx * ext.x, ry * ext.y, rz * ext.z);
  const float spin = rotate_per_step_deg * kDeg2Rad;
  const Vec3 spinAxis = axisVector(1u);

  for (uint32_t c = 0; c < copies; ++c) {
    const uint32_t base = c * v;
    const float angle = spin * static_cast<float>(c);
    for (uint32_t i = 0; i < v; ++i) {
      Vec3 p = readPos(g_s.inPos, i);
      if (rotate_per_step_deg != 0.0f) p = rotateAxis(p, spinAxis, angle);
      writePos(g_s.outPos, base + i, p + step * static_cast<float>(c));
      if (g_s.hasUv) { g_s.outUv[(base + i) * 2] = g_s.inUv[i * 2]; g_s.outUv[(base + i) * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    }
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t o = (c * t + f) * 3;
      g_s.outIdx[o] = base + g_s.inIdx[f * 3];
      g_s.outIdx[o + 1] = base + g_s.inIdx[f * 3 + 1];
      g_s.outIdx[o + 2] = base + g_s.inIdx[f * 3 + 2];
      if (g_s.outSmooth && g_s.inSmooth) g_s.outSmooth[c * t + f] = g_s.inSmooth[f];
    }
  }
  return commit(v * copies, t * copies);
}

/* Subdivision. Split every triangle into four with edge midpoints and weld the
   shared midpoints; then the two modes Blender offers:

     - Catmull-Clark (mode 0): relax once with the Loop vertex rule, so the
       surface rounds off and the silhouette changes;
     - Simple (mode 1): move nothing. The midpoints are already exactly on the
       edges they split and the old vertices keep their positions, so the
       silhouette is unchanged and only the topology is finer.

   The session has a fixed capacity, and a slider has no idea how big a level
   is before it is built. Rather than refuse the whole request when level ten
   does not fit, the kernel builds level after level and stops at the last one
   the session holds, returning how many it built. A caller that asked for ten
   on a mesh with room for six gets six levels of real geometry and a 6. */
FE_EXPORT int32_t fe_mod_subdivide(uint32_t levels, uint32_t simple) {
  if (!g_s.ready) return -1;
  const uint32_t want = levels > 10u ? 10u : levels;
  if (want == 0u) return 0;
  const bool plain = simple != 0u;

  uint32_t v = g_s.vc, t = g_s.tc;
  uint32_t done = 0;
  for (uint32_t level = 0; level < want; ++level) {
    const uint32_t nv = v + t * 3u;
    const uint32_t nt = t * 4u;
    if (nv > g_s.vcap || nt > g_s.tcap) break;

    for (uint32_t i = 0; i < v; ++i) {
      writePos(g_s.outPos, i, readPos(g_s.inPos, i));
      if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    }
    uint32_t next = v, o = 0;
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t a = g_s.inIdx[f * 3], b = g_s.inIdx[f * 3 + 1], c = g_s.inIdx[f * 3 + 2];
      const Vec3 pa = readPos(g_s.inPos, a), pb = readPos(g_s.inPos, b), pc = readPos(g_s.inPos, c);
      const uint32_t iab = next++, ibc = next++, ica = next++;
      writePos(g_s.outPos, iab, (pa + pb) * 0.5f);
      writePos(g_s.outPos, ibc, (pb + pc) * 0.5f);
      writePos(g_s.outPos, ica, (pc + pa) * 0.5f);
      if (g_s.hasUv) {
        const float ua0 = g_s.inUv[a * 2], ua1 = g_s.inUv[a * 2 + 1];
        const float ub0 = g_s.inUv[b * 2], ub1 = g_s.inUv[b * 2 + 1];
        const float uc0 = g_s.inUv[c * 2], uc1 = g_s.inUv[c * 2 + 1];
        g_s.outUv[iab * 2] = (ua0 + ub0) * 0.5f; g_s.outUv[iab * 2 + 1] = (ua1 + ub1) * 0.5f;
        g_s.outUv[ibc * 2] = (ub0 + uc0) * 0.5f; g_s.outUv[ibc * 2 + 1] = (ub1 + uc1) * 0.5f;
        g_s.outUv[ica * 2] = (uc0 + ua0) * 0.5f; g_s.outUv[ica * 2 + 1] = (uc1 + ua1) * 0.5f;
      }
      g_s.outIdx[o++] = a;   g_s.outIdx[o++] = iab; g_s.outIdx[o++] = ica;
      g_s.outIdx[o++] = iab; g_s.outIdx[o++] = b;   g_s.outIdx[o++] = ibc;
      g_s.outIdx[o++] = ica; g_s.outIdx[o++] = ibc; g_s.outIdx[o++] = c;
      g_s.outIdx[o++] = iab; g_s.outIdx[o++] = ibc; g_s.outIdx[o++] = ica;
      /* Four children, one parent: they inherit how it is shaded. A flat face
         subdivides into flat faces, and Simple subdivision then shows exactly
         the model it started from. */
      if (g_s.outSmooth && g_s.inSmooth) {
        const uint8_t shade = g_s.inSmooth[f];
        g_s.outSmooth[f * 4] = shade;
        g_s.outSmooth[f * 4 + 1] = shade;
        g_s.outSmooth[f * 4 + 2] = shade;
        g_s.outSmooth[f * 4 + 3] = shade;
      }
    }
    copyOutToIn(nv, nt);
    v = nv;
    t = nt;

    uint32_t* remap = modArray<uint32_t>(v + 1u);
    if (!remap) return -2;
    uint32_t wv = 0, wt = 0;
    const int32_t rc = weldSession(1e-6f, &wv, &wt, remap);
    if (rc != 0) return rc;
    copyOutToIn(wv, wt);
    v = wv;
    t = wt;

    if (!plain) {
      const int32_t rr = loopRelax();
      if (rr != 0) return rr;
    }
    ++done;
  }
  if (done == 0u) return -2;
  /* Simple mode never enters loopRelax, which is where the other mode gets its
     normals, so they are built once here for both - and then the per-face
     shading is applied, which is what keeps a flat cube flat however many times
     it is split. */
  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  if (g_s.flagMode) v = applyFaceShading(v, t);
  g_s.vc = v;
  g_s.counts[0] = v;
  g_s.counts[1] = t;
  return static_cast<int32_t>(done);
}

/* Vertex-clustering decimation: choose a grid resolution by bisection so the
   surviving face count lands near the requested ratio, then emit the collapse. */
FE_EXPORT int32_t fe_mod_decimate(float ratio, int32_t preserve_boundary) {
  if (!g_s.ready) return -1;
  /* Clustered faces do not correspond to the ones they replaced. */
  g_s.flagMode = 0;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const float r = clampf(ratio, 0.01f, 1.0f);
  const uint32_t targetT = static_cast<uint32_t>(maxf(1.0f, floorf(static_cast<float>(t) * r)));
  if (targetT >= t) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    return commit(v, t);
  }

  const uint32_t cap = nextPow2(v + 1u);
  uint32_t* cellIndex = modArray<uint32_t>(cap);
  uint32_t* firstVertex = modArray<uint32_t>(cap);
  uint32_t* counts = modArray<uint32_t>(v);
  float* sums = modArray<float>(v * 3u);
  float* uvs = modArray<float>(v * 2u);
  uint32_t* cellOf = modArray<uint32_t>(v);
  if (!cellIndex || !firstVertex || !counts || !sums || !uvs || !cellOf) return -2;

  uint8_t* boundary = nullptr;
  if (preserve_boundary) {
    boundary = modArray<uint8_t>(v);
    EdgeTable edges;
    if (boundary && edgeTableInit(edges, t, false)) {
      for (uint32_t i = 0; i < v; ++i) boundary[i] = 0;
      for (uint32_t f = 0; f < t; ++f) {
        edgeTableAdd(edges, g_s.inIdx[f * 3], g_s.inIdx[f * 3 + 1], f);
        edgeTableAdd(edges, g_s.inIdx[f * 3 + 1], g_s.inIdx[f * 3 + 2], f);
        edgeTableAdd(edges, g_s.inIdx[f * 3 + 2], g_s.inIdx[f * 3], f);
      }
      for (uint32_t s = 0; s <= edges.mask; ++s) {
        if (edges.count[s] != 1u) continue;
        boundary[edges.a[s]] = 1;
        boundary[edges.b[s]] = 1;
      }
    }
  }

  const Box box = meshBounds(g_s.inPos, v);
  const Vec3 ext = box.size();
  const float maxExt = maxf(maxf(ext.x, ext.y), ext.z);

  /* Build clusters for a grid of n cells per axis; returns surviving triangles. */
  auto build = [&](uint32_t n, bool emit) -> int32_t {
    const float inv = maxExt > 1e-9f ? static_cast<float>(n) / maxExt : 1.0f;
    for (uint32_t i = 0; i < cap; ++i) cellIndex[i] = 0xFFFFFFFFu;
    uint32_t cells = 0;
    for (uint32_t i = 0; i < v; ++i) {
      if (boundary && boundary[i]) {
        cellOf[i] = cells;
        firstVertex[cells] = i;
        sums[cells * 3] = 0.0f; sums[cells * 3 + 1] = 0.0f; sums[cells * 3 + 2] = 0.0f;
        uvs[cells * 2] = 0.0f; uvs[cells * 2 + 1] = 0.0f;
        counts[cells] = 0;
        cells++;
        continue;
      }
      const Vec3 p = readPos(g_s.inPos, i) - box.lo;
      const uint32_t qx = static_cast<uint32_t>(clampf(floorf(p.x * inv), 0.0f, 255.0f));
      const uint32_t qy = static_cast<uint32_t>(clampf(floorf(p.y * inv), 0.0f, 255.0f));
      const uint32_t qz = static_cast<uint32_t>(clampf(floorf(p.z * inv), 0.0f, 255.0f));
      const uint32_t key = hashU32(qx * 73856093u ^ qy * 19349663u ^ qz * 83492791u) & (cap - 1u);
      uint32_t slot = key;
      uint32_t bucket = 0xFFFFFFFFu;
      for (uint32_t probe = 0; probe < cap; ++probe) {
        if (cellIndex[slot] == 0xFFFFFFFFu) {
          bucket = cells;
          cellIndex[slot] = cells;
          firstVertex[cells] = i;
          sums[cells * 3] = 0.0f; sums[cells * 3 + 1] = 0.0f; sums[cells * 3 + 2] = 0.0f;
          uvs[cells * 2] = 0.0f; uvs[cells * 2 + 1] = 0.0f;
          counts[cells] = 0;
          cells++;
          break;
        }
        const uint32_t fv = firstVertex[cellIndex[slot]];
        const Vec3 fp = readPos(g_s.inPos, fv) - box.lo;
        if (static_cast<uint32_t>(clampf(floorf(fp.x * inv), 0.0f, 255.0f)) == qx &&
            static_cast<uint32_t>(clampf(floorf(fp.y * inv), 0.0f, 255.0f)) == qy &&
            static_cast<uint32_t>(clampf(floorf(fp.z * inv), 0.0f, 255.0f)) == qz) {
          bucket = cellIndex[slot];
          break;
        }
        slot = (slot + 1u) & (cap - 1u);
      }
      if (bucket == 0xFFFFFFFFu) return -2;
      cellOf[i] = bucket;
      const Vec3 p2 = readPos(g_s.inPos, i);
      sums[bucket * 3] += p2.x; sums[bucket * 3 + 1] += p2.y; sums[bucket * 3 + 2] += p2.z;
      if (g_s.hasUv) { uvs[bucket * 2] += g_s.inUv[i * 2]; uvs[bucket * 2 + 1] += g_s.inUv[i * 2 + 1]; }
      counts[bucket]++;
    }

    uint32_t surviving = 0;
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t a = cellOf[g_s.inIdx[f * 3]], b = cellOf[g_s.inIdx[f * 3 + 1]], c = cellOf[g_s.inIdx[f * 3 + 2]];
      if (a == b || b == c || c == a) continue;
      if (emit) {
        g_s.outIdx[surviving * 3] = a; g_s.outIdx[surviving * 3 + 1] = b; g_s.outIdx[surviving * 3 + 2] = c;
      }
      surviving++;
    }
    if (emit) {
      for (uint32_t c = 0; c < cells; ++c) {
        const float invCount = counts[c] ? 1.0f / static_cast<float>(counts[c]) : 1.0f;
        writePos(g_s.outPos, c, Vec3(sums[c * 3] * invCount, sums[c * 3 + 1] * invCount, sums[c * 3 + 2] * invCount));
        if (g_s.hasUv) { g_s.outUv[c * 2] = uvs[c * 2] * invCount; g_s.outUv[c * 2 + 1] = uvs[c * 2 + 1] * invCount; }
      }
      g_s.counts[0] = cells;
      g_s.counts[1] = surviving;
    }
    return static_cast<int32_t>(emit ? cells : surviving);
  };

  uint32_t lo = 2, hi = 96, best = 2, bestErr = 0xFFFFFFFFu;
  for (uint32_t it = 0; it < 7; ++it) {
    const uint32_t n = (lo + hi) / 2u;
    const int32_t faces = build(n, false);
    if (faces < 0) return faces;
    const uint32_t diff = static_cast<uint32_t>(faces) > targetT
      ? static_cast<uint32_t>(faces) - targetT : targetT - static_cast<uint32_t>(faces);
    if (diff < bestErr) { bestErr = diff; best = n; }
    /* More cells means more surviving faces, so search downward when over budget. */
    if (static_cast<uint32_t>(faces) > targetT) hi = n > 0u ? n - 1u : 0u; else lo = n + 1u;
    if (lo > hi) break;
  }

  const int32_t cellsOut = build(best, true);
  if (cellsOut < 0) return cellsOut;
  const uint32_t outV = static_cast<uint32_t>(cellsOut);
  const uint32_t outT = g_s.counts[1];
  if (outV == 0 || outT == 0) return -4;
  return commit(outV, outT);
}

/* =========================================================================
 * Collapse decimation - ported from bmesh_decimate_collapse.cc
 *
 *   source/blender/bmesh/tools/bmesh_decimate_collapse.cc (GPL-2.0-or-later)
 *
 * The kernel that used to sit behind the Decimate modifier was a vertex
 * clusterer: it snapped vertices to a grid, so a face that spanned two cells
 * became a shape that never existed. Fine at 50 %, a lumpy box at 10 %.
 *
 * This is Blender's collapse instead, kept as close to the original as a flat
 * triangle buffer allows. What is carried over:
 *
 *   - bm_decim_build_quadrics(): one 10-float symmetric quadric per vertex,
 *     summed from the plane through each incident face's centre, then a plane
 *     perpendicular to every boundary edge (cross(edge, face normal), through
 *     the edge midpoint) scaled by BOUNDARY_PRESERVE_WEIGHT = 100 so a rim
 *     stays a rim;
 *   - bm_decim_calc_target_co_db(): the collapse target is the quadric
 *     minimum when BLI_quadric_optimize() finds one (determinant above
 *     OPTIMIZE_EPS = 1e-8), otherwise the edge midpoint;
 *   - bm_decim_build_edge_cost_single(): cost = |eval(q1) + eval(q2)| at that
 *     target, and an edge that cannot collapse right now gets COST_INVALID
 *     rather than being dropped, so it is retried once its surroundings move;
 *   - the degenerate-topology test (the link condition): the two vertex
 *     neighbourhoods may only overlap in the vertices of the faces the edge
 *     itself joins;
 *   - bm_edge_collapse_is_degenerate_flip(), inequality included:
 *     dot(cross_exist, cross_optim) <= (|cross_exist|^2 + |cross_optim|^2) * 0.01
 *     So a face is never allowed to fold flat, only to shrink.
 *
 * Not carried over, and stated plainly: BMesh's custom-data interpolation
 * (vertex weights, shape keys, UV corners, vertex groups - the kernel keeps
 * the surviving vertex's UV), the symmetry KD-tree pass, and Blender's
 * dissolve-based mode. What runs here is the collapse path, which is what the
 * modifier does at every ratio.
 * ========================================================================= */

/* BLI_quadric: symmetric 4x4, stored as the upper triangle. */
struct Quadric {
  float m[10];  /* a2 ab ac ad  b2 bc bd  c2 cd  d2 */
};

inline void quadricZero(Quadric& q) { for (uint32_t i = 0; i < 10u; ++i) q.m[i] = 0.0f; }

/* BLI_quadric_from_plane(): outer product of the plane. */
inline void quadricAddPlane(Quadric& q, const Vec3& n, float d, float w) {
  q.m[0] += w * n.x * n.x;
  q.m[1] += w * n.x * n.y;
  q.m[2] += w * n.x * n.z;
  q.m[3] += w * n.x * d;
  q.m[4] += w * n.y * n.y;
  q.m[5] += w * n.y * n.z;
  q.m[6] += w * n.y * d;
  q.m[7] += w * n.z * n.z;
  q.m[8] += w * n.z * d;
  q.m[9] += w * d * d;
}

inline void quadricAdd(Quadric& a, const Quadric& b) { for (uint32_t i = 0; i < 10u; ++i) a.m[i] += b.m[i]; }

/* BLI_quadric_evaluate(): v' * Q * v. */
inline float quadricError(const Quadric& q, const Vec3& v) {
  const float x = v.x, y = v.y, z = v.z;
  return q.m[0] * x * x + 2.0f * q.m[1] * x * y + 2.0f * q.m[2] * x * z + 2.0f * q.m[3] * x
       + q.m[4] * y * y + 2.0f * q.m[5] * y * z + 2.0f * q.m[6] * y
       + q.m[7] * z * z + 2.0f * q.m[8] * z
       + q.m[9];
}

/* BLI_quadric_optimize(): the point minimising the quadric, if the system is
 * well conditioned. Returns false (the caller then uses the midpoint) exactly
 * when the 3x3 determinant is not above eps. */
inline bool quadricOptimize(const Quadric& q, float eps, Vec3& out) {
  const float a2 = q.m[0], ab = q.m[1], ac = q.m[2], ad = q.m[3];
  const float b2 = q.m[4], bc = q.m[5], bd = q.m[6];
  const float c2 = q.m[7], cd = q.m[8];
  const float det = a2 * (b2 * c2 - bc * bc) - ab * (ab * c2 - bc * ac) + ac * (ab * bc - b2 * ac);
  if (!isfinitef(det) || absf(det) <= eps) return false;
  const float inv = 1.0f / det;
  out.x = -(ad * (b2 * c2 - bc * bc) - ab * (bd * c2 - bc * cd) + ac * (bd * bc - b2 * cd)) * inv;
  out.y = -(a2 * (bd * c2 - bc * cd) - ad * (ab * c2 - bc * ac) + ac * (ab * cd - bd * ac)) * inv;
  out.z = -(a2 * (b2 * cd - bd * bc) - ab * (ab * cd - bd * ac) + ad * (ab * bc - b2 * ac)) * inv;
  return isfinitef(out.x + out.y + out.z);
}

#define DECIM_BOUNDARY_PRESERVE_WEIGHT 100.0f
#define DECIM_OPTIMIZE_EPS 1e-8f
#define DECIM_TOPOLOGY_FALLBACK_EPS 1e-12f
#define DECIM_COST_INVALID 3.402823466e+38f

/* A binary min-heap of (cost, edge). An entry is re-checked against the live
 * quadrics when it is popped: if the numbers moved it is re-pushed with the
 * fresh cost, which is Blender's heap-update without a per-edge node table. */
struct CollapseHeap {
  float* cost = nullptr;
  uint64_t* key = nullptr;   /* (uint64)a | ((uint64)b << 32) */
  uint32_t size = 0, capacity = 0;
};

inline void heapSwap(CollapseHeap& h, uint32_t i, uint32_t j) {
  const float c = h.cost[i]; h.cost[i] = h.cost[j]; h.cost[j] = c;
  const uint64_t k = h.key[i]; h.key[i] = h.key[j]; h.key[j] = k;
}

bool heapPush(CollapseHeap& h, float cost, uint32_t a, uint32_t b) {
  if (h.size >= h.capacity) return false;
  uint32_t i = h.size++;
  h.cost[i] = cost;
  h.key[i] = static_cast<uint64_t>(a) | (static_cast<uint64_t>(b) << 32);
  while (i > 0u) {
    const uint32_t p = (i - 1u) >> 1u;
    if (h.cost[p] <= h.cost[i]) break;
    heapSwap(h, p, i);
    i = p;
  }
  return true;
}

bool heapPop(CollapseHeap& h, float& cost, uint32_t& a, uint32_t& b) {
  if (h.size == 0u) return false;
  cost = h.cost[0];
  const uint64_t k = h.key[0];
  a = static_cast<uint32_t>(k & 0xFFFFFFFFu);
  b = static_cast<uint32_t>(k >> 32);
  --h.size;
  if (h.size > 0u) {
    h.cost[0] = h.cost[h.size];
    h.key[0] = h.key[h.size];
    uint32_t i = 0;
    for (;;) {
      const uint32_t l = i * 2u + 1u, r = l + 1u;
      uint32_t best = i;
      if (l < h.size && h.cost[l] < h.cost[best]) best = l;
      if (r < h.size && h.cost[r] < h.cost[best]) best = r;
      if (best == i) break;
      heapSwap(h, i, best);
      i = best;
    }
  }
  return true;
}

/* bm_decim_build_edge_cost_single(), triangle-buffer form. Full edge list is
 * walked once for the quadrics; afterwards an edge's cost only changes when
 * one of its two vertices moves. */
FE_EXPORT int32_t fe_mod_decimate_collapse(float ratio, int32_t preserve_boundary,
                                          int32_t use_symmetry, int32_t symmetry_axis,
                                          float vweight_factor) {
  if (!g_s.ready) return -1;
  g_s.flagMode = 0;                 /* a collapsed mesh has no 1:1 face mapping */
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const float r = clampf(ratio, 0.01f, 1.0f);
  const uint32_t targetT = static_cast<uint32_t>(maxf(1.0f, floorf(static_cast<float>(t) * r)));
  if (targetT >= t) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    return commit(v, t);
  }

  float* pos = modArray<float>(v * 3u);
  uint32_t* faces = modArray<uint32_t>(t * 3u);
  uint8_t* aliveV = modArray<uint8_t>(v);
  uint8_t* aliveF = modArray<uint8_t>(t);
  Quadric* quad = modArray<Quadric>(v);
  int32_t* head = modArray<int32_t>(v);
  int32_t* nextFace = modArray<int32_t>(t * 3u);
  float* foldNormal = modArray<float>(t * 3u);
  uint32_t* remap = modArray<uint32_t>(v);
  CollapseHeap heap;
  const uint32_t heapCap = t * 3u + 64u;
  heap.cost = modArray<float>(heapCap);
  heap.key = modArray<uint64_t>(heapCap);
  heap.capacity = heapCap;
  if (!pos || !faces || !aliveV || !aliveF || !quad || !head || !nextFace || !foldNormal ||
      !remap || !heap.cost || !heap.key) return -2;

  for (uint32_t i = 0; i < v * 3u; ++i) pos[i] = g_s.inPos[i];
  for (uint32_t i = 0; i < t * 3u; ++i) faces[i] = g_s.inIdx[i];
  for (uint32_t i = 0; i < v; ++i) { aliveV[i] = 1; head[i] = -1; quadricZero(quad[i]); }
  for (uint32_t f = 0; f < t; ++f) {
    aliveF[f] = 1;
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t vi = faces[f * 3u + k];
      nextFace[f * 3u + k] = head[vi];
      head[vi] = static_cast<int32_t>(f * 3u + k);
    }
  }

  auto faceHas = [&](uint32_t f, uint32_t vi) {
    return faces[f * 3u] == vi || faces[f * 3u + 1u] == vi || faces[f * 3u + 2u] == vi;
  };
  auto safeNormal = [&](uint32_t f) {
    const Vec3 a = readPos(pos, faces[f * 3u]), b = readPos(pos, faces[f * 3u + 1u]);
    const Vec3 c = readPos(pos, faces[f * 3u + 2u]);
    const Vec3 n = cross(b - a, c - a);
    const float len = length(n);
    foldNormal[f * 3u] = len > 0.0f ? n.x / len : 0.0f;
    foldNormal[f * 3u + 1u] = len > 0.0f ? n.y / len : 0.0f;
    foldNormal[f * 3u + 2u] = len > 0.0f ? n.z / len : 0.0f;
  };

  /* ---- bm_decim_build_quadrics() ---- */
  for (uint32_t f = 0; f < t; ++f) {
    safeNormal(f);
    const Vec3 a = readPos(pos, faces[f * 3u]), b = readPos(pos, faces[f * 3u + 1u]);
    const Vec3 c = readPos(pos, faces[f * 3u + 2u]);
    const Vec3 centre = (a + b + c) * (1.0f / 3.0f);
    const Vec3 n(foldNormal[f * 3u], foldNormal[f * 3u + 1u], foldNormal[f * 3u + 2u]);
    if (length_sq(n) == 0.0f) continue;
    const float d = -dot(n, centre);
    quadricAddPlane(quad[faces[f * 3u]], n, d, 1.0f);
    quadricAddPlane(quad[faces[f * 3u + 1u]], n, d, 1.0f);
    quadricAddPlane(quad[faces[f * 3u + 2u]], n, d, 1.0f);
  }

  /* Boundary edges, at BOUNDARY_PRESERVE_WEIGHT. A rim vertex is pulled
   * towards the plane through its edge rather than anywhere on the surface. */
  if (preserve_boundary) {
    EdgeTable edges;
    if (edgeTableInit(edges, t, true)) {
      for (uint32_t f = 0; f < t; ++f) {
        edgeTableAdd(edges, faces[f * 3u], faces[f * 3u + 1u], f);
        edgeTableAdd(edges, faces[f * 3u + 1u], faces[f * 3u + 2u], f);
        edgeTableAdd(edges, faces[f * 3u + 2u], faces[f * 3u], f);
      }
      for (uint32_t s = 0; s <= edges.mask; ++s) {
        if (edges.count[s] != 1u || edges.a[s] == 0xFFFFFFFFu) continue;
        const uint32_t a = edges.a[s], b = edges.b[s], f = edges.tri[s];
        if (f >= t) continue;
        const Vec3 pa = readPos(pos, a), pb = readPos(pos, b);
        const Vec3 edgeVec = pb - pa;
        const Vec3 fn(foldNormal[f * 3u], foldNormal[f * 3u + 1u], foldNormal[f * 3u + 2u]);
        Vec3 plane = cross(edgeVec, fn);
        const float len = length(plane);
        if (len <= 1e-7f) continue;              /* FLT_EPSILON guard, as upstream */
        plane = plane * (1.0f / len);
        const Vec3 centre = (pa + pb) * 0.5f;
        const float d = -dot(plane, centre);
        quadricAddPlane(quad[a], plane, d, DECIM_BOUNDARY_PRESERVE_WEIGHT);
        quadricAddPlane(quad[b], plane, d, DECIM_BOUNDARY_PRESERVE_WEIGHT);
      }
    }
  }

  auto targetCo = [&](uint32_t a, uint32_t b, Vec3& out) {
    Quadric q = quad[a];
    quadricAdd(q, quad[b]);
    if (quadricOptimize(q, DECIM_OPTIMIZE_EPS, out)) return;
    out = (readPos(pos, a) + readPos(pos, b)) * 0.5f;
  };

  auto edgeCost = [&](uint32_t a, uint32_t b, Vec3& merged) -> float {
    if (!aliveV[a] || !aliveV[b] || a == b) return DECIM_COST_INVALID;
    uint32_t shared = 0u;
    for (int32_t e = head[a]; e >= 0; e = nextFace[e]) {
      const uint32_t f = static_cast<uint32_t>(e) / 3u;
      if (aliveF[f] && faceHas(f, a) && faceHas(f, b)) ++shared;
    }
    if (shared == 0u || shared > 2u) return DECIM_COST_INVALID;   /* not manifold/boundary */
    targetCo(a, b, merged);
    /* Same as upstream: sum the two vertex quadrics at the target, then take
     * the magnitude so a small negative error cannot outrank a real one. */
    float c = absf(quadricError(quad[a], merged) + quadricError(quad[b], merged));
    /* vertex_group + vertex_group_factor: an edge whose end is outside the
     * group is never collapsed at all, and the rest are pushed back by their
     * length. bm_decim_build_edge_cost_single(), the vweights branches. */
    if (g_s.vgOn) {
      const float wa = g_s.vg[a], wb = g_s.vg[b];
      if (wa == 0.0f || wb == 0.0f) return DECIM_COST_INVALID;
      const float e_weight = 2.0f - (wa + wb);
      if (e_weight != 0.0f) c += length(readPos(pos, a) - readPos(pos, b)) * (e_weight * vweight_factor);
    }
    return c;
  };

  uint32_t pushed = 0u;
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t c[3] = { faces[f * 3u], faces[f * 3u + 1u], faces[f * 3u + 2u] };
    for (uint32_t k = 0; k < 3u; ++k) {
      uint32_t a = c[k], b = c[(k + 1u) % 3u];
      if (a > b) { const uint32_t s = a; a = b; b = s; }
      Vec3 merged;
      if (heapPush(heap, edgeCost(a, b, merged), a, b)) ++pushed;
    }
  }

  auto collectNeighbours = [&](uint32_t vi, uint32_t* out, uint32_t& count) {
    count = 0u;
    for (int32_t e = head[vi]; e >= 0; e = nextFace[e]) {
      const uint32_t f = static_cast<uint32_t>(e) / 3u;
      if (!aliveF[f] || !faceHas(f, vi)) continue;
      for (uint32_t k = 0; k < 3u; ++k) {
        const uint32_t other = faces[f * 3u + k];
        if (other == vi) continue;
        bool seen = false;
        for (uint32_t i = 0; i < count; ++i) if (out[i] == other) { seen = true; break; }
        if (!seen && count < 128u) out[count++] = other;
      }
    }
  };

  uint32_t faceCount = t;
  uint32_t pops = 0u;
  const uint32_t popBudget = t * 24u + 1024u;   /* hard stop; a stale entry costs one pop */

  /* bm_edge_symmetry_map(): pair every vertex with the vertex its mirror lands
   * on, across the chosen axis, before the collapse starts. The collapse loop
   * then collapses the twin edges together -- a post-pass cannot repair an
   * asymmetric collapse, because the removed vertices are already gone. */
  int32_t* mirrorV = nullptr;
  const bool sym = use_symmetry != 0 && symmetry_axis >= 0 && symmetry_axis <= 2;
  if (sym) {
    const float eps = 1e-4f;
    const float inv = 1.0f / eps;
    const uint32_t hcap = nextPow2(v * 2u + 8u);
    int32_t* head = modArray<int32_t>(hcap);
    int32_t* chain = modArray<int32_t>(v);
    int32_t* cell = modArray<int32_t>(v * 3u);
    mirrorV = modArray<int32_t>(v);
    if (!head || !chain || !cell || !mirrorV) return -2;
    for (uint32_t i = 0; i < hcap; ++i) head[i] = -1;
    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(pos, i);
      const int32_t cx = static_cast<int32_t>(floorf(p.x * inv));
      const int32_t cy = static_cast<int32_t>(floorf(p.y * inv));
      const int32_t cz = static_cast<int32_t>(floorf(p.z * inv));
      cell[i * 3] = cx; cell[i * 3 + 1] = cy; cell[i * 3 + 2] = cz;
      const uint32_t h = hashU32(static_cast<uint32_t>(cx) * 73856093u ^
                                 static_cast<uint32_t>(cy) * 19349663u ^
                                 static_cast<uint32_t>(cz) * 83492791u) & (hcap - 1u);
      chain[i] = head[h];
      head[h] = static_cast<int32_t>(i);
    }
    const float eps2 = eps * eps;
    for (uint32_t i = 0; i < v; ++i) {
      mirrorV[i] = -1;
      Vec3 m = readPos(pos, i);
      if (symmetry_axis == 0) m.x = -m.x;
      else if (symmetry_axis == 1) m.y = -m.y;
      else m.z = -m.z;
      /* 27 cells around the query: after a collapse a partner can sit a hair
       * across a cell boundary, which a single-cell lookup would miss. */
      const int32_t base[3] = {static_cast<int32_t>(floorf(m.x * inv)),
                               static_cast<int32_t>(floorf(m.y * inv)),
                               static_cast<int32_t>(floorf(m.z * inv))};
      int32_t best = -1;
      float bestD = eps2;
      for (int32_t dx = -1; dx <= 1; ++dx) {
        for (int32_t dy = -1; dy <= 1; ++dy) {
          for (int32_t dz = -1; dz <= 1; ++dz) {
            const uint32_t h = hashU32(static_cast<uint32_t>(base[0] + dx) * 73856093u ^
                                       static_cast<uint32_t>(base[1] + dy) * 19349663u ^
                                       static_cast<uint32_t>(base[2] + dz) * 83492791u) & (hcap - 1u);
            for (int32_t j = head[h]; j >= 0; j = chain[j]) {
              if (cell[j * 3] != base[0] + dx || cell[j * 3 + 1] != base[1] + dy ||
                  cell[j * 3 + 2] != base[2] + dz) continue;
              const float d = length_sq(readPos(pos, static_cast<uint32_t>(j)) - m);
              if (d <= bestD) { bestD = d; best = j; }
            }
          }
        }
      }
      mirrorV[i] = best;
    }
  }
  auto mirrorVec = [&](Vec3 p) {
    if (symmetry_axis == 0) p.x = -p.x;
    else if (symmetry_axis == 1) p.y = -p.y;
    else p.z = -p.z;
    return p;
  };

  /* bm_edge_collapse_is_degenerate_topology() + _is_degenerate_flip(), for one
   * edge at a known target. Both edges of a mirrored pair are tested before
   * either is collapsed, since a collapse invalidates the surrounding faces. */
  auto canCollapse = [&](uint32_t a, uint32_t b, const Vec3& merged) -> bool {
    /* Degenerate topology: the two vertex neighbourhoods may overlap only in
     * the faces along this edge. */
    uint32_t shared = 0u;
    for (int32_t e = head[a]; e >= 0; e = nextFace[e]) {
      const uint32_t f = static_cast<uint32_t>(e) / 3u;
      if (aliveF[f] && faceHas(f, a) && faceHas(f, b)) ++shared;
    }
    uint32_t neighbourA[128], neighbourB[128];
    uint32_t na = 0u, nb = 0u;
    collectNeighbours(a, neighbourA, na);
    collectNeighbours(b, neighbourB, nb);
    uint32_t common = 0u;
    for (uint32_t i = 0; i < na; ++i) {
      if (neighbourA[i] == b) continue;
      for (uint32_t j = 0; j < nb; ++j) {
        if (neighbourB[j] == a) continue;
        if (neighbourA[i] == neighbourB[j]) { ++common; break; }
      }
    }
    if (common != shared) return false;

    /* bm_edge_collapse_is_degenerate_flip(), per surrounding vertex. */
    for (uint32_t pass = 0; pass < 2u; ++pass) {
      const uint32_t pivot = pass == 0u ? a : b;
      for (int32_t e = head[pivot]; e >= 0; e = nextFace[e]) {
        const uint32_t f = static_cast<uint32_t>(e) / 3u;
        if (!aliveF[f] || !faceHas(f, pivot)) continue;
        if (faceHas(f, a) && faceHas(f, b)) continue;   /* the faces the edge joins */
        uint32_t prev = 0u, next = 0u;
        for (uint32_t k = 0; k < 3u; ++k) {
          const uint32_t u = faces[f * 3u + (k + 2u) % 3u];
          const uint32_t w = faces[f * 3u + (k + 1u) % 3u];
          if (faces[f * 3u + k] == pivot) { prev = u; next = w; break; }
        }
        if (prev == next) continue;
        const Vec3 coPrev = readPos(pos, prev), coNext = readPos(pos, next);
        const Vec3 vecOther = coPrev - coNext;
        const Vec3 crossExist = cross(vecOther, coPrev - readPos(pos, pivot));
        const Vec3 crossOptim = cross(vecOther, coPrev - merged);
        const float exist2 = length_sq(crossExist), optim2 = length_sq(crossOptim);
        if (dot(crossExist, crossOptim) <= (exist2 + optim2) * 0.01f) return false;
      }
    }
    return true;
  };

  /* bm_edge_collapse(): b merges into a, at the target position. */
  auto doCollapse = [&](uint32_t a, uint32_t b, const Vec3& merged) {
    writePos(pos, a, merged);
    quadricAdd(quad[a], quad[b]);
    aliveV[b] = 0;

    for (int32_t e = head[b]; e >= 0; ) {
      const int32_t eNext = nextFace[e];
      const uint32_t f = static_cast<uint32_t>(e) / 3u;
      if (aliveF[f] && faceHas(f, b)) {
        /* The node has to keep belonging to the corner it was filed under, or
         * a chain would be spliced into another vertex's list. */
        uint32_t corner = 3u;
        for (uint32_t k = 0; k < 3u; ++k) {
          if (faces[f * 3u + k] == b) { faces[f * 3u + k] = a; corner = k; }
        }
        const bool degenerate = faces[f * 3u] == faces[f * 3u + 1u] || faces[f * 3u + 1u] == faces[f * 3u + 2u] ||
                                faces[f * 3u + 2u] == faces[f * 3u];
        if (degenerate || corner == 3u) {
          aliveF[f] = 0;
          --faceCount;
        }
        else {
          /* Re-file the face under its new corner and refresh its plane so
           * later flip tests compare against the face as it is now. */
          const int32_t node = static_cast<int32_t>(f * 3u + corner);
          nextFace[node] = head[a];
          head[a] = node;
          safeNormal(f);
        }
      }
      e = eNext;
    }
    /* Both ends of everything that touched b now have a new cost; the stale
     * entries already in the heap re-price themselves when they surface. */
    if (heap.size + 8u < heap.capacity) {
      for (int32_t e = head[a]; e >= 0; ) {
        const int32_t eNext = nextFace[e];
        const uint32_t f = static_cast<uint32_t>(e) / 3u;
        if (aliveF[f] && faceHas(f, a)) {
          for (uint32_t k = 0; k < 3u; ++k) {
            uint32_t u = faces[f * 3u + k], w = faces[f * 3u + (k + 1u) % 3u];
            if (u == a || w == a) {
              if (u > w) { const uint32_t s2 = u; u = w; w = s2; }
              Vec3 m2;
              heapPush(heap, edgeCost(u, w, m2), u, w);
            }
          }
        }
        e = eNext;
      }
    }
  };

  while (faceCount > targetT && pops < popBudget) {
    float cost;
    uint32_t a, b;
    if (!heapPop(heap, cost, a, b)) break;
    ++pops;
    if (!aliveV[a] || !aliveV[b]) continue;
    Vec3 merged;
    const float fresh = edgeCost(a, b, merged);
    if (fresh == DECIM_COST_INVALID) continue;
    /* The stored cost is only a hint: if the quadrics moved since it was
     * pushed, put the honest number back and let the heap re-order. */
    if (absf(fresh - cost) > 1e-5f * (1.0f + absf(fresh) + absf(cost))) {
      heapPush(heap, fresh, a, b);
      continue;
    }

    /* The mirrored twin of this edge, from the precomputed vertex pairing. */
    uint32_t ma = a, mb = b;
    bool hasMirror = false;
    if (sym) {
      const int32_t mvA = mirrorV[a], mvB = mirrorV[b];
      if (mvA >= 0 && mvB >= 0 && aliveV[static_cast<uint32_t>(mvA)] &&
          aliveV[static_cast<uint32_t>(mvB)]) {
        ma = static_cast<uint32_t>(mvA);
        mb = static_cast<uint32_t>(mvB);
        /* A mirror edge that shares a vertex is refused outright, otherwise the
         * pair would move the shared vertex twice and pull it off the plane
         * (bm_edge_share_vert_check()). */
        if (!(ma == a && mb == b) && (ma == a || ma == b || mb == a || mb == b)) continue;
        if (ma == a && mb == b) {
          /* Its own mirror, so it lies in the plane: keep it there. */
          if (symmetry_axis == 0) merged.x = 0.0f;
          else if (symmetry_axis == 1) merged.y = 0.0f;
          else merged.z = 0.0f;
        }
        else {
          hasMirror = true;
        }
      }
      /* No twin (asymmetric mesh): collapse it alone, as upstream does. */
    }

    if (!canCollapse(a, b, merged)) continue;
    Vec3 mergedM;
    if (hasMirror) {
      mergedM = mirrorVec(merged);
      if (!canCollapse(ma, mb, mergedM)) continue;
    }

    doCollapse(a, b, merged);
    if (hasMirror) doCollapse(ma, mb, mergedM);
  }

  /* ---- compact ---- */
  uint32_t outV = 0u;
  for (uint32_t i = 0; i < v; ++i) {
    if (!aliveV[i]) { remap[i] = 0xFFFFFFFFu; continue; }
    remap[i] = outV;
    writePos(g_s.outPos, outV, readPos(pos, i));
    if (g_s.hasUv) { g_s.outUv[outV * 2] = g_s.inUv[i * 2]; g_s.outUv[outV * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    ++outV;
  }
  uint32_t outT = 0u;
  for (uint32_t f = 0; f < t; ++f) {
    if (!aliveF[f]) continue;
    const uint32_t a = remap[faces[f * 3u]], b = remap[faces[f * 3u + 1u]], c = remap[faces[f * 3u + 2u]];
    if (a == 0xFFFFFFFFu || b == 0xFFFFFFFFu || c == 0xFFFFFFFFu || a == b || b == c || c == a) continue;
    g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = c;
    ++outT;
  }
  if (outT == 0u || outV == 0u) return -4;
  (void)pushed;
  return commit(outV, outT);
}

/* =========================================================================
 * Decimate's other two modes, and the symmetry option of the collapse.
 *
 *   source/blender/bmesh/tools/bmesh_decimate_unsubdivide.cc  (Un-Subdivide)
 *   source/blender/bmesh/tools/bmesh_decimate_dissolve.cc     (Planar)
 *   source/blender/modifiers/intern/MOD_decimate.cc           (the dispatcher)
 *
 * Un-Subdivide dissolves the vertices that a subdivision put there:
 * bm_vert_dissolve_fan_test() accepts a vertex when every edge at it is
 * manifold and no face already joins its ring of neighbours - the fan test
 * that keeps a torus from being pinched - and bm_vert_dissolve_fan() then
 * removes it. Upstream writes the four-edge and three-edge cases out by hand
 * because a quad grid is what it is written for; the ring walk below is the
 * same test with the valence left general, so a triangle grid - which is what
 * a 1-to-4 subdivision of a triangle mesh produces - un-subdivides too.
 *
 * Planar dissolves a region of faces that are coplanar within the angle limit
 * into a single face. The region's border is walked into one loop and that
 * loop is ear-clipped. Unlike Blender this kernel cannot keep an n-gon - the
 * modifier stack hands it triangles and gets triangles back - so the merged
 * face is tessellated on the way out. The surface, its area and its winding
 * are the same; what is gone is the interior vertices and the interior edges,
 * which is what the modifier removes.
 * ========================================================================= */

/* Ear clipping of one closed loop of vertex ids, projected onto the loop's own
 * plane. Returns the triangle count, or 0 when the loop is not simple (the
 * caller then keeps its input faces). Writes winding-consistent triangles that
 * follow the loop's own direction. */
uint32_t earClipLoop(const float* pos, const uint32_t* loop, uint32_t n, uint32_t* out, uint32_t outCap) {
  if (n < 3u) return 0u;
  /* Newell normal, so a ring that is not perfectly flat still gets a plane. */
  Vec3 nn(0.0f, 0.0f, 0.0f);
  for (uint32_t i = 0; i < n; ++i) {
    const Vec3 a = readPos(pos, loop[i]), b = readPos(pos, loop[(i + 1u) % n]);
    nn.x += (a.y - b.y) * (a.z + b.z);
    nn.y += (a.z - b.z) * (a.x + b.x);
    nn.z += (a.x - b.x) * (a.y + b.y);
  }
  const float nl = length(nn);
  if (nl < 1e-12f) return 0u;
  nn = nn * (1.0f / nl);
  /* Two in-plane axes; the projection keeps the loop's winding sign, which is
   * what makes the emitted triangles face the same way as the faces they
   * replace. */
  Vec3 ux = cross(nn, Vec3(0.0f, 0.0f, 1.0f));
  if (length(ux) < 1e-4f) ux = cross(nn, Vec3(1.0f, 0.0f, 0.0f));
  ux = normalize(ux);
  const Vec3 uy = cross(nn, ux);

  float* px = modArray<float>(n * 2u);
  uint32_t* ring = modArray<uint32_t>(n);
  if (!px || !ring) return 0u;
  for (uint32_t i = 0; i < n; ++i) {
    const Vec3 p = readPos(pos, loop[i]);
    px[i * 2] = dot(p, ux);
    px[i * 2 + 1] = dot(p, uy);
    ring[i] = i;
  }
  auto cross2 = [&](uint32_t a, uint32_t b, uint32_t c) {
    const float ax = px[a * 2], ay = px[a * 2 + 1];
    return (px[b * 2] - ax) * (px[c * 2 + 1] - ay) - (px[b * 2 + 1] - ay) * (px[c * 2] - ax);
  };
  float signedArea = 0.0f;
  for (uint32_t i = 0; i < n; ++i) {
    const uint32_t j = (i + 1u) % n;
    signedArea += px[i * 2] * px[j * 2 + 1] - px[j * 2] * px[i * 2 + 1];
  }
  const float sign = signedArea >= 0.0f ? 1.0f : -1.0f;

  uint32_t live = n, tris = 0u;
  uint32_t guard = 0u;
  while (live > 3u && tris + 1u <= outCap && guard < n * n + 8u) {
    bool clipped = false;
    for (uint32_t i = 0; i < live; ++i) {
      const uint32_t ia = ring[(i + live - 1u) % live], ib = ring[i], ic = ring[(i + 1u) % live];
      if (cross2(ia, ib, ic) * sign <= 1e-14f) continue;
      bool empty = true;
      for (uint32_t k = 0; k < live && empty; ++k) {
        const uint32_t p = ring[k];
        if (p == ia || p == ib || p == ic) continue;
        const float d1 = cross2(ia, ib, p) * sign, d2 = cross2(ib, ic, p) * sign, d3 = cross2(ic, ia, p) * sign;
        if (d1 >= 0.0f && d2 >= 0.0f && d3 >= 0.0f) empty = false;
      }
      if (!empty) continue;
      out[tris * 3] = loop[ia]; out[tris * 3 + 1] = loop[ib]; out[tris * 3 + 2] = loop[ic];
      ++tris;
      for (uint32_t k = i; k + 1u < live; ++k) ring[k] = ring[k + 1u];
      --live;
      clipped = true;
      break;
    }
    ++guard;
    if (!clipped) return 0u;   /* not a simple polygon: let the caller keep its faces */
  }
  if (live != 3u || tris + 1u > outCap) return 0u;
  out[tris * 3] = loop[ring[0]]; out[tris * 3 + 1] = loop[ring[1]]; out[tris * 3 + 2] = loop[ring[2]];
  ++tris;
  return tris;
}

FE_EXPORT int32_t fe_mod_decimate_unsubdivide(uint32_t iterations) {
  if (!g_s.ready) return -1;
  g_s.flagMode = 0;
  const uint32_t v0 = g_s.vc, t0 = g_s.tc;
  if (!v0 || !t0) return -3;
  const uint32_t passes = iterations < 1u ? 1u : (iterations > 6u ? 6u : iterations);

  uint32_t v = v0, t = t0;
  /* A dissolve removes a vertex and adds a fan of (ring-2) triangles where its
   * ring had (ring) triangles, so the block has to hold a few more than the
   * input. Six passes over a grid shrink far more than they grow, and the
   * guard below stops the copy from running off the end. */
  const uint32_t tCap = t0 + 4096u;
  float* pos = modArray<float>(v0 * 3u);
  uint32_t* tris = modArray<uint32_t>(tCap * 3u);
  int32_t* head = modArray<int32_t>(v0);
  int32_t* nextFace = modArray<int32_t>(tCap * 3u);
  uint8_t* dead = modArray<uint8_t>(v0);
  uint8_t* blocked = modArray<uint8_t>(v0);
  uint32_t* nextInRing = modArray<uint32_t>(v0);
  uint32_t* ring = modArray<uint32_t>(v0);
  uint32_t* remap = modArray<uint32_t>(v0);
  if (!pos || !tris || !head || !nextFace || !dead || !blocked || !nextInRing || !ring || !remap) return -2;
  for (uint32_t i = 0; i < v0 * 3u; ++i) pos[i] = g_s.inPos[i];
  for (uint32_t i = 0; i < t0 * 3u; ++i) tris[i] = g_s.inIdx[i];

  /* deadF is owned by the kernel, not by a pass: a fan triangle a dissolve adds
     is a live face for every later pass, and the compaction reads its flag. */
  uint8_t* deadF = modArray<uint8_t>(tCap);
  if (!deadF) return -2;
  for (uint32_t i = 0; i < tCap; ++i) deadF[i] = 0u;

  for (uint32_t pass = 0; pass < passes; ++pass) {
    /* vertex -> its live faces, as a linked list, so the ring walk costs the
     * vertex's valence and not the whole mesh. */
    for (uint32_t i = 0; i < v; ++i) { head[i] = -1; dead[i] = 0u; blocked[i] = 0u; nextInRing[i] = 0xFFFFFFFFu; }
    for (uint32_t f = 0; f < t; ++f) {
      for (uint32_t k = 0; k < 3u; ++k) {
        const uint32_t vi = tris[f * 3 + k];
        nextFace[f * 3 + k] = head[vi];
        head[vi] = static_cast<int32_t>(f * 3u + k);
      }
    }
    EdgeTable edges;
    if (!edgeTableInit(edges, t, false)) return -2;
    for (uint32_t f = 0; f < t; ++f) {
      for (uint32_t k = 0; k < 3u; ++k) {
        if (!edgeTableAdd(edges, tris[f * 3 + k], tris[f * 3 + (k + 1u) % 3u], f)) return -2;
      }
    }
    auto edgeCount = [&](uint32_t a, uint32_t b) -> uint32_t {
      const uint32_t lo = a < b ? a : b, hi = a < b ? b : a;
      const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
      uint32_t i = hashU32(lo * 2654435761u ^ hi * 2246822519u) & edges.mask;
      for (uint32_t probe = 0; probe <= edges.mask; ++probe) {
        if (edges.count[i] == 0) return 0u;
        if (edges.key[i] == key) return edges.count[i];
        i = (i + 1u) & edges.mask;
      }
      return 0u;
    };
    for (uint32_t f = 0; f < t; ++f) deadF[f] = 0u;

    /* bm_vert_dissolve_fan_test(): every edge at the vertex is manifold (no
     * border, no wire), and no face already joins the ring - which is the
     * fan test that keeps a torus from being pinched shut. */
    uint32_t dissolved = 0u;
    for (uint32_t vi = 0; vi < v; ++vi) {
      if (blocked[vi]) continue;
      uint32_t ringLen = 0u, incident = 0u;
      bool ok = true;
      uint32_t start = 0xFFFFFFFFu;
      for (int32_t node = head[vi]; node >= 0 && ok; node = nextFace[node]) {
        const uint32_t f = static_cast<uint32_t>(node) / 3u;
        if (deadF[f]) continue;
        const uint32_t k = static_cast<uint32_t>(node) % 3u;
        const uint32_t a = tris[f * 3 + (k + 1u) % 3u];
        const uint32_t b = tris[f * 3 + (k + 2u) % 3u];
        if (edgeCount(vi, a) != 2u || edgeCount(vi, b) != 2u) { ok = false; break; }
        if (nextInRing[a] != 0xFFFFFFFFu) { ok = false; break; }
        nextInRing[a] = b;
        if (start == 0xFFFFFFFFu) start = a;
        ++ringLen;
        ++incident;
      }
      if (ok && ringLen >= 3u && ringLen == incident) {
        uint32_t cur = start, walked = 0u;
        while (cur != 0xFFFFFFFFu && walked < ringLen) {
          ring[walked++] = cur;
          cur = nextInRing[cur];
          if (cur == start) break;
        }
        if (cur != start || walked != ringLen) ok = false;
      } else {
        ok = false;
      }
      /* Reset only the scratch this vertex wrote. */
      for (uint32_t r = 0; ok && r < ringLen; ++r) nextInRing[ring[r]] = 0xFFFFFFFFu;
      if (!ok) {
        for (int32_t node = head[vi]; node >= 0; node = nextFace[node]) {
          const uint32_t f = static_cast<uint32_t>(node) / 3u;
          const uint32_t k = static_cast<uint32_t>(node) % 3u;
          nextInRing[tris[f * 3 + (k + 1u) % 3u]] = 0xFFFFFFFFu;
          nextInRing[tris[f * 3 + (k + 2u) % 3u]] = 0xFFFFFFFFu;
        }
        continue;
      }
      /* A three-sided ring that already carries a face is a pinch: the fan
       * would duplicate it. That is the only case a triangle mesh can hit. */
      if (ringLen == 3u) {
        bool pinched = false;
        for (int32_t node = head[ring[0]]; node >= 0 && !pinched; node = nextFace[node]) {
          const uint32_t f = static_cast<uint32_t>(node) / 3u;
          if (deadF[f]) continue;
          bool has1 = false, has2 = false;
          for (uint32_t k = 0; k < 3u; ++k) {
            if (tris[f * 3 + k] == ring[1]) has1 = true;
            if (tris[f * 3 + k] == ring[2]) has2 = true;
          }
          if (has1 && has2) pinched = true;
        }
        if (pinched) continue;
      }
      if (t + ringLen > tCap) break;
      for (int32_t node = head[vi]; node >= 0; node = nextFace[node]) {
        const uint32_t f = static_cast<uint32_t>(node) / 3u;
        if (!deadF[f]) deadF[f] = 1u;
      }
      dead[vi] = 1u;
      ++dissolved;
      /* BM_vert_dissolve_fan() -> BM_faces_join(): the ring becomes one face,
       * emitted here as a fan from its first corner, which keeps the winding
       * the surrounding faces had. */
      for (uint32_t r = 1u; r + 1u < ringLen; ++r) {
        tris[t * 3] = ring[0]; tris[t * 3 + 1] = ring[r]; tris[t * 3 + 2] = ring[r + 1u];
        deadF[t] = 0u;
        ++t;
      }
      for (uint32_t r = 0; r < ringLen; ++r) blocked[ring[r]] = 1u;
    }
    if (!dissolved) break;
    /* Compact the pass. */
    uint32_t newV = 0u;
    for (uint32_t i = 0; i < v; ++i) {
      if (dead[i]) { remap[i] = 0xFFFFFFFFu; continue; }
      remap[i] = newV;
      writePos(pos, newV, readPos(pos, i));
      ++newV;
    }
    uint32_t newT = 0u;
    for (uint32_t f = 0; f < t; ++f) {
      if (deadF[f]) continue;
      const uint32_t a = remap[tris[f * 3]], b = remap[tris[f * 3 + 1]], c = remap[tris[f * 3 + 2]];
      if (a == 0xFFFFFFFFu || b == 0xFFFFFFFFu || c == 0xFFFFFFFFu) continue;
      if (a == b || b == c || c == a) continue;
      tris[newT * 3] = a; tris[newT * 3 + 1] = b; tris[newT * 3 + 2] = c;
      ++newT;
    }
    if (!newT) break;
    v = newV; t = newT;
  }

  if (v > g_s.vcap || t > g_s.tcap) return -2;
  for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = pos[i];
  for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = tris[i];
  if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_decimate_planar(float angle_limit_deg, int32_t dissolve_boundaries) {
  if (!g_s.ready) return -1;
  g_s.flagMode = 0;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const float limit = clampf(angle_limit_deg, 0.0f, 180.0f) * 3.14159265358979f / 180.0f;
  const float cosLimit = cosf(limit);

  float* fn = modArray<float>(t * 3u);
  uint32_t* parent = modArray<uint32_t>(t);
  uint32_t* regionTris = modArray<uint32_t>(t);
  uint32_t* scratchTris = modArray<uint32_t>(t * 3u);
  if (!fn || !parent || !regionTris || !scratchTris) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 a = readPos(g_s.inPos, g_s.inIdx[f * 3]);
    const Vec3 b = readPos(g_s.inPos, g_s.inIdx[f * 3 + 1]);
    const Vec3 c = readPos(g_s.inPos, g_s.inIdx[f * 3 + 2]);
    const Vec3 n = normalize(cross(b - a, c - a));
    fn[f * 3] = n.x; fn[f * 3 + 1] = n.y; fn[f * 3 + 2] = n.z;
    parent[f] = f;
  }
  auto rootOf = [&](uint32_t i) {
    while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  /* Region per face: two faces join when they share an edge and their normals
   * are within the limit. Blender also refuses to merge across a face that is
   * not a quad; a triangle buffer has no quad to protect. */
  EdgeTable edges;
  if (!edgeTableInit(edges, t, true)) return -2;
  uint32_t* edgeFaceB = modArray<uint32_t>(edges.mask + 1u);
  if (!edgeFaceB) return -2;
  for (uint32_t i = 0; i <= edges.mask; ++i) edgeFaceB[i] = 0xFFFFFFFFu;
  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t a = g_s.inIdx[f * 3 + k], b = g_s.inIdx[f * 3 + (k + 1u) % 3u];
      const uint32_t lo = a < b ? a : b, hi = a < b ? b : a;
      const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
      uint32_t i = hashU32(lo * 2654435761u ^ hi * 2246822519u) & edges.mask;
      for (uint32_t probe = 0; probe <= edges.mask; ++probe) {
        if (edges.count[i] == 0) {
          edges.key[i] = key; edges.a[i] = lo; edges.b[i] = hi;
          edges.count[i] = 1; edges.tri[i] = f;
          break;
        }
        if (edges.key[i] == key) {
          const uint32_t other = edges.tri[i];
          edges.count[i] = 2;
          edgeFaceB[i] = other;
          const float d = fn[other * 3] * fn[f * 3] + fn[other * 3 + 1] * fn[f * 3 + 1] +
                          fn[other * 3 + 2] * fn[f * 3 + 2];
          if (d >= cosLimit) {
            const uint32_t ra = rootOf(other), rb = rootOf(f);
            if (ra != rb) parent[rb] = ra;
          }
          break;
        }
        i = (i + 1u) & edges.mask;
      }
    }
  }

  uint32_t outT = 0u;
  uint8_t* done = modArray<uint8_t>(t);
  /* Which regions touch each vertex: a border vertex that also belongs to a
   * neighbouring region cannot be dissolved out of this loop, because the
   * neighbour still needs it and the seam would crack open. One pass over the
   * faces fills this in. */
  uint8_t* vertMulti = modArray<uint8_t>(v);
  uint32_t* vertRoot = modArray<uint32_t>(v);
  if (!vertMulti || !vertRoot) return -2;
  for (uint32_t i = 0; i < v; ++i) { vertMulti[i] = 0u; vertRoot[i] = 0xFFFFFFFFu; }
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t r = rootOf(f);
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t vi = g_s.inIdx[f * 3 + k];
      if (vertRoot[vi] == 0xFFFFFFFFu) vertRoot[vi] = r;
      else if (vertRoot[vi] != r) vertMulti[vi] = 1u;
    }
  }
  /* Every per-region block is allocated once, outside the loop: a region's
   * allocations would otherwise pile up in an arena that cannot free. */
  uint32_t* loopVerts = modArray<uint32_t>(t * 3u);
  uint32_t* next = modArray<uint32_t>(v);
  uint32_t* earTris = modArray<uint32_t>(v * 3u + 3u);
  if (!done || !loopVerts || !next || !earTris) return -2;
  for (uint32_t f = 0; f < t; ++f) done[f] = 0u;

  for (uint32_t seed = 0; seed < t; ++seed) {
    if (done[seed]) continue;
    const uint32_t root = rootOf(seed);
    uint32_t count = 0u;
    for (uint32_t f = seed; f < t; ++f) {
      if (done[f] || rootOf(f) != root) continue;
      regionTris[count++] = f;
      done[f] = 1u;
    }
    if (count <= 1u) {
      for (uint32_t i = 0; i < count; ++i) {
        const uint32_t rf = regionTris[i];
        for (uint32_t k = 0; k < 3u; ++k) {
          if (outT >= g_s.tcap) return -2;
          g_s.outIdx[outT * 3 + k] = g_s.inIdx[rf * 3 + k];
        }
        ++outT;
      }
      continue;
    }
    /* Directed border: an edge of a region face whose partner is outside the
     * region, or which has no partner at all. */
    uint32_t loopLen = 0u;
    bool simple = true;
    for (uint32_t i = 0; i < count && simple; ++i) {
      const uint32_t rf = regionTris[i];
      for (uint32_t k = 0; k < 3u; ++k) {
        const uint32_t a = g_s.inIdx[rf * 3 + k], b = g_s.inIdx[rf * 3 + (k + 1u) % 3u];
        const uint32_t lo = a < b ? a : b, hi = a < b ? b : a;
        const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
        uint32_t slot = hashU32(lo * 2654435761u ^ hi * 2246822519u) & edges.mask;
        uint32_t idx = 0xFFFFFFFFu;
        for (uint32_t probe = 0; probe <= edges.mask; ++probe) {
          if (edges.count[slot] == 0) break;
          if (edges.key[slot] == key) { idx = slot; break; }
          slot = (slot + 1u) & edges.mask;
        }
        bool border = true;
        if (idx != 0xFFFFFFFFu && edges.count[idx] == 2u) {
          const uint32_t other = edges.tri[idx] == rf ? edgeFaceB[idx] : edges.tri[idx];
          if (other != 0xFFFFFFFFu && rootOf(other) == root) border = false;
        }
        if (!border) continue;
        if (loopLen >= count * 3u) { simple = false; break; }
        /* Store the directed edge as its start vertex, then resolve the order
         * by following. Two border edges must not leave the same vertex. */
        loopVerts[loopLen++] = a;
      }
    }
    if (!simple || loopLen < 3u) {
      for (uint32_t i = 0; i < count; ++i) {
        const uint32_t rf = regionTris[i];
        if (outT >= g_s.tcap) return -2;
        for (uint32_t k = 0; k < 3u; ++k) g_s.outIdx[outT * 3 + k] = g_s.inIdx[rf * 3 + k];
        ++outT;
      }
      continue;
    }
    /* Order the border into one loop by chasing each start vertex's successor.
     * loopVerts only holds the starts, so the ends are recomputed here. */
    for (uint32_t i = 0; i < v; ++i) next[i] = 0xFFFFFFFFu;
    for (uint32_t i = 0; i < loopLen; ++i) {
      const uint32_t a = loopVerts[i];
      /* Find b for this border edge again: the triangles of the region that
       * use a as a corner and cross the border. */
      uint32_t b = 0xFFFFFFFFu;
      for (uint32_t j = 0; j < count && b == 0xFFFFFFFFu; ++j) {
        const uint32_t rf = regionTris[j];
        for (uint32_t k = 0; k < 3u; ++k) {
          if (g_s.inIdx[rf * 3 + k] != a) continue;
          const uint32_t cand = g_s.inIdx[rf * 3 + (k + 1u) % 3u];
          const uint32_t lo = a < cand ? a : cand, hi = a < cand ? cand : a;
          const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
          uint32_t slot = hashU32(lo * 2654435761u ^ hi * 2246822519u) & edges.mask;
          uint32_t idx = 0xFFFFFFFFu;
          for (uint32_t probe = 0; probe <= edges.mask; ++probe) {
            if (edges.count[slot] == 0) break;
            if (edges.key[slot] == key) { idx = slot; break; }
            slot = (slot + 1u) & edges.mask;
          }
          bool border = true;
          if (idx != 0xFFFFFFFFu && edges.count[idx] == 2u) {
            const uint32_t other = edges.tri[idx] == rf ? edgeFaceB[idx] : edges.tri[idx];
            if (other != 0xFFFFFFFFu && rootOf(other) == root) border = false;
          }
          if (border) { b = cand; break; }
        }
      }
      if (b == 0xFFFFFFFFu) { simple = false; break; }
      if (next[a] != 0xFFFFFFFFu && next[a] != b) { simple = false; break; }
      next[a] = b;
    }
    uint32_t ringLen = 0u;
    if (simple) {
      const uint32_t first = loopVerts[0];
      uint32_t cur = first;
      for (uint32_t step = 0; step < loopLen; ++step) {
        if (cur == 0xFFFFFFFFu) { simple = false; break; }
        loopVerts[step] = cur;
        cur = next[cur];
      }
      if (simple && cur == first) ringLen = loopLen;
      else simple = false;
    }
    if (!simple || ringLen < 3u || ringLen + 2u > g_s.tcap - outT) {
      for (uint32_t i = 0; i < count; ++i) {
        const uint32_t rf = regionTris[i];
        if (outT >= g_s.tcap) return -2;
        for (uint32_t k = 0; k < 3u; ++k) g_s.outIdx[outT * 3 + k] = g_s.inIdx[rf * 3 + k];
        ++outT;
      }
      continue;
    }
    /* The merged face, tessellated. A region that ear clipping refuses (or that
     * would change area) keeps its own triangles. */
    float beforeArea = 0.0f;
    for (uint32_t i = 0; i < count; ++i) {
      const uint32_t rf = regionTris[i];
      const Vec3 a = readPos(g_s.inPos, g_s.inIdx[rf * 3]);
      const Vec3 b = readPos(g_s.inPos, g_s.inIdx[rf * 3 + 1]);
      const Vec3 c = readPos(g_s.inPos, g_s.inIdx[rf * 3 + 2]);
      beforeArea += length(cross(b - a, c - a)) * 0.5f;
    }
    /* use_dissolve_boundaries: BM_mesh_decimate_dissolve_ex()'s second phase
     * joins boundary edges that run straight through a vertex, so a straight
     * border becomes one edge instead of keeping every vertex the original
     * tessellation put there. A vertex is only eligible when this region is
     * the only one using it - dropping it from the loop while a neighbour
     * still refers to it would leave a T-junction - and when the border does
     * not turn there. Each pass removes every vertex that qualifies against
     * its current neighbours, and the passes repeat until nothing changes. */
    if (dissolve_boundaries && ringLen > 3u) {
      bool changed = true;
      while (changed && ringLen > 3u) {
        changed = false;
        uint32_t out = 0u;
        for (uint32_t i = 0; i < ringLen; ++i) {
          const uint32_t cur = loopVerts[i];
          const uint32_t prev = loopVerts[(i + ringLen - 1u) % ringLen];
          const uint32_t next = loopVerts[(i + 1u) % ringLen];
          bool drop = false;
          if (!vertMulti[cur] && out + (ringLen - i) > 3u) {
            const Vec3 pPrev = readPos(g_s.inPos, prev);
            const Vec3 pCur = readPos(g_s.inPos, cur);
            const Vec3 pNext = readPos(g_s.inPos, next);
            const Vec3 dIn = pCur - pPrev, dOut = pNext - pCur;
            const float lenIn2 = length_sq(dIn), lenOut2 = length_sq(dOut);
            if (lenIn2 > 0.0f && lenOut2 > 0.0f) {
              /* sin(theta)^2 below 1e-10 is under a hundredth of a degree. */
              drop = length_sq(cross(dIn, dOut)) <= 1e-10f * lenIn2 * lenOut2;
            }
          }
          if (drop) changed = true;
          else loopVerts[out++] = cur;
        }
        if (out < 3u) break;   /* never dissolve the polygon away */
        ringLen = out;
      }
    }
    const uint32_t capTris = ringLen;   /* n - 2 triangles at most, n for headroom */
    uint32_t* out = earTris;
    const uint32_t made = earClipLoop(g_s.inPos, loopVerts, ringLen, out, capTris);
    float afterArea = 0.0f;
    for (uint32_t i = 0; i < made; ++i) {
      const Vec3 a = readPos(g_s.inPos, out[i * 3]);
      const Vec3 b = readPos(g_s.inPos, out[i * 3 + 1]);
      const Vec3 c = readPos(g_s.inPos, out[i * 3 + 2]);
      afterArea += length(cross(b - a, c - a)) * 0.5f;
    }
    const bool keep = made > 0u && (beforeArea <= 1e-12f || absf(afterArea - beforeArea) <= beforeArea * 1e-3f);
    if (keep) {
      for (uint32_t i = 0; i < made; ++i) {
        if (outT >= g_s.tcap) return -2;
        g_s.outIdx[outT * 3] = out[i * 3];
        g_s.outIdx[outT * 3 + 1] = out[i * 3 + 1];
        g_s.outIdx[outT * 3 + 2] = out[i * 3 + 2];
        ++outT;
      }
    } else {
      for (uint32_t i = 0; i < count; ++i) {
        const uint32_t rf = regionTris[i];
        if (outT >= g_s.tcap) return -2;
        for (uint32_t k = 0; k < 3u; ++k) g_s.outIdx[outT * 3 + k] = g_s.inIdx[rf * 3 + k];
        ++outT;
      }
    }
  }
  /* Every vertex that no output triangle uses is gone with the edges it
   * carried. */
  uint8_t* used = modArray<uint8_t>(v);
  uint32_t* remap = modArray<uint32_t>(v);
  if (!used || !remap) return -2;
  for (uint32_t i = 0; i < v; ++i) used[i] = 0u;
  for (uint32_t i = 0; i < outT * 3u; ++i) used[g_s.outIdx[i]] = 1u;
  uint32_t newV = 0u;
  for (uint32_t i = 0; i < v; ++i) {
    remap[i] = used[i] ? newV : 0xFFFFFFFFu;
    if (!used[i]) continue;
    writePos(g_s.outPos, newV, readPos(g_s.inPos, i));
    ++newV;
  }
  for (uint32_t f = 0; f < outT; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) g_s.outIdx[f * 3 + k] = remap[g_s.outIdx[f * 3 + k]];
  }
  if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
  if (!newV || !outT) return -4;
  return commit(newV, outT);
}

/* =========================================================================
 * Wireframe - ported from bmesh/tools/bmesh_wireframe.cc
 *
 *   source/blender/bmesh/tools/bmesh_wireframe.cc  (BM_mesh_wireframe)
 *   source/blender/modifiers/intern/MOD_wireframe.cc (the dispatcher)
 *
 * The modifier does not thicken the edges; it frames the faces. Around every
 * corner it puts four vertices:
 *
 *   - two copies of the corner itself, pushed along the vertex normal to
 *     ofs_orig and ofs_new, which are the same pair Solidify uses, so the
 *     Offset slider means the same thing in both modifiers;
 *   - one vertex inset into the face along BM_loop_calc_face_tangent(), the
 *     corner's interior bisector, by thickness / 2. With Even Offset that
 *     inset is divided by cos((pi - corner_angle) / 2) - shell_angle_to_dist()
 *     - so a sharp corner does not produce a thin strut.
 *
 * Two quads per corner then join the inset vertex to the two copies, which is
 * where the square profile comes from, and a boundary edge gets two more quads
 * so an open mesh's border closes. Open borders use bm_vert_boundary_tangent():
 * cross(average edge direction, average face normal), flipped against
 * BM_edge_calc_face_tangent() so it points out of the surface.
 *
 * Not ported: crease weights, vertex groups, relative offset, material
 * offsets, and the n-gon paths (a triangle buffer has three corners per face).
 * Those are the parts that read BMesh custom data.
 * ========================================================================= */
FE_EXPORT int32_t fe_mod_wireframe(float thickness, float offset, int32_t replace_original,
                                   int32_t boundary, int32_t even_offset, int32_t relative_offset,
                                   float thickness_vgroup_fac, int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  /* A wireframe is all new surface: the input's per-face flags have nothing to
     say about it. */
  g_s.flagMode = 0;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const float th = clampf(thickness, 0.0f, 1.0f);
  if (th <= 1e-6f) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    return commit(v, t);
  }
  const float offset_fac = clampf(offset, -1.0f, 1.0f);
  const float ofs_orig = -(((-offset_fac + 1.0f) * 0.5f) * th);
  const float ofs_new = th + ofs_orig;
  const float ofs_mid = (ofs_orig + ofs_new) * 0.5f;
  const float inset = th * 0.5f;

  float* fn = modArray<float>(t * 3u);
  float* vn = modArray<float>(v * 3u);
  float* loopPos = modArray<float>(t * 3u * 3u);
  float* bndPos = modArray<float>(v * 3u);
  uint8_t* bndMade = modArray<uint8_t>(v);
  int32_t* eaFace = modArray<int32_t>(v);
  int32_t* ebFace = modArray<int32_t>(v);
  uint32_t* eaOther = modArray<uint32_t>(v);
  uint32_t* ebOther = modArray<uint32_t>(v);
  if (!fn || !vn || !loopPos || !bndPos || !bndMade || !eaFace || !ebFace || !eaOther || !ebOther) return -2;

  /* use_relative_offset: every offset is scaled per vertex by
     BM_vert_calc_median_tagged_edge_length(). Despite the name that function
     sums the lengths of the tagged edges at the vertex and divides by the edge
     count - the mean edge length - and the modifier tags every edge, so it is
     the vertex's average edge length. A dense patch then gets thin wire and a
     sparse one thick wire, which is what keeps a wireframe readable at two
     different mesh densities. */
  float* relfac = nullptr;
  if (relative_offset) {
    relfac = modArray<float>(v);
    float* sum = modArray<float>(v);
    uint32_t* cnt = modArray<uint32_t>(v);
    if (!relfac || !sum || !cnt) return -2;
    for (uint32_t i = 0; i < v; ++i) { sum[i] = 0.0f; cnt[i] = 0u; }
    for (uint32_t f = 0; f < t; ++f) {
      for (uint32_t k = 0; k < 3u; ++k) {
        const uint32_t a = g_s.inIdx[f * 3 + k], b = g_s.inIdx[f * 3 + (k + 1u) % 3u];
        if (a == b) continue;
        const float len = length(readPos(g_s.inPos, b) - readPos(g_s.inPos, a));
        sum[a] += len; cnt[a]++;
        sum[b] += len; cnt[b]++;
      }
    }
    for (uint32_t i = 0; i < v; ++i) relfac[i] = cnt[i] ? sum[i] / static_cast<float>(cnt[i]) : 0.0f;
  }
  /* thickness_vertex_group: bmesh_wireframe.cc scales the same relative factor
     the Relative Offset setting uses, so a weighted vertex gets a thinner
     frame and the two settings compose. */
  const float vgFacIn = clampf(thickness_vgroup_fac, 0.0f, 1.0f);
  auto facOf = [&](uint32_t i) {
    float f = relfac ? relfac[i] : 1.0f;
    if (g_s.vgOn) {
      float w = g_s.vg[i];
      if (invert_vgroup) w = 1.0f - w;
      f *= vgFacIn + (w * (1.0f - vgFacIn));
    }
    return f;
  };

  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 a = readPos(g_s.inPos, g_s.inIdx[f * 3]);
    const Vec3 b = readPos(g_s.inPos, g_s.inIdx[f * 3 + 1]);
    const Vec3 c = readPos(g_s.inPos, g_s.inIdx[f * 3 + 2]);
    const Vec3 n = normalize(cross(b - a, c - a));
    fn[f * 3] = n.x; fn[f * 3 + 1] = n.y; fn[f * 3 + 2] = n.z;
  }
  vertexNormalsAngleWeighted(g_s.inPos, g_s.inIdx, v, t, fn, vn);
  for (uint32_t i = 0; i < v; ++i) { eaFace[i] = -1; ebFace[i] = -1; eaOther[i] = ebOther[i] = 0u; bndMade[i] = 0u; }

  /* Boundary edges carry both endpoints, so bm_vert_boundary_tangent() has the
     two edges it needs. */
  EdgeTable edges;
  uint32_t boundaryEdges = 0u;
  {
    if (!edgeTableInit(edges, t, true)) return -2;
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t i0 = g_s.inIdx[f * 3], i1 = g_s.inIdx[f * 3 + 1], i2 = g_s.inIdx[f * 3 + 2];
      if (!edgeTableAdd(edges, i0, i1, f) || !edgeTableAdd(edges, i1, i2, f) || !edgeTableAdd(edges, i2, i0, f)) return -2;
    }
    for (uint32_t sIdx = 0; sIdx <= edges.mask; ++sIdx) {
      if (edges.count[sIdx] != 1u) continue;
      ++boundaryEdges;
      const uint32_t a = edges.a[sIdx], b = edges.b[sIdx], f = edges.tri[sIdx];
      if (eaFace[a] < 0) { eaFace[a] = static_cast<int32_t>(f); eaOther[a] = b; }
      else if (ebFace[a] < 0) { ebFace[a] = static_cast<int32_t>(f); ebOther[a] = b; }
      if (eaFace[b] < 0) { eaFace[b] = static_cast<int32_t>(f); eaOther[b] = a; }
      else if (ebFace[b] < 0) { ebFace[b] = static_cast<int32_t>(f); ebOther[b] = a; }
    }
  }

  /* ---- the inset vertex per face corner (verts_loop) ---- */
  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 n(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]);
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t iv = g_s.inIdx[f * 3 + k];
      const Vec3 prev = readPos(g_s.inPos, g_s.inIdx[f * 3 + (k + 2u) % 3u]);
      const Vec3 next = readPos(g_s.inPos, g_s.inIdx[f * 3 + (k + 1u) % 3u]);
      const Vec3 curr = readPos(g_s.inPos, iv);
      /* BM_loop_calc_face_tangent(): bisector of the two corner edges, made
         perpendicular to the face normal so it lies in the plane. */
      Vec3 vPrev = prev - curr, vNext = next - curr;
      const float lp = length(vPrev), ln = length(vNext);
      Vec3 tangent(0.0f, 0.0f, 0.0f);
      if (lp > 0.0f && ln > 0.0f) {
        vPrev = vPrev * (1.0f / lp);
        vNext = vNext * (1.0f / ln);
        const Vec3 dir = vPrev + vNext;
        Vec3 nor = cross(vPrev, vNext);
        if (dot(nor, n) < 0.0f) nor = nor * -1.0f;
        tangent = cross(dir, nor);
        const float lt = length(tangent);
        tangent = lt > 0.0f ? tangent * (1.0f / lt) : n;
      }
      /* BM_loop_calc_face_angle() and shell_angle_to_dist(). */
      float facShell = 1.0f;
      if (even_offset && lp > 0.0f && ln > 0.0f) {
        const float corner = cornerAngle(dot(vPrev, vNext));
        const float a = (3.14159265358979f - corner) * 0.5f;
        facShell = absf(1.0f / cosf(a));
      }
      const Vec3 vnormal = readPos(vn, iv);
      const float fac = facOf(iv);
      Vec3 p = curr + tangent * (inset * facShell * fac) + vnormal * (ofs_mid * fac);
      writePos(loopPos + f * 9u, k, p);
    }
  }

  /* ---- boundary vertices (bm_vert_boundary_tangent) ---- */
  if (boundary) {
    for (uint32_t i = 0; i < v; ++i) {
      if (eaFace[i] < 0 || bndMade[i]) continue;
      const int32_t fa = eaFace[i];
      const Vec3 na(fn[fa * 3], fn[fa * 3 + 1], fn[fa * 3 + 2]);
      const Vec3 co = readPos(g_s.inPos, i);
      const uint32_t va = eaOther[i];
      const Vec3 coA = readPos(g_s.inPos, va);
      Vec3 noFace = na;
      Vec3 noEdge;
      Vec3 tangentA = cross(co - coA, na);
      Vec3 tangentB(0.0f, 0.0f, 0.0f);
      bool hasSecond = ebFace[i] >= 0;
      Vec3 tvecA = co - coA;
      if (length(tvecA) > 0.0f) tvecA = normalize(tvecA);
      if (hasSecond) {
        const int32_t fb = ebFace[i];
        const Vec3 nb(fn[fb * 3], fn[fb * 3 + 1], fn[fb * 3 + 2]);
        noFace = normalize(na + nb);
        const uint32_t vb = ebOther[i];
        Vec3 tvecB = readPos(g_s.inPos, vb) - co;
        if (length(tvecB) > 0.0f) tvecB = normalize(tvecB);
        noEdge = tvecA + tvecB;
        tangentB = cross(readPos(g_s.inPos, vb) - co, nb);
      } else {
        noEdge = tvecA;
      }
      Vec3 no = cross(noEdge, noFace);
      const float ln = length(no);
      no = ln > 0.0f ? no * (1.0f / ln) : readPos(vn, i);
      if (length(tangentA) > 0.0f) tangentA = normalize(tangentA);
      if (length(tangentB) > 0.0f) tangentB = normalize(tangentB);
      const Vec3 tangentSum = tangentA + tangentB;
      if (dot(no, hasSecond ? tangentSum : tangentA) > 0.0f) no = no * -1.0f;

      float facShell = 1.0f;
      if (even_offset && hasSecond) {
        /* angle_on_axis_v3v3v3_v3(va, v, vb, no_face): both vectors point away
           from the vertex, so a straight border reads as pi and gets factor 1. */
        const Vec3 vb = readPos(g_s.inPos, ebOther[i]);
        const Vec3 u1 = readPos(g_s.inPos, va) - co;
        const Vec3 u2 = vb - co;
        const float l1v = length(u1), l2 = length(u2);
        if (l1v > 0.0f && l2 > 0.0f) {
          const Vec3 u1n = u1 * (1.0f / l1v);
          const Vec3 u2n = u2 * (1.0f / l2);
          float angle = atan2f(dot(noFace, cross(u1n, u2n)), dot(u1n, u2n));
          if (angle < 0.0f) angle += 6.28318530717959f;
          const float a = (3.14159265358979f - angle) * 0.5f;
          const float c = cosf(a);
          /* A border corner folded back on itself would send shell_angle_to_dist
             to infinity; upstream carries the same hazard, and a finite 1 here
             is the only sane answer. */
          facShell = absf(c) > 1e-6f ? absf(1.0f / c) : 1.0f;
        }
      }
      const float fac = facOf(i);
      const Vec3 p = co + no * (inset * facShell * fac) + readPos(vn, i) * (ofs_mid * fac);
      writePos(bndPos, i, p);
      bndMade[i] = 1u;
    }
  }

  /* ---- write the mesh ---- */
  const uint32_t negBase = 0u;              /* 2i, 2i+1 */
  const uint32_t loopBase = v * 2u;
  const uint32_t bndBase = loopBase + t * 3u;
  const uint32_t totalVerts = bndBase + (boundary ? v : 0u);
  uint32_t outT = 0u;

  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const Vec3 n = readPos(vn, i);
    const float fac = facOf(i);
    writePos(g_s.outPos, negBase + i * 2u, p + n * (ofs_orig * fac));
    writePos(g_s.outPos, negBase + i * 2u + 1u, p + n * (ofs_new * fac));
    if (g_s.hasUv) {
      g_s.outUv[(negBase + i * 2u) * 2] = g_s.inUv[i * 2];
      g_s.outUv[(negBase + i * 2u) * 2 + 1] = g_s.inUv[i * 2 + 1];
      g_s.outUv[(negBase + i * 2u + 1u) * 2] = g_s.inUv[i * 2];
      g_s.outUv[(negBase + i * 2u + 1u) * 2 + 1] = g_s.inUv[i * 2 + 1];
    }
  }
  for (uint32_t j = 0; j < t * 3u; ++j) {
    const uint32_t iv = g_s.inIdx[j];
    writePos(g_s.outPos, loopBase + j, readPos(loopPos, j));
    if (g_s.hasUv) {
      g_s.outUv[(loopBase + j) * 2] = g_s.inUv[iv * 2];
      g_s.outUv[(loopBase + j) * 2 + 1] = g_s.inUv[iv * 2 + 1];
    }
  }
  if (boundary) {
    for (uint32_t i = 0; i < v; ++i) {
      writePos(g_s.outPos, bndBase + i, bndMade[i] ? readPos(bndPos, i) : readPos(g_s.inPos, i));
      if (g_s.hasUv) {
        g_s.outUv[(bndBase + i) * 2] = g_s.inUv[i * 2];
        g_s.outUv[(bndBase + i) * 2 + 1] = g_s.inUv[i * 2 + 1];
      }
    }
  }

  auto tri = [&](uint32_t a, uint32_t b, uint32_t c) {
    if (outT >= g_s.tcap) return false;
    g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = c;
    ++outT;
    return true;
  };

  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t k2 = (k + 1u) % 3u;
      const uint32_t l1 = loopBase + f * 3u + k, l2 = loopBase + f * 3u + k2;
      const uint32_t i1 = g_s.inIdx[f * 3 + k], i2 = g_s.inIdx[f * 3 + k2];
      const uint32_t n1 = negBase + i1 * 2u, n2 = negBase + i2 * 2u;
      const uint32_t p1 = n1 + 1u, p2 = n2 + 1u;
      /* quad(v_l1, v_l2, v_neg2, v_neg1) */
      if (!tri(l1, l2, n2) || !tri(l1, n2, n1)) return -2;
      /* quad(v_l2, v_l1, v_pos1, v_pos2) */
      if (!tri(l2, l1, p1) || !tri(l2, p1, p2)) return -2;

      if (boundary && bndMade[i1] && bndMade[i2] && edgeTableCount(edges, i1, i2) == 1u) {
        const uint32_t b1 = bndBase + i1, b2 = bndBase + i2;
        /* quad(v_b2, v_b1, v_neg1, v_neg2) */
        if (!tri(b2, b1, n1) || !tri(b2, n1, n2)) return -2;
        /* quad(v_b1, v_b2, v_pos2, v_pos1) */
        if (!tri(b1, b2, p2) || !tri(b1, p2, p1)) return -2;
      }
    }
  }

  if (!replace_original) {
    for (uint32_t f = 0; f < t; ++f) {
      if (!tri(g_s.inIdx[f * 3], g_s.inIdx[f * 3 + 1], g_s.inIdx[f * 3 + 2])) return -2;
    }
  }

  (void)boundaryEdges;
  return commit(totalVerts, outT);
}

/* =========================================================================
 * Simple Deform - ported from modifiers/intern/MOD_simpledeform.cc
 *
 *   source/blender/modifiers/intern/MOD_simpledeform.cc
 *
 * This is the closest thing in the whole modifier tree to a straight copy:
 * four closed-form vertex functions and the bookkeeping around them. What is
 * carried over:
 *
 *   - the axis remap table {{1,2,0},{2,0,1},{0,1,2}}, which exists so every
 *     deformation can be written against Z and then mapped. Bend always uses
 *     the identity map because it needs the deformation axis itself;
 *   - the normalised limits: smd_limit[1] = lower + (upper-lower)*limit[1],
 *     and smd_factor = factor / max(FLT_EPSILON, upper_limit - lower_limit) -
 *     which is why a Twist of one full turn bends the same whatever the object
 *     measures;
 *   - axis_limit() on every locked axis with the base limits {0,0}, so Lock X
 *     pins the vertex to the plane x = 0 and the amount it was cut by is handed
 *     to the deformation as dcut (that is what keeps the locked faces flat);
 *   - the four deformations themselves, formulas untouched:
 *
 *       taper    scale = z*factor; x += x*scale; y += y*scale
 *       twist    theta = z*factor; rotate (x,y) about z
 *       stretch  scale = z*z*factor - factor + 1; (x,y) *= scale; z *= 1+factor
 *       bend     r = 1/factor; the arc of radius r, with the dcut corrections
 *
 * Not ported: vertex-group weighting, the Origin object space transform, and
 * "Bend should not have a lock axis" is applied (lock_axis is zeroed for bend)
 * exactly as upstream does.
 * ========================================================================= */
FE_EXPORT int32_t fe_mod_simple_deform(uint32_t mode, uint32_t deform_axis,
                                       float factor, float limit_lo, float limit_hi,
                                       uint32_t lock_axis, int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const uint32_t axis = deform_axis > 2u ? 2u : deform_axis;
  const uint32_t bend = mode == 1u;

  /* axis_map_table[axis] for every mode but bend, which uses the identity. */
  static const uint32_t axis_map_table[3][3] = {
    {1u, 2u, 0u},
    {2u, 0u, 1u},
    {0u, 1u, 2u}
  };
  const uint32_t* map = axis_map_table[bend ? 2u : axis];

  uint32_t lock = bend ? 0u : lock_axis;
  if (!bend) {
    /* Never lock the axis being deformed: it would flatten the geometry. */
    if (axis == 0u) lock &= ~1u;
    if (axis == 1u) lock &= ~2u;
    if (axis == 2u) lock &= ~4u;
  }

  const uint32_t limit_axis = bend ? ((axis == 0u || axis == 1u) ? 2u : 0u) : axis;

  /* The limits are normalised to the object's own bounds along limit_axis. */
  float lower = 3.402823466e+38f, upper = -3.402823466e+38f;
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const float c = limit_axis == 0u ? p.x : (limit_axis == 1u ? p.y : p.z);
    if (c < lower) lower = c;
    if (c > upper) upper = c;
  }
  const float span = upper - lower;
  const float lo = clampf(limit_lo, 0.0f, 1.0f);
  const float hi = clampf(limit_hi, 0.0f, 1.0f);
  const float abs_hi = lower + span * hi;
  const float abs_lo = lower + span * (lo < hi ? lo : hi);
  const float eps = 1.1920929e-7f; /* FLT_EPSILON */
  const float f = factor / maxf(eps, abs_hi - abs_lo);
  if (bend && absf(f) < 0.000001f) {                 /* BEND_EPS */
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    if (g_s.inSmooth && g_s.outSmooth) for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i];
    return commit(v, t);
  }

  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 src = readPos(g_s.inPos, i);
    float co[3] = { src.x, src.y, src.z };
    float dcut[3] = { 0.0f, 0.0f, 0.0f };

    /* axis_limit(): clamp into [0, 0] on a locked axis, record what was cut. */
    auto axisLimit = [](uint32_t a, const float limits[2], float c[3], float cut[3]) {
      float val = c[a];
      val = val > limits[0] ? val : limits[0];
      val = val < limits[1] ? val : limits[1];
      cut[a] = c[a] - val;
      c[a] = val;
    };
    const float base_limit[2] = { 0.0f, 0.0f };
    if (lock & 1u) axisLimit(0u, base_limit, co, dcut);
    if (lock & 2u) axisLimit(1u, base_limit, co, dcut);
    if (lock & 4u) axisLimit(2u, base_limit, co, dcut);
    {
      const float limits[2] = { abs_lo, abs_hi };
      axisLimit(limit_axis, limits, co, dcut);
    }

    float co_map[3] = { co[map[0]], co[map[1]], co[map[2]] };
    float cut_map[3] = { dcut[map[0]], dcut[map[1]], dcut[map[2]] };
    const float x = co_map[0], y = co_map[1], z = co_map[2];

    switch (mode) {
      case 0u: {                       /* twist */
        const float theta = z * f;
        const float st = sinf(theta), ct = cosf(theta);
        co_map[0] = x * ct - y * st;
        co_map[1] = x * st + y * ct;
        co_map[2] = z;
        break;
      }
      case 1u: {                       /* bend */
        float theta;
        if (axis == 0u || axis == 1u) theta = z * f; else theta = x * f;
        const float st = sinf(theta), ct = cosf(theta);
        const float inv = 1.0f / f;
        if (axis == 0u) {
          co_map[0] = x;
          co_map[1] = y * ct + (1.0f - ct) * inv;
          co_map[2] = -(y - inv) * st;
          co_map[0] += cut_map[0];
          co_map[1] += st * cut_map[2];
          co_map[2] += ct * cut_map[2];
        } else if (axis == 1u) {
          co_map[0] = x * ct + (1.0f - ct) * inv;
          co_map[1] = y;
          co_map[2] = -(x - inv) * st;
          co_map[0] += st * cut_map[2];
          co_map[1] += cut_map[1];
          co_map[2] += ct * cut_map[2];
        } else {
          co_map[0] = -(y - inv) * st;
          co_map[1] = y * ct + (1.0f - ct) * inv;
          co_map[2] = z;
          co_map[0] += ct * cut_map[0];
          co_map[1] += st * cut_map[0];
          co_map[2] += cut_map[2];
        }
        break;
      }
      case 2u: {                       /* taper */
        const float scale = z * f;
        co_map[0] = x + x * scale;
        co_map[1] = y + y * scale;
        co_map[2] = z;
        break;
      }
      default: {                       /* stretch */
        const float scale = z * z * f - f + 1.0f;
        co_map[0] = x * scale;
        co_map[1] = y * scale;
        co_map[2] = z * (1.0f + f);
        break;
      }
    }
    co_map[0] += cut_map[0]; co_map[1] += cut_map[1]; co_map[2] += cut_map[2];

    float out[3];
    out[map[0]] = co_map[0];
    out[map[1]] = co_map[1];
    out[map[2]] = co_map[2];
    /* MOD_simpledeform.cc's simple_helper() ends with
       interp_v3_v3v3(vertexCos, vertexCos, co, weight): the weight is the
       blend between where the vertex was and where the deform puts it. */
    const float w = deformWeight(i, invert_vgroup);
    const Vec3 deformed(out[0], out[1], out[2]);
    writePos(g_s.outPos, i, w == 1.0f ? deformed : src + (deformed - src) * w);
  }

  if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
  for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
  if (g_s.inSmooth && g_s.outSmooth) {
    g_s.flagMode = 1;
    for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i];
  }
  return commit(v, t);
}

/* =========================================================================
 * Edge Split - ported from MOD_edgesplit.cc and bmesh_edgesplit.cc
 *
 *   source/blender/modifiers/intern/MOD_edgesplit.cc   (the seam tags)
 *   source/blender/bmesh/tools/bmesh_edgesplit.cc      (BM_vert_separate_hflag)
 *
 * The modifier moves no vertex at all. It decides which edges are seams, then
 * splits every vertex along them so the faces on either side stop sharing a
 * corner - which is how a hard edge becomes hard, and what Blender used for
 * auto-smooth before 4.1.
 *
 * The tag rule is doEdgeSplit()'s, term for term:
 *
 *   threshold = cosf(split_angle + 0.000000175f)
 *   split if   the edge has 3+ faces                (always)
 *           or split_angle is ~zero                 (split everything)
 *           or dot(face_a_normal, face_b_normal) < threshold
 *
 * The split is BM_vert_separate_hflag(), in the form a triangle buffer needs:
 * around every vertex the incident faces are grouped into the fans still joined
 * by unsplit edges - a union-find over those faces - and each fan gets its own
 * output vertex. A vertex whose edges are all seams becomes one vertex per
 * corner, exactly as upstream leaves it.
 *
 * Sharp-edge tagging (MOD_EDGESPLIT_FROMFLAG) is not offered: this pipeline
 * carries one smooth flag per face, not per edge, and inventing edge flags the
 * model does not have would be worse than saying so. Edge Angle is the mode.
 * ========================================================================= */

FE_EXPORT int32_t fe_mod_edge_split(float split_angle, int32_t use_angle, int32_t use_sharp) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;

  const bool do_split_angle = use_angle != 0 && split_angle < 3.14159265f;
  const bool do_split_sharp = use_sharp != 0 && g_s.inSmooth != nullptr;
  if (!do_split_angle && !do_split_sharp) {
    /* Nothing tagged: upstream hands the mesh straight back. */
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    if (g_s.inSmooth && g_s.outSmooth) { g_s.flagMode = 1; for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i]; }
    return commit(v, t);
  }
  /* The split keeps every face where it was, so the shading flags ride along
     one-to-one and flat faces stay flat. */
  g_s.flagMode = 1;
  if (g_s.inSmooth && g_s.outSmooth) {
    for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i];
  }

  const float threshold = cosf(split_angle + 0.000000175f);
  const bool do_split_all = split_angle < 1.1920929e-7f;   /* FLT_EPSILON */

  float* fn = modArray<float>(t * 3u);
  SplitEdges e;
  uint32_t* cornerCount = modArray<uint32_t>(v + 1u);
  uint32_t* cornerStart = modArray<uint32_t>(v + 1u);
  uint32_t* cornerList = modArray<uint32_t>(t * 3u);
  float* cornerUv = modArray<float>(t * 3u * 2u);
  uint32_t* parent = modArray<uint32_t>(t);
  uint32_t* cornerOut = modArray<uint32_t>(t * 3u);
  if (!fn || !splitEdgesInit(e, t) || !cornerCount || !cornerStart || !cornerList || !cornerUv ||
      !parent || !cornerOut) return -2;

  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 a = readPos(g_s.inPos, g_s.inIdx[f * 3]);
    const Vec3 b = readPos(g_s.inPos, g_s.inIdx[f * 3 + 1]);
    const Vec3 c = readPos(g_s.inPos, g_s.inIdx[f * 3 + 2]);
    const Vec3 n = normalize(cross(b - a, c - a));
    fn[f * 3] = n.x; fn[f * 3 + 1] = n.y; fn[f * 3 + 2] = n.z;
    for (uint32_t k = 0; k < 3u; ++k) {
      splitEdgeSlot(e, g_s.inIdx[f * 3 + k], g_s.inIdx[f * 3 + (k + 1u) % 3u], true, f, nullptr);
    }
  }

  /* ---- tag the seams ---- */
  for (uint32_t i = 0; i <= e.mask; ++i) {
    if (e.nf[i] == 0u) continue;
    bool split = false;
    const uint32_t fa = e.f0[i], fb = e.f1[i];
    const bool pair = e.nf[i] == 2u && fa < t && fb < t && fa != fb;

    if (do_split_angle) {
      split = do_split_all || e.nf[i] >= 3u;
      if (!split && pair) {
        const float d = fn[fa * 3] * fn[fb * 3] + fn[fa * 3 + 1] * fn[fb * 3 + 1] +
                        fn[fa * 3 + 2] * fn[fb * 3 + 2];
        if (d < threshold) split = true;
      }
    }
    /* Sharp Edges: a sharp edge is one the two sides disagree about. This
       pipeline stores one smooth flag per face, not per edge, so the edge
       between a flat face and a smooth one - or between two faces that were
       shaded separately - is the sharp edge the model actually carries. */
    if (!split && pair && do_split_sharp && g_s.inSmooth[fa] != g_s.inSmooth[fb]) {
      split = true;
    }
    e.split[i] = split ? 1u : 0u;
  }

  /* ---- vertex -> its corners, contiguous (CSR) ---- */
  for (uint32_t i = 0; i <= v; ++i) cornerCount[i] = 0u;
  for (uint32_t j = 0; j < t * 3u; ++j) ++cornerCount[g_s.inIdx[j]];
  cornerStart[0] = 0u;
  for (uint32_t i = 0; i < v; ++i) cornerStart[i + 1u] = cornerStart[i] + cornerCount[i];
  for (uint32_t i = 0; i <= v; ++i) cornerCount[i] = cornerStart[i];
  for (uint32_t j = 0; j < t * 3u; ++j) {
    const uint32_t vi = g_s.inIdx[j];
    cornerList[cornerCount[vi]++] = j;
    cornerUv[j * 2] = g_s.hasUv ? g_s.inUv[vi * 2] : 0.0f;
    cornerUv[j * 2 + 1] = g_s.hasUv ? g_s.inUv[vi * 2 + 1] : 0.0f;
  }

  auto findRoot = [&](uint32_t i) {
    while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };

  uint32_t outV = 0u;
  for (uint32_t vi = 0; vi < v; ++vi) {
    const uint32_t begin = cornerStart[vi], endc = cornerStart[vi + 1u];
    if (begin == endc) continue;

    for (uint32_t i = begin; i < endc; ++i) parent[cornerList[i] / 3u] = cornerList[i] / 3u;

    /* Join the faces on either side of every unsplit edge through this vertex.
       Each corner contributes two edges, so this covers the whole fan. */
    for (uint32_t i = begin; i < endc; ++i) {
      const uint32_t corner = cornerList[i];
      const uint32_t f = corner / 3u, k = corner % 3u;
      for (uint32_t side = 0; side < 2u; ++side) {
        /* side 0: the edge leaving this corner; side 1: the one arriving. */
        const uint32_t other = g_s.inIdx[f * 3 + (side == 0u ? (k + 1u) % 3u : (k + 2u) % 3u)];
        if (other == vi) continue;
        const uint32_t slot = splitEdgeSlot(e, vi, other, false, 0u, nullptr);
        if (slot == 0xFFFFFFFFu || e.split[slot] || e.nf[slot] != 2u) continue;
        const uint32_t fa = e.f0[slot], fb = e.f1[slot];
        /* Only union faces that both touch this vertex. */
        bool aHere = false, bHere = false;
        for (uint32_t j = begin; j < endc; ++j) {
          const uint32_t f2 = cornerList[j] / 3u;
          if (f2 == fa) aHere = true;
          if (f2 == fb) bHere = true;
        }
        if (!aHere || !bHere) continue;
        const uint32_t ra = findRoot(fa), rb = findRoot(fb);
        if (ra != rb) parent[ra] = rb;
      }
    }

    /* One output vertex per fan. */
    uint32_t roots[64];
    uint32_t ids[64];
    uint32_t rootCount = 0u;
    for (uint32_t i = begin; i < endc; ++i) {
      const uint32_t corner = cornerList[i];
      const uint32_t root = findRoot(corner / 3u);
      uint32_t found = 0xFFFFFFFFu;
      for (uint32_t r = 0; r < rootCount; ++r) if (roots[r] == root) { found = ids[r]; break; }
      if (found == 0xFFFFFFFFu) {
        if (outV >= g_s.vcap) return -2;
        found = outV++;
        writePos(g_s.outPos, found, readPos(g_s.inPos, vi));
        if (g_s.hasUv) {
          g_s.outUv[found * 2] = cornerUv[corner * 2];
          g_s.outUv[found * 2 + 1] = cornerUv[corner * 2 + 1];
        }
        if (rootCount < 64u) { roots[rootCount] = root; ids[rootCount] = found; ++rootCount; }
      }
      cornerOut[corner] = found;
    }
  }

  for (uint32_t j = 0; j < t * 3u; ++j) {
    g_s.outIdx[j] = cornerOut[j];
    if (cornerOut[j] == 0xFFFFFFFFu) return -4;
  }
  if (outV == 0u) return -4;
  return commit(outV, t);
}

constexpr uint32_t LAPLACIAN_MAX_VERTS = 40000u;
constexpr uint32_t LAPLACIAN_MAX_ITERS = 260u;

struct Csr {
  uint32_t n = 0, nnz = 0;
  uint32_t* row = nullptr;
  uint32_t* col = nullptr;
  float* val = nullptr;
};

inline void csrMatVec(const Csr& a, const float* x, float* y) {
  for (uint32_t i = 0; i < a.n; ++i) {
    float sum = 0.0f;
    for (uint32_t k = a.row[i]; k < a.row[i + 1u]; ++k) sum += a.val[k] * x[a.col[k]];
    y[i] = sum;
  }
}

/* A^T, from A. Same coefficients, rows and columns exchanged. */
bool csrTranspose(const Csr& a, Csr& out) {
  out.n = a.n;
  out.nnz = a.nnz;
  out.row = modArray<uint32_t>(a.n + 1u);
  out.col = modArray<uint32_t>(a.nnz ? a.nnz : 1u);
  out.val = modArray<float>(a.nnz ? a.nnz : 1u);
  if (!out.row || !out.col || !out.val) return false;
  for (uint32_t i = 0; i <= a.n; ++i) out.row[i] = 0u;
  for (uint32_t k = 0; k < a.nnz; ++k) ++out.row[a.col[k] + 1u];
  for (uint32_t i = 0; i < a.n; ++i) out.row[i + 1u] += out.row[i];
  /* Walk the columns of each row, filling the next slot of the target row. */
  uint32_t* cursor = modArray<uint32_t>(a.n);
  if (!cursor) return false;
  for (uint32_t i = 0; i < a.n; ++i) cursor[i] = out.row[i];
  for (uint32_t i = 0; i < a.n; ++i) {
    for (uint32_t k = a.row[i]; k < a.row[i + 1u]; ++k) {
      const uint32_t slot = cursor[a.col[k]]++;
      out.col[slot] = i;
      out.val[slot] = a.val[k];
    }
  }
  return true;
}
/* =========================================================================
 * Screw - ported from MOD_screw.cc
 *
 *   source/blender/modifiers/intern/MOD_screw.cc   (screwModifier_do)
 *
 * The profile is the mesh's edges - upstream sweeps edges, not faces, so a
 * mesh that arrives with faces has them replaced by the surface of revolution
 * of its wire - and every step adds a rotated copy of the whole profile:
 *
 *   step_tot = ((steps + 1) * iterations) - (iterations - 1)
 *   step_angle = angle / (step_tot - (!close)) * step
 *   screw_ofs * (step / (step_tot - 1)) added along the axis
 *
 * A full turn with no screw offset closes: step_tot loses one ring and the
 * last step is joined back to the first instead of duplicating it, which is
 * upstream's `close` branch. Merge welds the result by distance afterwards,
 * like mesh_remove_doubles() does at the end of screwModifier_do().
 *
 * Not ported: the object-as-axis transform, and upstream's per-loop UV
 * layout - this pipeline carries one UV per vertex, so the generated UVs are
 * the step (u) and the distance along the profile (v).
 * ========================================================================= */
Vec3 rotateAboutAxis(const Vec3& p, uint32_t axis, float angle) {
  const float c = cosf(angle), sn = sinf(angle);
  if (axis == 0u) return {p.x, p.y * c - p.z * sn, p.y * sn + p.z * c};
  if (axis == 1u) return {p.x * c + p.z * sn, p.y, -p.x * sn + p.z * c};
  return {p.x * c - p.y * sn, p.x * sn + p.y * c, p.z};
}

/* =========================================================================
 * Build - ported from MOD_build.cc
 *
 *   source/blender/modifiers/intern/MOD_build.cc   (build_face_mesh)
 *
 * Upstream turns a frame into a fraction of the mesh to reveal:
 *
 *   frac = (scene_time - start) / length, clamped to 0..1, reversed on demand
 *   faces kept = faces * frac
 *
 * and then keeps that many faces either in order or from a seeded shuffle,
 * compacting the vertices that survive. Nothing moves: the mesh grows by
 * revealing faces.
 *
 * This stack is evaluated on demand rather than per frame, so the slider is
 * the fraction itself instead of a frame number - the same frac, from the
 * other end. The shuffle is splitmix64 seeded the way BLI_array_randomize is
 * seeded, not bit-identical to it.
 * ========================================================================= */
/* =========================================================================
 * Bevel - ported from the shape of bmesh_bevel.cc
 *
 *   source/blender/bmesh/tools/bmesh_bevel.cc   (BM_mesh_bevel)
 *   source/blender/modifiers/intern/MOD_bevel.cc
 *
 * Upstream bevels the edges of n-gon faces, not of triangles, so the first
 * thing this does is rebuild the faces a modeller would see: triangles that
 * share an edge and agree on their normal are welded into one polygon. A cube
 * out of a triangle buffer therefore bevels as six quads, not as eighteen
 * strips along its diagonals - which is the difference between a bevel and a
 * mess.
 *
 * With polygons in hand the construction is bmesh_bevel's, in the same order:
 *
 *   - every face corner moves in along both of its edges by
 *     t = width / sin(corner angle), which puts it `width` away from each of
 *     the two edges. Clamp Overlap caps t at 45% of the shorter edge so two
 *     offsets cannot cross.
 *   - every edge becomes a strip between the two faces that share it. With
 *     more than one segment the strip follows an arc: the offset vector is
 *     rotated about the edge by the dihedral angle, and Profile bends the
 *     parameter the way upstream's profile does (0.5 is a round bevel, values
 *     away from it push the arc out or in).
 *   - every vertex becomes a patch: its corner offsets and the strip ends of
 *     the edges between them form a ring, which is fanned from its centroid.
 *
 * Not ported: the vertex/edge weights, the custom profile curve and the
 * miter modes - this pipeline carries no custom data for them.
 * ========================================================================= */
struct BevelFace {
  uint32_t* verts = nullptr;   /* the polygon's corners */
  float* corner = nullptr;     /* 3 floats per corner: the inset point */
  uint32_t n = 0;
};

FE_EXPORT int32_t fe_mod_bevel(float width, int32_t segments, int32_t clamp_overlap, float profile,
                               int32_t offset_type, int32_t limit_method, float angle_limit) {
  if (!g_s.ready) return -1;
  uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  if (!(width > 1e-7f)) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    g_s.flagMode = 0;
    return commit(v, t);
  }
  g_s.flagMode = 0;

  /* ---- 0. weld the input ----
     A mesh out of a triangle buffer splits its vertices at every UV seam, so a
     cube arrives as 24 vertices that do not share a single edge. Blender's
     bevel works on the mesh's real edges, and so must this: weld by position
     first, which is what BMesh's edges already imply. */
  float* bpos = modArray<float>(v * 3u);
  uint32_t* bidx = modArray<uint32_t>(t * 3u);
  uint32_t* wremap = modArray<uint32_t>(v);
  float* buv = modArray<float>(v * 2u);
  if (!bpos || !bidx || !wremap) return -2;
  uint32_t bv = 0u;
  {
    WeldMap wm;
    if (!weldMapInit(wm, v)) return -2;
    const float inv = 1e7f;
    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(g_s.inPos, i);
      const int32_t qx = quantize(p.x, inv), qy = quantize(p.y, inv), qz = quantize(p.z, inv);
      uint32_t slot = hashU32(static_cast<uint32_t>(qx) * 73856093u ^
                              static_cast<uint32_t>(qy) * 19349663u ^
                              static_cast<uint32_t>(qz) * 83492791u) & wm.mask;
      for (;;) {
        if (wm.slot[slot] == 0) {
          wm.slot[slot] = ++wm.unique;
          wm.cx[slot] = qx; wm.cy[slot] = qy; wm.cz[slot] = qz;
          const uint32_t id = bv++;
          writePos(bpos, id, p);
          if (g_s.hasUv) { buv[id * 2] = g_s.inUv[i * 2]; buv[id * 2 + 1] = g_s.inUv[i * 2 + 1]; }
          wremap[i] = id;
          break;
        }
        if (wm.cx[slot] == qx && wm.cy[slot] == qy && wm.cz[slot] == qz) {
          wremap[i] = wm.slot[slot] - 1u;
          break;
        }
        slot = (slot + 1u) & wm.mask;
      }
    }
  }
  uint32_t bt = 0u;
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t a = wremap[g_s.inIdx[f * 3]], b = wremap[g_s.inIdx[f * 3 + 1]],
                   c = wremap[g_s.inIdx[f * 3 + 2]];
    if (a == b || b == c || c == a) continue;
    bidx[bt * 3] = a; bidx[bt * 3 + 1] = b; bidx[bt * 3 + 2] = c;
    ++bt;
  }
  if (bt < 4u) return -4;
  /* The kernel below works on the welded copy; v and t follow it. */
  const uint32_t vIn = v, tIn = t;
  (void)vIn; (void)tIn;
  v = bv; t = bt;

  const int32_t seg = segments < 1 ? 1 : (segments > 16 ? 16 : segments);
  const float prof = clampf(profile <= 0.0f ? 0.5f : profile, 0.05f, 0.99f);

  /* ---- 1. coplanar triangles -> polygons ---- */
  float* fn = modArray<float>(t * 3u);
  uint32_t* parent = modArray<uint32_t>(t);
  if (!fn || !parent) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    const Vec3 a = readPos(bpos, bidx[f * 3]);
    const Vec3 b = readPos(bpos, bidx[f * 3 + 1]);
    const Vec3 c = readPos(bpos, bidx[f * 3 + 2]);
    const Vec3 n = normalize(cross(b - a, c - a));
    fn[f * 3] = n.x; fn[f * 3 + 1] = n.y; fn[f * 3 + 2] = n.z;
    parent[f] = f;
  }
  auto findFace = [&](uint32_t i) {
    while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  {
    /* Union each pair of triangles that share an edge and agree on the normal. */
    SplitEdges es;
    if (!splitEdgesInit(es, t)) return -2;
    for (uint32_t f = 0; f < t; ++f) {
      for (uint32_t k = 0; k < 3u; ++k) {
        splitEdgeSlot(es, bidx[f * 3 + k], bidx[f * 3 + (k + 1u) % 3u], true, f, nullptr);
      }
    }
    for (uint32_t i = 0; i <= es.mask; ++i) {
      if (es.nf[i] != 2u) continue;
      const uint32_t fa = es.f0[i], fb = es.f1[i];
      if (fa >= t || fb >= t || fa == fb) continue;
      const float d = fn[fa * 3] * fn[fb * 3] + fn[fa * 3 + 1] * fn[fb * 3 + 1] +
                      fn[fa * 3 + 2] * fn[fb * 3 + 2];
      if (d > 0.99995f) {
        const uint32_t ra = findFace(fa), rb = findFace(fb);
        if (ra != rb) parent[ra] = rb;
      }
    }
  }

  /* ---- 2. each group's boundary, walked into one loop ---- */
  /* A directed boundary edge exists once; the loop is its chain. */
  struct LoopEdge { uint32_t a, b; };
  uint32_t* rootOf = modArray<uint32_t>(t);
  if (!rootOf) return -2;
  for (uint32_t f = 0; f < t; ++f) rootOf[f] = findFace(f);

  /* Count the corners so the polygon array can be laid out flat. */
  uint32_t maxCorners = 0;
  for (uint32_t f = 0; f < t; ++f) {
    if (rootOf[f] != f) continue;
    uint32_t corners = 0;
    for (uint32_t g = 0; g < t; ++g) if (rootOf[g] == f) corners += 3u;
    maxCorners += corners;
  }
  if (!maxCorners) return -4;

  uint32_t* loopStart = modArray<uint32_t>(t + 1u);
  uint32_t* loopVerts = modArray<uint32_t>(maxCorners);
  float* cornerPos = modArray<float>(maxCorners * 3u);
  uint32_t* faceOfCorner = modArray<uint32_t>(maxCorners);
  if (!loopStart || !loopVerts || !cornerPos || !faceOfCorner) return -2;

  uint32_t faceCount = 0, cornerWrite = 0;
  uint32_t* nextOf = modArray<uint32_t>(v);
  uint8_t* used = modArray<uint8_t>(v);
  if (!nextOf || !used) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    if (rootOf[f] != f) continue;
    /* Directed boundary edges of the group, as next[a] = b. A vertex can be
       on two boundary edges of the same group (a pinch), which a triangle
       mesh does not produce; the first one wins. */
    for (uint32_t i = 0; i < v; ++i) { nextOf[i] = 0xFFFFFFFFu; used[i] = 0u; }
    uint32_t start = 0xFFFFFFFFu;
    for (uint32_t g = 0; g < t; ++g) {
      if (rootOf[g] != f) continue;
      for (uint32_t k = 0; k < 3u; ++k) {
        const uint32_t a = bidx[g * 3 + k];
        const uint32_t b = bidx[g * 3 + (k + 1u) % 3u];
        /* is the reverse edge inside the same group? */
        bool interior = false;
        for (uint32_t h = 0; h < t && !interior; ++h) {
          if (rootOf[h] != f) continue;
          for (uint32_t m = 0; m < 3u; ++m) {
            if (bidx[h * 3 + m] == b && bidx[h * 3 + (m + 1u) % 3u] == a) { interior = true; break; }
          }
        }
        if (interior) continue;
        if (!used[a]) { nextOf[a] = b; used[a] = 1u; if (start == 0xFFFFFFFFu) start = a; }
      }
    }
    if (start == 0xFFFFFFFFu) continue;
    /* Walk the loop. */
    loopStart[faceCount] = cornerWrite;
    uint32_t cur = start, guard = 0;
    do {
      loopVerts[cornerWrite] = cur;
      faceOfCorner[cornerWrite] = f;
      const Vec3 cp = readPos(bpos, cur);
      cornerPos[cornerWrite * 3] = cp.x;
      cornerPos[cornerWrite * 3 + 1] = cp.y;
      cornerPos[cornerWrite * 3 + 2] = cp.z;
      ++cornerWrite;
      cur = nextOf[cur];
      if (cur == 0xFFFFFFFFu) break;
    } while (cur != start && ++guard < v);
    ++faceCount;
  }
  loopStart[faceCount] = cornerWrite;
  if (!faceCount || !cornerWrite) return -4;

  /* One normal per polygon, for the angle limit. Newell's method, which does
     not care how the polygon is shaped as long as it is flat. */
  float* polyNormal = modArray<float>(faceCount * 3u);
  if (!polyNormal) return -2;
  for (uint32_t f = 0; f < faceCount; ++f) {
    const uint32_t b = loopStart[f], e = loopStart[f + 1u];
    const uint32_t n = e - b;
    Vec3 acc(0.0f, 0.0f, 0.0f);
    for (uint32_t i = 0; i < n; ++i) {
      const Vec3 pa = readPos(g_s.inPos, loopVerts[b + i]);
      const Vec3 pb = readPos(g_s.inPos, loopVerts[b + (i + 1u) % n]);
      acc.x += (pa.y - pb.y) * (pa.z + pb.z);
      acc.y += (pa.z - pb.z) * (pa.x + pb.x);
      acc.z += (pa.x - pb.x) * (pa.y + pb.y);
    }
    const Vec3 nn = normalize(acc);
    polyNormal[f * 3] = nn.x; polyNormal[f * 3 + 1] = nn.y; polyNormal[f * 3 + 2] = nn.z;
  }

  /* cornerOut[c] is the new vertex id for corner c of the flat corner array;
     cornerFace[c] says which polygon it belongs to. Both are needed by the
     strip table below and filled in by the corner loop. */
  uint32_t* cornerOut = modArray<uint32_t>(cornerWrite);
  uint32_t* cornerFace = modArray<uint32_t>(cornerWrite);
  if (!cornerOut || !cornerFace) return -2;

  /* cornerFace[c] follows from the loop layout alone: corner c belongs to the
     polygon whose loop range contains it. Filling it here means the strip
     table below does not have to wait for the corner loop. */
  for (uint32_t f = 0; f < faceCount; ++f) {
    for (uint32_t c = loopStart[f]; c < loopStart[f + 1u]; ++c) cornerFace[c] = f;
  }

  /* ---- 4. vertex -> corners, so the strips can find their faces ---- */
  uint32_t* cornerStart = modArray<uint32_t>(v + 1u);
  uint32_t* cornerList = modArray<uint32_t>(cornerWrite);
  uint32_t* cornerAtV = modArray<uint32_t>(cornerWrite);
  if (!cornerStart || !cornerList || !cornerAtV) return -2;
  for (uint32_t i = 0; i <= v; ++i) cornerStart[i] = 0u;
  for (uint32_t c = 0; c < cornerWrite; ++c) ++cornerStart[loopVerts[c] + 1u];
  for (uint32_t i = 0; i < v; ++i) cornerStart[i + 1u] += cornerStart[i];
  for (uint32_t i = 0; i < v; ++i) cornerAtV[i] = cornerStart[i];
  for (uint32_t c = 0; c < cornerWrite; ++c) cornerList[cornerAtV[loopVerts[c]]++] = c;

  /* ---- 6. the strips ---- */
  /* Every boundary edge of every face, with the two faces that own it. */
  SplitEdges be;
  if (!splitEdgesInit(be, t)) return -2;
  for (uint32_t c = 0; c < cornerWrite; ++c) {
    const uint32_t f = cornerFace[c];
    const uint32_t b = loopStart[f], e = loopStart[f + 1u];
    const uint32_t n = e - b;
    const uint32_t a = loopVerts[c];
    const uint32_t nxt = loopVerts[b + ((c - b) + 1u) % n];
    splitEdgeSlot(be, a, nxt, true, f, nullptr);
  }

  /* For every edge that two faces share: the four corners that own it. */
  const uint32_t levelCount = static_cast<uint32_t>(seg) + 1u;
  uint32_t* edgeFaceA = modArray<uint32_t>(be.mask + 1u);
  uint32_t* edgeFaceB = modArray<uint32_t>(be.mask + 1u);
  uint32_t* edgeCorner = modArray<uint32_t>((be.mask + 1u) * 4u);  /* a_u, a_v, b_u, b_v */
  uint8_t* edgeLive = modArray<uint8_t>(be.mask + 1u);
  if (!edgeFaceA || !edgeFaceB || !edgeCorner || !edgeLive) return -2;
  for (uint32_t i = 0; i <= be.mask; ++i) edgeLive[i] = 0u;

  uint32_t stripCount = 0;
  auto cornerFor = [&](uint32_t face, uint32_t vert) -> uint32_t {
    for (uint32_t c = 0; c < cornerWrite; ++c) {
      if (loopVerts[c] == vert && cornerFace[c] == face) return c;
    }
    return 0xFFFFFFFFu;
  };
  for (uint32_t i = 0; i <= be.mask; ++i) {
    if (be.nf[i] != 2u) continue;
    const uint32_t va = be.a[i], vb2 = be.b[i];
    /* the two faces that own this edge, found from va's corners */
    uint32_t faces[2] = {0xFFFFFFFFu, 0xFFFFFFFFu};
    uint32_t nf = 0u;
    for (uint32_t k = cornerStart[va]; k < cornerStart[va + 1u] && nf < 2u; ++k) {
      const uint32_t c = cornerList[k];
      const uint32_t f = cornerFace[c];
      const uint32_t b = loopStart[f], e = loopStart[f + 1u];
      const uint32_t n = e - b;
      const uint32_t slot = c - b;
      if (loopVerts[b + (slot + 1u) % n] == vb2 || loopVerts[b + (slot + n - 1u) % n] == vb2) {
        if (nf == 0u || faces[0] != f) faces[nf++] = f;
      }
    }
    if (nf < 2u) continue;
    const uint32_t ca_a = cornerFor(faces[0], va), ca_b = cornerFor(faces[0], vb2);
    const uint32_t cb_a = cornerFor(faces[1], va), cb_b = cornerFor(faces[1], vb2);
    if (ca_a == 0xFFFFFFFFu || ca_b == 0xFFFFFFFFu || cb_a == 0xFFFFFFFFu || cb_b == 0xFFFFFFFFu) continue;
    edgeLive[i] = 1u;
    edgeFaceA[i] = faces[0];
    edgeFaceB[i] = faces[1];
    edgeCorner[i * 4] = ca_a;
    edgeCorner[i * 4 + 1] = ca_b;
    edgeCorner[i * 4 + 2] = cb_a;
    edgeCorner[i * 4 + 3] = cb_b;
    ++stripCount;
  }
  if (!stripCount) return -4;

  /* ---- 3. the corner offsets ---- */
  /* vertex -> (face, slot) is needed to find the two faces of an edge. */
  uint32_t nextV = 0;
  for (uint32_t f = 0; f < faceCount; ++f) {
    const uint32_t b = loopStart[f], e = loopStart[f + 1u];
    const uint32_t n = e - b;
    for (uint32_t i = 0; i < n; ++i) {
      const uint32_t c = b + i;
      const uint32_t prev = b + (i + n - 1u) % n;
      const uint32_t next = b + (i + 1u) % n;
      const Vec3 P = {cornerPos[c * 3], cornerPos[c * 3 + 1], cornerPos[c * 3 + 2]};
      const Vec3 P0 = {cornerPos[prev * 3], cornerPos[prev * 3 + 1], cornerPos[prev * 3 + 2]};
      const Vec3 P1 = {cornerPos[next * 3], cornerPos[next * 3 + 1], cornerPos[next * 3 + 2]};
      const Vec3 d0 = normalize(P0 - P), d1 = normalize(P1 - P);
      const float sinA = cross(d0, d1).length();
      /* Upstream's Offset Type: the slider means a different distance each
         way, and all four reduce to the same inset parameter t.
           Offset  - the distance from the original edge
           Width   - the width of the bevel face itself
           Depth   - how far the bevel cuts into the corner
           Percent - a fraction of the shorter neighbouring edge */
      float want = width;
      if (offset_type == 1 || offset_type == 2) {
        /* Upstream converts Width and Depth with the edge's face angle
           (`edge_face_angle`, the angle between the two polygons that share the
           edge), not the angle between the edges meeting at this corner. Take
           the mean of the two edges that touch the corner. */
        float faceAngle = 0.0f;
        uint32_t found = 0u;
        for (uint32_t side = 0; side < 2u; ++side) {
          const uint32_t otherC = side == 0u ? next : prev;
          const uint32_t slot = splitEdgeSlot(be, loopVerts[c], loopVerts[otherC], false, 0u, nullptr);
          if (slot == 0xFFFFFFFFu || !edgeLive[slot]) continue;
          const uint32_t fa = edgeFaceA[slot], fb = edgeFaceB[slot];
          const float dot = clampf(polyNormal[fa * 3] * polyNormal[fb * 3] +
                                   polyNormal[fa * 3 + 1] * polyNormal[fb * 3 + 1] +
                                   polyNormal[fa * 3 + 2] * polyNormal[fb * 3 + 2], -1.0f, 1.0f);
          faceAngle += cornerAngle(dot);
          ++found;
        }
        if (found) faceAngle /= static_cast<float>(found);
        else if (sinA > 1e-6f) faceAngle = atan2f(sinA, Vec3::dot(d0, d1));
        const float halfA = faceAngle * 0.5f;
        if (offset_type == 1) {                   /* Width */
          want = width / maxf(absf(2.0f * sinf(halfA)), 1e-4f);
        } else {                                  /* Depth */
          want = width / maxf(absf(cosf(halfA)), 0.05f);
        }
      } else if (offset_type == 3) {              /* Percent */
        want = (width / 100.0f) * minf((P0 - P).length(), (P1 - P).length());
      }
      float tparam = sinA > 1e-6f ? want / sinA : want * 1e3f;
      if (clamp_overlap) {
        const float limit = 0.45f * minf((P0 - P).length(), (P1 - P).length());
        if (tparam > limit) tparam = limit;
      }
      /* Limit Method: Angle bevels only the edges sharper than the slider, and
         a corner whose edge is not beveled stays where it was. */
      if (limit_method == 1) {
        bool sharp = false;
        for (uint32_t side = 0; side < 2u && !sharp; ++side) {
          const uint32_t otherC = side == 0u ? next : prev;
          const uint32_t otherV = loopVerts[otherC];
          const uint32_t slot = splitEdgeSlot(be, loopVerts[c], otherV, false, 0u, nullptr);
          if (slot == 0xFFFFFFFFu || !edgeLive[slot]) continue;
          const uint32_t fa = edgeFaceA[slot], fb = edgeFaceB[slot];
          const float na[3] = {polyNormal[fa * 3], polyNormal[fa * 3 + 1], polyNormal[fa * 3 + 2]};
          const float nb[3] = {polyNormal[fb * 3], polyNormal[fb * 3 + 1], polyNormal[fb * 3 + 2]};
          const float dot = clampf(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2], -1.0f, 1.0f);
          const float angle = 180.0f - atan2f(sqrtf(maxf(0.0f, 1.0f - dot * dot)), dot) * kRad2Deg;
          if (angle > angle_limit) sharp = true;
        }
        if (!sharp) tparam = 0.0f;
      }
      const Vec3 q = P + (d0 + d1) * tparam;
      if (nextV >= g_s.vcap) return -2;
      writePos(g_s.outPos, nextV, q);
      if (g_s.hasUv) {
        const uint32_t srcVert = loopVerts[c];
        g_s.outUv[nextV * 2] = buv[srcVert * 2];
        g_s.outUv[nextV * 2 + 1] = buv[srcVert * 2 + 1];
      }
      cornerOut[c] = nextV;
      cornerFace[c] = f;
      ++nextV;
    }
  }

  uint32_t outT = 0;
  auto putTri = [&](uint32_t a, uint32_t b, uint32_t c) {
    if (outT >= g_s.tcap) return false;
    g_s.outIdx[outT * 3] = a;
    g_s.outIdx[outT * 3 + 1] = b;
    g_s.outIdx[outT * 3 + 2] = c;
    ++outT;
    return true;
  };
  auto fan = [&](const uint32_t* ids, uint32_t n) {
    for (uint32_t i = 1; i + 1u < n; ++i) {
      if (!putTri(ids[0], ids[i], ids[i + 1u])) return false;
    }
    return true;
  };

  /* ---- 5. the shrunken faces ---- */
  uint32_t* ids = modArray<uint32_t>(64u);
  const uint32_t idsCap = 64u;
  if (!ids) return -2;
  for (uint32_t f = 0; f < faceCount; ++f) {
    const uint32_t b = loopStart[f], e = loopStart[f + 1u];
    const uint32_t n = e - b;
    if (n < 3u) continue;
    if (n > idsCap) return -2;
    for (uint32_t i = 0; i < n; ++i) ids[i] = cornerOut[b + i];
    if (!fan(ids, n)) return -2;
  }

  /* ---- 6. the strips (table built above, before the corner offsets) ---- */

  /* The inner ring levels, stored contiguously per edge so the vertex patch
     can splice them into its ring. */
  const uint32_t innerPerEdge = (levelCount > 2u ? levelCount - 2u : 0u) * 2u;
  uint32_t* stripBase = modArray<uint32_t>(be.mask + 1u);
  uint32_t* innerVerts = innerPerEdge ? modArray<uint32_t>(stripCount * innerPerEdge) : nullptr;
  if (!stripBase || (innerPerEdge && !innerVerts)) return -2;
  for (uint32_t i = 0; i <= be.mask; ++i) stripBase[i] = 0xFFFFFFFFu;

  uint32_t innerWrite = 0;
  for (uint32_t i = 0; i <= be.mask; ++i) {
    if (!edgeLive[i]) continue;
    const uint32_t va = be.a[i], vb = be.b[i];
    const uint32_t ca_a = edgeCorner[i * 4], ca_b = edgeCorner[i * 4 + 1];
    const uint32_t cb_a = edgeCorner[i * 4 + 2], cb_b = edgeCorner[i * 4 + 3];

    /* The inset points, not the original corners: these are what the strip
       arcs between, and the vertex ids they became. */
    const Vec3 P0 = readPos(g_s.outPos, cornerOut[ca_a]);
    const Vec3 P1 = readPos(g_s.outPos, cornerOut[cb_a]);
    const Vec3 Q0 = readPos(g_s.outPos, cornerOut[ca_b]);
    const Vec3 Q1 = readPos(g_s.outPos, cornerOut[cb_b]);

    const Vec3 vaPos = readPos(bpos, va), vbPos = readPos(bpos, vb);
    const Vec3 axis = normalize(vbPos - vaPos);

    uint32_t rings[17][2];
    for (uint32_t lv = 0; lv < levelCount; ++lv) { rings[lv][0] = 0xFFFFFFFFu; rings[lv][1] = 0xFFFFFFFFu; }
    rings[0][0] = cornerOut[ca_a];
    rings[0][1] = cornerOut[ca_b];
    rings[levelCount - 1u][0] = cornerOut[cb_a];
    rings[levelCount - 1u][1] = cornerOut[cb_b];

    stripBase[i] = innerWrite;
    for (uint32_t lv = 1; lv + 1u < levelCount; ++lv) {
      float u = static_cast<float>(lv) / static_cast<float>(levelCount - 1u);
      if (prof != 0.5f) u = powf(u, prof * 2.0f);
      for (uint32_t end = 0; end < 2u; ++end) {
        const Vec3 A = end == 0u ? P0 : Q0;
        const Vec3 B = end == 0u ? P1 : Q1;
        const Vec3 base = end == 0u ? vaPos : vbPos;
        const Vec3 foot = base + axis * Vec3::dot(A - base, axis);
        const Vec3 rA = A - foot;
        const Vec3 rB = B - foot;
        const float lenA = rA.length(), lenB = rB.length();
        if (lenA < 1e-9f || lenB < 1e-9f) {
          /* the offset is on the edge itself: no arc to follow */
          rings[lv][end] = cornerOut[end == 0u ? ca_a : ca_b];
          continue;
        }
        const float c = clampf(Vec3::dot(rA, rB) / (lenA * lenB), -1.0f, 1.0f);
        const float ang = atan2f(cross(rA, rB).length(), c);
        const Vec3 rd = rA * (1.0f / lenA);
        Vec3 perp = cross(axis, rd);
        const float pl = perp.length();
        perp = pl > 1e-9f ? perp * (1.0f / pl) : Vec3(0.0f, 0.0f, 0.0f);
        /* Turn towards the other face, never the long way round: the arc has
           to stay inside the corner. */
        if (Vec3::dot(perp, rB) < 0.0f) perp = -perp;
        const float a2 = ang * u;
        const float radius = lerpf(lenA, lenB, u);
        const Vec3 pt = foot + rd * (cosf(a2) * radius) + perp * (sinf(a2) * radius);
        if (nextV >= g_s.vcap) return -2;
        writePos(g_s.outPos, nextV, pt);
        if (g_s.hasUv) {
          const uint32_t uvA = loopVerts[end == 0u ? ca_a : cb_a];
          const uint32_t uvB = loopVerts[end == 0u ? ca_b : cb_b];
          g_s.outUv[nextV * 2] = lerpf(buv[uvA * 2], buv[uvB * 2], u);
          g_s.outUv[nextV * 2 + 1] = lerpf(buv[uvA * 2 + 1], buv[uvB * 2 + 1], u);
        }
        rings[lv][end] = nextV;
        innerVerts[innerWrite++] = nextV;
        ++nextV;
      }
    }

    for (uint32_t lv = 0; lv + 1u < levelCount; ++lv) {
      const uint32_t a0 = rings[lv][0], b0 = rings[lv][1];
      const uint32_t a1 = rings[lv + 1u][0], b1 = rings[lv + 1u][1];
      if (a0 == 0xFFFFFFFFu || b0 == 0xFFFFFFFFu || a1 == 0xFFFFFFFFu || b1 == 0xFFFFFFFFu) continue;
      if (!putTri(a0, b0, b1)) return -2;
      if (!putTri(a0, b1, a1)) return -2;
    }
  }

  /* ---- 7. the vertex patches ---- */
  uint32_t* ring = modArray<uint32_t>(64u + stripCount * 4u);
  uint8_t* seenV = modArray<uint8_t>(v);
  if (!ring || !seenV) return -2;
  for (uint32_t i = 0; i < v; ++i) seenV[i] = 0u;

  for (uint32_t vi = 0; vi < v; ++vi) {
    const uint32_t cb = cornerStart[vi], ce = cornerStart[vi + 1u];
    if (ce - cb < 3u) continue;   /* one or two faces meet smoothly here */
    seenV[vi] = 1u;

    const Vec3 centre = readPos(bpos, vi);
    uint32_t owners[64];
    float angOf[64];
    const uint32_t ownerCount = ce - cb < 64u ? ce - cb : 64u;
    for (uint32_t i = 0; i < ownerCount; ++i) owners[i] = cornerList[cb + i];

    /* Rotational order in the plane the offsets lie in. */
    Vec3 axisV(0.0f, 0.0f, 0.0f);
    for (uint32_t i = 0; i < ownerCount; ++i) axisV += readPos(g_s.outPos, cornerOut[owners[i]]) - centre;
    if (axisV.length() < 1e-9f) axisV = Vec3(0.0f, 0.0f, 1.0f);
    axisV = normalize(axisV);
    Vec3 e1 = cross(axisV, Vec3(0.0f, 1.0f, 0.0f));
    if (e1.length() < 1e-6f) e1 = cross(axisV, Vec3(1.0f, 0.0f, 0.0f));
    e1 = normalize(e1);
    const Vec3 e2 = cross(axisV, e1);
    for (uint32_t i = 0; i < ownerCount; ++i) {
      const Vec3 d = readPos(g_s.outPos, cornerOut[owners[i]]) - centre;
      angOf[i] = atan2f(Vec3::dot(d, e2), Vec3::dot(d, e1));
    }
    for (uint32_t i = 1; i < ownerCount; ++i) {
      const float key = angOf[i];
      const uint32_t keyOwner = owners[i];
      int32_t j = static_cast<int32_t>(i) - 1;
      while (j >= 0 && angOf[j] > key) {
        angOf[j + 1] = angOf[j];
        owners[j + 1] = owners[j];
        --j;
      }
      angOf[j + 1] = key;
      owners[j + 1] = keyOwner;
    }

    /* Ring: corner offset, then the strip ends towards the next face. */
    uint32_t ringN = 0;
    for (uint32_t i = 0; i < ownerCount; ++i) {
      ring[ringN++] = cornerOut[owners[i]];
      const uint32_t c = owners[i];
      const uint32_t f = cornerFace[c];
      const uint32_t b = loopStart[f], e = loopStart[f + 1u];
      const uint32_t n = e - b;
      const uint32_t slot = c - b;
      const uint32_t fwd = loopVerts[b + (slot + 1u) % n];
      const uint32_t backV = loopVerts[b + (slot + n - 1u) % n];
      /* The edge that leads to the next face in the ring - which of the two
         edges leaving this corner that is depends on how the faces came out of
         the sort, so both are tried and the one whose *other* face matches is
         the one that gets spliced in. */
      const uint32_t nextFace = cornerFace[owners[(i + 1u) % ownerCount]];
      auto leadsTo = [&](uint32_t other) {
        const uint32_t slotE = splitEdgeSlot(be, vi, other, false, 0u, nullptr);
        if (slotE == 0xFFFFFFFFu || !edgeLive[slotE]) return 0xFFFFFFFFu;
        const uint32_t fa = edgeFaceA[slotE], fb = edgeFaceB[slotE];
        const bool shares = fa == f || fb == f;
        const uint32_t otherFace = fa == f ? fb : fa;
        if (!shares || otherFace != nextFace) return 0xFFFFFFFFu;
        return slotE;
      };
      uint32_t edgeSlot = leadsTo(fwd);
      if (edgeSlot == 0xFFFFFFFFu) edgeSlot = leadsTo(backV);
      if (edgeSlot == 0xFFFFFFFFu || !edgeLive[edgeSlot] || stripBase[edgeSlot] == 0xFFFFFFFFu) continue;
      /* Which end of the strip is this vertex, and which way does the ring
         travel across it? The inner levels run from the A side of the strip to
         the B side, so a ring leaving the A face reads them in order and one
         leaving the B face reads them backwards. */
      const uint32_t base = stripBase[edgeSlot];
      const bool atA = be.a[edgeSlot] == vi;
      const bool fromA = edgeFaceA[edgeSlot] == f;
      const uint32_t levels = innerPerEdge / 2u;
      for (uint32_t lv = 0; lv < levels; ++lv) {
        const uint32_t pick = fromA ? lv : (levels - 1u - lv);
        ring[ringN++] = innerVerts[base + pick * 2u + (atA ? 0u : 1u)];
      }
    }
    if (ringN < 3u) continue;
    if (!fan(ring, ringN)) return -2;
  }

  if (!nextV || !outT) return -4;
  return commit(nextV, outT);
}

FE_EXPORT int32_t fe_mod_build(float progress, int32_t reverse, int32_t randomize, int32_t seed) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;

  float frac = clampf(progress, 0.0f, 1.0f);
  if (reverse) frac = 1.0f - frac;
  const uint32_t keep = static_cast<uint32_t>(frac * static_cast<float>(t));
  if (keep == 0u) return -4;

  uint32_t* order = modArray<uint32_t>(t);
  uint32_t* remap = modArray<uint32_t>(v);
  if (!order || !remap) return -2;
  for (uint32_t i = 0; i < t; ++i) order[i] = i;
  for (uint32_t i = 0; i < v; ++i) remap[i] = 0xFFFFFFFFu;

  if (randomize) {
    /* Fisher-Yates with a splitmix64 stream, seeded like BLI_array_randomize. */
    uint64_t state = 0x9e3779b97f4a7c15ull ^ static_cast<uint64_t>(static_cast<uint32_t>(seed));
    auto next = [&]() {
      state += 0x9e3779b97f4a7c15ull;
      uint64_t z = state;
      z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
      z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
      return z ^ (z >> 31);
    };
    for (uint32_t i = t; i > 1u; --i) {
      const uint32_t j = static_cast<uint32_t>(next() % i);
      const uint32_t tmp = order[i - 1u];
      order[i - 1u] = order[j];
      order[j] = tmp;
    }
  }

  uint32_t outV = 0u;
  for (uint32_t i = 0; i < keep; ++i) {
    const uint32_t f = order[i];
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t src = g_s.inIdx[f * 3 + k];
      if (remap[src] == 0xFFFFFFFFu) {
        if (outV >= g_s.vcap) return -2;
        remap[src] = outV;
        writePos(g_s.outPos, outV, readPos(g_s.inPos, src));
        if (g_s.hasUv) {
          g_s.outUv[outV * 2] = g_s.inUv[src * 2];
          g_s.outUv[outV * 2 + 1] = g_s.inUv[src * 2 + 1];
        }
        ++outV;
      }
    }
  }

  g_s.flagMode = 1;
  for (uint32_t i = 0; i < keep; ++i) {
    const uint32_t f = order[i];
    for (uint32_t k = 0; k < 3u; ++k) {
      g_s.outIdx[i * 3 + k] = remap[g_s.inIdx[f * 3 + k]];
    }
    if (g_s.inSmooth && g_s.outSmooth) g_s.outSmooth[i] = g_s.inSmooth[f];
  }
  if (!outV) return -4;
  return commit(outV, keep);
}

FE_EXPORT int32_t fe_mod_screw(float angle, float screw_ofs, int32_t iterations, int32_t steps,
                               int32_t axis, int32_t use_merge, float merge_dist,
                               int32_t normal_flip) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const int32_t iter = iterations < 1 ? 1 : (iterations > 100 ? 100 : iterations);
  int32_t step_in = steps < 1 ? 1 : (steps > 512 ? 512 : steps);
  const uint32_t ax = static_cast<uint32_t>(axis < 0 ? 0 : (axis > 2 ? 2 : axis));
  g_s.flagMode = 0;

  float total_angle = angle * static_cast<float>(iter);
  float total_ofs = screw_ofs * static_cast<float>(iter);
  uint32_t step_tot = static_cast<uint32_t>(((step_in + 1) * iter) - (iter - 1));

  bool close = false;
  const float eps = 1.1920929e-7f * 100.0f;
  if (absf(total_ofs) <= eps && absf(absf(total_angle) - kTwoPi) <= eps && step_tot > 3u) {
    close = true;
    --step_tot;
    total_ofs = 0.0f;
  } else if (step_tot < 2u) {
    step_tot = 2u;
  }

  /* ---- the profile: every edge of the mesh, as upstream sweeps them ---- */
  SplitEdges es;
  if (!splitEdgesInit(es, t)) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t a = g_s.inIdx[f * 3 + k], b = g_s.inIdx[f * 3 + (k + 1u) % 3u];
      if (a != b) splitEdgeSlot(es, a, b, true, f, nullptr);
    }
  }
  uint32_t ec = 0;
  for (uint32_t i = 0; i <= es.mask; ++i) if (es.nf[i]) ++ec;
  if (!ec) return -4;

  uint32_t* eu = modArray<uint32_t>(ec);
  uint32_t* ev = modArray<uint32_t>(ec);
  if (!eu || !ev) return -2;
  {
    uint32_t w = 0;
    for (uint32_t i = 0; i <= es.mask; ++i) {
      if (!es.nf[i]) continue;
      eu[w] = es.a[i]; ev[w] = es.b[i]; ++w;
    }
  }

  const uint64_t outV64 = static_cast<uint64_t>(v) * step_tot;
  const uint64_t rings = close ? step_tot : (step_tot - 1u);
  const uint64_t outT64 = static_cast<uint64_t>(ec) * rings * 2u;
  if (outV64 > g_s.vcap || outT64 > g_s.tcap || outV64 > MOD_MAX_VERTS) return -2;
  uint32_t outV = static_cast<uint32_t>(outV64), outT = static_cast<uint32_t>(outT64);

  /* ring 0 is the profile itself, untouched - upstream copies it verbatim */
  for (uint32_t i = 0; i < v; ++i) writePos(g_s.outPos, i, readPos(g_s.inPos, i));

  const float denom = static_cast<float>(step_tot) - (close ? 0.0f : 1.0f);
  for (uint32_t step = 1; step < step_tot; ++step) {
    const float step_angle = (total_angle / denom) * static_cast<float>(step);
    Vec3 shift(0.0f, 0.0f, 0.0f);
    if (total_ofs != 0.0f) {
      const float along = total_ofs * (static_cast<float>(step) / static_cast<float>(step_tot - 1u));
      if (ax == 0u) shift.x = along; else if (ax == 1u) shift.y = along; else shift.z = along;
    }
    for (uint32_t j = 0; j < v; ++j) {
      writePos(g_s.outPos, step * v + j, rotateAboutAxis(readPos(g_s.inPos, j), ax, step_angle) + shift);
    }
  }

  /* ---- faces: one quad per edge per ring gap ---- */
  uint32_t face = 0;
  auto quad = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
    if (!normal_flip) {
      g_s.outIdx[face * 3] = a; g_s.outIdx[face * 3 + 1] = b; g_s.outIdx[face * 3 + 2] = c; ++face;
      g_s.outIdx[face * 3] = a; g_s.outIdx[face * 3 + 1] = c; g_s.outIdx[face * 3 + 2] = d; ++face;
    } else {
      g_s.outIdx[face * 3] = a; g_s.outIdx[face * 3 + 1] = c; g_s.outIdx[face * 3 + 2] = b; ++face;
      g_s.outIdx[face * 3] = a; g_s.outIdx[face * 3 + 1] = d; g_s.outIdx[face * 3 + 2] = c; ++face;
    }
  };
  for (uint32_t step = 1; step < step_tot; ++step) {
    const uint32_t prev = (step - 1u) * v, cur = step * v;
    for (uint32_t e = 0; e < ec; ++e) quad(prev + eu[e], prev + ev[e], cur + ev[e], cur + eu[e]);
  }
  if (close) {
    const uint32_t last = (step_tot - 1u) * v;
    for (uint32_t e = 0; e < ec; ++e) quad(last + eu[e], last + ev[e], ev[e], eu[e]);
  }
  if (face != outT) return -4;

  /* ---- UVs: the step across, the distance along the profile along ---- */
  if (g_s.hasUv) {
    float totalLen = 0.0f;
    for (uint32_t e = 0; e < ec; ++e) {
      totalLen += (readPos(g_s.inPos, ev[e]) - readPos(g_s.inPos, eu[e])).length();
    }
    if (totalLen <= 0.0f) totalLen = 1.0f;
    /* The profile is a graph only along a path; use the ring index for u and
       each vertex's cumulative edge length along the profile for v. */
    float* acc = modArray<float>(v);
    uint32_t* seen = modArray<uint32_t>(v);
    if (!acc || !seen) return -2;
    for (uint32_t i = 0; i < v; ++i) { acc[i] = 0.0f; seen[i] = 0u; }
    float running = 0.0f;
    for (uint32_t e = 0; e < ec; ++e) {
      const float len = (readPos(g_s.inPos, ev[e]) - readPos(g_s.inPos, eu[e])).length();
      if (!seen[eu[e]]) { acc[eu[e]] = running; seen[eu[e]] = 1u; }
      running += len;
      if (!seen[ev[e]]) { acc[ev[e]] = running; seen[ev[e]] = 1u; }
    }
    for (uint32_t step = 0; step < step_tot; ++step) {
      const float u = step_tot > 1u ? static_cast<float>(step) / static_cast<float>(step_tot) : 0.0f;
      for (uint32_t j = 0; j < v; ++j) {
        g_s.outUv[(step * v + j) * 2] = u;
        g_s.outUv[(step * v + j) * 2 + 1] = acc[j] / totalLen;
      }
    }
  }

  for (uint32_t i = 0; i < outV * 3u; ++i) g_s.inPos[i] = g_s.outPos[i];
  if (g_s.hasUv) for (uint32_t i = 0; i < outV * 2u; ++i) g_s.inUv[i] = g_s.outUv[i];
  for (uint32_t i = 0; i < outT * 3u; ++i) g_s.inIdx[i] = g_s.outIdx[i];
  g_s.vc = outV;
  g_s.tc = outT;

  if (use_merge && merge_dist > 0.0f) {
    /* mesh_remove_doubles(), the call upstream makes when the screw leaves a
       seam: weld by distance, then drop the triangles that collapse onto a
       line. */
    uint32_t* remap = modArray<uint32_t>(outV);
    if (!remap) return -2;
    uint32_t newV = outV, newT = outT;
    if (weldSession(merge_dist, &newV, &newT, remap) == 0) {
      for (uint32_t i = 0; i < newV * 3u; ++i) g_s.inPos[i] = g_s.outPos[i];
      if (g_s.hasUv) for (uint32_t i = 0; i < newV * 2u; ++i) g_s.inUv[i] = g_s.outUv[i];
      for (uint32_t i = 0; i < newT * 3u; ++i) g_s.inIdx[i] = g_s.outIdx[i];
      outV = newV;
      outT = newT;
    }
  }

  for (uint32_t i = 0; i < outV * 2u; ++i) if (g_s.hasUv) g_s.inUv[i] = g_s.outUv[i];
  for (uint32_t i = 0; i < outT * 3u; ++i) g_s.inIdx[i] = g_s.outIdx[i];
  g_s.vc = outV;
  g_s.tc = outT;
  computeNormals(g_s.inPos, g_s.inIdx, outV, outT, g_s.nrm);
  g_s.counts[0] = outV;
  g_s.counts[1] = outT;
  return 0;
}

FE_EXPORT int32_t fe_mod_laplacian_smooth(int32_t repeat, float lambda, float lambda_border,
                                          int32_t axis_mask, int32_t preserve_volume,
                                          int32_t normalized, int32_t invert_vgroup) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const uint32_t axes = static_cast<uint32_t>(axis_mask) & 7u;
  const int32_t iters = repeat < 0 ? 0 : (repeat > 64 ? 64 : repeat);
  if (!axes || !iters) {
    for (uint32_t i = 0; i < v * 3u; ++i) g_s.outPos[i] = g_s.inPos[i];
    for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
    if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
    if (g_s.inSmooth && g_s.outSmooth) {
      g_s.flagMode = 1;
      for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i];
    }
    return commit(v, t);
  }
  if (v > LAPLACIAN_MAX_VERTS) return -5;
  g_s.flagMode = 1;
  if (g_s.inSmooth && g_s.outSmooth) {
    for (uint32_t i = 0; i < t; ++i) g_s.outSmooth[i] = g_s.inSmooth[i];
  }

  const float minArea = 0.00001f;

  /* ---- unique edges ---- */
  SplitEdges es;
  if (!splitEdgesInit(es, t)) return -2;
  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t a = g_s.inIdx[f * 3 + k];
      const uint32_t b = g_s.inIdx[f * 3 + (k + 1u) % 3u];
      if (a != b) splitEdgeSlot(es, a, b, true, f, nullptr);
    }
  }
  uint32_t ec = 0;
  for (uint32_t i = 0; i <= es.mask; ++i) if (es.nf[i]) ++ec;
  if (!ec) return -4;

  uint32_t* eu = modArray<uint32_t>(ec);
  uint32_t* ev = modArray<uint32_t>(ec);
  float* eweight = modArray<float>(ec);
  uint32_t* neEd = modArray<uint32_t>(v);
  uint32_t* neFa = modArray<uint32_t>(v);
  float* ringArea = modArray<float>(v);
  float* vlen = modArray<float>(v);
  float* vwt = modArray<float>(v);
  uint8_t* zero = modArray<uint8_t>(v);
  float* cot = modArray<float>(t * 3u);
  if (!eu || !ev || !eweight || !neEd || !neFa || !ringArea || !vlen || !vwt || !zero || !cot) return -2;

  for (uint32_t i = 0; i < v; ++i) {
    neEd[i] = 0u; neFa[i] = 0u; ringArea[i] = 0.0f; vlen[i] = 0.0f; vwt[i] = 0.0f; zero[i] = 0u;
  }

  /* ---- init_laplacian_matrix(): edge lengths first ---- */
  {
    uint32_t w = 0;
    for (uint32_t i = 0; i <= es.mask; ++i) {
      if (!es.nf[i]) continue;
      eu[w] = es.a[i]; ev[w] = es.b[i];
      const float len = (readPos(g_s.inPos, es.b[i]) - readPos(g_s.inPos, es.a[i])).length();
      float weight = len;
      if (len < minArea) {
        zero[es.a[i]] = 1u;
        zero[es.b[i]] = 1u;
      } else {
        weight = 1.0f / len;
      }
      eweight[w] = weight;
      ++neEd[es.a[i]];
      ++neEd[es.b[i]];
      ++w;
    }
  }

  /* ---- corner cotangents, ring areas, face counts ---- */
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t ia = g_s.inIdx[f * 3], ib = g_s.inIdx[f * 3 + 1], ic = g_s.inIdx[f * 3 + 2];
    const Vec3 pa = readPos(g_s.inPos, ia), pb = readPos(g_s.inPos, ib), pc = readPos(g_s.inPos, ic);
    const float twice = cross(pb - pa, pc - pa).length();
    const float area = 0.5f * twice;
    ++neFa[ia]; ++neFa[ib]; ++neFa[ic];
    ringArea[ia] += area; ringArea[ib] += area; ringArea[ic] += area;
    if (area < minArea) { zero[ia] = 1u; zero[ib] = 1u; zero[ic] = 1u; }
    /* cotangent_tri_weight_v3(): dot(a, b) / |cross(a, b)| at each corner. */
    const float inv = twice > 0.0f ? 1.0f / twice : 0.0f;
    cot[f * 3] = Vec3::dot(pa - pb, pa - pc) * inv;
    cot[f * 3 + 1] = Vec3::dot(pb - pa, pb - pc) * inv;
    cot[f * 3 + 2] = Vec3::dot(pc - pa, pc - pb) * inv;
  }

  /* vweights. Upstream's corner loop visits every corner of a face three
     times - once with it as curr, once as next, once as prev - and each visit
     adds the two cotangents at the other corners, so a triangle contributes
     twice the sum of its three cotangents to each of its vertices. */
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t c0 = f * 3, c1 = f * 3 + 1, c2 = f * 3 + 2;
    const float total = cot[c0] + cot[c1] + cot[c2];
    vwt[g_s.inIdx[c0]] += total;
    vwt[g_s.inIdx[c1]] += total;
    vwt[g_s.inIdx[c2]] += total;
  }

  auto isRing = [&](uint32_t i) { return neEd[i] == neFa[i] && zero[i] == 0u; };
  auto isBoundary = [&](uint32_t i) { return neEd[i] != neFa[i]; };

  for (uint32_t e = 0; e < ec; ++e) {
    if (isBoundary(eu[e]) && isBoundary(ev[e])) {
      vlen[eu[e]] += eweight[e];
      vlen[ev[e]] += eweight[e];
    }
  }

  /* ---- the per-vertex normalisation, before anything is assembled ---- */
  const float absLambda = absf(lambda);
  const float absBorder = absf(lambda_border);
  /* MOD_laplaciansmooth.cc builds the system once, at iter 0, and every row of
     a weighted vertex is scaled by wpaint - including the diagonal:
       vweights[i] = -|lambda| * wpaint / w
       vlengths[i] = -|lambda_border| * wpaint * 2 / w
       diag        = 1 + |lambda| * wpaint   (or |lambda_border| * wpaint * 2)
     A zero weight therefore leaves the row as the identity, and the vertex
     does not move. */
  float* wpaint = modArray<float>(v);
  if (!wpaint) return -2;
  for (uint32_t i = 0; i < v; ++i) wpaint[i] = deformWeight(i, invert_vgroup);
  for (uint32_t i = 0; i < v; ++i) {
    if (zero[i]) { vwt[i] = 0.0f; vlen[i] = 0.0f; continue; }
    if (isRing(i)) {
      if (normalized) {
        vwt[i] = vwt[i] == 0.0f ? 0.0f : -absLambda * wpaint[i] / vwt[i];
      } else {
        const float w = vwt[i] * ringArea[i];
        vwt[i] = w == 0.0f ? 0.0f : -absLambda * wpaint[i] / (4.0f * w);
      }
      vlen[i] = 0.0f;
    } else {
      vwt[i] = 0.0f;
      vlen[i] = vlen[i] == 0.0f ? 0.0f : -absBorder * 2.0f * wpaint[i] / vlen[i];
    }
  }

  /* ---- assemble A ---- */
  /* Six entries per corner, exactly like fill_laplacian_matrix(): each corner
     writes the two neighbours of itself, of the next corner and of the
     previous one, so a pair inside one triangle is written twice. */
  uint32_t nnz = v;  /* the diagonal, always present */
  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      if (isRing(g_s.inIdx[f * 3 + k])) nnz += 6u;
    }
  }
  for (uint32_t e = 0; e < ec; ++e) {
    if (isBoundary(eu[e]) && isBoundary(ev[e]) && !zero[eu[e]] && !zero[ev[e]]) nnz += 2u;
  }

  Csr a;
  a.n = v;
  a.nnz = nnz;
  a.row = modArray<uint32_t>(v + 1u);
  a.col = modArray<uint32_t>(nnz);
  a.val = modArray<float>(nnz);
  uint32_t* cursor = modArray<uint32_t>(v);
  if (!a.row || !a.col || !a.val || !cursor) return -2;

  for (uint32_t i = 0; i <= v; ++i) a.row[i] = 0u;
  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t c = g_s.inIdx[f * 3 + k];
      if (isRing(c)) a.row[c + 1u] += 6u;
    }
  }
  for (uint32_t e = 0; e < ec; ++e) {
    if (isBoundary(eu[e]) && isBoundary(ev[e]) && !zero[eu[e]] && !zero[ev[e]]) {
      ++a.row[eu[e] + 1u];
      ++a.row[ev[e] + 1u];
    }
  }
  for (uint32_t i = 0; i < v; ++i) ++a.row[i + 1u];
  for (uint32_t i = 0; i < v; ++i) a.row[i + 1u] += a.row[i];
  for (uint32_t i = 0; i < v; ++i) cursor[i] = a.row[i];

  auto addEntry = [&](uint32_t r, uint32_t c, float val) {
    const uint32_t slot = cursor[r]++;
    a.col[slot] = c;
    a.val[slot] = val;
  };

  for (uint32_t f = 0; f < t; ++f) {
    for (uint32_t k = 0; k < 3u; ++k) {
      const uint32_t curr = f * 3 + k, next = f * 3 + (k + 1u) % 3u, prev = f * 3 + (k + 2u) % 3u;
      const uint32_t vc = g_s.inIdx[curr], vn = g_s.inIdx[next], vp = g_s.inIdx[prev];
      const float wNext = cot[next] * 0.5f, wPrev = cot[prev] * 0.5f, wCurr = cot[curr] * 0.5f;
      if (isRing(vc)) {
        addEntry(vc, vn, wPrev * vwt[vc]);
        addEntry(vc, vp, wNext * vwt[vc]);
      }
      if (isRing(vn)) {
        addEntry(vn, vc, wPrev * vwt[vn]);
        addEntry(vn, vp, wCurr * vwt[vn]);
      }
      if (isRing(vp)) {
        addEntry(vp, vc, wNext * vwt[vp]);
        addEntry(vp, vn, wCurr * vwt[vp]);
      }
    }
  }
  for (uint32_t e = 0; e < ec; ++e) {
    const uint32_t u = eu[e], w = ev[e];
    if (isBoundary(u) && isBoundary(w) && !zero[u] && !zero[w]) {
      addEntry(u, w, eweight[e] * vlen[u]);
      addEntry(w, u, eweight[e] * vlen[w]);
    }
  }
  for (uint32_t i = 0; i < v; ++i) {
    if (zero[i]) { addEntry(i, i, 1.0f); }
    else if (isRing(i)) {
      addEntry(i, i, normalized ? 1.0f + absLambda * wpaint[i]
                                : 1.0f + (ringArea[i] > 0.0f ? absLambda * wpaint[i] / (4.0f * ringArea[i]) : 0.0f));
    } else {
      addEntry(i, i, 1.0f + absBorder * 2.0f * wpaint[i]);
    }
  }

  Csr at;
  if (!csrTranspose(a, at)) return -2;

  /* ---- workspace: three axes share it ---- */
  float* x = modArray<float>(v);
  float* r = modArray<float>(v);
  float* p = modArray<float>(v);
  float* q = modArray<float>(v);
  float* s2 = modArray<float>(v);
  float* diag = modArray<float>(v);
  float* rhs = modArray<float>(v);
  float* prec = modArray<float>(v);
  if (!x || !r || !p || !q || !s2 || !diag || !rhs || !prec) return -2;

  /* diag(A^T A) = sum of the squares of column i. */
  for (uint32_t i = 0; i < v; ++i) diag[i] = 0.0f;
  for (uint32_t i = 0; i < v; ++i) {
    for (uint32_t k = at.row[i]; k < at.row[i + 1u]; ++k) diag[at.col[k]] += at.val[k] * at.val[k];
  }
  for (uint32_t i = 0; i < v; ++i) prec[i] = diag[i] > 1e-12f ? 1.0f / diag[i] : 1.0f;

  auto solveAxis = [&](float* coord) -> bool {
    /* rhs = A^T b */
    for (uint32_t i = 0; i < v; ++i) {
      x[i] = coord[i];
      rhs[i] = 0.0f;
    }
    for (uint32_t i = 0; i < v; ++i) {
      const float xi = coord[i];
      for (uint32_t k = at.row[i]; k < at.row[i + 1u]; ++k) rhs[at.col[k]] += at.val[k] * xi;
    }
    /* r = A^T b - A^T A x */
    csrMatVec(a, x, q);
    csrMatVec(at, q, r);
    float rr = 0.0f;
    for (uint32_t i = 0; i < v; ++i) { r[i] = rhs[i] - r[i]; rr += r[i] * r[i]; }
    const float rr0 = rr;
    if (!(rr0 > 0.0f)) return true;
    for (uint32_t i = 0; i < v; ++i) p[i] = r[i] * prec[i];
    float rp = 0.0f;
    for (uint32_t i = 0; i < v; ++i) rp += r[i] * p[i];
    for (uint32_t iter = 0; iter < LAPLACIAN_MAX_ITERS; ++iter) {
      if (rr <= rr0 * 1e-10f) break;
      csrMatVec(a, p, q);
      csrMatVec(at, q, s2);
      float pAp = 0.0f;
      for (uint32_t i = 0; i < v; ++i) pAp += p[i] * s2[i];
      if (!(pAp > 1e-20f)) break;
      const float alpha = rp / pAp;
      for (uint32_t i = 0; i < v; ++i) { x[i] += alpha * p[i]; r[i] -= alpha * s2[i]; }
      float rrNew = 0.0f;
      for (uint32_t i = 0; i < v; ++i) rrNew += r[i] * r[i];
      if (!(rrNew > 0.0f)) break;
      for (uint32_t i = 0; i < v; ++i) q[i] = r[i] * prec[i];
      float rpNew = 0.0f;
      for (uint32_t i = 0; i < v; ++i) rpNew += r[i] * q[i];
      const float beta = rpNew / rp;
      for (uint32_t i = 0; i < v; ++i) p[i] = q[i] + beta * p[i];
      rp = rpNew;
      rr = rrNew;
    }
    return true;
  };

  /* ---- the centroid, and the starting volume ---- */
  Vec3 centroid(0.0f, 0.0f, 0.0f);
  for (uint32_t i = 0; i < v; ++i) centroid += readPos(g_s.inPos, i);
  centroid = centroid * (1.0f / static_cast<float>(v));

  auto volume = [&](const float* pos) {
    float vol = 0.0f;
    for (uint32_t f = 0; f < t; ++f) {
      const Vec3 a = readPos(pos, g_s.inIdx[f * 3]) - centroid;
      const Vec3 b = readPos(pos, g_s.inIdx[f * 3 + 1]) - centroid;
      const Vec3 c = readPos(pos, g_s.inIdx[f * 3 + 2]) - centroid;
      vol += Vec3::dot(a, cross(b, c)) / 6.0f;
    }
    return absf(vol);
  };

  /* Working positions, so the solve always reads the same buffer. */
  float* pos = g_s.outPos;
  for (uint32_t i = 0; i < v * 3u; ++i) pos[i] = g_s.inPos[i];

  const float vini = preserve_volume ? volume(pos) : 0.0f;

  float* axisBuf = modArray<float>(v);
  if (!axisBuf) return -2;

  for (int32_t iter = 0; iter < iters; ++iter) {
    for (uint32_t axis = 0; axis < 3u; ++axis) {
      if (!(axes & (1u << axis))) continue;
      for (uint32_t i = 0; i < v; ++i) axisBuf[i] = pos[i * 3 + axis];
      if (!solveAxis(axisBuf)) return -2;
      for (uint32_t i = 0; i < v; ++i) {
        if (zero[i]) continue;
        /* A zero weight makes the row the identity, so the direct solve
           upstream runs pins the vertex where it is. This stack solves the
           normal equations instead, which would let a neighbour's row drag an
           unweighted vertex along; pin it here, which is exactly the identity
           row's answer. */
        if (wpaint[i] <= 0.0f) continue;
        const float lam = isRing(i) ? (lambda >= 0.0f ? 1.0f : -1.0f)
                                    : (lambda_border >= 0.0f ? 1.0f : -1.0f);
        pos[i * 3 + axis] += lam * (x[i] - pos[i * 3 + axis]);
      }
    }
    if (preserve_volume) {
      const float vend = volume(pos);
      if (vend > 0.0f && vini > 0.0f) {
        const float beta = powf(vini / vend, 1.0f / 3.0f);
        for (uint32_t i = 0; i < v; ++i) {
          const Vec3 d = readPos(pos, i) - centroid;
          Vec3 out = d;
          if (axes & 1u) out.x = d.x * beta;
          if (axes & 2u) out.y = d.y * beta;
          if (axes & 4u) out.z = d.z * beta;
          writePos(pos, i, out + centroid);
        }
      }
    }
  }

  for (uint32_t i = 0; i < t * 3u; ++i) g_s.outIdx[i] = g_s.inIdx[i];
  if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.outUv[i] = g_s.inUv[i];
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_boolean(int32_t op, int32_t use_self, int32_t hole_tolerant) {
  if (!g_s.ready) return -1;
  const uint32_t vA = g_s.vc, tA = g_s.tc;
  if (!vA || !tA) return -3;
  if (!g_s.tgtCounts || !g_s.tgtPos || !g_s.tgtIdx) return -3;
  const uint32_t tB = g_s.tgtCounts[1];
  if (!g_s.tgtCounts[0] || !tB) return -3;
  (void)use_self;
  (void)hole_tolerant;
  if (op < 0 || op > 2) op = 0;
  g_s.flagMode = 0;

  /* Coplanar faces are the one case a segment-based cut cannot see: two cubes
     sharing a wall meet along no line at all, and both copies of that wall
     would be classified from a point that sits exactly on the other surface.
     Upstream's exact solver resolves it with rationals; the float solver is
     allowed a nudge, so B is rotated by a tenth of a milliradian about its own
     centre. Nothing visible moves - on a 2-unit cube it is 2e-4 units - and
     every pair of faces is afterwards in general position. */
  float* bPos = modArray<float>(g_s.tgtCounts[0] * 3u);
  if (!bPos) return -2;
  {
    Vec3 c(0.0f, 0.0f, 0.0f);
    for (uint32_t i = 0; i < g_s.tgtCounts[0]; ++i) c += readPos(g_s.tgtPos, i);
    c = c * (1.0f / static_cast<float>(g_s.tgtCounts[0]));
    const Vec3 ax = normalize(Vec3(0.3121f, 0.5153f, 0.7977f));
    const float ang = 1.5e-4f;
    const float ca = cosf(ang), sa = sinf(ang);
    for (uint32_t i = 0; i < g_s.tgtCounts[0]; ++i) {
      const Vec3 d = readPos(g_s.tgtPos, i) - c;
      const Vec3 par = ax * Vec3::dot(d, ax);
      const Vec3 perp = d - par;
      const Vec3 rot = perp * ca + cross(ax, perp) * sa + par;
      writePos(bPos, i, rot + c);
    }
  }

  BoolBvh bvhA, bvhB;
  if (!bvhBuild(bvhA, g_s.inPos, g_s.inIdx, tA)) return -2;
  if (!bvhBuild(bvhB, bPos, g_s.tgtIdx, tB)) return -2;

  uint32_t nextV = 0, outT = 0;
  /* The ray: not axis aligned and not a small rational, so a cube's edges and
     diagonals never line up with it. */
  const Vec3 rayDir = normalize(Vec3(0.3420201f, 0.6040228f, 0.7198463f));

  auto emitTri = [&](const Vec3* tri, const float uvs[3][2], bool hasUv, bool flip) -> bool {
    if (outT >= g_s.tcap || nextV + 3u > g_s.vcap) return false;
    const uint32_t base = nextV;
    for (uint32_t c = 0; c < 3u; ++c) {
      writePos(g_s.outPos, base + c, tri[c]);
      if (g_s.hasUv) {
        g_s.outUv[(base + c) * 2] = hasUv ? uvs[c][0] : 0.0f;
        g_s.outUv[(base + c) * 2 + 1] = hasUv ? uvs[c][1] : 0.0f;
      }
    }
    g_s.outIdx[outT * 3] = base;
    g_s.outIdx[outT * 3 + 1] = base + (flip ? 2u : 1u);
    g_s.outIdx[outT * 3 + 2] = base + (flip ? 1u : 2u);
    ++outT;
    nextV = base + 3u;
    return true;
  };

  /* One mesh against the other: cut where they cross, classify the pieces,
     keep the half the operation wants. */
  auto process = [&](const float* pos, const uint32_t* idx, const float* uvBuf, uint32_t tn,
                     const BoolBvh& other, const float* oPos, const uint32_t* oIdx,
                     bool keepInside, bool flip) -> int32_t {
    for (uint32_t t = 0; t < tn; ++t) {
      const Vec3 p0 = readPos(pos, idx[t * 3]);
      const Vec3 p1 = readPos(pos, idx[t * 3 + 1]);
      const Vec3 p2 = readPos(pos, idx[t * 3 + 2]);
      if (cross(p1 - p0, p2 - p0).length() < 1e-12f) continue;

      Vec3 segA[BOOL_MAX_PIECES], segB[BOOL_MAX_PIECES];
      uint32_t segN = 0;
      Vec3 tl, th;
      triBounds(pos, idx, t, tl, th);
      uint32_t stack[64];
      uint32_t sp = 0;
      stack[sp++] = 0u;
      while (sp && segN < BOOL_MAX_PIECES) {
        const uint32_t nd = stack[--sp];
        if (th.x < other.lo[nd * 3] || tl.x > other.hi[nd * 3]) continue;
        if (th.y < other.lo[nd * 3 + 1] || tl.y > other.hi[nd * 3 + 1]) continue;
        if (th.z < other.lo[nd * 3 + 2] || tl.z > other.hi[nd * 3 + 2]) continue;
        if (other.start[nd] != 0xFFFFFFFFu) {
          for (uint32_t i = 0; i < other.count[nd] && segN < BOOL_MAX_PIECES; ++i) {
            const uint32_t u = other.order[other.start[nd] + i];
            const Vec3 q0 = readPos(oPos, oIdx[u * 3]);
            const Vec3 q1 = readPos(oPos, oIdx[u * 3 + 1]);
            const Vec3 q2 = readPos(oPos, oIdx[u * 3 + 2]);
            Vec3 s0, s1;
            if (triTriSegment(p0, p1, p2, q0, q1, q2, s0, s1)) {
              segA[segN] = s0;
              segB[segN] = s1;
              ++segN;
            }
          }
          continue;
        }
        if (sp + 2u < 64u) { stack[sp++] = nd + 1u; stack[sp++] = other.right[nd]; }
      }

      const bool hasUv = g_s.hasUv && uvBuf != nullptr;
      float uv[3][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}, {0.0f, 0.0f}};
      if (hasUv) {
        uv[0][0] = uvBuf[idx[t * 3] * 2]; uv[0][1] = uvBuf[idx[t * 3] * 2 + 1];
        uv[1][0] = uvBuf[idx[t * 3 + 1] * 2]; uv[1][1] = uvBuf[idx[t * 3 + 1] * 2 + 1];
        uv[2][0] = uvBuf[idx[t * 3 + 2] * 2]; uv[2][1] = uvBuf[idx[t * 3 + 2] * 2 + 1];
      }

      const Vec3 corners[3] = {p0, p1, p2};
      int32_t rc = 0;
      if (!segN) {
        const Vec3 centre = (p0 + p1 + p2) * (1.0f / 3.0f);
        const bool inside = (bvhHits(other, oPos, oIdx, centre, rayDir) & 1u) != 0u;
        if (inside == keepInside) {
          if (!emitTri(corners, uv, hasUv, flip)) rc = -2;
        }
      } else {
        boolCutTriangle(p0, p1, p2, uv[0], uv[1], uv[2], segA, segB, segN,
          [&](const Vec3* tri, const float uvs[3][2]) {
            if (rc) return;
            const Vec3 centre = (tri[0] + tri[1] + tri[2]) * (1.0f / 3.0f);
            const bool inside = (bvhHits(other, oPos, oIdx, centre, rayDir) & 1u) != 0u;
            if (inside == keepInside) {
              if (!emitTri(tri, uvs, hasUv, flip)) rc = -2;
            }
          });
      }
      if (rc) return rc;
    }
    return 0;
  };

  /* Difference keeps A outside B and B inside A, with B reversed; Union keeps
     both outsides; Intersection both insides. */
  const bool aInside = op == 2;
  const bool bInside = op != 1;   /* Difference and Intersection both keep B's
                                     inside; Union keeps its outside. */
  int32_t rc = process(g_s.inPos, g_s.inIdx, g_s.hasUv ? g_s.inUv : nullptr, tA,
                       bvhB, g_s.tgtPos, g_s.tgtIdx, aInside, false);
  if (rc) return rc;
  rc = process(bPos, g_s.tgtIdx, g_s.tgtUv, tB,
               bvhA, g_s.inPos, g_s.inIdx, bInside, op == 0);
  if (rc) return rc;
  if (!nextV || !outT) return -4;
  return commit(nextV, outT);
}

/* =========================================================================
 * Laplacian Smooth - ported from MOD_laplaciansmooth.cc
 *
 *   source/blender/modifiers/intern/MOD_laplaciansmooth.cc
 *
 * Upstream builds one sparse Laplacian matrix per mesh and solves it as a
 * least-squares problem, three right-hand sides at once (x, y, z):
 *
 *   - a ring (interior) vertex gets the cotangent weights of the triangles
 *     around it, normalised by vweights,
 *   - a boundary vertex gets the scale-dependent umbrella operator over the
 *     edges that stay on the boundary, normalised by vlengths,
 *   - a triangle below 1e-5 in area, or an edge below it in length, marks its
 *     vertices zerola and pins them to a unit diagonal.
 *
 * Upstream solves it with Eigen's LeastSquaresConjugateGradient. Eigen is not
 * something a freestanding module can link, so the same normal equations
 * (A^T A x = A^T b) are solved here with conjugate gradients and a Jacobi
 * preconditioner; that is the same method, written out. The result is then
 * blended in with the signed step validate_solution() applies, and the volume
 * preserved the way volume_preservation() does it.
 *
 * Not ported: vertex-group weighting (no weight groups in this pipeline).
 * Meshes above LAPLACIAN_MAX_VERTS fall back to the caller's own smoothing:
 * the three sparse matrices would not fit the arena.
 * ========================================================================= */

/* =========================================================================
 * Exported deformation kernel entry points
 * ========================================================================= */

FE_EXPORT uint32_t fe_mod_matrix_ptr(void) {
  return g_s.matrix ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.matrix)) : 0u;
}

FE_EXPORT int32_t fe_mod_target_begin(uint32_t vert_count, uint32_t tri_count) {
  if (!g_s.ready) return -1;
  if (vert_count < 3u || tri_count == 0u) return -3;
  if (vert_count > MOD_MAX_VERTS || tri_count > MOD_MAX_TRIS) return -2;
  float* pos = modArray<float>(vert_count * 3u);
  uint32_t* idx = modArray<uint32_t>(tri_count * 3u);
  float* world = modArray<float>(vert_count * 3u);
  float* tuv = modArray<float>(vert_count * 2u);
  uint32_t* counts = modArray<uint32_t>(2u);
  if (!pos || !idx || !world || !tuv || !counts) return -2;
  g_s.tgtPos = pos;
  g_s.tgtIdx = idx;
  g_s.tgtWorld = world;
  g_s.tgtUv = tuv;
  g_s.tgtCounts = counts;
  counts[0] = vert_count;
  counts[1] = tri_count;
  return 0;
}

FE_EXPORT uint32_t fe_mod_target_counts_ptr(void) {
  return g_s.tgtCounts ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.tgtCounts)) : 0u;
}
FE_EXPORT uint32_t fe_mod_target_pos_ptr(void) {
  return g_s.tgtPos ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.tgtPos)) : 0u;
}
FE_EXPORT uint32_t fe_mod_target_uv_ptr(void) {
  return g_s.tgtUv ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.tgtUv)) : 0u;
}

FE_EXPORT uint32_t fe_mod_target_idx_ptr(void) {
  return g_s.tgtIdx ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.tgtIdx)) : 0u;
}

FE_EXPORT int32_t fe_mod_lattice_cage(uint32_t nx, uint32_t ny, uint32_t nz, float pad_ratio) {
  if (!g_s.ready) return -1;
  return latticeCageFromBounds(nx, ny, nz, pad_ratio);
}

FE_EXPORT int32_t fe_mod_lattice_alloc(uint32_t point_count) {
  if (!g_s.ready) return -1;
  if (point_count < 2u || point_count > 4096u) return -3;
  float* rest = modArray<float>(point_count * 3u);
  float* def = modArray<float>(point_count * 3u);
  if (!rest || !def) return -2;
  g_s.latRest = rest;
  g_s.latDef = def;
  g_s.latN = point_count;
  return 0;
}

FE_EXPORT uint32_t fe_mod_lattice_rest_ptr(void) {
  return g_s.latRest ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.latRest)) : 0u;
}
FE_EXPORT uint32_t fe_mod_lattice_deform_ptr(void) {
  return g_s.latDef ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.latDef)) : 0u;
}

FE_EXPORT int32_t fe_mod_lattice_apply(uint32_t nx, uint32_t ny, uint32_t nz, float strength) {
  if (!g_s.ready) return -1;
  return latticeApply(nx, ny, nz, strength);
}

FE_EXPORT int32_t fe_mod_armature(float influence, int32_t preserve_volume, float bend_deg, float twist_deg) {
  if (!g_s.ready) return -1;
  return armatureApply(influence, preserve_volume, bend_deg, twist_deg);
}

FE_EXPORT int32_t fe_mod_shrinkwrap(uint32_t mode, float offset) {
  if (!g_s.ready) return -1;
  return shrinkwrapApply(mode, offset);
}

FE_EXPORT int32_t fe_mod_sd_bind(void) {
  if (!g_s.ready) return -1;
  return surfaceDeformBind();
}

FE_EXPORT int32_t fe_mod_sd_upload(uint32_t vert_count, uint32_t tri_count) {
  if (!g_s.ready) return -1;
  if (vert_count == 0u || tri_count == 0u) return -3;
  if (vert_count != g_s.vc) return -3;
  if (vert_count > MOD_MAX_VERTS || tri_count > MOD_MAX_TRIS) return -2;
  uint32_t* ord = modArray<uint32_t>(vert_count);
  float* bary = modArray<float>(vert_count * 3u);
  float* scalars = modArray<float>(vert_count * 2u);
  uint32_t* tris = modArray<uint32_t>(tri_count * 3u);
  if (!ord || !bary || !scalars || !tris) return -2;
  g_s.sdOrd = ord;
  g_s.sdBary = bary;
  g_s.sdScalars = scalars;
  g_s.sdTris = tris;
  g_s.sdBound = vert_count;
  g_s.sdTriN = tri_count;
  return 0;
}

FE_EXPORT int32_t fe_mod_sd_apply(float strength) {
  if (!g_s.ready) return -1;
  return surfaceDeformApply(strength);
}

FE_EXPORT uint32_t fe_mod_sd_ordinal_ptr(void) {
  return g_s.sdOrd ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.sdOrd)) : 0u;
}
FE_EXPORT uint32_t fe_mod_sd_bary_ptr(void) {
  return g_s.sdBary ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.sdBary)) : 0u;
}
FE_EXPORT uint32_t fe_mod_sd_scalars_ptr(void) {
  return g_s.sdScalars ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.sdScalars)) : 0u;
}
FE_EXPORT uint32_t fe_mod_sd_tris_ptr(void) {
  return g_s.sdTris ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.sdTris)) : 0u;
}
FE_EXPORT uint32_t fe_mod_sd_tri_count(void) { return g_s.sdTriN; }

} // extern "C"
