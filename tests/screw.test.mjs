import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { screwGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Screw: MOD_screw.cc, ported as fe_mod_screw() in cpp/src/fe_modifiers.cpp.
 *
 * The profile is the mesh's edges. Every step adds a rotated copy of it and
 * joins consecutive copies, so the counts below are the contract:
 *
 *   rings   = ((steps + 1) * iterations) - (iterations - 1)   (minus one when
 *             the sweep closes on itself)
 *   verts   = profileVerts * rings
 *   tris    = profileEdges * ringGaps * 2
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

/* A ribbon at x = 1 running up the Y axis: 10 verts, 8 triangles, 17 edges. */
function profile() {
  const P = [], I = [];
  for (let k = 0; k < 5; k++) P.push(1, k * 0.25, 0, 1, k * 0.25, 0.01);
  for (let k = 0; k < 4; k++) {
    const a = k * 2, b = k * 2 + 1, c = (k + 1) * 2, d = (k + 1) * 2 + 1;
    I.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  return g;
}

const PROFILE_EDGES = 17;

function radii(g) {
  const p = g.attributes.position, out = [];
  for (let i = 0; i < p.count; i++) out.push(Math.hypot(p.getX(i), p.getZ(i)));
  return out;
}

test('a full turn closes instead of duplicating the first ring', () => withCore(() => {
  const src = profile();
  const out = screwGeometry(src, { angle: 360, steps: 8, axis: 1 });
  assert.equal(out.attributes.position.count, 10 * 8, 'eight rings, not nine');
  assert.equal(out.index.count / 3, PROFILE_EDGES * 8 * 2, 'the closing gap is filled too');
}));

test('a quarter turn leaves the sweep open', () => withCore(() => {
  const out = screwGeometry(profile(), { angle: 90, steps: 4, axis: 1 });
  assert.equal(out.attributes.position.count, 10 * 5, 'steps + 1 rings');
  assert.equal(out.index.count / 3, PROFILE_EDGES * 4 * 2, 'four gaps, no wrap');
}));

test('the profile keeps its radius and the axis is untouched', () => withCore(() => {
  const out = screwGeometry(profile(), { angle: 360, steps: 12, axis: 1 });
  for (const r of radii(out)) assert.ok(Math.abs(r - 1) < 1e-3, `radius ${r} should be 1`);
  const p = out.attributes.position;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.count; i++) { lo = Math.min(lo, p.getY(i)); hi = Math.max(hi, p.getY(i)); }
  assert.ok(Math.abs(lo) < 1e-5 && Math.abs(hi - 1) < 1e-5, 'the profile height is 0..1');
}));

test('a screw offset turns the sweep into a helix', () => withCore(() => {
  const out = screwGeometry(profile(), { angle: 360, screwOffset: 0.5, steps: 8, axis: 1 });
  const p = out.attributes.position;
  let hi = -Infinity;
  for (let i = 0; i < p.count; i++) hi = Math.max(hi, p.getY(i));
  assert.ok(Math.abs(hi - 1.5) < 1e-4, `the top should climb to 1.5, got ${hi}`);
}));

test('iterations multiply the sweep', () => withCore(() => {
  /* 120 degrees twice is 240: a full turn would close and lose a ring. */
  const one = screwGeometry(profile(), { angle: 120, iterations: 1, steps: 4, axis: 1 });
  const two = screwGeometry(profile(), { angle: 120, iterations: 2, steps: 4, axis: 1 });
  assert.equal(one.attributes.position.count, 10 * 5);
  assert.equal(two.attributes.position.count, 10 * 9, '(steps+1)*iter - (iter-1)');
  assert.ok(two.index.count > one.index.count);
}));

test('the axis switch sweeps around a different line', () => withCore(() => {
  const y = screwGeometry(profile(), { angle: 360, steps: 6, axis: 1 });
  const x = screwGeometry(profile(), { angle: 360, steps: 6, axis: 0 });
  const extent = (g, k) => {
    const p = g.attributes.position;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.count; i++) { const v = p.array[i * 3 + k]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return Math.round((hi - lo) * 1e4) / 1e4;
  };
  /* The swept axis itself never moves: around Y the profile keeps its y range
     and swings through x, around X it keeps its x and swings through z. */
  assert.deepEqual(extent(y, 1), extent(profile(), 1), 'Y is the axis, so y is untouched');
  assert.ok(extent(y, 0) > 1.5, 'and x is swept out');
  assert.ok(extent(x, 2) > 1.5, 'around X it is z that is swept out');
}));

test('the surface has finite, unit normals', () => withCore(() => {
  const out = screwGeometry(profile(), { angle: 360, steps: 10, axis: 1 });
  const n = out.attributes.normal;
  assert.ok(n && n.count === out.attributes.position.count);
  for (let i = 0; i < n.count; i++) {
    assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-3, `normal ${i}`);
  }
}));

test('normal flip reverses the winding', () => withCore(() => {
  const a = screwGeometry(profile(), { angle: 90, steps: 3, axis: 1 });
  const b = screwGeometry(profile(), { angle: 90, steps: 3, axis: 1, normalFlip: true });
  assert.equal(a.index.count, b.index.count);
  assert.notDeepEqual([...a.index.array].slice(0, 6), [...b.index.array].slice(0, 6));
}));
