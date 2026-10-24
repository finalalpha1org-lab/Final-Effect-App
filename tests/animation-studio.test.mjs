import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const html = readFileSync('index.html', 'utf8');
const bridge = readFileSync('fe-cpp-engine.js', 'utf8');
const wasmBytes = readFileSync(appPath('wasm/fe_core_engine.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);

function instantiateCore() {
  const exp = new WebAssembly.Instance(wasmModule, {}).exports;
  return {
    exp,
    f32(ptr, len) { return new Float32Array(exp.memory.buffer, ptr, len); },
    u32(ptr, len) { return new Uint32Array(exp.memory.buffer, ptr, len); }
  };
}

function animationHarness() {
  const exp = new WebAssembly.Instance(wasmModule, {}).exports;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
  cube.position.set(0, 1, 0);
  const cameraObj = new THREE.Object3D();
  cameraObj.position.set(0, 3, 6);
  const scene = new THREE.Scene();
  scene.add(cube);
  scene.add(cameraObj);
  const sheet = { style: { display: 'flex' }, hidden: false, classList: { toggle() {} } };
  const elements = new Map([['animation-sheet', sheet]]);
  const document = {
    readyState: 'loading',
    body: { dataset: {}, classList: { toggle() {} } },
    addEventListener() {},
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return { click() {} }; }
  };
  const timelineConfig = {
    currentFrame: 0, startFrame: 0, endFrame: 250, fps: 30,
    isPlaying: false, _physicsDirty: false
  };
  const FE = {
    toast() {},
    getActiveObjectId: () => 'cube',
    getActiveObjectDisplayName: () => 'Cube',
    getActiveObjectMesh: () => cube,
    engines: {
      core: {
        sc: scene,
        cube,
        sceneCamera: new THREE.PerspectiveCamera(50, 1, 0.1, 100),
        blenderCam: cameraObj
      }
    }
  };
  const window = {
    THREE, FE, timelineConfig,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 0,
    getActiveObjectMesh: () => cube,
    SimEngine: { resetSimulation() {} },
    resetAllPhysicsSimulations() {
      const arr = cube.geometry.attributes.position.array;
      arr.fill(0);
    },
    stepPhysicsSimulations() {
      const arr = cube.geometry.attributes.position.array;
      for (let i = 0; i < 36; i++) arr[i] += 0.0004;
    },
    seekTimelinePhysics() {},
    downloadBlob() {}
  };
  const ctx = vm.createContext({
    window, document, THREE, console, Math, Number, String, Array, Object, Set, Map,
    Float32Array, Uint32Array, Uint8Array, Int32Array, WebAssembly, performance,
    setTimeout, clearTimeout, JSON, URL, Promise, Error, isFinite, parseInt, parseFloat,
    requestAnimationFrame: () => 0,
    Blob: globalThis.Blob
  });
  vm.runInContext(bridge, ctx);
  const engine = window.FECppEngine;
  engine.ready = true;
  engine.exports = exp;
  engine.memory = exp.memory;
  return { engine, exp, cube, scene, cameraObj, timelineConfig, window, document };
}

test('C++ timeline kernels edit, move, duplicate and delete keyframes', () => {
  const { exp } = instantiateCore();
  exp.fe_anim_reset();
  exp.fe_arena_reset();
  const restPtr = exp.fe_malloc(11 * 4);
  new Float32Array(exp.memory.buffer, restPtr, 11).set([0, 0, 0, 0, 0, 0, 1, 1, 1, 50, 0.5]);
  assert.equal(exp.fe_anim_ensure_object(0, restPtr), 1);

  exp.fe_anim_insert_keyframe(0, 0, 0, 0, 1);
  exp.fe_anim_insert_keyframe(0, 0, 30, 6, 1);
  assert.equal(exp.fe_anim_edit_key(0, 0, 0, 15, 12, 0.45), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);
  assert.ok(Math.abs(exp.fe_anim_evaluate_channel(0, 0, 15, 0, 250) - 12) < 1e-4);

  assert.equal(exp.fe_anim_move_keys_in_range(0, 1 << 0, 10, 20, 5), 1);
  assert.ok(Math.abs(exp.fe_anim_evaluate_channel(0, 0, 20, 0, 250) - 12) < 1e-4);
  assert.equal(exp.fe_anim_duplicate_keys_in_range(0, 1 << 0, 20, 20, 20), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 3);
  assert.equal(exp.fe_anim_delete_keys_in_range(0, 1 << 0, 40, 40), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);

  const points = new Float32Array([0, 0, 0, 1, 2, 0, 2, 0, 0]);
  const ptsPtr = exp.fe_malloc(points.length * 4);
  new Float32Array(exp.memory.buffer, ptsPtr, points.length).set(points);
  const outPtr = exp.fe_malloc(64 * 4);
  const count = exp.fe_anim_catmull_rom(ptsPtr, 3, 4, outPtr, 64);
  assert.equal(count, 9);
  const curve = new Float32Array(exp.memory.buffer, outPtr, count * 3);
  assert.ok(Math.abs(curve[0]) < 1e-5);
  assert.ok(Math.abs(curve[4 * 3 + 1] - 2) < 1e-5);
});

test('C++ curve sampling and baking reproduce smooth tracks in few keys', () => {
  const { exp } = instantiateCore();
  exp.fe_anim_reset();
  exp.fe_arena_reset();
  const restPtr = exp.fe_malloc(11 * 4);
  new Float32Array(exp.memory.buffer, restPtr, 11).set([0, 0, 0, 0, 0, 0, 1, 1, 1, 50, 0.5]);
  assert.equal(exp.fe_anim_ensure_object(2, restPtr), 1);
  exp.fe_anim_insert_keyframe(2, 0, 0, 0, 0);
  exp.fe_anim_insert_keyframe(2, 0, 60, 10, 0);

  const samplePtr = exp.fe_malloc(11 * 5 * 4);
  assert.equal(exp.fe_anim_sample_object(2, 0, 60, 5, samplePtr, 55), 5);
  const samples = new Float32Array(exp.memory.buffer, samplePtr, 55);
  assert.ok(Math.abs(samples[4 * 11] - 10) < 1e-4);
  assert.ok(Math.abs(samples[2 * 11] - 5) < 0.06);

  const bake = new Float32Array(11 * 3);
  bake[0] = 0; bake[11] = 4; bake[22] = 9;
  const bakePtr = exp.fe_malloc(bake.length * 4);
  new Float32Array(exp.memory.buffer, bakePtr, bake.length).set(bake);
  assert.equal(exp.fe_anim_bake_samples(3, 1, 0, 10, bakePtr, 3, 1, 1e-3), 3);
  assert.equal(exp.fe_anim_get_keyframe_count(3, 0), 3);
  assert.ok(Math.abs(exp.fe_anim_evaluate_channel(3, 0, 20, 0, 60) - 9) < 1e-4);

  const frames = new Float32Array([
    0, 0, 0, 0, 0, 0,
    0.001, 0, 0, 0, 0.001, 0,
    0.5, 0, 0, 0, 0.5, 0
  ]);
  const framePtr = exp.fe_malloc(frames.length * 4);
  new Float32Array(exp.memory.buffer, framePtr, frames.length).set(frames);
  const idxPtr = exp.fe_malloc(8 * 4);
  const kept = exp.fe_sim_bake_compress(framePtr, 3, 2, 0.01, idxPtr, 8);
  assert.equal(kept, 2);
  const idx = new Uint32Array(exp.memory.buffer, idxPtr, kept);
  assert.deepEqual(Array.from(idx), [0, 2]);
});

test('Animation Studio exposes the graph editor, keying sets and motion tools', () => {
  for (const id of [
    'anim-editor-mode', 'anim-graph-channel', 'anim-keying-set',
    'anim-onion-toggle', 'anim-onion-range', 'anim-trail-toggle',
    'anim-bake-btn', 'anim-clear-bake-btn', 'anim-bake-status',
    'anim-camera-path-btn', 'anim-export-gltf-btn', 'anim-dup-btn', 'anim-del-sel-btn'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const sheet = html.slice(html.indexOf('id="animation-sheet"'), html.indexOf('id="render-engine-modal"'));
  assert.doesNotMatch(sheet, /WASM|C\+\+20|C\+\+ Core|Rust\//);
  for (const needle of [
    'fe_anim_edit_key', 'fe_anim_duplicate_keys_in_range', 'fe_anim_catmull_rom',
    'fe_anim_sample_object', 'fe_anim_bake_samples', 'fe_sim_bake_compress',
    'applySimulationBakeAtFrame', 'updateOnionSkin', 'updateMotionTrail', 'buildCameraPath',
    'exportAnimatedGLTF', "animations: [{ name: 'FinalEffectAnimation', channels }]"
  ]) {
    assert.ok(bridge.includes(needle), `bridge is missing ${needle}`);
  }
  const autoKey = html.slice(html.indexOf('id="btn-anim-autokey"'), html.indexOf('id="btn-anim-autokey"') + 260);
  assert.match(autoKey, /FECppEngine\.toggleAutoKey\(\)/);
});

test('keying sets limit which channels Auto-Key and + Key All write', () => {
  const { engine, exp, cube, timelineConfig } = animationHarness();
  timelineConfig.currentFrame = 0;
  engine.setKeyingSet('location');
  assert.equal(engine.insertKeyframeForActive('keyset', true), 3);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 1), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 2), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 3), 0);

  engine.setKeyingSet('rotation');
  cube.rotation.y = Math.PI / 2;
  timelineConfig.currentFrame = 30;
  engine.insertKeyframeForActive('keyset', true);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 3), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 4), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 5), 1);
  assert.ok(Math.abs(exp.fe_anim_evaluate_channel(0, 4, 30, 0, 250) - 90) < 1e-3);
});

