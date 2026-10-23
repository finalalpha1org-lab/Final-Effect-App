import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* Climate & weather: the studio used to expose raw rain/storm/snow targets and
   a handful of presets. These tests pin the C++ field that now decides them —
   the real lapse rate, the diurnal cycle and its thermal lag, the dew point,
   seasonality, synoptic fronts, the Whittaker biome table and the two hazard
   envelopes — plus the thin bridge that feeds the existing weather system and
   the promise that a missing kernel leaves manual weather untouched. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const moduleSource = readFileSync('landscape-weather.js', 'utf8');
const html = readFileSync('Terrain_system_.html', 'utf8');
const panel = readFileSync('terrain-main-07.js', 'utf8');
const buildScript = readFileSync('scripts/build.mjs', 'utf8');
const cppBuild = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');
const sw = readFileSync('sw.js', 'utf8');

const GRAVITY = 9.80665;

async function bootBridge() {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  await context.FELandscapeCore.loading;
  return { context, core: context.FELandscapeCore };
}

function weather(core) {
  const w = core.climateWeather();
  return { temp: w[0], dew: w[1], cloud: w[2], rain: w[3], snow: w[4], storm: w[5], lightning: w[6], fog: w[7], wind: w[8], dir: w[9] };
}

/* Runs the studio-only parts the module talks to. */
function studioContext(core) {
  const writes = { realism: [] };
  const context = {
    console, Math, Promise, setTimeout, Date, Float32Array, Uint8Array, Uint32Array,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    requestAnimationFrame: () => 0,
    WX: { rain: 0, rainT: 0, over: 0, overT: 0, storm: 0, stormT: 0, snowfall: 0, snowfallT: 0, cover: 0, coverT: 0, snowAuto: true, seasonT: 0.32 },
    scene: { fog: { density: 0.004 } },
    FELandscapeCore: core,
    FELandscapeRealism: { settings: { enabled: true }, set: (k, v) => { writes.realism.push([k, v]); return v; } },
    torSpawn: () => { writes.tornado = (writes.tornado || 0) + 1; },
    tsuLaunch: () => { writes.tsunami = (writes.tsunami || 0) + 1; }
  };
  vm.createContext(context);
  vm.runInContext('var windUser = 1;', context);
  vm.runInContext(moduleSource, context);
  return { context, api: context.FELandscapeWeather, writes };
}

test('the artifact ships the climate kernels and eight biomes', async () => {
  const { core } = await bootBridge();
  for (const name of ['fe_climate_init', 'fe_climate_weather', 'fe_climate_at', 'fe_climate_biome', 'fe_climate_snow_line', 'fe_climate_tornado', 'fe_climate_tsunami']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
  }
  assert.equal(core.climateBiomeCount(), 8);
});

test('temperature follows the 6.5 K/km environmental lapse rate', async () => {
  const { core } = await bootBridge();
  core.climateInit(7, 0, 28, 0.8, 0.2, 6);
  const sea = core.climateAt(0, 0, 0, 9);
  const up1 = core.climateAt(0, 0, 1000, 9);
  const up2 = core.climateAt(0, 0, 2000, 9);
  assert.ok(Math.abs((sea[0] - up1[0]) - 6.5) < 0.05, `first kilometre drops ${(sea[0] - up1[0]).toFixed(2)} K`);
  assert.ok(Math.abs((sea[0] - up2[0]) - 13.0) < 0.1, 'two kilometres drop 13 K');
});

test('the diurnal cycle peaks after solar noon and fog forms before dawn', async () => {
  const { core } = await bootBridge();
  core.climateInit(7, 0, 28, 0.8, 0.2, 4);
  const h = (hour) => core.climateAt(0, 0, 0, hour);
  const dawn = h(3), morning = h(9), noon = h(12), afternoon = h(15), night = h(23);
  assert.ok(afternoon[0] > noon[0], 'thermal inertia puts the peak after noon');
  assert.ok(noon[0] > morning[0] && morning[0] > dawn[0], 'the ground warms through the morning');
  assert.ok(night[0] < noon[0], 'it cools again after sunset');
  assert.ok(dawn[6] > noon[6], 'fog belongs to the cold, saturated hours');
  assert.ok(dawn[6] > 0.05, 'a humid dawn actually reports fog');
});

