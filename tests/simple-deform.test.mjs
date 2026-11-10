import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { simpleDeformGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Simple Deform: MOD_simpledeform.cc, ported as fe_mod_simple_deform() in
 * cpp/src/fe_modifiers.cpp.
 *
 * The properties below are the ones the formulas promise. Blender normalises
 * the slider limits to the mesh's own bounds and divides the factor by that
 * span, so a 90-degree Bend bends the object through 90 degrees whatever it
 * measures - that normalisation is what most of these tests pin down.
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

/* A beam along the given axis, from the origin outwards. */
function beam(axis = 'Z', length = 4, width = 1) {
  const g = new THREE.BoxGeometry(width, width, length, 1, 1, 8);
  /* BoxGeometry is centred; put the base on the origin so the deformation has
     a clean zero to measure from. */
  g.translate(0, 0, length / 2);
  if (axis === 'X') g.rotateY(Math.PI / 2);
  if (axis === 'Y') g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

function bbox(g) {
  g.computeBoundingBox();
  return g.boundingBox;
}

function cornerDistance(g, a, b) {
  const p = g.attributes.position;
  return Math.hypot(p.getX(a) - p.getX(b), p.getY(a) - p.getY(b), p.getZ(a) - p.getZ(b));
}

test('a Twist turns the far end and leaves the near end alone', () => {
  withCore(() => {
    const source = beam('Z', 4);
    const twisted = simpleDeformGeometry(source, { mode: 'Twist', axis: 'Z', angle: 180 });
    const b = bbox(twisted);
    /* 180 degrees: the corners of the top face swap sides, so the beam's
       cross-section sweeps a disc of radius sqrt(0.5^2 + 0.5^2) = 0.707. */
    assert.ok(Math.abs(b.max.x - 0.7071) < 0.01, `x reached ${b.max.x.toFixed(4)}`);
    assert.ok(Math.abs(b.min.x - -0.7071) < 0.01, `x reached ${b.min.x.toFixed(4)}`);
    /* the length is untouched: a twist does not stretch */
    assert.ok(Math.abs(b.max.z - 4) < 1e-4 && Math.abs(b.min.z) < 1e-4);

    /* zero angle is a no-op */
    const still = simpleDeformGeometry(source, { mode: 'Twist', axis: 'Z', angle: 0 });
    const b0 = bbox(still);
    assert.ok(Math.abs(b0.max.x - 0.5) < 1e-4, `zero twist moved a corner to ${b0.max.x}`);
  });
});

test('a 90 degree Twist turns a quarter turn, not a half', () => {
  withCore(() => {
    const source = beam('Z', 4);
    const p = source.attributes.position;
    /* A corner of the top face, at z = 4. */
    let top = -1;
    for (let i = 0; i < p.count; i++) if (p.getZ(i) > 3.99 && p.getX(i) > 0.49 && p.getY(i) > 0.49) top = i;
    assert.ok(top >= 0, 'found the top-right corner');
    const q = simpleDeformGeometry(source, { mode: 'Twist', axis: 'Z', angle: 90 }).attributes.position;
    /* (0.5, 0.5) rotated 90 degrees about z is (-0.5, 0.5). */
    assert.ok(Math.abs(q.getX(top) - -0.5) < 0.01, `x ${q.getX(top).toFixed(4)}`);
    assert.ok(Math.abs(q.getY(top) - 0.5) < 0.01, `y ${q.getY(top).toFixed(4)}`);
    assert.ok(Math.abs(q.getZ(top) - 4) < 1e-4);
  });
});

test('a Bend curls the beam onto a circle of radius 1/factor', () => {
  withCore(() => {
    /* Bend around Z of a beam that runs along X: theta = x * factor, and the
       formula r_co[0] = -(y - 1/f)*sin(t), r_co[1] = y*cos(t) + (1-cos(t))/f
       maps the beam onto a circle centred at (0, 1/f) in the XY plane. */
    const length = 4;
    const angle = 90;
    const source = beam('X', length);
    const bent = simpleDeformGeometry(source, { mode: 'Bend', axis: 'Z', angle });
    const radius = length / (angle * Math.PI / 180);

    /* Every vertex has to sit at that radius from the centre of curvature. */
    const p = bent.attributes.position;
    let worst = 0;
    for (let i = 0; i < p.count; i++) {
      const d = Math.hypot(p.getX(i) - 0, p.getY(i) - radius);
      worst = Math.max(worst, Math.abs(d - radius));
    }
    /* the corners of the cross-section sit half a width either side, so the
       radius varies by at most the beam's half width */
    assert.ok(worst < 0.71, `a vertex sat ${worst.toFixed(3)} off the arc`);
    /* and the far end really did travel round the quarter turn */
    const b = bbox(bent);
    assert.ok(b.max.y > radius * 0.9, `y reached ${b.max.y.toFixed(3)}, wanted about ${radius.toFixed(3)}`);
    assert.ok(Math.abs(b.max.z - 0.5) < 0.01, 'a bend about Z moved the beam along Z');

    /* A bend of zero is refused by BEND_EPS upstream, so the mesh is unchanged */
    const flat = simpleDeformGeometry(source, { mode: 'Bend', axis: 'Z', angle: 0 });
    assert.ok(Math.abs(bbox(flat).max.x - bbox(source).max.x) < 1e-5, 'a zero bend moved the mesh');
  });
});

test('a Taper scales the cross-section with the deform axis', () => {
  withCore(() => {
    const source = beam('Z', 4, 1); // z from 0 to 4, x/y in [-0.5, 0.5]
    const tapered = simpleDeformGeometry(source, { mode: 'Taper', axis: 'Z', factor: 1 });
    const p = tapered.attributes.position;
    /* scale = z * factor, with the factor normalised by the span (4). So at
       z = 4 the scale is 1 and the width doubles; at z = 0 it does not move. */
    let bottom = 0, top = 0;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getZ(i)) < 1e-4) bottom = Math.max(bottom, Math.abs(p.getX(i)));
      if (p.getZ(i) > 3.99) top = Math.max(top, Math.abs(p.getX(i)));
    }
    assert.ok(Math.abs(bottom - 0.5) < 1e-3, `the base moved to ${bottom}`);
    assert.ok(Math.abs(top - 1.0) < 0.02, `the tip should be twice as wide, got ${top}`);
  });
});

