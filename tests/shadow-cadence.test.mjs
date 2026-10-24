import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

/* A shadow map is a second pass over every caster in the scene. In the
 * landscaping studio the sun follows the camera target in 2 m steps at most
 * five times a second, so the shadow map is usually the same picture as the
 * frame before it — and three.js renders it again anyway, because that is what
 * autoUpdate does.
 *
 * The studio now drives `shadowMap.needsUpdate` itself, from `shadowCadence`:
 * immediately when the focus or the sun moved, otherwise at 30 Hz so the wind
 * sway in the foliage depth material stays alive. These tests run the real
 * function, sliced out of the shipped script, against a fake renderer. */

const FOCUS = readFileSync('terrain-main-04.js', 'utf8');
const SCENE = readFileSync('terrain-main-01.js', 'utf8');
const LOOP = readFileSync('terrain-main-09.js', 'utf8');

function cadence() {
  const start = FOCUS.indexOf('const SHADOW_INTERVAL_MS=');
  const end = FOCUS.indexOf('function updateDirectionalShadowFocus');
  assert.ok(start > 0 && end > start, 'shadowCadence must stay a separate, testable function');
  const slice = FOCUS.slice(start, end);
  const context = {
    ren: { shadowMap: { enabled: true, needsUpdate: false } },
    __out: null
  };
  vm.createContext(context);
  vm.runInContext(slice + '\n__out={cadence:shadowCadence,dirty:()=>{shadowDirty=true},updates:()=>shadowUpdates,interval:SHADOW_INTERVAL_MS};', context);
  return { context, api: context.__out };
}

test('a still scene asks for a new shadow map at 30 Hz, not every frame', () => {
  const { context, api } = cadence();
  const map = context.ren.shadowMap;
  api.cadence(1000);
  assert.equal(map.needsUpdate, true, 'the first tick arms an update');

  map.needsUpdate = false;
  api.cadence(1005);
  assert.equal(map.needsUpdate, false, '5 ms later the same map is still valid');

  map.needsUpdate = false;
  api.cadence(1010);
  assert.equal(map.needsUpdate, false);

  map.needsUpdate = false;
  api.cadence(1016);   /* 16 ms after the armed frame: half the interval */
  assert.equal(map.needsUpdate, false, '16 ms is a 60 Hz cadence, not the one we chose');

  map.needsUpdate = false;
  api.cadence(1040);   /* 40 ms after the armed frame */
  assert.equal(map.needsUpdate, true);
});

test('a moved sun or focus updates on the very next frame', () => {
  const { context, api } = cadence();
  const map = context.ren.shadowMap;
  api.cadence(2000);
  map.needsUpdate = false;
  api.cadence(2001);
  assert.equal(map.needsUpdate, false);

  api.dirty();                 /* updateDirectionalShadowFocus moved the light */
  api.cadence(2002);           /* one frame later */
  assert.equal(map.needsUpdate, true, 'the frame after the sun moved must re-render the map');
  const before = api.updates();
  api.cadence(2003);
  api.cadence(2004);
  assert.equal(api.updates(), before, 'a dirty flag is consumed once, not held down');
});

test('a renderer with shadows switched off pays nothing', () => {
  const { context, api } = cadence();
  context.ren.shadowMap.enabled = false;
  context.ren.shadowMap.needsUpdate = false;
  api.cadence(3000);
  assert.equal(context.ren.shadowMap.needsUpdate, false);
});

test('the interval is a real cadence, and the loop calls it before every draw', () => {
  const { api } = cadence();
  assert.ok(api.interval >= 16 && api.interval <= 40, `interval ${api.interval} ms should be 16–40 ms`);

  assert.match(SCENE, /ren\.shadowMap\.autoUpdate=false/, 'the studio must own the cadence');
  assert.match(SCENE, /ren\.shadowMap\.needsUpdate=true/, 'the first frame must not be shadowless');

  const loop = LOOP.slice(LOOP.indexOf('function loop(){'));
  const cadenceAt = loop.indexOf('shadowCadence(n)');
  const renderAt = loop.indexOf('ren.render(scene,cam)');
  assert.ok(cadenceAt > 0, 'the loop must drive the cadence');
  assert.ok(renderAt > cadenceAt, 'the cadence has to run before the draw that uses it');

  /* The focus function is the only thing that moves the sun, so it is the only
     thing that has to raise the flag. */
  const focus = FOCUS.slice(FOCUS.indexOf('function updateDirectionalShadowFocus'));
  assert.match(focus.slice(0, 900), /shadowDirty=true/);
});

test('the 3D workspace keeps its own 30 Hz shadow cadence', () => {
  const shell = readFileSync('index.html', 'utf8');
  assert.match(shell, /r\.shadowMap\.autoUpdate = false/);
  const tick = shell.slice(shell.indexOf('shadowMap.autoUpdate === false'));
  assert.match(tick.slice(0, 200), /needsUpdate = true/, 'the viewport loop must arm the update');
});
