import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { arrayGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Array: arrayModifier_doArray from modifiers/intern/MOD_array.cc, ported as
 * fe_mod_array_ex() in cpp/src/fe_modifiers.cpp.
 *
 * The things Blender's implementation actually promises, and what is checked:
 *   - the offset is a MATRIX multiplied out copy by copy, so a rotation
 *     compounds into a spiral rather than a fan of translated copies;
 *   - Relative offset is a multiple of the object's bounding box;
 *   - Fit Length replaces Count with (length + 1e-6) / |offset| + 1;
 *   - Merge welds the seam between neighbouring copies;
 *   - UVs are offset per copy.
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

function box(size = 1) {
  const geometry = new THREE.BoxGeometry(size, size, size);
  geometry.computeVertexNormals();
  return geometry;
}

function uniquePositions(geometry) {
  const p = geometry.attributes.position;
  const seen = new Set();
  for (let i = 0; i < p.count; i++) {
    seen.add(`${p.getX(i).toFixed(5)}:${p.getY(i).toFixed(5)}:${p.getZ(i).toFixed(5)}`);
  }
  return seen.size;
}

/* The same count with a tolerance: a rotated copy lands on the same corner to
   within the float error of a 90-degree sine, not exactly on it. */
function uniqueRounded(geometry, digits = 3) {
  const p = geometry.attributes.position;
  const seen = new Set();
  for (let i = 0; i < p.count; i++) {
    seen.add(`${p.getX(i).toFixed(digits)}:${p.getY(i).toFixed(digits)}:${p.getZ(i).toFixed(digits)}`);
  }
  return seen.size;
}

function bounds(geometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox;
}

test('Fixed Count makes exactly that many copies, at the constant offset', () => {
  withCore(() => {
    const source = box(1);
    const perCopy = source.attributes.position.count;
    const result = arrayGeometry(source, { count: 4, offset: [2, 0, 0] });
    assert.equal(result.attributes.position.count, perCopy * 4);

    const b = bounds(result);
    assert.ok(Math.abs(b.min.x - -0.5) < 1e-5, `min x ${b.min.x}`);
    assert.ok(Math.abs(b.max.x - 6.5) < 1e-5, `max x ${b.max.x}`);
    /* and the copies are not stacked: 4 distinct blocks */
    assert.equal(uniquePositions(result), uniquePositions(source) * 4);
  });
});

test('Relative offset is measured in bounding-box widths', () => {
  withCore(() => {
    const source = box(1); // one unit wide
    const one = arrayGeometry(source, { count: 3, offset: [0, 0, 0], relative: [1, 0, 0] });
    const b = bounds(one);
    /* three unit cubes abut: -0.5 .. 2.5 */
    assert.ok(Math.abs(b.min.x - -0.5) < 1e-5 && Math.abs(b.max.x - 2.5) < 1e-5,
      `got ${b.min.x}..${b.max.x}`);

    const two = arrayGeometry(source, { count: 3, offset: [0, 0, 0], relative: [2, 0, 0] });
    const b2 = bounds(two);
    /* two widths apart: 0, 2, 4 */
    assert.ok(Math.abs(b2.max.x - 4.5) < 1e-5, `got ${b2.max.x}`);
  });
});

test('a rotated step compounds into a spiral, not a straight fan', () => {
  withCore(() => {
    const source = box(1);
    const result = arrayGeometry(source, { count: 4, offset: [0, 0, 0], rotationPerStep: 90 });
    /* 0, 90, 180, 270 degrees about the origin: every copy lands on the
       origin's footprint, four boxes in a pinwheel. The bounding box stays
       small - a translated fan would reach x = 3. */
    const b = bounds(result);
    assert.ok(b.min.x > -1.1 && b.max.x < 1.1, `x ${b.min.x}..${b.max.x}`);
    assert.ok(b.max.z < 1.1, `z ${b.max.z}`);
    /* each copy is still a full cube of its own */
    assert.equal(result.index.count / 3, (source.index.count / 3) * 4);
    /* four cubes at 90 degrees share one footprint */
    assert.equal(uniqueRounded(result), uniqueRounded(source));
  });
});

test('a rotated step with a translation spirals outwards', () => {
  withCore(() => {
    const source = box(0.4);
    const result = arrayGeometry(source, { count: 5, offset: [1, 0, 0], rotationPerStep: 72 });
    /* Five steps of (translate 1, rotate 72) close a pentagon: the copies wrap
       around the origin instead of marching along a line. */
    const b = bounds(result);
    assert.ok(b.max.z - b.min.z > 0.5, 'the copies spread in z, so they turned');
    /* a pentagon of step 1 has a circumradius of 1 / (2 sin 36°) = 0.85, and
       the copies are half a box wide on top of that */
    assert.ok(b.max.x < 1.8, `x reached ${b.max.x}, so the spiral did not close`);
  });
});

test('Fit Length replaces Count with Blender’s own arithmetic', () => {
  withCore(() => {
    const source = box(1);
    const perCopy = source.attributes.position.count;
    /* length 5, step 2 -> (5 + 1e-6) / 2 + 1 = 3 copies */
    const three = arrayGeometry(source, { fitType: 'Fit Length', fitLength: 5, offset: [2, 0, 0] });
    assert.equal(three.attributes.position.count, perCopy * 3);

    /* length 6, step 2 -> 4 copies */
    const four = arrayGeometry(source, { fitType: 'Fit Length', fitLength: 6, offset: [2, 0, 0] });
    assert.equal(four.attributes.position.count, perCopy * 4);

    /* a zero offset cannot fit anything: one copy, exactly as upstream says */
    const one = arrayGeometry(source, { fitType: 'Fit Length', fitLength: 10, offset: [0, 0, 0] });
    assert.equal(one.attributes.position.count, perCopy);

    /* Fit Curve is the same arithmetic with the length supplied directly */
    const curve = arrayGeometry(source, { fitType: 'Fit Curve', fitLength: 6, offset: [2, 0, 0] });
    assert.equal(curve.attributes.position.count, perCopy * 4);
  });
});

test('Merge welds the seam between abutting copies', () => {
  withCore(() => {
    const source = box(1);
    const perCopy = source.attributes.position.count;
    /* one unit apart, so every copy's right face sits on the next one's left */
    const unmerged = arrayGeometry(source, { count: 4, offset: [1, 0, 0] });
    const merged = arrayGeometry(source, { count: 4, offset: [1, 0, 0], merge: true, mergeDistance: 0.01 });
    assert.equal(unmerged.attributes.position.count, perCopy * 4);
    assert.ok(merged.attributes.position.count < unmerged.attributes.position.count,
      `merge kept ${merged.attributes.position.count} of ${unmerged.attributes.position.count}`);
    /* the seam vertices are gone: a 4-copy bar of unit cubes has 3 seams */
    const mergedBox = bounds(merged);
    assert.ok(Math.abs(mergedBox.max.x - unmerged.boundingBox.max.x) < 1e-5, 'merge moved geometry');

    /* With a gap wider than the merge distance nothing is welded. */
    const apart = arrayGeometry(source, { count: 4, offset: [2, 0, 0], merge: true, mergeDistance: 0.01 });
    assert.equal(apart.attributes.position.count, perCopy * 4);
  });
});

test('UVs are offset once per copy', () => {
  withCore(() => {
    const source = box(1);
    const perCopy = source.attributes.position.count;
    const result = arrayGeometry(source, { count: 3, offset: [2, 0, 0], uvOffset: [0.25, 0.1] });
    const uv = result.attributes.uv;
    assert.ok(uv, 'uv survives the array');
    /* copy 0 keeps its UVs, copy 1 is shifted once, copy 2 twice */
    const sourceUv = source.attributes.uv;
    for (let i = 0; i < perCopy; i++) {
      assert.ok(Math.abs(uv.getX(i) - sourceUv.getX(i)) < 1e-6);
      assert.ok(Math.abs(uv.getX(perCopy + i) - (sourceUv.getX(i) + 0.25)) < 1e-6);
      assert.ok(Math.abs(uv.getY(perCopy * 2 + i) - (sourceUv.getY(i) + 0.2)) < 1e-6);
    }
  });
});

test('one copy is the identity and the face count scales with it', () => {
  withCore(() => {
    const source = box(1);
    const faces = source.index.count / 3;
    const single = arrayGeometry(source, { count: 1 });
    assert.equal(single.index.count / 3, faces);

    const five = arrayGeometry(source, { count: 5, offset: [1.5, 0, 0] });
    assert.equal(five.index.count / 3, faces * 5);
  });
});

test('an offset object supplies the step matrix itself', () => {
  withCore(() => {
    /* MOD_array.cc: offset = offset * inverse(object) * offset_object, then
       compounded per copy. Here the object stands 3 units along x and a
       quarter turn about z, with the constant offset switched off entirely -
       every copy is the previous one carried through that transform. */
    const source = box(1);
    const perCopy = source.attributes.position.count;
    const step = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    step.setPosition(3, 0, 0);
    const result = arrayGeometry(source, { count: 3, offset: [0,0,0], objectOffset: step.elements });
    assert.equal(result.attributes.position.count, perCopy * 3);

    /* Copy 0 is the original, copy 1 is it through the step, copy 2 twice. */
    const p = result.attributes.position;
    const corner = (c) => new THREE.Vector3(p.getX(c * perCopy), p.getY(c * perCopy), p.getZ(c * perCopy));
    const near = (v, x, y, z) => Math.abs(v.x - x) < 1e-5 && Math.abs(v.y - y) < 1e-5 && Math.abs(v.z - z) < 1e-5;
    const src = source.attributes.position;
    const first = new THREE.Vector3(src.getX(0), src.getY(0), src.getZ(0));
    const one = first.clone().applyMatrix4(step);
    const two = one.clone().applyMatrix4(step);
    assert.ok(near(corner(0), first.x, first.y, first.z), `copy 0 at ${corner(0).toArray()}`);
    assert.ok(near(corner(1), one.x, one.y, one.z), `copy 1 at ${corner(1).toArray()}, wanted ${one.toArray()}`);
    assert.ok(near(corner(2), two.x, two.y, two.z), `copy 2 at ${corner(2).toArray()}, wanted ${two.toArray()}`);
  });
});

test('without an offset object the step matrix is the constant offset alone', () => {
  withCore(() => {
    const source = box(1);
    const a = arrayGeometry(source, { count: 3, offset: [2, 0, 0] });
    const identity = new THREE.Matrix4().elements;
    const b = arrayGeometry(source, { count: 3, offset: [2, 0, 0], objectOffset: identity });
    assert.deepEqual(Array.from(a.attributes.position.array), Array.from(b.attributes.position.array));
  });
});
