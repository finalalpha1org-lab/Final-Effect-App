import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/* Drives the real Edit Mode bridge (edit-mode.js) against the real kernel
   (wasm/fe_core_engine.wasm) with a deliberately small stand-in for three.js
   and the DOM. Everything below the UI — upload, kernel calls, geometry
   write-back, overlay buffers, undo — is the shipped code path, so a bridge
   regression fails here instead of on a phone. */

const artifact = readFileSync('wasm/fe_core_engine.wasm');
const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact), {});
const exp = instance.exports;

/* ---- enough three.js to run the bridge ---------------------------------- */

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  setFromMatrixColumn(matrix, column) {
    const e = matrix.elements;
    this.x = e[column * 4]; this.y = e[column * 4 + 1]; this.z = e[column * 4 + 2];
    return this;
  }
  setScalar(v) { this.x = v; this.y = v; this.z = v; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, out = this.elements;
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] = ae[r] * be[c * 4] + ae[4 + r] * be[c * 4 + 1] + ae[8 + r] * be[c * 4 + 2] + ae[12 + r] * be[c * 4 + 3];
      }
    }
    return this;
  }
  multiply(m) {
    const a = { elements: this.elements.slice() };
    return this.multiplyMatrices(a, m);
  }
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
    this.needsUpdate = false;
    this.updateRange = { offset: 0, count: -1 };
  }
  setUsage() { return this; }
}

class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this.drawRange = { start: 0, count: Infinity }; this.userData = {}; this.disposed = false; }
  setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
  setIndex(attribute) { this.index = attribute; return this; }
  setDrawRange(start, count) { this.drawRange = { start, count }; return this; }
  computeBoundingSphere() { this.boundingSphere = { radius: 1 }; }
  computeBoundingBox() { this.boundingBox = {}; }
  computeVertexNormals() {
    if (!this.attributes.normal) {
      this.setAttribute('normal', new BufferAttribute(new Float32Array(this.attributes.position.array.length), 3));
    }
  }
  dispose() { this.disposed = true; return this; }
}

class Object3D {
  constructor() { this.children = []; this.parent = null; this.userData = {}; this.position = new Vector3(); this.scale = new Vector3(1, 1, 1); this.rotation = new Vector3(); this.matrixWorld = new Matrix4(); this.quaternion = null; this.visible = true; this.frustumCulled = true; this.renderOrder = 0; }
  traverse(callback) { callback(this); for (const child of this.children) child.traverse?.(callback); }
  add(...children) { for (const child of children) { child.parent = this; this.children.push(child); } return this; }
  remove(child) { const at = this.children.indexOf(child); if (at >= 0) { this.children.splice(at, 1); child.parent = null; } return this; }
  getObjectByName(name) {
    if (this.name === name) return this;
    for (const child of this.children) { const hit = child.getObjectByName?.(name); if (hit) return hit; }
    return null;
  }
  updateMatrixWorld() {}
  localToWorld(v) { return v.clone().add(this.position); }
  worldToLocal(v) { return v.clone().sub(this.position); }
}

class Color {
  constructor(value = 0xffffff) { this.setHex(value); }
  setHex(value) { this.hex = value >>> 0; this.r = ((this.hex >> 16) & 255) / 255; this.g = ((this.hex >> 8) & 255) / 255; this.b = (this.hex & 255) / 255; return this; }
  getHex() { return this.hex; }
}

class Material {
  constructor(options = {}) {
    const { color, ...rest } = options;
    Object.assign(this, rest);
    if (color !== undefined) this.color = color instanceof Color ? color : new Color(color);
    this.needsUpdate = false;
  }
  dispose() { this.disposed = true; }
}

