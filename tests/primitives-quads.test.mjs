import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';

/* The Add 3D Element sheet used to spawn triangles: a cube arrived as twelve
   triangles, a grid as a hundred and twenty eight, and Edit Mode then showed
   the diagonal of every face as if it were an edge of the model. A cube's faces
   are quads, and an editor is expected to say so.

   `PRIMITIVE_MESHES` in index.html is the single table the sheet is built from.
   This file takes that table out of the page, builds every mesh in it, and runs
   each one through both face models the app actually draws with:

     - the edit kernel (`wasm/fe_core_engine.wasm`), which draws the Edit Mode
       cage - one face per pair of triangles that are the two halves of a quad;
     - `fe-poly.js`, which draws the Object Mode wireframe and the selection
       outline from the same mesh.

   The counts below are pinned because they are the shipped topology: "more
   quads than before" is not a test, and a primitive whose face count changes
   should change a number here deliberately. */

const html = readFileSync('index.html', 'utf8');
const wasmBytes = readFileSync('wasm/fe_core_engine.wasm');

/* ---- taking the definitions out of the page ----------------------------- */

/* index.html is one long script: there is no module to import, so the source of
   a definition is cut out by matching brackets and evaluated in a context that
   holds THREE and nothing else. If either definition is renamed or moved, this
   throws - which is the point: the table is documented as the one place a
   primitive is described. */
function sourceOf(source, opener) {
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, `index.html no longer contains ${opener}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${opener} is not closed`);
}

function loadPrimitives() {
  const context = vm.createContext({ THREE, Math, Number, Object, Array, JSON, console });
  const table = sourceOf(html, 'const PRIMITIVE_MESHES =');
  const quadSphere = sourceOf(html, 'function createQuadSphereGeometry(');
  vm.runInContext(`${quadSphere}\n${table}\nglobalThis.PRIMITIVE_MESHES = PRIMITIVE_MESHES;`, context);
  return context.PRIMITIVE_MESHES;
}

const PRIMITIVES = loadPrimitives();
const KERNEL = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}).exports;

/* ---- measuring one mesh the way each renderer measures it --------------- */

/* Uploads to the edit kernel the way the bridge does (positions and triangle
   indices, no normals) and reads back the cage it would draw: the lone
   triangles plus the quads it paired. The kernel welds coincident vertices on
   upload, so its triangle count can be lower than the index count - a cone's
   side arrives from three as a wedge with a zero-length top edge, and those
   triangles have no area and are dropped. The kernel's own count is what the
   accounting below uses. */
function kernelFaces(geometry) {
  const position = geometry.attributes.position;
  const index = geometry.index ? geometry.index.array : null;
  const vertexCount = position.count;
  const triangles = new Uint32Array(index ? index.length : vertexCount);
  if (index) triangles.set(index);
  else for (let i = 0; i < vertexCount; i++) triangles[i] = i;
  const triCount = triangles.length / 3;

  const positionPtr = KERNEL.fe_malloc(vertexCount * 3 * 4);
  const triPtr = KERNEL.fe_malloc(triCount * 3 * 4);
  /* Views are made after every allocation: the wasm memory can grow and detach
     an older view. */
  new Float32Array(KERNEL.memory.buffer, positionPtr, vertexCount * 3)
    .set(position.array.subarray(0, vertexCount * 3));
  new Uint32Array(KERNEL.memory.buffer, triPtr, triCount * 3).set(triangles);
  KERNEL.fe_edit_upload(vertexCount, positionPtr, triCount, triPtr, 0);

  const quads = KERNEL.fe_edit_quad_pair_count();
  const uploaded = KERNEL.fe_edit_tri_count();
  const tris = uploaded - quads * 2;
  KERNEL.fe_free(positionPtr);
  KERNEL.fe_free(triPtr);
  return { quads, tris, uploaded, faces: quads + tris };
}

function loadPoly() {
  const window = { THREE };
  window.window = window;
  const context = vm.createContext({
    window, THREE, Map, Set, Math, Number, Object, Array,
    Int32Array, Float32Array, Uint8Array
  });
  vm.runInContext(readFileSync('fe-poly.js', 'utf8'), context);
  return window.FEPoly;
}

const FEPoly = loadPoly();
const polyStats = (geometry) => FEPoly.stats(geometry);

function loadIcons() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, Object, Array, Math, Number, String, RegExp, Map, Set });
  vm.runInContext(readFileSync('fe-icons.js', 'utf8'), context);
  return window.FEIcons;
}

/* ---- the shipped set ---------------------------------------------------- */

test('the primitive table is the sheet: ten meshes, one entry each', () => {
  assert.deepEqual(Object.keys(PRIMITIVES), [
    'cube', 'sphere', 'cylinder', 'cone', 'torus',
    'plane', 'grid', 'ring', 'quadsphere', 'knot'
  ], 'the sheet offers these ten meshes, in this order');
  const labels = Object.values(PRIMITIVES).map((spec) => spec.label);
  assert.equal(new Set(labels).size, labels.length, 'every mesh has its own name');
  for (const spec of Object.values(PRIMITIVES)) {
    assert.equal(typeof spec.build, 'function', `${spec.label} builds itself`);
    assert.equal(typeof spec.lift, 'number', `${spec.label} knows how far to lift`);
    assert.ok(spec.build() instanceof THREE.BufferGeometry, `${spec.label} builds a geometry`);
  }
});

