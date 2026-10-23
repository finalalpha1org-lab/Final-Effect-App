import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* The transport row used to be a line of look-alike text glyphs (▶ ◀ ◆ ▶),
   which made the play button impossible to find on a phone. These tests keep
   the replacement honest: every control is a distinct vector icon, the play
   button is the one raised "3D" disc, the bar is tall enough to drag, and
   pressing play on the end frame rewinds instead of doing nothing. */
const html = readFileSync('index.html', 'utf8');

function slice(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0, `missing marker: ${from}`);
  assert.ok(end > start, `missing end marker: ${to}`);
  return html.slice(start, end);
}

const transportMarkup = slice('<div class="timeline-header">', '<div class="timeline-tracks-wrapper"');

function transportHarness({ start = 0, end = 250, currentFrame = 0 } = {}) {
  const buttons = new Map();
  const makeButton = id => {
    const el = {
      id, attrs: {}, classes: new Set(), innerHTML: '',
      classList: {
        add: c => el.classes.add(c),
        remove: c => el.classes.delete(c),
        toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
      },
      setAttribute: (k, v) => { el.attrs[k] = v; },
      getAttribute: k => (k in el.attrs ? el.attrs[k] : null),
      querySelector: () => null,
    };
    buttons.set(id, el);
    return el;
  };
  for (const id of ['tb-play-btn', 'tb-min-btn', 'tb-current-frame-input', 'studio-timeline-bar']) makeButton(id);
  const applied = [];
  const toasts = [];
  const window = { FEIcons: { svg: (name, opts) => `<svg data-ico="${name}" width="${opts?.size || 18}"></svg>` }, FE: { toast: m => toasts.push(m) } };
  const ctx = vm.createContext({
    window,
    document: { getElementById: id => buttons.get(id) || null, activeElement: null },
    FE: window.FE,
    console, Math, Number, String, performance, setTimeout,
    timelineConfig: {
      currentFrame, startFrame: start, endFrame: end, fps: 30, isPlaying: false,
      isMinimized: false, snapToKeys: true, loopRange: false, customRange: false,
      isScrubbing: false, playAccumulator: 0, _physicsDirty: false, lastFrameTime: 0,
    },
    renderTimelineRulerCanvas() {},
    setTimelineCurrentFrame(frame, options) { applied.push({ frame, options }); ctx.timelineConfig.currentFrame = frame; },
  });
  /* Ship the real range block, the real transport block and the real
     play/pause + stop helpers; only the canvas renderer is stubbed. */
  const code = [
    slice('const TIMELINE_FRAME_LIMIT', 'function hasActivePhysicsSims'),
    slice('function pauseTimelineForScrub', 'function handleRulerPointer'),
  ].join('\n');
  vm.runInContext(code, ctx);
  return { ctx, buttons, applied, toasts };
}