const THREE = {
  Vector3, Matrix4, BufferAttribute, BufferGeometry, Object3D, Material, Color,
  DynamicDrawUsage: 35048,
  DoubleSide: 2,
  Group: class Group extends Object3D { constructor() { super(); this.name = ''; } },
  LineSegments: class LineSegments extends Object3D {
    constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.renderOrder = 0; }
  },
  Points: class Points extends Object3D {
    constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.renderOrder = 0; }
  },
  Mesh: class Mesh extends Object3D {
    constructor(geometry = new BufferGeometry(), material = new Material()) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; this.renderOrder = 0; }
  },
  CylinderGeometry: class CylinderGeometry extends BufferGeometry {},
  ConeGeometry: class ConeGeometry extends BufferGeometry {},
  TorusGeometry: class TorusGeometry extends BufferGeometry {},
  BoxGeometry: class BoxGeometry extends BufferGeometry {},
  SphereGeometry: class SphereGeometry extends BufferGeometry {},
  LineBasicMaterial: class LineBasicMaterial extends Material {},
  PointsMaterial: class PointsMaterial extends Material {},
  MeshBasicMaterial: class MeshBasicMaterial extends Material {},
  CanvasTexture: class CanvasTexture { constructor(canvas) { this.image = canvas; } }
};

/* ---- a scene good enough for the bridge --------------------------------- */

const CUBE_VERTS = new Float32Array([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
]);
const CUBE_TRIS = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
]);

function makeCube() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(CUBE_VERTS), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(CUBE_TRIS), 1));
  const cube = new THREE.Mesh(geometry, new Material());
  cube.name = 'Cube';
  const scene = new Object3D();
  scene.add(cube);
  return { cube, scene };
}

function makeEngine(scene, cube) {
  const camera = {
    isPerspectiveCamera: true,
    fov: 50,
    position: new Vector3(0, 0, 6),
    matrixWorld: new Matrix4(),
    projectionMatrix: new Matrix4(),
    matrixWorldInverse: new Matrix4(),
    updateMatrixWorld() {}
  };
  return {
    sc: scene,
    cube,
    getActiveCamera: () => camera,
    viewportCamera: camera,
    oc: { enableRotate: true, enablePan: true, enableZoom: true, enabled: true },
    transformControls: {
      detach() {},
      attach() {},
      setMode() {},
      updateMatrixWorld() {}
    },
    r: { domElement: null }
  };
}

/* ---- install the fakes, load the bridge ---------------------------------- */

const toasts = [];
const { cube, scene } = makeCube();
const engineStub = makeEngine(scene, cube);

globalThis.THREE = THREE;
globalThis.FE = {
  current: 'core',
  engines: { core: engineStub },
  toast: (message) => toasts.push(message)
};
globalThis.FECppEngine = {
  ready: true,
  exports: exp,
  memory: exp.memory,
  init: async () => exp
};
globalThis.getActiveObjectMesh = () => cube;
/* A tiny element stub: enough for the sheet, with a parser for the buttons a
   template string produces, so a click can be simulated on real markup. */
function parseButtons(html) {
  const buttons = [];
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const attrs = match[1];
    const dataset = {};
    for (const attr of attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      dataset[key] = attr[2];
    }
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1] || '';
    buttons.push({
      id, dataset, hidden: false, textContent: '', disabled: false, style: {},
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle(c, on) { if (on === undefined) this._set.has(c) ? this._set.delete(c) : this._set.add(c); else if (on) this._set.add(c); else this._set.delete(c); }, contains(c) { return this._set.has(c); } },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
      onclick: null,
      click() { this.onclick?.({ shiftKey: false, ctrlKey: false, metaKey: false }); }
    });
  }
  return buttons;
}

class StubElement {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.className = '';
    this.children = [];
    this._html = '';
    this.classList = { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } }, contains(c) { return this._set.has(c); } };
  }
  set innerHTML(html) { this._html = html; this.children = parseButtons(html); }
  get innerHTML() { return this._html; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { const at = this.children.indexOf(child); if (at >= 0) this.children.splice(at, 1); child.parentNode = null; return child; }
  querySelectorAll(selector) {
    const attr = /^\[data-([a-z-]+)\]$/.exec(selector);
    if (!attr) return [];
    const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return this.children.filter((child) => child.dataset && child.dataset[key] !== undefined);
  }
  querySelector(selector) {
    if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
    return null;
  }
  addEventListener() {}
  set onclick(handler) { this._onclick = handler; }
  get onclick() { return this._onclick; }
  click() { this._onclick?.({ shiftKey: false, ctrlKey: false, metaKey: false }); }
}

const elements = new Map();
function elementFor(id) {
  if (!elements.has(id)) elements.set(id, new StubElement(id));
  return elements.get(id);
}

