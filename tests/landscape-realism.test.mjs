import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* Surface realism: the landscape used to describe grass, snow and granite with
   one random-speckle canvas. These tests pin the replacement — measured PBR
   values, tileable micro-structure generated in C++, and the JS glue that
   paints it into the shipped textures — plus the promise that every layer is a
   user setting and that a stale artifact degrades instead of half-upgrading. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const realismSource = readFileSync('landscape-realism.js', 'utf8');

async function bootBridge() {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  await context.FELandscapeCore.loading;
  assert.equal(context.FELandscapeCore.ready, true);
  return context.FELandscapeCore;
}

test('the engine reports the surface kernels and the 15 measured surfaces', async () => {
  const core = await bootBridge();
  for (const name of ['fe_surface_pbr', 'fe_surface_count', 'fe_surface_detail', 'fe_surface_detail_ptr', 'fe_surface_detail_size', 'fe_water_optical', 'fe_surface_wind_roughness', 'fe_surface_snow_albedo']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
  }
  assert.equal(core.surfaceCount(), 15);
});

test('measured albedo and roughness land in the physical range for each surface', async () => {
  const core = await bootBridge();
  for (let id = 0; id < 15; id++) {
    const s = core.surfacePbr(id, 0, 0, 0);
    assert.equal(s.length, 8);
    assert.ok(s[0] >= 0 && s[0] <= 1 && s[1] >= 0 && s[1] <= 1 && s[2] >= 0 && s[2] <= 1, `albedo ${id}`);
    assert.ok(s[3] >= 0.2 && s[3] <= 1, `roughness ${id}`);
    assert.ok(s[4] > 0 && s[4] < 0.09, `dielectric F0 ${id}`);
    assert.equal(s[7], 1);
  }
  /* Sanity anchors a photographer would recognise. */
  const snow = core.surfacePbr(7, 0, 0, 0);
  assert.ok(snow[0] > 0.7 && snow[1] > 0.7 && snow[2] > 0.7, 'fresh snow is near-white');
  assert.ok(snow[5] > 0.3, 'snow is strongly translucent');
  const granite = core.surfacePbr(4, 0, 0, 0);
  const basalt = core.surfacePbr(5, 0, 0, 0);
  assert.ok(basalt[0] < 0.15 && basalt[1] < 0.15, 'basalt is dark');
  assert.ok(granite[3] < basalt[3], 'weathered basalt is duller than granite');
  assert.ok(snow[3] < granite[3], 'fresh snow is glossy because its grains are single-scatter ice');
  const meadow = core.surfacePbr(0, 0, 0, 0);
  assert.ok(meadow[1] > meadow[0] && meadow[1] > meadow[2], 'meadow grass is green');
});

test('wet ground darkens and films over, and old snow loses albedo', async () => {
  const core = await bootBridge();
  const dry = core.surfacePbr(3, 0, 0, 0);
  const wet = core.surfacePbr(3, 1, 0, 0);
  assert.ok(wet[0] < dry[0] * 0.7, 'a water film darkens the sand');
  assert.ok(wet[3] < 0.1, 'a water film makes sand mirror-glossy');
  assert.ok(wet[4] > dry[4], 'the water film raises F0 towards water');

  const fresh = core.surfacePbr(7, 0, 0, 0);
  const aged = core.surfacePbr(7, 0, 300, 0);
  assert.ok(aged[0] < fresh[0], 'grain growth lowers the snow albedo');
  assert.ok(aged[3] > fresh[3], 'older snow is rougher');
  assert.ok(aged[5] < fresh[5], 'older snow scatters less light through');

  const sooty = core.surfacePbr(7, 0, 300, 1);
  assert.ok(sooty[0] < aged[0], 'impurities accelerate the albedo drop');
});

