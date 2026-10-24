import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* The off-thread kernel channel.
 *
 * A worker is the kind of code that works in a demo and fails on a phone: the
 * blob URL is blocked, the module will not compile twice, a job throws and the
 * promise never settles. So the tests here do not trust the happy path — they
 * run the *actual* worker source inside a sandbox, compare its bytes against
 * the inline path, and check that every failure mode still answers. */

const wasm = readFileSync('wasm/fe_core_engine.wasm');
const workerSource = readFileSync('kernel-worker.js', 'utf8');
const floraSource = readFileSync('landscape-flora.js', 'utf8');
const terrain03 = readFileSync('terrain-main-03.js', 'utf8');
const buildScript = readFileSync('scripts/build.mjs', 'utf8');
const sw = readFileSync('sw.js', 'utf8');
const html = readFileSync('Terrain_system_.html', 'utf8');

/* A browser-shaped sandbox around the worker body: `self`, postMessage into a
   queue, and the real WebAssembly so the artifact actually runs. */
function spawnWorker(sandboxGlobal) {
  const posted = [];
  const context = vm.createContext({
    WebAssembly, Uint8Array, Uint32Array, Float32Array, Math, console,
    self: null,
    postMessage: (value) => posted.push(value),
    ...sandboxGlobal
  });
  context.self = { postMessage: context.postMessage };
  vm.runInContext(workerSource, context);
  /* The worker source is not factory-shaped: the file defines FEKernelWorker
     and the stringified body separately. Grab the body the same way the client
     does, so this test exercises the shipped text and not a copy of it. */
  const body = context.FEKernelWorker.source();
  vm.runInContext(body, context);
  return { context, posted, post: (message) => context.self.onmessage({ data: message }) };
}

async function boot(atlas) {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array,
    Math, Promise, setTimeout, TextDecoder, TextEncoder,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
  };
  vm.createContext(context);
  vm.runInContext(readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0], context);
  await context.FELandscapeCore.loading;
  context.THREE = THREE;
  vm.runInContext(workerSource, context);
  vm.runInContext(floraSource, context);
  if (atlas) vm.runInContext(atlas, context);
  return context;
}

test('the worker body boots the artifact and answers a job', async () => {
  const worker = spawnWorker({});
  worker.post({ type: 'init', protocol: 1, bytes: new Uint8Array(wasm) });
  assert.equal(worker.posted[0]?.type, 'ready', 'the worker announces itself once the module is live');
  assert.equal(worker.posted[0]?.protocol, 1);

  const before = worker.posted.length;
  worker.post({ type: 'job', id: 7, name: 'impostor', args: { kind: 18, seed: 4242, detail: 2, views: 8 } });
  /* A worker message handler is synchronous, and the job is too: the answer is
     already in the queue when this line returns. */
  const answer = worker.posted[worker.posted.length - 1];
  assert.equal(worker.posted.length, before + 1);
  assert.equal(answer.type, 'result');
  assert.equal(answer.id, 7);
  assert.equal(answer.value.views, 8, 'eight azimuths come back');
  assert.ok(answer.value.quadW > 0.1 && answer.value.quadW < 40, 'the quad width is in metres');
  assert.ok(answer.value.quadH > 0.1 && answer.value.quadH < 40, 'the quad height is in metres');
  assert.equal(answer.pixels.length, answer.value.width * answer.value.height * 8 * 4,
    'the pixels are a full eight-tile atlas');
  assert.ok(answer.pixels.byteLength > 0);
});

test('the worker and the main thread bake the same atlas', async () => {
  const worker = spawnWorker({});
  worker.post({ type: 'init', protocol: 1, bytes: new Uint8Array(wasm) });
  const context = await boot('');
  const core = context.FELandscapeCore;

  for (const kind of [0, 16, 18]) {
    worker.post({ type: 'job', id: kind + 1, name: 'impostor', args: { kind, seed: 99, detail: 2, views: 8 } });
    const off = worker.posted[worker.posted.length - 1];
    const on = core.impostor(kind, 99, 2, 8);
    assert.equal(off.value.views, on.views);
    assert.equal(off.value.width, on.width);
    assert.equal(off.value.quadW, on.quadW, 'the quad width must not depend on which thread baked it');
    assert.equal(off.value.cropU, on.cropU);
    let diff = 0;
    for (let i = 0; i < on.pixels.length; i++) if (off.pixels[i] !== on.pixels[i]) diff++;
    assert.equal(diff, 0, `species ${kind}: the two instances must produce byte-identical atlases, ${diff} bytes differed`);
  }
  void context;
});

