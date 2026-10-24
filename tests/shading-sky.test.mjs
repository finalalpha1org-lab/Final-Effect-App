import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* Solid shading used to throw the sky away. Switching to Solid (or Wireframe)
   ran applyLandscapeAwareShadingWorld(), which set scene.environment = null —
   correct, Workbench has no image-based light — and then painted
   scene.background a flat dark colour, which is not correct: Blender's
   viewport keeps the world background in every shading mode. This pins the
   split between "the sky is visible" and "the sky lights the model". */

const html = readFileSync('index.html', 'utf8');

const START = html.indexOf('/* =========================================================\n   8. COMPREHENSIVE VIEWPORT SHADING ENGINE');
const END = html.indexOf("/* HDRI Preset generator */", START);
const shadingSource = html.slice(START, END);

function makeTexture(fake) {
  return { isTexture: true, mapping: fake.THREE.EquirectangularReflectionMapping, encoding: null, image: { width: 512, height: 256 } };
}

function harness(shadingMode = 'solid') {
  class Color {
    constructor(value) { this.isColor = true; this.value = value; }
    set() { return this; }
    setHex(v) { this.value = v; return this; }
    clone() { const c = new Color(this.value); return c; }
    copy(other) { this.value = other.value; return this; }
  }
  const THREE = {
    Color,
    CanvasTexture: class CanvasTexture {
      constructor(canvas) { this.isTexture = true; this.image = canvas; this.mapping = null; this.encoding = null; }
    },
    EquirectangularReflectionMapping: 302,
    sRGBEncoding: 3001,
    DoubleSide: 2
  };
  const gradients = [];
  const document = {
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() {
      return {
        width: 0, height: 0,
        getContext: () => ({
          createLinearGradient() {
            const gradient = { stops: [], addColorStop(o, c) { gradient.stops.push([o, c]); } };
            gradients.push(gradient);
            return gradient;
          },
          createRadialGradient() {
            return { addColorStop() {} };
          },
          fillRect() {},
          beginPath() {},
          arc() {},
          fill() {},
          set fillStyle(value) {},
          get fillStyle() { return null; }
        })
      };
    }
  };
  const scene = { environment: null, background: null, userData: {}, getObjectByName() { return null; } };
  const eng = { sc: scene, r: {}, d: {}, fillLight: {}, amb: {}, shadowFloor: {}, studioFloor: {} };
  const FE = { engines: { core: eng } };
  const window = { FE, activeLight: null };
  const ctx = vm.createContext({
    THREE, document, window, FE, Math, Number, String, Array, Object, Map, Set,
    console, isFinite, parseFloat, parseInt, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  });
  ctx.currentShadingMode = shadingMode;
  vm.runInContext(shadingSource, ctx);
  return { ctx, eng, scene, FE };
}

test('with no sky chosen, Solid still falls back to a flat colour', () => {
  const { ctx, eng, scene } = harness('solid');
  ctx.currentShadingMode = 'solid';
  ctx.applyLandscapeAwareShadingWorld(eng, 0x0a0b0e);
  assert.equal(scene.environment, null, 'Workbench has no image-based lighting');
  assert.equal(scene.background instanceof ctx.THREE.Color, true);
  assert.equal(scene.background.value, 0x0a0b0e);
});

test('a chosen sky is the Solid backdrop but never the Solid light', () => {
  const { ctx, eng, scene } = harness('solid');
  ctx.currentShadingMode = 'solid';
  const texture = makeTexture(ctx);
  ctx.rememberSkyTexture(eng, texture);

  ctx.applyLandscapeAwareShadingWorld(eng, 0x0a0b0e);
  assert.equal(scene.background, texture, 'the skybox is visible in Solid');
  assert.equal(scene.environment, null, 'and it does not light the model');
  assert.equal(eng.skyTexture, texture);
  assert.equal(scene.userData.feSkyTexture, texture);
});

test('Wireframe keeps the same backdrop rule', () => {
  const { ctx, eng, scene } = harness('wireframe');
  ctx.currentShadingMode = 'wireframe';
  const texture = makeTexture(ctx);
  ctx.rememberSkyTexture(eng, texture);
  ctx.applyLandscapeAwareShadingWorld(eng, 0x0a0b0e);
  assert.equal(scene.background, texture);
  assert.equal(scene.environment, null);
});

test('picking an HDRI preset in Solid changes the backdrop only', () => {
  const { ctx, eng, scene } = harness('solid');
  ctx.currentShadingMode = 'solid';
  ctx.applyHdriPreset('forest', true);

  assert.equal(scene.environment, null, 'no IBL in Solid');
  assert.equal(scene.background.isTexture, true, 'but the sky is on screen');
  assert.equal(scene.userData.feSkyTexture, scene.background);

  /* And Material Preview must not silently reset the choice to the studio sky. */
  ctx.currentShadingMode = 'material';
  ctx.applyShadingMode;
  const remembered = scene.userData.feSkyTexture;
  ctx.applyLandscapeAwareShadingWorld(eng, 0x0a0b0e);
  assert.equal(scene.userData.feSkyTexture, remembered);
});

test('Material Preview seeds a studio sky when none was ever chosen', () => {
  const { ctx, eng, scene } = harness('material');
  ctx.currentShadingMode = 'material';
  assert.equal(scene.userData.feSkyTexture, undefined);
  ctx.applyHdriPreset('studio', true);
  assert.equal(scene.environment.isTexture, true, 'Material Preview lights from the sky');
  assert.equal(scene.background.isTexture, true);
});

test('the imported-landscape world still wins over the studio sky', () => {
  const { ctx, eng, scene } = harness('solid');
  const imported = makeTexture(ctx);
  ctx.rememberSkyTexture(eng, makeTexture(ctx));
  scene.getObjectByName = () => ({ _landscapeEnvironmentTexture: imported });
  ctx.applyLandscapeAwareShadingWorld(eng, 0x0a0b0e);
  assert.equal(scene.background, imported);
  assert.equal(scene.environment, imported, 'the landscape world keeps lighting the scene');
});
