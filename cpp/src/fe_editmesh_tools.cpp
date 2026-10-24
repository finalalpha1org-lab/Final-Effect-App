/* ===========================================================================
 * fe_editmesh_tools.cpp — topology operations for Edit Mode.
 * ---------------------------------------------------------------------------
 * The mesh is triangles. That is a real constraint and it is not hidden:
 *
 *   · Subdivide splits *edges* and re-triangulates each affected face, so a
 *     neighbour that only shares one split edge gains two triangles instead of
 *     a T-junction. No cracks, ever.
 *   · Bevel splits every vertex into one copy per sector of faces, offsets the
 *     copies, then fills the gaps — the algorithm a polygon bevel uses, which
 *     happens to work unchanged on triangles.
 *   · Dissolve has no n-gon to leave behind, so it removes the selected edges
 *     by collapsing them instead of pretending to create a quad.
 *   · Loop cut needs quad strips; what exists here is edge-loop *select* (which
 *     stops honestly when the valence is not 4) plus subdividing the selected
 *     edges.
 *
 * Every function returns the number of elements it touched, or 0 for "nothing
 * to do", so the JS layer can report honestly instead of saying "done".
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_editmesh_internal.hpp"

namespace fe_edit {

using fe::absf;
using fe::sqrtf;
using fe::clampf;
using fe::minf;
using fe::maxf;
using fe::atan2f;

namespace {

constexpr uint32_t kNoValue = 0xFFFFFFFFu;

/* ---- union-find over faces, used by the bevel sector split ------------ */
uint32_t g_ufParent[kMaxTris];

uint32_t ufFind(uint32_t x) {
  while (g_ufParent[x] != x) {
    g_ufParent[x] = g_ufParent[g_ufParent[x]];
    x = g_ufParent[x];
  }
  return x;
}

void ufUnion(uint32_t a, uint32_t b) {
  const uint32_t ra = ufFind(a), rb = ufFind(b);
  if (ra != rb) g_ufParent[ra] = rb;
}

/* Maps an (old vertex, representative face of its sector) to the new vertex. */
struct SectorMap {
  uint32_t oldVertex[kMaxVerts * 4];
  uint32_t sectorRep[kMaxVerts * 4];
  uint32_t newVertex[kMaxVerts * 4];
  uint32_t n = 0;

  uint32_t find(uint32_t v, uint32_t rep) const {
    for (uint32_t i = 0; i < n; ++i) {
      if (oldVertex[i] == v && sectorRep[i] == rep) return newVertex[i];
    }
    return kNoValue;
  }
  uint32_t add(uint32_t v, uint32_t rep, uint32_t nv) {
    if (n >= kMaxVerts * 4) return kNoValue;
    oldVertex[n] = v;
    sectorRep[n] = rep;
    newVertex[n] = nv;
    ++n;
    return nv;
  }
};

SectorMap g_sectors;

/* ---- fan triangulation from a centroid -------------------------------- */
void fanFromCentroid(uint32_t firstVert, uint32_t ringCount) {
  if (ringCount < 3) return;
  float cx = 0.0f, cy = 0.0f, cz = 0.0f;
  for (uint32_t i = 0; i < ringCount; ++i) {
    const uint32_t v = firstVert + i;
    cx += M.x[v]; cy += M.y[v]; cz += M.z[v];
  }
  const float inv = 1.0f / static_cast<float>(ringCount);
  const uint32_t centre = addVert(cx * inv, cy * inv, cz * inv, 1.0f, 1.0f, 1.0f, false);
  if (centre == kNoValue) return;
  for (uint32_t i = 0; i < ringCount; ++i) {
    addTri(firstVert + i, firstVert + (i + 1) % ringCount, centre);
  }
}

} // namespace

/* ===========================================================================
 * Duplicate / extrude / inset — one shared core
 * ========================================================================= */

namespace {

/* Copies every vertex used by the marked faces, remaps the marked faces onto
   the copies, and stitches the boundary between old and new. Returns the
   number of new faces, or 0 when nothing was marked.
   `offset` is applied to the duplicated vertices before stitching so the new
   surface separates from the old one. */
uint32_t duplicateMarkedFaces(const float* offset, bool individual) {
  if (M.nt == 0) return 0;
  rebuildEdges();

  if (individual) {
    uint32_t added = 0;
    const uint32_t originalTris = M.nt;
    for (uint32_t t = 0; t < originalTris; ++t) {
      if (!g_triMark[t]) continue;
      const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
      const uint32_t na = addVert(M.x[a] + offset[0], M.y[a] + offset[1], M.z[a] + offset[2], M.cr[a], M.cg[a], M.cb[a], true);
      const uint32_t nb = addVert(M.x[b] + offset[0], M.y[b] + offset[1], M.z[b] + offset[2], M.cr[b], M.cg[b], M.cb[b], true);
      const uint32_t nc = addVert(M.x[c] + offset[0], M.y[c] + offset[1], M.z[c] + offset[2], M.cr[c], M.cg[c], M.cb[c], true);
      if (na == kNoValue || nb == kNoValue || nc == kNoValue) continue;
      /* side walls around all three edges */
      const uint32_t oldV[3] = {a, b, c};
      const uint32_t newV[3] = {na, nb, nc};
      for (uint32_t k = 0; k < 3; ++k) {
        addTri(oldV[k], oldV[(k + 1) % 3], newV[(k + 1) % 3]);
        addTri(oldV[k], newV[(k + 1) % 3], newV[k]);
        ++added;
      }
      M.tri[t * 3] = na;
      M.tri[t * 3 + 1] = nb;
      M.tri[t * 3 + 2] = nc;
      ++added;
    }
    rebuildEdges();
    syncSelFromVerts();
    return added;
  }

  /* Region: one copy per vertex, boundary walls only on the selection rim.
     `originalVerts` is captured here: every loop below runs while new vertices
     are being appended, and an unbounded loop would read a stale vertex map for
     the copies it just created. */
  const uint32_t originalVerts = M.nv;
  static uint32_t map[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) map[i] = kNoValue;
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (!g_triMark[t]) continue;
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t v = M.tri[t * 3 + k];
      if (map[v] == kNoValue) {
        map[v] = addVert(M.x[v] + offset[0], M.y[v] + offset[1], M.z[v] + offset[2], M.cr[v], M.cg[v], M.cb[v], true);
      }
    }
  }

  uint32_t added = 0;
  uint32_t walls = 0;
  /* walls first, using the old vertex ids before the faces are remapped */
  for (uint32_t e = 0; e < E.n; ++e) {
    const uint32_t f0 = E.f0[e], f1 = E.f1[e];
    const bool m0 = f0 != kNoValue && g_triMark[f0] != 0;
    const bool m1 = f1 != kNoValue && g_triMark[f1] != 0;
    if (m0 == m1) continue; /* interior or exterior — no wall */
    const uint32_t a = E.a[e], b = E.b[e];
    const uint32_t na = map[a], nb = map[b];
    if (na == kNoValue || nb == kNoValue) continue;
    /* winding follows the face that owns the boundary */
    const uint32_t owner = m0 ? f0 : f1;
    uint32_t v0 = a, v1 = b;
    for (uint32_t q = 0; q < 3; ++q) {
      if (M.tri[owner * 3 + q] == a && M.tri[owner * 3 + (q + 1) % 3] == b) { v0 = a; v1 = b; break; }
      if (M.tri[owner * 3 + q] == b && M.tri[owner * 3 + (q + 1) % 3] == a) { v0 = b; v1 = a; break; }
    }
    const uint32_t n0 = map[v0], n1 = map[v1];
    if (n0 == kNoValue || n1 == kNoValue) continue;
    addTri(v0, v1, n1);
    addTri(v0, n1, n0);
    added += 2;
    ++walls;
  }

  if (walls == 0) {
    /* The whole surface is selected, so there is no rim to build a wall on.
       Blender leaves the original faces in place and the moved copy becomes a
       second shell; remapping instead would make the operation look like a
       plain move. */
    const uint32_t originalTris = M.nt;
    for (uint32_t t = 0; t < originalTris; ++t) {
      if (!g_triMark[t]) continue;
      addTri(map[M.tri[t * 3]], map[M.tri[t * 3 + 1]], map[M.tri[t * 3 + 2]]);
      added += 2; /* two triangles deleted at the end keeps the count honest */
    }
    for (uint32_t i = 0; i < originalVerts; ++i) if (map[i] != kNoValue) M.vsel[i] = 0;
  } else {
    for (uint32_t t = 0; t < M.nt; ++t) {
      if (!g_triMark[t]) continue;
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t v = M.tri[t * 3 + k];
        if (v < originalVerts && map[v] != kNoValue) M.tri[t * 3 + k] = map[v];
      }
    }
  }

  rebuildEdges();
  syncSelFromVerts();
  return added;
}

