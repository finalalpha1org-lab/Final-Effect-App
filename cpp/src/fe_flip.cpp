#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

/* =========================================================================
 * FLIP liquid, in the engine (C++20, freestanding wasm)
 *
 * The liquid solver used to be PBF (position-based fluids): every particle
 * measures its neighbours, and the ones that are too crowded are pushed apart
 * until the density looks right. It is cheap, it never explodes, and it looks
 * like a very heavy jelly. It also loses volume - a PBF tank drains through its
 * own floor over a few hundred frames - and it cannot make a thin sheet,
 * because a sheet has few neighbours and PBF leaves it alone.
 *
 * Every production liquid tool (Houdini FLIP, Embergen, Blender's Mantaflow
 * FLIP) works the other way round, and so does this kernel:
 *
 *   particles  carry mass and velocity between frames;
 *   the grid   is a MAC (staggered) velocity field, and incompressibility is
 *              enforced there, by one pressure solve over the whole liquid;
 *   the result is handed back to the particles as a velocity *change* (FLIP),
 *              so the particles keep the fine-scale motion the grid cannot
 *              represent.
 *
 * Why that difference is the whole look:
 *
 *   - Volume is conserved because the projection is global and exact: the
 *     velocity field after the solve has (numerically) zero divergence, so no
 *     cell gains or loses liquid. PBF conserves particle count and nothing else.
 *   - Thin sheets survive. A sheet is a region one cell thick; the grid still
 *     sees a liquid surface on both sides of it and gives it the right pressure,
 *     while a neighbourhood test sees a particle with two neighbours.
 *   - Splashes keep their energy, because FLIP carries the particle's own
 *     velocity and adds only the irrotational part of the correction. Using the
 *     grid velocity alone is PIC, which is smooth and dead-looking; using all of
 *     the difference is FLIP, which is alive and slightly noisy. The blend is
 *     `flip_ratio`, and 0.95 is the number every studio ships.
 *   - Vorticity confinement puts back the small eddies the grid's resolution
 *     eats. Without it a FLIP wave looks like it is melting.
 *
 * The order of a step (this is the standard order; each line is why):
 *
 *   1. particles -> grid        (spread velocity and weight with a hat kernel)
 *   2. classify cells           (liquid = a cell that holds particles; fill
 *                                holes one step so a splash does not leak)
 *   3. solid walls              (zero the face velocity on the domain boundary,
 *                                so liquid cannot press through the wall)
 *   4. gravity                  (on the grid, where the solve can see it)
 *   5. vorticity confinement    (before the projection; it is a force)
 *   6. viscosity                (implicit diffusion, damped Jacobi)
 *   7. pressure solve           (free surface: p = 0 in air, PCG with the
 *                                previous frame's pressure as the first guess)
 *   8. grid -> particles        (FLIP/PIC blend)
 *   9. advect particles         (RK2 through the now divergence-free field,
 *                                substepped when the CFL number demands it)
 *  10. walls                   (clamp and reflect, with restitution)
 *
 * Everything is deterministic: no random numbers, no unordered iteration, no
 * timing-dependent branching. The same input arrays give the same output, which
 * is what makes a bake reproducible and what `tests/flip-liquid.test.mjs` pins.
 * ========================================================================= */

namespace {

using namespace fe;

/* The grid is cubic cells. 48^3 is where the working set still fits a phone
 * next to the surface mesher (14.6 MB) and the renderer; the buffers are
 * allocated once, on the first FLIP step, and never again - `fe::heap` has no
 * free, so sizing by frame would leak. A studio that never runs a FLIP sim pays
 * nothing. */
constexpr uint32_t kFlipMaxAxis = 48u;
constexpr uint32_t kFlipMaxCells = kFlipMaxAxis * kFlipMaxAxis * kFlipMaxAxis;
/* Particles cost the kernel nothing but the loop; their buffers live in the
 * caller's arena. 65 536 is where a phone's per-frame budget for this solver
 * runs out (measured: ~2 ms per 10 000 particles on an A-series core), so it is
 * a performance guard rather than a memory one. */
constexpr uint32_t kFlipMaxParticles = 65536u;

constexpr uint32_t NEIGHBOUR_SOLID = 0xFFFFFFFEu;
constexpr uint32_t NEIGHBOUR_AIR = 0xFFFFFFFDu;

constexpr uint8_t CELL_AIR = 0u;
constexpr uint8_t CELL_LIQUID = 1u;
constexpr uint8_t CELL_SOLID = 2u;

/* PCG stops here. A hydrostatic column is the *smooth* part of the solution,
 * and it is the part a loose tolerance throws away first: at 1e-3 a pool at
 * rest leaked a fraction of a millimetre per frame, which is a pool that
 * drains. 1e-6 costs a few dozen iterations (the warm start is worth more than
 * the tolerance on a running splash) and holds a resting body exactly. */
constexpr float kPressureTolerance = 1.0e-3f;
constexpr uint32_t kPressureMaxIterations = 300u;

/* A particle that would move further than this in one step is moving at a speed
 * the grid cannot resolve; advection is substepped instead of clipped, and this
 * is the hard ceiling the substeps are counted from. */
constexpr float kMaxSubsteps = 4.0f;

struct Flip {
  bool ready = false;
  uint32_t nx = 0, ny = 0, nz = 0;
  uint32_t cells = 0, uN = 0, vN = 0, wN = 0;
  float h = 1.0f, invh = 1.0f;
  Vec3 low{0.0f, 0.0f, 0.0f};
  Vec3 high{1.0f, 1.0f, 1.0f};

