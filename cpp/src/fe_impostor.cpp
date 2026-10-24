/* Foliage impostors.
 * =========================================================================
 * A tree at 3 km is a few pixels wide. Drawing its 9 000 triangles there costs
 * more than everything else on screen, and the low-detail twin is only half the
 * size of the problem. An impostor is the standard answer: bake the plant from a
 * ring of viewpoints into an atlas, then draw one camera-facing quad per plant.
 *
 * What matters is that the impostor is baked from the real model. Nothing here
 * is authored art: this file takes the mesh the flora kernel just grew for the
 * species — the same trunks, the same leaf cards, the same vertex colours — and
 * rasterises it, so a pine's impostor is that pine. The eight azimuths are
 * rendered with the same key light as the lit scene, which is why the atlas
 * carries its form instead of looking like a sticker.
 *
 * The rasteriser is a plain scanline-with-barycentrics over the triangle list,
 * supersampled 2x, with a z-buffer so a branch in front of a trunk wins. Alpha
 * is the coverage mask; the shader cuts on it, and the quad is billboarded
 * around Y (foliage does not look right tipping over as the camera tilts).
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_flora_geom.hpp"
#include "../include/fe_math.hpp"

/* The species entry point, defined in fe_flora.cpp. */
extern "C" int32_t fe_flora_tree(int32_t kind, uint32_t seed, int32_t detail);

