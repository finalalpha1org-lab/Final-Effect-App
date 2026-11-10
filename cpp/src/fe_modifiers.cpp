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

/* Weld the session mesh from input into output. */
int32_t weldSession(float epsilon, uint32_t* outV, uint32_t* outT, uint32_t* remap) {
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (v == 0 || t == 0) return -3;
  const float eps = epsilon > 1e-9f ? epsilon : 1e-9f;
  const float inv = 1.0f / eps;

  WeldMap map;
  if (!weldMapInit(map, v)) return -2;
  uint32_t newV = 0;
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
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

extern "C" {

FE_EXPORT int32_t fe_mod_begin(uint32_t vert_capacity, uint32_t tri_capacity, uint32_t has_uv) {
  g_s.ready = false;
  g_s.hasUv = has_uv != 0;
  g_s.matrix = nullptr;
  g_s.tgtPos = nullptr; g_s.tgtIdx = nullptr; g_s.tgtWorld = nullptr; g_s.tgtCounts = nullptr;
  g_s.sdOrd = nullptr; g_s.sdBary = nullptr; g_s.sdScalars = nullptr; g_s.sdTris = nullptr;
  g_s.sdBound = 0; g_s.sdTriN = 0;
  g_s.latRest = nullptr; g_s.latDef = nullptr; g_s.latN = 0;
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
  g_s.matrix = modArray<float>(16u);
  if (g_s.matrix) {
    for (uint32_t i = 0; i < 16u; ++i) g_s.matrix[i] = 0.0f;
    g_s.matrix[0] = 1.0f; g_s.matrix[5] = 1.0f; g_s.matrix[10] = 1.0f; g_s.matrix[15] = 1.0f;
  }
  if (!g_s.inPos || !g_s.inUv || !g_s.inNrm || !g_s.inIdx || !g_s.inSmooth || !g_s.outSmooth ||
      !g_s.outPos || !g_s.outUv || !g_s.outIdx || !g_s.nrm || !g_s.counts || !g_s.matrix) {
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

FE_EXPORT int32_t fe_mod_weld(float epsilon) {
  if (!g_s.ready) return -1;
  uint32_t* remap = modArray<uint32_t>(g_s.vc + 1u);
  if (!remap) return -2;
  uint32_t v = 0, t = 0;
  const int32_t rc = weldSession(epsilon, &v, &t, remap);
  if (rc != 0) return rc;
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_smooth(uint32_t iterations, float factor, int32_t volume_preserving, int32_t boundary_mode) {
  if (!g_s.ready) return -1;
  const uint32_t v0 = g_s.vc, t0 = g_s.tc;
  if (v0 == 0 || t0 == 0) return -3;

  uint32_t* remap = modArray<uint32_t>(v0 + 1u);
  if (!remap) return -2;
  uint32_t v = 0, t = 0;
  int32_t rc = weldSession(1e-6f, &v, &t, remap);
  if (rc != 0) return rc;
  copyOutToIn(v, t);

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
      const Vec3 p = readPos(g_s.inPos, i);
      const Vec3 avg = readPos(acc, i) * (1.0f / static_cast<float>(cnt[i]));
      writePos(g_s.inPos, i, lerpv(p, avg, step));
    }
  }

  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  g_s.vc = v;
  g_s.tc = t;
  g_s.counts[0] = v;
  g_s.counts[1] = t;
  return 0;
}

FE_EXPORT int32_t fe_mod_mirror(uint32_t axis_mask, int32_t clipping, float merge_epsilon) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  uint32_t axesEnabled = 0;
  for (uint32_t a = 0; a < 3; ++a) if (axis_mask & (1u << a)) axesEnabled++;
  const uint32_t copies = 1u << axesEnabled;
  if (v * copies > g_s.vcap || t * copies > g_s.tcap) return -2;

  for (uint32_t k = 0; k < copies; ++k) {
    float sign[3] = {1.0f, 1.0f, 1.0f};
    uint32_t bit = 0;
    for (uint32_t a = 0; a < 3; ++a) {
      if (axis_mask & (1u << a)) {
        if (k & (1u << bit)) sign[a] = -1.0f;
        bit++;
      }
    }
    const uint32_t base = k * v;
    for (uint32_t i = 0; i < v; ++i) {
      const Vec3 p = readPos(g_s.inPos, i);
      writePos(g_s.outPos, base + i, Vec3(p.x * sign[0], p.y * sign[1], p.z * sign[2]));
      if (g_s.hasUv) { g_s.outUv[(base + i) * 2] = g_s.inUv[i * 2]; g_s.outUv[(base + i) * 2 + 1] = g_s.inUv[i * 2 + 1]; }
    }
    const bool flip = sign[0] * sign[1] * sign[2] < 0.0f;
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t a = g_s.inIdx[f * 3], b = g_s.inIdx[f * 3 + 1], c = g_s.inIdx[f * 3 + 2];
      const uint32_t o = (k * t + f) * 3;
      if (flip) { g_s.outIdx[o] = base + c; g_s.outIdx[o + 1] = base + b; g_s.outIdx[o + 2] = base + a; }
      else { g_s.outIdx[o] = base + a; g_s.outIdx[o + 1] = base + b; g_s.outIdx[o + 2] = base + c; }
      if (g_s.outSmooth && g_s.inSmooth) g_s.outSmooth[k * t + f] = g_s.inSmooth[f];
    }
  }

  const uint32_t outV = v * copies, outT = t * copies;
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

FE_EXPORT int32_t fe_mod_solidify(float thickness, float offset, int32_t rim, int32_t even_thickness) {
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

  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const Vec3 n = readPos(vn, i);
    const float scale = accum[i] > 1e-12f ? angles[i] / accum[i] : 1.0f;
    writePos(g_s.outPos, i, p + n * (ofs_orig * scale));
    writePos(g_s.outPos, v + i, p + n * (ofs_new * scale));
    if (g_s.hasUv) {
      g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1];
      g_s.outUv[(v + i) * 2] = g_s.inUv[i * 2]; g_s.outUv[(v + i) * 2 + 1] = g_s.inUv[i * 2 + 1];
    }
  }

  uint32_t outT = 0u;
  for (uint32_t f = 0; f < t && outT + 2u <= g_s.tcap; ++f) {
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
      const Vec3 want = cross(pb - pa, n);
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

FE_EXPORT int32_t fe_mod_displace(float strength, float midlevel, float frequency, uint32_t seed, uint32_t octaves, uint32_t direction) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const float freq = clampf(frequency, 0.01f, 40.0f);
  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  const Vec3 fixedAxis = axisVector(direction > 0u ? direction - 1u : 0u);
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const float n = fbm3(p.x * freq + 11.0f, p.y * freq + 17.0f, p.z * freq + 23.0f, seed, octaves);
    const float d = (n - clampf(midlevel, 0.0f, 1.0f)) * strength;
    const Vec3 dir = direction == 0u ? readPos(g_s.nrm, i) : fixedAxis;
    writePos(g_s.outPos, i, p + dir * d);
    if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
  }
  for (uint32_t f = 0; f < t * 3u; ++f) g_s.outIdx[f] = g_s.inIdx[f];
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_wave(float height, float width, float speed, float time, uint32_t axis, float phase) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const uint32_t ax = axis > 2u ? 0u : axis;
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const float radial = ax == 0u ? sqrtf(p.x * p.x + p.z * p.z)
                       : ax == 1u ? sqrtf(p.y * p.y + p.z * p.z)
                                  : sqrtf(p.x * p.x + p.y * p.y);
    const float wave = sinf(radial * width * 1.5f - time * speed + phase) * height * 0.2f;
    Vec3 q = p;
    if (ax == 0u) q.y += wave; else if (ax == 1u) q.x += wave; else q.z += wave;
    writePos(g_s.outPos, i, q);
    if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
  }
  for (uint32_t f = 0; f < t * 3u; ++f) g_s.outIdx[f] = g_s.inIdx[f];
  return commit(v, t);
}

