import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { bevelGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Bevel: bmesh_bevel.cc, ported as fe_mod_bevel() in cpp/src/fe_modifiers.cpp.
 *
 * The properties a bevel has to have, and that a broken one always loses:
 *   - the surface stays closed: every edge is used by exactly two triangles
 *   - it stays inside the original shape
 *   - it removes the sharp corner (the surface area falls)
 *   - more segments get closer to the round profile
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

const cube = () => new THREE.BoxGeometry(2, 2, 2);

function topology(g) {
  const idx = g.index.array, use = new Map();
  for (let f = 0; f < idx.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[f * 3 + k], b = idx[f * 3 + (k + 1) % 3];
      const key = Math.min(a, b) + ':' + Math.max(a, b);
      use.set(key, (use.get(key) || 0) + 1);
    }
  }
  const hist = {};
  for (const n of use.values()) hist[n] = (hist[n] || 0) + 1;
  return { edges: use.size, hist, v: g.attributes.position.count, f: idx.length / 3 };
}

function area(g) {
  const p = g.attributes.position, idx = g.index.array;
  let sum = 0;
  for (let f = 0; f < idx.length / 3; f++) {
    const a = new THREE.Vector3().fromBufferAttribute(p, idx[f * 3]);
    const b = new THREE.Vector3().fromBufferAttribute(p, idx[f * 3 + 1]);
    const c = new THREE.Vector3().fromBufferAttribute(p, idx[f * 3 + 2]);
    sum += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  return sum;
}

function extent(g) {
  const p = g.attributes.position;
  let m = 0;
  for (let i = 0; i < p.count; i++) m = Math.max(m, Math.abs(p.getX(i)), Math.abs(p.getY(i)), Math.abs(p.getZ(i)));
  return m;
}

test('a beveled cube is still a closed surface', () => withCore(() => {
  for (const segments of [1, 2, 4]) {
    const out = bevelGeometry(cube(), { width: 0.2, segments });
    const { hist, v, edges, f } = topology(out);
    assert.deepEqual(Object.keys(hist), ['2'], `segments ${segments}: every edge is used twice`);
    assert.equal(v - edges + f, 2, `segments ${segments}: Euler characteristic of a closed surface`);
  }
}));

test('the bevel stays inside the original shape', () => withCore(() => {
  for (const segments of [1, 2, 4, 8]) {
    const out = bevelGeometry(cube(), { width: 0.2, segments });
    assert.ok(extent(out) <= 1 + 1e-6, `segments ${segments}: never pokes out of the cube`);
  }
}));

test('bevelling removes a corner: the area drops, then climbs back with segments', () => withCore(() => {
  const src = area(cube());
  const one = area(bevelGeometry(cube(), { width: 0.2, segments: 1 }));
  const four = area(bevelGeometry(cube(), { width: 0.2, segments: 4 }));
  assert.ok(one < src, `a flat chamfer is smaller than the cube: ${one} < ${src}`);
  assert.ok(four > one, 'more segments follow the arc and come back up');
  assert.ok(four < src, 'but never past the original');
}));

test('zero width is the input back', () => withCore(() => {
  const src = cube();
  const out = bevelGeometry(src, { width: 0 });
  assert.equal(out.attributes.position.count, src.attributes.position.count);
  assert.deepEqual([...out.index.array], [...src.index.array]);
}));

test('clamp overlap keeps a too-wide bevel from crossing itself', () => withCore(() => {
  const out = bevelGeometry(cube(), { width: 5, segments: 2, clampOverlap: true });
  const { hist } = topology(out);
  assert.deepEqual(Object.keys(hist), ['2'], 'still a closed surface');
  assert.ok(extent(out) <= 1 + 1e-6);
}));

test('the profile pushes the arc out or in', () => withCore(() => {
  const a = area(bevelGeometry(cube(), { width: 0.2, segments: 4, profile: 0.2 }));
  const b = area(bevelGeometry(cube(), { width: 0.2, segments: 4, profile: 0.8 }));
  assert.ok(Number.isFinite(a) && Number.isFinite(b));
  assert.notEqual(a.toFixed(4), b.toFixed(4), 'the two profiles are not the same surface');
}));

test('a bevel replaces the sharp edges, it does not add to them', () => withCore(() => {
  const src = bevelGeometry(cube(), { width: 0.1, segments: 2 });
  const p = src.attributes.position;
  /* every vertex of a beveled cube sits on one of the twelve rounded edges or
     on one of the six faces, never at a corner of the original cube */
  let onCorner = 0;
  for (let i = 0; i < p.count; i++) {
    const x = Math.abs(p.getX(i)), y = Math.abs(p.getY(i)), z = Math.abs(p.getZ(i));
    if (x > 0.99 && y > 0.99 && z > 0.99) onCorner++;
  }
  assert.equal(onCorner, 0, 'no vertex is left at an original corner');
}));

test('UVs come along', () => withCore(() => {
  const out = bevelGeometry(cube(), { width: 0.2, segments: 2 });
  assert.ok(out.attributes.uv);
  assert.equal(out.attributes.uv.count, out.attributes.position.count);
}));

/* ---- the settings Blender exposes, added in this pass ---- */

test('Offset Type changes what the slider means', () => withCore(() => {
  const base = { segments: 2, clampOverlap: false };
  const offset = bevelGeometry(cube(), { ...base, width: 0.2, offsetType: 'Offset' });
  const width = bevelGeometry(cube(), { ...base, width: 0.2, offsetType: 'Width' });
  const percent = bevelGeometry(cube(), { ...base, width: 20, offsetType: 'Percent' });
  const ext = g => extent(g);
  assert.ok(ext(offset) <= 1 + 1e-6 && ext(width) <= 1 + 1e-6, 'both stay inside the cube');
  assert.notEqual(area(offset).toFixed(4), area(width).toFixed(4), 'Width is not Offset');
  assert.ok(Math.abs(area(percent) - area(offset)) > 1e-6, 'Percent is not Offset either');
  for (const g of [offset, width, percent]) {
    assert.deepEqual(Object.keys(topology(g).hist), ['2'], 'still closed');
  }
}));

test('an angle limit leaves the shallow edges sharp', () => withCore(() => {
  /* A cube has 90-degree edges everywhere, so a 120-degree limit bevels
     nothing and a 30-degree limit bevels everything. */
  const none = bevelGeometry(cube(), { width: 0.2, segments: 2, limitMethod: 'Angle', angleLimit: 120 });
  const all = bevelGeometry(cube(), { width: 0.2, segments: 2, limitMethod: 'Angle', angleLimit: 30 });
  assert.equal(none.attributes.position.count, 24, 'nothing was sharp enough to bevel');
  assert.ok(all.attributes.position.count > 24, 'everything was');
}));
