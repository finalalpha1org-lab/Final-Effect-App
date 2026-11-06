import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* `fe-poly.js` recovers the polygon faces behind a triangle mesh: the wireframe,
   See through, the selection outline and the exports read faces from here
   instead of guessing from the triangulation. These tests hold the rules the
   module documents: quads come back as quads, a fold is not a quad, non-indexed
   geometry is welded first, and nothing is triangulated. */

const source = readFileSync('fe-poly.js', 'utf8');

function loadPoly() {
  const window = { THREE };
  window.window = window;
  const ctx = vm.createContext({ window, THREE, Map, Set, Math, Number, Int32Array, Float32Array, Uint8Array, Object, Array });
  vm.runInContext(source, ctx);
  return window.FEPoly;
}

/* A cube with eight shared corners, indexed - what the editor's own meshes are.
   (THREE's BoxGeometry gives every side its own four corners so each face can
   have its own normal and UVs; the face recovery then still finds the six quads
   but sees each of the twelve edges twice, once per side.) */
function weldedCube() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, 0.5, -0.5,  -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5,   0.5, -0.5, 0.5,   0.5, 0.5, 0.5,   -0.5, 0.5, 0.5
  ], 3));
  geometry.setIndex([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7
  ]);
  return geometry;
}

test('a cube is six quads and twelve edges', () => {
  const FEPoly = loadPoly();
  const stats = FEPoly.stats(weldedCube());
  assert.deepEqual(
    { faces: stats.faces, quads: stats.quads, triangles: stats.triangles, ngons: stats.ngons,
      edges: stats.edges, vertices: stats.vertices, drawn: stats.sourceTriangles },
    { faces: 6, quads: 6, triangles: 0, ngons: 0, edges: 12, vertices: 8, drawn: 12 },
    'the six sides of a cube are six faces, twelve edges, twelve triangles drawn'
  );
});

test('the wireframe is the faces’ own edges, so no face has a diagonal', () => {
  const FEPoly = loadPoly();
  const geometry = weldedCube();
  const wire = FEPoly.buildWireGeometry(geometry);
  assert.ok(wire, 'the wireframe geometry must be built');
  assert.equal(wire.attributes.position.count, 24, 'twelve edges, two ends each');
  assert.equal(wire.userData.fePolyEdges, true, 'and it is marked as a polygon wireframe');

  /* Every segment of a cube's wireframe is one of its twelve edges: an edge of
     length 1 along one axis, never the face diagonal of length √2. */
  const p = wire.attributes.position.array;
  for (let i = 0; i < wire.attributes.position.count; i += 2) {
    const dx = p[i * 3] - p[(i + 1) * 3];
    const dy = p[i * 3 + 1] - p[(i + 1) * 3 + 1];
    const dz = p[i * 3 + 2] - p[(i + 1) * 3 + 2];
    const length = Math.hypot(dx, dy, dz);
    assert.ok(Math.abs(length - 1) < 1e-5, `a wireframe segment of length ${length.toFixed(3)} is a diagonal`);
    const axes = [dx, dy, dz].filter((value) => Math.abs(value) > 1e-5).length;
    assert.equal(axes, 1, 'a cube edge runs along one axis only');
  }
});

test('a box from THREE keeps six faces but repeats each edge once per side', () => {
  const FEPoly = loadPoly();
  /* BoxGeometry carries twenty-four corners for eight positions so every side
     can have its own normal and UVs. The faces still pair into six quads; the
     edge table simply lists a side's four edges per side. Nothing draws a
     diagonal, which is the property the wireframe depends on. */
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const stats = FEPoly.stats(geometry);
  assert.equal(stats.faces, 6);
  assert.equal(stats.quads, 6);
  assert.equal(stats.triangles, 0, 'still no triangle faces');
  assert.equal(stats.edges, 24, 'twelve edges, each listed by both of the sides that own it');
  /* Nothing here is a diagonal: every side is a quad, so its four sides are the
     four cube edges. */
  for (const face of FEPoly.facesInSlots(geometry)) assert.equal(face.length, 4);
  const positions = geometry.attributes.position.array;
  for (const face of FEPoly.facesInSlots(geometry)) {
    for (let i = 0; i < 4; i++) {
      const a = face[i] * 3, b = face[(i + 1) % 4] * 3;
      const length = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
      assert.ok(Math.abs(length - 1) < 1e-5, `a face side of ${length.toFixed(3)} is a diagonal`);
    }
  }
});

test('a fold is not a quad: two triangles that do not face the same way stay two faces', () => {
  const FEPoly = loadPoly();
  const geometry = new THREE.BufferGeometry();
  /* Two triangles sharing the edge v0-v1, the second one standing up at a right
     angle: the shared edge is a crease of the model, not a diagonal. */
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,   1, 0, 0,   0.5, 1, 0,
    0, 0, 0,   1, 0, 0,   0.5, 0.2, 1
  ], 3));
  const faces = FEPoly.facesInSlots(geometry);
  assert.equal(faces.length, 2, 'a folded pair is two faces');
  for (const face of faces) assert.equal(face.length, 3, 'and neither one grew into a quad');
});

