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
  /* The climate is off by default: it used to overwrite the studio's rain,
     overcast, storm and snowfall targets on every tick, which is why those
     sliders appeared dead. Turning it off must leave them exactly as the
     studio set them. */
  const authored = { rainT: 0.42, overT: 0.31, stormT: 0.17, snowfallT: 0.08 };
  Object.assign(W, authored);
  api.set('enabled', false);
  api.apply();
  assert.deepEqual({ rainT: W.rainT, overT: W.overT, stormT: W.stormT, snowfallT: W.snowfallT }, authored,
    'with the climate off the studio sliders are untouched');
  api.set('enabled', true);
  assert.equal(api.settings.enabled, true, 'and it can be switched back on');
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
  assert.match(sw, /CACHE_NAME = 'final-effect-cpp-v\d+'/, 'the service worker cache is versioned for the new module');
  assert.ok(sw.includes("'./landscape-weather.js'"), 'and precaches it');
});

/* ------------------------------------------------------------------ */
/* Climate biomes are an explicit action over the paint layers         */
/* ------------------------------------------------------------------ */

const BIOME_BLOCK = panel.slice(panel.indexOf('const CLIMATE_SURFACE_KEYS'), panel.indexOf('PN.openworld=()=>{'));

/* Boots the real apply action over a real climate bridge: the module, the
   terrain arrays and the panel code are all the shipped ones. */
async function bootBiomeAction({ ow = false } = {}) {
  const { core } = await bootBridge();
  const events = [];
  const N = 32, W = N + 1, S = 256;
  const heights = new Float32Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const x = i * S / N - S / 2, z = j * S / N - S / 2;
    heights[j * W + i] = 24 + 30 * Math.sin(x * 0.016) * Math.cos(z * 0.019) + 6 * Math.sin(x * 0.06 + z * 0.04);
  }
  const paintA = new Float32Array(W * W * 4), paintB = new Float32Array(W * W * 4), paintC = new Float32Array(W * W * 4);
  for (let k = 0; k < W * W; k++) paintA[k * 4] = 1;   /* the artist painted hills everywhere */
  const materials = new Uint8Array(W * W).fill(255);
  const status = { textContent: 'Ready to generate' };
  const chunk = ow ? {
    segments: N, size: S, originX: 256, originZ: -256, dirty: false,
    heights: heights.slice(), surfaceWeights: new Float32Array(W * W * 12)
  } : null;
  const context = {
    console, Math, Promise, setTimeout, Date, JSON, Object, Array, Number, String, isFinite,
    Float32Array, Uint8Array, Uint32Array,
    document: { readyState: 'loading', addEventListener() {}, getElementById: (id) => (id === 'owstatus' ? status : null) },
    requestAnimationFrame: () => 0,
    WX: { rainT: 0, overT: 0, stormT: 0, snowfallT: 0, coverT: 0, snowAuto: true, seasonT: 0.32, tsu: {} },
    scene: { fog: { density: 0.004 } },
    FELandscapeCore: core,
    OW_SURFACE_DEFS: [['hills', 'Hills'], ['alpine', 'Alpine'], ['desert', 'Desert'], ['volcano', 'Volcano'],
      ['shore', 'Sand Shores'], ['rocky', 'Rocky Mountains'], ['grassy', 'Grassy'], ['sand', 'Sand'],
      ['lava', 'Lava'], ['magma', 'Magma'], ['pebbles', 'Pebbles'], ['beach', 'Beach Sand']].map(([key, label]) => ({ key, label })),
    H: heights, W, S, SWA: paintA, SWB: paintB, SWC: paintC, MI: materials,
    OW: ow ? { active: true, chunks: new Map([['0,0', chunk]]) } : { active: false, chunks: new Map() },
    upd: () => events.push('upd'),
    push: () => events.push('push'),
    owUpdateChunkGeometry: (c) => { events.push('chunk'); c.updated = (c.updated || 0) + 1; }
  };
  vm.createContext(context);
  context.window = context;
  vm.runInContext(moduleSource, context);
  vm.runInContext(BIOME_BLOCK, context);
  return { context, core, events, status, heights, paints: [paintA, paintB, paintC], materials, W, S, N, chunk };
}