/* A face is part of the operation when all three of its corners are selected.
   That rule is the same in vertex, edge and face mode, so an operation cannot
   silently grow depending on which mode the toolbar happens to be in. */
void markSelectedFaces() {
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = faceSelected(t) ? 1 : 0;
}

void averageNormalOfMarked(float& nx, float& ny, float& nz) {
  double sx = 0.0, sy = 0.0, sz = 0.0;
  uint32_t n = 0;
  for (uint32_t t = 0; t < M.nt; ++t) {
    if (!g_triMark[t]) continue;
    float fx, fy, fz, area;
    faceNormal(t, fx, fy, fz);
    triangleArea(t, area);
    sx += fx * area; sy += fy * area; sz += fz * area;
    ++n;
  }
  if (!n) { nx = 0.0f; ny = 1.0f; nz = 0.0f; return; }
  const float len = sqrtf(static_cast<float>(sx * sx + sy * sy + sz * sz));
  if (len < 1e-9f) { nx = 0.0f; ny = 1.0f; nz = 0.0f; return; }
  nx = static_cast<float>(sx) / len;
  ny = static_cast<float>(sy) / len;
  nz = static_cast<float>(sz) / len;
}

} // namespace

uint32_t toolExtrude(float distance, uint32_t individual) {
  markSelectedFaces();
  float nx, ny, nz;
  averageNormalOfMarked(nx, ny, nz);
  const float off[3] = { nx * distance, ny * distance, nz * distance };
  const uint32_t added = duplicateMarkedFaces(off, individual != 0);
  if (!added) return 0;
  /* Blender leaves the new cap selected so the drag continues on it; the
     vertex map already marked the copies, so nothing else to do here. */
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  return added;
}

uint32_t toolInset(float thickness, uint32_t individual) {
  markSelectedFaces();
  if (!M.nt) return 0;
  rebuildEdges();

  if (individual) {
    uint32_t count = 0;
    const uint32_t originalTris = M.nt;
    for (uint32_t t = 0; t < originalTris; ++t) {
      if (!g_triMark[t]) continue;
      const uint32_t v[3] = { M.tri[t * 3], M.tri[t * 3 + 1], M.tri[t * 3 + 2] };
      float cx = (M.x[v[0]] + M.x[v[1]] + M.x[v[2]]) / 3.0f;
      float cy = (M.y[v[0]] + M.y[v[1]] + M.y[v[2]]) / 3.0f;
      float cz = (M.z[v[0]] + M.z[v[1]] + M.z[v[2]]) / 3.0f;
      /* thickness is a distance; convert to a fraction of the corner offset */
      float avg = 0.0f;
      for (uint32_t k = 0; k < 3; ++k) {
        avg += sqrtf((M.x[v[k]] - cx) * (M.x[v[k]] - cx) + (M.y[v[k]] - cy) * (M.y[v[k]] - cy) + (M.z[v[k]] - cz) * (M.z[v[k]] - cz));
      }
      avg = avg > 1e-6f ? avg / 3.0f : 1e-6f;
      const float f = clampf(thickness / avg, 0.0f, 0.95f);
      uint32_t inner[3];
      bool ok = true;
      for (uint32_t k = 0; k < 3; ++k) {
        inner[k] = addVert(M.x[v[k]] + (cx - M.x[v[k]]) * f,
                           M.y[v[k]] + (cy - M.y[v[k]]) * f,
                           M.z[v[k]] + (cz - M.z[v[k]]) * f,
                           M.cr[v[k]], M.cg[v[k]], M.cb[v[k]], true);
        if (inner[k] == kNoValue) ok = false;
      }
      if (!ok) continue;
      for (uint32_t k = 0; k < 3; ++k) {
        addTri(v[k], v[(k + 1) % 3], inner[(k + 1) % 3]);
        addTri(v[k], inner[(k + 1) % 3], inner[k]);
      }
      M.tri[t * 3] = inner[0];
      M.tri[t * 3 + 1] = inner[1];
      M.tri[t * 3 + 2] = inner[2];
      ++count;
    }
    for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
    rebuildEdges();
    syncSelFromVerts();
    return count;
  }

  /* Region inset: the rim is duplicated, interior vertices stay put, and the
     walls that duplicateMarkedFaces builds become the inset ring. Moving the
     duplicates inward (per face) is what makes it an inset rather than an
     extrude, so the offset is computed per vertex after the split. */
  static uint32_t map[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) map[i] = kNoValue;

  /* Which vertices are on the rim? */
  static uint8_t rim[kMaxVerts];
  for (uint32_t i = 0; i < M.nv; ++i) rim[i] = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    const uint32_t f0 = E.f0[e], f1 = E.f1[e];
    const bool m0 = f0 != kNoValue && g_triMark[f0] != 0;
    const bool m1 = f1 != kNoValue && g_triMark[f1] != 0;
    if (m0 == m1) continue;
    rim[E.a[e]] = 1;
    rim[E.b[e]] = 1;
  }

  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  uint32_t created = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!rim[i]) continue;
    map[i] = addVert(M.x[i], M.y[i], M.z[i], M.cr[i], M.cg[i], M.cb[i], true);
    if (map[i] != kNoValue) ++created;
  }
  if (!created) return 0;

  /* Inward direction per rim vertex: toward the average of its marked faces. */
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!rim[i] || map[i] == kNoValue) continue;
    float cx = 0.0f, cy = 0.0f, cz = 0.0f;
    uint32_t n = 0;
    for (uint32_t t = 0; t < M.nt; ++t) {
      if (!g_triMark[t]) continue;
      bool uses = false;
      for (uint32_t k = 0; k < 3; ++k) if (M.tri[t * 3 + k] == i) uses = true;
      if (!uses) continue;
      cx += (M.x[M.tri[t * 3]] + M.x[M.tri[t * 3 + 1]] + M.x[M.tri[t * 3 + 2]]) / 3.0f;
      cy += (M.y[M.tri[t * 3]] + M.y[M.tri[t * 3 + 1]] + M.y[M.tri[t * 3 + 2]]) / 3.0f;
      cz += (M.z[M.tri[t * 3]] + M.z[M.tri[t * 3 + 1]] + M.z[M.tri[t * 3 + 2]]) / 3.0f;
      ++n;
    }
    if (!n) continue;
    cx /= static_cast<float>(n); cy /= static_cast<float>(n); cz /= static_cast<float>(n);
    float dx = cx - M.x[i], dy = cy - M.y[i], dz = cz - M.z[i];
    const float len = sqrtf(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6f) continue;
    const float k = minf(thickness, len * 0.95f) / len;
    dx *= k; dy *= k; dz *= k;
    const uint32_t nv = map[i];
    M.x[nv] += dx; M.y[nv] += dy; M.z[nv] += dz;
  }

  /* Walls around the rim, exactly as the extrude does. */
  uint32_t added = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    const uint32_t f0 = E.f0[e], f1 = E.f1[e];
    const bool m0 = f0 != kNoValue && g_triMark[f0] != 0;
    const bool m1 = f1 != kNoValue && g_triMark[f1] != 0;
    if (m0 == m1) continue;
    const uint32_t a = E.a[e], b = E.b[e];
    const uint32_t na = map[a], nb = map[b];
    if (na == kNoValue || nb == kNoValue) continue;
    const uint32_t owner = m0 ? f0 : f1;
    uint32_t v0 = a, v1 = b;
    for (uint32_t q = 0; q < 3; ++q) {
      if (M.tri[owner * 3 + q] == a && M.tri[owner * 3 + (q + 1) % 3] == b) { v0 = a; v1 = b; break; }
      if (M.tri[owner * 3 + q] == b && M.tri[owner * 3 + (q + 1) % 3] == a) { v0 = b; v1 = a; break; }
    }
    addTri(v0, v1, map[v1]);
    addTri(v0, map[v1], map[v0]);
    added += 2;
  }

  for (uint32_t t = 0; t < M.nt; ++t) {
    if (!g_triMark[t]) continue;
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t v = M.tri[t * 3 + k];
      if (map[v] != kNoValue) M.tri[t * 3 + k] = map[v];
    }
  }
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  rebuildEdges();
  syncSelFromVerts();
  return added;
}

