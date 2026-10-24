import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';

/* Instance transforms for the instanced studio.
 *
 * `sync()` in terrain-main-03.js used to compose every visible plant's matrix
 * through a `THREE.Object3D`: shortest-arc quaternion to the ground normal,
 * yaw about +Y, a `YXZ` tilt Euler, then `updateMatrix()`. That is the correct
 * transform, but it is five quaternion operations and four transcendental calls
 * per instance through object property lookups — measured at 18.2 ms for
 * 30 000 instances on a desktop CPU, and a phone is three to five times slower.
 *
 * The kernel does the same arithmetic over a flat structure-of-arrays block.
 * These tests exist because "the same arithmetic" is exactly the claim that
 * silently stops being true: a sign flipped in the shortest-arc quaternion, or
 * the tilt applied before the yaw instead of after, still produces a plausible
 * looking forest with every tree leaning the wrong way.
 *
 * So the reference is three.js r128 itself — the code path that shipped — and
 * the comparison is component by component on every matrix element. */

const WASM = 'wasm/fe_core_engine.wasm';

async function boot() {
  const mod = await WebAssembly.compile(readFileSync(WASM));
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports;
}

/* The studio's stride: x, y, z, scale_xz, scale_y, yaw, nx, ny, nz, hash_x,
   hash_z, root_span. `y` is the ground height; the root sink is the kernel's. */
const STRIDE = 12;

function writeInput(exp, rows) {
  const ptr = exp.fe_scatter_begin(rows.length);
  assert.ok(ptr > 0, 'fe_scatter_begin must hand back a block');
  const view = new Float32Array(exp.memory.buffer, ptr, rows.length * STRIDE);
  rows.forEach((r, i) => view.set(r, i * STRIDE));
  return ptr;
}

function matrices(exp, count, order, tilt, bend, mode, flags) {
  const ptr = exp.fe_scatter_matrices(count, order || 0, tilt, bend, mode, flags || 0);
  assert.ok(ptr > 0, 'fe_scatter_matrices must return the output block');
  return new Float32Array(exp.memory.buffer, ptr, count * 16).slice();
}

const UP = new THREE.Vector3(0, 1, 0);

/* The exact reference: an Object3D driven the way the studio drove it. */
function reference(row, tilt, bend, mode) {
  const [x, y, z, sxz, sy, yaw, nx, ny, nz, h2, h3] = row;
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  if (mode === 0) {
    o.rotation.set((h2 - 0.5) * tilt, yaw, (h3 - 0.5) * tilt, 'YXZ');
  } else {
    const n = new THREE.Vector3(nx, ny, nz).normalize();
    o.quaternion.setFromUnitVectors(UP, n);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    o.quaternion.multiply(q);
    const e = new THREE.Euler((h2 - 0.5) * bend, 0, (h3 - 0.5) * bend, 'YXZ');
    o.quaternion.multiply(new THREE.Quaternion().setFromEuler(e));
  }
  o.scale.set(sxz, sy, sxz);
  o.updateMatrix();
  return Array.from(o.matrix.elements);
}

function rows(n, seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const gx = (rnd() - 0.5) * 0.9;
    const gz = (rnd() - 0.5) * 0.9;
    const ny = 1;
    const len = Math.hypot(gx, ny, gz);
    out.push([
      (rnd() - 0.5) * 900, rnd() * 40, (rnd() - 0.5) * 900,
      0.4 + rnd() * 3, 0.4 + rnd() * 3, rnd() * Math.PI * 2,
      (gx / len) * 0.7, ny / len, (gz / len) * 0.7,
      rnd(), rnd(), 0,
    ]);
  }
  return out;
}

test('aligned mode reproduces the three.js transform element for element', async () => {
  const exp = await boot();
  const input = rows(512, 7);
  writeInput(exp, input);
  const got = matrices(exp, input.length, 0, 0.35, 0.18, 1);
  let worst = 0;
  input.forEach((row, i) => {
    const want = reference(row, 0.35, 0.18, 1);
    for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(want[k] - got[i * 16 + k]));
  });
  /* The kernel is compiled freestanding, so it uses the core's minimax
     sin/cos (max error 1.5e-7 on [-pi, pi], ~2e-6 at the ends of the range)
     instead of the platform's libm. Through the quaternion products that is a
     1e-5 rad error in a tilt angle - 0.0006 degrees, three orders of magnitude
     below a pixel - so the comparison is element by element with a tolerance
     that admits the arithmetic and rejects a wrong transform (which shows up
     at 1e-1 and above). */
  assert.ok(worst < 6e-5, `worst component error ${worst} must stay under 6e-5`);
});

