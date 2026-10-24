#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

/* =========================================================================
 * Final Effect — landscape surface library (C++)
 *
 * Everything the Landscaping Studio puts on a natural asset resolves here:
 *
 *   1. fe_surface_pbr()          measured base albedo / roughness / F0 per
 *                               natural surface plus the physical modifiers
 *                               for wetness, snow grain ageing and lichen.
 *   2. fe_surface_detail()       tileable micro-structure (bark fibre, rock
 *                               bedding + fracture, sastrugi snow, sand
 *                               ripples, turf strands, leaf venation, gravel
 *                               cells) baked into tangent-space normals so
 *                               the GPU only samples a normal/roughness map.
 *   3. fe_water_optical()        Jerlov water-type absorption / scattering.
 *   4. fe_surface_wind_roughness() Cox–Munk mean-square-slope model.
 *
 * Values are *approximations* of published measurements (spectral albedo
 * libraries, Jerlov 1976 water types, Cox & Munk 1954, Warren & Wiscombe snow
 * grain models). They are documented in docs/LANDSCAPE-REALISM.md together
 * with what is still missing, so nothing here pretends to be a radiative
 * transfer simulation.
 * ========================================================================= */

namespace {

using namespace fe;

/* ------------------------------------------------------------------ */
/* Surface ids — keep in sync with FELandscapeRealism.SURFACES (JS).   */
/* ------------------------------------------------------------------ */
enum SurfaceId {
  SURF_MEADOW_GRASS = 0,
  SURF_DRY_GRASS,
  SURF_LOAM,
  SURF_SAND_DRY,
  SURF_GRANITE,
  SURF_BASALT,
  SURF_SANDSTONE,
  SURF_SNOW,
  SURF_BARK_OAK,
  SURF_BARK_BIRCH,
  SURF_BARK_PINE,
  SURF_LEAF_BROAD,
  SURF_NEEDLE,
  SURF_GRAVEL,
  SURF_LICHEN,
  SURF_COUNT
};

struct Surface {
  float r, g, b;      /* linear albedo */
  float roughness;    /* base roughness */
  float f0;           /* dielectric specular reflectance at normal incidence */
  float translucency; /* 0..1 light transmitted through the surface */
  float anisotropy;   /* 0 = isotropic micro-structure, 1 = strongly directional */
};

/* Base reflectances are linear (no sRGB), which is what three.js expects for
   material colours. Roughness values follow the usual material-scan ranges for
   the same surface: dry mineral = 0.85-0.97, polished mineral = 0.55-0.75,
   waxy leaf = 0.45-0.65, fresh snow = 0.4-0.55. */
const Surface kSurface[SURF_COUNT] = {
  /* meadow grass  */ { 0.085f, 0.150f, 0.045f, 0.93f, 0.040f, 0.30f, 0.35f },
  /* dry grass     */ { 0.265f, 0.215f, 0.105f, 0.95f, 0.040f, 0.18f, 0.35f },
  /* loam soil     */ { 0.125f, 0.098f, 0.070f, 0.97f, 0.038f, 0.00f, 0.10f },
  /* dry sand      */ { 0.430f, 0.375f, 0.265f, 0.88f, 0.040f, 0.06f, 0.25f },
  /* granite       */ { 0.320f, 0.310f, 0.300f, 0.60f, 0.045f, 0.00f, 0.12f },
  /* basalt        */ { 0.092f, 0.092f, 0.098f, 0.74f, 0.045f, 0.00f, 0.12f },
  /* sandstone     */ { 0.395f, 0.300f, 0.198f, 0.82f, 0.042f, 0.00f, 0.20f },
  /* snow          */ { 0.830f, 0.860f, 0.900f, 0.46f, 0.018f, 0.55f, 0.05f },
  /* oak bark      */ { 0.072f, 0.055f, 0.040f, 0.96f, 0.030f, 0.00f, 0.70f },
  /* birch bark    */ { 0.560f, 0.545f, 0.505f, 0.90f, 0.032f, 0.02f, 0.55f },
  /* pine bark     */ { 0.088f, 0.062f, 0.045f, 0.96f, 0.030f, 0.00f, 0.72f },
  /* broadleaf     */ { 0.052f, 0.118f, 0.032f, 0.55f, 0.036f, 0.62f, 0.45f },
  /* needle        */ { 0.030f, 0.062f, 0.026f, 0.62f, 0.034f, 0.34f, 0.35f },
  /* gravel        */ { 0.215f, 0.205f, 0.192f, 0.86f, 0.042f, 0.00f, 0.05f },
  /* lichen        */ { 0.165f, 0.198f, 0.108f, 0.84f, 0.035f, 0.05f, 0.15f }
};

/* ------------------------------------------------------------------ */
/* Detail kinds — keep in sync with FELandscapeRealism.DETAIL_KINDS.   */
/* ------------------------------------------------------------------ */
enum DetailKind {
  DET_TURF = 0,
  DET_LOAM,
  DET_ROCK,
  DET_SNOW,
  DET_SAND,
  DET_BARK,
  DET_LEAF,
  DET_GRAVEL,
  DET_RIPPLE,
  DET_LAVA,
  DET_MOSS,
  DET_COUNT
};

constexpr int kMaxDetail = 512;
/* Four megabytes of normal/roughness texels, produced on demand for the size
   the caller asked for. Only the landscaping studio's surface detail map needs
   it, so it is taken from the lazy heap instead of being reserved by every
   session. */
static float* gDetail = nullptr;
static float* gDetailHeight = nullptr;
static uint32_t gDetailCap = 0;
static int gDetailW = 0, gDetailH = 0;

static bool ensure_detail(uint32_t texels) {
  if (gDetail != nullptr && gDetailCap >= texels) return true;
  gDetail = reinterpret_cast<float*>(fe::heap::alloc(texels * 4u * 4u, 16));
  if (gDetail == nullptr) return false;
  gDetailHeight = reinterpret_cast<float*>(fe::heap::alloc(texels * 4u, 16));
  if (gDetailHeight == nullptr) return false;
  gDetailCap = texels;
  gDetailW = 0;
  gDetailH = 0;
  return true;
}

/* ------------------------------------------------------------------ */
/* Periodic noise: every lattice frequency is an integer, so the tile   */
/* wraps exactly in both axes.                                          */
/* ------------------------------------------------------------------ */
inline uint32_t hash2(int x, int y, uint32_t s) {
  uint32_t h = uint32_t(x) * 374761393u + uint32_t(y) * 668265263u + (s + 0x9e3779b9u) * 1442695041u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

inline float hashf(int x, int y, uint32_t s) {
  return float(hash2(x, y, s) & 0xffffffu) * (1.0f / 16777215.0f);
}

inline int wrapi(int v, int p) {
  if (p <= 0) return 0;
  const int m = v % p;
  return m < 0 ? m + p : m;
}

inline float pnoise(float x, float y, int px, int py, uint32_t s) {
  const int xi = int(floorf(x)), yi = int(floorf(y));
  float fx = x - float(xi), fy = y - float(yi);
  fx = fx * fx * (3.f - 2.f * fx);
  fy = fy * fy * (3.f - 2.f * fy);
  const int x0 = wrapi(xi, px), x1 = wrapi(xi + 1, px);
  const int y0 = wrapi(yi, py), y1 = wrapi(yi + 1, py);
  const float a = hashf(x0, y0, s), b = hashf(x1, y0, s);
  const float c = hashf(x0, y1, s), d = hashf(x1, y1, s);
  return lerpf(lerpf(a, b, fx), lerpf(c, d, fx), fy);
}

/* Value-noise FBM whose octave frequencies are 4, 8, 16 ... times `base`. */
inline float pfbm(float u, float v, int base, uint32_t s, int octaves) {
  float sum = 0.f, amp = 0.5f, norm = 0.f;
  int f = base < 1 ? 1 : base;
  for (int i = 0; i < octaves; ++i) {
    sum += amp * pnoise(u * float(f), v * float(f), f, f, s + uint32_t(i) * 131u);
    norm += amp;
    amp *= 0.5f;
    f *= 2;
  }
  return norm > 0.f ? sum / norm : 0.f;
}

inline float ridged(float n) { return 1.f - absf(n * 2.f - 1.f); }

/* Periodic Worley cell noise: returns distance to the nearest feature point
   normalised into the cell (0 at the centre, 1 at the cell edge). */
inline float pcell(float u, float v, int cells, uint32_t s) {
  const float x = u * float(cells), y = v * float(cells);
  const int cx = int(floorf(x)), cy = int(floorf(y));
  float best = 8.f;
  for (int j = -1; j <= 1; ++j) {
    for (int i = -1; i <= 1; ++i) {
      const int gx = cx + i, gy = cy + j;
      const int wx = wrapi(gx, cells), wy = wrapi(gy, cells);
      const float fx = (float(gx) + hashf(wx, wy, s)) / float(cells);
      const float fy = (float(gy) + hashf(wx, wy, s + 7919u)) / float(cells);
      float dx = x / float(cells) - fx, dy = y / float(cells) - fy;
      if (dx > 0.5f) dx -= 1.f;
      if (dx < -0.5f) dx += 1.f;
      if (dy > 0.5f) dy -= 1.f;
      if (dy < -0.5f) dy += 1.f;
      const float d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return clampf(sqrtf(best) * float(cells), 0.f, 1.f);
}

/* ------------------------------------------------------------------ */
/* Micro-structure height per surface kind, in [0,1].                  */
/* ------------------------------------------------------------------ */
float detailHeight(int kind, float u, float v, uint32_t s) {
  switch (kind) {
    case DET_TURF: {
      /* Turf: clumped canopy, individual blades standing across the tile,
         small tufts on top of the clumps. */
      const float clump = pfbm(u, v, 4, s, 4);
      const float blades = pnoise(u * 128.f, v * 16.f, 128, 16, s ^ 0x9e37u);
      const float tufts = pnoise(u * 24.f, v * 24.f, 24, 24, s + 91u);
      return 0.52f * clump + 0.32f * blades + 0.16f * tufts;
    }
    case DET_LOAM: {
      /* Ploughed soil: clods, then hairline cracks between them. */
      const float clod = pfbm(u, v, 5, s + 3u, 4);
      const float cracks = powf(ridged(pfbm(u, v, 9, s + 11u, 3)), 5.f);
      const float grit = pcell(u, v, 96, s + 17u);
      return 0.55f * clod + 0.30f * cracks + 0.15f * grit;
    }
    case DET_ROCK: {
      /* Sedimentary bedding planes (stepped layers), blocky fracture and a
         fine mineral grain. A real rock face is mostly these three scales. */
      const float beddingWarp = pnoise(u * 3.f, v * 26.f, 3, 26, s + 7u);
      const float strata = floorf(v * 9.f + beddingWarp * 1.35f) / 9.f;
      const float block = pnoise(u * 7.f, v * 7.f, 7, 7, s + 13u);
      const float cracks = powf(ridged(pfbm(u, v, 8, s + 19u, 4)), 6.f);
      const float grain = pnoise(u * 180.f, v * 180.f, 180, 180, s + 29u);
      return 0.40f * strata + 0.22f * block + 0.26f * cracks + 0.12f * grain;
    }
    case DET_SNOW: {
      /* Wind-packed snow: sastrugi ridges along the wind axis, a soft crust
         and the granule cells that drive the specular glitter. */
      const float sastrugi = ridged(pnoise(u * 4.f, v * 13.f, 4, 13, s + 5u));
      const float crust = pfbm(u, v, 6, s + 23u, 4);
      const float grain = pcell(u, v, 112, s + 31u);
      return 0.48f * sastrugi + 0.30f * crust + 0.22f * grain;
    }
    case DET_SAND: {
      /* Aeolian ripples: crests slightly sinuous, plus grain relief. */
      const float warp = pfbm(u, v, 3, s + 2u, 3);
      const float ripple = 0.5f + 0.5f * sinf(kTwoPi * (v * 26.f + warp * 1.8f));
      const float grains = pcell(u, v, 128, s + 37u);
      return 0.55f * ripple + 0.25f * warp + 0.20f * grains;
    }
    case DET_BARK: {
      /* Bark: long vertical fibres (high frequency across the trunk, low along
         it), secondary micro-fibres and the raised plates of mature bark. */
      const float fibre = pnoise(u * 80.f, v * 7.f, 80, 7, s + 41u);
      const float micro = pnoise(u * 170.f, v * 11.f, 170, 11, s + 43u);
      const float plates = floorf(ridged(pfbm(u, v, 10, s + 47u, 4)) * 6.f) / 6.f;
      return 0.46f * fibre + 0.24f * micro + 0.30f * plates;
    }
    case DET_LEAF: {
      /* Leaf blade: midrib, secondary veins at an angle, areole cells between
         them (the network visible when a leaf is back-lit). */
      const float mid = 1.f - smoothstepf(0.f, 0.035f, absf(u - 0.5f));
      const float va = absf(sinf(kPi * (v * 9.f + u * 4.f)));
      const float vb = absf(sinf(kPi * (v * 9.f - u * 4.f)));
      const float veins = (1.f - smoothstepf(0.f, 0.16f, va)) + (1.f - smoothstepf(0.f, 0.16f, vb));
      const float areole = pcell(u, v, 48, s + 53u);
      return 0.30f * mid + 0.36f * clampf(veins * 0.5f, 0.f, 1.f) + 0.34f * areole;
    }
    case DET_GRAVEL: {
      /* Rounded river gravel: one dome per cell, packed tightly. */
      const float cell = pcell(u, v, 26, s + 59u);
      const float dome = 1.f - clampf(cell * 1.35f, 0.f, 1.f);
      const float grit = pnoise(u * 190.f, v * 190.f, 190, 190, s + 61u);
      return 0.78f * (dome * dome) + 0.22f * grit;
    }
    case DET_RIPPLE: {
      /* Water micro-relief: two crossing wave trains (capillary + gravity). */
      const float warp = pfbm(u, v, 4, s + 67u, 3);
      const float a = sinf(kTwoPi * (u * 17.f + v * 5.f + warp));
      const float b = sinf(kTwoPi * (u * 6.f - v * 21.f + warp * 0.7f));
      return 0.5f + 0.25f * (a + b);
    }
    case DET_LAVA: {
      /* Cooled crust split by glowing fissures. */
      const float crust = pfbm(u, v, 6, s + 71u, 4);
      const float fissure = powf(ridged(pfbm(u, v, 5, s + 73u, 4)), 7.f);
      return 0.72f * crust + 0.28f * (1.f - fissure);
    }
    case DET_MOSS: {
      /* Moss: soft cushions with tiny upright fronds. */
      const float cushion = pfbm(u, v, 5, s + 79u, 4);
      const float fronds = pnoise(u * 150.f, v * 40.f, 150, 40, s + 83u);
      return 0.62f * cushion + 0.38f * fronds;
    }
    default:
      return pfbm(u, v, 6, s, 4);
  }
}

/* Roughness response per kind: how much the micro-structure changes gloss.
   Wind-polished snow and wet sand are smoother on the crests, bark and loam
   stay matte everywhere. */
inline float detailRoughness(int kind, float base, float h, float slope) {
  switch (kind) {
    case DET_SNOW:   return clampf(base + (0.5f - h) * 0.10f + slope * 0.22f, 0.30f, 0.62f);
    case DET_SAND:   return clampf(base + (h - 0.5f) * 0.08f - slope * 0.10f, 0.72f, 0.98f);
    case DET_LEAF:   return clampf(base + (0.5f - h) * 0.22f, 0.36f, 0.78f);
    case DET_ROCK:   return clampf(base + (0.5f - h) * 0.18f + slope * 0.16f, 0.42f, 0.98f);
    case DET_BARK:   return clampf(base + (0.5f - h) * 0.08f, 0.82f, 1.00f);
    case DET_RIPPLE: return clampf(base + (0.5f - h) * 0.05f, 0.02f, 0.22f);
    case DET_GRAVEL: return clampf(base + (0.5f - h) * 0.14f, 0.66f, 0.96f);
    case DET_LAVA:   return clampf(base + (0.5f - h) * 0.30f, 0.28f, 0.95f);
    default:         return clampf(base + (0.5f - h) * 0.10f + slope * 0.08f, 0.55f, 1.00f);
  }
}

} // namespace

extern "C" {

/* -------------------------------------------------------------------------
 * Physical surface properties.
 * out[0..2] linear albedo, out[3] roughness, out[4] F0,
 * out[5] translucency, out[6] anisotropy, out[7] reserved (mask).
 * wet: 0 = dry, 1 = water film (rain, shoreline, puddles)
 * snowAge: days since snowfall (grain growth -> albedo loss)
 * lichen: 0..1 coverage (rock only, but harmless everywhere)
 * ------------------------------------------------------------------------- */
FE_EXPORT int32_t fe_surface_pbr(int32_t surface, float wet, float snow_age, float lichen, float* out) {
  if (!out) return 0;
  const int id = (surface < 0 || surface >= SURF_COUNT) ? 0 : int(surface);
  const Surface& s = kSurface[id];

  float r = s.r, g = s.g, b = s.b;
  float rough = s.roughness, f0 = s.f0, trans = s.translucency;

  /* Snow metamorphism: grain radius grows as sqrt(age), and the absorption
     cross-section rises with grain radius and impurity load. */
  if (id == SURF_SNOW) {
    const float age = clampf(snow_age, 0.f, 400.f);
    const float radius = clampf(50.f + 26.f * sqrtf(age), 50.f, 2500.f);
    const float impurity = clampf(lichen, 0.f, 1.f); /* reuse the slot as soot/dust */
    const float k = 0.00022f + 0.00058f * impurity;
    const float atten = expf(-k * (radius - 50.f));
    r *= atten; g *= atten; b *= atten;
    rough += 0.16f * smoothstepf(0.f, 200.f, age);
    trans = lerpf(trans, 0.28f, smoothstepf(0.f, 200.f, age));
  }

  /* Lichen / moss cover on rock and soil: a matte biological layer with its
     own pigment, which is what makes a granite face read as "outside". */
  if (id != SURF_SNOW && lichen > 0.f) {
    const float c = clampf(lichen, 0.f, 1.f);
    r = lerpf(r, kSurface[SURF_LICHEN].r, c);
    g = lerpf(g, kSurface[SURF_LICHEN].g, c);
    b = lerpf(b, kSurface[SURF_LICHEN].b, c);
    rough = lerpf(rough, 0.86f, c);
    trans = lerpf(trans, 0.05f, c);
  }

  /* Rain / wet ground: a water film fills the micro-pores, so the surface
     darkens (less internal scattering) and becomes much glossier. */
  const float w = clampf(wet, 0.f, 1.f);
  if (w > 0.f) {
    const float film = smoothstepf(0.f, 1.f, w);
    const float darken = 1.f - 0.46f * film;
    /* Water absorbs the red end first, so the remaining light cools slightly. */
    r *= darken * (1.f - 0.05f * film);
    g *= darken;
    b *= darken * (1.f + 0.04f * film);
    rough = lerpf(rough, 0.045f, powf(film, 1.4f));
    f0 = lerpf(f0, 0.055f, film * 0.65f);
  }

  out[0] = clampf(r, 0.f, 1.f);
  out[1] = clampf(g, 0.f, 1.f);
  out[2] = clampf(b, 0.f, 1.f);
  out[3] = clampf(rough, 0.f, 1.f);
  out[4] = clampf(f0, 0.f, 1.f);
  out[5] = clampf(trans, 0.f, 1.f);
  out[6] = clampf(s.anisotropy, 0.f, 1.f);
  out[7] = 1.f;
  return 1;
}

FE_EXPORT int32_t fe_surface_count(void) { return SURF_COUNT; }

/* -------------------------------------------------------------------------
 * Tileable micro-structure. Fills gDetail with width*height texels of
 * (normal.x, normal.y, normal.z, roughness) in [0,1] range, ready to be
 * uploaded as an RGBA8 normal/roughness map.
 * Returns 1 on success, 0 for an invalid size.
 * ------------------------------------------------------------------------- */
FE_EXPORT int32_t fe_surface_detail(int32_t kind, int32_t width, int32_t height, uint32_t seed, float strength) {
  if (width <= 0 || height <= 0 || width > kMaxDetail || height > kMaxDetail) return 0;
  if (!ensure_detail(uint32_t(width) * uint32_t(height))) return -1;
  const int k = (kind < 0 || kind >= DET_COUNT) ? int(DET_TURF) : int(kind);
  const float s = clampf(strength <= 0.f ? 1.f : strength, 0.05f, 4.f);
  const float du = 1.f / float(width), dv = 1.f / float(height);
  const uint32_t salt = seed * 2654435761u + uint32_t(k) * 97u + 0x51ed270bu;
  const float baseRough = [&]() -> float {
    switch (k) {
      case DET_TURF: return 0.93f;
      case DET_LOAM: return 0.96f;
      case DET_ROCK: return 0.72f;
      case DET_SNOW: return 0.46f;
      case DET_SAND: return 0.89f;
      case DET_BARK: return 0.93f;
      case DET_LEAF: return 0.55f;
      case DET_GRAVEL: return 0.86f;
      case DET_RIPPLE: return 0.08f;
      case DET_LAVA: return 0.62f;
      case DET_MOSS: return 0.90f;
      default: return 0.90f;
    }
  }();

  /* Two passes, not five noise evaluations per texel.
   *
   * The height field is a pure function of (kind, u, v, salt), and a Sobel
   * difference only ever reads the four neighbouring texels, so the whole
   * gradient is a lookup once the field itself has been evaluated once per
   * texel. The previous version evaluated the octave stack five times per
   * texel — centre, left, right, down, up — which cost 76 ms at 256x256 and
   * 303 ms at 512x512 on a desktop, an order of magnitude worse on a phone,
   * for a texture the landscaping studio paints during load.
   *
   * The wrapped neighbours are the same texels the fractional coordinates
   * used to land on: u - du is the previous column (last column at the left
   * edge) and u + du the next one (first column at the right edge), so the
   * output is bit-identical, which tests/surface-detail.test.mjs checks
   * against the hashes recorded from the five-sample version. */
  for (int j = 0; j < height; ++j) {
    const float v = (float(j) + 0.5f) / float(height);
    for (int i = 0; i < width; ++i) {
      const float u = (float(i) + 0.5f) / float(width);
      gDetailHeight[j * width + i] = detailHeight(k, u, v, salt);
    }
  }

  for (int j = 0; j < height; ++j) {
    const int jD = (j == 0) ? (height - 1) : (j - 1);
    const int jU = (j + 1 == height) ? 0 : (j + 1);
    for (int i = 0; i < width; ++i) {
      const int iL = (i == 0) ? (width - 1) : (i - 1);
      const int iR = (i + 1 == width) ? 0 : (i + 1);
      const float h = gDetailHeight[j * width + i];
      const float hx = gDetailHeight[j * width + iR] - gDetailHeight[j * width + iL];
      const float hy = gDetailHeight[jU * width + i] - gDetailHeight[jD * width + i];

      /* Height differences become a tangent-space normal. The 0.5 factor keeps
         the tangent basis similar to a classic Sobel normal map. */
      const float nx = -hx * s * 6.0f;
      const float ny = -hy * s * 6.0f;
      const float nz = 1.0f;
      const float inv = 1.0f / sqrtf(nx * nx + ny * ny + nz * nz);
      const float slope = sqrtf(hx * hx + hy * hy);
      const float rough = detailRoughness(k, baseRough, h, slope * s);

      const int o = (j * width + i) * 4;
      gDetail[o + 0] = nx * inv * 0.5f + 0.5f;
      gDetail[o + 1] = ny * inv * 0.5f + 0.5f;
      gDetail[o + 2] = nz * inv * 0.5f + 0.5f;
      gDetail[o + 3] = rough;
    }
  }
  gDetailW = int(width);
  gDetailH = int(height);
  return 1;
}

FE_EXPORT uint32_t fe_surface_detail_ptr(void) {
  return uint32_t(reinterpret_cast<uintptr_t>(gDetail));
}

FE_EXPORT int32_t fe_surface_detail_size(void) { return gDetailW * gDetailH; }

/* -------------------------------------------------------------------------
 * Jerlov water types. out = absorption R,G,B (1/m) then scattering R,G,B.
 * 0 = I (clear ocean), 1 = II, 2 = 1C (coastal), 3 = 3C, 4 = 5C (turbid)
 * ------------------------------------------------------------------------- */
FE_EXPORT int32_t fe_water_optical(int32_t type, float* out) {
  if (!out) return 0;
  /* Absorption in m^-1 at 650 nm (red), 550 nm (green) and 450 nm (blue).
     Red goes first: that is why everything below a few metres reads blue. The
     turbid types add CDOM (yellow substance) absorption in the blue, which is
     what turns an estuary green-brown instead of blue. */
  static const float kAbsorb[5][3] = {
    { 0.3050f, 0.0545f, 0.0145f },  /* I    — open ocean */
    { 0.3500f, 0.0750f, 0.0200f },  /* II   — clear coastal */
    { 0.4200f, 0.1100f, 0.0450f },  /* 1C   — coastal */
    { 0.5500f, 0.2000f, 0.1150f },  /* 3C   — turbid coastal */
    { 0.7200f, 0.3600f, 0.3000f }   /* 5C   — harbour / estuary */
  };
  static const float kScatter[5] = { 0.0030f, 0.0100f, 0.0500f, 0.3500f, 1.2000f };
  const int t = (type < 0 || type > 4) ? 0 : int(type);
  out[0] = kAbsorb[t][0];
  out[1] = kAbsorb[t][1];
  out[2] = kAbsorb[t][2];
  out[3] = kScatter[t];
  out[4] = kScatter[t] * 1.08f;
  out[5] = kScatter[t] * 0.92f;
  return 1;
}

/* -------------------------------------------------------------------------
 * Cox–Munk (1954) mean-square slope -> GGX roughness.
 * sigma^2 = 0.003 + 5.12e-3 * U  (U in m/s, upwind/downwind average)
 * The slope is mapped with a 1.6 gain so a calm sea reads glossy and a
 * 20 m/s storm reads matte, matching the material-scan range for water.
 * ------------------------------------------------------------------------- */
FE_EXPORT float fe_surface_wind_roughness(float wind_mps) {
  const float u = clampf(wind_mps, 0.f, 40.f);
  const float ms = 0.003f + 0.00512f * u;
  return clampf(sqrtf(ms) * 1.6f, 0.030f, 0.600f);
}

/* Snow albedo after grain growth + impurity loading (Warren/Wiscombe-style
   single-scatter attenuation, exposed separately for the snow shader). */
FE_EXPORT float fe_surface_snow_albedo(float base_albedo, float age_days, float impurity) {
  const float radius = clampf(50.f + 26.f * sqrtf(clampf(age_days, 0.f, 400.f)), 50.f, 2500.f);
  const float k = 0.00022f + 0.00058f * clampf(impurity, 0.f, 1.f);
  return clampf(base_albedo * expf(-k * (radius - 50.f)), 0.f, 1.f);
}

} // extern "C"
