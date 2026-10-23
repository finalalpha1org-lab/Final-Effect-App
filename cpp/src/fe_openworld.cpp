#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

/* Open World kernels: the streamed chunk sampler, the chunk planner that feeds
   the scheduler, and the hydrology solver (priority-flood drainage + river
   tracing). JS keeps the worker messaging, instancing and GPU uploads. */
namespace {
using namespace fe;

constexpr uint32_t OW_MAX_SEG = 192;
constexpr uint32_t OW_MAX_VERTS = (OW_MAX_SEG + 1) * (OW_MAX_SEG + 1);

constexpr uint32_t OW_MAX_CHUNKS = 2048;

constexpr uint32_t HYDRO_MAX_N = 320;
constexpr uint32_t HYDRO_MAX_CELLS = HYDRO_MAX_N * HYDRO_MAX_N;
constexpr uint32_t RIVER_MAX_POINTS = 49152;
constexpr uint32_t RIVER_MAX_COUNT = 48;

static float owHeights[OW_MAX_VERTS];
static float owSurfaces[OW_MAX_VERTS * 12];
static int32_t owPlanCells[OW_MAX_CHUNKS * 3];
static float owPlanDist[OW_MAX_CHUNKS];

static float hydroHeights[HYDRO_MAX_CELLS];
static float hydroF[HYDRO_MAX_CELLS];
static int32_t hydroParent[HYDRO_MAX_CELLS];
static uint8_t hydroClosed[HYDRO_MAX_CELLS];
static int32_t hydroUsed[HYDRO_MAX_CELLS];
static uint32_t hydroHeap[HYDRO_MAX_CELLS];
static float riverPoints[RIVER_MAX_POINTS * 2];
static int32_t riverMeta[RIVER_MAX_COUNT * 6];
constexpr uint32_t LOD_MAX = 65536;
static int8_t lodOut[LOD_MAX];

static float owSeed = 1.f, owMountain = 0.f, owWater = 0.f, owWorldHalf = 6000.f;
static float owSea = 0.f, owBlend = 0.f;
static float owBiomeMix[4] = {1.f, 1.f, 1.f, 1.f};

bool finite(float x) { return isfinitef(x); }

float owHash(float x, float z, float seed) {
  const float v = sinf(x * 127.1f + z * 311.7f + seed * 74.7f) * 43758.5453f;
  return v - floorf(v);
}
float owNoise(float x, float z, float seed) {
  const int ix = int(floorf(x)), iz = int(floorf(z));
  const float fx = x - float(ix), fz = z - float(iz);
  const float u = fx * fx * (3.f - 2.f * fx), v = fz * fz * (3.f - 2.f * fz);
  const float a = lerpf(owHash(float(ix), float(iz), seed), owHash(float(ix + 1), float(iz), seed), u);
  const float b = lerpf(owHash(float(ix), float(iz + 1), seed), owHash(float(ix + 1), float(iz + 1), seed), u);
  return lerpf(a, b, v);
}
float owFbm(float x, float z, float seed, int octaves) {
  float a = .55f, f = 1.f, sum = 0.f, norm = 0.f;
  for (int i = 0; i < octaves; i++) {
    sum += (owNoise(x * f + 17.1f * float(i), z * f - 9.7f * float(i), seed + float(i) * 13.17f) - .5f) * 2.f * a;
    norm += a; a *= .5f; f *= 2.07f;
  }
  return norm > 0.f ? sum / norm : 0.f;
}
float owRidge(float x, float z, float seed) { return 1.f - absf(owFbm(x, z, seed, 4)); }

float owHeightAt(float x, float z) {
  const float seed = owSeed, scale = clampf(owMountain, 0.f, 100.f), water = clampf(owWater, 0.f, 100.f) / 100.f;
  const float wx = (owNoise(x * .012f + seed * .13f + 41.f, z * .012f + seed * .07f + 13.f, seed) - .5f) * 10.f;
  const float wz = (owNoise(x * .012f + seed * .03f + 17.f, z * .012f + seed * .17f + 61.f, seed + 1.f) - .5f) * 10.f;
  float n = 0.f, a = .56f, f = .026f, r = 0.f, ra = .55f, rf = .035f;
  for (int o = 0; o < 4; o++) {
    n += (owNoise((x + wx) * f + float(o) * 17.f, (z + wz) * f + float(o) * 11.f, seed) - .5f) * a;
    const float q = owNoise((x + wx * .4f) * rf + 31.f + float(o) * 7.f, (z + wz * .4f) * rf - 17.f, seed + 3.f);
    r += (1.f - absf(q * 2.f - 1.f)) * ra;
    a *= .5f; f *= 2.05f; ra *= .5f; rf *= 2.05f;
  }
  r = r / 1.03125f - .5f;
  const float base = n * (24.f + scale * .32f) * 1.65f + r * (20.f + scale * .3f) * .6f + 1.6f;
  const float continental = clampf(.5f + .5f * owFbm(x * .00048f + seed * .001f, z * .00048f - seed * .001f, seed + 23.f, 4), 0.f, 1.f);
  const float regional = smoothstepf(.34f + water * .34f, .54f + water * .34f, continental);
  const float edgeMask = 1.f - smoothstepf(.78f, .98f, sqrtf(x * x + z * z) / owWorldHalf);
  const float coreLand = clampf(.88f - water * .46f, 0.f, .95f);
  const float land = edgeMask * maxf(coreLand, regional);
  const float massif = powf(maxf(0.f, owRidge(x * .0025f + seed * .001f, z * .0025f, seed + 37.f) - .31f), 1.45f) * (scale * 1.75f);
  const float volcanic = powf(maxf(0.f, owFbm(x * .0018f + seed * .003f + 7.f, z * .0018f - seed * .002f - 5.f, seed + 53.f, 4) - .35f), 1.7f) * (scale * .5f);
  const float continentalLift = 34.f + scale * .42f, deepOcean = 34.f + water * 45.f;
  const float coastalRelief = base * (.04f + .96f * land * land * land);
  return coastalRelief + land * (massif + volcanic + continentalLift) - (1.f - land) * deepOcean;
}

void owBiomeWeights(float x, float z, float h, float* out) {
  const float seed = owSeed;
  const float elev = clampf((h - owSea) / 220.f, 0.f, 1.f);
  const float temp = clampf(.5f + .5f * owFbm(x * .00072f + seed * .001f + 91.f, z * .00072f - seed * .002f, seed + 67.f, 4), 0.f, 1.f);
  const float moist = clampf(.5f + .5f * owFbm(x * .00105f - seed * .002f, z * .00105f + seed * .001f + 37.f, seed + 89.f, 4), 0.f, 1.f);
  const float tect = clampf(.5f + .5f * owFbm(x * .0019f + seed * .003f - 13.f, z * .0019f - seed * .002f + 47.f, seed + 107.f, 4), 0.f, 1.f);
  float scores[4] = {
    .4f + moist * .38f + (1.f - elev) * .12f,
    .08f + elev * .7f + (1.f - temp) * .42f,
    .06f + temp * .56f + (1.f - moist) * .78f,
    .04f + tect * .8f + elev * .12f
  };
  float mx = scores[0];
  for (int i = 1; i < 4; i++) if (scores[i] > mx) mx = scores[i];
  const float softness = .055f + owBlend * .4f;
  float sum = 0.f;
  for (int i = 0; i < 4; i++) {
    out[i] = expf((scores[i] - mx) / softness) * clampf(owBiomeMix[i], .02f, 4.f);
    sum += out[i];
  }
  if (sum <= 0.f) sum = 1.f;
  for (int i = 0; i < 4; i++) out[i] /= sum;
}

void owSurfaceWeights(float x, float z, float h, float slope, const float* bio, float* out) {
  const float sea = owSea;
  const float shore = (1.f - smoothstepf(sea + 1.f, sea + 18.f, h)) * .66f;
  const float steep = smoothstepf(.22f, .95f, slope);
  const float desert = bio[2], alpine = bio[1], volcano = bio[3];
  const float hot = clampf(.5f + .5f * owFbm(x * .005f, z * .005f, owSeed + 211.f, 3), 0.f, 1.f);
  float beach = shore * .35f, shoreMat = shore * .22f;
  float rock = clampf(steep * .62f + alpine * clampf((h - sea) / 210.f, 0.f, 1.f) * .18f + volcano * steep * .24f, 0.f, .72f);
  float sand = clampf(shore * .55f + desert * .22f, 0.f, .58f);
  float lava = clampf(volcano * hot * .26f, 0.f, .22f);
  float magma = clampf(volcano * hot * .13f, 0.f, .12f);
  float pebbles = rock * .14f;
  float overlays = rock + sand + lava + magma + beach + shoreMat + pebbles;
  if (overlays > .9f) {
    const float k = .9f / overlays;
    rock *= k; sand *= k; lava *= k; magma *= k; beach *= k; shoreMat *= k; pebbles *= k;
    overlays = .9f;
  }
  for (int i = 0; i < 12; i++) out[i] = 0.f;
  const float retain = 1.f - overlays;
  for (int i = 0; i < 4; i++) out[i] = bio[i] * retain;
  out[4] = shoreMat;
  out[5] = rock - pebbles;
  out[7] = sand;
  out[8] = lava;
  out[9] = magma;
  out[10] = pebbles;
  out[11] = beach;
  float total = 0.f;
  for (int i = 0; i < 12; i++) total += out[i];
  if (total <= 0.f) total = 1.f;
  for (int i = 0; i < 12; i++) out[i] /= total;
}

float hydroSample(float x, float z, uint32_t n, float span) {
  const float step = span / float(n - 1);
  const float half = span * .5f;
  const float u = clampf((x + half) / step, 0.f, float(n) - 1.001f);
  const float v = clampf((z + half) / step, 0.f, float(n) - 1.001f);
  const uint32_t i = uint32_t(u), j = uint32_t(v);
  const float a = u - float(i), b = v - float(j), k = float(j * n + i);
  const uint32_t ki = uint32_t(k);
  return lerpf(lerpf(hydroHeights[ki], hydroHeights[ki + 1], a),
               lerpf(hydroHeights[ki + n], hydroHeights[ki + n + 1], a), b);
}

uint32_t hydroN = 0;
float hydroSpan = 0.f, hydroSea = 0.f;

void heapPush(uint32_t* heap, uint32_t& size, uint32_t idx) {
  uint32_t c = size++;
  while (c > 0) {
    const uint32_t p = (c - 1) >> 1;
    if (hydroF[heap[p]] <= hydroF[idx]) break;
    heap[c] = heap[p];
    c = p;
  }
  heap[c] = idx;
}
uint32_t heapPop(uint32_t* heap, uint32_t& size) {
  const uint32_t top = heap[0];
  const uint32_t last = heap[--size];
  uint32_t c = 0;
  for (;;) {
    uint32_t l = 2 * c + 1;
    if (l >= size) break;
    if (l + 1 < size && hydroF[heap[l + 1]] < hydroF[heap[l]]) l++;
    if (hydroF[heap[l]] >= hydroF[last]) break;
    heap[c] = heap[l];
    c = l;
  }
  heap[c] = last;
  return top;
}
uint32_t hydroRngState = 1u;
float hydroRandom() {
  hydroRngState ^= hydroRngState << 13;
  hydroRngState ^= hydroRngState >> 17;
  hydroRngState ^= hydroRngState << 5;
  return float(hydroRngState) / 4294967296.f;
}
} // namespace

