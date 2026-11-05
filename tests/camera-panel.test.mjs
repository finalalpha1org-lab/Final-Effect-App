import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Feature 3 of the Workspace: the Camera panel. It is a lot of controls over
   one camera, so the tests drive the functions the panel calls rather than the
   markup, with a fake camera and a fake DOM. Every failure below was a real one
   in the panel: three controls writing the same property, sliders that showed
   numbers the camera did not have, and a stabilization switch that did not
   switch anything off. */

const html = readFileSync('index.html', 'utf8');

/* Pull one top-level function out of index.html by name, braces matched. */
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist in index.html`);
  let depth = 0, i = html.indexOf('{', start);
  const from = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

function makeVector(x = 0, y = 0, z = 0) {
  return {
    x, y, z, isVector3: true,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    clone() { return makeVector(this.x, this.y, this.z); },
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; },
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  };
}

function harness({ elements = {}, camera = {}, eng = {}, globalSettings = {} } = {}) {
  const dom = new Map(Object.entries(elements).map(([id, value]) => [id, value]));
  const document = {
    activeElement: null,
    getElementById: (id) => {
      const entry = dom.get(id);
      if (entry === undefined || entry === null) return null;
      return entry;
    }
  };
  const ctx = vm.createContext({
    document,
    window: { getActiveObjectMesh: () => eng.activeMesh || null },
    Math, Number, String, Array, Object, JSON, console, parseFloat, parseInt, Infinity,
    THREE: { Vector3: function (x, y, z) { return makeVector(x, y, z); }, MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI } },
    GLOBAL_SETTINGS: { sensitivity: 1, ...globalSettings },
    FE: { engines: { core: eng } },
    timelineConfig: {},
    updateCameraFrame: () => { ctx.__frames = (ctx.__frames || 0) + 1; },
    out: () => null
  });
  ctx.__elements = dom;
  const stabDefaults = html.slice(html.indexOf('const CAMERA_STAB_DEFAULTS'), html.indexOf('\n', html.indexOf('const CAMERA_STAB_DEFAULTS')));
  const code = [
    stabDefaults,
    'let isTransformSliderInteracting = false;',
    'const cameraDisplayFov = (c) => (c && c.isPerspectiveCamera && Number.isFinite(c.fov)) ? c.fov : (Number(c && c.userData && c.userData.displayFov) || 39.6);',
    extract('cameraSensorCrop'), extract('cameraZoomSetting'), extract('applyCameraZoom'),
    extract('setCameraZoom'), extract('setCameraSensorCrop'),
    extract('applyCameraStabilization'), extract('syncCameraPanelLabel'),
    extract('getConfiguredCameraFocusTarget'), extract('syncCameraSlidersFromScene')
  ].join('\n\n');
  vm.runInContext(code, ctx);
  return { ctx, camera, eng, dom };
}

function makeCamera(extra = {}) {
  const camera = {
    userData: {},
    zoom: 1,
    aspect: 16 / 9,
    isPerspectiveCamera: true,
    position: makeVector(-4.5, 3.5, 4.5),
    rotation: { x: 0, y: 0, z: 0 },
    updateProjectionMatrix() { camera.__updated = (camera.__updated || 0) + 1; },
    getWorldDirection(v) { return v.set(0, 0, -1); },
    updateMatrixWorld() {},
    ...extra
  };
  return camera;
}

test('the sensor, the crop preset and zoom no longer overwrite each other', () => {
  const camera = makeCamera();
  const { ctx } = harness({ camera, eng: { sceneCamera: camera } });

  ctx.setCameraZoom(camera, 2);
  assert.equal(camera.zoom, 2, 'zoom alone is what the slider says');

  /* A smaller sensor sees less of the frame at the same focal length: 1.5x. */
  ctx.setCameraSensorCrop(camera, 1.5);
  assert.equal(camera.zoom, 3, 'the projection is the product of the two');
  assert.equal(ctx.cameraZoomSetting(camera), 2, 'and the zoom the user set is remembered');
  assert.equal(ctx.cameraSensorCrop(camera), 1.5, 'as is the sensor');

  /* Back to full frame: the user's zoom comes back instead of being lost. */
  ctx.setCameraSensorCrop(camera, 1);
  assert.equal(camera.zoom, 2);

  /* Both sliders are clamped to what the camera can hold. */
  ctx.setCameraZoom(camera, 999);
  assert.equal(ctx.cameraZoomSetting(camera), 10);
  ctx.setCameraSensorCrop(camera, 0.01);
  assert.equal(ctx.cameraSensorCrop(camera), 0.5);
  assert.equal(camera.zoom, 5, '10x zoom on a 0.5x sensor');

  /* Every change updates the projection, or the viewport would not move. */
  assert.ok(camera.__updated >= 4, 'the projection matrix is refreshed on every change');
  assert.ok(ctx.__frames >= 4, 'and the camera frame follows it');
});

test('the sliders show what the camera holds, not what was last typed', () => {
  const camera = makeCamera();
  const zoom = { id: 'cam-zoom', value: '1.00' };
  const crop = { id: 'cam-crop', value: '1', options: [{ value: '1' }, { value: '1.5' }, { value: '2' }, { value: '.88' }] };
  const label = { textContent: 'Camera 1' };
  const lens = { id: 'cam-lens-type', value: 'perspective' };
  const { ctx } = harness({
    camera,
    eng: { sceneCamera: camera },
    elements: {
      'cam-zoom': zoom, 'cam-crop': crop, 'camera-selected-label': label, 'cam-lens-type': lens
    }
  });

  ctx.setCameraZoom(camera, 1.75);
  ctx.setCameraSensorCrop(camera, 1.5);
  ctx.syncCameraSlidersFromScene();
  assert.equal(zoom.value, '1.75', 'the zoom slider shows the user\'s zoom, not the projection product');
  assert.equal(crop.value, '1.5', 'the crop preset follows the sensor');
  assert.match(label.textContent, /Perspective/, 'and the panel says which lens it is editing');

  /* While the user is dragging a slider, the sync must not fight them. */
  zoom.value = '0.50';
  ctx.document.activeElement = zoom;
  ctx.syncCameraSlidersFromScene();
  assert.equal(zoom.value, '0.50', 'the slider under the finger is left alone');
  ctx.document.activeElement = null;
  ctx.syncCameraSlidersFromScene();
  assert.equal(zoom.value, '1.75', 'and it catches up as soon as the finger lifts');
});

test('stabilization Off puts the camera back and the sliders stay asleep', () => {
  const oc = { dampingFactor: 0.5, rotateSpeed: 3, enableDamping: true };
  const { ctx, dom } = harness({ eng: { oc } });
  dom.set('cam-stab-mode', { value: 'off' });
  dom.set('cam-stab-smooth', { value: '1' });
  dom.set('cam-stab-strength', { value: '1' });

  let state = ctx.applyCameraStabilization({ oc });
  assert.equal(state.mode, 'off');
  assert.equal(oc.dampingFactor, 0.08, 'the viewport default damping is restored');
  assert.equal(oc.rotateSpeed, 1, 'and the sensitivity from the settings, not a stabilization curve');

  dom.set('cam-stab-mode', { value: 'digital' });
  state = ctx.applyCameraStabilization({ oc });
  assert.equal(state.mode, 'digital');
  assert.ok(oc.dampingFactor < 0.08, 'smoothness eases the camera instead of snapping');
  assert.ok(oc.rotateSpeed < 1, 'strength takes speed away in digital mode');

  dom.set('cam-stab-mode', { value: 'optical' });
  ctx.applyCameraStabilization({ oc });
  assert.equal(oc.rotateSpeed, 1, 'optical only steadies the motion, it does not slow the camera');
  assert.ok(oc.dampingFactor < 0.08);

  /* A sensitivity setting is the base every mode returns to. */
  const base = harness({ eng: { oc }, globalSettings: { sensitivity: 0.6 } });
  base.dom.set('cam-stab-mode', { value: 'off' });
  base.ctx.applyCameraStabilization({ oc });
  assert.equal(oc.rotateSpeed, 0.6);
});

test('the focus point the panel asks for is the one autofocus and DoF use', () => {
  const camera = makeCamera();
  const cube = { position: makeVector(1, 2, 3) };
  const activeMesh = { position: makeVector(9, 9, 9) };
  const eng = { sceneCamera: camera, cube, activeMesh };
  const { ctx, dom } = harness({ camera, eng });

  const xyz = (v) => [v.x, v.y, v.z];
  dom.set('cam-focus-point', { value: 'center' });
  assert.deepEqual(xyz(ctx.getConfiguredCameraFocusTarget(eng, camera)), [0, 0, 0]);

  dom.set('cam-focus-point', { value: 'cube' });
  let point = ctx.getConfiguredCameraFocusTarget(eng, camera);
  assert.deepEqual(xyz(point), [1, 2, 3]);

  dom.set('cam-focus-point', { value: 'active' });
  point = ctx.getConfiguredCameraFocusTarget(eng, camera);
  assert.deepEqual(xyz(point), [9, 9, 9], 'the active mesh, not the starter cube');

  /* A scene whose starter cube was deleted still has a focus target. */
  dom.set('cam-focus-point', { value: 'cube' });
  const bare = { sceneCamera: camera };
  point = ctx.getConfiguredCameraFocusTarget(bare, camera);
  assert.ok(point, 'no cube is not a crash');

  /* The per-frame path reuses the caller's vector. */
  const reused = makeVector();
  dom.set('cam-focus-point', { value: 'cube' });
  const returned = ctx.getConfiguredCameraFocusTarget(eng, camera, reused);
  assert.equal(returned, reused, 'autofocus must not allocate a vector per frame');

  /* Camera-forward focus is where the lens is pointed, at the focus distance. */
  dom.set('cam-focus-point', { value: 'camera' });
  dom.set('cam-focus-distance', { value: '10' });
  point = ctx.getConfiguredCameraFocusTarget(eng, camera, makeVector());
  assert.deepEqual(xyz(point), [-4.5, 3.5, -5.5]);
});

test('the panel has no dead controls and no fake effects', () => {
  /* Lens Distortion used to round the canvas corners: a slider that damaged the
     viewport instead of distorting the lens. There is no lens shader in the
     viewport, so the control is gone rather than pretending. */
  assert.ok(!html.includes('id="cam-distortion"'), 'the fake distortion slider must stay gone');
  assert.ok(!html.includes('out-distortion'));
  assert.ok(!/cam-distortion/.test(html));

  /* The Camera dropdown listed one camera and nothing ever read it. */
  assert.ok(!html.includes('id="camera-selector"'), 'a selector nobody reads is not a feature');
  assert.ok(html.includes('id="camera-selected-label"'), 'the header still names the camera');
  assert.ok(html.includes('syncCameraPanelLabel()'), 'and it is kept in step with the lens');

  /* Autofocus may not require the starter cube to still exist. */
  const autofocus = html.slice(html.indexOf("else if (el.id === 'cam-autofocus')"), html.indexOf("else if (el.id === 'cam-focus-peaking')"));
  assert.ok(!/eng\.cube/.test(autofocus), 'autofocus must work in any scene');

  /* The camera frame rate is the project frame rate. */
  const fps = html.slice(html.indexOf("else if (el.id === 'cam-fps')"), html.indexOf("else if (el.id === 'cam-stab-mode')"));
  assert.match(fps, /timelineConfig\.fps = fps/, 'the frame-rate dropdown has to set the timeline rate');

  /* And the stabilization sliders go through the mode switch. */
  const sliders = html.slice(html.indexOf("el.id === 'cam-stab-smooth'"), html.indexOf("el.id === 'cam-stab-smooth'") + 400);
  assert.match(sliders, /applyCameraStabilization\(eng\)/);
  assert.ok(!/dampingFactor = 0\.01/.test(sliders), 'no second, ungated copy of the curve');
});