test('latitude and season move the whole field the way the real world does', async () => {
  const { core } = await bootBridge();
  core.climateInit(7, 0, 28, 0.6, 0.2, 6);
  core.climateSetClock(9);
  const equator = core.climateAt(0, 0, 0, 9)[0];
  core.climateInit(7, 60, 28, 0.6, 0.2, 6);
  core.climateSetClock(9);
  const high = core.climateAt(0, 0, 0, 9)[0];
  core.climateInit(7, 85, 10, 0.5, 0.2, 6);
  core.climateSetClock(9);
  const pole = core.climateAt(0, 0, 0, 9)[0];
  assert.ok(high < equator - 8, `60° is ${(equator - high).toFixed(1)} K colder than the equator`);
  assert.ok(pole < -5, 'the polar field is below freezing');

  /* Northern summer at season .25, winter at .75; the southern hemisphere
     must do the opposite. */
  const seasonal = (lat, s) => {
    core.climateInit(7, lat, 20, 0.5, 0.6, 6);
    core.climateSetSeason(s);
    core.climateSetClock(12);
    return core.climateAt(0, 0, 0, 12)[0];
  };
  assert.ok(seasonal(50, 0.25) > seasonal(50, 0.75) + 10, 'northern summer is far warmer than winter');
  assert.ok(seasonal(-50, 0.25) < seasonal(-50, 0.75) - 10, 'the seasons flip south of the equator');
});

test('moisture falls inland and with altitude, and drives the biome table', async () => {
  const { core } = await bootBridge();
  core.climateInit(7, 10, 26, 0.95, 0.2, 6);
  const coast = core.climateAt(0, 0, 5, 10)[2];
  core.climateInit(7, 10, 26, 0.95, 0.9, 6);
  const inland = core.climateAt(0, 0, 5, 10)[2];
  const ridge = core.climateAt(0, 0, 900, 10)[2];
  assert.ok(coast > 0.75, 'a humid coast is wet');
  assert.ok(inland < coast - 0.2, 'continentality dries the interior');
  assert.ok(ridge < inland + 0.01, 'a ridge sits in its own rain shadow');

  const B = { tundra: 0, taiga: 1, grassland: 2, forest: 3, desert: 4, savanna: 5, rainforest: 6, rock: 7 };
  assert.equal(core.climateBiome(-10, 0.5), B.tundra);
  assert.equal(core.climateBiome(0, 0.5), B.taiga);
  assert.equal(core.climateBiome(0, 0.1), B.tundra);
  assert.equal(core.climateBiome(12, 0.1), B.grassland);
  assert.equal(core.climateBiome(12, 0.5), B.forest);
  assert.equal(core.climateBiome(26, 0.05), B.desert);
  assert.equal(core.climateBiome(26, 0.3), B.savanna);
  assert.equal(core.climateBiome(26, 0.9), B.rainforest);
  assert.equal(core.climateBiomeOnSlope(12, 0.5, 0.9), B.rock, 'steep ground loses its soil');
});

test('synoptic fronts evolve, stay bounded and are reproducible per seed', async () => {
  const { core } = await bootBridge();
  const run = (seed) => {
    core.climateInit(seed, 30, 24, 0.7, 0.3, 8);
    core.climateSetClock(0);
    const series = [];
    for (let i = 0; i < 120; i++) { core.climateStep(1); series.push(weather(core)); }
    return series;
  };
  const a = run(7), b = run(7), c = run(11);
  assert.deepEqual(a.map((w) => Math.round(w.rain * 1e6)), b.map((w) => Math.round(w.rain * 1e6)), 'the same seed replays the same weather');
  assert.notDeepEqual(a.map((w) => Math.round(w.rain * 1e6)), c.map((w) => Math.round(w.rain * 1e6)), 'a different seed gives a different history');

  for (const w of a) {
    for (const key of ['cloud', 'rain', 'snow', 'storm', 'lightning', 'fog']) {
      assert.ok(Number.isFinite(w[key]) && w[key] >= 0 && w[key] <= 1, `${key} out of range: ${w[key]}`);
    }
    assert.ok(w.wind >= 0 && w.wind <= 60, 'wind stays in a physical range');
    if (w.rain > 0.01) assert.ok(w.cloud > 0.1, 'rain requires cloud');
    if (w.snow > 0.01) assert.ok(w.temp < 2.5, 'snow only falls near or below freezing');
    assert.ok(w.storm <= w.rain + 0.4, 'a storm cannot exceed its own precipitation by much');
  }
  const wet = a.reduce((s, w) => s + w.rain, 0) / a.length;
  const dry = a.filter((w) => w.rain < 0.02).length;
  assert.ok(wet > 0.01 && wet < 0.6, 'the climate produces weather, not a constant monsoon');
  assert.ok(dry > 10, 'and it clears up again');
  assert.ok(new Set(a.map((w) => w.rain.toFixed(3))).size > 20, 'the front evolves instead of stepping between two states');
});

