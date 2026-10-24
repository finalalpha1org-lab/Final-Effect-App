/* ===========================================================================
 * fe_editmesh.cpp — C++ Edit Mode kernel: state, selection, transforms,
 *                   proportional editing, undo, and the render-mesh builder.
 * ---------------------------------------------------------------------------
 * Topology operations (extrude, inset, subdivide, bevel, …) live in
 * fe_editmesh_tools.cpp and share this state through fe_editmesh_internal.hpp.
 *
 * Everything here runs in C++ because it is O(vertices x edges) work; the JS
 * layer only forwards touch events and uploads the result to the GPU.
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_editmesh_internal.hpp"

namespace fe_edit {

using fe::absf;
using fe::sqrtf;
using fe::clampf;
using fe::minf;
using fe::maxf;
using fe::floorf;
using fe::sinf;
using fe::cosf;
using fe::atan2f;

/* Zero-initialised because these live in .bss: the wasm file must not carry
   megabytes of padding just to state that a mesh starts empty. */
Mesh M;
EdgeTable E;
PairFlags g_seams;
PairFlags g_sharp;

uint32_t g_mode = kModeVertex;
float g_propRadius = 1.0f;
uint32_t g_propFalloff = kFallSmooth;
bool g_propEnabled = false;
bool g_propConnected = true;
uint32_t g_pivotMode = 0; /* 0 median, 1 cursor, 2 individual */
float g_pivot[3] = {0.0f, 0.0f, 0.0f};
uint32_t g_snapMode = 0;
float g_snapIncrement = 0.1f;

uint8_t g_triMark[kMaxTris];
uint32_t g_vertMap[kMaxVerts];
uint32_t g_vertStamp[kMaxVerts];
uint8_t g_vertMark[kMaxVerts];

uint32_t g_adjStart[kMaxVerts + 1];
uint32_t g_adjList[kMaxEdges * 2];
uint32_t g_adjCount = 0;

uint32_t g_faceStart[kMaxVerts + 1];
uint32_t g_faceList[kMaxTris * 3];

Clip C;

float g_outPos[kMaxRenderVerts * 3];
float g_outNrm[kMaxRenderVerts * 3];
float g_outCol[kMaxRenderVerts * 3];
uint32_t g_outIdx[kMaxTris * 3];
uint32_t g_outVerts = 0;
uint32_t g_outIdxCount = 0;
uint32_t g_outSplit = 0;

namespace {

constexpr uint32_t kHashBits = 17;
constexpr uint32_t kHashSize = 1u << kHashBits;
constexpr uint32_t kNoFace = 0xFFFFFFFFu;

uint32_t g_hash[kHashSize];

/* The undo pool. Six megabytes of snapshots that only exist once the studio is
   in Edit Mode, so it is taken from the lazy heap on the first snapshot rather
   than reserved by every session — and by the kernel worker, which never edits
   a mesh. A session that cannot get the block simply records no undo steps:
   fe_edit_undo then reports that there is nothing to undo, which is the
   degraded behaviour the caller already handles. */
uint8_t* g_pool = nullptr;
uint32_t g_poolUsed = 0;

static bool ensure_undo_pool(void) {
  if (g_pool != nullptr) return true;
  g_pool = reinterpret_cast<uint8_t*>(fe::heap::alloc(kMaxUndoBytes, 16));
  if (g_pool == nullptr) return false;
  g_poolUsed = 0;
  return true;
}

struct Snapshot {
  uint32_t offset;
  uint32_t size;
};

Snapshot g_undo[kUndoSteps];
uint32_t g_undoCount = 0;
Snapshot g_redo[kUndoSteps];
uint32_t g_redoCount = 0;

void copyBytes(uint8_t* dst, const uint8_t* src, uint32_t n) {
  if (dst == src) return;
  for (uint32_t i = 0; i < n; ++i) dst[i] = src[i];
}

inline uint32_t packKey(uint32_t a, uint32_t b) {
  if (a > b) { const uint32_t t = a; a = b; b = t; }
  return (a * 73856093u) ^ (b * 19349663u);
}

inline uint32_t edgeKey(uint32_t a, uint32_t b) { return packKey(a, b) & (kHashSize - 1u); }

/* ---- tiny binary heap for multi-source Dijkstra ---- */
uint32_t g_heapV[kMaxVerts];
float g_heapD[kMaxVerts];
uint32_t g_heapN = 0;

void heapPush(uint32_t v, float d) {
  if (g_heapN >= kMaxVerts) return;
  uint32_t i = g_heapN++;
  while (i > 0) {
    const uint32_t parent = (i - 1) >> 1;
    if (g_heapD[parent] <= d) break;
    g_heapV[i] = g_heapV[parent];
    g_heapD[i] = g_heapD[parent];
    i = parent;
  }
  g_heapV[i] = v;
  g_heapD[i] = d;
}

void heapPop(uint32_t& v, float& d) {
  v = g_heapV[0];
  d = g_heapD[0];
  --g_heapN;
  if (g_heapN == 0) return;
  const uint32_t lv = g_heapV[g_heapN];
  const float ld = g_heapD[g_heapN];
  uint32_t i = 0;
  for (;;) {
    uint32_t child = (i << 1) + 1;
    if (child >= g_heapN) break;
    if (child + 1 < g_heapN && g_heapD[child + 1] < g_heapD[child]) ++child;
    if (g_heapD[child] >= ld) break;
    g_heapV[i] = g_heapV[child];
    g_heapD[i] = g_heapD[child];
    i = child;
  }
  g_heapV[i] = lv;
  g_heapD[i] = ld;
}

/* ---- snapshot (undo) size/encode/decode ---- */
uint32_t snapshotSize() {
  uint32_t size = 0;
  size += 4 * 4;                       /* nv, nt, flags, seam/sharp counts */
  size += M.nv;                        /* vsel */
  size += M.nv * 12u;                  /* positions */
  if (M.hasColor) size += M.nv * 12u;  /* colours */
  size += M.nt * 12u;                  /* triangles */
  size += (g_seams.n + g_sharp.n) * 12u;
  return (size + 3u) & ~3u;
}

void putU32(uint8_t*& p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFF);
  p += 4;
}

void putFloat(uint8_t*& p, float v) {
  uint32_t bits;
  __builtin_memcpy(&bits, &v, 4);
  putU32(p, bits);
}

uint32_t getU32(const uint8_t*& p) {
  const uint32_t v = static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
                     (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
  p += 4;
  return v;
}

float getFloat(const uint8_t*& p) {
  const uint32_t bits = getU32(p);
  float v;
  __builtin_memcpy(&v, &bits, 4);
  return v;
}

void encodeState(uint8_t* dst) {
  uint8_t* p = dst;
  putU32(p, M.nv);
  putU32(p, M.nt);
  putU32(p, (M.hasColor ? 1u : 0u) | (M.smooth ? 2u : 0u));
  putU32(p, g_seams.n * 4u + g_sharp.n);
  for (uint32_t i = 0; i < M.nv; ++i) *p++ = M.vsel[i];
  for (uint32_t i = 0; i < M.nv; ++i) { putFloat(p, M.x[i]); putFloat(p, M.y[i]); putFloat(p, M.z[i]); }
  if (M.hasColor) {
    for (uint32_t i = 0; i < M.nv; ++i) { putFloat(p, M.cr[i]); putFloat(p, M.cg[i]); putFloat(p, M.cb[i]); }
  }
  for (uint32_t i = 0; i < M.nt * 3u; ++i) putU32(p, M.tri[i]);
  for (uint32_t i = 0; i < g_seams.n; ++i) { putU32(p, g_seams.a[i]); putU32(p, g_seams.b[i]); putFloat(p, g_seams.value[i]); }
  for (uint32_t i = 0; i < g_sharp.n; ++i) { putU32(p, g_sharp.a[i]); putU32(p, g_sharp.b[i]); putFloat(p, g_sharp.value[i]); }
}

bool decodeState(const uint8_t* src) {
  const uint8_t* p = src;
  const uint32_t nv = getU32(p);
  const uint32_t nt = getU32(p);
  const uint32_t flags = getU32(p);
  const uint32_t pairHeader = getU32(p);
  if (nv > kMaxVerts || nt > kMaxTris) return false;
  M.nv = nv;
  M.nt = nt;
  M.hasColor = (flags & 1u) != 0;
  M.smooth = (flags & 2u) != 0;
  for (uint32_t i = 0; i < nv; ++i) M.vsel[i] = *p++;
  for (uint32_t i = 0; i < nv; ++i) { M.x[i] = getFloat(p); M.y[i] = getFloat(p); M.z[i] = getFloat(p); }
  if (M.hasColor) {
    for (uint32_t i = 0; i < nv; ++i) { M.cr[i] = getFloat(p); M.cg[i] = getFloat(p); M.cb[i] = getFloat(p); }
  }
  for (uint32_t i = 0; i < nt * 3u; ++i) M.tri[i] = getU32(p);
  const uint32_t seamCount = pairHeader / 4u;
  const uint32_t sharpCount = pairHeader - seamCount * 4u;
  g_seams.n = seamCount;
  g_sharp.n = sharpCount;
  for (uint32_t i = 0; i < seamCount; ++i) { g_seams.a[i] = getU32(p); g_seams.b[i] = getU32(p); g_seams.value[i] = getFloat(p); }
  for (uint32_t i = 0; i < sharpCount; ++i) { g_sharp.a[i] = getU32(p); g_sharp.b[i] = getU32(p); g_sharp.value[i] = getFloat(p); }
  rebuildEdges();
  syncSelFromVerts();
  return true;
}

/* Drops the oldest history until `needed` more bytes fit, then rewrites the
   surviving snapshots to the front of the pool. The newest steps survive,
   because those are the ones an undo actually reaches for. */
void compactPool(uint32_t needed) {
  uint32_t total = 0;
  for (uint32_t i = 0; i < g_undoCount; ++i) total += g_undo[i].size;
  for (uint32_t i = 0; i < g_redoCount; ++i) total += g_redo[i].size;

  uint32_t drop = 0;
  while (drop < g_undoCount && total + needed > kMaxUndoBytes) {
    total -= g_undo[drop].size;
    ++drop;
  }
  while (drop < g_undoCount && total + needed > kMaxUndoBytes) ++drop;
  if (drop > 0) {
    for (uint32_t i = drop; i < g_undoCount; ++i) g_undo[i - drop] = g_undo[i];
    g_undoCount -= drop;
  }
  if (total + needed > kMaxUndoBytes) {
    /* Nothing left to drop: keep the redo tail only, then give up on history. */
    g_undoCount = 0;
    total = 0;
    for (uint32_t i = 0; i < g_redoCount; ++i) total += g_redo[i].size;
    if (total + needed > kMaxUndoBytes) { g_redoCount = 0; total = 0; }
  }

  uint32_t dst = 0;
  for (uint32_t i = 0; i < g_undoCount; ++i) {
    const uint32_t size = g_undo[i].size;
    copyBytes(g_pool + dst, g_pool + g_undo[i].offset, size);
    g_undo[i].offset = dst;
    dst += size;
  }
  for (uint32_t i = 0; i < g_redoCount; ++i) {
    const uint32_t size = g_redo[i].size;
    copyBytes(g_pool + dst, g_pool + g_redo[i].offset, size);
    g_redo[i].offset = dst;
    dst += size;
  }
  g_poolUsed = dst;
}

bool appendSnapshot(Snapshot* list, uint32_t& count, uint32_t size) {
  if (!ensure_undo_pool()) return false;
  if (count >= kUndoSteps) {
    /* Drop the oldest entry; its bytes stay as dead space until compaction. */
    for (uint32_t i = 1; i < count; ++i) list[i - 1] = list[i];
    --count;
  }
  if (g_poolUsed + size > kMaxUndoBytes) compactPool(size);
  if (g_poolUsed + size > kMaxUndoBytes) return false;
  const uint32_t offset = g_poolUsed;
  encodeState(g_pool + offset);
  g_poolUsed += size;
  list[count].offset = offset;
  list[count].size = size;
  ++count;
  return true;
}

} // namespace

