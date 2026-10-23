/* Volume atlas packing for the C++ smoke/fire solver.
 *
 * The solver keeps density and temperature in flat cell grids. WebGL1 has no
 * 3D textures, so this module tiles the z slices into one 2D RGBA atlas:
 *   R = density, G = temperature, B = 0, A = 255
 * The raymarch shader samples two neighbouring slices and blends them, which
 * makes the atlas work on WebGL1 and WebGL2 without sampler3D.
 *
 * Pure data in / pure data out: no THREE, no DOM, so the mapping is testable
 * outside a browser. The caller owns the texture object and marks it dirty.
 */
(function (root) {
  'use strict';

  function clamp01(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v >= 1 ? 1 : v;
  }

  /* One texture wide enough for every z slice, tiled as evenly as possible. */
  function layout(grid) {
    const g = Math.max(1, Math.round(Number(grid) || 1));
    const tilesX = Math.ceil(Math.sqrt(g));
    const tilesY = Math.ceil(g / tilesX);
    return { grid: g, tilesX, tilesY, width: g * tilesX, height: g * tilesY };
  }

  /* Pack `density` and `temperature` (flat, x fastest, then y, then z) into an
   * RGBA8 atlas. Values are normalised by the matching scale so a single byte
   * channel can carry them; the shader multiplies the scale back. */
  function pack(options) {
    const opts = options || {};
    const density = opts.density;
    const temperature = opts.temperature;
    const grid = Math.max(1, Math.round(Number(opts.grid) || 0));
    const cells = grid * grid * grid;
    if (!density || !temperature || density.length < cells || temperature.length < cells) {
      throw new Error('Volume atlas needs density and temperature arrays for the full grid');
    }
    const info = layout(grid);
    const out = opts.out || new Uint8Array(info.width * info.height * 4);
    if (out.length < info.width * info.height * 4) throw new Error('Volume atlas target is too small');
    const densityScale = Number(opts.densityScale) > 0 ? Number(opts.densityScale) : 1;
    const temperatureScale = Number(opts.temperatureScale) > 0 ? Number(opts.temperatureScale) : 1;
    const width = info.width;

    for (let z = 0; z < grid; z++) {
      const tileX = (z % info.tilesX) * grid;
      const tileY = Math.floor(z / info.tilesX) * grid;
      for (let y = 0; y < grid; y++) {
        const row = (tileY + y) * width + tileX;
        const slice = (z * grid + y) * grid;
        for (let x = 0; x < grid; x++) {
          const src = slice + x;
          const dst = (row + x) * 4;
          out[dst] = Math.round(clamp01(density[src] / densityScale) * 255);
          out[dst + 1] = Math.round(clamp01(temperature[src] / temperatureScale) * 255);
          out[dst + 2] = 0;
          out[dst + 3] = 255;
        }
      }
    }
    return {
      data: out,
      grid,
      tilesX: info.tilesX,
      tilesY: info.tilesY,
      width: info.width,
      height: info.height,
      densityScale,
      temperatureScale,
      written: grid * grid * grid
    };
  }

  root.FEVolumeAtlas = { layout: layout, pack: pack };
})(typeof window !== 'undefined' ? window : globalThis);
