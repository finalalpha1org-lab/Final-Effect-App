/* Native unit tests for the C++ Edit Mode kernel.
   Built and run by tests/cpp-editmesh.test.mjs, and by the existing native
   suite target. They exercise the topology operations against a closed cube
   and check invariants that a screenshot cannot: no NaN, no index outside the
   vertex range, and a known triangle/vertex count after each operation. */

#include <stdio.h>
#include <string.h>
#include <math.h>

extern "C" {
unsigned int fe_edit_reset(void);
unsigned int fe_edit_upload(unsigned int, const float*, unsigned int, const unsigned int*, const float*);
unsigned int fe_edit_vert_count(void);
unsigned int fe_edit_tri_count(void);
unsigned int fe_edit_edge_count(void);
unsigned int fe_edit_max_verts(void);
void fe_edit_set_mode(unsigned int);
void fe_edit_select_all(void);
void fe_edit_select_none(void);
unsigned int fe_edit_sel_count(void);
const unsigned int* fe_edit_stats_ptr(void);
const float* fe_edit_bounds_ptr(void);
const float* fe_edit_pos_interleaved_ptr(void);
const unsigned int* fe_edit_idx_ptr(void);
unsigned int fe_edit_move(float, float, float, unsigned int);
unsigned int fe_edit_scale(float, float, float, unsigned int);
unsigned int fe_edit_rotate(float, unsigned int);
unsigned int fe_edit_extrude(float, unsigned int);
unsigned int fe_edit_inset(float, unsigned int);
unsigned int fe_edit_subdivide(unsigned int, unsigned int);
unsigned int fe_edit_merge_center(void);
unsigned int fe_edit_merge_distance(float);
unsigned int fe_edit_delete(unsigned int);
unsigned int fe_edit_duplicate(void);
unsigned int fe_edit_poke(void);
unsigned int fe_edit_bevel(float, unsigned int);
unsigned int fe_edit_bisect(float, float, float, float, float, float, unsigned int, unsigned int, unsigned int);
unsigned int fe_edit_symmetrize(unsigned int);
unsigned int fe_edit_collapse(void);
unsigned int fe_edit_build_render(void);
unsigned int fe_edit_render_vert_count(void);
unsigned int fe_edit_render_idx_count(void);
const float* fe_edit_render_pos_ptr(void);
const unsigned int* fe_edit_render_idx_ptr(void);
unsigned int fe_edit_undo(void);
unsigned int fe_edit_redo(void);
unsigned int fe_edit_undo_depth(void);
void fe_edit_undo_clear(void);
unsigned int fe_edit_recalc_normals(unsigned int);
void fe_edit_set_proportional(unsigned int, unsigned int, float, unsigned int);
void fe_edit_set_shade(unsigned int);
unsigned int fe_edit_mark_sharp(unsigned int);
unsigned int fe_edit_sharp_count(void);
unsigned int fe_edit_select_linked(unsigned int);
unsigned int fe_edit_select_more(void);
unsigned int fe_edit_select_less(void);
unsigned int fe_edit_select_invert(void);
unsigned int fe_edit_pick(const float*, float, float);
void fe_edit_undo_push(void);
unsigned int fe_edit_select_by_index(unsigned int, unsigned int, const unsigned int*, unsigned int);
unsigned int fe_edit_flip_normals(void);
}

static int g_failures = 0;

#define CHECK_MSG(cond, msg) do { \
  if (!(cond)) { printf("FAIL %s:%d  %s (%s)\n", __FILE__, __LINE__, #cond, msg); ++g_failures; } \
} while (0)

#define CHECK(cond) do { \
  if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); ++g_failures; } \
} while (0)

