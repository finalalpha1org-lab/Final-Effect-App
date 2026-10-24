#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

/* Eulerian smoke & fire core.

   A staggered MAC grid (face velocities, cell-centred density / temperature /
   pressure) stepped with semi-Lagrangian transport, temperature buoyancy,
   vorticity confinement and a Jacobi pressure projection that enforces a
   divergence-free velocity field. The visible surface is extracted with a dual
   (surface-nets) isosurface pass, which needs one vertex per crossed cube and
   avoids the 256-case marching-cubes table while producing the same closed,
   smooth manifold.

   This file owns the physics and the isosurface only: the volume shader, the
   3D texture upload and the UI belong to the GPU bridge. */

namespace {
using namespace fe;

constexpr uint32_t VMAX = 40;                       /* per-axis cell cap */
constexpr uint32_t VCELLS = VMAX * VMAX * VMAX;
constexpr uint32_t VFACES = (VMAX + 1) * VMAX * VMAX;

constexpr uint32_t MESH_MAX_N = 36;                 /* isosurface grid cap */
constexpr uint32_t MESH_CUBES = (MESH_MAX_N - 1) * (MESH_MAX_N - 1) * (MESH_MAX_N - 1);
constexpr uint32_t MESH_VERTS = MESH_CUBES;
constexpr uint32_t MESH_INDICES = MESH_CUBES * 18u; /* 3 sign-changing edges per cube, 6 indices each */

static uint32_t NX = 0, NY = 0, NZ = 0;
static float HX = 0.f, HY = 0.f, HZ = 0.f;

/* The combustion grid. Nine and a half megabytes over a 40^3 lattice, kept in
   one lazy block: a session that never opens the smoke solver does not reserve
   it, and neither does the kernel worker that shares this module. The block is
   carved once by fe_vol_init and never moves, which is what lets the pointer
   exports below stay a plain return. */
static uint8_t* g_vol_block = nullptr;
static uint32_t g_vol_cursor = 0;

static void* vol_carve(uint32_t bytes) {
  uint8_t* p = g_vol_block + g_vol_cursor;
  g_vol_cursor = (g_vol_cursor + bytes + 15u) & ~15u;
  return p;
}

static float* FU = nullptr; static float* FV = nullptr; static float* FW = nullptr;   /* face velocities */
static float* AU = nullptr; static float* AV = nullptr; static float* AW = nullptr;   /* advection scratch */
static float* den = nullptr; static float* tem = nullptr; static float* prs = nullptr;
static float* divf = nullptr; static float* tmp = nullptr; static float* prs2 = nullptr;
/* Previous accepted frame, used by the temporal filter. Two extra fields are
   cheap next to the solver arrays and give the shader a calmer field. */
static float* denPrev = nullptr; static float* temPrev = nullptr;
static float temporalAmount = 0.f;
static float* cvx = nullptr; static float* cvy = nullptr; static float* cvz = nullptr;
static float* crl = nullptr;

static float* meshPos = nullptr; static float* meshNrm = nullptr;
static uint32_t* meshIdx = nullptr;
static int32_t* cubeVert = nullptr;

/* face velocities + advection 6x VFACES, the 8 cell fields plus 3 centre
   velocities plus a 3-wide curl 14x VCELLS, the surface mesh 6x MESH_VERTS,
   its indices and its cube table; 512 bytes of slack absorbs the 16-byte
   alignment padding between the blocks. */
constexpr uint32_t kVolBytes =
  (VFACES * 6u + VCELLS * 14u + MESH_VERTS * 6u) * 4u + MESH_INDICES * 4u + MESH_CUBES * 4u + 512u;

static bool ensure_vol_buffers(void) {
  if (g_vol_block != nullptr) return true;
  g_vol_block = reinterpret_cast<uint8_t*>(fe::heap::alloc(kVolBytes, 16));
  if (g_vol_block == nullptr) return false;
  g_vol_cursor = 0;
  FU = static_cast<float*>(vol_carve(VFACES * 4u));
  FV = static_cast<float*>(vol_carve(VFACES * 4u));
  FW = static_cast<float*>(vol_carve(VFACES * 4u));
  AU = static_cast<float*>(vol_carve(VFACES * 4u));
  AV = static_cast<float*>(vol_carve(VFACES * 4u));
  AW = static_cast<float*>(vol_carve(VFACES * 4u));
  den = static_cast<float*>(vol_carve(VCELLS * 4u));
  tem = static_cast<float*>(vol_carve(VCELLS * 4u));
  prs = static_cast<float*>(vol_carve(VCELLS * 4u));
  divf = static_cast<float*>(vol_carve(VCELLS * 4u));
  tmp = static_cast<float*>(vol_carve(VCELLS * 4u));
  prs2 = static_cast<float*>(vol_carve(VCELLS * 4u));
  denPrev = static_cast<float*>(vol_carve(VCELLS * 4u));
  temPrev = static_cast<float*>(vol_carve(VCELLS * 4u));
  cvx = static_cast<float*>(vol_carve(VCELLS * 4u));
  cvy = static_cast<float*>(vol_carve(VCELLS * 4u));
  cvz = static_cast<float*>(vol_carve(VCELLS * 4u));
  crl = static_cast<float*>(vol_carve(VCELLS * 12u));
  meshPos = static_cast<float*>(vol_carve(MESH_VERTS * 12u));
  meshNrm = static_cast<float*>(vol_carve(MESH_VERTS * 12u));
  meshIdx = static_cast<uint32_t*>(vol_carve(MESH_INDICES * 4u));
  cubeVert = static_cast<int32_t*>(vol_carve(MESH_CUBES * 4u));
  return true;
}

static uint32_t meshVertCount = 0, meshIdxCount = 0;
static float stats[6] = {0, 0, 0, 0, 0, 0}; /* divBefore, divAfter, totalDensity, maxTemp, maxSpeed, steps */

inline uint32_t cellIdx(uint32_t i, uint32_t j, uint32_t k) { return (k * NY + j) * NX + i; }
inline uint32_t uIdx(uint32_t i, uint32_t j, uint32_t k) { return (k * NY + j) * (NX + 1) + i; }
inline uint32_t vIdx(uint32_t i, uint32_t j, uint32_t k) { return (k * (NY + 1) + j) * NX + i; }
inline uint32_t wIdx(uint32_t i, uint32_t j, uint32_t k) { return (k * NY + j) * NX + i; }

inline uint32_t clampi(int32_t v, uint32_t hi) { return v < 0 ? 0u : (uint32_t(v) > hi ? hi : uint32_t(v)); }

/* Trilinear sample of a cell-centred field; x in [0, NX-1], y in [0, NY-1], z in [0, NZ-1] */
float sampleCell(const float* f, float x, float y, float z) {
  x = clampf(x, 0.f, float(NX) - 1.f);
  y = clampf(y, 0.f, float(NY) - 1.f);
  z = clampf(z, 0.f, float(NZ) - 1.f);
  const uint32_t i0 = clampi(int32_t(x), NX - 1), j0 = clampi(int32_t(y), NY - 1), k0 = clampi(int32_t(z), NZ - 1);
  const uint32_t i1 = i0 + 1 < NX ? i0 + 1 : i0, j1 = j0 + 1 < NY ? j0 + 1 : j0, k1 = k0 + 1 < NZ ? k0 + 1 : k0;
  const float fx = x - float(i0), fy = y - float(j0), fz = z - float(k0);
  const float c00 = lerpf(f[cellIdx(i0, j0, k0)], f[cellIdx(i1, j0, k0)], fx);
  const float c10 = lerpf(f[cellIdx(i0, j1, k0)], f[cellIdx(i1, j1, k0)], fx);
  const float c01 = lerpf(f[cellIdx(i0, j0, k1)], f[cellIdx(i1, j0, k1)], fx);
  const float c11 = lerpf(f[cellIdx(i0, j1, k1)], f[cellIdx(i1, j1, k1)], fx);
  return lerpf(lerpf(c00, c10, fy), lerpf(c01, c11, fy), fz);
}

/* Trilinear sample of the u faces; x in [0, NX], y/z in [0, NY-1]/[0, NZ-1] */
float sampleU(const float* f, float x, float y, float z) {
  x = clampf(x, 0.f, float(NX));
  y = clampf(y, 0.f, float(NY) - 1.f);
  z = clampf(z, 0.f, float(NZ) - 1.f);
  const uint32_t i0 = clampi(int32_t(x), NX), j0 = clampi(int32_t(y), NY - 1), k0 = clampi(int32_t(z), NZ - 1);
  const uint32_t i1 = i0 + 1 <= NX ? i0 + 1 : i0, j1 = j0 + 1 < NY ? j0 + 1 : j0, k1 = k0 + 1 < NZ ? k0 + 1 : k0;
  const float fx = x - float(i0), fy = y - float(j0), fz = z - float(k0);
  const float c00 = lerpf(f[uIdx(i0, j0, k0)], f[uIdx(i1, j0, k0)], fx);
  const float c10 = lerpf(f[uIdx(i0, j1, k0)], f[uIdx(i1, j1, k0)], fx);
  const float c01 = lerpf(f[uIdx(i0, j0, k1)], f[uIdx(i1, j0, k1)], fx);
  const float c11 = lerpf(f[uIdx(i0, j1, k1)], f[uIdx(i1, j1, k1)], fx);
  return lerpf(lerpf(c00, c10, fy), lerpf(c01, c11, fy), fz);
}

float sampleV(const float* f, float x, float y, float z) {
  x = clampf(x, 0.f, float(NX) - 1.f);
  y = clampf(y, 0.f, float(NY));
  z = clampf(z, 0.f, float(NZ) - 1.f);
  const uint32_t i0 = clampi(int32_t(x), NX - 1), j0 = clampi(int32_t(y), NY), k0 = clampi(int32_t(z), NZ - 1);
  const uint32_t i1 = i0 + 1 < NX ? i0 + 1 : i0, j1 = j0 + 1 <= NY ? j0 + 1 : j0, k1 = k0 + 1 < NZ ? k0 + 1 : k0;
  const float fx = x - float(i0), fy = y - float(j0), fz = z - float(k0);
  const float c00 = lerpf(f[vIdx(i0, j0, k0)], f[vIdx(i1, j0, k0)], fx);
  const float c10 = lerpf(f[vIdx(i0, j1, k0)], f[vIdx(i1, j1, k0)], fx);
  const float c01 = lerpf(f[vIdx(i0, j0, k1)], f[vIdx(i1, j0, k1)], fx);
  const float c11 = lerpf(f[vIdx(i0, j1, k1)], f[vIdx(i1, j1, k1)], fx);
  return lerpf(lerpf(c00, c10, fy), lerpf(c01, c11, fy), fz);
}

float sampleW(const float* f, float x, float y, float z) {
  x = clampf(x, 0.f, float(NX) - 1.f);
  y = clampf(y, 0.f, float(NY) - 1.f);
  z = clampf(z, 0.f, float(NZ));
  const uint32_t i0 = clampi(int32_t(x), NX - 1), j0 = clampi(int32_t(y), NY - 1), k0 = clampi(int32_t(z), NZ);
  const uint32_t i1 = i0 + 1 < NX ? i0 + 1 : i0, j1 = j0 + 1 < NY ? j0 + 1 : j0, k1 = k0 + 1 <= NZ ? k0 + 1 : k0;
  const float fx = x - float(i0), fy = y - float(j0), fz = z - float(k0);
  const float c00 = lerpf(f[wIdx(i0, j0, k0)], f[wIdx(i1, j0, k0)], fx);
  const float c10 = lerpf(f[wIdx(i0, j1, k0)], f[wIdx(i1, j1, k0)], fx);
  const float c01 = lerpf(f[wIdx(i0, j0, k1)], f[wIdx(i1, j0, k1)], fx);
  const float c11 = lerpf(f[wIdx(i0, j1, k1)], f[wIdx(i1, j1, k1)], fx);
  return lerpf(lerpf(c00, c10, fy), lerpf(c01, c11, fy), fz);
}

void rebuildCenterVelocity() {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const uint32_t c = cellIdx(i, j, k);
        cvx[c] = 0.5f * (FU[uIdx(i, j, k)] + FU[uIdx(i + 1, j, k)]);
        cvy[c] = 0.5f * (FV[vIdx(i, j, k)] + FV[vIdx(i, j + 1, k)]);
        cvz[c] = 0.5f * (FW[wIdx(i, j, k)] + FW[wIdx(i, j, k + 1)]);
      }
    }
  }
}