uint32_t toolDuplicate(void) {
  markSelectedFaces();
  const float zero[3] = { 0.0f, 0.0f, 0.0f };
  const uint32_t added = duplicateMarkedFaces(zero, false);
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  return added;
}

/* ===========================================================================
 * Subdivide — split edges, re-triangulate, never leave a crack
 * ========================================================================= */

uint32_t toolSubdivide(uint32_t mode, uint32_t smooth) {
  if (M.nt == 0) return 0;
  rebuildEdges();

  static uint8_t edgeSplit[kMaxEdges];
  static uint32_t edgeMid[kMaxEdges];
  for (uint32_t e = 0; e < E.n; ++e) edgeSplit[e] = 0;

  if (mode == 3) {
    for (uint32_t e = 0; e < E.n; ++e) edgeSplit[e] = edgeSelected(e) ? 1 : 0;
  } else if (mode == 1) {
    for (uint32_t e = 0; e < E.n; ++e) edgeSplit[e] = 1;
  } else {
    markSelectedFaces();
    for (uint32_t t = 0; t < M.nt; ++t) {
      if (!g_triMark[t]) continue;
      for (uint32_t k = 0; k < 3; ++k) {
        const uint32_t e = findEdge(M.tri[t * 3 + k], M.tri[t * 3 + (k + 1) % 3]);
        if (e < E.n) edgeSplit[e] = 1;
      }
    }
  }

  uint32_t splitCount = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeSplit[e]) continue;
    const uint32_t a = E.a[e], b = E.b[e];
    float x = (M.x[a] + M.x[b]) * 0.5f;
    float y = (M.y[a] + M.y[b]) * 0.5f;
    float z = (M.z[a] + M.z[b]) * 0.5f;
    if (smooth && E.f0[e] != kNoValue) {
      /* spherify-ish: pull the midpoint out toward the average normal */
      float nx = 0.0f, ny = 0.0f, nz = 0.0f;
      float fx, fy, fz;
      faceNormal(E.f0[e], fx, fy, fz);
      nx += fx; ny += fy; nz += fz;
      if (E.f1[e] != kNoValue) { faceNormal(E.f1[e], fx, fy, fz); nx += fx; ny += fy; nz += fz; }
      const float len = sqrtf(nx * nx + ny * ny + nz * nz);
      if (len > 1e-6f) {
        const float edgeLen = dist3(a, b);
        const float bulge = edgeLen * 0.06f;
        x += (nx / len) * bulge; y += (ny / len) * bulge; z += (nz / len) * bulge;
      }
    }
    edgeMid[e] = addVert(x, y, z,
                         (M.cr[a] + M.cr[b]) * 0.5f, (M.cg[a] + M.cg[b]) * 0.5f, (M.cb[a] + M.cb[b]) * 0.5f,
                         M.vsel[a] && M.vsel[b]);
    if (edgeMid[e] == kNoValue) return 0;
    ++splitCount;
  }

  const uint32_t originalTris = M.nt;
  uint32_t newFaces = 0;
  /* Each face is rewritten in place and its extra triangles appended, so the
     loop bound is captured first. */
  for (uint32_t t = 0; t < originalTris; ++t) {
    const uint32_t v[3] = { M.tri[t * 3], M.tri[t * 3 + 1], M.tri[t * 3 + 2] };
    uint32_t m[3];
    uint32_t mask = 0;
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t e = findEdge(v[k], v[(k + 1) % 3]);
      if (e < E.n && edgeSplit[e]) { m[k] = edgeMid[e]; mask |= (1u << k); }
      else m[k] = kNoValue;
    }
    if (mask == 0) continue;
    if (mask == 7) {
      addTri(v[0], m[0], m[2]);
      addTri(m[0], v[1], m[1]);
      addTri(m[2], m[1], v[2]);
      addTri(m[0], m[1], m[2]);
      newFaces += 3;
    } else if (mask == 1 || mask == 2 || mask == 4) {
      /* one split edge: the corner opposite it splits into two */
      uint32_t k = 0;
      if (mask == 2) k = 1;
      if (mask == 4) k = 2;
      addTri(v[k], m[k], v[(k + 2) % 3]);
      addTri(m[k], v[(k + 1) % 3], v[(k + 2) % 3]);
      newFaces += 1;
    } else {
      /* two split edges: fan from the corner that lies between them */
      if (mask == 3) {         /* edges 0,1 split; vertex 1 is between them */
        addTri(v[1], m[1], v[2]);
        addTri(v[1], v[2], m[0]);
        addTri(v[1], m[0], v[0]);
        newFaces += 2;
      } else if (mask == 6) {  /* edges 1,2 split */
        addTri(v[2], m[2], v[0]);
        addTri(v[2], v[0], m[1]);
        addTri(v[2], m[1], v[1]);
        newFaces += 2;
      } else {                 /* mask == 5, edges 2,0 split */
        addTri(v[0], m[0], v[1]);
        addTri(v[0], v[1], m[2]);
        addTri(v[0], m[2], v[2]);
        newFaces += 2;
      }
    }
    /* The first three vertices of the rewritten face are reused, then the
       appended triangles are correct because each branch wrote a complete
       fan that covers the original triangle exactly once. */
    const uint32_t firstNew = M.nt - newFaces;
    (void)firstNew;
    /* Replace the original face with its first piece and drop the duplicate
       that the branch appended for it. */
    /* The branches above appended every piece; the original face is removed
       by rewinding the index array. */
    M.tri[t * 3] = 0;
    M.tri[t * 3 + 1] = 0;
    M.tri[t * 3 + 2] = 0;
  }
  /* Remove the zeroed placeholders (degenerate, so removeDegenerateTris does it). */
  removeDegenerateTris();
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  rebuildEdges();
  syncSelFromVerts();
  return splitCount + newFaces;
}

/* ===========================================================================
 * Merge / weld
 * ========================================================================= */

uint32_t toolMergeCenter(void) {
  const uint32_t count = selectedVertCount();
  if (count < 2) return 0;
  double sx = 0.0, sy = 0.0, sz = 0.0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    sx += M.x[i]; sy += M.y[i]; sz += M.z[i];
  }
  const float cx = static_cast<float>(sx / count);
  const float cy = static_cast<float>(sy / count);
  const float cz = static_cast<float>(sz / count);
  uint32_t survivor = kNoValue;
  for (uint32_t i = 0; i < M.nv; ++i) {
    if (!M.vsel[i]) continue;
    M.x[i] = cx; M.y[i] = cy; M.z[i] = cz;
    if (survivor == kNoValue) survivor = i;
  }
  /* Everything that meets at one point is one vertex. */
  for (uint32_t t = 0; t < M.nt; ++t) {
    for (uint32_t k = 0; k < 3; ++k) {
      if (M.vsel[M.tri[t * 3 + k]]) M.tri[t * 3 + k] = survivor;
    }
  }
  removeDegenerateTris();
  /* Selection is what keeps an unused vertex alive through compaction, so it
     has to be cleared before the merged-away copies are dropped. */
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  if (survivor < M.nv) M.vsel[survivor] = 1;
  compactMesh(false);
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  if (M.nv) M.vsel[0] = 1;
  syncSelFromVerts();
  return count;
}

