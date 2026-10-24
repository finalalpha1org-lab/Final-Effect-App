#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

/* Ocean surface solver: Tessendorf spectrum build + inverse FFT producing the
   RGBA displacement/normal field the water shader samples. JS keeps the texture
   upload and the material; the maths lives here. */

namespace {
using namespace fe;

constexpr uint32_t OCEAN_MAX_RES = 256;
constexpr uint32_t OCEAN_MAX_CELLS = OCEAN_MAX_RES * OCEAN_MAX_RES;
constexpr uint32_t OCEAN_CASCADES = 3;

/* Double-precision helpers: the freestanding build has no libm, so the ocean
   carries its own reduced-range implementations. */
inline double dSqrt(double x) { return __builtin_sqrt(x); }
inline double dFloor(double x) { return __builtin_floor(x); }

double dSin(double x) {
  const double INV_TWO_PI = 0.15915494309189535;
  const double TWO_PI = 6.283185307179586476925286766559;
  const double PI = 3.141592653589793238462643383279;
  const double HALF_PI = 1.570796326794896619231321691639;
  const double k = dFloor(x * INV_TWO_PI + 0.5);
  x -= k * TWO_PI;
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const double x2 = x * x;
  return x * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 +
         x2 * (1.0 / 362880.0 + x2 * (-1.0 / 39916800.0 + x2 * (1.0 / 6227020800.0)))))));
}
double dCos(double x) { return dSin(x + 1.570796326794896619231321691639); }

double dExp(double x) {
  if (x < -740.0) return 0.0;
  if (x > 700.0) return 1e300;
  const double LN2 = 0.69314718055994530942;
  double k = dFloor(x / LN2 + 0.5);
  const double r = x - k * LN2;
  const double t = 1.0 + r * (1.0 + r * (0.5 + r * (1.0 / 6.0 + r * (1.0 / 24.0 +
      r * (1.0 / 120.0 + r * (1.0 / 720.0 + r * (1.0 / 5040.0 + r * (1.0 / 40320.0 +
      r * (1.0 / 362880.0 + r * (1.0 / 3628800.0))))))))));
  double scale = t;
  while (k > 0) { scale *= 2.0; k -= 1.0; }
  while (k < 0) { scale *= 0.5; k += 1.0; }
  return scale;
}

double dLog(double x) {
  if (x <= 0.0) return -1e300;
  int e = 0;
  while (x >= 2.0) { x *= 0.5; e++; }
  while (x < 1.0) { x *= 2.0; e--; }
  const double z = (x - 1.0) / (x + 1.0);
  const double z2 = z * z;
  double term = z, sum = z;
  for (int i = 3; i < 61; i += 2) { term *= z2; sum += term / double(i); }
  return 2.0 * sum + double(e) * 0.69314718055994530942;
}

/* The three FFT cascades are 10.8 MB over the maximum 256x256 resolution, and
   only the landscaping studio's water surface ever reads them. They come from
   the lazy heap and are carved on the first fe_ocean_configure, so the 3D
   workspace — and the kernel worker — do not reserve them. */
float (*oceanH0R)[OCEAN_MAX_CELLS] = nullptr;
float (*oceanH0I)[OCEAN_MAX_CELLS] = nullptr;
float (*oceanOmega)[OCEAN_MAX_CELLS] = nullptr;
uint32_t (*oceanOpposite)[OCEAN_MAX_CELLS] = nullptr;
double* oceanHr = nullptr;
double* oceanHi = nullptr;
double* oceanXr = nullptr;
double* oceanXi = nullptr;
double* oceanZr = nullptr;
double* oceanZi = nullptr;
float (*oceanData)[OCEAN_MAX_CELLS * 4] = nullptr;
float* oceanDirX = nullptr;
float* oceanDirZ = nullptr;
float (*oceanFoam)[OCEAN_MAX_CELLS] = nullptr;
uint8_t* oceanRgba = nullptr;
float* oceanJ = nullptr;

