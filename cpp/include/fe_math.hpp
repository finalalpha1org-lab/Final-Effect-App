#ifndef FE_MATH_HPP
#define FE_MATH_HPP

#include <stdint.h>
#include <stddef.h>

namespace fe {

constexpr float kPi      = 3.14159265358979323846f;
constexpr float kTwoPi   = 6.28318530717958647692f;
constexpr float kHalfPi  = 1.57079632679489661923f;
constexpr float kInvPi   = 0.31830988618379067154f;
constexpr float kDeg2Rad = kPi / 180.0f;
constexpr float kRad2Deg = 180.0f / kPi;
constexpr float kEps     = 1e-6f;

/* ---- Hardware-intrinsic & freestanding-safe scalar math ---- */
inline float absf(float x)   { return __builtin_fabsf(x); }
inline float sqrtf(float x)  { return x > 0.0f ? __builtin_sqrtf(x) : 0.0f; }
inline float floorf(float x) { return __builtin_floorf(x); }
inline float ceilf(float x)  { return __builtin_ceilf(x); }
inline bool  isfinitef(float x) { return __builtin_isfinite(x); }

inline float minf(float a, float b) { return a < b ? a : b; }
inline float maxf(float a, float b) { return a > b ? a : b; }
inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }
inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }
inline float smoothstepf(float e0, float e1, float x) {
  const float d = e1 - e0;
  if (absf(d) < 1e-12f) return x >= e1 ? 1.0f : 0.0f;
  const float t = clampf((x - e0) / d, 0.0f, 1.0f);
  return t * t * (3.0f - 2.0f * t);
}

/* High-accuracy minimax sin/cos on [-pi, pi] (max error < 1.5e-7) */
inline float sinf(float x) {
  float k = floorf(x * (1.0f / kTwoPi) + 0.5f);
  x -= k * kTwoPi;
  if (x > kHalfPi) x = kPi - x;
  else if (x < -kHalfPi) x = -kPi - x;
  const float x2 = x * x;
  return x * (1.0f + x2 * (-0.1666666664f + x2 * (0.0083333310f + x2 * (-0.00019840874f + x2 * 2.7525562e-6f))));
}

inline float cosf(float x) {
  return sinf(x + kHalfPi);
}

inline float tanf(float x) {
  const float c = cosf(x);
  return absf(c) > 1e-6f ? (sinf(x) / c) : (c >= 0.0f ? 1e6f : -1e6f);
}

/* Accurate atan2f (max error < 2e-6) */
inline float atanf_unit(float z) {
  const float z2 = z * z;
  return z * (0.99997726f + z2 * (-0.33262347f + z2 * (0.19354346f + z2 * (-0.11643287f + z2 * (0.05265332f - 0.01172120f * z2)))));
}

inline float atan2f(float y, float x) {
  if (x == 0.0f && y == 0.0f) return 0.0f;
  const float ay = absf(y), ax = absf(x);
  float a = (ax >= ay) ? atanf_unit(ay / ax) : (kHalfPi - atanf_unit(ax / ay));
  if (x < 0.0f) a = kPi - a;
  return y < 0.0f ? -a : a;
}

/* IEEE-754 bit-cast helpers for fast exp2/log2/pow */
inline uint32_t float_to_bits(float f) {
  uint32_t u;
  __builtin_memcpy(&u, &f, sizeof(u));
  return u;
}
inline float bits_to_float(uint32_t u) {
  float f;
  __builtin_memcpy(&f, &u, sizeof(f));
  return f;
}

inline float exp2f(float x) {
  x = clampf(x, -126.0f, 126.0f);
  const float fl = floorf(x);
  const float f = x - fl;
  const int32_t i = static_cast<int32_t>(fl);
  const float p = 1.0f + f * (0.69314718f + f * (0.24022650f + f * (0.05550411f + f * (0.00961813f + f * 0.00133336f))));
  const uint32_t scale_bits = static_cast<uint32_t>((i + 127) << 23);
  return p * bits_to_float(scale_bits);
}