/* RK2 backtrace from a world position with the current centre velocity field. */
void backtrace(float px, float py, float pz, float dt, float& ox, float& oy, float& oz) {
  const float cx = px / HX - 0.5f, cy = py / HY - 0.5f, cz = pz / HZ - 0.5f;
  const float vx = sampleCell(cvx, cx, cy, cz), vy = sampleCell(cvy, cx, cy, cz), vz = sampleCell(cvz, cx, cy, cz);
  const float mx = px - 0.5f * dt * vx, my = py - 0.5f * dt * vy, mz = pz - 0.5f * dt * vz;
  const float mcx = mx / HX - 0.5f, mcy = my / HY - 0.5f, mcz = mz / HZ - 0.5f;
  const float wx = sampleCell(cvx, mcx, mcy, mcz), wy = sampleCell(cvy, mcx, mcy, mcz), wz = sampleCell(cvz, mcx, mcy, mcz);
  ox = px - dt * wx; oy = py - dt * wy; oz = pz - dt * wz;
}

void advectVelocity(float dt) {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i <= NX; ++i) {
        const float px = float(i) * HX, py = (float(j) + 0.5f) * HY, pz = (float(k) + 0.5f) * HZ;
        float bx, by, bz;
        backtrace(px, py, pz, dt, bx, by, bz);
        AU[uIdx(i, j, k)] = sampleU(FU, bx / HX, by / HY - 0.5f, bz / HZ - 0.5f);
      }
    }
  }
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j <= NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float px = (float(i) + 0.5f) * HX, py = float(j) * HY, pz = (float(k) + 0.5f) * HZ;
        float bx, by, bz;
        backtrace(px, py, pz, dt, bx, by, bz);
        AV[vIdx(i, j, k)] = sampleV(FV, bx / HX - 0.5f, by / HY, bz / HZ - 0.5f);
      }
    }
  }
  for (uint32_t k = 0; k <= NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float px = (float(i) + 0.5f) * HX, py = (float(j) + 0.5f) * HY, pz = float(k) * HZ;
        float bx, by, bz;
        backtrace(px, py, pz, dt, bx, by, bz);
        AW[wIdx(i, j, k)] = sampleW(FW, bx / HX - 0.5f, by / HY - 0.5f, bz / HZ);
      }
    }
  }
  const uint32_t uCount = (NX + 1) * NY * NZ, vCount = NX * (NY + 1) * NZ, wCount = NX * NY * (NZ + 1);
  for (uint32_t n = 0; n < uCount; ++n) FU[n] = AU[n];
  for (uint32_t n = 0; n < vCount; ++n) FV[n] = AV[n];
  for (uint32_t n = 0; n < wCount; ++n) FW[n] = AW[n];
}