/* Seed the two containers with the markup that actually ships. */
const shippedHtml = readFileSync('index.html', 'utf8');
const categoryBarHtml = /<nav[^>]*id="edit-category-bar"[\s\S]*?<\/nav>/.exec(shippedHtml)?.[0] || '';
elementFor('edit-category-bar').innerHTML = categoryBarHtml;

const studioScreen = {
  querySelector(selector) { return selector.startsWith('#') ? elementFor(selector.slice(1)) : null; }
};

globalThis.document = {
  readyState: 'complete',
  body: { classList: { add() {}, remove() {}, toggle() {} } },
  getElementById: (id) => (id === 'studio-core' ? studioScreen : elementFor(id)),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => Object.assign(new StubElement(), {
    width: 0,
    height: 0,
    getContext: () => ({ beginPath() {}, arc() {}, fill() {}, set fillStyle(value) { this._fill = value; }, get fillStyle() { return this._fill; } })
  })
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};

await import(pathToFileURL(resolve('edit-mode.js')).href);
const EditMode = globalThis.FEEditMode;

function kernelCounts() {
  return {
    verts: exp.fe_edit_vert_count(),
    tris: exp.fe_edit_tri_count(),
    edges: exp.fe_edit_edge_count()
  };
}

test('entering Edit Mode uploads the object and swaps in the kernel mesh', () => {
  assert.ok(EditMode, 'edit-mode.js did not register FEEditMode');
  assert.equal(EditMode.isActive(), false);
  assert.equal(EditMode.enter(), true);
  assert.equal(EditMode.isActive(), true);
  assert.deepEqual(kernelCounts(), { verts: 8, tris: 12, edges: 18 });

  /* The viewport now draws the kernel's render mesh. The kernel starts in
     smooth shading, so a cube shares its eight corner normals. */
  const geometry = cube.geometry;
  assert.equal(geometry.attributes.position.count, 8);
  assert.equal(geometry.index.count, 36);
  assert.equal(geometry.drawRange.count, 36);
  assert.ok(geometry.attributes.normal, 'the render mesh must carry kernel normals');
  const overlay = cube.getObjectByName('EditModeOverlay');
  assert.ok(overlay, 'the vertex/edge overlay was not attached');
  assert.ok(overlay.getObjectByName('EditEdges'));
  assert.ok(overlay.getObjectByName('EditVertexDots'));
});

test('the tool table drives the kernel and keeps stats honest', () => {
  EditMode.runTool('all');
  assert.equal(exp.fe_edit_sel_count(), 8);
  assert.equal(EditMode.stats().selected, 8);

  EditMode.setMode('face');
  /* Six quads, not twelve triangles: the kernel pairs the two halves of a quad
     into one face (buildQuadGroups in cpp/src/fe_editmesh.cpp), and the shell
     has to report what the viewport draws. */
  assert.equal(exp.fe_edit_sel_count(), 6, 'face mode counts the faces of an all-vertex selection');

  EditMode.setMode('edge');
  assert.equal(exp.fe_edit_sel_count(), 18);

  EditMode.setMode('vertex');
  EditMode.runTool('none');
  assert.equal(exp.fe_edit_sel_count(), 0);
});

test('a mesh operation reaches the object and undo restores it', () => {
  /* Face mode extrudes the selection as one shell; vertex mode extrudes every
     face on its own, which is a different (also correct) result. */
  EditMode.setMode('face');
  EditMode.runTool('all');
  const before = { verts: 8, tris: 12, edges: 18 };
  const extruded = EditMode.runTool('extrude');
  assert.ok(extruded > 0, 'extrude changed nothing');
  assert.equal(kernelCounts().verts, 16);
  assert.equal(kernelCounts().tris, 24);
  /* The viewport geometry followed the kernel without a second upload. */
  assert.equal(cube.geometry.attributes.position.count, exp.fe_edit_render_vert_count());

  EditMode.undo();
  assert.deepEqual(kernelCounts(), before);

  EditMode.redo();
  assert.equal(kernelCounts().verts, 16);
  EditMode.undo();
  assert.equal(kernelCounts().verts, 8);
});

