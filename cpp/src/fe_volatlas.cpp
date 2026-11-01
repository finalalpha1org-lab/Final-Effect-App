#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

/* Volume atlas packing and the CPU-side trilinear read.

   WebGL1 has no 3D textures, so the smoke/fire solver's (density, temperature)
   lattice is tiled into one RGBA8 2D image: each z slice becomes a tile, R is
   density, G is temperature, A is 255. The same layout is used for the baked
   "cinema" library, where tile = frame * grid + z.

   This used to be a JavaScript loop that ran on every frame of a live volume
   simulation — a 40^3 lattice is 64 000 cells of divide, clamp, multiply and
   round, sixty times a second, in the tab that is also raymarching it. The
   arithmetic is now here and the bridge only copies the finished image out.

   Nothing in this file allocates: the caller owns every buffer, because the
   density and temperature grids already live in this same linear memory (the
   smoke solver's blocks) and the atlas target is the texture's own byte array
   on the JavaScript side. */

namespace {
using namespace fe;

/* Per-axis cap. A live solver runs 24..40; the ceiling only exists so a bad
 * count cannot spin for a minute inside a frame. */
constexpr uint32_t kMaxGrid = 512u;
/* Total tiles one library atlas may hold (frames x slices). */
constexpr uint32_t kMaxTiles = 1u << 20;

/* The JavaScript used Math.ceil(Math.sqrt(g)). Integer search gives the same
 * answer without depending on the accuracy of a float square root. */
uint32_t tiles_ceil_sqrt(uint64_t n) {
  uint32_t t = 1;
  while (static_cast<uint64_t>(t) * t < n) ++t;
  return t;
}

/* t < 0 ? 0 : t > 1 ? 1 : t — NaN passes through, as it did in the
 * JavaScript one-liner the sampler used. */
double clamp_unit(double t) {
  return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
}

/* The packer's clamp is the other one: anything not finite - NaN, either
 * infinity - is byte 0, exactly like the Number.isFinite test it replaces. */
double clamp01(double v) {
  if (!isfinitef(v) || v <= 0.0) return 0.0;
  return v >= 1.0 ? 1.0 : v;
}

double lerpd(double a, double b, double t) { return a + (b - a) * t; }

/* Math.min(limit, Math.floor(f)) || 0, without the JavaScript coercion. */
uint32_t clamp_index(double f, uint32_t limit) {
  const double fl = __builtin_floor(f);
  if (!(fl > 0.0)) return 0;
  if (fl >= static_cast<double>(limit)) return limit;
  return static_cast<uint32_t>(fl);
}

/* Tiles past the last real slice are padding the shader never samples. A fresh
 * JS Uint8Array had them zero; a reused atlas buffer would keep whatever was
 * there before, so they are cleared explicitly and the two paths agree. */
void clear_padding(uint8_t* out, uint32_t width, uint32_t grid, uint32_t cols,
                   uint32_t rows, uint64_t used_tiles) {
  const uint64_t total = static_cast<uint64_t>(cols) * rows;
  for (uint64_t tile = used_tiles; tile < total; ++tile) {
    const uint32_t ox = static_cast<uint32_t>(tile % cols) * grid;
    const uint32_t oy = static_cast<uint32_t>(tile / cols) * grid;
    for (uint32_t y = 0; y < grid; ++y) {
      const uint32_t row = ((oy + y) * width + ox) * 4u;
      for (uint32_t x = 0; x < grid * 4u; ++x) out[row + x] = 0;
    }
  }
}

uint8_t quantize(double value, double scale) {
  const double s = scale > 0.0 ? scale : 1.0;
  return static_cast<uint8_t>(clamp01(value / s) * 255.0 + 0.5);
}

}  // namespace

