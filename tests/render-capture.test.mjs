import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* A render is not a screenshot of the editor. These tests pin the two halves of
   that rule that used to be missing: editor helpers never reach a rendered
   frame, and a capture never inherits the viewport's camera crop. */

const source = readFileSync('render-capture.js', 'utf8');
const context = { Math, THREE };
vm.createContext(context);
vm.runInContext(source, context);
const RC = context.FERenderCapture;

const engineSource = readFileSync('fe-cpp-engine.js', 'utf8');
const html = readFileSync('index.html', 'utf8');

function studioScene() {
  const scene = new THREE.Scene();

  const grid = new THREE.GridHelper(50, 50, 0x818cf8, 0x2a2e3d);
  const cursor = new THREE.Object3D();
  cursor.name = 'Cursor3D';
  const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50));
  shadowFloor.name = 'ShadowFloor';
  shadowFloor.visible = false;

  const blenderCam = new THREE.Group();
  blenderCam.name = 'Camera';
  blenderCam.add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()));
  const blenderLight = new THREE.Group();
  blenderLight.name = 'Light';
  blenderLight.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));

  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial());
  cube.name = 'Cube';

  const torch = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshStandardMaterial());
  torch.name = 'Torch';                 /* user geometry with a helper-ish name must survive */
  const gizmo = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
  gizmo.userData.isEditorHelper = true;

  scene.add(grid, cursor, shadowFloor, blenderCam, blenderLight, cube, torch, gizmo);

  const engine = { grid, cursor3d: cursor, shadowFloor, studioFloor: null, blenderCam, blenderCamLines: blenderCam.children[0], blenderLight, cube };
  return { scene, engine, grid, cursor, shadowFloor, blenderCam, blenderLight, cube, torch, gizmo };
}

test('a rendered frame contains the artwork and none of the editor', () => {
  const { scene, engine, grid, cursor, blenderCam, blenderLight, cube, torch, gizmo } = studioScene();
  const hidden = RC.hideEditorHelpers(scene, engine);

  for (const [label, object] of Object.entries({ grid, cursor, blenderCam, blenderLight, gizmo })) {
    assert.equal(object.visible, false, `${label} is not in the render`);
  }
  assert.equal(cube.visible, true, 'the model stays');
  assert.equal(torch.visible, true, 'and so does ordinary user geometry');
  assert.ok(hidden.includes(grid) && hidden.includes(blenderCam), 'the caller is told what was hidden');

  RC.restoreEditorHelpers(hidden);
  for (const object of [grid, cursor, blenderCam, blenderLight, gizmo]) {
    assert.equal(object.visible, true, 'the viewport is unchanged after the render');
  }
});

test('a helper that was already hidden stays hidden after the capture', () => {
  const { scene, engine, cursor, shadowFloor } = studioScene();
  cursor.visible = false;               /* e.g. camera view already hides the rig */
  shadowFloor.visible = false;          /* the shadow catcher only exists in rendered shading */

  const hidden = RC.hideEditorHelpers(scene, engine);
  assert.ok(!hidden.includes(cursor), 'an invisible helper is not claimed by the capture');
  RC.restoreEditorHelpers(hidden);

  assert.equal(cursor.visible, false, 'and it is not switched on by the restore');
  assert.equal(shadowFloor.visible, false, 'neither is the floor');
  assert.equal(scene.children[0].visible, true, 'while the grid comes back');
});

test('the shadow catcher stays when the render dialog asks for one', () => {
  const { scene, engine, shadowFloor, grid } = studioScene();
  shadowFloor.visible = true;           /* rendered shading switched it on */
  const hidden = RC.hideEditorHelpers(scene, engine, new Set([shadowFloor]));
  assert.equal(shadowFloor.visible, true, 'the catcher is a rendered element, not an editor helper');
  assert.equal(grid.visible, false, 'while the grid still goes away');
  RC.restoreEditorHelpers(hidden);
  assert.equal(shadowFloor.visible, true, 'and the viewport still has it');
  assert.equal(grid.visible, true);

  /* Without the exemption it is an ordinary helper. */
  const off = RC.hideEditorHelpers(scene, engine);
  assert.equal(shadowFloor.visible, false);
  RC.restoreEditorHelpers(off);
});

