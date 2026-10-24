#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

namespace {

constexpr uint32_t kMaxMaterials  = 256;
constexpr uint32_t kMaxTriangles  = 49152;
constexpr uint32_t kMaxBvhNodes   = kMaxTriangles * 2;
constexpr uint32_t kMaxLights     = 4;
constexpr uint32_t kMaxPathPixels = 1280 * 1280; /* Covers 1280x720, 720x1280, 1080x1080 */
constexpr uint32_t kMaxBloomDim   = 320 * 320;

struct MaterialPBR {
  fe::Vec3 albedo;
  float    roughness;
  float    metalness;
  float    emission;
  float    opacity;
};

struct TrianglePrim {
  fe::Vec3 v0, v1, v2;
  fe::Vec3 n0, n1, n2;
  fe::Vec3 centroid;
  uint32_t mat_id;
};

struct BVHNode {
  fe::AABB bounds;
  uint32_t left_or_first;
  uint32_t tri_count; /* 0 = internal node (left=left_or_first, right=left_or_first+1 or stored) */
  uint32_t right_child;
};

struct SceneLight {
  uint32_t type; /* 0=off, 1=point, 2=directional, 3=spot */
  fe::Vec3 pos;
  fe::Vec3 dir;
  fe::Vec3 color;
  float    intensity;
  float    radius;
  float    spot_cos_outer;
  /* Tangent basis for the soft-shadow disk, computed once when the light is
     set instead of twice per shading point. */
  fe::Vec3 tangent;
  fe::Vec3 bitangent;
};

struct CameraState {
  fe::Vec3 eye;
  fe::Vec3 fwd;
  fe::Vec3 right;
  fe::Vec3 up;
  float    tan_half_fov;
  float    aspect;
  float    aperture;
  float    focus_dist;
};

static MaterialPBR  g_materials[kMaxMaterials];
static uint32_t     g_mat_count = 0;

static TrianglePrim g_tris[kMaxTriangles];
static uint32_t     g_tri_indices[kMaxTriangles];
static uint32_t     g_tri_count = 0;

static BVHNode      g_bvh[kMaxBvhNodes];
static uint32_t     g_bvh_used = 0;
static bool         g_bvh_ready = false;

static SceneLight   g_lights[kMaxLights];
static uint32_t     g_env_preset = 0;
static float        g_sky_intensity = 1.0f;
static bool         g_shadow_catcher = true;
static float        g_ground_y = -0.002f;

static CameraState  g_cam = {
  {7.0f, 6.0f, 9.0f},
  {-0.53f, -0.45f, -0.71f},
  {0.80f, 0.0f, -0.59f},
  {-0.27f, 0.89f, -0.36f},
  0.4663f, 16.0f / 9.0f, 0.0f, 8.0f
};

static uint32_t     g_fb_w = 0;
static uint32_t     g_fb_h = 0;
static uint32_t     g_accum_samples = 0;
static float        g_accum_rgb[kMaxPathPixels * 3];
static uint8_t      g_resolved_rgba[kMaxPathPixels * 4];

/* Per-pixel sample counts. A cube is mostly flat surfaces and sky: after two
   samples the sky has converged and every extra sample spent on it is waste
   that the picture never shows. These make the tracer spend its budget on the
   pixels that are actually still moving — the shadows and the edges. */
static uint16_t     g_pixel_samples[kMaxPathPixels];
static uint16_t     g_pixel_cap[kMaxPathPixels];

/* Primary-hit distance, quantised to 16 bits over 0..64 m. The denoiser needs
   it to tell a cube edge from noise on the same surface, and 3 MB of uint16 is
   cheap next to a float buffer. 0xFFFF means "sky". */
static uint16_t     g_depth16[kMaxPathPixels];
constexpr uint16_t  kDepthFar = 0xFFFFu;
constexpr float     kDepthScale = 1023.0f;   /* 64 m / 0xFFFF-ish */

/* Primary-hit albedo, 8 bits per channel. A colour-weighted filter cannot tell
   a painted line from noise on its own — both are sharp luminance steps — so
   the filter is told which steps are geometry and which are material. This is
   the same trick production denoisers use when they are handed albedo and
   normal passes; 5 MB buys the whole floor grid back. */
static uint8_t      g_albedo8[kMaxPathPixels * 3];

/* Lights that are actually on. Iterating four slots and skipping the empty
   ones is cheap per sample and was not cheap per bounce. */
static uint32_t     g_active_lights[kMaxLights];
static uint32_t     g_active_light_count = 0;
static float        g_bloom_a[kMaxBloomDim * 3];
static float        g_bloom_b[kMaxBloomDim * 3];

/* ---- Analytical Procedural HDRI Environment Sampler ---- */
static fe::Vec3 sample_environment(const fe::Vec3& dir) {
  const float y = fe::clampf(dir.y, -1.0f, 1.0f);
  const float t = fe::clampf(y * 0.5f + 0.5f, 0.0f, 1.0f);
  fe::Vec3 sky_top, sky_hor, ground_col;

  switch (g_env_preset) {
    case 1: /* City */
      sky_top    = {0.22f, 0.36f, 0.68f};
      sky_hor    = {0.72f, 0.66f, 0.58f};
      ground_col = {0.14f, 0.14f, 0.16f};
      break;
    case 2: /* Forest */
      sky_top    = {0.20f, 0.45f, 0.65f};
      sky_hor    = {0.58f, 0.72f, 0.60f};
      ground_col = {0.09f, 0.15f, 0.08f};
      break;
    case 3: /* Night */
      sky_top    = {0.015f, 0.025f, 0.065f};
      sky_hor    = {0.055f, 0.075f, 0.14f};
      ground_col = {0.01f, 0.012f, 0.02f};
      break;
    case 4: /* Sunset */
      sky_top    = {0.16f, 0.18f, 0.45f};
      sky_hor    = {0.98f, 0.46f, 0.20f};
      ground_col = {0.12f, 0.07f, 0.06f};
      break;
    case 0: /* Studio Softbox HDRI */
    default:
      sky_top    = {0.42f, 0.46f, 0.56f};
      sky_hor    = {0.24f, 0.26f, 0.32f};
      ground_col = {0.07f, 0.075f, 0.095f};
      break;
  }

  fe::Vec3 base = (y >= 0.0f)
    ? fe::lerpv(sky_hor, sky_top, fe::powf(fe::clampf(y, 0.0f, 1.0f), 0.65f))
    : fe::lerpv(sky_hor * 0.55f, ground_col, fe::clampf(-y * 2.5f, 0.0f, 1.0f));

  /* Studio softbox key & rim cards for crisp metallic reflections */
  if (g_env_preset == 0) {
    const fe::Vec3 key_dir = fe::normalize({0.58f, 0.68f, 0.45f});
    const fe::Vec3 rim_dir = fe::normalize({-0.65f, 0.42f, -0.62f});
    const float key_lobe = fe::maxf(0.0f, fe::dot(dir, key_dir));
    const float rim_lobe = fe::maxf(0.0f, fe::dot(dir, rim_dir));
    base += fe::Vec3(1.55f, 1.48f, 1.38f) * fe::powi(key_lobe, 14u);
    base += fe::Vec3(0.55f, 0.68f, 1.05f) * fe::powi(rim_lobe, 18u);
  } else if (g_env_preset != 3) {
    const fe::Vec3 sun_dir = (g_env_preset == 4)
      ? fe::normalize({0.75f, 0.18f, 0.63f})
      : fe::normalize({0.52f, 0.72f, 0.46f});
    const float sd = fe::maxf(0.0f, fe::dot(dir, sun_dir));
    base += fe::Vec3(2.2f, 1.85f, 1.45f) * fe::powi(sd, 48u);
  } else {
    /* Subtle moon glow at night */
    const fe::Vec3 moon_dir = fe::normalize({-0.45f, 0.68f, 0.57f});
    const float md = fe::maxf(0.0f, fe::dot(dir, moon_dir));
    base += fe::Vec3(0.35f, 0.45f, 0.75f) * fe::powi(md, 64u);
  }

  (void)t;
  return base * g_sky_intensity;
}

/* ---- BVH Construction (Median/Midpoint Spatial Split, Zero Heap Allocation) ---- */
static fe::AABB tri_bounds(const TrianglePrim& tr) {
  fe::AABB b;
  b.expand(tr.v0);
  b.expand(tr.v1);
  b.expand(tr.v2);
  /* Pad degenerate flat triangles slightly */
  b.bmin = b.bmin - fe::Vec3(1e-4f);
  b.bmax = b.bmax + fe::Vec3(1e-4f);
  return b;
}

static uint32_t build_bvh_recursive(uint32_t first, uint32_t count, uint32_t depth) {
  const uint32_t node_idx = g_bvh_used++;
  BVHNode& node = g_bvh[node_idx];

  fe::AABB bounds;
  fe::AABB cbounds;
  for (uint32_t i = 0; i < count; ++i) {
    const TrianglePrim& tr = g_tris[g_tri_indices[first + i]];
    bounds.expand_box(tri_bounds(tr));
    cbounds.expand(tr.centroid);
  }
  node.bounds = bounds;

  if (count <= 4 || depth >= 22 || g_bvh_used + 2 >= kMaxBvhNodes) {
    node.left_or_first = first;
    node.tri_count = count;
    node.right_child = 0;
    return node_idx;
  }

  const fe::Vec3 ext = cbounds.bmax - cbounds.bmin;
  int axis = 0;
  if (ext.y > ext.x && ext.y >= ext.z) axis = 1;
  else if (ext.z > ext.x && ext.z > ext.y) axis = 2;

  const float extent_axis = (axis == 0) ? ext.x : ((axis == 1) ? ext.y : ext.z);
  if (extent_axis < 1e-5f) {
    node.left_or_first = first;
    node.tri_count = count;
    node.right_child = 0;
    return node_idx;
  }

  const float split_pos = 0.5f * ((axis == 0) ? (cbounds.bmin.x + cbounds.bmax.x)
                                : (axis == 1) ? (cbounds.bmin.y + cbounds.bmax.y)
                                              : (cbounds.bmin.z + cbounds.bmax.z));

  uint32_t i = first;
  uint32_t j = first + count - 1;
  while (i <= j) {
    const fe::Vec3& c = g_tris[g_tri_indices[i]].centroid;
    const float cv = (axis == 0) ? c.x : ((axis == 1) ? c.y : c.z);
    if (cv < split_pos) {
      ++i;
    } else {
      const uint32_t tmp = g_tri_indices[i];
      g_tri_indices[i] = g_tri_indices[j];
      g_tri_indices[j] = tmp;
      if (j == 0) break;
      --j;
    }
  }

  uint32_t left_count = i - first;
  if (left_count == 0 || left_count == count) {
    left_count = count >> 1u;
  }

  node.tri_count = 0;
  const uint32_t left_child  = build_bvh_recursive(first, left_count, depth + 1);
  const uint32_t right_child = build_bvh_recursive(first + left_count, count - left_count, depth + 1);
  g_bvh[node_idx].left_or_first = left_child;
  g_bvh[node_idx].right_child   = right_child;
  return node_idx;
}

/* ---- Ray-Scene Intersection ---- */
struct HitInfo {
  float    t;
  fe::Vec3 pos;
  fe::Vec3 normal;
  uint32_t mat_id;
  bool     is_ground;
};

static bool intersect_triangle(const fe::Ray& r, const TrianglePrim& tr, float t_max, float& out_t, float& out_u, float& out_v) {
  const fe::Vec3 e1 = tr.v1 - tr.v0;
  const fe::Vec3 e2 = tr.v2 - tr.v0;
  const fe::Vec3 pvec = fe::cross(r.dir, e2);
  const float det = fe::dot(e1, pvec);
  if (fe::absf(det) < 1e-8f) return false;
  const float inv_det = 1.0f / det;
  const fe::Vec3 tvec = r.origin - tr.v0;
  const float u = fe::dot(tvec, pvec) * inv_det;
  if (u < 0.0f || u > 1.0f) return false;
  const fe::Vec3 qvec = fe::cross(tvec, e1);
  const float v = fe::dot(r.dir, qvec) * inv_det;
  if (v < 0.0f || u + v > 1.0f) return false;
  const float t = fe::dot(e2, qvec) * inv_det;
  if (t < 1e-4f || t >= t_max) return false;
  out_t = t;
  out_u = u;
  out_v = v;
  return true;
}

static bool trace_bvh(const fe::Ray& ray, float t_max, HitInfo& hit, bool any_hit) {
  bool found = false;
  hit.t = t_max;
  hit.is_ground = false;

  if (g_bvh_ready && g_tri_count > 0 && g_bvh_used > 0) {
    uint32_t stack[64];
    uint32_t sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const BVHNode& node = g_bvh[stack[--sp]];
      if (!fe::intersect_aabb(ray, node.bounds, hit.t)) continue;

      if (node.tri_count > 0) {
        for (uint32_t i = 0; i < node.tri_count; ++i) {
          const TrianglePrim& tr = g_tris[g_tri_indices[node.left_or_first + i]];
          float t, u, v;
          if (intersect_triangle(ray, tr, hit.t, t, u, v)) {
            hit.t = t;
            found = true;
            if (any_hit) return true;
            const float w = 1.0f - u - v;
            fe::Vec3 n = fe::normalize(tr.n0 * w + tr.n1 * u + tr.n2 * v);
            if (fe::dot(n, ray.dir) > 0.0f) n = -n;
            hit.pos = ray.origin + ray.dir * t;
            hit.normal = n;
            hit.mat_id = tr.mat_id;
            hit.is_ground = false;
          }
        }
      } else {
        if (sp + 2 <= 64) {
          stack[sp++] = node.right_child;
          stack[sp++] = node.left_or_first;
        }
      }
    }
  }

