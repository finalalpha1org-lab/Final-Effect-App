import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* Studio settings used to live only in variables, so a reload reset every
   landscape, water, sky, weather and open-world control. They are now one JSON
   document: localStorage on the web, the same document exported to a file for
   a native build. These tests pin the document, its round trip, the defensive
   validation and the boot order that restores it before the world is built. */

const panel = readFileSync('terrain-main-07.js', 'utf8');
const init = readFileSync('terrain-main-09.js', 'utf8');
const sw = readFileSync('sw.js', 'utf8');

const BLOCK = panel.slice(
  panel.indexOf('/* ---- studio settings: one JSON document'),
  panel.indexOf('/* ---- Climate biomes: an explicit action')
);

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear()
  };
}

/* A tiny fake clock so the debounce is exercised without waiting. */
function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    flush() { while (timers.length) timers.shift().fn(); }
  };
}

function boot({ saved = null, weather = true, storage = null } = {}) {
  const calls = { restored: [], synced: 0, errors: [], messages: [], overlays: [] };
  const local = storage || memoryStorage(saved ? { fe_landscape_config_v1: saved } : {});
  const clock = fakeClock();
  const wx = weather
    ? {
      settings: { enabled: true, latitude: 32, temperature: 22, humidity: 0.55, continentality: 0.4, wind: 6, timeScale: 30, fog: true, wetnessFromRain: true, autoTornado: false, seed: 7 },
      syncKernel: () => { calls.synced++; return true; }
    }
    : null;
  const context = {
    console, Math, JSON, Object, Number, String, Date, isFinite, Float32Array, Uint8Array,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    localStorage: local,
    document: { getElementById: () => null, addEventListener() {} },
    addEventListener() {},
    OW: { config: { sizeKm: 12, seed: 42817, blend: 0.58, mountainHeight: 48, biomeMix: { hills: 1, alpine: 1, desert: 1, volc: 1 } } },
    FELandscapeWeather: wx,
    captureStudioSettings: () => ({ seed: 128.5, hs: 34, rockT: 0.62, snowL: 44, biome: 'hills', wl: -6, ampUser: 1.4, wspd: 0.9, season: 'autumn', windUser: 1.2, sky: '{"a":1}', wx: '{"rainT":0.2}' }),
    restoreStudioSettings: (s) => { calls.restored.push(s); },
    gen: () => calls.messages.push('gen'),
    scatter: () => calls.messages.push('scatter'),
    updSky: () => calls.messages.push('updSky'),
    build: () => calls.messages.push('build'),
    showErr: (m) => calls.errors.push(m),
    msg: (m) => calls.messages.push(m),
    showLandscapeExportFallback: (json, message) => calls.overlays.push({ json, message })
  };
  vm.createContext(context);
  context.window = context;
  vm.runInContext(BLOCK, context);
  return { context, calls, local, clock };
}

test('the studio document is plain JSON with the three sections', () => {
  const { context } = boot();
  const doc = JSON.parse(vm.runInContext('serializeStudioConfig()', context));
  assert.equal(doc.app, 'final-effect');
  assert.equal(doc.kind, 'landscape-settings');
  assert.equal(doc.version, 1);
  assert.ok(typeof doc.savedAt === 'string' && !Number.isNaN(Date.parse(doc.savedAt)), 'the document is dated');
  assert.equal(doc.studio.seed, 128.5, 'the whole studio snapshot rides along');
  assert.equal(doc.openWorld.seed, 42817);
  assert.equal(doc.openWorld.biomeMix.desert, 1, 'the nested biome mix is a real copy');
  assert.equal(doc.climate.latitude, 32);
});