extern "C" {

/* Tile layout for a `grid`^3 lattice: `out4` receives
 * [tilesX, tilesY, width, height]; the tile for z is (z % tilesX, z / tilesX).
 * Returns 0, or -3 for a grid the shader could not address. */
FE_EXPORT int32_t fe_volatlas_layout(uint32_t grid, uint32_t* out4) {
  if (!out4) return -3;
  if (grid == 0 || grid > kMaxGrid) return -3;
  const uint32_t tiles_x = tiles_ceil_sqrt(grid);
  const uint32_t tiles_y = (grid + tiles_x - 1) / tiles_x;
  out4[0] = tiles_x;
  out4[1] = tiles_y;
  out4[2] = grid * tiles_x;
  out4[3] = grid * tiles_y;
  return 0;
}

/* Bytes one RGBA atlas for `grid` needs. The bridge asks for this before it
 * creates the texture, so it never has to re-derive the layout in JavaScript. */
FE_EXPORT uint32_t fe_volatlas_bytes(uint32_t grid) {
  if (grid == 0 || grid > kMaxGrid) return 0;
  const uint32_t tiles_x = tiles_ceil_sqrt(grid);
  const uint32_t tiles_y = (grid + tiles_x - 1) / tiles_x;
  return grid * tiles_x * grid * tiles_y * 4u;
}

/* Live solver atlas: normalise the two float grids into one RGBA8 image.
 * Division is done in double because the JavaScript version divided two
 * doubles; a float divide would move a value that lands on .5 to the other
 * side of the rounding and change a byte. */
FE_EXPORT int32_t fe_volatlas_pack(const float* density, const float* temperature,
                                   uint32_t grid, double density_scale,
                                   double temperature_scale, uint8_t* out_rgba) {
  if (!density || !temperature || !out_rgba) return -3;
  if (grid == 0 || grid > kMaxGrid) return -3;
  uint32_t info[4];
  fe_volatlas_layout(grid, info);
  const uint32_t tiles_x = info[0];
  const uint32_t width = info[2];
  clear_padding(out_rgba, width, grid, info[0], info[1], grid);

  for (uint32_t z = 0; z < grid; ++z) {
    const uint32_t tile_x = (z % tiles_x) * grid;
    const uint32_t tile_y = (z / tiles_x) * grid;
    for (uint32_t y = 0; y < grid; ++y) {
      const uint32_t row = (tile_y + y) * width + tile_x;
      const uint32_t slice = (z * grid + y) * grid;
      for (uint32_t x = 0; x < grid; ++x) {
        const uint32_t src = slice + x;
        const uint32_t dst = (row + x) * 4u;
        out_rgba[dst + 0] = quantize(static_cast<double>(density[src]), density_scale);
        out_rgba[dst + 1] = quantize(static_cast<double>(temperature[src]), temperature_scale);
        out_rgba[dst + 2] = 0;
        out_rgba[dst + 3] = 255;
      }
    }
  }
  return 0;
}

/* Baked library atlas: frames x z slices become tiles, tile = frame * grid + z.
 * `frames_rg` is the packed library payload (two bytes per cell, density then
 * temperature). `out_dims4` receives [tilesX, tilesY, width, height]. */
FE_EXPORT int32_t fe_volatlas_pack_library(const uint8_t* frames_rg, uint32_t grid,
                                           uint32_t frame_count, uint8_t* out_rgba,
                                           uint32_t* out_dims4) {
  if (!frames_rg || !out_rgba || !out_dims4) return -3;
  if (grid == 0 || grid > kMaxGrid || frame_count == 0) return -3;

  const uint64_t tiles64 = static_cast<uint64_t>(frame_count) * grid;
  if (tiles64 > kMaxTiles) return -3;
  const uint32_t tiles = static_cast<uint32_t>(tiles64);
  const uint32_t cols = tiles_ceil_sqrt(tiles);
  const uint32_t rows = (tiles + cols - 1) / cols;
  const uint32_t width = cols * grid;
  const uint32_t height = rows * grid;
  out_dims4[0] = cols;
  out_dims4[1] = rows;
  out_dims4[2] = width;
  out_dims4[3] = height;

  clear_padding(out_rgba, width, grid, cols, rows, tiles);

  const uint32_t cells = grid * grid * grid;
  for (uint32_t f = 0; f < frame_count; ++f) {
    const uint8_t* frame = frames_rg + static_cast<size_t>(f) * cells * 2u;
    for (uint32_t z = 0; z < grid; ++z) {
      const uint32_t tile = f * grid + z;
      const uint32_t ox = (tile % cols) * grid;
      const uint32_t oy = (tile / cols) * grid;
      for (uint32_t y = 0; y < grid; ++y) {
        const uint32_t row = ((oy + y) * width + ox) * 4u;
        for (uint32_t x = 0; x < grid; ++x) {
          const uint32_t s = ((z * grid + y) * grid + x) * 2u;
          const uint32_t o = row + x * 4u;
          out_rgba[o + 0] = frame[s + 0];
          out_rgba[o + 1] = frame[s + 1];
          out_rgba[o + 3] = 255;
        }
      }
    }
  }
  return 0;
}

/* Trilinear read of one frame in normalised domain space, both channels.
 * Same clamp-and-blend the JavaScript helper did, so a probe value is
 * unchanged to the last bit of the 8-bit lattice. */
FE_EXPORT int32_t fe_volatlas_sample(const uint8_t* frames_rg, uint32_t grid,
                                     uint32_t frame, double u, double v, double w,
                                     double* out2) {
  if (!frames_rg || !out2) return -3;
  if (grid < 2 || grid > kMaxGrid) return -3;

  const double du = clamp_unit(u), dv = clamp_unit(v), dw = clamp_unit(w);
  const double fx = du * static_cast<double>(grid - 1);
  const double fy = dv * static_cast<double>(grid - 1);
  const double fz = dw * static_cast<double>(grid - 1);
  const uint32_t limit = grid - 2;
  const uint32_t ix = clamp_index(fx, limit);
  const uint32_t iy = clamp_index(fy, limit);
  const uint32_t iz = clamp_index(fz, limit);
  const double tx = fx - static_cast<double>(ix);
  const double ty = fy - static_cast<double>(iy);
  const double tz = fz - static_cast<double>(iz);

  const uint8_t* base = frames_rg + static_cast<size_t>(frame) * grid * grid * grid * 2u;
  for (uint32_t c = 0; c < 2; ++c) {
    const auto read = [&](uint32_t x, uint32_t y, uint32_t z) -> double {
      return static_cast<double>(base[((z * grid + y) * grid + x) * 2u + c]) / 255.0;
    };
    const double c000 = read(ix, iy, iz), c100 = read(ix + 1, iy, iz);
    const double c010 = read(ix, iy + 1, iz), c110 = read(ix + 1, iy + 1, iz);
    const double c001 = read(ix, iy, iz + 1), c101 = read(ix + 1, iy, iz + 1);
    const double c011 = read(ix, iy + 1, iz + 1), c111 = read(ix + 1, iy + 1, iz + 1);
    const double z0 = lerpd(lerpd(c000, c100, tx), lerpd(c010, c110, tx), ty);
    const double z1 = lerpd(lerpd(c001, c101, tx), lerpd(c011, c111, tx), ty);
    out2[c] = lerpd(z0, z1, tz);
  }
  return 0;
}

/* Ping-pong playback: forward then backward, so a short loop never snaps from
 * the last frame back to the first. `out_ab` receives [a, b] and `out_blend`
 * the weight of b. `fps` of 0 or less means 24, the library's default.
 * The modulo is truncated, not floored, because that is what `%` does in
 * JavaScript — with a negative time the two would disagree. */
FE_EXPORT int32_t fe_volatlas_frame_at(uint32_t frames, double fps, double seconds,
                                       double motion, int32_t* out_ab,
                                       double* out_blend) {
  if (!out_ab || !out_blend) return -3;
  if (frames == 0) {
    out_ab[0] = 0;
    out_ab[1] = 0;
    *out_blend = 0.0;
    return 0;
  }
  const double speed = motion > 0.0 ? motion : 0.0;
  const double rate = fps > 0.0 ? fps : 24.0;
  const double span = frames > 1 ? static_cast<double>(frames - 1) : 1.0;
  double phase = (seconds * rate * speed) / span;
  if (!isfinitef(phase)) phase = 0.0;
  double wrap = phase - 2.0 * __builtin_trunc(phase / 2.0); /* fmod(phase, 2) */
  const double wave = __builtin_fabs(wrap - 1.0);            /* 1 -> 0 -> 1 */
  const double pos = (1.0 - wave) * span;
  const double fa = __builtin_floor(pos);
  const int32_t a = static_cast<int32_t>(fa);
  const int32_t limit = frames > 1 ? static_cast<int32_t>(frames - 1) : 0;
  const int32_t b = (a + 1) > limit ? limit : a + 1;
  out_ab[0] = a;
  out_ab[1] = b;
  *out_blend = pos - fa;
  return 0;
}

/* Read the baked-library header and describe each variant: seven u32 per
 * variant (name offset, name length, grid, frames, fps, data offset, data
 * length), written into `out_meta`. Returns the variant count, or
 * -1 bad magic, -2 truncated data, -3 bad argument / table too small.
 *
 * The file format stays a JavaScript concern in the sense that the objects it
 * builds are JavaScript objects, but the walk over the bytes - and the bounds
 * checks that decide whether the file is valid - are here, once, so a truncated
 * download is refused rather than half-read. */
FE_EXPORT int32_t fe_volatlas_parse_library(const uint8_t* bytes, uint32_t length,
                                            uint32_t* out_meta, uint32_t meta_capacity) {
  if (!bytes || !out_meta) return -3;
  static const char kMagic[6] = {'F', 'E', 'L', 'I', 'B', '1'};
  if (length < 9) return -2;
  for (uint32_t i = 0; i < 6; ++i) {
    if (bytes[i] != static_cast<uint8_t>(kMagic[i])) return -1;
  }
  const uint32_t count = bytes[8];
  if (count > meta_capacity) return -3;
  uint64_t offset = 9;
  for (uint32_t v = 0; v < count; ++v) {
    if (offset >= length) return -2;
    const uint32_t name_length = bytes[offset++];
    if (offset + name_length + 6 > length) return -2;
    const uint32_t name_offset = static_cast<uint32_t>(offset);
    offset += name_length;
    const uint32_t grid = static_cast<uint32_t>(bytes[offset]) |
                          (static_cast<uint32_t>(bytes[offset + 1]) << 8);
    offset += 2;
    const uint32_t frames = static_cast<uint32_t>(bytes[offset]) |
                            (static_cast<uint32_t>(bytes[offset + 1]) << 8);
    offset += 2;
    const uint32_t fps = bytes[offset++];
    offset++; /* reserved */
    const uint64_t cells = static_cast<uint64_t>(grid) * grid * grid;
    const uint64_t byte_length = cells * 2u * frames;
    if (offset + byte_length > length) return -2;
    uint32_t* meta = out_meta + static_cast<size_t>(v) * 7u;
    meta[0] = name_offset;
    meta[1] = name_length;
    meta[2] = grid;
    meta[3] = frames;
    meta[4] = fps;
    meta[5] = static_cast<uint32_t>(offset);
    meta[6] = static_cast<uint32_t>(byte_length);
    offset += byte_length;
  }
  return static_cast<int32_t>(count);
}

}  // extern "C"
