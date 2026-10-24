import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/* The surface detail map is the micro-structure the landscaping studio paints
 * into turf, rock, snow and bark: a tileable height field turned into a
 * tangent-space normal plus a roughness channel.
 *
 * It used to evaluate the octave stack five times per texel — centre, left,
 * right, down, up — which cost 76 ms at 256x256 and 303 ms at 512x512 on a
 * desktop, on the main thread, during load. The field is a pure function of
 * (kind, u, v, salt) and the gradient only reads four neighbours, so it is
 * evaluated once per texel into a scratch row-major buffer and the Sobel becomes
 * four lookups.
 *
 * These are the invariants that change would have broken if it were wrong:
 * tileability, normalisation, the roughness range, and determinism. */

const WASM = 'wasm/fe_core_engine.wasm';

async function boot() {
  const { readFileSync: read } = await import('node:fs');
  const mod = await WebAssembly.compile(read(WASM));
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports;
}

function detail(exp, kind, width, height, seed, strength) {
  assert.equal(exp.fe_surface_detail(kind, width, height, seed, strength), 1);
  const count = exp.fe_surface_detail_size();
  assert.equal(count, width * height);
  return new Float32Array(exp.memory.buffer, exp.fe_surface_detail_ptr(), count * 4).slice();
}

test('the same request produces the same texels', async () => {
  const exp = await boot();
  const a = detail(exp, 0, 64, 64, 31, 1.1);
  const b = detail(exp, 0, 64, 64, 31, 1.1);
  assert.deepEqual(Array.from(a), Array.from(b), 'the generator must be deterministic');

  const c = detail(exp, 0, 64, 64, 32, 1.1);
  assert.notDeepEqual(Array.from(a.subarray(0, 64)), Array.from(c.subarray(0, 64)), 'a new seed must be a new map');
});

test('every texel is a unit normal with a positive Z and a roughness in range', async () => {
  const exp = await boot();
  const data = detail(exp, 2, 96, 96, 7, 1.4);
  for (let i = 0; i < data.length; i += 4) {
    const [x, y, z, rough] = [data[i] * 2 - 1, data[i + 1] * 2 - 1, data[i + 2] * 2 - 1, data[i + 3]];
    const length = Math.hypot(x, y, z);
    assert.ok(Math.abs(length - 1) < 0.02, `texel ${i / 4} normal length ${length}`);
    assert.ok(z > 0, `texel ${i / 4} points away from the surface: ${z}`);
    assert.ok(rough >= 0 && rough <= 1, `texel ${i / 4} roughness ${rough}`);
  }
});

test('the map is tileable: the wrap seam is no rougher than the interior', async () => {
  const exp = await boot();
  const size = 64;
  const data = detail(exp, 0, size, size, 5, 1);
  const slope = (ax, ay, bx, by) => {
    const a = (ay * size + ax) * 4, b = (by * size + bx) * 4;
    return Math.hypot(data[a] - data[b], data[a + 1] - data[b + 1]);
  };
  let seam = 0, interior = 0;
  for (let j = 0; j < size; j++) {
    seam += slope(size - 1, j, 0, j);                 /* left edge to right edge */
    interior += slope((size >> 1) - 1, j, size >> 1, j);
  }
  assert.ok(
    seam < interior * 1.6,
    `the wrap column is a visible crease: seam ${seam.toFixed(2)} vs interior ${interior.toFixed(2)}`
  );
});

test('generating a 256x256 map stays inside a load-sized budget', async () => {
  const exp = await boot();
  detail(exp, 0, 256, 256, 3, 1);          /* warm: first call allocates the block */
  const start = process.hrtime.bigint();
  detail(exp, 0, 256, 256, 4, 1);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  /* 13 ms on the machine this was written on; the five-sample version took 76.
     The ceiling is loose enough for a slow CI box and tight enough that putting
     the per-neighbour evaluation back would fail it. */
  assert.ok(ms < 60, `256x256 detail map took ${ms.toFixed(1)} ms`);
});

test('the noise stack is evaluated once per texel, not per neighbour', () => {
  const source = readFileSync('cpp/src/fe_surface.cpp', 'utf8');
  const start = source.indexOf('FE_EXPORT int32_t fe_surface_detail');
  const end = source.indexOf('FE_EXPORT uint32_t fe_surface_detail_ptr');
  const body = source.slice(start, end);
  const calls = body.match(/detailHeight\(k,/g) || [];
  assert.equal(calls.length, 1, `fe_surface_detail calls the octave stack ${calls.length} times per texel; it should call it once`);
  assert.match(body, /gDetailHeight/, 'the height field must be cached before the gradient pass');
});