  /* Optional analytical ground shadow-catcher plane */
  if (g_shadow_catcher && fe::absf(ray.dir.y) > 1e-6f) {
    const float tg = (g_ground_y - ray.origin.y) / ray.dir.y;
    if (tg > 1e-4f && tg < hit.t) {
      const fe::Vec3 gp = ray.origin + ray.dir * tg;
      /* Bounded studio disk (radius 45m) so horizon remains clean */
      if (gp.x * gp.x + gp.z * gp.z <= 45.0f * 45.0f) {
        if (any_hit) return true;
        hit.t = tg;
        hit.pos = gp;
        hit.normal = (ray.dir.y < 0.0f) ? fe::Vec3(0.0f, 1.0f, 0.0f) : fe::Vec3(0.0f, -1.0f, 0.0f);
        hit.is_ground = true;
        found = true;
      }
    }
  }

  return found;
}

/* 64 points on the unit disk, golden-angle spiral. Shadow rays need a jittered
   disk, and sin/cos per sample per light per bounce was a measurable share of
   the frame; a table of pre-distributed points is both cheaper and better
   stratified than two uniform randoms. */
constexpr uint32_t kDiskSamples = 64;
struct DiskPoint { float x, y; };
static DiskPoint g_disk[kDiskSamples];
static bool g_disk_ready = false;

static void ensure_disk_table(void) {
  if (g_disk_ready) return;
  for (uint32_t i = 0; i < kDiskSamples; ++i) {
    const float r = fe::sqrtf((static_cast<float>(i) + 0.5f) / static_cast<float>(kDiskSamples));
    const float phi = static_cast<float>(i) * 2.39996323f;   /* golden angle */
    g_disk[i].x = r * fe::cosf(phi);
    g_disk[i].y = r * fe::sinf(phi);
  }
  g_disk_ready = true;
}

/* ---- Orthonormal Basis & Sampling Helpers ---- */
static void make_onb(const fe::Vec3& n, fe::Vec3& t, fe::Vec3& b) {
  if (fe::absf(n.y) < 0.999f) {
    t = fe::normalize(fe::cross({0.0f, 1.0f, 0.0f}, n));
  } else {
    t = fe::normalize(fe::cross({1.0f, 0.0f, 0.0f}, n));
  }
  b = fe::cross(n, t);
}

static fe::Vec3 sample_cosine_hemisphere(const fe::Vec3& n, fe::RNG& rng) {
  const float u1 = rng.next_f01();
  const float u2 = rng.next_f01();
  const float r = fe::sqrtf(u1);
  const float phi = fe::kTwoPi * u2;
  const float x = r * fe::cosf(phi);
  const float z = r * fe::sinf(phi);
  const float y = fe::sqrtf(fe::maxf(0.0f, 1.0f - u1));
  fe::Vec3 t, b;
  make_onb(n, t, b);
  return fe::normalize(t * x + n * y + b * z);
}