void advectScalar(float* field, uint32_t count, float dt) {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float px = (float(i) + 0.5f) * HX, py = (float(j) + 0.5f) * HY, pz = (float(k) + 0.5f) * HZ;
        float bx, by, bz;
        backtrace(px, py, pz, dt, bx, by, bz);
        tmp[cellIdx(i, j, k)] = sampleCell(field, bx / HX - 0.5f, by / HY - 0.5f, bz / HZ - 0.5f);
      }
    }
  }
  for (uint32_t n = 0; n < count; ++n) field[n] = tmp[n];
}

void applyBuoyancy(float dt, float buoyancy) {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 1; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float t = 0.5f * (tem[cellIdx(i, j - 1, k)] + tem[cellIdx(i, j, k)]);
        FV[vIdx(i, j, k)] += dt * buoyancy * t;
      }
    }
  }
}

void computeCurl() {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const uint32_t c = cellIdx(i, j, k);
        const uint32_t xm = cellIdx(clampi(int32_t(i) - 1, NX - 1), j, k), xp = cellIdx(clampi(int32_t(i) + 1, NX - 1), j, k);
        const uint32_t ym = cellIdx(i, clampi(int32_t(j) - 1, NY - 1), k), yp = cellIdx(i, clampi(int32_t(j) + 1, NY - 1), k);
        const uint32_t zm = cellIdx(i, j, clampi(int32_t(k) - 1, NZ - 1)), zp = cellIdx(i, j, clampi(int32_t(k) + 1, NZ - 1));
        const float dx = (i > 0 && i + 1 < NX) ? 2.f * HX : HX;
        const float dy = (j > 0 && j + 1 < NY) ? 2.f * HY : HY;
        const float dz = (k > 0 && k + 1 < NZ) ? 2.f * HZ : HZ;
        crl[c * 3 + 0] = (cvy[zp] - cvy[zm]) / dz - (cvz[yp] - cvz[ym]) / dy;
        crl[c * 3 + 1] = (cvz[xp] - cvz[xm]) / dx - (cvx[zp] - cvx[zm]) / dz;
        crl[c * 3 + 2] = (cvx[yp] - cvx[ym]) / dy - (cvy[xp] - cvy[xm]) / dx;
      }
    }
  }
}