/* ---- geometry helpers -------------------------------------------------- */

void faceNormal(uint32_t t, float& nx, float& ny, float& nz) {
  const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
  const float ux = M.x[b] - M.x[a], uy = M.y[b] - M.y[a], uz = M.z[b] - M.z[a];
  const float vx = M.x[c] - M.x[a], vy = M.y[c] - M.y[a], vz = M.z[c] - M.z[a];
  nx = uy * vz - uz * vy;
  ny = uz * vx - ux * vz;
  nz = ux * vy - uy * vx;
  const float len = sqrtf(nx * nx + ny * ny + nz * nz);
  if (len > 1e-20f) { nx /= len; ny /= len; nz /= len; }
  else { nx = 0.0f; ny = 1.0f; nz = 0.0f; }
}

void triangleArea(uint32_t t, float& area) {
  const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
  const float ux = M.x[b] - M.x[a], uy = M.y[b] - M.y[a], uz = M.z[b] - M.z[a];
  const float vx = M.x[c] - M.x[a], vy = M.y[c] - M.y[a], vz = M.z[c] - M.z[a];
  const float cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  area = 0.5f * sqrtf(cx * cx + cy * cy + cz * cz);
}

void vertexNormals(float* nx, float* ny, float* nz) {
  for (uint32_t i = 0; i < M.nv; ++i) { nx[i] = 0.0f; ny[i] = 0.0f; nz[i] = 0.0f; }
  for (uint32_t t = 0; t < M.nt; ++t) {
    float fx, fy, fz;
    faceNormal(t, fx, fy, fz);
    const float ax = M.x[M.tri[t * 3]], ay = M.y[M.tri[t * 3]], az = M.z[M.tri[t * 3]];
    const float bx = M.x[M.tri[t * 3 + 1]], by = M.y[M.tri[t * 3 + 1]], bz = M.z[M.tri[t * 3 + 1]];
    const float cx = M.x[M.tri[t * 3 + 2]], cy = M.y[M.tri[t * 3 + 2]], cz = M.z[M.tri[t * 3 + 2]];
    const float ux = bx - ax, uy = by - ay, uz = bz - az;
    const float vx = cx - ax, vy = cy - ay, vz = cz - az;
    const float wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx;
    const float area = 0.5f * sqrtf(wx * wx + wy * wy + wz * wz);
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t v = M.tri[t * 3 + k];
      nx[v] += fx * area;
      ny[v] += fy * area;
      nz[v] += fz * area;
    }
  }
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float len = sqrtf(nx[i] * nx[i] + ny[i] * ny[i] + nz[i] * nz[i]);
    if (len > 1e-20f) { nx[i] /= len; ny[i] /= len; nz[i] /= len; }
    else { nx[i] = 0.0f; ny[i] = 1.0f; nz[i] = 0.0f; }
  }
}

/* ---- edge table -------------------------------------------------------- */

void rebuildEdges() {
  for (uint32_t i = 0; i < kHashSize; ++i) g_hash[i] = 0;
  E.n = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    for (uint32_t k = 0; k < 3; ++k) {
      uint32_t a = M.tri[t * 3 + k];
      uint32_t b = M.tri[t * 3 + (k + 1) % 3];
      if (a > b) { const uint32_t tmp = a; a = b; b = tmp; }
      uint32_t slot = edgeKey(a, b);
      uint32_t found = kNoFace;
      for (;;) {
        const uint32_t entry = g_hash[slot];
        if (entry == 0) break;
        const uint32_t e = entry - 1;
        if (E.a[e] == a && E.b[e] == b) { found = e; break; }
        slot = (slot + 1) & (kHashSize - 1u);
      }
      if (found != kNoFace) {
        if (E.f1[found] == kNoFace) E.f1[found] = t;
        continue;
      }
      if (E.n >= kMaxEdges) continue;
      const uint32_t e = E.n++;
      E.a[e] = a;
      E.b[e] = b;
      E.f0[e] = t;
      E.f1[e] = kNoFace;
      E.sel[e] = 0;
      g_hash[slot] = e + 1;
    }
  }
}

uint32_t findEdge(uint32_t a, uint32_t b) {
  if (a > b) { const uint32_t t = a; a = b; b = t; }
  uint32_t slot = edgeKey(a, b);
  for (;;) {
    const uint32_t entry = g_hash[slot];
    if (entry == 0) return kNoFace;
    const uint32_t e = entry - 1;
    if (E.a[e] == a && E.b[e] == b) return e;
    slot = (slot + 1) & (kHashSize - 1u);
  }
}

bool edgeSelected(uint32_t e) {
  if (e >= E.n) return false;
  return M.vsel[E.a[e]] && M.vsel[E.b[e]];
}

bool faceSelected(uint32_t t) {
  return M.vsel[M.tri[t * 3]] && M.vsel[M.tri[t * 3 + 1]] && M.vsel[M.tri[t * 3 + 2]];
}

void selectFaceVerts(uint32_t t) {
  M.vsel[M.tri[t * 3]] = 1;
  M.vsel[M.tri[t * 3 + 1]] = 1;
  M.vsel[M.tri[t * 3 + 2]] = 1;
}

void deselectFaceVerts(uint32_t t) {
  M.vsel[M.tri[t * 3]] = 0;
  M.vsel[M.tri[t * 3 + 1]] = 0;
  M.vsel[M.tri[t * 3 + 2]] = 0;
}

void syncSelFromVerts() {
  for (uint32_t e = 0; e < E.n; ++e) E.sel[e] = (M.vsel[E.a[e]] && M.vsel[E.b[e]]) ? 1 : 0;
  for (uint32_t t = 0; t < M.nt; ++t) M.fsel[t] = faceSelected(t) ? 1 : 0;
}

uint32_t selectedVertCount() {
  uint32_t n = 0;
  for (uint32_t i = 0; i < M.nv; ++i) n += M.vsel[i] ? 1u : 0u;
  return n;
}

uint32_t selectedEdgeCount() {
  uint32_t n = 0;
  for (uint32_t e = 0; e < E.n; ++e) n += edgeSelected(e) ? 1u : 0u;
  return n;
}

uint32_t selectedFaceCount() {
  uint32_t n = 0;
  for (uint32_t t = 0; t < M.nt; ++t) n += faceSelected(t) ? 1u : 0u;
  return n;
}

void clearSelection() {
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  syncSelFromVerts();
}

/* ---- pair flags -------------------------------------------------------- */

bool pairGet(PairFlags& set, uint32_t a, uint32_t b, float* value) {
  if (a > b) { const uint32_t t = a; a = b; b = t; }
  for (uint32_t i = 0; i < set.n; ++i) {
    if (set.a[i] == a && set.b[i] == b) {
      if (value) *value = set.value[i];
      return true;
    }
  }
  return false;
}

void pairSet(PairFlags& set, uint32_t a, uint32_t b, bool on, float value) {
  if (a > b) { const uint32_t t = a; a = b; b = t; }
  uint32_t i = 0;
  while (i < set.n && !(set.a[i] == a && set.b[i] == b)) ++i;
  if (on) {
    if (i < set.n) { set.value[i] = value; return; }
    if (set.n >= kMaxPairs) return;
    set.a[set.n] = a;
    set.b[set.n] = b;
    set.value[set.n] = value;
    ++set.n;
  } else if (i < set.n) {
    set.a[i] = set.a[set.n - 1];
    set.b[i] = set.b[set.n - 1];
    set.value[i] = set.value[set.n - 1];
    --set.n;
  }
}

/* ---- structure helpers ------------------------------------------------- */

bool addTri(uint32_t a, uint32_t b, uint32_t c) {
  if (a == b || b == c || a == c) return false;
  if (M.nt >= kMaxTris) return false;
  M.tri[M.nt * 3] = a;
  M.tri[M.nt * 3 + 1] = b;
  M.tri[M.nt * 3 + 2] = c;
  ++M.nt;
  return true;
}

uint32_t addVert(float x, float y, float z, float r, float g, float b, bool selected) {
  if (M.nv >= kMaxVerts) return 0xFFFFFFFFu;
  const uint32_t v = M.nv++;
  M.x[v] = x; M.y[v] = y; M.z[v] = z;
  M.cr[v] = r; M.cg[v] = g; M.cb[v] = b;
  M.vsel[v] = selected ? 1 : 0;
  return v;
}

uint32_t removeDegenerateTris() {
  uint32_t removed = 0;
  uint32_t out = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
    if (a == b || b == c || a == c) { ++removed; continue; }
    if (out != t) {
      M.tri[out * 3] = a;
      M.tri[out * 3 + 1] = b;
      M.tri[out * 3 + 2] = c;
    }
    ++out;
  }
  M.nt = out;
  return removed;
}

void compactMesh(bool keepUnusedVerts) {
  removeDegenerateTris();
  for (uint32_t i = 0; i < M.nv; ++i) g_vertStamp[i] = 0;
  for (uint32_t i = 0; i < M.nt * 3u; ++i) g_vertStamp[M.tri[i]] = 1;
  uint32_t nv = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const bool keep = keepUnusedVerts || g_vertStamp[i] || M.vsel[i];
    g_vertMap[i] = keep ? nv : 0xFFFFFFFFu;
    if (!keep) continue;
    if (nv != i) {
      M.x[nv] = M.x[i]; M.y[nv] = M.y[i]; M.z[nv] = M.z[i];
      M.cr[nv] = M.cr[i]; M.cg[nv] = M.cg[i]; M.cb[nv] = M.cb[i];
      M.vsel[nv] = M.vsel[i];
    }
    ++nv;
  }
  /* Remap triangles. Any triangle that references a dropped vertex is stale
     by construction, so it is dropped with it. */
  uint32_t nt = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    const uint32_t a = g_vertMap[M.tri[t * 3]];
    const uint32_t b = g_vertMap[M.tri[t * 3 + 1]];
    const uint32_t c = g_vertMap[M.tri[t * 3 + 2]];
    if (a == 0xFFFFFFFFu || b == 0xFFFFFFFFu || c == 0xFFFFFFFFu) continue;
    M.tri[nt * 3] = a; M.tri[nt * 3 + 1] = b; M.tri[nt * 3 + 2] = c;
    ++nt;
  }
  M.nv = nv;
  M.nt = nt;
  rebuildEdges();
  syncSelFromVerts();
}