uint32_t toolMergeByDistance(float threshold) {
  if (threshold <= 0.0f) threshold = 1e-4f;
  /* Spatial hash: cell size == threshold, so only the 27 neighbouring cells
     can contain a candidate. O(n) instead of O(n^2). */
  constexpr uint32_t kCellBits = 12;
  constexpr uint32_t kCellSize = 1u << kCellBits;
  static int32_t cellHead[kCellSize];
  static int32_t nextVert[kMaxVerts];
  for (uint32_t i = 0; i < kCellSize; ++i) cellHead[i] = -1;
  for (uint32_t i = 0; i < M.nv; ++i) nextVert[i] = -1;

  const float inv = 1.0f / threshold;
  auto cellHash = [&](int32_t cx, int32_t cy, int32_t cz) {
    const uint32_t h = static_cast<uint32_t>(cx) * 73856093u ^ static_cast<uint32_t>(cy) * 19349663u ^ static_cast<uint32_t>(cz) * 83492791u;
    return h & (kCellSize - 1u);
  };

  for (uint32_t i = 0; i < M.nv; ++i) g_vertMap[i] = i;
  uint32_t merged = 0;
  for (uint32_t i = 0; i < M.nv; ++i) {
    const int32_t cx = static_cast<int32_t>(fe::floorf(M.x[i] * inv));
    const int32_t cy = static_cast<int32_t>(fe::floorf(M.y[i] * inv));
    const int32_t cz = static_cast<int32_t>(fe::floorf(M.z[i] * inv));
    uint32_t target = kNoValue;
    for (int32_t dx = -1; dx <= 1 && target == kNoValue; ++dx) {
      for (int32_t dy = -1; dy <= 1 && target == kNoValue; ++dy) {
        for (int32_t dz = -1; dz <= 1 && target == kNoValue; ++dz) {
          const uint32_t h = cellHash(cx + dx, cy + dy, cz + dz);
          for (int32_t j = cellHead[h]; j >= 0; j = nextVert[j]) {
            if (dist3(i, static_cast<uint32_t>(j)) <= threshold) {
              target = static_cast<uint32_t>(j);
              break;
            }
          }
        }
      }
    }
    if (target != kNoValue) {
      g_vertMap[i] = target;
      ++merged;
      continue;
    }
    const uint32_t h = cellHash(cx, cy, cz);
    nextVert[i] = cellHead[h];
    cellHead[h] = static_cast<int32_t>(i);
  }

  if (!merged) return 0;
  for (uint32_t t = 0; t < M.nt * 3u; ++t) g_vertMap[M.tri[t]] = g_vertMap[M.tri[t]];
  for (uint32_t t = 0; t < M.nt * 3u; ++t) M.tri[t] = g_vertMap[M.tri[t]];
  compactMesh(false);
  syncSelFromVerts();
  return merged;
}

/* ===========================================================================
 * Delete
 * ========================================================================= */

uint32_t toolDelete(uint32_t kind) {
  rebuildEdges();
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  uint32_t removed = 0;

  if (kind == 0) {
    /* vertices: every face using a selected vertex goes */
    for (uint32_t t = 0; t < M.nt; ++t) {
      for (uint32_t k = 0; k < 3; ++k) {
        if (M.vsel[M.tri[t * 3 + k]]) { g_triMark[t] = 1; ++removed; break; }
      }
    }
    removeMarkedTris();
    for (uint32_t i = 0; i < M.nv; ++i) if (M.vsel[i]) g_vertMark[i] = 1;
    compactMesh(false);
  } else if (kind == 1) {
    /* edges: faces touching a selected edge */
    for (uint32_t e = 0; e < E.n; ++e) {
      if (!edgeSelected(e)) continue;
      if (E.f0[e] != kNoValue) g_triMark[E.f0[e]] = 1;
      if (E.f1[e] != kNoValue) g_triMark[E.f1[e]] = 1;
    }
    for (uint32_t t = 0; t < M.nt; ++t) removed += g_triMark[t];
    removeMarkedTris();
    compactMesh(false);
  } else {
    /* faces, and "only faces" keeps the vertices that other faces still use */
    for (uint32_t t = 0; t < M.nt; ++t) if (faceSelected(t)) g_triMark[t] = 1;
    for (uint32_t t = 0; t < M.nt; ++t) removed += g_triMark[t];
    removeMarkedTris();
    compactMesh(kind == 3);
  }
  rebuildEdges();
  syncSelFromVerts();
  return removed;
}

/* ===========================================================================
 * Poke, fill, bisect
 * ========================================================================= */

uint32_t toolPoke(void) {
  markSelectedFaces();
  uint32_t added = 0;
  const uint32_t originalTris = M.nt;
  for (uint32_t t = 0; t < originalTris; ++t) {
    if (!g_triMark[t]) continue;
    const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
    const uint32_t centre = addVert((M.x[a] + M.x[b] + M.x[c]) / 3.0f,
                                    (M.y[a] + M.y[b] + M.y[c]) / 3.0f,
                                    (M.z[a] + M.z[b] + M.z[c]) / 3.0f,
                                    (M.cr[a] + M.cr[b] + M.cr[c]) / 3.0f,
                                    (M.cg[a] + M.cg[b] + M.cg[c]) / 3.0f,
                                    (M.cb[a] + M.cb[b] + M.cb[c]) / 3.0f, true);
    if (centre == kNoValue) break;
    M.tri[t * 3] = a; M.tri[t * 3 + 1] = b; M.tri[t * 3 + 2] = centre;
    addTri(b, c, centre);
    addTri(c, a, centre);
    added += 2;
  }
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  rebuildEdges();
  syncSelFromVerts();
  return added;
}

namespace {

/* The ordered loops of selected boundary edges. All loops share one vertex
   pool: a per-loop array of kMaxVerts would cost megabytes of .bss for a
   result that never holds more than one vertex per boundary vertex. */
struct LoopSet {
  uint32_t verts[kMaxVerts];
  uint32_t start[64];
  uint32_t count[64];
  uint32_t poolUsed;
  uint32_t loopCount;
  uint32_t total() const { return poolUsed; }
  uint32_t vertexAt(uint32_t loop, uint32_t i) const {
    return verts[start[loop] + i % (count[loop] ? count[loop] : 1)];
  }
};

LoopSet g_loops;

uint32_t traceSelectedBoundaryLoops(LoopSet& loops, uint32_t maxLoops) {
  rebuildEdges();
  static uint8_t used[kMaxEdges];
  static uint8_t isBoundary[kMaxVerts];
  for (uint32_t e = 0; e < E.n; ++e) used[e] = 0;
  for (uint32_t i = 0; i < M.nv; ++i) isBoundary[i] = 0;

  /* adjacency restricted to selected boundary edges */
  static uint32_t adjStart[kMaxVerts + 1];
  static uint32_t adjVal[kMaxEdges * 2];
  static uint32_t adjEdge[kMaxEdges * 2];
  for (uint32_t i = 0; i <= M.nv; ++i) adjStart[i] = 0;
  uint32_t total = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeSelected(e)) continue;
    if (E.f1[e] != kNoValue) continue; /* interior edge: not a boundary */
    isBoundary[E.a[e]] = 1;
    isBoundary[E.b[e]] = 1;
    ++adjStart[E.a[e] + 1];
    ++adjStart[E.b[e] + 1];
    ++total;
  }
  for (uint32_t i = 0; i < M.nv; ++i) adjStart[i + 1] += adjStart[i];
  if (total == 0) return 0;
  for (uint32_t i = 0; i <= M.nv; ++i) g_vertStamp[i] = adjStart[i];
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeSelected(e) || E.f1[e] != kNoValue) continue;
    adjVal[g_vertStamp[E.a[e]]] = E.b[e];
    adjEdge[g_vertStamp[E.a[e]]++] = e;
    adjVal[g_vertStamp[E.b[e]]] = E.a[e];
    adjEdge[g_vertStamp[E.b[e]]++] = e;
  }

  loops.loopCount = 0;
  loops.poolUsed = 0;
  for (uint32_t start = 0; start < M.nv && loops.loopCount < maxLoops; ++start) {
    if (!isBoundary[start]) continue;
    bool hasUnused = false;
    for (uint32_t k = adjStart[start]; k < adjStart[start + 1]; ++k) if (!used[adjEdge[k]]) hasUnused = true;
    if (!hasUnused) continue;

    const uint32_t room = kMaxVerts - loops.poolUsed;
    if (room < 3) break;
    const uint32_t base = loops.poolUsed;
    uint32_t written = 0;
    uint32_t current = start;
    uint32_t previous = kNoValue;
    for (;;) {
      loops.verts[base + written++] = current;
      uint32_t next = kNoValue;
      for (uint32_t k = adjStart[current]; k < adjStart[current + 1]; ++k) {
        if (used[adjEdge[k]]) continue;
        const uint32_t candidate = adjVal[k];
        if (candidate == previous) continue;
        next = candidate;
        used[adjEdge[k]] = 1;
        break;
      }
      if (next == kNoValue || next == start) break;
      previous = current;
      current = next;
      if (written >= room) break;
    }
    if (written >= 3) {
      loops.start[loops.loopCount] = base;
      loops.count[loops.loopCount] = written;
      ++loops.loopCount;
      loops.poolUsed += written;
    }
  }
  return loops.loopCount;
}

} // namespace

