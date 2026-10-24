#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

namespace {

using fe::Vec3;
using fe::absf;
using fe::clampf;
using fe::cosf;
using fe::expf;
using fe::floorf;
using fe::isfinitef;
using fe::lerpf;
using fe::maxf;
using fe::minf;
using fe::powf;
using fe::sinf;
using fe::sqrtf;

constexpr uint32_t kMaxSimParticles    = 8192u;
constexpr uint32_t kParticleHashBuckets = 16384u; /* power of 2 */
constexpr uint32_t kMaxDeformNodes     = 16384u;
constexpr uint32_t kSelfColBuckets     = 16384u;  /* power of 2 */
constexpr uint32_t kMaxGridDim         = 97u;     /* supports up to 96^3 cells */
constexpr uint32_t kMaxGridNodes       = kMaxGridDim * kMaxGridDim * kMaxGridDim;
constexpr uint32_t kEdgeCacheCap       = 131072u; /* power of 2 */
constexpr uint32_t kMaxMeshVerts       = 65536u;

/* Zero-initialized BSS buffers (0 bytes in .wasm binary payload, zero per-frame allocations) */
static int32_t  g_part_head[kParticleHashBuckets];
static int32_t  g_part_next[kMaxSimParticles];
static float    g_pbf_lambda[kMaxSimParticles];
static float    g_pbf_delta[kMaxSimParticles * 3u];
static float    g_vort_omega[kMaxSimParticles * 3u];
static float    g_vort_mag[kMaxSimParticles];
static uint16_t g_nbr_count[kMaxSimParticles];

static int32_t  g_sc_head[kSelfColBuckets];
static int32_t  g_sc_next[kMaxDeformNodes];
static float    g_node_strain[kMaxDeformNodes];
static uint16_t g_node_strain_deg[kMaxDeformNodes];

/* The surface-reconstruction grid. Four float fields over 97^3 nodes are
   14.6 MB: the largest single block in the module and one that only the liquid
   mesher ever reads. It comes from the lazy heap, so a studio that never runs
   a fluid simulation does not reserve it. */
static float*   g_field_a = nullptr;
static float*   g_field_b = nullptr;
static float*   g_field_foam = nullptr;
static float*   g_field_speed = nullptr;

static bool ensure_surface_grid(void) {
  if (g_field_a != nullptr) return true;
  constexpr uint32_t kNodeBytes = kMaxGridNodes * sizeof(float);
  uint8_t* base = reinterpret_cast<uint8_t*>(fe::heap::alloc(kNodeBytes * 4u, 16));
  if (base == nullptr) return false;
  g_field_a     = reinterpret_cast<float*>(base);
  g_field_b     = reinterpret_cast<float*>(base + kNodeBytes);
  g_field_foam  = reinterpret_cast<float*>(base + kNodeBytes * 2u);
  g_field_speed = reinterpret_cast<float*>(base + kNodeBytes * 3u);
  return true;
}

static uint32_t g_edge_lo[kEdgeCacheCap];
static uint32_t g_edge_hi[kEdgeCacheCap];
static uint32_t g_edge_stamp[kEdgeCacheCap];
static uint32_t g_edge_vert[kEdgeCacheCap];
static uint32_t g_current_edge_stamp = 0u;

static float    g_taubin_sum[kMaxMeshVerts * 3u];
static uint16_t g_taubin_deg[kMaxMeshVerts];

/* ---- Deterministic 3D Spatial Hash ---- */
inline uint32_t hash_cell_3d(int32_t ix, int32_t iy, int32_t iz, uint32_t mask) {
  const uint32_t ux = static_cast<uint32_t>(ix) * 73856093u;
  const uint32_t uy = static_cast<uint32_t>(iy) * 19349663u;
  const uint32_t uz = static_cast<uint32_t>(iz) * 83492791u;
  return (ux ^ uy ^ uz) & mask;
}

/* ---- Smooth 3D Divergence-Free Curl Noise for Wind & Pyro Vorticity ---- */
inline float hash31(int32_t x, int32_t y, int32_t z) {
  uint32_t n = static_cast<uint32_t>(x) * 374761393u
             + static_cast<uint32_t>(y) * 668265263u
             + static_cast<uint32_t>(z) * 2147483647u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  return static_cast<float>((n ^ (n >> 16u)) & 0x00FFFFFFu) * (1.0f / 16777215.0f);
}

inline float smooth_noise3(float x, float y, float z) {
  const float fx0 = floorf(x), fy0 = floorf(y), fz0 = floorf(z);
  const int32_t ix = static_cast<int32_t>(fx0);
  const int32_t iy = static_cast<int32_t>(fy0);
  const int32_t iz = static_cast<int32_t>(fz0);
  const float tx = x - fx0, ty = y - fy0, tz = z - fz0;
  const float ux = tx * tx * (3.0f - 2.0f * tx);
  const float uy = ty * ty * (3.0f - 2.0f * ty);
  const float uz = tz * tz * (3.0f - 2.0f * tz);

  const float c000 = hash31(ix,     iy,     iz);
  const float c100 = hash31(ix + 1, iy,     iz);
  const float c010 = hash31(ix,     iy + 1, iz);
  const float c110 = hash31(ix + 1, iy + 1, iz);
  const float c001 = hash31(ix,     iy,     iz + 1);
  const float c101 = hash31(ix + 1, iy,     iz + 1);
  const float c011 = hash31(ix,     iy + 1, iz + 1);
  const float c111 = hash31(ix + 1, iy + 1, iz + 1);

  const float x00 = lerpf(c000, c100, ux);
  const float x10 = lerpf(c010, c110, ux);
  const float x01 = lerpf(c001, c101, ux);
  const float x11 = lerpf(c011, c111, ux);
  const float y0  = lerpf(x00, x10, uy);
  const float y1  = lerpf(x01, x11, uy);
  return lerpf(y0, y1, uz) * 2.0f - 1.0f;
}

inline Vec3 curl_noise3(float x, float y, float z, float t) {
  constexpr float e = 0.12f;
  constexpr float inv2e = 1.0f / (2.0f * e);
  const float ox = t * 0.85f;
  const float oy = t * 1.15f;
  const float oz = t * 0.65f;

  auto psi_x = [&](float px, float py, float pz) {
    return smooth_noise3(px + ox, py + 13.7f + oy, pz + 29.3f);
  };
  auto psi_y = [&](float px, float py, float pz) {
    return smooth_noise3(px + 47.1f, py + oy, pz + 71.9f + oz);
  };
  auto psi_z = [&](float px, float py, float pz) {
    return smooth_noise3(px + 89.5f + ox, py + 113.2f, pz + oz);
  };

  const float dpy_dz = (psi_y(x, y, z + e) - psi_y(x, y, z - e)) * inv2e;
  const float dpz_dy = (psi_z(x, y + e, z) - psi_z(x, y - e, z)) * inv2e;
  const float dpz_dx = (psi_z(x + e, y, z) - psi_z(x - e, y, z)) * inv2e;
  const float dpx_dz = (psi_x(x, y, z + e) - psi_x(x, y, z - e)) * inv2e;
  const float dpx_dy = (psi_x(x, y + e, z) - psi_x(x, y - e, z)) * inv2e;
  const float dpy_dx = (psi_y(x + e, y, z) - psi_y(x - e, y, z)) * inv2e;

  return { dpz_dy - dpy_dz, dpx_dz - dpz_dx, dpy_dx - dpx_dy };
}

} // namespace