test('micro-structure maps are deterministic, tileable and sized by the engine', async () => {
  const core = await bootBridge();
  const a = core.surfaceDetail(5, 64, 64, 7, 1);
  const b = core.surfaceDetail(5, 64, 64, 7, 1);
  assert.equal(a.length, 64 * 64 * 4);
  assert.equal(core.detailSize(), 64 * 64);
  assert.equal(JSON.stringify(Array.from(a)), JSON.stringify(Array.from(b)), 'same seed, same bark');
  for (let i = 0; i < a.length; i += 4) {
    const len = Math.hypot(a[i] * 2 - 1, a[i + 1] * 2 - 1, a[i + 2] * 2 - 1);
    assert.ok(Math.abs(len - 1) < 1e-3, 'every texel is a unit normal');
    assert.ok(a[i + 3] >= 0 && a[i + 3] <= 1, 'roughness is normalised');
  }
  /* Seamless: stepping off the right edge must look like any other step, so
     the wrap gradient stays inside the range of the interior gradients. */
  const at = (x, y, c) => a[(y * 64 + x) * 4 + c];
  let interior = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 63; x++) interior = Math.max(interior, Math.abs(at(x, y, 2) - at(x + 1, y, 2)));
  for (let y = 0; y < 64; y++) assert.ok(Math.abs(at(63, y, 2) - at(0, y, 2)) <= interior + 1e-4, `horizontal wrap at row ${y}`);
  for (let x = 0; x < 64; x++) assert.ok(Math.abs(at(x, 63, 2) - at(x, 0, 2)) <= interior + 1e-4, `vertical wrap at column ${x}`);

  const other = core.surfaceDetail(5, 64, 64, 8, 1);
  assert.notEqual(JSON.stringify(Array.from(a)), JSON.stringify(Array.from(other)), 'the seed changes the pattern');

  /* Distinct material families must not collapse to the same texture. */
  const rock = core.surfaceDetail(2, 64, 64, 7, 1);
  const sand = core.surfaceDetail(4, 64, 64, 7, 1);
  const mean = (buf) => { let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i + 3]; return s / (buf.length / 4); };
  assert.ok(Math.abs(mean(rock) - mean(sand)) > 0.02, 'rock and sand must not read as one noise');
  assert.equal(core.surfaceDetail(0, 1024, 16, 1, 1), null, 'oversized requests are rejected');
});

test('Jerlov water types redden with depth and Cox–Munk roughens with wind', async () => {
  const core = await bootBridge();
  const clear = core.waterOptical(0);
  const turbid = core.waterOptical(4);
  assert.equal(clear.length, 6);
  for (let c = 0; c < 3; c++) assert.ok(turbid[0 + c] > clear[0 + c], `turbid water absorbs more in channel ${c}`);
  assert.ok(clear[0] > clear[2] * 8, 'water absorbs red first, which is why depth reads blue');
  const tropical = core.waterOptical(2);
  assert.ok(tropical[2] > clear[2], 'coastal water absorbs blue faster than open ocean');
  assert.ok(core.waterOptical(9)[0] === clear[0], 'an out-of-range type falls back to clear ocean');

  const calm = core.windRoughness(0);
  const fresh = core.windRoughness(10);
  const gale = core.windRoughness(20);
  assert.ok(calm < fresh && fresh < gale, 'wind roughens the surface monotonically');
  assert.ok(calm >= 0.03 && gale <= 0.6, 'the result stays inside the clamp');

  assert.ok(core.snowAlbedo(0.86, 0, 0) > core.snowAlbedo(0.86, 120, 0));
});

/* ------------------------------------------------------------------ */
/* JS glue                                                            */
/* ------------------------------------------------------------------ */
function fakeThree() {
  class Color {
    constructor() { this.r = 1; this.g = 1; this.b = 1; }
    setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
    clone() { const c = new Color(); c.setRGB(this.r, this.g, this.b); return c; }
    copy(o) { return this.setRGB(o.r, o.g, o.b); }
    multiplyScalar(k) { this.setRGB(this.r * k, this.g * k, this.b * k); return this; }
  }
  class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } setScalar(v) { this.x = this.y = v; return this; } }
  class Vector4 { constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; } set(a, b, c, d) { this.x = a; this.y = b; this.z = c; this.w = d; return this; } }
  class Vector3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; } normalize() { return this; } transformDirection() { return this; } }
  return { Color, Vector2, Vector3, Vector4 };
}