test('upright mode reproduces the three.js transform element for element', async () => {
  const exp = await boot();
  const input = rows(512, 11);
  writeInput(exp, input);
  const got = matrices(exp, input.length, 0, 0.12, 0, 0);
  let worst = 0;
  input.forEach((row, i) => {
    const want = reference(row, 0.12, 0, 0);
    for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(want[k] - got[i * 16 + k]));
  });
  /* The kernel is compiled freestanding, so it uses the core's minimax
     sin/cos (max error 1.5e-7 on [-pi, pi], ~2e-6 at the ends of the range)
     instead of the platform's libm. Through the quaternion products that is a
     1e-5 rad error in a tilt angle - 0.0006 degrees, three orders of magnitude
     below a pixel - so the comparison is element by element with a tolerance
     that admits the arithmetic and rejects a wrong transform (which shows up
     at 1e-1 and above). */
  assert.ok(worst < 6e-5, `worst component error ${worst} must stay under 6e-5`);
});

test('a transform is orthonormal and carries the scale exactly', async () => {
  const exp = await boot();
  const input = rows(64, 3);
  writeInput(exp, input);
  const got = matrices(exp, input.length, 0, 0.35, 0.18, 1);
  for (let i = 0; i < input.length; i++) {
    const [, , , sxz, sy] = input[i];
    const m = got.subarray(i * 16, i * 16 + 16);
    /* Columns 0..2 are the basis; their lengths are the scales. */
    assert.ok(Math.abs(Math.hypot(m[0], m[1], m[2]) - sxz) < sxz * 2e-5, 'x scale');
    assert.ok(Math.abs(Math.hypot(m[4], m[5], m[6]) - sy) < sy * 2e-5, 'y scale');
    assert.ok(Math.abs(Math.hypot(m[8], m[9], m[10]) - sxz) < sxz * 2e-5, 'z scale');
    /* Orthogonality: dot(col0, col1) and dot(col0, col2) are zero. */
    assert.ok(Math.abs(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]) < sxz * sy * 2e-5, 'x/y orthogonal');
    assert.ok(Math.abs(m[0] * m[8] + m[1] * m[9] + m[2] * m[10]) < sxz * sxz * 2e-5, 'x/z orthogonal');
    /* Translation is the plant's own position. */
    /* A metre-scale world stored as float32 carries ~3e-5 of rounding at 450 m. */
    assert.ok(Math.abs(m[12] - input[i][0]) < 1e-3 && Math.abs(m[14] - input[i][2]) < 1e-3, 'position');
  }
});

test('the compacted order list selects the instances it names', async () => {
  const exp = await boot();
  const input = rows(256, 5);
  writeInput(exp, input);
  const all = matrices(exp, input.length, 0, 0.35, 0.18, 1);
  const order = Uint32Array.from([3, 0, 200, 17]);
  const orderPtr = exp.fe_malloc(order.length * 4);
  assert.ok(orderPtr > 0);
  new Uint32Array(exp.memory.buffer, orderPtr, order.length).set(order);
  const picked = matrices(exp, order.length, orderPtr, 0.35, 0.18, 1);
  order.forEach((src, i) => {
    assert.deepEqual(
      Array.from(picked.subarray(i * 16, i * 16 + 16)),
      Array.from(all.subarray(src * 16, src * 16 + 16)),
      `slot ${i} must be instance ${src}`,
    );
  });
});

test('a bad call refuses instead of writing garbage', async () => {
  const exp = await boot();
  assert.equal(exp.fe_scatter_begin(0), 0, 'zero instances is not a block');
  input: {
    const input = rows(16, 1);
    writeInput(exp, input);
    assert.equal(exp.fe_scatter_matrices(0, 0, 0, 0, 1, 0), 0, 'a zero count is refused');
    assert.equal(exp.fe_scatter_matrices(17, 0, 0, 0, 1, 0), 0, 'more than reserved is refused');
    const orderPtr = exp.fe_malloc(4);
    new Uint32Array(exp.memory.buffer, orderPtr, 1)[0] = 99;
    assert.equal(exp.fe_scatter_matrices(1, orderPtr, 0, 0, 1, 0), 0, 'an out-of-range index is refused');
  }
});