inline float log2f(float x) {
  if (x <= 1e-37f) return -126.0f;
  const uint32_t bits = float_to_bits(x);
  const int32_t exp_i = static_cast<int32_t>((bits >> 23) & 0xFFu) - 127;
  const float m = bits_to_float((bits & 0x007FFFFFu) | 0x3F800000u);
  const float t = (m - 1.0f) / (m + 1.0f);
  const float t2 = t * t;
  const float ln_m = 2.0f * t * (1.0f + t2 * (0.33333333f + t2 * (0.2f + t2 * (0.14285714f + t2 * 0.11111111f))));
  return static_cast<float>(exp_i) + ln_m * 1.44269504089f;
}

inline float powf(float base, float exp) {
  if (base <= 0.0f) return 0.0f;
  return exp2f(exp * log2f(base));
}

/* powi(x, n) — exponentiation by squaring. Every integer exponent in the
   renderer used to go through exp2/log2 (two polynomial evaluations and a
   float->int round trip); a lobe with exponent 48 is six multiplies instead. */
inline float powi(float base, uint32_t e) {
  float r = 1.0f;
  float b = base;
  while (e) {
    if (e & 1u) r *= b;
    b *= b;
    e >>= 1u;
  }
  return r;
}

inline float expf(float x) {
  return exp2f(x * 1.44269504089f);
}

/* ---- 3D Vector ---- */
struct Vec3 {
  float x, y, z;

  constexpr Vec3() : x(0.0f), y(0.0f), z(0.0f) {}
  constexpr Vec3(float s) : x(s), y(s), z(s) {}
  constexpr Vec3(float x_, float y_, float z_) : x(x_), y(y_), z(z_) {}

  constexpr Vec3 operator+(const Vec3& r) const { return {x + r.x, y + r.y, z + r.z}; }
  constexpr Vec3 operator-(const Vec3& r) const { return {x - r.x, y - r.y, z - r.z}; }
  constexpr Vec3 operator-() const { return {-x, -y, -z}; }
  constexpr Vec3 operator*(float s) const { return {x * s, y * s, z * s}; }
  constexpr Vec3 operator*(const Vec3& r) const { return {x * r.x, y * r.y, z * r.z}; }
  Vec3& operator+=(const Vec3& r) { x += r.x; y += r.y; z += r.z; return *this; }
  Vec3& operator*=(float s) { x *= s; y *= s; z *= s; return *this; }

  static constexpr float dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static constexpr Vec3 cross(const Vec3& a, const Vec3& b) {
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
  }
  constexpr float length_sq() const { return x * x + y * y + z * z; }
  float length() const { return sqrtf(length_sq()); }
  Vec3 normalized() const {
    const float len = length();
    return len > 1e-8f ? (*this * (1.0f / len)) : Vec3(0.0f, 1.0f, 0.0f);
  }
};

inline constexpr Vec3 operator*(float s, const Vec3& v) { return {v.x * s, v.y * s, v.z * s}; }
inline constexpr float dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline constexpr Vec3 cross(const Vec3& a, const Vec3& b) {
  return {
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
  };
}
inline constexpr float length_sq(const Vec3& v) { return dot(v, v); }
inline float length(const Vec3& v) { return sqrtf(length_sq(v)); }
inline Vec3 normalize(const Vec3& v) {
  const float len = length(v);
  return len > 1e-8f ? (v * (1.0f / len)) : Vec3(0.0f, 1.0f, 0.0f);
}
inline Vec3 minv(const Vec3& a, const Vec3& b) { return {minf(a.x, b.x), minf(a.y, b.y), minf(a.z, b.z)}; }
inline Vec3 maxv(const Vec3& a, const Vec3& b) { return {maxf(a.x, b.x), maxf(a.y, b.y), maxf(a.z, b.z)}; }
inline Vec3 lerpv(const Vec3& a, const Vec3& b, float t) {
  return {lerpf(a.x, b.x, t), lerpf(a.y, b.y, t), lerpf(a.z, b.z, t)};
}
inline Vec3 reflect(const Vec3& i, const Vec3& n) {
  return i - n * (2.0f * dot(i, n));
}

