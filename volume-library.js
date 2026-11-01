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

  /* The tiling, the trilinear read and the ping-pong playback arithmetic are in
     cpp/src/fe_volatlas.cpp. What stays here is the file format - the header,
     the names, the slicing into per-variant views - because those are objects
     the app holds, not numbers it computes. Each function keeps its JavaScript
     body (*Software) as the fallback and as the parity oracle. */
  function engine() {
    const eng = global.FECppEngine;
    if (!eng || !eng.ready || !eng.exports || !eng.memory) return null;
    if (typeof eng.exports.fe_volatlas_pack_library !== 'function' || typeof eng.scratch !== 'function') return null;
    return eng;
  }

  /* Upload one variant's packed frames; engine-owned views ride along for free. */
  function upload(eng, variant) {
    const data = variant.data;
    if (data.buffer === eng.memory.buffer) return data.byteOffset;
    const slot = eng.scratch('volatlas-library', data.length);
    new Uint8Array(eng.memory.buffer, slot.ptr, data.length).set(data);
    return slot.ptr;
  }

  /* The header walk is cpp/src/fe_volatlas.cpp (fe_volatlas_parse_library): it
     decides whether the file is valid and where each variant lives, this maps
     that table onto the objects the app holds. parseSoftware is the fallback. */
  function parse(buffer) {
    const eng = engine();
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (eng && typeof eng.exports.fe_volatlas_parse_library === 'function') {
      const parsed = parseThroughEngine(eng, bytes);
      if (parsed) return parsed;
    }
    return parseSoftware(bytes);
  }

  function parseThroughEngine(eng, bytes) {
    const ex = eng.exports;
    if (!bytes.length) return null;
    const upload = eng.scratch('volatlas-library-file', bytes.length);
    new Uint8Array(eng.memory.buffer, upload.ptr, bytes.length).set(bytes);
    /* At most 256 variants (the count is a single byte), seven words each. */
    const meta = eng.scratch('volatlas-library-meta', 256 * 7 * 4);
    const count = ex.fe_volatlas_parse_library(upload.ptr, bytes.length, meta.ptr, 256);
    if (count === -1) throw new Error('volume-library: bad magic');
    if (count < 0) return null;   /* let the JavaScript reader report the reason */
    const table = new Uint32Array(eng.memory.buffer, meta.ptr, count * 7);
    const variants = [];
    for (let v = 0; v < count; v++) {
      const base = v * 7;
      let name = '';
      for (let i = 0; i < table[base + 1]; i++) name += String.fromCharCode(bytes[table[base] + i]);
      const grid = table[base + 2], frames = table[base + 3], fps = table[base + 4];
      const offset = table[base + 5], byteLength = table[base + 6];
      variants.push({ name, grid, frames, fps, data: bytes.subarray(offset, offset + byteLength) });
    }
    return { variants };
  }

  function parseSoftware(bytes) {
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
    const eng = engine();
    if (eng && typeof eng.exports.fe_volatlas_frame_at === 'function') {
      const abSlot = eng.scratch('volatlas-frame-ab', 16);
      const blendSlot = eng.scratch('volatlas-frame-blend', 8);
      const speed = Math.max(0, motion == null ? 1 : motion);
      const fps = variant.fps || 24;
      if (eng.exports.fe_volatlas_frame_at(variant.frames, fps, seconds, speed, abSlot.ptr, blendSlot.ptr) === 0) {
        const ab = new Int32Array(eng.memory.buffer, abSlot.ptr, 2);
        const blend = new Float64Array(eng.memory.buffer, blendSlot.ptr, 1);
        return { a: ab[0], b: ab[1], blend: blend[0] };
      }
    }
    return frameAtSoftware(variant, seconds, motion);
  }

  function frameAtSoftware(variant, seconds, motion) {
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
    const eng = engine();
    if (eng) {
      const packed = packAtlasThroughEngine(eng, variant);
      if (packed) return packed;
    }
    return packAtlasSoftware(variant);
  }

  function packAtlasThroughEngine(eng, variant) {
    const ex = eng.exports;
    const grid = variant.grid, frames = variant.frames;
    if (!grid || !frames) return null;
    const cells = grid * grid * grid;
    if (variant.data.length < cells * 2 * frames) return null;
    /* tiles = frames x grid; the same ceil(sqrt()) tiling the kernel uses. */
    const tiles = frames * grid;
    const cols = Math.ceil(Math.sqrt(tiles));
    const rows = Math.ceil(tiles / cols);
    const width = cols * grid, height = rows * grid;

    const dimsSlot = eng.scratch('volatlas-library-dims', 16);
    const image = eng.scratch('volatlas-library-image', width * height * 4);
    const rc = ex.fe_volatlas_pack_library(upload(eng, variant), grid, frames, image.ptr, dimsSlot.ptr);
    if (rc !== 0) return null;
    const dims = Array.from(new Uint32Array(eng.memory.buffer, dimsSlot.ptr, 4));
    return {
      data: new Uint8Array(eng.memory.buffer, image.ptr, width * height * 4).slice(),
      width: dims[2],
      height: dims[3],
      tilesX: dims[0],
      tilesY: dims[1],
      grid,
      frames
    };
  }

  function packAtlasSoftware(variant) {
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
    const eng = engine();
    if (eng && variant && variant.grid >= 2 && variant.grid <= 512) {
      const result = out || [0, 0];
      const ex = eng.exports;
      const cells = variant.grid * variant.grid * variant.grid;
      if (variant.data.length >= cells * 2 * (frame + 1)) {
        const r = eng.scratch('volatlas-sample-out', 16);
        if (ex.fe_volatlas_sample(upload(eng, variant), variant.grid, frame, u, v, w, r.ptr) === 0) {
          const pair = new Float64Array(eng.memory.buffer, r.ptr, 2);
          result[0] = pair[0];
          result[1] = pair[1];
          return result;
        }
      }
    }
    return sampleSoftware(variant, frame, u, v, w, out);
  }

  function sampleSoftware(variant, frame, u, v, w, out) {
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

  global.FEVolumeLibrary = {
    parse, find, frameAt, packAtlas, sample,
    parseSoftware, frameAtSoftware, packAtlasSoftware, sampleSoftware
  };
})(typeof window !== 'undefined' ? window : globalThis);
