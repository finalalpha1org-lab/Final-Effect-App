import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

/* Water presets are bodies of water, not colour swatches. Each one names a
   Jerlov optical type, a CDOM load and a suspended-sediment load, and the
   colours the shader receives are derived from those with Beer-Lambert. These
   tests hold the derivation to the published behaviour: clear water is blue
   because red is absorbed first, silt turns the shallows brown, a bog is brown
   because gilvin eats the blue end, and the Secchi depth orders the presets the
   way a limnologist would. */

const html = readFileSync(appPath('Terrain_system_.html'), 'utf8');
const source = readFileSync(appPath('terrain-main-01.js'), 'utf8');
const wasm = readFileSync('fe_core_engine.wasm');

function waterApi(extra = {}) {
  const start = source.indexOf('const WATER_SILT=');
  const end = source.indexOf('function setWater(', start);
  assert.ok(start > 0 && end > start, 'the water physics block must exist');
  const block = source.slice(start, end);
  const window = {};
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  const api = new Function('cl', 'window', `${block};return { WATER_PROFILES, waterProfileFor, waterOpticalFor, waterColumnColour, waterShallowColour, beaufortOf };`)(cl, window);
  return { ...api, window, ...extra };
}

async function bootKernel() {
  const bridge = source.split('/* END LANDSCAPE CORE BRIDGE */')[0];
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout, TextDecoder, TextEncoder,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
  };
  vm.createContext(context);
  vm.runInContext(bridge, context);
  await context.FELandscapeCore.loading;
  return context.FELandscapeCore;
}

test('the studio offers real water bodies, each with measured optical properties', () => {
  const api = waterApi();
  const profiles = api.WATER_PROFILES;
  assert.ok(profiles.length >= 7, 'more than the original three presets');
  const names = profiles.map((p) => p.name);
  for (const name of ['Ocean', 'Lagoon', 'Murky', 'Reef', 'Alpine Lake', 'River', 'Estuary', 'Peat Bog']) {
    assert.ok(names.includes(name), `missing preset ${name}`);
  }
  for (const p of profiles) {
    for (const field of ['jerlov', 'cdom', 'sediment', 'tempC', 'salinityPSU', 'fetchKm', 'wind']) {
      assert.equal(typeof p[field], 'number', `${p.name} needs a numeric ${field}`);
    }
    assert.ok(p.jerlov >= 0 && p.jerlov <= 7, `${p.name} uses a real Jerlov type`);
    assert.ok(p.tempC > -2 && p.tempC < 40, `${p.name} is inside liquid water`);
    assert.ok(p.salinityPSU >= 0 && p.salinityPSU <= 40, `${p.name} salinity is physical`);
  }
});

test('colours come from the optics: red is absorbed first, silt browns the shallows', () => {
  const api = waterApi();
  const ocean = api.waterProfileFor(0);
  const lagoon = api.waterProfileFor(1);
  const murky = api.waterProfileFor(2);
  const reef = api.waterProfileFor(3);
  const river = api.waterProfileFor(5);
  const bog = api.waterProfileFor(7);

  /* Deep water: blue survives, red does not. */
  assert.ok(ocean.deep[2] > ocean.deep[0] * 8, 'the ocean is blue at depth');
  assert.ok(lagoon.deep[2] >= lagoon.deep[0] * 4, 'a lagoon keeps its blue-green depth tint');
  assert.ok(reef.deep[2] > reef.deep[0] * 4, 'reef water is blue at depth');

  /* Shallow water is the bed seen through the column: green/blue over sand,
     brown where silt dominates. */
  assert.ok(ocean.shallow[1] > ocean.shallow[0] && ocean.shallow[2] > ocean.shallow[0], 'shallow ocean reads cyan');
  assert.ok(lagoon.shallow[1] > lagoon.shallow[0], 'lagoon shallows are turquoise, not blue');
  for (const p of [murky, river]) {
    assert.ok(p.shallow[0] > p.shallow[2], `${p.name} shallows are silty brown`);
  }
  /* Gilvin (CDOM) is a blue absorber: a peat bog is red-brown at depth. */
  assert.ok(bog.deep[0] > bog.deep[2] * 4, 'a peat bog is tea-brown, not blue');
  assert.ok(bog.shallow[0] > bog.shallow[1] && bog.shallow[1] > bog.shallow[2], 'bog shallows run red > green > blue');

  /* Brightness is preserved from the authored exposure, only the hue is physical. */
  for (const p of api.WATER_PROFILES) {
    const hydrated = api.waterProfileFor(api.WATER_PROFILES.indexOf(p));
    assert.ok(Math.abs(Math.max(...hydrated.deep) - Math.max(...p.deep)) < 1e-6, `${p.name} keeps its deep exposure`);
  }
});