uint32_t toolFill(void) {
  const uint32_t loopCount = traceSelectedBoundaryLoops(g_loops, 64);
  if (!loopCount) return 0;
  uint32_t added = 0;
  for (uint32_t l = 0; l < loopCount; ++l) {
    const uint32_t before = M.nt;
    /* The loop vertices are contiguous in the pool, so a fan can be built
       straight from the first one. */
    fanFromCentroid(g_loops.verts[g_loops.start[l]], g_loops.count[l]);
    added += M.nt - before;
  }
  rebuildEdges();
  syncSelFromVerts();
  return added;
}

uint32_t toolBridge(void) {
  const uint32_t loopCount = traceSelectedBoundaryLoops(g_loops, 64);
  if (loopCount != 2) return 0;
  const LoopSet& loops = g_loops;
  const uint32_t countA = loops.count[0], countB = loops.count[1];
  auto vertexAt = [&](uint32_t loop, uint32_t index) -> uint32_t {
    const uint32_t n = loops.count[loop];
    return loops.verts[loops.start[loop] + (index % n)];
  };

  /* Start from the closest pair, then walk both loops in the same direction. */
  uint32_t ia = 0, ib = 0;
  float best = 1e30f;
  for (uint32_t i = 0; i < countA; ++i) {
    for (uint32_t j = 0; j < countB; ++j) {
      const uint32_t va = vertexAt(0, i), vb = vertexAt(1, j);
      const float dx = M.x[va] - M.x[vb], dy = M.y[va] - M.y[vb], dz = M.z[va] - M.z[vb];
      const float d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; ia = i; ib = j; }
    }
  }
  if (best > 1e29f) return 0;

  /* Decide the walking direction of B by testing both and keeping the one
     that produces the shorter total edge length — the standard bridge rule. */
  const uint32_t steps = countA > countB ? countA : countB;
  auto bridgeCost = [&](int32_t dir) {
    float cost = 0.0f;
    for (uint32_t k = 0; k < steps; ++k) {
      const uint32_t va = vertexAt(0, ia + k);
      const uint32_t j = static_cast<uint32_t>((static_cast<int32_t>(ib) + dir * static_cast<int32_t>(k)) % static_cast<int32_t>(countB) + static_cast<int32_t>(countB));
      const uint32_t vb = vertexAt(1, j);
      cost += dist3(va, vb);
    }
    return cost;
  };
  const int32_t dir = bridgeCost(1) <= bridgeCost(-1) ? 1 : -1;

  uint32_t added = 0;
  for (uint32_t k = 0; k < steps; ++k) {
    const uint32_t va0 = vertexAt(0, ia + k);
    const uint32_t va1 = vertexAt(0, ia + k + 1);
    const uint32_t jb0 = static_cast<uint32_t>((static_cast<int32_t>(ib) + dir * static_cast<int32_t>(k) + static_cast<int32_t>(countB)) % static_cast<int32_t>(countB));
    const uint32_t jb1 = static_cast<uint32_t>((static_cast<int32_t>(ib) + dir * static_cast<int32_t>(k + 1) + static_cast<int32_t>(countB)) % static_cast<int32_t>(countB));
    const uint32_t vb0 = vertexAt(1, jb0);
    const uint32_t vb1 = vertexAt(1, jb1);
    if (va0 == va1 || vb0 == vb1) continue;
    addTri(va0, va1, vb1);
    addTri(va0, vb1, vb0);
    added += 2;
  }
  rebuildEdges();
  syncSelFromVerts();
  return added;
}

uint32_t toolBisect(float px, float py, float pz, float nx, float ny, float nz,
                    uint32_t keepPositive, uint32_t fillCut, uint32_t clearOther) {
  const float len = sqrtf(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9f) return 0;
  nx /= len; ny /= len; nz /= len;
  rebuildEdges();

  /* One cut vertex per crossed edge, shared by both adjacent faces. */
  static uint32_t edgeCut[kMaxEdges];
  for (uint32_t e = 0; e < E.n; ++e) {
    edgeCut[e] = kNoValue;
    const float da = (M.x[E.a[e]] - px) * nx + (M.y[E.a[e]] - py) * ny + (M.z[E.a[e]] - pz) * nz;
    const float db = (M.x[E.b[e]] - px) * nx + (M.y[E.b[e]] - py) * ny + (M.z[E.b[e]] - pz) * nz;
    if ((da < 0.0f) == (db < 0.0f)) continue;
    const float t = absf(da) + absf(db) > 1e-9f ? absf(da) / (absf(da) + absf(db)) : 0.5f;
    const uint32_t a = E.a[e], b = E.b[e];
    edgeCut[e] = addVert(M.x[a] + (M.x[b] - M.x[a]) * t,
                         M.y[a] + (M.y[b] - M.y[a]) * t,
                         M.z[a] + (M.z[b] - M.z[a]) * t,
                         M.cr[a] + (M.cr[b] - M.cr[a]) * t,
                         M.cg[a] + (M.cg[b] - M.cg[a]) * t,
                         M.cb[a] + (M.cb[b] - M.cb[a]) * t, false);
  }

  const uint32_t originalTris = M.nt;
  uint32_t cutFaces = 0;
  for (uint32_t t = 0; t < originalTris; ++t) {
    const uint32_t v[3] = { M.tri[t * 3], M.tri[t * 3 + 1], M.tri[t * 3 + 2] };
    float d[3];
    uint32_t positive = 0, negative = 0;
    for (uint32_t k = 0; k < 3; ++k) {
      d[k] = (M.x[v[k]] - px) * nx + (M.y[v[k]] - py) * ny + (M.z[v[k]] - pz) * nz;
      if (d[k] > 0.0f) ++positive;
      if (d[k] < 0.0f) ++negative;
    }
    if (negative == 0 || positive == 0) {
      /* entirely on one side */
      const bool keepSide = (positive > 0) == (keepPositive != 0);
      if (!keepSide) { g_triMark[t] = 1; }
      continue;
    }
    /* split: build the polygon on each side from the corners plus the cut
       points on the two crossed edges, then fan each side. */
    uint32_t polyA[8], polyB[8];
    uint32_t na = 0, nb = 0;
    for (uint32_t k = 0; k < 3; ++k) {
      const uint32_t k1 = (k + 1) % 3;
      if (d[k] >= 0.0f) polyA[na++] = v[k];
      if (d[k] <= 0.0f) polyB[nb++] = v[k];
      if ((d[k] < 0.0f) != (d[k1] < 0.0f)) {
        const uint32_t e = findEdge(v[k], v[k1]);
        if (e >= E.n || edgeCut[e] == kNoValue) continue;
        polyA[na++] = edgeCut[e];
        polyB[nb++] = edgeCut[e];
      }
    }
    if (na < 3 || nb < 3) { ++cutFaces; continue; }

    /* Winding: A follows the original order, so it is already correct; B is
       the complementary polygon and runs the other way. */
    auto emit = [&](uint32_t* poly, uint32_t n, bool reverse) {
      for (uint32_t i = 1; i + 1 < n; ++i) {
        if (reverse) addTri(poly[0], poly[i + 1], poly[i]);
        else addTri(poly[0], poly[i], poly[i + 1]);
      }
    };
    const bool keepA = keepPositive != 0;
    if (keepA) { emit(polyA, na, false); }
    else { emit(polyB, nb, true); }
    if (clearOther) {} /* handled by the keep flag above */
    g_triMark[t] = 1;
    ++cutFaces;
  }

  removeMarkedTris();
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;

  if (fillCut) {
    /* The cut boundary is every edge that now has exactly one face and both
       endpoints on the plane. Fan it so the hole is closed. */
    rebuildEdges();
    bool any = false;
    for (uint32_t v = 0; v < M.nv; ++v) {
      const float d = (M.x[v] - px) * nx + (M.y[v] - py) * ny + (M.z[v] - pz) * nz;
      M.vsel[v] = absf(d) < 1e-4f ? 1 : 0;
      if (M.vsel[v]) any = true;
    }
    for (uint32_t e = 0; e < E.n; ++e) E.sel[e] = 0;
    if (any) {
      /* traceSelectedBoundaryLoops only walks boundary edges whose two ends
         are selected, and the selection is exactly the on-plane vertices. */
      const uint32_t loopsFound = traceSelectedBoundaryLoops(g_loops, 16);
      for (uint32_t l = 0; l < loopsFound; ++l) {
        fanFromCentroid(g_loops.verts[g_loops.start[l]], g_loops.count[l]);
      }
    }
    for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  }

  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  compactMesh(false);
  rebuildEdges();
  syncSelFromVerts();
  return cutFaces;
}

