import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The Workspace is one page (index.html) and a handful of modules that reach
   into it by element id. An id that no longer exists is the quiet kind of bug:
   nothing throws, the lookup returns null, and the feature silently stops
   working - it is how the still renderer lost depth of field entirely, reading
   `cam-dof-enable` and `cam-fstop` from a camera panel that had been rewritten
   underneath it. This suite keeps the two sides in step. */

const html = readFileSync('index.html', 'utf8');
const MODULES = [
  'fe-cpp-engine.js', 'edit-mode.js', 'modifier-engine.js', 'render-export.js',
  'render-preview.js', 'render-capture.js', 'workspace-export.js', 'fe-project.js',
  'fe-poly.js', 'simulationCore.js'
];

/* Ids the page builds at runtime from a prefix would look missing here, so only
   the control families that are written out in the markup are checked. */
const CONTROL_PREFIXES = /^(cam|render|anim|fx|set|ws|tool|panel|btn|out|tl|key|mod|add|export|edit|light|hdri|status|fe)-/;

const pageIds = new Set();
for (const match of html.matchAll(/\bid\s*=\s*["']([A-Za-z][\w-]*)["']/g)) pageIds.add(match[1]);

test('every control id the modules reach for exists in the page', () => {
  const missing = [];
  for (const file of MODULES) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) {
      const id = match[1];
      if (!CONTROL_PREFIXES.test(id)) continue;
      if (!pageIds.has(id)) missing.push(`${file}: #${id}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'a module is looking for a control the page does not have');
});

test('the renderer reads the camera panel it actually has', () => {
  const bridge = readFileSync('fe-cpp-engine.js', 'utf8');
  const aperture = bridge.slice(bridge.indexOf('const dofCheck ='), bridge.indexOf('const fov = cam.isPerspectiveCamera'));
  assert.match(aperture, /getElementById\('cam-dof'\)/, 'the Depth of Field switch');
  assert.match(aperture, /getElementById\('cam-aperture'\)/, 'and the F-Stop slider');
  assert.ok(!/cam-dof-enable|cam-fstop/.test(aperture.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the old ids must not come back, not even as a fallback');

  /* The switch has to be able to make a difference: a closed DoF switch means
     aperture 0, an open one means a real aperture from the f-stop. */
  assert.match(aperture, /\(dofCheck && dofCheck\.checked\)/, 'DoF is read from the switch');
  assert.match(aperture, /Number\(fStopEl\?\.value\)/, 'and the f-stop from its slider');
  assert.match(aperture, /\? Math\.max\(0\.0, Math\.min\(0\.45,[\s\S]*?\)\)\s*:\s*0\.0/, 'closed means no aperture');

  /* The viewport's own DoF reads the same two controls, so the two renderers
     cannot disagree about what the user set. */
  const viewport = html.slice(html.indexOf('function updateDoFFilter'), html.indexOf('function updateDoFFilter') + 2000);
  assert.match(viewport, /getElementById\('cam-dof'\)\?\.checked/);
  assert.match(viewport, /getElementById\('cam-aperture'\)\?\.value/);
});
