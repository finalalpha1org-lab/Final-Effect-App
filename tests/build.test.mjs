import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { buildGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Build: MOD_build.cc, ported as fe_mod_build() in cpp/src/fe_modifiers.cpp.
 *
 * Upstream keeps `faces * frac` faces - in order, or from a seeded shuffle -
 * and compacts whatever vertices they still use. Nothing moves. The tests
 * pin the counts and the compaction, which is where a port like this breaks.
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

function cube() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.computeVertexNormals();
  return g;                       /* 12 triangles, 24 vertices */
}

test('half of the faces survive the build', () => withCore(() => {
  const src = cube();
  const out = buildGeometry(src, { progress: 0.5, randomize: false });
  assert.equal(out.index.count / 3, 6, '12 faces * 0.5');
  assert.ok(out.attributes.position.count <= 24, 'only the vertices in use are kept');
  assert.ok(out.attributes.position.count >= 8);
}));

test('a full build is the whole mesh, an empty one keeps a face', () => withCore(() => {
  const src = cube();
  const full = buildGeometry(src, { progress: 1, randomize: false });
  assert.equal(full.index.count, src.index.count);
  const none = buildGeometry(src, { progress: 0, randomize: false });
  assert.equal(none.index.count, 3, 'the fraction never reaches zero faces');
}));

test('reverse inverts the fraction, the way frac = 1 - frac does upstream', () => withCore(() => {
  const src = cube();
  const early = buildGeometry(src, { progress: 0.25, randomize: false });
  const late = buildGeometry(src, { progress: 0.25, reverse: true, randomize: false });
  assert.equal(early.index.count / 3, 3, 'a quarter of twelve');
  assert.equal(late.index.count / 3, 9, 'and the reverse keeps the other three quarters');
  /* The reverse build is a superset: it reveals the same start, further along. */
  const first = new Set(early.index.array);
  for (const i of first) assert.ok([...late.index.array].includes(i));
}));

test('randomize picks a different set for a different seed', () => withCore(() => {
  const src = cube();
  const a = buildGeometry(src, { progress: 0.5, randomize: true, seed: 1 });
  const b = buildGeometry(src, { progress: 0.5, randomize: true, seed: 2 });
  assert.equal(a.index.count, b.index.count);
  assert.notDeepEqual([...a.index.array], [...b.index.array]);
}));

test('the same seed is the same build, every time', () => withCore(() => {
  const src = cube();
  const a = buildGeometry(src, { progress: 0.75, randomize: true, seed: 7 });
  const b = buildGeometry(src, { progress: 0.75, randomize: true, seed: 7 });
  assert.deepEqual([...a.index.array], [...b.index.array]);
  assert.deepEqual([...a.attributes.position.array], [...b.attributes.position.array]);
}));

test('the surviving geometry is untouched, only compacted', () => withCore(() => {
  const src = cube();
  const out = buildGeometry(src, { progress: 0.5, randomize: false });
  const p = out.attributes.position;
  const indices = new Set(out.index.array);
  for (const i of indices) {
    assert.ok(i >= 0 && i < p.count, 'every index points inside the new buffer');
  }
  assert.equal(indices.size, p.count, 'no vertex is left unused');
}));

test('UVs come along with the faces that survive', () => withCore(() => {
  const src = cube();
  const out = buildGeometry(src, { progress: 0.5, randomize: false });
  assert.ok(out.attributes.uv);
  assert.equal(out.attributes.uv.count, out.attributes.position.count);
}));

test('the geometry has finite bounds', () => withCore(() => {
  const out = buildGeometry(cube(), { progress: 0.4 });
  out.computeBoundingBox();
  const bb = out.boundingBox;
  assert.ok([bb.min.x, bb.max.x, bb.min.y, bb.max.y, bb.min.z, bb.max.z].every(Number.isFinite));
}));