/* ===========================================================================
 * Bevel — vertex sectors, offset, gap fill
 * ========================================================================= */

uint32_t toolBevel(float width, uint32_t aroundVertices) {
  rebuildEdges();
  if (M.nt == 0 || width <= 0.0f) return 0;

  /* Which vertices and edges does the bevel act on? */
  static uint8_t vertBevel[kMaxVerts];
  static uint8_t edgeBevel[kMaxEdges];
  uint32_t vertCount = 0, edgeCount = 0;
  for (uint32_t i = 0; i < M.nv; ++i) vertBevel[i] = 0;
  for (uint32_t e = 0; e < E.n; ++e) edgeBevel[e] = 0;

  if (aroundVertices) {
    for (uint32_t i = 0; i < M.nv; ++i) if (M.vsel[i]) { vertBevel[i] = 1; ++vertCount; }
  } else {
    for (uint32_t e = 0; e < E.n; ++e) {
      if (!edgeSelected(e)) continue;
      edgeBevel[e] = 1;
      vertBevel[E.a[e]] = 1;
      vertBevel[E.b[e]] = 1;
      ++edgeCount;
    }
  }
  if (!vertCount && !edgeCount) return 0;
  for (uint32_t i = 0; i < M.nv; ++i) if (vertBevel[i]) ++vertCount;

  buildVertexFaces();

  /* Split each affected vertex into sectors separated by beveled edges. */
  g_sectors.n = 0;
  static uint32_t cornerNew[kMaxTris * 3];
  bool overflow = false;
  /* M.nv grows while the sectors are created, so the bound is captured now:
     the newly added vertices are not part of the old adjacency. */
  const uint32_t originalVerts = M.nv;

  for (uint32_t v = 0; v < originalVerts && !overflow; ++v) {
    const uint32_t start = g_faceStart[v], end = g_faceStart[v + 1];
    const uint32_t incident = end - start;
    if (incident == 0) continue;

    if (!vertBevel[v]) {
      for (uint32_t k = start; k < end; ++k) {
        const uint32_t f = g_faceList[k];
        for (uint32_t q = 0; q < 3; ++q) if (M.tri[f * 3 + q] == v) cornerNew[f * 3 + q] = v;
      }
      continue;
    }

    /* union-find the incident faces across non-beveled shared edges */
    for (uint32_t k = start; k < end; ++k) g_ufParent[g_faceList[k]] = g_faceList[k];
    for (uint32_t k = start; k < end; ++k) {
      const uint32_t f = g_faceList[k];
      for (uint32_t q = 0; q < 3; ++q) {
        const uint32_t a = M.tri[f * 3 + q];
        const uint32_t b = M.tri[f * 3 + (q + 1) % 3];
        if (a != v && b != v) continue;
        const uint32_t e = findEdge(a, b);
        if (e >= E.n) continue;
        /* Faces stay welded across this edge unless the bevel separates them.
           A vertex bevel separates every face, an edge bevel only the
           selected edges. */
        if (aroundVertices || edgeBevel[e]) continue;
        const uint32_t other = E.f0[e] == f ? E.f1[e] : E.f0[e];
        if (other == kNoValue || other >= M.nt) continue;
        bool inSet = false;
        for (uint32_t z = start; z < end; ++z) if (g_faceList[z] == other) inSet = true;
        if (!inSet) continue;
        ufUnion(f, other);
      }
    }

    /* one new vertex per root */
    static uint32_t rootFace[64];
    static uint32_t rootNew[64];
    uint32_t roots = 0;
    for (uint32_t k = start; k < end; ++k) {
      const uint32_t f = g_faceList[k];
      const uint32_t r = ufFind(f);
      uint32_t idx = kNoValue;
      for (uint32_t z = 0; z < roots; ++z) if (rootFace[z] == r) idx = z;
      if (idx == kNoValue) {
        if (roots >= 64) { overflow = true; break; }
        idx = roots++;
        rootFace[idx] = r;
        rootNew[idx] = v; /* resolved to the real sector vertex below */
      }
      /* A real vertex id never has this bit set (the kernel holds 16 384), so
         the placeholder cannot be confused for one — and it cannot overflow
         the way 0xFFFFFFFE + idx would. */
      for (uint32_t q = 0; q < 3; ++q) {
        if (M.tri[f * 3 + q] == v) cornerNew[f * 3 + q] = 0xFFFF0000u | idx;
      }
    }
    if (overflow) break;

    /* Offset direction per sector: toward the average of that sector's faces. */
    for (uint32_t z = 0; z < roots; ++z) {
      float cx = 0.0f, cy = 0.0f, cz = 0.0f;
      uint32_t n = 0;
      for (uint32_t k = start; k < end; ++k) {
        const uint32_t f = g_faceList[k];
        if (ufFind(f) != rootFace[z]) continue;
        cx += (M.x[M.tri[f * 3]] + M.x[M.tri[f * 3 + 1]] + M.x[M.tri[f * 3 + 2]]) / 3.0f;
        cy += (M.y[M.tri[f * 3]] + M.y[M.tri[f * 3 + 1]] + M.y[M.tri[f * 3 + 2]]) / 3.0f;
        cz += (M.z[M.tri[f * 3]] + M.z[M.tri[f * 3 + 1]] + M.z[M.tri[f * 3 + 2]]) / 3.0f;
        ++n;
      }
      float dx = 0.0f, dy = 0.0f, dz = 0.0f;
      if (n) {
        cx /= static_cast<float>(n); cy /= static_cast<float>(n); cz /= static_cast<float>(n);
        dx = cx - M.x[v]; dy = cy - M.y[v]; dz = cz - M.z[v];
        const float len = sqrtf(dx * dx + dy * dy + dz * dz);
        if (len > 1e-6f) { dx /= len; dy /= len; dz /= len; }
        else { dx = 0.0f; dy = 0.0f; dz = 0.0f; }
      }
      const uint32_t nv = addVert(M.x[v] + dx * width, M.y[v] + dy * width, M.z[v] + dz * width,
                                  M.cr[v], M.cg[v], M.cb[v], false);
      if (nv == kNoValue) { overflow = true; break; }
      rootNew[z] = nv;
      g_sectors.add(v, rootFace[z], nv);
    }
    /* resolve the placeholders */
    for (uint32_t k = start; k < end; ++k) {
      const uint32_t f = g_faceList[k];
      for (uint32_t q = 0; q < 3; ++q) {
        if (M.tri[f * 3 + q] != v) continue;
        if ((cornerNew[f * 3 + q] & 0xFFFF0000u) == 0xFFFF0000u) {
          const uint32_t idx = cornerNew[f * 3 + q] & 0xFFFFu;
          cornerNew[f * 3 + q] = rootNew[idx];
        }
      }
    }
  }
  if (overflow) {
    /* Undo the partial split by leaving the mesh untouched. */
    compactMesh(false);
    return 0;
  }

  /* The gap along every beveled edge, built while the OLD edge table still
     describes which two faces met there. cornerNew already holds the sector
     vertex for each corner, so the four corners of the gap are known. */
  uint32_t added = 0;
  /* The gap geometry is appended, and it must not be rewritten by the corner
     remap below — cornerNew only has entries for the original faces. */
  const uint32_t originalTris = M.nt;
  auto sectorCorner = [&](uint32_t f, uint32_t v) -> uint32_t {
    for (uint32_t k = 0; k < 3; ++k) {
      if (M.tri[f * 3 + k] == v) return cornerNew[f * 3 + k];
    }
    return kNoValue;
  };

  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeBevel[e]) continue;
    const uint32_t a = E.a[e], b = E.b[e];
    const uint32_t f0 = E.f0[e], f1 = E.f1[e];
    if (f0 == kNoValue || f1 == kNoValue) continue;
    const uint32_t a0 = sectorCorner(f0, a), b0 = sectorCorner(f0, b);
    const uint32_t a1 = sectorCorner(f1, a), b1 = sectorCorner(f1, b);
    if (a0 == kNoValue || b0 == kNoValue || a1 == kNoValue || b1 == kNoValue) continue;
    if (a0 == a1 && b0 == b1) continue;
    addTri(a0, b0, b1);
    addTri(a0, b1, a1);
    added += 2;
  }

  /* Rebuild the original faces on their sector vertices. */
  for (uint32_t t = 0; t < originalTris; ++t) {
    M.tri[t * 3] = cornerNew[t * 3];
    M.tri[t * 3 + 1] = cornerNew[t * 3 + 1];
    M.tri[t * 3 + 2] = cornerNew[t * 3 + 2];
  }
  rebuildEdges();

  /* Corner polygons: for every affected vertex, fan its sector ring. */
  for (uint32_t v = 0; v < originalVerts; ++v) {
    if (!vertBevel[v]) continue;
    uint32_t sectors[64];
    uint32_t count = 0;
    for (uint32_t i = 0; i < g_sectors.n; ++i) {
      if (g_sectors.oldVertex[i] != v) continue;
      if (count < 64) sectors[count++] = g_sectors.newVertex[i];
    }
    if (count < 3) continue;
    /* order around the vertex by angle in the plane perpendicular to its
       normal, then close the ring */
    float vx = 0.0f, vy = 0.0f, vz = 0.0f;
    float nx = 0.0f, ny = 0.0f, nz = 0.0f;
    for (uint32_t i = 0; i < count; ++i) {
      const uint32_t s = sectors[i];
      vx += M.x[s]; vy += M.y[s]; vz += M.z[s];
    }
    vx /= static_cast<float>(count); vy /= static_cast<float>(count); vz /= static_cast<float>(count);
    /* vertex normal from the sector fan */
    for (uint32_t t = 0; t < M.nt; ++t) {
      if (M.tri[t * 3] != v && M.tri[t * 3 + 1] != v && M.tri[t * 3 + 2] != v) continue;
      float fx, fy, fz;
      faceNormal(t, fx, fy, fz);
      nx += fx; ny += fy; nz += fz;
    }
    const float nl = sqrtf(nx * nx + ny * ny + nz * nz);
    if (nl > 1e-9f) { nx /= nl; ny /= nl; nz /= nl; } else { nx = 0.0f; ny = 1.0f; nz = 0.0f; }

    /* An orthonormal basis in the plane the sectors lie in. */
    float hx = 1.0f, hy = 0.0f, hz = 0.0f;
    if (absf(nx) > 0.9f) { hx = 0.0f; hy = 1.0f; hz = 0.0f; }
    float tx = hy * nz - hz * ny, ty = hz * nx - hx * nz, tz = hx * ny - hy * nx;
    const float tl = sqrtf(tx * tx + ty * ty + tz * tz);
    if (tl > 1e-9f) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 1.0f; ty = 0.0f; tz = 0.0f; }
    const float bx = ny * tz - nz * ty;
    const float by = nz * tx - nx * tz;
    const float bz = nx * ty - ny * tx;

    float angles[64];
    for (uint32_t i = 0; i < count; ++i) {
      const uint32_t s = sectors[i];
      const float dx = M.x[s] - vx, dy = M.y[s] - vy, dz = M.z[s] - vz;
      angles[i] = atan2f(dx * bx + dy * by + dz * bz, dx * tx + dy * ty + dz * tz);
    }
    for (uint32_t i = 0; i < count; ++i) {
      for (uint32_t j = i + 1; j < count; ++j) {
        if (angles[j] < angles[i]) {
          const float ta = angles[i]; angles[i] = angles[j]; angles[j] = ta;
          const uint32_t ts = sectors[i]; sectors[i] = sectors[j]; sectors[j] = ts;
        }
      }
    }
    const uint32_t centre = addVert(vx, vy, vz, M.cr[v], M.cg[v], M.cb[v], false);
    if (centre == kNoValue) continue;
    for (uint32_t i = 0; i < count; ++i) {
      addTri(sectors[i], sectors[(i + 1) % count], centre);
      ++added;
    }
  }

  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  rebuildEdges();
  syncSelFromVerts();
  return added;
}