FE_EXPORT int32_t fe_mod_cast(uint32_t shape, float factor, float radius, float size) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  const Box box = meshBounds(g_s.inPos, v);
  const Vec3 center = box.center();
  const Vec3 ext = box.size();
  const float base = maxf(maxf(ext.x, ext.y), ext.z) * 0.5f * maxf(radius, 0.0f) * clampf(size, 0.05f, 8.0f);
  const float f = clampf(factor, 0.0f, 1.0f);
  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const Vec3 local = p - center;
    Vec3 target = local;
    if (shape == 0u) {
      const float len = maxf(length(local), 1e-6f);
      target = local * (base / len);
    } else if (shape == 1u) {
      const float len = maxf(sqrtf(local.x * local.x + local.z * local.z), 1e-6f);
      target = Vec3(local.x * (base / len), local.y, local.z * (base / len));
    } else {
      target = Vec3(clampf(local.x, -base, base), clampf(local.y, -base, base), clampf(local.z, -base, base));
    }
    writePos(g_s.outPos, i, center + lerpv(local, target, f));
    if (g_s.hasUv) { g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1]; }
  }
  for (uint32_t f2 = 0; f2 < t * 3u; ++f2) g_s.outIdx[f2] = g_s.inIdx[f2];
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
                                  float uv_u, float uv_v) {
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

  const float eps = 1e-6f;
  const float dist = length(translation);
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
FE_EXPORT int32_t fe_mod_decimate_collapse(float ratio, int32_t preserve_boundary) {
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
    return absf(quadricError(quad[a], merged) + quadricError(quad[b], merged));
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

  uint32_t neighbourA[128], neighbourB[128];
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

    /* Degenerate topology (bm_edge_collapse_is_degenerate_topology): the two
     * vertex neighbourhoods may overlap only in the faces along this edge. */
    uint32_t shared = 0u;
    for (int32_t e = head[a]; e >= 0; e = nextFace[e]) {
      const uint32_t f = static_cast<uint32_t>(e) / 3u;
      if (aliveF[f] && faceHas(f, a) && faceHas(f, b)) ++shared;
    }
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
    if (common != shared) continue;

    /* bm_edge_collapse_is_degenerate_flip(), per surrounding vertex. */
    bool flip = false;
    for (uint32_t pass = 0; pass < 2u && !flip; ++pass) {
      const uint32_t pivot = pass == 0u ? a : b;
      for (int32_t e = head[pivot]; e >= 0 && !flip; e = nextFace[e]) {
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
        if (dot(crossExist, crossOptim) <= (exist2 + optim2) * 0.01f) flip = true;
      }
    }
    if (flip) continue;

    /* ---- the collapse: b merges into a, at the target position ---- */
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
        } else {
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
                                   int32_t boundary, int32_t even_offset) {
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
      Vec3 p = curr + tangent * (inset * facShell) + vnormal * ofs_mid;
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
      const Vec3 p = co + no * (inset * facShell) + readPos(vn, i) * ofs_mid;
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
    writePos(g_s.outPos, negBase + i * 2u, p + n * ofs_orig);
    writePos(g_s.outPos, negBase + i * 2u + 1u, p + n * ofs_new);
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
  uint32_t* counts = modArray<uint32_t>(2u);
  if (!pos || !idx || !world || !counts) return -2;
  g_s.tgtPos = pos;
  g_s.tgtIdx = idx;
  g_s.tgtWorld = world;
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
