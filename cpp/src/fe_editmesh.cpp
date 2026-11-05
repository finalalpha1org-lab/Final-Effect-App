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
/* Per-edge wireframe mask and the dihedral threshold it is built from. A
   triangle mesh has a diagonal across every quad face; Blender's edit mode
   does not show them because its faces are quads. Ours are triangles, so the
   diagonal is hidden by angle instead: an edge whose two faces are nearly
   coplanar is internal structure, not a silhouette. */
uint8_t g_edgeDisplay[kMaxEdges];
float g_displayAngle = 0.6f;

/* Screen-space pick radius in NDC units. The app sets it from the viewport
   height so a finger keeps the same target size on any camera; the constants
   below are only the fallback for a caller that never sets it. */
float g_pickTolerance = 0.045f;
/* Quad faces. Two triangles are the two halves of *one* face when the edge they
   share is the diagonal of a quad - see buildQuadGroups() for how that is
   decided and why it survives a deformation. Selection lives on vertices, so a
   face's vertices move together: picking a face means picking all four corners
   of the side, and the tool acts on the whole side instead of on half of it. */
uint32_t g_quadOf[kMaxTris];
uint32_t g_quadFirst[kMaxTris];
uint32_t g_quadNext[kMaxTris];
uint32_t g_quadCount = 0;
uint8_t g_quadPaired[kMaxTris];
/* Each face's corner ring, flattened: g_grpStart[f] is where face f starts in
   g_grpRing and g_grpStart[f + 1] is where it ends, so the ring of face f is
   g_grpRing[g_grpStart[f] .. g_grpStart[f + 1]). Three corners for a triangle,
   four for a quad, n for an n-gon. This is the table the shell outlines and
   the tests read; it is bounded by three corners per triangle, which covers
   every case (a quad needs four corners for two triangles, an n-gon n corners
   for n - 2). */
uint32_t g_grpStart[kMaxTris + 1];
uint32_t g_grpRing[kMaxTris * 3];
uint32_t g_grpRingCount = 0;
uint32_t g_ngonCount = 0;
/* The signature of the triangle table the groups were built from, and how far
   two triangles may fold and still be the two halves of one face. */
uint32_t g_quadSignature = 0u;
bool g_quadBuilt = false;
float g_quadAngle = 45.0f;
/* The edges inside a face, handed to the shell as vertex index pairs: the
   diagonal of a quad, the spokes of a fan. Bounded by the edge table. */
uint32_t g_quadPairs[kMaxEdges * 2];
uint32_t g_quadPairCount = 0;

/* The faces the app declared (fe_edit_set_faces), waiting for the next group
   build. They are consumed once: after an operation that changes the topology
   a declared ring describes vertices that may no longer be there, so the
   kernel goes back to the shape's own hints instead of holding a stale face. */
/* The capacity is the mesh's own capacity, not a smaller budget: a face is at
   least one triangle, so there are never more faces than triangles, and a
   triangle carries three corners while a quad carries four for two triangles
   and an n-gon n for n - 2. Three corners per triangle therefore covers every
   mesh this kernel accepts, which makes the declaration a property of the mesh
   instead of a second, smaller limit a user can walk into. */
constexpr uint32_t kMaxDeclFaces = kMaxTris;
constexpr uint32_t kMaxDeclCorners = kMaxTris * 3u;
uint32_t g_declStart[kMaxDeclFaces + 1];
uint32_t g_declRing[kMaxDeclCorners];
uint32_t g_declFaces = 0;
bool g_declPending = false;
/* Upload slot -> welded vertex, so a face declared in the geometry's own
   numbering still names the right vertex after three's split corners have been
   welded. kNoFace when the weld dropped the vertex. */
uint32_t g_slotFinal[kMaxVerts];
uint32_t g_slotFinalCount = 0;
uint32_t g_weldMerged = 0;
uint8_t g_vertUsed[kMaxVerts];
uint32_t g_vertNew[kMaxVerts];

/* One drag of one handle. The gizmo is not a three.js TransformControls: its
   picking and its maths live here, next to the mesh, so a finger drag is one
   kernel call per frame and the handles obey proportional editing and the axis
   lock exactly like the tools in the sheet do. */