extern "C" {
float* fe_ow_height_ptr() { return owHeights; }
float* fe_ow_surface_ptr() { return owSurfaces; }
int32_t* fe_ow_plan_cells_ptr() { return owPlanCells; }
float* fe_ow_plan_distance_ptr() { return owPlanDist; }
int32_t* fe_ow_river_meta_ptr() { return riverMeta; }
float* fe_ow_river_points_ptr() { return riverPoints; }
float* fe_ow_hydro_input_ptr() { return hydroHeights; }
float* fe_ow_hydro_field_ptr() { return hydroF; }
int8_t* fe_lod_out_ptr() { return lodOut; }

int32_t fe_ow_set_params(float seed, float mountain_height, float water_coverage, float world_half,
                         float sea_level, float blend, const float* biome_mix) {
  if (!finite(seed) || !finite(mountain_height) || !finite(water_coverage) || !finite(world_half) ||
      !finite(sea_level) || !finite(blend) || !biome_mix) return -1;
  if (world_half <= 0.f || world_half > 50000.f) return -1;
  if (mountain_height < 0.f || mountain_height > 100.f) return -1;
  if (water_coverage < 0.f || water_coverage > 100.f) return -1;
  owSeed = seed; owMountain = mountain_height; owWater = water_coverage;
  owWorldHalf = world_half; owSea = sea_level; owBlend = clampf(blend, 0.f, 1.f);
  for (int i = 0; i < 4; i++) owBiomeMix[i] = clampf(biome_mix[i], .02f, 4.f);
  return 0;
}

float fe_ow_height_at(float x, float z) {
  if (!finite(x) || !finite(z)) return 0.f;
  return owHeightAt(x, z);
}

int32_t fe_ow_biome_weights_at(float x, float z, float h, float* out4) {
  if (!out4 || !finite(x) || !finite(z) || !finite(h)) return -1;
  owBiomeWeights(x, z, h, out4);
  return 0;
}

int32_t fe_ow_height_grid(uint32_t segments, float origin_x, float origin_z, float chunk_size) {
  if (segments < 8 || segments > OW_MAX_SEG) return -1;
  if (!finite(origin_x) || !finite(origin_z) || !finite(chunk_size) || chunk_size <= 0.f) return -1;
  const uint32_t row = segments + 1;
  const float step = chunk_size / float(segments);
  for (uint32_t j = 0; j < row; j++) {
    const float z = origin_z - chunk_size * .5f + float(j) * step;
    for (uint32_t i = 0; i < row; i++) {
      const float x = origin_x - chunk_size * .5f + float(i) * step;
      owHeights[j * row + i] = owHeightAt(x, z);
    }
  }
  return int32_t(row * row);
}

int32_t fe_ow_surface_grid(uint32_t segments, float origin_x, float origin_z, float chunk_size) {
  if (segments < 8 || segments > OW_MAX_SEG) return -1;
  if (!finite(origin_x) || !finite(origin_z) || !finite(chunk_size) || chunk_size <= 0.f) return -1;
  const uint32_t row = segments + 1;
  const float step = chunk_size / float(segments);
  const float inv = 1.f / (2.f * step);
  float bio[4], weights[12];
  for (uint32_t j = 0; j < row; j++) {
    const float z = origin_z - chunk_size * .5f + float(j) * step;
    for (uint32_t i = 0; i < row; i++) {
      const float x = origin_x - chunk_size * .5f + float(i) * step;
      const uint32_t k = j * row + i;
      const float h = owHeights[k];
      const float hl = owHeights[j * row + (i ? i - 1 : i)];
      const float hr = owHeights[j * row + (i + 1 < row ? i + 1 : i)];
      const float hd = owHeights[(j ? j - 1 : j) * row + i];
      const float hu = owHeights[(j + 1 < row ? j + 1 : j) * row + i];
      const float slope = sqrtf((hr - hl) * (hr - hl) + (hu - hd) * (hu - hd)) * inv;
      owBiomeWeights(x, z, h, bio);
      owSurfaceWeights(x, z, h, slope, bio, weights);
      for (int q = 0; q < 12; q++) owSurfaces[k * 12 + q] = weights[q];
    }
  }
  return int32_t(row * row * 12);
}

int32_t fe_ow_plan_chunks(int32_t cx, int32_t cz, uint32_t radius, float chunk_size, float world_half) {
  if (radius > 48 || !finite(chunk_size) || chunk_size <= 0.f || !finite(world_half)) return -1;
  uint32_t count = 0;
  const float edge = chunk_size * .5f;
  for (int32_t dz = -int32_t(radius); dz <= int32_t(radius); dz++) {
    for (int32_t dx = -int32_t(radius); dx <= int32_t(radius); dx++) {
      const int32_t ax = cx + dx, az = cz + dz;
      if (absf(float(ax) * chunk_size) - edge > world_half) continue;
      if (absf(float(az) * chunk_size) - edge > world_half) continue;
      if (count >= OW_MAX_CHUNKS) return int32_t(count);
      owPlanCells[count * 3] = ax;
      owPlanCells[count * 3 + 1] = az;
      owPlanCells[count * 3 + 2] = dx * dx + dz * dz;
      owPlanDist[count] = sqrtf(float(dx * dx + dz * dz)) * chunk_size;
      count++;
    }
  }
  /* Nearest-first ordering is the scheduler contract: insertion sort keeps the
     array small and avoids pulling a heap into the freestanding build. */
  for (uint32_t i = 1; i < count; i++) {
    const float d = owPlanDist[i];
    const int32_t a = owPlanCells[i * 3], b = owPlanCells[i * 3 + 1], r = owPlanCells[i * 3 + 2];
    uint32_t j = i;
    while (j > 0 && owPlanDist[j - 1] > d) {
      owPlanDist[j] = owPlanDist[j - 1];
      owPlanCells[j * 3] = owPlanCells[(j - 1) * 3];
      owPlanCells[j * 3 + 1] = owPlanCells[(j - 1) * 3 + 1];
      owPlanCells[j * 3 + 2] = owPlanCells[(j - 1) * 3 + 2];
      j--;
    }
    owPlanDist[j] = d;
    owPlanCells[j * 3] = a;
    owPlanCells[j * 3 + 1] = b;
    owPlanCells[j * 3 + 2] = r;
  }
  return int32_t(count);
}

int32_t fe_lod_classify(uint32_t count, const float* xyz, float cam_x, float cam_y, float cam_z,
                        float full_distance, uint32_t ground_cover) {
  if (!xyz || count > LOD_MAX) return -1;
  if (!finite(cam_x) || !finite(cam_y) || !finite(cam_z)) return -1;
  if (!finite(full_distance) || full_distance < 50.f || full_distance > 10000.f) return -1;
  const float far = ground_cover ? 8000.f : 14000.f;
  const float band = maxf(120.f, full_distance * 2.f);
  for (uint32_t i = 0; i < count; i++) {
    const float x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    if (!finite(x) || !finite(y) || !finite(z)) { lodOut[i] = -1; continue; }
    const float dx = x - cam_x, dy = y - cam_y, dz = z - cam_z;
    const float d = sqrtf(dx * dx + dy * dy + dz * dz);
    if (!(d < far)) { lodOut[i] = -1; continue; }
    const float h = owHash(x * .731f + 13.7f, z * .917f - 7.3f, 1.f);
    const float threshold = full_distance + h * band;
    lodOut[i] = d <= threshold ? 0 : 1;
  }
  return int32_t(count);
}

/* ---------------------------------------------------------------- */
/* Compacted visible-instance list                                   */
/* ---------------------------------------------------------------- */
/* The LoD call above answers "how far is this instance"; this one answers
 * "which instances are worth submitting at all" and writes a dense list of
 * their indices, so the bridge never has to walk the full set in JS. The six
 * frustum planes are extracted here (Gribb-Hartmann) from the column-major
 * view-projection matrix three.js already keeps, and a deterministic hash turns
 * the distance into a ground-cover density falloff — no flicker, because the
 * same instance always falls on the same side of the threshold. */
static uint32_t visIndex[LOD_MAX];
static uint32_t visCount = 0;
static uint8_t visTier[LOD_MAX];

extern "C" uint32_t* fe_lod_visible_index_ptr() { return visIndex; }
extern "C" uint8_t* fe_lod_visible_tier_ptr() { return visTier; }

inline void planeFrom(const float* m, int32_t row, float sign, float* out) {
  const float a = m[0 * 4 + 3] + sign * m[0 * 4 + row];
  const float b = m[1 * 4 + 3] + sign * m[1 * 4 + row];
  const float c = m[2 * 4 + 3] + sign * m[2 * 4 + row];
  const float d = m[3 * 4 + 3] + sign * m[3 * 4 + row];
  const float n = sqrtf(a * a + b * b + c * c);
  const float inv = n > 1e-8f ? 1.f / n : 0.f;
  out[0] = a * inv; out[1] = b * inv; out[2] = c * inv; out[3] = d * inv;
}

inline bool outside(const float* p, float x, float y, float z, float r) {
  return p[0] * x + p[1] * y + p[2] * z + p[3] < -r;
}

int32_t fe_ow_visible_count(void) { return int32_t(visCount); }
int32_t fe_lod_visible(uint32_t count, const float* xyz, const float* vp,
                       float cam_x, float cam_y, float cam_z,
                       float full_distance, float cull_radius, float margin,
                       uint32_t options) {
  if (!xyz || !vp || count > LOD_MAX) return -1;
  if (!finite(cam_x) || !finite(cam_y) || !finite(cam_z)) return -1;
  if (!finite(full_distance) || full_distance < 10.f || full_distance > 20000.f) return -1;
  if (!finite(cull_radius) || cull_radius < 10.f || cull_radius > 40000.f) return -1;
  if (!finite(margin) || margin < 0.f || margin > 96.f) return -1;
  const bool ground = (options & 1u) != 0u;
  const bool skip_frustum = (options & 2u) != 0u;
  float planes[6][4];
  if (!skip_frustum) {
    planeFrom(vp, 0, 1.f, planes[0]);
    planeFrom(vp, 0, -1.f, planes[1]);
    planeFrom(vp, 1, 1.f, planes[2]);
    planeFrom(vp, 1, -1.f, planes[3]);
    planeFrom(vp, 2, 1.f, planes[4]);
    planeFrom(vp, 2, -1.f, planes[5]);
  }
  const float band = maxf(120.f, full_distance * 2.f);
  const float keepFrom = cull_radius * 0.55f;
  uint32_t out = 0;
  for (uint32_t i = 0; i < count; i++) {
    const float x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    if (!finite(x) || !finite(y) || !finite(z)) continue;
    const float dx = x - cam_x, dy = y - cam_y, dz = z - cam_z;
    const float d = sqrtf(dx * dx + dy * dy + dz * dz);
    if (d > cull_radius + margin) continue;
    if (!skip_frustum) {
      bool cut = false;
      for (int32_t p = 0; p < 6; ++p) {
        if (outside(planes[p], x, y, z, margin)) { cut = true; break; }
      }
      if (cut) continue;
    }
    const float h = owHash(x * .731f + 13.7f, z * .917f - 7.3f, 1.f);
    /* Ground cover thins out with distance: full density up to 55% of the
       radius, then a deterministic hash decides, so the same blade is always
       kept or dropped while the camera moves. */
    if (ground && d > keepFrom) {
      const float t = (d - keepFrom) / maxf(1.f, cull_radius - keepFrom);
      const float keep = 1.f - t * t * (3.f - 2.f * t);
      if (h > keep) continue;
    }
    visIndex[out] = i;
    visTier[out] = d <= full_distance + h * band ? 0 : 1;
    out++;
    if (out >= LOD_MAX) break;
  }
  visCount = out;
  return int32_t(out);
}

int32_t fe_ow_hydro_set_grid(uint32_t n, float span, float sea_level) {
  if (n < 16 || n > HYDRO_MAX_N) return -1;
  if (!finite(span) || span <= 0.f || !finite(sea_level)) return -1;
  hydroN = n; hydroSpan = span; hydroSea = sea_level;
  /* Two 3x3 smoothing passes remove single-cell pits that would trap rivers. */
  float* src = hydroHeights;
  for (int pass = 0; pass < 2; pass++) {
    for (uint32_t j = 1; j + 1 < n; j++) {
      for (uint32_t i = 1; i + 1 < n; i++) {
        float acc = 0.f;
        for (int q = -1; q <= 1; q++)
          for (int w = -1; w <= 1; w++) acc += src[(j + q) * n + (i + w)];
        src[j * n + i] = acc / 9.f;
      }
    }
  }
  for (uint32_t k = 0; k < n * n; k++) {
    hydroF[k] = src[k];
    hydroParent[k] = -1;
    hydroClosed[k] = 0;
    hydroUsed[k] = -1;
  }
  uint32_t hsize = 0;
  for (uint32_t j = 0; j < n; j++)
    for (uint32_t i = 0; i < n; i++) {
      const uint32_t k = j * n + i;
      if (i == 0 || j == 0 || i == n - 1 || j == n - 1 || src[k] <= sea_level + .5f) {
        hydroClosed[k] = 1;
        heapPush(hydroHeap, hsize, k);
      }
    }
  const float eps = .002f * (span / float(n - 1));
  while (hsize > 0) {
    const uint32_t c = heapPop(hydroHeap, hsize);
    const int32_t ci = int32_t(c % n), cj = int32_t(c / n);
    for (int dj = -1; dj <= 1; dj++) {
      for (int di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const int32_t ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= int32_t(n) || nj >= int32_t(n)) continue;
        const uint32_t k = uint32_t(nj) * n + uint32_t(ni);
        if (hydroClosed[k]) continue;
        hydroClosed[k] = 1;
        hydroParent[k] = int32_t(c);
        if (hydroF[k] <= hydroF[c] + eps) hydroF[k] = hydroF[c] + eps;
        heapPush(hydroHeap, hsize, k);
      }
    }
  }
  return int32_t(n * n);
}

