import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html = readFileSync('index.html','utf8');
const bridge = readFileSync('fe-cpp-engine.js','utf8');

function slice(from,to){
  const start = html.indexOf(from);
  const end = html.indexOf(to,start);
  assert.ok(start >= 0,`missing marker: ${from}`);
  assert.ok(end > start,`missing end marker: ${to}`);
  return html.slice(start,end);
}

function rangeHarness({end = 250, keys = [], bakeEnd = 0, currentFrame = 0} = {}){
  const inputs = new Map([
    ['tb-start-frame-input',{value:'0'}],
    ['tb-end-frame-input',{value:String(end)}],
    ['anim-range-start',{value:'0'}],
    ['anim-range-end',{value:String(end)}],
    ['anim-range-status',{textContent:''}]
  ]);
  const document = {
    getElementById: id => inputs.get(id) || null,
    activeElement: null
  };
  const renders = {count:0};
  const ctx = vm.createContext({
    window:{},
    document,
    console,
    Math,
    Number,
    String,
    timelineConfig:{
      currentFrame, startFrame:0, endFrame:end, fps:30, isPlaying:false,
      isMinimized:false, snapToKeys:true, loopRange:false, customRange:false, isScrubbing:false, playAccumulator:0,
      _physicsDirty:false
    },
    renderTimelineRulerCanvas(){ renders.count++; },
    timelineKeyFrames(){ return keys; },
    getActiveObjectMesh(){ return bakeEnd ? {userData:{simBake:{frameEnd:bakeEnd}}} : null; }
  });
  const code = slice('const TIMELINE_FRAME_LIMIT','function toggleTimelineMinimize');
  vm.runInContext(code,ctx);
  return {ctx,inputs,renders};
}

test('250 frames is a starting window, not a ceiling',()=>{
  const {ctx} = rangeHarness({end:250});
  assert.equal(ctx.timelineConfig.endFrame,250,'the default window still starts at 250');

  ctx.applyTimelineRange(0,600);
  assert.equal(ctx.timelineConfig.endFrame,600,'the end frame can be extended by hand');
  assert.equal(ctx.timelineConfig.startFrame,0);

  ctx.extendTimelineRange(50);
  assert.equal(ctx.timelineConfig.endFrame,650,'+50 adds frames');

  ctx.applyTimelineRange(120,900);
  assert.equal(ctx.timelineConfig.startFrame,120,'the start frame is editable too');
  assert.equal(ctx.timelineConfig.endFrame,900);
});

test('the timeline is unlimited: there is no frame ceiling',()=>{
  const {ctx} = rangeHarness({end:250});
  for(const length of [1200, 10000, 250000, 5_000_000]){
    ctx.applyTimelineRange(0, length);
    assert.equal(ctx.timelineConfig.endFrame, length, `${length} frames is allowed`);
  }
  ctx.setTimelineEndFrame(Number.MAX_SAFE_INTEGER);
  assert.equal(ctx.timelineConfig.endFrame, Number.MAX_SAFE_INTEGER, 'only the safe-integer guard applies');
  assert.ok(!/TIMELINE_HARD_MAX/.test(readFileSync('index.html','utf8')), 'the old 10000-frame cap is gone');
});

test('the end frame is a wall: playback stops there instead of growing the scene',()=>{
  const {ctx} = rangeHarness({end:250});
  assert.equal(ctx.timelineConfig.loopRange, false, 'stop-at-end is the default');

  ctx.timelineConfig.currentFrame = 10;
  let tick = ctx.advanceTimelinePlayback(5);
  assert.deepEqual({frame:tick.frame,wrapped:tick.wrapped,stopped:tick.stopped},{frame:15,wrapped:false,stopped:false});

  ctx.timelineConfig.currentFrame = 248;
  tick = ctx.advanceTimelinePlayback(4);
  assert.equal(tick.frame, 250, 'the playhead lands exactly on the end frame');
  assert.equal(tick.stopped, true, 'and playback is told to stop');
  assert.equal(ctx.timelineConfig.endFrame, 250, 'playing never stretches the scene');

  ctx.timelineConfig.loopRange = true;
  tick = ctx.advanceTimelinePlayback(4);
  assert.equal(tick.wrapped, true, 'looping wraps instead of stopping');
  assert.equal(tick.frame, 1, '4 frames from 248 wrap 249, 250, 0, 1');
  assert.equal(ctx.timelineConfig.endFrame, 250, 'looping never stretches the scene either');
});

test('dragging the ruler past the edge is how time is added',()=>{
  const {ctx} = rangeHarness({end:250});
  assert.equal(ctx.timelineConfig.customRange, false, 'a fresh timeline tracks its content');
  assert.equal(ctx.growTimelineForFrame(480), true);
  assert.equal(ctx.timelineConfig.endFrame, 500, 'the axis grows in 50-frame pages');
  assert.equal(ctx.timelineConfig.customRange, true, 'the dragged length becomes the wall playback stops on');
  assert.equal(ctx.growTimelineForFrame(120), false, 'frames already inside the range do not shrink it');
  assert.equal(ctx.timelineAutoFitRange(), false, 'auto-fit never overrides a hand-set length');

  ctx.applyTimelineRange(0, 120);
  assert.equal(ctx.timelineConfig.customRange, true, 'a typed end frame is owned by the user too');
});

