import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* The Move / Rotate / Scale panels are how an object is placed on a phone: the
   sheet is open, the gizmo is behind it, and six controls per panel (slider,
   number box, key button, times three axes) are the whole tool.

   Reported: "some axes cannot move the object". The cause was the axis
   restriction. Picking "X Axis Only" disabled the other two rows outright -
   slider, number box and key button - so two thirds of the panel stopped
   working, and the select that did it can scroll out of a short sheet. Blender
   draws the line elsewhere: an axis constraint applies to the interactive grab,
   not to the numeric fields.

   These tests run the shipped functions from index.html against a DOM stub, so
   a row that is greyed out but inert again fails here rather than on the phone.
   The restriction itself is still tested - it must keep working on the gizmo. */

const html = readFileSync('index.html', 'utf8');

function topLevelFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist in index.html`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

/* ---- a DOM just big enough for the transform panels -------------------- */

class Node {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  closest(selector) { return selector === '.panel-field-row' ? (this.row || null) : null; }
  querySelector(selector) {
    if (selector === '.panel-axis-chip') return this.children.find((c) => c.className?.includes('panel-axis-chip')) || null;
    const id = selector.replace(/^#/, '');
    if (this.registry) return this.registry.get(id) || null;
    const found = this.children.find((c) => c.id === id);
    return found || null;
  }
  querySelectorAll(selector) {
    if (selector === '.panel-field-row') return this.rows || [];
    if (selector === 'input, button') return this.rows.flatMap((r) => r.controls || []);
    return [];
  }
}

function buildPanels() {
  const registry = new Map();
  const panels = new Map();
  const kinds = [
    { name: 'move', prefix: 'move', panelId: 'panel-move' },
    { name: 'rotate', prefix: 'rot', panelId: 'panel-rotate' },
    { name: 'scale', prefix: 'scale', panelId: 'panel-scale' }
  ];
  for (const kind of kinds) {
    const panel = new Node(kind.panelId);
    panel.registry = registry;
    const chip = new Node(kind.name + '-axis-chip', 'button');
    chip.className = 'panel-axis-chip';
    panel.children.push(chip);
    registry.set(chip.id, chip);

    const select = new Node(kind.name + '-axis-select', 'select');
    select.value = 'all';
    registry.set(select.id, select);

    panel.rows = [];
    for (const axis of ['x', 'y', 'z']) {
      const row = new Node('', 'div');
      row.style = {};
      const slider = new Node('slider-' + kind.name + '-' + axis, 'input');
      slider.min = kind.name === 'scale' ? '0.05' : kind.name === 'rotate' ? '-180' : '-20';
      slider.max = kind.name === 'scale' ? '5' : kind.name === 'rotate' ? '180' : '20';
      slider.step = kind.name === 'rotate' ? '1' : kind.name === 'scale' ? '0.05' : '0.1';
      const box = new Node('num-' + kind.prefix + '-' + axis, 'input');
      const key = new Node('key-' + kind.name + '-' + axis, 'button');
      for (const el of [slider, box, key]) {
        el.row = row;
        registry.set(el.id, el);
      }
      row.controls = [slider, box, key];
      row.querySelectorAll = (sel) => (sel === 'input, button' ? row.controls : []);
      panel.rows.push(row);
    }
    const uniform = new Node('', 'div');
    const uniformSlider = new Node('slider-scale-uniform', 'input');
    uniformSlider.min = '0.05'; uniformSlider.max = '5'; uniformSlider.step = '0.05';
    const uniformBox = new Node('num-scale-uniform', 'input');
    const uniformKey = new Node('key-scale-uniform', 'button');
    for (const el of [uniformSlider, uniformBox, uniformKey]) { el.row = uniform; registry.set(el.id, el); }
    uniform.controls = [uniformSlider, uniformBox, uniformKey];
    uniform.querySelectorAll = (sel) => (sel === 'input, button' ? uniform.controls : []);
    panel.rows.push(uniform);

    panels.set(kind.name, panel);
    registry.set(panel.id, panel);
  }
  return { registry, panels };
}

function makeObject() {
  const vec = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, clone() { return { x: this.x, y: this.y, z: this.z }; } });
  return {
    position: vec(), rotation: vec(),
    scale: Object.assign(vec(), { x: 1, y: 1, z: 1 }),
    userData: {}, geometry: null, isMesh: true,
    updateMatrix() {}, updateMatrixWorld() {}, frustumCulled: true
  };
}

function load({ restriction = 'all' } = {}) {
  const { registry, panels } = buildPanels();
  if (restriction !== 'all') {
    const select = registry.get('move-axis-select');
    if (select) select.value = restriction;
  }
  const mesh = makeObject();
  const gizmo = {
    showX: true, showY: true, showZ: true,
    updateMatrixWorld() { this.updates = (this.updates || 0) + 1; }
  };
  const document = {
    activeElement: null,
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null
  };
  const sandbox = {
    Math, Number, String, parseFloat, parseInt, isFinite, isNaN, JSON, console,
    document,
    THREE: { MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI } },
    FE: {
      current: 'core',
      toast() {},
      engines: { core: { cube: mesh, selectionBox: null, transformControls: gizmo, sceneCamera: null } }
    },
    window: {},
    activeObject: 'cube',
    modStack: [],
    updateMeasurePanel() {},
    requestAutoKey() {},
    getActiveObjectMesh: () => mesh,
    getActiveScreen: () => ({ querySelector: (sel) => registry.get(sel.replace(/^#/, '')) || null }),
    getPanel: (name) => panels.get(name) || null,
    captureLightRigState: () => null,
    preserveLightRigState() {},
    syncCameraSlidersFromScene() {},
    syncLightSlidersFromScene() {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* The per-slider memory lives beside the function it belongs to. */
  assert.ok(html.includes('const feSliderRanges = new WeakMap();'),
    'feSliderRanges is the only place a slider remembers the range its markup declared');
  const source = ['const feSliderRanges = new WeakMap();'].concat(
    ['getScreenElement', 'axisNumId', 'feSliderFitValue', 'syncAxisSliders',
      'applyTransformChange', 'applyAxisSlider',
      'updateAxisRestrictionUI', 'updateAxisRestriction', 'releaseAxisRestriction']
      .map((name) => topLevelFunction(html, name))
  ).join('\n\n');
  vm.runInContext(source, sandbox, { filename: 'transform-panels.js' });
  return { sandbox, registry, panels, mesh, gizmo, document };
}

/* ---- the report ------------------------------------------------------- */

test('every axis moves the object, whichever axis the gizmo is locked to', () => {
  /* The old shell disabled the two rows that were not selected. Walk every
     restriction, then every axis, through the slider the finger actually
     drags. */
  for (const restriction of ['all', 'x', 'y', 'z']) {
    for (const kind of ['move', 'rotate', 'scale']) {
      const { sandbox, registry, mesh } = load();
      sandbox.updateAxisRestriction(kind, restriction);

      for (const axis of ['x', 'y', 'z']) {
        const row = ['x', 'y', 'z']
          .map((a) => registry.get('num-' + (kind === 'rotate' ? 'rot' : kind) + '-' + a))
          .find((el) => el.id.endsWith('-' + axis));
        assert.equal(row.disabled, false,
          `${kind}/${restriction}: the ${axis.toUpperCase()} number box is disabled again`);

        const target = kind === 'move' ? mesh.position : kind === 'rotate' ? mesh.rotation : mesh.scale;
        const before = target[axis];
        const value = kind === 'move' ? '4.5' : kind === 'rotate' ? '30' : '2.5';
        sandbox.applyAxisSlider(kind, axis, value);
        const expected = kind === 'rotate' ? 30 * Math.PI / 180 : Number(value);
        assert.ok(Math.abs(target[axis] - expected) < 1e-9,
          `${kind}/${restriction}: the ${axis.toUpperCase()} slider did not move the object ` +
          `(${before} -> ${target[axis]}, wanted ${expected})`);
      }
    }
  }
});

test('a lock left behind by an earlier session is cleared, not honoured', () => {
  const { sandbox, registry } = load();
  /* An old build wrote `disabled` and a dimmed row onto the elements. Opening
     the panel now has to hand them back. */
  for (const axis of ['x', 'y', 'z']) {
    const box = registry.get('num-move-' + axis);
    box.disabled = true;
    box.row.style.opacity = '0.45';
  }
  sandbox.updateAxisRestriction('move', 'all');
  for (const axis of ['x', 'y', 'z']) {
    const box = registry.get('num-move-' + axis);
    assert.equal(box.disabled, false, `the ${axis.toUpperCase()} row stayed disabled`);
    assert.equal(box.row.style.opacity, '', 'the row stayed dimmed');
  }
});

/* ---- what the restriction is for -------------------------------------- */

test('the restriction still locks the gizmo, and says so in the title bar', () => {
  const { sandbox, registry, gizmo } = load();
  sandbox.updateAxisRestriction('move', 'y');
  assert.equal(gizmo.showX, false, 'the gizmo kept its X handle');
  assert.equal(gizmo.showY, true, 'the gizmo lost the axis it was locked to');
  assert.equal(gizmo.showZ, false, 'the gizmo kept its Z handle');

  const chip = registry.get('move-axis-chip');
  assert.equal(chip.hidden, false, 'a locked gizmo with no visible state is how the panel got stuck');
  assert.match(chip.textContent, /^Y axis$/, `the chip reads "${chip.textContent}"`);

  /* One tap puts all three handles back and moves the select with them. */
  sandbox.releaseAxisRestriction('move');
  assert.equal(gizmo.showX, true, 'the tap did not unlock the gizmo');
  assert.equal(gizmo.showZ, true, 'the tap did not unlock the gizmo');
  assert.equal(registry.get('move-axis-select').value, 'all', 'the select still shows the old restriction');
  assert.equal(chip.hidden, true, 'the chip is still showing a restriction that is gone');

  /* Unlocked: no chip, and asking for "all" is not a state to advertise. */
  sandbox.updateAxisRestriction('move', 'all');
  assert.equal(chip.hidden, true);
  assert.equal(chip.textContent, '');
});

/* ---- an out-of-range object must not pin its own axis ----------------- */

test('a slider widens to hold an object that is outside its working range', () => {
  const { sandbox, registry, mesh } = load();
  const slider = registry.get('slider-move-y');
  assert.equal(slider.max, '20', 'the shipped range moved');

  /* Typed, animated or imported: 34 m up is outside +-20. */
  mesh.position.y = 34;
  sandbox.syncAxisSliders('move');
  assert.ok(Number(slider.max) > 34, `the track ends at ${slider.max}, short of the object it is showing`);
  assert.equal(Number(slider.value), 34, 'the thumb has to sit on the object, not at the end of the track');

  /* Back in range: the declared range returns, so the tool keeps its feel. */
  mesh.position.y = 2;
  sandbox.syncAxisSliders('move');
  assert.equal(slider.max, '20', `the range did not come back: ${slider.max}`);
  assert.equal(Number(slider.value), 2);

  /* Negative and below the range widens the low end, never below the floor the
     panel declares for a scale slider. */
  mesh.position.y = -57.5;
  sandbox.syncAxisSliders('move');
  assert.ok(Number(slider.min) < -57.5, `the low end is ${slider.min}`);

  const scaleSlider = registry.get('slider-scale-x');
  mesh.scale.x = 9.5;
  sandbox.syncAxisSliders('scale');
  assert.ok(Number(scaleSlider.max) > 9.5, `a 9.5x object pins the scale slider at ${scaleSlider.max}`);
  assert.equal(scaleSlider.min, '0.05', 'the scale range is allowed to start at its own floor');
  mesh.scale.x = 0.0001;
  sandbox.syncAxisSliders('scale');
  assert.ok(Number(scaleSlider.min) > 0, `a scale slider may never offer zero or below: ${scaleSlider.min}`);
});

test('sync never fights the control the finger is on', () => {
  const { sandbox, registry, mesh, document } = load();
  const slider = registry.get('slider-move-x');
  document.activeElement = slider;
  mesh.position.x = 12;
  /* Mid-drag the object is being written *from* the slider: reading it back
     would move the thumb under the finger. */
  sandbox.syncAxisSliders('move');
  assert.equal(Number(slider.value), 0, 'the slider was written back to while the user held it');
  document.activeElement = null;
  sandbox.syncAxisSliders('move');
  assert.equal(Number(slider.value), 12);
});