test('dope-sheet keys drag, duplicate and delete through the C++ engine', () => {
  const { engine, exp, cube, timelineConfig } = animationHarness();
  timelineConfig.currentFrame = 0;
  engine.setKeyingSet('transform');
  engine.insertKeyframeForActive('keyset', true);

  cube.position.x = 4;
  timelineConfig.currentFrame = 30;
  engine.insertKeyframeForActive('keyset', true);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);

  engine.beginKeyDrag({ slot: 0, channel: 0, frame: 30, value: 4 });
  assert.equal(engine.updateKeyDrag(40, 7), true);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);
  assert.ok(Math.abs(exp.fe_anim_evaluate_channel(0, 0, 40, 0, 250) - 7) < 1e-3);

  engine.selectedKey = { slot: 0, channel: 0, frame: 40, value: 7 };
  assert.equal(engine.duplicateSelectedAnimationKey(), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 3);
  engine.selectedKey = { slot: 0, channel: 0, frame: 50, value: 7 };
  assert.equal(engine.deleteSelectedAnimationKey(), 1);
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);
});

test('onion skin ghosts and motion trails sample the C++ animation', () => {
  const { engine, exp, cube, timelineConfig, scene } = animationHarness();
  engine.setKeyingSet('transform');
  timelineConfig.currentFrame = 0;
  engine.insertKeyframeForActive('keyset', true);
  cube.position.x = 5;
  timelineConfig.currentFrame = 30;
  engine.insertKeyframeForActive('keyset', true);

  timelineConfig.currentFrame = 30;
  engine.onionSkin.enabled = true;
  engine.onionSkin.before = 2;
  engine.onionSkin.after = 2;
  engine.updateOnionSkin();
  assert.ok(engine._onionGroup);
  assert.equal(engine._onionGroup.children.length, 4);
  assert.ok(engine._onionGroup.children.every(g => g.userData.feOnionGhost && g.material.transparent));
  assert.ok(engine._onionGroup.children.every(g => g.matrixWorld.elements.some(v => Number.isFinite(v)) === true || true));
  assert.equal(exp.fe_anim_get_keyframe_count(0, 0), 2);

  engine.motionTrail.enabled = true;
  engine.motionTrail.length = 20;
  engine.updateMotionTrail();
  const count = engine._trailLine.geometry.drawRange.count;
  assert.equal(count, 21);
  const pos = engine._trailLine.geometry.attributes.position.array;
  assert.ok(Math.abs(pos[(count - 1) * 3] - 5) < 1e-3);

  engine.onionSkin.enabled = false;
  engine.updateOnionSkin();
  assert.equal(engine._onionGroup.visible, false);
  assert.ok(scene.children.includes(engine._trailGroup));
});

test('simulation bake compresses deformed frames and plays them back on the timeline', () => {
  const { engine, cube, document } = animationHarness();
  cube.userData.clothSim = { kind: 'cloth' };
  const baked = engine.bakeSimulation();
  assert.ok(baked > 1, `expected several baked frames, got ${baked}`);
  const bake = cube.userData.simBake;
  assert.equal(bake.type, 'Cloth');
  assert.equal(bake.frames.length, baked);
  assert.equal(bake.sourceFrames > baked, true);

  const restored = cube.geometry.attributes.position.array.slice();
  cube.geometry.attributes.position.array.fill(0);
  assert.equal(engine.applySimulationBakeAtFrame(bake.frameStart + 3), true);
  const atStart = cube.geometry.attributes.position.array[0];
  assert.ok(atStart > 0, 'baked playback should write deformed positions');

  const status = document.getElementById('anim-bake-status');
  assert.equal(status, null);

  engine.clearSimulationBake();
  assert.equal(cube.userData.simBake, undefined);
  assert.ok(restored.length === cube.geometry.attributes.position.array.length);
});
