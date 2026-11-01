#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"
#include "../include/fe_math64.hpp"

/* Render maths that used to be inline JavaScript.

   Three small, pure kernels that the viewport needs but that no browser API
   can help with:

     fe_taa_halton / fe_taa_jitter   the sub-pixel sampling sequence the
                                     temporal anti-aliasing pass offsets its
                                     projection by
     fe_taa_project                  the reprojection the TAA shader performs,
                                     so a CPU-side probe and the shader agree
     fe_color_blackbody_*            Planck + CIE 1931 colour science, used to
                                     bake the fire temperature ramp texture

   Everything computes in double, the precision a JavaScript number has, and
   the tests compare the wasm results against the JavaScript fallbacks exactly.
   Since the inputs are integers and a fixed wavelength walk, "close enough"
   would hide a real disagreement in a colour table that is baked once and then
   relied on for the rest of the session. */

namespace {
using namespace fe;

/* CIE 1931 multi-lobe Gaussian fit of the 2-degree observer. */
double cie_gaussian(double wave, double mu, double sigma_low, double sigma_high) {
  const double t = (wave - mu) / (wave < mu ? sigma_low : sigma_high);
  return exp64(-0.5 * t * t);
}

void cie_xyz_bar(double wave, double* out3) {
  const double x = 1.056 * cie_gaussian(wave, 599.8, 37.9, 31.0) +
                   0.362 * cie_gaussian(wave, 442.0, 16.0, 26.7) -
                   0.065 * cie_gaussian(wave, 501.1, 20.4, 26.2);
  const double y = 0.821 * cie_gaussian(wave, 568.8, 46.9, 40.5) +
                   0.286 * cie_gaussian(wave, 530.9, 16.3, 31.1);
  const double z = 1.217 * cie_gaussian(wave, 437.0, 11.8, 36.0) +
                   0.681 * cie_gaussian(wave, 459.0, 26.0, 13.8);
  out3[0] = x > 0.0 ? x : 0.0;
  out3[1] = y > 0.0 ? y : 0.0;
  out3[2] = z > 0.0 ? z : 0.0;
}

/* hc/k in m*K. */
constexpr double kPlanckC2 = 1.438776877e-2;

/* Planck spectral radiance up to a constant: the 1/lambda^5 factor is what
 * makes a cool flame red instead of merely dim. */
double planck_radiance(double wave_nm, double kelvin) {
  const double metres = wave_nm * 1e-9;
  const double exponent = kPlanckC2 / (metres * (kelvin > 1.0 ? kelvin : 1.0));
  if (exponent > 700.0) return 0.0;
  return 1.0 / (pow64(metres, 5.0) * expm164(exponent));
}

void blackbody_xyz(double kelvin, double* out3) {
  double T = kelvin;
  if (!(T == T)) T = 1800.0; /* NaN -> the 1800 K default */
  if (T < 500.0) T = 500.0;
  if (T > 40000.0) T = 40000.0;
  double X = 0.0, Y = 0.0, Z = 0.0;
  for (int wave = 360; wave <= 830; wave += 5) {
    double bar[3];
    cie_xyz_bar(static_cast<double>(wave), bar);
    const double radiance = planck_radiance(static_cast<double>(wave), T);
    X += bar[0] * radiance;
    Y += bar[1] * radiance;
    Z += bar[2] * radiance;
  }
  out3[0] = X;
  out3[1] = Y > 1e-12 ? Y : 1e-12;
  out3[2] = Z;
}

/* A colour clamped to [0,1] and rounded onto a byte. Anything not finite is
 * byte 0, which is what storing NaN into a Uint8Array does in JavaScript. */
uint8_t byte_of(double value) {
  if (!isfinite64(value) || !(value > 0.0)) return 0;
  const double clamped = value >= 1.0 ? 1.0 : value;
  return static_cast<uint8_t>(clamped * 255.0 + 0.5);
}

}  // namespace