/* ---- Quaternion (Three.js XYZ intrinsic Euler compatible) ---- */
struct Quat {
  float x, y, z, w;
  constexpr Quat() : x(0.0f), y(0.0f), z(0.0f), w(1.0f) {}
  constexpr Quat(float x_, float y_, float z_, float w_) : x(x_), y(y_), z(z_), w(w_) {}

  static Quat from_euler_xyz_deg(float rx_deg, float ry_deg, float rz_deg) {
    const float hx = rx_deg * kDeg2Rad * 0.5f;
    const float hy = ry_deg * kDeg2Rad * 0.5f;
    const float hz = rz_deg * kDeg2Rad * 0.5f;
    const float c1 = cosf(hx), s1 = sinf(hx);
    const float c2 = cosf(hy), s2 = sinf(hy);
    const float c3 = cosf(hz), s3 = sinf(hz);
    /* Three.js 'XYZ' Euler order */
    return {
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3
    };
  }

  Quat normalized() const {
    const float n = sqrtf(x * x + y * y + z * z + w * w);
    if (n < 1e-8f) return Quat();
    const float inv = 1.0f / n;
    return {x * inv, y * inv, z * inv, w * inv};
  }
};

/* ---- Axis-Aligned Bounding Box & Ray ---- */
struct AABB {
  Vec3 bmin;
  Vec3 bmax;

  constexpr AABB() : bmin(1e30f), bmax(-1e30f) {}
  constexpr AABB(const Vec3& mn, const Vec3& mx) : bmin(mn), bmax(mx) {}

  void expand(const Vec3& p) {
    bmin = minv(bmin, p);
    bmax = maxv(bmax, p);
  }
  void expand_box(const AABB& b) {
    bmin = minv(bmin, b.bmin);
    bmax = maxv(bmax, b.bmax);
  }
  Vec3 centroid() const { return (bmin + bmax) * 0.5f; }
};

struct Ray {
  Vec3 origin;
  Vec3 dir;
  Vec3 inv_dir;

  Ray() = default;
  Ray(const Vec3& o, const Vec3& d) : origin(o), dir(d) {
    inv_dir.x = absf(d.x) > 1e-8f ? (1.0f / d.x) : (d.x >= 0.0f ? 1e8f : -1e8f);
    inv_dir.y = absf(d.y) > 1e-8f ? (1.0f / d.y) : (d.y >= 0.0f ? 1e8f : -1e8f);
    inv_dir.z = absf(d.z) > 1e-8f ? (1.0f / d.z) : (d.z >= 0.0f ? 1e8f : -1e8f);
  }
};

inline bool intersect_aabb(const Ray& r, const AABB& box, float t_max) {
  float t1 = (box.bmin.x - r.origin.x) * r.inv_dir.x;
  float t2 = (box.bmax.x - r.origin.x) * r.inv_dir.x;
  float tmin = minf(t1, t2);
  float tmax = maxf(t1, t2);

  t1 = (box.bmin.y - r.origin.y) * r.inv_dir.y;
  t2 = (box.bmax.y - r.origin.y) * r.inv_dir.y;
  tmin = maxf(tmin, minf(t1, t2));
  tmax = minf(tmax, maxf(t1, t2));

  t1 = (box.bmin.z - r.origin.z) * r.inv_dir.z;
  t2 = (box.bmax.z - r.origin.z) * r.inv_dir.z;
  tmin = maxf(tmin, minf(t1, t2));
  tmax = minf(tmax, maxf(t1, t2));

  return tmax >= maxf(tmin, 1e-4f) && tmin < t_max;
}

/* ---- Deterministic Fast PCG32 Random Number Generator ---- */
struct RNG {
  uint64_t state;
  uint64_t inc;