test('a saved document comes back: every section is applied, the seed reaches boot', () => {
  const first = boot();
  vm.runInContext('persistStudioConfig()', first.context);
  assert.equal(first.local.map.size, 1, 'one key, no scatter of individual settings');
  assert.ok(first.local.map.has('fe_landscape_config_v1'));
  const saved = first.local.map.get('fe_landscape_config_v1');

  const second = boot({ saved });
  const ok = vm.runInContext('window.__feRestoreStudioConfig()', second.context);
  assert.equal(ok, true);
  assert.equal(second.calls.restored.length, 1, 'the studio snapshot is handed to the existing restorer');
  assert.equal(second.calls.restored[0].hs, 34);
  assert.equal(second.calls.synced, 1, 'the climate kernel is re-seeded from the restored settings');
  assert.equal(second.context.__feStartupSeed, 128.5, 'the world seed survives the reload');
});

test('a stale, foreign or corrupt document never damages the studio', () => {
  const cases = {
    corrupt: '{"oops"',
    foreign: JSON.stringify({ app: 'final-effect', kind: 'scene', version: 1, studio: { seed: 1 } }),
    empty: JSON.stringify({}),
    nullish: 'null'
  };
  for (const [name, raw] of Object.entries(cases)) {
    const env = boot({ saved: raw });
    assert.equal(vm.runInContext('window.__feRestoreStudioConfig()', env.context), false, `${name} is refused`);
    assert.equal(env.calls.restored.length, 0, `${name} never reaches the restorer`);
  }
  /* A newer document with extra fields is accepted for what it does carry. */
  const env = boot({ saved: JSON.stringify({ kind: 'landscape-settings', version: 9, future: { a: 1 }, studio: { seed: 3 } }) });
  assert.equal(vm.runInContext('window.__feRestoreStudioConfig()', env.context), true);
  assert.equal(env.context.__feStartupSeed, 3);
});

test('wrongly typed fields are ignored instead of poisoning a live value', () => {
  const doc = {
    kind: 'landscape-settings', version: 1,
    studio: { seed: 12 },
    openWorld: { sizeKm: 'huge', seed: 99, blend: null, biomeMix: { hills: 2 } },
    climate: { latitude: 'north', humidity: 0.9, unknown: 5 }
  };
  const env = boot();
  const ok = vm.runInContext(`applyStudioConfig(${JSON.stringify(doc)})`, env.context);
  assert.equal(ok, true);
  assert.equal(env.context.OW.config.sizeKm, 12, 'a string never becomes the world size');
  assert.equal(env.context.OW.config.seed, 99, 'a number still applies');
  assert.equal(env.context.OW.config.blend, 0.58, 'null is not a number');
  assert.equal(env.context.OW.config.biomeMix.hills, 2);
  assert.equal(env.context.FELandscapeWeather.settings.latitude, 32);
  assert.equal(env.context.FELandscapeWeather.settings.humidity, 0.9);
  assert.equal('unknown' in env.context.FELandscapeWeather.settings, false);
});

test('panel edits are batched into one write, and never lost on unload', () => {
  const env = boot();
  for (let i = 0; i < 6; i++) vm.runInContext('queueStudioConfigSave()', env.context);
  assert.equal(env.clock.timers.length, 1, 'six slider moves schedule a single save');
  assert.equal(env.local.map.size, 0, 'nothing is written before the debounce');
  env.clock.flush();
  assert.equal(env.local.map.size, 1, 'the debounce wrote exactly once');
});

test('export and import are the same document, and import rebuilds the world', () => {
  const env = boot();
  vm.runInContext('exportStudioSettings()', env.context);
  assert.equal(env.calls.overlays.length, 1, 'the existing export overlay shows the JSON');
  const { json } = env.calls.overlays[0];
  assert.equal(JSON.parse(json).kind, 'landscape-settings');

  const box = { value: json };
  env.context.document.getElementById = (id) => (id === 'exp' ? box : null);
  const ok = vm.runInContext('importStudioSettings()', env.context);
  assert.equal(ok, true);
  assert.deepEqual(env.calls.messages, ['gen', 'scatter', 'updSky', 'build', 'Studio settings loaded'],
    'a pasted document rebuilds the world in the same order as a cold boot');

  box.value = '{"kind":"something-else"}';
  assert.equal(vm.runInContext('importStudioSettings()', env.context), false, 'a foreign JSON is refused');
  assert.ok(env.calls.errors.length >= 1, 'and the refusal is reported');
  box.value = 'not json at all';
  assert.equal(vm.runInContext('importStudioSettings()', env.context), false);
});