test('a Stretch lengthens the beam and bows its middle', () => {
  withCore(() => {
    const length = 4;
    const factor = 4;
    const source = beam('Z', length, 1);
    const stretched = simpleDeformGeometry(source, { mode: 'Stretch', axis: 'Z', factor });
    const b = bbox(stretched);
    /* Blender divides the slider by the object's span before it is used, so the
       factor that reaches the formula is factor / length: here 1. Then
       z *= 1 + f  and  (x, y) *= z^2 * f - f + 1, which is 1 at z = 0. */
    const f = factor / length;
    assert.ok(Math.abs(b.max.z - length * (1 + f)) < 1e-3,
      `length became ${b.max.z.toFixed(3)}, wanted ${(length * (1 + f)).toFixed(3)}`);
    assert.ok(b.max.x > 0.5, `the cross-section should grow along the beam, got ${b.max.x.toFixed(3)}`);
  });
});

test('Locking an axis holds that axis still through the deformation', () => {
  withCore(() => {
    const source = beam('Z', 4, 1);
    /* axis_limit() cuts the locked coordinate to zero and hands the amount it
       cut to the deformation as dcut, which is added back afterwards. For a
       Taper about Z that means x comes out exactly as it went in, instead of
       being widened with the rest of the cross-section. */
    const free = simpleDeformGeometry(source, { mode: 'Taper', axis: 'Z', factor: 1 });
    const locked = simpleDeformGeometry(source, { mode: 'Taper', axis: 'Z', factor: 1, lockX: true });

    const maxAbsX = (geometry) => {
      const p = geometry.attributes.position;
      let m = 0;
      for (let i = 0; i < p.count; i++) m = Math.max(m, Math.abs(p.getX(i)));
      return m;
    };
    assert.ok(maxAbsX(free) > 0.99, `an unlocked taper should double the width, got ${maxAbsX(free)}`);
    assert.ok(maxAbsX(locked) < 0.51, `a locked taper kept x at ${maxAbsX(locked)}, wanted 0.5`);
    /* and it is still the same mesh, not degenerate */
    assert.equal(locked.index.count, source.index.count);
  });
});

test('the limits crop the deformation to a slice of the object', () => {
  withCore(() => {
    const source = beam('Z', 4, 1);
    /* Only the top half (0.5 .. 1.0) deforms; the bottom half is cut back to
       the lower limit and rides along undeformed. */
    const sliced = simpleDeformGeometry(source, {
      mode: 'Taper', axis: 'Z', factor: 1, limitLower: 0.5, limitUpper: 1
    });
    const p = sliced.attributes.position;
    let bottomWidth = 0, topWidth = 0;
    for (let i = 0; i < p.count; i++) {
      if (p.getZ(i) < 2.01) bottomWidth = Math.max(bottomWidth, Math.abs(p.getX(i)));
      if (p.getZ(i) > 3.99) topWidth = Math.max(topWidth, Math.abs(p.getX(i)));
    }
    /* The limit changes which coordinate drives the deformation, not where the
       vertices sit: axis_limit() records how much it cut in dcut, and every
       deformation adds that back. So the slice below the line keeps its own z
       and is tapered as if it were at the limit - a constant cross-section -
       while everything above keeps tapering normally. */
    assert.ok(bottomWidth > 0.99 && bottomWidth < 1.01, `the clamped slice is ${bottomWidth.toFixed(3)} wide`);
    /* With the limits at 0.5 .. 1.0 the factor is divided by half the object's
       span, so the scale at the limit is 1 and at the top it is 2: the widths
       are 0.5 * (1 + s), i.e. 1.0 and 1.5. */
    assert.ok(Math.abs(topWidth - 1.5) < 0.02, `the top tapered to ${topWidth.toFixed(3)}, wanted 1.5`);
    /* and nothing fell through the floor: the object is still 0 .. 4 tall */
    assert.ok(Math.abs(bbox(sliced).min.z) < 1e-4 && Math.abs(bbox(sliced).max.z - 4) < 1e-4,
      `the slice spans ${bbox(sliced).min.z.toFixed(3)}..${bbox(sliced).max.z.toFixed(3)}`);
  });
});

test('every mode leaves the topology and the UVs alone', () => {
  withCore(() => {
    const source = beam('Z', 4, 1);
    for (const mode of ['Twist', 'Bend', 'Taper', 'Stretch']) {
      const g = simpleDeformGeometry(source, { mode, axis: 'Z', angle: 30, factor: 0.3 });
      assert.equal(g.index.count, source.index.count, `${mode} changed the face count`);
      assert.equal(g.attributes.position.count, source.attributes.position.count, `${mode} changed the vertex count`);
      assert.ok(g.attributes.uv, `${mode} dropped the UVs`);
    }
  });
});