  constexpr explicit RNG(uint64_t seed = 0x853c49e6748fea9bULL, uint64_t seq = 0xda3e39cb94b95bdbULL)
    : state(0ULL), inc((seq << 1u) | 1u) {
    next_u32();
    state += seed;
    next_u32();
  }

  constexpr uint32_t next_u32() {
    uint64_t oldstate = state;
    state = oldstate * 6364136223846793005ULL + inc;
    uint32_t xorshifted = static_cast<uint32_t>(((oldstate >> 18u) ^ oldstate) >> 27u);
    uint32_t rot = static_cast<uint32_t>(oldstate >> 59u);
    return (xorshifted >> rot) | (xorshifted << ((-rot) & 31u));
  }

  float next_f01() {
    return static_cast<float>(next_u32() >> 8u) * (1.0f / 16777216.0f);
  }
};

/* ---- Tone Mapping & Color Space Utilities ---- */
inline Vec3 tonemap_aces(const Vec3& c) {
  constexpr float a = 2.51f, b = 0.03f, cc = 2.43f, d = 0.59f, e = 0.14f;
  auto map1 = [&](float x) {
    x = maxf(0.0f, x);
    return clampf((x * (a * x + b)) / (x * (cc * x + d) + e), 0.0f, 1.0f);
  };
  return {map1(c.x), map1(c.y), map1(c.z)};
}

inline Vec3 tonemap_agx_punchy(const Vec3& c) {
  /* AgX-inspired inset crosstalk + sigmoid shoulder for vibrant highlights without clipping hue */
  Vec3 inset(
    0.84247906f * maxf(0.0f, c.x) + 0.0784336f  * maxf(0.0f, c.y) + 0.07922375f * maxf(0.0f, c.z),
    0.04232824f * maxf(0.0f, c.x) + 0.87846864f * maxf(0.0f, c.y) + 0.07916613f * maxf(0.0f, c.z),
    0.04237565f * maxf(0.0f, c.x) + 0.0784336f  * maxf(0.0f, c.y) + 0.87914297f * maxf(0.0f, c.z)
  );
  auto curve = [](float v) {
    const float x = v / (v + 0.65f);
    return clampf(powf(x, 1.12f), 0.0f, 1.0f);
  };
  return {curve(inset.x), curve(inset.y), curve(inset.z)};
}

inline Vec3 tonemap_reinhard(const Vec3& c) {
  return {
    clampf(maxf(0.0f, c.x) / (1.0f + maxf(0.0f, c.x)), 0.0f, 1.0f),
    clampf(maxf(0.0f, c.y) / (1.0f + maxf(0.0f, c.y)), 0.0f, 1.0f),
    clampf(maxf(0.0f, c.z) / (1.0f + maxf(0.0f, c.z)), 0.0f, 1.0f)
  };
}

inline Vec3 tonemap_filmic(const Vec3& c) {
  auto u2 = [](float x) {
    x = maxf(0.0f, x);
    return ((x * (0.15f * x + 0.05f) + 0.004f) / (x * (0.15f * x + 0.50f) + 0.06f)) - (0.004f / 0.06f);
  };
  const float w = 1.0f / u2(11.2f);
  return {clampf(u2(c.x * 2.0f) * w, 0.0f, 1.0f), clampf(u2(c.y * 2.0f) * w, 0.0f, 1.0f), clampf(u2(c.z * 2.0f) * w, 0.0f, 1.0f)};
}

inline float linear_to_srgb(float x) {
  x = clampf(x, 0.0f, 1.0f);
  return x <= 0.0031308f ? (12.92f * x) : (1.055f * powf(x, 1.0f / 2.4f) - 0.055f);
}

inline float srgb_to_linear(float x) {
  x = clampf(x, 0.0f, 1.0f);
  return x <= 0.04045f ? (x / 12.92f) : powf((x + 0.055f) / 1.055f, 2.4f);
}

} // namespace fe

#endif /* FE_MATH_HPP */