function fakeCanvas(width = 256, height = 256) {
  const canvas = {
    width, height,
    __pixels: new Uint8ClampedArray(width * height * 4),
    getContext() {
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: canvas.__pixels.slice(0, w * h * 4) }),
        putImageData: (img) => { canvas.__pixels = img.data; },
        clearRect() {},
        drawImage() {}
      };
    }
  };
  return canvas;
}

function texture(canvas) {
  return { image: canvas, needsUpdate: false };
}

function material(over = {}) {
  return Object.assign({
    name: '', roughness: 0.8, metalness: 0, alphaTest: 0.4, map: {}, userData: {},
    normalScale: new (fakeThree().Vector2)(0.6, 0.6),
    onBeforeCompile(shader) { shader.fragmentShader = '#include <common>x#include <output_fragment>'; }
  }, over);
}

function loadRealism({ withEngine = true, kinds = {} } = {}) {
  const THREE = fakeThree();
  const requests = [];
  const contexts = {
    THREE,
    requestAnimationFrame: (fn) => { requests.push(fn); return requests.length; },
    setTimeout: (fn) => { requests.push(fn); return requests.length; },
    console: { warn() {}, log() {} }
  };
  if (withEngine) {
    contexts.FELandscapeCore = {
      ready: true,
      has: (name) => name === 'fe_surface_pbr',
      surfacePbr: (id) => {
        const table = {
          0: [0.085, 0.15, 0.045, 0.93, 0.04, 0.3, 0.2, 1],
          2: [0.125, 0.098, 0.07, 0.97, 0.038, 0, 0.2, 1],
          4: [0.32, 0.31, 0.3, 0.6, 0.045, 0, 0.2, 1],
          7: [0.83, 0.86, 0.9, 0.46, 0.018, 0.55, 0.2, 1],
          11: [0.052, 0.118, 0.032, 0.55, 0.036, 0.62, 0.2, 1],
          12: [0.03, 0.062, 0.026, 0.62, 0.034, 0.34, 0.2, 1],
          8: [0.072, 0.055, 0.04, 0.96, 0.03, 0, 0.2, 1]
        };
        return table[id] || table[0];
      },
      surfaceDetail: (kind, w, h) => {
        const out = new Float32Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          out[i * 4] = 0.5; out[i * 4 + 1] = 0.5; out[i * 4 + 2] = 0.8 + (i % 5) * 0.02; out[i * 4 + 3] = 0.7;
        }
        return out;
      },
      windRoughness: (u) => Math.min(0.6, Math.max(0.03, Math.sqrt(0.003 + 0.00512 * u) * 1.6)),
      waterOptical: () => [0.305, 0.0545, 0.0145, 0.0035, 0.0038, 0.0032],
      loading: null
    };
  }
  contexts.document = { readyState: 'complete' };
  contexts.window = contexts;
  const context = vm.createContext(contexts);
  vm.runInContext(realismSource, context);
  return { api: context.FELandscapeRealism, context, run: () => { while (requests.length) requests.shift()(); } };
}

test('the module publishes measured surface values, not hidden constants', () => {
  const { api, run } = loadRealism();
  assert.equal(api.surface('snow').translucency, 0.55);
  assert.equal(api.surface('leafBroad').roughness, 0.55);
  assert.deepEqual(Object.values(api.settings), [1, 0, 0, 1, true]);
  /* Every layer is settable and returns the stored value. */
  assert.equal(api.set('wetness', 0.5), 0.5);
  assert.equal(api.set('translucency', 1.2), 1.2);
  assert.equal(api.set('snowAge', 120), 120);
  assert.equal(api.set('detail', 0.4), 0.4);
  assert.equal(api.set('enabled', false), false, 'the master switch is not a slider');
  run();
});

test('the fallback mirror keeps the same physics when no engine is present', () => {
  const { api } = loadRealism({ withEngine: false });
  const dry = api.surface('sand', { wet: 0 });
  const wet = api.surface('sand', { wet: 1 });
  assert.ok(wet.albedo[0] < dry.albedo[0] * 0.7, 'wet sand darkens without the engine too');
  assert.ok(wet.roughness < 0.1);
  const old = api.surface('snow', { snowAge: 300 });
  assert.ok(old.albedo[0] < api.surface('snow', { snowAge: 0 }).albedo[0]);
  assert.equal(api.state.engine, false);
});