test('the range stays sane without a hard guard',()=>{
  const {ctx} = rangeHarness({end:250});
  ctx.applyTimelineRange(0,999999);
  assert.equal(ctx.timelineConfig.endFrame,999999,'a large range is accepted');
  ctx.applyTimelineRange(0,Number.NaN);
  assert.equal(ctx.timelineConfig.endFrame,999999,'NaN cannot poison the axis');
  ctx.applyTimelineRange(0,Number.POSITIVE_INFINITY);
  assert.equal(ctx.timelineConfig.endFrame,999999,'infinity is rejected and the previous range kept');
  ctx.applyTimelineRange(-50,0);
  assert.equal(ctx.timelineConfig.startFrame,0,'the timeline never starts below zero');
  assert.equal(ctx.timelineConfig.endFrame,1,'end > start is preserved');
});

test('content beyond the window widens it automatically',()=>{
  const keys = rangeHarness({end:250,keys:[0,40,320]});
  keys.ctx.timelineAutoFitRange();
  assert.equal(keys.ctx.timelineConfig.endFrame,350,'a key at 320 rounds the end up to 350');
  assert.equal(keys.inputs.get('anim-range-end').value,'350','the visible end field follows');
  assert.equal(keys.inputs.get('anim-range-status').textContent,'0 – 350');

  const bake = rangeHarness({end:250,bakeEnd:480});
  bake.ctx.timelineAutoFitRange();
  assert.equal(bake.ctx.timelineConfig.endFrame,500,'a baked simulation widens the window');

  const moved = rangeHarness({end:250,currentFrame:600});
  moved.ctx.timelineAutoFitRange();
  assert.equal(moved.ctx.timelineConfig.endFrame,650,'a playhead past the end widens the window');

  const inside = rangeHarness({end:250,keys:[0,120]});
  inside.ctx.timelineAutoFitRange();
  assert.equal(inside.ctx.timelineConfig.endFrame,250,'the window never shrinks on its own');
});

test('fit to keys sizes the window to the last keyframe',()=>{
  const {ctx} = rangeHarness({end:900,keys:[0,100,420]});
  ctx.fitTimelineRangeToKeys();
  assert.equal(ctx.timelineConfig.endFrame,450,'fit rounds up past the last key');
  const empty = rangeHarness({end:900,keys:[]});
  empty.ctx.fitTimelineRangeToKeys();
  assert.equal(empty.ctx.timelineConfig.endFrame,50,'an empty timeline still keeps a usable minimum');
});

test('the animation sheet exposes the range controls',()=>{
  const body = slice('<div id="animation-sheet-body">','</aside>');
  assert.ok(body.includes('id="anim-range-start"') && body.includes('id="anim-range-end"'));
  assert.ok(body.includes('onclick="extendTimelineRange(50)"'),'a one-tap extend button exists on the phone');
  assert.ok(body.includes('onclick="fitTimelineRangeToKeys()"'));
  assert.ok(body.includes('id="anim-range-status"'));
  assert.ok(body.includes('id="anim-loop-btn"'),'the loop toggle lives with the range controls');
  assert.ok(body.includes('onclick="toggleTimelineLoop()"'));
  assert.ok(!/id="anim-range-end"[^>]*max=/.test(body),'the end field has no artificial maximum');
  assert.ok(html.includes('window.applyTimelineRange = applyTimelineRange'));
  assert.ok(html.includes('window.extendTimelineRange = extendTimelineRange'));
  assert.ok(html.includes('window.fitTimelineRangeToKeys = fitTimelineRangeToKeys'));
  assert.ok(!html.includes('endFrame: 250,\n  fps: 30') || !/timelineConfig.endFrame\s*=\s*Math\.max\(1,\s*parseInt\(endEl\.value\)\s*\|\|\s*250\)/.test(html),
    'the old fixed 250 fallback is gone');
});

test('the dope sheet lets a vertical drag scroll the sheet',()=>{
  assert.ok(html.includes('#anim-dopesheet-wrap{width:100%;height:168px;background:#0b0d14;border:1px solid #262c40;border-radius:10px;overflow:hidden;position:relative;touch-action:pan-y}'),
    'the graph keeps horizontal gestures but hands vertical pans to the sheet');
  assert.ok(/\.anim-range-field\{/.test(html),'range fields have their own styling');
  const sheetBody = slice('#animation-sheet-body {','.modifiers-sheet-head {');
  assert.ok(sheetBody.includes('min-height: 0'),'the scroll container can shrink inside the flex sheet');
  assert.ok(sheetBody.includes('overscroll-behavior: contain'));
  assert.ok(sheetBody.includes('touch-action: pan-y'));
  assert.ok(bridge.includes('pendingPointer'),'the graph waits for a direction before scrubbing');
  assert.ok(bridge.includes('if (dx > dy * 1.2)'),'only a clearly horizontal drag starts a scrub');
  assert.ok(!/pointerdown[\s\S]{0,400}scrubDope\(ev\);\n\s*\}\);/.test(bridge),'pointerdown no longer scrubs immediately');
});
