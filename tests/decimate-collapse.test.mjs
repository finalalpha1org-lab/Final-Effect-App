import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { decimateGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Decimate: the collapse ported from bmesh/tools/bmesh_decimate_collapse.cc
 * living in cpp/src/fe_modifiers.cpp as fe_mod_decimate_collapse().
 *
 * The assertions below are the properties the port is supposed to guarantee,
 * not a snapshot of whatever it happened to produce:
 *   - the requested ratio is reached, and never over-shot;
 *   - the result is still a closed two-manifold, because the link condition
 *     and the degenerate-flip test refuse the collapses that would tear or
 *     fold it;
 *   - the surface stays on the sphere it came from (quadric error is doing
 *     its job) instead of drifting into the middle;
 *   - a boundary stays a boundary when preserve_boundary is on.
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

/* An icosphere: a closed, seam-free sphere. THREE.SphereGeometry is not one -
   its UV seam and poles carry duplicate vertices, so its index mesh has 124
   open edges before any modifier touches it, which makes it useless as a
   tearing test. */
function icosphere(subdivisions = 3, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ].map(v => new THREE.Vector3(...v).normalize());
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];
  for (let level = 0; level < subdivisions; level++) {
    const midpoints = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (midpoints.has(key)) return midpoints.get(key);
      const v = verts[a].clone().add(verts[b]).normalize();
      verts.push(v);
      const index = verts.length - 1;
      midpoints.set(key, index);
      return index;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => { positions[i * 3] = v.x * radius; positions[i * 3 + 1] = v.y * radius; positions[i * 3 + 2] = v.z * radius; });
  const indices = faces.flat();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/* A grid of n x n quads in the XZ plane, triangulated: an open surface with a
   boundary all the way round it. */
function grid(size = 12, extent = 1) {
  const positions = [];
  const indices = [];
  for (let z = 0; z <= size; z++) {
    for (let x = 0; x <= size; x++) {
      positions.push(-extent + (2 * extent * x) / size, 0, -extent + (2 * extent * z) / size);
    }
  }
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const a = z * (size + 1) + x;
      const b = a + 1;
      const c = a + size + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
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

/* Each undirected edge and how many triangles use it. */
function edgeUse(geometry) {
  const index = geometry.getIndex();
  const idx = index ? index.array : null;
  assert.ok(idx, 'the kernel returns indexed geometry');
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

function area(geometry) {
  const p = geometry.attributes.position;
  const index = geometry.getIndex();
  const idx = index ? index.array : [...Array(p.count).keys()];
  let total = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, idx[i]);
    const b = new THREE.Vector3().fromBufferAttribute(p, idx[i + 1]);
    const c = new THREE.Vector3().fromBufferAttribute(p, idx[i + 2]);
    total += b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
  }
  return total;
}

test('the collapse kernel reaches the requested ratio on a sphere', () => {
  withCore(() => {
    const source = icosphere(3);
    const before = triangleCount(source);
    const result = decimateGeometry(source, 0.35);
    const after = triangleCount(result);
    assert.ok(after > 0, 'decimation produced triangles');
    assert.ok(after <= Math.floor(before * 0.35) + 2, `expected about ${Math.floor(before * 0.35)}, got ${after}`);
    assert.ok(after < before / 2, `expected a real reduction, got ${after} of ${before}`);
  });
});

test('the collapsed sphere is still closed: no torn edge, no folded face', () => {
  withCore(() => {
    const result = decimateGeometry(icosphere(3), 0.3);
    const uses = edgeUse(result);
    let boundary = 0;
    let nonManifold = 0;
    for (const count of uses.values()) {
      if (count === 1) boundary++;
      if (count > 2) nonManifold++;
    }
    /* The input was a closed sphere, so a collapse that respects the link
       condition leaves no boundary behind. */
    assert.equal(boundary, 0, `${boundary} edges were left open`);
    assert.equal(nonManifold, 0, `${nonManifold} edges are used more than twice`);

    const index = result.getIndex().array;
    for (let i = 0; i < index.length; i += 3) {
      assert.ok(index[i] !== index[i + 1] && index[i + 1] !== index[i + 2] && index[i + 2] !== index[i],
        'a degenerate triangle survived');
    }
  });
});

test('collapsed vertices stay on the surface, not in its middle', () => {
  withCore(() => {
    const radius = 2;
    const result = decimateGeometry(icosphere(3, radius), 0.25);
    const p = result.attributes.position;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    /* The quadric optimum for a sphere is on the sphere; allowing 8 % covers
       the flattest patches at the poles, where any collapse has to choose. */
    assert.ok(min > radius * 0.92, `a vertex sank to ${min.toFixed(3)} of ${radius}`);
    assert.ok(max < radius * 1.02, `a vertex ballooned to ${max.toFixed(3)} of ${radius}`);
    /* And the surface is not lost: the area stays within a few percent. */
    const before = area(icosphere(3, radius));
    const after = area(result);
    assert.ok(after > before * 0.9 && after < before * 1.1, `area ${before.toFixed(3)} -> ${after.toFixed(3)}`);
  });
});

test('preserve boundary keeps the rim of an open surface', () => {
  withCore(() => {
    const source = grid(12, 1);
    const result = decimateGeometry(source, 0.3, 65000, { preserveBoundary: true });
    assert.ok(triangleCount(result) < triangleCount(source) * 0.5);

    const p = result.attributes.position;
    let nearRim = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      if (Math.abs(Math.abs(x) - 1) < 1e-4 || Math.abs(Math.abs(z) - 1) < 1e-4) nearRim++;
    }
    /* Four corners plus points distributed along four sides: the boundary
       plane pulls rim vertices back onto the rim line instead of shrinking
       the grid inward. */
    assert.ok(nearRim >= 8, `only ${nearRim} vertices survived on the boundary`);

    const uses = edgeUse(result);
    let boundary = 0;
    for (const count of uses.values()) if (count === 1) boundary++;
    assert.ok(boundary > 0, 'an open surface must keep an open rim');
  });
});

test('a ratio of 1 returns the mesh untouched and a tiny ratio still resolves', () => {
  withCore(() => {
    const source = icosphere(2);
    const same = decimateGeometry(source, 1);
    assert.equal(triangleCount(same), triangleCount(source));

    const tiny = decimateGeometry(icosphere(2), 0.02);
    assert.ok(triangleCount(tiny) >= 1);
    assert.ok(triangleCount(tiny) < triangleCount(source) * 0.2);
    const uses = edgeUse(tiny);
    for (const count of uses.values()) assert.ok(count <= 2, 'the collapse tore the mesh');
  });
});