test('the studio boots from the saved document before it generates the world', () => {
  const restoreAt = init.indexOf('__feRestoreStudioConfig');
  const genAt = init.indexOf('gen(window.__feStartupSeed)');
  assert.ok(restoreAt > 0, 'the boot restores the saved settings');
  assert.ok(genAt > restoreAt, 'and it does so before the terrain is generated');
  assert.ok(init.indexOf('()=>gen()') < 0, 'the boot no longer throws the saved seed away');
  assert.ok(panel.includes("['exp','Export settings JSON']") && panel.includes("['imp','Load settings from JSON']"),
    'the sheet exposes both actions');
  assert.ok(panel.includes('localStorage.setItem(STUDIO_CONFIG_KEY'), 'the web build persists to localStorage');
  assert.ok(panel.includes('pagehide'), 'an unload flushes a pending save');
  /* Assert the shape, not one literal: pinning a version number makes every
     cache bump a test edit, which is how a stale shell ships by accident. */
  assert.match(sw, /const CACHE_NAME = 'final-effect-cpp-v\d+';/, 'the cache is bumped whenever the shipped shell changes');
});

test('a partial biome mix is merged, and the grown-flora settings survive the trip', () => {
  const { context, calls } = boot();
  const doc = {
    app: 'final-effect', kind: 'landscape-settings', version: 1,
    studio: { seed: 5, floraHeight: 1.4, floraDensity: 0.7, floraRules: 'X -> F[+X]F[-X]+X', waveAuto: true },
    openWorld: { sizeKm: 20, biomeMix: { hills: 1.6 } },
    climate: { wind: 11 }
  };
  vm.runInContext(`applyStudioConfig(${JSON.stringify(doc)})`, context);
  assert.equal(context.OW.config.sizeKm, 20);
  assert.equal(context.OW.config.biomeMix.hills, 1.6, 'the named influence is applied');
  assert.equal(context.OW.config.biomeMix.alpine, 1, 'and the three it does not mention are untouched');
  assert.equal(context.OW.config.biomeMix.volc, 1);
  assert.equal(calls.restored.length, 1);
  assert.equal(calls.restored[0].floraHeight, 1.4, 'the grown-flora sliders reach the restore path');
  assert.equal(calls.restored[0].floraRules, 'X -> F[+X]F[-X]+X', 'so does the grammar text');
  assert.equal(calls.restored[0].waveAuto, true, 'and the sea-follows-the-weather switch');

  /* The live capture and restore in the studio carry the same fields, and the
     restore actually switches the mode back on instead of dropping it. */
  const capture = readFileSync('terrain-main-04.js', 'utf8');
  for (const key of ['floraHeight', 'floraDensity', 'floraRules', 'waveAuto']) {
    assert.ok(capture.includes(key), `${key} is captured and restored by the studio itself`);
  }
  assert.ok(capture.includes("waveAuto=a.waveAuto;waveAutoApplied=-1;"), 'the saved switch is applied, not just carried');
  assert.ok(capture.includes('if(waveAuto&&typeof stepWaveClimate===\'function\')stepWaveClimate()'),
    'and restoring an on switch re-derives the sea from the current wind immediately');
});

/* ------------------------------------------------------------------ */
/* World size: a streamed bound, not an allocation                     */
/* ------------------------------------------------------------------ */