void applyVorticity(float dt, float strength) {
  computeCurl();
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const uint32_t c = cellIdx(i, j, k);
        const uint32_t xm = cellIdx(clampi(int32_t(i) - 1, NX - 1), j, k), xp = cellIdx(clampi(int32_t(i) + 1, NX - 1), j, k);
        const uint32_t ym = cellIdx(i, clampi(int32_t(j) - 1, NY - 1), k), yp = cellIdx(i, clampi(int32_t(j) + 1, NY - 1), k);
        const uint32_t zm = cellIdx(i, j, clampi(int32_t(k) - 1, NZ - 1)), zp = cellIdx(i, j, clampi(int32_t(k) + 1, NZ - 1));
        auto magnitude = [&](uint32_t q) {
          const float a = crl[q * 3], b = crl[q * 3 + 1], cc = crl[q * 3 + 2];
          return sqrtf(a * a + b * b + cc * cc);
        };
        const float dx = (i > 0 && i + 1 < NX) ? 2.f * HX : HX;
        const float dy = (j > 0 && j + 1 < NY) ? 2.f * HY : HY;
        const float dz = (k > 0 && k + 1 < NZ) ? 2.f * HZ : HZ;
        float gx = (magnitude(xp) - magnitude(xm)) / dx;
        float gy = (magnitude(yp) - magnitude(ym)) / dy;
        float gz = (magnitude(zp) - magnitude(zm)) / dz;
        const float len = sqrtf(gx * gx + gy * gy + gz * gz);
        if (len > 1e-6f) { gx /= len; gy /= len; gz /= len; } else { gx = gy = gz = 0.f; }
        const float wx = crl[c * 3], wy = crl[c * 3 + 1], wz = crl[c * 3 + 2];
        tmp[c] = gy * wz - gz * wy;       /* (N x w).x */
        prs2[c] = gz * wx - gx * wz;      /* (N x w).y */
        divf[c] = gx * wy - gy * wx;      /* (N x w).z */
      }
    }
  }
  /* Spread the cell force back to the faces it sits between. */
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 1; i < NX; ++i) {
        FU[uIdx(i, j, k)] += dt * strength * 0.5f * (tmp[cellIdx(i - 1, j, k)] + tmp[cellIdx(i, j, k)]);
      }
    }
  }
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 1; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        FV[vIdx(i, j, k)] += dt * strength * 0.5f * (prs2[cellIdx(i, j - 1, k)] + prs2[cellIdx(i, j, k)]);
      }
    }
  }
  for (uint32_t k = 1; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        FW[wIdx(i, j, k)] += dt * strength * 0.5f * (divf[cellIdx(i, j, k - 1)] + divf[cellIdx(i, j, k)]);
      }
    }
  }
}

float maxAbsDivergence() {
  float worst = 0.f;
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float d = (FU[uIdx(i + 1, j, k)] - FU[uIdx(i, j, k)]) / HX +
                        (FV[vIdx(i, j + 1, k)] - FV[vIdx(i, j, k)]) / HY +
                        (FW[wIdx(i, j, k + 1)] - FW[wIdx(i, j, k)]) / HZ;
        const float a = absf(d);
        if (a > worst) worst = a;
      }
    }
  }
  return worst;
}

void computeDivergence() {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        divf[cellIdx(i, j, k)] = (FU[uIdx(i + 1, j, k)] - FU[uIdx(i, j, k)]) / HX +
                                 (FV[vIdx(i, j + 1, k)] - FV[vIdx(i, j, k)]) / HY +
                                 (FW[wIdx(i, j, k + 1)] - FW[wIdx(i, j, k)]) / HZ;
      }
    }
  }
}

void sealWalls();

void project(uint32_t iterations) {
  computeDivergence();
  const float invX = 1.f / (HX * HX), invY = 1.f / (HY * HY), invZ = 1.f / (HZ * HZ);
  const float diag = 2.f * (invX + invY + invZ);
  for (uint32_t n = 0; n < NX * NY * NZ; ++n) prs[n] = 0.f;
  for (uint32_t it = 0; it < iterations; ++it) {
    for (uint32_t k = 0; k < NZ; ++k) {
      for (uint32_t j = 0; j < NY; ++j) {
        for (uint32_t i = 0; i < NX; ++i) {
          const uint32_t c = cellIdx(i, j, k);
          const float pl = prs[cellIdx(i ? i - 1 : i, j, k)];
          const float pr = prs[cellIdx(i + 1 < NX ? i + 1 : i, j, k)];
          const float pb = prs[cellIdx(i, j ? j - 1 : j, k)];
          const float pt = prs[cellIdx(i, j + 1 < NY ? j + 1 : j, k)];
          const float pf = prs[cellIdx(i, j, k ? k - 1 : k)];
          const float pk = prs[cellIdx(i, j, k + 1 < NZ ? k + 1 : k)];
          prs2[c] = ((pl + pr) * invX + (pb + pt) * invY + (pf + pk) * invZ - divf[c]) / diag;
        }
      }
    }
    for (uint32_t n = 0; n < NX * NY * NZ; ++n) prs[n] = prs2[n];
  }
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i <= NX; ++i) {
        const float l = prs[cellIdx(i ? i - 1 : 0, j, k)];
        const float rr = prs[cellIdx(i < NX ? i : NX - 1, j, k)];
        FU[uIdx(i, j, k)] -= (rr - l) / HX;
      }
    }
  }
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j <= NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float b = prs[cellIdx(i, j ? j - 1 : 0, k)];
        const float t = prs[cellIdx(i, j < NY ? j : NY - 1, k)];
        FV[vIdx(i, j, k)] -= (t - b) / HY;
      }
    }
  }
  for (uint32_t k = 0; k <= NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float b = prs[cellIdx(i, j, k ? k - 1 : 0)];
        const float t = prs[cellIdx(i, j, k < NZ ? k : NZ - 1)];
        FW[wIdx(i, j, k)] -= (t - b) / HZ;
      }
    }
  }
  sealWalls();
}