void removeMarkedTris() {
  uint32_t out = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (g_triMark[t]) continue;
    if (out != t) {
      M.tri[out * 3] = M.tri[t * 3];
      M.tri[out * 3 + 1] = M.tri[t * 3 + 1];
      M.tri[out * 3 + 2] = M.tri[t * 3 + 2];
    }
    ++out;
  }
  M.nt = out;
}

/* ---- proportional weights ---------------------------------------------- */

namespace {

float falloffAt(uint32_t mode, float t) {
  if (t <= 0.0f) return 1.0f;
  if (t >= 1.0f) return 0.0f;
  switch (mode) {
    case kFallConst: return 1.0f;
    case kFallLinear: return 1.0f - t;
    case kFallSmooth: return 1.0f - (t * t * (3.0f - 2.0f * t));
    case kFallSphere: return sqrtf(1.0f - t * t);
    case kFallRoot: return sqrtf(1.0f - t);
    case kFallSharp: return (1.0f - t) * (1.0f - t);
    default: return 1.0f - t;
  }
}

} // namespace

void buildVertexAdjacency() {
  for (uint32_t i = 0; i <= M.nv; ++i) g_adjStart[i] = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    ++g_adjStart[E.a[e] + 1];
    ++g_adjStart[E.b[e] + 1];
  }
  for (uint32_t i = 0; i < M.nv; ++i) g_adjStart[i + 1] += g_adjStart[i];
  g_adjCount = g_adjStart[M.nv];
  for (uint32_t i = 0; i <= M.nv; ++i) g_vertStamp[i] = g_adjStart[i];
  for (uint32_t e = 0; e < E.n; ++e) {
    g_adjList[g_vertStamp[E.a[e]]++] = E.b[e];
    g_adjList[g_vertStamp[E.b[e]]++] = E.a[e];
  }
}

void buildVertexFaces() {
  for (uint32_t i = 0; i <= M.nv; ++i) g_faceStart[i] = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    ++g_faceStart[M.tri[t * 3] + 1];
    ++g_faceStart[M.tri[t * 3 + 1] + 1];
    ++g_faceStart[M.tri[t * 3 + 2] + 1];
  }
  for (uint32_t i = 0; i < M.nv; ++i) g_faceStart[i + 1] += g_faceStart[i];
  for (uint32_t i = 0; i <= M.nv; ++i) g_vertStamp[i] = g_faceStart[i];
  for (uint32_t t = 0; t < M.nt; ++t) {
    g_faceList[g_vertStamp[M.tri[t * 3]]++] = t;
    g_faceList[g_vertStamp[M.tri[t * 3 + 1]]++] = t;
    g_faceList[g_vertStamp[M.tri[t * 3 + 2]]++] = t;
  }
}

void computeWeights() {
  for (uint32_t i = 0; i < M.nv; ++i) M.weight[i] = M.vsel[i] ? 1.0f : 0.0f;
  if (!g_propEnabled || g_propRadius <= 0.0f) return;

  if (!g_propConnected) {
    /* Euclidean: distance to the nearest selected vertex, no topology. */
    for (uint32_t i = 0; i < M.nv; ++i) {
      if (M.vsel[i]) continue;
      float best = g_propRadius;
      for (uint32_t s = 0; s < M.nv; ++s) {
        if (!M.vsel[s]) continue;
        const float dx = M.x[i] - M.x[s], dy = M.y[i] - M.y[s], dz = M.z[i] - M.z[s];
        const float d = sqrtf(dx * dx + dy * dy + dz * dz);
        if (d < best) best = d;
      }
      M.weight[i] = falloffAt(g_propFalloff, best / g_propRadius);
    }
    return;
  }

  buildVertexAdjacency();
  static float dist[kMaxVerts];
  static uint8_t settled[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) { dist[i] = 1e30f; settled[i] = 0; }
  g_heapN = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    dist[i] = 0.0f;
    heapPush(i, 0.0f);
  }
  while (g_heapN > 0) {
    uint32_t v = 0;
    float d = 0.0f;
    heapPop(v, d);
    if (settled[v]) continue;
    settled[v] = 1;
    if (d > g_propRadius) continue;
    for (uint32_t k = g_adjStart[v]; k < g_adjStart[v + 1]; ++k) {
      const uint32_t n = g_adjList[k];
      if (settled[n]) continue;
      const float nd = d + dist3(v, n);
      if (nd < dist[n]) { dist[n] = nd; heapPush(n, nd); }
    }
  }
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (M.vsel[i]) { M.weight[i] = 1.0f; continue; }
    M.weight[i] = dist[i] >= g_propRadius ? 0.0f : falloffAt(g_propFalloff, dist[i] / g_propRadius);
  }
}

/* ---- undo -------------------------------------------------------------- */

void undoClear() {
  g_undoCount = 0;
  g_redoCount = 0;
  g_poolUsed = 0;
}

void undoPush() {
  const uint32_t size = snapshotSize();
  if (appendSnapshot(g_undo, g_undoCount, size)) g_redoCount = 0;
}

uint32_t undoDepth() { return g_undoCount; }
uint32_t redoDepth() { return g_redoCount; }

int32_t undoStep() {
  if (g_undoCount == 0) return 0;
  const uint32_t size = snapshotSize();
  /* The state being left behind becomes the redo target. Appending may compact
     the pool, so the popped offset is read after the append. */
  appendSnapshot(g_redo, g_redoCount, size);
  if (g_undoCount == 0) return 0;
  const Snapshot snap = g_undo[g_undoCount - 1];
  --g_undoCount;
  return decodeState(g_pool + snap.offset) ? 1 : 0;
}

int32_t redoStep() {
  if (g_redoCount == 0) return 0;
  const uint32_t size = snapshotSize();
  appendSnapshot(g_undo, g_undoCount, size);
  if (g_redoCount == 0) return 0;
  const Snapshot snap = g_redo[g_redoCount - 1];
  --g_redoCount;
  return decodeState(g_pool + snap.offset) ? 1 : 0;
}

/* ---- clipboard --------------------------------------------------------- */

void clipClear() {
  C.nv = 0;
  C.nt = 0;
  C.hasColor = false;
}

/* ---- render mesh -------------------------------------------------------- */

namespace {

uint32_t g_groupOf[64];

} // namespace