test('a stale artifact keeps the old look instead of half-upgrading', async () => {
  const { api, run } = loadRealism({ withEngine: false });
  run();
  const upgraded = await api.upgrade();
  assert.equal(upgraded, false);
  assert.equal(api.state.upgraded, false);
  assert.match(api.state.warnings.join(' '), /surface kernels unavailable/);
});

test('the upgrade paints the C++ micro-structure into the shipped canvases once', async () => {
  const kinds = {};
  for (const name of ['oak', 'pine', 'rock', 'grass']) {
    kinds[name] = { meshes: [{ material: material({ name }) }], lowMeshes: [], shadowMeshes: [] };
  }
  const textureSet = {
    oak: texture(fakeCanvas()), pine: texture(fakeCanvas()), birch: texture(fakeCanvas()),
    palm: texture(fakeCanvas()), char: texture(fakeCanvas()), cactus: texture(fakeCanvas(256, 512))
  };
  const normalSet = Object.fromEntries(Object.entries(textureSet).map(([k, t]) => [k, texture(fakeCanvas(t.image.width, t.image.height))]));
  const roughSet = Object.fromEntries(Object.entries(textureSet).map(([k, t]) => [k, texture(fakeCanvas(t.image.width, t.image.height))]));
  const leaf = { generic: { nm: texture(fakeCanvas()), rm: texture(fakeCanvas()) }, oak: { nm: texture(fakeCanvas()), rm: texture(fakeCanvas()) } };
  const terrain = { grass: texture(fakeCanvas()), soil: texture(fakeCanvas()), rock: texture(fakeCanvas()), snow: texture(fakeCanvas()), rough: texture(fakeCanvas()) };
  const maps = [texture(fakeCanvas()), texture(fakeCanvas())];
  const atlas = texture(fakeCanvas(1056, 264)); /* 4 tiles per row, 264px cell */
  const { api, run, context } = loadRealism({ kinds });
  context.__feLandscapeTex = { BT: textureSet, BN: normalSet, BR: roughSet, LEAF_PBR: leaf };
  context.TERRAIN_PBR = terrain;
  context.OW_SURFACE_MAPS = maps;
  context.OW_SURFACE_ATLAS = atlas;
  context.OW_SURFACE_DEFS = [{ key: 'hills' }, { key: 'desert' }];
  context.KIND = kinds;
  context.tm = {
    roughness: 0.84, color: new (fakeThree().Color)(),
    userData: { feShader: { uniforms: { uSurfRough: { value: new (fakeThree().Vector4)() } } } }
  };
  run();
  /* Each job runs on its own animation frame, so drive the queue before awaiting. */
  const pending = api.upgrade();
  let guard = 0;
  while (!api.state.upgraded && guard++ < 400) run();
  const ok = await pending;
  assert.equal(ok, true);
  assert.equal(api.state.upgraded, true);
  for (const [name, t] of Object.entries(terrain)) {
    assert.ok(t.needsUpdate, `${name} terrain detail must be repainted`);
    const px = t.image.__pixels;
    let spread = 0;
    for (let i = 0; i < 64; i++) spread = Math.max(spread, Math.abs(px[i * 4] - px[0]));
    assert.ok(spread > 0, `${name} must carry real detail variation`);
  }
  assert.ok(textureSet.oak.needsUpdate && normalSet.oak.needsUpdate && roughSet.oak.needsUpdate, 'bark colour, normal and roughness all move together');
  assert.ok(leaf.oak.nm.needsUpdate && leaf.oak.rm.needsUpdate, 'leaf cards get veins');
  assert.ok(atlas.needsUpdate, 'the biome atlas is rebuilt from the repainted tiles');
  /* Materials are grounded in the measured table. */
  const rock = kinds.rock.meshes[0].material;
  assert.ok(Math.abs(rock.roughness - (0.8 + (0.6 - 0.8) * 0.6)) < 1e-6, 'rock roughness comes from the measured granite value');
  assert.equal(rock.metalness, 0);
  const oakMat = kinds.oak.meshes[0].material;
  assert.ok(oakMat.userData.feTrans.value > 0.4, 'leaf cards become translucent');
  /* Grass blades carry no UVs, so the scatter term is the physical win there. */
  assert.ok(kinds.grass.meshes[0].material.userData.feTrans, 'grass blades are back-lit translucent too');
  assert.match(context.tm.userData.feShader.uniforms.uSurfRough.value.x.toFixed(2), /0\.93/, 'terrain roughness follows the measured grass value');
});

