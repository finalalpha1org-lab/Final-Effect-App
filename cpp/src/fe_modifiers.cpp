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

/* Keep 6 MB of the shared scratch arena free for other subsystems. */
constexpr uint32_t MOD_ARENA_BUDGET = 18u * 1024u * 1024u;
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
  uint32_t* inIdx = nullptr;
  float* outPos = nullptr;
  float* outUv = nullptr;
  uint32_t* outIdx = nullptr;
  float* nrm = nullptr;
  uint32_t* counts = nullptr;
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

void copyOutToIn(uint32_t v, uint32_t t) {
  for (uint32_t i = 0; i < v * 3u; ++i) g_s.inPos[i] = g_s.outPos[i];
  if (g_s.hasUv) for (uint32_t i = 0; i < v * 2u; ++i) g_s.inUv[i] = g_s.outUv[i];
  for (uint32_t i = 0; i < t * 3u; ++i) g_s.inIdx[i] = g_s.outIdx[i];
  g_s.vc = v;
  g_s.tc = t;
}

int32_t commit(uint32_t v, uint32_t t) {
  if (v == 0 || t == 0) return -4;
  if (v > g_s.vcap || t > g_s.tcap) return -2;
  copyOutToIn(v, t);
  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
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

} // namespace

extern "C" {

FE_EXPORT int32_t fe_mod_begin(uint32_t vert_capacity, uint32_t tri_capacity, uint32_t has_uv) {
  g_s.ready = false;
  g_s.hasUv = has_uv != 0;
  if (vert_capacity == 0 || tri_capacity == 0) return -3;
  if (vert_capacity > MOD_MAX_VERTS || tri_capacity > MOD_MAX_TRIS) return -2;

  const uint32_t v = vert_capacity, t = tri_capacity;
  const uint32_t uvCap = g_s.hasUv ? v * 2u : 1u;
  uint64_t bytes = static_cast<uint64_t>(v) * 3u * 4u * 3u;
  bytes += static_cast<uint64_t>(uvCap) * 4u * 2u;
  bytes += static_cast<uint64_t>(t) * 3u * 4u * 2u;
  bytes += 8u;
  if (bytes > MOD_ARENA_BUDGET - 8u * 1024u * 1024u) return -2;

  fe_arena_reset();
  g_mod_used = 0;
  g_s.vcap = v;
  g_s.tcap = t;
  g_s.vc = 0;
  g_s.tc = 0;
  g_s.inPos = modArray<float>(v * 3u);
  g_s.inUv = modArray<float>(uvCap);
  g_s.inIdx = modArray<uint32_t>(t * 3u);
  g_s.outPos = modArray<float>(v * 3u);
  g_s.outUv = modArray<float>(uvCap);
  g_s.outIdx = modArray<uint32_t>(t * 3u);
  g_s.nrm = modArray<float>(v * 3u);
  g_s.counts = modArray<uint32_t>(2u);
  if (!g_s.inPos || !g_s.inUv || !g_s.inIdx || !g_s.outPos || !g_s.outUv || !g_s.outIdx || !g_s.nrm || !g_s.counts) {
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
FE_EXPORT uint32_t fe_mod_normals_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_s.nrm)); }

