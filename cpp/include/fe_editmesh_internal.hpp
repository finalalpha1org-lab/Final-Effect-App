#ifndef FE_EDITMESH_INTERNAL_HPP
#define FE_EDITMESH_INTERNAL_HPP

/* Internal state of the C++ Edit Mode kernel.
 *
 * The mesh is a triangle soup with per-vertex selection, which is exactly what
 * a GPU wants and exactly what Blender's edit mode does *not* use. Every tool
 * that needs real topology (loops, rings, boundary detection, adjacency) builds
 * an edge table first, and every topology change rebuilds it. Selection is kept
 * on vertices only; edge and face selection are derived from it, so the three
 * selection modes can never disagree with each other after an operation.
 *
 * No allocation: all buffers are static, sized for the meshes this app can
 * actually open (see kMaxVerts). Uploading a larger mesh fails with code 0
 * instead of corrupting the heap. */

#include <stdint.h>
#include <stddef.h>
#include "fe_math.hpp"

namespace fe_edit {

/* Sized for what a phone can actually edit at 60 fps: 16 384 vertices is
   32 768 triangles, and the whole kernel lives in ~15 MB of linear memory.
   A mesh above the limit is refused by fe_edit_upload with a 0 return, which
   the UI reports instead of silently truncating the model. */
constexpr uint32_t kMaxVerts = 16384u;
constexpr uint32_t kMaxTris = 32768u;
constexpr uint32_t kMaxEdges = 65536u;
constexpr uint32_t kMaxRenderVerts = kMaxVerts * 2u;
constexpr uint32_t kMaxUndoBytes = 6u * 1024u * 1024u;
constexpr uint32_t kUndoSteps = 48u;
constexpr uint32_t kMaxPairs = 16384u;

enum EditMode : uint32_t { kModeVertex = 0, kModeEdge = 1, kModeFace = 2 };
enum Falloff : uint32_t { kFallConst = 0, kFallLinear = 1, kFallSmooth = 2, kFallSphere = 3, kFallRoot = 4, kFallSharp = 5 };

struct Mesh {
  float x[kMaxVerts];
  float y[kMaxVerts];
  float z[kMaxVerts];
  float cr[kMaxVerts];
  float cg[kMaxVerts];
  float cb[kMaxVerts];
  uint8_t vsel[kMaxVerts];
  float weight[kMaxVerts];
  uint32_t tri[kMaxTris * 3];
  uint8_t fsel[kMaxTris];
  /* Per-face shading, the flag every modeller keeps: 1 = smooth, 0 = flat. A
     face is the unit of shading, not the mesh - a cylinder is round with flat
     caps - so this lives beside `fsel` and travels with the triangles through
     every edit, the undo stack and the committed geometry. */
  uint8_t fsmooth[kMaxTris];
  /* How far those flags have been written. A topology tool appends triangles
     without touching them, so everything past this point would otherwise be a
     stale byte left behind by the mesh that was there before the tool ran. */
  uint32_t fsmoothCount;
  /* Which face each triangle is part of, one id per triangle. This is what a
     tool writes as it makes triangles, and it is the only thing that keeps a
     face a face: the pairing below can only *guess* a quad from the shape, and
     a guess stops being true the moment the shape is dragged - which is exactly
     when the user sees a line appear through the middle of a face. A tag is
     recorded when the face is made and travels with the triangles through
     every edit, so no amount of deformation can split it. kNoTag means "this
     triangle has not been given a face yet"; the first rebuild then derives one
     from the shape and writes it down. */
  uint32_t ftag[kMaxTris];
  /* No default member initialisers anywhere in these structures: an NSDMI
     turns the array into .data, and a 2 MB block of zeroes then ships inside
     the wasm file. Everything is initialised explicitly by fe_edit_reset(). */
  uint32_t nv;
  uint32_t nt;
  bool hasColor;
  bool smooth;
};

struct EdgeTable {
  uint32_t a[kMaxEdges];
  uint32_t b[kMaxEdges];
  uint32_t f0[kMaxEdges];
  uint32_t f1[kMaxEdges];
  uint8_t sel[kMaxEdges];
  uint32_t n;
};

/* A pair of vertices that carries an edge flag (seam / sharp). Stored apart
   from the edge table because the table is rebuilt after every operation and
   the flags must survive it. */
struct PairFlags {
  uint32_t a[kMaxPairs];
  uint32_t b[kMaxPairs];
  float value[kMaxPairs];
  uint32_t n;
};

extern Mesh M;
extern EdgeTable E;
extern PairFlags g_seams;
extern PairFlags g_sharp;

extern uint32_t g_mode;
extern float g_propRadius;
extern uint32_t g_propFalloff;
extern bool g_propEnabled;
extern bool g_propConnected;
extern uint32_t g_pivotMode;
extern float g_pivot[3];
extern uint32_t g_snapMode;
extern float g_snapIncrement;

/* scratch, reused by every operation */
extern uint8_t g_triMark[kMaxTris];

/* Faces: the triangles the wireframe joins into one surface (see
   buildQuadGroups). g_quadOf maps a triangle to its face, g_quadFirst holds
   the face's first triangle and g_quadNext walks the rest - a cube side is two
   triangles, a cylinder cap is thirty-two, a cone's side is one. */
extern uint32_t g_quadOf[kMaxTris];
extern uint32_t g_quadFirst[kMaxTris];
extern uint32_t g_quadNext[kMaxTris];
extern uint32_t g_quadCount;
/* Each face's corner ring, flattened (see buildQuadGroups): face f owns
   g_grpRing[g_grpStart[f] .. g_grpStart[f + 1]). A tool that works on a face
   rather than on a triangle - poke, for one - reads the face from here. */
extern uint32_t g_grpStart[kMaxTris + 1];
extern uint32_t g_grpRing[kMaxTris * 3];
/* Constants a tool needs: no face, no vertex, and the largest ring the kernel
   will draw. */
constexpr uint32_t kNoFaceTool = 0xFFFFFFFFu;
constexpr uint32_t kMaxRingCornersTool = 2048u;
extern float g_quadAngle;
extern uint32_t g_vertMap[kMaxVerts];
extern uint32_t g_vertStamp[kMaxVerts];
extern uint8_t g_vertMark[kMaxVerts];

/* ---- geometry helpers ---- */
inline float dist3(uint32_t i, uint32_t j) {
  const float dx = M.x[i] - M.x[j], dy = M.y[i] - M.y[j], dz = M.z[i] - M.z[j];
  return fe::sqrtf(dx * dx + dy * dy + dz * dz);
}

void faceNormal(uint32_t t, float& nx, float& ny, float& nz);
void vertexNormals(float* nx, float* ny, float* nz);
void triangleArea(uint32_t t, float& area);

/* ---- edge table ---- */
void rebuildEdges();
uint32_t findEdge(uint32_t a, uint32_t b);
bool edgeSelected(uint32_t e);
bool faceSelected(uint32_t t);
bool quadFaceSelected(uint32_t t);
void selectFaceVerts(uint32_t t);
void deselectFaceVerts(uint32_t t);
void buildQuadGroups();

/* ---- face tags ----------------------------------------------------------
   A face id per triangle (see Mesh::ftag). `g_tagPending` is the id `addTri`
   stamps onto whatever it appends, so a tool tags a whole piece of geometry
   with one call; `newFaceTag()` mints an id nothing has used; the tools that
   cannot keep a face whole (a weld merges triangles of two faces) call
   `tagInvalidate()` and let the next rebuild derive the table from the shape
   once, which writes fresh tags. */
constexpr uint32_t kNoTag = 0xFFFFFFFFu;

extern uint32_t g_tagPending;
extern uint32_t g_tagNext;
extern bool g_tagValid;

uint32_t newFaceTag(void);
void tagInvalidate(void);
/* The tag of a triangle, or kNoTag. */
uint32_t tagOfTriangle(uint32_t t);

/* A tool that leaves triangles visible on purpose (a poke's fan) declares them
   as faces before it asks for the rebuild: beginToolFaceDeclarations clears the
   store, toolDeclareFaceRing appends one ring in the kernel's vertex numbering,
   and the rebuild claims them before anything is paired or merged. */
void beginToolFaceDeclarations(void);
bool toolDeclareFaceRing(const uint32_t* verts, uint32_t n);
uint32_t selectedVertCount();
uint32_t selectedEdgeCount();
uint32_t selectedFaceCount();
void syncSelFromVerts();
void clearSelection();

/* ---- pair flags ---- */
bool pairGet(PairFlags& set, uint32_t a, uint32_t b, float* value);
void pairSet(PairFlags& set, uint32_t a, uint32_t b, bool on, float value);
void pairRebuildAfterCompact();

/* ---- structure edits ---- */
bool addTri(uint32_t a, uint32_t b, uint32_t c);
uint32_t addVert(float x, float y, float z, float r, float g, float b, bool selected);
void compactMesh(bool keepUnusedVerts);
void removeMarkedTris();
uint32_t removeDegenerateTris();

/* ---- proportional editing ---- */
void computeWeights();

/* ---- undo ---- */
void undoPush();
int32_t undoStep();
int32_t redoStep();
uint32_t undoDepth();
uint32_t redoDepth();
void undoClear();

/* ---- clipboard (separate / join / duplicate to new object) ---- */
struct Clip {
  float x[kMaxVerts];
  float y[kMaxVerts];
  float z[kMaxVerts];
  float cr[kMaxVerts];
  float cg[kMaxVerts];
  float cb[kMaxVerts];
  uint32_t tri[kMaxTris * 3];
  uint32_t nv;
  uint32_t nt;
  bool hasColor;
};
extern Clip C;
void clipClear();

/* ---- CSR vertex adjacency, rebuilt by the tools that need it ---- */
extern uint32_t g_adjStart[kMaxVerts + 1];
extern uint32_t g_adjList[kMaxEdges * 2];
extern float g_pickTolerance;

extern uint32_t g_adjCount;
void buildVertexAdjacency();

/* ---- face adjacency per vertex (for normal splitting) ---- */
extern uint32_t g_faceStart[kMaxVerts + 1];
extern uint32_t g_faceList[kMaxTris * 3];
void buildVertexFaces();

/* ---- render buffers ---- */
extern float g_outPos[kMaxRenderVerts * 3];
extern float g_outNrm[kMaxRenderVerts * 3];
extern float g_outCol[kMaxRenderVerts * 3];
extern uint32_t g_outIdx[kMaxTris * 3];
extern uint32_t g_outVerts;
extern uint32_t g_outIdxCount;
extern uint32_t g_outSplit;
/* For every render vertex, the welded (cage) vertex it was built from. A flat
   face has its own copies, so the shell needs this to map anything expressed in
   cage vertices - the face rings - onto the render mesh it draws. */
extern uint32_t g_renderWeld[kMaxRenderVerts];

} // namespace fe_edit

#endif