uint32_t buildRenderMesh() {
  g_outVerts = 0;
  g_outIdxCount = 0;
  g_outSplit = 0;
  if (M.nt == 0 || M.nv == 0) return 0;

  /* Everything big is static: this runs on the wasm stack, which is 64 kB. */
  static float nx[kMaxVerts], ny[kMaxVerts], nz[kMaxVerts];
  static float fnx[kMaxTris], fny[kMaxTris], fnz[kMaxTris], farea[kMaxTris];
  vertexNormals(nx, ny, nz);

  if (!M.smooth) {
    /* Flat shading is done by the material (derivative normals in the
       fragment shader), so the indexed mesh can be reused untouched. */
    for (uint32_t i = 0; i < M.nv; ++i) {
      g_outPos[i * 3] = M.x[i]; g_outPos[i * 3 + 1] = M.y[i]; g_outPos[i * 3 + 2] = M.z[i];
      g_outNrm[i * 3] = nx[i]; g_outNrm[i * 3 + 1] = ny[i]; g_outNrm[i * 3 + 2] = nz[i];
      g_outCol[i * 3] = M.hasColor ? M.cr[i] : 1.0f;
      g_outCol[i * 3 + 1] = M.hasColor ? M.cg[i] : 1.0f;
      g_outCol[i * 3 + 2] = M.hasColor ? M.cb[i] : 1.0f;
    }
    g_outVerts = M.nv;
    for (uint32_t t = 0; t < M.nt; ++t) {
      g_outIdx[t * 3] = M.tri[t * 3];
      g_outIdx[t * 3 + 1] = M.tri[t * 3 + 1];
      g_outIdx[t * 3 + 2] = M.tri[t * 3 + 2];
    }
    g_outIdxCount = M.nt * 3u;
    return g_outVerts;
  }

  buildVertexFaces();
  for (uint32_t t = 0; t < M.nt; ++t) {
    faceNormal(t, fnx[t], fny[t], fnz[t]);
    triangleArea(t, farea[t]);
  }

  /* Per (vertex, smoothing group) render vertex. Two faces at the same vertex
     are in one group unless the edge between them is marked sharp. */
  uint32_t renderCount = 0;
  static uint32_t cornerGroup[kMaxTris * 3];
  static uint32_t groupVerts[3 * kMaxVerts];
  uint32_t groupTotal = 0;

  for (uint32_t v = 0; v < M.nv; ++v) {
    const uint32_t start = g_faceStart[v];
    const uint32_t count = g_faceStart[v + 1] - start;
    if (count == 0) {
      if (renderCount >= kMaxRenderVerts) goto unsplit;
      cornerGroup[v] = 0;
      g_outPos[renderCount * 3] = M.x[v];
      g_outPos[renderCount * 3 + 1] = M.y[v];
      g_outPos[renderCount * 3 + 2] = M.z[v];
      g_outNrm[renderCount * 3] = nx[v];
      g_outNrm[renderCount * 3 + 1] = ny[v];
      g_outNrm[renderCount * 3 + 2] = nz[v];
      ++renderCount;
      continue;
    }
    if (count > 63) goto unsplit;

    /* Group the incident faces. */
    uint32_t groupCount = 0;
    for (uint32_t i = 0; i < count; ++i) g_groupOf[i] = 0xFFFFFFFFu;
    for (uint32_t i = 0; i < count; ++i) {
      if (g_groupOf[i] != 0xFFFFFFFFu) continue;
      const uint32_t g = groupCount++;
      g_groupOf[i] = g;
      /* flood fill inside the incident set */
      bool grew = true;
      while (grew) {
        grew = false;
        for (uint32_t a = 0; a < count; ++a) {
          if (g_groupOf[a] != g) continue;
          const uint32_t fa = g_faceList[start + a];
          for (uint32_t b = 0; b < count; ++b) {
            if (g_groupOf[b] != 0xFFFFFFFFu) continue;
            const uint32_t fb = g_faceList[start + b];
            /* share another vertex? */
            uint32_t shared = 0xFFFFFFFFu;
            for (uint32_t x = 0; x < 3; ++x) {
              for (uint32_t y = 0; y < 3; ++y) {
                if (M.tri[fa * 3 + x] == M.tri[fb * 3 + y] && M.tri[fa * 3 + x] != v) shared = M.tri[fa * 3 + x];
              }
            }
            if (shared == 0xFFFFFFFFu) continue;
            float crease = 0.0f;
            if (pairGet(g_sharp, v, shared, &crease)) continue;
            g_groupOf[b] = g;
            grew = true;
          }
        }
      }
    }
    if (groupTotal + groupCount > 3 * kMaxVerts) goto unsplit;

    for (uint32_t g = 0; g < groupCount; ++g) {
      float ax = 0.0f, ay = 0.0f, az = 0.0f;
      for (uint32_t i = 0; i < count; ++i) {
        if (g_groupOf[i] != g) continue;
        const uint32_t f = g_faceList[start + i];
        ax += fnx[f] * farea[f];
        ay += fny[f] * farea[f];
        az += fnz[f] * farea[f];
      }
      const float len = sqrtf(ax * ax + ay * ay + az * az);
      if (len > 1e-20f) { ax /= len; ay /= len; az /= len; }
      else { ax = nx[v]; ay = ny[v]; az = nz[v]; }
      if (renderCount >= kMaxRenderVerts) goto unsplit;
      const uint32_t rv = renderCount++;
      g_outPos[rv * 3] = M.x[v]; g_outPos[rv * 3 + 1] = M.y[v]; g_outPos[rv * 3 + 2] = M.z[v];
      g_outNrm[rv * 3] = ax; g_outNrm[rv * 3 + 1] = ay; g_outNrm[rv * 3 + 2] = az;
      g_outCol[rv * 3] = M.hasColor ? M.cr[v] : 1.0f;
      g_outCol[rv * 3 + 1] = M.hasColor ? M.cg[v] : 1.0f;
      g_outCol[rv * 3 + 2] = M.hasColor ? M.cb[v] : 1.0f;
      groupVerts[groupTotal + g] = rv;
    }
    groupTotal += groupCount;
    for (uint32_t i = 0; i < count; ++i) {
      /* remember group -> render vertex for the corner that produced it */
      const uint32_t f = g_faceList[start + i];
      const uint32_t rv = groupVerts[groupTotal - groupCount + g_groupOf[i]];
      for (uint32_t k = 0; k < 3; ++k) {
        if (M.tri[f * 3 + k] == v) cornerGroup[f * 3 + k] = rv;
      }
    }
  }

  for (uint32_t t = 0; t < M.nt; ++t) {
    g_outIdx[t * 3] = cornerGroup[M.tri[t * 3]];
    g_outIdx[t * 3 + 1] = cornerGroup[M.tri[t * 3 + 1]];
    g_outIdx[t * 3 + 2] = cornerGroup[M.tri[t * 3 + 2]];
  }
  g_outVerts = renderCount;
  g_outIdxCount = M.nt * 3u;
  g_outSplit = renderCount > M.nv ? renderCount - M.nv : 0;
  return renderCount;

unsplit:
  for (uint32_t i = 0; i < M.nv; ++i) {
    g_outPos[i * 3] = M.x[i]; g_outPos[i * 3 + 1] = M.y[i]; g_outPos[i * 3 + 2] = M.z[i];
    g_outNrm[i * 3] = nx[i]; g_outNrm[i * 3 + 1] = ny[i]; g_outNrm[i * 3 + 2] = nz[i];
    g_outCol[i * 3] = M.hasColor ? M.cr[i] : 1.0f;
    g_outCol[i * 3 + 1] = M.hasColor ? M.cg[i] : 1.0f;
    g_outCol[i * 3 + 2] = M.hasColor ? M.cb[i] : 1.0f;
  }
  for (uint32_t t = 0; t < M.nt; ++t) {
    g_outIdx[t * 3] = M.tri[t * 3];
    g_outIdx[t * 3 + 1] = M.tri[t * 3 + 1];
    g_outIdx[t * 3 + 2] = M.tri[t * 3 + 2];
  }
  g_outVerts = M.nv;
  g_outIdxCount = M.nt * 3u;
  g_outSplit = 0;
  return g_outVerts;
}

/* ---- selection helpers used by the exported layer ---------------------- */

namespace {

void applySelectOp(uint32_t op, uint32_t idx, bool& touched) {
  if (op == 0) { M.vsel[idx] = 1; touched = true; }
  else if (op == 1) { M.vsel[idx] = 1; touched = true; }
  else if (op == 2) { M.vsel[idx] = 0; touched = true; }
  else { M.vsel[idx] = M.vsel[idx] ? 0 : 1; touched = true; }
}

float medianAxis(uint32_t axis) {
  double sum = 0.0;
  uint32_t n = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    sum += axis == 0 ? M.x[i] : (axis == 1 ? M.y[i] : M.z[i]);
    ++n;
  }
  return n ? static_cast<float>(sum / n) : 0.0f;
}

void pivotPoint(float& px, float& py, float& pz) {
  if (g_pivotMode == 1) { px = g_pivot[0]; py = g_pivot[1]; pz = g_pivot[2]; return; }
  double sx = 0.0, sy = 0.0, sz = 0.0;
  uint32_t n = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    sx += M.x[i]; sy += M.y[i]; sz += M.z[i];
    ++n;
  }
  if (n == 0) { px = py = pz = 0.0f; return; }
  px = static_cast<float>(sx / n);
  py = static_cast<float>(sy / n);
  pz = static_cast<float>(sz / n);
}

float snapValue(float v) {
  if (g_snapMode == 0 || g_snapIncrement <= 0.0f) return v;
  return floorf(v / g_snapIncrement + 0.5f) * g_snapIncrement;
}

bool axisAllows(uint32_t axis, uint32_t component) {
  if (axis == 0) return true;
  if (axis == 1) return component == 0;
  if (axis == 2) return component == 1;
  if (axis == 3) return component == 2;
  if (axis == 4) return component != 2;
  if (axis == 5) return component != 0;
  if (axis == 6) return component != 1;
  return true;
}

} // namespace

uint32_t selectByRay(const float* clip, float cx, float cy, int32_t* outIndex, uint32_t* outKind) {
  /* Depth buffer for the tap test so a click cannot select the back of a cube. */
  float zbuf[64 * 64];
  const uint32_t bw = 64, bh = 64;
  for (uint32_t i = 0; i < bw * bh; ++i) zbuf[i] = 1e30f;
  uint32_t triCount = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    float sx[3], sy[3], sz[3];
    bool ok = true;
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t v = M.tri[t * 3 + k];
      const float w = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
      if (w <= 1e-6f) { ok = false; break; }
      const float px = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / w;
      const float py = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / w;
      const float pz = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / w;
      sx[k] = (px * 0.5f + 0.5f) * static_cast<float>(bw);
      sy[k] = (1.0f - (py * 0.5f + 0.5f)) * static_cast<float>(bh);
      sz[k] = pz;
    }
    if (!ok) continue;
    const float minX = minf(sx[0], minf(sx[1], sx[2]));
    const float maxX = maxf(sx[0], maxf(sx[1], sx[2]));
    const float minY = minf(sy[0], minf(sy[1], sy[2]));
    const float maxY = maxf(sy[0], maxf(sy[1], sy[2]));
    const int32_t x0 = static_cast<int32_t>(maxf(0.0f, minX)), x1 = static_cast<int32_t>(minf(static_cast<float>(bw - 1), maxX));
    const int32_t y0 = static_cast<int32_t>(maxf(0.0f, minY)), y1 = static_cast<int32_t>(minf(static_cast<float>(bh - 1), maxY));
    if (x1 < x0 || y1 < y0) continue;
    const float area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    if (absf(area) < 1e-9f) continue;
    ++triCount;
    for (int32_t y = y0; y <= y1; ++y) {
      for (int32_t x = x0; x <= x1; ++x) {
        const float px = static_cast<float>(x) + 0.5f;
        const float py = static_cast<float>(y) + 0.5f;
        float w0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
        float w1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
        float w2 = 1.0f - w0 - w1;
        if (w0 < -0.001f || w1 < -0.001f || w2 < -0.001f) continue;
        const float z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
        const uint32_t i = static_cast<uint32_t>(y) * bw + static_cast<uint32_t>(x);
        if (z < zbuf[i]) zbuf[i] = z;
      }
    }
  }
  if (triCount == 0) {
    *outIndex = -1;
    *outKind = g_mode;
    return 0;
  }

  const float ndcX = cx * 2.0f - 1.0f;
  const float ndcY = 1.0f - cy * 2.0f;
  int32_t best = -1;
  uint32_t bestKind = g_mode;
  float bestDist = 1e30f;
  float bestDepth = 1e30f;

  /* convert NDC -> buffer coords for the occlusion test */
  const uint32_t bx = static_cast<uint32_t>(clampf((ndcX * 0.5f + 0.5f) * static_cast<float>(bw), 0.0f, static_cast<float>(bw - 1)));
  const uint32_t by = static_cast<uint32_t>(clampf(((1.0f - ndcY) * 0.5f) * static_cast<float>(bh), 0.0f, static_cast<float>(bh - 1)));
  const float depthLimit = zbuf[by * bw + bx] + 0.02f;

  for (uint32_t v = 0; v < M.nv; ++v) {
    const float w = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
    if (w <= 1e-6f) continue;
    const float px = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / w;
    const float py = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / w;
    const float pz = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / w;
    if (pz > depthLimit) continue;
    const float dx = px - ndcX, dy = py - ndcY;
    const float d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = static_cast<int32_t>(v); bestKind = kModeVertex; bestDepth = pz; }
  }

  if (g_mode == kModeEdge) {
    for (uint32_t e = 0; e < E.n; ++e) {
      const uint32_t a = E.a[e], b = E.b[e];
      float ax, ay, bx2, by2, az, bz2;
      const float wa = clip[3] * M.x[a] + clip[7] * M.y[a] + clip[11] * M.z[a] + clip[15];
      const float wb = clip[3] * M.x[b] + clip[7] * M.y[b] + clip[11] * M.z[b] + clip[15];
      if (wa <= 1e-6f || wb <= 1e-6f) continue;
      ax = (clip[0] * M.x[a] + clip[4] * M.y[a] + clip[8] * M.z[a] + clip[12]) / wa;
      ay = (clip[1] * M.x[a] + clip[5] * M.y[a] + clip[9] * M.z[a] + clip[13]) / wa;
      az = (clip[2] * M.x[a] + clip[6] * M.y[a] + clip[10] * M.z[a] + clip[14]) / wa;
      bx2 = (clip[0] * M.x[b] + clip[4] * M.y[b] + clip[8] * M.z[b] + clip[12]) / wb;
      by2 = (clip[1] * M.x[b] + clip[5] * M.y[b] + clip[9] * M.z[b] + clip[13]) / wb;
      bz2 = (clip[2] * M.x[b] + clip[6] * M.y[b] + clip[10] * M.z[b] + clip[14]) / wb;
      const float vx = bx2 - ax, vy = by2 - ay;
      const float len2 = vx * vx + vy * vy;
      if (len2 < 1e-12f) continue;
      float t = ((ndcX - ax) * vx + (ndcY - ay) * vy) / len2;
      t = clampf(t, 0.0f, 1.0f);
      const float qx = ax + vx * t, qy = ay + vy * t;
      const float dx = qx - ndcX, dy = qy - ndcY;
      const float d = dx * dx + dy * dy;
      const float z = az + (bz2 - az) * t;
      if (z > depthLimit) continue;
      if (d < bestDist * 0.8f) { bestDist = d; best = static_cast<int32_t>(e); bestKind = kModeEdge; bestDepth = z; }
    }
  }

  if (g_mode == kModeFace) {
    for (uint32_t t = 0; t < M.nt; ++t) {
      float sx[3], sy[3], sz[3];
      bool ok = true;
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v = M.tri[t * 3 + k];
        const float ww = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
        if (ww <= 1e-6f) { ok = false; break; }
        sx[k] = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / ww;
        sy[k] = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / ww;
        sz[k] = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / ww;
      }
      if (!ok) continue;
      const float area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
      if (absf(area) < 1e-12f) continue;
      float w0 = ((sx[1] - ndcX) * (sy[2] - ndcY) - (sx[2] - ndcX) * (sy[1] - ndcY)) / area;
      float w1 = ((sx[2] - ndcX) * (sy[0] - ndcY) - (sx[0] - ndcX) * (sy[2] - ndcY)) / area;
      float w2 = 1.0f - w0 - w1;
      if (w0 < 0.0f || w1 < 0.0f || w2 < 0.0f) continue;
      const float z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
      if (z > depthLimit) continue;
      bestDist = 0.0f; best = static_cast<int32_t>(t); bestKind = kModeFace; bestDepth = z;
    }
  }

  (void)bestDepth;
  *outIndex = best;
  *outKind = bestKind;
  return best >= 0 ? 1u : 0u;
}