constexpr uint32_t kOceanFieldFloatBytes = OCEAN_MAX_CELLS * 4u;
constexpr uint32_t kOceanFieldDoubleBytes = OCEAN_MAX_CELLS * 8u;
constexpr uint32_t kOceanBlockBytes =
  OCEAN_CASCADES * kOceanFieldFloatBytes * 3u      /* H0 real, H0 imag, omega */
  + OCEAN_CASCADES * OCEAN_MAX_CELLS * 4u          /* opposite corners */
  + kOceanFieldDoubleBytes * 6u                    /* h, x, z re/im work pairs */
  + OCEAN_CASCADES * kOceanFieldFloatBytes * 4u    /* per-cascade data quad */
  + kOceanFieldFloatBytes * 2u                     /* wind direction */
  + OCEAN_CASCADES * kOceanFieldFloatBytes        /* foam */
  + OCEAN_MAX_CELLS * 4u                           /* upload pixels */
  + kOceanFieldFloatBytes                          /* Jacobian test field */
  + 512u;

uint8_t* g_ocean_block = nullptr;
uint32_t g_ocean_cursor = 0;

inline void* oceanCarve(uint32_t bytes) {
  uint8_t* p = g_ocean_block + g_ocean_cursor;
  g_ocean_cursor = (g_ocean_cursor + bytes + 15u) & ~15u;
  return p;
}

bool ensure_ocean_buffers(void) {
  if (g_ocean_block != nullptr) return true;
  g_ocean_block = reinterpret_cast<uint8_t*>(fe::heap::alloc(kOceanBlockBytes, 16));
  if (g_ocean_block == nullptr) return false;
  g_ocean_cursor = 0;
  oceanH0R = static_cast<float (*)[OCEAN_MAX_CELLS]>(oceanCarve(OCEAN_CASCADES * kOceanFieldFloatBytes));
  oceanH0I = static_cast<float (*)[OCEAN_MAX_CELLS]>(oceanCarve(OCEAN_CASCADES * kOceanFieldFloatBytes));
  oceanOmega = static_cast<float (*)[OCEAN_MAX_CELLS]>(oceanCarve(OCEAN_CASCADES * kOceanFieldFloatBytes));
  oceanOpposite = static_cast<uint32_t (*)[OCEAN_MAX_CELLS]>(oceanCarve(OCEAN_CASCADES * OCEAN_MAX_CELLS * 4u));
  oceanHr = static_cast<double*>(oceanCarve(kOceanFieldDoubleBytes));
  oceanHi = static_cast<double*>(oceanCarve(kOceanFieldDoubleBytes));
  oceanXr = static_cast<double*>(oceanCarve(kOceanFieldDoubleBytes));
  oceanXi = static_cast<double*>(oceanCarve(kOceanFieldDoubleBytes));
  oceanZr = static_cast<double*>(oceanCarve(kOceanFieldDoubleBytes));
  oceanZi = static_cast<double*>(oceanCarve(kOceanFieldDoubleBytes));
  oceanData = static_cast<float (*)[OCEAN_MAX_CELLS * 4]>(oceanCarve(OCEAN_CASCADES * kOceanFieldFloatBytes * 4u));
  oceanDirX = static_cast<float*>(oceanCarve(kOceanFieldFloatBytes));
  oceanDirZ = static_cast<float*>(oceanCarve(kOceanFieldFloatBytes));
  oceanFoam = static_cast<float (*)[OCEAN_MAX_CELLS]>(oceanCarve(OCEAN_CASCADES * kOceanFieldFloatBytes));
  oceanRgba = static_cast<uint8_t*>(oceanCarve(OCEAN_MAX_CELLS * 4u));
  oceanJ = static_cast<float*>(oceanCarve(kOceanFieldFloatBytes));
  return true;
}

uint32_t oceanResolution = 0, oceanCellCount = 0;
float oceanLengths[OCEAN_CASCADES] = {256.f, 1024.f, 4096.f};
float oceanWindSpeed = 14.f, oceanWindDirection = 0.f;
float oceanHeightEncode = 3.f, oceanDisplaceEncode = 2.f;
uint32_t oceanSeed = 7;

bool finite(float x) { return isfinitef(x); }
bool finiteDouble(double x) { return x == x && x < 1e300 && x > -1e300; }

