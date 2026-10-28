import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* A building's windows carry a real metalness map (metalness 0.59, roughness
   0.13) and there was nothing in the scene for them to reflect: three only
   reflects an environment that has one, and the studio had set
   scene.environment = null. Metal without an environment is flat grey paint,
   which is the difference between glass and cardboard.

   The sky the dome draws is closed-form, so the same four values are baked
   into a small equirect and prefiltered once with PMREM. These tests run that
   bake against a fake canvas: the picture has to be a sky (zenith brighter than
   the horizon, a sun disc where the sun is, a horizon band below it), and it has
   to reach the building materials and nothing else. */

const main = readFileSync('terrain-main-04.js', 'utf8');
const block = main.slice(
  main.indexOf('/* ---- Sky environment: what metal and glass reflect'),
  main.indexOf('window.__feSkyEnv = skyEnvSource;') + 'window.__feSkyEnv = skyEnvSource;'.length
);

function canvasFake() {
  const created = [];
  const element = { width: 0, height: 0, getContext: () => context };
  const context = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => { element.pixels = img; }
  };
  created.push(element);
  return { element, created };
}

function run({ tod = 12, az = 0, over = 0, rain = 0, mode = 'render', bmat = [], canvas } = {}) {
  const sky = canvas || canvasFake();
  const textures = [];
  const pmremCalls = [];
  class CanvasTexture {
    constructor(c) { this.image = c; this.mapping = null; textures.push(this); }
    dispose() { this.disposed = true; }
  }
  class PMREMGenerator {
    fromEquirectangular(src) {
      pmremCalls.push(src);
      return { texture: { isTexture: true, from: src }, dispose() { this.disposed = true; } };
    }
  }
  const THREE = {
    CanvasTexture, PMREMGenerator,
    EquirectangularReflectionMapping: 303,
    SRGBColorSpace: 'srgb'
  };
  /* The uniforms the dome shader reads, at noon with the sun overhead. */
  const col = (r, g, b) => ({ r, g, b, isColor: true });
  const U = {
    top: { value: col(0.08, 0.26, 0.7) },
    hor: { value: col(0.55, 0.75, 0.95) },
    sun: { value: col(1, 0.8, 0.55) },
    sd: { value: { x: Math.cos(((tod - 6) / 12) * Math.PI), y: Math.sin(((tod - 6) / 12) * Math.PI), z: 0 } }
  };
  const errors = [];
  const scope = {
    THREE, U, BMAT: bmat, tod, az, mode, ren: { isRenderer: true },
    WX: { over, rain },
    performance: { now: () => 1000 },
    document: { createElement: () => sky.element },
    window: {},
    showErr: (m) => errors.push(m),
    cl: (v, a, b) => Math.min(b, Math.max(a, v))
  };
  const names = Object.keys(scope);
  const fn = new Function(...names, `${block}\nreturn { skyEnvSource, SKY_ENV, applySkyEnv };`);
  const api = fn(...names.map((n) => scope[n]));
  return { api, sky, textures, pmremCalls, errors, U, bmat };
}

function pixels(sky) {
  const img = sky.element.pixels;
  assert.ok(img, 'the bake wrote an image');
  return img;
}

test('the bake is a sky: a deep-blue zenith, a pale horizon, and ground lit like the horizon', () => {
  /* 09:00, so the sun stands at 45 degrees and the zenith is ordinary sky. */
  const { api, sky } = run({ tod: 9 });
  const tex = api.skyEnvSource(true);
  assert.ok(tex, 'the environment was produced');
  const img = pixels(sky);
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  const zenith = at(4, 0);
  const horizon = at(4, Math.floor(img.height / 2) - 1);
  const below = at(4, Math.floor(img.height / 2) + 1);
  const nadir = at(4, img.height - 1);
  assert.equal(zenith[3], 255, 'the sky is opaque');
  /* The dome shader mixes hor -> top with pow(d.y,.55): the horizon is pale
     (high red), the zenith is deep blue (low red, and a bigger blue-red gap). */
  assert.ok(zenith[0] < horizon[0], `the zenith is deeper than the horizon (${zenith[0]} vs ${horizon[0]})`);
  assert.ok(zenith[2] - zenith[0] > horizon[2] - horizon[0], 'and it is the bluer of the two');
  /* Below the horizon the dome clamps d.y at 0, so the bake is horizon-lit
     ground, not a second sky. */
  assert.deepEqual(nadir.slice(0, 3), below.slice(0, 3), 'everything under the horizon is one flat ground tone');
  assert.ok(below[0] > zenith[0], 'and that ground tone is the pale horizon colour, not the zenith');
});

test('the sun is a disc where the sun is, and it is the brightest thing in the bake', () => {
  const { api, sky } = run({ tod: 9, az: 0 });
  api.skyEnvSource(true);
  const img = pixels(sky);
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const lum = img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
      if (lum > best) { best = lum; bx = x; by = y; }
    }
  }
  /* tod 9 puts the sun at 45 degrees elevation, due east (az 0): row ~H/4 and
     the centre column of the equirect. */
  assert.ok(by > img.height * 0.18 && by < img.height * 0.36, `sun sits at 45 degrees (row ${by} of ${img.height})`);
  assert.ok(Math.abs(bx - img.width / 2) <= 3, `sun is near the centre column (x ${bx})`);
  /* Far from the disc the sky is only a sky. */
  const away = (y, x) => {
    const i = (y * img.width + x) * 4;
    return img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
  };
  assert.ok(best > away(img.height - 2, 4) + 40, 'the disc is much brighter than the ground');
});

test('the environment reaches the buildings and never the whole scene', () => {
  const bmat = [{ envMapIntensity: 1.1 }, { envMapIntensity: 1.1 }, { envMapIntensity: 1.1 }];
  const { api } = run({ bmat });
  api.skyEnvSource(true);
  for (const m of bmat) {
    assert.equal(m.envMap, api.SKY_ENV.tex, 'a building material reflects the sky');
    assert.ok(m.envMapIntensity <= 0.55, 'the sky can glint on a window without turning plaster into a mirror');
    assert.equal(m.needsUpdate, true, 'the shader is told to pick the map up');
  }
  assert.match(main, /^scene\.environment=null;$/m,
    'the terrain keeps its own lighting: a global environment washes the painted biomes out');
});

test('an unmaterialised list is caught on the next sky update, not left bare', () => {
  const bmat = [];
  const { api } = run({ bmat });
  api.skyEnvSource(true);
  assert.equal(api.SKY_ENV.applied, 0);
  /* The world is built after the first sky update, so the material list grows
     afterwards. A second call must attach the environment it already baked. */
  bmat.push({ envMapIntensity: 1.1 });
  api.skyEnvSource();
  assert.equal(bmat[0].envMap, api.SKY_ENV.tex, 'the late material still gets the sky');
});

test('a broken canvas fails once, loudly, and never breaks the frame loop', () => {
  const bad = { width: 0, height: 0, getContext: () => { throw new Error('no 2d context'); } };
  const { api, errors } = run({ canvas: { element: bad } });
  assert.equal(api.skyEnvSource(true), null);
  assert.equal(errors.length, 1, 'the first failure is reported');
  assert.match(errors[0], /Sky reflections/);
  /* Three strikes and the studio stops trying: a device without a 2D canvas
     must not log on every sky change. */
  api.skyEnvSource(true);
  api.skyEnvSource(true);
  api.skyEnvSource(true);
  assert.equal(errors.length, 1, 'a repeated failure is silent');
});