uint32_t selectRegion(const float* clip, float minX, float minY, float maxX, float maxY,
                      float cx, float cy, float radius, uint32_t circle, uint32_t op, uint32_t xray,
                      float aspect) {
  /* The screen-space selectors take *normalised* coordinates: (0,0) is the
     top-left of the viewport and (1,1) the bottom-right, which is exactly what
     a pointer event hands to JS. fe_edit_pick already worked that way, but the
     box and circle paths compared those numbers against NDC (-1..1), so a drag
     across the whole screen only ever reached the upper-right quadrant. The
     conversion lives here, once, instead of in every caller. */
  const float ndcMinX = minX * 2.0f - 1.0f, ndcMaxX = maxX * 2.0f - 1.0f;
  const float ndcMinY = 1.0f - maxY * 2.0f, ndcMaxY = 1.0f - minY * 2.0f;
  const float ndcCx = cx * 2.0f - 1.0f, ndcCy = 1.0f - cy * 2.0f;
  const float rNdcX = radius * 2.0f;
  const float rNdcY = radius * 2.0f * (aspect > 0.01f ? aspect : 1.0f);
  const float invRx = rNdcX > 1e-6f ? 1.0f / rNdcX : 1e6f;
  const float invRy = rNdcY > 1e-6f ? 1.0f / rNdcY : 1e6f;
  float zbuf[96 * 96];
  const uint32_t bw = 96, bh = 96;
  for (uint32_t i = 0; i < bw * bh; ++i) zbuf[i] = 1e30f;

  for (uint32_t t = 0; t < M.nt; ++t) {
    float sx[3], sy[3], sz[3];
    bool ok = true;
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t v = M.tri[t * 3 + k];
      const float w = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
      if (w <= 1e-6f) { ok = false; break; }
      const float px = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / w;
      const float py = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / w;
      const float pz = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / w;
      sx[k] = (px * 0.5f + 0.5f) * static_cast<float>(bw);
      sy[k] = (1.0f - (py * 0.5f + 0.5f)) * static_cast<float>(bh);
      sz[k] = pz;
    }
    if (!ok) continue;
    const float minPX = minf(sx[0], minf(sx[1], sx[2]));
    const float maxPX = maxf(sx[0], maxf(sx[1], sx[2]));
    const float minPY = minf(sy[0], minf(sy[1], sy[2]));
    const float maxPY = maxf(sy[0], maxf(sy[1], sy[2]));
    const int32_t x0 = static_cast<int32_t>(maxf(0.0f, minPX)), x1 = static_cast<int32_t>(minf(static_cast<float>(bw - 1), maxPX));
    const int32_t y0 = static_cast<int32_t>(maxf(0.0f, minPY)), y1 = static_cast<int32_t>(minf(static_cast<float>(bh - 1), maxPY));
    if (x1 < x0 || y1 < y0) continue;
    const float area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    if (absf(area) < 1e-12f) continue;
    for (int32_t y = y0; y <= y1; ++y) {
      for (int32_t x = x0; x <= x1; ++x) {
        const float px = static_cast<float>(x) + 0.5f;
        const float py = static_cast<float>(y) + 0.5f;
        const float w0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
        const float w1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
        const float w2 = 1.0f - w0 - w1;
        if (w0 < -0.001f || w1 < -0.001f || w2 < -0.001f) continue;
        const float z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
        const uint32_t i = static_cast<uint32_t>(y) * bw + static_cast<uint32_t>(x);
        if (z < zbuf[i]) zbuf[i] = z;
      }
    }
  }

  uint32_t touchedCount = 0;
  for (uint32_t v = 0; v < M.nv; ++v) {
    const float w = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
    if (w <= 1e-6f) continue;
    const float px = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / w;
    const float py = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / w;
    const float pz = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / w;

    bool inside = false;
    if (circle) {
      const float dx = (px - ndcCx) * invRx, dy = (py - ndcCy) * invRy;
      inside = (dx * dx + dy * dy) <= 1.0f;
    } else {
      inside = px >= ndcMinX && px <= ndcMaxX && py >= ndcMinY && py <= ndcMaxY;
    }
    if (!inside) continue;

    if (!xray) {
      const uint32_t bx = static_cast<uint32_t>(clampf((px * 0.5f + 0.5f) * static_cast<float>(bw), 0.0f, static_cast<float>(bw - 1)));
      const uint32_t by = static_cast<uint32_t>(clampf(((1.0f - (py * 0.5f + 0.5f))) * static_cast<float>(bh), 0.0f, static_cast<float>(bh - 1)));
      if (pz > zbuf[by * bw + bx] + 0.02f) continue;
    }

    if (g_mode == kModeVertex) {
      if (op == 2) M.vsel[v] = 0;
      else if (op == 3) M.vsel[v] = M.vsel[v] ? 0 : 1;
      else M.vsel[v] = 1;
      ++touchedCount;
    } else if (g_mode == kModeFace) {
      continue; /* handled below so a face needs all three corners */
    } else {
      continue;
    }
  }

  if (g_mode == kModeEdge) {
    for (uint32_t e = 0; e < E.n; ++e) {
      const uint32_t a = E.a[e], b = E.b[e];
      const float wa = clip[3] * M.x[a] + clip[7] * M.y[a] + clip[11] * M.z[a] + clip[15];
      const float wb = clip[3] * M.x[b] + clip[7] * M.y[b] + clip[11] * M.z[b] + clip[15];
      if (wa <= 1e-6f || wb <= 1e-6f) continue;
      const float ax = (clip[0] * M.x[a] + clip[4] * M.y[a] + clip[8] * M.z[a] + clip[12]) / wa;
      const float ay = (clip[1] * M.x[a] + clip[5] * M.y[a] + clip[9] * M.z[a] + clip[13]) / wa;
      const float az = (clip[2] * M.x[a] + clip[6] * M.y[a] + clip[10] * M.z[a] + clip[14]) / wa;
      const float bx2 = (clip[0] * M.x[b] + clip[4] * M.y[b] + clip[8] * M.z[b] + clip[12]) / wb;
      const float by2 = (clip[1] * M.x[b] + clip[5] * M.y[b] + clip[9] * M.z[b] + clip[13]) / wb;
      const float bz2 = (clip[2] * M.x[b] + clip[6] * M.y[b] + clip[10] * M.z[b] + clip[14]) / wb;
      bool hitA, hitB;
      if (circle) {
        const float adx = (ax - ndcCx) * invRx, ady = (ay - ndcCy) * invRy;
        const float bdx = (bx2 - ndcCx) * invRx, bdy = (by2 - ndcCy) * invRy;
        hitA = (adx * adx + ady * ady) <= 1.0f;
        hitB = (bdx * bdx + bdy * bdy) <= 1.0f;
      } else {
        hitA = ax >= ndcMinX && ax <= ndcMaxX && ay >= ndcMinY && ay <= ndcMaxY;
        hitB = bx2 >= ndcMinX && bx2 <= ndcMaxX && by2 >= ndcMinY && by2 <= ndcMaxY;
      }
      if (!(hitA && hitB)) continue;
      if (!xray) {
        const float mz = (az + bz2) * 0.5f;
        const float mx = (ax + bx2) * 0.5f, my = (ay + by2) * 0.5f;
        const uint32_t bx3 = static_cast<uint32_t>(clampf((mx * 0.5f + 0.5f) * static_cast<float>(bw), 0.0f, static_cast<float>(bw - 1)));
        const uint32_t by3 = static_cast<uint32_t>(clampf((1.0f - (my * 0.5f + 0.5f)) * static_cast<float>(bh), 0.0f, static_cast<float>(bh - 1)));
        if (mz > zbuf[by3 * bw + bx3] + 0.02f) continue;
      }
      if (op == 2) { M.vsel[a] = 0; M.vsel[b] = 0; }
      else if (op == 3) {
        const uint8_t next = (M.vsel[a] && M.vsel[b]) ? 0 : 1;
        M.vsel[a] = next; M.vsel[b] = next;
      } else { M.vsel[a] = 1; M.vsel[b] = 1; }
      ++touchedCount;
    }
  }

  if (g_mode == kModeFace) {
    for (uint32_t t = 0; t < M.nt; ++t) {
      bool all = true;
      float mz = 0.0f, mx = 0.0f, my = 0.0f;
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v = M.tri[t * 3 + k];
        const float w = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
        if (w <= 1e-6f) { all = false; break; }
        const float px = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / w;
        const float py = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / w;
        const float pz = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / w;
        bool inside;
        if (circle) {
          const float dx = (px - ndcCx) * invRx, dy = (py - ndcCy) * invRy;
          inside = (dx * dx + dy * dy) <= 1.0f;
        } else {
          inside = px >= ndcMinX && px <= ndcMaxX && py >= ndcMinY && py <= ndcMaxY;
        }
        if (!inside) { all = false; break; }
        mx += px; my += py; mz += pz;
      }
      if (!all) continue;
      mx /= 3.0f; my /= 3.0f; mz /= 3.0f;
      if (!xray) {
        const uint32_t bx = static_cast<uint32_t>(clampf((mx * 0.5f + 0.5f) * static_cast<float>(bw), 0.0f, static_cast<float>(bw - 1)));
        const uint32_t by = static_cast<uint32_t>(clampf((1.0f - (my * 0.5f + 0.5f)) * static_cast<float>(bh), 0.0f, static_cast<float>(bh - 1)));
        if (mz > zbuf[by * bw + bx] + 0.02f) continue;
      }
      if (op == 2) deselectFaceVerts(t);
      else if (op == 3 && faceSelected(t)) deselectFaceVerts(t);
      else selectFaceVerts(t);
      ++touchedCount;
    }
  }

  (void)touchedCount;
  syncSelFromVerts();
  return selectedVertCount();
}

} // namespace fe_edit