/* ===========================================================================
 * Symmetrize, split, collapse, loop
 * ========================================================================= */

uint32_t toolSymmetrize(uint32_t axis) {
  float px = 0.0f, py = 0.0f, pz = 0.0f;
  if (g_pivotMode == 1) { px = g_pivot[0]; py = g_pivot[1]; pz = g_pivot[2]; }

  /* Keep the positive half, mirror it to the negative side, weld the seam. */
  float nx = 0.0f, ny = 0.0f, nz = 0.0f;
  if (axis == 0) nx = 1.0f; else if (axis == 1) ny = 1.0f; else nz = 1.0f;
  toolBisect(px, py, pz, nx, ny, nz, 1, 0, 0);

  const uint32_t originalVerts = M.nv;
  const uint32_t originalTris = M.nt;
  for (uint32_t i = 0; i < originalVerts; ++i) {
    const uint32_t nv = addVert(axis == 0 ? 2.0f * px - M.x[i] : M.x[i],
                                axis == 1 ? 2.0f * py - M.y[i] : M.y[i],
                                axis == 2 ? 2.0f * pz - M.z[i] : M.z[i],
                                M.cr[i], M.cg[i], M.cb[i], false);
    if (nv == kNoValue) return 0;
    g_vertMap[i] = nv;
  }
  for (uint32_t t = 0; t < originalTris; ++t) {
    /* mirrored copy flips winding */
    addTri(g_vertMap[M.tri[t * 3]], g_vertMap[M.tri[t * 3 + 2]], g_vertMap[M.tri[t * 3 + 1]]);
  }
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  toolMergeByDistance(1e-4f);
  rebuildEdges();
  syncSelFromVerts();
  return M.nt;
}

