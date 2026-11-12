import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { booleanGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Boolean: mesh_boolean.cc, ported as fe_mod_boolean() in
 * cpp/src/fe_modifiers.cpp.
 *
 * The one test that cannot be faked is volume: for two boxes whose overlap is
 * known in closed form, difference, union and intersection each have exactly
 * one right answer, and a boolean that keeps the wrong pieces is off by
 * whole pieces, not by rounding.
 * ========================================================================= */

const wasmBytes = readFileSync(appPath('fe_core_engine.wasm'));
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const exports = instance.exports;

function withCore(run) {
  const previous = globalThis.FECppEngine;
  globalThis.FECppEngine = { exports, memory: exports.memory, ready: true };
  try { return run(); } finally {
    if (previous === undefined) delete globalThis.FECppEngine;
    else globalThis.FECppEngine = previous;
  }
}

const box = (dx = 0, dy = 0, dz = 0, size = 2, spin = 0) => {
  const g = new THREE.BoxGeometry(size, size, size);
  if (spin) g.rotateY(spin);
  g.translate(dx, dy, dz);
  return g;
};

function volume(g) {
  const p = g.attributes.position, I = g.index.array;
  let v = 0;
  for (let f = 0; f < I.length / 3; f++) {
    const a = new THREE.Vector3().fromBufferAttribute(p, I[f * 3]);
    const b = new THREE.Vector3().fromBufferAttribute(p, I[f * 3 + 1]);
    const c = new THREE.Vector3().fromBufferAttribute(p, I[f * 3 + 2]);
    v += a.dot(b.cross(c)) / 6;
  }
  return Math.abs(v);
}

const M = new THREE.Matrix4().elements;
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('two offset boxes: difference, union and intersection by volume', () => withCore(() => {
  const a = box(), b = box(1, 0.3, 0.2);
  const overlap = 1 * 1.7 * 1.8;                 /* x 0..1, y -0.7..1, z -0.8..1 */
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Difference')), 8 - overlap), 'difference');
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Union')), 16 - overlap), 'union');
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Intersection')), overlap), 'intersection');
}));

test('a cutter fully inside leaves a shell of the right volume', () => withCore(() => {
  const a = box(), b = box(0, 0, 0, 1);
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Difference')), 7), 'difference 8 - 1');
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Intersection')), 1), 'intersection is the small box');
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Union')), 8), 'union is the big one');
}));

test('an enclosing box is the whole thing for intersection', () => withCore(() => {
  const a = box(), b = box(0, 0, 0, 6);
  assert.ok(near(volume(booleanGeometry(a, b, M, 'Intersection')), 8), 'A inside B');
}));

test('the three operations agree with each other', () => withCore(() => {
  /* |A| + |B| = |A union B| + |A intersect B|, always. */
  const a = box(0, 0, 0, 2, 0.4), b = box(0.8, 0, 0, 2, -0.2);
  const u = volume(booleanGeometry(a, b, M, 'Union'));
  const i = volume(booleanGeometry(a, b, M, 'Intersection'));
  assert.ok(near(u + i, 16, 0.01), `union + intersection = 16, got ${(u + i).toFixed(4)}`);
  const d = volume(booleanGeometry(a, b, M, 'Difference'));
  assert.ok(near(d + i, 8, 0.01), `difference + intersection = 8, got ${(d + i).toFixed(4)}`);
}));

test('every triangle is valid: in range, non-degenerate, finite', () => withCore(() => {
  for (const op of ['Difference', 'Union', 'Intersection']) {
    const out = booleanGeometry(box(), box(1, 0.3, 0.2), M, op);
    const I = out.index.array, P = out.attributes.position;
    for (let i = 0; i < I.length; i++) assert.ok(I[i] < P.count, `${op}: index ${I[i]} is in range`);
    for (let f = 0; f < I.length / 3; f++) {
      const a = new THREE.Vector3().fromBufferAttribute(P, I[f * 3]);
      const b = new THREE.Vector3().fromBufferAttribute(P, I[f * 3 + 1]);
      const c = new THREE.Vector3().fromBufferAttribute(P, I[f * 3 + 2]);
      assert.ok(Number.isFinite(a.x + b.y + c.z), `${op}: triangle ${f} is finite`);
      assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).length() > 1e-9, `${op}: triangle ${f} has area`);
    }
  }
}));

test('the operand matrix is applied before the cut', () => withCore(() => {
  const a = box();
  const matrix = new THREE.Matrix4().makeTranslation(1, 0.3, 0.2).elements;
  const moved = booleanGeometry(a, box(), matrix, 'Intersection');
  const still = booleanGeometry(a, box(), M, 'Intersection');
  assert.ok(near(volume(still), 8), 'the unchanged operand covers A fully');
  assert.ok(near(volume(moved), 1 * 1.7 * 1.8, 0.02), 'the moved one overlaps by the known box');
}));

test('a union of disjoint boxes keeps both', () => withCore(() => {
  const out = booleanGeometry(box(), box(5, 0, 0, 1), M, 'Union');
  assert.ok(near(volume(out), 9, 0.01), 'volumes add when nothing overlaps');
}));

test('UVs survive the cut', () => withCore(() => {
  const out = booleanGeometry(box(), box(1, 0.3, 0.2), M, 'Difference');
  assert.ok(out.attributes.uv, 'a uv attribute is present');
  assert.equal(out.attributes.uv.count, out.attributes.position.count);
  for (let i = 0; i < out.attributes.uv.count; i++) {
    assert.ok(Number.isFinite(out.attributes.uv.getX(i)) && Number.isFinite(out.attributes.uv.getY(i)));
  }
}));
