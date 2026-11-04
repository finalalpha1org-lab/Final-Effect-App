import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* The viewport's idle guard and its WebGL context handling live in index.html,
   next to the loop they belong to. Both are about the same report: the app is
   fast when it opens and slow after a while on a phone. The guard stops drawing
   frames nobody asked for; the context handlers put the canvas back when iOS
   takes it away. */

const html = readFileSync('index.html', 'utf8');

function guardSource() {
  const marker = html.indexOf('VIEWPORT IDLE GUARD');
  assert.ok(marker > 0, 'the guard section must exist');
  /* Start at the comment that introduces it, not inside that comment. */
  const start = html.lastIndexOf('/*', marker);
  const end = html.indexOf("FE.register('core',{", marker);
  assert.ok(end > start);
  return html.slice(start, end);
}

function loadGuard() {
  const ctx = vm.createContext({ performance, console, Math, Float64Array, Array, Object });
  /* No addEventListener in this context: the activity listeners are a browser
     detail, and the guard must not need them to be measurable. */
  vm.runInContext(guardSource(), ctx);
  return ctx;
}

function makeScene() {
  const mesh = {
    visible: true,
    children: [],
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    geometry: {
      attributes: { position: { count: 8, version: 0 } },
      index: { version: 0 },
      drawRange: { count: Infinity }
    },
    material: { color: { r: 0.2, g: 0.3, b: 0.7 }, opacity: 1 }
  };
  return { children: [mesh], updateMatrixWorld() { return this; } };
}

function makeCamera() {
  return {
    zoom: 1,
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1] },
    projectionMatrix: { elements: [1.2, 0, 0, 0, 0, 1.6, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    updateMatrixWorld() { return this; }
  };
}

const later = (ctx) => vm.runInContext('__feLastActivityAt', ctx) + 5000;

test('a still viewport is not redrawn, a moved one is', () => {
  const ctx = loadGuard();
  const cam = makeCamera();
  const scene = makeScene();
  const eng = { sc: scene, transformControls: null };
  const at = later(ctx);
  const draw = (time = at) => vm.runInContext('feShouldDrawFrame', ctx)(eng, cam, time);

  assert.equal(draw(), true, 'the first frame after an input is drawn');

  /* Three seconds later nothing has changed: no frame is worth drawing. */
  assert.equal(draw(at + 3000), false, 'an untouched scene must not redraw');
  assert.equal(draw(at + 8000), false, 'and it must stay idle');

  cam.matrixWorld.elements[12] = 1.5;
  assert.equal(draw(at + 8100), true, 'moving the camera is a new picture');
  assert.equal(draw(at + 8200), false, 'and then it is still again');

  scene.children[0].matrixWorld.elements[13] = 2;
  assert.equal(draw(at + 8300), true, 'moving an object is a new picture');
  assert.equal(draw(at + 8400), false);

  scene.children[0].geometry.attributes.position.version = 4;
  assert.equal(draw(at + 8500), true, 'a rewritten vertex buffer (a modifier, a solver) is a new picture');
  assert.equal(draw(at + 8600), false);

  scene.children[0].material.color.r = 0.9;
  assert.equal(draw(at + 8700), true, 'a changed material colour is a new picture');

  scene.children[0].visible = false;
  assert.equal(draw(at + 8800), true, 'hiding an object is a new picture');
  assert.equal(draw(at + 8900), false);

  /* An HDRI finishes decoding long after the file dialog closed, so the
     backdrop has to be part of the fingerprint. */
  scene.background = { getHex: () => 0x223344 };
  assert.equal(draw(at + 9000), true, 'a new backdrop is a new picture');
  assert.equal(draw(at + 9100), false);
  scene.background = { isTexture: true };
  assert.equal(draw(at + 9200), true, 'a sky texture is a new picture');
  assert.equal(draw(at + 9300), false);
  scene.environment = { isTexture: true };
  assert.equal(draw(at + 9400), true, 'image-based lighting is a new picture');
  assert.equal(draw(at + 9500), false);
});

