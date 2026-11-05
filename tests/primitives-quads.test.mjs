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
  const context = vm.createContext({ THREE, Math, Number, Object, Array, JSON, console, Set, Map });
  /* The three helpers the table builds its faces with, then the table itself.
     The ring helpers need a geometry, so they are extracted rather than
     rewritten here - a copy would be a second definition of the same face. */
  const parts = [
    sourceOf(html, 'function feRingAroundY('),
    sourceOf(html, 'function feFanRingsAroundY('),
    sourceOf(html, 'function withFaces('),
    sourceOf(html, 'function createQuadSphereGeometry('),
    sourceOf(html, 'const PRIMITIVE_MESHES ='),
    'globalThis.PRIMITIVE_MESHES = PRIMITIVE_MESHES;'
  ];
  vm.runInContext(parts.join('\n'), context);
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

  /* The faces the mesh was built with, when it has them: the kernel claims
     them before it looks at the shape (fe_edit_set_faces). */
  const declared = declaredFaceArrays(geometry, vertexCount);
  let taken = 0;
  if (declared) {
    const startsPtr = KERNEL.fe_malloc(declared.starts.length * 4);
    const cornersPtr = KERNEL.fe_malloc(declared.corners.length * 4);
    new Uint32Array(KERNEL.memory.buffer, startsPtr, declared.starts.length).set(declared.starts);
    new Uint32Array(KERNEL.memory.buffer, cornersPtr, declared.corners.length).set(declared.corners);
    taken = KERNEL.fe_edit_set_faces(declared.count, startsPtr, cornersPtr);
    KERNEL.fe_free(startsPtr);
    KERNEL.fe_free(cornersPtr);
  }

  /* Faces by the ring the kernel drew for them: three corners is a triangle,
     four a quad, more an n-gon. */
  const faceCount = KERNEL.fe_edit_face_count();
  const startsView = new Uint32Array(KERNEL.memory.buffer, KERNEL.fe_edit_face_start_ptr(), faceCount + 1);
  let quads = 0, tris = 0, ngons = 0;
  for (let f = 0; f < faceCount; f++) {
    const n = startsView[f + 1] - startsView[f];
    if (n === 3) tris++;
    else if (n === 4) quads++;
    else ngons++;
  }
  const uploaded = KERNEL.fe_edit_tri_count();
  KERNEL.fe_free(positionPtr);
  KERNEL.fe_free(triPtr);
  return { quads, tris, ngons, declared: !!taken, uploaded, faces: faceCount };
}

/* The declared faces, flattened for the kernel call: start offsets plus the
   corner slots, in the geometry's own numbering. */