FE_EXPORT void fe_mod_set_counts(uint32_t vert_count, uint32_t tri_count) {
  if (!g_s.ready) return;
  g_s.vc = vert_count > g_s.vcap ? g_s.vcap : vert_count;
  g_s.tc = tri_count > g_s.tcap ? g_s.tcap : tri_count;
  g_s.counts[0] = g_s.vc;
  g_s.counts[1] = g_s.tc;
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

FE_EXPORT int32_t fe_mod_solidify(float thickness, float offset, int32_t rim, int32_t even_thickness) {
  if (!g_s.ready) return -1;
  const uint32_t v = g_s.vc, t = g_s.tc;
  if (!v || !t) return -3;
  if (v * 2u > g_s.vcap) return -2;
  const float th = clampf(thickness, -1.0f, 1.0f);
  if (absf(th) < 1e-9f) return 0;
  (void)even_thickness;

  computeNormals(g_s.inPos, g_s.inIdx, v, t, g_s.nrm);
  const float outer = th * (1.0f - clampf(offset, -1.0f, 1.0f)) * 0.5f;
  const float inner = -th * (1.0f + clampf(offset, -1.0f, 1.0f)) * 0.5f;

  for (uint32_t i = 0; i < v; ++i) {
    const Vec3 p = readPos(g_s.inPos, i);
    const Vec3 n = readPos(g_s.nrm, i);
    writePos(g_s.outPos, i, p + n * outer);
    writePos(g_s.outPos, v + i, p + n * inner);
    if (g_s.hasUv) {
      g_s.outUv[i * 2] = g_s.inUv[i * 2]; g_s.outUv[i * 2 + 1] = g_s.inUv[i * 2 + 1];
      g_s.outUv[(v + i) * 2] = g_s.inUv[i * 2]; g_s.outUv[(v + i) * 2 + 1] = g_s.inUv[i * 2 + 1];
    }
  }

  uint32_t outT = 0;
  for (uint32_t f = 0; f < t; ++f) {
    const uint32_t a = g_s.inIdx[f * 3], b = g_s.inIdx[f * 3 + 1], c = g_s.inIdx[f * 3 + 2];
    g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = c; outT++;
    g_s.outIdx[outT * 3] = v + c; g_s.outIdx[outT * 3 + 1] = v + b; g_s.outIdx[outT * 3 + 2] = v + a; outT++;
  }

  if (rim) {
    EdgeTable edges;
    if (!edgeTableInit(edges, t, true)) return -2;
    for (uint32_t f = 0; f < t; ++f) {
      const uint32_t i0 = g_s.inIdx[f * 3], i1 = g_s.inIdx[f * 3 + 1], i2 = g_s.inIdx[f * 3 + 2];
      if (!edgeTableAdd(edges, i0, i1, f) || !edgeTableAdd(edges, i1, i2, f) || !edgeTableAdd(edges, i2, i0, f)) return -2;
    }
    for (uint32_t s = 0; s <= edges.mask; ++s) {
      if (edges.count[s] != 1u) continue;
      if (outT + 2u > g_s.tcap) return -2;
      const uint32_t a = edges.a[s], b = edges.b[s];
      const Vec3 pa = readPos(g_s.inPos, a), pb = readPos(g_s.inPos, b);
      const Vec3 na = readPos(g_s.nrm, a), nb = readPos(g_s.nrm, b);
      const Vec3 oa = pa + na * outer, ob = pb + nb * outer;
      const Vec3 ia = pa + na * inner, ib = pb + nb * inner;
      const uint32_t f = edges.tri ? edges.tri[s] : 0u;
      const Vec3 fa = readPos(g_s.inPos, g_s.inIdx[f * 3]);
      const Vec3 fb = readPos(g_s.inPos, g_s.inIdx[f * 3 + 1]);
      const Vec3 fc = readPos(g_s.inPos, g_s.inIdx[f * 3 + 2]);
      const Vec3 n = cross(fb - fa, fc - fa);
      const Vec3 want = cross(pb - pa, n);
      const Vec3 got = cross(ob - oa, ib - oa);
      if (dot(got, want) >= 0.0f) {
        g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = b; g_s.outIdx[outT * 3 + 2] = v + b; outT++;
        g_s.outIdx[outT * 3] = a; g_s.outIdx[outT * 3 + 1] = v + b; g_s.outIdx[outT * 3 + 2] = v + a; outT++;
      } else {
        g_s.outIdx[outT * 3] = b; g_s.outIdx[outT * 3 + 1] = a; g_s.outIdx[outT * 3 + 2] = v + a; outT++;
        g_s.outIdx[outT * 3] = b; g_s.outIdx[outT * 3 + 1] = v + a; g_s.outIdx[outT * 3 + 2] = v + b; outT++;
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
    }
  }
  return commit(v * copies, t * copies);
}

/* Split every triangle into four with edge midpoints, weld the shared midpoints,
   then relax once so the surface reads like a Loop limit (documented). */
FE_EXPORT int32_t fe_mod_subdivide(uint32_t levels) {
  if (!g_s.ready) return -1;
  const uint32_t lv = levels > 3u ? 3u : levels;
  if (lv == 0u) return 0;

  uint32_t v = g_s.vc, t = g_s.tc;
  for (uint32_t level = 0; level < lv; ++level) {
    const uint32_t nv = v + t * 3u;
    const uint32_t nt = t * 4u;
    if (nv > g_s.vcap || nt > g_s.tcap) return -2;

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
    }
    copyOutToIn(nv, nt);
    v = nv;
    t = nt;

    uint32_t* remap = modArray<uint32_t>(v + 1u);
    if (!remap) return -2;
    uint32_t wv = 0, wt = 0;
    int32_t rc = weldSession(1e-6f, &wv, &wt, remap);
    if (rc != 0) return rc;
    copyOutToIn(wv, wt);
    v = wv;
    t = wt;

    rc = loopRelax();
    if (rc != 0) return rc;
  }
  g_s.counts[0] = v;
  g_s.counts[1] = t;
  return 0;
}

/* Vertex-clustering decimation: choose a grid resolution by bisection so the
   surviving face count lands near the requested ratio, then emit the collapse. */
FE_EXPORT int32_t fe_mod_decimate(float ratio, int32_t preserve_boundary) {
  if (!g_s.ready) return -1;
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

} // extern "C"