/* Cook-Torrance GGX Direct Lighting Evaluation */
static fe::Vec3 evaluate_ggx_direct(
  const fe::Vec3& n,
  const fe::Vec3& v,
  const fe::Vec3& l,
  const fe::Vec3& albedo,
  float roughness,
  float metalness
) {
  const float ndotl = fe::maxf(0.0f, fe::dot(n, l));
  const float ndotv = fe::maxf(1e-4f, fe::dot(n, v));
  if (ndotl <= 0.0f) return {0.0f, 0.0f, 0.0f};

  const fe::Vec3 h = fe::normalize(v + l);
  const float ndoth = fe::maxf(0.0f, fe::dot(n, h));
  const float vdoth = fe::maxf(0.0f, fe::dot(v, h));

  const float alpha = fe::maxf(0.04f, roughness * roughness);
  const float a2 = alpha * alpha;
  const float denom = ndoth * ndoth * (a2 - 1.0f) + 1.0f;
  const float D = a2 / (fe::kPi * denom * denom + 1e-7f);

  const float k = ((roughness + 1.0f) * (roughness + 1.0f)) * 0.125f;
  const float gv = ndotv / (ndotv * (1.0f - k) + k);
  const float gl = ndotl / (ndotl * (1.0f - k) + k);
  const float G = gv * gl;

  const fe::Vec3 f0 = fe::lerpv({0.04f, 0.04f, 0.04f}, albedo, metalness);
  const float f_pow = fe::powi(fe::clampf(1.0f - vdoth, 0.0f, 1.0f), 5u);
  const fe::Vec3 F = f0 + (fe::Vec3(1.0f) - f0) * f_pow;

  const fe::Vec3 spec = F * (D * G / fe::maxf(1e-4f, 4.0f * ndotv * ndotl));
  const fe::Vec3 kd = (fe::Vec3(1.0f) - F) * (1.0f - metalness);
  const fe::Vec3 diff = kd * albedo * fe::kInvPi;

  return (diff + spec) * ndotl;
}

/* ---- Progressive Path Integrator ---- */
static fe::Vec3 trace_path(fe::Ray ray, uint32_t max_bounces, fe::RNG& rng, float* out_primary_depth, fe::Vec3* out_primary_albedo) {
  fe::Vec3 radiance(0.0f);
  fe::Vec3 throughput(1.0f);
  if (out_primary_depth) *out_primary_depth = -1.0f;
  if (out_primary_albedo) *out_primary_albedo = {0.0f, 0.0f, 0.0f};

  for (uint32_t bounce = 0; bounce <= max_bounces; ++bounce) {
    HitInfo hit;
    if (!trace_bvh(ray, 1e20f, hit, false)) {
      radiance += throughput * sample_environment(ray.dir);
      break;
    }
    if (bounce == 0 && out_primary_depth) *out_primary_depth = hit.t;

    MaterialPBR mat;
    if (hit.is_ground) {
      /* Subtle studio matte ground with grid-inspired micro contrast */
      const float gx = fe::absf(hit.pos.x - fe::floorf(hit.pos.x + 0.5f));
      const float gz = fe::absf(hit.pos.z - fe::floorf(hit.pos.z + 0.5f));
      const float line = (gx < 0.018f || gz < 0.018f) ? 1.0f : 0.0f;
      const float fade = fe::clampf(1.0f - fe::sqrtf(hit.pos.x * hit.pos.x + hit.pos.z * hit.pos.z) / 42.0f, 0.0f, 1.0f);
      mat.albedo = fe::lerpv({0.055f, 0.06f, 0.078f}, {0.13f, 0.145f, 0.22f}, line * fade * 0.65f);
      mat.roughness = 0.72f;
      mat.metalness = 0.05f;
      mat.emission = 0.0f;
      mat.opacity = 1.0f;
    } else {
      mat = g_materials[hit.mat_id < g_mat_count ? hit.mat_id : 0];
    }

    if (bounce == 0 && out_primary_albedo) *out_primary_albedo = mat.albedo;

    if (mat.emission > 0.0f) {
      radiance += throughput * mat.albedo * mat.emission;
    }

    const fe::Vec3 v = -ray.dir;
    const fe::Vec3 origin_offset = hit.pos + hit.normal * 1e-3f;

    /* Next-Event Estimation: sample the lights that are on, with soft-shadow jitter */
    for (uint32_t ai = 0; ai < g_active_light_count; ++ai) {
      const SceneLight& L = g_lights[g_active_lights[ai]];

      fe::Vec3 l_dir;
      float max_dist = 1e20f;
      float atten = 1.0f;

      /* Stratified disk offset for soft shadows, from the precomputed table. */
      const DiskPoint& disk = g_disk[static_cast<uint32_t>(rng.next_f01() * static_cast<float>(kDiskSamples)) & (kDiskSamples - 1u)];
      const float r_u = L.radius;

      if (L.type == 2) {
        /* Directional sun light */
        const fe::Vec3 base_l = -L.dir;
        const fe::Vec3 offset = L.tangent * disk.x + L.bitangent * disk.y;
        l_dir = fe::normalize(base_l + offset * (r_u * 0.06f));
      } else {
        /* Point or Spot light */
        fe::Vec3 to_light = L.pos - hit.pos;
        const float dist = fe::length(to_light);
        if (dist < 1e-3f) continue;
        const fe::Vec3 jitter_pos = L.pos + (L.tangent * disk.x + L.bitangent * disk.y) * r_u;
        const fe::Vec3 jvec = jitter_pos - hit.pos;
        max_dist = fe::length(jvec) - 2e-3f;
        l_dir = jvec * (1.0f / fe::maxf(1e-4f, max_dist + 2e-3f));
        atten = 1.0f / (1.0f + 0.09f * dist + 0.032f * dist * dist);

        if (L.type == 3) {
          /* Spot cone falloff */
          const float spot_cos = fe::dot(-l_dir, L.dir);
          const float inner_cos = fe::lerpf(L.spot_cos_outer, 1.0f, 0.35f);
          if (spot_cos <= L.spot_cos_outer) continue;
          atten *= fe::smoothstepf(L.spot_cos_outer, inner_cos, spot_cos);
        }
      }

      const float ndotl = fe::dot(hit.normal, l_dir);
      if (ndotl <= 0.0f) continue;

      HitInfo shadow_hit;
      /* Temporarily disable ground self-shadowing on ground */
      const bool prev_ground = g_shadow_catcher;
      if (hit.is_ground) g_shadow_catcher = false;
      const bool occluded = trace_bvh(fe::Ray(origin_offset, l_dir), max_dist, shadow_hit, true);
      g_shadow_catcher = prev_ground;

      if (!occluded) {
        const fe::Vec3 brdf = evaluate_ggx_direct(hit.normal, v, l_dir, mat.albedo, mat.roughness, mat.metalness);
        radiance += throughput * brdf * L.color * (L.intensity * atten);
      }
    }

    if (bounce == max_bounces) break;

    /* Indirect bounce: choose specular vs diffuse lobe from Fresnel + metalness */
    const float ndotv = fe::maxf(0.0f, fe::dot(hit.normal, v));
    const float fresnel = 0.04f + 0.96f * fe::powi(1.0f - ndotv, 5u);
    const float spec_prob = fe::clampf(fe::lerpf(fresnel, 1.0f, mat.metalness), 0.08f, 0.92f);

    fe::Vec3 next_dir;
    if (rng.next_f01() < spec_prob) {
      const fe::Vec3 refl = fe::reflect(ray.dir, hit.normal);
      const fe::Vec3 jitter = sample_cosine_hemisphere(hit.normal, rng);
      next_dir = fe::normalize(fe::lerpv(refl, jitter, mat.roughness * mat.roughness));
      if (fe::dot(next_dir, hit.normal) <= 0.0f) next_dir = jitter;
      const fe::Vec3 f0 = fe::lerpv({0.04f, 0.04f, 0.04f}, mat.albedo, mat.metalness);
      const fe::Vec3 F = f0 + (fe::Vec3(1.0f) - f0) * fe::powi(1.0f - ndotv, 5u);
      throughput = throughput * F * (1.0f / spec_prob);
    } else {
      next_dir = sample_cosine_hemisphere(hit.normal, rng);
      throughput = throughput * mat.albedo * ((1.0f - mat.metalness) / (1.0f - spec_prob));
    }

    /* Russian Roulette after first bounce */
    if (bounce >= 1) {
      const float p = fe::clampf(fe::maxf(throughput.x, fe::maxf(throughput.y, throughput.z)), 0.05f, 0.95f);
      if (rng.next_f01() > p) break;
      throughput *= (1.0f / p);
    }

    ray = fe::Ray(origin_offset, next_dir);
  }

  /* Clamp fireflies so progressive convergence stays clean on low sample counts */
  return {
    fe::minf(radiance.x, 18.0f),
    fe::minf(radiance.y, 18.0f),
    fe::minf(radiance.z, 18.0f)
  };
}

