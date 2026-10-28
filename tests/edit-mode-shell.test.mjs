import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/* The seam the phone actually crosses: the shell in index.html (the mode
   dropdown, its change handler, the `fe:mode` event) driving the Edit Mode
   bridge in edit-mode.js and the real wasm kernel behind it.

   Every other Edit Mode test starts inside the bridge and calls enter()
   directly, so a break in the shell - a dropdown that never emits, a listener
   that quietly does nothing because the module is missing, a toolbar id that
   does not match - would pass a green suite while the user sees an app with no
   Edit Mode in it at all. This file runs the shipped shell code. */

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
    transformControls: { detach() {} },
    r: { domElement: null }
  };
}

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


/* ---- the scene, the global DOM, and the bridge --------------------------- */

const toasts = [];
const { cube, scene } = makeCube();
globalThis.THREE = THREE;
globalThis.document = {
  readyState: 'complete',
  body: { classList: { add() {}, remove() {}, toggle() {} } },
  getElementById: (id) => elementFor(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => Object.assign(new StubElement(), {
    width: 0, height: 0,
    getContext: () => ({ beginPath() {}, arc() {}, fill() {}, set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; } })
  })
};
globalThis.FECppEngine = { ready: true, exports: exp, memory: exp.memory, init: async () => exp };
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

/* ---- the shipped shell, extracted from index.html ------------------------ */

const html = readFileSync('index.html', 'utf8');
const pick = (re, name) => {
  const hit = re.exec(html);
  assert.ok(hit, `index.html no longer carries ${name}`);
  return hit[0];
};
const STUDIOS_DECL = pick(/const BACK=\[[^\n]*\nconst STUDIOS=\{[\s\S]*?\n\};/, 'the STUDIOS table');
const EMIT = pick(/const emit=\([^\n]*/, 'the emit helper');
const LISTENER = pick(/document\.addEventListener\('fe:mode'[\s\S]*?\n\}\);/, 'the fe:mode listener');
const MODE_INNER = pick(/mode\.innerHTML=s\.modes\.map[^\n]*/, 'the mode dropdown options');
const MODE_ONCHANGE = pick(/mode\.onchange=\(\)=>\{[\s\S]*?\n  \};/, 'the mode dropdown handler');
const GET_ACTIVE = pick(/function getActiveObjectMesh\(\) \{[\s\S]*?\n\}/, 'getActiveObjectMesh');

/* The shell's own globals: the studios table, emit, and the dropdown wiring. */
const shell = new Function(
  'window', 'document', 'CustomEvent', 'activeObject', 'FE', 'closeAllFloatingPanels',
  `${STUDIOS_DECL}
   ${EMIT}
   ${GET_ACTIVE}
   window.getActiveObjectMesh = getActiveObjectMesh;
   ${LISTENER}
   return { STUDIOS, emit, getActiveObjectMesh, BACK };`
);

function makeShell() {
  const listeners = {};
  const doc = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); return true; },
    getElementById: (id) => elementFor(id)
  };
  const FE = { current: 'core', engines: { core: { cube } }, toast: (m) => toasts.push(m) };
  /* In a browser `window` is the global object, and the listener reads
     window.FEEditMode from it; the harness must not freeze a copy. */
  const api = shell(globalThis, doc, class { constructor(t, i) { this.type = t; this.detail = i?.detail; } }, 'cube', FE, () => {});
  return { api, FE, doc, listeners };
}

/* A stand-in for the <select class="mode"> of the core studio, driven by the
   same two lines of code the app ships. */
function makeModeSelect(api, FE) {
  const select = new StubElement('core-mode');
  select.value = 'object';
  /* The shell reaches the dropdown by id when it has to put it back, so the
     stub has to be the one getElementById() returns. */
  elements.set('core-mode', select);
  const id = 'core';
  const s = api.STUDIOS.core;
  const document = { getElementById: () => null };
  const emit = api.emit;
  new Function('mode', 'id', 's', 'emit', 'document', `${MODE_INNER}\n${MODE_ONCHANGE}`)(select, id, s, emit, document);
  return select;
}

/* The bridge is one module instance for the whole file: importing it again
   returns the cached module without re-running it, so the tests share it and
   the first import is the one that publishes window.FEEditMode. */
async function loadBridge() {
  if (!globalThis.FEEditMode) await import(pathToFileURL(resolve('edit-mode.js')).href);
  return globalThis.FEEditMode;
}

test('the core studio really offers Edit Mode, and the dropdown is built from that list', () => {
  const { api } = makeShell();
  const modes = api.STUDIOS.core.modes.map(([value]) => value);
  assert.ok(modes.includes('edit'), 'the 3D Workspace mode dropdown must list Edit Mode');
  const select = makeModeSelect(api, null);
  assert.match(select.innerHTML, /<option value="edit">Edit Mode<\/option>/);
  assert.match(select.innerHTML, /<option value="object">Object Mode<\/option>/);
});