function declaredFaceArrays(geometry, vertCount) {
  const rings = geometry.userData && geometry.userData.feFaces;
  if (!Array.isArray(rings) || !rings.length) return null;
  if (geometry.userData.feFaceVerts !== vertCount) return null;
  let total = 0;
  for (const ring of rings) total += ring.length;
  const starts = new Uint32Array(rings.length + 1);
  const corners = new Uint32Array(total);
  let at = 0;
  for (let f = 0; f < rings.length; f++) {
    starts[f] = at;
    for (const slot of rings[f]) corners[at++] = slot;
  }
  starts[rings.length] = at;
  return { count: rings.length, starts, corners };
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

/* quads / tris / ngons: the faces of each kind the primitive has, which is the
   topology Blender gives the same shape:

     - a cylinder is thirty-two quads and two thirty-two-gon caps;
     - a cone is thirty-two triangles around its tip and one n-gon base;
     - a UV sphere is nine hundred and sixty quads and two rows of thirty-two
       pole triangles (Blender's UV sphere has the same rows);
     - everything else is quads.

   The n-gons exist because the app declares them: three gives a cap a fan of
   triangles around a middle vertex, and no shape test can tell that fan from a
   subdivided disc, so the mesh library says which rings are faces
   (feRingAroundY) and both models take it as read. The numbers below are the
   same for the kernel and for fe-poly - that agreement is the test. */
const SHIPPED = {
  cube:       { quads: 6,    tris: 0,  ngons: 0 },
  sphere:     { quads: 960,  tris: 64, ngons: 0 },
  cylinder:   { quads: 32,   tris: 0,  ngons: 2 },
  cone:       { quads: 0,    tris: 32, ngons: 1 },
  torus:      { quads: 512,  tris: 0,  ngons: 0 },
  plane:      { quads: 1,    tris: 0,  ngons: 0 },
  grid:       { quads: 64,   tris: 0,  ngons: 0 },
  ring:       { quads: 48,   tris: 0,  ngons: 0 },
  quadsphere: { quads: 864,  tris: 0,  ngons: 0 },
  knot:       { quads: 1152, tris: 0,  ngons: 0 }
};

for (const [type, expected] of Object.entries(SHIPPED)) {
  test(`the edit kernel draws ${type} as ${expected.quads} quads, ${expected.tris} triangles and ${expected.ngons} n-gons`, () => {
    const geometry = PRIMITIVES[type].build();
    const { quads, tris, ngons, faces, uploaded, declared } = kernelFaces(geometry);
    assert.equal(quads, expected.quads, `${type}: quad count`);
    assert.equal(tris, expected.tris, `${type}: triangle count`);
    assert.equal(ngons, expected.ngons, `${type}: n-gon count`);
    assert.equal(faces, expected.quads + expected.tris + expected.ngons, `${type}: face count`);
    /* An n-gon is only possible when the mesh declared its faces. */
    if (expected.ngons > 0) assert.equal(declared, true, `${type}: its faces were taken from the declaration`);
    assert.ok(uploaded >= faces, `${type}: no face is made of less than one triangle`);
  });

  test(`fe-poly draws ${type} as ${expected.quads} quads, ${expected.tris} triangles and ${expected.ngons} n-gons`, () => {
    const stats = polyStats(PRIMITIVES[type].build());
    assert.equal(stats.quads, expected.quads, `${type}: quad count`);
    assert.equal(stats.triangles, expected.tris, `${type}: triangle count`);
    assert.equal(stats.ngons, expected.ngons, `${type}: n-gon count`);
    assert.equal(stats.faces, expected.quads + expected.tris + expected.ngons);
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

test('both models answer the same faces, mesh for mesh', () => {
  /* The Object Mode wireframe and the Edit Mode cage are the same list of
     faces - that is what stops the wireframe growing a diagonal the moment a
     mesh is edited, and what keeps a cap one face in both. */
  for (const [type, spec] of Object.entries(PRIMITIVES)) {
    const geometry = spec.build();
    const kernel = kernelFaces(geometry);
    const poly = polyStats(geometry);
    assert.equal(poly.quads, kernel.quads, `${type}: quad count`);
    assert.equal(poly.triangles, kernel.tris, `${type}: triangle count`);
    assert.equal(poly.ngons, kernel.ngons, `${type}: n-gon count`);
    assert.equal(poly.faces, kernel.faces, `${type}: face count`);
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

test('a mesh comes back from an edit with the faces it was drawn with', () => {
  /* The loop a user actually walks: add a cylinder, enter Edit Mode, move a
     vertex, leave. The kernel's face table is written onto the committed
     geometry (edit-mode.js, stashFaces) and handed back on the next upload -
     so the cap is still one face the second time, and the third, instead of
     being re-derived from a shape that may have been bent since. */
  const cylinder = PRIMITIVES.cylinder.build();
  const first = kernelFaces(cylinder);
  assert.deepEqual([first.quads, first.tris, first.ngons], [32, 0, 2], 'the cap starts as one face');

  /* What commitToObject builds: the kernel's own vertices and triangles, with
     the kernel's rings in userData. */
  const vertexCount = KERNEL.fe_edit_vert_count();
  const triCount = KERNEL.fe_edit_tri_count();
  const positions = Array.from(new Float32Array(KERNEL.memory.buffer, KERNEL.fe_edit_pos_interleaved_ptr(), vertexCount * 3));
  const indices = Array.from(new Uint32Array(KERNEL.memory.buffer, KERNEL.fe_edit_idx_ptr(), triCount * 3));
  const faceCount = KERNEL.fe_edit_face_count();
  const starts = Array.from(new Uint32Array(KERNEL.memory.buffer, KERNEL.fe_edit_face_start_ptr(), faceCount + 1));
  const ring = Array.from(new Uint32Array(KERNEL.memory.buffer, KERNEL.fe_edit_face_ring_ptr(), KERNEL.fe_edit_face_ring_count()));
  const committed = new THREE.BufferGeometry();
  committed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  committed.setIndex(indices);
  committed.userData.feFaces = starts.slice(0, -1).map((from, f) => ring.slice(from, starts[f + 1]));
  committed.userData.feFaceVerts = vertexCount;

  const second = kernelFaces(committed);
  assert.equal(second.declared, true, 'the stashed faces were taken');
  assert.deepEqual([second.quads, second.tris, second.ngons], [32, 0, 2], 'and the cap is still one face');
  const poly = polyStats(committed);
  assert.deepEqual([poly.quads, poly.triangles, poly.ngons], [32, 0, 2], 'the wireframe agrees');
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

test('the shell hands the declaration in and the table back out', () => {
  /* The two halves of the wiring that no geometry test can see: enter Edit Mode
     with a declared mesh and the rings travel with the upload; leave it and the
     kernel's own table is written onto the committed geometry. */
  const bridge = readFileSync('edit-mode.js', 'utf8');
  assert.ok(/function declareFaces\(/.test(bridge), 'the shell has the upload side');
  assert.ok(bridge.includes('declareFaces(exp2, geometry, vertCount)'), 'the upload path calls it');
  assert.ok(bridge.includes('fe_edit_set_faces'), 'and hands the rings to the kernel');
  assert.ok(/function stashFaces\(/.test(bridge), 'the shell has the commit side');
  assert.ok(bridge.includes('fe_edit_face_start_ptr'), 'which reads the kernel table back');
  assert.ok(/stashFaces\(target\.userData\.baseGeometry/.test(bridge), 'and writes it onto the committed mesh');
  assert.ok(bridge.includes('feFaceVerts'), 'stamped, so a rewritten buffer invalidates it');
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