test('withEditorHelpersHidden restores the scene even when the capture throws', () => {
  const { scene, engine, grid } = studioScene();
  assert.throws(() => RC.withEditorHelpersHidden(scene, engine, () => { throw new Error('context lost'); }), /context lost/);
  assert.equal(grid.visible, true, 'a failed render must not leave the editor stripped');
  assert.equal(RC.withEditorHelpersHidden(scene, engine, () => grid.visible), false, 'and the scene is clean while it runs');
});

test('the scene registry is the same list the path tracer skips', () => {
  /* The floors and the outline helper are skipped by name; the 3D cursor is
     skipped by identity, because a user's own mesh may legitimately be called
     "Cursor3D". Both routes are pinned, since only one of them is visible in
     the source as a string. */
  for (const name of ['ShadowFloor', 'StudioFloor', 'SelectionOutlineHelper']) {
    assert.ok(RC.HELPER_NAMES.includes(name));
    assert.ok(engineSource.includes(`'${name}'`), `${name} is filtered by the path tracer as well`);
  }
  assert.ok(RC.HELPER_NAMES.includes('Cursor3D'));
  assert.ok(engineSource.includes('eng.cursor3d'), 'the cursor is skipped by identity, not by name');
  assert.match(engineSource, /obj\.userData\?\.isEditorHelper/, 'user-marked helpers are skipped by the path tracer');
  assert.match(engineSource, /if \(!obj\.visible/, 'and hidden objects never reach the renderer');

  /* The workspace exporter must use the same registry — an export that keeps
     the grid while the render drops it is the bug this file exists for. */
  const exporter = readFileSync('workspace-export.js', 'utf8');
  for (const name of ['Cursor3D', 'StudioFloor', 'ShadowFloor']) {
    assert.ok(exporter.includes(`'${name}'`), `the exporter filters ${name} too`);
  }
});

test('the camera source is the authored rig, or the camera the viewport draws with', () => {
  const rig = { name: 'scene' }, view = { name: 'viewport' };
  const engine = { sceneCamera: rig, viewportCamera: view };

  assert.equal(RC.resolveRenderCamera(engine, 'scene', view), rig, 'the rig means the rig, whatever the viewport shows');
  assert.equal(RC.resolveRenderCamera(engine, 'viewport', view), view, 'the viewport means the orbit camera when that is what is drawn');
  assert.equal(RC.resolveRenderCamera(engine, 'viewport', rig), rig, 'and the rig when camera view is what is drawn');
  assert.equal(RC.resolveRenderCamera(engine, undefined, view), view, 'an unset source falls back to the viewport');
  assert.equal(RC.resolveRenderCamera({ sceneCamera: rig }, 'viewport', undefined), rig, 'a missing viewport camera still renders something');
  assert.equal(RC.resolveRenderCamera(null, 'scene', view), null);

  /* The engine must ask this module instead of resolving it inline. */
  const at = engineSource.indexOf('renderCamera() {');
  const boot = engineSource.slice(at, at + 700);
  assert.ok(at > 0, 'the engine has one camera resolver');
  assert.match(boot, /FERenderCapture/, 'the engine defers to the shared rule');
  assert.match(boot, /render-cam-source/, 'driven by the dialog, not by isCameraView');
  const capture = engineSource.slice(engineSource.indexOf('renderSingleWebGLPostFXFrame'), engineSource.indexOf('async startStillRender'));
  assert.ok(!capture.includes('getActiveCamera'), 'the capture never asks for "whatever is active"');
});

test('a capture clears the viewport camera crop and hands it back exactly', () => {
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 100);
  camera.position.set(-4.5, 3.5, 4.5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  /* The camera-view overlay crops the projection to the frame box. */
  camera.setViewOffset(960, 540, -120, 40, 1600, 900);
  camera.updateMatrixWorld(true);
  const cropped = camera.projectionMatrix.clone();
  const croppedAspect = camera.aspect;

  const saved = RC.prepareRenderCamera(camera, 1920 / 1080);
  assert.equal(camera.view.enabled, false, 'the render does not inherit the viewport crop');
  assert.equal(camera.aspect, 1920 / 1080, 'and uses the output aspect');
  assert.notDeepEqual(
    Array.from(camera.projectionMatrix.elements),
    Array.from(cropped.elements),
    'so the projection actually changes'
  );

  RC.restoreRenderCamera(camera, saved);
  assert.equal(camera.view.enabled, true, 'the viewport crop is back');
  assert.equal(camera.aspect, croppedAspect);
  assert.deepEqual(Array.from(camera.projectionMatrix.elements), Array.from(cropped.elements), 'bit for bit the viewport projection');
});

test('a camera without a crop is not given one', () => {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  const before = Array.from(camera.projectionMatrix.elements);
  const saved = RC.prepareRenderCamera(camera, 2);
  RC.restoreRenderCamera(camera, saved);
  assert.deepEqual(Array.from(camera.projectionMatrix.elements), before);
  assert.equal(camera.view, null);
});

test('both engines render from the same capture rule', () => {
  const still = engineSource.slice(engineSource.indexOf('renderSingleWebGLPostFXFrame'), engineSource.indexOf('async startStillRender'));
  assert.match(still, /hideEditorHelpers/, 'the EEVEE capture hides the editor');
  assert.match(still, /restoreEditorHelpers/, 'and puts it back');
  assert.match(still, /prepareRenderCamera/, 'it owns the camera while it renders');
  assert.match(still, /restoreRenderCamera/, 'and gives it back');
  assert.ok(still.indexOf('hideEditorHelpers') < still.indexOf('eng.r.render'), 'helpers are hidden before the draw, not after');

  const tracer = engineSource.slice(engineSource.indexOf('uploadWorkspaceSceneToCpp'), engineSource.indexOf('renderSingleWebGLPostFXFrame'));
  assert.match(tracer, /this\.renderCamera\(\)/, 'the path tracer resolves the camera the same way');
  assert.match(tracer, /isEditorHelper/, 'and keeps skipping helpers');
});

/* ---------------------------------------------------------------- */
/* The real capture method, executed                                */
/* ---------------------------------------------------------------- */

const METHODS_START = engineSource.indexOf('    renderCamera() {');
const METHODS_END = engineSource.indexOf('    async startStillRender() {');

function captureHarness({ shading = 'rendered', shadowCatcher = true, source = 'scene' } = {}) {
  assert.ok(METHODS_START > 0 && METHODS_END > METHODS_START, 'the capture methods are where the test expects them');
  const methods = engineSource.slice(METHODS_START, METHODS_END).replace(/,\s*$/, '');
  const factory = new Function('window', 'document', 'THREE', `return {${methods}};`);

  const rig = new THREE.PerspectiveCamera(42, 9 / 16, 0.1, 100);
  rig.position.set(-4, 3, 5);
  rig.lookAt(0, 0, 0);
  rig.setViewOffset(900, 1200, -80, 30, 1200, 900);      /* the camera-view frame crop */
  const view = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  view.position.set(6, 4, 6);

  const scene = new THREE.Scene();
  const grid = new THREE.GridHelper(10, 10);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  scene.add(grid, cube);
  const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50));
  shadowFloor.name = 'ShadowFloor';
  scene.add(shadowFloor);

  const seen = [];
  const sizes = [];
  const renderer = {
    domElement: { tagName: 'CANVAS' },
    getSize: (v) => { v.x = 800; v.y = 600; },
    getPixelRatio: () => 2,
    setPixelRatio: () => {},
    setSize: (w, h) => sizes.push([w, h]),
    render: (s, cam) => seen.push({
      grid: grid.visible,
      floor: shadowFloor.visible,
      cam,
      viewEnabled: cam.view ? cam.view.enabled : null,
      aspect: cam.aspect
    })
  };

  const engine = {
    r: renderer, sc: scene, grid, shadowFloor, cursor3d: null, studioFloor: null,
    blenderCam: null, blenderCamLines: null, blenderLight: null,
    sceneCamera: rig, viewportCamera: view,
    getActiveCamera: () => rig,
    getShadingMode: () => shading
  };

  const window = { FE: { engines: { core: engine } }, FERenderCapture: RC, applyShadingMode: () => {} };
  const document = { getElementById: (id) => (id === 'render-cam-source' ? { value: source } : null) };

  const obj = factory(window, document, THREE);
  obj.renderState = { shadowCatcher, tonemap: 0, exposure: 1, contrast: 1, saturation: 1, temperature: 0, bloom: 0, vignette: 0, chromatic: 0, grain: 0 };
  obj.ready = true;
  obj.exports = { fe_arena_reset: () => {}, fe_postprocess_rgba8: () => 0 };
  obj.allocU8 = (n) => ({ ptr: 1, view: new Uint8ClampedArray(n) });

  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {}
    })
  };

  return { obj, canvas, seen, sizes, grid, shadowFloor, rig, view, scene };
}