test('a lazily built species is grounded when it appears, not only at boot', () => {
  const kinds = {};
  const { api, context, run } = loadRealism();
  context.KIND = kinds;
  run();
  /* The species is built long after boot, when the user first paints it. */
  const mat = material({ name: 'spruce' });
  kinds.spruce = { meshes: [{ material: mat }], lowMeshes: [], shadowMeshes: [] };
  assert.equal(api.refreshKind('spruce'), 1);
  assert.equal(mat.userData.feRole, 'needle', 'a needle species is classified on demand');
  assert.ok(mat.userData.feTranslucency !== undefined, 'and receives its measured translucency');
  assert.equal(api.refreshKind('unknown-species'), 0);
});

test('water roughness follows the wind physically instead of a flat constant', () => {
  const { api } = loadRealism();
  const calm = { roughness: 0.09, wind: 3 };
  const gale = { roughness: 0.09, wind: 18 };
  assert.ok(api.waterRoughness(gale) > api.waterRoughness(calm), 'a gale roughens the sea');
  assert.ok(api.waterRoughness(calm) >= 0.09 * 0.7, 'the authored calm stays close to its intent');
  assert.equal(api.waterRoughness({ roughness: 0.4 }), 0.4, 'a profile without wind keeps its authored value');
  const deep = api.waterColour(0, 12);
  assert.ok(deep[2] > deep[0], 'deep water reads blue, not red');
  assert.equal(Math.max(...deep).toFixed(4), '1.0000', 'the deep colour is normalised');
});

test('the leaf scatter lands in the real three.js fragment shader', () => {
  const { api } = loadRealism();
  const mat = material({
    /* three r128 writes gl_FragColor directly, with no <output_fragment>. */
    onBeforeCompile(shader) { shader.fragmentShader = '#include <common>\nvec3 outgoingLight = vec3(0.);\ngl_FragColor = vec4( outgoingLight, diffuseColor.a );'; }
  });
  const keyBefore = mat.customProgramCacheKey;
  assert.equal(api.patchTranslucency(mat, 0.6), true);
  const shader = { uniforms: {}, fragmentShader: '' };
  mat.onBeforeCompile(shader);
  assert.ok(shader.uniforms.uFeTrans === mat.userData.feTrans, 'the uniform is shared, so a slider can move it');
  assert.equal(shader.uniforms.uFeTrans.value, 0.6);
  assert.match(shader.fragmentShader, /uniform float uFeTrans/);
  assert.ok(shader.fragmentShader.indexOf('outgoingLight +=') < shader.fragmentShader.indexOf('gl_FragColor'),
    'the scatter is added before the final write');
  assert.notEqual(mat.customProgramCacheKey(), keyBefore, 'the shader variant gets its own cache key');
  assert.deepEqual(api.patchTranslucency(mat, 0.9), false, 'patching twice would double the term');
});

test('the leaf scatter lands in the real three.js r128 shader', () => {
  const { api } = loadRealism();
  /* Not a fake string: this is the fragment shader three actually compiles. */
  const base = THREE.ShaderLib.physical.fragmentShader;
  assert.ok(base.includes('gl_FragColor = vec4( outgoingLight, diffuseColor.a );'), 'r128 writes gl_FragColor directly');
  const material = new THREE.MeshPhysicalMaterial({});
  /* wind() in the studio owns the cache key; the scatter must chain onto it. */
  material.customProgramCacheKey = () => 'w5.003leaf25';
  assert.equal(api.patchTranslucency(material, 0.62), true);
  const shader = { uniforms: {}, fragmentShader: base };
  material.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.includes('uFeTrans'), 'the scatter term reaches the compiled shader');
  assert.ok(shader.fragmentShader.indexOf('outgoingLight += diffuseColor.rgb * uFeTrans') < shader.fragmentShader.indexOf('gl_FragColor = vec4( outgoingLight'),
    'the scatter is added before the final colour write');
  assert.equal(material.customProgramCacheKey(), 'w5.003leaf25+trans', 'the wind cache key is preserved');
  assert.equal(shader.uniforms.uFeTrans, material.userData.feTrans, 'the slider updates the live uniform');
  assert.equal(shader.uniforms.uFeTrans.value, 0.62);
});