test('two coplanar triangles sharing their longest edge are one quad', () => {
  const FEPoly = loadPoly();
  const geometry = new THREE.BufferGeometry();
  /* A square of side 1 split along its diagonal (length √2): the two halves are
     one face, and the diagonal is not an edge of it. */
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,   1, 0, 0,   1, 1, 0,
    0, 0, 0,   1, 1, 0,   0, 1, 0
  ], 3));
  const stats = FEPoly.stats(geometry);
  assert.equal(stats.faces, 1);
  assert.equal(stats.quads, 1);
  assert.equal(stats.edges, 4, 'four sides, no diagonal');
  const wire = FEPoly.buildWireGeometry(geometry);
  const p = wire.attributes.position.array;
  for (let i = 0; i < wire.attributes.position.count; i += 2) {
    const length = Math.hypot(p[i * 3] - p[(i + 1) * 3], p[i * 3 + 1] - p[(i + 1) * 3 + 1], p[i * 3 + 2] - p[(i + 1) * 3 + 2]);
    assert.ok(length < 1.2, `a wireframe segment of ${length.toFixed(3)} is the diagonal`);
  }
});

test('a quad on a curved surface is one face, however far it is bent', () => {
  const FEPoly = loadPoly();
  const geometry = new THREE.BufferGeometry();
  /* A square of side 1 split along its diagonal, whose fourth corner is lifted
     so the two halves fold by about twenty degrees. A cylinder's side, a torus,
     a knot: this is what every quad of a curved surface looks like. It is not
     coplanar - the flat test alone would call it two triangles and draw the
     diagonal - but the shared edge is still the longest side of both halves, so
     it is the quad it was drawn as. */
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,   1, 0, 0,   1, 1, 0,
    0, 0, 0,   1, 1, 0,   0, 1, 0.36
  ], 3));
  const stats = FEPoly.stats(geometry);
  assert.equal(stats.faces, 1, 'one face, not two');
  assert.equal(stats.quads, 1);
  assert.equal(stats.triangles, 0, 'and no triangle came out of it');
  assert.equal(stats.edges, 4, 'four sides: the diagonal is not an edge of the model');
});

test('a row of cells pairs across its own diagonals and nothing else', () => {
  const FEPoly = loadPoly();
  /* Sixteen cells around a circle: every cell is a warped quad (a fold of 22.5
     degrees between the halves), and the edge each cell shares with its
     neighbour is shorter than the diagonal inside it. Taking the longest shared
     edge first is what keeps the pairing inside the cells; taking the shortest
     first fuses neighbours into strips and leaves triangles behind. */
  const side = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
  const stats = FEPoly.stats(side);
  assert.equal(stats.faces, 16, 'sixteen cells');
  assert.equal(stats.quads, 16, 'every one of them a quad');
  assert.equal(stats.triangles, 0, 'no cell was torn into triangles');
  assert.equal(stats.edges, 49, 'sixteen verticals above, sixteen below, sixteen shared, one seam');

  const grid = FEPoly.stats(new THREE.PlaneGeometry(2, 2, 4, 4));
  assert.equal(grid.faces, 16, 'a four by four grid is sixteen cells');
  assert.equal(grid.quads, 16);
  assert.equal(grid.edges, 40, 'five rows and five columns of five vertices');
});

test('a real crease is still not a quad, and a saddle is not one either', () => {
  const FEPoly = loadPoly();
  const make = (lift) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,   1, 0, 0,   1, 1, 0,
      0, 0, 0,   1, 1, 0,   0, 1, lift
    ], 3));
    return FEPoly.stats(geometry);
  };
  /* The same warped quad at three angles, measured: 27, 55 and 58 degrees of
     fold between the halves. The first two are one face. The third is two, for
     two reasons - the fold is closing on the sixty degrees the edit kernel
     draws the line at (quadCreaseWithin), and the four corners have stopped
     enclosing a convex quad, which no amount of tolerance can fix. Both rules
     are deliberate: past this the shape is a saddle, not a bent face. */
  assert.equal(make(0.36).faces, 1, 'a 27 degree warp is one face');
  assert.equal(make(1.0).faces, 1, 'a 55 degree warp is still one face');
  assert.equal(make(1.15).faces, 2, 'a 58 degree saddle is two');
  assert.equal(make(2.5).faces, 2, 'and a right angle plus is a fold');
});

test('non-indexed geometry is welded by position before faces are paired', () => {
  const FEPoly = loadPoly();
  const indexed = new THREE.BoxGeometry(1, 1, 1);
  const flat = indexed.toNonIndexed();
  assert.equal(flat.index, null, 'this is the case a loader hands over');
  const stats = FEPoly.stats(flat);
  assert.equal(stats.faces, 6, 'a triangle soup of a cube is still six faces');
  assert.equal(stats.vertices, 8, 'its thirty-six corners are eight vertices');
  assert.equal(FEPoly.facesInSlots(flat).every((face) => face.length === 4), true, 'and every face is a quad');
});

test('the face list is cached on the geometry and rebuilt when the buffer changes', () => {
  const FEPoly = loadPoly();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const first = FEPoly.faceList(geometry);
  assert.ok(first);
  assert.equal(FEPoly.faceList(geometry), first, 'the same geometry is measured once');
  assert.equal(geometry.userData.fePoly, first, 'and remembered on the geometry');

  FEPoly.invalidate(geometry);
  const second = FEPoly.faceList(geometry);
  assert.ok(second);
  assert.notEqual(second, first, 'a rewritten buffer gets a fresh face list');
});

test('an empty or missing geometry is refused instead of guessed at', () => {
  const FEPoly = loadPoly();
  assert.equal(FEPoly.faceList(null), null);
  assert.equal(FEPoly.faceList(new THREE.BufferGeometry()), null);
  const empty = new THREE.BufferGeometry();
  empty.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  assert.equal(FEPoly.stats(empty), null);
});