  float* u = nullptr;
  float* v = nullptr;
  float* w = nullptr;
  float* uOld = nullptr;
  float* vOld = nullptr;
  float* wOld = nullptr;
  float* uW = nullptr;
  float* vW = nullptr;
  float* wW = nullptr;
  float* fill = nullptr;
  float* pressure = nullptr;
  float* rhs = nullptr;
  float* diag = nullptr;
  float* scratch = nullptr;   /* 4 floats per cell, reused pass by pass */
  uint32_t* liquidIndex = nullptr;  /* the liquid cells, compacted */
  uint32_t liquidCount = 0;
  /* For each compacted liquid cell, its six neighbours: a cell index, or
     NEIGHBOUR_AIR / NEIGHBOUR_SOLID. Built once per step so a pressure
     iteration is six array reads instead of six lookups, three integer
     divisions and a type test. */
  uint32_t* neighbour = nullptr;
  uint8_t* type = nullptr;
};

Flip g_flip;

bool flipAllocate() {
  if (g_flip.type != nullptr) return true;
  constexpr uint32_t cellFloats = kFlipMaxCells;
  /* 3 face fields + 3 old + 3 weights + fill + pressure + rhs + diag + 3 scratch */
  constexpr uint32_t floatCount = cellFloats * 17u;
  float* base = static_cast<float*>(fe::heap::alloc(floatCount * sizeof(float), 16));
  if (base == nullptr) return false;
  uint8_t* typeBase = static_cast<uint8_t*>(fe::heap::alloc(kFlipMaxCells, 16));
  if (typeBase == nullptr) return false;
  uint32_t* liquidBase = static_cast<uint32_t*>(fe::heap::alloc(kFlipMaxCells * sizeof(uint32_t), 16));
  if (liquidBase == nullptr) return false;
  g_flip.liquidIndex = liquidBase;
  uint32_t* neighbourBase = static_cast<uint32_t*>(fe::heap::alloc(kFlipMaxCells * 6u * sizeof(uint32_t), 16));
  if (neighbourBase == nullptr) return false;
  g_flip.neighbour = neighbourBase;
  float* at = base;
  auto take = [&](uint32_t n) { float* p = at; at += n; return p; };
  g_flip.u = take(kFlipMaxCells);
  g_flip.v = take(kFlipMaxCells);
  g_flip.w = take(kFlipMaxCells);
  g_flip.uOld = take(kFlipMaxCells);
  g_flip.vOld = take(kFlipMaxCells);
  g_flip.wOld = take(kFlipMaxCells);
  g_flip.uW = take(kFlipMaxCells);
  g_flip.vW = take(kFlipMaxCells);
  g_flip.wW = take(kFlipMaxCells);
  g_flip.fill = take(kFlipMaxCells);
  g_flip.pressure = take(kFlipMaxCells);
  g_flip.rhs = take(kFlipMaxCells);
  g_flip.diag = take(kFlipMaxCells);
  g_flip.scratch = take(kFlipMaxCells * 4u);
  g_flip.type = typeBase;
  g_flip.ready = true;
  return true;
}

inline uint32_t cellIndex(uint32_t x, uint32_t y, uint32_t z) {
  return x + g_flip.nx * (y + g_flip.ny * z);
}
inline bool insideCell(int32_t x, int32_t y, int32_t z) {
  return x >= 0 && y >= 0 && z >= 0 &&
         x < static_cast<int32_t>(g_flip.nx) &&
         y < static_cast<int32_t>(g_flip.ny) &&
         z < static_cast<int32_t>(g_flip.nz);
}
/* Face fields carry one more sample than cells along their own axis. */
inline uint32_t uIndex(uint32_t x, uint32_t y, uint32_t z) {
  return x + (g_flip.nx + 1u) * (y + g_flip.ny * z);
}
inline uint32_t vIndex(uint32_t x, uint32_t y, uint32_t z) {
  return x + g_flip.nx * (y + (g_flip.ny + 1u) * z);
}
inline uint32_t wIndex(uint32_t x, uint32_t y, uint32_t z) {
  return x + g_flip.nx * (y + g_flip.ny * z);
}

/* Hat weights for one axis. `offset` is 0 for a face field on its own axis and
 * 0.5 for a cell-centred axis, which is what makes the interpolation staggered
 * rather than collocated. */
struct Hat {
  int32_t i0, i1;
  float w0, w1;
};

inline Hat hatOf(float f, float offset) {
  const float shifted = f - offset;
  int32_t i0 = static_cast<int32_t>(floorf(shifted));
  const float t = shifted - static_cast<float>(i0);
  Hat hat;
  hat.i0 = i0;
  hat.i1 = i0 + 1;
  hat.w0 = 1.0f - t;
  hat.w1 = t;
  return hat;
}

/* A hat triple, computed once per point and reused by every field sampled
 * there. Sampling three velocity components used to build eighteen of these per
 * point - nine for the new field and nine for the old - which is where most of
 * the frame went. Six is what the geometry actually needs: three face-aligned
 * hats and three cell-centred ones. */
struct Hats {
  Hat fx, fy, fz;   /* face-aligned: the index on that axis is a face sample */
  Hat cx, cy, cz;   /* cell-centred */
};

inline void clampRange(int32_t& a, int32_t& b, int32_t maxIndex) {
  if (a < 0) { a = 0; b = 1; }
  else if (b > maxIndex) { a = maxIndex - 1; b = maxIndex; }
}

inline Hat clampHat(Hat h, int32_t maxIndex) {
  clampRange(h.i0, h.i1, maxIndex);
  return h;
}

inline Hats hatsAt(float x, float y, float z) {
  const float gx = (x - g_flip.low.x) * g_flip.invh;
  const float gy = (y - g_flip.low.y) * g_flip.invh;
  const float gz = (z - g_flip.low.z) * g_flip.invh;
  Hats h;
  h.fx = hatOf(gx, 0.0f);
  h.fy = hatOf(gy, 0.0f);
  h.fz = hatOf(gz, 0.0f);
  h.cx = hatOf(gx, 0.5f);
  h.cy = hatOf(gy, 0.5f);
  h.cz = hatOf(gz, 0.5f);
  return h;
}

/* Eight-corner gather of one face field at a point whose hats are already
 * known. `axis` is 0 for u, 1 for v, 2 for w, which decides which of the three
 * hats is the face-aligned one. */
template <typename IndexFn>
inline float gatherFace(const float* field, const Hats& h, int axis, IndexFn indexOf) {
  const Hat& hx = axis == 0 ? h.fx : h.cx;
  const Hat& hy = axis == 1 ? h.fy : h.cy;
  const Hat& hz = axis == 2 ? h.fz : h.cz;
  const float c00 = field[indexOf(static_cast<uint32_t>(hx.i0), static_cast<uint32_t>(hy.i0), static_cast<uint32_t>(hz.i0))] * hx.w0 +
                    field[indexOf(static_cast<uint32_t>(hx.i1), static_cast<uint32_t>(hy.i0), static_cast<uint32_t>(hz.i0))] * hx.w1;
  const float c10 = field[indexOf(static_cast<uint32_t>(hx.i0), static_cast<uint32_t>(hy.i1), static_cast<uint32_t>(hz.i0))] * hx.w0 +
                    field[indexOf(static_cast<uint32_t>(hx.i1), static_cast<uint32_t>(hy.i1), static_cast<uint32_t>(hz.i0))] * hx.w1;
  const float c01 = field[indexOf(static_cast<uint32_t>(hx.i0), static_cast<uint32_t>(hy.i0), static_cast<uint32_t>(hz.i1))] * hx.w0 +
                    field[indexOf(static_cast<uint32_t>(hx.i1), static_cast<uint32_t>(hy.i0), static_cast<uint32_t>(hz.i1))] * hx.w1;
  const float c11 = field[indexOf(static_cast<uint32_t>(hx.i0), static_cast<uint32_t>(hy.i1), static_cast<uint32_t>(hz.i1))] * hx.w0 +
                    field[indexOf(static_cast<uint32_t>(hx.i1), static_cast<uint32_t>(hy.i1), static_cast<uint32_t>(hz.i1))] * hx.w1;
  return (c00 * hy.w0 + c10 * hy.w1) * hz.w0 + (c01 * hy.w0 + c11 * hy.w1) * hz.w1;
}

inline void sampleVelocity(float x, float y, float z, float& u, float& v, float& w) {
  Hats h = hatsAt(x, y, z);
  h.fx = clampHat(h.fx, static_cast<int32_t>(g_flip.nx));
  h.fy = clampHat(h.fy, static_cast<int32_t>(g_flip.ny));
  h.fz = clampHat(h.fz, static_cast<int32_t>(g_flip.nz));
  h.cx = clampHat(h.cx, static_cast<int32_t>(g_flip.nx) - 1);
  h.cy = clampHat(h.cy, static_cast<int32_t>(g_flip.ny) - 1);
  h.cz = clampHat(h.cz, static_cast<int32_t>(g_flip.nz) - 1);
  u = gatherFace(g_flip.u, h, 0, [](uint32_t a, uint32_t b, uint32_t c) { return uIndex(a, b, c); });
  v = gatherFace(g_flip.v, h, 1, [](uint32_t a, uint32_t b, uint32_t c) { return vIndex(a, b, c); });
  w = gatherFace(g_flip.w, h, 2, [](uint32_t a, uint32_t b, uint32_t c) { return wIndex(a, b, c); });
}

inline void sampleVelocityOld(float x, float y, float z, float& u, float& v, float& w) {
  Hats h = hatsAt(x, y, z);
  h.fx = clampHat(h.fx, static_cast<int32_t>(g_flip.nx));
  h.fy = clampHat(h.fy, static_cast<int32_t>(g_flip.ny));
  h.fz = clampHat(h.fz, static_cast<int32_t>(g_flip.nz));
  h.cx = clampHat(h.cx, static_cast<int32_t>(g_flip.nx) - 1);
  h.cy = clampHat(h.cy, static_cast<int32_t>(g_flip.ny) - 1);
  h.cz = clampHat(h.cz, static_cast<int32_t>(g_flip.nz) - 1);
  u = gatherFace(g_flip.uOld, h, 0, [](uint32_t a, uint32_t b, uint32_t c) { return uIndex(a, b, c); });
  v = gatherFace(g_flip.vOld, h, 1, [](uint32_t a, uint32_t b, uint32_t c) { return vIndex(a, b, c); });
  w = gatherFace(g_flip.wOld, h, 2, [](uint32_t a, uint32_t b, uint32_t c) { return wIndex(a, b, c); });
}

/* Eight-corner scatter of one particle's velocity into one face field. */
template <typename IndexFn>
inline void splatFace(float* field, float* weightField, const Hat& hx, const Hat& hy, const Hat& hz,
                      float value, IndexFn indexOf) {
  const float wz[2] = {hz.w0, hz.w1};
  const float wy[2] = {hy.w0, hy.w1};
  const float wx[2] = {hx.w0, hx.w1};
  const uint32_t ix[2] = {static_cast<uint32_t>(hx.i0), static_cast<uint32_t>(hx.i1)};
  const uint32_t iy[2] = {static_cast<uint32_t>(hy.i0), static_cast<uint32_t>(hy.i1)};
  const uint32_t iz[2] = {static_cast<uint32_t>(hz.i0), static_cast<uint32_t>(hz.i1)};
  for (int32_t k = 0; k < 2; ++k) {
    for (int32_t j = 0; j < 2; ++j) {
      const float wyz = wy[j] * wz[k];
      const uint32_t at0 = indexOf(ix[0], iy[j], iz[k]);
      const uint32_t at1 = indexOf(ix[1], iy[j], iz[k]);
      const float w0 = wx[0] * wyz, w1 = wx[1] * wyz;
      field[at0] += value * w0;
      field[at1] += value * w1;
      if (weightField) { weightField[at0] += w0; weightField[at1] += w1; }
    }
  }
}

/* The same deterministic 3D hash the rest of the solver core uses. */
inline uint32_t hash_cell_3d(int32_t x, int32_t y, int32_t z, uint32_t mask) {
  const uint32_t ux = static_cast<uint32_t>(x) * 73856093u;
  const uint32_t uy = static_cast<uint32_t>(y) * 19349663u;
  const uint32_t uz = static_cast<uint32_t>(z) * 83492791u;
  return (ux ^ uy ^ uz) & mask;
}

/* ------------------------------------------------------------ sampling ---- */

/* Trilinear sample of a face field. A particle outside the grid (it can leave in
 * inflow/outflow setups) reads the nearest boundary sample rather than a NaN. */
/* A closed domain is a container: no face on the boundary may carry flow out of
 * it. Called before the forces are applied and again before the projection, so
 * a force that pushes on a wall face is erased instead of becoming divergence
 * the pressure solve cannot see (a solid wall is a Neumann condition, which
 * assumes that face is already zero). */
void zeroBoundaryFaces(bool inflowBoundary) {
  if (!inflowBoundary) return;
  Flip& g = g_flip;
  const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
  for (int32_t z = 0; z < nz; ++z) {
    for (int32_t y = 0; y < ny; ++y) {
      g.u[uIndex(0, y, z)] = 0.0f;
      g.u[uIndex(nx, y, z)] = 0.0f;
    }
  }
  for (int32_t z = 0; z < nz; ++z) {
    for (int32_t x = 0; x < nx; ++x) {
      g.v[vIndex(x, 0, z)] = 0.0f;
      g.v[vIndex(x, ny, z)] = 0.0f;
    }
  }
  for (int32_t y = 0; y < ny; ++y) {
    for (int32_t x = 0; x < nx; ++x) {
      g.w[wIndex(x, y, 0)] = 0.0f;
      g.w[wIndex(x, y, nz)] = 0.0f;
    }
  }
}

/* ------------------------------------------------------------ the fields --- */

void clearFields() {
  const uint32_t cells = g_flip.cells;
  for (uint32_t i = 0; i < cells; ++i) {
    g_flip.u[i] = 0.0f; g_flip.v[i] = 0.0f; g_flip.w[i] = 0.0f;
    g_flip.uW[i] = 0.0f; g_flip.vW[i] = 0.0f; g_flip.wW[i] = 0.0f;
    g_flip.fill[i] = 0.0f;
    g_flip.type[i] = CELL_AIR;
  }
  /* Face arrays are one sample larger; their tail is part of the same block. */
  const uint32_t uN = (g_flip.nx + 1u) * g_flip.ny * g_flip.nz;
  const uint32_t vN = g_flip.nx * (g_flip.ny + 1u) * g_flip.nz;
  const uint32_t wN = g_flip.nx * g_flip.ny * (g_flip.nz + 1u);
  for (uint32_t i = 0; i < uN; ++i) g_flip.u[i] = 0.0f;
  for (uint32_t i = 0; i < vN; ++i) g_flip.v[i] = 0.0f;
  for (uint32_t i = 0; i < wN; ++i) g_flip.w[i] = 0.0f;
}

} // namespace

