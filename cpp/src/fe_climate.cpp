#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

/* =========================================================================
 * Final Effect — climate & weather kernel (C++)
 *
 * The Landscaping Studio describes its world with one seeded climate field:
 * latitude, a sea-level temperature, humidity, continentality and a prevailing
 * wind. Everything the scene shows about "what the weather is doing today"
 * resolves from that field here, so the rain, snow, fog, storm, wind and snow
 * line never drift between a shader constant and a JavaScript slider.
 *
 * Physics that is actually modelled:
 *
 *   1. Seasonal-mean temperature   T = base - 30(1-cos lat) - 6.5 K/km
 *      (a real environmental lapse rate) with a hemispheric seasonal anomaly.
 *   2. Diurnal cycle               dry air swings ~12 K, humid air ~4 K
 *      (the Bowen ratio: latent heat flattens the daily range).
 *   3. Saturation / dew point      Td = T - (1-RH)·20  (Magnus, linearised for
 *      the 0-40 C range) and fog when the dew-point spread collapses.
 *   4. Synoptic fronts             a seeded 1D noise target with inertia, so
 *      weather evolves continuously instead of jumping between presets.
 *   5. Precipitation               cloud -> rain -> snow by temperature; deep
 *      convection (storm) needs both warmth and moisture.
 *   6. Long waves                  tsunami phase speed sqrt(g·depth) and run-up
 *      (Synolakis), so the studio's tsunami is not a fixed 26 m/s.
 *   7. Rankine vortex              tornado tangential wind inside/outside the
 *      core radius, mapped from the EF scale.
 *
 * What this is NOT: a radiative-transfer model, a general circulation model or
 * a Navier-Stokes atmosphere. It is a physically-grounded parameterisation, and
 * docs/CLIMATE.md lists exactly which terms are approximations.
 * ========================================================================= */

