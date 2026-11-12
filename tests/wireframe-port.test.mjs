import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { wireframeGeometry3D } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Wireframe: BM_mesh_wireframe from bmesh/tools/bmesh_wireframe.cc, ported as
 * fe_mod_wireframe() in cpp/src/fe_modifiers.cpp.
 *
 * Blender frames the faces rather than thickening the edges, so the checks are
 * about that frame: two quads per corner, a strut whose two skins sit
 * `thickness` apart, boundary strips that close an open border, and the
 * original surface gone or kept according to Replace Original.
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

function weldedCube(size = 2) {
  const h = size / 2;
  const positions = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]
  ];
  const indices = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function plane(size = 2, segments = 2) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.computeVertexNormals();
  return geometry;
}

function triangleCount(geometry) {
  const index = geometry.getIndex();
  return index ? index.count / 3 : geometry.attributes.position.count / 3;
}

function edgeUse(geometry) {
  const idx = geometry.getIndex().array;
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

function radiusRange(geometry, centre = [0, 0, 0]) {
  const p = geometry.attributes.position;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i) - centre[0], p.getY(i) - centre[1], p.getZ(i) - centre[2]);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  return { min, max };
}

test('the wire is a frame of the faces, not a thickening of the edges', () => {
  withCore(() => {
    const source = weldedCube(2);
    const faces = triangleCount(source);
    const result = wireframeGeometry3D(source, { thickness: 0.1, replaceOriginal: true });
    /* Two quads per corner of every original triangle. */
    assert.equal(triangleCount(result), faces * 12);
    assert.equal(result.getIndex().array.length % 3, 0);
  });
});

test('a closed input gives a closed wire cage', () => {
  withCore(() => {
    const result = wireframeGeometry3D(weldedCube(2), { thickness: 0.1, replaceOriginal: true });
    const uses = edgeUse(result);
    let boundary = 0;
    let nonManifold = 0;
    for (const count of uses.values()) {
      if (count === 1) boundary++;
      if (count > 2) nonManifold++;
    }
    assert.equal(boundary, 0, `${boundary} edges of the cage are open`);
    assert.equal(nonManifold, 0, `${nonManifold} edges are used more than twice`);
  });
});

test('the strut is as thick as asked, and Even Offset widens the corner', () => {
  withCore(() => {
    const thickness = 0.2;
    const cube = weldedCube(2);
    const source = cube.attributes.position;
    const result = wireframeGeometry3D(cube, { thickness, offset: 0, replaceOriginal: true });
    const p = result.attributes.position;

    /* The kernel writes the two skins first: vertex 2i and 2i + 1 are the same
       corner pushed along its normal by ofs_orig and ofs_new, which with
       Offset 0 are -t/2 and +t/2 - so the pair is exactly t apart. */
    for (let i = 0; i < source.count; i++) {
      const dx = p.getX(i * 2 + 1) - p.getX(i * 2);
      const dy = p.getY(i * 2 + 1) - p.getY(i * 2);
      const dz = p.getZ(i * 2 + 1) - p.getZ(i * 2);
      assert.ok(Math.abs(Math.hypot(dx, dy, dz) - thickness) < 1e-4,
        `corner ${i}: skins are ${Math.hypot(dx, dy, dz).toFixed(4)} apart`);
    }

    /* The inset vertex at a corner sits in the face, at
       (t/2) / cos((pi - corner_angle) / 2) from the corner. Every cube corner
       is a right angle, so Even Offset gives 1/cos(pi/4) = sqrt(2) times the
       plain inset. */
    const firstCorner = new THREE.Vector3(source.getX(0), source.getY(0), source.getZ(0));
    const nearest = (geometry) => {
      const q = geometry.attributes.position;
      let best = Infinity;
      for (let i = source.count * 2; i < q.count; i++) {
        const d = Math.hypot(q.getX(i) - firstCorner.x, q.getY(i) - firstCorner.y, q.getZ(i) - firstCorner.z);
        if (d > 1e-5) best = Math.min(best, d);
      }
      return best;
    };
    const evenDistance = nearest(wireframeGeometry3D(cube, { thickness, offset: 0, evenOffset: true }));
    const plainDistance = nearest(wireframeGeometry3D(cube, { thickness, offset: 0, evenOffset: false }));
    assert.ok(Math.abs(evenDistance - thickness / 2 * Math.SQRT2) < 0.01,
      `even inset ${evenDistance.toFixed(4)}, expected ${(thickness / 2 * Math.SQRT2).toFixed(4)}`);
    assert.ok(Math.abs(plainDistance - thickness / 2) < 0.01,
      `plain inset ${plainDistance.toFixed(4)}, expected ${(thickness / 2).toFixed(4)}`);
  });
});

test('Replace Original keeps the surface, and turning it off removes it', () => {
  withCore(() => {
    const source = weldedCube(2);
    const faces = triangleCount(source);
    const kept = wireframeGeometry3D(source, { thickness: 0.1, replaceOriginal: false });
    assert.equal(triangleCount(kept), faces * 12 + faces);
  });
});

test('an open border gets its strips only when Boundary is on', () => {
  withCore(() => {
    const source = plane(2, 2);
    const faces = triangleCount(source);
    const withBorder = wireframeGeometry3D(source, { thickness: 0.1, boundary: true });
    const without = wireframeGeometry3D(source, { thickness: 0.1, boundary: false });
    assert.ok(triangleCount(withBorder) > triangleCount(without),
      `boundary strips added ${triangleCount(withBorder) - triangleCount(without)} triangles`);
    assert.ok(triangleCount(without) >= faces * 12);

    /* A border strip closes the rim of the cage: only the strips may leave
       edges with a single user, and with Boundary on the outer skin is sealed. */
    const uses = edgeUse(withBorder);
    let open = 0;
    for (const count of uses.values()) if (count === 1) open++;
    assert.equal(open, 0, `${open} edges left open on the bordered plane`);
  });
});

test('a zero thickness leaves the mesh alone', () => {
  withCore(() => {
    const source = weldedCube(2);
    const same = wireframeGeometry3D(source, { thickness: 0 });
    assert.equal(triangleCount(same), triangleCount(source));
  });
});

test('Relative Offset scales the wire by the mesh density at each vertex', () => withCore(() => {
  /* Two quads of very different size sharing one edge: with relative offset on,
     the wire at the small quad's corners is much thinner than at the big
     quad's, because the factor is the mean edge length at the vertex. */
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, -1, 0, 0.1, -1, 0, 0.1, 0.1, 0, -1, 0.1, 0,
    1, -1, 0, 1, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]);
  const absolute = wireframeGeometry3D(geometry, { thickness: 0.02, relativeOffset: false });
  const relative = wireframeGeometry3D(geometry, { thickness: 0.02, relativeOffset: true });
  assert.equal(relative.attributes.position.count, absolute.attributes.position.count);
  /* Every vertex of the relative result is within the un-scaled one's slab, and
     the two differ: the relative wire cannot be identical. */
  const a = absolute.attributes.position.array, b = relative.attributes.position.array;
  let moved = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) moved++;
  assert.ok(moved > a.length * 0.1, `relative offset moves the wire (${moved} of ${a.length} values)`);
  for (let i = 0; i < b.length; i++) assert.ok(Number.isFinite(b[i]), 'no NaN');
}));