test('applying the climate map rewrites every vertex once, after one undo step', async () => {
  const env = await bootBiomeAction();
  const { context, core, events } = env;
  assert.deepEqual(Array.from(env.paints[0].slice(0, 8)), [1, 0, 0, 0, 1, 0, 0, 0], 'the painted layers are untouched before the action');

  const out = vm.runInContext('applyClimateBiomes()', context);
  assert.ok(out && out.cells === env.W * env.W, 'every vertex is classified');
  assert.deepEqual(events, ['push', 'upd'], 'one undo step is pushed first, then the ground is refreshed');

  const weather = context.FELandscapeWeather;
  const keys = context.OW_SURFACE_DEFS.map((d) => d.key);
  const expected = core.climateBiomeGrid(env.heights, env.W, env.S, 0, 0, weather.state.clock % 24);
  for (let k = 0; k < env.W * env.W; k++) {
    const id = keys.indexOf(weather.BIOME_SURFACE[weather.BIOMES[expected[k]]]);
    const w = [0, 1, 2].flatMap((c) => [env.paints[c][k * 4], env.paints[c][k * 4 + 1], env.paints[c][k * 4 + 2], env.paints[c][k * 4 + 3]]);
    assert.equal(w[id], 1, `vertex ${k} carries its biome surface`);
    assert.equal(w.filter((v) => v !== 0).length, 1, `vertex ${k} carries exactly one surface`);
    assert.equal(env.materials[k], 255, 'the old material index must not fight the painted weights');
  }
  assert.match(env.status.textContent, /^Climate biomes applied · /, 'the sheet reports what changed');
  assert.match(env.status.textContent, /%/, 'and how much of the map each biome covers');
});

test('applying over an open world writes the twelve chunk weights, not the island', async () => {
  const env = await bootBiomeAction({ ow: true });
  const before = env.paints.map((p) => p.slice());
  const out = vm.runInContext('applyClimateBiomes()', env.context);
  assert.ok(out.cells === env.W * env.W);
  assert.deepEqual(env.events, ['push', 'chunk'], 'the chunk is rebuilt, the island is not refreshed');
  for (let c = 0; c < 3; c++) assert.deepEqual(env.paints[c], before[c], 'the island keeps its paint');
  const sw = env.chunk.surfaceWeights, row = env.W;
  assert.equal(env.chunk.dirty, true);
  assert.equal(env.chunk.updated, 1);
  for (let k = 0; k < row * row; k++) {
    let sum = 0, ones = 0;
    for (let q = 0; q < 12; q++) { const v = sw[k * 12 + q]; sum += v; if (v === 1) ones++; }
    assert.equal(sum, 1, `chunk vertex ${k} is fully weighted`);
    assert.equal(ones, 1, `chunk vertex ${k} has exactly one surface`);
  }
});

test('fill-only mode keeps a hand-painted chunk whole instead of speckling it', async () => {
  const env = await bootBiomeAction({ ow: true });
  const { context, chunk, W } = env;
  /* The artist worked this whole tile: every vertex carries a two-way blend. */
  for (let k = 0; k < W * W; k++) { chunk.surfaceWeights[k * 12] = 0.6; chunk.surfaceWeights[k * 12 + 5] = 0.4; }
  const before = chunk.surfaceWeights.slice();
  /* A neighbouring tile that was never painted. */
  const second = { segments: W - 1, size: env.S, originX: -256, originZ: -256, dirty: false,
    heights: chunk.heights.slice(), surfaceWeights: new Float32Array(W * W * 12) };
  context.OW.chunks.set('1,0', second);
  vm.runInContext("climateApplyMode='free'", context);
  const out = vm.runInContext('applyClimateBiomes()', context);
  assert.equal(out.chunks, 2, 'both resident chunks are considered');
  assert.equal(out.keptChunks, 1, 'the painted tile is kept as a whole');
  assert.deepEqual(chunk.surfaceWeights, before, 'not one vertex of the painted chunk changed');
  assert.equal(chunk.dirty, false, 'and it is not even re-uploaded');
  let ones = 0, sum = 0;
  for (let k = 0; k < W * W * 12; k++) { if (second.surfaceWeights[k] === 1) ones++; sum += second.surfaceWeights[k]; }
  assert.equal(ones, W * W, 'every vertex of the unpainted tile gets a climate surface');
  assert.equal(sum, W * W, 'exactly one surface per vertex');
  assert.match(env.status.textContent, /1 of 2 chunks kept from your painting/, 'the sheet reports chunks, not a vague percentage');
});