using namespace fe_edit;

extern "C" {

/* ---- lifecycle --------------------------------------------------------- */

FE_EXPORT void fe_edit_reset(void) {
  M.nv = 0;
  M.nt = 0;
  M.hasColor = false;
  M.smooth = true;
  E.n = 0;
  g_seams.n = 0;
  g_sharp.n = 0;
  g_mode = kModeVertex;
  g_propEnabled = false;
  g_propConnected = true;
  g_propRadius = 1.0f;
  g_propFalloff = kFallSmooth;
  g_pivotMode = 0;
  g_snapMode = 0;
  g_snapIncrement = 0.1f;
  clipClear();
  undoClear();
  g_outVerts = 0;
  g_outIdxCount = 0;
  g_outSplit = 0;
}

FE_EXPORT uint32_t fe_edit_upload(uint32_t vertCount, const float* positions,
                                  uint32_t triCount, const uint32_t* indices,
                                  const float* colors) {
  if (!positions || !indices) return 0;
  if (vertCount > kMaxVerts || triCount > kMaxTris) return 0;
  if (vertCount < 3 || triCount < 1) return 0;
  fe_edit_reset();
  M.nv = vertCount;
  M.nt = triCount;
  M.hasColor = colors != nullptr;
  for (uint32_t i = 0; i < vertCount; ++i) {
    M.x[i] = positions[i * 3];
    M.y[i] = positions[i * 3 + 1];
    M.z[i] = positions[i * 3 + 2];
    M.vsel[i] = 0;
    if (M.hasColor) {
      M.cr[i] = colors[i * 3];
      M.cg[i] = colors[i * 3 + 1];
      M.cb[i] = colors[i * 3 + 2];
    } else {
      M.cr[i] = M.cg[i] = M.cb[i] = 1.0f;
    }
  }
  for (uint32_t i = 0; i < triCount * 3u; ++i) {
    const uint32_t v = indices[i];
    M.tri[i] = v < vertCount ? v : 0;
  }
  for (uint32_t t = 0; t < M.nt; ++t) M.fsel[t] = 0;
  rebuildEdges();
  syncSelFromVerts();
  return 1;
}

FE_EXPORT uint32_t fe_edit_vert_count(void) { return M.nv; }
FE_EXPORT uint32_t fe_edit_tri_count(void) { return M.nt; }
FE_EXPORT uint32_t fe_edit_edge_count(void) { return E.n; }
FE_EXPORT uint32_t fe_edit_max_verts(void) { return kMaxVerts; }
FE_EXPORT uint32_t fe_edit_has_color(void) { return M.hasColor ? 1u : 0u; }

FE_EXPORT const float* fe_edit_pos_ptr(void) { return M.x; }
FE_EXPORT const uint32_t* fe_edit_idx_ptr(void) { return M.tri; }
FE_EXPORT const uint8_t* fe_edit_vert_sel_ptr(void) { return M.vsel; }
FE_EXPORT const uint32_t* fe_edit_edge_ptr(void) { return E.a; }
/* The edge table is struct-of-arrays. The overlay needs both endpoints and the
   two faces of every edge (face mode outlines the edge loop a tap lands in), so
   each array gets its own pointer instead of one packed copy that would have to
   be rebuilt on every read. */
FE_EXPORT const uint32_t* fe_edit_edge_b_ptr(void) { return E.b; }
FE_EXPORT const uint32_t* fe_edit_edge_face_ptr(void) { return E.f0; }
FE_EXPORT const uint8_t* fe_edit_edge_sel_ptr(void) { return E.sel; }
FE_EXPORT const uint8_t* fe_edit_face_sel_ptr(void) { return M.fsel; }

/* Positions are stored as three separate arrays; the exporter of the kernel
   gives JS one interleaved buffer so it does not have to stitch them. */
FE_EXPORT const float* fe_edit_pos_interleaved_ptr(void) {
  static float interleaved[kMaxVerts * 3];
  for (uint32_t i = 0; i < M.nv; ++i) {
    interleaved[i * 3] = M.x[i];
    interleaved[i * 3 + 1] = M.y[i];
    interleaved[i * 3 + 2] = M.z[i];
  }
  return interleaved;
}

/* Same idea for the per-vertex colours, so leaving Edit Mode can put the edit
   mesh (not the split render mesh) back into the object with its paint intact. */
FE_EXPORT const float* fe_edit_color_interleaved_ptr(void) {
  static float interleaved[kMaxVerts * 3];
  for (uint32_t i = 0; i < M.nv; ++i) {
    interleaved[i * 3] = M.cr[i];
    interleaved[i * 3 + 1] = M.cg[i];
    interleaved[i * 3 + 2] = M.cb[i];
  }
  return interleaved;
}

/* ---- selection --------------------------------------------------------- */

FE_EXPORT void fe_edit_set_mode(uint32_t mode) { g_mode = mode > 2u ? 0u : mode; }
FE_EXPORT uint32_t fe_edit_get_mode(void) { return g_mode; }

FE_EXPORT void fe_edit_select_all(void) {
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 1;
  syncSelFromVerts();
}

FE_EXPORT void fe_edit_select_none(void) {
  clearSelection();
}

FE_EXPORT void fe_edit_select_invert(void) {
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = M.vsel[i] ? 0 : 1;
  syncSelFromVerts();
}

FE_EXPORT uint32_t fe_edit_sel_count(void) {
  if (g_mode == kModeEdge) return selectedEdgeCount();
  if (g_mode == kModeFace) return selectedFaceCount();
  return selectedVertCount();
}

FE_EXPORT void fe_edit_select_by_index(uint32_t kind, uint32_t count, const uint32_t* indices, uint32_t op) {
  if (!indices) return;
  for (uint32_t i = 0; i < count; ++i) {
    const uint32_t idx = indices[i];
    bool touched = false;
    if (kind == 0) {
      if (idx < M.nv) applySelectOp(op, idx, touched);
    } else if (kind == 1) {
      if (idx < E.n) {
        if (op == 2) {
          M.vsel[E.a[idx]] = 0;
          M.vsel[E.b[idx]] = 0;
        } else {
          M.vsel[E.a[idx]] = 1;
          M.vsel[E.b[idx]] = 1;
        }
      }
    } else {
      if (idx < M.nt) {
        if (op == 2) deselectFaceVerts(idx);
        else selectFaceVerts(idx);
      }
    }
  }
  syncSelFromVerts();
}

FE_EXPORT uint32_t fe_edit_select_linked(uint32_t delimitSeam) {
  /* Flood through shared vertices, optionally stopping at a seam. */
  static uint8_t visited[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) visited[i] = 0;
  buildVertexAdjacency();
  static uint32_t queue[kMaxVerts];
  uint32_t head = 0, tail = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    visited[i] = 1;
    queue[tail++] = i;
  }
  if (tail == 0) return 0;
  while (head < tail) {
    const uint32_t v = queue[head++];
    for (uint32_t k = g_adjStart[v]; k < g_adjStart[v + 1]; ++k) {
      const uint32_t n = g_adjList[k];
      if (visited[n]) continue;
      if (delimitSeam && pairGet(g_seams, v, n, nullptr)) continue;
      visited[n] = 1;
      queue[tail++] = n;
    }
  }
  for (uint32_t i = 0; i < M.nv; ++i) if (visited[i]) M.vsel[i] = 1;
  syncSelFromVerts();
  return selectedVertCount();
}

FE_EXPORT uint32_t fe_edit_select_more(void) {
  buildVertexAdjacency();
  static uint8_t add[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) add[i] = 0;
  for (uint32_t v = 0; v < M.nv; ++v) {
    if (!M.vsel[v]) continue;
    for (uint32_t k = g_adjStart[v]; k < g_adjStart[v + 1]; ++k) add[g_adjList[k]] = 1;
  }
  for (uint32_t i = 0; i < M.nv; ++i) if (add[i]) M.vsel[i] = 1;
  syncSelFromVerts();
  return selectedVertCount();
}

FE_EXPORT uint32_t fe_edit_select_less(void) {
  buildVertexAdjacency();
  static uint8_t drop[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) drop[i] = 0;
  for (uint32_t v = 0; v < M.nv; ++v) {
    if (!M.vsel[v]) continue;
    for (uint32_t k = g_adjStart[v]; k < g_adjStart[v + 1]; ++k) {
      if (!M.vsel[g_adjList[k]]) { drop[v] = 1; break; }
    }
  }
  for (uint32_t i = 0; i < M.nv; ++i) if (drop[i]) M.vsel[i] = 0;
  syncSelFromVerts();
  return selectedVertCount();
}

