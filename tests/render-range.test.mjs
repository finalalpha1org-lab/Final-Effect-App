import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* The animation render must cover exactly the timeline's START→END frames.
   It used to run on its own default range, so a 120-frame animation exported
   250 frames, and the recorder ran in real time on top of that, so the clip
   also played at whatever speed the device happened to manage. Both are
   pinned here: the range is read from the timeline, and the buffered frames
   are played back at the timeline frame rate. */

const bridge = readFileSync('fe-cpp-engine.js', 'utf8');
const exportSource = readFileSync('render-export.js', 'utf8');
const html = readFileSync('index.html', 'utf8');

function loadExport() {
  const context = { TextEncoder, Blob, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date, Buffer, console, URL, setTimeout, performance, Image: function Image() {} };
  vm.createContext(context);
  vm.runInContext(exportSource, context);
  return context.FERenderExport;
}

const X = loadExport();

function harness({ start = '0', end = '250', config = {} } = {}) {
  const inputs = new Map([
    ['tb-start-frame-input', { value: start }],
    ['tb-end-frame-input', { value: end }],
    ['render-range-info', { textContent: '' }]
  ]);
  const document = {
    readyState: 'loading',
    body: { dataset: {}, classList: { toggle() {} } },
    addEventListener() {},
    getElementById(id) { return inputs.get(id) || null; },
    createElement() { return { click() {} }; }
  };
  const timelineConfig = { currentFrame: 0, startFrame: 0, endFrame: 250, fps: 30, isPlaying: false, ...config };
  const window = {
    timelineConfig,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 0
  };
  const ctx = vm.createContext({
    window, document, console, Math, Number, String, Array, Object, Set, Map,
    Float32Array, Uint32Array, Uint8Array, Int32Array, WebAssembly, performance,
    setTimeout, clearTimeout, JSON, URL, Promise, Error, isFinite, parseInt, parseFloat,
    requestAnimationFrame: () => 0,
    Blob: globalThis.Blob
  });
  vm.runInContext(bridge, ctx);
  return { engine: window.FECppEngine, window, document, inputs };
}

test('the animation render range is the timeline range, read from the START/END fields', () => {
  const { engine } = harness({ start: '10', end: '40', config: { fps: 24 } });
  const range = engine.renderRange();
  assert.equal(range.start, 10);
  assert.equal(range.end, 40);
  assert.equal(range.fps, 24);
  assert.equal(range.frames, 31, 'START and END are inclusive, like Blender');
  assert.ok(Math.abs(range.seconds - 31 / 24) < 1e-9);
});

test('the typed START/END fields win over a stale config object', () => {
  /* The fields are what the user sees; the config object is a cache. */
  const { engine } = harness({ start: '5', end: '9', config: { startFrame: 0, endFrame: 250, fps: 30 } });
  assert.deepEqual({ ...engine.renderRange() }, { start: 5, end: 9, fps: 30, frames: 5, seconds: 5 / 30 });
});

test('a nonsense range is repaired instead of producing zero frames', () => {
  const backwards = harness({ start: '80', end: '20' });
  const range = backwards.engine.renderRange();
  assert.equal(range.start, 80);
  assert.equal(range.end, 81, 'END never falls below START');
  assert.equal(range.frames, 2);

  const empty = harness({ start: '', end: '' });
  const fallback = empty.engine.renderRange();
  assert.equal(fallback.start, 0);
  assert.equal(fallback.end, 250, 'empty fields fall back to the timeline config');
});

test('the renderer walks exactly START…END and moves the timeline with it', () => {
  const start = bridge.indexOf('async renderAnimationSequenceVideo()');
  assert.ok(start > 0);
  const body = bridge.slice(start, bridge.indexOf('/* ---------------------------------------------------------------------', start));
  assert.match(body, /const range = this\.renderRange\(\)/);
  assert.match(body, /for \(let f = startF; f <= endF; f\+\+\)/);
  assert.match(body, /window\.setTimelineCurrentFrame\(f\)/);
  assert.equal(/endF\s*=\s*250/.test(body), false, 'no private default range');
  assert.equal(/frames\s*=\s*250/.test(body), false);
  /* The recorder is opened after the frames exist, not while they render. */
  const recordAt = body.indexOf('X.beginRecording(');
  const loopAt = body.indexOf('for (let f = startF');
  assert.ok(recordAt > loopAt, 'recording starts after the frame loop');
  assert.match(body, /await X\.playSequence\(/);
  assert.match(body, /window\.setTimelineCurrentFrame\(savedFrame\)/, 'the playhead is put back');
});

test('the render dialog shows the range it is about to render', () => {
  assert.ok(html.includes('id="render-range-info"'));
  assert.match(html, /FECppEngine\?\.updateRenderRangeReadout\?\.\(\)/);
  assert.match(bridge, /updateRenderRangeReadout\(\)/);
  assert.match(bridge, /rangeLabel\(range\.start, range\.end, range\.fps\)/);
});

test('the range readout counts inclusive frames at the timeline frame rate', () => {
  assert.equal(X.rangeLabel(0, 250, 30), 'Frames 0–250 · 251 frames · 30 fps · 8.4 s');
  assert.equal(X.rangeLabel(10, 10, 30), 'Frames 10–11 · 2 frames · 30 fps · 0.1 s');
  assert.equal(X.rangeLabel(5, 9, 24), 'Frames 5–9 · 5 frames · 24 fps · 0.2 s');
});

test('buffered frames are played at the timeline rate, not at render speed', async () => {
  let drawn = 0;
  const canvas = { width: 8, height: 8, getContext: () => ({ drawImage() { drawn++; } }) };
  const frames = [new Blob([new Uint8Array(4)]), new Blob([new Uint8Array(4)]), new Blob([new Uint8Array(4)])];
  const ticks = [];
  const started = performance.now();
  const played = await X.playSequence(canvas, frames, 120, (index) => ticks.push(index), {
    decode: async () => ({ close() {} })
  });
  const elapsed = performance.now() - started;

  assert.equal(played, 3);
  assert.equal(drawn, 3, 'each buffered frame is drawn exactly once');
  assert.deepEqual(ticks, [0, 1, 2]);
  /* 120 fps = 8.33 ms per frame; three frames need at least two slots. */
  assert.ok(elapsed >= 16, `played too fast: ${elapsed} ms`);
});

test('a full frame buffer stops at the byte limit instead of exhausting memory', () => {
  const sequence = X.createSequence({ byteLimit: 8 });
  assert.equal(sequence.add(new Blob([new Uint8Array(4)])), true);
  assert.equal(sequence.full, false);
  assert.equal(sequence.add(new Blob([new Uint8Array(4)])), true);
  assert.equal(sequence.add(new Blob([new Uint8Array(1)])), false, 'the limit is a ceiling, not a suggestion');
  assert.equal(sequence.count, 2);
  assert.equal(sequence.full, true);
  assert.equal(sequence.bytes, 8);
});