test('shading tools change the surface, not the topology', () => {
  const before = kernelCounts();
  EditMode.runTool('flat');
  /* The kernel keeps one shared vertex per corner and asks the material for
     derivative normals; the bridge has to carry that flag to the material. */
  assert.equal(exp.fe_edit_get_shade(), 0);
  assert.equal(cube.material.flatShading, true, 'flat shading never reached the material');
  EditMode.runTool('smooth');
  assert.equal(exp.fe_edit_get_shade(), 1);
  assert.equal(cube.material.flatShading, false);
  /* Sharp edges still split the mesh, and that is a geometry-level change. */
  EditMode.setMode('edge');
  EditMode.runTool('all');
  EditMode.runTool('sharp');
  assert.ok(exp.fe_edit_render_vert_count() > 8, 'marking every edge sharp must split the corners');
  assert.deepEqual(kernelCounts(), before);
});

test('leaving the mode writes the canonical mesh back to the object', () => {
  assert.equal(kernelCounts().tris, 12, 'this test starts from the unit cube');
  EditMode.setMode('face');
  EditMode.runTool('all');
  EditMode.runTool('subdivide');
  const afterSubdivide = kernelCounts();
  assert.equal(afterSubdivide.tris, 48);

  EditMode.exit();
  assert.equal(EditMode.isActive(), false);
  assert.equal(cube.geometry.attributes.position.count, exp.fe_edit_vert_count(), 'the object keeps shared vertices, not the split render mesh');
  assert.equal(cube.geometry.attributes.position.count, 26, 'subdividing the cube adds one vertex per edge');
  assert.equal(cube.geometry.index.count, afterSubdivide.tris * 3);
  assert.equal(cube.getObjectByName('EditModeOverlay'), null, 'the overlay must not survive the mode');
  assert.ok(engineStub.oc.enableRotate, 'orbiting must come back');
});

test('the bridge refuses an object with no mesh and reports it', () => {
  const saved = globalThis.getActiveObjectMesh;
  globalThis.getActiveObjectMesh = () => null;
  const entered = EditMode.enter();
  globalThis.getActiveObjectMesh = saved;
  assert.equal(entered, false);
  assert.equal(EditMode.isActive(), false);
  assert.ok(toasts.some((message) => /select a mesh/i.test(message)), 'the user must be told why nothing happened');
});

test("one button in the main toolbar opens the edit tools, and they reach the kernel", () => {
  elementFor('toolbar-core').hidden = false;
  assert.equal(EditMode.enter(), true);

  /* Nothing that was already in the main toolbar changes, and nothing is
     hidden: the edit feature adds exactly one button to it. */
  assert.equal(elementFor('toolbar-core').hidden, false, 'the object toolbar must stay as it was');
  const toggle = elementFor('toolbar-core').children.find((child) => child.id === 'edit-tools-btn');
  assert.ok(toggle, 'the main toolbar must gain one Edit tools button');
  assert.equal(toggle.dataset.tool, undefined, 'it must not pretend to be one of the object tools');

  /* Its panel carries the categories, the point / edge / face switch, and the
     tools of the open category; the sheet opens with the mode. */
  const sheet = elementFor('edit-sheet');
  assert.equal(sheet.hidden, false, 'the tool panel opens with the mode');
  assert.ok(sheet.classList.contains('open'));
  assert.equal(elementFor('edit-category-bar').hidden, false, 'the categories live inside that panel');

  const tools = elementFor('edit-sheet-tools');
  assert.equal(tools.children.length, 12, 'the Select sub-toolbar lists its twelve tools');
  const all = tools.children.find((button) => button.dataset.editCommand === 'all');
  assert.ok(all, 'the Select sub-toolbar has an All button');
  all.click();
  assert.equal(exp.fe_edit_sel_count(), exp.fe_edit_vert_count(), 'the All button did not reach the kernel');

  const bar = elementFor('edit-category-bar');
  const mesh = bar.children.find((button) => button.dataset.editCategory === 'mesh');
  assert.ok(mesh, 'the Mesh category button is missing from the shipped panel');
  mesh.click();
  assert.equal(EditMode.state.category, 'mesh');
  assert.equal(elementFor('edit-sheet-tools').children.length, 15, 'the Mesh sub-toolbar replaced the Select one');

  /* The amount slider belongs to the tool, not to the panel: it appears for
     Extrude and disappears for Poke. */
  EditMode.setMode('face');
  const meshTools = elementFor('edit-sheet-tools');
  meshTools.children.find((button) => button.dataset.editCommand === 'extrude').click();
  assert.equal(elementFor('edit-amount-row').hidden, false, 'Extrude needs its distance slider');
  assert.ok(exp.fe_edit_tri_count() > 12, 'Extrude did not change the mesh');

  const before = exp.fe_edit_tri_count();
  meshTools.children.find((button) => button.dataset.editCommand === 'poke').click();
  assert.ok(exp.fe_edit_tri_count() > before, 'Poke did not split the selected faces');
  assert.equal(elementFor('edit-amount-row').hidden, true, 'Poke has no amount to set');

  /* Undo and redo are in the top bar, so the edit panel carries no second pair:
     a duplicate would be two buttons doing one job in the same screen. */
  const barIds = [...(readFileSync('index.html', 'utf8').matchAll(/<button[^>]*id="(edit-[a-z-]+)"/g))].map((m) => m[1]);
  assert.ok(!barIds.includes('edit-undo'), 'the edit panel must not carry an undo button');
  assert.ok(!barIds.includes('edit-redo'), 'the edit panel must not carry a redo button');

  /* The one button folds the panel away and gives the whole viewport back. */
  toggle.click();
  assert.equal(elementFor('edit-sheet').hidden, true, 'the toggle button folds the tools away');
  toggle.click();
  assert.equal(elementFor('edit-sheet').hidden, false, 'and opens them again');

  EditMode.exit();
  assert.equal(elementFor('edit-sheet').hidden, true, 'leaving folds the panel');
  assert.equal(elementFor('toolbar-core').children.some((child) => child.id === 'edit-tools-btn'), false,
    'leaving takes the one added button away again');
  assert.equal(elementFor('toolbar-core').hidden, false, 'and the object toolbar is still there');
});

