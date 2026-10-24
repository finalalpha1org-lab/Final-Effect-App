import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/* The 3D Workspace viewport runs `resume()`'s `t()` on every animation frame.
 *
 * The rule is the one the landscaping loop already lives by: a frame allocates
 * nothing and does no DOM lookups. That was not true here. With dynamic
 * autofocus on, every frame did two `getElementById` calls, a `toFixed(2)`
 * string, two DOM writes and a full `updateDoFFilter()` — which is another
 * dozen lookups plus a filter rebuild — whether or not the camera had moved.
 * With focus tracking set to "center" it also allocated a `THREE.Vector3` per
 * frame, which is one garbage object every 8 ms on a 120 Hz panel.
 *
 * These tests pin the shape of the loop, because none of it is visible: a
 * regression here shows up as a slightly warmer phone, not as a bug. */

const HTML = readFileSync('index.html', 'utf8');

function loopBody() {
  const start = HTML.indexOf('    const t=()=>{\n      if(!this._viewportRunning)return;');
  assert.ok(start > 0, 'the viewport loop is in index.html');
  const end = HTML.indexOf('\n    t();', start);
  assert.ok(end > start, 'and it is invoked once');
  return HTML.slice(start, end);
}

test('the viewport frame loop does not allocate', () => {
  const body = loopBody();
  /* Every `new THREE.x` left in the loop is behind a `|| (this._x = new ...)`
     one-time guard. Anything else is a per-frame allocation. */
  const allocations = body.match(/new THREE\.[A-Za-z]+/g) || [];
  assert.equal(allocations.length, 1, `unexpected per-frame allocations: ${allocations.join(', ')}`);
  assert.match(
    body,
    /this\._originV3 \|\| \(this\._originV3 = new THREE\.Vector3\(0, 0, 0\)\)/,
    'the focus-tracking zero vector is cached',
  );
  for (const banned of ['.filter(', '.map(', '.forEach(', 'Array.from', 'structuredClone']) {
    assert.equal(body.includes(banned), false, `the frame loop must not use ${banned}`);
  }
  /* The physics step ran `sc.children.forEach(child => ...)`: a closure per
     frame, before any other work. It is an index loop now. */
  const from = HTML.indexOf('function stepPhysicsSimulations(dt) {');
  const physics = HTML.slice(from, HTML.indexOf('\n}', from));
  assert.match(physics, /for \(let ci = 0; ci < kids\.length; ci\+\+\)/, 'the physics walk is an index loop');
  assert.equal(/children\.forEach\(/.test(physics), false, 'and no longer allocates a callback');
});

test('the viewport frame loop does not query the DOM', () => {
  const body = loopBody();
  const lookups = body.match(/getElementById/g) || [];
  /* Three, and each one inside a `=== undefined` guard: the elements are static
     markup, so a lookup is a setup cost, not a frame cost. */
  assert.equal(lookups.length, 3, 'only the three cached-element guards may look up the DOM');
  for (const id of ['cam-autofocus', 'cam-focus-distance', 'out-focus-distance']) {
    assert.ok(body.includes(`document.getElementById('${id}')`), `${id} is still wired`);
  }
  assert.equal(body.includes('querySelector'), false, 'no selector queries in a frame');
});

test('autofocus only touches the UI when the distance actually changed', () => {
  const body = loopBody();
  const calls = body.match(/updateDoFFilter\(\);/g) || [];
  assert.equal(calls.length, 1, 'the filter chain is rebuilt from one place');
  const guard = body.indexOf('Math.abs(dist - (this._afShown === undefined ? 1e9 : this._afShown)) > 0.01');
  const call = body.indexOf('updateDoFFilter();');
  assert.ok(guard > 0 && guard < call, 'the rebuild sits behind the change check');
  assert.match(body, /this\._afShown = dist;/, 'the last shown distance is remembered');
  assert.match(body, /this\.focusDistance = dist;/, 'and the DoF target still follows the camera');
  assert.match(
    body,
    /if \(fDist && document\.activeElement !== fDist && Math\.abs\(dist/,
    'dragging the slider still stops the loop from overwriting it',
  );
});

test('the shadow pass and the metrics the ⚙ sheet reads are still wired', () => {
  const body = loopBody();
  assert.match(body, /this\._shadowTick = \(this\._shadowTick \|\| 0\) \+ 1;/, 'the tick still advances');
  assert.match(body, /if \(this\._shadowTick % 2 === 0\) this\.r\.shadowMap\.needsUpdate = true;/, 'and only every other frame is armed');
  assert.match(body, /this\.viewportMetrics=\{frameIntervalMs/, 'the metrics block is still built');
  assert.match(body, /drawCalls:this\.r\.info\.render\.calls,triangles:this\.r\.info\.render\.triangles/, 'draw calls and triangles still reach the sheet');
  assert.match(body, /window\.FECppEngine\?\.tickPerformanceGovernor\(\);/, 'the governor is still fed');
});