/* ---- C++ Post-Processing Helpers (Bloom, Color Grade, ToneMap, Lens FX) ---- */
static void build_bloom_pyramid(const float* linear_rgb, uint32_t w, uint32_t h, float threshold, uint32_t& out_bw, uint32_t& out_bh) {
  uint32_t bw = w >> 2u;
  uint32_t bh = h >> 2u;
  if (bw < 1) bw = 1;
  if (bh < 1) bh = 1;
  while (bw * bh > kMaxBloomDim) {
    bw = fe::maxf(1.0f, static_cast<float>(bw >> 1u));
    bh = fe::maxf(1.0f, static_cast<float>(bh >> 1u));
  }
  out_bw = bw;
  out_bh = bh;

  /* Downsample bright highlights */
  for (uint32_t y = 0; y < bh; ++y) {
    const uint32_t sy = (y * h) / bh;
    for (uint32_t x = 0; x < bw; ++x) {
      const uint32_t sx = (x * w) / bw;
      const uint32_t si = (sy * w + sx) * 3;
      const float r = linear_rgb[si + 0];
      const float g = linear_rgb[si + 1];
      const float b = linear_rgb[si + 2];
      const float lum = 0.2126f * r + 0.7152f * g + 0.0722f * b;
      const float knee = fe::maxf(0.0f, lum - threshold) / fe::maxf(1e-4f, lum);
      const uint32_t di = (y * bw + x) * 3;
      g_bloom_a[di + 0] = r * knee;
      g_bloom_a[di + 1] = g * knee;
      g_bloom_a[di + 2] = b * knee;
    }
  }

  /* Two-pass separable wide tent blur */
  for (int pass = 0; pass < 2; ++pass) {
    const int rad = (pass == 0) ? 4 : 7;
    /* Horizontal */
    for (uint32_t y = 0; y < bh; ++y) {
      for (uint32_t x = 0; x < bw; ++x) {
        float sr = 0.0f, sg = 0.0f, sb = 0.0f, sw = 0.0f;
        for (int k = -rad; k <= rad; ++k) {
          int xx = static_cast<int>(x) + k;
          if (xx < 0) xx = 0;
          if (xx >= static_cast<int>(bw)) xx = static_cast<int>(bw) - 1;
          const float wt = static_cast<float>(rad + 1 - (k < 0 ? -k : k));
          const uint32_t idx = (y * bw + static_cast<uint32_t>(xx)) * 3;
          sr += g_bloom_a[idx + 0] * wt;
          sg += g_bloom_a[idx + 1] * wt;
          sb += g_bloom_a[idx + 2] * wt;
          sw += wt;
        }
        const float inv = 1.0f / sw;
        const uint32_t dst = (y * bw + x) * 3;
        g_bloom_b[dst + 0] = sr * inv;
        g_bloom_b[dst + 1] = sg * inv;
        g_bloom_b[dst + 2] = sb * inv;
      }
    }
    /* Vertical */
    for (uint32_t y = 0; y < bh; ++y) {
      for (uint32_t x = 0; x < bw; ++x) {
        float sr = 0.0f, sg = 0.0f, sb = 0.0f, sw = 0.0f;
        for (int k = -rad; k <= rad; ++k) {
          int yy = static_cast<int>(y) + k;
          if (yy < 0) yy = 0;
          if (yy >= static_cast<int>(bh)) yy = static_cast<int>(bh) - 1;
          const float wt = static_cast<float>(rad + 1 - (k < 0 ? -k : k));
          const uint32_t idx = (static_cast<uint32_t>(yy) * bw + x) * 3;
          sr += g_bloom_b[idx + 0] * wt;
          sg += g_bloom_b[idx + 1] * wt;
          sb += g_bloom_b[idx + 2] * wt;
          sw += wt;
        }
        const float inv = 1.0f / sw;
        const uint32_t dst = (y * bw + x) * 3;
        g_bloom_a[dst + 0] = sr * inv;
        g_bloom_a[dst + 1] = sg * inv;
        g_bloom_a[dst + 2] = sb * inv;
      }
    }
  }
}

static fe::Vec3 sample_bloom_bilinear(float u, float v, uint32_t bw, uint32_t bh) {
  const float fx = fe::clampf(u, 0.0f, 1.0f) * static_cast<float>(bw - 1);
  const float fy = fe::clampf(v, 0.0f, 1.0f) * static_cast<float>(bh - 1);
  const uint32_t x0 = static_cast<uint32_t>(fx);
  const uint32_t y0 = static_cast<uint32_t>(fy);
  const uint32_t x1 = (x0 + 1 < bw) ? (x0 + 1) : x0;
  const uint32_t y1 = (y0 + 1 < bh) ? (y0 + 1) : y0;
  const float tx = fx - static_cast<float>(x0);
  const float ty = fy - static_cast<float>(y0);

  auto fetch = [&](uint32_t x, uint32_t y) -> fe::Vec3 {
    const uint32_t i = (y * bw + x) * 3;
    return {g_bloom_a[i + 0], g_bloom_a[i + 1], g_bloom_a[i + 2]};
  };
  const fe::Vec3 c00 = fetch(x0, y0);
  const fe::Vec3 c10 = fetch(x1, y0);
  const fe::Vec3 c01 = fetch(x0, y1);
  const fe::Vec3 c11 = fetch(x1, y1);
  return fe::lerpv(fe::lerpv(c00, c10, tx), fe::lerpv(c01, c11, tx), ty);
}

static fe::Vec3 apply_tonemap_grade(
  fe::Vec3 col,
  uint32_t tonemap_mode,
  float exposure,
  float contrast,
  float saturation,
  float temperature
) {
  col *= fe::maxf(0.01f, exposure);

  /* White balance temperature (-1 cool .. +1 warm) */
  if (fe::absf(temperature) > 1e-4f) {
    const float t = fe::clampf(temperature, -1.0f, 1.0f);
    col.x *= (1.0f + 0.18f * t);
    col.y *= (1.0f + 0.03f * t);
    col.z *= (1.0f - 0.18f * t);
  }

  switch (tonemap_mode) {
    case FE_TONEMAP_AGX:      col = fe::tonemap_agx_punchy(col); break;
    case FE_TONEMAP_REINHARD: col = fe::tonemap_reinhard(col); break;
    case FE_TONEMAP_FILMIC:   col = fe::tonemap_filmic(col); break;
    case FE_TONEMAP_LINEAR:
      col = {fe::clampf(col.x, 0.0f, 1.0f), fe::clampf(col.y, 0.0f, 1.0f), fe::clampf(col.z, 0.0f, 1.0f)};
      break;
    case FE_TONEMAP_ACES:
    default:                  col = fe::tonemap_aces(col); break;
  }

  /* Contrast around mid-gray */
  if (fe::absf(contrast - 1.0f) > 1e-4f) {
    const float c = fe::clampf(contrast, 0.2f, 2.5f);
    col.x = fe::clampf((col.x - 0.5f) * c + 0.5f, 0.0f, 1.0f);
    col.y = fe::clampf((col.y - 0.5f) * c + 0.5f, 0.0f, 1.0f);
    col.z = fe::clampf((col.z - 0.5f) * c + 0.5f, 0.0f, 1.0f);
  }

  /* Saturation */
  if (fe::absf(saturation - 1.0f) > 1e-4f) {
    const float s = fe::clampf(saturation, 0.0f, 2.5f);
    const float lum = 0.2126f * col.x + 0.7152f * col.y + 0.0722f * col.z;
    col.x = fe::clampf(fe::lerpf(lum, col.x, s), 0.0f, 1.0f);
    col.y = fe::clampf(fe::lerpf(lum, col.y, s), 0.0f, 1.0f);
    col.z = fe::clampf(fe::lerpf(lum, col.z, s), 0.0f, 1.0f);
  }

  return col;
}

} // namespace