namespace {

using namespace fe;

/* Both dimensions are powers of two so the studio can build a mip chain even
 * on a WebGL1 fallback — without one, a plant 2 km away is 20 texels wide and
 * shimmers as the camera drifts. */
constexpr int32_t IMP_W = 64;      /* atlas tile, texels                       */
constexpr int32_t IMP_H = 128;
constexpr int32_t IMP_MAX_VIEWS = 8;
constexpr int32_t IMP_SS = 2;      /* supersampling factor per axis            */
constexpr int32_t IMP_SW = IMP_W * IMP_SS;
constexpr int32_t IMP_SH = IMP_H * IMP_SS;

/* Supersampled working buffers: colour + coverage, and depth. */
float impColor[IMP_SW * IMP_SH * 4];
float impDepth[IMP_SW * IMP_SH];
float impSx[24000 + 4];
float impSy[24000 + 4];
float impSz[24000 + 4];

uint8_t impPixels[IMP_MAX_VIEWS * IMP_W * IMP_H * 4];
int32_t impViews = 0;
/* [0] quad width (m)  [1] quad height (m)  [2] coverage 0..1  [3] base y (m)
 * [4] used tile width 0..1  [5] used tile height 0..1  [6] u offset 0..1
 * [7] reserved. The used rectangle is the union of all eight views, so one quad
 * size serves the whole ring and the transparent margin is cropped away. */
float impBounds[8];
float impScale = 1.0f;   /* texels per metre of the atlas currently baked     */

inline float lambert(float nx, float ny, float nz) {
  /* Key light from the upper front left, the same direction the studio's sun
   * arrives from. Foliage is two-sided, so a back-facing normal is lit dimly
   * rather than left black — cards in a canopy face every way at once. */
  const float d = nx * -0.4236f + ny * 0.8040f + nz * -0.4194f;
  const float ndl = d >= 0.0f ? d : -d * 0.45f;
  return 0.56f + 0.44f * ndl;
}

/* Project and rasterise one vertex array into the working buffers. Called once
 * for the wood and once for the leaf cards, so a broadleaf's canopy —
 * which lives entirely in the card buffer — lands in the same atlas. */
void rasterSurface(const float* pos, const float* nrm, const float* col, const uint32_t* idx,
                   int32_t nv, int32_t ni, float scale, float cx, float baseY,
                   float rx, float rz, float dx, float dz, uint32_t seed) {
  if (nv <= 0 || ni < 3 || nv > 24000) return;
  for (int32_t i = 0; i < nv; i++) {
    const float x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    impSx[i] = ((x * rx + z * rz) * scale + cx);
    impSy[i] = ((y - baseY) * scale);
    impSz[i] = (x * dx + z * dz);                 /* larger = nearer viewer */
  }

  for (int32_t t = 0; t < ni; t += 3) {
    const int32_t a = int32_t(idx[t]);
    const int32_t b = int32_t(idx[t + 1]);
    const int32_t c = int32_t(idx[t + 2]);
    if (a >= nv || b >= nv || c >= nv) continue;
    const float ax = impSx[a], ay = impSy[a], bx = impSx[b], by = impSy[b], cx2 = impSx[c], cy2 = impSy[c];
    const float area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    if (area > -1.0e-6f && area < 1.0e-6f) continue;   /* edge-on: no pixels */
    const float inv = 1.0f / area;
    /* Bounding box clipped to the tile. */
    int32_t x0 = int32_t(floorf(minf(ax, minf(bx, cx2))));
    int32_t x1 = int32_t(ceilf(maxf(ax, maxf(bx, cx2))));
    int32_t y0 = int32_t(floorf(minf(ay, minf(by, cy2))));
    int32_t y1 = int32_t(ceilf(maxf(ay, maxf(by, cy2))));
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= IMP_SW) x1 = IMP_SW - 1;
    if (y1 >= IMP_SH) y1 = IMP_SH - 1;
    if (x1 < x0 || y1 < y0) continue;

    const float szA = impSz[a], szB = impSz[b], szC = impSz[c];
    float shadeA = lambert(nrm[a * 3], nrm[a * 3 + 1], nrm[a * 3 + 2]);
    float shadeB = lambert(nrm[b * 3], nrm[b * 3 + 1], nrm[b * 3 + 2]);
    float shadeC = lambert(nrm[c * 3], nrm[c * 3 + 1], nrm[c * 3 + 2]);
    /* A little per-vertex break-up so a flat canopy does not read as one sheet. */
    const float dither = float(seed & 31) * 0.002f;
    shadeA += dither;
    shadeB += dither;
    shadeC += dither;

    for (int32_t y = y0; y <= y1; y++) {
      const float py = float(y) + 0.5f;
      for (int32_t x = x0; x <= x1; x++) {
        const float px = float(x) + 0.5f;
        /* Barycentrics via edge functions. */
        const float w0 = ((bx - px) * (cy2 - py) - (by - py) * (cx2 - px)) * inv;
        const float w1 = ((cx2 - px) * (ay - py) - (cy2 - py) * (ax - px)) * inv;
        const float w2 = 1.0f - w0 - w1;
        if (w0 < -1.0e-4f || w1 < -1.0e-4f || w2 < -1.0e-4f) continue;
        const float z = w0 * szA + w1 * szB + w2 * szC;
        const int32_t at = y * IMP_SW + x;
        if (z <= impDepth[at]) continue;
        impDepth[at] = z;
        const float sh = w0 * shadeA + w1 * shadeB + w2 * shadeC;
        impColor[at * 4 + 0] = (w0 * col[a * 3] + w1 * col[b * 3] + w2 * col[c * 3]) * sh;
        impColor[at * 4 + 1] = (w0 * col[a * 3 + 1] + w1 * col[b * 3 + 1] + w2 * col[c * 3 + 1]) * sh;
        impColor[at * 4 + 2] = (w0 * col[a * 3 + 2] + w1 * col[b * 3 + 2] + w2 * col[c * 3 + 2]) * sh;
        impColor[at * 4 + 3] = 1.0f;
      }
    }
  }
}