test('choosing Edit Mode in the dropdown reaches the kernel and puts the tools on screen', async () => {
  globalThis.FEEditMode = undefined;
  await import(pathToFileURL(resolve('edit-mode.js')).href);
  const EditMode = globalThis.FEEditMode;
  const { api, FE, doc } = makeShell();
  globalThis.FEEditMode = EditMode;
  FE.current = 'core';

  const select = makeModeSelect(api, FE);
  select.value = 'edit';
  select.onchange();

  assert.equal(EditMode.isActive(), true, 'the dropdown change did not put the app into Edit Mode');
  const bar = elementFor('toolbar-core');
  const toggle = bar.children.find((child) => child.id === 'edit-tools-btn');
  assert.ok(toggle, 'the one Edit tools button is missing from the main toolbar');
  assert.equal(elementFor('edit-sheet').hidden, false, 'the tool sheet did not open');
  assert.equal(elementFor('edit-sheet-tools').children.length, 12, 'the Select sub-toolbar is not populated');
  assert.equal(exp.fe_edit_vert_count(), 8, 'the cube never reached the kernel');

  /* Leaving the mode takes the button away again and changes nothing else. */
  select.value = 'object';
  select.onchange();
  assert.equal(EditMode.isActive(), false);
  assert.equal(bar.children.some((child) => child.id === 'edit-tools-btn'), false);
  assert.equal(bar.hidden, false, 'the object toolbar must survive the round trip');
});

test('the three selection modes sit above the Select tools and decide what a pick takes', async () => {
  /* The shipped row, not a copy of it: if the markup moves out of index.html
     the app has no mode switch, whatever the bridge believes. */
  const rowMarkup = /<div class="edit-mode-row"[\s\S]*?<\/div>/.exec(html)?.[0];
  assert.ok(rowMarkup, 'index.html no longer carries the selection mode row');
  const row = elementFor('edit-mode-row');
  row.children = parseButtons(rowMarkup);
  assert.equal(row.children.length, 3, 'the mode row must offer exactly three choices');
  assert.deepEqual(row.children.map((button) => button.dataset.editMode), ['vertex', 'edge', 'face']);

  const EditMode = await loadBridge();
  const { api, FE } = makeShell();
  FE.current = 'core';
  const select = makeModeSelect(api, FE);
  select.value = 'edit';
  select.onchange();

  assert.equal(EditMode.isActive(), true, 'the bridge did not enter Edit Mode');
  assert.equal(exp.fe_edit_get_mode(), 0, 'Edit Mode starts on points');
  assert.equal(row.children[0].classList.contains('active'), true, 'the points button is not lit');

  for (const [index, mode, kind] of [[1, 'edge', 1], [2, 'face', 2], [0, 'vertex', 0]]) {
    row.children[index].click();
    assert.equal(EditMode.state.mode, mode, `tapping ${mode} did not change the mode`);
    assert.equal(exp.fe_edit_get_mode(), kind, `the kernel was not told about ${mode} mode`);
    assert.equal(row.children[index].classList.contains('active'), true, `the ${mode} button is not lit`);
    assert.equal(row.children.filter((button) => button.classList.contains('active')).length, 1, 'two modes cannot be on at once');
  }
  assert.match(elementFor('edit-mode-hint').textContent, /Vertices only/i, 'the row must say what a selection will take');
  EditMode.exit();
});

/* "Smooth shading does not work" is a claim about the material the viewport
   draws with, so the test drives the two buttons in the sheet and reads the
   material afterwards, not the kernel flag alone. */
test('Shade Smooth and Shade Flat reach the material the viewport draws with', async () => {
  const EditMode = await loadBridge();
  const { api, FE } = makeShell();
  FE.current = 'core';
  const select = makeModeSelect(api, FE);
  select.value = 'edit';
  select.onchange();
  assert.equal(EditMode.isActive(), true, 'the bridge did not enter Edit Mode');

  EditMode.runTool('smooth');
  assert.equal(exp.fe_edit_get_shade(), 1, 'the kernel did not switch to smooth shading');
  assert.equal(cube.material.flatShading, false, 'the material still shades flat after Shade Smooth');
  const smooth = Array.from(cube.geometry.attributes.normal.array).slice(0, 9).map((v) => Math.abs(v));
  assert.ok(smooth.every((v) => Math.abs(v - 0.5773503) < 0.002), `a smooth cube corner must lean equally on all three faces, got ${smooth}`);

  EditMode.runTool('flat');
  assert.equal(exp.fe_edit_get_shade(), 0, 'the kernel did not switch to flat shading');
  assert.equal(cube.material.flatShading, true, 'the material still shades smooth after Shade Flat');
  EditMode.exit();
});

test('a build without the Edit Mode module says so instead of doing nothing', () => {
  const { api, FE } = makeShell();
  globalThis.FEEditMode = undefined;
  const select = makeModeSelect(api, FE);
  const before = toasts.length;
  select.value = 'edit';
  select.onchange();
  assert.ok(toasts.length > before, 'selecting Edit Mode with no bridge must tell the user, not fail silently');
  assert.match(toasts[toasts.length - 1], /did not load/i);
  assert.match(toasts[toasts.length - 1], /Update/i, 'and it must say what to do about it');
  assert.equal(select.value, 'object', 'the dropdown must not claim a mode the app is not in');
});

test('a failed enter() puts the dropdown back where it was', () => {
  const { api, FE } = makeShell();
  let entered = 0;
  globalThis.FEEditMode = { enter() { entered++; return false; }, isActive: () => false, exit() {} };
  const select = makeModeSelect(api, FE);
  select.value = 'edit';
  select.onchange();
  assert.equal(entered, 1, 'the bridge was asked');
  assert.equal(select.value, 'object', 'a refusal is not a mode change');
  globalThis.FEEditMode = undefined;
});
