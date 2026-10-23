#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

namespace {

constexpr uint32_t kMaxSmoothVerts = 32768;
static float g_smooth_scratch[kMaxSmoothVerts * 3];

/* ---- Mobile Multi-Touch Gesture State ---- */
struct TouchTracker {
  uint32_t prev_count;
  float    prev_p0x, prev_p0y;
  float    prev_p1x, prev_p1y;
  float    prev_dist;
  float    prev_angle;
  float    vel_orbit_x, vel_orbit_y;
  float    vel_pan_x, vel_pan_y;
};

static TouchTracker g_touch = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

/* ---- Adaptive GPU Performance Governor State ---- */
static float    g_ema_frame_ms = 16.6f;
static uint32_t g_frame_samples = 0;

static float brush_falloff(float dist_sq, float radius_sq) {
  if (dist_sq >= radius_sq || radius_sq <= 1e-8f) return 0.0f;
  const float t = 1.0f - fe::sqrtf(dist_sq / radius_sq);
  /* Smooth quartic ZBrush-style clay falloff */
  return t * t * (3.0f - 2.0f * t);
}

static uint32_t apply_single_sculpt_dab(
  float* pos,
  const float* nrm,
  uint32_t vcount,
  uint32_t brush_mode,
  const fe::Vec3& center,
  const fe::Vec3& hit_n,
  const fe::Vec3& grab_delta,
  float radius,
  float strength
) {
  const float r2 = radius * radius;
  uint32_t affected = 0;

  /* Pre-compute local neighborhood average position & plane for Smooth / Flatten */
  fe::Vec3 avg_pos(0.0f);
  float weight_sum = 0.0f;
  if (brush_mode == FE_BRUSH_SMOOTH || brush_mode == FE_BRUSH_FLATTEN) {
    for (uint32_t i = 0; i < vcount; ++i) {
      const fe::Vec3 p(pos[i * 3 + 0], pos[i * 3 + 1], pos[i * 3 + 2]);
      const float d2 = fe::length_sq(p - center);
      if (d2 < r2) {
        const float w = brush_falloff(d2, r2);
        avg_pos += p * w;
        weight_sum += w;
      }
    }
    if (weight_sum > 1e-6f) avg_pos *= (1.0f / weight_sum);
    else avg_pos = center;
  }

  /* Snapshot original positions if Smooth brush */
  const uint32_t snap_n = vcount < kMaxSmoothVerts ? vcount : kMaxSmoothVerts;
  if (brush_mode == FE_BRUSH_SMOOTH) {
    for (uint32_t i = 0; i < snap_n * 3; ++i) g_smooth_scratch[i] = pos[i];
  }

  for (uint32_t i = 0; i < vcount; ++i) {
    const fe::Vec3 p(pos[i * 3 + 0], pos[i * 3 + 1], pos[i * 3 + 2]);
    const float d2 = fe::length_sq(p - center);
    if (d2 >= r2) continue;

    const float w = brush_falloff(d2, r2);
    fe::Vec3 disp(0.0f);

    switch (brush_mode) {
      case FE_BRUSH_DRAW: {
        disp = hit_n * (strength * radius * 0.28f * w);
        break;
      }
      case FE_BRUSH_INFLATE: {
        fe::Vec3 vn = hit_n;
        if (nrm) {
          vn = fe::normalize({nrm[i * 3 + 0], nrm[i * 3 + 1], nrm[i * 3 + 2]});
        }
        disp = vn * (strength * radius * 0.26f * w);
        break;
      }
      case FE_BRUSH_PINCH: {
        disp = (center - p) * (fe::clampf(strength * 0.45f, -0.8f, 0.8f) * w);
        break;
      }
      case FE_BRUSH_FLATTEN: {
        const float plane_dist = fe::dot(p - avg_pos, hit_n);
        disp = -hit_n * (plane_dist * fe::clampf(strength * 0.65f, 0.0f, 1.0f) * w);
        break;
      }
      case FE_BRUSH_GRAB: {
        disp = grab_delta * (fe::clampf(fe::absf(strength), 0.05f, 2.0f) * w);
        break;
      }
      case FE_BRUSH_SMOOTH:
      default: {
        /* Local spatial Gaussian/umbrella relaxation toward weighted neighborhood */
        fe::Vec3 local_sum(0.0f);
        float local_w = 0.0f;
        const float sr2 = (radius * 0.45f) * (radius * 0.45f) + 1e-5f;
        if (vcount <= 2048) {
          for (uint32_t j = 0; j < snap_n; ++j) {
            const fe::Vec3 q(g_smooth_scratch[j * 3 + 0], g_smooth_scratch[j * 3 + 1], g_smooth_scratch[j * 3 + 2]);
            const float qd2 = fe::length_sq(q - p);
            if (qd2 < sr2) {
              const float kw = 1.0f - qd2 / sr2;
              local_sum += q * kw;
              local_w += kw;
            }
          }
        }
        const fe::Vec3 target = (local_w > 1e-5f) ? (local_sum * (1.0f / local_w)) : avg_pos;
        disp = (target - p) * (fe::clampf(fe::absf(strength) * 0.55f, 0.0f, 0.95f) * w);
        break;
      }
    }

    pos[i * 3 + 0] = p.x + disp.x;
    pos[i * 3 + 1] = p.y + disp.y;
    pos[i * 3 + 2] = p.z + disp.z;
    ++affected;
  }

  return affected;
}

} // namespace