struct GizmoState {
  bool active;
  int32_t handle;   /* 0 = X, 1 = Y, 2 = Z, -1 = none */
  uint32_t space;   /* 0 translate, 1 rotate, 2 scale */
  float pivot[3];
  float size;
  float startX;
  float startY;
  float startT;
  float startAngle;
  float startDist;
  float applied;
};
GizmoState GZ = {false, -1, 0u, {0.0f, 0.0f, 0.0f}, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
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
uint32_t g_renderWeld[kMaxRenderVerts];

namespace {

constexpr uint32_t kHashBits = 17;
constexpr uint32_t kHashSize = 1u << kHashBits;
constexpr uint32_t kNoFace = 0xFFFFFFFFu;
/* The most corners one face may have. The ring frame below is a fixed buffer
   because the kernel has no allocator, so there has to be a bound; this one is
   larger than any polygon the vertex budget allows. A ring that somehow arrives
   bigger is skipped on its own rather than failing the call, so one absurd face
   cannot cost the mesh every other face it declared. */
constexpr uint32_t kMaxRingCorners = 2048u;

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
  size += M.nt;                        /* per-face shading flags */
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
  for (uint32_t i = 0; i < M.nt; ++i) *p++ = M.fsmooth[i];
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
  for (uint32_t i = 0; i < nt; ++i) { M.fsmooth[i] = static_cast<uint8_t>(*p++ & 1u); }
  M.fsmoothCount = nt;
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

/* The angle of triangle `t` at its corner `k`, in radians.
 *
 * Vertex normals used to be summed with the triangle *area* as the weight, and
 * on a quad-split model that is visibly wrong: of the two triangles of a face,
 * one owns the corner and the other does not, so that face counts half as much
 * as its neighbour and a smooth-shaded cube comes out lopsided. The angle the
 * corner actually subtends inside the face is unchanged by the split - the two
 * halves add up to the quad's own corner angle - which is the weighting every
 * modelling package uses and the reason smooth shading reads as smooth. */
float cornerAngle(uint32_t t, uint32_t k) {
  const uint32_t a = M.tri[t * 3 + k];
  const uint32_t b = M.tri[t * 3 + (k + 1) % 3];
  const uint32_t c = M.tri[t * 3 + (k + 2) % 3];
  const float ux = M.x[b] - M.x[a], uy = M.y[b] - M.y[a], uz = M.z[b] - M.z[a];
  const float vx = M.x[c] - M.x[a], vy = M.y[c] - M.y[a], vz = M.z[c] - M.z[a];
  const float cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const float cross = sqrtf(cx * cx + cy * cy + cz * cz);
  const float dot = ux * vx + uy * vy + uz * vz;
  if (cross < 1e-20f && dot == 0.0f) return 0.0f;
  return atan2f(cross, dot);
}

void vertexNormals(float* nx, float* ny, float* nz) {
  for (uint32_t i = 0; i < M.nv; ++i) { nx[i] = 0.0f; ny[i] = 0.0f; nz[i] = 0.0f; }
  for (uint32_t t = 0; t < M.nt; ++t) {
    float fx, fy, fz;
    faceNormal(t, fx, fy, fz);
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t v = M.tri[t * 3 + k];
      const float weight = cornerAngle(t, k);
      nx[v] += fx * weight;
      ny[v] += fy * weight;
      nz[v] += fz * weight;
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
  /* Which of these edges belong in the wireframe (see g_edgeDisplay). */
  const float cosLimit = fe::cosf(g_displayAngle * fe::kDeg2Rad);
  for (uint32_t e = 0; e < E.n; ++e) {
    if (E.f1[e] == kNoFace) { g_edgeDisplay[e] = 1; continue; }
    float ax, ay, az, bx, by, bz;
    faceNormal(E.f0[e], ax, ay, az);
    faceNormal(E.f1[e], bx, by, bz);
    g_edgeDisplay[e] = (ax * bx + ay * by + az * bz) < cosLimit ? 1u : 0u;
  }
  buildQuadGroups();
}

/* Signature of the triangle table. The pairing below is valid while the table
   is: a deformation only moves vertices, so the faces the mesh had are kept,
   while any operation that adds, removes or re-indexes a triangle invalidates
   it, so a stored partner can never point at a face that op has since
   replaced. */
uint32_t quadTopologySignature() {
  uint32_t h = 2166136261u;
  h = (h ^ (M.nt * 2654435761u)) * 16777619u;
  for (uint32_t i = 0; i < M.nt * 3u; ++i) h = (h ^ M.tri[i]) * 16777619u;
  return h;
}

/* True when the edge is the longest side of *both* of its triangles, which is
   what a quad's diagonal is: a rectangle's diagonal is its hypotenuse while the
   sides two quads share are shorter than the diagonals of the triangles that
   touch them. The tolerance is small (2%) because a deformation moves these
   lengths around: a quad whose corner has been dragged upwards can bring a side
   close to the length of the diagonal, and the face must stay one face. The
   crease limit in buildQuadGroups, not this length test, is what keeps a
   triangulated mesh (a sphere, a cone, a tetrahedron) out of the pairing. */
bool isQuadDiagonal(const uint32_t e) {
  if (E.f0[e] == kNoFace || E.f1[e] == kNoFace) return false;
  const uint32_t a = E.a[e], b = E.b[e];
  const float dx = M.x[a] - M.x[b], dy = M.y[a] - M.y[b], dz = M.z[a] - M.z[b];
  const float len2 = dx * dx + dy * dy + dz * dz;
  if (len2 <= 1e-12f) return false;
  const float limit = len2 * 1.02f;
  for (uint32_t k = 0; k < 2; ++k) {
    const uint32_t f = k ? E.f1[e] : E.f0[e];
    for (uint32_t c = 0; c < 3; ++c) {
      const uint32_t v = M.tri[f * 3 + c], w = M.tri[f * 3 + (c + 1u) % 3u];
      if ((v == a && w == b) || (v == b && w == a)) continue;
      const float ex = M.x[v] - M.x[w], ey = M.y[v] - M.y[w], ez = M.z[v] - M.z[w];
      if (ex * ex + ey * ey + ez * ez > limit) return false;
    }
  }
  return true;
}

/* The two faces may fold towards each other this far and still be one face. */
bool quadCreaseWithin(const uint32_t e, const float cosLimit) {
  float ax, ay, az, bx, by, bz;
  faceNormal(E.f0[e], ax, ay, az);
  faceNormal(E.f1[e], bx, by, bz);
  return (ax * bx + ay * by + az * bz) >= cosLimit;
}

/* Take the inside of every face out of the wireframe. A face's *interior*
   edges are the ones its own triangles share: a quad's diagonal, the spokes a
   fan draws from the middle of a cap. They are structure the face does not
   have, so they stay hidden however the face is bent afterwards - which is why
   this is decided from the face table and not from the angle between two
   triangles. */
void hideFaceInteriors() {
  for (uint32_t e = 0; e < E.n; ++e) {
    if (E.f0[e] == kNoFace || E.f1[e] == kNoFace) continue;
    const uint32_t g = g_quadOf[E.f0[e]];
    if (g == kNoFace || g != g_quadOf[E.f1[e]]) continue;
    g_edgeDisplay[e] = 0;
  }
}

/* The corner of triangle t that is not a or b. */
uint32_t triangleApex(uint32_t t, uint32_t a, uint32_t b) {
  for (uint32_t k = 0; k < 3; ++k) {
    const uint32_t v = M.tri[t * 3 + k];
    if (v != a && v != b) return v;
  }
  return kNoFace;
}

/* ---- declared faces -------------------------------------------------------
   The app built the mesh, so it knows which triangles are one face: a cylinder
   cap is a thirty-two-gon in Blender and a fan of thirty-two triangles in the
   buffer, and no shape test can tell that fan apart from a flat quad mesh
   subdivided the same way. So the app can say it, and this is how.

   A declared face claims its triangles with one of two tests:

     1. every corner of the triangle is a corner of the ring. Exact, and true
        of any shape, which is what a face that has since been bent needs;
     2. the triangle lies in the ring's plane and its centroid is inside the
        ring. This is the fan case: a cap's middle vertex is not a corner of
        the cap, so the rim ring cannot name it, but every triangle of the fan
        is inside the rim.

   Both are the model's own geometry. Nothing here guesses. */

/* The plane and the 2D projection of a face's ring, computed once per face. */
struct RingFrame {
  float nx, ny, nz, d;      /* plane: dot(n, p) = d */
  float scale;              /* how big the ring is, for a tolerance */
  uint32_t n;               /* corners projected into the buffers below */
  uint32_t axis;            /* 0: xy, 1: xz, 2: yz - the projection used */
};
/* The projection lives in globals rather than inside the struct: the kernel has
   no allocator, a face may have a thousand corners, and eight kilobytes of
   stack for one would be a stack overflow waiting for a big n-gon. */
float g_ringPX[kMaxRingCorners];
float g_ringPY[kMaxRingCorners];

bool ringFrame(const uint32_t* ring, uint32_t n, RingFrame& frame) {
  /* Newell's method: the normal of a polygon, and its centroid. */
  float nx = 0.0f, ny = 0.0f, nz = 0.0f, cx = 0.0f, cy = 0.0f, cz = 0.0f;
  for (uint32_t i = 0; i < n; ++i) {
    const uint32_t a = ring[i], b = ring[(i + 1u) % n];
    nx += (M.y[a] - M.y[b]) * (M.z[a] + M.z[b]);
    ny += (M.z[a] - M.z[b]) * (M.x[a] + M.x[b]);
    nz += (M.x[a] - M.x[b]) * (M.y[a] + M.y[b]);
    cx += M.x[a]; cy += M.y[a]; cz += M.z[a];
  }
  const float inv = 1.0f / static_cast<float>(n);
  cx *= inv; cy *= inv; cz *= inv;
  const float len = fe::sqrtf(nx * nx + ny * ny + nz * nz);
  if (!(len > 1e-9f)) return false;
  frame.nx = nx / len; frame.ny = ny / len; frame.nz = nz / len;
  frame.d = frame.nx * cx + frame.ny * cy + frame.nz * cz;
  float extent = 0.0f;
  for (uint32_t i = 0; i < n; ++i) {
    const float dx = M.x[ring[i]] - cx, dy = M.y[ring[i]] - cy, dz = M.z[ring[i]] - cz;
    const float r = dx * dx + dy * dy + dz * dz;
    if (r > extent) extent = r;
  }
  frame.scale = fe::sqrtf(extent);
  if (!(frame.scale > 1e-9f)) return false;
  /* Project along the axis the face faces most: the projection then keeps the
     ring's area and no two corners of a convex face coincide. */
  const float ax = fe::absf(frame.nx), ay = fe::absf(frame.ny), az = fe::absf(frame.nz);
  frame.axis = (az >= ax && az >= ay) ? 0u : (ay >= ax ? 1u : 2u);
  frame.n = n;
  for (uint32_t i = 0; i < n; ++i) {
    const uint32_t v = ring[i];
    if (frame.axis == 0u) { g_ringPX[i] = M.x[v]; g_ringPY[i] = M.y[v]; }
    else if (frame.axis == 1u) { g_ringPX[i] = M.x[v]; g_ringPY[i] = M.z[v]; }
    else { g_ringPX[i] = M.y[v]; g_ringPY[i] = M.z[v]; }
  }
  return true;
}

bool pointInRing(const RingFrame& frame, uint32_t n, float x, float y, float z) {
  (void)n;   /* the frame carries how many corners it projected */
  float u, v;
  if (frame.axis == 0u) { u = x; v = y; }
  else if (frame.axis == 1u) { u = x; v = z; }
  else { u = y; v = z; }
  bool inside = false;
  for (uint32_t i = 0, j = n - 1; i < n; j = i++) {
    const float yi = g_ringPY[i], yj = g_ringPY[j];
    if ((yi > v) == (yj > v)) continue;
    const float t = (v - yi) / (yj - yi);
    if (u < g_ringPX[i] + t * (g_ringPX[j] - g_ringPX[i])) inside = !inside;
  }
  return inside;
}

bool ringClaimsTriangle(const uint32_t t, const uint32_t* ring, uint32_t n, const RingFrame& frame) {
  const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
  /* 1. the triangle's corners are the ring's own corners. */
  uint32_t hits = 0;
  for (uint32_t k = 0; k < 3; ++k) {
    const uint32_t v = M.tri[t * 3 + k];
    for (uint32_t i = 0; i < n; ++i) {
      if (ring[i] == v) { ++hits; break; }
    }
  }
  if (hits == 3) return true;
  /* 2. the triangle is in the face's plane and inside its ring. */
  const float eps = frame.scale * 1.0e-3f;
  for (uint32_t k = 0; k < 3; ++k) {
    const uint32_t v = M.tri[t * 3 + k];
    const float side = frame.nx * M.x[v] + frame.ny * M.y[v] + frame.nz * M.z[v] - frame.d;
    if (side > eps || side < -eps) return false;
  }
  const float cx = (M.x[a] + M.x[b] + M.x[c]) * (1.0f / 3.0f);
  const float cy = (M.y[a] + M.y[b] + M.y[c]) * (1.0f / 3.0f);
  const float cz = (M.z[a] + M.z[b] + M.z[c]) * (1.0f / 3.0f);
  return pointInRing(frame, n, cx, cy, cz);
}

/* The triangles of every declared face, claimed before the shape is asked for
   its own hints: a declared face is a fact, a pairing is a guess. */
void claimDeclaredFaces() {
  if (g_declFaces == 0) return;
  buildVertexFaces();
  for (uint32_t f = 0; f < g_declFaces; ++f) {
    const uint32_t start = g_declStart[f], end = g_declStart[f + 1];
    const uint32_t n = end - start;
    if (n < 3 || n > kMaxRingCorners) continue;
    const uint32_t* ring = &g_declRing[start];
    RingFrame frame;
    if (!ringFrame(ring, n, frame)) continue;
    uint32_t group = kNoFace, last = kNoFace;
    for (uint32_t k = 0; k < n; ++k) {
      const uint32_t v = ring[k];
      for (uint32_t i = g_faceStart[v]; i < g_faceStart[v + 1]; ++i) {
        const uint32_t t = g_faceList[i];
        if (g_quadOf[t] != kNoFace) continue;      /* already part of a face */
        if (!ringClaimsTriangle(t, ring, n, frame)) continue;
        if (group == kNoFace) {
          if (g_quadCount >= kMaxTris) return;
          if (g_grpRingCount + n > kMaxTris * 3u) return;
          group = g_quadCount++;
          g_quadFirst[group] = t;
          g_grpStart[group] = g_grpRingCount;
          for (uint32_t c = 0; c < n; ++c) g_grpRing[g_grpRingCount++] = ring[c];
          g_grpStart[group + 1] = g_grpRingCount;
        }
        g_quadOf[t] = group;
        g_quadPaired[t] = 1;
        if (last == kNoFace) last = t;
        else { g_quadNext[last] = t; last = t; }
        g_quadNext[t] = kNoFace;
      }
    }
    if (group != kNoFace && n >= 5) ++g_ngonCount;
  }
}

/* One face is one surface. It is built from, in order: the faces the app
   declared; then, for what is left, two triangles that share the diagonal of a
   quad; then every triangle that found no partner (a sphere's pole, a cone's
   side, a tetrahedron's face).

   The pairing half used to be decided from g_edgeDisplay, i.e. from the angle
   between the two triangles, which is exactly the thing a deformation changes:
   move one vertex of a quad by ten degrees and the wireframe grew a triangle
   back in the middle of the face. It is decided from the shape of the two
   triangles now, and kept as long as the triangle table is unchanged, so an
   edit can bend a quad without tearing it into triangles. */
void buildQuadGroups() {
  if (g_quadBuilt && g_quadSignature == quadTopologySignature()) {
    hideFaceInteriors();
    return;
  }

  for (uint32_t t = 0; t < M.nt; ++t) {
    g_quadOf[t] = kNoFace;
    g_quadNext[t] = kNoFace;
    g_quadPaired[t] = 0;
  }
  g_quadCount = 0;
  g_grpRingCount = 0;
  g_ngonCount = 0;
  g_grpStart[0] = 0;

  /* 1. what the app said the faces are. */
  claimDeclaredFaces();
  g_declFaces = 0;                 /* consumed: a topology change invalidates it */
  g_declPending = false;

  /* 2. Candidate diagonals, longest first: in a triangulated quad mesh the
     diagonal of a drawn quad is the longest edge of both of its triangles,
     while the edges two quads share are the shortest - taking the long ones
     rebuilds the quads the model was drawn with instead of pairing across
     them. */
  static uint32_t order[kMaxEdges];
  uint32_t candidates = 0;
  /* The pairing is a shape test, not an angle test: two triangles are the two
     halves of one quad when they share their longest side. The angle is a
     generous backstop (60 degrees) rather than the old 45: an edit changes the
     angle, and a quad that has been bent must stay one face, while a real fold
     - a sphere's, a cone's, a tetrahedron's 70 degrees - still shows its
     triangles. */
  const float cosQuad = 0.5f;
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!isQuadDiagonal(e)) continue;
    if (!quadCreaseWithin(e, cosQuad)) continue;
    order[candidates++] = e;
  }
  for (uint32_t i = 1; i < candidates; ++i) {
    const uint32_t e = order[i];
    const float dx = M.x[E.a[e]] - M.x[E.b[e]];
    const float dy = M.y[E.a[e]] - M.y[E.b[e]];
    const float dz = M.z[E.a[e]] - M.z[E.b[e]];
    const float len = dx * dx + dy * dy + dz * dz;
    uint32_t j = i;
    while (j > 0) {
      const uint32_t o = order[j - 1];
      const float ox = M.x[E.a[o]] - M.x[E.b[o]];
      const float oy = M.y[E.a[o]] - M.y[E.b[o]];
      const float oz = M.z[E.a[o]] - M.z[E.b[o]];
      if (ox * ox + oy * oy + oz * oz >= len) break;
      order[j] = order[j - 1];
      --j;
    }
    order[j] = e;
  }

  for (uint32_t i = 0; i < candidates; ++i) {
    const uint32_t e = order[i];
    const uint32_t f0 = E.f0[e], f1 = E.f1[e];
    if (g_quadPaired[f0] || g_quadPaired[f1]) continue;
    if (g_quadCount >= kMaxTris) break;
    if (g_grpRingCount + 4u > kMaxTris * 3u) break;
    g_quadPaired[f0] = 1;
    g_quadPaired[f1] = 1;
    const uint32_t group = g_quadCount++;
    g_quadOf[f0] = group;
    g_quadOf[f1] = group;
    g_quadFirst[group] = f0;
    g_quadNext[f0] = f1;
    g_quadNext[f1] = kNoFace;
    /* The quad's own ring: the shared edge is its diagonal, so the corners run
       a, apex(f0), b, apex(f1) - four corners in the order the face has. */
    const uint32_t a = E.a[e], b = E.b[e];
    const uint32_t c = triangleApex(f0, a, b);
    const uint32_t d = triangleApex(f1, a, b);
    g_grpStart[group] = g_grpRingCount;
    g_grpRing[g_grpRingCount++] = a;
    g_grpRing[g_grpRingCount++] = c;
    g_grpRing[g_grpRingCount++] = b;
    g_grpRing[g_grpRingCount++] = d;
    g_grpStart[group + 1] = g_grpRingCount;
  }

  /* 3. Every triangle that found no partner is a face of its own. */
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (g_quadPaired[t]) continue;
    if (g_quadCount >= kMaxTris) break;
    if (g_grpRingCount + 3u > kMaxTris * 3u) break;
    const uint32_t group = g_quadCount++;
    g_quadOf[t] = group;
    g_quadFirst[group] = t;
    g_grpStart[group] = g_grpRingCount;
    g_grpRing[g_grpRingCount++] = M.tri[t * 3];
    g_grpRing[g_grpRingCount++] = M.tri[t * 3 + 1];
    g_grpRing[g_grpRingCount++] = M.tri[t * 3 + 2];
    g_grpStart[group + 1] = g_grpRingCount;
  }

  g_quadSignature = quadTopologySignature();
  g_quadBuilt = true;
  hideFaceInteriors();
}

