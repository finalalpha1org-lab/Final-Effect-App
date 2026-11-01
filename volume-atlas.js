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

  /* The packing loop lives in cpp/src/fe_volatlas.cpp now: a 40^3 lattice is
     64 000 cells of divide-clamp-round, every frame, in the tab that is also
     raymarching it. This file keeps the JavaScript loop as `packSoftware` -
     the fallback when the engine artifact is missing and the oracle the parity
     suite compares the kernel against. */
  function engine() {
    const eng = root.FECppEngine;
    if (!eng || !eng.ready || !eng.exports || !eng.memory) return null;
    if (typeof eng.exports.fe_volatlas_pack !== 'function' || typeof eng.scratch !== 'function') return null;
    return eng;
  }

  /* Upload a float grid: a view over engine memory needs no copy at all, since
     the smoke solver already keeps density and temperature here. */
  function upload(eng, name, values, cells) {
    const bytes = values.byteOffset;
    if (values.buffer === eng.memory.buffer) return { ptr: bytes, owned: false };
    const slot = eng.scratch(name, cells * 4);
    new Float32Array(eng.memory.buffer, slot.ptr, cells).set(values.subarray(0, cells));
    return { ptr: slot.ptr, owned: true };
  }

  function packThroughEngine(eng, density, temperature, grid, densityScale, temperatureScale, out) {
    const ex = eng.exports;
    const cells = grid * grid * grid;
    const layoutSlot = eng.scratch('volatlas-layout', 16);
    if (ex.fe_volatlas_layout(grid, layoutSlot.ptr) !== 0) return null;
    const dims = Array.from(new Uint32Array(eng.memory.buffer, layoutSlot.ptr, 4));
    const need = dims[2] * dims[3] * 4;
    if (out && out.length < need) return null;
    const target = out || new Uint8Array(need);

    const d = upload(eng, 'volatlas-density', density, cells);
    const t = upload(eng, 'volatlas-temperature', temperature, cells);
    const image = eng.scratch('volatlas-image', need);
    const rc = ex.fe_volatlas_pack(d.ptr, t.ptr, grid, densityScale, temperatureScale, image.ptr);
    if (rc !== 0) return null;
    target.set(new Uint8Array(eng.memory.buffer, image.ptr, need), 0);
    return {
      data: target,
      grid,
      tilesX: dims[0],
      tilesY: dims[1],
      width: dims[2],
      height: dims[3],
      densityScale,
      temperatureScale,
      written: cells
    };
  }

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

    const eng = engine();
    if (eng) {
      const packed = packThroughEngine(eng, density, temperature, grid, densityScale, temperatureScale, out);
      if (packed) return packed;
    }
    return packSoftware(density, temperature, grid, densityScale, temperatureScale, out, info);
  }

  function packSoftware(density, temperature, grid, densityScale, temperatureScale, out, info) {
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

  root.FEVolumeAtlas = { layout: layout, pack: pack, packSoftware: packSoftware };
})(typeof window !== 'undefined' ? window : globalThis);