FE_EXPORT uint32_t fe_edit_select_similar(uint32_t kind, float threshold) {
  const float t = threshold <= 0.0f ? 0.25f : threshold;
  if (g_mode == kModeFace) {
    float rnx = 0.0f, rny = 0.0f, rnz = 0.0f, ra = 0.0f;
    uint32_t n = 0;
    for (uint32_t f = 0; f < M.nt; ++f) {
      if (!faceSelected(f)) continue;
      float nx, ny, nz, area;
      faceNormal(f, nx, ny, nz);
      triangleArea(f, area);
      rnx += nx; rny += ny; rnz += nz; ra += area;
      ++n;
    }
    if (!n) return 0;
    const float len = sqrtf(rnx * rnx + rny * rny + rnz * rnz);
    if (len > 1e-9f) { rnx /= len; rny /= len; rnz /= len; }
    ra /= static_cast<float>(n);
    for (uint32_t f = 0; f < M.nt; ++f) {
      float nx, ny, nz, area;
      faceNormal(f, nx, ny, nz);
      triangleArea(f, area);
      bool match = false;
      if (kind == 0) match = (nx * rnx + ny * rny + nz * rnz) >= (1.0f - t);
      else if (kind == 1) match = (ra > 0.0f) && (absf(area - ra) / ra) <= t;
      else match = faceSelected(f);
      if (match) selectFaceVerts(f);
    }
  } else if (g_mode == kModeEdge) {
    float total = 0.0f;
    uint32_t n = 0;
    for (uint32_t e = 0; e < E.n; ++e) {
      if (!edgeSelected(e)) continue;
      total += dist3(E.a[e], E.b[e]);
      ++n;
    }
    if (!n) return 0;
    const float mean = total / static_cast<float>(n);
    for (uint32_t e = 0; e < E.n; ++e) {
      const float len = dist3(E.a[e], E.b[e]);
      if (mean > 0.0f && absf(len - mean) / mean <= t) {
        M.vsel[E.a[e]] = 1;
        M.vsel[E.b[e]] = 1;
      }
    }
  } else {
    buildVertexFaces();
    float rnx = 0.0f, rny = 0.0f, rnz = 0.0f;
    uint32_t n = 0;
    for (uint32_t v = 0; v < M.nv; ++v) {
      if (!M.vsel[v]) continue;
      for (uint32_t k = g_faceStart[v]; k < g_faceStart[v + 1]; ++k) {
        float nx, ny, nz;
        faceNormal(g_faceList[k], nx, ny, nz);
        rnx += nx; rny += ny; rnz += nz;
        ++n;
      }
    }
    if (!n) return 0;
    const float len = sqrtf(rnx * rnx + rny * rny + rnz * rnz);
    if (len > 1e-9f) { rnx /= len; rny /= len; rnz /= len; }
    for (uint32_t v = 0; v < M.nv; ++v) {
      float ax = 0.0f, ay = 0.0f, az = 0.0f;
      for (uint32_t k = g_faceStart[v]; k < g_faceStart[v + 1]; ++k) {
        float nx, ny, nz;
        faceNormal(g_faceList[k], nx, ny, nz);
        ax += nx; ay += ny; az += nz;
      }
      const float l2 = sqrtf(ax * ax + ay * ay + az * az);
      if (l2 < 1e-9f) continue;
      if ((ax * rnx + ay * rny + az * rnz) / l2 >= (1.0f - t)) M.vsel[v] = 1;
    }
  }
  syncSelFromVerts();
  return fe_edit_sel_count();
}

FE_EXPORT uint32_t fe_edit_select_random(float percent, uint32_t seed) {
  if (percent <= 0.0f) return 0;
  if (percent > 100.0f) percent = 100.0f;
  uint32_t state = seed ? seed : 0x9E3779B9u;
  for (uint32_t i = 0; i < M.nv; ++i) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    const float r = static_cast<float>(state & 0xFFFFFFu) / 16777215.0f;
    M.vsel[i] = r * 100.0f < percent ? 1 : 0;
  }
  syncSelFromVerts();
  return selectedVertCount();
}

FE_EXPORT uint32_t fe_edit_select_box(const float* clip, float x0, float y0, float x1, float y1,
                                      uint32_t op, uint32_t xray) {
  if (!clip) return 0;
  const float minX = minf(x0, x1), maxX = maxf(x0, x1);
  const float minY = minf(y0, y1), maxY = maxf(y0, y1);
  if (op == 0) clearSelection();
  return selectRegion(clip, minX, minY, maxX, maxY, 0.0f, 0.0f, 0.0f, 0, op, xray, 1.0f);
}

/* `aspect` is viewport width / height. The hit test rasterises NDC as a square,
   so without it a circle dragged on a portrait phone would select an ellipse. */
FE_EXPORT uint32_t fe_edit_select_circle(const float* clip, float cx, float cy, float radius,
                                         uint32_t op, uint32_t xray, float aspect) {
  if (!clip) return 0;
  if (op == 0) clearSelection();
  return selectRegion(clip, 0.0f, 0.0f, 0.0f, 0.0f, cx, cy, radius, 1, op, xray, aspect);
}

FE_EXPORT int32_t fe_edit_pick(const float* clip, float cx, float cy) {
  if (!clip) return -1;
  int32_t index = -1;
  uint32_t kind = g_mode;
  selectByRay(clip, cx, cy, &index, &kind);
  return index;
}

/* ---- tool parameters --------------------------------------------------- */

FE_EXPORT void fe_edit_set_proportional(uint32_t enabled, uint32_t falloff, float radius, uint32_t connected) {
  g_propEnabled = enabled != 0;
  g_propFalloff = falloff > 5u ? kFallSmooth : falloff;
  g_propRadius = radius;
  g_propConnected = connected != 0;
}

FE_EXPORT void fe_edit_set_pivot(uint32_t mode, float x, float y, float z) {
  g_pivotMode = mode > 2u ? 0u : mode;
  g_pivot[0] = x; g_pivot[1] = y; g_pivot[2] = z;
}

FE_EXPORT void fe_edit_set_snap(uint32_t mode, float increment) {
  g_snapMode = mode > 3u ? 0u : mode;
  g_snapIncrement = increment;
}

/* ---- transforms -------------------------------------------------------- */