/* ---- welding -------------------------------------------------------------
   three.js hands over a triangle soup: a cube's eight corners arrive as
   twenty-four vertices, one per face. Editing that soup is why picking a
   corner used to tear the cube open - the corner was three separate vertices
   and only one of them moved - and why the overlay drew twenty-four dots on
   an eight-corner box. Everything from upload onwards works on a welded mesh:
   coincident vertices become one, triangles that collapse are dropped, and the
   vertex indices are compacted so no orphan is left to draw. */
void weldVertices() {
  const float eps = 1.0e-5f;
  const float inv = 1.0f / eps;
  for (uint32_t i = 0; i < kHashSize; ++i) g_hash[i] = 0;
  uint32_t merged = 0;
  for (uint32_t v = 0; v < M.nv; ++v) {
    const int32_t cx = static_cast<int32_t>(fe::floorf(M.x[v] * inv));
    const int32_t cy = static_cast<int32_t>(fe::floorf(M.y[v] * inv));
    const int32_t cz = static_cast<int32_t>(fe::floorf(M.z[v] * inv));
    uint32_t slot = (static_cast<uint32_t>(cx) * 73856093u) ^
                    (static_cast<uint32_t>(cy) * 19349663u) ^
                    (static_cast<uint32_t>(cz) * 83492791u);
    slot &= (kHashSize - 1u);
    uint32_t rep = v;
    for (;;) {
      const uint32_t entry = g_hash[slot];
      if (entry == 0) { g_hash[slot] = v + 1; break; }
      const uint32_t u = entry - 1;
      const int32_t ux = static_cast<int32_t>(fe::floorf(M.x[u] * inv));
      const int32_t uy = static_cast<int32_t>(fe::floorf(M.y[u] * inv));
      const int32_t uz = static_cast<int32_t>(fe::floorf(M.z[u] * inv));
      if (ux == cx && uy == cy && uz == cz) { rep = u; ++merged; break; }
      slot = (slot + 1) & (kHashSize - 1u);
    }
    g_vertMap[v] = rep;
  }
  g_weldMerged = merged;
  g_slotFinalCount = M.nv;
  if (merged == 0) {
    /* Nothing moved: every slot is its own vertex. */
    for (uint32_t v = 0; v < M.nv; ++v) g_slotFinal[v] = v;
    return;
  }

  /* Re-index the triangles and drop the ones that collapsed onto themselves. */
  uint32_t keep = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    const uint32_t a = g_vertMap[M.tri[t * 3]], b = g_vertMap[M.tri[t * 3 + 1]], c = g_vertMap[M.tri[t * 3 + 2]];
    if (a == b || b == c || a == c) continue;
    M.tri[keep * 3] = a; M.tri[keep * 3 + 1] = b; M.tri[keep * 3 + 2] = c;
    M.fsmooth[keep] = M.fsmooth[t] ? 1u : 0u;
    ++keep;
  }
  M.nt = keep;
  M.fsmoothCount = keep;

  /* Compact the vertex array so the survivors are 0..n-1 in first-use order. */
  for (uint32_t v = 0; v < M.nv; ++v) g_vertUsed[v] = 0;
  for (uint32_t i = 0; i < M.nt * 3u; ++i) g_vertUsed[M.tri[i]] = 1;
  uint32_t next = 0;
  for (uint32_t v = 0; v < M.nv; ++v) {
    if (!g_vertUsed[v]) { g_vertNew[v] = kNoFace; continue; }
    g_vertNew[v] = next;
    if (next != v) {
      M.x[next] = M.x[v]; M.y[next] = M.y[v]; M.z[next] = M.z[v];
      M.cr[next] = M.cr[v]; M.cg[next] = M.cg[v]; M.cb[next] = M.cb[v];
    }
    ++next;
  }
  for (uint32_t i = 0; i < M.nt * 3u; ++i) M.tri[i] = g_vertNew[M.tri[i]];
  /* A face declared in the geometry's numbering has to name the welded vertex:
     the shell knows the mesh three.js handed it, where a cube's corner is three
     vertices, and the kernel edits the one. */
  for (uint32_t v = 0; v < g_slotFinalCount; ++v) g_slotFinal[v] = g_vertNew[g_vertMap[v]];
  M.nv = next;
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

