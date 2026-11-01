#pragma once

/* Double-precision maths for the kernels that have to agree with JavaScript.

   The engine is built freestanding (-nostdlib, no libm), so `exp`, `log`, `pow`
   and `fmod` simply do not exist in a wasm build: the compiler emits calls to
   libm and wasm-ld refuses the link. The float versions in fe_math.hpp are too
   coarse for work that is compared against a JavaScript number, which is an
   IEEE double.

   So this header carries the handful of double functions the render maths
   needs, each accurate to a fraction of an ulp over the range the app actually
   uses. They are not a general libm: no subnormal handling beyond clamping, no
   errno, no rounding modes. That is fine here - the callers are a 128-entry
   colour table and a sub-pixel jitter sequence. */

#include <stdint.h>

namespace fe {

inline double floor64(double x) { return __builtin_floor(x); }
inline double trunc64(double x) { return __builtin_trunc(x); }
inline double fabs64(double x) { return __builtin_fabs(x); }
inline double sqrt64(double x) { return __builtin_sqrt(x); }
inline bool isfinite64(double x) { return __builtin_isfinite(x); }

constexpr double kLn2 = 0.6931471805599453094172321;
constexpr double kInvLn2 = 1.4426950408889634073599247;
constexpr double kSqrtHalf = 0.70710678118654752440;

/* 2^k for an integer k, built by writing the exponent field directly. */
inline double pow2i(int32_t k) {
  if (k < -1022) return 0.0;
  if (k > 1023) return __builtin_inf();
  const uint64_t bits = static_cast<uint64_t>(static_cast<int64_t>(k) + 1023) << 52;
  double out;
  __builtin_memcpy(&out, &bits, sizeof(out));
  return out;
}

/* x - trunc(x / y) * y, with the same sign behaviour as C's fmod / JS `%`. */
inline double fmod64(double x, double y) {
  if (y == 0.0 || !isfinite64(x) || !(y == y)) return __builtin_nan("");
  return x - trunc64(x / y) * y;
}

inline double exp64(double x) {
  if (!(x == x)) return x;                       /* NaN */
  if (x > 709.782712893384) return __builtin_inf();
  if (x < -745.1332191019411) return 0.0;
  const double k = floor64(x * kInvLn2 + 0.5);
  const double r = x - k * kLn2;                 /* |r| <= 0.3466 */
  /* Taylor series of exp(r): 14 terms is below one ulp at this range. */
  double term = 1.0, sum = 1.0;
  for (int i = 1; i <= 14; ++i) {
    term *= r / static_cast<double>(i);
    sum += term;
  }
  return sum * pow2i(static_cast<int32_t>(k));
}

inline double expm164(double x) {
  if (x > 1e-5) return exp64(x) - 1.0;
  /* The small argument is the only place exp(x) - 1 loses its precision; two
     series terms cover it exactly enough. */
  return x + 0.5 * x * x + x * x * x / 6.0 + x * x * x * x / 24.0;
}

inline double log64(double x) {
  if (!(x > 0.0)) return x == 0.0 ? -__builtin_inf() : __builtin_nan("");
  uint64_t bits;
  __builtin_memcpy(&bits, &x, sizeof(bits));
  int32_t e = static_cast<int32_t>((bits >> 52) & 0x7FFu) - 1023;
  bits = (bits & 0x000FFFFFFFFFFFFFull) | 0x3FF0000000000000ull;
  double m;
  __builtin_memcpy(&m, &bits, sizeof(m));        /* m in [1, 2) */
  if (m > 1.4142135623730951) {
    m *= 0.5;
    e += 1;
  }
  const double t = (m - 1.0) / (m + 1.0);        /* |t| <= 0.1716 */
  const double t2 = t * t;
  const double series = 2.0 * t * (1.0 + t2 * (1.0 / 3.0 + t2 * (0.2 + t2 * (1.0 / 7.0 +
                         t2 * (1.0 / 9.0 + t2 * (1.0 / 11.0 + t2 * (1.0 / 13.0 +
                         t2 * (1.0 / 15.0))))))));
  return static_cast<double>(e) * kLn2 + series;
}

inline double pow64(double base, double exponent) {
  if (base <= 0.0) return 0.0;
  return exp64(exponent * log64(base));
}

}  // namespace fe