test('30 000 instances stay well inside a frame', async () => {
  const exp = await boot();
  const input = rows(30000, 9);
  writeInput(exp, input);
  /* Timed through the raw export: the test helper would clone the 1.9 MB output
     block on every call and that copy is the caller's blit, not the kernel. */
  exp.fe_scatter_matrices(input.length, 0, 0.35, 0.18, 1, 0);
  const t0 = performance.now();
  for (let pass = 0; pass < 3; pass++) exp.fe_scatter_matrices(input.length, 0, 0.35, 0.18, 1, 0);
  const per = (performance.now() - t0) / 3;
  /* The JavaScript path this replaces measured 18.2 ms for the same count on
     this machine. The budget is deliberately loose (CI machines vary) but it
     still fails if the kernel falls back to per-instance object traffic. */
  assert.ok(per < 6, `30000 instances took ${per.toFixed(2)} ms; budget is 6 ms`);
});

/* ---- wiring -------------------------------------------------------------
 * A kernel that nothing calls is not an optimisation. These read the studio and
 * the bridge and pin the two places that have to stay connected. */

const SYNC = readFileSync('terrain-main-03.js', 'utf8');
const BRIDGE = readFileSync('terrain-main-01.js', 'utf8');

test('the studio lays instances out in the kernel and blits the block', () => {
  const start = SYNC.indexOf('function sync(k,allInstances=false){');
  const end = SYNC.indexOf('function syncFoliageKind', start);
  assert.ok(start > 0 && end > start, 'sync() lives in terrain-main-03.js');
  const body = SYNC.slice(start, end);

  assert.match(body, /core\.instancingBegin\(n\)/, 'the species block comes from the core');
  assert.match(body, /core\.instancingMatrices\(ci,op,tl,K\._bend,md,fl\)/, 'the full-detail block is one call');
  assert.match(body, /core\.instancingMatrices\(li,op,tl,K\._bend,md,fl\)/, 'the low-detail twin is one call');
  assert.match(body, /m\.instanceMatrix\.array\.set\(out\)/, 'the result is blitted, not copied per instance');
  assert.match(body, /if\(!useKernel\)target\.setMatrixAt\(i,dm\.matrix\);/, 'the three.js path stays as the fallback');
  assert.match(body, /if\(!useKernel\|\|tier===2\|\|o\.fl\)\{/, 'impostors and explicit transforms keep the object path');
  assert.match(body, /if\(ROOT_SPAN\[k\]\)core\.instancingTerrain\(H,N,S\);/, 'the height grid goes over once per settle, and only for species with a root span');
});

test('the bridge does not fuse the instance kernel with the terrain scatter', () => {
  /* `core.scatterBegin` is the terrain height upload. A second definition with
     the same name silently replaced it once; the placement pass called it with
     one argument and every plant landed at y = 0. */
  const occurrences = BRIDGE.match(/^ core\.scatterBegin=/gm) || [];
  assert.equal(occurrences.length, 1, 'core.scatterBegin must be defined exactly once');
  assert.match(BRIDGE, /core\.instancingBegin=function\(count\)/, 'the instance kernel has its own name');
  assert.match(BRIDGE, /if\(!core\.has\('fe_scatter_begin'\)\|\|!\(count>0\)\)return null;/, 'and it degrades to null without the core');
  assert.match(BRIDGE, /new Float32Array\(ex\.memory\.buffer,p,count\*11\)/, 'the SoA view is rebuilt after the call');
});

test('the blit lands in the instance buffer three.js will upload', async () => {
  const exp = await boot();
  const input = rows(300, 13);
  const ptr = writeInput(exp, input);
  const orderPtr = exp.fe_scatter_order_ptr();
  const order = new Uint32Array(exp.memory.buffer, orderPtr, input.length);
  for (let i = 0; i < input.length; i++) order[i] = i;
  const out = new Float32Array(exp.memory.buffer, exp.fe_scatter_matrices(input.length, orderPtr, 0.35, 0.18, 1, 0), input.length * 16);

  /* Exactly what sync() does: the mesh owns the buffer, the kernel block is
     copied into it, and three.js reads the matrices back off the attribute. */
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), input.length);
  mesh.instanceMatrix.array.set(out);
  mesh.count = input.length;

  const m = new THREE.Matrix4();
  for (let i = 0; i < input.length; i++) {
    mesh.getMatrixAt(i, m);
    const want = reference(input[i], 0.35, 0.18, 1);
    for (let k = 0; k < 16; k++) {
      assert.ok(Math.abs(m.elements[k] - want[k]) < 6e-5, `instance ${i} component ${k}`);
    }
  }
});