FE_EXPORT uint32_t fe_edit_move(float dx, float dy, float dz, uint32_t axis) {
  computeWeights();
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    if (axisAllows(axis, 0)) M.x[i] = snapValue(M.x[i] + dx * w);
    if (axisAllows(axis, 1)) M.y[i] = snapValue(M.y[i] + dy * w);
    if (axisAllows(axis, 2)) M.z[i] = snapValue(M.z[i] + dz * w);
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_rotate(float angleDeg, uint32_t axis) {
  computeWeights();
  float px, py, pz;
  pivotPoint(px, py, pz);
  const float a = angleDeg * fe::kDeg2Rad;
  const float s = sinf(a), c = cosf(a);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    const float ang = a * w;
    const float si = sinf(ang), co = cosf(ang);
    (void)s; (void)c;
    const float vx = M.x[i] - px, vy = M.y[i] - py, vz = M.z[i] - pz;
    float rx = vx, ry = vy, rz = vz;
    if (axis == 0 || axis == 3) { rx = vx * co - vy * si; ry = vx * si + vy * co; }
    else if (axis == 1) { ry = vy * co - vz * si; rz = vy * si + vz * co; }
    else if (axis == 2) { rz = vz * co - vx * si; rx = vz * si + vx * co; }
    M.x[i] = px + rx; M.y[i] = py + ry; M.z[i] = pz + rz;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_scale(float sx, float sy, float sz, uint32_t axis) {
  computeWeights();
  float px, py, pz;
  pivotPoint(px, py, pz);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    const float fx = axisAllows(axis, 0) ? 1.0f + (sx - 1.0f) * w : 1.0f;
    const float fy = axisAllows(axis, 1) ? 1.0f + (sy - 1.0f) * w : 1.0f;
    const float fz = axisAllows(axis, 2) ? 1.0f + (sz - 1.0f) * w : 1.0f;
    M.x[i] = px + (M.x[i] - px) * fx;
    M.y[i] = py + (M.y[i] - py) * fy;
    M.z[i] = pz + (M.z[i] - pz) * fz;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_shrink_fatten(float amount) {
  computeWeights();
  static float nx[kMaxVerts], ny[kMaxVerts], nz[kMaxVerts];
  vertexNormals(nx, ny, nz);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    M.x[i] += nx[i] * amount * w;
    M.y[i] += ny[i] * amount * w;
    M.z[i] += nz[i] * amount * w;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_shear(float amount, uint32_t axis, uint32_t direction) {
  computeWeights();
  float px, py, pz;
  pivotPoint(px, py, pz);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    if (axis == 0) {
      const float ref = direction == 1 ? (M.y[i] - py) : (M.z[i] - pz);
      M.x[i] += amount * ref * w;
    } else if (axis == 1) {
      const float ref = direction == 0 ? (M.x[i] - px) : (M.z[i] - pz);
      M.y[i] += amount * ref * w;
    } else {
      const float ref = direction == 0 ? (M.x[i] - px) : (M.y[i] - py);
      M.z[i] += amount * ref * w;
    }
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_to_sphere(float factor) {
  computeWeights();
  float px, py, pz;
  pivotPoint(px, py, pz);
  float maxR = 0.0f;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    const float dx = M.x[i] - px, dy = M.y[i] - py, dz = M.z[i] - pz;
    const float r = sqrtf(dx * dx + dy * dy + dz * dz);
    if (r > maxR) maxR = r;
  }
  if (maxR <= 0.0f) return 0;
  const float f = clampf(factor, -1.0f, 1.0f);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    float dx = M.x[i] - px, dy = M.y[i] - py, dz = M.z[i] - pz;
    const float r = sqrtf(dx * dx + dy * dy + dz * dz);
    if (r < 1e-6f) continue;
    const float target = fe::lerpf(r, maxR, f * w);
    const float k = target / r;
    M.x[i] = px + dx * k;
    M.y[i] = py + dy * k;
    M.z[i] = pz + dz * k;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_bend(float angleDeg, uint32_t axis) {
  computeWeights();
  float px, py, pz;
  pivotPoint(px, py, pz);
  /* Bend around `axis` proportional to the distance along the next axis. */
  float minC = 1e30f, maxC = -1e30f;
  const uint32_t coord = (axis + 1) % 3;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    const float c = coord == 0 ? M.x[i] : (coord == 1 ? M.y[i] : M.z[i]);
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  const float span = maxC - minC;
  if (span <= 1e-6f) return 0;
  const float a = angleDeg * fe::kDeg2Rad;
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    const float c = coord == 0 ? M.x[i] : (coord == 1 ? M.y[i] : M.z[i]);
    const float t = (c - minC) / span - 0.5f;
    const float ang = a * t * w;
    const float si = sinf(ang), co = cosf(ang);
    const float vx = M.x[i] - px, vy = M.y[i] - py, vz = M.z[i] - pz;
    float rx = vx, ry = vy, rz = vz;
    if (axis == 0) { rx = vx * co - vy * si; ry = vx * si + vy * co; }
    else if (axis == 1) { ry = vy * co - vz * si; rz = vy * si + vz * co; }
    else { rz = vz * co - vx * si; rx = vz * si + vx * co; }
    M.x[i] = px + rx; M.y[i] = py + ry; M.z[i] = pz + rz;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_randomize(float amount, uint32_t seed) {
  computeWeights();
  uint32_t state = seed ? seed : 0x1234567u;
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    float r[3];
    for (uint32_t k = 0; k < 3; ++k) {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      r[k] = (static_cast<float>(state & 0xFFFFu) / 65535.0f) * 2.0f - 1.0f;
    }
    M.x[i] += r[0] * amount * w;
    M.y[i] += r[1] * amount * w;
    M.z[i] += r[2] * amount * w;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_align(uint32_t axis) {
  if (selectedVertCount() < 2) return 0;
  const float target = medianAxis(axis);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    if (axis == 0) M.x[i] = target;
    else if (axis == 1) M.y[i] = target;
    else M.z[i] = target;
    ++moved;
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_mirror(uint32_t axis, uint32_t merge) {
  float px, py, pz;
  pivotPoint(px, py, pz);
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    if (axis == 0) M.x[i] = 2.0f * px - M.x[i];
    else if (axis == 1) M.y[i] = 2.0f * py - M.y[i];
    else M.z[i] = 2.0f * pz - M.z[i];
    ++moved;
  }
  if (merge) {
    /* Weld vertices that landed on top of an existing one. */
    for (uint32_t i = 0; i < M.nv; ++i) {
      if (!M.vsel[i]) continue;
      for (uint32_t j = 0; j < M.nv; ++j) {
        if (j == i) continue;
        if (dist3(i, j) < 1e-4f) { g_vertMap[i] = j; break; }
      }
    }
    for (uint32_t t = 0; t < M.nt; ++t) {
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v = M.tri[t * 3 + k];
        if (M.vsel[v] && g_vertMap[v] != 0xFFFFFFFFu) M.tri[t * 3 + k] = g_vertMap[v];
      }
    }
    for (uint32_t i = 0; i < M.nv; ++i) g_vertMap[i] = 0xFFFFFFFFu;
    compactMesh(false);
  }
  return moved;
}

FE_EXPORT uint32_t fe_edit_slide(float amount) {
  computeWeights();
  buildVertexAdjacency();
  static float tx[kMaxVerts], ty[kMaxVerts], tz[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) {
    tx[i] = M.x[i]; ty[i] = M.y[i]; tz[i] = M.z[i];
    const uint32_t start = g_adjStart[i], end = g_adjStart[i + 1];
    if (end <= start) continue;
    float sx = 0.0f, sy = 0.0f, sz = 0.0f;
    for (uint32_t k = start; k < end; ++k) {
      const uint32_t n = g_adjList[k];
      sx += M.x[n]; sy += M.y[n]; sz += M.z[n];
    }
    const float inv = 1.0f / static_cast<float>(end - start);
    tx[i] = sx * inv; ty[i] = sy * inv; tz[i] = sz * inv;
  }
  uint32_t moved = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const float w = M.weight[i];
    if (w <= 0.0f) continue;
    const float k = clampf(amount, -1.0f, 1.0f) * w;
    M.x[i] += (tx[i] - M.x[i]) * k;
    M.y[i] += (ty[i] - M.y[i]) * k;
    M.z[i] += (tz[i] - M.z[i]) * k;
    ++moved;
  }
  return moved;
}

/* ---- flags ------------------------------------------------------------- */

FE_EXPORT void fe_edit_set_shade(uint32_t smooth) { M.smooth = smooth != 0; }
FE_EXPORT uint32_t fe_edit_get_shade(void) { return M.smooth ? 1u : 0u; }

FE_EXPORT uint32_t fe_edit_mark_sharp(uint32_t on) {
  uint32_t count = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeSelected(e)) continue;
    pairSet(g_sharp, E.a[e], E.b[e], on != 0, 1.0f);
    ++count;
  }
  return count;
}

FE_EXPORT uint32_t fe_edit_mark_seam(uint32_t on) {
  uint32_t count = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeSelected(e)) continue;
    pairSet(g_seams, E.a[e], E.b[e], on != 0, 1.0f);
    ++count;
  }
  return count;
}

FE_EXPORT uint32_t fe_edit_sharp_count(void) { return g_sharp.n; }
FE_EXPORT uint32_t fe_edit_seam_count(void) { return g_seams.n; }

FE_EXPORT uint32_t fe_edit_recalc_normals(uint32_t outside) {
  /* Make winding consistent across every connected component, then flip a
     component if its signed volume points inwards. */
  uint32_t flipped = 0;
  static uint8_t visited[kMaxTris];
  for (uint32_t t = 0; t < M.nt; ++t) visited[t] = 0;
  rebuildEdges();

  for (uint32_t seed = 0; seed < M.nt; ++seed) {
    if (visited[seed]) continue;
    static uint32_t stack[kMaxTris];
    uint32_t top = 0;
    stack[top++] = seed;
    visited[seed] = 1;
    double volume = 0.0;
    while (top > 0) {
      const uint32_t t = stack[--top];
      const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
      volume += (static_cast<double>(M.x[a]) * (static_cast<double>(M.y[b]) * M.z[c] - static_cast<double>(M.z[b]) * M.y[c]) -
                 static_cast<double>(M.y[a]) * (static_cast<double>(M.x[b]) * M.z[c] - static_cast<double>(M.z[b]) * M.x[c]) +
                 static_cast<double>(M.z[a]) * (static_cast<double>(M.x[b]) * M.y[c] - static_cast<double>(M.y[b]) * M.x[c])) / 6.0;
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v0 = M.tri[t * 3 + k];
        const uint32_t v1 = M.tri[t * 3 + (k + 1) % 3];
        const uint32_t e = findEdge(v0, v1);
        if (e >= E.n) continue;
        const uint32_t other = E.f0[e] == t ? E.f1[e] : E.f0[e];
        if (other == 0xFFFFFFFFu || other >= M.nt || visited[other]) continue;
        /* neighbour must traverse this edge in the opposite direction */
        bool sameDirection = false;
        for (uint32_t q = 0; q < 3; ++q) {
          if (M.tri[other * 3 + q] == v0 && M.tri[other * 3 + (q + 1) % 3] == v1) sameDirection = true;
        }
        if (sameDirection) {
          const uint32_t tmp = M.tri[other * 3 + 1];
          M.tri[other * 3 + 1] = M.tri[other * 3 + 2];
          M.tri[other * 3 + 2] = tmp;
          ++flipped;
        }
        visited[other] = 1;
        stack[top++] = other;
      }
    }
    if (outside && volume < 0.0) {
      for (uint32_t t = 0; t < M.nt; ++t) {
        if (!visited[t]) continue;
        const uint32_t tmp = M.tri[t * 3 + 1];
        M.tri[t * 3 + 1] = M.tri[t * 3 + 2];
        M.tri[t * 3 + 2] = tmp;
      }
      ++flipped;
    }
  }
  rebuildEdges();
  return flipped;
}

FE_EXPORT uint32_t fe_edit_flip_normals(void) {
  uint32_t count = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (!faceSelected(t)) continue;
    const uint32_t tmp = M.tri[t * 3 + 1];
    M.tri[t * 3 + 1] = M.tri[t * 3 + 2];
    M.tri[t * 3 + 2] = tmp;
    ++count;
  }
  return count;
}

/* ---- stats, bounds, render -------------------------------------------- */

FE_EXPORT const uint32_t* fe_edit_stats_ptr(void) {
  static uint32_t stats[6];
  stats[0] = M.nv;
  stats[1] = E.n;
  stats[2] = M.nt;
  stats[3] = selectedVertCount();
  stats[4] = selectedEdgeCount();
  stats[5] = selectedFaceCount();
  return stats;
}

FE_EXPORT const float* fe_edit_bounds_ptr(void) {
  static float out[12];
  float minX = 1e30f, minY = 1e30f, minZ = 1e30f;
  float maxX = -1e30f, maxY = -1e30f, maxZ = -1e30f;
  double sx = 0.0, sy = 0.0, sz = 0.0;
  uint32_t sel = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (M.x[i] < minX) minX = M.x[i];
    if (M.y[i] < minY) minY = M.y[i];
    if (M.z[i] < minZ) minZ = M.z[i];
    if (M.x[i] > maxX) maxX = M.x[i];
    if (M.y[i] > maxY) maxY = M.y[i];
    if (M.z[i] > maxZ) maxZ = M.z[i];
    if (M.vsel[i]) { sx += M.x[i]; sy += M.y[i]; sz += M.z[i]; ++sel; }
  }
  if (M.nv == 0) { minX = minY = minZ = maxX = maxY = maxZ = 0.0f; }
  out[0] = minX; out[1] = minY; out[2] = minZ;
  out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  out[6] = sel ? static_cast<float>(sx / sel) : 0.0f;
  out[7] = sel ? static_cast<float>(sy / sel) : 0.0f;
  out[8] = sel ? static_cast<float>(sz / sel) : 0.0f;
  out[9] = static_cast<float>(sel);
  out[10] = maxX - minX;
  out[11] = maxY - minY;
  return out;
}

FE_EXPORT uint32_t fe_edit_build_render(void) { return fe_edit::buildRenderMesh(); }
FE_EXPORT const float* fe_edit_render_pos_ptr(void) { return g_outPos; }
FE_EXPORT const float* fe_edit_render_nrm_ptr(void) { return g_outNrm; }
FE_EXPORT const float* fe_edit_render_col_ptr(void) { return g_outCol; }
FE_EXPORT const uint32_t* fe_edit_render_idx_ptr(void) { return g_outIdx; }
FE_EXPORT uint32_t fe_edit_render_vert_count(void) { return g_outVerts; }
FE_EXPORT uint32_t fe_edit_render_idx_count(void) { return g_outIdxCount; }
FE_EXPORT uint32_t fe_edit_render_split_count(void) { return g_outSplit; }

/* ---- undo -------------------------------------------------------------- */

FE_EXPORT void fe_edit_undo_push(void) { undoPush(); }
FE_EXPORT int32_t fe_edit_undo(void) { return undoStep(); }
FE_EXPORT int32_t fe_edit_redo(void) { return redoStep(); }
FE_EXPORT uint32_t fe_edit_undo_depth(void) { return undoDepth(); }
FE_EXPORT uint32_t fe_edit_redo_depth(void) { return redoDepth(); }
FE_EXPORT void fe_edit_undo_clear(void) { undoClear(); }

/* ---- clipboard readback (separate / join) ------------------------------ */

FE_EXPORT uint32_t fe_edit_clip_vert_count(void) { return C.nv; }
FE_EXPORT uint32_t fe_edit_clip_tri_count(void) { return C.nt; }
FE_EXPORT const float* fe_edit_clip_pos_ptr(void) {
  static float interleaved[kMaxVerts * 3];
  for (uint32_t i = 0; i < C.nv; ++i) {
    interleaved[i * 3] = C.x[i];
    interleaved[i * 3 + 1] = C.y[i];
    interleaved[i * 3 + 2] = C.z[i];
  }
  return interleaved;
}
FE_EXPORT const uint32_t* fe_edit_clip_idx_ptr(void) { return C.tri; }

} // extern "C"
