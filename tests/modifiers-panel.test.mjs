import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Feature 6 of the Workspace: the Modifiers Tool. The geometry itself is the
   tested module (modifier-geometry / modifier-cpp), so what is checked here is
   the panel: what the library offers, whether the evaluator can actually run
   it, and whether a control that looks live changes anything. Every failure
   below was a real one in the panel - two of them were several hundred lines of
   code that had been silently replaced and could never run again. */

const html = readFileSync('index.html', 'utf8');
const sim = readFileSync('simulationCore.js', 'utf8');

const registryStart = html.indexOf('const modifiersData');
const registryEnd = html.indexOf('\nlet modStack', registryStart);
assert.ok(registryStart > 0 && registryEnd > registryStart, 'the modifier registry must exist');
const registry = html.slice(registryStart, registryEnd);
/* Everything the panel does, minus the registry itself: a field label that
   appears nowhere else is a control nothing reads. */
const outsideRegistry = html.slice(0, registryStart) + html.slice(registryEnd);

function functionsDeclaredOnce(source) {
  const seen = new Map();
  for (const line of source.split('\n')) {
    const match = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (!match) continue;
    seen.set(match[1], (seen.get(match[1]) || 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

function registryEntries() {
  const entries = [];
  for (const match of registry.matchAll(/name:"([^"]+)", fields:\s*\[/g)) {
    const name = match[1];
    const open = registry.indexOf('[', match.index + match[0].length);
    let depth = 0;
    let i = open;
    for (; i < registry.length; i++) {
      if (registry[i] === '[') depth++;
      else if (registry[i] === ']') { depth--; if (depth === 0) break; }
    }
    const fields = registry.slice(open, i + 1);
    const labels = [...fields.matchAll(/\[\s*"([^"]+)"\s*,/g)].map((m) => m[1]);
    entries.push({ name, labels });
  }
  return entries;
}

function evaluatorSource() {
  const start = html.indexOf('function updateModifiersOnScene');
  assert.ok(start > 0);
  return html.slice(start, html.indexOf('window.updateModifiersOnScene = updateModifiersOnScene'));
}

/* Pull one top-level function out of the shell by name, braces matched. */
function topLevel(source, name) {
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

/* ---- The library and the evaluator agree -------------------------------- */

test('no function in the shell is declared twice', () => {
  /* Fifteen modifier implementations used to exist twice: the old ad-hoc JS
     versions and the kernel-backed ones. The last declaration wins, so the
     first copies were unreachable - and editing them changed nothing. */
  assert.deepEqual(functionsDeclaredOnce(html), []);
});

test('the superseded modifier implementations stay deleted', () => {
  assert.equal(html.split('function applyBevelModifier(').length - 1, 1, 'one Bevel, the kernel-backed one');
  assert.equal(html.split('function applyShrinkwrapModifier(').length - 1, 1);
  assert.ok(!html.includes('function applyLatticeModifier('), 'the fake taper has no caller and no home');
  assert.ok(!/REAL PROCEDURAL GEOMETRY MODIFIER FUNCTIONS/.test(html), 'the old section header went with it');
});

test('every modifier the library offers has somewhere to run', () => {
  const evaluator = evaluatorSource();
  const physics = new Set(['Collision', 'Cloth', 'Soft Body', 'Fluid']);
  const entries = registryEntries();
  assert.equal(entries.length, 24);

  for (const { name } of entries) {
    if (physics.has(name)) continue;
    assert.ok(
      new RegExp(`mod\\.name === "${name}"`).test(evaluator),
      `${name} is offered by the library but has no stage in updateModifiersOnScene`
    );
  }

  /* The four physics entries are not geometry stages: they configure the
     solver, and their settings travel through userData. */
  assert.match(evaluator, /collisionSettings=\{\.\.\.collisionMod\.values,enabled:true\}/);
  assert.match(evaluator, /initClothSim\(targetObj, mod\.values/);
  assert.match(evaluator, /initSoftBodySim\(targetObj, mod\.values/);
  assert.match(evaluator, /initFluidSim\(targetObj, mod\.values/);
});

test('every field a modifier card shows is read by something', () => {
  /* Subdivision carried a "Render Levels" slider with no render path to feed,
     and Surface Deform a "Falloff" that was passed to a bind function taking
     three arguments. Both looked live and did nothing. */
  const physics = new Set(['Collision', 'Cloth', 'Soft Body', 'Fluid']);
  for (const { name, labels } of registryEntries()) {
    for (const label of labels) {
      const read = outsideRegistry.includes(label) || (physics.has(name) && sim.includes(label));
      assert.ok(read, `${name} shows "${label}" but nothing reads it`);
    }
  }
});

test('Subdivision Surface offers both of Blender\'s modes and levels up to ten', () => {
  /* The card used to carry a single slider that stopped at four, and one way to
     subdivide. Blender's modifier has two: Catmull-Clark, which rounds the shape
     off, and Simple, which splits the mesh and leaves the silhouette exactly
     where it was. Both are offered, and both are read by the evaluator. */
  const entry = registryEntries().find((candidate) => candidate.name === 'Subdivision Surface');
  assert.ok(entry, 'Subdivision Surface is in the library');
  assert.equal(entry.labels[0], 'Subdivision Type', 'the mode selector leads the card');
  const card = registry.slice(registry.indexOf('name:"Subdivision Surface"'));
  assert.match(card, /\["Subdivision Type","select",\["Catmull-Clark","Simple"\]\]/);
  assert.match(card, /\["Viewport Levels","range",0,10,2,1\]/);
  const evaluator = evaluatorSource();
  assert.match(evaluator, /p\["Subdivision Type"\] === "Simple"/, 'the evaluator reads the mode');
  assert.match(evaluator, /applySubdivisionModifier\(currentGeo, lvl, simple\)/, 'and passes it to the modifier');
  /* The object-space prefix evaluator (what a Boolean above this modifier sees)
     reads the same two values. */
  assert.match(html, /applySubdivisionModifier\(g,Number\(p\['Viewport Levels'\]\?\?2\),p\['Subdivision Type'\]==='Simple'\)/);
});

test('Subdivision Surface says which level it built when the slider asks for more', () => {
  /* A level quadruples the triangles, so ten is past what the session holds for
     any real mesh. Doing six and saying nothing would leave the slider lying;
     the card carries a line that names the level that was built. */
  assert.match(html, /function feSubdivisionNote\(info, element\)/);
  const note = topLevel(html, 'feSubdivisionNote');
  assert.match(note, /info\.levels < info\.requested/);
  assert.match(note, /built level \$\{info\.levels\} of \$\{info\.requested\}/);
  assert.match(html, /card\.dataset\.modifier = mod\.name/);
  assert.match(html, /feSubdivisionNote\(subdivisionNote\)/);
});

test('the two dead sliders specifically stay gone', () => {
  assert.ok(!registry.includes('Render Levels'));
  assert.ok(!registry.includes('"Falloff"'));
  assert.ok(!html.includes("p['Falloff']"));
});

/* ---- Editing cost -------------------------------------------------------- */

test('a slider drag evaluates once per frame and saves once', () => {
  const handler = html.slice(html.indexOf('input.oninput = () => {\n      labelEl.lastElementChild.textContent'));
  const range = handler.slice(0, handler.indexOf('wrapper.append(labelEl, input)'));
  assert.match(range, /scheduleModifierUpdate\(targetObj\)/, 'the drag asks for one evaluation per frame');
  assert.ok(!/updateModifiersOnScene\(\)/.test(range), 'and not one per input event');
  assert.match(range, /input\.onchange = \(\) => scheduleModifierUpdate\(null, true\)/,
    'letting go evaluates the value it landed on immediately');

  const sheet = html.slice(html.indexOf("modifiersSheetEl.addEventListener('input'"));
  assert.match(sheet.slice(0, 300), /scheduleModifierUpdate\(\)/);

  const evaluator = evaluatorSource();
  assert.ok(!/saveCurrentProjectAsRecent\(\)/.test(evaluator),
    'the evaluator must not write localStorage; a gesture ends in one debounced save');
  assert.match(evaluator, /feSaveProjectSoon\(\)/);
});

test('scheduleModifierUpdate coalesces a burst into one evaluation', () => {
  const source = topLevel(html, 'scheduleModifierUpdate') + '\n' + topLevel(html, 'feSaveProjectSoon');
  const calls = [];
  const timers = [];
  const ctx = vm.createContext({
    Math, Number, console, String, Array, Object, JSON,
    requestAnimationFrame: (fn) => { timers.push(fn); return timers.length; },
    cancelAnimationFrame: () => { timers.push(null); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    updateModifiersOnScene: (target) => calls.push(target || null),
    saveCurrentProjectAsRecent: () => calls.push('save'),
    window: {}
  });
  vm.runInContext(`let modifierUpdateHandle = 0;\nlet modifierUpdateTarget = null;\nlet feSaveProjectSoonHandle = 0;\n${source}`, ctx);
  const schedule = vm.runInContext('scheduleModifierUpdate', ctx);

  const target = { name: 'cube' };
  for (let i = 0; i < 5; i++) schedule(target);
  assert.equal(calls.length, 0, 'nothing runs before the frame');
  assert.equal(timers.length, 1, 'five edits queue one frame');
  timers.shift()();
  assert.deepEqual(calls, [target], 'one evaluation, for the object being edited');

  schedule(null, true);
  assert.equal(calls.length, 2, 'the release evaluates immediately');
});

test('the project record is written once a gesture settles', async () => {
  const source = topLevel(html, 'feSaveProjectSoon');
  let saves = 0;
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Math, Number, console, String,
    saveCurrentProjectAsRecent: () => { saves++; },
    window: {}
  });
  vm.runInContext(`let feSaveProjectSoonHandle = 0;\n${source}`, ctx);
  const soon = vm.runInContext('feSaveProjectSoon', ctx);

  for (let i = 0; i < 10; i++) soon();
  assert.equal(saves, 0, 'mid-gesture nothing is written');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(saves, 1, 'ten edits, one write');
});

/* ---- Correctness of the cache ------------------------------------------- */

test('the stack is only rebuilt on a move when a modifier reads other objects', () => {
  /* Folding the object's transform into every stack's hash made a subdivision
     surface rebuild its whole mesh on each step of a Move drag. */
  const hash = topLevel(html, 'modifierEvaluationHash');
  assert.match(hash, /const needsPlacement = mods\.some\(mod => modifierDependencyRef\(mod\)\)/);
  assert.match(hash, /transform:needsPlacement \? targetObj\.matrixWorld\?\.elements : null/);

  const ref = topLevel(html, 'modifierDependencyRef');
  for (const name of ['Boolean', 'Shrinkwrap', 'Surface Deform', 'Lattice', 'Armature']) {
    assert.ok(ref.includes(`'${name}'`), `${name} works in the other object's space`);
  }
});

test('a geometry stage disposes the input it replaced', () => {
  const stage = topLevel(html, 'applyModifierGeometryStage');
  const disposed = [];
  const ctx = vm.createContext({ Math, console, String, Object, Array });
  vm.runInContext(stage, ctx);
  const run = vm.runInContext('applyModifierGeometryStage', ctx);
  const input = { dispose: () => disposed.push('input') };
  const output = { dispose: () => disposed.push('output') };
  assert.equal(run(input, () => output), output);
  assert.deepEqual(disposed, ['input'], 'the replaced mesh is released');
  /* A stage that declines to change the mesh must not release it. */
  assert.equal(run(input, () => input), input);
  assert.deepEqual(disposed, ['input']);
});

/* ---- The phone ----------------------------------------------------------- */

test('on a phone the stack stays reachable and the buttons are thumb-sized', () => {
  const mobile = html.slice(html.indexOf('@media(max-width:768px) {\n  #modifiers-sheet-body'));
  const block = mobile.slice(0, mobile.indexOf('}\n.category-title'));
  assert.match(block, /grid-template-columns: 1fr/);
  assert.match(block, /#modifiers-sheet-body > \.sidebar\s*\{\s*max-height: 30vh/,
    '24 library entries may not push the stack off the sheet');
  assert.match(block, /\.icon-btn\s*\{\s*min-width: 40px; min-height: 40px/,
    'the remove button is a finger target, not a cursor target');
  assert.match(block, /\.small-btn\s*\{\s*padding: 10px/);
});