test('Secchi depth, turbidity and transparency follow from the same numbers', () => {
  const api = waterApi();
  const byName = Object.fromEntries(api.WATER_PROFILES.map((p, i) => [p.name, api.waterProfileFor(i)]));
  assert.ok(byName.Ocean.secchi > byName.Lagoon.secchi, 'open ocean is clearer than a lagoon');
  assert.ok(byName.Lagoon.secchi > byName.River.secchi, 'a lagoon is clearer than a river');
  assert.ok(byName.River.secchi > byName.Murky.secchi, 'a river is clearer than harbour water');
  assert.ok(byName['Peat Bog'].secchi < byName.Ocean.secchi / 4, 'a bog is stained and shallow-sighted');
  for (const [name, p] of Object.entries(byName)) {
    assert.ok(p.secchi > 0.2 && p.secchi < 80, `${name} Secchi depth is plausible`);
    assert.ok(p.clarity >= 0.3 && p.clarity <= 4, `${name} clarity stays inside the shader range`);
    assert.ok(p.turbidity >= 0.02 && p.turbidity <= 1, `${name} turbidity stays normalised`);
    assert.ok(p.transparency >= 0.08 && p.transparency <= 1, `${name} transparency stays normalised`);
  }
  assert.ok(byName.Murky.turbidity > byName.Ocean.turbidity, 'silt scatters more than open water');
  assert.ok(byName.Murky.transparency < byName.Ocean.transparency, 'you see less far into harbour water');
});

test('the derived optics are the C++ kernel, not a second copy of the table', async () => {
  const core = await bootKernel();
  const start = source.indexOf('const WATER_SILT=');
  const end = source.indexOf('function setWater(', start);
  const block = source.slice(start, end);
  const window = {};
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  const api = new Function('cl', 'window', 'core', `${block};return { waterOpticalFor, WATER_PROFILES };`)(cl, window, core);
  for (let type = 0; type < 8; type++) {
    const kernel = core.waterOptical(type);
    assert.equal(kernel.length, 6);
    const js = api.waterOpticalFor({ jerlov: type, cdom: 0 });
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(js[c] - kernel[c]) < 1e-6, `type ${type} absorption channel ${c} matches the kernel`);
    assert.ok(Math.abs(js[3] - kernel[3]) < 1e-6, `type ${type} scattering matches the kernel`);
  }
  /* The eight real Jerlov types are strictly ordered by red absorption. */
  const absorb = [];
  for (let type = 0; type < 8; type++) absorb.push(core.waterOptical(type)[0]);
  for (const [index, value] of [[0, absorb[5]], [5, absorb[6]], [6, absorb[2]]]) {
    assert.ok(absorb[index] < value, 'IA < IB < 1C in red absorption');
  }
  assert.ok(core.waterOptical(4)[0] > core.waterOptical(3)[0] && core.waterOptical(3)[0] > core.waterOptical(2)[0], 'the coastal series reddens monotonically');
  assert.equal(core.waterOptical(8)[0], core.waterOptical(0)[0], 'an out-of-range type falls back to clear ocean');
});

test('the Beaufort sea state and the wave height agree with the wind speed', () => {
  const api = waterApi();
  assert.equal(api.beaufortOf(0.2), 0);
  assert.equal(api.beaufortOf(4.5), 3);
  assert.equal(api.beaufortOf(12), 6);
  assert.equal(api.beaufortOf(40), 12);
  const hsBand = [[0, 0.1], [1, 0.2], [2, 0.4], [3, 0.7], [4, 1.2], [5, 2.2], [6, 3.7], [7, 5.7], [8, 7.7]];
  for (const [index, p] of api.WATER_PROFILES.entries()) {
    const hydrated = api.waterProfileFor(index);
    const hs = p.height * 2;
    const band = hsBand[Math.min(hydrated.beaufort, hsBand.length - 1)][1];
    assert.ok(hs <= band * 1.25 + 0.05, `${p.name}: ${hs} m significant height is too big for Beaufort ${hydrated.beaufort}`);
    assert.ok(hydrated.beaufort >= 0 && hydrated.beaufort <= 12);
  }
});

test('setWater reads the physical profile and the panel offers every preset', () => {
  assert.match(source, /function setWater\(i\)\{const p=waterProfileFor\(Number\(i\)\);/);
  assert.match(source, /window\.__feWaterPresets=/);
  const scene = readFileSync(appPath('terrain-main-07.js'), 'utf8');
  assert.match(scene, /chips\(\[\.\.\.WATER_PROFILES\.map\(\(p,i\)=>\[i,p\.name\]\)/);
  assert.doesNotMatch(scene, /👁/, 'the water panel uses text, not an eye emoji');
});