test('input, a playing timeline, a gizmo drag and an orbiting camera always draw', () => {
  const ctx = loadGuard();
  const cam = makeCamera();
  const scene = makeScene();
  const eng = { sc: scene, transformControls: null };
  const shouldDraw = vm.runInContext('feShouldDrawFrame', ctx);
  const at = later(ctx);

  /* A pointer that has just landed: the frame it is about to change is drawn
     even though nothing in the scene records it yet. */
  vm.runInContext('feMarkViewportActive()', ctx);
  const justTouched = vm.runInContext('__feLastActivityAt', ctx);
  assert.equal(shouldDraw(eng, cam, justTouched + 100), true, 'a touch must draw the next frame');

  /* Idle again, then the things that move without a finger. */
  assert.equal(shouldDraw(eng, cam, justTouched + 5000), true, 'first frame after the touch');
  assert.equal(shouldDraw(eng, cam, justTouched + 5100), false);

  eng.transformControls = { dragging: true };
  assert.equal(shouldDraw(eng, cam, justTouched + 5200), true, 'the gizmo is being dragged');
  eng.transformControls = { dragging: false };

  ctx.timelineConfig = { isPlaying: true };
  assert.equal(shouldDraw(eng, cam, justTouched + 5300), true, 'the timeline is playing');
  ctx.timelineConfig = { isPlaying: false };

  eng.oc = { autoRotate: true };
  assert.equal(shouldDraw(eng, cam, justTouched + 5400), true, 'the camera is orbiting on its own');
  eng.oc = { autoRotate: false };
  assert.equal(shouldDraw(eng, cam, justTouched + 5500), false, 'and when they all stop, so does the drawing');

  /* The every-frame path must not allocate a fingerprint buffer per frame. */
  const guard = guardSource();
  assert.match(guard, /const __fePrintNow = new Float64Array\(24\)/, 'one reusable print buffer');
  assert.ok(!/new Float64Array\(24\)/.test(guard.slice(guard.indexOf('function feShouldDrawFrame'))),
    'the per-frame path allocates nothing');
});

test('the loop stops drawing but keeps its RAF chain and its frame-time metric honest', () => {
  const start = html.indexOf('  resume(){\n    if(this._viewportRunning)');
  const end = html.indexOf('\n});', start);
  const body = html.slice(start, end);
  assert.ok(body.includes('feShouldDrawFrame(this,idleCam,performance.now())'), 'the loop asks the guard');
  assert.ok(body.includes('this._lastViewportFrame=0;'),
    'after a skipped frame the interval is reset, or the next one reads as a stall');
  /* The skip happens after the RAF is scheduled, so the loop can wake itself. */
  const raf = body.indexOf('this.raf=requestAnimationFrame(t);');
  const skip = body.indexOf('feShouldDrawFrame(this');
  assert.ok(raf > 0 && raf < skip, 'the next frame is requested before this one is skipped');
});

test('a lost WebGL context is asked back and the passes that keep GPU state are reset', () => {
  assert.match(html, /addEventListener\('webglcontextlost'/);
  assert.match(html, /event\.preventDefault\(\);/, 'without preventDefault the browser never hands it back');
  assert.match(html, /addEventListener\('webglcontextrestored'/);
  const restore = html.slice(html.indexOf("addEventListener('webglcontextrestored'"), html.indexOf("addEventListener('webglcontextrestored'") + 700);
  assert.match(restore, /this\.taa\?\.reset\?\.\(\)/, 'the temporal history is stale after a context loss');
  assert.match(restore, /shadowMap\.needsUpdate = true/, 'and so is the shadow map');
  assert.match(restore, /feMarkViewportActive\(\)/, 'the restored frame is drawn at once');
  /* While the context is gone the loop must not hand a dead context to three.js. */
  assert.match(html, /!this\._contextLost&&!feShouldDrawFrame/, 'no rendering while the context is lost');
});

test('a touch screen starts without the temporal pass and earns it back', () => {
  const mount = html.slice(html.indexOf("FE.register('core',{"), html.indexOf('FE.register.prototype'));
  assert.match(mount, /coarse && \(navigator\.maxTouchPoints \|\| 0\) > 1\) this\._autoTaa = false/,
    'a phone starts with MSAA only');
  const bridge = readFileSync('fe-cpp-engine.js', 'utf8');
  assert.match(bridge, /eng\._autoTaaGood >= \d+/, 'and the governor turns the pass back on after good frames');
  assert.match(bridge, /eng\._autoTaa === undefined\) \{\s*eng\._autoTaa = prefers;/, 'the first tick only decides when nothing decided before');
});