/* Twiddle tables: cos/sin of +2pi*c/len for every stage of every transform of
   the same size. The phase angles are identical to the ones computed inline
   before, so results stay bit-comparable, but the trig calls drop from
   n/2*log2(n) per transform to n-1 per size. */
double twiddleRe[OCEAN_MAX_RES], twiddleIm[OCEAN_MAX_RES];
uint32_t twiddleN = 0;
void buildTwiddles(uint32_t n) {
  if (twiddleN == n) return;
  const double TAU = 6.283185307179586476925286766559;
  uint32_t k = 0;
  for (uint32_t len = 2; len <= n; len <<= 1) {
    const double ang = TAU / double(len);
    for (uint32_t c = 0; c < (len >> 1); c++) {
      twiddleRe[k] = dCos(ang * double(c));
      twiddleIm[k] = dSin(ang * double(c));
      k++;
    }
  }
  twiddleN = n;
}

void fft1d(double* re, double* im, uint32_t n, uint32_t stride, bool inverse) {
  for (uint32_t i = 1, l = 0; i < n; i++) {
    uint32_t m = n >> 1;
    for (; l & m; m >>= 1) l ^= m;
    l ^= m;
    if (i < l) {
      const uint32_t a = i * stride, b = l * stride;
      const double tr = re[a]; re[a] = re[b]; re[b] = tr;
      const double ti = im[a]; im[a] = im[b]; im[b] = ti;
    }
  }
  buildTwiddles(n);
  uint32_t tw = 0;
  for (uint32_t len = 2; len <= n; len <<= 1) {
    const uint32_t half = len >> 1;
    for (uint32_t start = 0; start < n; start += len) {
      for (uint32_t c = 0; c < half; c++) {
        const double wr = twiddleRe[tw + c];
        const double wi = inverse ? twiddleIm[tw + c] : -twiddleIm[tw + c];
        const uint32_t a = (start + c) * stride, b = (start + c + half) * stride;
        const double xr = wr * re[b] - wi * im[b];
        const double xi = wr * im[b] + wi * re[b];
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
    tw += half;
  }
  if (inverse) {
    for (uint32_t i = 0; i < n; i++) { re[i * stride] /= double(n); im[i * stride] /= double(n); }
  }
}
/* Rows are transformed in place with unit stride; columns use a stride of n.
   (Passing the row start as the stride would index element*offset repeatedly.) */
void fft2d(double* re, double* im, uint32_t n) {
  for (uint32_t r = 0; r < n; r++) fft1d(re + r * n, im + r * n, n, 1, true);
  for (uint32_t c = 0; c < n; c++) fft1d(re + c, im + c, n, n, true);
}

uint32_t oceanRngState = 1u;
double oceanRandom() {
  oceanRngState ^= oceanRngState << 13;
  oceanRngState ^= oceanRngState >> 17;
  oceanRngState ^= oceanRngState << 5;
  return double(oceanRngState) / 4294967296.0;
}
double oceanGaussian() {
  double u = oceanRandom();
  if (u < 1e-12) u = 1e-12;
  const double v = oceanRandom();
  return dSqrt(-2.0 * dLog(u)) * dCos(6.283185307179586476925286766559 * v);
}

void buildSpectrum(uint32_t cascade) {
  const uint32_t n = oceanResolution;
  const double length = double(oceanLengths[cascade]);
  oceanRngState = oceanSeed + uint32_t(cascade + 1) * 2654435761u;
  if (!oceanRngState) oceanRngState = 1831565813u;
  const double d = 6.283185307179586476925286766559 / length;   /* 2pi / length */
  const double windRad = double(oceanWindDirection);
  const double m = dCos(windRad), x = dSin(windRad);
  const double speed = double(oceanWindSpeed);
  const double f = (speed * speed / 9.81) > 1.0 ? (speed * speed / 9.81) : 1.0;
  const double w = f * .0016;
  const double k = .0028 * ((speed / 12.0) > .08 ? (speed / 12.0) : .08);
  for (uint32_t g = 0; g < n; g++) {
    for (uint32_t y = 0; y < n; y++) {
      const uint32_t p = g * n + y;
      const double z = double(y <= n / 2 ? int32_t(y) : int32_t(y) - int32_t(n));
      const double q = double(g <= n / 2 ? int32_t(g) : int32_t(g) - int32_t(n));
      const double s = z * d, mm = q * d;
      const double A = s * s + mm * mm;
      const double F = dSqrt(A);
      oceanOpposite[cascade][p] = ((n - g) % n) * n + ((n - y) % n);
      if (F < 1e-8) { oceanH0R[cascade][p] = 0.f; oceanH0I[cascade][p] = 0.f; oceanOmega[cascade][p] = 0.f; continue; }
      const double b = (s * m + mm * x) / F;
      const double E = b >= 0.0 ? b * b : b * b * .07;
      const double head = k * dExp(-1.0 / (A * f * f > 1e-10 ? A * f * f : 1e-10)) / (A * A) * E * dExp(-A * w * w) * d * d;
      const double D = dSqrt((head > 0.0 ? head : 0.0) * .5);
      oceanH0R[cascade][p] = float(oceanGaussian() * D);
      oceanH0I[cascade][p] = float(oceanGaussian() * D);
      oceanOmega[cascade][p] = float(dSqrt(9.81 * F));
    }
  }
}
/* Jacobian foam: where the displaced surface folds over itself the 2x2
   Jacobian of the horizontal displacement drops below 1 and the water breaks
   into whitecaps. Derivatives are per world unit (n / cascade length).

   The threshold is adaptive (per-frame mean/standard deviation of J) so the
   whitecap coverage stays believable across amplitudes instead of vanishing or
   flooding the surface when the gain changes. Choppiness and wind scale both
   the coverage and the strength. */
void computeFoam(uint32_t cascade, uint32_t n, float amplitude, float choppiness) {
  const float* d = oceanData[cascade];
  float* out = oceanFoam[cascade];
  const uint32_t cells = n * n;
  if (amplitude <= 0.f) { for (uint32_t s = 0; s < cells; s++) out[s] = 0.f; return; }
  const double per = double(n) / double(oceanLengths[cascade]);
  double sum = 0.0, sum2 = 0.0;
  for (uint32_t s = 0; s < cells; s++) {
    const uint32_t ix = s % n, iz = s / n;
    const uint32_t xm = iz * n + (ix + n - 1) % n, xp = iz * n + (ix + 1) % n;
    const uint32_t zm = ((iz + n - 1) % n) * n + ix, zp = ((iz + 1) % n) * n + ix;
    const double dxdx = (double(d[xp * 4 + 1]) - double(d[xm * 4 + 1])) * .5 * per;
    const double dzdx = (double(d[xp * 4 + 2]) - double(d[xm * 4 + 2])) * .5 * per;
    const double dxdz = (double(d[zp * 4 + 1]) - double(d[zm * 4 + 1])) * .5 * per;
    const double dzdz = (double(d[zp * 4 + 2]) - double(d[zm * 4 + 2])) * .5 * per;
    const double J = (1.0 + dxdx) * (1.0 + dzdz) - dxdz * dzdx;
    oceanJ[s] = float(J);
    sum += J; sum2 += J * J;
  }
  const double mean = sum / double(cells);
  double variance = sum2 / double(cells) - mean * mean;
  const double stddev = variance > 1e-12 ? dSqrt(variance) : 0.0;
  const double wind = double(oceanWindSpeed) / 14.0;
  double strength = (.35 + .65 * double(choppiness)) * (wind < .45 ? .45 : (wind > 1.4 ? 1.4 : wind));
  strength = strength > 1.0 ? 1.0 : (strength < 0.0 ? 0.0 : strength);
  const double z0 = 2.05 - .65 * strength;
  for (uint32_t s = 0; s < cells; s++) {
    if (stddev < 1e-6) { out[s] = 0.f; continue; }
    const double z = (mean - double(oceanJ[s])) / stddev;
    double f = (z - z0) * 2.2 * strength;
    f = f < 0.0 ? 0.0 : (f > 1.0 ? 1.0 : f);
    out[s] = float(f * f * (3.0 - 2.0 * f));
  }
}
} // namespace

extern "C" {
float* fe_ocean_field_ptr(void) { return oceanData[0]; }
uint32_t fe_ocean_resolution(void) { return oceanResolution; }

float* fe_ocean_get_cascade_float4_ptr(uint32_t cascade_idx) {
  return cascade_idx < OCEAN_CASCADES ? oceanData[cascade_idx] : nullptr;
}

int32_t fe_ocean_configure(uint32_t resolution, float len0, float len1, float len2,
                           float wind_speed, float wind_dir_deg, uint32_t seed) {
  if (resolution < 8 || resolution > OCEAN_MAX_RES || (resolution & (resolution - 1)) != 0) return -1;
  const float lengths[OCEAN_CASCADES] = {len0, len1, len2};
  for (uint32_t i = 0; i < OCEAN_CASCADES; i++)
    if (!finite(lengths[i]) || lengths[i] < 1.f || lengths[i] > 100000.f) return -1;
  if (!finite(wind_speed) || wind_speed < 0.f || wind_speed > 80.f) return -1;
  if (!finite(wind_dir_deg) || wind_dir_deg < -720.f || wind_dir_deg > 720.f) return -1;
  if (!ensure_ocean_buffers()) return -2;   /* the device refused the memory */
  oceanResolution = resolution;
  oceanCellCount = resolution * resolution;
  for (uint32_t i = 0; i < OCEAN_CASCADES; i++) oceanLengths[i] = lengths[i];
  oceanWindSpeed = wind_speed;
  oceanWindDirection = wind_dir_deg * 3.14159265358979323846f / 180.f;
  oceanSeed = seed;
  for (uint32_t c = 0; c < OCEAN_CASCADES; c++) buildSpectrum(c);
  /* Normalised wave vectors only depend on the sample index, not the cascade,
     so they are built once per configure instead of per cell per frame. */
  for (uint32_t s = 0; s < oceanCellCount; s++) {
    const uint32_t ix = s % resolution, iz = s / resolution;
    const double gx = double(ix <= resolution / 2 ? int32_t(ix) : int32_t(ix) - int32_t(resolution));
    const double gz = double(iz <= resolution / 2 ? int32_t(iz) : int32_t(iz) - int32_t(resolution));
    const double mag = dSqrt(gx * gx + gz * gz);
    if (mag > 1e-8) { oceanDirX[s] = float(gx / mag); oceanDirZ[s] = float(gz / mag); }
    else { oceanDirX[s] = 0.f; oceanDirZ[s] = 0.f; }
  }
  return 0;
}

int32_t fe_ocean_update(float time_sec, float amplitude, float choppiness,
                        float max_height_encode, float max_displace_encode) {
  if (!oceanResolution) return -1;
  if (!finite(time_sec) || !finite(amplitude) || !finite(choppiness)) return -1;
  if (amplitude < 0.f || amplitude > 10.f || choppiness < 0.f || choppiness > 10.f) return -1;
  const uint32_t n = oceanResolution, cells = oceanCellCount;
  const double t = double(time_sec), chop = double(choppiness);
  if (finite(max_height_encode) && max_height_encode > 0.f) oceanHeightEncode = max_height_encode;
  if (finite(max_displace_encode) && max_displace_encode > 0.f) oceanDisplaceEncode = max_displace_encode;
  const double cascadeScale[OCEAN_CASCADES] = {.58, .30, .16};
  for (uint32_t cascade = 0; cascade < OCEAN_CASCADES; cascade++) {
    const float* h0r = oceanH0R[cascade];
    const float* h0i = oceanH0I[cascade];
    const float* omega = oceanOmega[cascade];
    const uint32_t* opp = oceanOpposite[cascade];
    const double length = double(oceanLengths[cascade]);
    for (uint32_t s = 0; s < cells; s++) {
      const uint32_t o = opp[s];
      const double ang = double(omega[s]) * t;
      const double c = dCos(ang), sn = dSin(ang);
      const double E = double(h0r[s]) * c - double(h0i[s]) * sn;
      const double P = double(h0r[s]) * sn + double(h0i[s]) * c;
      const double D = double(h0r[o]) * c - double(h0i[o]) * sn;
      const double X = -double(h0r[o]) * sn - double(h0i[o]) * c;
      oceanHr[s] = E + D;
      oceanHi[s] = P + X;
      const double wx = double(oceanDirX[s]), wz = double(oceanDirZ[s]);
      if (wx != 0.0 || wz != 0.0) {
        oceanXr[s] = oceanHi[s] * wx * chop;
        oceanXi[s] = -oceanHr[s] * wx * chop;
        oceanZr[s] = oceanHi[s] * wz * chop;
        oceanZi[s] = -oceanHr[s] * wz * chop;
      } else {
        oceanXr[s] = 0.0; oceanXi[s] = 0.0; oceanZr[s] = 0.0; oceanZi[s] = 0.0;
      }
    }
    fft2d(oceanHr, oceanHi, n);
    fft2d(oceanXr, oceanXi, n);
    fft2d(oceanZr, oceanZi, n);
    double mean = 0.0;
    for (uint32_t s = 0; s < cells; s++) mean += oceanHr[s];
    mean /= double(cells);
    double variance = 0.0;
    for (uint32_t s = 0; s < cells; s++) {
      const double d = oceanHr[s] - mean;
      variance += d * d;
    }
    const double stddev = dSqrt(variance / double(cells));
    const double peak = (.12 + double(oceanWindSpeed) * .043) * cascadeScale[cascade] *
                        (double(amplitude) > 0.0 ? double(amplitude) : 0.0);
    const double norm = stddev > 1e-12 ? peak / stddev : 0.0;
    float* data = oceanData[cascade];
    for (uint32_t s = 0; s < cells; s++) {
      data[s * 4 + 0] = float((oceanHr[s] - mean) * norm);
      data[s * 4 + 1] = float(oceanXr[s] * norm);
      data[s * 4 + 2] = float(oceanZr[s] * norm);
      data[s * 4 + 3] = 1.f;
    }
    computeFoam(cascade, n, amplitude, choppiness);
  }
  return int32_t(cells * 4);
}

float* fe_ocean_get_cascade_foam_ptr(uint32_t cascade_idx) {
  return cascade_idx < OCEAN_CASCADES ? oceanFoam[cascade_idx] : nullptr;
}

uint8_t* fe_ocean_get_cascade_rgba8_ptr(uint32_t cascade_idx) {
  if (cascade_idx >= OCEAN_CASCADES || !oceanCellCount) return nullptr;
  const float* src = oceanData[cascade_idx];
  const float heightScale = maxf(oceanHeightEncode, .0001f) * 2.f;
  const float displaceScale = maxf(oceanDisplaceEncode, .0001f) * 2.f;
  for (uint32_t s = 0; s < oceanCellCount; s++) {
    const float h = clampf(src[s * 4] / heightScale + .5f, 0.f, 1.f);
    const float dx = clampf(src[s * 4 + 1] / displaceScale + .5f, 0.f, 1.f);
    const float dz = clampf(src[s * 4 + 2] / displaceScale + .5f, 0.f, 1.f);
    oceanRgba[s * 4] = uint8_t(h * 255.f + .5f);
    oceanRgba[s * 4 + 1] = uint8_t(dx * 255.f + .5f);
    oceanRgba[s * 4 + 2] = uint8_t(dz * 255.f + .5f);
    oceanRgba[s * 4 + 3] = 255;
  }
  return oceanRgba;
}

int32_t fe_ocean_ifft2d_f32(float* real, float* imag, uint32_t n) {
  if (!real || !imag || n < 8 || n > OCEAN_MAX_RES || (n & (n - 1)) != 0) return -1;
  for (uint32_t i = 0; i < n * n; i++) { oceanHr[i] = double(real[i]); oceanHi[i] = double(imag[i]); }
  fft2d(oceanHr, oceanHi, n);
  for (uint32_t i = 0; i < n * n; i++) { real[i] = float(oceanHr[i]); imag[i] = float(oceanHi[i]); }
  return 0;
}
}