test('the real capture hides the editor, owns the camera, and puts both back', () => {
  const h = captureHarness({ source: 'scene', shadowCatcher: true });
  const rigProjection = Array.from(h.rig.projectionMatrix.elements);

  assert.equal(h.obj.renderSingleWebGLPostFXFrame(h.canvas, 1920, 1080), true);

  assert.equal(h.seen.length, 1, 'the scene was rendered once');
  const draw = h.seen[0];
  assert.equal(draw.grid, false, 'the floor grid is not in the render');
  assert.equal(draw.floor, true, 'the shadow catcher stays, because the dialog asked for one');
  assert.equal(draw.cam, h.rig, '"Scene Camera 1 Rig" renders the rig');
  assert.equal(draw.viewEnabled, false, 'and without the viewport crop');
  assert.equal(draw.aspect, 1920 / 1080, 'at the output aspect');

  assert.equal(h.grid.visible, true, 'the viewport got its grid back');
  assert.equal(h.rig.view.enabled, true, 'and its camera crop');
  assert.deepEqual(Array.from(h.rig.projectionMatrix.elements), rigProjection, 'with the same projection it had before');
  assert.deepEqual(h.sizes, [[1920, 1080], [800, 600]], 'and the renderer is back at viewport size');
});

test('the capture honours the shadow-catcher switch and the viewport source', () => {
  const off = captureHarness({ source: 'scene', shadowCatcher: false });
  off.obj.renderSingleWebGLPostFXFrame(off.canvas, 1080, 1920);
  assert.equal(off.seen[0].floor, false, 'no catcher means no stray ground plane');
  assert.equal(off.seen[0].aspect, 1080 / 1920, 'a vertical still gets a vertical projection');

  const viewport = captureHarness({ source: 'viewport' });
  viewport.obj.renderSingleWebGLPostFXFrame(viewport.canvas, 1280, 720);
  assert.equal(viewport.seen[0].cam, viewport.rig, 'the draw camera is what the viewport draws with');
  assert.equal(viewport.seen[0].viewEnabled, false);
});

test('a capture that throws still restores the editor', () => {
  const h = captureHarness();
  h.obj.exports.fe_postprocess_rgba8 = () => { throw new Error('compositor exploded'); };
  assert.throws(() => h.obj.renderSingleWebGLPostFXFrame(h.canvas, 640, 360), /compositor exploded/);
  assert.equal(h.grid.visible, true, 'the grid is back');
  assert.equal(h.rig.view.enabled, true, 'the camera crop is back');
  assert.deepEqual(h.sizes.at(-1), [800, 600], 'and so is the viewport size');
});

test('the capture helper ships with the page', () => {
  const tag = '<script src="render-capture.js"></script>';
  assert.ok(html.includes(tag), 'index.html loads it');
  assert.ok(html.indexOf(tag) < html.indexOf('<script src="fe-cpp-engine.js"></script>'), 'before the engine that uses it');
  const sw = readFileSync('sw.js', 'utf8');
  assert.ok(sw.includes("'./render-capture.js'"), 'the service worker caches it');
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(build.includes('"render-capture.js"'), 'and the build copies it');
  const standalone = readFileSync('scripts/standalone-html.mjs', 'utf8');
  assert.ok(standalone.includes("'render-capture.js'"), 'the single-file build inlines it');
});
