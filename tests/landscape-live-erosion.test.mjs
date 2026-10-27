import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* Time-sliced erosion, end to end below the shader: the C++ kernel owns the run
   and the rectangle, the bridge reads back only that rectangle, and the
   controller decides *whether* a frame should be spent at all. The kernel's own
   arithmetic is pinned in tests/landscape-cpp.test.mjs; this file pins the two
   JavaScript layers and the pause matrix. */

const wasm = readFileSync('wasm/fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const controllerSource = readFileSync('terrain-main-03.js', 'utf8');
const panel = readFileSync('terrain-main-07.js', 'utf8');
const loop = readFileSync('terrain-main-09.js', 'utf8');
const cppBuild = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');

async function bootBridge() {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int16Array, Int32Array,
    Uint16Array, Math, Promise, setTimeout,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  await context.FELandscapeCore.loading;
  assert.equal(context.FELandscapeCore.ready, true);
  return context.FELandscapeCore;
}

const GRID = 64, SPAN = 512, ROW = GRID + 1;

const PALETTE = [.28, .5, .16, .42, .29, .17, .42, .42, .44, .64, .56, .38, .92, .94, .98];
/* A real, seeded hillside in the kernel — a flat field has no gradient, so a
   droplet would stop immediately and there would be nothing to report. */
function field(core) {
  const heights = new Float32Array(ROW * ROW);
  assert.equal(core.generate({ n: GRID, size: SPAN, heights, pal: PALETTE, seed: 42, hs: 9 }), true);
  return heights;
}

test('the bridge starts a live run, reads back only the touched rectangle, and can stop', async () => {
  const core = await bootBridge();
  const heights = field(core);
  const before = heights.slice();
  assert.equal(core.erosionBegin({ n: GRID, size: SPAN, droplets: 4000, heights, seed: 5 }), true);
  assert.equal(core.erosionActive(), true);
  assert.equal(core.erosionRemaining(), 4000);

  assert.equal(core.erosionRegion(0, 0, 60), true);
  assert.equal(core.erosionStep(700), 700);
  const touched = core.erosionRead(heights);
  assert.equal(touched, true, 'the kernel reports a rectangle after a slice');
  const rect = core.erosionRect;
  assert.ok(rect[1] >= rect[0] && rect[3] >= rect[2], 'the rectangle is ordered');
  assert.ok((rect[1] - rect[0] + 1) * (rect[3] - rect[2] + 1) < ROW * ROW, 'and is a fraction of the grid');

  /* Every changed cell is inside the rectangle, and the cells outside it are
     still bit-identical — the bridge copied exactly what the kernel listed. */
  let changed = 0;
  for (let j = 0; j < ROW; j++) for (let i = 0; i < ROW; i++) {
    const k = j * ROW + i;
    if (before[k] === heights[k]) continue;
    changed++;
    assert.ok(i >= rect[0] && i <= rect[1] && j >= rect[2] && j <= rect[3], `cell ${i},${j} is inside the rectangle`);
  }
  assert.ok(changed > 50, 'the slice actually moved the ground');

  assert.equal(core.erosionRead(heights), false, 'a second read without a new slice reports nothing');
  core.erosionCancel();
  assert.equal(core.erosionActive(), false);
  assert.equal(core.erosionStep(100), -1, 'a cancelled run cannot be stepped');
});

test('a run starts from the JavaScript field, never from whatever the kernel held', async () => {
  const core = await bootBridge();
  /* A field the kernel has never seen: if the bridge did not upload it, the
     droplets would erode a flat zero grid and the copy-back would destroy the map. */
  const heights = new Float32Array(ROW * ROW);
  for (let j = 0; j < ROW; j++) for (let i = 0; i < ROW; i++) {
    heights[j * ROW + i] = 18 + 6 * Math.sin(i * 0.11) * Math.cos(j * 0.08);
  }
  const before = heights.slice();
  assert.equal(core.erosionBegin({ n: GRID, size: SPAN, droplets: 3000, heights, seed: 11 }), true);
  assert.equal(core.erosionRegion(0, 0, 70), true);
  while (core.erosionRemaining() > 0) {
    core.erosionStep(700);
    assert.equal(core.erosionRead(heights), true);
  }
  let absorbed = 0, moved = 0;
  for (let k = 0; k < heights.length; k++) {
    const delta = Math.abs(heights[k] - before[k]);
    assert.ok(heights[k] > 2, 'the map was not flattened to zero');
    if (delta > 0) moved++;
    absorbed = Math.max(absorbed, delta);
  }
  assert.ok(moved > 100, 'the run changed the ground');
  assert.ok(absorbed < 12, 'and only by erosion, not by replacing the field');
});

test('the bridge rebuilds the normals of the uploaded band, identical to a full pass', async () => {
  const core = await bootBridge();
  const heights = field(core);
  /* Full pass first, so the kernel's field and the JS copy are the same before
     the band pass is asked to reproduce it. */
  const full = new Float32Array(ROW * ROW * 3);
  assert.equal(core.normals({ n: GRID, size: SPAN, heights, output: full }), true);
  const out = new Float32Array(ROW * ROW * 3);
  const rect = [10, 40, 12, 44];
  assert.equal(core.normalsRegion({ n: GRID, size: SPAN, heights, rect, output: out }), true);
  const band = out.slice();
  let compared = 0;
  for (let j = 12; j <= 44; j++) for (let i = 10; i <= 40; i++) {
    const k = (j * ROW + i) * 3;
    assert.equal(band[k], full[k], `x of ${i},${j}`);
    assert.equal(band[k + 1], full[k + 1], `y of ${i},${j}`);
    assert.equal(band[k + 2], full[k + 2], `z of ${i},${j}`);
    compared++;
  }
  assert.equal(compared, 31 * 33, 'the whole band was compared');
  assert.equal(band[0], 0, 'and nothing outside the band was written');
});

/* ------------------------------------------------------------------ */
/* The controller: when a frame is allowed to erode                    */
/* ------------------------------------------------------------------ */

const TICK_MARK = 'window.__feLiveErosionTick=liveErosionTick;';
const CONTROLLER = controllerSource.slice(controllerSource.indexOf('/* --- Live erosion ---'), controllerSource.indexOf(TICK_MARK) + TICK_MARK.length);

function controller({ visible = true, hidden = false, sheet = 'terrain', brushing = false, remaining = 4000 } = {}) {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  const target = new THREE.Vector3(0, 0, 0);
  camera.position.set(0, 90, 140);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  /* Point the camera away from the patch for the off-screen case. */
  if (!visible) { camera.position.set(0, 90, -140); camera.lookAt(new THREE.Vector3(0, 90, -200)); camera.updateMatrixWorld(); }
  const calls = { steps: 0, uploaded: [], pushed: 0, updated: 0, snapped: 0, region: [], status: '', built: 0, errors: [] };
  const state = { remaining, ran: 0 };
  const fake = {
    ready: true,
    error: null,
    erosionBegin: () => true,
    erosionRegion: (x, z, r) => { calls.region.push([x, z, r]); return true; },
    erosionStep: (n) => {
      calls.steps++;
      const run = Math.min(n, state.remaining);
      state.remaining -= run; state.ran += run;
      return run;
    },
    erosionRead: (H) => { H[0] += 1; return true; },
    erosionRect: [4, 20, 4, 20],
    erosionRemaining: () => state.remaining,
    erosionActive: () => state.remaining > 0,
    erosionCancel: () => { state.remaining = 0; }
  };
  const node = { textContent: '' };
  const context = {
    console, Math, Number, String, Object, Array, THREE,
    window: null, cam: camera, oc: { target }, N: GRID, S: SPAN, H: new Float32Array(ROW * ROW),
    tab: sheet, seed: 7, document: { hidden, getElementById: (id) => (id === 'erosion-live' ? node : null) },
    FELandscapeCore: fake,
    hgt: () => 0, cl: (v, a, b) => Math.min(b, Math.max(a, v)),
    nowMs: () => Date.now(), performance,
    updLive: (x0, x1, z0, z1) => calls.uploaded.push([x0, x1, z0, z1]),
    upd: () => { calls.updated++; }, resnap: () => { calls.snapped++; }, push: () => { calls.pushed++; },
    build: () => { calls.built++; }, showErr: (e) => calls.errors.push(e),
    OW: { active: false }
  };
  if (brushing) context.painting = true;
  context.window = context;
  context.__state = state;
  context.__calls = calls;
  context.__node = node;
  vm.createContext(context);
  vm.runInContext(CONTROLLER, context);
  return context;
}

test('live erosion pauses itself instead of spending frames you cannot see', () => {
  const cases = [
    { name: 'hidden tab', opts: { hidden: true } },
    { name: 'another sheet open', opts: { sheet: 'plants' } },
    { name: 'patch off screen', opts: { visible: false } },
    { name: 'a brush stroke in progress', opts: { brushing: true } }
  ];
  for (const { name, opts } of cases) {
    const ctx = controller(opts);
    assert.equal(ctx.startLiveErosion(), true, name);
    ctx.liveErosionTick(1000);
    assert.equal(ctx.__state.remaining, 4000, `${name}: no droplets were simulated`);
    assert.equal(ctx.__calls.steps, 0, `${name}: the kernel was not called`);
    assert.match(ctx.__node.textContent, /Paused/, `${name}: the sheet says why`);
  }
  const live = controller();
  live.startLiveErosion();
  live.liveErosionTick(1000);
  assert.equal(live.__calls.steps, 1, 'with a clear view the frame erodes');
  assert.ok(live.__state.remaining < 4000);
  /* The sheet's number is the width of the patch, so the kernel gets half of it. */
  assert.deepEqual(live.__calls.region.at(-1), [0, 0, vm.runInContext('LIVE.area', live) / 2]);
});

test('the eroded rectangle is uploaded on a cadence, not every frame', () => {
  const ctx = controller({ remaining: 100000 });
  ctx.startLiveErosion();
  let now = 1000;
  for (let f = 0; f < 10; f++, now += 8) ctx.liveErosionTick(now);
  const early = ctx.__calls.uploaded.length;
  assert.ok(early <= 2, 'eighty milliseconds of frames do not upload ten times');
  for (let f = 0; f < 10; f++, now += 8) ctx.liveErosionTick(now);
  assert.ok(ctx.__calls.uploaded.length > early, 'but a band is uploaded as the run continues');
  const [x0, x1, z0, z1] = ctx.__calls.uploaded[0];
  assert.ok(x0 <= 4 && x1 >= 20 && z0 <= 4 && z1 >= 20, 'the uploaded band covers the changed rectangle plus a halo');
});

test('the live status reports progress and patch size, not a frame-time readout', () => {
  const ctx = controller({ remaining: 20000 });
  ctx.startLiveErosion();
  let now = 1000;
  for (let f = 0; f < 6; f++, now += 40) ctx.liveErosionTick(now);
  const text = ctx.__node.textContent;
  assert.match(text, /Eroding · \d+ \/ 20000 droplets/);
  assert.match(text, /cells|m patch/, 'it says how big the eroded patch is');
  assert.ok(!/ms|fps|frame/i.test(text), 'no frame-time readout in the sheet');
});

test('a run that the kernel lost stops instead of pretending to erode', () => {
  const ctx = controller({ remaining: 5000 });
  ctx.startLiveErosion();
  ctx.liveErosionTick(1000);
  /* Regenerating the grid calls fe_terrain_init, which cancels the run. */
  ctx.FELandscapeCore.erosionStep = () => -1;
  ctx.FELandscapeCore.erosionRemaining = () => 0;
  ctx.FELandscapeCore.erosionActive = () => false;
  ctx.liveErosionTick(1040);
  assert.equal(ctx.__feLiveErosion.on, false, 'the run is over');
  assert.match(ctx.__node.textContent, /the terrain was rebuilt/);
  assert.equal(ctx.__calls.snapped, 1, 'and the plants were settled');
});

test('a finished run stops, refreshes the whole terrain once, and reports its total', () => {
  const ctx = controller({ remaining: 1500 });
  ctx.startLiveErosion();
  const before = ctx.__calls.updated;
  let now = 1000;
  for (let f = 0; f < 40 && vm.runInContext('LIVE.on', ctx); f++, now += 40) ctx.liveErosionTick(now);
  assert.equal(vm.runInContext('LIVE.on', ctx), false, 'the run ended by itself');
  assert.ok(ctx.__calls.updated > before, 'the whole terrain is refreshed once at the end');
  assert.match(ctx.__node.textContent, /Erosion finished · 1500 droplets/);
});

test('starting a run takes exactly one undo snapshot and refuses to fight the open world', () => {
  const ctx = controller();
  ctx.startLiveErosion();
  assert.equal(ctx.__calls.pushed, 1, 'one undo step for the whole run, taken before the first droplet');
  ctx.startLiveErosion();
  assert.equal(ctx.__calls.pushed, 1, 'pressing again does not stack snapshots');
  ctx.stopLiveErosion();
  assert.equal(ctx.__calls.updated, 1, 'stopping refreshes the terrain');
  assert.equal(ctx.__calls.snapped, 1, 'and drops everything standing on the eroded ground back onto it');

  const ow = controller();
  ow.OW.active = true;
  assert.equal(ow.startLiveErosion(), false);
  assert.equal(ow.__calls.pushed, 0, 'nothing is snapshotted for a run that never starts');
  assert.match(ow.__calls.errors[0], /island terrain/);
});

test('the slice size follows the measured cost of the previous frame', () => {
  const ctx = controller({ remaining: 1000000 });
  ctx.startLiveErosion();
  assert.equal(vm.runInContext('LIVE.trim', ctx), 1);
  /* A deliberately slow kernel: each call burns the budget, so the trim falls. */
  const slow = ctx.FELandscapeCore.erosionStep;
  ctx.FELandscapeCore.erosionStep = (n) => { const t = Date.now(); while (Date.now() - t < 6); return slow(n); };
  ctx.liveErosionTick(1000);
  ctx.liveErosionTick(1040);
  const trimmed = vm.runInContext('LIVE.trim', ctx);
  assert.ok(trimmed < 1, 'a slow frame lowers the droplet budget');
  ctx.FELandscapeCore.erosionStep = slow;
  for (let f = 0; f < 12; f++) ctx.liveErosionTick(2000 + f * 40);
  assert.ok(vm.runInContext('LIVE.trim', ctx) > trimmed, 'and a fast one lets it recover');
  assert.ok(vm.runInContext('LIVE.trim', ctx) <= 1.8, 'but never past the ceiling');
});

test('a live slice does not rebuild the whole bounding sphere on every upload', () => {
  const src = readFileSync('terrain-main-01.js', 'utf8');
  const live = src.slice(src.indexOf('function updLive('), src.indexOf('let GENC=0'));
  assert.ok(!/boundingSphere=tg\.boundingBox=null/.test(live), 'the sphere is not thrown away every frame');
  assert.match(live, /tg\.geometry\.computeBoundingSphere\(\)/, 'it is recomputed deliberately');
  assert.match(live, /boundingSphere\.radius\+=1/, 'and padded, so a later rise stays inside it');
  assert.match(live, /bandY/, 'the band height is measured while the vertices are written');
});

test('the shader heightmap is patched in place, never re-uploaded whole', () => {
  const src = readFileSync('terrain-main-01.js', 'utf8');
  const a = src.indexOf('const HMB_ROWS=32;');
  const b = src.indexOf('function updLive(', a);
  assert.ok(a > 0 && b > a, 'the band patcher exists');
  const block = src.slice(a, b);
  const W = 513;
  const heights = new Float32Array(W * W);
  for (let k = 0; k < heights.length; k++) heights[k] = k % 97;
  const calls = [];
  const seen = new Map();
  const ren = {
    copyTextureToTexture: (pos, from) => {
      calls.push(pos.y);
      for (let r = 0; r < from.image.height; r++) for (let i = 0; i < W; i++) {
        seen.set((pos.y + r) * W + i, from.image.data[r * W + i]);
      }
    }
  };
  const THREE = { DataTexture: class { constructor(data, w, h) { this.image = { data, width: w, height: h }; } }, RedFormat: 1, FloatType: 2, NearestFilter: 3 };
  const fn = new Function('W', 'H', 'ren', 'hmTex', 'THREE', block + '\nreturn updLiveHeight;');
  const patch = fn(W, heights, ren, {}, THREE);

  /* A 65-row slice: three or four 32-row texSubImage2D blocks, not 513 rows. */
  assert.ok(patch(96, 160) <= 4, 'a wide slice is a handful of texture patches');
  assert.equal(patch(200, 200), 1, 'a single row is one patch');
  for (const [z0, z1] of [[96, 160], [0, 0], [40, 45], [500, 512], [0, 512]]) {
    calls.length = 0; seen.clear();
    patch(z0, z1);
    assert.ok(calls.length * 32 < W * 1.5, `rows ${z0}..${z1} cost ${calls.length} patches`);
    for (let z = z0; z <= z1; z++) for (let i = 0; i < W; i++) {
      assert.equal(seen.get(z * W + i), heights[z * W + i], `cell ${i},${z} was patched`);
    }
    for (const start of calls) assert.ok(start >= 0 && start + 32 <= W, 'every patch fits inside the texture');
  }

  /* The full refresh is what sets needsUpdate; the band patcher must not. */
  const live = src.slice(src.indexOf('function updLive('), src.indexOf('let GENC=0'));
  assert.ok(!/hmTex\.needsUpdate/.test(live), 'a live slice never triggers a whole-texture upload');
  assert.ok(/updLiveHeight\(z0,z1\)/.test(live), 'and it does patch the band');
});

test('the slice adapts to the cost of the whole tick, uploads included', () => {
  const ctx = controller({ remaining: 1000000 });
  ctx.startLiveErosion();
  /* A bridge whose band upload is the expensive part: the droplet loop is
     cheap, so a controller that only timed the droplets would never trim. */
  ctx.updLive = () => { const t = Date.now(); while (Date.now() - t < 6); };
  vm.runInContext('updLive=this.updLive', ctx);
  ctx.liveErosionTick(1000);   /* first tick carries an upload */
  ctx.liveErosionTick(1040);
  assert.ok(vm.runInContext('LIVE.trim', ctx) < 1, 'an expensive upload lowers the droplet budget');
});

test('the panel and the frame loop are wired to the live run', () => {
  for (const id of ['fe_erosion_begin', 'fe_erosion_step', 'fe_erosion_dirty_ptr', 'fe_erosion_set_region', 'fe_erosion_cancel']) {
    assert.ok(cppBuild.includes(`'${id}'`), `${id} is a required export`);
  }
  assert.match(loop, /updateFoliageLOD\(n\);frameStage='erosion';liveErosionTick\(n\);frameStage='';/,
    'the loop ticks the run once per frame, and names the stage so a fault can stop it');
  assert.equal((loop.match(/liveErosionTick\(/g) || []).length, 1, 'exactly one tick per frame');
  assert.match(panel, /\['hydro','💧 Hydraulic erosion'\]/, 'the chip survives');
  assert.match(panel, /if\(mode==='hydro'\)\{/, 'and it starts the live run instead of the blocking pass');
  assert.match(panel, /sl\('Erosion area \(m\)'/, 'the patch size is a runtime control');
  assert.match(panel, /sl\('Erosion rate ×'/, 'so is the rate');
  assert.ok(panel.includes('id="erosion-live"'), 'the sheet reports the live progress');
  /* The hydraulic press is live-only now: the blocking whole-map call survives
     for thermal erosion, which really is one pass, and for nothing else. */
  assert.equal((panel.match(/core\.erode\(\{mode:'thermal'/g) || []).length, 1, 'thermal erosion is still a single pass');
  assert.equal((panel.match(/core\.erode\(\{mode(?!:)/g) || []).length, 0, 'no call passes the chip mode straight to the blocking kernel');
});
