import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');

function slice(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0, `missing marker: ${from}`);
  assert.ok(end > start, `missing end marker: ${to}`);
  return html.slice(start, end);
}

function harness({ keys = [], startFrame = 0, endFrame = 250, width = 600 } = {}) {
  const container = {
    dataset: {},
    addEventListener() {},
    getBoundingClientRect() { return { left: 0, width, top: 0, height: 52 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const elements = new Map([
    ['timeline-ruler-container', container],
    ['timeline-ruler-canvas', null],
    ['timeline-playhead', { style: {} }],
    ['tb-play-btn', { textContent: '', classList: { remove() {}, toggle() {} } }],
  ]);
  const document = { getElementById: id => elements.get(id) ?? null };
  const applied = [];
  const window = {
    FECppEngine: {
      ready: true,
      exports: { fe_anim_get_total_keyframes: () => keys.length },
      listDistinctKeyFramesForObject: () => keys,
    },
    FE: { getActiveObjectId: () => 'cube', toast() {} },
  };
  const ctx = vm.createContext({
    window, document, console, Math, Number, String, Array, performance,
    timelineConfig: {
      currentFrame: 0, startFrame, endFrame, fps: 30, isPlaying: false,
      snapToKeys: true, isScrubbing: false, playAccumulator: 0, _physicsDirty: false,
    },
    setTimelineCurrentFrame(frame, options) {
      applied.push({ frame, options });
      ctx.timelineConfig.currentFrame = frame;
    },
  });

  const metrics = slice('const TIMELINE_RULER_PAD', 'function positionTimelinePlayhead');
  const scrub = slice('function timelineFrameAtClientX', 'window.handleRulerPointer = handleRulerPointer;');
  vm.runInContext(metrics + '\n' + scrub, ctx);
  return { ctx, applied, container };
}

test('ruler maps the full frame range onto the padded canvas width', () => {
  const { ctx } = harness({ startFrame: 0, endFrame: 250, width: 600 });
  const m = vm.runInContext('timelineFrameMetrics(600)', ctx);
  assert.equal(m.pad, 12);
  assert.equal(m.plotW, 576);
  assert.equal(m.frameToX(0), 12);
  assert.equal(m.frameToX(250), 588);
  assert.ok(Math.abs(m.xToFrame(m.frameToX(137)) - 137) < 1e-9);
});

test('a pointer position always resolves to the same frame (no drift)', () => {
  const { ctx, applied } = harness({ startFrame: 0, endFrame: 250, width: 600 });
  const x = 12 + (100 / 250) * 576;
  ctx.applyTimelineScrub(x);
  assert.equal(applied[0].frame, 100);
  ctx.timelineConfig.currentFrame = 187;
  ctx.applyTimelineScrub(x);
  assert.equal(applied[1].frame, 100, 'repeated pointer positions must not accumulate a delta');
  ctx.applyTimelineScrub(x);
  assert.equal(applied[2].frame, 100);
  assert.equal(applied[0].options.scrub, true, 'scrubbing must not bake physics on every move');
  assert.equal(applied[0].options.clampRange, true, 'scrubbing must clamp to the timeline range');
});

test('dragging outside the ruler clamps to the configured range', () => {
  const { ctx, applied } = harness({ startFrame: 10, endFrame: 90, width: 600 });
  ctx.applyTimelineScrub(-400);
  ctx.applyTimelineScrub(5000);
  assert.equal(applied[0].frame, 10);
  assert.equal(applied[1].frame, 90);
});

test('scrubbing snaps onto a nearby keyframe and holds it exactly', () => {
  const { ctx, applied } = harness({ keys: [0, 50, 100], startFrame: 0, endFrame: 250, width: 600 });
  const xFor = frame => 12 + (frame / 250) * 576;
  ctx.applyTimelineScrub(xFor(51.4));
  assert.equal(applied.at(-1).frame, 50, 'within the magnet radius the key wins');
  ctx.applyTimelineScrub(xFor(60));
  assert.equal(applied.at(-1).frame, 60, 'far from any key the exact frame is used');
  ctx.timelineConfig.snapToKeys = false;
  ctx.applyTimelineScrub(xFor(51.4));
  assert.equal(applied.at(-1).frame, 51, 'snapping can be switched off');
});

test('ruler interactions use pointer capture instead of accumulating deltas', () => {
  const block = slice('function initTimelineRulerInteractions', 'function jumpTimelineToKey');
  assert.ok(block.includes('setPointerCapture'), 'the drag must capture the pointer');
  assert.ok(block.includes('pointermove'), 'dragging must update through pointermove');
  assert.ok(block.includes('seekTimelinePhysics'), 'physics is baked once on release, not per move');
  assert.ok(!block.includes('currentFrame +'), 'the pointer handler must not add a delta to the current frame');
});

test('timeline exposes key-jump and snap controls', () => {
  assert.ok(html.includes('id="tb-prev-key-btn"') && html.includes('jumpTimelineToKey(-1)'));
  assert.ok(html.includes('id="tb-next-key-btn"') && html.includes('jumpTimelineToKey(1)'));
  assert.ok(html.includes('id="tb-snap-btn"') && html.includes('toggleTimelineSnap()'));
  assert.ok(html.includes('if (e.shiftKey) jumpTimelineToKey(-1); else stepTimelineFrame(-1);'));
});