function worldContext() {
  const source = readFileSync('terrain-main-03.js', 'utf8');
  const block = source.slice(source.indexOf('function owChunkBytes'), source.indexOf('window.__feWorldMemory'));
  const calls = { disposed: 0, refreshed: 0, radius: 0, status: [] };
  const chunk = (cx, cz, n = 65) => ({
    key: cx + ',' + cz, cx, cz, size: 256, segments: n - 1,
    heights: new Float32Array(n * n), surfaceWeights: new Float32Array(n * n * 12),
    group: { parent: null }, terrain: { geometry: { dispose() {} } }, foliageMeshes: []
  });
  const context = {
    console, Math, Number, String, Object, Array,
    cl: (v, a, b) => Math.min(b, Math.max(a, v)),
    OW: {
      active: true, chunkSize: 256, config: { sizeKm: 12 }, currentConfig: { sizeKm: 12 },
      chunks: new Map(), editStore: new Map(), lastCenterX: 3, lastCenterZ: 3
    },
    owValidChunk(cx, cz) {
      const half = context.OW.config.sizeKm * 500, edge = 128;
      return Math.abs(cx * 256) - edge <= half && Math.abs(cz * 256) - edge <= half;
    },
    owDisposeChunk(c) { calls.disposed++; context.OW.editStore.set(c.key, { cx: c.cx, cz: c.cz, heights: c.heights, surfaceWeights: c.surfaceWeights }); },
    owRefresh(force) { calls.refreshed++; calls.force = force; },
    setOpenWorldWaterRadius() { calls.radius++; },
    owStatus(text) { calls.status.push(text); }
  };
  context.window = context;
  context.__chunk = chunk;
  context.__calls = calls;
  vm.createContext(context);
  vm.runInContext(block, context);
  return context;
}

test('a bigger world streams further without using more memory', () => {
  const ctx = worldContext();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) ctx.OW.chunks.set(cx + ',' + cz, ctx.__chunk(cx, cz));
  const before = ctx.owMemory();
  assert.equal(before.chunks, 9);
  assert.equal(before.bytes, 9 * (65 * 65 * 4 + 65 * 65 * 12 * 4), 'the resident set is the nine chunks, nothing else');

  assert.equal(ctx.owSetWorldSize(50), true);
  assert.equal(ctx.OW.config.sizeKm, 50);
  assert.equal(ctx.__calls.disposed, 0, 'growing keeps the chunks you are standing on');
  assert.equal(ctx.__calls.refreshed, 1, 'the streamer is asked to fill the new ring');
  assert.equal(ctx.__calls.force, true);
  assert.equal(ctx.__calls.radius, 1, 'the water plane is re-sized, not re-allocated by area');
  assert.deepEqual(ctx.owMemory(), before, 'a 50 km world costs exactly what a 12 km world cost');

  assert.equal(ctx.owSetWorldSize(60), false, 'a value outside the range is not a change');
  ctx.OW.chunks.set('5,0', ctx.__chunk(5, 0));
  assert.equal(ctx.owSetWorldSize(0), true, 'zero clamps to the 1 km minimum');
  assert.equal(ctx.OW.config.sizeKm, 1);
  assert.equal(ctx.__calls.disposed, 1, 'shrinking disposes only the chunks now outside the edge');
  assert.equal(ctx.OW.chunks.size, 9, 'the resident ring survives');
  assert.equal(ctx.OW.editStore.size, 1, 'the edited chunk moves to the edit store rather than leaking');
  assert.match(ctx.__calls.status.join(' '), /World size 1 km/);
});

test('the sheet routes world size through the streamer and says what it costs', () => {
  assert.match(panel, /owSetWorldSize\(v\)/, 'the slider calls the streamer instead of writing the field');
  assert.match(panel, /larger world streams further instead of using more memory/, 'the sheet explains the bound');
  assert.match(readFileSync('terrain-main-03.js', 'utf8'), /window\.__feWorldMemory=owMemory/, 'the memory report is reachable for diagnostics');
});