namespace {

using namespace fe;

/* ---- Biome ids — keep in sync with FELandscapeWeather.BIOMES (JS). ---- */
enum BiomeId {
  BIOME_TUNDRA = 0,      /* cold and dry     -> alpine / snowfield   */
  BIOME_TAIGA,           /* cold and wet     -> conifer hills        */
  BIOME_GRASSLAND,       /* temperate, dry   -> grassy               */
  BIOME_TEMPERATE_FOREST,/* temperate, moist -> hills / broadleaf    */
  BIOME_DESERT,          /* hot, very dry    -> desert               */
  BIOME_SAVANNA,         /* hot, dry         -> grassy               */
  BIOME_RAINFOREST,      /* hot, wet         -> tropical hills       */
  BIOME_BARE_ROCK,       /* too steep / cold to soil                 */
  BIOME_COUNT
};

constexpr float kLapseRate      = 0.0065f;  /* K per metre, ICAO standard atmosphere */
constexpr float kGravity        = 9.80665f; /* m/s^2 */
constexpr float kPolarDrop      = 30.0f;    /* K between equator and pole at sea level */
constexpr float kSeasonTilt     = 23.44f;   /* degrees, Earth's axial tilt */
constexpr float kHoursPerDay    = 24.0f;
constexpr float kDayHours       = 0.041666667f; /* 1/24 */

struct Climate {
  uint32_t seed;
  float latDeg;          /* -90..90 */
  float baseC;           /* sea-level annual mean before the latitude term */
  float humidity;        /* 0..1 */
  float continentality;  /* 0 = maritime, 1 = deep continental interior */
  float windBase;        /* m/s at 10 m */
  float clockH;          /* hours since the world started */
  float season;          /* 0..1 (0 = spring equinox, .25 = summer solstice) */
  float front;           /* 0..1 synoptic front strength (state) */
  float frontTarget;
  float nextFrontH;
  int   init;
};

Climate C = {1u, 15.0f, 15.0f, 0.55f, 0.35f, 5.0f, 9.0f, 0.32f, 0.2f, 0.3f, 0.0f, 0};

/* ---- deterministic noise ------------------------------------------------ */
inline uint32_t hash32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

inline float hashUnit(uint32_t x) {
  return static_cast<float>(hash32(x) & 0x00FFFFFFu) * (1.0f / 16777215.0f);
}

/* 2D value noise. Two lattice octaves are summed, so a 500 m landscape gets
   both local texture and regional districts (a wet valley beside a dry ridge)
   instead of a single uniform air mass. Bilinear + smoothstep, output in [0,1]. */
inline float lattice(int32_t ix, int32_t iz, uint32_t salt) {
  return hashUnit(static_cast<uint32_t>(ix) * 0x9E3779B9u ^
                  static_cast<uint32_t>(iz) * 0x85EBCA6Bu ^ salt);
}

inline float value2d(float x, float z, uint32_t salt) {
  const float fx = floorf(x), fz = floorf(z);
  const int32_t ix = static_cast<int32_t>(fx), iz = static_cast<int32_t>(fz);
  float tx = x - fx, tz = z - fz;
  tx = tx * tx * (3.0f - 2.0f * tx);
  tz = tz * tz * (3.0f - 2.0f * tz);
  const float a = lattice(ix, iz, salt), b = lattice(ix + 1, iz, salt);
  const float c = lattice(ix, iz + 1, salt), d = lattice(ix + 1, iz + 1, salt);
  const float top = a + (b - a) * tx;
  const float bot = c + (d - c) * tx;
  return top + (bot - top) * tz;
}

/* Spatial noise used by the moisture field: ~420 m districts over ~95 m
   detail, combined 60/40 and left in [0,1]. */
inline float noise2d(float x, float z, uint32_t salt) {
  const float regional = value2d(x * 0.0024f, z * 0.0024f, salt);
  const float local = value2d(x * 0.0105f + 3.0f, z * 0.0105f + 7.0f, salt ^ 0x27d4eb2fu);
  return regional * 0.60f + local * 0.40f;
}

inline float deg2rad(float d) { return d * kDeg2Rad; }

/* ---- 1. seasonal-mean sea-level temperature ----------------------------- */
float seaLevelMean() {
  const float lat = deg2rad(clampf(C.latDeg, -90.0f, 90.0f));
  /* Insolation falls as cos(lat); the pole is ~30 K colder at sea level. */
  return C.baseC - kPolarDrop * (1.0f - cosf(lat));
}

/* ---- 2. seasonal anomaly (declination from the season phase) ------------ */
float seasonalAnomaly() {
  const float lat = deg2rad(clampf(C.latDeg, -90.0f, 90.0f));
  /* Summer solstice sits at season = .25, the equinoxes at 0 and .5, so the
     anomaly follows cos(2 pi (season - .25)) and flips sign in the southern
     hemisphere through sin(lat). */
  const float phase = cosf(kTwoPi * (C.season - 0.25f));
  /* Continental interiors swing harder than coasts (no ocean heat capacity). */
  const float amp = 4.0f + 14.0f * clampf(C.continentality, 0.0f, 1.0f);
  return amp * sinf(lat) * phase;
}

/* ---- 3. solar elevation for the hour of day ---------------------------- */
float solarSin(float latDeg, float hour) {
  const float lat = deg2rad(latDeg);
  const float decl = kSeasonTilt * kDeg2Rad * sinf(kTwoPi * (C.season - 0.25f));
  /* hour angle: 0 at solar noon, +-pi at midnight */
  const float ha = kTwoPi * ((hour - 12.0f) * kDayHours);
  return sinf(lat) * sinf(decl) + cosf(lat) * cosf(decl) * cosf(ha);
}

/* ---- 4. current temperature at x/z/altitude ---------------------------- */
float temperatureAt(float x, float z, float altitude, float hour) {
  const float mean = seaLevelMean();
  const float season = seasonalAnomaly();
  const float h = hour - floorf(hour * kDayHours) * kHoursPerDay;
  /* Diurnal range: 12 K over dry ground, 4 K over a humid one. */
  const float dry = clampf(1.0f - C.humidity, 0.0f, 1.0f);
  const float diurnalAmp = 4.0f + 8.0f * dry;
  /* The ground peaks ~2.5 h after solar noon (thermal inertia), so the
     elevation is sampled with a lag instead of symmetrically about noon. */
  const float sun = solarSin(C.latDeg, h - 2.5f);   /* -1..1 */
  const float diurnal = diurnalAmp * sun * 0.5f;
  /* Weak warm-advection term so the field is not a perfect plane. */
  const float mesh = (noise2d(x, z, C.seed ^ 0xA511E9B3u) - 0.5f) * 1.6f;
  /* Lapse rate applies above sea level only. */
  const float alt = maxf(0.0f, altitude);
  return mean + season + diurnal + mesh - kLapseRate * alt;
}

/* ---- 5. moisture field ------------------------------------------------- */
float moistureAt(float x, float z, float altitude) {
  const float inland = clampf(C.continentality, 0.0f, 1.0f);
  /* Air loses water as it travels inland: -35 % at the far end. */
  const float drift = 0.35f * inland;
  /* Low ground near the sea stays humid; ridges sit in their own rain shadow. */
  const float shadow = 0.22f * smoothstepf(40.0f, 520.0f, maxf(0.0f, altitude));
  /* Districts differ: the same coast can carry a rainforest and a dry lee
     basin within a few hundred metres, exactly as real orography does. */
  const float n = (noise2d(x, z, C.seed ^ 0x68E31DA4u) - 0.5f) * 0.45f;
  return clampf(C.humidity - drift - shadow + n, 0.02f, 1.0f);
}

/* ---- 6. dew point / frost point --------------------------------------- */
/* The studio only needs the field, but a dew point below -20 C would make the
   fog term meaningless, so it is kept in the range water can actually be. */
inline float frostPoint(float t) { return clampf(t, -20.0f, 32.0f); }

float dewPoint(float t, float rh) {
  /* Dew-point depression is roughly (1-RH) * 20 K in this range. */
  return t - (1.0f - clampf(rh, 0.0f, 1.0f)) * 20.0f;
}

/* ---- 7. weather state at the current clock ----------------------------- */
struct Weather {
  float temp, dew, cloud, rain, snow, storm, lightning, fog, windSpeed, windDir;
};

void advanceFront(float hours) {
  /* Each front lives 9-30 h; between them the sky clears. */
  if (C.clockH >= C.nextFrontH) {
    const uint32_t slot = static_cast<uint32_t>(C.clockH / 6.0f);
    C.frontTarget = 0.15f + 0.85f * hashUnit(hash32(slot ^ C.seed));
    /* Wet climates produce more organised fronts. */
    C.frontTarget *= 0.45f + 0.75f * C.humidity;
    C.frontTarget = clampf(C.frontTarget, 0.0f, 1.0f);
    C.nextFrontH = C.clockH + 9.0f + 21.0f * hashUnit(hash32(slot * 7u ^ C.seed));
  }
  /* 3 h time constant: weather evolves, it does not teleport. */
  const float k = 1.0f - expf(-hours / 3.0f);
  C.front += (C.frontTarget - C.front) * k;
  C.front = clampf(C.front, 0.0f, 1.0f);
}

Weather weatherNow(float hour) {
  Weather w;
  const float t = temperatureAt(0.0f, 0.0f, 0.0f, hour);
  const float m = C.humidity;
  const float front = C.front;

  /* Fair weather is the *default*, not a gap between rain showers. The old
     curve put cloud cover above 0.4 for a typical front and started rain at a
     front of 0.22, so a freshly generated world was overcast and drizzling most
     of the time -- "every time I load the default terrain it is raining". A
     front now has to actually pass before the sky fills in, and rain needs a
     fully developed one. */
  const float cover = smoothstepf(0.30f, 0.95f, front);
  w.cloud = clampf(0.03f + 1.02f * cover * (0.45f + 0.55f * m), 0.0f, 1.0f);
  /* Rain needs a developed front AND moisture; a weak front over dry air stays
     clear, and between showers the sky is simply blue. */
  const float wetness = smoothstepf(0.55f, 0.92f, front);
  w.rain = clampf(wetness * wetness * (0.30f + 0.85f * m) * w.cloud, 0.0f, 1.0f);

  /* Wind first: fog below needs the calm-air term. */
  w.windSpeed = C.windBase * (0.55f + 0.75f * front);
  w.windDir = 0.6f * sinf(kTwoPi * C.clockH / 47.0f) + 0.35f * sinf(kTwoPi * C.clockH / 13.0f + 1.7f);

  /* Snow: all snow below -0.5 C, mixed sleet in the 2.5 K above it. */
  const float snowFrac = clampf((2.0f - t) / 2.5f, 0.0f, 1.0f);
  w.snow = w.rain * snowFrac;
  w.rain *= 1.0f - snowFrac * 0.55f;   /* sleet still reaches the ground */

  /* Deep convection needs warmth *and* moisture, then a trigger (the front). */
  const float warmth = clampf((t - 10.0f) / 18.0f, 0.0f, 1.0f);
  const float moist = clampf((m - 0.25f) / 0.75f, 0.0f, 1.0f);
  w.storm = clampf(w.rain * 1.35f * warmth * moist + front * front * warmth * moist * 0.35f, 0.0f, 1.0f);
  w.lightning = w.storm * w.storm * w.storm;

  /* Dew point follows the absolute moisture, not the instantaneous
     temperature, so a cold dawn pushes the relative humidity towards
     saturation while the same air at noon is dry. */
  const float meanT = seaLevelMean() + seasonalAnomaly();
  w.dew = frostPoint(meanT - (1.0f - m) * 16.0f);
  const float rh = clampf(expf((w.dew - t) * 0.125f), 0.0f, 1.0f); /* 1/8 K^-1 */
  /* Fog: saturated air, calm wind, and enough cloud to keep the night cold. */
  const float spread = t - w.dew;
  const float calm = clampf(1.0f - w.windSpeed / 9.0f, 0.0f, 1.0f);
  w.fog = clampf((2.2f - spread) / 2.2f, 0.0f, 1.0f) * calm * (0.30f + 0.70f * w.cloud) * (0.55f + 0.45f * rh);

  /* A storm drags the surface wind up with it. */
  w.windSpeed = clampf(w.windSpeed + C.windBase * 0.55f * w.storm, 0.0f, 60.0f);
  w.temp = t;
  return w;
}

}  // namespace