/* Bake one azimuth into the atlas tile for `view`. */
void rasterise(int32_t view, uint32_t seed) {
  const int32_t nv = fe_flora_geom::verts();
  const int32_t ni = fe_flora_geom::indices();
  const int32_t cv = fe_flora_geom::card_verts();
  const int32_t ci = fe_flora_geom::card_indices();
  if ((nv <= 0 || ni < 3) && (cv <= 0 || ci < 3)) return;

  for (int32_t i = 0; i < IMP_SW * IMP_SH; i++) {
    impDepth[i] = -3.0e30f;
    impColor[i * 4 + 0] = 0.0f;
    impColor[i * 4 + 1] = 0.0f;
    impColor[i * 4 + 2] = 0.0f;
    impColor[i * 4 + 3] = 0.0f;
  }

  const float* pos = fe_flora_geom::pos();
  const float* nrm = fe_flora_geom::nrm();
  const float* col = fe_flora_geom::col();
  const float* cpos = fe_flora_geom::card_pos();
  const float* cnrm = fe_flora_geom::card_nrm();
  const float* ccol = fe_flora_geom::card_col();

  /* Bounds in world space, over both buffers: every view then shares one scale,
   * so the plant does not change size as the camera orbits and the quad the
   * studio draws is the same size whichever azimuth it picked. */
  float minY = 3.0e30f, maxY = -3.0e30f, maxR = 0.0f;
  for (int32_t i = 0; i < nv; i++) {
    const float x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (!isfinitef(x) || !isfinitef(y) || !isfinitef(z)) continue;
    minY = minf(minY, y); maxY = maxf(maxY, y);
    maxR = maxf(maxR, sqrtf(x * x + z * z));
  }
  for (int32_t i = 0; i < cv; i++) {
    const float x = cpos[i * 3], y = cpos[i * 3 + 1], z = cpos[i * 3 + 2];
    if (!isfinitef(x) || !isfinitef(y) || !isfinitef(z)) continue;
    minY = minf(minY, y); maxY = maxf(maxY, y);
    maxR = maxf(maxR, sqrtf(x * x + z * z));
  }
  if (!(maxY > minY)) return;
  const float modelH = maxY - minY;
  const float modelR = maxf(maxR, modelH * 0.16f);

  const float az = (float(view) / float(impViews)) * kTwoPi;
  const float dx = sinf(az), dz = cosf(az);       /* viewer direction       */
  const float rx = cosf(az), rz = -sinf(az);      /* screen right           */

  /* One uniform scale, chosen so both the height and the widest view fit. */
  const float scale = minf(float(IMP_SH - 4) / modelH, float(IMP_SW - 4) / (2.0f * modelR));
  const float cx = (float(IMP_SW) * 0.5f);
  const float baseY = minY;

  rasterSurface(pos, nrm, col, fe_flora_geom::idx(), nv, ni, scale, cx, baseY, rx, rz, dx, dz, seed);
  rasterSurface(cpos, cnrm, ccol, fe_flora_geom::card_idx(), cv, ci, scale, cx, baseY, rx, rz, dx, dz, seed + 977u);

  /* Downsample to the atlas tile. Colour is weighted by coverage, so the edge
   * texels do not darken toward black and the cutout stays clean at distance. */
  uint8_t* dst = impPixels + view * IMP_W * IMP_H * 4;
  for (int32_t y = 0; y < IMP_H; y++) {
    for (int32_t x = 0; x < IMP_W; x++) {
      float r = 0.0f, g = 0.0f, b = 0.0f, cov = 0.0f;
      for (int32_t sy = 0; sy < IMP_SS; sy++) {
        for (int32_t sx = 0; sx < IMP_SS; sx++) {
          const int32_t at = (y * IMP_SS + sy) * IMP_SW + (x * IMP_SS + sx);
          if (impColor[at * 4 + 3] <= 0.0f) continue;
          r += impColor[at * 4 + 0];
          g += impColor[at * 4 + 1];
          b += impColor[at * 4 + 2];
          cov += 1.0f;
        }
      }
      const int32_t o = (y * IMP_W + x) * 4;
      const float k = cov > 0.0f ? 1.0f / cov : 0.0f;
      /* Store display-referred colour: the studio composites in sRGB, so the
         atlas is encoded with the same transfer function and the billboard
         needs no decode on either WebGL1 or WebGL2. */
      const float enc = 1.0f / 2.2f;
      const float rr = clampf(r * k, 0.0f, 4.0f);
      const float gg = clampf(g * k, 0.0f, 4.0f);
      const float bb = clampf(b * k, 0.0f, 4.0f);
      dst[o + 0] = uint8_t(clampf(powf(rr, enc), 0.0f, 1.0f) * 255.0f + 0.5f);
      dst[o + 1] = uint8_t(clampf(powf(gg, enc), 0.0f, 1.0f) * 255.0f + 0.5f);
      dst[o + 2] = uint8_t(clampf(powf(bb, enc), 0.0f, 1.0f) * 255.0f + 0.5f);
      dst[o + 3] = uint8_t(clampf(cov / float(IMP_SS * IMP_SS), 0.0f, 1.0f) * 255.0f + 0.5f);
    }
  }

  /* Remember the texels-per-metre this tile was rendered at; the atlas bounds
   * below are measured in texels, so they need it. */
  impScale = scale;
}

}  // namespace