test('every mesh in the table has a button on the Add sheet, and every button an icon', () => {
  const body = html.slice(html.indexOf('id="add-3d-body"'));
  const sheet = body.slice(0, body.indexOf('</div>'));
  const buttons = [...sheet.matchAll(/add-3d-card-btn[\s\S]*?(?:data-ico|onclick)="([^"]+)"/g)];
  const icons = [...sheet.matchAll(/data-ico="([^"]+)"/g)].map((m) => m[1]);
  const spawns = [...sheet.matchAll(/addNewObjectAtCursor\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(buttons.length, 12, 'ten meshes, the camera and the light');
  assert.equal(icons.length, 12, 'every card has an icon');
  const names = loadIcons().names;
  for (const name of icons) assert.ok(names.includes(name), `fe-icons.js has no "${name}"`);
  /* The mesh cards and the table are the same list, so the sheet cannot offer a
     mesh nothing builds, or hide one it does. */
  assert.deepEqual(spawns.slice(0, 10), Object.keys(PRIMITIVES), 'the first ten cards are the table');
  assert.deepEqual(spawns.slice(10), ['camera', 'light'], 'then the camera and the light');
  for (const label of Object.values(PRIMITIVES).map((spec) => spec.label)) {
    assert.ok(sheet.includes(text(label)), `the sheet does not offer ${label}`);
  }
});

function text(label) {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---- the counts ---------------------------------------------------------- */

/* quads: the faces that are four corners; tris: the faces that are still
   triangles; faces: what a user can click in Edit Mode. Zero triangles is the
   point of the exercise - six of these ten meshes have none, and the four that
   do are the ones a fan is: a UV sphere's two pole rows (Blender's UV sphere
   has the same triangle rows), a cone's apex, and the caps of the cylinder and
   the cone, which three authors as a triangle fan around the middle of the cap.

   The kernel welds those fan triangles into pairs it calls quads - a pie slice
   is convex and its shared radial edge is the longest side of both halves, so
   it passes the same test a real quad passes. Blender would draw each cap as a
   single n-gon face instead; the kernel pairs triangles only, so a 32 sided cap
   comes out as twelve pie quads and eight triangle slivers. That is the one
   place the two models do not agree (see the last test). It is pinned here
   rather than hidden: making the cap one face needs n-gon faces in the kernel,
   not a looser test. */
const SHIPPED = {
  cube:       { kernel: { quads: 6,    tris: 0  }, poly: { quads: 6,    tris: 0   } },
  sphere:     { kernel: { quads: 988,  tris: 8  }, poly: { quads: 960,  tris: 64  } },
  cylinder:   { kernel: { quads: 56,   tris: 16 }, poly: { quads: 32,   tris: 64  } },
  cone:       { kernel: { quads: 31,   tris: 2  }, poly: { quads: 0,    tris: 96  } },
  torus:      { kernel: { quads: 512,  tris: 0  }, poly: { quads: 512,  tris: 0   } },
  plane:      { kernel: { quads: 1,    tris: 0  }, poly: { quads: 1,    tris: 0   } },
  grid:       { kernel: { quads: 64,   tris: 0  }, poly: { quads: 64,   tris: 0   } },
  ring:       { kernel: { quads: 48,   tris: 0  }, poly: { quads: 48,   tris: 0   } },
  quadsphere: { kernel: { quads: 864,  tris: 0  }, poly: { quads: 864,  tris: 0   } },
  knot:       { kernel: { quads: 1152, tris: 0  }, poly: { quads: 1152, tris: 0   } }
};

for (const [type, expected] of Object.entries(SHIPPED)) {
  test(`the edit kernel draws ${type} with ${expected.kernel.quads} quads and ${expected.kernel.tris} triangles`, () => {
    const geometry = PRIMITIVES[type].build();
    const { quads, tris, uploaded, faces } = kernelFaces(geometry);
    assert.equal(quads, expected.kernel.quads, `${type}: quad count`);
    assert.equal(tris, expected.kernel.tris, `${type}: lone triangle count`);
    assert.equal(faces, quads + tris);
    assert.equal(quads * 2 + tris, uploaded, `${type}: every uploaded triangle is a face`);
  });

  test(`fe-poly draws ${type} with ${expected.poly.quads} quads and ${expected.poly.tris} triangles`, () => {
    const stats = polyStats(PRIMITIVES[type].build());
    assert.equal(stats.quads, expected.poly.quads, `${type}: quad count`);
    assert.equal(stats.triangles, expected.poly.tris, `${type}: triangle count`);
    assert.equal(stats.ngons, 0, `${type}: nothing grew into an n-gon`);
    assert.equal(stats.faces, stats.quads + stats.triangles + stats.ngons);
  });
}

test('the cube is six quads and no triangles, in both models', () => {
  /* The reason this file exists: the cube the sheet adds used to answer Edit
     Mode with twelve triangles. */
  const cube = PRIMITIVES.cube.build();
  assert.equal(kernelFaces(cube).tris, 0, 'the kernel leaves no triangle in a cube');
  const stats = polyStats(cube);
  assert.equal(stats.faces, 6, 'six faces');
  assert.equal(stats.quads, 6);
  assert.equal(FEPoly.facesInSlots(cube).every((face) => face.length === 4), true, 'every face is four corners');
});

test('the quad-built meshes answer the same faces in both models', () => {
  /* Seven of the ten are made of quads end to end. For those the Object Mode
     wireframe and the Edit Mode cage are the same list of faces, which is what
     stops the wireframe growing a diagonal the moment a mesh is edited. */
  for (const type of ['cube', 'torus', 'plane', 'grid', 'ring', 'quadsphere', 'knot']) {
    const geometry = PRIMITIVES[type].build();
    const kernel = kernelFaces(geometry);
    const poly = polyStats(geometry);
    assert.equal(poly.quads, kernel.quads, `${type}: quad count`);
    assert.equal(poly.triangles, kernel.tris, `${type}: triangle count`);
  }
});

test('no quad face has its diagonal drawn as a wireframe segment', () => {
  /* A quad means four segments, not five. Read from the face list rather than
     from a count, so it holds for the curved meshes too: the diagonal of each
     face is the edge the two halves of that face share, and that edge must not
     be in the wireframe. */
  for (const [type, spec] of Object.entries(PRIMITIVES)) {
    const geometry = spec.build();
    const poly = FEPoly.faceList(geometry);
    const wire = FEPoly.buildWireGeometry(geometry);
    assert.ok(wire, `${type}: a wireframe was built`);
    const drawn = new Set();
    const p = wire.attributes.position.array;
    for (let i = 0; i < wire.attributes.position.count; i += 2) {
      const a = p[i * 3] + ',' + p[i * 3 + 1] + ',' + p[i * 3 + 2];
      const b = p[(i + 1) * 3] + ',' + p[(i + 1) * 3 + 1] + ',' + p[(i + 1) * 3 + 2];
      drawn.add(a < b ? a + '|' + b : b + '|' + a);
    }
    const position = geometry.attributes.position;
    const pointKey = (id) => {
      const slot = poly.rep ? poly.rep[id] : id;
      return position.array[slot * 3] + ',' + position.array[slot * 3 + 1] + ',' + position.array[slot * 3 + 2];
    };
    let quadsSeen = 0;
    for (let f = 0; f < poly.faces.length; f++) {
      if (poly.faceTris[f].length !== 2) continue;
      /* A quad face is read as its four corners a, c, b, d; the two diagonals of
         that reading are a-b and c-d, and neither is an edge of the model. */
      const face = poly.faces[f];
      quadsSeen++;
      for (const [i, j] of [[0, 2], [1, 3]]) {
        const a = pointKey(face[i]), b = pointKey(face[j]);
        assert.equal(drawn.has(a < b ? a + '|' + b : b + '|' + a), false,
          `${type}: a diagonal of a face is drawn as an edge`);
      }
    }
    const quadFaces = poly.faces.filter((face) => face.length === 4).length;
    assert.equal(quadsSeen, quadFaces, `${type}: every quad face was checked`);
    if (type !== 'cone') assert.ok(quadsSeen > 0, `${type}: there are quad faces to check`);
  }
});

test('the quad sphere is quads all the way to its corners', () => {
  /* A UV sphere pinches into triangles at its poles; this one is a subdivided
     cube pushed out to a radius, so the poles are simply not there. */
  const geometry = PRIMITIVES.quadsphere.build();
  const stats = polyStats(geometry);
  assert.equal(stats.triangles, 0, 'not one triangle');
  assert.equal(stats.faces, 6 * 12 * 12, 'six faces of twelve by twelve');
  assert.equal(kernelFaces(geometry).tris, 0, 'and the kernel agrees');
  /* Every vertex sits on the radius, which is what makes the cells even. */
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
    assert.ok(Math.abs(radius - 0.85) < 1e-4, `vertex ${i} is off the sphere at ${radius}`);
  }
});

test('a mesh added twice is named from the table, and nothing is built outside it', () => {
  /* The spawn path names a duplicate after the spec label; this reads the lines
     out of the page rather than running a spawn, which needs the live scene. */
  const spawn = sourceOf(html, 'function addNewObjectAtCursor(');
  assert.ok(spawn.includes('PRIMITIVE_MESHES[type]'), 'the spawn path is table driven, not a chain of ifs');
  assert.ok(spawn.includes('spec.label'), 'and a duplicate is named after the table');
  assert.equal(/new THREE\.(Box|Sphere|Cylinder|Cone|Torus|Plane|Ring|TorusKnot)Geometry/.test(spawn), false,
    'no primitive is built outside the table');
});
