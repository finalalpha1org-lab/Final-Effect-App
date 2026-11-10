import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { laplacianSmoothGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Laplacian Smooth: MOD_laplaciansmooth.cc, ported as
 * fe_mod_laplacian_smooth() in cpp/src/fe_modifiers.cpp.
 *
 * Upstream builds a cotangent Laplacian and solves it as a least-squares
 * problem. The tests pin what that means: a flat sheet stays flat, a lumpy
 * one gets its lumps taken out, the axis switches work, and a lambda of zero
 * is the identity.
 * ========================================================================= */

const wasmBytes = readFileSync(appPath('fe_core_engine.wasm'));
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const exports = instance.exports;

function withCore(run) {
  const previous = globalThis.FECppEngine;
  globalThis.FECppEngine = { exports, memory: exports.memory, ready: true };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.FECppEngine;
    else globalThis.FECppEngine = previous;
  }
}

function grid(n = 5) {
  const P = [], I = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) P.push(x / (n - 1), y / (n - 1), 0);
  const id = (x, y) => y * n + x;
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    I.push(id(x, y), id(x + 1, y), id(x + 1, y + 1), id(x, y), id(x + 1, y + 1), id(x, y + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(P.filter((_, i) => i % 3 !== 2), 2));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

/* An indexed sphere with one vertex pulled out: the classic smoothing test.
   SphereGeometry shares its vertices, which is what makes the Laplacian mean
   anything - an unindexed mesh is all boundary and never moves. */
function lumpySphere(segments = 16) {
  const g = new THREE.SphereGeometry(1, segments, Math.max(8, segments / 2));
  const p = g.attributes.position;
  let top = 0;
  for (let i = 1; i < p.count; i++) if (p.getY(i) > p.getY(top)) top = i;
  p.setY(top, p.getY(top) * 1.8);
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

const positions = g => {
  const a = g.attributes.position;
  const out = [];
  for (let i = 0; i < a.count; i++) out.push([a.getX(i), a.getY(i), a.getZ(i)]);
  return out;
};

test('lambda zero is the identity', () => withCore(() => {
  const src = grid();
  const out = laplacianSmoothGeometry(src, { repeat: 3, lambda: 0, lambdaBorder: 0 });
  assert.deepEqual(positions(out), positions(src));
}));

test('a flat sheet stays flat and keeps its corners in the plane', () => withCore(() => {
  const src = grid(6);
  const out = laplacianSmoothGeometry(src, { repeat: 2, lambda: 0.3, lambdaBorder: 0.3 });
  for (const [x, y, z] of positions(out)) {
    assert.ok(Math.abs(z) < 1e-6, `z stays zero, got ${z}`);
    assert.ok(x >= -0.2 && x <= 1.2 && y >= -0.2 && y <= 1.2, 'the sheet does not fold over itself');
  }
  assert.equal(out.attributes.position.count, src.attributes.position.count, 'no vertex is added');
}));

test('a spike is pulled in and the radius spread narrows', () => withCore(() => {
  const src = lumpySphere(16);
  const radii = g => {
    const a = g.attributes.position;
    const r = [];
    for (let i = 0; i < a.count; i++) r.push(Math.hypot(a.getX(i), a.getY(i), a.getZ(i)));
    return r;
  };
  const before = radii(src);
  /* A modest lambda: upstream's operator overshoots well before 1.0, and a
     deeper repeat with a large weight is a sawtooth, not a smoother. */
  const out = laplacianSmoothGeometry(src, { repeat: 2, lambda: 0.1, lambdaBorder: 0.1 });
  const after = radii(out);
  const spread = r => Math.max(...r) - Math.min(...r);
  assert.ok(spread(after) < spread(before) * 0.9,
    `spread should fall: ${spread(before).toFixed(4)} -> ${spread(after).toFixed(4)}`);
  assert.ok(Math.max(...after) < Math.max(...before), 'the spike is shorter than it was');
}));

test('more repeats smooth more', () => withCore(() => {
  const src = lumpySphere(16);
  const one = laplacianSmoothGeometry(src, { repeat: 1, lambda: 0.1, lambdaBorder: 0.1 });
  const five = laplacianSmoothGeometry(src, { repeat: 2, lambda: 0.1, lambdaBorder: 0.1 });
  const peak = g => Math.max(...positions(g).map(([x, y, z]) => Math.hypot(x, y, z)));
  assert.ok(peak(five) < peak(one), `${peak(one).toFixed(4)} should beat ${peak(five).toFixed(4)}`);
}));

test('the axis switches are respected', () => withCore(() => {
  const src = lumpySphere(12);
  const before = positions(src);
  const xOnly = laplacianSmoothGeometry(src, {
    repeat: 2, lambda: 0.1, lambdaBorder: 0.1, axes: [true, false, false],
  });
  const after = positions(xOnly);
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(after[i][1] - before[i][1]) < 1e-6, `y is untouched at ${i}`);
    assert.ok(Math.abs(after[i][2] - before[i][2]) < 1e-6, `z is untouched at ${i}`);
  }
}));

test('preserve volume keeps the object about the same size', () => withCore(() => {
  const src = lumpySphere(16);
  const volume = g => {
    const p = g.attributes.position, idx = g.index.array;
    let vol = 0;
    for (let f = 0; f < idx.length; f += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, idx[f]);
      const b = new THREE.Vector3().fromBufferAttribute(p, idx[f + 1]);
      const c = new THREE.Vector3().fromBufferAttribute(p, idx[f + 2]);
      vol += a.dot(b.cross(c)) / 6;
    }
    return Math.abs(vol);
  };
  const free = laplacianSmoothGeometry(src, { repeat: 2, lambda: 0.1, lambdaBorder: 0.1 });
  const kept = laplacianSmoothGeometry(src, { repeat: 2, lambda: 0.1, lambdaBorder: 0.1, preserveVolume: true });
  const v0 = volume(src);
  assert.ok(volume(free) < v0, 'without the flag the mesh loses volume');
  assert.ok(Math.abs(volume(kept) - v0) / v0 < 0.02, 'with the flag it keeps it');
}));

test('UVs and topology survive', () => withCore(() => {
  const src = grid(4);
  const out = laplacianSmoothGeometry(src, { repeat: 1 });
  assert.deepEqual([...out.index.array], [...src.index.array]);
  assert.deepEqual([...out.attributes.uv.array], [...src.attributes.uv.array]);
}));

test('the kernel refuses a mesh too large for the arena', () => {
  const v = 40001, t = 2;
  assert.equal(exports.fe_mod_begin(v, t, 0), 0);
  assert.equal(exports.fe_mod_laplacian_smooth(1, 0.3, 0.3, 7, 0, 0), -3,
    'no geometry was uploaded, so there is nothing to smooth');
});