/* ======================================================================= */
/* Public ABI                                                              */
/* ======================================================================= */

extern "C" {

/* Declared here so fe_climate_at()/fe_climate_biome_on_slope() can call the
   classifier before its definition further down the translation unit. */
int32_t fe_climate_biome(float temp_c, float moisture);

FE_EXPORT int32_t fe_climate_init(uint32_t seed, float latitude_deg, float base_c,
                                  float humidity, float continentality, float wind_mps) {
  C.seed = seed ? seed : 1u;
  C.latDeg = clampf(latitude_deg, -90.0f, 90.0f);
  C.baseC = clampf(base_c, -60.0f, 60.0f);
  C.humidity = clampf(humidity, 0.0f, 1.0f);
  C.continentality = clampf(continentality, 0.0f, 1.0f);
  C.windBase = clampf(wind_mps, 0.0f, 40.0f);
  C.clockH = 9.0f;
  C.front = 0.35f;
  C.frontTarget = 0.35f;
  C.nextFrontH = 12.0f;
  C.init = 1;
  return 1;
}

FE_EXPORT int32_t fe_climate_ready(void) { return C.init; }

FE_EXPORT float fe_climate_set_clock(float hours) {
  C.clockH = hours < 0.0f ? 0.0f : hours;
  /* Re-seed the next front boundary so seeking the clock stays consistent. */
  const uint32_t slot = static_cast<uint32_t>(C.clockH / 6.0f);
  C.nextFrontH = (floorf(C.clockH / 6.0f) + 1.0f) * 6.0f;
  C.frontTarget = clampf((0.15f + 0.85f * hashUnit(hash32(slot ^ C.seed))) *
                         (0.45f + 0.75f * C.humidity), 0.0f, 1.0f);
  return C.clockH;
}

FE_EXPORT float fe_climate_set_season(float t01) {
  C.season = t01 - floorf(t01);
  return C.season;
}

FE_EXPORT float fe_climate_step(float dt_hours) {
  const float dt = clampf(dt_hours, 0.0f, 24.0f);
  C.clockH += dt;
  advanceFront(dt);
  return C.clockH;
}

FE_EXPORT float fe_climate_clock(void) { return C.clockH; }

/* Sea-level temperature for the current season, day and hour. */
FE_EXPORT float fe_climate_sea_level_temp(float hour) {
  return temperatureAt(0.0f, 0.0f, 0.0f, hour);
}

/* Altitude (m) at which the current temperature reaches 0 C. Sea level is the
   reference, so a cold hour can report 0 and a warm one a very high line. */
FE_EXPORT float fe_climate_snow_line(float hour) {
  const float t0 = temperatureAt(0.0f, 0.0f, 0.0f, hour);
  if (t0 <= 0.0f) return 0.0f;
  return t0 / kLapseRate;
}

/* out[10] = temp C, dew C, moisture 0..1, cloud, rain, snow, fog, wind m/s,
             wind dir rad, biome id */
FE_EXPORT int32_t fe_climate_at(float x, float z, float altitude, float hour, float* out) {
  if (!out) return 0;
  if (!C.init) fe_climate_init(1u, 15.0f, 15.0f, 0.55f, 0.35f, 5.0f);
  const float t = temperatureAt(x, z, altitude, hour);
  const float m = moistureAt(x, z, altitude);
  const Weather w = weatherNow(hour);
  const int biome = fe_climate_biome(t, m);
  out[0] = t;
  out[1] = frostPoint(t - (1.0f - m) * 16.0f);
  out[2] = m;
  out[3] = w.cloud;
  out[4] = w.rain;
  out[5] = w.snow;
  out[6] = w.fog;
  out[7] = w.windSpeed;
  out[8] = w.windDir;
  out[9] = static_cast<float>(biome);
  return 1;
}

/* out[10] = temp C, dew C, cloud, rain, snow, storm, lightning, fog,
             wind m/s, wind dir rad */
FE_EXPORT int32_t fe_climate_weather(float* out) {
  if (!out) return 0;
  if (!C.init) fe_climate_init(1u, 15.0f, 15.0f, 0.55f, 0.35f, 5.0f);
  const float hour = C.clockH - floorf(C.clockH * kDayHours) * kHoursPerDay;
  const Weather w = weatherNow(hour);
  out[0] = w.temp;
  out[1] = w.dew;
  out[2] = w.cloud;
  out[3] = w.rain;
  out[4] = w.snow;
  out[5] = w.storm;
  out[6] = w.lightning;
  out[7] = w.fog;
  out[8] = w.windSpeed;
  out[9] = w.windDir;
  return 1;
}

/* Whittaker-style classification. Temperature and moisture are the only
   inputs the studio can actually paint, so the table stays two-dimensional. */
FE_EXPORT int32_t fe_climate_biome(float temp_c, float moisture) {
  const float t = temp_c;
  const float m = clampf(moisture, 0.0f, 1.0f);
  if (t < -5.0f) return BIOME_TUNDRA;
  if (t < 5.0f) return m < 0.28f ? BIOME_TUNDRA : BIOME_TAIGA;
  if (t < 20.0f) {
    if (m < 0.22f) return BIOME_GRASSLAND;
    if (m < 0.30f) return BIOME_GRASSLAND;
    if (m < 0.72f) return BIOME_TEMPERATE_FOREST;
    return BIOME_TEMPERATE_FOREST;      /* temperate rainforest reads the same */
  }
  if (m < 0.16f) return BIOME_DESERT;
  if (m < 0.42f) return BIOME_SAVANNA;
  if (m < 0.78f) return BIOME_SAVANNA;
  return BIOME_RAINFOREST;
}

FE_EXPORT int32_t fe_climate_biome_count(void) { return BIOME_COUNT; }

/* Defined below; the grid uses the slope-aware classifier. */
FE_EXPORT int32_t fe_climate_biome_on_slope(float temp_c, float moisture, float slope);

/* Whole-map classification for the explicit "Apply Climate Biomes" action.
   heights is a row-major n*n grid spanning `size` metres on both axes (the
   terrain vertex grid); out receives the biome id per cell. Nothing is written
   anywhere else: the studio only paints when the user asks, because replacing
   hand-painted biome layers without a prompt would destroy their work. */
FE_EXPORT int32_t fe_climate_biome_grid(const float* heights, int32_t n, float size,
                                        float origin_x, float origin_z, float hour,
                                        uint8_t* out) {
  if (!out || n < 2 || n > 1025) return 0;
  if (!C.init) fe_climate_init(1u, 15.0f, 15.0f, 0.55f, 0.35f, 5.0f);
  const float step = size / float(n - 1);
  const float half = size * 0.5f;
  const int32_t cells = n * n;
  for (int32_t j = 0; j < n; ++j) {
    const float z = origin_z - half + step * float(j);
    for (int32_t i = 0; i < n; ++i) {
      const float x = origin_x - half + step * float(i);
      const float h = heights ? heights[j * n + i] : 0.0f;
      const float t = temperatureAt(x, z, h, hour);
      const float m = moistureAt(x, z, h);
      /* Steep or high ground has no soil whatever the climate says, so the
         slope is part of the classification rather than a paint trick. */
      float slope = 0.0f;
      if (heights) {
        const int32_t i0 = i > 0 ? i - 1 : i, i1 = i < n - 1 ? i + 1 : i;
        const int32_t j0 = j > 0 ? j - 1 : j, j1 = j < n - 1 ? j + 1 : j;
        const float hx = heights[j * n + i1] - heights[j * n + i0];
        const float hz = heights[j1 * n + i] - heights[j0 * n + i];
        const float run = step * float((i1 - i0) + (j1 - j0)) * 0.5f;
        slope = run > 1e-4f ? sqrtf(hx * hx + hz * hz) / (2.0f * run) : 0.0f;
      }
      out[j * n + i] = uint8_t(fe_climate_biome_on_slope(t, m, slope));
    }
  }
  return cells;
}

/* Bare-rock override: steep or very high ground has no soil regardless of the
   climate, so the studio can bias the biome before it paints. */
FE_EXPORT int32_t fe_climate_biome_on_slope(float temp_c, float moisture, float slope) {
  const int base = fe_climate_biome(temp_c, moisture);
  if (slope > 0.78f && base != BIOME_TUNDRA) return BIOME_BARE_ROCK;
  return base;
}

/* Rankine vortex mapped from the Enhanced Fujita scale.
   out[4] = core radius m, max tangential wind m/s, funnel height m,
            damage swath width m */
FE_EXPORT int32_t fe_climate_tornado(float ef, float* out) {
  if (!out) return 0;
  const float e = clampf(ef, 0.0f, 5.0f);
  /* EF0 ~ 30 m/s, EF5 ~ 95 m/s (3-second gust, NWS). */
  const float vmax = 29.0f + 13.3f * e;
  const float radius = 18.0f + 16.0f * e;          /* condensation funnel */
  const float height = 1100.0f + 180.0f * e;       /* boundary layer depth */
  out[0] = radius;
  out[1] = vmax;
  out[2] = height;
  out[3] = radius * 3.2f;                          /* damage swath ~ 3R */
  return 1;
}

/* Tangential wind at radius r inside/outside the core. */
FE_EXPORT float fe_climate_rankine(float r, float core_radius, float vmax) {
  const float R = maxf(core_radius, 0.5f);
  const float d = maxf(r, 0.0f);
  if (d <= R) return vmax * (d / R);
  return vmax * (R / d);
}

/* Long-wave tsunami: phase speed sqrt(g*depth), shoaling amplification at the
   shore (Green's law, depth ratio ^ 1/4) and Synolakis run-up (2.83 * amplitude).
   out[5] = speed m/s, wavelength m, shoaling factor, run-up m, period s, energy
            proxy (amplitude^2 * wavelength) */
FE_EXPORT int32_t fe_climate_tsunami(float amplitude_m, float depth_m, float* out) {
  if (!out) return 0;
  const float a = clampf(amplitude_m, 0.05f, 40.0f);
  const float d = clampf(depth_m, 1.0f, 6000.0f);
  const float c = sqrtf(kGravity * d);
  /* Shallow-water waves are non-dispersive: T = 2 pi / omega and c = gT/2pi. */
  const float period = kTwoPi * c / kGravity;
  const float wavelength = c * period;
  const float shoreDepth = 3.0f;
  const float shoal = powf(d / shoreDepth, 0.25f);
  out[0] = c;
  out[1] = wavelength;
  out[2] = shoal;
  out[3] = 2.83f * a * clampf(shoal / 4.0f, 1.0f, 1.8f);
  out[4] = period;
  out[5] = a * a * wavelength;
  return 1;
}

}  // extern "C"
