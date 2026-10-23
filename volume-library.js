/* FEVolumeLibrary - reader for the baked "cinema" volume set.

   The binary is produced offline by scripts/bake-volume-library.mjs from the
   same freestanding C++ solver that runs live. Each variant is a short loop of
   den/tem frames at a fixed grid; the runtime only blends two neighbouring
   frames, so a phone never pays for a full simulation.

   Layout (little endian):
     'FELIB1\0' u8?  -> magic bytes 0..5, byte 6 zero, byte 7 zero, byte 8 count
     per variant: u8 nameLen, name, u16 grid, u16 frames, u8 fps, u8 reserved,
                  frames * grid^3 * 2 bytes (density, temperature)
*/
(function (global) {
  'use strict';
  const MAGIC = 'FELIB1';

  function parse(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('volume-library: bad magic');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes[8];
    let offset = 9;
    const variants = [];
    for (let v = 0; v < count; v++) {
      const nameLen = bytes[offset++];
      let name = '';
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(bytes[offset + i]);
      offset += nameLen;
      const grid = view.getUint16(offset, true); offset += 2;
      const frames = view.getUint16(offset, true); offset += 2;
      const fps = bytes[offset++];
      offset++; /* reserved */
      const cells = grid * grid * grid;
      const byteLength = cells * 2 * frames;
      if (offset + byteLength > bytes.length) throw new Error(`volume-library: truncated ${name}`);
      variants.push({ name, grid, frames, fps, data: bytes.subarray(offset, offset + byteLength) });
      offset += byteLength;
    }
    return { variants };
  }

  function find(library, name) {
    if (!library || !Array.isArray(library.variants)) return null;
    return library.variants.find(v => v.name === name) || null;
  }

  /* Continuous, ping-pong playback index: forward then backward, so the short
     loop never snaps from the last frame back to the first. */
  function frameAt(variant, seconds, motion) {
    if (!variant || !variant.frames) return { a: 0, b: 0, blend: 0 };
    const speed = Math.max(0, motion == null ? 1 : motion);
    const span = Math.max(1, variant.frames - 1);
    const phase = (seconds * (variant.fps || 24) * speed) / span;
    const wave = Math.abs((phase % 2) - 1); /* 1 -> 0 -> 1 */
    const pos = (1 - wave) * span;
    const a = Math.floor(pos);
    const b = Math.min(span, a + 1);
    return { a, b, blend: pos - a };
  }

  /* Every frame x slice becomes one tile, exactly like the live volume atlas:
     tile index = frame * grid + z, so the shader can address a 3D sample with
     two frame offsets. R = density, G = temperature. */
  function packAtlas(variant) {
    const grid = variant.grid, frames = variant.frames;
    const tiles = frames * grid;
    const cols = Math.ceil(Math.sqrt(tiles));
    const rows = Math.ceil(tiles / cols);
    const width = cols * grid, height = rows * grid;
    const data = new Uint8Array(width * height * 4);
    const cells = grid * grid * grid;
    for (let f = 0; f < frames; f++) {
      const frame = variant.data.subarray(f * cells * 2, (f + 1) * cells * 2);
      for (let z = 0; z < grid; z++) {
        const tile = f * grid + z;
        const ox = (tile % cols) * grid, oy = Math.floor(tile / cols) * grid;
        for (let y = 0; y < grid; y++) {
          const row = ((oy + y) * width + ox) * 4;
          for (let x = 0; x < grid; x++) {
            const s = ((z * grid + y) * grid + x) * 2;
            const o = row + x * 4;
            data[o] = frame[s];
            data[o + 1] = frame[s + 1];
            data[o + 3] = 255;
          }
        }
      }
    }
    return { data, width, height, tilesX: cols, tilesY: rows, grid, frames };
  }

  /* Trilinear read of one frame, in normalised domain space. Used by the tests
     and by any CPU-side preview; the shader has its own sampler. */
  function sample(variant, frame, u, v, w, out) {
    const grid = variant.grid, cells = grid * grid * grid;
    const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;
    const fx = clamp01(u) * (grid - 1), fy = clamp01(v) * (grid - 1), fz = clamp01(w) * (grid - 1);
    const ix = Math.min(grid - 2, Math.floor(fx)) || 0, iy = Math.min(grid - 2, Math.floor(fy)) || 0, iz = Math.min(grid - 2, Math.floor(fz)) || 0;
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const base = frame * cells * 2;
    const read = (x, y, z, channel) => variant.data[base + ((z * grid + y) * grid + x) * 2 + channel] / 255;
    const lerp = (a, b, t) => a + (b - a) * t;
    const result = out || [0, 0];
    for (let c = 0; c < 2; c++) {
      const c000 = read(ix, iy, iz, c), c100 = read(ix + 1, iy, iz, c);
      const c010 = read(ix, iy + 1, iz, c), c110 = read(ix + 1, iy + 1, iz, c);
      const c001 = read(ix, iy, iz + 1, c), c101 = read(ix + 1, iy, iz + 1, c);
      const c011 = read(ix, iy + 1, iz + 1, c), c111 = read(ix + 1, iy + 1, iz + 1, c);
      const z0 = lerp(lerp(c000, c100, tx), lerp(c010, c110, tx), ty);
      const z1 = lerp(lerp(c001, c101, tx), lerp(c011, c111, tx), ty);
      result[c] = lerp(z0, z1, tz);
    }
    return result;
  }

  global.FEVolumeLibrary = { parse, find, frameAt, packAtlas, sample };
})(typeof window !== 'undefined' ? window : globalThis);