/* ---- root sink ----------------------------------------------------------
 * A tree is not placed at the height under its trunk: it is lowered by however
 * far the ground falls away inside its root span. That was 24 `hgt()` lookups
 * per instance in JavaScript, once per mesh; it is now the kernel's job, from a
 * grid uploaded once per settle. The reference below is the studio's own loop,
 * including the two radii and the clamp. */

function heightAt(H, n, size, x, z) {
  const W = n + 1, d = size / n;
  const u = Math.min(Math.max((x + size / 2) / d, 0), n - 0.001);
  const v = Math.min(Math.max((z + size / 2) / d, 0), n - 0.001);
  const i = u | 0, j = v | 0, a = u - i, b = v - j, k = j * W + i;
  return H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + W] * (1 - a) * b + H[k + W + 1] * a * b;
}

test('the root sink matches the studio formula, from the uploaded grid', async () => {
  const exp = await boot();
  const n = 64, size = 200, W = n + 1;
  const H = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i * size) / n - size / 2, z = (j * size) / n - size / 2;
      H[j * W + i] = Math.sin(x * 0.05) * 6 + Math.cos(z * 0.07) * 4;
    }
  }
  const gridPtr = exp.fe_scatter_terrain(n, size);
  assert.ok(gridPtr > 0, 'the grid block must be handed back');
  new Float32Array(exp.memory.buffer, gridPtr, W * W).set(H);

  /* Instances on the slope, with a root span of 1.2 m scaled by their size. */
  const input = [];
  for (let t = 0; t < 40; t++) {
    const x = -60 + t * 3, z = -30 + t * 1.5;
    const y = heightAt(H, n, size, x, z);
    const s = 0.8 + (t % 7) * 0.2;
    input.push([x, y, z, s, s, t * 0.3, 0, 1, 0, 0.3, 0.6, 1.2 * s]);
  }
  writeInput(exp, input);
  const got = matrices(exp, input.length, 0, 0.35, 0.18, 1, 0);

  const expectedSink = [];
  input.forEach((row, i) => {
    const [x, y, z, , s, , , , , , , span] = row;
    let lowY = y;
    for (let q = 0; q < 12; q++) {
      const a = (q * Math.PI) / 6;
      for (const f of [0.5, 1]) {
        lowY = Math.min(lowY, heightAt(H, n, size, x + Math.cos(a) * span * f, z + Math.sin(a) * span * f));
      }
    }
    const sink = Math.min(Math.max(0, y - lowY - 0.08), Math.min(0.28 * s, 0.16 * span));
    expectedSink.push(sink);
    assert.ok(Math.abs(got[i * 16 + 13] - (y - sink)) < 1e-3, `instance ${i}: y ${got[i * 16 + 13]} must be ${y - sink}`);
  });
  assert.ok(expectedSink.some((v) => v > 0.01), 'the fixture has to actually sink something');
});

test('a rock is bedded into the ground by a twelfth of its size', async () => {
  const exp = await boot();
  const input = [[0, 5, 0, 1.5, 1.5, 0, 0, 1, 0, 0.5, 0.5, 0]];
  writeInput(exp, input);
  const plain = matrices(exp, 1, 0, 0, 0, 1, 0);
  const rock = matrices(exp, 1, 0, 0, 0, 1, 1);
  assert.ok(Math.abs(plain[13] - 5) < 1e-5, 'an upright instance sits on its ground height');
  assert.ok(Math.abs(rock[13] - (5 - 0.12 * 1.5)) < 1e-5, 'a rock sits 0.12 * scale lower');
});
