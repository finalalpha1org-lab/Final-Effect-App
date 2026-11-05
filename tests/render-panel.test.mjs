import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Feature 4 of the Workspace: the Render Engine dialog. The path tracer itself
   is the kernel (already covered by cpp-core-engine and render-export); what is
   tested here is the wiring between the dialog and the engine, because that is
   where the quiet failures live: a control that cannot do anything, a button
   that silently does nothing, a state that disagrees with the panel. */

const html = readFileSync('index.html', 'utf8');
const bridgeSource = readFileSync('fe-cpp-engine.js', 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

function loadRenderHelpers(ids = {}) {
  const elements = new Map(Object.entries(ids));
  const document = {
    getElementById: (id) => (elements.has(id) ? elements.get(id) : null)
  };
  const ctx = vm.createContext({ document, console, Math, Number, String, Array, Object, JSON });
  vm.runInContext(extract(bridgeSource, 'syncRenderEngineEnabled'), ctx);
  return { ctx, elements };
}

test('the dialog state starts on the same values the dialog shows', () => {
  const config = bridgeSource.slice(bridgeSource.indexOf('renderState: {'), bridgeSource.indexOf('},', bridgeSource.indexOf('renderState: {')));
  const value = (key) => {
    const match = config.match(new RegExp(`${key}:\\s*'?([^,'\\n]+)'?`));
    assert.ok(match, `renderState.${key} must be declared`);
    return match[1].trim();
  };
  const htmlValue = (id) => {
    const tag = html.slice(html.indexOf(`id="${id}"`));
    const select = tag.slice(0, tag.indexOf('</select>'));
    /* `selected` may be written before or after other attributes on the option. */
    const chosen = select.match(/<option[^>]*value="([^"]+)"[^>]*selected[^>]*>/);
    if (chosen) return chosen[1];
    /* No attribute: the first option is what the browser shows. */
    const first = select.match(/<option[^>]*value="([^"]+)"/);
    return first ? first[1] : null;
  };

  assert.equal(value('engine'), htmlValue('render-engine-select'), 'engine');
  assert.equal(value('aspectPreset'), htmlValue('render-aspect-select'), 'frame aspect');
  assert.equal(value('resScale'), htmlValue('render-quality-select'), 'resolution');
  assert.equal(value('targetSamples'), htmlValue('render-samples-select'), 'path samples');
  assert.equal(value('bounces'), htmlValue('render-bounces-select'), 'light bounces');
});

test('Eevee disables the controls only the path tracer can honour', () => {
  const samples = { id: 'render-samples-select', disabled: false, title: '', closest: () => row };
  const bounces = { id: 'render-bounces-select', disabled: false, title: '', closest: () => row };
  const row = { style: {} };
  const engine = { id: 'render-engine-select', value: 'cycles_cpp' };
  const { ctx } = loadRenderHelpers({
    'render-engine-select': engine,
    'render-samples-select': samples,
    'render-bounces-select': bounces
  });

  ctx.syncRenderEngineEnabled();
  assert.equal(samples.disabled, false, 'the path tracer takes samples');
  assert.equal(bounces.disabled, false);
  assert.equal(row.style.opacity, '', 'and the rows are at full strength');

  engine.value = 'eevee_cpp';
  ctx.syncRenderEngineEnabled();
  assert.equal(samples.disabled, true, 'the raster engine has no samples to take');
  assert.equal(bounces.disabled, true);
  assert.match(samples.title, /path tracer/, 'and says why');
  assert.equal(row.style.opacity, '0.55', 'the rows are visibly out of play');

  /* A dialog without those rows must not throw. */
  const bare = loadRenderHelpers({ 'render-engine-select': { value: 'eevee_cpp' } });
  bare.ctx.syncRenderEngineEnabled();
});

test('a render starts empty instead of inheriting the last bar', () => {
  const start = bridgeSource.slice(bridgeSource.indexOf('async startStillRender()'), bridgeSource.indexOf('stopActiveRender() {'));
  assert.match(start, /if \(barEl\) barEl\.style\.width = '0%'/, 'the progress bar is cleared');
  assert.match(start, /if \(statusEl\) statusEl\.textContent = 'Starting…'/);
  const videoStart = bridgeSource.indexOf('async renderAnimationSequenceVideo()');
  const video = bridgeSource.slice(videoStart, bridgeSource.indexOf('renderRange() {', videoStart));
  assert.match(video, /renderRange\(\)/, 'the video uses the timeline range');
});

test('Save Image says something when there is nothing to save', () => {
  const save = bridgeSource.slice(bridgeSource.indexOf('downloadRenderedStill() {'), bridgeSource.indexOf('downloadRenderedPNG()'));
  assert.match(save, /Render a frame first/, 'a button that does nothing reads as broken');
  assert.match(save, /if \(!X\)/, 'a missing export module is reported, not swallowed');
  assert.ok(!/^\s*if \(!canvas \|\| !canvas\.width\) return;$/m.test(save), 'the silent return is gone');
  /* And it reports whether it saved. */
  assert.match(save, /return true;/);
  assert.match(save, /return false;/);
});

test('every render control is read by the engine, and the render sync applies the engine rules', () => {
  const sync = bridgeSource.slice(bridgeSource.indexOf('function syncRenderControlsFromUI()'), bridgeSource.indexOf('function openRenderEngineModal()'));
  const PRESENTATION_ONLY = new Set([
    'render-engine-modal', 'render-studio-title', 'render-preview-canvas',
    'render-progress-fill', 'render-progress-text', 'render-range-info',
    'render-still-quality-row', 'render-new-window', 'render-still-format'
  ]);
  const controls = [...new Set([...html.matchAll(/id="(render-[a-z-]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(controls.length >= 15, 'the dialog still has its controls');
  for (const id of controls) {
    if (PRESENTATION_ONLY.has(id)) continue;
    assert.ok(bridgeSource.includes(`'${id}'`), `#${id} is in the dialog but nothing reads it`);
  }
  /* The controls the render itself is graded and drawn with are read by the
     sync every render starts with, so a change cannot be missed. */
  for (const id of ['render-engine-select', 'render-aspect-select', 'render-quality-select',
    'render-samples-select', 'render-bounces-select', 'render-tonemap-select',
    'render-exp-range', 'render-contrast-range', 'render-sat-range', 'render-temp-range',
    'render-bloom-range', 'render-vig-range', 'render-ca-range', 'render-grain-range',
    'render-denoise-toggle', 'render-shadow-catcher']) {
    assert.ok(sync.includes(`'${id}'`), `#${id} must be part of the render sync`);
  }
  /* The camera source, environment, still format and quality are read where
     they are used: by the render camera, the scene upload, and the saver. */
  assert.match(bridgeSource, /getElementById\('render-cam-source'\)/, 'the camera source picks the render camera');
  assert.match(bridgeSource, /getElementById\('render-env-select'\)/, 'the sky is uploaded with the scene');
  assert.match(bridgeSource, /render-still-format/, 'the still format is what the saver writes');
  assert.match(bridgeSource, /render-still-quality/, 'and the quality slider is its setting');

  assert.match(sync, /syncRenderEngineEnabled\(\)/, 'the render sync applies the engine rules');
  assert.match(html, /id="out-still-quality"/, 'the quality slider shows its value');
});