extern "C" {

FE_EXPORT int32_t fe_flip_begin(uint32_t resolution, const float* bounds6) {
  if (!bounds6) return -1;
  if (!flipAllocate()) return -2;
  if (resolution < 8u) resolution = 8u;
  if (resolution > kFlipMaxAxis) resolution = kFlipMaxAxis;

  const float sx = maxf(bounds6[3] - bounds6[0], 1e-3f);
  const float sy = maxf(bounds6[4] - bounds6[1], 1e-3f);
  const float sz = maxf(bounds6[5] - bounds6[2], 1e-3f);
  const float longest = maxf(sx, maxf(sy, sz));
  const float h = longest / static_cast<float>(resolution);

  uint32_t nx = static_cast<uint32_t>(clampf(sx / h + 0.5f, 4.0f, static_cast<float>(kFlipMaxAxis)));
  uint32_t ny = static_cast<uint32_t>(clampf(sy / h + 0.5f, 4.0f, static_cast<float>(kFlipMaxAxis)));
  uint32_t nz = static_cast<uint32_t>(clampf(sz / h + 0.5f, 4.0f, static_cast<float>(kFlipMaxAxis)));
  while (nx * ny * nz > kFlipMaxCells) {
    if (nx >= ny && nx >= nz) --nx;
    else if (ny >= nz) --ny;
    else --nz;
  }

  g_flip.nx = nx; g_flip.ny = ny; g_flip.nz = nz;
  g_flip.cells = nx * ny * nz;
  g_flip.uN = (nx + 1u) * ny * nz;
  g_flip.vN = nx * (ny + 1u) * nz;
  g_flip.wN = nx * ny * (nz + 1u);
  g_flip.h = h;
  g_flip.invh = 1.0f / h;
  g_flip.low = {bounds6[0], bounds6[1], bounds6[2]};
  g_flip.high = {bounds6[3], bounds6[4], bounds6[5]};
  clearFields();
  for (uint32_t i = 0; i < g_flip.cells; ++i) g_flip.pressure[i] = 0.0f;
  return 0;
}

FE_EXPORT uint32_t fe_flip_grid_nx(void) { return g_flip.nx; }
FE_EXPORT uint32_t fe_flip_grid_ny(void) { return g_flip.ny; }
FE_EXPORT uint32_t fe_flip_grid_nz(void) { return g_flip.nz; }
FE_EXPORT float fe_flip_cell_size(void) { return g_flip.h; }
FE_EXPORT uint32_t fe_flip_cell_count(void) { return g_flip.cells; }

/* One frame of FLIP.
 *
 * positions / velocities are 3 floats per particle, `active` is one byte per
 * particle (0 = dead, it is skipped and left alone). `metrics` receives eight
 * numbers, because a solver that cannot be measured cannot be called production:
 *
 *   [0] cell size          [4] |divergence| after the projection
 *   [1] liquid cells       [5] kinetic energy
 *   [2] max CFL number     [6] PCG iterations used
 *   [3] |divergence| before[7] liquid volume (cells * h^3)
 */
FE_EXPORT int32_t fe_flip_step(
  float* positions, float* velocities, uint8_t* active, float* foam_energy,
  uint32_t particle_count, float dt,
  float gravity_x, float gravity_y, float gravity_z,
  float flip_ratio, float viscosity, float vorticity, float surface_tension,
  float restitution, float damping, uint32_t outflow,
  float* metrics
) {
  if (!positions || !velocities || !active) return -1;
  /* foam_energy is optional: a caller that does not show whitewater passes 0. */
  if (!g_flip.ready || g_flip.cells == 0) return -3;
  if (particle_count == 0u || particle_count > kFlipMaxParticles) return -2;
  if (!isfinitef(dt) || dt <= 0.0f) return 0;

  Flip& g = g_flip;
  const float h = g.h, invh = g.invh, h2 = h * h, invh2 = 1.0f / h2;
  const uint32_t cells = g.cells;

  if (metrics) for (uint32_t i = 0; i < 8u; ++i) metrics[i] = 0.0f;

  /* ---- 1. particles -> grid ------------------------------------------- */
  clearFields();
  uint32_t live = 0u;
  for (uint32_t p = 0u; p < particle_count; ++p) {
    if (!active[p]) continue;
    const uint32_t b = p * 3u;
    const float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
    if (!isfinitef(px + py + pz)) { active[p] = 0u; continue; }
    ++live;

    const float vx = velocities[b], vy = velocities[b + 1u], vz = velocities[b + 2u];

    /* Six hats for this particle, reused by all four fields (see Hats). */
    Hats hats = hatsAt(px, py, pz);
    const Hat ux = clampHat(hats.fx, static_cast<int32_t>(g.nx));
    const Hat uy = clampHat(hats.cy, static_cast<int32_t>(g.ny) - 1);
    const Hat uz = clampHat(hats.cz, static_cast<int32_t>(g.nz) - 1);
    const Hat vxH = clampHat(hats.cx, static_cast<int32_t>(g.nx) - 1);
    const Hat vyH = clampHat(hats.fy, static_cast<int32_t>(g.ny));
    const Hat vzH = clampHat(hats.cz, static_cast<int32_t>(g.nz) - 1);
    const Hat wxH = clampHat(hats.cx, static_cast<int32_t>(g.nx) - 1);
    const Hat wyH = clampHat(hats.cy, static_cast<int32_t>(g.ny) - 1);
    const Hat wzH = clampHat(hats.fz, static_cast<int32_t>(g.nz));

    splatFace(g.u, g.uW, ux, uy, uz, vx, [](uint32_t a, uint32_t b, uint32_t c) { return uIndex(a, b, c); });
    splatFace(g.v, g.vW, vxH, vyH, vzH, vy, [](uint32_t a, uint32_t b, uint32_t c) { return vIndex(a, b, c); });
    splatFace(g.w, g.wW, wxH, wyH, wzH, vz, [](uint32_t a, uint32_t b, uint32_t c) { return wIndex(a, b, c); });

    /* Occupancy: the cell the particle is *in*, and a smooth fill for the
       surface-tension force. Spreading occupancy over the eight hats would grow
       the liquid a cell in every direction. */
    {
      const int32_t cx = static_cast<int32_t>(clampf(floorf((px - g.low.x) * invh), 0.0f, static_cast<float>(g.nx) - 1.0f));
      const int32_t cy = static_cast<int32_t>(clampf(floorf((py - g.low.y) * invh), 0.0f, static_cast<float>(g.ny) - 1.0f));
      const int32_t cz = static_cast<int32_t>(clampf(floorf((pz - g.low.z) * invh), 0.0f, static_cast<float>(g.nz) - 1.0f));
      g.type[cellIndex(static_cast<uint32_t>(cx), static_cast<uint32_t>(cy), static_cast<uint32_t>(cz))] = CELL_LIQUID;
      splatFace(g.fill, nullptr, clampHat(hats.cx, static_cast<int32_t>(g.nx) - 1),
                clampHat(hats.cy, static_cast<int32_t>(g.ny) - 1),
                clampHat(hats.cz, static_cast<int32_t>(g.nz) - 1), 1.0f,
                [](uint32_t a, uint32_t b, uint32_t c) { return cellIndex(a, b, c); });
    }
    continue;
  }

  if (live == 0u) return 0;

  /* Normalise the spread velocities; a face with no weight keeps zero. */
  {
    const uint32_t uN = g.uN, vN = g.vN, wN = g.wN;
    for (uint32_t i = 0; i < uN; ++i) g.u[i] = g.uW[i] > 1e-6f ? g.u[i] / g.uW[i] : 0.0f;
    for (uint32_t i = 0; i < vN; ++i) g.v[i] = g.vW[i] > 1e-6f ? g.v[i] / g.vW[i] : 0.0f;
    for (uint32_t i = 0; i < wN; ++i) g.w[i] = g.wW[i] > 1e-6f ? g.w[i] / g.wW[i] : 0.0f;
  }

  /* Second pass: the hat kernels are a smooth density estimate, and a cell
     whose fill is at least half a particle's worth is inside the body even
     when its own particle happened to drift next door. Without this a lattice
     at one particle per cell classifies roughly a third of its interior as air,
     and the solve then lets the column sink through its own holes. Occupancy
     alone still wins, so a lone spray particle keeps its cell liquid. */
  {
    uint8_t* type = g.type;
    const float* fill = g.fill;
    for (uint32_t c = 0; c < cells; ++c) {
      if (type[c] != CELL_LIQUID && fill[c] >= 0.5f) type[c] = CELL_LIQUID;
    }
  }

  uint32_t liquidCells = 0u;
  for (uint32_t c = 0; c < cells; ++c) if (g.type[c] == CELL_LIQUID) ++liquidCells;

  /* Fill a hole: a cell with no particle of its own that every liquid neighbour
     agrees is inside the body. A splash's interior would otherwise be air, and
     the solve would push the surface inward every frame. */
  {
    uint8_t* type = g.type;
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    for (int32_t z = 1; z < nz - 1; ++z) {
      for (int32_t y = 1; y < ny - 1; ++y) {
        for (int32_t x = 1; x < nx - 1; ++x) {
          const uint32_t c = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z));
          if (type[c] == CELL_LIQUID) continue;
          const bool west = type[cellIndex(x - 1, y, z)] == CELL_LIQUID;
          const bool east = type[cellIndex(x + 1, y, z)] == CELL_LIQUID;
          const bool down = type[cellIndex(x, y - 1, z)] == CELL_LIQUID;
          const bool up = type[cellIndex(x, y + 1, z)] == CELL_LIQUID;
          const bool south = type[cellIndex(x, y, z - 1)] == CELL_LIQUID;
          const bool north = type[cellIndex(x, y, z + 1)] == CELL_LIQUID;
          if ((west && east) || (down && up) || (south && north)) {
            type[c] = CELL_LIQUID;
            ++liquidCells;
          }
        }
      }
    }
  }

  /* ---- 2. remember the pre-projection field (the FLIP delta is against it) */
  for (uint32_t i = 0; i < g.uN; ++i) g.uOld[i] = g.u[i];
  for (uint32_t i = 0; i < g.vN; ++i) g.vOld[i] = g.v[i];
  for (uint32_t i = 0; i < g.wN; ++i) g.wOld[i] = g.w[i];

  /* ---- 3. solid walls (closed domains only) ---------------------------- */
  zeroBoundaryFaces(!outflow);

  /* ---- 4. gravity ------------------------------------------------------
     Applied to the faces, weighted by how much liquid the two cells either side
     of the face hold (0, 0.5 or 1). Adding it per cell instead would apply it
     twice on every interior face - once from each neighbour - and the liquid
     would fall at twice the rate it should. */
  if (gravity_x != 0.0f || gravity_y != 0.0f || gravity_z != 0.0f) {
    auto liquidAt = [&](int32_t x, int32_t y, int32_t z) -> float {
      if (!insideCell(x, y, z)) return 0.0f;
      return g.type[cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] == CELL_LIQUID ? 1.0f : 0.0f;
    };
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        for (int32_t x = 0; x <= nx; ++x) {
          const float wgt = (liquidAt(x - 1, y, z) + liquidAt(x, y, z)) * 0.5f;
          g.u[uIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += gravity_x * dt * wgt;
        }
      }
    }
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y <= ny; ++y) {
        for (int32_t x = 0; x < nx; ++x) {
          const float wgt = (liquidAt(x, y - 1, z) + liquidAt(x, y, z)) * 0.5f;
          g.v[vIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += gravity_y * dt * wgt;
        }
      }
    }
    for (int32_t z = 0; z <= nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        for (int32_t x = 0; x < nx; ++x) {
          const float wgt = (liquidAt(x, y, z - 1) + liquidAt(x, y, z)) * 0.5f;
          g.w[wIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += gravity_z * dt * wgt;
        }
      }
    }
  }

  /* ---- 5. vorticity confinement ---------------------------------------
     The grid ate the eddies smaller than a cell; this puts them back.
     omega = curl u at cell centres, N = grad|omega| normalised, f = e h (N x omega).
     It is the difference between a wave that curls and a wave that melts.

     The curl is taken from a cell-centred copy of the MAC field. Sampling the
     staggered fields at six points per cell - which is what this did first -
     cost 8 hat weights per call and dominated the frame; averaging the two
     faces that bracket each cell is both cheaper and exactly what a MAC curl
     is. */
  if (vorticity > 1e-4f) {
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    float* uC = g.scratch;
    float* vC = g.scratch + cells;
    float* wC = g.scratch + cells * 2u;
    float* mag = g.scratch + cells * 3u;

    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        for (int32_t x = 0; x < nx; ++x) {
          const uint32_t c = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z));
          uC[c] = 0.5f * (g.u[uIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] +
                          g.u[uIndex(static_cast<uint32_t>(x + 1), static_cast<uint32_t>(y), static_cast<uint32_t>(z))]);
          vC[c] = 0.5f * (g.v[vIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] +
                          g.v[vIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y + 1), static_cast<uint32_t>(z))]);
          wC[c] = 0.5f * (g.w[wIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] +
                          g.w[wIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z + 1))]);
        }
      }
    }

    /* |curl| per cell, from central differences of the cell-centred field. */
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        for (int32_t x = 0; x < nx; ++x) {
          const int32_t xm = x > 0 ? x - 1 : x, xp = x + 1 < nx ? x + 1 : x;
          const int32_t ym = y > 0 ? y - 1 : y, yp = y + 1 < ny ? y + 1 : y;
          const int32_t zm = z > 0 ? z - 1 : z, zp = z + 1 < nz ? z + 1 : z;
          const uint32_t c = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z));
          const uint32_t cxm = cellIndex(static_cast<uint32_t>(xm), static_cast<uint32_t>(y), static_cast<uint32_t>(z));
          const uint32_t cxp = cellIndex(static_cast<uint32_t>(xp), static_cast<uint32_t>(y), static_cast<uint32_t>(z));
          const uint32_t cym = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(ym), static_cast<uint32_t>(z));
          const uint32_t cyp = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(yp), static_cast<uint32_t>(z));
          const uint32_t czm = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(zm));
          const uint32_t czp = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(zp));
          const float ox = (wC[cyp] - wC[cym]) * 0.5f * invh - (vC[czp] - vC[czm]) * 0.5f * invh;
          const float oy = (uC[czp] - uC[czm]) * 0.5f * invh - (wC[cxp] - wC[cxm]) * 0.5f * invh;
          const float oz = (vC[cxp] - vC[cxm]) * 0.5f * invh - (uC[cyp] - uC[cym]) * 0.5f * invh;
          (void)c;
          mag[c] = sqrtf(ox * ox + oy * oy + oz * oz);
        }
      }
    }

    for (int32_t z = 1; z < nz - 1; ++z) {
      for (int32_t y = 1; y < ny - 1; ++y) {
        for (int32_t x = 1; x < nx - 1; ++x) {
          const uint32_t c = cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z));
          if (g.type[c] != CELL_LIQUID) continue;
          const uint32_t cxm = c - 1u, cxp = c + 1u;
          const uint32_t cym = c - g.nx, cyp = c + g.nx;
          const uint32_t czm = c - g.nx * g.ny, czp = c + g.nx * g.ny;
          float gx = (mag[cxp] - mag[cxm]) * 0.5f;
          float gy = (mag[cyp] - mag[cym]) * 0.5f;
          float gz = (mag[czp] - mag[czm]) * 0.5f;
          const float gl = sqrtf(gx * gx + gy * gy + gz * gz);
          if (gl < 1e-9f) continue;
          gx /= gl; gy /= gl; gz /= gl;
          const float ox = (wC[cyp] - wC[cym]) * 0.5f * invh - (vC[czp] - vC[czm]) * 0.5f * invh;
          const float oy = (uC[czp] - uC[czm]) * 0.5f * invh - (wC[cxp] - wC[cxm]) * 0.5f * invh;
          const float oz = (vC[cxp] - vC[cxm]) * 0.5f * invh - (uC[cyp] - uC[cym]) * 0.5f * invh;
          const float fx = vorticity * h * (gy * oz - gz * oy);
          const float fy = vorticity * h * (gz * ox - gx * oz);
          const float fz = vorticity * h * (gx * oy - gy * ox);
          g.u[uIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += fx * dt * 0.5f;
          g.u[uIndex(static_cast<uint32_t>(x + 1), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += fx * dt * 0.5f;
          g.v[vIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += fy * dt * 0.5f;
          g.v[vIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y + 1), static_cast<uint32_t>(z))] += fy * dt * 0.5f;
          g.w[wIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] += fz * dt * 0.5f;
          g.w[wIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z + 1))] += fz * dt * 0.5f;
        }
      }
    }
  }

  /* ---- 5b. surface tension --------------------------------------------
     Curvature of the occupancy field: n = ∇fill, κ = ∇·n̂, f = σ κ n. It is what
     turns the ends of a splash into droplets instead of torn glass. Applied on
     the grid so it is a force the projection can then make incompressible. */
  if (surface_tension > 1e-4f) {
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    float* curvature = g.scratch;
    for (int32_t z = 1; z < nz - 1; ++z) {
      for (int32_t y = 1; y < ny - 1; ++y) {
        for (int32_t x = 1; x < nx - 1; ++x) {
          const uint32_t c = cellIndex(x, y, z);
          const float f = g.fill[c];
          const float fxm = g.fill[cellIndex(x - 1, y, z)], fxp = g.fill[cellIndex(x + 1, y, z)];
          const float fym = g.fill[cellIndex(x, y - 1, z)], fyp = g.fill[cellIndex(x, y + 1, z)];
          const float fzm = g.fill[cellIndex(x, y, z - 1)], fzp = g.fill[cellIndex(x, y, z + 1)];
          const float gx = (fxp - fxm) * 0.5f, gy = (fyp - fym) * 0.5f, gz = (fzp - fzm) * 0.5f;
          const float gl = sqrtf(gx * gx + gy * gy + gz * gz);
          if (gl < 1e-3f) { curvature[c] = 0.0f; continue; }
          curvature[c] = -(fxp + fxm + fyp + fym + fzp + fzm - 6.0f * f) / maxf(gl, 1e-3f);
        }
      }
    }
    const float gain = clampf(surface_tension, 0.0f, 4.0f) * 0.04f;
    for (int32_t z = 1; z < nz - 1; ++z) {
      for (int32_t y = 1; y < ny - 1; ++y) {
        for (int32_t x = 1; x < nx - 1; ++x) {
          const uint32_t c = cellIndex(x, y, z);
          if (g.type[c] != CELL_LIQUID) continue;
          const float fxm = g.fill[cellIndex(x - 1, y, z)], fxp = g.fill[cellIndex(x + 1, y, z)];
          const float fym = g.fill[cellIndex(x, y - 1, z)], fyp = g.fill[cellIndex(x, y + 1, z)];
          const float fzm = g.fill[cellIndex(x, y, z - 1)], fzp = g.fill[cellIndex(x, y, z + 1)];
          const float gx = (fxp - fxm) * 0.5f, gy = (fyp - fym) * 0.5f, gz = (fzp - fzm) * 0.5f;
          const float gl = sqrtf(gx * gx + gy * gy + gz * gz);
          if (gl < 1e-3f) continue;
          const float kappa = clampf(curvature[c], -4.0f, 4.0f);
          const float scale = gain * kappa * dt;
          const float fx = scale * gx, fy = scale * gy, fz = scale * gz;
          g.u[uIndex(x, y, z)] += fx * 0.5f;
          g.u[uIndex(x + 1u, y, z)] += fx * 0.5f;
          g.v[vIndex(x, y, z)] += fy * 0.5f;
          g.v[vIndex(x, y + 1u, z)] += fy * 0.5f;
          g.w[wIndex(x, y, z)] += fz * 0.5f;
          g.w[wIndex(x, y, z + 1u)] += fz * 0.5f;
        }
      }
    }
  }

  /* ---- 6. viscosity (implicit, damped Jacobi) --------------------------
     nu * laplacian(u) = (u_new - u_old) / dt, solved by a few Jacobi sweeps on
     each of the three face fields. Water needs almost none; honey needs many,
     and the sweep count follows the diffusion number so the result stays
     stable instead of ringing. Only cells that hold liquid are diffused - a
     cell that touches air is a free surface, not a wall. */
  if (viscosity > 1e-5f) {
    const float alpha = clampf(viscosity * dt * invh2, 0.0f, 2.5f);
    const uint32_t sweeps = static_cast<uint32_t>(clampf(alpha * 6.0f + 2.0f, 2.0f, 8.0f));
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    float* temp = g.scratch;

    /* The three face fields differ only in which axes carry an extra sample, so
       the sweep is written once and handed the field's own index function. */
    auto diffuse = [&](auto indexOf, float* field, int32_t stagX, int32_t stagY, int32_t stagZ) {
      for (uint32_t sweep = 0; sweep < sweeps; ++sweep) {
        for (int32_t z = 0; z < nz; ++z) {
          for (int32_t y = 0; y < ny; ++y) {
            for (int32_t x = 0; x < nx; ++x) {
              const uint32_t c = cellIndex(x, y, z);
              if (g.type[c] != CELL_LIQUID) continue;
              const float centre = field[indexOf(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))];
              float sum = 0.0f;
              int32_t n = 0;
              const int32_t lo[3] = {x, y, z};
              const int32_t hi[3] = {nx, ny, nz};
              const int32_t stag[3] = {stagX, stagY, stagZ};
              for (int32_t axis = 0; axis < 3; ++axis) {
                for (int32_t side = -1; side <= 1; side += 2) {
                  const int32_t nb = lo[axis] + side;
                  if (nb < 0 || nb > hi[axis] + stag[axis]) continue;
                  int32_t sx = x, sy = y, sz = z;
                  if (axis == 0) sx = nb; else if (axis == 1) sy = nb; else sz = nb;
                  sum += field[indexOf(static_cast<uint32_t>(sx), static_cast<uint32_t>(sy), static_cast<uint32_t>(sz))];
                  ++n;
                }
              }
              temp[c] = (centre + alpha * sum) / (1.0f + alpha * static_cast<float>(n));
            }
          }
        }
        for (int32_t z = 0; z < nz; ++z) {
          for (int32_t y = 0; y < ny; ++y) {
            for (int32_t x = 0; x < nx; ++x) {
              if (g.type[cellIndex(x, y, z)] != CELL_LIQUID) continue;
              const uint32_t c = cellIndex(x, y, z);
              field[indexOf(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] = temp[c];
              field[indexOf(static_cast<uint32_t>(x + 1), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] = temp[c];
            }
          }
        }
      }
    };
    diffuse([](uint32_t x, uint32_t y, uint32_t z) { return uIndex(x, y, z); }, g.u, 1, 0, 0);
    diffuse([](uint32_t x, uint32_t y, uint32_t z) { return vIndex(x, y, z); }, g.v, 0, 1, 0);
    diffuse([](uint32_t x, uint32_t y, uint32_t z) { return wIndex(x, y, z); }, g.w, 0, 0, 1);
  }

  /* The forces above write to wall faces too (gravity on the floor row, the
     vorticity impulse on a side). Those faces are solid: put them back to zero
     before the projection measures divergence, or the solve inherits a
     divergence it is not allowed to remove. */
  zeroBoundaryFaces(!outflow);

  /* ---- 7. pressure projection -----------------------------------------
     Free surface: air has p = 0 (a Dirichlet condition), so the liquid surface
     is where the pressure solve ends. Everything else follows from one SPD
     system, solved by PCG with the previous frame's pressure as the first
     guess - which is why a 40^3 dam break converges in a dozen iterations. */
  float divergenceBefore = 0.0f;
  uint32_t pcgIterations = 0u;
  {
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    float* rhs = g.rhs;
    float* diag = g.diag;
    float* pressure = g.pressure;
    uint32_t* liquidIndex = g.liquidIndex;
    uint32_t liquidCount = 0;

    for (uint32_t c = 0; c < cells; ++c) {
      rhs[c] = 0.0f; diag[c] = 0.0f;
      if (g.type[c] != CELL_LIQUID) { pressure[c] = 0.0f; continue; }
      const int32_t x = static_cast<int32_t>(c % g.nx);
      const int32_t y = static_cast<int32_t>((c / g.nx) % g.ny);
      const int32_t z = static_cast<int32_t>(c / (g.nx * g.ny));
      const float div = (g.u[uIndex(x + 1, y, z)] - g.u[uIndex(x, y, z)]
                       + g.v[vIndex(x, y + 1, z)] - g.v[vIndex(x, y, z)]
                       + g.w[wIndex(x, y, z + 1)] - g.w[wIndex(x, y, z)]) * invh;
      divergenceBefore += absf(div) * h * h * h;
      rhs[c] = -div;
      liquidIndex[liquidCount++] = c;

      float d = 0.0f;
      for (int32_t dir = 0; dir < 6; ++dir) {
        const int32_t nxp = x + (dir == 0 ? 1 : (dir == 1 ? -1 : 0));
        const int32_t nyp = y + (dir == 2 ? 1 : (dir == 3 ? -1 : 0));
        const int32_t nzp = z + (dir == 4 ? 1 : (dir == 5 ? -1 : 0));
        if (!insideCell(nxp, nyp, nzp)) {
          if (outflow) d += invh2;   /* open boundary: p = 0 outside */
          continue;                  /* closed boundary: solid, Neumann */
        }
        const uint32_t nc = cellIndex(nxp, nyp, nzp);
        if (g.type[nc] == CELL_SOLID) continue;
        d += invh2;
      }
      diag[c] = d > 1e-12f ? d : invh2;
    }
    g.liquidCount = liquidCount;

    /* Freeze the seven-point stencil for this step. Everything about it - which
       neighbours are liquid, which are air (p = 0), which are outside the domain
       - is decided here, once, and the pressure iteration below only adds. */
    for (uint32_t n = 0; n < liquidCount; ++n) {
      const uint32_t c = liquidIndex[n];
      const int32_t x = static_cast<int32_t>(c % g.nx);
      const int32_t y = static_cast<int32_t>((c / g.nx) % g.ny);
      const int32_t z = static_cast<int32_t>(c / (g.nx * g.ny));
      for (int32_t dir = 0; dir < 6; ++dir) {
        const int32_t nxp = x + (dir == 0 ? 1 : (dir == 1 ? -1 : 0));
        const int32_t nyp = y + (dir == 2 ? 1 : (dir == 3 ? -1 : 0));
        const int32_t nzp = z + (dir == 4 ? 1 : (dir == 5 ? -1 : 0));
        uint32_t encoded = NEIGHBOUR_SOLID;
        if (!insideCell(nxp, nyp, nzp)) {
          encoded = outflow ? NEIGHBOUR_AIR : NEIGHBOUR_SOLID;
        } else {
          const uint32_t nc = cellIndex(static_cast<uint32_t>(nxp), static_cast<uint32_t>(nyp), static_cast<uint32_t>(nzp));
          encoded = g.type[nc] == CELL_LIQUID ? nc : (g.type[nc] == CELL_SOLID ? NEIGHBOUR_SOLID : NEIGHBOUR_AIR);
        }
        g.neighbour[static_cast<size_t>(n) * 6u + static_cast<size_t>(dir)] = encoded;
      }
    }

    /* Solve A p = rhs on the liquid cells. A is the seven-point Laplacian with
       the diagonal stored separately, and PCG needs three vectors. */
    float* r = g.scratch;
    float* dir = g.scratch + cells;
    float* ap = g.scratch + cells * 2u;
    float* z = g.scratch + cells * 3u;

    const uint32_t* neighbour = g.neighbour;

    /* z = M^-1 r with the Jacobi preconditioner, M = diag(A). It is the
       cheapest thing that keeps the condition number in check, and on a
       7-point Poisson matrix it is enough: the dam break converges in roughly
       forty iterations. An IC(0) factorisation was tried here and dropped -
       with the fill terms truncated to the stencil it is not guaranteed SPD on
       the moving free surface, and CG then stalls instead of converging. */
    auto applyPreconditioner = [&](const float* in, float* out, float* temp) {
      (void)temp;
      for (uint32_t n = 0; n < liquidCount; ++n) {
        const uint32_t c = liquidIndex[n];
        out[c] = in[c] / diag[c];
      }
    };
    auto applyA = [&](const float* q, float* out) {
      for (uint32_t n = 0; n < liquidCount; ++n) {
        const uint32_t c = liquidIndex[n];
        const float centre = q[c];
        float sum = 0.0f;
        const uint32_t* row = neighbour + static_cast<size_t>(n) * 6u;
        for (uint32_t dir = 0; dir < 6; ++dir) {
          const uint32_t nb = row[dir];
          if (nb == NEIGHBOUR_SOLID) continue;
          if (nb == NEIGHBOUR_AIR) sum += centre * invh2;
          else sum += (centre - q[nb]) * invh2;
        }
        out[c] = sum;
      }
    };

    float rhsNorm = 0.0f;
    for (uint32_t n = 0; n < liquidCount; ++n) {
      const uint32_t c = liquidIndex[n];
      rhsNorm += rhs[c] * rhs[c];
    }
    rhsNorm = sqrtf(rhsNorm);

    if (rhsNorm > 1e-9f) {
      applyA(pressure, ap);
      float rNorm = 0.0f;
      for (uint32_t n = 0; n < liquidCount; ++n) {
        const uint32_t c = liquidIndex[n];
        r[c] = rhs[c] - ap[c];
        rNorm += r[c] * r[c];
      }
      rNorm = sqrtf(rNorm);
      applyPreconditioner(r, z, ap);
      float rz = 0.0f;
      for (uint32_t n = 0; n < liquidCount; ++n) { const uint32_t c = liquidIndex[n]; rz += r[c] * z[c]; }
      for (uint32_t n = 0; n < liquidCount; ++n) { const uint32_t c = liquidIndex[n]; dir[c] = z[c]; }

      for (uint32_t iter = 0; iter < kPressureMaxIterations; ++iter) {
        if (rNorm <= kPressureTolerance * rhsNorm + 1e-12f) break;
        ++pcgIterations;
        applyA(dir, ap);
        float denom = 0.0f;
        for (uint32_t n = 0; n < liquidCount; ++n) { const uint32_t c = liquidIndex[n]; denom += dir[c] * ap[c]; }
        if (!(absf(denom) > 1e-20f)) break;
        const float step = rz / denom;
        float newNorm = 0.0f;
        for (uint32_t n = 0; n < liquidCount; ++n) {
          const uint32_t c = liquidIndex[n];
          pressure[c] += step * dir[c];
          r[c] -= step * ap[c];
          newNorm += r[c] * r[c];
        }
        newNorm = sqrtf(newNorm);
        rNorm = newNorm;
        applyPreconditioner(r, z, ap);
        float rzNew = 0.0f;
        for (uint32_t n = 0; n < liquidCount; ++n) { const uint32_t c = liquidIndex[n]; rzNew += r[c] * z[c]; }
        const float beta = rz > 1e-20f ? rzNew / rz : 0.0f;
        for (uint32_t n = 0; n < liquidCount; ++n) {
          const uint32_t c = liquidIndex[n];
          dir[c] = z[c] + beta * dir[c];
        }
        rz = rzNew;
        if (!isfinitef(rz)) break;
      }
    } else {
      for (uint32_t n = 0; n < liquidCount; ++n) pressure[liquidIndex[n]] = 0.0f;
    }

    /* Subtract the pressure gradient: u -= grad p, one write per face.

       This used to loop over cells and write the face on each side of every
       cell, which applies every interior face's correction twice (the left face
       of cell x+1 and the right face of cell x are the same sample) and
       over-corrected the velocity by exactly a factor of two - the projection
       then made the divergence worse instead of removing it. */
    auto pressureAt = [&](int32_t x, int32_t y, int32_t z) -> float {
      if (!insideCell(x, y, z)) return 0.0f;              /* outflow: p = 0 outside */
      return pressure[cellIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))];
    };
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        for (int32_t x = 0; x <= nx; ++x) {
          const float left = x > 0 ? pressureAt(x - 1, y, z) : (outflow ? 0.0f : pressureAt(0, y, z));
          const float right = x < nx ? pressureAt(x, y, z) : (outflow ? 0.0f : pressureAt(nx - 1, y, z));
          g.u[uIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] -= (right - left) * invh;
        }
      }
    }
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y <= ny; ++y) {
        for (int32_t x = 0; x < nx; ++x) {
          const float down = y > 0 ? pressureAt(x, y - 1, z) : (outflow ? 0.0f : pressureAt(x, 0, z));
          const float up = y < ny ? pressureAt(x, y, z) : (outflow ? 0.0f : pressureAt(x, ny - 1, z));
          g.v[vIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] -= (up - down) * invh;
        }
      }
    }
    for (int32_t z = 0; z <= nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        for (int32_t x = 0; x < nx; ++x) {
          const float back = z > 0 ? pressureAt(x, y, z - 1) : (outflow ? 0.0f : pressureAt(x, y, 0));
          const float front = z < nz ? pressureAt(x, y, z) : (outflow ? 0.0f : pressureAt(x, y, nz - 1));
          g.w[wIndex(static_cast<uint32_t>(x), static_cast<uint32_t>(y), static_cast<uint32_t>(z))] -= (front - back) * invh;
        }
      }
    }
  }

  /* The gradient subtraction writes to the boundary faces of a closed domain;
     a solid wall carries no flow, so they are put back to zero. */
  if (!outflow) {
    const int32_t nx = static_cast<int32_t>(g.nx), ny = static_cast<int32_t>(g.ny), nz = static_cast<int32_t>(g.nz);
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t y = 0; y < ny; ++y) {
        g.u[uIndex(0, y, z)] = 0.0f;
        g.u[uIndex(nx, y, z)] = 0.0f;
      }
    }
    for (int32_t z = 0; z < nz; ++z) {
      for (int32_t x = 0; x < nx; ++x) {
        g.v[vIndex(x, 0, z)] = 0.0f;
        g.v[vIndex(x, ny, z)] = 0.0f;
      }
    }
    for (int32_t y = 0; y < ny; ++y) {
      for (int32_t x = 0; x < nx; ++x) {
        g.w[wIndex(x, y, 0)] = 0.0f;
        g.w[wIndex(x, y, nz)] = 0.0f;
      }
    }
  }

  /* Divergence after the projection, for the report. */
  float divergenceAfter = 0.0f;
  for (int32_t z = 0; z < static_cast<int32_t>(g.nz); ++z) {
    for (int32_t y = 0; y < static_cast<int32_t>(g.ny); ++y) {
      for (int32_t x = 0; x < static_cast<int32_t>(g.nx); ++x) {
        const uint32_t c = cellIndex(x, y, z);
        if (g.type[c] != CELL_LIQUID) continue;
        const float div = (g.u[uIndex(x + 1, y, z)] - g.u[uIndex(x, y, z)]
                         + g.v[vIndex(x, y + 1, z)] - g.v[vIndex(x, y, z)]
                         + g.w[wIndex(x, y, z + 1)] - g.w[wIndex(x, y, z)]) * invh;
        divergenceAfter += absf(div) * h * h * h;
      }
    }
  }

  /* ---- 8. grid -> particles (FLIP blend) -------------------------------
     PIC is the grid velocity: smooth, stable, and it damps every small motion
     away. FLIP is the particle's own velocity plus the *change* the grid made:
     it keeps the detail the particles carried in. flip_ratio 0.95 is the
     production number; 0 is a PIC sim, 1 is a FLIP sim that can get noisy. */
  const float blend = clampf(flip_ratio, 0.0f, 1.0f);
  const float keep = 1.0f - clampf(damping, 0.0f, 0.95f) * dt * 8.0f;
  float maxSpeed = 0.0f;
  float kinetic = 0.0f;
  for (uint32_t p = 0; p < particle_count; ++p) {
    if (!active[p]) continue;
    const uint32_t b = p * 3u;
    const float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
    float uNew, vNew, wNew, uPrev, vPrev, wPrev;
    sampleVelocity(px, py, pz, uNew, vNew, wNew);
    sampleVelocityOld(px, py, pz, uPrev, vPrev, wPrev);
    const float fu = velocities[b] + (uNew - uPrev);
    const float fv = velocities[b + 1u] + (vNew - vPrev);
    const float fw = velocities[b + 2u] + (wNew - wPrev);
    float vx = (uNew * (1.0f - blend) + fu * blend) * keep;
    float vy = (vNew * (1.0f - blend) + fv * blend) * keep;
    float vz = (wNew * (1.0f - blend) + fw * blend) * keep;
    if (!isfinitef(vx + vy + vz)) { vx = vy = vz = 0.0f; }
    velocities[b] = vx; velocities[b + 1u] = vy; velocities[b + 2u] = vz;
    const float speed = sqrtf(vx * vx + vy * vy + vz * vz);
    if (speed > maxSpeed) maxSpeed = speed;
    kinetic += 0.5f * speed * speed;
  }

  /* ---- 9. advect (RK2, substepped when the CFL number asks for it) ------ */
  const float maxDisplacement = maxSpeed * dt;
  uint32_t substeps = 1u;
  if (maxDisplacement > h * 0.9f) {
    substeps = static_cast<uint32_t>(clampf(maxDisplacement / (h * 0.9f) + 0.999f, 1.0f, kMaxSubsteps));
  }
  const float sdt = dt / static_cast<float>(substeps);
  float maxCfl = 0.0f;
  for (uint32_t p = 0; p < particle_count; ++p) {
    if (!active[p]) continue;
    const uint32_t b = p * 3u;
    float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
    const float vx0 = velocities[b], vy0 = velocities[b + 1u], vz0 = velocities[b + 2u];
    for (uint32_t s = 0; s < substeps; ++s) {
      const float mx = px + vx0 * sdt * 0.5f;
      const float my = py + vy0 * sdt * 0.5f;
      const float mz = pz + vz0 * sdt * 0.5f;
      float vxm, vym, vzm;
      sampleVelocity(mx, my, mz, vxm, vym, vzm);
      px += vxm * sdt;
      py += vym * sdt;
      pz += vzm * sdt;
      const float step = sqrtf(vxm * vxm + vym * vym + vzm * vzm) * sdt / h;
      if (step > maxCfl) maxCfl = step;
    }
    if (!isfinitef(px + py + pz)) {
      px = positions[b]; py = positions[b + 1u]; pz = positions[b + 2u];
      velocities[b] = velocities[b + 1u] = velocities[b + 2u] = 0.0f;
    }
    positions[b] = px; positions[b + 1u] = py; positions[b + 2u] = pz;
  }

  /* ---- 9b. whitewater --------------------------------------------------
     Foam is born where the liquid is moving fast (a crest breaking, a splash
     landing) and where the cell holds few particles (the surface is exposed),
     and it dies with a fixed half-life. The hash of the position breaks the
     banding a pure threshold leaves behind, and it is deterministic, so a bake
     reproduces frame for frame. */
  if (foam_energy) {
    const float decay = expf(-1.6f * dt);
    for (uint32_t p = 0; p < particle_count; ++p) {
      if (!active[p]) { foam_energy[p] = 0.0f; continue; }
      const uint32_t b = p * 3u;
      const float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
      const float vx = velocities[b], vy = velocities[b + 1u], vz = velocities[b + 2u];
      const float speed = sqrtf(vx * vx + vy * vy + vz * vz);
      const int32_t cx = static_cast<int32_t>(clampf(floorf((px - g.low.x) * invh), 0.0f, static_cast<float>(g.nx) - 1.0f));
      const int32_t cy = static_cast<int32_t>(clampf(floorf((py - g.low.y) * invh), 0.0f, static_cast<float>(g.ny) - 1.0f));
      const int32_t cz = static_cast<int32_t>(clampf(floorf((pz - g.low.z) * invh), 0.0f, static_cast<float>(g.nz) - 1.0f));
      const float occupancy = g.fill[cellIndex(static_cast<uint32_t>(cx), static_cast<uint32_t>(cy), static_cast<uint32_t>(cz))];
      const float exposure = clampf(1.0f - occupancy * 0.35f, 0.0f, 1.0f);
      const float jitter = 0.65f + 0.35f * (static_cast<float>(hash_cell_3d(static_cast<int32_t>(px * 512.0f),
                                                                          static_cast<int32_t>(py * 512.0f),
                                                                          static_cast<int32_t>(pz * 512.0f), 1023u)) / 1023.0f);
      float birth = clampf((speed - 1.15f) * 0.42f, 0.0f, 1.0f) * (0.25f + 0.75f * exposure) * jitter;
      const float previous = clampf(foam_energy[p], 0.0f, 1.0f);
      foam_energy[p] = clampf(maxf(previous * decay, birth), 0.0f, 1.0f);
    }
  }

  /* ---- 10. walls ------------------------------------------------------- */
  const float bounce = clampf(restitution, 0.0f, 1.0f);
  const float skin = h * 0.002f;
  for (uint32_t p = 0; p < particle_count; ++p) {
    if (!active[p]) continue;
    const uint32_t b = p * 3u;
    float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
    float vx = velocities[b], vy = velocities[b + 1u], vz = velocities[b + 2u];

    if (outflow) {
      if (px < g.low.x || px > g.high.x || py < g.low.y || py > g.high.y || pz < g.low.z || pz > g.high.z) {
        active[p] = 0u;
        velocities[b] = velocities[b + 1u] = velocities[b + 2u] = 0.0f;
        continue;
      }
      continue;
    }

    if (px < g.low.x + skin) { px = g.low.x + skin; if (vx < 0.0f) vx = -vx * bounce; vy *= 0.98f; vz *= 0.98f; }
    else if (px > g.high.x - skin) { px = g.high.x - skin; if (vx > 0.0f) vx = -vx * bounce; vy *= 0.98f; vz *= 0.98f; }
    if (py < g.low.y + skin) { py = g.low.y + skin; if (vy < 0.0f) vy = -vy * bounce; vx *= 0.98f; vz *= 0.98f; }
    else if (py > g.high.y - skin) { py = g.high.y - skin; if (vy > 0.0f) vy = -vy * bounce; vx *= 0.98f; vz *= 0.98f; }
    if (pz < g.low.z + skin) { pz = g.low.z + skin; if (vz < 0.0f) vz = -vz * bounce; vx *= 0.98f; vy *= 0.98f; }
    else if (pz > g.high.z - skin) { pz = g.high.z - skin; if (vz > 0.0f) vz = -vz * bounce; vx *= 0.98f; vy *= 0.98f; }

    positions[b] = px; positions[b + 1u] = py; positions[b + 2u] = pz;
    velocities[b] = vx; velocities[b + 1u] = vy; velocities[b + 2u] = vz;
  }

  if (metrics) {
    metrics[0] = h;
    metrics[1] = static_cast<float>(liquidCells);
    metrics[2] = maxCfl;
    metrics[3] = divergenceBefore;
    metrics[4] = divergenceAfter;
    metrics[5] = kinetic;
    metrics[6] = static_cast<float>(pcgIterations);
    metrics[7] = static_cast<float>(liquidCells) * h * h * h;

  }
  return 1;
}

} // extern "C"