test('every transport control is a distinct vector icon, not a text glyph', () => {
  assert.ok(!/[▶◀⏮⏭⏸◆▲▼↻]/.test(transportMarkup), 'no geometric glyphs or emoji are left in the transport row');
  const expected = {
    'tb-min-btn': 'chevronDown',
    'tb-play-btn': 'play',
    'tb-first-btn': 'skipBack',
    'tb-prev-btn': 'stepBack',
    'tb-next-btn': 'stepForward',
    'tb-last-btn': 'skipForward',
    'tb-prev-key-btn': 'keyPrev',
    'tb-next-key-btn': 'keyNext',
    'tb-insert-key-btn': 'keyframe',
  };
  for (const [id, icon] of Object.entries(expected)) {
    const button = transportMarkup.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`));
    assert.ok(button, `${id} must exist in the transport row`);
    assert.ok(button[1].includes(`data-ico="${icon}"`), `${id} must draw the ${icon} icon`);
  }
  const icons = [...transportMarkup.matchAll(/data-ico="([A-Za-z0-9]+)"/g)].map(m => m[1]);
  assert.equal(new Set(icons).size, icons.length, 'no two transport buttons share an icon');
  for (const id of ['tb-first-btn', 'tb-prev-btn', 'tb-next-btn', 'tb-last-btn', 'tb-prev-key-btn', 'tb-next-key-btn', 'tb-min-btn']) {
    const button = transportMarkup.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(button, `${id} must exist`);
    assert.ok(/aria-label="/.test(button[0]), `${id} keeps a screen-reader label now that it has no text`);
  }
});

test('the play button is the one raised 3D disc in the row', () => {
  const play = slice('.tb-play-btn {', '.tb-play-btn.active::after');
  assert.match(play, /border-radius: 50%/, 'play is a disc, not another flat square');
  assert.match(play, /radial-gradient\(/, 'the disc has a specular highlight');
  assert.match(play, /linear-gradient\(158deg/, 'and a bevelled body gradient');
  assert.match(play, /inset 0 1px 0 rgba\(255,255,255,\.8\)/, 'a lit top edge');
  assert.match(play, /inset 0 -3px 7px/, 'a shadowed bottom edge');
  assert.match(play, /0 3px 0 #221c5e/, 'a hard lip under the disc makes it read as 3D');
  assert.match(play, /translateY\(-1px\)/, 'the disc sits proud of the flat buttons');
  const playing = slice('.tb-play-btn.active {', '@keyframes tb-play-ring');
  assert.match(playing, /::after/, 'a pulsing ring marks the playing state');
  assert.match(html, /@keyframes tb-play-ring/);
  assert.match(html, /prefers-reduced-motion: reduce[\s\S]{0,120}tb-play-btn\.active::after \{ animation: none; \}/,
    'the ring respects reduced motion');
  const flat = slice('.tb-btn {', '/* ---- Play button');
  assert.ok(!/radial-gradient/.test(flat), 'the other transport buttons stay flat so the disc stands out');
});

test('the timeline bar is tall enough to drag with a thumb', () => {
  assert.match(html, /\.timeline-bar \{[^}]*height: 122px/, 'the bar grew from 82px to 122px');
  assert.match(html, /\.timeline-header \{[^}]*height: 48px/, 'the control row grew to 48px');
  assert.match(html, /\.tb-btn \{[^}]*height: 32px/, 'buttons are a 32px touch target');
  assert.match(html, /\.timeline-ruler-container \{[^}]*flex: 1/, 'the ruler fills whatever height is left');
  assert.match(html, /\.timeline-ruler-container \{[^}]*min-height: 62px/, 'and keeps a usable minimum');
  assert.match(html, /@media\(max-width:760px\)\{[\s\S]*?\.tb-btn\{min-width:36px;min-height:36px;height:36px\}/,
    'portrait phones get 36px buttons');
  assert.match(html, /\.tb-play-btn\{width:44px;height:44px;min-width:44px\}/, 'and a 44px play disc');
});

test('playing stops on the end frame and play on the wall rewinds', () => {
  const { ctx, buttons, toasts } = transportHarness({ start: 0, end: 250, currentFrame: 250 });
  ctx.toggleTimelinePlay();
  assert.equal(ctx.timelineConfig.currentFrame, 0, 'pressing play on the end frame rewinds to the start');
  assert.equal(ctx.timelineConfig.isPlaying, true);
  const playBtn = buttons.get('tb-play-btn');
  assert.ok(playBtn.classes.has('active'), 'the disc turns green while playing');
  assert.match(playBtn.innerHTML, /data-ico="pause"/, 'and shows the pause icon');
  assert.equal(playBtn.getAttribute('aria-pressed'), 'true');

  ctx.toggleTimelinePlay();
  assert.equal(ctx.timelineConfig.isPlaying, false);
  assert.ok(!playBtn.classes.has('active'));
  assert.match(playBtn.innerHTML, /data-ico="play"/, 'it goes back to the play icon');
  assert.ok(toasts.length >= 2, 'the state change is announced');
});

test('reaching the end frame stops playback and says how to add time', () => {
  const { ctx, buttons, toasts } = transportHarness({ start: 0, end: 120, currentFrame: 118 });
  ctx.timelineConfig.isPlaying = true;
  ctx.stopTimelinePlayback();
  assert.equal(ctx.timelineConfig.isPlaying, false, 'the engine loop stops');
  assert.equal(ctx.timelineConfig.playAccumulator, 0, 'no stale time carries into the next play');
  assert.ok(!buttons.get('tb-play-btn').classes.has('active'));
  assert.match(toasts[0], /End frame reached/, 'the first stop explains the wall');
  const hints = toasts.length;
  ctx.timelineConfig.isPlaying = true;
  ctx.stopTimelinePlayback();
  assert.equal(toasts.length, hints, 'and never nags twice');
});

test('stepping a single frame stops at both walls', () => {
  const { ctx, applied } = transportHarness({ start: 10, end: 90, currentFrame: 90 });
  ctx.stepTimelineFrame(1);
  assert.equal(applied.at(-1).frame, 90, 'the next-frame button cannot walk past the end frame');
  assert.equal(applied.at(-1).options.clampRange, true);
  ctx.timelineConfig.currentFrame = 10;
  ctx.stepTimelineFrame(-1);
  assert.equal(applied.at(-1).frame, 10, 'and the previous-frame button cannot walk before the start');
});

test('the height toggle swaps a chevron instead of a text triangle', () => {
  const block = slice('function toggleTimelineMinimize', 'function toggleTimelinePlay');
  assert.match(block, /setTimelineTransportIcon\(btn, timelineConfig\.isMinimized \? 'chevronUp' : 'chevronDown'/);
  assert.ok(!/textContent\s*=\s*'[▲▼]'/.test(block), 'no text triangles are written back');

  const { ctx, buttons } = transportHarness();
  const min = buttons.get('tb-min-btn');
  ctx.toggleTimelineMinimize();
  assert.equal(ctx.timelineConfig.isMinimized, true);
  assert.match(min.innerHTML, /data-ico="chevronUp"/, 'minimising points the chevron up');
  ctx.toggleTimelineMinimize();
  assert.equal(ctx.timelineConfig.isMinimized, false);
  assert.match(min.innerHTML, /data-ico="chevronDown"/, 'expanding points it back down');
});

test('the end frame never scrolls away and the ruler marks it as a wall', () => {
  const header = slice('<div class="timeline-header">', '<div class="timeline-tracks-wrapper"');
  const pin = slice('<div class="timeline-end-pin"', '<div class="timeline-tracks-wrapper"');
  assert.match(pin, /id="tb-end-frame-input"/, 'the End field lives in the pinned chip');
  assert.ok(!/max=/.test(pin), 'the end frame has no artificial maximum');
  const controls = slice('<div class="timeline-left-controls">', '<div class="timeline-end-pin"');
  assert.ok(!controls.includes('tb-end-frame-input'), 'the pinned field is outside the scrolling row');
  assert.match(html, /\.timeline-end-pin \{[^}]*flex: none/, 'the chip never scrolls with the transport row');
  assert.match(html, /\.timeline-left-controls \{[^}]*flex: 1/, 'the transport row takes the remaining width');
  assert.match(header, /timeline-end-pin[\s\S]*<\/div>\s*<\/div>/, 'and the chip closes the header');

  const ruler = slice('function renderTimelineRulerCanvas', 'window.renderTimelineRulerCanvas');
  assert.ok(ruler.includes("ctx.strokeStyle = '#f59e0b'"), 'the end bound is amber, the wall is visible');
  assert.ok(ruler.includes("ctx.strokeStyle = '#6366f1'"), 'the start bound keeps the accent colour');

  const loop = slice('const steps = Math.floor(timelineConfig.playAccumulator)', '// Keep OrbitControls');
  assert.match(loop, /advance\.stopped && typeof stopTimelinePlayback === 'function'/, 'the render loop stops playback on the wall');
  assert.ok(!loop.includes('growTimelineForFrame'), 'playback never grows the scene any more');
});