test('the shipped landscape page loads the module and exposes the controls', () => {
  const html = readFileSync('Terrain_system_.html', 'utf8');
  assert.ok(html.includes('<script src="./landscape-realism.js"></script>'), 'the realism module ships with the studio');
  const bridge = readFileSync('terrain-main-01.js', 'utf8');
  for (const name of ['fe_surface_pbr', 'fe_surface_detail', 'fe_water_optical', 'fe_surface_wind_roughness']) {
    assert.ok(bridge.includes(`'${name}'`), `${name} is in the optional bind list`);
  }
  assert.ok(bridge.includes("customProgramCacheKey=()=>'terrain-triplanar-pbr-v2'"), 'the terrain shader cache key is bumped');
  assert.ok(bridge.includes('uniforms.uSurfRough={value:new THREE.Vector4'), 'the terrain material carries measured per-surface roughness');
  /* The roughness blend runs at <roughnessmap_fragment>, so every mask it reads
     must already be declared by the terrain material's own <color_fragment>
     injection — and three must keep those two hooks in that order. */
  const real = THREE.ShaderLib.physical.fragmentShader;
  assert.ok(real.indexOf('#include <color_fragment>') < real.indexOf('#include <roughnessmap_fragment>'), 'three keeps the two injection points in order');
  const terrain = bridge.slice(bridge.indexOf('const tm=new THREE.MeshStandardMaterial'));
  for (const mask of ['float tGrass=', 'float tSand=', 'float tRock=', 'float tSnow=']) {
    assert.ok(terrain.slice(0, terrain.indexOf('#include <aomap_fragment>')).includes(mask), `${mask} is declared before the roughness blend reads it`);
  }
  assert.ok(bridge.includes('vec4 feSurfW=vec4(tGrass,tSand,tRock,tSnow)'), 'the terrain blend uses the terrain masks');
  assert.ok(!bridge.includes('vec4 feSurfW=vec4(clamp(1.-steep'), 'never borrow the leaf-card shader masks (steep/snowA) for the terrain');
  assert.ok(bridge.includes('dot(feSurfW,uSurfRough)'), 'the terrain blend is a normalised weighted average of the measured values');
  assert.ok(bridge.includes('window.FELandscapeRealism&&window.FELandscapeRealism.refreshKind(k)'), 'lazy species are grounded when built');
  assert.ok(bridge.includes('FELandscapeRealism.waterRoughness'), 'water roughness is resolved through the realism model');
  const models = readFileSync('terrain-main-02.js', 'utf8');
  assert.ok(models.includes('window.__feLandscapeTex={BT,BN,BR,LEAF_PBR'), 'the bark and leaf textures are published for repainting');
  const panel = readFileSync('terrain-main-07.js', 'utf8');
  for (const label of ['Micro detail', 'Wetness', 'Snow age (days)', 'Leaf translucency']) {
    assert.ok(panel.includes(`sl('${label}'`), `${label} must be a slider, never a hidden constant`);
  }
  const realismBlock = panel.slice(panel.indexOf("sl('Micro detail'"), panel.indexOf("sl('Micro detail'") + 1400);
  assert.ok(realismBlock.length > 400, 'the realism controls are found in the shipped panel');
  assert.doesNotMatch(realismBlock, /C\+\+|WASM|kernel/i, 'the controls must not advertise the engine');
});