void sealWalls() {
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      FU[uIdx(0, j, k)] = 0.f;
      FU[uIdx(NX, j, k)] = 0.f;
    }
  }
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t i = 0; i < NX; ++i) {
      FV[vIdx(i, 0, k)] = 0.f;
      FV[vIdx(i, NY, k)] = 0.f;
    }
  }
  for (uint32_t j = 0; j < NY; ++j) {
    for (uint32_t i = 0; i < NX; ++i) {
      FW[wIdx(i, j, 0)] = 0.f;
      FW[wIdx(i, j, NZ)] = 0.f;
    }
  }
}

void accumulateStats(float divBefore, float divAfter) {
  float total = 0.f, maxT = 0.f, maxS = 0.f;
  for (uint32_t n = 0; n < NX * NY * NZ; ++n) {
    total += den[n];
    if (tem[n] > maxT) maxT = tem[n];
    const float s = cvx[n] * cvx[n] + cvy[n] * cvy[n] + cvz[n] * cvz[n];
    if (s > maxS) maxS = s;
  }
  stats[0] = divBefore;
  stats[1] = divAfter;
  stats[2] = total / float(NX * NY * NZ);
  stats[3] = maxT;
  stats[4] = sqrtf(maxS);
  stats[5] += 1.f;
}

/* ---- Detail-noise tile -------------------------------------------------
 * A seamless RGBA tile the volume shader modulates density with. Three
 * independent fBm channels (billows, wisps, slow mask) are generated here so
 * the fragment shader only samples textures and never builds noise itself. */
constexpr uint32_t NOISE_MAX = 128;
static uint8_t vnoise[NOISE_MAX * NOISE_MAX * 4];
static uint32_t vnoiseSize = 0;

inline float hashValue(int32_t x, int32_t y, uint32_t salt) {
  uint32_t h = static_cast<uint32_t>(x) * 374761393u ^ static_cast<uint32_t>(y) * 668265263u ^ salt * 2246822519u;
  h ^= h >> 13;
  h *= 1274126177u;
  h ^= h >> 16;
  return static_cast<float>(h & 0xFFFFFFu) * (1.0f / 16777215.0f);
}

float tileNoise(float u, float v, uint32_t freq, uint32_t salt) {
  const float x = u * static_cast<float>(freq), y = v * static_cast<float>(freq);
  const int32_t ix = static_cast<int32_t>(floorf(x)), iy = static_cast<int32_t>(floorf(y));
  const float fx = x - static_cast<float>(ix), fy = y - static_cast<float>(iy);
  const float sx = fx * fx * (3.0f - 2.0f * fx), sy = fy * fy * (3.0f - 2.0f * fy);
  const int32_t n = static_cast<int32_t>(freq);
  const int32_t x0 = ((ix % n) + n) % n, x1 = ((ix + 1) % n + n) % n;
  const int32_t y0 = ((iy % n) + n) % n, y1 = ((iy + 1) % n + n) % n;
  const float v00 = hashValue(x0, y0, salt), v10 = hashValue(x1, y0, salt);
  const float v01 = hashValue(x0, y1, salt), v11 = hashValue(x1, y1, salt);
  return lerpf(lerpf(v00, v10, sx), lerpf(v01, v11, sx), sy);
}

float tileFbm(float u, float v, uint32_t baseFreq, uint32_t octaves, uint32_t salt) {
  float sum = 0.0f, amp = 0.5f, norm = 0.0f;
  uint32_t freq = baseFreq;
  for (uint32_t o = 0; o < octaves; ++o) {
    sum += tileNoise(u, v, freq, salt + o * 131u) * amp;
    norm += amp;
    freq *= 2u;
    amp *= 0.5f;
  }
  return norm > 0.0f ? sum / norm : 0.0f;
}

}  // namespace