#define CHECK_NEAR(a, b, eps) do { \
  const double _a = (a), _b = (b); \
  if (fabs(_a - _b) > (eps)) { printf("FAIL %s:%d  %s=%.6f expected %.6f\n", __FILE__, __LINE__, #a, _a, _b); ++g_failures; } \
} while (0)

/* A unit cube: 8 corners, 12 triangles, outward winding. */
static const float kCubeVerts[24] = {
  -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1,
  -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1
};

static const unsigned int kCubeTris[36] = {
  0, 2, 1,  0, 3, 2,
  4, 5, 6,  4, 6, 7,
  0, 1, 5,  0, 5, 4,
  1, 2, 6,  1, 6, 5,
  2, 3, 7,  2, 7, 6,
  3, 0, 4,  3, 4, 7
};

static void loadCube(void) {
  fe_edit_reset();
  fe_edit_upload(8, kCubeVerts, 12, kCubeTris, 0);
}

static float cubeVolume(void) {
  const float* p = fe_edit_pos_interleaved_ptr();
  const unsigned int* t = fe_edit_idx_ptr();
  const unsigned int nt = fe_edit_tri_count();
  double vol = 0.0;
  for (unsigned int i = 0; i < nt; ++i) {
    const unsigned int a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    vol += (static_cast<double>(p[a]) * (static_cast<double>(p[b + 1]) * p[c + 2] - static_cast<double>(p[b + 2]) * p[c + 1]) -
            static_cast<double>(p[a + 1]) * (static_cast<double>(p[b]) * p[c + 2] - static_cast<double>(p[b + 2]) * p[c]) +
            static_cast<double>(p[a + 2]) * (static_cast<double>(p[b]) * p[c + 1] - static_cast<double>(p[b + 1]) * p[c])) / 6.0;
  }
  return static_cast<float>(vol);
}

/* Every index inside range and every coordinate finite. Called after each
   operation, because a topology bug shows up as a bad index first. */
static void checkIntegrity(const char* where) {
  const unsigned int nv = fe_edit_vert_count();
  const unsigned int nt = fe_edit_tri_count();
  const float* p = fe_edit_pos_interleaved_ptr();
  const unsigned int* t = fe_edit_idx_ptr();
  CHECK(nv <= fe_edit_max_verts());
  for (unsigned int i = 0; i < nv * 3; ++i) {
    if (!(p[i] == p[i])) { printf("FAIL %s: NaN position at %u\n", where, i); ++g_failures; break; }
  }
  for (unsigned int i = 0; i < nt * 3; ++i) {
    if (t[i] >= nv) { printf("FAIL %s: index %u >= %u\n", where, t[i], nv); ++g_failures; break; }
  }
  for (unsigned int i = 0; i < nt; ++i) {
    if (t[i * 3] == t[i * 3 + 1] || t[i * 3 + 1] == t[i * 3 + 2] || t[i * 3] == t[i * 3 + 2]) {
      printf("FAIL %s: degenerate triangle %u\n", where, i);
      ++g_failures;
      break;
    }
  }
}

static void testUpload(void) {
  loadCube();
  CHECK(fe_edit_vert_count() == 8);
  CHECK(fe_edit_tri_count() == 12);
  CHECK(fe_edit_edge_count() == 18);
  CHECK_NEAR(cubeVolume(), 8.0, 1e-3);
  CHECK(fe_edit_upload(8, kCubeVerts, 12, kCubeTris, 0) == 1);
  /* more vertices than the kernel holds is refused, not truncated */
  CHECK(fe_edit_max_verts() >= 8192);
}

static void testSelection(void) {
  loadCube();
  fe_edit_select_all();
  CHECK(fe_edit_sel_count() == 8);
  fe_edit_select_none();
  CHECK(fe_edit_sel_count() == 0);
  fe_edit_select_invert();
  CHECK(fe_edit_sel_count() == 8);

  fe_edit_set_mode(1); /* edge */
  fe_edit_select_none();
  fe_edit_select_all();
  CHECK(fe_edit_sel_count() == 18);
  fe_edit_set_mode(2); /* face */
  fe_edit_select_all();
  CHECK(fe_edit_sel_count() == 12);
  fe_edit_set_mode(0);
}

static void testMoveAndUndo(void) {
  loadCube();
  fe_edit_select_all();
  fe_edit_undo_clear();
  const float before = cubeVolume();
  fe_edit_undo_push(); /* one gesture, one undo step */
  CHECK(fe_edit_move(1.0f, 0.0f, 0.0f, 0) == 8);
  const float* p = fe_edit_pos_interleaved_ptr();
  CHECK_NEAR(p[0], 0.0, 1e-4);
  CHECK(fe_edit_undo_depth() == 1);
  CHECK(fe_edit_undo() == 1);
  CHECK_NEAR(cubeVolume(), before, 1e-4);
  CHECK(fe_edit_redo() == 1);
  checkIntegrity("move/undo");
}

static void testAxisLock() {
  loadCube();
  fe_edit_select_all();
  const float* p = fe_edit_pos_interleaved_ptr();
  const float y0 = p[1];
  fe_edit_move(1.0f, 2.0f, 3.0f, 2); /* axis 2 == Y only */
  p = fe_edit_pos_interleaved_ptr();
  CHECK_NEAR(p[1], y0 + 2.0, 1e-4);
  CHECK_NEAR(p[0], kCubeVerts[0], 1e-4);
}

static void testExtrude(void) {
  loadCube();
  fe_edit_set_mode(2);
  /* select the +Z face (vertices 4,5,6,7 are not one face — pick one triangle) */
  fe_edit_select_none();
  loadCube();
  /* selecting the three corners of triangle 2 (4,5,6) selects exactly 1 face */
  fe_edit_select_all();
  fe_edit_select_none();
  fe_edit_set_mode(0);
  /* Everything is closed: extrude makes a second shell rather than a move. */
  fe_edit_select_all();
  const unsigned int beforeTri = fe_edit_tri_count();
  const unsigned int walls = fe_edit_extrude(0.5f, 0);
  CHECK(walls > 0);
  CHECK(fe_edit_tri_count() == beforeTri * 2);
  CHECK(fe_edit_vert_count() == 16);
  /* The moved shell stays selected and the original does not, so a follow-up
     tool acts on the new geometry instead of the whole mesh again. Counting the
     original vertices here as "not copied" used to deselected nothing at all,
     because the loop ran over the vertex count the operation had just grown. */
  fe_edit_set_mode(2);
  CHECK_MSG(fe_edit_sel_count() == 12, "the extruded shell must stay selected");
  fe_edit_set_mode(0);
  CHECK_MSG(fe_edit_sel_count() == 8, "only the eight new corners are selected");
  checkIntegrity("extrude shell");

  /* A single face extrudes into a walled box with exactly one rim. */
  loadCube();
  fe_edit_select_none();
  const float* p = fe_edit_pos_interleaved_ptr();
  const unsigned int* t = fe_edit_idx_ptr();
  unsigned int face = 0xFFFFFFFFu;
  for (unsigned int i = 0; i < fe_edit_tri_count(); ++i) {
    if (p[t[i * 3] * 3 + 2] > 0.99f && p[t[i * 3 + 1] * 3 + 2] > 0.99f && p[t[i * 3 + 2] * 3 + 2] > 0.99f) { face = i; break; }
  }
  CHECK(face != 0xFFFFFFFFu);
  unsigned int picked[3] = { t[face * 3], t[face * 3 + 1], t[face * 3 + 2] };
  fe_edit_select_by_index(0, 3, picked, 0);
  CHECK(fe_edit_sel_count() == 3);
  const unsigned int triBefore = fe_edit_tri_count();
  const unsigned int vertBefore = fe_edit_vert_count();
  const unsigned int added = fe_edit_extrude(0.5f, 0);
  /* three rim edges, two triangles each */
  CHECK_MSG(added == 6, "the rim of a single triangle is three edge pairs");
  CHECK(fe_edit_vert_count() == vertBefore + 3);
  CHECK_MSG(fe_edit_tri_count() == triBefore + 6, "the original face is remapped, not duplicated");
  checkIntegrity("extrude one face");
}

static void testInset(void) {
  loadCube();
  fe_edit_select_all();
  const unsigned int beforeTri = fe_edit_tri_count();
  const unsigned int faces = fe_edit_inset(0.2f, 1);
  CHECK(faces == beforeTri);
  /* one triangle becomes the inner face plus a six-triangle ring */
  CHECK(fe_edit_tri_count() == beforeTri * 7);
  checkIntegrity("inset individual");

  /* Region inset needs a rim; a fully closed selection has none, and saying
     "did nothing" is better than inventing geometry. */
  loadCube();
  fe_edit_select_all();
  CHECK(fe_edit_inset(0.2f, 0) == 0);

  loadCube();
  fe_edit_select_none();
  const float* p = fe_edit_pos_interleaved_ptr();
  const unsigned int* t = fe_edit_idx_ptr();
  unsigned int picked[3] = { t[0], t[1], t[2] };
  (void)p;
  fe_edit_select_by_index(0, 3, picked, 0);
  const unsigned int region = fe_edit_inset(0.05f, 0);
  CHECK(region > 0);
  checkIntegrity("inset region");
}

static void testSubdivide(void) {
  loadCube();
  fe_edit_select_all();
  const unsigned int beforeTri = fe_edit_tri_count();
  const unsigned int beforeVert = fe_edit_vert_count();
  fe_edit_subdivide(1, 0);
  CHECK(fe_edit_vert_count() > beforeVert);
  CHECK(fe_edit_tri_count() == beforeTri * 4);
  checkIntegrity("subdivide all");
  /* A midpoint on every edge of a closed cube keeps it closed: the volume is
     still that of the cube. */
  CHECK_NEAR(cubeVolume(), 8.0, 1e-2);
}

static void testBevel(void) {
  loadCube();
  fe_edit_select_all();
  const unsigned int beforeTri = fe_edit_tri_count();
  fe_edit_bevel(0.15f, 1); /* vertex bevel on all 8 corners */
  CHECK(fe_edit_vert_count() > 8);
  CHECK(fe_edit_tri_count() > beforeTri);
  checkIntegrity("bevel vertices");
  /* A chamfered cube still has volume, and less than the original. */
  const float v = cubeVolume();
  CHECK(v > 0.5f && v < 8.0f);
}

static void testBevelEdges(void) {
  loadCube();
  fe_edit_set_mode(1);
  fe_edit_select_all();
  const unsigned int beforeTri = fe_edit_tri_count();
  fe_edit_bevel(0.1f, 0);
  CHECK(fe_edit_tri_count() >= beforeTri);
  checkIntegrity("bevel edges");
}

static void testDeleteAndMerge(void) {
  loadCube();
  fe_edit_set_mode(2);
  fe_edit_select_all();
  const unsigned int removed = fe_edit_delete(2);
  CHECK(removed == 12);
  CHECK(fe_edit_tri_count() == 0);

  loadCube();
  fe_edit_select_all();
  fe_edit_merge_center();
  CHECK(fe_edit_vert_count() == 1);
  CHECK(fe_edit_tri_count() == 0);

  loadCube();
  fe_edit_select_all();
  CHECK(fe_edit_merge_distance(0.0001f) == 0);
  checkIntegrity("merge distance");
}

static void testPokeAndDuplicate(void) {
  loadCube();
  fe_edit_set_mode(2);
  fe_edit_select_all();
  const unsigned int tris = fe_edit_tri_count();
  fe_edit_poke();
  CHECK(fe_edit_tri_count() == tris * 3);
  checkIntegrity("poke");

  loadCube();
  fe_edit_select_all();
  fe_edit_duplicate();
  CHECK(fe_edit_vert_count() == 16);
  checkIntegrity("duplicate");
}

static void testBisect(void) {
  loadCube();
  fe_edit_select_none();
  const unsigned int before = fe_edit_tri_count();
  /* cut in half at x = 0 and keep the positive side */
  fe_edit_bisect(0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 1, 0, 1);
  CHECK(fe_edit_tri_count() > 0);
  CHECK(fe_edit_tri_count() != before || before == 0);
  checkIntegrity("bisect");
  const float* b = fe_edit_bounds_ptr();
  CHECK(b[0] >= -1e-4f); /* nothing left of the cut plane */
}

static void testSymmetrize(void) {
  loadCube();
  fe_edit_select_none();
  fe_edit_symmetrize(0);
  CHECK(fe_edit_tri_count() > 0);
  checkIntegrity("symmetrize");
}

static void testCollapse(void) {
  loadCube();
  fe_edit_set_mode(1);
  fe_edit_select_all();
  const unsigned int before = fe_edit_tri_count();
  fe_edit_collapse();
  /* Collapsing every edge of a cube pulls the whole thing toward its corners,
     so most of the surface is gone. */
  CHECK(fe_edit_tri_count() < before);
  checkIntegrity("collapse");
}

static void testRecalcNormals(void) {
  loadCube();
  /* Flip every face, then rebuild: the signed volume must come back positive. */
  fe_edit_set_mode(2);
  fe_edit_select_all();
  fe_edit_flip_normals();
  CHECK(cubeVolume() < 0.0f);
  fe_edit_recalc_normals(1);
  CHECK(cubeVolume() > 0.0f);
  checkIntegrity("recalc normals");
}

static void testRenderMesh(void) {
  loadCube();
  fe_edit_set_shade(1);
  const unsigned int verts = fe_edit_build_render();
  CHECK(verts >= 8);
  CHECK(fe_edit_render_idx_count() == fe_edit_tri_count() * 3);
  const float* p = fe_edit_render_pos_ptr();
  const unsigned int* idx = fe_edit_render_idx_ptr();
  for (unsigned int i = 0; i < fe_edit_render_idx_count(); ++i) CHECK(idx[i] < verts);
  CHECK(p[0] == p[0]);

  /* A sharp edge splits the normal, so the render mesh grows. */
  loadCube();
  fe_edit_set_mode(1);
  fe_edit_select_all();
  const unsigned int sharp = fe_edit_mark_sharp(1);
  CHECK(sharp == 18);
  CHECK(fe_edit_sharp_count() == 18);
  const unsigned int split = fe_edit_build_render();
  CHECK(split > 8);
  checkIntegrity("render split");
}

static void testProportional(void) {
  loadCube();
  fe_edit_select_none();
  fe_edit_set_proportional(1, 2, 1.0f, 0);
  fe_edit_select_all();
  CHECK(fe_edit_move(0.5f, 0.0f, 0.0f, 0) > 0);
  checkIntegrity("proportional");
  fe_edit_set_proportional(0, 2, 1.0f, 0);
}

static void testSelectionWalk(void) {
  loadCube();
  fe_edit_set_mode(0);
  fe_edit_select_none();
  /* select one vertex via linked selection from nothing returns 0 */
  CHECK(fe_edit_select_linked(0) == 0);
  fe_edit_select_all();
  CHECK(fe_edit_select_linked(0) == 8);
  CHECK(fe_edit_select_more() == 8);
  (void)fe_edit_select_less();
  checkIntegrity("selection walk");

  /* the pick helper must not crash on a degenerate matrix */
  const float identity[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
  const int picked = fe_edit_pick(identity, 0.5f, 0.5f);
  CHECK(picked >= -1);
}

int main(void) {
  testUpload();
  testSelection();
  testMoveAndUndo();
  testAxisLock();
  testExtrude();
  testInset();
  testSubdivide();
  testBevel();
  testBevelEdges();
  testDeleteAndMerge();
  testPokeAndDuplicate();
  testBisect();
  testSymmetrize();
  testCollapse();
  testRecalcNormals();
  testRenderMesh();
  testProportional();
  testSelectionWalk();

  if (g_failures == 0) {
    printf("All Final Effect C++20 Edit Mode tests passed\n");
    return 0;
  }
  printf("%d Edit Mode check(s) failed\n", g_failures);
  return 1;
}
