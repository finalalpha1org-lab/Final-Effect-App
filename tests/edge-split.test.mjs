import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { edgeSplitGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Edge Split: MOD_edgesplit.cc + bmesh_edgesplit.cc, ported as
 * fe_mod_edge_split() in cpp/src/fe_modifiers.cpp.
 *
 * The modifier moves nothing. The tests therefore pin the vertex counts, the
 * positions (unchanged to the bit), and the fan structure: which corners still
 * share a vertex and which were cut apart.
 * ========================================================================= */

const wasmBytes = readFileSync(appPath('fe_core_engine.wasm'));
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const exports = instance.exports;

/* One quad split into two triangles and folded along the diagonal, so the two
   faces meet at 90 degrees on an edge they share. */
function foldedQuad() {
  const P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1];
  const I = [0, 1, 2, 1, 3, 2];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex(I);
  return g;
}

/* A welded cube: 8 vertices, 12 triangles, twelve 90-degree edges. This is the
   classic auto-smooth case - split at 30 degrees it becomes 24 corners. */
function cube(size = 1) {
  const h = size;
  const P = [-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
             -h, -h, h, h, -h, h, h, h, h, -h, h, h];
  const Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const I = [];
  for (const [a, b, c, d] of Q) I.push(a, b, c, a, c, d);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  return g;
}

function positions(g) {
  const p = g.attributes.position;
  const out = [];
  for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
  return out;
}

function sortedUniquePositions(g) {
  return [...new Set(positions(g).map(v => v.map(n => n.toFixed(6)).join(',')))].sort();
}

test('a 90-degree cube at 30 degrees splits into one vertex per corner', () => {
  const out = edgeSplitGeometry(cube(), { splitAngle: 30 });
  assert.equal(out.index.count, 36, 'triangle count never changes');
  assert.equal(out.attributes.position.count, 24, 'six faces x four corners');
  assert.equal(sortedUniquePositions(out).length, 8, 'no vertex moved');
});

test('nothing moves, whatever the angle', () => {
  const src = cube();
  for (const angle of [0, 10, 45, 89, 91, 180]) {
    const out = edgeSplitGeometry(src, { splitAngle: angle });
    assert.deepEqual(sortedUniquePositions(out), sortedUniquePositions(src), `angle ${angle}`);
    assert.equal(out.index.count, src.index.count, `angle ${angle}`);
  }
});

test('above the sharpest edge nothing splits and the topology is untouched', () => {
  const out = edgeSplitGeometry(cube(), { splitAngle: 100 });
  assert.equal(out.attributes.position.count, 8);
  assert.deepEqual([...out.index.array], [...cube().index.array]);
});

test('zero splits every edge, one vertex per corner even on a cubic corner', () => {
  const out = edgeSplitGeometry(cube(), { splitAngle: 0 });
  assert.equal(out.index.count, 36);
  assert.equal(out.attributes.position.count, 36, '12 triangles x 3 unique corners');
});

test('a 180-degree threshold is a no-op', () => {
  const src = cube();
  const out = edgeSplitGeometry(src, { splitAngle: 180 });
  assert.equal(out.attributes.position.count, 8);
  assert.deepEqual([...out.index.array], [...src.index.array]);
});

test('useAngle false leaves the mesh alone', () => {
  const src = cube();
  const out = edgeSplitGeometry(src, { splitAngle: 10, useAngle: false });
  assert.equal(out.attributes.position.count, 8);
  assert.deepEqual([...out.index.array], [...src.index.array]);
});

test('a shared edge between two faces folds open, an open boundary never splits', () => {
  const src = foldedQuad();
  const split = edgeSplitGeometry(src, { splitAngle: 30 });
  /* The diagonal is a 90-degree seam, so its two ends gain a vertex each:
     the four outer boundary edges have a single face and are left alone. */
  assert.equal(split.attributes.position.count, 6);
  assert.equal(sortedUniquePositions(split).length, 4, 'still the same four corners');

  const kept = edgeSplitGeometry(src, { splitAngle: 100 });
  assert.equal(kept.attributes.position.count, 4, 'nothing is sharp enough');
  assert.deepEqual([...kept.index.array], [...src.index.array]);
});

test('UVs survive the split', () => {
  const out = edgeSplitGeometry(foldedQuad(), { splitAngle: 10 });
  assert.ok(out.attributes.uv, 'uv attribute is present');
  assert.equal(out.attributes.uv.count, out.attributes.position.count);
  const xs = new Set();
  for (let i = 0; i < out.attributes.uv.count; i++) xs.add(out.attributes.uv.getX(i));
  assert.equal(xs.size, 2, 'u only ever 0 or 1');
});

test('the kernel refuses a mesh that will not fit the arena', () => {
  const src = cube();
  const t = src.index.count / 3;
  /* Only the input vertices of headroom; a full split wants three per corner. */
  assert.equal(exports.fe_mod_begin(8, t, 0), 0);
  const pos = src.attributes.position.array, idx = src.index.array;
  new Float32Array(exports.memory.buffer, exports.fe_mod_in_pos_ptr(), pos.length).set(pos);
  new Uint32Array(exports.memory.buffer, exports.fe_mod_in_idx_ptr(), idx.length).set(idx);
  exports.fe_mod_set_counts(8, t);
  assert.equal(exports.fe_mod_edge_split(0, 1, 0), -2, 'ran out of output vertices');
  assert.equal(exports.fe_mod_begin(t * 3 + 16, t, 0), 0, 'the session is still usable afterwards');
});

test('the kernel reports the counts it wrote', () => {
  const src = cube();
  const t = src.index.count / 3;
  assert.equal(exports.fe_mod_begin(t * 3 + 16, t, 0), 0);
  const pos = src.attributes.position.array, idx = src.index.array;
  new Float32Array(exports.memory.buffer, exports.fe_mod_in_pos_ptr(), pos.length).set(pos);
  new Uint32Array(exports.memory.buffer, exports.fe_mod_in_idx_ptr(), idx.length).set(idx);
  exports.fe_mod_set_counts(src.attributes.position.count, t);
  assert.equal(exports.fe_mod_edge_split(Math.PI / 6, 1, 0), 0);
  const counts = new Uint32Array(exports.memory.buffer, exports.fe_mod_counts_ptr(), 2);
  assert.equal(counts[0], 24, 'one vertex per corner');
  assert.equal(counts[1], t, 'triangle count is never touched');
});

test('the geometry has finite bounds and normals', () => {
  const out = edgeSplitGeometry(cube(), { splitAngle: 30 });
  out.computeBoundingBox();
  const bb = out.boundingBox;
  assert.ok([bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].every(Number.isFinite));
  const n = out.attributes.normal;
  assert.ok(n && n.count === out.attributes.position.count);
  for (let i = 0; i < n.count; i++) {
    assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-3, `normal ${i} is unit length`);
  }
});