uint32_t toolSplit(void) {
  markSelectedFaces();
  /* Detach: copy the faces onto their own vertices, delete the originals. */
  const uint32_t originalTris = M.nt;
  uint32_t moved = 0;
  for (uint32_t t = 0; t < originalTris; ++t) {
    if (!g_triMark[t]) continue;
    const uint32_t a = M.tri[t * 3], b = M.tri[t * 3 + 1], c = M.tri[t * 3 + 2];
    const uint32_t na = addVert(M.x[a], M.y[a], M.z[a], M.cr[a], M.cg[a], M.cb[a], true);
    const uint32_t nb = addVert(M.x[b], M.y[b], M.z[b], M.cr[b], M.cg[b], M.cb[b], true);
    const uint32_t nc = addVert(M.x[c], M.y[c], M.z[c], M.cr[c], M.cg[c], M.cb[c], true);
    if (na == kNoValue || nb == kNoValue || nc == kNoValue) break;
    M.tri[t * 3] = na;
    M.tri[t * 3 + 1] = nb;
    M.tri[t * 3 + 2] = nc;
    ++moved;
  }
  for (uint32_t t = 0; t < M.nt; ++t) g_triMark[t] = 0;
  compactMesh(false);
  for (uint32_t i = 0; i < M.nv; ++i) M.vsel[i] = 0;
  syncSelFromVerts();
  return moved;
}

uint32_t toolCollapse(void) {
  rebuildEdges();
  uint32_t collapsed = 0;
  for (uint32_t e = 0; e < E.n; ++e) {
    if (!edgeSelected(e)) continue;
    const uint32_t a = E.a[e], b = E.b[e];
    const float mx = (M.x[a] + M.x[b]) * 0.5f;
    const float my = (M.y[a] + M.y[b]) * 0.5f;
    const float mz = (M.z[a] + M.z[b]) * 0.5f;
    M.x[a] = mx; M.y[a] = my; M.z[a] = mz;
    for (uint32_t t = 0; t < M.nt * 3u; ++t) if (M.tri[t] == b) M.tri[t] = a;
    ++collapsed;
  }
  removeDegenerateTris();
  compactMesh(false);
  syncSelFromVerts();
  rebuildEdges();
  return collapsed;
}

uint32_t toolSelectLoop(uint32_t seedEdge) {
  rebuildEdges();
  if (seedEdge >= E.n) return 0;
  buildVertexAdjacency();

  auto oppositeEdge = [&](uint32_t v, uint32_t via) -> int32_t {
    /* at a valence-4 vertex, the loop continues through the edge that is not
       the incoming one and not adjacent to it */
    const uint32_t start = g_adjStart[v], end = g_adjStart[v + 1];
    if (end - start != 4) return -1;
    uint32_t neighbours[4];
    uint32_t n = 0;
    for (uint32_t k = start; k < end && n < 4; ++k) neighbours[n++] = g_adjList[k];
    /* find the index of `via` */
    uint32_t idx = 4;
    for (uint32_t i = 0; i < 4; ++i) if (neighbours[i] == via) idx = i;
    if (idx == 4) return -1;
    /* The opposite edge is the one whose other endpoint is not adjacent to
       `via` in the ring; with valence 4 the ring order is not stored, so the
       rule used is the geometric one: the edge most nearly opposite in
       direction. */
    const float vx = M.x[v], vy = M.y[v], vz = M.z[v];
    float ix = M.x[via] - vx, iy = M.y[via] - vy, iz = M.z[via] - vz;
    const float il = sqrtf(ix * ix + iy * iy + iz * iz);
    if (il < 1e-9f) return -1;
    ix /= il; iy /= il; iz /= il;
    int32_t best = -1;
    float bestDot = 1e30f;
    for (uint32_t i = 0; i < 4; ++i) {
      if (neighbours[i] == via) continue;
      float dx = M.x[neighbours[i]] - vx, dy = M.y[neighbours[i]] - vy, dz = M.z[neighbours[i]] - vz;
      const float dl = sqrtf(dx * dx + dy * dy + dz * dz);
      if (dl < 1e-9f) continue;
      const float dot = (dx * ix + dy * iy + dz * iz) / dl;
      if (dot < bestDot) { bestDot = dot; best = static_cast<int32_t>(i); }
    }
    if (best < 0 || bestDot > -0.5f) return -1;
    const uint32_t target = neighbours[best];
    const uint32_t e = findEdge(v, target);
    return e < E.n ? static_cast<int32_t>(e) : -1;
  };

  M.vsel[E.a[seedEdge]] = 1;
  M.vsel[E.b[seedEdge]] = 1;
  uint32_t count = 1;
  /* two directions */
  for (int32_t dir = 0; dir < 2; ++dir) {
    uint32_t v = dir == 0 ? E.a[seedEdge] : E.b[seedEdge];
    uint32_t via = dir == 0 ? E.b[seedEdge] : E.a[seedEdge];
    for (uint32_t guard = 0; guard < kMaxVerts; ++guard) {
      const int32_t next = oppositeEdge(v, via);
      if (next < 0) break;
      const uint32_t e = static_cast<uint32_t>(next);
      if (M.vsel[E.a[e]] && M.vsel[E.b[e]]) break;
      M.vsel[E.a[e]] = 1;
      M.vsel[E.b[e]] = 1;
      ++count;
      const uint32_t nv = (E.a[e] == v) ? E.b[e] : E.a[e];
      via = v;
      v = nv;
    }
  }
  syncSelFromVerts();
  return count;
}

} // namespace fe_edit

using namespace fe_edit;

extern "C" {

FE_EXPORT uint32_t fe_edit_extrude(float distance, uint32_t individual) {
  undoPush();
  return fe_edit::toolExtrude(distance, individual);
}

FE_EXPORT uint32_t fe_edit_inset(float thickness, uint32_t individual) {
  undoPush();
  return fe_edit::toolInset(thickness, individual);
}

FE_EXPORT uint32_t fe_edit_subdivide(uint32_t mode, uint32_t smooth) {
  undoPush();
  return fe_edit::toolSubdivide(mode, smooth);
}

FE_EXPORT uint32_t fe_edit_merge_center(void) {
  undoPush();
  return fe_edit::toolMergeCenter();
}

FE_EXPORT uint32_t fe_edit_merge_distance(float threshold) {
  undoPush();
  return fe_edit::toolMergeByDistance(threshold);
}

FE_EXPORT uint32_t fe_edit_delete(uint32_t kind) {
  undoPush();
  return fe_edit::toolDelete(kind);
}

FE_EXPORT uint32_t fe_edit_duplicate(void) {
  undoPush();
  return fe_edit::toolDuplicate();
}

FE_EXPORT uint32_t fe_edit_poke(void) {
  undoPush();
  return fe_edit::toolPoke();
}

FE_EXPORT uint32_t fe_edit_fill(void) {
  undoPush();
  return fe_edit::toolFill();
}

FE_EXPORT uint32_t fe_edit_bridge(void) {
  undoPush();
  return fe_edit::toolBridge();
}

FE_EXPORT uint32_t fe_edit_bisect(float px, float py, float pz, float nx, float ny, float nz,
                                  uint32_t keepPositive, uint32_t fillCut, uint32_t clearOther) {
  undoPush();
  return fe_edit::toolBisect(px, py, pz, nx, ny, nz, keepPositive, fillCut, clearOther);
}

FE_EXPORT uint32_t fe_edit_bevel(float width, uint32_t aroundVertices) {
  undoPush();
  return fe_edit::toolBevel(width, aroundVertices);
}

FE_EXPORT uint32_t fe_edit_symmetrize(uint32_t axis) {
  undoPush();
  return fe_edit::toolSymmetrize(axis);
}

FE_EXPORT uint32_t fe_edit_split(void) {
  undoPush();
  return fe_edit::toolSplit();
}

FE_EXPORT uint32_t fe_edit_collapse(void) {
  undoPush();
  return fe_edit::toolCollapse();
}

FE_EXPORT uint32_t fe_edit_select_loop(uint32_t seedEdge) {
  return fe_edit::toolSelectLoop(seedEdge);
}

} // extern "C"