int32_t fe_ow_hydro_trace(uint32_t max_rivers, float min_length, float spacing, uint32_t seed) {
  if (!hydroN) return -1;
  if (max_rivers < 1 || max_rivers > RIVER_MAX_COUNT) return -1;
  if (!finite(min_length) || min_length < 0.f || !finite(spacing) || spacing < 0.f) return -1;
  const uint32_t n = hydroN;
  const float step = hydroSpan / float(n - 1), half = hydroSpan * .5f;
  hydroRngState = seed ? seed : 1u;

  /* Candidate sources: high, dry land sampled across the map, tallest first. */
  float candX[1400], candZ[1400], candH[1400];
  uint32_t candCount = 0;
  for (uint32_t i = 0; i < 1400; i++) {
    const float x = (hydroRandom() - .5f) * hydroSpan * .84f;
    const float z = (hydroRandom() - .5f) * hydroSpan * .84f;
    const float h = hydroSample(x, z, n, hydroSpan);
    if (h <= hydroSea + 40.f) continue;
    candX[candCount] = x; candZ[candCount] = z; candH[candCount] = h;
    candCount++;
  }
  for (uint32_t i = 1; i < candCount; i++) {
    const float h = candH[i], x = candX[i], z = candZ[i];
    uint32_t j = i;
    while (j > 0 && candH[j - 1] < h) {
      candH[j] = candH[j - 1]; candX[j] = candX[j - 1]; candZ[j] = candZ[j - 1];
      j--;
    }
    candH[j] = h; candX[j] = x; candZ[j] = z;
  }

  uint32_t pointCursor = 0, rivers = 0;
  float startX[RIVER_MAX_COUNT], startZ[RIVER_MAX_COUNT];
  for (uint32_t c = 0; c < candCount && rivers < max_rivers; c++) {
    bool tooClose = false;
    for (uint32_t t = 0; t < rivers; t++) {
      const float dx = startX[t] - candX[c], dz = startZ[t] - candZ[c];
      if (sqrtf(dx * dx + dz * dz) < spacing) { tooClose = true; break; }
    }
    if (tooClose) continue;
    int32_t cell = int32_t(floorf((candX[c] + half) / step + .5f));
    int32_t cellZ = int32_t(floorf((candZ[c] + half) / step + .5f));
    if (cell < 0 || cell >= int32_t(n) || cellZ < 0 || cellZ >= int32_t(n)) continue;
    uint32_t ck = uint32_t(cellZ) * n + uint32_t(cell);
    if (hydroUsed[ck] >= 0) continue;
    const uint32_t startPoint = pointCursor;
    int32_t endCode = 0, joinId = -1;
    for (uint32_t guard = 0; guard < 4000; guard++) {
      if (pointCursor >= RIVER_MAX_POINTS) break;
      riverPoints[pointCursor * 2] = float(ck % n) * step - half;
      riverPoints[pointCursor * 2 + 1] = float(ck / n) * step - half;
      pointCursor++;
      if (hydroHeights[ck] <= hydroSea + .9f) { endCode = 0; break; }
      const int32_t p = hydroParent[ck];
      if (p < 0) { endCode = 1; break; }
      if (hydroUsed[uint32_t(p)] >= 0) {
        joinId = hydroUsed[uint32_t(p)];
        if (pointCursor < RIVER_MAX_POINTS) {
          riverPoints[pointCursor * 2] = float(uint32_t(p) % n) * step - half;
          riverPoints[pointCursor * 2 + 1] = float(uint32_t(p) / n) * step - half;
          pointCursor++;
        }
        endCode = 2;
        break;
      }
      ck = uint32_t(p);
    }
    const uint32_t points = pointCursor - startPoint;
    float length = 0.f;
    for (uint32_t i = startPoint + 1; i < pointCursor; i++) {
      const float dx = riverPoints[i * 2] - riverPoints[i * 2 - 2];
      const float dz = riverPoints[i * 2 + 1] - riverPoints[i * 2 - 1];
      length += sqrtf(dx * dx + dz * dz);
    }
    if (length < min_length || points < 6) { pointCursor = startPoint; continue; }
    for (uint32_t i = startPoint; i < pointCursor; i++) {
      const uint32_t k = uint32_t(floorf((riverPoints[i * 2 + 1] + half) / step + .5f)) * n +
                         uint32_t(floorf((riverPoints[i * 2] + half) / step + .5f));
      if (k < n * n) hydroUsed[k] = int32_t(rivers);
    }
    riverMeta[rivers * 6] = int32_t(candX[c] * 100.f);
    riverMeta[rivers * 6 + 1] = int32_t(candZ[c] * 100.f);
    riverMeta[rivers * 6 + 2] = int32_t(startPoint);
    riverMeta[rivers * 6 + 3] = int32_t(points);
    riverMeta[rivers * 6 + 4] = endCode;
    riverMeta[rivers * 6 + 5] = joinId;
    startX[rivers] = candX[c]; startZ[rivers] = candZ[c];
    rivers++;
  }
  return int32_t(rivers);
}
}