extern "C" {

FE_EXPORT int32_t fe_vol_init(uint32_t nx, uint32_t ny, uint32_t nz) {
  if (nx < 8 || ny < 8 || nz < 8 || nx > VMAX || ny > VMAX || nz > VMAX) return -1;
  if (!ensure_vol_buffers()) return -4;   /* the device refused the memory */
  NX = nx; NY = ny; NZ = nz;
  HX = 1.f / float(nx); HY = 1.f / float(ny); HZ = 1.f / float(nz);
  for (uint32_t n = 0; n < VCELLS; ++n) { den[n] = 0.f; tem[n] = 0.f; prs[n] = 0.f; divf[n] = 0.f; tmp[n] = 0.f; prs2[n] = 0.f; cvx[n] = 0.f; cvy[n] = 0.f; cvz[n] = 0.f; crl[n * 3] = crl[n * 3 + 1] = crl[n * 3 + 2] = 0.f; }
  for (uint32_t n = 0; n < VFACES; ++n) { FU[n] = FV[n] = FW[n] = AU[n] = AV[n] = AW[n] = 0.f; }
  for (uint32_t n = 0; n < VCELLS; ++n) { denPrev[n] = 0.f; temPrev[n] = 0.f; }
  meshVertCount = meshIdxCount = 0;
  stats[0] = stats[1] = stats[2] = stats[3] = stats[4] = stats[5] = 0.f;
  return 0;
}

FE_EXPORT uint32_t fe_vol_grid_size() { return NX; }

FE_EXPORT int32_t fe_vol_reset() {
  if (!NX) return -1;
  return fe_vol_init(NX, NY, NZ);
}

/* Add a gaussian heat / smoke puff at a normalised position (0..1). */
FE_EXPORT int32_t fe_vol_source(float cx, float cy, float cz, float radius, float heat, float density, float lift) {
  if (!NX) return -1;
  if (!isfinitef(cx) || !isfinitef(cy) || !isfinitef(cz)) return -1;
  if (!isfinitef(radius) || radius <= 0.f || radius > 1.f) return -1;
  if (!isfinitef(heat) || !isfinitef(density) || !isfinitef(lift)) return -1;
  if (absf(heat) > 100.f || absf(density) > 100.f || absf(lift) > 100.f) return -1;
  cx = clampf(cx, 0.f, 1.f); cy = clampf(cy, 0.f, 1.f); cz = clampf(cz, 0.f, 1.f);
  const float inv = 1.f / (radius * radius);
  int32_t touched = 0;
  for (uint32_t k = 0; k < NZ; ++k) {
    const float dz = (float(k) + 0.5f) * HZ - cz;
    for (uint32_t j = 0; j < NY; ++j) {
      const float dy = (float(j) + 0.5f) * HY - cy;
      for (uint32_t i = 0; i < NX; ++i) {
        const float dx = (float(i) + 0.5f) * HX - cx;
        const float r2 = (dx * dx + dy * dy + dz * dz) * inv;
        if (r2 >= 1.f) continue;
        const float w = (1.f - r2) * (1.f - r2);
        const uint32_t c = cellIdx(i, j, k);
        den[c] = minf(den[c] + density * w, 40.f);
        tem[c] = minf(tem[c] + heat * w, 40.f);
        if (lift != 0.f && j + 1 <= NY) FV[vIdx(i, j + 1 < NY ? j + 1 : NY, k)] = clampf(FV[vIdx(i, j + 1 < NY ? j + 1 : NY, k)] + lift * w, -50.f, 50.f);
        ++touched;
      }
    }
  }
  return touched;
}

FE_EXPORT int32_t fe_vol_step(float dt, float buoyancy, float vorticity, float dissipation, float cooling, uint32_t iterations) {
  if (!NX) return -1;
  if (!isfinitef(dt) || dt <= 0.f || dt > 0.25f) return -1;
  if (!isfinitef(buoyancy) || buoyancy < 0.f || buoyancy > 50.f) return -1;
  if (!isfinitef(vorticity) || vorticity < 0.f || vorticity > 20.f) return -1;
  if (!isfinitef(dissipation) || dissipation < 0.f || dissipation > 20.f) return -1;
  if (!isfinitef(cooling) || cooling < 0.f || cooling > 20.f) return -1;
  if (iterations < 1 || iterations > 160) return -1;

  rebuildCenterVelocity();
  advectVelocity(dt);
  advectScalar(den, NX * NY * NZ, dt);
  advectScalar(tem, NX * NY * NZ, dt);
  applyBuoyancy(dt, buoyancy);
  if (vorticity > 0.f) applyVorticity(dt, vorticity);
  sealWalls();
  const float before = maxAbsDivergence();
  project(iterations);
  const float after = maxAbsDivergence();
  if (dissipation > 0.f || cooling > 0.f) {
    const float keepD = 1.f / (1.f + dissipation * dt);
    const float keepT = 1.f / (1.f + cooling * dt);
    for (uint32_t n = 0; n < NX * NY * NZ; ++n) {
      den[n] *= keepD;
      tem[n] *= keepT;
      if (den[n] < 1e-5f) den[n] = 0.f;
      if (tem[n] < 1e-5f) tem[n] = 0.f;
    }
  }
  /* Temporal filter: an exponential moving average of the accepted field.
     amount = 0 keeps every step as-is; higher values trade a little lag for a
     much calmer surface (the shimmer of a 20-28 cell grid is the main tell). */
  const float keep = temporalAmount <= 0.f ? 0.f : temporalAmount;
  if (keep > 0.f) {
    /* Mass-preserving low pass: blending toward the previous frame dims a fast
       plume, so the total is restored afterwards. Only the shape is smoothed. */
    float total = 0.f, blended = 0.f;
    for (uint32_t n = 0; n < NX * NY * NZ; ++n) {
      total += den[n];
      den[n] = lerpf(den[n], denPrev[n], keep);
      blended += den[n];
      tem[n] = lerpf(tem[n], temPrev[n], keep);
    }
    const float scale = blended > 1e-6f ? clampf(total / blended, 0.85f, 1.15f) : 1.f;
    for (uint32_t n = 0; n < NX * NY * NZ; ++n) {
      den[n] *= scale;
      denPrev[n] = den[n];
      temPrev[n] = tem[n];
    }
  } else {
    for (uint32_t n = 0; n < NX * NY * NZ; ++n) { denPrev[n] = den[n]; temPrev[n] = tem[n]; }
  }
  rebuildCenterVelocity();
  accumulateStats(before, after);
  return 0;
}

/* 0..0.95: how much of the previous frame is folded into each new one. */
FE_EXPORT int32_t fe_vol_set_temporal(float amount) {
  if (!isfinitef(amount)) return -1;
  temporalAmount = clampf(amount, 0.f, 0.95f);
  return 0;
}
FE_EXPORT float fe_vol_temporal(void) { return temporalAmount; }

FE_EXPORT float* fe_vol_density_ptr() { return den; }
FE_EXPORT float* fe_vol_temperature_ptr() { return tem; }
FE_EXPORT float* fe_vol_velocity_x_ptr() { return cvx; }
FE_EXPORT float* fe_vol_velocity_y_ptr() { return cvy; }
FE_EXPORT float* fe_vol_velocity_z_ptr() { return cvz; }
FE_EXPORT float* fe_vol_stats_ptr() { return stats; }

/* Dual isosurface (surface nets) over the density field. Returns the vertex
   count, -2 when the index buffer would overflow, -1 on invalid input. */
FE_EXPORT int32_t fe_vol_surface(float iso, uint32_t max_verts) {
  if (!NX || NX < 4 || NY < 4 || NZ < 4) return -1;
  if (!isfinitef(iso)) return -1;
  if (NX > MESH_MAX_N || NY > MESH_MAX_N || NZ > MESH_MAX_N) return -1;
  meshVertCount = 0;
  meshIdxCount = 0;
  const uint32_t cx = NX - 1, cy = NY - 1, cz = NZ - 1;
  for (uint32_t n = 0; n < cx * cy * cz; ++n) cubeVert[n] = -1;

  auto cubeIndex = [&](uint32_t i, uint32_t j, uint32_t k) { return (k * cy + j) * cx + i; };
  auto corner = [&](uint32_t i, uint32_t j, uint32_t k, uint32_t c) {
    const uint32_t di = c & 1u, dj = (c >> 1) & 1u, dk = (c >> 2) & 1u;
    return den[cellIdx(i + di, j + dj, k + dk)] - iso;
  };

  for (uint32_t k = 0; k < cz; ++k) {
    for (uint32_t j = 0; j < cy; ++j) {
      for (uint32_t i = 0; i < cx; ++i) {
        float v[8];
        uint32_t mask = 0;
        for (uint32_t c = 0; c < 8; ++c) {
          v[c] = corner(i, j, k, c);
          if (v[c] > 0.f) mask |= (1u << c);
        }
        if (mask == 0u || mask == 255u) continue;
        /* 12 cube edges as (cornerA, cornerB) */
        static const uint8_t E[12][2] = {{0,1},{2,3},{4,5},{6,7},{0,2},{1,3},{4,6},{5,7},{0,4},{1,5},{2,6},{3,7}};
        float sx = 0.f, sy = 0.f, sz = 0.f;
        uint32_t crossings = 0;
        for (uint32_t e = 0; e < 12; ++e) {
          const uint32_t a = E[e][0], b = E[e][1];
          if ((v[a] > 0.f) == (v[b] > 0.f)) continue;
          const float t = v[a] / (v[a] - v[b]);
          const float ax = float(a & 1u), ay = float((a >> 1) & 1u), az = float((a >> 2) & 1u);
          const float bx = float(b & 1u), by = float((b >> 1) & 1u), bz = float((b >> 2) & 1u);
          sx += ax + (bx - ax) * t;
          sy += ay + (by - ay) * t;
          sz += az + (bz - az) * t;
          ++crossings;
        }
        if (!crossings) continue;
        const float fx = sx / float(crossings), fy = sy / float(crossings), fz = sz / float(crossings);
        const uint32_t slot = cubeIndex(i, j, k);
        if (meshVertCount >= MESH_VERTS || meshVertCount >= max_verts) return -2;
        const uint32_t vi = meshVertCount++;
        meshPos[vi * 3 + 0] = (float(i) + fx + 0.5f) / float(NX);
        meshPos[vi * 3 + 1] = (float(j) + fy + 0.5f) / float(NY);
        meshPos[vi * 3 + 2] = (float(k) + fz + 0.5f) / float(NZ);
        cubeVert[slot] = int32_t(vi);
      }
    }
  }
  if (!meshVertCount) return 0;

  /* Normals from the analytic density gradient at each vertex. */
  for (uint32_t vi = 0; vi < meshVertCount; ++vi) {
    const float gx = meshPos[vi * 3 + 0] * float(NX) - 0.5f; /* back to cell-index space */
    const float gy = meshPos[vi * 3 + 1] * float(NY) - 0.5f;
    const float gz = meshPos[vi * 3 + 2] * float(NZ) - 0.5f;
    const float e = 0.75f;
    /* density falls off outward, so the outward normal is minus the gradient */
    const float nx = sampleCell(den, gx - e, gy, gz) - sampleCell(den, gx + e, gy, gz);
    const float ny = sampleCell(den, gx, gy - e, gz) - sampleCell(den, gx, gy + e, gz);
    const float nz = sampleCell(den, gx, gy, gz - e) - sampleCell(den, gx, gy, gz + e);
    const float len = sqrtf(nx * nx + ny * ny + nz * nz);
    if (len > 1e-8f) {
      meshNrm[vi * 3 + 0] = nx / len;
      meshNrm[vi * 3 + 1] = ny / len;
      meshNrm[vi * 3 + 2] = nz / len;
    } else {
      meshNrm[vi * 3 + 0] = 0.f;
      meshNrm[vi * 3 + 1] = 1.f;
      meshNrm[vi * 3 + 2] = 0.f;
    }
  }

  auto emit = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
    if (meshIdxCount + 6 > MESH_INDICES) return false;
    /* Orient the quad so its normal follows the density gradient (outward). */
    const float* pa = &meshPos[a * 3];
    const float* pb = &meshPos[b * 3];
    const float* pc = &meshPos[c * 3];
    const float e1x = pb[0] - pa[0], e1y = pb[1] - pa[1], e1z = pb[2] - pa[2];
    const float e2x = pc[0] - pa[0], e2y = pc[1] - pa[1], e2z = pc[2] - pa[2];
    const float nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const float gx = meshNrm[a * 3] + meshNrm[b * 3] + meshNrm[c * 3] + meshNrm[d * 3];
    const float gy = meshNrm[a * 3 + 1] + meshNrm[b * 3 + 1] + meshNrm[c * 3 + 1] + meshNrm[d * 3 + 1];
    const float gz = meshNrm[a * 3 + 2] + meshNrm[b * 3 + 2] + meshNrm[c * 3 + 2] + meshNrm[d * 3 + 2];
    const bool flip = (nx * gx + ny * gy + nz * gz) < 0.f;
    if (!flip) {
      meshIdx[meshIdxCount++] = a; meshIdx[meshIdxCount++] = b; meshIdx[meshIdxCount++] = d;
      meshIdx[meshIdxCount++] = b; meshIdx[meshIdxCount++] = c; meshIdx[meshIdxCount++] = d;
    } else {
      meshIdx[meshIdxCount++] = a; meshIdx[meshIdxCount++] = d; meshIdx[meshIdxCount++] = b;
      meshIdx[meshIdxCount++] = b; meshIdx[meshIdxCount++] = d; meshIdx[meshIdxCount++] = c;
    }
    return true;
  };

  /* One quad per sign-changing sample edge, joining the four cubes around it. */
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i + 1 < NX; ++i) {
        const float a = den[cellIdx(i, j, k)] - iso, b = den[cellIdx(i + 1, j, k)] - iso;
        if ((a > 0.f) == (b > 0.f)) continue;
        if (!i || j == 0 || k == 0 || j + 1 >= NY || k + 1 >= NZ) continue;
        const int32_t v00 = cubeVert[cubeIndex(i, j - 1, k - 1)];
        const int32_t v10 = cubeVert[cubeIndex(i, j, k - 1)];
        const int32_t v11 = cubeVert[cubeIndex(i, j, k)];
        const int32_t v01 = cubeVert[cubeIndex(i, j - 1, k)];
        if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
        if (a > 0.f) { if (!emit(uint32_t(v00), uint32_t(v10), uint32_t(v11), uint32_t(v01))) return -2; }
        else { if (!emit(uint32_t(v01), uint32_t(v11), uint32_t(v10), uint32_t(v00))) return -2; }
      }
    }
  }
  for (uint32_t k = 0; k < NZ; ++k) {
    for (uint32_t j = 0; j + 1 < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float a = den[cellIdx(i, j, k)] - iso, b = den[cellIdx(i, j + 1, k)] - iso;
        if ((a > 0.f) == (b > 0.f)) continue;
        if (!j || i == 0 || k == 0 || i + 1 >= NX || k + 1 >= NZ) continue;
        const int32_t v00 = cubeVert[cubeIndex(i - 1, j, k - 1)];
        const int32_t v10 = cubeVert[cubeIndex(i, j, k - 1)];
        const int32_t v11 = cubeVert[cubeIndex(i, j, k)];
        const int32_t v01 = cubeVert[cubeIndex(i - 1, j, k)];
        if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
        if (a > 0.f) { if (!emit(uint32_t(v00), uint32_t(v10), uint32_t(v11), uint32_t(v01))) return -2; }
        else { if (!emit(uint32_t(v01), uint32_t(v11), uint32_t(v10), uint32_t(v00))) return -2; }
      }
    }
  }
  for (uint32_t k = 0; k + 1 < NZ; ++k) {
    for (uint32_t j = 0; j < NY; ++j) {
      for (uint32_t i = 0; i < NX; ++i) {
        const float a = den[cellIdx(i, j, k)] - iso, b = den[cellIdx(i, j, k + 1)] - iso;
        if ((a > 0.f) == (b > 0.f)) continue;
        if (!k || i == 0 || j == 0 || i + 1 >= NX || j + 1 >= NY) continue;
        const int32_t v00 = cubeVert[cubeIndex(i - 1, j - 1, k)];
        const int32_t v10 = cubeVert[cubeIndex(i, j - 1, k)];
        const int32_t v11 = cubeVert[cubeIndex(i, j, k)];
        const int32_t v01 = cubeVert[cubeIndex(i - 1, j, k)];
        if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
        if (a > 0.f) { if (!emit(uint32_t(v00), uint32_t(v10), uint32_t(v11), uint32_t(v01))) return -2; }
        else { if (!emit(uint32_t(v01), uint32_t(v11), uint32_t(v10), uint32_t(v00))) return -2; }
      }
    }
  }
  return int32_t(meshVertCount);
}

