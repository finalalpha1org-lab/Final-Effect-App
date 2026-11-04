import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const bridge = readFileSync('fe-cpp-engine.js', 'utf8');

function loadApplyHighRefreshMode() {
  const start = html.indexOf('function applyHighRefreshMode');
  const end = html.indexOf('window.applyHighRefreshMode = applyHighRefreshMode;', start);
  assert.ok(start >= 0 && end > start, 'applyHighRefreshMode must exist');
  const code = html.slice(start, end);
  const state = { disposed: 0, enabled: [] };
  const shadow = { mapSize: { x: 2048, y: 2048, set(x, y) { this.x = x; this.y = y; } }, map: { dispose() { state.disposed++; } } };
  const taa = { setEnabled(value) { state.enabled.push(value); }, reset() { state.resets = (state.resets || 0) + 1; } };
  const renderer = {
    _pr: 2,
    getPixelRatio() { return renderer._pr; },
    setPixelRatio(value) { renderer._pr = value; },
    setSize() {},
    shadowMap: { type: 'PCFSoftShadowMap' },
  };
  const eng = { d: { shadow }, r: renderer, taa };
  const ctx = vm.createContext({
    window: { devicePixelRatio: 3 }, console,
    document: { getElementById: () => null },
    THREE: { PCFShadowMap: 'PCFShadowMap', PCFSoftShadowMap: 'PCFSoftShadowMap' },
    GLOBAL_SETTINGS: { taa: true },
    FE: { engines: { core: eng } },
  });
  vm.runInContext(code, ctx);
  return { ctx, shadow, taa, renderer, state, run: on => vm.runInContext(`applyHighRefreshMode(${on ? 'true' : 'false'})`, ctx) };
}

test('high refresh mode trades temporal AA and shadow resolution for frame rate', () => {
  const { ctx, run, shadow, state, renderer } = loadApplyHighRefreshMode();
  const source = html.slice(html.indexOf('function applyHighRefreshMode'), html.indexOf('window.applyHighRefreshMode = applyHighRefreshMode;'));

  /* The performance governor is the one writer of the pixel ratio, and this
     toggle is a ceiling it reads: `window.__feHighRefresh` in fe-cpp-engine.js
     says 1.5x instead of 2x. It used to set the ratio here as well, while the
     governor set it from the kernel's frame times, so the two resized the
     drawing buffer against each other. */
  assert.ok(!source.includes('setPixelRatio'), 'the toggle must not resize the viewport itself');
  const ceilings = bridge.slice(bridge.indexOf('const ceilings = window.__feHighRefresh'), bridge.indexOf('const floors = window.__feHighRefresh'));
  assert.match(ceilings, /\[1\.5, 1, 1\.25, 1\.5\]/, 'high refresh caps the render scale at 1.5x');
  assert.match(ceilings, /Math\.min\(native, 2\)/, 'and full quality may reach the device ratio up to 2x');

  run(true);
  assert.equal(ctx.window.__feHighRefresh, true, 'the governor is asked for the high-refresh ceiling');
  assert.equal(shadow.mapSize.x, 1024, 'shadow map drops to 1024²');
  assert.equal(shadow.mapSize.y, 1024);
  assert.equal(state.disposed, 1, 'the stale shadow map is released so three.js rebuilds it');
  assert.equal(renderer.shadowMap.type, 'PCFShadowMap', 'and the cheaper filter is used');
  assert.deepEqual(state.enabled, [false], 'temporal AA is paused');
  assert.equal(state.resets, 1, 'the history is thrown away with the pass');

  run(false);
  assert.equal(ctx.window.__feHighRefresh, false);
  assert.equal(shadow.mapSize.x, 2048);
  assert.equal(renderer.shadowMap.type, 'PCFSoftShadowMap', 'full quality restores the soft filter');
  assert.equal(state.enabled.at(-1), true, 'temporal AA is restored');
});

test('the flag is a user setting, persisted with the other workspace settings', () => {
  assert.ok(html.includes('id="ws-high-refresh"'), 'the settings sheet must expose the toggle');
  assert.ok(/DEFAULT_GLOBAL_SETTINGS=\{[^}]*highRefresh:false/.test(html), 'the default is off');
  assert.ok(html.includes('GLOBAL_SETTINGS.highRefresh = highRefresh.checked'));
  assert.ok(html.includes('persistGlobalSettings();') && html.includes('applyHighRefreshMode(highRefresh.checked)'));
});

test('the governor keeps a single TAA decision and publishes real per-frame costs', () => {
  assert.ok(bridge.includes('eng._autoTaa = true') && bridge.includes('eng._autoTaa = false'),
    'auto quality decides TAA in one place');
  const hysteresis = bridge.match(/eng\._autoTaaGood\s*>=\s*(\d+)/);
  assert.ok(hysteresis, 're-enabling TAA needs sustained good frames (no ping-pong)');
  assert.ok(Number(hysteresis[1]) >= 4,
    `TAA may only come back after a run of good frames, not one, and this asks for ${hysteresis[1]}`);
  assert.match(bridge, /eng\._autoTaaGood = 0/, 'a slow frame resets the run');
  assert.ok(!bridge.includes('eng.taa.setEnabled(wantTaa)'), 'the governor must not toggle TAA on its own timer');
  for (const key of ['cpuMs', 'renderMs', 'drawCalls', 'triangles']) {
    assert.ok(bridge.includes(`${key}:`), `perfStats must include ${key}`);
  }
  assert.ok(!bridge.includes('eng.r.setPixelRatio(recDpr)'), 'resolution stays native and sharp');
});

test('the workspace reports display capability separately from rendered FPS', () => {
  assert.ok(html.includes('function measureIdleDisplayHz'), 'an idle rAF sample measures the panel');
  assert.ok(html.includes('window.__feDisplayHz'));
  assert.ok(html.includes("put('ws-perf-raf'"));
  assert.ok(html.includes('<small>Display</small>'));
  assert.ok(html.includes('<small>Frame time</small>'));
});

test('shadow maps refresh on alternate frames instead of every frame', () => {
  assert.ok(html.includes('r.shadowMap.autoUpdate = false'), 'the renderer must not re-render shadows every frame');
  assert.ok(html.includes('r.shadowMap.needsUpdate = true;'), 'the first frame still needs a shadow pass');
  assert.ok(html.includes('if (this._shadowTick % 2 === 0) this.r.shadowMap.needsUpdate = true;'),
    'the viewport loop refreshes the shadow map every other frame');
});