extern "C" {

FE_EXPORT uint32_t fe_sim_backend_magic(void) {
  return FE_SIM_CPP_BACKEND_MAGIC;
}

FE_EXPORT uint32_t sim_solver_abi_version(void) {
  return 2u;
}

/* =========================================================================
 * 1. Houdini Vellum-Style C++20 XPBD Cloth & Soft-Body Solver
 * ========================================================================= */
FE_EXPORT int32_t fe_sim_xpbd_deformable_step(
  float* positions,
  float* previous,
  const float* rest,
  const uint8_t* pinned,
  const uint32_t* edges,
  float* rest_lengths,
  const float* edge_weights,
  uint32_t node_count,
  uint32_t edge_count,
  const uint32_t* faces_u32,
  uint32_t surface_tri_count,
  const uint32_t* volume_tets_u32,
  const float* volume_rest_f32,
  uint32_t tet_count,
  float dt,
  float gravity_x,
  float gravity_y,
  float gravity_z,
  float damping,
  float stiffness,
  float goal_strength,
  float stretch_resistance,
  float compression_resistance,
  float volume_stiffness,
  float plasticity,
  float self_collision_radius,
  float wind_x,
  float wind_y,
  float wind_z,
  float wind_turbulence,
  float time_sec,
  float air_drag,
  float collision_margin,
  uint32_t iterations,
  const float* bounds_6,
  float restitution,
  float friction
) {
  if (!positions || !previous || !rest || !pinned || !edges || !rest_lengths || !bounds_6) return -1;
  if (node_count == 0u || edge_count == 0u) return -2;
  if (!isfinitef(dt) || dt <= 0.0f) return 0;

  const float h = clampf(dt, 1e-5f, 1.0f / 24.0f);
  const float h2 = h * h;
  const float damp = clampf(damping, 0.0f, 0.98f);
  const float vel_keep = 1.0f - damp;
  const float k_stiff = clampf(stiffness, 0.0f, 1.0f);
  const float k_goal = clampf(goal_strength, 0.0f, 1.0f);
  const float k_stretch = clampf(stretch_resistance, 0.0f, 1.0f);
  const float k_compress = clampf(compression_resistance, 0.0f, 1.0f);
  const float k_vol = clampf(volume_stiffness, 0.0f, 1.0f);
  const float k_plast = clampf(plasticity, 0.0f, 1.0f);
  const float margin = clampf(collision_margin, 0.0f, 0.5f);
  const float bounce = clampf(restitution, 0.0f, 1.0f);
  const float mu_fric = clampf(friction, 0.0f, 1.0f);
  const uint32_t iters = iterations < 1u ? 1u : (iterations > 32u ? 32u : iterations);

  /* Optional aerodynamic wind lift & drag over surface triangles */
  const float wind_mag2 = wind_x * wind_x + wind_y * wind_y + wind_z * wind_z;
  const bool has_aero = faces_u32 != nullptr && surface_tri_count > 0u &&
                        (wind_mag2 > 1e-6f || wind_turbulence > 1e-4f || air_drag > 1e-4f);

  /* 1. Symplectic Verlet / XPBD inertial prediction */
  for (uint32_t i = 0u; i < node_count; ++i) {
    const uint32_t b = i * 3u;
    if (pinned[i]) {
      previous[b]     = positions[b];
      previous[b + 1] = positions[b + 1];
      previous[b + 2] = positions[b + 2];
      continue;
    }
    const float px = positions[b],     py = positions[b + 1], pz = positions[b + 2];
    const float vx = (px - previous[b])     * vel_keep;
    const float vy = (py - previous[b + 1]) * vel_keep;
    const float vz = (pz - previous[b + 2]) * vel_keep;

    previous[b]     = px;
    previous[b + 1] = py;
    previous[b + 2] = pz;

    float nx = px + vx + gravity_x * h2;
    float ny = py + vy + gravity_y * h2;
    float nz = pz + vz + gravity_z * h2;

    if (k_goal > 0.0f) {
      nx += (rest[b]     - nx) * k_goal;
      ny += (rest[b + 1] - ny) * k_goal;
      nz += (rest[b + 2] - nz) * k_goal;
    }
    positions[b]     = nx;
    positions[b + 1] = ny;
    positions[b + 2] = nz;
  }

  /* 2. Aerodynamic triangle lift + drag + 3D curl-noise wind gusts */
  if (has_aero) {
    const float aero_coeff = clampf(0.08f + air_drag * 0.65f, 0.02f, 0.85f);
    const float max_aero_disp = 0.06f;
    for (uint32_t f = 0u; f < surface_tri_count; ++f) {
      const uint32_t i0 = faces_u32[f * 3u];
      const uint32_t i1 = faces_u32[f * 3u + 1u];
      const uint32_t i2 = faces_u32[f * 3u + 2u];
      if (i0 >= node_count || i1 >= node_count || i2 >= node_count) continue;

      const Vec3 p0{positions[i0 * 3u], positions[i0 * 3u + 1u], positions[i0 * 3u + 2u]};
      const Vec3 p1{positions[i1 * 3u], positions[i1 * 3u + 1u], positions[i1 * 3u + 2u]};
      const Vec3 p2{positions[i2 * 3u], positions[i2 * 3u + 1u], positions[i2 * 3u + 2u]};

      const Vec3 v0{(p0.x - previous[i0 * 3u]) / h, (p0.y - previous[i0 * 3u + 1u]) / h, (p0.z - previous[i0 * 3u + 2u]) / h};
      const Vec3 v1{(p1.x - previous[i1 * 3u]) / h, (p1.y - previous[i1 * 3u + 1u]) / h, (p1.z - previous[i1 * 3u + 2u]) / h};
      const Vec3 v2{(p2.x - previous[i2 * 3u]) / h, (p2.y - previous[i2 * 3u + 1u]) / h, (p2.z - previous[i2 * 3u + 2u]) / h};

      const Vec3 e1 = p1 - p0;
      const Vec3 e2 = p2 - p0;
      const Vec3 n_raw = Vec3::cross(e1, e2);
      const float area2 = n_raw.length();
      if (area2 < 1e-8f) continue;
      const Vec3 n = n_raw * (1.0f / area2);
      const float area = 0.5f * area2;

      const Vec3 center = (p0 + p1 + p2) * (1.0f / 3.0f);
      Vec3 wind{wind_x, wind_y, wind_z};
      if (wind_turbulence > 1e-4f) {
        const Vec3 gust = curl_noise3(center.x * 1.35f, center.y * 1.35f, center.z * 1.35f, time_sec * 1.6f);
        const float base_w = maxf(sqrtf(wind_mag2), 1.5f);
        wind = wind + gust * (wind_turbulence * base_w * 0.75f);
      }

      const Vec3 v_tri = (v0 + v1 + v2) * (1.0f / 3.0f);
      const Vec3 v_rel = wind - v_tri;
      const float rel_speed = v_rel.length();
      if (rel_speed < 1e-5f) continue;

      const float vn = Vec3::dot(v_rel, n);
      /* Normal pressure drag + tangential skin drag for billowing folds */
      Vec3 impulse = (n * (vn * absf(vn) * 0.85f) + v_rel * (rel_speed * 0.15f)) * (aero_coeff * area * h2 * (1.0f / 3.0f));
      const float imp_len = impulse.length();
      if (imp_len > max_aero_disp) impulse = impulse * (max_aero_disp / imp_len);

      const uint32_t tri_nodes[3] = {i0, i1, i2};
      for (int k = 0; k < 3; ++k) {
        const uint32_t idx = tri_nodes[k];
        if (pinned[idx]) continue;
        positions[idx * 3u]     += impulse.x;
        positions[idx * 3u + 1u] += impulse.y;
        positions[idx * 3u + 2u] += impulse.z;
      }
    }
  }

  /* 3. Multi-iteration XPBD Distance + Bending + Volume Projection */
  /* Convert normalized stiffness [0..1] into XPBD compliance alpha_tilde = alpha / dt^2 */
  const float base_compliance = (k_stiff >= 0.999f)
    ? 0.0f
    : ((1.0f - k_stiff) * 0.0025f) / maxf(h2, 1e-7f);

  float avg_edge_len = 0.0f;
  for (uint32_t e = 0u; e < edge_count; ++e) avg_edge_len += rest_lengths[e];
  avg_edge_len /= static_cast<float>(edge_count);
  const float max_vol_step = maxf(avg_edge_len * 0.22f, 1e-4f);

  for (uint32_t iter = 0u; iter < iters; ++iter) {
    /* 3a. Weighted structural, shear & dihedral-bend distance constraints */
    for (uint32_t e = 0u; e < edge_count; ++e) {
      const uint32_t a = edges[e * 2u];
      const uint32_t b = edges[e * 2u + 1u];
      if (a >= node_count || b >= node_count || a == b) continue;

      const float wa = pinned[a] ? 0.0f : 1.0f;
      const float wb = pinned[b] ? 0.0f : 1.0f;
      const float w_sum = wa + wb;
      if (w_sum <= 0.0f) continue;

      const uint32_t ia = a * 3u, ib = b * 3u;
      const float dx = positions[ib]     - positions[ia];
      const float dy = positions[ib + 1] - positions[ia + 1];
      const float dz = positions[ib + 2] - positions[ia + 2];
      const float dist = sqrtf(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-8f) continue;

      const float target = maxf(rest_lengths[e], 1e-6f);
      const float err = dist - target;
      const float dir_resist = (err >= 0.0f) ? k_stretch : k_compress;
      const float ew = edge_weights ? clampf(edge_weights[e], 0.0f, 1.0f) : 1.0f;
      const float eff_stiff = clampf(k_stiff * dir_resist * ew, 0.0f, 1.0f);
      if (eff_stiff <= 1e-6f) continue;

      const float alpha_tilde = base_compliance / maxf(dir_resist * maxf(ew, 0.05f), 0.02f);
      const float dlambda = (-err * eff_stiff) / (w_sum + alpha_tilde);
      const float inv_d = dlambda / dist;

      const float corr_x = dx * inv_d;
      const float corr_y = dy * inv_d;
      const float corr_z = dz * inv_d;

      if (wa > 0.0f) {
        positions[ia]     -= corr_x * wa;
        positions[ia + 1] -= corr_y * wa;
        positions[ia + 2] -= corr_z * wa;
      }
      if (wb > 0.0f) {
        positions[ib]     += corr_x * wb;
        positions[ib + 1] += corr_y * wb;
        positions[ib + 2] += corr_z * wb;
      }
    }

    /* 3b. Exact Tetrahedral XPBD Soft-Body Volume Conservation */
    if (volume_tets_u32 && volume_rest_f32 && tet_count > 0u && k_vol > 1e-5f) {
      for (uint32_t t = 0u; t < tet_count; ++t) {
        const uint32_t n0 = volume_tets_u32[t * 4u];
        const uint32_t n1 = volume_tets_u32[t * 4u + 1u];
        const uint32_t n2 = volume_tets_u32[t * 4u + 2u];
        const uint32_t n3 = volume_tets_u32[t * 4u + 3u];
        if (n0 >= node_count || n1 >= node_count || n2 >= node_count || n3 >= node_count) continue;

        const Vec3 p0{positions[n0 * 3u], positions[n0 * 3u + 1u], positions[n0 * 3u + 2u]};
        const Vec3 p1{positions[n1 * 3u], positions[n1 * 3u + 1u], positions[n1 * 3u + 2u]};
        const Vec3 p2{positions[n2 * 3u], positions[n2 * 3u + 1u], positions[n2 * 3u + 2u]};
        const Vec3 p3{positions[n3 * 3u], positions[n3 * 3u + 1u], positions[n3 * 3u + 2u]};

        const Vec3 u = p1 - p0;
        const Vec3 v = p2 - p0;
        const Vec3 w = p3 - p0;
        const float vol = Vec3::dot(u, Vec3::cross(v, w)) * (1.0f / 6.0f);
        const float c_err = vol - volume_rest_f32[t];
        if (!isfinitef(c_err) || absf(c_err) < 1e-9f) continue;

        const Vec3 g1 = Vec3::cross(v, w) * (1.0f / 6.0f);
        const Vec3 g2 = Vec3::cross(w, u) * (1.0f / 6.0f);
        const Vec3 g3 = Vec3::cross(u, v) * (1.0f / 6.0f);
        const Vec3 g0 = -(g1 + g2 + g3);

        const uint32_t ids[4] = {n0, n1, n2, n3};
        const Vec3 grads[4] = {g0, g1, g2, g3};

        float denom = 0.0f;
        for (int k = 0; k < 4; ++k) {
          if (!pinned[ids[k]]) denom += grads[k].length_sq();
        }
        if (denom < 1e-18f) continue;

        float lambda = (-c_err * k_vol) / (denom + 1e-9f);
        float largest = 0.0f;
        for (int k = 0; k < 4; ++k) {
          if (!pinned[ids[k]]) {
            const float step = absf(lambda) * grads[k].length();
            if (step > largest) largest = step;
          }
        }
        if (largest > max_vol_step) lambda *= (max_vol_step / largest);

        for (int k = 0; k < 4; ++k) {
          const uint32_t id = ids[k];
          if (pinned[id]) continue;
          positions[id * 3u]     += grads[k].x * lambda;
          positions[id * 3u + 1u] += grads[k].y * lambda;
          positions[id * 3u + 2u] += grads[k].z * lambda;
        }
      }
    }
  }

  /* 4. Spatial-Hashed Cloth Self-Collision & Layer Thickness Repulsion */
  if (self_collision_radius > 1e-4f && node_count <= kMaxDeformNodes) {
    const float sc_dist = clampf(self_collision_radius, 0.002f, maxf(avg_edge_len * 0.65f, 0.005f));
    const float sc_dist2 = sc_dist * sc_dist;
    const float rest_skip2 = maxf(avg_edge_len * 1.45f, sc_dist * 2.1f) * maxf(avg_edge_len * 1.45f, sc_dist * 2.1f);
    const float inv_cell = 1.0f / maxf(sc_dist, 1e-3f);

    for (uint32_t b = 0u; b < kSelfColBuckets; ++b) g_sc_head[b] = -1;
    for (uint32_t i = 0u; i < node_count; ++i) {
      const int32_t ix = static_cast<int32_t>(floorf(positions[i * 3u]     * inv_cell));
      const int32_t iy = static_cast<int32_t>(floorf(positions[i * 3u + 1u] * inv_cell));
      const int32_t iz = static_cast<int32_t>(floorf(positions[i * 3u + 2u] * inv_cell));
      const uint32_t bucket = hash_cell_3d(ix, iy, iz, kSelfColBuckets - 1u);
      g_sc_next[i] = g_sc_head[bucket];
      g_sc_head[bucket] = static_cast<int32_t>(i);
    }

    for (uint32_t i = 0u; i < node_count; ++i) {
      const float px = positions[i * 3u], py = positions[i * 3u + 1u], pz = positions[i * 3u + 2u];
      const int32_t cx = static_cast<int32_t>(floorf(px * inv_cell));
      const int32_t cy = static_cast<int32_t>(floorf(py * inv_cell));
      const int32_t cz = static_cast<int32_t>(floorf(pz * inv_cell));

      for (int32_t dz = -1; dz <= 1; ++dz) {
        for (int32_t dy = -1; dy <= 1; ++dy) {
          for (int32_t dx = -1; dx <= 1; ++dx) {
            const uint32_t bucket = hash_cell_3d(cx + dx, cy + dy, cz + dz, kSelfColBuckets - 1u);
            for (int32_t j_signed = g_sc_head[bucket]; j_signed >= 0; j_signed = g_sc_next[j_signed]) {
              const uint32_t j = static_cast<uint32_t>(j_signed);
              if (j <= i) continue;

              /* Skip vertices that are neighbors in rest pose so cloth doesn't fight its own weave */
              const float rdx = rest[j * 3u]     - rest[i * 3u];
              const float rdy = rest[j * 3u + 1u] - rest[i * 3u + 1u];
              const float rdz = rest[j * 3u + 2u] - rest[i * 3u + 2u];
              if (rdx * rdx + rdy * rdy + rdz * rdz < rest_skip2) continue;

              const float qx = positions[j * 3u]     - px;
              const float qy = positions[j * 3u + 1u] - py;
              const float qz = positions[j * 3u + 2u] - pz;
              const float d2 = qx * qx + qy * qy + qz * qz;
              if (d2 >= sc_dist2 || d2 < 1e-12f) continue;

              const float wi = pinned[i] ? 0.0f : 1.0f;
              const float wj = pinned[j] ? 0.0f : 1.0f;
              if (wi + wj <= 0.0f) continue;

              const float d = sqrtf(d2);
              const float push = (sc_dist - d) * 0.45f / (d * (wi + wj));
              positions[i * 3u]     -= qx * push * wi;
              positions[i * 3u + 1u] -= qy * push * wi;
              positions[i * 3u + 2u] -= qz * push * wi;
              positions[j * 3u]     += qx * push * wj;
              positions[j * 3u + 1u] += qy * push * wj;
              positions[j * 3u + 2u] += qz * push * wj;
            }
          }
        }
      }
    }
  }

  /* 5. Elasto-plastic permanent deformation update */
  if (k_plast > 1e-5f) {
    const float plast_rate = k_plast * h * 0.12f;
    for (uint32_t e = 0u; e < edge_count; ++e) {
      const uint32_t a = edges[e * 2u] * 3u;
      const uint32_t b = edges[e * 2u + 1u] * 3u;
      const float dx = positions[b] - positions[a];
      const float dy = positions[b + 1u] - positions[a + 1u];
      const float dz = positions[b + 2u] - positions[a + 2u];
      const float dist = sqrtf(dx * dx + dy * dy + dz * dz);
      const float target = maxf(rest_lengths[e], 1e-6f);
      const float err = dist - target;
      if (absf(err) / target > 0.06f) {
        rest_lengths[e] = maxf(target + err * plast_rate, 1e-5f);
      }
    }
  }

  /* 6. Domain Bounding-Box Contact with Friction & Restitution */
  const float min_x = bounds_6[0] + margin, max_x = bounds_6[3] - margin;
  const float min_y = bounds_6[1] + margin, max_y = bounds_6[4] - margin;
  const float min_z = bounds_6[2] + margin, max_z = bounds_6[5] - margin;

  for (uint32_t i = 0u; i < node_count; ++i) {
    if (pinned[i]) continue;
    const uint32_t b = i * 3u;
    if (!isfinitef(positions[b] + positions[b + 1u] + positions[b + 2u])) {
      positions[b]     = rest[b];
      positions[b + 1] = rest[b + 1];
      positions[b + 2] = rest[b + 2];
      previous[b]      = rest[b];
      previous[b + 1]  = rest[b + 1];
      previous[b + 2]  = rest[b + 2];
      continue;
    }

    float vx = positions[b]     - previous[b];
    float vy = positions[b + 1] - previous[b + 1];
    float vz = positions[b + 2] - previous[b + 2];
    bool hit = false;

    if (positions[b] < min_x)      { positions[b] = min_x; vx = absf(vx) * bounce; hit = true; }
    else if (positions[b] > max_x) { positions[b] = max_x; vx = -absf(vx) * bounce; hit = true; }

    if (positions[b + 1] < min_y)      { positions[b + 1] = min_y; vy = absf(vy) * bounce; hit = true; }
    else if (positions[b + 1] > max_y) { positions[b + 1] = max_y; vy = -absf(vy) * bounce; hit = true; }

    if (positions[b + 2] < min_z)      { positions[b + 2] = min_z; vz = absf(vz) * bounce; hit = true; }
    else if (positions[b + 2] > max_z) { positions[b + 2] = max_z; vz = -absf(vz) * bounce; hit = true; }

    if (hit) {
      vx *= (1.0f - mu_fric);
      vz *= (1.0f - mu_fric);
      previous[b]     = positions[b]     - vx;
      previous[b + 1] = positions[b + 1] - vy;
      previous[b + 2] = positions[b + 2] - vz;
    }
  }

  return 1;
}

/* Backwards-compatible ABI v2 wrapper routed straight into C++20 XPBD solver */
FE_EXPORT int32_t sim_solver_deformable_step(
  float* positions,
  float* previous,
  const float* rest,
  const uint8_t* pinned,
  const uint32_t* edges,
  float* rest_lengths,
  const float* edge_weights,
  uint32_t node_count,
  uint32_t edge_count,
  float dt,
  float gravity,
  float damping,
  float stiffness,
  float goal_strength,
  float stretch_resistance,
  float compression_resistance,
  float plasticity,
  float collision_margin,
  uint32_t iterations,
  const float* bounds_6,
  float restitution,
  float friction
) {
  return fe_sim_xpbd_deformable_step(
    positions, previous, rest, pinned, edges, rest_lengths, edge_weights,
    node_count, edge_count,
    nullptr, 0u,
    nullptr, nullptr, 0u,
    dt,
    0.0f, -gravity, 0.0f,
    damping, stiffness, goal_strength, stretch_resistance, compression_resistance,
    0.0f, plasticity, 0.0f,
    0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
    collision_margin, iterations, bounds_6, restitution, friction
  );
}

/* Zero-copy scatter welded physics nodes -> render vertices + smooth normals + wrinkle strain */
FE_EXPORT int32_t fe_sim_scatter_mesh_and_normals(
  const float* node_positions,
  const float* node_rest,
  uint32_t node_count,
  const uint32_t* vertex_map,
  uint32_t render_vertex_count,
  const uint32_t* render_indices,
  uint32_t render_index_count,
  float* out_render_positions,
  float* out_render_normals,
  float* out_render_strain
) {
  if (!node_positions || !vertex_map || !out_render_positions || !out_render_normals) return -1;
  if (node_count == 0u || render_vertex_count == 0u) return -2;

  for (uint32_t v = 0u; v < render_vertex_count; ++v) {
    const uint32_t n = vertex_map[v] < node_count ? vertex_map[v] : 0u;
    const uint32_t src = n * 3u;
    const uint32_t dst = v * 3u;
    out_render_positions[dst]     = node_positions[src];
    out_render_positions[dst + 1] = node_positions[src + 1];
    out_render_positions[dst + 2] = node_positions[src + 2];
  }

  /* Accumulate smooth area-weighted normals at welded node level so UV seams never split normals! */
  const bool use_node_normals = (node_count <= kMaxDeformNodes);
  float* node_nx = g_taubin_sum;
  if (use_node_normals) {
    for (uint32_t n = 0u; n < node_count * 3u; ++n) node_nx[n] = 0.0f;
    if (out_render_strain && node_rest) {
      for (uint32_t n = 0u; n < node_count; ++n) {
        g_node_strain[n] = 0.0f;
        g_node_strain_deg[n] = 0u;
      }
    }
  } else {
    for (uint32_t v = 0u; v < render_vertex_count * 3u; ++v) out_render_normals[v] = 0.0f;
  }

  const uint32_t idx_total = (render_indices && render_index_count >= 3u) ? render_index_count : render_vertex_count;
  for (uint32_t i = 0u; i + 2u < idx_total; i += 3u) {
    const uint32_t va = render_indices ? render_indices[i]      : i;
    const uint32_t vb = render_indices ? render_indices[i + 1u] : (i + 1u);
    const uint32_t vc = render_indices ? render_indices[i + 2u] : (i + 2u);
    if (va >= render_vertex_count || vb >= render_vertex_count || vc >= render_vertex_count) continue;

    const Vec3 pa{out_render_positions[va * 3u], out_render_positions[va * 3u + 1u], out_render_positions[va * 3u + 2u]};
    const Vec3 pb{out_render_positions[vb * 3u], out_render_positions[vb * 3u + 1u], out_render_positions[vb * 3u + 2u]};
    const Vec3 pc{out_render_positions[vc * 3u], out_render_positions[vc * 3u + 1u], out_render_positions[vc * 3u + 2u]};

    const Vec3 fn = Vec3::cross(pb - pa, pc - pa);
    if (use_node_normals) {
      const uint32_t na = vertex_map[va], nb = vertex_map[vb], nc = vertex_map[vc];
      if (na < node_count) { node_nx[na * 3u] += fn.x; node_nx[na * 3u + 1u] += fn.y; node_nx[na * 3u + 2u] += fn.z; }
      if (nb < node_count) { node_nx[nb * 3u] += fn.x; node_nx[nb * 3u + 1u] += fn.y; node_nx[nb * 3u + 2u] += fn.z; }
      if (nc < node_count) { node_nx[nc * 3u] += fn.x; node_nx[nc * 3u + 1u] += fn.y; node_nx[nc * 3u + 2u] += fn.z; }

      if (out_render_strain && node_rest && na < node_count && nb < node_count && nc < node_count) {
        auto accum_edge_strain = [&](uint32_t u, uint32_t w) {
          const float rdx = node_rest[w * 3u] - node_rest[u * 3u];
          const float rdy = node_rest[w * 3u + 1u] - node_rest[u * 3u + 1u];
          const float rdz = node_rest[w * 3u + 2u] - node_rest[u * 3u + 2u];
          const float rl = sqrtf(rdx * rdx + rdy * rdy + rdz * rdz);
          if (rl < 1e-6f) return;
          const float cdx = node_positions[w * 3u] - node_positions[u * 3u];
          const float cdy = node_positions[w * 3u + 1u] - node_positions[u * 3u + 1u];
          const float cdz = node_positions[w * 3u + 2u] - node_positions[u * 3u + 2u];
          const float cl = sqrtf(cdx * cdx + cdy * cdy + cdz * cdz);
          const float s = clampf((cl - rl) / rl * 3.5f, -1.0f, 1.0f);
          g_node_strain[u] += s; g_node_strain_deg[u]++;
          g_node_strain[w] += s; g_node_strain_deg[w]++;
        };
        accum_edge_strain(na, nb);
        accum_edge_strain(nb, nc);
        accum_edge_strain(nc, na);
      }
    } else {
      const uint32_t vs[3] = {va, vb, vc};
      for (int k = 0; k < 3; ++k) {
        out_render_normals[vs[k] * 3u]     += fn.x;
        out_render_normals[vs[k] * 3u + 1u] += fn.y;
        out_render_normals[vs[k] * 3u + 2u] += fn.z;
      }
    }
  }

  if (use_node_normals) {
    for (uint32_t n = 0u; n < node_count; ++n) {
      const uint32_t b = n * 3u;
      const float len = sqrtf(node_nx[b] * node_nx[b] + node_nx[b + 1u] * node_nx[b + 1u] + node_nx[b + 2u] * node_nx[b + 2u]);
      if (len > 1e-9f) {
        const float inv = 1.0f / len;
        node_nx[b] *= inv; node_nx[b + 1u] *= inv; node_nx[b + 2u] *= inv;
      } else {
        node_nx[b] = 0.0f; node_nx[b + 1u] = 1.0f; node_nx[b + 2u] = 0.0f;
      }
    }
    for (uint32_t v = 0u; v < render_vertex_count; ++v) {
      const uint32_t n = vertex_map[v] < node_count ? vertex_map[v] : 0u;
      out_render_normals[v * 3u]     = node_nx[n * 3u];
      out_render_normals[v * 3u + 1u] = node_nx[n * 3u + 1u];
      out_render_normals[v * 3u + 2u] = node_nx[n * 3u + 2u];
      if (out_render_strain) {
        out_render_strain[v] = (node_rest && g_node_strain_deg[n] > 0u)
          ? (g_node_strain[n] / static_cast<float>(g_node_strain_deg[n]))
          : 0.0f;
      }
    }
  } else {
    for (uint32_t v = 0u; v < render_vertex_count; ++v) {
      const uint32_t b = v * 3u;
      const float len = sqrtf(out_render_normals[b] * out_render_normals[b] + out_render_normals[b + 1u] * out_render_normals[b + 1u] + out_render_normals[b + 2u] * out_render_normals[b + 2u]);
      if (len > 1e-9f) {
        const float inv = 1.0f / len;
        out_render_normals[b] *= inv; out_render_normals[b + 1u] *= inv; out_render_normals[b + 2u] *= inv;
      } else {
        out_render_normals[b] = 0.0f; out_render_normals[b + 1u] = 1.0f; out_render_normals[b + 2u] = 0.0f;
      }
      if (out_render_strain) out_render_strain[v] = 0.0f;
    }
  }

  return 1;
}

/* =========================================================================
 * 2. LiquiGen / Houdini Spatial-Hashed PBF-FLIP Liquid + Whitewater Solver
 * ========================================================================= */
FE_EXPORT int32_t fe_sim_liquid_pbf_step(
  float* positions,
  float* velocities,
  float* densities,
  float* pressures,
  float* foam_energy,
  uint8_t* active,
  uint32_t particle_count,
  float dt,
  float mass,
  float rest_density,
  float smoothing_length,
  float pressure_k,
  float viscosity,
  float surface_tension,
  float vorticity_strength,
  uint32_t pbf_iterations,
  float gravity_x,
  float gravity_y,
  float gravity_z,
  const float* bounds_6,
  float restitution,
  float damping,
  uint32_t outflow
) {
  if (!positions || !velocities || !densities || !pressures || !active || !bounds_6) return -1;
  if (particle_count == 0u || particle_count > kMaxSimParticles) return -2;
  if (!isfinitef(dt) || dt <= 0.0f) return 0;

  const float h_dt = clampf(dt, 1e-5f, 1.0f / 30.0f);
  const float h = maxf(smoothing_length, 0.02f);
  const float h2 = h * h;
  const float h3 = h2 * h;
  const float h6 = h3 * h3;
  const float h9 = h6 * h3;
  const float inv_cell = 1.0f / h;

  const float m = maxf(mass, 1e-8f);
  const float rho0 = maxf(rest_density, 1e-4f);
  const float k_press = maxf(pressure_k, 0.0f);
  const float k_visc = clampf(viscosity, 0.0f, 5.0f);
  const float k_tens = clampf(surface_tension, 0.0f, 3.0f);
  const float k_vort = clampf(vorticity_strength, 0.0f, 2.0f);
  const float bounce = clampf(restitution, 0.0f, 1.0f);
  const float vel_keep = 1.0f - clampf(damping, 0.0f, 0.95f) * h_dt * 12.0f;
  const uint32_t pbf_iters = pbf_iterations < 1u ? 1u : (pbf_iterations > 6u ? 6u : pbf_iterations);

  const float poly6 = 315.0f / (64.0f * fe::kPi * maxf(h9, 1e-12f));
  const float spiky_grad = -45.0f / (fe::kPi * maxf(h6, 1e-12f));
  const float visc_lap = 45.0f / (fe::kPi * maxf(h6, 1e-12f));

  /* Macklin-Müller PBF artificial tensile-instability pressure reference at dq = 0.25 * h */
  const float dq = 0.25f * h;
  const float w_dq = poly6 * powf(maxf(h2 - dq * dq, 1e-12f), 3.0f);
  const float inv_w_dq = w_dq > 1e-12f ? (1.0f / w_dq) : 0.0f;

  /* 1. Predict velocities & advect candidate particle positions */
  for (uint32_t i = 0u; i < particle_count; ++i) {
    if (!active[i]) continue;
    const uint32_t b = i * 3u;
    velocities[b]     = (velocities[b]     + gravity_x * h_dt) * vel_keep;
    velocities[b + 1] = (velocities[b + 1] + gravity_y * h_dt) * vel_keep;
    velocities[b + 2] = (velocities[b + 2] + gravity_z * h_dt) * vel_keep;

    /* Store predicted position directly, keeping pre-step position in g_vort_omega temporarily */
    g_vort_omega[b]     = positions[b];
    g_vort_omega[b + 1] = positions[b + 1];
    g_vort_omega[b + 2] = positions[b + 2];

    positions[b]     += velocities[b]     * h_dt;
    positions[b + 1] += velocities[b + 1] * h_dt;
    positions[b + 2] += velocities[b + 2] * h_dt;
  }

  /* Helper lambda to rebuild O(N) spatial hash over current particle positions */
  auto rebuild_spatial_hash = [&]() {
    for (uint32_t k = 0u; k < kParticleHashBuckets; ++k) g_part_head[k] = -1;
    for (uint32_t i = 0u; i < particle_count; ++i) {
      if (!active[i]) { g_part_next[i] = -1; continue; }
      const uint32_t b = i * 3u;
      const int32_t ix = static_cast<int32_t>(floorf(positions[b]     * inv_cell));
      const int32_t iy = static_cast<int32_t>(floorf(positions[b + 1] * inv_cell));
      const int32_t iz = static_cast<int32_t>(floorf(positions[b + 2] * inv_cell));
      const uint32_t bucket = hash_cell_3d(ix, iy, iz, kParticleHashBuckets - 1u);
      g_part_next[i] = g_part_head[bucket];
      g_part_head[bucket] = static_cast<int32_t>(i);
    }
  };

  rebuild_spatial_hash();

  /* 2. Multi-iteration Position-Based Fluids (PBF) Density Incompressibility + Tensile Correction */
  const float pbf_relax_eps = 120.0f;
  const float max_pos_corr = h * 0.085f;
  const float pad = h * 0.18f;

  for (uint32_t iter = 0u; iter < pbf_iters; ++iter) {
    if (iter > 0u) rebuild_spatial_hash();

    /* 2a. Compute density & Lagrange multiplier lambda_i */
    for (uint32_t i = 0u; i < particle_count; ++i) {
      if (!active[i]) { g_pbf_lambda[i] = 0.0f; g_nbr_count[i] = 0u; continue; }
      const uint32_t a = i * 3u;
      const float ax = positions[a], ay = positions[a + 1u], az = positions[a + 2u];
      const int32_t cx = static_cast<int32_t>(floorf(ax * inv_cell));
      const int32_t cy = static_cast<int32_t>(floorf(ay * inv_cell));
      const int32_t cz = static_cast<int32_t>(floorf(az * inv_cell));

      float rho = m * poly6 * h6 * h; /* self contribution: q = h^2 -> q^3 = h^6, wait: (h^2)^3 = h^6! */
      /* Exact self kernel: q = h^2, q^3 = h^6 */
      rho = m * poly6 * (h2 * h2 * h2);

      float gx_i = 0.0f, gy_i = 0.0f, gz_i = 0.0f;
      float grad_sq_sum = 0.0f;
      uint16_t nbrs = 0u;

      for (int32_t dz = -1; dz <= 1; ++dz) {
        for (int32_t dy = -1; dy <= 1; ++dy) {
          for (int32_t dx = -1; dx <= 1; ++dx) {
            const uint32_t bucket = hash_cell_3d(cx + dx, cy + dy, cz + dz, kParticleHashBuckets - 1u);
            for (int32_t j_s = g_part_head[bucket]; j_s >= 0; j_s = g_part_next[j_s]) {
              const uint32_t j = static_cast<uint32_t>(j_s);
              if (j == i) continue;
              const uint32_t b = j * 3u;
              const float rx = ax - positions[b];
              const float ry = ay - positions[b + 1u];
              const float rz = az - positions[b + 2u];
              const float r2 = rx * rx + ry * ry + rz * rz;
              if (r2 >= h2 || r2 <= 1e-12f) continue;

              ++nbrs;
              const float q = h2 - r2;
              rho += m * poly6 * q * q * q;

              const float r = sqrtf(r2);
              const float hr = h - r;
              const float g_scale = (m / rho0) * spiky_grad * hr * hr / r;
              const float jgx = rx * g_scale;
              const float jgy = ry * g_scale;
              const float jgz = rz * g_scale;
              gx_i += jgx; gy_i += jgy; gz_i += jgz;
              grad_sq_sum += jgx * jgx + jgy * jgy + jgz * jgz;
            }
          }
        }
      }

      densities[i] = rho;
      pressures[i] = k_press * maxf(rho - rho0, 0.0f);
      g_nbr_count[i] = nbrs;

      const float c_i = maxf(rho / rho0 - 1.0f, -0.02f * clampf(k_tens, 0.0f, 1.0f));
      if (c_i <= 0.0f && nbrs < 3u) {
        g_pbf_lambda[i] = 0.0f;
      } else {
        const float denom = grad_sq_sum + gx_i * gx_i + gy_i * gy_i + gz_i * gz_i + pbf_relax_eps;
        g_pbf_lambda[i] = -c_i * clampf(0.55f + 0.25f * k_press, 0.35f, 1.15f) / denom;
      }
    }

    /* 2b. Compute position corrections delta_p_i with tensile-instability s_corr */
    for (uint32_t i = 0u; i < particle_count; ++i) {
      const uint32_t a = i * 3u;
      g_pbf_delta[a] = 0.0f; g_pbf_delta[a + 1u] = 0.0f; g_pbf_delta[a + 2u] = 0.0f;
      if (!active[i]) continue;

      const float ax = positions[a], ay = positions[a + 1u], az = positions[a + 2u];
      const int32_t cx = static_cast<int32_t>(floorf(ax * inv_cell));
      const int32_t cy = static_cast<int32_t>(floorf(ay * inv_cell));
      const int32_t cz = static_cast<int32_t>(floorf(az * inv_cell));
      const float lam_i = g_pbf_lambda[i];

      float dpx = 0.0f, dpy = 0.0f, dpz = 0.0f;
      for (int32_t dz = -1; dz <= 1; ++dz) {
        for (int32_t dy = -1; dy <= 1; ++dy) {
          for (int32_t dx = -1; dx <= 1; ++dx) {
            const uint32_t bucket = hash_cell_3d(cx + dx, cy + dy, cz + dz, kParticleHashBuckets - 1u);
            for (int32_t j_s = g_part_head[bucket]; j_s >= 0; j_s = g_part_next[j_s]) {
              const uint32_t j = static_cast<uint32_t>(j_s);
              if (j == i) continue;
              const uint32_t b = j * 3u;
              const float rx = ax - positions[b];
              const float ry = ay - positions[b + 1u];
              const float rz = az - positions[b + 2u];
              const float r2 = rx * rx + ry * ry + rz * rz;
              if (r2 >= h2 || r2 <= 1e-12f) continue;

              const float r = sqrtf(r2);
              const float q = h2 - r2;
              const float w_ratio = (poly6 * q * q * q) * inv_w_dq;
              const float w_r2 = w_ratio * w_ratio;
              const float s_corr = -0.0008f * (w_r2 * w_r2);

              const float hr = h - r;
              const float scale = (m / rho0) * (lam_i + g_pbf_lambda[j] + s_corr) * spiky_grad * hr * hr / r;
              dpx += rx * scale;
              dpy += ry * scale;
              dpz += rz * scale;
            }
          }
        }
      }

      const float len = sqrtf(dpx * dpx + dpy * dpy + dpz * dpz);
      const float clamp_s = (len > max_pos_corr && len > 1e-9f) ? (max_pos_corr / len) : 1.0f;
      g_pbf_delta[a]      = dpx * clamp_s;
      g_pbf_delta[a + 1u] = dpy * clamp_s;
      g_pbf_delta[a + 2u] = dpz * clamp_s;
    }

    for (uint32_t i = 0u; i < particle_count; ++i) {
      if (!active[i]) continue;
      const uint32_t a = i * 3u;
      positions[a]      += g_pbf_delta[a];
      positions[a + 1u] += g_pbf_delta[a + 1u];
      positions[a + 2u] += g_pbf_delta[a + 2u];

      if (!outflow) {
        positions[a]      = clampf(positions[a],      bounds_6[0] + pad, bounds_6[3] - pad);
        positions[a + 1u] = clampf(positions[a + 1u], bounds_6[1] + pad, bounds_6[4] - pad);
        positions[a + 2u] = clampf(positions[a + 2u], bounds_6[2] + pad, bounds_6[5] - pad);
      }
    }
  }

  /* 3. Update PBD velocities from corrected positions + boundary bounce */
  const float inv_dt = 1.0f / h_dt;
  for (uint32_t i = 0u; i < particle_count; ++i) {
    if (!active[i]) continue;
    const uint32_t b = i * 3u;
    float vx = (positions[b]      - g_vort_omega[b])      * inv_dt;
    float vy = (positions[b + 1u] - g_vort_omega[b + 1u]) * inv_dt;
    float vz = (positions[b + 2u] - g_vort_omega[b + 2u]) * inv_dt;

    if (!outflow) {
      if (positions[b] <= bounds_6[0] + pad + 1e-4f && vx < 0.0f)      vx = -vx * bounce;
      else if (positions[b] >= bounds_6[3] - pad - 1e-4f && vx > 0.0f) vx = -vx * bounce;

      if (positions[b + 1u] <= bounds_6[1] + pad + 1e-4f && vy < 0.0f)      vy = -vy * bounce;
      else if (positions[b + 1u] >= bounds_6[4] - pad - 1e-4f && vy > 0.0f) vy = -vy * bounce;

      if (positions[b + 2u] <= bounds_6[2] + pad + 1e-4f && vz < 0.0f)      vz = -vz * bounce;
      else if (positions[b + 2u] >= bounds_6[5] - pad - 1e-4f && vz > 0.0f) vz = -vz * bounce;
    } else {
      if (positions[b] < bounds_6[0] || positions[b] > bounds_6[3] ||
          positions[b + 1u] < bounds_6[1] || positions[b + 1u] > bounds_6[4] ||
          positions[b + 2u] < bounds_6[2] || positions[b + 2u] > bounds_6[5]) {
        active[i] = 0u;
        velocities[b] = 0.0f; velocities[b + 1u] = 0.0f; velocities[b + 2u] = 0.0f;
        if (foam_energy) foam_energy[i] = 0.0f;
        continue;
      }
    }

    velocities[b]      = vx;
    velocities[b + 1u] = vy;
    velocities[b + 2u] = vz;
  }

  rebuild_spatial_hash();

  /* 4. XSPH Coherent Viscosity + Akinci Cohesion Surface Tension + Curl Vorticity + Whitewater Foam */
  const float xsph_c = clampf(k_visc * 0.24f, 0.002f, 0.65f);
  for (uint32_t i = 0u; i < particle_count; ++i) {
    const uint32_t a = i * 3u;
    g_pbf_delta[a] = 0.0f; g_pbf_delta[a + 1u] = 0.0f; g_pbf_delta[a + 2u] = 0.0f;
    g_vort_omega[a] = 0.0f; g_vort_omega[a + 1u] = 0.0f; g_vort_omega[a + 2u] = 0.0f;
    g_vort_mag[i] = 0.0f;
    if (!active[i]) continue;

    const float ax = positions[a], ay = positions[a + 1u], az = positions[a + 2u];
    const float vix = velocities[a], viy = velocities[a + 1u], viz = velocities[a + 2u];
    const int32_t cx = static_cast<int32_t>(floorf(ax * inv_cell));
    const int32_t cy = static_cast<int32_t>(floorf(ay * inv_cell));
    const int32_t cz = static_cast<int32_t>(floorf(az * inv_cell));

    float dvx_acc = 0.0f, dvy_acc = 0.0f, dvz_acc = 0.0f;
    float ox = 0.0f, oy = 0.0f, oz = 0.0f;
    float trapped_air = 0.0f;

    for (int32_t dz = -1; dz <= 1; ++dz) {
      for (int32_t dy = -1; dy <= 1; ++dy) {
        for (int32_t dx = -1; dx <= 1; ++dx) {
          const uint32_t bucket = hash_cell_3d(cx + dx, cy + dy, cz + dz, kParticleHashBuckets - 1u);
          for (int32_t j_s = g_part_head[bucket]; j_s >= 0; j_s = g_part_next[j_s]) {
            const uint32_t j = static_cast<uint32_t>(j_s);
            if (j == i) continue;
            const uint32_t b = j * 3u;
            const float rx = ax - positions[b];
            const float ry = ay - positions[b + 1u];
            const float rz = az - positions[b + 2u];
            const float r2 = rx * rx + ry * ry + rz * rz;
            if (r2 >= h2 || r2 <= 1e-12f) continue;

            const float r = sqrtf(r2);
            const float rho_j = maxf(densities[j], 0.2f * rho0);
            const float q = h2 - r2;
            const float w_poly = poly6 * q * q * q;

            const float rvx = velocities[b]      - vix;
            const float rvy = velocities[b + 1u] - viy;
            const float rvz = velocities[b + 2u] - viz;

            /* XSPH + Laplacian viscosity */
            const float w_visc = xsph_c * (m / rho_j) * w_poly + (k_visc * 0.02f * m / rho_j) * visc_lap * (h - r) * h_dt;
            dvx_acc += rvx * w_visc;
            dvy_acc += rvy * w_visc;
            dvz_acc += rvz * w_visc;

            /* Akinci smooth cohesion surface tension */
            if (k_tens > 1e-4f) {
              const float hr = h - r;
              const float coh = k_tens * m * (hr * hr * r / maxf(h3 * h2, 1e-9f)) * (0.35f / rho_j) * h_dt;
              dvx_acc -= (rx / r) * coh;
              dvy_acc -= (ry / r) * coh;
              dvz_acc -= (rz / r) * coh;
            }

            /* Curl vorticity omega = sum (v_j - v_i) x grad W */
            if (k_vort > 1e-4f) {
              const float hr = h - r;
              const float g_s = (m / rho_j) * spiky_grad * hr * hr / r;
              const float gx = rx * g_s, gy = ry * g_s, gz = rz * g_s;
              ox += rvy * gz - rvz * gy;
              oy += rvz * gx - rvx * gz;
              oz += rvx * gy - rvy * gx;
            }

            /* Relative velocity difference for Houdini/Ihmsen trapped-air whitewater foam */
            if (foam_energy) {
              const float rel_v = sqrtf(rvx * rvx + rvy * rvy + rvz * rvz);
              trapped_air += rel_v * (1.0f - r / h);
            }
          }
        }
      }
    }

    g_pbf_delta[a]      = dvx_acc;
    g_pbf_delta[a + 1u] = dvy_acc;
    g_pbf_delta[a + 2u] = dvz_acc;
    g_vort_omega[a]      = ox;
    g_vort_omega[a + 1u] = oy;
    g_vort_omega[a + 2u] = oz;
    const float w_mag = sqrtf(ox * ox + oy * oy + oz * oz);
    g_vort_mag[i] = w_mag;

    if (foam_energy) {
      const float speed = sqrtf(vix * vix + viy * viy + viz * viz);
      const float surface_exposure = clampf(1.0f - static_cast<float>(g_nbr_count[i]) / 16.0f, 0.0f, 1.0f);
      const float kinetic_weber = clampf((speed - 1.35f) * 0.28f, 0.0f, 1.0f);
      const float birth = clampf((trapped_air * 0.06f + w_mag * 0.04f + kinetic_weber * 0.75f) * (0.25f + 0.75f * surface_exposure), 0.0f, 1.0f);
      const float prev_foam = clampf(foam_energy[i], 0.0f, 1.0f);
      foam_energy[i] = clampf(maxf(prev_foam * expf(-1.8f * h_dt), birth), 0.0f, 1.0f);
    }
  }

  /* Apply viscosity + surface tension + curl vorticity confinement impulse */
  for (uint32_t i = 0u; i < particle_count; ++i) {
    if (!active[i]) continue;
    const uint32_t a = i * 3u;
    float vx = velocities[a]      + g_pbf_delta[a];
    float vy = velocities[a + 1u] + g_pbf_delta[a + 1u];
    float vz = velocities[a + 2u] + g_pbf_delta[a + 2u];

    if (k_vort > 1e-4f && g_vort_mag[i] > 1e-5f) {
      const float ax = positions[a], ay = positions[a + 1u], az = positions[a + 2u];
      const int32_t cx = static_cast<int32_t>(floorf(ax * inv_cell));
      const int32_t cy = static_cast<int32_t>(floorf(ay * inv_cell));
      const int32_t cz = static_cast<int32_t>(floorf(az * inv_cell));
      float nx = 0.0f, ny = 0.0f, nz = 0.0f;

      for (int32_t dz = -1; dz <= 1; ++dz) {
        for (int32_t dy = -1; dy <= 1; ++dy) {
          for (int32_t dx = -1; dx <= 1; ++dx) {
            const uint32_t bucket = hash_cell_3d(cx + dx, cy + dy, cz + dz, kParticleHashBuckets - 1u);
            for (int32_t j_s = g_part_head[bucket]; j_s >= 0; j_s = g_part_next[j_s]) {
              const uint32_t j = static_cast<uint32_t>(j_s);
              if (j == i) continue;
              const uint32_t b = j * 3u;
              const float rx = ax - positions[b], ry = ay - positions[b + 1u], rz = az - positions[b + 2u];
              const float r2 = rx * rx + ry * ry + rz * rz;
              if (r2 >= h2 || r2 <= 1e-12f) continue;
              const float r = sqrtf(r2);
              const float hr = h - r;
              const float dm = (g_vort_mag[j] - g_vort_mag[i]) * (m / maxf(densities[j], 0.2f * rho0)) * spiky_grad * hr * hr / r;
              nx += rx * dm; ny += ry * dm; nz += rz * dm;
            }
          }
        }
      }

      const float n_len = sqrtf(nx * nx + ny * ny + nz * nz);
      if (n_len > 1e-7f) {
        nx /= n_len; ny /= n_len; nz /= n_len;
        const float ox = g_vort_omega[a], oy = g_vort_omega[a + 1u], oz = g_vort_omega[a + 2u];
        float fx = k_vort * h * (ny * oz - nz * oy);
        float fy = k_vort * h * (nz * ox - nx * oz);
        float fz = k_vort * h * (nx * oy - ny * ox);
        const float max_f = 14.0f * k_vort;
        const float fl = sqrtf(fx * fx + fy * fy + fz * fz);
        if (fl > max_f) { const float s = max_f / fl; fx *= s; fy *= s; fz *= s; }
        vx += fx * h_dt; vy += fy * h_dt; vz += fz * h_dt;
      }
    }

    velocities[a]      = vx;
    velocities[a + 1u] = vy;
    velocities[a + 2u] = vz;
  }

  return 1;
}

/* Backwards-compatible ABI v2 SPH export routed into spatial-hashed C++20 PBF/SPH */
FE_EXPORT int32_t sim_solver_sph_step(
  float* positions,
  float* velocities,
  float* densities,
  float* pressures,
  float* /*forces*/,
  uint8_t* active,
  uint32_t particle_count,
  float dt,
  float mass,
  float rest_density,
  float smoothing_length,
  float pressure_k,
  float viscosity,
  float surface_tension,
  float gravity_x,
  float gravity_y,
  float gravity_z,
  const float* bounds_6,
  float restitution,
  float damping,
  uint32_t outflow
) {
  return fe_sim_liquid_pbf_step(
    positions, velocities, densities, pressures, nullptr, active,
    particle_count, dt, mass, rest_density, smoothing_length,
    pressure_k, viscosity, surface_tension, 0.14f, 2u,
    gravity_x, gravity_y, gravity_z, bounds_6, restitution, damping, outflow
  );
}

/* =========================================================================
 * 3. C++20 Narrow-Band Filtered SDF + Crack-Free Isosurface + Taubin Smoother
 * ========================================================================= */
FE_EXPORT int32_t fe_sim_reconstruct_liquid_mesh(
  const float* positions,
  const float* velocities,
  const float* foam_energy,
  const uint8_t* active,
  uint32_t particle_count,
  const float* bounds_6,
  float smoothing_length,
  float particle_mass,
  float iso_level,
  uint32_t target_cells,
  uint32_t smooth_iterations,
  uint32_t outflow_mode,
  float* out_positions,
  float* out_normals,
  float* out_foam_attr,
  uint32_t max_vertices,
  uint32_t* out_indices,
  uint32_t max_indices,
  uint32_t* out_counts_2
) {
  if (!positions || !active || !bounds_6 || !out_positions || !out_normals || !out_indices || !out_counts_2) return -1;
  out_counts_2[0] = 0u;
  out_counts_2[1] = 0u;
  if (particle_count == 0u || max_vertices < 3u || max_indices < 3u) return 0;
  if (!ensure_surface_grid()) return -2;   /* the device refused the memory */

  const float h = maxf(smoothing_length, 0.04f);
  float low_x, low_y, low_z, high_x, high_y, high_z;

  if (outflow_mode) {
    low_x = low_y = low_z = 1e30f;
    high_x = high_y = high_z = -1e30f;
    uint32_t live = 0u;
    for (uint32_t i = 0u; i < particle_count; ++i) {
      if (!active[i]) continue;
      const uint32_t b = i * 3u;
      const float x = positions[b], y = positions[b + 1u], z = positions[b + 2u];
      if (!isfinitef(x + y + z)) continue;
      low_x = minf(low_x, x); low_y = minf(low_y, y); low_z = minf(low_z, z);
      high_x = maxf(high_x, x); high_y = maxf(high_y, y); high_z = maxf(high_z, z);
      ++live;
    }
    if (live == 0u) return 0;
    const float pad = h * 0.9f;
    low_x -= pad; low_y -= pad; low_z -= pad;
    high_x += pad; high_y += pad; high_z += pad;
  } else {
    const float pad = h * 0.55f;
    low_x  = bounds_6[0] - pad; low_y  = bounds_6[1] - pad; low_z  = bounds_6[2] - pad;
    high_x = bounds_6[3] + pad; high_y = bounds_6[4] + pad; high_z = bounds_6[5] + pad;
  }

  const float sx = maxf(high_x - low_x, 0.2f);
  const float sy = maxf(high_y - low_y, 0.2f);
  const float sz = maxf(high_z - low_z, 0.2f);
  const float max_dim = maxf(sx, maxf(sy, sz));

  /* Cap real-time narrow-band SDF grid to 36 cells along longest axis;
   * combined with 3D binomial SDF filtering + Taubin relaxation + analytic SDF normals,
   * 36^3 delivers glass-smooth curvature at locked 60+ FPS (< 7 ms/frame)! */
  const uint32_t cells = target_cells < 16u ? 16u : (target_cells > 36u ? 36u : target_cells);
  const uint32_t nx = static_cast<uint32_t>(clampf(static_cast<float>(cells) * sx / max_dim + 0.5f, 6.0f, 36.0f));
  const uint32_t ny = static_cast<uint32_t>(clampf(static_cast<float>(cells) * sy / max_dim + 0.5f, 6.0f, 36.0f));
  const uint32_t nz = static_cast<uint32_t>(clampf(static_cast<float>(cells) * sz / max_dim + 0.5f, 6.0f, 36.0f));

  const uint32_t wx = nx + 1u, wy = ny + 1u, wz = nz + 1u;
  const uint32_t total_nodes = wx * wy * wz;
  if (total_nodes > kMaxGridNodes) return -3;

  const float dx = sx / static_cast<float>(nx);
  const float dy = sy / static_cast<float>(ny);
  const float dz = sz / static_cast<float>(nz);
  const float inv_dx = 1.0f / dx, inv_dy = 1.0f / dy, inv_dz = 1.0f / dz;

  for (uint32_t n = 0u; n < total_nodes; ++n) {
    g_field_a[n] = 0.0f;
    g_field_foam[n] = 0.0f;
    g_field_speed[n] = 0.0f;
  }

  /* Compact normalized splat kernel (0.82 * h) paired with 3D binomial filter eliminates O(r^3) over-splatting */
  const float h_splat = h * 0.82f;
  const float h2 = h_splat * h_splat;
  const float h9 = h2 * h2 * h2 * h2 * h_splat;
  const float poly6 = 315.0f / (64.0f * fe::kPi * maxf(h9, 1e-12f));
  const float m_poly = maxf(particle_mass, 1e-8f) * poly6;

  const int32_t rx = static_cast<int32_t>(fe::ceilf(h_splat * inv_dx));
  const int32_t ry = static_cast<int32_t>(fe::ceilf(h_splat * inv_dy));
  const int32_t rz = static_cast<int32_t>(fe::ceilf(h_splat * inv_dz));

  auto id_at = [&](uint32_t x, uint32_t y, uint32_t z) -> uint32_t {
    return x + wx * (y + wy * z);
  };

  /* Track narrow-band active AABB so filter & marching skip empty air above the liquid! */
  int32_t band_x0 = static_cast<int32_t>(nx), band_y0 = static_cast<int32_t>(ny), band_z0 = static_cast<int32_t>(nz);
  int32_t band_x1 = 0, band_y1 = 0, band_z1 = 0;

  /* 1. Narrow-band isotropic + velocity-anisotropic scalar splatting */
  for (uint32_t i = 0u; i < particle_count; ++i) {
    if (!active[i]) continue;
    const uint32_t b = i * 3u;
    const float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
    if (!isfinitef(px + py + pz)) continue;

    float vx = 0.0f, vy = 0.0f, vz = 0.0f, speed = 0.0f;
    if (velocities) {
      vx = velocities[b]; vy = velocities[b + 1u]; vz = velocities[b + 2u];
      speed = sqrtf(vx * vx + vy * vy + vz * vz);
    }
    const float p_foam = foam_energy ? clampf(foam_energy[i], 0.0f, 1.0f) : clampf((speed - 1.8f) * 0.25f, 0.0f, 1.0f);

    const int32_t gx = static_cast<int32_t>(floorf((px - low_x) * inv_dx));
    const int32_t gy = static_cast<int32_t>(floorf((py - low_y) * inv_dy));
    const int32_t gz = static_cast<int32_t>(floorf((pz - low_z) * inv_dz));

    const int32_t x0 = gx - rx < 0 ? 0 : (gx - rx);
    const int32_t x1 = gx + rx > static_cast<int32_t>(nx) ? static_cast<int32_t>(nx) : (gx + rx);
    const int32_t y0 = gy - ry < 0 ? 0 : (gy - ry);
    const int32_t y1 = gy + ry > static_cast<int32_t>(ny) ? static_cast<int32_t>(ny) : (gy + ry);
    const int32_t z0 = gz - rz < 0 ? 0 : (gz - rz);
    const int32_t z1 = gz + rz > static_cast<int32_t>(nz) ? static_cast<int32_t>(nz) : (gz + rz);

    if (x0 > x1 || y0 > y1 || z0 > z1) continue;
    if (x0 < band_x0) band_x0 = x0;
    if (x1 > band_x1) band_x1 = x1;
    if (y0 < band_y0) band_y0 = y0;
    if (y1 > band_y1) band_y1 = y1;
    if (z0 < band_z0) band_z0 = z0;
    if (z1 > band_z1) band_z1 = z1;

    const bool aniso = (speed > 0.8f);
    const float inv_sp = aniso ? (1.0f / speed) : 0.0f;
    const float inv_stretch2 = aniso ? (1.0f / (clampf(1.0f + speed * 0.07f, 1.0f, 1.45f) * clampf(1.0f + speed * 0.07f, 1.0f, 1.45f))) : 1.0f;

    for (int32_t iz = z0; iz <= z1; ++iz) {
      const float oz = (low_z + static_cast<float>(iz) * dz) - pz;
      const float oz2 = oz * oz;
      for (int32_t iy = y0; iy <= y1; ++iy) {
        const float oy = (low_y + static_cast<float>(iy) * dy) - py;
        const float oyz2 = oy * oy + oz2;
        if (oyz2 >= h2 * 1.35f) continue;
        uint32_t row = id_at(static_cast<uint32_t>(x0), static_cast<uint32_t>(iy), static_cast<uint32_t>(iz));
        for (int32_t ix = x0; ix <= x1; ++ix, ++row) {
          const float ox = (low_x + static_cast<float>(ix) * dx) - px;
          float eff_r2 = ox * ox + oyz2;
          if (aniso && eff_r2 < h2 * 1.35f) {
            const float proj = (ox * vx + oy * vy + oz * vz) * inv_sp;
            eff_r2 = (eff_r2 - proj * proj) + proj * proj * inv_stretch2;
          }
          const float q = h2 - eff_r2;
          if (q > 0.0f) {
            const float w = m_poly * q * q * q;
            g_field_a[row]     += w;
            g_field_foam[row]  += w * p_foam;
            g_field_speed[row] += w * speed;
          }
        }
      }
    }
  }

  if (band_x0 > band_x1 || band_y0 > band_y1 || band_z0 > band_z1) return 0;
  const uint32_t bx0 = band_x0 > 1 ? static_cast<uint32_t>(band_x0 - 1) : 0u;
  const uint32_t bx1 = static_cast<uint32_t>(band_x1 + 1) < nx ? static_cast<uint32_t>(band_x1 + 1) : nx;
  const uint32_t by0 = band_y0 > 1 ? static_cast<uint32_t>(band_y0 - 1) : 0u;
  const uint32_t by1 = static_cast<uint32_t>(band_y1 + 1) < ny ? static_cast<uint32_t>(band_y1 + 1) : ny;
  const uint32_t bz0 = band_z0 > 1 ? static_cast<uint32_t>(band_z0 - 1) : 0u;
  const uint32_t bz1 = static_cast<uint32_t>(band_z1 + 1) < nz ? static_cast<uint32_t>(band_z1 + 1) : nz;

  /* Normalize weighted foam & speed fields inside active band */
  for (uint32_t z = bz0; z <= bz1; ++z) {
    for (uint32_t y = by0; y <= by1; ++y) {
      uint32_t row = id_at(bx0, y, z);
      for (uint32_t x = bx0; x <= bx1; ++x, ++row) {
        if (g_field_a[row] > 1e-8f) {
          const float inv_w = 1.0f / g_field_a[row];
          g_field_foam[row]  *= inv_w;
          g_field_speed[row] *= inv_w;
        }
        g_field_b[row] = 0.0f;
      }
    }
  }

  /* 2. Separable 3D [1, 2, 1]/4 Binomial SDF Filter inside narrow-band AABB! */
  /* Pass X: g_field_a -> g_field_b */
  for (uint32_t z = bz0; z <= bz1; ++z) {
    for (uint32_t y = by0; y <= by1; ++y) {
      const uint32_t row = id_at(0u, y, z);
      for (uint32_t x = bx0; x <= bx1; ++x) {
        const float left  = x > 0u  ? g_field_a[row + x - 1u] : g_field_a[row + x];
        const float right = x < nx  ? g_field_a[row + x + 1u] : g_field_a[row + x];
        g_field_b[row + x] = 0.25f * left + 0.5f * g_field_a[row + x] + 0.25f * right;
      }
    }
  }
  /* Pass Y: g_field_b -> g_field_a */
  for (uint32_t z = bz0; z <= bz1; ++z) {
    for (uint32_t x = bx0; x <= bx1; ++x) {
      for (uint32_t y = by0; y <= by1; ++y) {
        const float down = y > 0u ? g_field_b[id_at(x, y - 1u, z)] : g_field_b[id_at(x, y, z)];
        const float up   = y < ny ? g_field_b[id_at(x, y + 1u, z)] : g_field_b[id_at(x, y, z)];
        g_field_a[id_at(x, y, z)] = 0.25f * down + 0.5f * g_field_b[id_at(x, y, z)] + 0.25f * up;
      }
    }
  }
  /* Pass Z: g_field_a -> g_field_b (final filtered scalar field in g_field_b!) */
  for (uint32_t y = by0; y <= by1; ++y) {
    for (uint32_t x = bx0; x <= bx1; ++x) {
      for (uint32_t z = bz0; z <= bz1; ++z) {
        const float back  = z > 0u ? g_field_a[id_at(x, y, z - 1u)] : g_field_a[id_at(x, y, z)];
        const float front = z < nz ? g_field_a[id_at(x, y, z + 1u)] : g_field_a[id_at(x, y, z)];
        g_field_b[id_at(x, y, z)] = 0.25f * back + 0.5f * g_field_a[id_at(x, y, z)] + 0.25f * front;
      }
    }
  }

  /* 3. Crack-Free Watertight Kuhn 6-Tetrahedra Isosurface Extraction with O(1) Edge Cache */
  ++g_current_edge_stamp;
  if (g_current_edge_stamp == 0u) {
    for (uint32_t k = 0u; k < kEdgeCacheCap; ++k) g_edge_stamp[k] = 0u;
    g_current_edge_stamp = 1u;
  }

  const float iso = clampf(iso_level, 0.08f, 1.5f);
  uint32_t vert_count = 0u;
  uint32_t idx_count  = 0u;
  const uint32_t vert_cap = minf(max_vertices, kMaxMeshVerts);

  auto node_xyz = [&](uint32_t id) -> Vec3 {
    const uint32_t x = id % wx;
    const uint32_t q = id / wx;
    const uint32_t y = q % wy;
    const uint32_t z = q / wy;
    return {
      low_x + static_cast<float>(x) * dx,
      low_y + static_cast<float>(y) * dy,
      low_z + static_cast<float>(z) * dz
    };
  };

  auto get_or_create_edge_vertex = [&](uint32_t n0, uint32_t n1) -> int32_t {
    const uint32_t lo = n0 < n1 ? n0 : n1;
    const uint32_t hi = n0 < n1 ? n1 : n0;
    uint32_t slot = ((lo * 2654435761u) ^ (hi * 2246822519u)) & (kEdgeCacheCap - 1u);
    for (uint32_t probe = 0u; probe < 64u; ++probe) {
      if (g_edge_stamp[slot] != g_current_edge_stamp) {
        if (vert_count >= vert_cap) return -1;
        const float va = g_field_b[lo], vb = g_field_b[hi];
        const float denom = vb - va;
        const float t = absf(denom) > 1e-12f ? clampf((iso - va) / denom, 0.0f, 1.0f) : 0.5f;
        const Vec3 pa = node_xyz(lo);
        const Vec3 pb = node_xyz(hi);
        const Vec3 p  = pa + (pb - pa) * t;

        const uint32_t vi = vert_count++;
        out_positions[vi * 3u]     = p.x;
        out_positions[vi * 3u + 1u] = p.y;
        out_positions[vi * 3u + 2u] = p.z;
        if (out_foam_attr) {
          out_foam_attr[vi * 2u]      = lerpf(g_field_foam[lo],  g_field_foam[hi],  t);
          out_foam_attr[vi * 2u + 1u] = lerpf(g_field_speed[lo], g_field_speed[hi], t);
        }

        g_edge_stamp[slot] = g_current_edge_stamp;
        g_edge_lo[slot]    = lo;
        g_edge_hi[slot]    = hi;
        g_edge_vert[slot]  = vi;
        return static_cast<int32_t>(vi);
      }
      if (g_edge_lo[slot] == lo && g_edge_hi[slot] == hi) {
        return static_cast<int32_t>(g_edge_vert[slot]);
      }
      slot = (slot + 1u) & (kEdgeCacheCap - 1u);
    }
    return -1;
  };

  auto emit_tri = [&](int32_t a, int32_t b, int32_t c, const Vec3& outward) {
    if (a < 0 || b < 0 || c < 0 || a == b || b == c || c == a) return;
    if (idx_count + 3u > max_indices) return;
    const Vec3 pa{out_positions[a * 3], out_positions[a * 3 + 1], out_positions[a * 3 + 2]};
    const Vec3 pb{out_positions[b * 3], out_positions[b * 3 + 1], out_positions[b * 3 + 2]};
    const Vec3 pc{out_positions[c * 3], out_positions[c * 3 + 1], out_positions[c * 3 + 2]};
    const Vec3 n = Vec3::cross(pb - pa, pc - pa);
    if (n.length_sq() < 1e-18f) return;
    if (Vec3::dot(n, outward) < 0.0f) {
      out_indices[idx_count++] = static_cast<uint32_t>(a);
      out_indices[idx_count++] = static_cast<uint32_t>(c);
      out_indices[idx_count++] = static_cast<uint32_t>(b);
    } else {
      out_indices[idx_count++] = static_cast<uint32_t>(a);
      out_indices[idx_count++] = static_cast<uint32_t>(b);
      out_indices[idx_count++] = static_cast<uint32_t>(c);
    }
  };

  constexpr uint8_t kTetCorners[6][4] = {
    {0, 5, 1, 6}, {0, 1, 2, 6}, {0, 2, 3, 6},
    {0, 3, 7, 6}, {0, 7, 4, 6}, {0, 4, 5, 6}
  };

  const uint32_t march_x1 = bx1 < nx ? bx1 : nx;
  const uint32_t march_y1 = by1 < ny ? by1 : ny;
  const uint32_t march_z1 = bz1 < nz ? bz1 : nz;

  for (uint32_t z = bz0; z < march_z1; ++z) {
    for (uint32_t y = by0; y < march_y1; ++y) {
      for (uint32_t x = bx0; x < march_x1; ++x) {
        const uint32_t c[8] = {
          id_at(x,     y,     z),
          id_at(x + 1, y,     z),
          id_at(x + 1, y + 1, z),
          id_at(x,     y + 1, z),
          id_at(x,     y,     z + 1),
          id_at(x + 1, y,     z + 1),
          id_at(x + 1, y + 1, z + 1),
          id_at(x,     y + 1, z + 1)
        };
        float c_min = g_field_b[c[0]], c_max = c_min;
        for (int k = 1; k < 8; ++k) {
          const float v = g_field_b[c[k]];
          if (v < c_min) c_min = v;
          if (v > c_max) c_max = v;
        }
        if (c_min >= iso || c_max < iso) continue;

        for (int t = 0; t < 6; ++t) {
          uint32_t inside[4], outside[4];
          uint32_t in_cnt = 0u, out_cnt = 0u;
          for (int k = 0; k < 4; ++k) {
            const uint32_t nid = c[kTetCorners[t][k]];
            if (g_field_b[nid] >= iso) inside[in_cnt++] = nid;
            else outside[out_cnt++] = nid;
          }
          if (in_cnt == 0u || out_cnt == 0u) continue;

          Vec3 in_c{0.0f}, out_c{0.0f};
          for (uint32_t k = 0u; k < in_cnt; ++k)  in_c  = in_c  + node_xyz(inside[k]);
          for (uint32_t k = 0u; k < out_cnt; ++k) out_c = out_c + node_xyz(outside[k]);
          in_c  = in_c  * (1.0f / static_cast<float>(in_cnt));
          out_c = out_c * (1.0f / static_cast<float>(out_cnt));
          const Vec3 outward = out_c - in_c;

          if (in_cnt == 1u) {
            emit_tri(
              get_or_create_edge_vertex(inside[0], outside[0]),
              get_or_create_edge_vertex(inside[0], outside[1]),
              get_or_create_edge_vertex(inside[0], outside[2]),
              outward
            );
          } else if (in_cnt == 3u) {
            emit_tri(
              get_or_create_edge_vertex(outside[0], inside[0]),
              get_or_create_edge_vertex(outside[0], inside[1]),
              get_or_create_edge_vertex(outside[0], inside[2]),
              outward
            );
          } else {
            const int32_t p0 = get_or_create_edge_vertex(inside[0], outside[0]);
            const int32_t p1 = get_or_create_edge_vertex(inside[0], outside[1]);
            const int32_t p2 = get_or_create_edge_vertex(inside[1], outside[1]);
            const int32_t p3 = get_or_create_edge_vertex(inside[1], outside[0]);
            emit_tri(p0, p1, p2, outward);
            emit_tri(p0, p2, p3, outward);
          }
        }
      }
    }
  }

  if (vert_count < 3u || idx_count < 3u) {
    out_counts_2[0] = 0u;
    out_counts_2[1] = 0u;
    return 0;
  }

  /* 4. Volume-Preserving Taubin (lambda = +0.45, mu = -0.473) Surface Mesh Relaxation */
  const uint32_t relax_passes = smooth_iterations > 4u ? 4u : smooth_iterations;
  auto laplacian_step = [&](float weight) {
    for (uint32_t v = 0u; v < vert_count; ++v) {
      g_taubin_sum[v * 3u]     = 0.0f;
      g_taubin_sum[v * 3u + 1u] = 0.0f;
      g_taubin_sum[v * 3u + 2u] = 0.0f;
      g_taubin_deg[v] = 0u;
    }
    for (uint32_t i = 0u; i + 2u < idx_count; i += 3u) {
      const uint32_t tri[3] = {out_indices[i], out_indices[i + 1u], out_indices[i + 2u]};
      for (int k = 0; k < 3; ++k) {
        const uint32_t u = tri[k];
        const uint32_t w1 = tri[(k + 1) % 3];
        const uint32_t w2 = tri[(k + 2) % 3];
        g_taubin_sum[u * 3u]     += out_positions[w1 * 3u]     + out_positions[w2 * 3u];
        g_taubin_sum[u * 3u + 1u] += out_positions[w1 * 3u + 1u] + out_positions[w2 * 3u + 1u];
        g_taubin_sum[u * 3u + 2u] += out_positions[w1 * 3u + 2u] + out_positions[w2 * 3u + 2u];
        g_taubin_deg[u] = static_cast<uint16_t>(g_taubin_deg[u] + 2u);
      }
    }
    for (uint32_t v = 0u; v < vert_count; ++v) {
      if (g_taubin_deg[v] == 0u) continue;
      const float inv_d = 1.0f / static_cast<float>(g_taubin_deg[v]);
      const uint32_t b = v * 3u;
      const float avg_x = g_taubin_sum[b]      * inv_d;
      const float avg_y = g_taubin_sum[b + 1u] * inv_d;
      const float avg_z = g_taubin_sum[b + 2u] * inv_d;
      out_positions[b]      += (avg_x - out_positions[b])      * weight;
      out_positions[b + 1u] += (avg_y - out_positions[b + 1u]) * weight;
      out_positions[b + 2u] += (avg_z - out_positions[b + 2u]) * weight;
    }
  };

  for (uint32_t p = 0u; p < relax_passes; ++p) {
    laplacian_step(0.45f);
    laplacian_step(-0.473f);
  }

  /* 5. Analytic Trilinear SDF Gradient + Area-Weighted Hybrid Smooth Normals + Crest Curvature Foam */
  for (uint32_t v = 0u; v < vert_count * 3u; ++v) out_normals[v] = 0.0f;

  for (uint32_t i = 0u; i + 2u < idx_count; i += 3u) {
    const uint32_t a = out_indices[i], b = out_indices[i + 1u], c = out_indices[i + 2u];
    const Vec3 pa{out_positions[a * 3u], out_positions[a * 3u + 1u], out_positions[a * 3u + 2u]};
    const Vec3 pb{out_positions[b * 3u], out_positions[b * 3u + 1u], out_positions[b * 3u + 2u]};
    const Vec3 pc{out_positions[c * 3u], out_positions[c * 3u + 1u], out_positions[c * 3u + 2u]};
    const Vec3 fn = Vec3::cross(pb - pa, pc - pa);
    const uint32_t vs[3] = {a, b, c};
    for (int k = 0; k < 3; ++k) {
      out_normals[vs[k] * 3u]     += fn.x;
      out_normals[vs[k] * 3u + 1u] += fn.y;
      out_normals[vs[k] * 3u + 2u] += fn.z;
    }
  }

  auto sample_sdf = [&](float wx_p, float wy_p, float wz_p) -> float {
    const float fx = clampf((wx_p - low_x) * inv_dx, 0.0f, static_cast<float>(nx) - 1e-4f);
    const float fy = clampf((wy_p - low_y) * inv_dy, 0.0f, static_cast<float>(ny) - 1e-4f);
    const float fz = clampf((wz_p - low_z) * inv_dz, 0.0f, static_cast<float>(nz) - 1e-4f);
    const uint32_t x0 = static_cast<uint32_t>(fx), y0 = static_cast<uint32_t>(fy), z0 = static_cast<uint32_t>(fz);
    const float tx = fx - static_cast<float>(x0), ty = fy - static_cast<float>(y0), tz = fz - static_cast<float>(z0);
    const float c00 = lerpf(g_field_b[id_at(x0, y0, z0)],     g_field_b[id_at(x0 + 1, y0, z0)],     tx);
    const float c10 = lerpf(g_field_b[id_at(x0, y0 + 1, z0)], g_field_b[id_at(x0 + 1, y0 + 1, z0)], tx);
    const float c01 = lerpf(g_field_b[id_at(x0, y0, z0 + 1)],     g_field_b[id_at(x0 + 1, y0, z0 + 1)],     tx);
    const float c11 = lerpf(g_field_b[id_at(x0, y0 + 1, z0 + 1)], g_field_b[id_at(x0 + 1, y0 + 1, z0 + 1)], tx);
    return lerpf(lerpf(c00, c10, ty), lerpf(c01, c11, ty), tz);
  };

  for (uint32_t v = 0u; v < vert_count; ++v) {
    const uint32_t b = v * 3u;
    const float px = out_positions[b], py = out_positions[b + 1u], pz = out_positions[b + 2u];
    Vec3 mesh_n{out_normals[b], out_normals[b + 1u], out_normals[b + 2u]};
    mesh_n = mesh_n.normalized();

    /* Analytic negative SDF gradient (points outward from dense liquid) */
    Vec3 sdf_n{
      -(sample_sdf(px + dx * 0.6f, py, pz) - sample_sdf(px - dx * 0.6f, py, pz)) * inv_dx,
      -(sample_sdf(px, py + dy * 0.6f, pz) - sample_sdf(px, py - dy * 0.6f, pz)) * inv_dy,
      -(sample_sdf(px, py, pz + dz * 0.6f) - sample_sdf(px, py, pz - dz * 0.6f)) * inv_dz
    };
    const float sl = sdf_n.length();
    Vec3 final_n = (sl > 1e-6f) ? (sdf_n * (0.65f / sl) + mesh_n * 0.35f).normalized() : mesh_n;
    if (final_n.length_sq() < 1e-8f) final_n = {0.0f, 1.0f, 0.0f};

    out_normals[b]      = final_n.x;
    out_normals[b + 1u] = final_n.y;
    out_normals[b + 2u] = final_n.z;
  }

  out_counts_2[0] = vert_count;
  out_counts_2[1] = idx_count;
  return 1;
}

/* =========================================================================
 * 4. EmberGen / LiquiGen-Style C++20 Curl-Noise Vorticity Pyro Solver
 * ========================================================================= */
FE_EXPORT int32_t fe_sim_pyro_step(
  float* positions,
  float* velocities,
  float* temperatures,
  float* ages,
  uint8_t* active,
  uint32_t particle_count,
  float dt,
  float time_sec,
  float gravity,
  float buoyancy,
  float vorticity_turbulence,
  float drag,
  float heat_decay,
  float expansion_swirl,
  float max_age,
  const float* bounds_6,
  float restitution
) {
  if (!positions || !velocities || !temperatures || !ages || !bounds_6) return -1;
  if (particle_count == 0u) return -2;
  if (!isfinitef(dt) || dt <= 0.0f) return 0;

  const float h_dt = clampf(dt, 1e-5f, 1.0f / 20.0f);
  const float vel_keep = expf(-clampf(drag, 0.0f, 8.0f) * h_dt);
  const float cool_keep = expf(-clampf(heat_decay, 0.0f, 5.0f) * h_dt);
  const float turb = clampf(vorticity_turbulence, 0.0f, 3.0f);
  const float swirl = clampf(expansion_swirl, 0.0f, 3.0f);
  const float bounce = clampf(restitution, 0.0f, 1.0f);
  const float life_cap = maxf(max_age, 0.25f);

  const float cx = 0.5f * (bounds_6[0] + bounds_6[3]);
  const float cz = 0.5f * (bounds_6[2] + bounds_6[5]);

  for (uint32_t i = 0u; i < particle_count; ++i) {
    if (active && !active[i]) continue;
    ages[i] += h_dt;
    if (ages[i] >= life_cap) continue;

    const uint32_t b = i * 3u;
    float px = positions[b], py = positions[b + 1u], pz = positions[b + 2u];
    float vx = velocities[b], vy = velocities[b + 1u], vz = velocities[b + 2u];
    float temp = maxf(temperatures[i], 0.0f);

    /* Thermal buoyancy lift + gravitational settling of cold soot */
    const float thermal_acc = buoyancy * gravity * (0.35f + 1.45f * temp) - gravity * 0.14f * clampf(1.0f - temp, 0.0f, 1.0f);
    vy += thermal_acc * h_dt;

    /* Multi-octave divergence-free 3D curl noise plume turbulence */
    if (turb > 1e-4f) {
      const Vec3 c1 = curl_noise3(px * 1.15f, py * 0.95f - time_sec * 0.8f, pz * 1.15f, time_sec);
      const Vec3 c2 = curl_noise3(px * 2.65f + 19.0f, py * 2.4f - time_sec * 1.5f, pz * 2.65f, time_sec * 1.7f);
      const float age_ramp = clampf(ages[i] * 1.4f, 0.2f, 1.6f);
      const Vec3 vort = (c1 * 0.72f + c2 * 0.28f) * (turb * (1.8f + temp * 1.4f) * age_ramp);
      vx += vort.x * h_dt;
      vy += vort.y * 0.55f * h_dt;
      vz += vort.z * h_dt;
    }

    /* Rising mushroom-cap radial expansion & helical Karman vortex swirl */
    if (swirl > 1e-4f) {
      const float rx = px - cx, rz = pz - cz;
      const float r_xz = sqrtf(rx * rx + rz * rz);
      if (r_xz > 1e-4f) {
        const float age_norm = clampf(ages[i] / life_cap, 0.0f, 1.0f);
        const float expand = (age_norm > 0.35f ? 0.55f : -0.22f) * swirl;
        const float tangent = 0.42f * swirl * (0.4f + temp * 0.6f);
        vx += ((rx / r_xz) * expand - (rz / r_xz) * tangent) * h_dt;
        vz += ((rz / r_xz) * expand + (rx / r_xz) * tangent) * h_dt;
      }
    }

    vx *= vel_keep; vy *= vel_keep; vz *= vel_keep;
    px += vx * h_dt; py += vy * h_dt; pz += vz * h_dt;

    if (px < bounds_6[0])      { px = bounds_6[0]; vx = absf(vx) * bounce; }
    else if (px > bounds_6[3]) { px = bounds_6[3]; vx = -absf(vx) * bounce; }
    if (py < bounds_6[1])      { py = bounds_6[1]; vy = absf(vy) * bounce; }
    else if (py > bounds_6[4]) { py = bounds_6[4]; vy = -absf(vy) * bounce; }
    if (pz < bounds_6[2])      { pz = bounds_6[2]; vz = absf(vz) * bounce; }
    else if (pz > bounds_6[5]) { pz = bounds_6[5]; vz = -absf(vz) * bounce; }

    positions[b] = px; positions[b + 1u] = py; positions[b + 2u] = pz;
    velocities[b] = vx; velocities[b + 1u] = vy; velocities[b + 2u] = vz;
    temperatures[i] = temp * cool_keep;
  }

  return 1;
}

/* Backwards-compatible ABI v2 buoyant tracer step routed into C++20 Pyro Solver */
FE_EXPORT int32_t sim_solver_buoyant_tracer_step(
  float* positions,
  float* velocities,
  float* temperatures,
  float* ages,
  uint32_t particle_count,
  float dt,
  float gravity,
  float buoyancy,
  float drag,
  float heat_decay,
  float max_age,
  const float* bounds_6,
  float restitution
) {
  static float s_accum_time = 0.0f;
  s_accum_time += clampf(dt, 0.0f, 0.05f);
  return fe_sim_pyro_step(
    positions, velocities, temperatures, ages, nullptr,
    particle_count, dt, s_accum_time,
    gravity, buoyancy, 0.45f, drag, heat_decay, 0.35f, max_age, bounds_6, restitution
  );
}

} // extern "C"