extern "C" {

/* Radical-inverse sequence: the low-discrepancy basis of the TAA jitter. */
FE_EXPORT double fe_taa_halton(double index, double base) {
  double i = floor64(index);
  if (i < 0.0) i = 0.0;
  const double b = base > 1.0 ? base : 2.0;
  double f = 1.0, result = 0.0;
  while (i > 0.0) {
    f /= b;
    result += f * fmod64(i, b);
    i = floor64(i / b);
  }
  return result;
}

/* Sub-pixel offset in clip-space units: one pixel of amplitude, cycling over 64
 * Halton samples. `out2` receives x and y. */
FE_EXPORT int32_t fe_taa_jitter(double frame, double width, double height, double* out2) {
  if (!out2) return -3;
  const double w = width >= 1.0 ? width : 1.0;
  const double h = height >= 1.0 ? height : 1.0;
  double f = floor64(frame);
  if (f < 0.0) f = 0.0;
  const double index = fmod64(f, 64.0) + 1.0;
  out2[0] = (fe_taa_halton(index, 2.0) - 0.5) * 2.0 / w;
  out2[1] = (fe_taa_halton(index, 3.0) - 0.5) * 2.0 / h;
  return 0;
}

/* Reproject a world point through the previous view-projection. `out3` receives
 * x, y and 1 when the sample is inside the viewport, 0 when it is not. */
FE_EXPORT int32_t fe_taa_project(const double* matrix16, double x, double y, double z,
                                 double* out3) {
  if (!matrix16 || !out3) return -3;
  const double cx = matrix16[0] * x + matrix16[4] * y + matrix16[8] * z + matrix16[12];
  const double cy = matrix16[1] * x + matrix16[5] * y + matrix16[9] * z + matrix16[13];
  const double cw = matrix16[3] * x + matrix16[7] * y + matrix16[11] * z + matrix16[15];
  if (!(cw > 1e-6)) {
    out3[0] = 0.0;
    out3[1] = 0.0;
    out3[2] = 0.0;
    return 0;
  }
  out3[0] = (cx / cw) * 0.5 + 0.5;
  out3[1] = (cy / cw) * 0.5 + 0.5;
  out3[2] = (out3[0] > 0.0 && out3[0] < 1.0 && out3[1] > 0.0 && out3[1] < 1.0) ? 1.0 : 0.0;
  return 0;
}

/* Linear Rec.709 for a blackbody temperature, normalised so the hottest channel
 * is 1 and encoded to display space - the fire shader owns brightness, this
 * owns hue. `out3` receives r, g, b. */
FE_EXPORT int32_t fe_color_blackbody_rgb(double kelvin, double* out3) {
  if (!out3) return -3;
  double xyz[3];
  blackbody_xyz(kelvin, xyz);
  double r = 3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2];
  double g = -0.9692660 * xyz[0] + 1.8760108 * xyz[1] + 0.0415560 * xyz[2];
  double b = 0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2];
  if (r < 0.0) r = 0.0;
  if (g < 0.0) g = 0.0;
  if (b < 0.0) b = 0.0;
  double peak = r > g ? r : g;
  if (b > peak) peak = b;
  if (!(peak > 0.0)) peak = 1.0;
  out3[0] = pow64(r / peak, 1.0 / 2.2);
  out3[1] = pow64(g / peak, 1.0 / 2.2);
  out3[2] = pow64(b / peak, 1.0 / 2.2);
  return 0;
}

/* The temperature ramp texture: `count` RGBA8 entries spanning min_k..max_k.
 * 128 entries times 95 wavelengths of Planck and CIE is the one part of the
 * fire shading that is pure arithmetic, so it is baked here. */
FE_EXPORT int32_t fe_color_blackbody_lut(double min_k, double max_k, uint32_t count,
                                         uint8_t* out_rgba) {
  if (!out_rgba || count == 0 || count > 4096) return -3;
  const double span = static_cast<double>(count - 1);
  for (uint32_t i = 0; i < count; ++i) {
    const double k = min_k + (max_k - min_k) * (static_cast<double>(i) / span);
    double rgb[3];
    fe_color_blackbody_rgb(k, rgb);
    out_rgba[i * 4 + 0] = byte_of(rgb[0]);
    out_rgba[i * 4 + 1] = byte_of(rgb[1]);
    out_rgba[i * 4 + 2] = byte_of(rgb[2]);
    out_rgba[i * 4 + 3] = 255;
  }
  return 0;
}

}  // extern "C"