extern "C" {

FE_EXPORT uint32_t fe_sculpt_apply_brush(
  float* positions_xyz,
  float* normals_xyz,
  uint32_t vertex_count,
  uint32_t brush_mode,
  float hit_x, float hit_y, float hit_z,
  float normal_x, float normal_y, float normal_z,
  float delta_x, float delta_y, float delta_z,
  float radius,
  float strength,
  uint32_t symmetry_mask
) {
  if (!positions_xyz || vertex_count == 0 || radius <= 1e-5f) return 0;
  const fe::Vec3 hit_p(hit_x, hit_y, hit_z);
  const fe::Vec3 hit_n = fe::normalize({normal_x, normal_y, normal_z});
  const fe::Vec3 grab_d(delta_x, delta_y, delta_z);

  uint32_t total = apply_single_sculpt_dab(
    positions_xyz, normals_xyz, vertex_count, brush_mode, hit_p, hit_n, grab_d, radius, strength
  );

  /* Optional X / Y / Z mirror symmetry passes */
  if ((symmetry_mask & 1u) && fe::absf(hit_x) > 1e-4f) {
    total += apply_single_sculpt_dab(
      positions_xyz, normals_xyz, vertex_count, brush_mode,
      {-hit_p.x, hit_p.y, hit_p.z},
      {-hit_n.x, hit_n.y, hit_n.z},
      {-grab_d.x, grab_d.y, grab_d.z},
      radius, strength
    );
  }
  if ((symmetry_mask & 2u) && fe::absf(hit_y) > 1e-4f) {
    total += apply_single_sculpt_dab(
      positions_xyz, normals_xyz, vertex_count, brush_mode,
      {hit_p.x, -hit_p.y, hit_p.z},
      {hit_n.x, -hit_n.y, hit_n.z},
      {grab_d.x, -grab_d.y, grab_d.z},
      radius, strength
    );
  }
  if ((symmetry_mask & 4u) && fe::absf(hit_z) > 1e-4f) {
    total += apply_single_sculpt_dab(
      positions_xyz, normals_xyz, vertex_count, brush_mode,
      {hit_p.x, hit_p.y, -hit_p.z},
      {hit_n.x, hit_n.y, -hit_n.z},
      {grab_d.x, grab_d.y, -grab_d.z},
      radius, strength
    );
  }

  return total;
}

FE_EXPORT void fe_mesh_recompute_vertex_normals(
  const float* positions_xyz,
  const uint32_t* indices,
  uint32_t vertex_count,
  uint32_t tri_count,
  float* out_normals_xyz
) {
  if (!positions_xyz || !out_normals_xyz || vertex_count == 0) return;
  for (uint32_t i = 0; i < vertex_count * 3; ++i) out_normals_xyz[i] = 0.0f;

  for (uint32_t t = 0; t < tri_count; ++t) {
    const uint32_t i0 = indices ? indices[t * 3 + 0] : (t * 3 + 0);
    const uint32_t i1 = indices ? indices[t * 3 + 1] : (t * 3 + 1);
    const uint32_t i2 = indices ? indices[t * 3 + 2] : (t * 3 + 2);
    if (i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count) continue;

    const fe::Vec3 v0(positions_xyz[i0 * 3 + 0], positions_xyz[i0 * 3 + 1], positions_xyz[i0 * 3 + 2]);
    const fe::Vec3 v1(positions_xyz[i1 * 3 + 0], positions_xyz[i1 * 3 + 1], positions_xyz[i1 * 3 + 2]);
    const fe::Vec3 v2(positions_xyz[i2 * 3 + 0], positions_xyz[i2 * 3 + 1], positions_xyz[i2 * 3 + 2]);
    const fe::Vec3 fn = fe::cross(v1 - v0, v2 - v0);

    const uint32_t ids[3] = {i0, i1, i2};
    for (int k = 0; k < 3; ++k) {
      out_normals_xyz[ids[k] * 3 + 0] += fn.x;
      out_normals_xyz[ids[k] * 3 + 1] += fn.y;
      out_normals_xyz[ids[k] * 3 + 2] += fn.z;
    }
  }

  for (uint32_t i = 0; i < vertex_count; ++i) {
    const fe::Vec3 n = fe::normalize({
      out_normals_xyz[i * 3 + 0],
      out_normals_xyz[i * 3 + 1],
      out_normals_xyz[i * 3 + 2]
    });
    out_normals_xyz[i * 3 + 0] = n.x;
    out_normals_xyz[i * 3 + 1] = n.y;
    out_normals_xyz[i * 3 + 2] = n.z;
  }
}

FE_EXPORT uint32_t fe_vertex_paint_apply(
  const float* positions_xyz,
  float* colors_rgb,
  uint32_t vertex_count,
  float hit_x, float hit_y, float hit_z,
  float radius,
  float strength,
  float r, float g, float b,
  uint32_t symmetry_mask
) {
  if (!positions_xyz || !colors_rgb || vertex_count == 0 || radius <= 1e-5f) return 0;
  const float r2 = radius * radius;
  const float str = fe::clampf(strength, 0.0f, 1.0f);
  const fe::Vec3 target_col(fe::clampf(r, 0.0f, 1.0f), fe::clampf(g, 0.0f, 1.0f), fe::clampf(b, 0.0f, 1.0f));
  uint32_t painted = 0;

  auto paint_center = [&](const fe::Vec3& c) {
    for (uint32_t i = 0; i < vertex_count; ++i) {
      const fe::Vec3 p(positions_xyz[i * 3 + 0], positions_xyz[i * 3 + 1], positions_xyz[i * 3 + 2]);
      const float d2 = fe::length_sq(p - c);
      if (d2 >= r2) continue;
      const float w = brush_falloff(d2, r2) * str;
      colors_rgb[i * 3 + 0] = fe::lerpf(colors_rgb[i * 3 + 0], target_col.x, w);
      colors_rgb[i * 3 + 1] = fe::lerpf(colors_rgb[i * 3 + 1], target_col.y, w);
      colors_rgb[i * 3 + 2] = fe::lerpf(colors_rgb[i * 3 + 2], target_col.z, w);
      ++painted;
    }
  };

  paint_center({hit_x, hit_y, hit_z});
  if ((symmetry_mask & 1u) && fe::absf(hit_x) > 1e-4f) {
    paint_center({-hit_x, hit_y, hit_z});
  }
  return painted;
}

FE_EXPORT void fe_touch_reset(void) {
  g_touch = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
}

FE_EXPORT int32_t fe_touch_update(
  uint32_t pointer_count,
  float p0_x, float p0_y,
  float p1_x, float p1_y,
  float viewport_w, float viewport_h,
  float dt_sec,
  float* out_8
) {
  if (!out_8) return -1;
  for (int i = 0; i < 8; ++i) out_8[i] = 0.0f;

  const float vw = fe::maxf(1.0f, viewport_w);
  const float vh = fe::maxf(1.0f, viewport_h);
  const float min_dim = fe::minf(vw, vh);
  const float dt = fe::clampf(dt_sec, 1e-4f, 0.25f);
  const float smooth = fe::clampf(dt * 28.0f, 0.15f, 1.0f);

  if (pointer_count == 0) {
    /* Inertia decay when fingers lift */
    g_touch.vel_orbit_x *= 0.85f;
    g_touch.vel_orbit_y *= 0.85f;
    g_touch.vel_pan_x   *= 0.82f;
    g_touch.vel_pan_y   *= 0.82f;
    g_touch.prev_count = 0;
    out_8[0] = g_touch.vel_orbit_x;
    out_8[1] = g_touch.vel_orbit_y;
    out_8[2] = g_touch.vel_pan_x;
    out_8[3] = g_touch.vel_pan_y;
    out_8[6] = 0.0f;
    return 0;
  }

  if (pointer_count == 1) {
    if (g_touch.prev_count == 1) {
      float dx = (p0_x - g_touch.prev_p0x) / min_dim;
      float dy = (p0_y - g_touch.prev_p0y) / min_dim;
      /* Micro-jitter deadzone for capacitive touch screens */
      if (fe::absf(dx) < 0.0006f) dx = 0.0f;
      if (fe::absf(dy) < 0.0006f) dy = 0.0f;
      g_touch.vel_orbit_x = fe::lerpf(g_touch.vel_orbit_x, dx, smooth);
      g_touch.vel_orbit_y = fe::lerpf(g_touch.vel_orbit_y, dy, smooth);
      out_8[0] = g_touch.vel_orbit_x;
      out_8[1] = g_touch.vel_orbit_y;
      out_8[6] = 1.0f; /* 1 = Single-finger orbit */
      out_8[7] = 1.0f;
    }
    g_touch.prev_count = 1;
    g_touch.prev_p0x = p0_x;
    g_touch.prev_p0y = p0_y;
    return 1;
  }

  /* 2+ pointers: Simultaneous Pinch-Zoom + Two-Finger Pan + Twist */
  const float cx = 0.5f * (p0_x + p1_x);
  const float cy = 0.5f * (p0_y + p1_y);
  const float sep_x = p1_x - p0_x;
  const float sep_y = p1_y - p0_y;
  const float dist = fe::maxf(8.0f, fe::sqrtf(sep_x * sep_x + sep_y * sep_y));
  const float angle = fe::atan2f(sep_y, sep_x);

  if (g_touch.prev_count >= 2 && g_touch.prev_dist > 0.0f) {
    const float prev_cx = 0.5f * (g_touch.prev_p0x + g_touch.prev_p1x);
    const float prev_cy = 0.5f * (g_touch.prev_p0y + g_touch.prev_p1y);
    const float pan_dx = (cx - prev_cx) / min_dim;
    const float pan_dy = (cy - prev_cy) / min_dim;
    const float scale_ratio = dist / g_touch.prev_dist;
    float d_ang = angle - g_touch.prev_angle;
    if (d_ang > fe::kPi) d_ang -= fe::kTwoPi;
    if (d_ang < -fe::kPi) d_ang += fe::kTwoPi;

    g_touch.vel_pan_x = fe::lerpf(g_touch.vel_pan_x, pan_dx, smooth);
    g_touch.vel_pan_y = fe::lerpf(g_touch.vel_pan_y, pan_dy, smooth);

    out_8[2] = g_touch.vel_pan_x;
    out_8[3] = g_touch.vel_pan_y;
    out_8[4] = scale_ratio - 1.0f;
    out_8[5] = d_ang;
    out_8[6] = 2.0f; /* 2 = Two-finger dolly/pan/twist */
    out_8[7] = 1.0f;
  }

  g_touch.prev_count = 2;
  g_touch.prev_p0x = p0_x; g_touch.prev_p0y = p0_y;
  g_touch.prev_p1x = p1_x; g_touch.prev_p1y = p1_y;
  g_touch.prev_dist = dist;
  g_touch.prev_angle = angle;
  return 2;
}

FE_EXPORT void fe_perf_reset(void) {
  g_ema_frame_ms = 16.6f;
  g_frame_samples = 0;
}

FE_EXPORT void fe_perf_push_frame_ms(float frame_ms) {
  if (!fe::isfinitef(frame_ms) || frame_ms <= 0.1f || frame_ms > 500.0f) return;
  if (g_frame_samples == 0) {
    g_ema_frame_ms = frame_ms;
  } else {
    g_ema_frame_ms = g_ema_frame_ms * 0.90f + frame_ms * 0.10f;
  }
  ++g_frame_samples;
}

FE_EXPORT uint32_t fe_perf_recommend_tier(uint32_t mode_override) {
  if (mode_override == 1) return 0; /* Forced Low */
  if (mode_override == 2) return 1; /* Forced Medium */
  if (mode_override == 3) return 2; /* Forced High */

  /* Auto Adaptive Governor */
  if (g_ema_frame_ms > 27.5f) return 0; /* < ~36 FPS -> Low / Mobile Battery Saver */
  if (g_ema_frame_ms > 18.8f) return 1; /* < ~53 FPS -> Medium / Balanced Mobile */
  return 2;                             /* >= 53 FPS -> High / Flagship */
}

FE_EXPORT void fe_perf_query_metrics(uint32_t mode_override, float device_dpr, float* out_6) {
  if (!out_6) return;
  const uint32_t tier = fe_perf_recommend_tier(mode_override);
  const float dpr = fe::clampf(device_dpr > 0.5f ? device_dpr : 1.0f, 0.75f, 3.0f);

  float rec_dpr = 1.0f;
  float shadow_res = 1024.0f;
  float substeps = 2.0f;

  if (tier == 0) {
    rec_dpr = fe::minf(dpr, 1.0f) * 0.85f;
    shadow_res = 512.0f;
    substeps = 1.0f;
  } else if (tier == 1) {
    rec_dpr = fe::minf(dpr, 1.35f);
    shadow_res = 1024.0f;
    substeps = 2.0f;
  } else {
    rec_dpr = fe::minf(dpr, 2.0f);
    shadow_res = 2048.0f;
    substeps = 3.0f;
  }

  out_6[0] = g_ema_frame_ms;
  out_6[1] = 1000.0f / fe::maxf(1.0f, g_ema_frame_ms);
  out_6[2] = rec_dpr;
  out_6[3] = shadow_res;
  out_6[4] = substeps;
  out_6[5] = static_cast<float>(tier);
}

} // extern "C"