test('the climate never replaces painted biomes on its own', async () => {
  /* Structural promise: the action exists, and nothing calls it but the button. */
  const calls = panel.match(/applyClimateBiomes\(\)/g) || [];
  assert.equal(calls.length, 2, 'one definition and one button handler — no timer, no boot hook, no weather hook');
  assert.match(panel, /btn\('[^']*Apply Climate Biomes',\(\)=>applyClimateBiomes\(\)\)/,
    'the button is the only way in, and it is a deliberate press');
  const moduleCode = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(moduleCode, /SWA|SWB|SWC|surfaceWeights|OW_SURFACE_DEFS|MI\[/,
    'the weather module has no access to the paint layers at all');
  const live = await bootBiomeAction();
  live.context.FELandscapeWeather.apply();
  live.context.FELandscapeWeather.set('humidity', 0.9);
  assert.deepEqual(live.events, [], 'a weather tick never touches the ground');
});

test('fill-only mode leaves every hand-painted vertex exactly as it was', async () => {
  const env = await bootBiomeAction();
  const { context } = env;
  /* Paint only the even vertices, so half the island is the artist's work. */
  for (const p of env.paints) p.fill(0);
  for (let k = 0; k < env.W * env.W; k += 2) env.paints[0][k * 4 + 3] = 0.8;   /* a blend, not a pure surface */
  const snapshot = env.paints.map((p) => p.slice());
  vm.runInContext("climateApplyMode='free'", context);
  const out = vm.runInContext('applyClimateBiomes()', context);
  assert.ok(out.kept > 0 && out.kept < env.W * env.W, 'some vertices are kept and some are filled');
  for (let k = 0; k < env.W * env.W; k++) {
    if (k % 2 === 0) {
      for (let q = 0; q < 4; q++) assert.equal(env.paints[0][k * 4 + q], snapshot[0][k * 4 + q], `painted vertex ${k} is untouched`);
      assert.equal(env.paints[1][k * 4], snapshot[1][k * 4]);
    } else {
      const w = [0, 1, 2].flatMap((c) => [env.paints[c][k * 4], env.paints[c][k * 4 + 1], env.paints[c][k * 4 + 2], env.paints[c][k * 4 + 3]]);
      assert.equal(w.filter((v) => v === 1).length, 1, `unpainted vertex ${k} receives exactly one climate surface`);
    }
  }
  assert.match(env.status.textContent, /kept from your painting/, 'the sheet says how much was preserved');
});

/* ------------------------------------------------------------------ */
/* Sea state from the climate wind                                     */
/* ------------------------------------------------------------------ */

function seaStateContext() {
  const source = readFileSync('terrain-main-01.js', 'utf8');
  const block = source.slice(source.indexOf('function wavePhysicsForWind'), source.indexOf('window.__feWavePhysics'));
  const prelude = `
    let waterWindSpeed = 14, ampUser = 1.05, waterWavePeriod = 6, waveChop = 0.22;
    const cl = (v, a, b) => Math.min(b, Math.max(a, v));
    const U = { uWindSpeed: { value: 0 }, amp: { value: 0 }, uWavePeriod: { value: 0 }, uChop: { value: 0 } };`;
  const tail = `
    globalThis.__sea = {
      physics: wavePhysicsForWind, apply: applyWavePhysics,
      step: stepWaveClimate,
      setAuto(v) { waveAuto = v; waveAutoApplied = -1; },
      get auto() { return waveAuto; },
      state: () => ({ wind: waterWindSpeed, hs: ampUser, period: waterWavePeriod, chop: waveChop, u: { ...U } })
    };`;
  const context = { console, Math, Number, JSON };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(prelude + block + tail, context);
  return { context, sea: context.__sea };
}

test('the sea state is derived from one wind speed, the way a Gerstner or FFT spectrum expects', () => {
  const { sea } = seaStateContext();
  const calm = sea.physics(0);
  const breeze = sea.physics(8);
  const gale = sea.physics(20);
  assert.ok(calm.hs <= 0.02 + 1e-9, 'a calm sea has no waves');
  assert.ok(breeze.hs > calm.hs && gale.hs > breeze.hs, 'wave height grows with the wind');
  assert.ok(Math.abs(breeze.hs - 0.0025 * 64) < 1e-6, 'fully developed sea: H_s = 0.0025 U^2');
  assert.ok(Math.abs(breeze.period - 5.84) < 1e-6, 'peak period: T_p = 0.73 U');
  const length = 9.81 * breeze.period * breeze.period / (2 * Math.PI);
  assert.ok(Math.abs(breeze.length - length) < 1e-6, 'peak wavelength: L = g T_p^2 / 2 pi');
  assert.ok(gale.period > breeze.period && gale.chop > breeze.chop, 'a gale is slower and choppier, not just taller');
  /* The clamps keep a hand-written weather value from making an impossible sea. */
  assert.ok(sea.physics(-4).wind === 0 && sea.physics(90).wind === 40);
  assert.ok(sea.physics(90).hs <= 2.6 && sea.physics(90).period <= 16);
});

test('applying a wind speed writes every slider and its uniform', () => {
  const { sea } = seaStateContext();
  const p = sea.apply(12);
  const s = sea.state();
  assert.equal(s.wind, 12);
  assert.equal(s.hs, p.hs);
  assert.equal(s.period, p.period);
  assert.equal(s.u.uWindSpeed.value, 12, 'the spectrum wind speed follows');
  assert.equal(s.u.amp.value, p.hs, 'the Gerstner amplitude follows');
  assert.equal(s.u.uWavePeriod.value, p.period);
  assert.equal(s.u.uChop.value, p.chop);
});

test('the sea follows the weather only after the artist asks it to', () => {
  const { context, sea } = seaStateContext();
  context.window = context;
  context.FELandscapeWeather = { state: { wind: 16 } };
  const before = sea.state();
  sea.step();
  assert.equal(sea.state().wind, before.wind, 'nothing moves while the toggle is off');
  assert.equal(sea.auto, false);
  sea.setAuto(true);
  sea.step();
  assert.equal(sea.state().wind, 16, 'the climate wind reaches the water');
  assert.ok(Math.abs(sea.state().hs - 0.0025 * 256) < 1e-6);
  context.FELandscapeWeather.state.wind = 4;
  sea.step();
  assert.equal(sea.state().wind, 4, 'and keeps following it');
  /* A missing climate module must never throw inside the render loop. */
  delete context.FELandscapeWeather;
  sea.step();
  assert.equal(sea.state().wind, 4);
});

test('the sheet exposes the toggle and reads the sea state back in physical units', () => {
  assert.match(panel, /Waves follow the weather/, 'the toggle is in the water sheet');
  assert.match(panel, /id="fe-sea-state"/, 'the derived sea state is visible');
  assert.match(panel, /significant wave height/, 'in metres');
  assert.match(panel, /peak period/, 'in seconds');
  assert.match(panel, /wavelength/, 'and metres of wavelength');
  assert.match(panel, /stepWaveClimate\(\);/, 'the render loop steps it once a frame');
  assert.match(readFileSync('terrain-main-09.js', 'utf8'), /stepWaveClimate\(\);syncWaterPhysical\(\)/, 'from the frame loop, before the water uniforms are synced');
  assert.match(panel.slice(panel.indexOf('Waves follow the weather'), panel.indexOf('Waves follow the weather') + 700), /^\s*(?!.*(?:C\+\+|WASM|kernel|shader)).*$/is, 'and never names the implementation');
});

/* ------------------------------------------------------------------ */
/* Tsunami envelope against the wind sea                               */
/* ------------------------------------------------------------------ */

function tsunamiBlendFn() {
  const source = readFileSync('terrain-main-06.js', 'utf8');
  const block = source.slice(source.indexOf('function tsunamiBlend'), source.indexOf('function tsuLaunch'));
  const context = { console, Math, Number, window: {} };
  vm.createContext(context);
  vm.runInContext(block + '\nglobalThis.__blend = tsunamiBlend;', context);
  return context.__blend;
}

test('the surface switches to the long wave over time, not in one frame', () => {
  const blend = tsunamiBlendFn();
  assert.equal(typeof blend, 'function');
  /* A triggered long wave ramps in; the short waves yield as it does. */
  let f = 0;
  const ramp = [];
  for (let i = 0; i < 120; i++) { f = blend(f, true, 8, 1 / 60); ramp.push(f); }
  assert.ok(ramp[0] > 0 && ramp[0] < 0.1, 'the first frame does not jump to a full tsunami');
  assert.ok(ramp[5] < ramp[30] && ramp[30] < ramp[119], 'the factor only ever moves towards the long wave');
  assert.ok(ramp[119] > 0.95, 'and gets there in a couple of seconds');
  assert.ok(ramp.every((v) => v >= 0 && v <= 1), 'the factor is always a 0..1 blend');

  /* When the front has passed the amplitude goes to zero and the sea returns. */
  let g = 1;
  const decay = [];
  for (let i = 0; i < 150; i++) { g = blend(g, false, 0, 1 / 60); decay.push(g); }
  assert.ok(decay[0] < 1 && decay[10] < decay[0], 'the long wave leaves gradually');
  assert.ok(decay[149] < 0.02, 'and the wind sea is back');
  assert.ok(decay.every((v, i) => i === 0 || v <= decay[i - 1]), 'the decay is monotone');

  /* A tiny amplitude still takes over the silhouette, a huge one clamps. */
  assert.equal(blend(0, true, 0, 10) <= 1, true);
  assert.ok(blend(0, true, 0.4, 5) > 0.34, 'a small long wave still gets a visible share');
  assert.ok(blend(0, true, 40, 5) <= 1, 'and a giant one cannot exceed a full blend');
});

test('height and normal are blended by the same factor, so the mesh cannot tear', () => {
  const bridge = readFileSync('terrain-main-01.js', 'utf8');
  assert.match(bridge, /uniform float uTf,uTl,uTa,uTdx,uTdz,uTsF;/, 'the shader has the blend factor');
  assert.match(bridge, /float tsF=clamp\(uTsF,0\.,1\.\);/, 'it is clamped to a blend');
  assert.match(bridge, /vec2 windSlope=waterGrad\*amp\*waterFade\*\(1\.-tsF\*\.85\);/, 'the wind sea yields its slope');
  assert.match(bridge, /vec2 waterSlope=windSlope\+tsSlope\*tsF;/, 'the long wave takes the slope over');
  assert.match(bridge, /objectNormal=normalize\(vec3\(-waterSlope\.x,1\.,-waterSlope\.y\)\);/, 'the normal comes from the blended slope');
  assert.match(bridge, /transformed\.y\+=waterWave\*amp\*waterFade\*\(1\.-tsF\*\.85\)\+tsH\(waterBaseWorld\.xz\)\*tsF\+waterRainHeight\*\(1\.-tsF\*\.7\);/, 'the height uses the identical factor');
  /* The slope is taken from the same profile the height uses. */
  assert.match(bridge, /float tsHx=tsH\(waterBaseWorld\.xz\+vec2\(tsE,0\.\)\)-tsH\(waterBaseWorld\.xz\);/, 'the long-wave slope is a finite difference of the height field');
  assert.match(bridge, /'uTf','uTl','uTa','uTdx','uTdz','uTsF',/, 'and the factor is wired into the material uniforms');
});

test('the weather step drives the factor and never leaves a stale amplitude', () => {
  const source = readFileSync('terrain-main-06.js', 'utf8');
  assert.match(source, /WX\.tsF=tsunamiBlend\(WX\.tsF,WX\.tsAmp>0&&WX\.tsu\.on,WX\.tsAmp,dt\);/, 'the factor is integrated once a frame');
  assert.match(source, /U\.uTsF\.value=WX\.tsF;U\.uTa\.value=WX\.tsAmp\*WX\.tsF;/, 'the shader amplitude follows the blend instead of snapping to zero');
  assert.match(source, /if\(Q\.f>215\)\{Q\.on=false;WX\.tsAmp=0/, 'the end of the event drops the target, not the value');
  assert.match(source, /function tsuReset\(\)\{WX\.tsu\.on=false;WX\.tsAmp=0;/, 'a hard reset clears both');
});