extern "C" {

/* Bake one species into the atlas. Returns the view count, or 0 on failure.
 * The atlas is reused, so a caller must upload it before baking another kind. */
FE_EXPORT int32_t fe_impostor_build(int32_t kind, uint32_t seed, int32_t detail, int32_t views) {
  if (views < 1 || views > IMP_MAX_VIEWS) return 0;
  if (fe_flora_tree(kind, seed ? seed : 1u, detail) < 1) return 0;
  impViews = views;
  for (int32_t v = 0; v < views; v++) rasterise(v, seed + uint32_t(v) * 7919u);
  /* How much of the atlas is opaque — the studio uses it to reject an atlas that
   * came out empty, and a test asserts it is neither blank nor solid. */
  int32_t covered = 0;
  for (int32_t v = 0; v < views; v++) {
    const uint8_t* px = impPixels + v * IMP_W * IMP_H * 4;
    for (int32_t i = 0; i < IMP_W * IMP_H; i++) {
      if (px[i * 4 + 3] > 96) ++covered;
    }
  }
  impBounds[2] = float(covered) / float(views * IMP_W * IMP_H);

  /* The quad the studio draws is the union box of the pixels that actually got
   * painted, measured rather than predicted: a plant's leaf cards reach higher
   * than its wood, and a wide canopy never fills a 1:2 tile. Sizing the quad
   * from the model bounds instead would draw the plant at the wrong height. */
  int32_t minX = IMP_W, maxX = -1, maxY = -1;
  for (int32_t v = 0; v < views; v++) {
    const uint8_t* px = impPixels + v * IMP_W * IMP_H * 4;
    for (int32_t y = 0; y < IMP_H; y++) {
      for (int32_t x = 0; x < IMP_W; x++) {
        if (px[(y * IMP_W + x) * 4 + 3] < 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return 0;          /* nothing was painted */
  const int32_t x0 = maxX > minX ? (minX > 0 ? minX - 1 : 0) : 0;
  const int32_t x1 = maxX < IMP_W - 1 ? maxX + 1 : IMP_W - 1;
  const int32_t y1 = maxY < IMP_H - 1 ? maxY + 1 : IMP_H - 1;
  const float mScale = impScale > 0.0f ? impScale : 1.0f;
  impBounds[0] = float(x1 - x0 + 1) / mScale;    /* quad width, metres  */
  impBounds[1] = float(y1 + 1) / mScale;         /* quad height, metres */
  impBounds[3] = 0.0f;                           /* base at the origin  */
  impBounds[4] = float(x1 - x0 + 1) / float(IMP_W);
  impBounds[5] = float(y1 + 1) / float(IMP_H);
  impBounds[6] = float(x0) / float(IMP_W);
  /* Horizontally the box should straddle the tile centre, because the union of
   * all azimuths spans the same radius either side. Nudge it if it does not, so
   * the plant does not drift off its own trunk. */
  const float centre = (float(x0) + float(x1 + 1)) * 0.5f;
  impBounds[6] = clampf(impBounds[6] - (centre - float(IMP_W) * 0.5f) / float(IMP_W), 0.0f, 1.0f - impBounds[4]);
  impBounds[7] = 0.0f;
  return views;
}

FE_EXPORT int32_t fe_impostor_width(void) { return IMP_W; }
FE_EXPORT int32_t fe_impostor_height(void) { return IMP_H; }
FE_EXPORT int32_t fe_impostor_view_count(void) { return impViews; }
FE_EXPORT int32_t fe_impostor_max_views(void) { return IMP_MAX_VIEWS; }
FE_EXPORT uint8_t* fe_impostor_pixels_ptr(void) { return impPixels; }
/* [quad width m, quad height m, coverage 0..1, base offset m] */
FE_EXPORT float* fe_impostor_bounds_ptr(void) { return impBounds; }

/* Which atlas column a camera sees a plant from. Kept in the kernel so the
 * shader and the tests agree on the convention: column 0 is the view from +Z,
 * and the columns run counter-clockwise looking down. */
FE_EXPORT int32_t fe_impostor_column(float cam_dx, float cam_dz) {
  if (impViews < 1) return 0;
  float a = atan2f(cam_dx, cam_dz);
  if (a < 0.0f) a += kTwoPi;
  const float turn = kTwoPi / float(impViews);
  int32_t col = int32_t(a / turn + 0.5f);
  if (col >= impViews) col -= impViews;
  return col;
}

}  // extern "C"