test('snow line, tornado and tsunami envelopes are physical', async () => {
  const { core } = await bootBridge();
  core.climateInit(7, 20, 30, 0.5, 0.4, 6);
  core.climateSetClock(13);
  const warmLine = core.climateSnowLine(13);
  core.climateInit(7, 20, 0, 0.5, 0.4, 6);
  core.climateSetClock(13);
  const coldLine = core.climateSnowLine(13);
  assert.ok(warmLine > 2000, `a warm afternoon puts the snow line high (${warmLine.toFixed(0)} m)`);
  assert.ok(coldLine < warmLine, 'a colder field lowers the snow line');

  let last = 0;
  for (let ef = 0; ef <= 5; ef++) {
    const t = core.climateTornado(ef);
    assert.equal(t.length, 4);
    assert.ok(t[0] > 0 && t[1] > last, 'EF classes only get stronger');
    assert.ok(t[1] >= 29 && t[1] <= 100, 'EF winds stay inside the published scale');
    assert.ok(t[3] > t[0], 'the damage swath is wider than the funnel core');
    last = t[1];
  }
  const R = 40, V = 60;
  assert.equal(core.climateRankine(0, R, V), 0);
  assert.equal(core.climateRankine(R, R, V), V);
  assert.ok(Math.abs(core.climateRankine(R * 4, R, V) - V / 4) < 1e-4, 'Rankine 1/r decay outside the core');

  for (const depth of [20, 200, 4000]) {
    const s = core.climateTsunami(5, depth);
    assert.equal(s.length, 6);
    assert.ok(Math.abs(s[0] - Math.sqrt(GRAVITY * depth)) < 0.01, `phase speed is sqrt(g*d) at ${depth} m`);
    assert.ok(Math.abs(s[1] - s[0] * s[4]) < 0.5, 'wavelength = speed * period');
    assert.ok(s[2] > 1, 'shoaling amplifies the wave');
    assert.ok(s[3] > 5, 'run-up exceeds the open-water amplitude');
  }
});

test('the bridge copies the climate buffers instead of handing out wasm views', async () => {
  const { core } = await bootBridge();
  core.climateInit(3, 45, 18, 0.6, 0.4, 7);
  core.climateSetClock(11);
  const weatherOut = core.climateWeather();
  assert.equal(weatherOut.length, 10);
  assert.ok(Array.isArray(weatherOut), 'the bridge copies into a JS array');
  const at = core.climateAt(10, 20, 150, 11);
  assert.equal(at.length, 10);
  assert.ok(at[0] < weatherOut[0], 'the hill is colder than sea level');
  assert.ok(at[9] >= 0 && at[9] < 8, 'the biome id is inside the table');
  const tw = core.climateTornado(3);
  assert.equal(tw.length, 4);
  const wave = core.climateTsunami(4, 60);
  assert.ok(Math.abs(wave[0] - Math.sqrt(GRAVITY * 60)) < 0.01);
});