FE_EXPORT float* fe_vol_surface_positions_ptr() { return meshPos; }
FE_EXPORT float* fe_vol_surface_normals_ptr() { return meshNrm; }
FE_EXPORT uint32_t* fe_vol_surface_indices_ptr() { return meshIdx; }
FE_EXPORT uint32_t fe_vol_surface_index_count() { return meshIdxCount; }


FE_EXPORT int32_t fe_vol_noise_generate(uint32_t size, uint32_t seed, uint32_t octaves) {
  if (size < 16u || size > NOISE_MAX) return -3;
  const uint32_t oct = octaves < 1u ? 1u : (octaves > 6u ? 6u : octaves);
  for (uint32_t y = 0; y < size; ++y) {
    const float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(size);
    for (uint32_t x = 0; x < size; ++x) {
      const float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(size);
      const float billow = tileFbm(u, v, 4u, oct, seed);
      const float wisp = tileFbm(u, v, 8u, oct + 1u, seed + 977u);
      const float mask = tileFbm(u, v, 2u, 2u, seed + 1931u);
      const uint32_t o = (y * size + x) * 4u;
      vnoise[o + 0] = static_cast<uint8_t>(clampf(billow, 0.0f, 1.0f) * 255.0f);
      vnoise[o + 1] = static_cast<uint8_t>(clampf(wisp, 0.0f, 1.0f) * 255.0f);
      vnoise[o + 2] = static_cast<uint8_t>(clampf(mask, 0.0f, 1.0f) * 255.0f);
      vnoise[o + 3] = 255u;
    }
  }
  vnoiseSize = size;
  return 0;
}

FE_EXPORT uint32_t fe_vol_noise_ptr(void) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(vnoise)); }
FE_EXPORT uint32_t fe_vol_noise_size(void) { return vnoiseSize; }

}  // extern "C"