test('rain wets the PBR surfaces through one uniform, with no rain particles', () => {
  const terrain = readFileSync('terrain-main-01.js', 'utf8');
  const ground = readFileSync('terrain-main-04.js', 'utf8');
  const weather = readFileSync('terrain-main-06.js', 'utf8');

  assert.ok(terrain.includes('const FXU={rain:{value:0},'), 'the rain uniform is declared with the other weather uniforms');
  assert.ok(weather.includes('FXU.rain.value=WX.rain;'), 'the weather tick feeds it the resolved rain intensity');

  /* Bark, needles and rock: glossier while it is raining, glazed on top faces. */
  assert.ok(terrain.includes('u.uRainK=FXU.rain;'), 'the foliage material receives the uniform');
  assert.ok(terrain.includes('uniform float uShed,uShedF,uAut,uSnowK,uBloom,uWet,uRainK;'), 'and declares it in the fragment shader');
  assert.ok(terrain.includes('roughnessFactor*=mix(1.,.55,clamp(uRainK,0.,1.));'), 'rain lowers bark and stone roughness');
  assert.ok(terrain.includes('roughnessFactor=mix(roughnessFactor,roughnessFactor*.35,clamp(uRainK*vSn*1.3,0.,1.));'),
    'upward faces glaze first, because vSn is the up-facing weight');

  /* Ground: soil and stone lose roughness, and puddles get sine ripples. */
  assert.ok(ground.includes('uniform float uDet,uWy,uT,uWetG,uRainK,uSnowG,uAutG,uLit,uSurfacePaintEnabled;'), 'the ground shader declares the uniform');
  assert.ok(ground.includes('s.uniforms.uRainK=U.rain;'), 'and it is the same rain intensity the weather already resolves');
  assert.ok(ground.includes('roughnessFactor*=mix(1.,.62,clamp(uRainK,0.,1.));'), 'rain drops ground roughness');
  assert.ok(ground.includes('roughnessFactor=mix(roughnessFactor,.045,clamp(pud*uRainK,0.,1.));'), 'and a puddle in the rain is near mirror-smooth');
  assert.ok(ground.includes('vec2 rip=vec2(sin(vW.x*7.1+uT*3.3)+.6*sin(vW.x*13.7-uT*4.1)'), 'the ripple is two sines, not geometry');
  assert.ok(ground.includes('rip*.055*clamp(pud*uRainK,0.,1.)'), 'and it is displaced only inside a puddle while raining');

  /* The falling water itself stays a small instanced batch. */
  assert.ok(weather.includes('const NR=7000'), 'the streak batch is 7 000 segments');
  assert.ok(weather.includes('rainMesh.visible=WX.rain>.02'), 'and it disappears when the rain stops');
  assert.equal(/for\s*\(.*NR.*\]\s*\{\s*new /.test(weather), false, 'no per-particle allocation');
});

test('the base pixels exist before any deferred painting runs', () => {
  /* shadeColour() multiplies into the pixels that are already on the canvas and
     caches them as __feOriginal. If the base colour arrives late -- or never,
     because the C++ pass discarded the queue -- every tile comes out black, and
     the land loses its material. The base fill is one fillRect: it belongs in
     the factory, not in the deferred job. */
  const terrainSource = readFileSync('terrain-main-01.js', 'utf8');
  const realismSource = readFileSync('landscape-realism.js', 'utf8');
  const factory = (name, end) => {
    const start = terrainSource.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    return terrainSource.slice(start, terrainSource.indexOf(end, start));
  };
  for (const [name, end] of [['terrainDetailTex', 'const TERRAIN_PBR='], ['owSurfaceTexture', 'const OW_PAINT_RGB=']]) {
    const body = factory(name, end);
    const fill = body.indexOf('x.fillRect(0,0,256,256)');
    const deferred = body.indexOf('BOOT_PAINT.add(()=>{');
    assert.ok(fill > 0, `${name} paints a base colour`);
    assert.ok(deferred > 0, `${name} defers its detail`);
    assert.ok(fill < deferred, `${name} paints the base before deferring the detail`);
    assert.equal(body.slice(deferred).includes('x.fillRect(0,0,256,256)'), false,
      `${name} does not fill the base twice`);
  }
  assert.ok(realismSource.includes('root.FE_BOOT_PAINT.discard()'), 'the queue is only dropped once the C++ kernels are about to paint');
});
