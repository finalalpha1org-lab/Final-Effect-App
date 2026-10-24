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
void selectFaceVerts(uint32_t t);
void deselectFaceVerts(uint32_t t);
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

} // namespace fe_edit

#endif