test('the module drives the studio weather from the kernel and leaves it alone when off', async () => {
  const { core } = await bootBridge();
  const { context, api, writes } = studioContext(core);
  api.settings.latitude = 40;
  api.settings.temperature = 20;
  api.settings.humidity = 0.7;
  assert.equal(api.install(), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(api.state.kernel, true);
  assert.equal(api.state.ready, true);

  const W = context.WX;
  assert.ok(Math.abs(W.rainT - api.state.rain) < 1e-6, 'rain target comes from the kernel');
  assert.ok(Math.abs(W.stormT - api.state.storm) < 1e-6);
  assert.ok(Math.abs(W.overT - api.state.cloud * 0.92) < 1e-6);
  assert.equal(W.snowAuto, false, 'the climate owns snow cover while it is driving');
  api.state.fog = 0.8;
  api.apply();
  assert.ok(Math.abs(context.scene.fog.density - 0.0195) < 1e-6, 'the fog term reaches the scene');
  api.state.fog = 0;
  api.apply();
  assert.ok(context.scene.fog.density < 0.005, 'clear air keeps the authored haze');
  assert.ok(writes.realism.some(([k]) => k === 'wetness'), 'rain reaches the surface realism setting');
  assert.ok(context.windUser !== 1 || api.state.wind === 6, 'the wind multiplier follows the field');

  /* A front is pulled forward and re-applied on demand. */
  api.settings.timeScale = 240;
  api.tick(1000, true);
  api.apply();
  assert.equal(api.state.applied >= 2, true);

  /* Switching off restores the studio's own snow rule and stops writing. */
  api.set('enabled', false);
  assert.equal(context.WX.snowAuto, true, 'manual weather gets its season snow back');
  const rainBefore = context.WX.rainT;
  api.state.rain = 0.99;
  api.apply();
  assert.equal(context.WX.rainT, rainBefore, 'a disabled climate never touches the weather');

  /* Re-enabling re-initialises from the current settings. */
  api.set('latitude', 5);
  api.set('enabled', true);
  assert.equal(context.WX.snowAuto, false);
  assert.equal(api.state.applied > 2, true);
});

test('a deployment without the climate kernel keeps manual weather', async () => {
  const context = {
    console, Math, Promise, setTimeout, Date,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    requestAnimationFrame: () => 0,
    WX: { rainT: 0.42, overT: 0.3, stormT: 0, snowfallT: 0, coverT: 0, snowAuto: true },
    scene: { fog: { density: 0.004 } },
    FELandscapeCore: { ready: false }
  };
  vm.createContext(context);
  vm.runInContext(moduleSource, context);
  const api = context.FELandscapeWeather;
  assert.equal(api.install(), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(api.state.kernel, false);
  assert.equal(api.state.ready, false);
  assert.equal(context.WX.rainT, 0.42, 'the manual rain slider still owns the weather');
  assert.ok(api.state.lastError, 'the fallback is reported, not silent');
});

test('the page, the panel and the build all carry the climate layer', () => {
  assert.ok(html.includes('<script src="./landscape-weather.js"></script>'), 'the studio loads the climate bridge');
  assert.ok(html.indexOf('./landscape-realism.js') < html.indexOf('./landscape-weather.js'), 'realism loads before the climate that drives its wetness');

  for (const label of ['Climate-driven weather', 'Latitude °', 'Sea-level temperature °C', 'Humidity', 'Continentality', 'Prevailing wind m/s', 'Weather speed (world h / min)', 'Wet surfaces from rain', 'Storm tornadoes']) {
    assert.ok(panel.includes(label), `the weather sheet must expose ${label}`);
  }
  assert.ok(panel.includes('id="fe-climate-readout"'), 'the sheet shows the live field readout');
  assert.ok(panel.includes('window.FELandscapeWeather'), 'the sheet is a view over the module, not a second copy of the numbers');
  const climateBlock = panel.slice(panel.indexOf('PN.weather=()=>{'), panel.indexOf('return [...climate,'));
  assert.doesNotMatch(climateBlock, /C\+\+|WASM|WebAssembly|kernel/,
    'the climate controls must not name the engine');

  assert.match(buildScript, /"landscape-weather\.js"/, 'the build ships the module');
  assert.match(cppBuild, /'cpp\/src\/fe_climate\.cpp'/, 'the wasm build compiles the climate kernel');
  assert.match(cppBuild, /'fe_climate_at',\s*'fe_climate_weather'/, 'the wasm build requires the climate exports');
  assert.ok(sw.includes("'final-effect-cpp-v23'"), 'the service worker cache is bumped for the new module');
  assert.ok(sw.includes("'./landscape-weather.js'"), 'and precaches it');
});
