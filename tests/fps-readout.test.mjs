import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The product rule is narrow and was already being broken: frame rate is shown
 * in the ⚙ 3D-workspace sheet and nowhere else. The Landscaping Studio used to
 * print its own "#fps" into the top bar, on top of the viewport, which put a
 * diagnostic in front of the artwork - exactly what the rule forbids.
 *
 * The measurement still has to run (the adaptive governor needs it), so the fix
 * is a hand-off: the studio measures, posts the number to the shell, and the
 * shell's settings sheet displays it. */

const shell = readFileSync('index.html', 'utf8');
const page = readFileSync('Terrain_system_.html', 'utf8');
const loop = readFileSync('terrain-main-09.js', 'utf8');

test('the studio no longer paints a frame rate over its viewport', () => {
  assert.equal(/id="fps"/.test(page), false, 'the top bar still holds an fps element');
  assert.equal(/#fps\{/.test(page), false, 'the fps style is still shipped');
  assert.equal(/\$\('#fps'\)/.test(loop), false, 'the render loop still writes to an fps element');
});

test('the studio still measures, and hands the number to the shell', () => {
  assert.match(loop, /const measuredFps=fc\/ft;/, 'the loop must still measure a frame rate');
  assert.match(loop, /reportPerf\(measuredFps\)/, 'the measurement must be reported');
  assert.match(loop, /postMessage\(\{type:'fe-perf',source:'landscape'/, 'the report is a message to the shell');
  /* The governor is the reason the measurement exists; it must still run. */
  assert.match(loop, /updateSmoothPreview\(measuredFps,n\)/);
});

test('the shell shows the studio report in the 3D-workspace settings sheet', () => {
  const sheet = /id="ws-perf-fps"/.test(shell);
  assert.ok(sheet, 'the settings sheet must own the fps readout');
  assert.match(shell, /d\.type === 'fe-perf'/, 'the shell must listen for the studio report');
  assert.match(shell, /renderWorkspacePerf\(\{fps:d\.fps/, 'the report feeds the sheet, not the viewport');
});