test('Edit Mode is entered from the mode dropdown and nowhere else', () => {
  /* Two different things used to share the word Edit: the ✏️ Edit tool in the
     main bar opened the Object Tools panel, and Edit Mode lives on the mode
     dropdown and edits vertices, edges and faces in the C++ kernel. The tool
     is gone - a second thing called Edit was forever being taken for the mode -
     so the dropdown is the only door, and this test holds that shut. */
  const html = readFileSync('index.html', 'utf8');
  const bar = html.slice(html.indexOf('tools:['), html.indexOf("['render','⚡','Render Engine']"));
  assert.ok(bar.length > 0, 'the main toolbar must be findable');
  assert.ok(!/\['edit',/.test(bar), 'the main bar must have no second Edit tool');
  assert.match(html, /modes:\[\['object','Object Mode'\],\['edit','Edit Mode'\]\]/,
    'the dropdown offers Object Mode and Edit Mode');

  /* Entering the mode is the dropdown's job: one event, one listener. */
  assert.match(html, /mode\.onchange=\(\)=>\{\s*emit\('mode',\{studio:id,mode:mode\.value\}\);/,
    'the dropdown is what announces a mode change');
  const bridge = readFileSync('edit-mode.js', 'utf8');
  assert.match(bridge, /events\.addEventListener\?\.\('fe:mode'/, 'the bridge enters on fe:mode');
  assert.ok(!/window\.FEEditMode/.test(bridge), 'the bridge must not reach through the window it lives on');

  /* The edit tools are one panel of this app's own language: a left-to-right
     row of categories over a left-to-right row of tools, both scrollable, and
     neither one a copy of another application's panel. */
  const barCss = html.slice(html.indexOf('.edit-sheet-head {'), html.indexOf('.edit-bar-sep {'));
  assert.match(barCss, /\.edit-sheet-head \.tool \{ gap: 6px;/, 'the category row is a row of tools');
  const subCss = html.slice(html.indexOf('#edit-sheet-tools {', barCss.length + html.indexOf('.edit-sheet-head {')), html.indexOf('.edit-sheet-row {'));
  assert.match(subCss, /flex-wrap: nowrap/, 'the tool row is one row, not a grid of tiles');
  assert.match(subCss, /overflow-x: auto/, 'and it scrolls sideways when it runs out of room');
  /* The panel floats; it does not wall the viewport in. */
  const sheetCss = html.slice(html.indexOf('#edit-sheet {'), html.indexOf('.edit-sheet-head {'));
  assert.match(sheetCss, /position: fixed/, 'the tool panel is a popover');
  assert.match(sheetCss, /border-radius: 14px/, 'and it has its own rounded shape');
  /* A hard ceiling, in viewport units and in pixels: the panel is a strip of
     tools at the bottom of the screen and may never grow into the model. */
  assert.match(sheetCss, /max-height: min\(34dvh, 280px\)/, 'the panel has a hard maximum height');

  /* The settings inside it read top to bottom: one label, one control across
     the full width. Side by side they left the right half of every row empty. */
  const stackStart = html.indexOf('.edit-sheet-row.edit-sheet-stack {');
  assert.ok(stackStart > 0, 'index.html has no stacked setting rows');
  const stackCss = html.slice(stackStart, stackStart + 900);
  assert.match(stackCss, /flex-direction: column/, 'a stacked setting puts its label above its control');
  for (const id of ['edit-axis-row', 'edit-prop-row', 'edit-exact-row']) {
    assert.match(html, new RegExp(`class="edit-sheet-row edit-sheet-stack" id="${id}"`),
      `${id} must use the stacked layout`);
  }
});

test('a face marked flat keeps its shading after leaving Edit Mode', () => {
  /* A cube whose faces were written down as flat, on a mesh that has no
     normals of its own - the cage the editor is handed back. The flags are the
     only record of the shading, which is exactly the case that used to be lost
     the moment the mode closed. */
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(CUBE_VERTS), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(CUBE_TRIS), 1));
  geometry.userData.feFaceShading = new Uint8Array(12);
  const faceted = new THREE.Mesh(geometry, new Material());
  faceted.name = 'FacetedCube';
  scene.add(faceted);
  const savedObject = globalThis.getActiveObjectMesh;
  globalThis.getActiveObjectMesh = () => faceted;
  try {
    assert.equal(EditMode.enter(), true);
    assert.equal(exp.fe_edit_shade_state(), 0, 'the written flags must reach the kernel as flat faces');

    /* Everything smooth, then one face flat again: the mixed mesh is the case
       no whole-object switch can express. */
    EditMode.setMode('face');
    EditMode.runTool('all');
    EditMode.runTool('smooth');
    assert.equal(exp.fe_edit_shade_state(), 1);
    EditMode.runTool('none');
    exp.fe_arena_reset();
    const facePtr = exp.fe_malloc(4);
    new Uint32Array(exp.memory.buffer, facePtr, 1)[0] = 0;
    exp.fe_edit_select_by_index(2, 1, facePtr, 0);
    exp.fe_arena_reset();
    EditMode.runTool('flat');
    exp.fe_edit_build_render();
    assert.equal(exp.fe_edit_shade_state(), 2, 'one flat quad in a smooth cube');

    EditMode.exit();

    /* The object comes back split: a flat face and a smooth one cannot share a
       vertex, so the corners are broken apart and the normals say which is
       which - that is what survives export, and what the next tool reads. */
    const committed = faceted.geometry;
    const flags = committed.userData.feFaceShading;
    assert.ok(flags instanceof Uint8Array, 'the flags must travel with the committed geometry');
    assert.equal(flags.length, 12, 'one flag per triangle');
    assert.equal(Array.from(flags).filter((v) => v === 0).length, 2, 'the quad the user marked is still flat');
    assert.ok(committed.attributes.position.count > 8, `a mixed mesh cannot share vertices, got ${committed.attributes.position.count}`);
    assert.equal(committed.attributes.normal.count, committed.attributes.position.count);
    assert.equal(faceted.material.flatShading, false, 'the geometry carries the shading, not the material');

    /* And re-entering starts from those flags again, not from a guess. */
    assert.equal(EditMode.enter(), true);
    assert.equal(exp.fe_edit_shade_state(), 2, 'the mixed shading was not restored');
    EditMode.exit();
  } finally {
    globalThis.getActiveObjectMesh = savedObject;
    scene.remove(faceted);
    geometry.dispose?.();
  }
});
