import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { solidifyGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Solidify: the shell from modifiers/intern/MOD_solidify_extrude.cc, ported as
 * fe_mod_solidify() in cpp/src/fe_modifiers.cpp.
 *
 * The properties checked here are the ones the Blender formula actually
 * guarantees:
 *   ofs_orig = -(((-offset + 1) * 0.5) * thickness)
 *   ofs_new  = thickness + ofs_orig
 * so Offset -1 keeps the original surface and pushes the copy, 0 splits the
 * thickness either side of it, +1 pushes the original instead. With Even
 * Thickness the offset is scaled by 1/|dot(vertex normal, face normal)|
 * averaged over the corner angles, which is what makes the wall on a corner
 * keep its thickness instead of thinning out.
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

/* A plane on z = 0, normal +z. */
function plane(size = 2, segments = 2) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.computeVertexNormals();
  return geometry;
}

/* A welded, outward-facing cube: 8 vertices, 12 triangles. THREE's
   BoxGeometry is six disconnected quads, so it can never test a shell's
   manifoldness; this can. */
function weldedCube(size = 2) {
  const h = size / 2;
  const positions = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h
  ];
  const quads = [
    [0, 3, 2, 1], // -z
    [4, 5, 6, 7], // +z
    [0, 1, 5, 4], // -y
    [1, 2, 6, 5], // +x
    [2, 3, 7, 6], // +y
    [3, 0, 4, 7] // -x
  ];
  const indices = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function triangleCount(geometry) {
  const index = geometry.getIndex();
  return index ? index.count / 3 : geometry.attributes.position.count / 3;
}

function zRange(geometry) {
  const p = geometry.attributes.position;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < p.count; i++) {
    min = Math.min(min, p.getZ(i));
    max = Math.max(max, p.getZ(i));
  }
  return { min, max };
}

function edgeUse(geometry) {
  const index = geometry.getIndex();
  const idx = index.array;
  const uses = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const u = idx[i + k];
      const v = idx[i + (k + 1) % 3];
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

function facePlane(geometry, faceIndex) {
  const p = geometry.attributes.position;
  const idx = geometry.getIndex().array;
  const a = new THREE.Vector3().fromBufferAttribute(p, idx[faceIndex * 3]);
  const b = new THREE.Vector3().fromBufferAttribute(p, idx[faceIndex * 3 + 1]);
  const c = new THREE.Vector3().fromBufferAttribute(p, idx[faceIndex * 3 + 2]);
  const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  return { n, d: -n.dot(a) };
}

test('the offset slider moves the two shells the way Blender divides the thickness', () => {
  withCore(() => {
    const thickness = 0.2;
    const cases = [
      [-1, -thickness, 0],   // original stays, copy is pushed
      [0, -thickness / 2, thickness / 2], // centred
      [1, 0, thickness]      // copy stays, original is pushed
    ];
    for (const [offset, wantMin, wantMax] of cases) {
      const result = solidifyGeometry(plane(), thickness, offset, { rim: true, evenThickness: true });
      const { min, max } = zRange(result);
      assert.ok(Math.abs(min - wantMin) < 1e-5, `offset ${offset}: min ${min} != ${wantMin}`);
      assert.ok(Math.abs(max - wantMax) < 1e-5, `offset ${offset}: max ${max} != ${wantMax}`);
    }
  });
});

test('a shell is two surfaces plus a rim, and no original face is lost', () => {
  withCore(() => {
    const source = plane(2, 2);
    const faces = triangleCount(source);
    const result = solidifyGeometry(source, 0.1, -1, { rim: true });
    /* Two skins of the same face count... */
    assert.ok(triangleCount(result) > faces * 2, 'the copy and the rim are both present');

    const uses = edgeUse(result);
    let boundary = 0;
    for (const count of uses.values()) if (count === 1) boundary++;
    /* The plane is open; a rim closes its border, so nothing is left with a
       single user unless the rim failed. */
    assert.equal(boundary, 0, `${boundary} edges were left open by the rim`);
  });
});

test('a closed cube becomes a closed shell: no open edge anywhere', () => {
  withCore(() => {
    const result = solidifyGeometry(weldedCube(2), 0.2, -1, { rim: true, evenThickness: true });
    const uses = edgeUse(result);
    let boundary = 0;
    let nonManifold = 0;
    for (const count of uses.values()) {
      if (count === 1) boundary++;
      if (count > 2) nonManifold++;
    }
    assert.equal(boundary, 0, `${boundary} edges are open`);
    assert.equal(nonManifold, 0, `${nonManifold} edges are used more than twice`);
  });
});

test('even thickness keeps the wall the same width on a corner', () => {
  withCore(() => {
    const thickness = 0.2;
    const source = weldedCube(2);
    const even = solidifyGeometry(source, thickness, -1, { evenThickness: true });
    const flat = solidifyGeometry(source, thickness, -1, { evenThickness: false });
    const faces = triangleCount(source);

    /* Every face has a copy: measure the distance between the two planes. With
       Even Thickness the wall is the requested thickness even at the corners;
       without it the corners pull in and the wall thins. */
    const wall = (geometry) => {
      const distances = [];
      for (let f = 0; f < faces; f++) {
        /* The kernel writes each face and then its copy: 2f and 2f + 1. */
        const outer = facePlane(geometry, f * 2);
        const inner = facePlane(geometry, f * 2 + 1);
        const p = geometry.attributes.position;
        const idx = geometry.getIndex().array;
        const point = new THREE.Vector3().fromBufferAttribute(p, idx[f * 2 * 3]);
        /* the copy is wound the other way, so its normal points inward */
        const signed = inner.n.dot(point) + inner.d;
        distances.push(Math.abs(signed));
      }
      return distances;
    };
    const evenWall = wall(even);
    const flatWall = wall(flat);
    const maxEven = Math.max(...evenWall);
    const maxFlat = Math.max(...flatWall);
    /* A cube corner has three faces at 90 degrees, so its vertex normal is the
       body diagonal: a plain offset of t along it only puts the copy t/sqrt(3)
       away from each face. Even thickness divides that back out. */
    assert.ok(maxEven > thickness * 0.95 && maxEven < thickness * 1.05,
      `even wall reached ${maxEven.toFixed(4)}, wanted about ${thickness}`);
    assert.ok(Math.abs(maxFlat - thickness / Math.sqrt(3)) < 0.01,
      `plain wall should be t/sqrt(3) = ${(thickness / Math.sqrt(3)).toFixed(4)}, got ${maxFlat.toFixed(4)}`);
  });
});

test('a zero thickness is a no-op and an inverted one flips the shell', () => {
  withCore(() => {
    const source = plane();
    const same = solidifyGeometry(source, 0, -1);
    assert.equal(triangleCount(same), triangleCount(source));

    const negative = solidifyGeometry(source, -0.2, -1);
    const { min, max } = zRange(negative);
    /* -thickness with offset -1: ofs_orig = +0.2, ofs_new = 0 */
    assert.ok(Math.abs(max - 0.2) < 1e-5 && Math.abs(min) < 1e-5, `got ${min}..${max}`);
  });
});