extern "C" {

FE_EXPORT void fe_render_scene_clear(void) {
  g_mat_count = 0;
  g_tri_count = 0;
  g_bvh_used  = 0;
  g_bvh_ready = false;
  for (uint32_t i = 0; i < kMaxLights; ++i) {
    g_lights[i].type = 0;
    g_lights[i].intensity = 0.0f;
  }
  g_active_light_count = 0;
}

FE_EXPORT int32_t fe_render_add_mesh(
  const float* positions_xyz,
  const float* normals_xyz,
  const uint32_t* indices,
  uint32_t vertex_count,
  uint32_t tri_count,
  float r, float g, float b,
  float roughness,
  float metalness,
  float emission,
  float opacity
) {
  if (!positions_xyz || vertex_count < 3 || tri_count == 0) return 0;
  if (g_mat_count >= kMaxMaterials) return -1;

  const uint32_t mat_id = g_mat_count++;
  g_materials[mat_id] = {
    {fe::srgb_to_linear(r), fe::srgb_to_linear(g), fe::srgb_to_linear(b)},
    fe::clampf(roughness, 0.04f, 1.0f),
    fe::clampf(metalness, 0.0f, 1.0f),
    fe::maxf(0.0f, emission),
    fe::clampf(opacity, 0.0f, 1.0f)
  };

  uint32_t added = 0;
  for (uint32_t t = 0; t < tri_count; ++t) {
    if (g_tri_count >= kMaxTriangles) break;
    const uint32_t i0 = indices ? indices[t * 3 + 0] : (t * 3 + 0);
    const uint32_t i1 = indices ? indices[t * 3 + 1] : (t * 3 + 1);
    const uint32_t i2 = indices ? indices[t * 3 + 2] : (t * 3 + 2);
    if (i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count) continue;

    const fe::Vec3 v0(positions_xyz[i0 * 3 + 0], positions_xyz[i0 * 3 + 1], positions_xyz[i0 * 3 + 2]);
    const fe::Vec3 v1(positions_xyz[i1 * 3 + 0], positions_xyz[i1 * 3 + 1], positions_xyz[i1 * 3 + 2]);
    const fe::Vec3 v2(positions_xyz[i2 * 3 + 0], positions_xyz[i2 * 3 + 1], positions_xyz[i2 * 3 + 2]);

    const fe::Vec3 face_n = fe::normalize(fe::cross(v1 - v0, v2 - v0));
    fe::Vec3 n0 = face_n, n1 = face_n, n2 = face_n;
    if (normals_xyz) {
      n0 = fe::normalize({normals_xyz[i0 * 3 + 0], normals_xyz[i0 * 3 + 1], normals_xyz[i0 * 3 + 2]});
      n1 = fe::normalize({normals_xyz[i1 * 3 + 0], normals_xyz[i1 * 3 + 1], normals_xyz[i1 * 3 + 2]});
      n2 = fe::normalize({normals_xyz[i2 * 3 + 0], normals_xyz[i2 * 3 + 1], normals_xyz[i2 * 3 + 2]});
    }

    TrianglePrim& prim = g_tris[g_tri_count];
    prim.v0 = v0; prim.v1 = v1; prim.v2 = v2;
    prim.n0 = n0; prim.n1 = n1; prim.n2 = n2;
    prim.centroid = (v0 + v1 + v2) * (1.0f / 3.0f);
    prim.mat_id = mat_id;
    g_tri_indices[g_tri_count] = g_tri_count;
    ++g_tri_count;
    ++added;
  }

  g_bvh_ready = false;
  return static_cast<int32_t>(added);
}

FE_EXPORT void fe_render_set_environment(
  uint32_t preset_id,
  float sky_intensity,
  uint32_t shadow_catcher_enabled,
  float ground_y
) {
  g_env_preset = preset_id <= 4 ? preset_id : 0;
  g_sky_intensity = fe::clampf(sky_intensity, 0.0f, 8.0f);
  g_shadow_catcher = (shadow_catcher_enabled != 0);
  g_ground_y = ground_y;
}

FE_EXPORT void fe_render_set_light(
  uint32_t light_index,
  uint32_t light_type,
  float px, float py, float pz,
  float dx, float dy, float dz,
  float cr, float cg, float cb,
  float intensity,
  float radius_softness,
  float spot_cos_outer
) {
  if (light_index >= kMaxLights) return;
  SceneLight& L = g_lights[light_index];
  L.type = light_type;
  L.pos = {px, py, pz};
  L.dir = fe::normalize({dx, dy, dz});
  L.color = {fe::srgb_to_linear(cr), fe::srgb_to_linear(cg), fe::srgb_to_linear(cb)};
  L.intensity = fe::maxf(0.0f, intensity);
  L.radius = fe::clampf(radius_softness, 0.0f, 8.0f);
  L.spot_cos_outer = fe::clampf(spot_cos_outer, -1.0f, 0.999f);
  make_onb(L.dir, L.tangent, L.bitangent);

  g_active_light_count = 0;
  for (uint32_t i = 0; i < kMaxLights; ++i) {
    if (g_lights[i].type != 0 && g_lights[i].intensity > 1e-4f) {
      g_active_lights[g_active_light_count++] = i;
    }
  }
}

FE_EXPORT void fe_render_set_camera(
  float eye_x, float eye_y, float eye_z,
  float fwd_x, float fwd_y, float fwd_z,
  float right_x, float right_y, float right_z,
  float up_x, float up_y, float up_z,
  float fov_deg,
  float aspect,
  float aperture,
  float focus_dist
) {
  g_cam.eye = {eye_x, eye_y, eye_z};
  g_cam.fwd = fe::normalize({fwd_x, fwd_y, fwd_z});
  g_cam.right = fe::normalize({right_x, right_y, right_z});
  g_cam.up = fe::normalize({up_x, up_y, up_z});
  const float clamped_fov = fe::clampf(fov_deg, 5.0f, 150.0f);
  g_cam.tan_half_fov = fe::tanf(clamped_fov * fe::kDeg2Rad * 0.5f);
  g_cam.aspect = fe::clampf(aspect, 0.1f, 10.0f);
  g_cam.aperture = fe::clampf(aperture, 0.0f, 2.0f);
  g_cam.focus_dist = fe::maxf(0.2f, focus_dist);
}

FE_EXPORT int32_t fe_render_build_bvh(void) {
  ensure_disk_table();
  g_bvh_used = 0;
  if (g_tri_count == 0) {
    g_bvh_ready = false;
    return 0;
  }
  for (uint32_t i = 0; i < g_tri_count; ++i) g_tri_indices[i] = i;
  build_bvh_recursive(0, g_tri_count, 0);
  g_bvh_ready = true;
  return static_cast<int32_t>(g_bvh_used);
}

FE_EXPORT uint32_t fe_render_get_triangle_count(void) {
  return g_tri_count;
}

FE_EXPORT int32_t fe_render_init_framebuffer(uint32_t width, uint32_t height) {
  if (width == 0 || height == 0 || width * height > kMaxPathPixels) return -1;
  g_fb_w = width;
  g_fb_h = height;
  fe_render_reset_accumulation();
  const uint32_t n = width * height;
  for (uint32_t i = 0; i < n; ++i) {
    g_pixel_samples[i] = 0;
    g_pixel_cap[i] = 0xFFFFu;   /* no cap until convergence says otherwise */
  }
  return 1;
}

FE_EXPORT void fe_render_reset_accumulation(void) {
  g_accum_samples = 0;
  const uint32_t n = g_fb_w * g_fb_h * 3;
  for (uint32_t i = 0; i < n; ++i) g_accum_rgb[i] = 0.0f;
  const uint32_t pixels = g_fb_w * g_fb_h;
  for (uint32_t i = 0; i < pixels; ++i) {
    g_pixel_samples[i] = 0;
    g_pixel_cap[i] = 0xFFFFu;
  }
}

FE_EXPORT uint32_t fe_render_trace_samples(
  uint32_t sample_count,
  uint32_t max_bounces,
  uint32_t tile_y_start,
  uint32_t tile_height
) {
  if (g_fb_w == 0 || g_fb_h == 0 || sample_count == 0) return g_accum_samples;
  const uint32_t bounces = max_bounces > 5 ? 5 : max_bounces;
  const uint32_t y0 = tile_y_start < g_fb_h ? tile_y_start : 0;
  const uint32_t y1 = (tile_height == 0 || y0 + tile_height > g_fb_h) ? g_fb_h : (y0 + tile_height);

  const float inv_w = 1.0f / static_cast<float>(g_fb_w);
  const float inv_h = 1.0f / static_cast<float>(g_fb_h);

  for (uint32_t s = 0; s < sample_count; ++s) {
    const uint32_t sample_idx = g_accum_samples + s + 1;
    for (uint32_t y = y0; y < y1; ++y) {
      for (uint32_t x = 0; x < g_fb_w; ++x) {
        const uint32_t pixel_index = y * g_fb_w + x;
        if (g_pixel_samples[pixel_index] >= g_pixel_cap[pixel_index]) continue;
        const uint64_t seed = (static_cast<uint64_t>(y * g_fb_w + x) * 1973ULL) ^
                              (static_cast<uint64_t>(sample_idx) * 9277ULL + 0x9e3779b97f4a7c15ULL);
        fe::RNG rng(seed, sample_idx * 2u + 1u);

        const float jx = (static_cast<float>(x) + rng.next_f01()) * inv_w;
        const float jy = (static_cast<float>(y) + rng.next_f01()) * inv_h;
        const float ndc_x = (2.0f * jx - 1.0f) * g_cam.aspect * g_cam.tan_half_fov;
        const float ndc_y = (1.0f - 2.0f * jy) * g_cam.tan_half_fov;

        fe::Vec3 ray_origin = g_cam.eye;
        fe::Vec3 ray_dir = fe::normalize(g_cam.fwd + g_cam.right * ndc_x + g_cam.up * ndc_y);

        /* Thin-lens Depth of Field */
        if (g_cam.aperture > 1e-4f) {
          const fe::Vec3 focal_pt = ray_origin + ray_dir * g_cam.focus_dist;
          const float lr = fe::sqrtf(rng.next_f01()) * g_cam.aperture;
          const float lphi = fe::kTwoPi * rng.next_f01();
          ray_origin += (g_cam.right * fe::cosf(lphi) + g_cam.up * fe::sinf(lphi)) * lr;
          ray_dir = fe::normalize(focal_pt - ray_origin);
        }

        float primary_depth = -1.0f;
        fe::Vec3 primary_albedo;
        const fe::Vec3 col = trace_path(fe::Ray(ray_origin, ray_dir), bounces, rng, &primary_depth, &primary_albedo);
        if (s == 0 && primary_depth > 0.0f) {
          const float q = fe::minf(primary_depth, 64.0f) * kDepthScale;
          g_depth16[y * g_fb_w + x] = static_cast<uint16_t>(q);
        } else if (s == 0 && primary_depth < 0.0f) {
          g_depth16[y * g_fb_w + x] = kDepthFar;
        }
        /* Running mean, not a sum. Per-pixel sample counts only help if the
           buffer is already an average, and an average removes a whole pass of
           normalisation (and the sample-count scaling in bloom). */
        const uint32_t sample_now = g_pixel_samples[pixel_index] + 1u;
        g_pixel_samples[pixel_index] = static_cast<uint16_t>(sample_now < 0xFFFFu ? sample_now : 0xFFFFu);
        const float mean_w = 1.0f / static_cast<float>(sample_now);
        const uint32_t mi = pixel_index * 3;
        g_accum_rgb[mi + 0] += (col.x - g_accum_rgb[mi + 0]) * mean_w;
        g_accum_rgb[mi + 1] += (col.y - g_accum_rgb[mi + 1]) * mean_w;
        g_accum_rgb[mi + 2] += (col.z - g_accum_rgb[mi + 2]) * mean_w;

        if (s == 0) {
          const uint32_t ai = (y * g_fb_w + x) * 3;
          g_albedo8[ai + 0] = static_cast<uint8_t>(fe::clampf(primary_albedo.x, 0.0f, 1.0f) * 255.0f + 0.5f);
          g_albedo8[ai + 1] = static_cast<uint8_t>(fe::clampf(primary_albedo.y, 0.0f, 1.0f) * 255.0f + 0.5f);
          g_albedo8[ai + 2] = static_cast<uint8_t>(fe::clampf(primary_albedo.z, 0.0f, 1.0f) * 255.0f + 0.5f);
        }
      }
    }
  }

  /* Only increment global sample counter when completing bottom of frame */
  if (y1 >= g_fb_h) {
    g_accum_samples += sample_count;
  }
  return g_accum_samples;
}

/* ---- Edge-avoiding denoiser ----------------------------------------
   A path tracer at 8 samples per pixel is not noise-free, but most of that
   noise is high-frequency and can be removed without softening the picture if
   the filter knows where the geometry ends. This is a separable bilateral
   filter — five taps per axis, three à-trous iterations (radii 1, 2, 4) — that
   stops at luminance steps and at depth discontinuities. It runs on the linear
   accumulation buffer before tone mapping, so the grade sees a clean image.

   Cost is what matters here: the default went from 24 SPP to 8 SPP, and the
   filter has to cost far less than the 16 SPP it replaces. Two passes of five
   taps is thirty weight evaluations per pixel in total, each a handful of
   flops, with no per-pixel allocation and no second full-size image. */

constexpr uint32_t kDenoiseMaxRow = 1280;
static float g_denoise_row[kDenoiseMaxRow * 3];
static float g_denoise_ring[5][kDenoiseMaxRow * 3];
static uint32_t g_denoise_tag[5];

static inline float denoise_luma(const float* c) {
  return c[0] * 0.2126f + c[1] * 0.7152f + c[2] * 0.0722f;
}

/* Lorentzian falloff on the three things a filter must not cross: a depth
   discontinuity (geometry), an albedo edge (material — the floor grid), and a
   large luminance step that is neither (a shadow, an emissive lamp). Written as
   an error term summed before squaring so the gates reinforce each other
   instead of one of them being outvoted. */
/* Tuned against a 64-sample reference on the default cube scene: these hold
   the floor grid's edges (the thing a blur eats first) while still removing
   most of the noise at 8 samples. fe_render_denoise_config() exists so the
   ratios are visible and adjustable rather than buried in the weight. */
static float g_dn_lum = 10.0f, g_dn_alb = 46.0f, g_dn_dep = 9.0f;

static inline float denoise_weight(
  float lum_a, float lum_b,
  uint16_t d_a, uint16_t d_b,
  const uint8_t* alb_a, const uint8_t* alb_b
) {
  const float dl = fe::absf(lum_a - lum_b);

  /* Depth gate, relative so it works at 0.5 m and at 40 m alike. */
  float a = 0.0f;
  if (d_a != d_b) {
    const float da = (d_a == kDepthFar) ? 64.0f : (static_cast<float>(d_a) * (1.0f / kDepthScale));
    const float db = (d_b == kDepthFar) ? 64.0f : (static_cast<float>(d_b) * (1.0f / kDepthScale));
    const float near = fe::maxf(0.08f, fe::minf(da, db));
    a += fe::absf(da - db) / near * g_dn_dep;
  }

  /* Albedo gate: a material boundary is never blended across, however similar
     the lit result looks. This is what keeps the studio grid on the floor. */
  const float dr = static_cast<float>(static_cast<int>(alb_a[0]) - static_cast<int>(alb_b[0])) * (1.0f / 255.0f);
  const float dg = static_cast<float>(static_cast<int>(alb_a[1]) - static_cast<int>(alb_b[1])) * (1.0f / 255.0f);
  const float db2 = static_cast<float>(static_cast<int>(alb_a[2]) - static_cast<int>(alb_b[2])) * (1.0f / 255.0f);
  a += fe::sqrtf(dr * dr + dg * dg + db2 * db2) * g_dn_alb;

  /* Luminance gate, deliberately loose: the whole point of the filter is to
     average away luminance noise, so this only has to catch the steps the
     other two gates cannot see. */
  a += dl * g_dn_lum;

  return 1.0f / (1.0f + a * a);
}

static void denoise_horizontal(uint32_t w, uint32_t h, uint32_t step) {
  for (uint32_t y = 0; y < h; ++y) {
    float* row = &g_accum_rgb[static_cast<size_t>(y) * w * 3];
    for (uint32_t x = 0; x < w; ++x) {
      const float* c = row + x * 3;
      const float lum_c = denoise_luma(c);
      const uint32_t di_c = y * w + x;
      const uint16_t d_c = g_depth16[di_c];
      const uint8_t* alb_c = &g_albedo8[static_cast<size_t>(di_c) * 3];
      float sum0 = 0.0f, sum1 = 0.0f, sum2 = 0.0f, wsum = 0.0f;
      for (int k = -2; k <= 2; ++k) {
        int sx = static_cast<int>(x) + k * static_cast<int>(step);
        sx = sx < 0 ? 0 : (sx >= static_cast<int>(w) ? static_cast<int>(w) - 1 : sx);
        const float* n = row + static_cast<size_t>(sx) * 3;
        const uint32_t di_n = y * w + sx;
        const float wt = denoise_weight(lum_c, denoise_luma(n), d_c, g_depth16[di_n], alb_c, &g_albedo8[static_cast<size_t>(di_n) * 3]);
        sum0 += n[0] * wt;
        sum1 += n[1] * wt;
        sum2 += n[2] * wt;
        wsum += wt;
      }
      const float inv = 1.0f / fe::maxf(1e-6f, wsum);
      g_denoise_row[x * 3 + 0] = sum0 * inv;
      g_denoise_row[x * 3 + 1] = sum1 * inv;
      g_denoise_row[x * 3 + 2] = sum2 * inv;
    }
    for (uint32_t i = 0; i < w * 3; ++i) row[i] = g_denoise_row[i];
  }
}

static void denoise_vertical(uint32_t w, uint32_t h, uint32_t step) {
  const size_t row_floats = static_cast<size_t>(w) * 3;
  for (uint32_t i = 0; i < 5; ++i) g_denoise_tag[i] = 0xFFFFFFFFu;

  const auto load = [&](int yy) -> const float* {
    const int clamped = yy < 0 ? 0 : (yy >= static_cast<int>(h) ? static_cast<int>(h) - 1 : yy);
    const uint32_t slot = static_cast<uint32_t>(clamped) % 5u;
    if (g_denoise_tag[slot] != static_cast<uint32_t>(clamped)) {
      const float* src = &g_accum_rgb[static_cast<size_t>(clamped) * w * 3];
      float* dst = g_denoise_ring[slot];
      for (size_t i = 0; i < row_floats; ++i) dst[i] = src[i];
      g_denoise_tag[slot] = static_cast<uint32_t>(clamped);
    }
    return g_denoise_ring[slot];
  };

  for (uint32_t y = 0; y < h; ++y) {
    const float* centre = load(static_cast<int>(y));
    for (uint32_t x = 0; x < w; ++x) {
      const float* c = centre + x * 3;
      const float lum_c = denoise_luma(c);
      const uint32_t di_c = y * w + x;
      const uint16_t d_c = g_depth16[di_c];
      const uint8_t* alb_c = &g_albedo8[static_cast<size_t>(di_c) * 3];
      float sum0 = 0.0f, sum1 = 0.0f, sum2 = 0.0f, wsum = 0.0f;
      for (int k = -2; k <= 2; ++k) {
        const int sy = static_cast<int>(y) + k * static_cast<int>(step);
        const int clamped = sy < 0 ? 0 : (sy >= static_cast<int>(h) ? static_cast<int>(h) - 1 : sy);
        const float* r = load(clamped);
        const float* n = r + x * 3;
        const uint32_t di_n = static_cast<size_t>(clamped) * w + x;
        const float wt = denoise_weight(lum_c, denoise_luma(n), d_c, g_depth16[di_n], alb_c, &g_albedo8[static_cast<size_t>(di_n) * 3]);
        sum0 += n[0] * wt;
        sum1 += n[1] * wt;
        sum2 += n[2] * wt;
        wsum += wt;
      }
      const float inv = 1.0f / fe::maxf(1e-6f, wsum);
      g_denoise_row[x * 3 + 0] = sum0 * inv;
      g_denoise_row[x * 3 + 1] = sum1 * inv;
      g_denoise_row[x * 3 + 2] = sum2 * inv;
    }
    float* dst = &g_accum_rgb[static_cast<size_t>(y) * w * 3];
    for (size_t i = 0; i < row_floats; ++i) dst[i] = g_denoise_row[i];
  }
}

FE_EXPORT void fe_render_denoise_config(float lum, float alb, float dep) {
  g_dn_lum = lum; g_dn_alb = alb; g_dn_dep = dep;
}

FE_EXPORT uint32_t fe_render_denoise(uint32_t iterations, uint32_t strength) {
  if (g_fb_w == 0 || g_fb_h == 0 || g_accum_samples == 0) return 0;
  if (g_fb_w > kDenoiseMaxRow || iterations == 0) return 0;
  const uint32_t passes = iterations > 3 ? 3 : iterations;
  (void)strength;

  /* The buffer already holds radiance means, so the filter can compare colours
     directly and the resolve needs no knowledge of what just happened. */
  for (uint32_t it = 0; it < passes; ++it) {
    const uint32_t step = 1u << it;
    denoise_horizontal(g_fb_w, g_fb_h, step);
    denoise_vertical(g_fb_w, g_fb_h, step);
  }
  return 1;
}

/* After each full pass, mark the pixels that have stopped moving and freeze
   their sample counts. "Stopped moving" is measured against the pixel's four
   neighbours rather than against its own history: progressive accumulation
   smooths a pixel's history by construction, so history cannot see the noise
   the denoiser will. A neighbourhood that agrees on colour and depth is either
   a flat surface or the middle of a soft gradient, and neither needs samples.

   Threshold is in linear light against the mean level, so it behaves the same
   in a bright sky and a dim corner. */
FE_EXPORT uint32_t fe_render_update_convergence(float tolerance) {
  if (g_fb_w == 0 || g_fb_h == 0) return 0;
  const float tol = fe::clampf(tolerance, 0.0005f, 0.5f);
  uint32_t converged = 0;

  for (uint32_t y = 0; y < g_fb_h; ++y) {
    for (uint32_t x = 0; x < g_fb_w; ++x) {
      const uint32_t i = y * g_fb_w + x;
      const uint16_t n = g_pixel_samples[i];
      if (n == 0 || g_pixel_cap[i] != 0xFFFFu) { if (g_pixel_cap[i] != 0xFFFFu) ++converged; continue; }

      const float* c = &g_accum_rgb[static_cast<size_t>(i) * 3];
      const float lum = c[0] * 0.2126f + c[1] * 0.7152f + c[2] * 0.0722f;
      const uint16_t depth = g_depth16[i];

      float worst = 0.0f;
      const int offsets[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
      for (uint32_t k = 0; k < 4; ++k) {
        const int nx = static_cast<int>(x) + offsets[k][0];
        const int ny = static_cast<int>(y) + offsets[k][1];
        if (nx < 0 || ny < 0 || nx >= static_cast<int>(g_fb_w) || ny >= static_cast<int>(g_fb_h)) continue;
        const uint32_t ni = static_cast<uint32_t>(ny) * g_fb_w + static_cast<uint32_t>(nx);
        if (g_pixel_samples[ni] == 0) continue;
        if (g_depth16[ni] != depth) { worst = 1.0f; break; }   /* a silhouette: keep sampling */
        const float* nc = &g_accum_rgb[static_cast<size_t>(ni) * 3];
        const float nlum = nc[0] * 0.2126f + nc[1] * 0.7152f + nc[2] * 0.0722f;
        const float scale = fe::maxf(0.03f, fe::maxf(lum, nlum));
        const float diff = fe::absf(lum - nlum) / scale;
        if (diff > worst) worst = diff;
      }

      if (worst < tol) {
        g_pixel_cap[i] = n;
        ++converged;
      }
    }
  }
  return converged;
}

/* How many pixels are still taking samples. Zero means every pixel has
   converged, and the render can stop before its sample target: there is
   nothing left for another pass to improve. */
FE_EXPORT uint32_t fe_render_active_pixels(void) {
  const uint32_t n = g_fb_w * g_fb_h;
  uint32_t active = 0;
  for (uint32_t i = 0; i < n; ++i) {
    if (g_pixel_samples[i] < g_pixel_cap[i]) ++active;
  }
  return active;
}

FE_EXPORT uint32_t fe_render_get_pixel_samples(uint32_t x, uint32_t y) {
  if (x >= g_fb_w || y >= g_fb_h) return 0;
  return g_pixel_samples[y * g_fb_w + x];
}

FE_EXPORT uint32_t fe_render_get_accum_samples(void) {
  return g_accum_samples;
}

FE_EXPORT uint32_t fe_render_resolve_rgba8(
  uint32_t tonemap_mode,
  float exposure,
  float contrast,
  float saturation,
  float temperature,
  float bloom_strength,
  float vignette,
  float chromatic_aberration,
  float film_grain
) {
  if (g_fb_w == 0 || g_fb_h == 0) return 0;

  /* The accumulation buffer holds radiance means, so there is nothing to
     normalise here and the bloom threshold is a real luminance. */
  uint32_t bw = 1, bh = 1;
  const bool use_bloom = bloom_strength > 1e-3f;
  if (use_bloom) {
    build_bloom_pyramid(g_accum_rgb, g_fb_w, g_fb_h, 0.85f, bw, bh);
  }

  const float inv_w = 1.0f / static_cast<float>(g_fb_w);
  const float inv_h = 1.0f / static_cast<float>(g_fb_h);
  fe::RNG grain_rng(0x517cc1b727220a95ULL + g_accum_samples, 7u);

  auto fetch_accum = [&](int x, int y) -> fe::Vec3 {
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= static_cast<int>(g_fb_w)) x = static_cast<int>(g_fb_w) - 1;
    if (y >= static_cast<int>(g_fb_h)) y = static_cast<int>(g_fb_h) - 1;
    const uint32_t i = (static_cast<uint32_t>(y) * g_fb_w + static_cast<uint32_t>(x)) * 3;
    return {g_accum_rgb[i + 0], g_accum_rgb[i + 1], g_accum_rgb[i + 2]};
  };

  for (uint32_t y = 0; y < g_fb_h; ++y) {
    const float v = (static_cast<float>(y) + 0.5f) * inv_h;
    for (uint32_t x = 0; x < g_fb_w; ++x) {
      const float u = (static_cast<float>(x) + 0.5f) * inv_w;
      fe::Vec3 col = fetch_accum(static_cast<int>(x), static_cast<int>(y));

      if (chromatic_aberration > 1e-4f) {
        const float dx = (u - 0.5f) * chromatic_aberration * static_cast<float>(g_fb_w) * 0.025f;
        const float dy = (v - 0.5f) * chromatic_aberration * static_cast<float>(g_fb_h) * 0.025f;
        col.x = fetch_accum(static_cast<int>(static_cast<float>(x) + dx), static_cast<int>(static_cast<float>(y) + dy)).x;
        col.z = fetch_accum(static_cast<int>(static_cast<float>(x) - dx), static_cast<int>(static_cast<float>(y) - dy)).z;
      }

      if (use_bloom) {
        col += sample_bloom_bilinear(u, v, bw, bh) * bloom_strength;
      }

      col = apply_tonemap_grade(col, tonemap_mode, exposure, contrast, saturation, temperature);

      if (vignette > 1e-4f) {
        const float vx = (u - 0.5f) * 2.0f;
        const float vy = (v - 0.5f) * 2.0f;
        const float r2 = vx * vx + vy * vy;
        const float vig = fe::clampf(1.0f - vignette * r2 * 0.55f, 0.0f, 1.0f);
        col *= vig;
      }

      if (film_grain > 1e-4f) {
        const float n = (grain_rng.next_f01() - 0.5f) * film_grain * 0.14f;
        col = {fe::clampf(col.x + n, 0.0f, 1.0f), fe::clampf(col.y + n, 0.0f, 1.0f), fe::clampf(col.z + n, 0.0f, 1.0f)};
      }

      const uint32_t oi = (y * g_fb_w + x) * 4;
      g_resolved_rgba[oi + 0] = static_cast<uint8_t>(fe::linear_to_srgb(col.x) * 255.0f + 0.5f);
      g_resolved_rgba[oi + 1] = static_cast<uint8_t>(fe::linear_to_srgb(col.y) * 255.0f + 0.5f);
      g_resolved_rgba[oi + 2] = static_cast<uint8_t>(fe::linear_to_srgb(col.z) * 255.0f + 0.5f);
      g_resolved_rgba[oi + 3] = 255u;
    }
  }

  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_resolved_rgba));
}

