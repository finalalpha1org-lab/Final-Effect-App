/* Bake the compact "cinema library" of canonical fire / smoke volumes.

   The same freestanding C++ solver that runs live is stepped offline for a
   fixed number of frames, then quantised to two bytes per cell (density,
   temperature). Running the real solver - not a noise shortcut - keeps the
   motion physically consistent with the live path, while the runtime only has
   to blend two frames.

   Output: volume-library.bin
     magic   'FELIB1\0'  (7 bytes)
     u8      variant count
     per variant:
       u8    name length, name bytes
       u16   grid (cubic)
       u16   frame count
       u8    fps
       u8    reserved
       frames * grid^3 * 2 bytes (density, temperature)
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wasm = readFileSync(path.join(root, 'wasm/fe_core_engine.wasm'));
const { instance: { exports: cpp } } = await WebAssembly.instantiate(wasm, {});

const GRID = 20;
const FRAMES = 12;
const FPS = 24;
const STEP = 1 / 30;

const VARIANTS = [
  {
    name: 'Fire',
    source: { x: 0.5, y: 0.08, z: 0.5, radius: 0.15, heat: 7, density: 0.5, lift: 0.6 },
    motion: { buoyancy: 1.4, vorticity: 2.4, dissipation: 0.45, cooling: 1.1, iterations: 20 }
  },
  {
    name: 'Smoke',
    source: { x: 0.5, y: 0.08, z: 0.5, radius: 0.18, heat: 1.2, density: 3.2, lift: 0.4 },
    motion: { buoyancy: 0.85, vorticity: 1.1, dissipation: 0.18, cooling: 0.22, iterations: 20 }
  },
  {
    name: 'Steam',
    source: { x: 0.5, y: 0.06, z: 0.5, radius: 0.12, heat: 2.2, density: 1.6, lift: 0.5 },
    motion: { buoyancy: 1.1, vorticity: 0.7, dissipation: 0.3, cooling: 0.5, iterations: 18 }
  }
];

function bake(variant) {
  if (cpp.fe_vol_init(GRID, GRID, GRID) !== 0) throw new Error('fe_vol_init failed');
  cpp.fe_vol_set_temporal(0);
  const cells = GRID * GRID * GRID;
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    cpp.fe_vol_source(variant.source.x, variant.source.y, variant.source.z, variant.source.radius,
      variant.source.heat, variant.source.density, variant.source.lift);
    const m = variant.motion;
    const rc = cpp.fe_vol_step(STEP, m.buoyancy, m.vorticity, m.dissipation, m.cooling, m.iterations);
    if (rc !== 0) throw new Error(`fe_vol_step failed at frame ${f}`);
    const den = new Float32Array(cpp.memory.buffer, cpp.fe_vol_density_ptr(), cells);
    const tem = new Float32Array(cpp.memory.buffer, cpp.fe_vol_temperature_ptr(), cells);
    const out = new Uint8Array(cells * 2);
    for (let i = 0; i < cells; i++) {
      out[i * 2] = Math.max(0, Math.min(255, Math.round(Math.min(1, den[i] / 0.8) * 255)));
      out[i * 2 + 1] = Math.max(0, Math.min(255, Math.round(Math.min(1, tem[i] / 2.2) * 255)));
    }
    frames.push(out);
  }
  return frames;
}

const variantsBaked = VARIANTS.map(v => ({ name: v.name, frames: bake(v) }));

const chunks = [];
const head = new Uint8Array(9);
head.set([0x46, 0x45, 0x4c, 0x49, 0x42, 0x31, 0x00, 0x00, 0x00], 0); /* 'FELIB1\0' + pad */
head[8] = variantsBaked.length;
chunks.push(head);
for (const { name, frames } of variantsBaked) {
  const nameBytes = new TextEncoder().encode(name);
  const meta = new Uint8Array(1 + nameBytes.length + 6);
  meta[0] = nameBytes.length;
  meta.set(nameBytes, 1);
  const view = new DataView(meta.buffer, meta.byteOffset);
  view.setUint16(1 + nameBytes.length, GRID, true);
  view.setUint16(3 + nameBytes.length, FRAMES, true);
  view.setUint8(5 + nameBytes.length, FPS);
  chunks.push(meta);
  for (const frame of frames) chunks.push(frame);
}

let length = 0;
for (const chunk of chunks) length += chunk.length;
const out = new Uint8Array(length);
let offset = 0;
for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
writeFileSync(path.join(root, 'volume-library.bin'), out);
console.log(`Baked ${variantsBaked.length} variants @ ${GRID}³ x ${FRAMES} frames -> volume-library.bin (${out.length} bytes)`);