/* Every triangle of the face the picked triangle belongs to. Falls back to the
   one triangle when the mesh has no groups yet (nothing has been rebuilt). */
void setFaceVertSelection(uint32_t t, uint8_t value) {
  if (t >= M.nt) return;
  const uint32_t group = g_quadOf[t];
  if (group >= kMaxTris) {
    M.vsel[M.tri[t * 3]] = value;
    M.vsel[M.tri[t * 3 + 1]] = value;
    M.vsel[M.tri[t * 3 + 2]] = value;
    return;
  }
  for (uint32_t f = g_quadFirst[group]; f != kNoFace && f < M.nt; f = g_quadNext[f]) {
    M.vsel[M.tri[f * 3]] = value;
    M.vsel[M.tri[f * 3 + 1]] = value;
    M.vsel[M.tri[f * 3 + 2]] = value;
  }
}

void selectFaceVerts(uint32_t t) {
  setFaceVertSelection(t, 1);
}

void deselectFaceVerts(uint32_t t) {
  setFaceVertSelection(t, 0);
}

/* Is the face this triangle belongs to selected? */
bool quadFaceSelected(uint32_t t) {
  if (t >= M.nt) return false;
  const uint32_t group = g_quadOf[t];
  if (group >= kMaxTris) return faceSelected(t);
  return faceSelected(g_quadFirst[group] < M.nt ? g_quadFirst[group] : t);
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
  if (g_quadCount == 0) {
    for (uint32_t t = 0; t < M.nt; ++t) n += faceSelected(t) ? 1u : 0u;
    return n;
  }
  for (uint32_t group = 0; group < g_quadCount && group < kMaxTris; ++group) {
    const uint32_t f = g_quadFirst[group];
    if (f < M.nt && faceSelected(f)) ++n;
  }
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

/* Set by fe_edit_build_render_split: the same pass, but it always splits, even
   when every face is flat. Leaving Edit Mode needs that, because the object it
   hands the mesh back to has no "flat" switch of its own - the only place the
   shading can live is inside the normals. */
bool g_forceSplit = false;

/* Every face is flat *and* planar - the one case the material can shade by
   itself, because a derivative normal taken across a planar triangle is exactly
   the face normal. A bent face is flat but not planar: its two halves point
   different ways, and only the split pass, which writes one normal per face,
   can keep the line off the diagonal. */
bool g_flatPlanar = false;

/* The shading of one face, with the stale bytes past the last written flag
   replaced by the mesh's own answer. A mesh that is smooth all over stays
   smooth through a subdivide, instead of inheriting whatever the previous,
   smaller mesh happened to leave in those slots. */
uint8_t faceSmoothFlag(uint32_t t) {
  if (t < M.fsmoothCount) return M.fsmooth[t] ? 1u : 0u;
  return M.smooth ? 1u : 0u;
}

uint32_t buildRenderMesh() {
  g_outVerts = 0;
  g_outIdxCount = 0;
  g_outSplit = 0;
  g_flatPlanar = false;
  if (M.nt == 0 || M.nv == 0) return 0;
  /* Hold the flags to the triangles that exist, so everything downstream - the
     ptr the bridge copies onto the committed geometry, the next snapshot - sees
     a defined value for every face the tools just created. */
  for (uint32_t t = 0; t < M.nt; ++t) M.fsmooth[t] = faceSmoothFlag(t);
  M.fsmoothCount = M.nt;

  /* Everything big is static: this runs on the wasm stack, which is 64 kB. */
  static float nx[kMaxVerts], ny[kMaxVerts], nz[kMaxVerts];
  static float fnx[kMaxTris], fny[kMaxTris], fnz[kMaxTris], farea[kMaxTris];
  vertexNormals(nx, ny, nz);

  /* The face normals, once, for both paths: the split pass shades with them and
     the fast path below needs to know whether any of them disagree about a face
     they share. */
  buildVertexFaces();
  for (uint32_t t = 0; t < M.nt; ++t) {
    faceNormal(t, fnx[t], fny[t], fnz[t]);
    triangleArea(t, farea[t]);
  }

  /* One normal per *face*, not per triangle. A face is the quad the model says
     it has, and a bent quad is still one face: shading it flat in Blender gives
     every one of its corners the polygon's normal, so no line appears down the
     diagonal. Shading it per triangle - which is what the buffer holds - draws
     exactly that line, because the two halves then point different ways. The
     kernel already knows which triangles are one face (`g_quadOf`, built from
     the declared rings and the quad pairing), so a flat face takes the weighted
     normal of the whole face and every triangle in it carries it. */
  static float snx[kMaxTris], sny[kMaxTris], snz[kMaxTris];
  for (uint32_t t = 0; t < M.nt; ++t) {
    snx[t] = fnx[t]; sny[t] = fny[t]; snz[t] = fnz[t];
  }
  /* A face whose triangles disagree is bent, and a bent face needs its own
     normals; a planar one is already exact and can stay on the fast path. */
  bool bentFlatFace = false;
  for (uint32_t g = 0; g < g_quadCount; ++g) {
    uint32_t count = 0;
    bool flat = true;
    float ax = 0.0f, ay = 0.0f, az = 0.0f;
    for (uint32_t t = g_quadFirst[g]; t != kNoFace && count < kMaxTris; t = g_quadNext[t]) {
      ++count;
      if (faceSmoothFlag(t)) { flat = false; break; }
      ax += fnx[t]; ay += fny[t]; az += fnz[t];
    }
    if (!flat || count < 2) continue;
    const float len = sqrtf(ax * ax + ay * ay + az * az);
    if (!(len > 1e-20f)) continue;
    ax /= len; ay /= len; az /= len;
    for (uint32_t t = g_quadFirst[g]; t != kNoFace; t = g_quadNext[t]) {
      if (fnx[t] * ax + fny[t] * ay + fnz[t] * az < 0.99999f) bentFlatFace = true;
      snx[t] = ax; sny[t] = ay; snz[t] = az;
    }
  }

  /* Anything smooth at all, and the split pass below runs: a mesh with a flat
     face and a smooth one needs the flat face's corners broken away from the
     smooth ones, or the smoothing wins at every shared vertex. */
  bool anySmooth = false;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (faceSmoothFlag(t)) { anySmooth = true; break; }
  }

  g_flatPlanar = !anySmooth && !bentFlatFace;
  if (g_flatPlanar && !g_forceSplit) {
    /* Every face is flat, and every one of them is planar. Flat shading is done
       by the material (derivative normals in the fragment shader), so the
       indexed mesh can be reused untouched - and that is also the only way to
       keep a 30 000 triangle flat mesh inside the render-vertex budget, which
       tripling corners would not. A *bent* flat face cannot use derivative
       normals: the shader would give each half of it its own direction and draw
       the diagonal the face does not have, which is why that case falls through
       to the split pass below. */
    for (uint32_t i = 0; i < M.nv; ++i) {
      g_outPos[i * 3] = M.x[i]; g_outPos[i * 3 + 1] = M.y[i]; g_outPos[i * 3 + 2] = M.z[i];
      g_outNrm[i * 3] = nx[i]; g_outNrm[i * 3 + 1] = ny[i]; g_outNrm[i * 3 + 2] = nz[i];
      g_outCol[i * 3] = M.hasColor ? M.cr[i] : 1.0f;
      g_outCol[i * 3 + 1] = M.hasColor ? M.cg[i] : 1.0f;
      g_outCol[i * 3 + 2] = M.hasColor ? M.cb[i] : 1.0f;
      g_renderWeld[i] = i;
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
      g_renderWeld[renderCount] = v;
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
            /* A flat face never averages with its neighbours - that is the
               whole point of the flag - but the triangles that make up ONE
               face must share a vertex, or a bent quad grows a line down the
               diagonal. Same face, same normal: one group. */
            const bool smoothA = faceSmoothFlag(fa) != 0;
            const bool smoothB = faceSmoothFlag(fb) != 0;
            if (smoothA != smoothB) continue;
            if (!smoothA) {
              const uint32_t ga = g_quadOf[fa], gb = g_quadOf[fb];
              if (ga == kNoFace || ga != gb) continue;
            } else {
              float crease = 0.0f;
              if (pairGet(g_sharp, v, shared, &crease)) continue;
            }
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
        /* Same weight as vertexNormals: the angle the face subtends at v, so a
           quad keeps its full share after being split into two triangles. */
        float weight = 0.0f;
        for (uint32_t k = 0; k < 3; ++k) {
          if (M.tri[f * 3 + k] == v) { weight = cornerAngle(f, k); break; }
        }
        ax += snx[f] * weight;
        ay += sny[f] * weight;
        az += snz[f] * weight;
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
      g_renderWeld[rv] = v;
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

  /* `cornerGroup` is written per *corner*, so it is read per corner. Reading it
     by vertex id looked the same on a mesh whose triangle table is 0,1,2,3... -
     which is most freshly uploaded ones - and silently picked another corner's
     vertex on anything a tool had re-indexed. */
  for (uint32_t t = 0; t < M.nt; ++t) {
    g_outIdx[t * 3] = cornerGroup[t * 3];
    g_outIdx[t * 3 + 1] = cornerGroup[t * 3 + 1];
    g_outIdx[t * 3 + 2] = cornerGroup[t * 3 + 2];
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
    g_renderWeld[i] = i;
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

  /* Only the active element kind is tested, and only within a screen-space
     radius the app passes in. Two bugs lived here before: the vertex pass ran
     in every mode with no distance limit, so a tap on empty space still took
     the nearest vertex - and in face mode that vertex index came back as a
     face index, selecting something unrelated. The edge pass additionally
     demanded d < bestDist * 0.8 of that stray vertex, which is why most edges
     could not be picked at all. */
  const float tolVert = g_pickTolerance;
  const float tolEdge = g_pickTolerance * 0.8f;
  /* Faces are large targets, so their tolerance is tight: a tap next to the
     mesh must not grab a face it is not on. */
  const float tolFace = g_pickTolerance * 0.45f;

  /* Frontmost depth under a screen point, or 1e30 where nothing was drawn. */
  const auto depthAt = [&](float screenX, float screenY) -> float {
    const uint32_t ix = static_cast<uint32_t>(clampf((screenX * 0.5f + 0.5f) * static_cast<float>(bw), 0.0f, static_cast<float>(bw - 1)));
    const uint32_t iy = static_cast<uint32_t>(clampf((1.0f - screenY) * 0.5f * static_cast<float>(bh), 0.0f, static_cast<float>(bh - 1)));
    return zbuf[iy * bw + ix];
  };
  const auto project = [&](uint32_t v, float& screenX, float& screenY, float& depth) -> bool {
    const float w = clip[3] * M.x[v] + clip[7] * M.y[v] + clip[11] * M.z[v] + clip[15];
    if (w <= 1e-6f) return false;
    screenX = (clip[0] * M.x[v] + clip[4] * M.y[v] + clip[8] * M.z[v] + clip[12]) / w;
    screenY = (clip[1] * M.x[v] + clip[5] * M.y[v] + clip[9] * M.z[v] + clip[13]) / w;
    depth = (clip[2] * M.x[v] + clip[6] * M.y[v] + clip[10] * M.z[v] + clip[14]) / w;
    return true;
  };
  /* Occlusion is judged under the candidate itself, not under the finger: a
     vertex on the silhouette lands a few pixels from the tap and used to be
     discarded for the surface depth at the tap instead. */
  const auto occluded = [&](float screenX, float screenY, float depth) -> bool {
    return depth > depthAt(screenX, screenY) + 0.02f;
  };

  int32_t best = -1;
  uint32_t bestKind = g_mode;
  float bestDist = 1e30f;
  float bestDepth = 1e30f;

  if (g_mode == kModeVertex) {
    const float limit = tolVert * tolVert;
    for (uint32_t v = 0; v < M.nv; ++v) {
      float sx, sy, sz;
      if (!project(v, sx, sy, sz)) continue;
      const float dx = sx - ndcX, dy = sy - ndcY;
      const float d = dx * dx + dy * dy;
      if (d > limit) continue;
      if (occluded(sx, sy, sz)) continue;
      if (d < bestDist) { bestDist = d; best = static_cast<int32_t>(v); bestKind = kModeVertex; bestDepth = sz; }
    }
  } else if (g_mode == kModeEdge) {
    const float limit = tolEdge * tolEdge;
    for (uint32_t e = 0; e < E.n; ++e) {
      /* Only the edges the wireframe draws. A quad's diagonal is an edge of the
         triangle soup, not of the surface, so it is not something to aim at. */
      if (!g_edgeDisplay[e]) continue;
      const uint32_t a = E.a[e], b = E.b[e];
      float ax, ay, az, bx2, by2, bz2;
      if (!project(a, ax, ay, az) || !project(b, bx2, by2, bz2)) continue;
      const float vx = bx2 - ax, vy = by2 - ay;
      const float len2 = vx * vx + vy * vy;
      if (len2 < 1e-12f) continue;
      float t = ((ndcX - ax) * vx + (ndcY - ay) * vy) / len2;
      t = clampf(t, 0.0f, 1.0f);
      const float qx = ax + vx * t, qy = ay + vy * t;
      const float dx = qx - ndcX, dy = qy - ndcY;
      const float d = dx * dx + dy * dy;
      if (d > limit) continue;
      const float z = az + (bz2 - az) * t;
      if (occluded(qx, qy, z)) continue;
      if (d < bestDist) { bestDist = d; best = static_cast<int32_t>(e); bestKind = kModeEdge; bestDepth = z; }
    }
  } else if (g_mode == kModeFace) {
    const float limit = tolFace * tolFace;
    for (uint32_t t = 0; t < M.nt; ++t) {
      float sx[3], sy[3], sz[3];
      bool ok = true;
      for (uint32_t k = 0; k < 3 && ok; ++k) ok = project(M.tri[t * 3 + k], sx[k], sy[k], sz[k]);
      if (!ok) continue;
      const float area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
      if (absf(area) < 1e-12f) continue;
      const float w0 = ((sx[1] - ndcX) * (sy[2] - ndcY) - (sx[2] - ndcX) * (sy[1] - ndcY)) / area;
      const float w1 = ((sx[2] - ndcX) * (sy[0] - ndcY) - (sx[0] - ndcX) * (sy[2] - ndcY)) / area;
      const float w2 = 1.0f - w0 - w1;
      float qx = ndcX, qy = ndcY, d = 0.0f;
      if (w0 < 0.0f || w1 < 0.0f || w2 < 0.0f) {
        /* A tap just off a thin triangle measures to its closest edge, so the
           face stays easy to take without reaching out to its neighbours. */
        const float xs[3] = { sx[0], sx[1], sx[2] };
        const float ys[3] = { sy[0], sy[1], sy[2] };
        d = 1e30f;
        for (uint32_t k = 0; k < 3; ++k) {
          const uint32_t n2 = (k + 1u) % 3u;
          const float ex = xs[n2] - xs[k], ey = ys[n2] - ys[k];
          const float elen2 = ex * ex + ey * ey;
          const float st = elen2 < 1e-12f ? 0.0f : clampf(((ndcX - xs[k]) * ex + (ndcY - ys[k]) * ey) / elen2, 0.0f, 1.0f);
          const float ex2 = xs[k] + ex * st, ey2 = ys[k] + ey * st;
          const float ddx = ex2 - ndcX, ddy = ey2 - ndcY;
          const float dd = ddx * ddx + ddy * ddy;
          if (dd < d) { d = dd; qx = ex2; qy = ey2; }
        }
        if (d > limit) continue;
      }
      /* Depth at the closest point (the tap itself when it is inside). */
      const float b0 = ((sx[1] - qx) * (sy[2] - qy) - (sx[2] - qx) * (sy[1] - qy)) / area;
      const float b1 = ((sx[2] - qx) * (sy[0] - qy) - (sx[0] - qx) * (sy[2] - qy)) / area;
      const float b2 = 1.0f - b0 - b1;
      const float z = b0 * sz[0] + b1 * sz[1] + b2 * sz[2];
      if (occluded(qx, qy, z)) continue;
      if (d < bestDist - 1e-9f || (d <= bestDist + 1e-9f && z < bestDepth)) {
        bestDist = d; bestDepth = z; best = static_cast<int32_t>(t); bestKind = kModeFace;
      }
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
      if (!g_edgeDisplay[e]) continue;
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

/* ---- on-canvas gizmo -----------------------------------------------------
   Projection, picking and the drag maths for the handles drawn at the
   selection: three arrows for translate, three rings for rotate and three
   bars for scale. Screen coordinates are the same normalised pair the picking
   code already takes, (0,0) top-left, and `aspect` is viewport width/height,
   so a handle is as easy to grab on a portrait phone as on a wide window. */

/* Share of the viewport height one handle covers. */
constexpr float kGizmoScreenShare = 0.18f;

bool projectLocal(const float* clip, float x, float y, float z, float& sx, float& sy, float& depth) {
  const float w = clip[3] * x + clip[7] * y + clip[11] * z + clip[15];
  if (w <= 1e-6f) return false;
  sx = ((clip[0] * x + clip[4] * y + clip[8] * z + clip[12]) / w) * 0.5f + 0.5f;
  sy = 1.0f - (((clip[1] * x + clip[5] * y + clip[9] * z + clip[13]) / w) * 0.5f + 0.5f);
  depth = (clip[2] * x + clip[6] * y + clip[10] * z + clip[14]) / w;
  return true;
}

void selectionPivot(float* out) {
  float sx = 0.0f, sy = 0.0f, sz = 0.0f;
  uint32_t n = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    sx += M.x[i]; sy += M.y[i]; sz += M.z[i];
    ++n;
  }
  if (n) {
    out[0] = sx / float(n); out[1] = sy / float(n); out[2] = sz / float(n);
    return;
  }
  /* Nothing selected: the handles sit at the middle of the mesh, which is
     where a first tap is going to land anyway. */
  float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (M.x[i] < mn[0]) mn[0] = M.x[i];
    if (M.y[i] < mn[1]) mn[1] = M.y[i];
    if (M.z[i] < mn[2]) mn[2] = M.z[i];
    if (M.x[i] > mx[0]) mx[0] = M.x[i];
    if (M.y[i] > mx[1]) mx[1] = M.y[i];
    if (M.z[i] > mx[2]) mx[2] = M.z[i];
  }
  if (M.nv == 0) { out[0] = out[1] = out[2] = 0.0f; return; }
  out[0] = (mn[0] + mx[0]) * 0.5f;
  out[1] = (mn[1] + mx[1]) * 0.5f;
  out[2] = (mn[2] + mx[2]) * 0.5f;
}

/* Local units that cover about 18 % of the viewport height at the pivot, so
   the handles keep the same size on screen as the camera pulls back and stay
   big enough to hit with a fingertip. */
float gizmoSize(const float* clip, const float pivot[3]) {
  float px, py, pd;
  if (!projectLocal(clip, pivot[0], pivot[1], pivot[2], px, py, pd)) return 1.0f;
  float best = 0.0f;
  for (int a = 0; a < 3; ++a) {
    float tip[3] = {pivot[0], pivot[1], pivot[2]};
    tip[a] += 1.0f;
    float tx, ty, td;
    if (!projectLocal(clip, tip[0], tip[1], tip[2], tx, ty, td)) continue;
    const float d = fe::sqrtf((tx - px) * (tx - px) + (ty - py) * (ty - py));
    if (d > best) best = d;
  }
  if (best < 1e-6f) return 1.0f;
  return kGizmoScreenShare / best;
}

float pointSegDistance(float ax, float ay, float bx, float by, float px, float py) {
  const float vx = bx - ax, vy = by - ay;
  const float len2 = vx * vx + vy * vy;
  float t = 0.0f;
  if (len2 > 1e-12f) t = ((px - ax) * vx + (py - ay) * vy) / len2;
  t = clampf(t, 0.0f, 1.0f);
  const float dx = ax + vx * t - px, dy = ay + vy * t - py;
  return fe::sqrtf(dx * dx + dy * dy);
}

/* The two local directions perpendicular to an axis, so a rotation ring can be
   sampled in screen space whatever the view orientation is. */
void axisBasis(int32_t axis, float* u, float* v) {
  if (axis == 0) { u[0] = 0.0f; u[1] = 1.0f; u[2] = 0.0f; v[0] = 0.0f; v[1] = 0.0f; v[2] = 1.0f; }
  else if (axis == 1) { u[0] = 0.0f; u[1] = 0.0f; u[2] = 1.0f; v[0] = 1.0f; v[1] = 0.0f; v[2] = 0.0f; }
  else { u[0] = 1.0f; u[1] = 0.0f; u[2] = 0.0f; v[0] = 0.0f; v[1] = 1.0f; v[2] = 0.0f; }
}

/* How far along the handle's axis the pointer sits, in world units. */
float axisParam(const float* clip, float aspect, const float pivot[3], float size,
                int32_t axis, float cx, float cy, float& tipDepth, float& pivotDepth) {
  float px, py, pd, tx, ty, td;
  tipDepth = 0.0f;
  pivotDepth = 0.0f;
  if (!projectLocal(clip, pivot[0], pivot[1], pivot[2], px, py, pd)) return 0.0f;
  float tip[3] = {pivot[0], pivot[1], pivot[2]};
  tip[axis] += size;
  if (!projectLocal(clip, tip[0], tip[1], tip[2], tx, ty, td)) return 0.0f;
  tipDepth = td;
  pivotDepth = pd;
  const float fix = (tx - px) * aspect, fiy = ty - py;
  const float len2 = fix * fix + fiy * fiy;
  if (len2 < 1e-10f) return 0.0f;
  return (((cx - px) * aspect) * fix + (cy - py) * fiy) / len2;
}

int32_t pickGizmo(const float* clip, float cx, float cy, float aspect, float hit, uint32_t space) {
  if (!clip || M.nv == 0) return -1;
  float pivot[3];
  selectionPivot(pivot);
  const float size = gizmoSize(clip, pivot);
  float px, py, pd;
  if (!projectLocal(clip, pivot[0], pivot[1], pivot[2], px, py, pd)) return -1;
  const float ox = px * aspect, oy = py;
  const float mx = cx * aspect, my = cy;
  int32_t best = -1;
  float bestD = hit;
  for (int32_t a = 0; a < 3; ++a) {
    float d;
    if (space == 1u) {
      float u[3], v[3];
      axisBasis(a, u, v);
      float ux, uy, ud, vx, vy, vd;
      float up[3] = {pivot[0] + u[0] * size, pivot[1] + u[1] * size, pivot[2] + u[2] * size};
      float vp[3] = {pivot[0] + v[0] * size, pivot[1] + v[1] * size, pivot[2] + v[2] * size};
      if (!projectLocal(clip, up[0], up[1], up[2], ux, uy, ud)) continue;
      if (!projectLocal(clip, vp[0], vp[1], vp[2], vx, vy, vd)) continue;
      d = 1e30f;
      for (int32_t k = 0; k < 32; ++k) {
        const float t = float(k) * (6.2831853f / 32.0f);
        const float rx = ox + (ux * aspect - ox) * fe::cosf(t) + (vx * aspect - ox) * fe::sinf(t);
        const float ry = oy + (uy - oy) * fe::cosf(t) + (vy - oy) * fe::sinf(t);
        const float ddx = rx - mx, ddy = ry - my;
        const float dd = fe::sqrtf(ddx * ddx + ddy * ddy);
        if (dd < d) d = dd;
      }
    } else {
      float tip[3] = {pivot[0], pivot[1], pivot[2]};
      tip[a] += size;
      float tx, ty, td;
      if (!projectLocal(clip, tip[0], tip[1], tip[2], tx, ty, td)) continue;
      d = pointSegDistance(ox, oy, tx * aspect, ty, mx, my);
    }
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/* Kernel axis codes: move/scale take 1 = X, 2 = Y, 3 = Z; rotate takes
   1 = X, 2 = Y, 0 = Z. */
uint32_t transformAxis(int32_t handle, uint32_t space) {
  if (space == 1u) return handle == 0 ? 1u : handle == 1 ? 2u : 0u;
  return handle == 0 ? 1u : handle == 1 ? 2u : 3u;
}

} // namespace fe_edit

using namespace fe_edit;

extern "C" {

/* ---- lifecycle --------------------------------------------------------- */

FE_EXPORT void fe_edit_reset(void) {
  M.nv = 0;
  M.nt = 0;
  M.fsmoothCount = 0;
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
  g_weldMerged = 0;
  /* The quad pairing is derived from the shape at build time and then kept by
     topology signature, so a tool that only moves vertices does not have to
     re-pair the mesh. A reset is a different mesh: its signature can collide
     with the old one (same triangle table), and then the stale pairing would
     hide a diagonal the new shape does not have. Throw it away here. */
  g_quadBuilt = false;
  g_quadCount = 0;
  g_quadPairCount = 0;
  g_quadSignature = 0u;
  g_grpRingCount = 0;
  g_ngonCount = 0;
  g_declFaces = 0;
  g_declPending = false;
  g_slotFinalCount = 0;
  GZ.active = false;
  GZ.handle = -1;
  g_outVerts = 0;
  g_outIdxCount = 0;
  g_outSplit = 0;
}

/* Which faces the model meant to shade flat, from the normals it arrived with.
   three builds a cube as twenty-four corners whose normals are the six face
   normals, and a sphere as corners whose normals are the smooth surface: a face
   is flat exactly when all three of its corner normals already point the way
   the face itself does. Read before the weld, while the corner normals still
   exist - after it the mesh has one normal per point and the answer is gone. */
void deriveFaceShade(const float* positions, const uint32_t* indices, uint32_t triCount,
                     const float* normals) {
  if (!normals) {
    for (uint32_t t = 0; t < triCount; ++t) M.fsmooth[t] = 1;
    M.smooth = true;
    return;
  }
  bool anySmooth = false, anyFlat = false;
  for (uint32_t t = 0; t < triCount; ++t) {
    const uint32_t a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const float ux = positions[b * 3] - positions[a * 3];
    const float uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const float uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const float vx = positions[c * 3] - positions[a * 3];
    const float vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const float vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    float nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const float len = sqrtf(nx * nx + ny * ny + nz * nz);
    bool flat = len > 1e-20f;
    if (flat) {
      nx /= len; ny /= len; nz /= len;
      const uint32_t corners[3] = {a, b, c};
      for (uint32_t k = 0; k < 3 && flat; ++k) {
        const float dot = nx * normals[corners[k] * 3] + ny * normals[corners[k] * 3 + 1] +
                          nz * normals[corners[k] * 3 + 2];
        if (dot < 0.9995f) flat = false;
      }
    }
    M.fsmooth[t] = flat ? 0 : 1;
    if (flat) anyFlat = true; else anySmooth = true;
  }
  M.smooth = anySmooth;
  (void)anyFlat;
}

FE_EXPORT uint32_t fe_edit_upload(uint32_t vertCount, const float* positions,
                                  uint32_t triCount, const uint32_t* indices,
                                  const float* colors, const float* normals) {
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
  deriveFaceShade(positions, M.tri, triCount, normals);
  M.fsmoothCount = triCount;
  for (uint32_t t = 0; t < M.nt; ++t) M.fsel[t] = 0;
  /* Weld before the edge table exists: an edge list built over duplicates
     would describe a mesh that is not the one being edited. */
  weldVertices();
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

/* Sets the pick radius in NDC units. The app derives it from the viewport
   height and the pointer type, so a fingertip gets ~22 px and a mouse ~11 px of
   slack without the kernel having to know about pixels at all. */
FE_EXPORT void fe_edit_set_pick_tolerance(float tolerance) {
  g_pickTolerance = clampf(tolerance, 0.002f, 0.5f);
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

/* Shade Smooth / Shade Flat. With faces selected in Face mode it applies to
   those faces and leaves the rest of the model alone, which is what makes a
   cylinder round with flat caps; with nothing selected it is the whole mesh. */
FE_EXPORT void fe_edit_set_shade(uint32_t smooth) {
  const uint8_t value = smooth != 0 ? 1u : 0u;
  bool any = false;
  if (g_mode == kModeFace) {
    for (uint32_t t = 0; t < M.nt; ++t) {
      if (!M.fsel[t]) continue;
      M.fsmooth[t] = value;
      any = true;
    }
  }
  if (!any) {
    for (uint32_t t = 0; t < M.nt; ++t) M.fsmooth[t] = value;
  }
  /* The single flag stays as the answer to "is anything here smooth", which is
     what the whole-mesh shading switch and the snapshot's legacy bit read. It
     is derived from the per-face flags rather than set alongside them, so a
     face marked smooth inside a flat cube cannot leave it behind. */
  M.smooth = false;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (!M.fsmooth[t]) continue;
    M.smooth = true;
    break;
  }
  M.fsmoothCount = M.nt;
}

FE_EXPORT uint32_t fe_edit_get_shade(void) { return M.smooth ? 1u : 0u; }

/* 0 = every face flat, 1 = every face smooth, 2 = both. The viewport only needs
   the material's derivative-normal mode for the first case; the split normals
   the render mesh carries cover the other two. */
FE_EXPORT uint32_t fe_edit_shade_state(void) {
  if (M.nt == 0) return 1u;
  bool smoothSeen = false, flatSeen = false;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (faceSmoothFlag(t)) smoothSeen = true; else flatSeen = true;
    if (smoothSeen && flatSeen) return 2u;
  }
  return smoothSeen ? 1u : 0u;
}

/* Restores per-face flags wholesale, for a mesh that already carries them.
   Deriving them from the corner normals cannot work here: the cage the editor
   is handed back has shared vertices and therefore averaged normals, so a cube
   whose faces were marked flat would come back in looking smooth. The flags
   travel with the mesh instead of being inferred from it. */
FE_EXPORT uint32_t fe_edit_upload_face_shade(const uint8_t* flags, uint32_t count) {
  if (!flags || M.nt == 0) return 0;
  const uint32_t n = count < M.nt ? count : M.nt;
  bool anySmooth = false;
  for (uint32_t t = 0; t < M.nt; ++t) {
    M.fsmooth[t] = t < n ? (flags[t] ? 1u : 0u) : 1u;
    if (M.fsmooth[t]) anySmooth = true;
  }
  M.smooth = anySmooth;
  M.fsmoothCount = n;
  return n;
}

/* The per-face flags, one byte per triangle in the mesh's own triangle order:
   what the viewport writes onto the committed geometry so the modifier stack
   and the next session start from the same shading the editor ended on. */
FE_EXPORT const uint8_t* fe_edit_face_shade_ptr(void) { return M.fsmooth; }
FE_EXPORT uint32_t fe_edit_face_shade_count(void) { return M.nt; }

/* The render vertex each welded vertex became, for the shell: committing an
   edit keeps the shared-vertex mesh (that is the cage), so the split normals of
   the render mesh have to be mapped back onto it. */
FE_EXPORT const uint32_t* fe_edit_render_weld_ptr(void) { return g_renderWeld; }
FE_EXPORT uint32_t fe_edit_render_weld_count(void) { return g_outVerts; }

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

FE_EXPORT uint32_t fe_edit_build_render(void) {
  fe_edit::g_forceSplit = false;
  return fe_edit::buildRenderMesh();
}

/* The same render pass with the all-flat shortcut switched off. Committing an
   edit hands the mesh to code that only understands normals, so an all-flat
   cube has to come out of here with its corners broken - otherwise a face the
   user marked flat would be drawn smooth by the next thing that touches it.
   The split still has a budget: past it the mesh falls back to the shared
   vertices, which is the one case where a flat face keeps its look only through
   the material. */
FE_EXPORT uint32_t fe_edit_build_render_split(void) {
  fe_edit::g_forceSplit = true;
  const uint32_t built = fe_edit::buildRenderMesh();
  fe_edit::g_forceSplit = false;
  return built;
}
FE_EXPORT const float* fe_edit_render_pos_ptr(void) { return g_outPos; }
FE_EXPORT const float* fe_edit_render_nrm_ptr(void) { return g_outNrm; }
FE_EXPORT const float* fe_edit_render_col_ptr(void) { return g_outCol; }
FE_EXPORT const uint32_t* fe_edit_render_idx_ptr(void) { return g_outIdx; }
FE_EXPORT uint32_t fe_edit_render_vert_count(void) { return g_outVerts; }
FE_EXPORT uint32_t fe_edit_render_idx_count(void) { return g_outIdxCount; }
FE_EXPORT uint32_t fe_edit_render_split_count(void) { return g_outSplit; }

/* Whether the material can shade the last render mesh by itself: every face is
   flat and every one of them is planar. Answering 0 for an all-flat mesh means
   a face is bent, and the normals the render pass just wrote are the ones to
   use - a derivative normal would draw the diagonal that face does not have. */
FE_EXPORT uint32_t fe_edit_flat_planar(void) { return g_flatPlanar ? 1u : 0u; }

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

/* ---- Edit Mode display masks and the on-canvas gizmo ------------------- */

FE_EXPORT uint32_t fe_edit_weld_count(void) { return g_weldMerged; }
FE_EXPORT const uint8_t* fe_edit_edge_display_ptr(void) { return g_edgeDisplay; }

/* The edges *inside* a face, as vertex index pairs: a quad's diagonal, the
   spokes a fan draws from the middle of an n-gon cap. The shell draws Wireframe
   shading in Object Mode from the object's own geometry, and the kernel draws
   the same cage in Edit Mode; handing these over means the two agree by
   construction instead of by two implementations of the same guess, and it
   survives the deformations that make a guess wrong (a bent quad still has the
   diagonal it was drawn with). */
FE_EXPORT const uint32_t* fe_edit_interior_pairs_ptr(void) {
  g_quadPairCount = 0;
  for (uint32_t e = 0; e < E.n && g_quadPairCount < kMaxEdges; ++e) {
    if (E.f0[e] == kNoFace || E.f1[e] == kNoFace) continue;
    const uint32_t g = g_quadOf[E.f0[e]];
    if (g == kNoFace || g != g_quadOf[E.f1[e]]) continue;
    g_quadPairs[g_quadPairCount * 2u] = E.a[e];
    g_quadPairs[g_quadPairCount * 2u + 1u] = E.b[e];
    ++g_quadPairCount;
  }
  return g_quadPairs;
}

/* Reads the pairing, so it is correct whichever call comes first. */
FE_EXPORT uint32_t fe_edit_interior_pair_count(void) {
  fe_edit_interior_pairs_ptr();
  return g_quadPairCount;
}

/* The older name for the same thing: when every face was a quad, the hidden
   edges were exactly the diagonals. Kept because the shell and the tests read
   it. */
FE_EXPORT const uint32_t* fe_edit_quad_pairs_ptr(void) { return fe_edit_interior_pairs_ptr(); }
FE_EXPORT uint32_t fe_edit_quad_pair_count(void) { return fe_edit_interior_pair_count(); }

/* ---- faces -------------------------------------------------------------- */

/* The faces the app knows about, declared as corner rings. A ring is the
   boundary of one face in the geometry's own vertex numbering: four corners
   for a quad, thirty-two for a cylinder cap, three for a triangle. The kernel
   claims the triangles inside each ring and draws them as one face - which is
   what makes an n-gon possible at all, because a triangle buffer cannot say
   "these thirty-two triangles were one face" any other way.

   `starts` is faceCount + 1 offsets into `corners`; corners are upload vertex
   slots, translated through the weld so a face may name any of three's split
   corners. Returns 1 when the faces were taken, 0 when they were not (an empty
   mesh, a malformed ring, more faces than the kernel holds): a caller that
   gets 0 still has a mesh, it just gets the shape's own hints instead. */
FE_EXPORT uint32_t fe_edit_set_faces(uint32_t faceCount, const uint32_t* starts, const uint32_t* corners) {
  if (!starts || !corners) return 0;
  if (faceCount == 0 || faceCount > kMaxDeclFaces) return 0;
  if (g_slotFinalCount < 3 || g_slotFinalCount > kMaxVerts) return 0;
  if (M.nt == 0) return 0;
  uint32_t total = 0;
  uint32_t faces = 0;
  for (uint32_t f = 0; f < faceCount; ++f) {
    if (starts[f + 1] <= starts[f]) return 0;
    const uint32_t n = starts[f + 1] - starts[f];
    if (n < 3) continue;
    /* A ring too large for the projection buffer is one face the mesh loses,
       not a reason to lose the declaration: the shell would fall back to the
       shape's hints for *every* face, which is a far bigger change than the one
       face this skips. */
    if (n > kMaxRingCorners) continue;
    uint32_t prev = kNoFace;
    uint32_t first = kNoFace;
    uint32_t kept = 0;
    bool overflow = false;
    for (uint32_t i = 0; i < n; ++i) {
      const uint32_t slot = corners[starts[f] + i];
      if (slot >= g_slotFinalCount) return 0;
      const uint32_t v = g_slotFinal[slot];
      if (v == kNoFace || v == prev) continue;
      if (kept == 0) first = v;
      if (total >= kMaxDeclCorners) { overflow = true; break; }
      g_declRing[total++] = v;
      prev = v;
      ++kept;
    }
    /* A ring that did not fit is dropped whole: half a polygon is not a face. */
    if (overflow) { total -= kept; continue; }
    /* A ring closes: the last corner may not repeat the first one. */
    if (kept > 1 && g_declRing[total - 1] == first) { --total; --kept; }
    /* A ring the weld flattened is not a face: three builds a cone's side as a
       quad whose top edge has no length, and the half of it that collapsed is
       the half the kernel already dropped. Skipping it is the same decision
       the weld made; failing the whole call over it would cost the mesh every
       other face it declared. */
    if (kept < 3) { total -= kept; continue; }
    g_declStart[faces + 1] = total;
    ++faces;
  }
  if (faces == 0) return 0;
  g_declStart[0] = 0;
  g_declFaces = faces;
  g_declPending = true;
  g_quadBuilt = false;
  g_quadSignature = 0u;
  buildQuadGroups();
  return 1;
}

/* What Edit Mode draws as one face. */
FE_EXPORT uint32_t fe_edit_face_count(void) { return g_quadCount; }
/* Faces with more than four corners: the n-gons a triangle buffer cannot
   describe on its own. */
FE_EXPORT uint32_t fe_edit_ngon_count(void) { return g_ngonCount; }
/* The corner rings, flattened: face f owns corners
   [faceStart[f], faceStart[f + 1]). */
FE_EXPORT uint32_t fe_edit_face_ring_count(void) { return g_grpRingCount; }
FE_EXPORT const uint32_t* fe_edit_face_start_ptr(void) { return g_grpStart; }
FE_EXPORT const uint32_t* fe_edit_face_ring_ptr(void) { return g_grpRing; }

FE_EXPORT void fe_edit_set_display_angle(float degrees) {
  g_displayAngle = clampf(degrees, 0.0f, 180.0f);
  rebuildEdges();
}

/* Whether a mesh that arrived with split vertices was authored smooth or
   faceted. Coincident vertices that carry the same normal were smooth; the
   ones that do not were a hard surface, and the edit mesh must go on shading
   it that way or a cube turns into a ball the moment it is edited. */
FE_EXPORT uint32_t fe_edit_detect_smooth(const float* positions, const float* normals, uint32_t count) {
  if (!positions || !normals || count == 0 || count > kMaxVerts) return 1;
  const float eps = 1.0e-5f;
  const float inv = 1.0f / eps;
  for (uint32_t i = 0; i < kHashSize; ++i) g_hash[i] = 0;
  for (uint32_t v = 0; v < count; ++v) {
    const int32_t cx = static_cast<int32_t>(fe::floorf(positions[v * 3] * inv));
    const int32_t cy = static_cast<int32_t>(fe::floorf(positions[v * 3 + 1] * inv));
    const int32_t cz = static_cast<int32_t>(fe::floorf(positions[v * 3 + 2] * inv));
    uint32_t slot = (static_cast<uint32_t>(cx) * 73856093u) ^
                    (static_cast<uint32_t>(cy) * 19349663u) ^
                    (static_cast<uint32_t>(cz) * 83492791u);
    slot &= (kHashSize - 1u);
    for (;;) {
      const uint32_t entry = g_hash[slot];
      if (entry == 0) { g_hash[slot] = v + 1; break; }
      const uint32_t u = entry - 1;
      const int32_t ux = static_cast<int32_t>(fe::floorf(positions[u * 3] * inv));
      const int32_t uy = static_cast<int32_t>(fe::floorf(positions[u * 3 + 1] * inv));
      const int32_t uz = static_cast<int32_t>(fe::floorf(positions[u * 3 + 2] * inv));
      if (ux == cx && uy == cy && uz == cz) {
        const float d = normals[u * 3] * normals[v * 3] +
                        normals[u * 3 + 1] * normals[v * 3 + 1] +
                        normals[u * 3 + 2] * normals[v * 3 + 2];
        if (d < 0.999f) return 0;
        break;
      }
      slot = (slot + 1) & (kHashSize - 1u);
    }
  }
  return 1;
}

FE_EXPORT uint32_t fe_edit_gizmo_pivot(float* out) {
  if (!out) return 0;
  selectionPivot(out);
  uint32_t n = 0;
  for (uint32_t i = 0; i < M.nv; ++i) if (M.vsel[i]) ++n;
  return n;
}

FE_EXPORT float fe_edit_gizmo_size(const float* clip) {
  if (!clip) return 1.0f;
  float pivot[3];
  selectionPivot(pivot);
  return gizmoSize(clip, pivot);
}

FE_EXPORT int32_t fe_edit_gizmo_pick(const float* clip, float cx, float cy, float aspect,
                                     float hit, uint32_t space) {
  return pickGizmo(clip, cx, cy, aspect, hit, space);
}

FE_EXPORT int32_t fe_edit_gizmo_begin(const float* clip, float cx, float cy, float aspect,
                                      float hit, uint32_t space) {
  const int32_t handle = pickGizmo(clip, cx, cy, aspect, hit, space);
  GZ.active = false;
  GZ.handle = handle;
  if (handle < 0) return -1;
  GZ.space = space > 2u ? 0u : space;
  selectionPivot(GZ.pivot);
  GZ.size = gizmoSize(clip, GZ.pivot);
  GZ.startX = cx;
  GZ.startY = cy;
  GZ.applied = 0.0f;
  float tipDepth = 0.0f, pivotDepth = 0.0f;
  GZ.startT = axisParam(clip, aspect, GZ.pivot, GZ.size, handle, cx, cy, tipDepth, pivotDepth);
  float px, py, pd;
  projectLocal(clip, GZ.pivot[0], GZ.pivot[1], GZ.pivot[2], px, py, pd);
  const float mx = cx * aspect - px * aspect, my = cy - py;
  GZ.startAngle = fe::atan2f(my, mx);
  GZ.startDist = fe::sqrtf(mx * mx + my * my);
  if (GZ.startDist < 1e-4f) GZ.startDist = 1e-4f;
  /* Which way the handle points relative to the eye decides the sign of a
     rotation: positive about an axis looks counter-clockwise from its tip. */
  GZ.startDist = (tipDepth < pivotDepth) ? -GZ.startDist : GZ.startDist;
  GZ.active = true;
  return handle;
}

/* Applies the drag to the selection and reports what it did:
   out[0] accumulated value, out[1] handle, out[2] space. */
FE_EXPORT int32_t fe_edit_gizmo_drag(const float* clip, float cx, float cy, float aspect, float* out) {
  if (!GZ.active || GZ.handle < 0 || !clip || M.nv == 0) return -1;
  float px, py, pd;
  projectLocal(clip, GZ.pivot[0], GZ.pivot[1], GZ.pivot[2], px, py, pd);
  const float mx = cx * aspect - px * aspect, my = cy - py;
  const uint32_t axis = transformAxis(GZ.handle, GZ.space);
  if (GZ.space == 0u) {
    float tipDepth = 0.0f, pivotDepth = 0.0f;
    const float t = axisParam(clip, aspect, GZ.pivot, GZ.size, GZ.handle, cx, cy, tipDepth, pivotDepth);
    const float world = (t - GZ.startT) * GZ.size;
    const float step = world - GZ.applied;
    float d[3] = {0.0f, 0.0f, 0.0f};
    d[GZ.handle] = step;
    if (step != 0.0f) fe_edit_move(d[0], d[1], d[2], axis);
    GZ.applied = world;
    if (out) { out[0] = world; out[1] = float(GZ.handle); out[2] = float(GZ.space); }
    return GZ.handle;
  }
  if (GZ.space == 1u) {
    const float angle = fe::atan2f(my, mx);
    float delta = (angle - GZ.startAngle) * 57.2957795f;
    while (delta > 180.0f) delta -= 360.0f;
    while (delta < -180.0f) delta += 360.0f;
    /* The stored start distance carries the sign of the axis direction. */
    const float signedDelta = GZ.startDist < 0.0f ? -delta : delta;
    const float step = signedDelta - GZ.applied;
    if (step != 0.0f) fe_edit_rotate(step, axis);
    GZ.applied = signedDelta;
    if (out) { out[0] = signedDelta; out[1] = float(GZ.handle); out[2] = float(GZ.space); }
    return GZ.handle;
  }
  float factor = fe::sqrtf(mx * mx + my * my) / (GZ.startDist < 0.0f ? -GZ.startDist : GZ.startDist);
  factor = clampf(factor, 0.01f, 100.0f);
  const float step = factor / (GZ.applied > 0.0f ? GZ.applied : 1.0f);
  if (step != 1.0f) fe_edit_scale(step, step, step, axis);
  GZ.applied = factor;
  if (out) { out[0] = factor; out[1] = float(GZ.handle); out[2] = float(GZ.space); }
  return GZ.handle;
}

FE_EXPORT void fe_edit_gizmo_end(void) {
  GZ.active = false;
  GZ.handle = -1;
  GZ.applied = 0.0f;
}

FE_EXPORT int32_t fe_edit_gizmo_active(void) { return GZ.active ? GZ.handle : -1; }

} // extern "C"