FE_EXPORT uint32_t fe_render_get_rgba8_ptr(void) {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_resolved_rgba));
}

FE_EXPORT const uint8_t* fe_render_get_rgba8_native(void) {
  return g_resolved_rgba;
}

FE_EXPORT int32_t fe_postprocess_rgba8(
  uint8_t* rgba_pixels,
  uint32_t width,
  uint32_t height,
  uint32_t tonemap_mode,
  float exposure,
  float contrast,
  float saturation,
  float temperature,
  float bloom_strength,
  float vignette,
  float chromatic_aberration,
  float film_grain,
  uint32_t frame_seed
) {
  if (!rgba_pixels || width == 0 || height == 0) return -1;
  const uint32_t count = width * height;
  if (count > kMaxPathPixels) return -2;

  /* Convert sRGB8 -> linear float in g_accum_rgb */
  for (uint32_t i = 0; i < count; ++i) {
    g_accum_rgb[i * 3 + 0] = fe::srgb_to_linear(static_cast<float>(rgba_pixels[i * 4 + 0]) * (1.0f / 255.0f));
    g_accum_rgb[i * 3 + 1] = fe::srgb_to_linear(static_cast<float>(rgba_pixels[i * 4 + 1]) * (1.0f / 255.0f));
    g_accum_rgb[i * 3 + 2] = fe::srgb_to_linear(static_cast<float>(rgba_pixels[i * 4 + 2]) * (1.0f / 255.0f));
  }

  uint32_t bw = 1, bh = 1;
  const bool use_bloom = bloom_strength > 1e-3f;
  if (use_bloom) {
    build_bloom_pyramid(g_accum_rgb, width, height, 0.62f, bw, bh);
  }

  const float inv_w = 1.0f / static_cast<float>(width);
  const float inv_h = 1.0f / static_cast<float>(height);
  fe::RNG grain_rng(0x9e3779b97f4a7c15ULL + frame_seed * 131u, 11u);

  auto fetch_lin = [&](int x, int y) -> fe::Vec3 {
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= static_cast<int>(width)) x = static_cast<int>(width) - 1;
    if (y >= static_cast<int>(height)) y = static_cast<int>(height) - 1;
    const uint32_t idx = (static_cast<uint32_t>(y) * width + static_cast<uint32_t>(x)) * 3;
    return {g_accum_rgb[idx + 0], g_accum_rgb[idx + 1], g_accum_rgb[idx + 2]};
  };

  for (uint32_t y = 0; y < height; ++y) {
    const float v = (static_cast<float>(y) + 0.5f) * inv_h;
    for (uint32_t x = 0; x < width; ++x) {
      const float u = (static_cast<float>(x) + 0.5f) * inv_w;
      fe::Vec3 col = fetch_lin(static_cast<int>(x), static_cast<int>(y));

      if (chromatic_aberration > 1e-4f) {
        const float dx = (u - 0.5f) * chromatic_aberration * static_cast<float>(width) * 0.022f;
        const float dy = (v - 0.5f) * chromatic_aberration * static_cast<float>(height) * 0.022f;
        col.x = fetch_lin(static_cast<int>(static_cast<float>(x) + dx), static_cast<int>(static_cast<float>(y) + dy)).x;
        col.z = fetch_lin(static_cast<int>(static_cast<float>(x) - dx), static_cast<int>(static_cast<float>(y) - dy)).z;
      }

      if (use_bloom) {
        col += sample_bloom_bilinear(u, v, bw, bh) * bloom_strength;
      }

      col = apply_tonemap_grade(col, tonemap_mode, exposure, contrast, saturation, temperature);

      if (vignette > 1e-4f) {
        const float vx = (u - 0.5f) * 2.0f;
        const float vy = (v - 0.5f) * 2.0f;
        const float vig = fe::clampf(1.0f - vignette * (vx * vx + vy * vy) * 0.55f, 0.0f, 1.0f);
        col *= vig;
      }

      if (film_grain > 1e-4f) {
        const float n = (grain_rng.next_f01() - 0.5f) * film_grain * 0.12f;
        col = {fe::clampf(col.x + n, 0.0f, 1.0f), fe::clampf(col.y + n, 0.0f, 1.0f), fe::clampf(col.z + n, 0.0f, 1.0f)};
      }

      const uint32_t oi = (y * width + x) * 4;
      rgba_pixels[oi + 0] = static_cast<uint8_t>(fe::linear_to_srgb(col.x) * 255.0f + 0.5f);
      rgba_pixels[oi + 1] = static_cast<uint8_t>(fe::linear_to_srgb(col.y) * 255.0f + 0.5f);
      rgba_pixels[oi + 2] = static_cast<uint8_t>(fe::linear_to_srgb(col.z) * 255.0f + 0.5f);
    }
  }
  return 1;
}

} // extern "C"