test('a bad job answers with an error instead of hanging', async () => {
  const worker = spawnWorker({});
  worker.post({ type: 'init', protocol: 1, bytes: new Uint8Array(wasm) });
  worker.post({ type: 'job', id: 3, name: 'not-a-job', args: {} });
  const answer = worker.posted[worker.posted.length - 1];
  assert.equal(answer.type, 'error');
  assert.match(answer.message, /Unknown kernel job/);
  /* An impossible species is a null result, not a crash. */
  worker.post({ type: 'job', id: 4, name: 'impostor', args: { kind: 999, seed: 1, detail: 2, views: 8 } });
  const last = worker.posted[worker.posted.length - 1];
  assert.equal(last.type, 'result');
  assert.equal(last.value, null, 'a failed bake returns null so the caller keeps the low mesh');
});

test('a worker that cannot boot degrades to the inline path and still finishes', async () => {
  const context = await boot('');
  const api = context.FEKernelWorker;
  /* No Worker constructor in this sandbox, exactly like a locked-down browser. */
  const channel = api.create({ api: context.FELandscapeCore, bytes: new Uint8Array(wasm) });
  assert.equal(channel.mode(), 'inline');
  const ready = await channel.ready;
  assert.equal(ready, false, 'the caller is told there is no thread, without an exception');
  const value = await channel.run('impostor', { kind: 18, seed: 5, detail: 1, views: 8 });
  assert.ok(value && value.pixels, 'the job still runs, on this thread');
  assert.equal(channel.stats().ranInline, 1);
  assert.equal(channel.stats().ranOffThread, 0);
});

test('a job that throws rejects with a message the caller can show', async () => {
  const context = await boot('');
  const api = context.FEKernelWorker;
  const channel = api.create({ api: { impostor: () => { throw new Error('kernel exploded'); } }, bytes: new Uint8Array(wasm) });
  await assert.rejects(() => channel.run('impostor', { kind: 0, seed: 1, detail: 2, views: 8 }), /kernel exploded/);
  assert.match(channel.stats().lastError, /kernel exploded/);
});

test('the studio bakes asynchronously and never blocks a frame doing it', async () => {
  /* The bake queue must hand the work to impostorAsync, cap the number in
     flight, and route the species when the atlas lands. */
  assert.match(terrain03, /const IMPOSTOR_INFLIGHT=2;/, 'a small number of bakes may run at once');
  assert.match(terrain03, /if\(!impostorWanted\.size\|\|impostorBakes>=IMPOSTOR_INFLIGHT\)return;/, 'the queue is capped');
  assert.match(terrain03, /f\.impostorAsync\(k,seed,detail\)\.then\(atlas=>\{/, 'the bake is a promise');
  assert.match(terrain03, /if\(impostorMeshFromAtlas\(k,atlas\)\)sync\(k\);/, 'the species is re-routed the moment its atlas lands');
  assert.match(terrain03, /impostorBakes--;/, 'an in-flight slot is always released, even on failure');
  assert.match(terrain03, /function impostorMeshFromAtlas\(k,atlas\)\{/, 'the mesh can be built from pixels that arrived later');
  /* And the sync path still exists for an atlas that is already cached. */
  assert.match(terrain03, /return impostorMeshFromAtlas\(k,f\.impostor\(k,seed,detail\)\);/, 'a cached atlas still builds synchronously');
});

test('the channel is loaded before the flora uses it, in the build and in the shell', () => {
  assert.match(html, /<script src="\.\/kernel-worker\.js"><\/script>\s*<script src="\.\/landscape-flora\.js">/,
    'kernel-worker.js must load before landscape-flora.js, or the first bake takes the inline path');
  assert.match(buildScript, /"kernel-worker\.js",\n\s+"landscape-realism\.js"/, 'the build copies it');
  assert.match(buildScript, /"fe-cpp-engine\.js",\n\s+"kernel-worker\.js"/, 'and minifies it');
  assert.match(sw, /'\.\/kernel-worker\.js'/, 'and the service worker caches it, or an installed client has no worker');
});

test('impostorAsync caches, shares an in-flight bake and resets', async () => {
  const context = await boot('');
  const flora = context.FELandscapeFlora;
  const a = flora.impostorAsync('pine', 4242, 2);
  const b = flora.impostorAsync('pine', 4242, 2);
  assert.equal(a, b, 'the same species does not bake twice while one is in flight');
  assert.ok(flora.impostorBusy() >= 1);
  const atlas = await a;
  assert.ok(atlas && atlas.texture, 'the atlas arrives with a texture');
  assert.equal(flora.impostorBusy(), 0, 'the in-flight entry is cleared');
  const again = await flora.impostorAsync('pine', 4242, 2);
  assert.equal(again, atlas, 'a baked atlas is reused');
  flora.impostorReset();
  assert.equal(flora.impostorCount(), 0);
  const after = await flora.impostorAsync('pine', 4242, 2);
  assert.notEqual(after, atlas, 'a reset drops the texture and the next call bakes again');
});
