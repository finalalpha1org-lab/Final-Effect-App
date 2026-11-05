import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Feature 7 of the Workspace: the Animation Studio (timeline, keyframes, onion
   skin, motion trail). The kernel keeps the tracks - already covered by
   cpp-core-engine - so what is tested here is the panel: the places where a
   control looked live but changed nothing. Every failure below was a real one:
   a curve dropdown that only touched keys that did not exist yet, a track mode
   that redrew the sheet without moving the scene, Auto-Key that ignored every
   edit except a gizmo drag, and a dope sheet whose hit test reached into the
   row above. */

const html = readFileSync('index.html', 'utf8');
const bridge = readFileSync('fe-cpp-engine.js', 'utf8');
const wasmBytes = readFileSync('wasm/fe_core_engine.wasm');

function kernel() {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  const exports = inst.exports;
  /* The same readAllKeys the bridge uses, over the real kernel. */
  const readAllKeys = (slot, channel) => {
    exports.fe_arena_reset();
    const ptr = exports.fe_malloc(128 * 3 * 4);
    const n = exports.fe_anim_list_object_keyframes(slot, channel, ptr, 128);
    const view = new Float32Array(exports.memory.buffer, ptr, n * 3);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ frame: view[i * 3], value: view[i * 3 + 1], interp: view[i * 3 + 2] });
    }
    return out;
  };
  return { exports, readAllKeys };
}

/* Pull one method of the FECppEngine object literal out by name. */
function methodBody(name) {
  const start = bridge.indexOf(`\n    ${name}(`);
  assert.ok(start > 0, `${name} must be a method on FECppEngine`);
  let depth = 0;
  let i = bridge.indexOf('{', start);
  for (; i < bridge.length; i++) {
    if (bridge[i] === '{') depth++;
    else if (bridge[i] === '}') { depth--; if (depth === 0) break; }
  }
  return bridge.slice(start, i + 1);
}

function topLevelFunction(source, name) {
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

function loadStudioMethod(name, { engine = {}, helpers = {} } = {}) {
  const calls = { refreshed: 0, toast: [], evaluated: [] };
  const source = methodBody(name);
  const sandbox = {
    Math, Number, String, Array, Object, JSON, console, parseFloat, parseInt, Set, Infinity,
    window: {
      FE: { toast: (message) => calls.toast.push(message), getActiveObjectId: () => 'cube' },
      timelineConfig: { startFrame: 0, endFrame: 250, currentFrame: 7, fps: 30 },
      renderTimelineRulerCanvas: () => { calls.ruler = (calls.ruler || 0) + 1; }
    },
    sceneTimeConfig: () => ({ startF: 0, endF: 250, curF: 7, fps: 30 }),
    refreshAnimationStudioUI: () => { calls.refreshed++; },
    keyingSetChannels: () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
    KEYING_SETS: { transform: { channels: [0, 1, 2, 3, 4, 5, 6, 7, 8] } },
    CHANNEL_LABELS: ['Location X', 'Location Y', 'Location Z', 'Rotation X', 'Rotation Y',
      'Rotation Z', 'Scale X', 'Scale Y', 'Scale Z', 'Lens FOV / Intensity', 'Roughness'],
    INTERP_LABELS: ['Bezier Smooth', 'Linear', 'Step', 'Ease In', 'Ease Out', 'Bounce'],
    EXTRAP_LABELS: ['Hold', 'Loop Cycle', 'Ping-Pong'],
    ...helpers
  };
  const ctx = vm.createContext(sandbox);
  const holder = vm.runInContext(`({ ${source} })`, ctx);
  const engineApi = {
    ready: true,
    currentInterp: 0,
    selectedKey: null,
    evaluateSceneAtFrame(frame) { calls.evaluated.push(frame); return true; },
    ...engine
  };
  return { engine: engineApi, method: holder[name], calls, sandbox, ctx };
}

/* ---- Curve interpolation ------------------------------------------------ */

test('the curve dropdown re-keys the selected key instead of only the next one', () => {
  const select = html.slice(html.indexOf('id="anim-interp-select"'));
  const handler = select.slice(0, select.indexOf('</select>'));
  assert.match(handler, /onchange="FECppEngine\.setAnimationInterpolation\(this\.value\)"/,
    'the dropdown must call the method that edits the selected key');
  assert.ok(!/onchange="FECppEngine\.currentInterp=/.test(handler),
    'writing currentInterp alone would leave the selected key untouched');

  const { exports, readAllKeys } = kernel();
  const { engine, method } = loadStudioMethod('setAnimationInterpolation', {
    engine: { exports },
    helpers: { readAllKeys }
  });

  const slot = 4;
  exports.fe_anim_reset();
  exports.fe_anim_insert_keyframe(slot, 0, 0, 0, 0);
  exports.fe_anim_insert_keyframe(slot, 0, 10, 10, 0);
  exports.fe_anim_insert_keyframe(slot, 0, 20, 0, 0);

  const bezierAt15 = exports.fe_anim_evaluate_channel(slot, 0, 15, 0, 20);
  engine.selectedKey = { slot, channel: 0, frame: 10, value: 10 };
  assert.equal(method.call(engine, '2'), 1, 'picking a curve on a selected key must report a change');

  const keys = readAllKeys(slot, 0);
  assert.equal(keys.length, 3, 're-keying the same frame must not add a fourth key');
  const edited = keys.find((key) => Math.abs(key.frame - 10) < 0.01);
  assert.equal(edited.interp, 2, 'the selected key must carry the chosen curve');
  assert.equal(edited.value, 10, 'the key keeps its value');

  const steppedAt15 = exports.fe_anim_evaluate_channel(slot, 0, 15, 0, 20);
  assert.equal(steppedAt15, 10, 'a step key must hold its value until the next key');
  assert.notEqual(steppedAt15, bezierAt15, 'the curve change must move the evaluation');

  /* With nothing selected it stays the default for the keys about to be made. */
  engine.selectedKey = null;
  assert.equal(method.call(engine, '1'), 0);
  assert.equal(engine.currentInterp, 1);
});

test('every curve in the dropdown gives a different curve', () => {
  const { exports } = kernel();
  const slot = 6;
  const at15 = (mode) => {
    exports.fe_anim_reset();
    exports.fe_anim_insert_keyframe(slot, 0, 0, 0, 0);
    exports.fe_anim_insert_keyframe(slot, 0, 10, 10, mode);
    exports.fe_anim_insert_keyframe(slot, 0, 20, 0, 0);
    return exports.fe_anim_evaluate_channel(slot, 0, 15, 0, 20);
  };
  const values = [0, 1, 2, 3, 4, 5].map(at15);
  assert.equal(new Set(values).size, values.length, `six curves, six different values: ${values.join(', ')}`);
  /* The dropdown offers exactly the six modes the kernel has. */
  const options = html.match(/id="anim-interp-select"[\s\S]*?<\/select>/)[0].match(/<option value="(\d+)"/g);
  assert.equal(options.length, values.length);
});

test('the dropdown shows the curve that is in force', () => {
  const sync = bridge.slice(bridge.indexOf("const interpSel = document.getElementById('anim-interp-select')"));
  const body = sync.slice(0, sync.indexOf('const autoBtn'));
  assert.match(body, /const sel = FECppEngine\.selectedKey/, 'the selected key decides what is shown');
  assert.match(body, /shown = key\.interp/, 'a selected key shows its own curve');
  assert.match(body, /interpSel\.value = String\(shown\)/);
});

/* ---- Track extrapolation ------------------------------------------------ */

test('the track mode dropdown moves the scene, not just the sheet', () => {
  const select = html.slice(html.indexOf('id="anim-extrap-select"'));
  const handler = select.slice(0, select.indexOf('</select>'));
  assert.match(handler, /onchange="FECppEngine\.setTrackExtrapolation\(this\.value\)"/);

  const { exports } = kernel();
  const { engine, method, calls } = loadStudioMethod('setTrackExtrapolation', {
    engine: { exports, getSlotForObjectId: () => 9 }
  });
  exports.fe_anim_reset();
  exports.fe_anim_insert_keyframe(9, 0, 0, 0, 1);
  exports.fe_anim_insert_keyframe(9, 0, 10, 5, 1);

  /* The kernel answers with a status, so the mode is read back, not taken
     from the return value. */
  assert.equal(method.call(engine, '1'), 1);
  assert.equal(exports.fe_anim_get_extrapolation(9), 1, 'the kernel holds the loop mode');
  assert.deepEqual(calls.evaluated, [7], 'the playhead frame is re-evaluated so the pose follows');
  assert.ok(calls.refreshed > 0, 'the panel is refreshed');

  assert.equal(method.call(engine, '2'), 1);
  assert.equal(exports.fe_anim_get_extrapolation(9), 2);
  /* Out of range the mode decides the pose: loop wraps, hold does not. */
  assert.equal(exports.fe_anim_evaluate_channel(9, 0, 15, 0, 10), 2.5);
  exports.fe_anim_set_extrapolation(9, 0);
  assert.equal(exports.fe_anim_evaluate_channel(9, 0, 15, 0, 10), 5);
});

/* ---- Auto-Key ----------------------------------------------------------- */

test('Auto-Key covers every transform edit, not only a gizmo drag', () => {
  const helper = topLevelFunction(html, 'requestAutoKey');
  assert.match(helper, /eng\.autoKey/, 'it must do nothing while Auto-Key is off');
  assert.match(helper, /clearTimeout\(autoKeyFlushTimer\)/, 'a slider drag must not write one key per pixel');
  assert.match(helper, /insertKeyframeForActive\('keyset', true\)/,
    'one key per settled edit, through the same path the gizmo uses');

  const transform = topLevelFunction(html, 'applyTransformChange');
  assert.match(transform.slice(-120), /requestAutoKey\(\);/, 'numeric boxes and axis sliders end here');
  const uniform = topLevelFunction(html, 'applyUniformScale');
  assert.match(uniform.slice(-120), /requestAutoKey\(\);/, 'the uniform scale box ends here too');

  /* The gizmo path still keys as well. */
  assert.match(bridge, /if \(!ev\.value && FECppEngine\.autoKey\)/);
});

test('Auto-Key writes one key once the edit settles', async () => {
  const helper = topLevelFunction(html, 'requestAutoKey');
  const keys = [];
  const sandbox = {
    Math, Number, console, clearTimeout, setTimeout, String,
    FE: { toast: () => {} },
    window: {
      timelineConfig: { currentFrame: 12 },
      FECppEngine: null
    }
  };
  const ctx = vm.createContext(sandbox);
  const engine = {
    ready: true,
    autoKey: true,
    insertKeyframeForActive(group, silent) { keys.push([group, silent]); return 9; }
  };
  sandbox.window.FECppEngine = engine;
  /* The timer handle lives beside the function in the shell. */
  vm.runInContext(`let autoKeyFlushTimer = 0;\n${helper}`, ctx);
  const run = vm.runInContext('requestAutoKey', ctx);

  /* A drag: twenty calls, one key. */
  for (let i = 0; i < 20; i++) run();
  assert.equal(keys.length, 0, 'nothing is written mid-drag');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.deepEqual(keys, [['keyset', true]], 'exactly one key, silently');

  engine.autoKey = false;
  assert.equal(run(), false, 'off means off');
});

/* ---- Dope sheet hit testing -------------------------------------------- */

test('a tap on a dope sheet key stays inside its own row', () => {
  const hit = methodBody('hitTestAnimationKey');
  const dope = hit.slice(hit.indexOf('/* The same rows the sheet draws'));
  assert.match(dope, /const radius = Math\.max\(3, Math\.min\(7, rowH \* 0\.45\)\)/,
    'the radius has to follow the row height, or it reaches into the row above');
  assert.match(dope, /consider\(c, key\.frame, key\.value, m\.frameToX\(key\.frame\), yMid, radius\)/);
  assert.ok(!/yMid, 7\)/.test(dope), 'a fixed 7 px radius was the bug');

  /* The formula really does stay inside a row on a phone-sized sheet. */
  const radiusFor = (plotH) => Math.max(3, Math.min(7, (plotH / 11) * 0.45));
  for (const plotH of [134, 200, 400]) {
    assert.ok(radiusFor(plotH) < (plotH / 11) / 2 + 0.5,
      `plot ${plotH}: the hit circle must not reach the neighbouring row`);
  }
});

/* ---- Deleting keys ------------------------------------------------------ */

test('deleting a key drops the selection and puts the scene back on its keys', () => {
  const del = methodBody('deleteKeyframeAtCurrentFrame');
  assert.match(del, /this\.selectedKey = null/, 'a selection on a deleted key cannot stay lit');
  assert.match(del, /this\.evaluateSceneAtFrame\(frame\)/, 'the object follows the keys that remain');

  const axis = methodBody('toggleAxisKeyframeForActive');
  assert.match(axis, /this\.selectedKey = null/);
  assert.match(axis, /this\.evaluateSceneAtFrame\(frame\)/);

  const group = methodBody('toggleKeyframeForActive');
  assert.match(group, /this\.selectedKey = null/);
  assert.match(group, /this\.evaluateSceneAtFrame\(frame\)/);

  const clear = methodBody('clearActiveObjectAnimation');
  assert.match(clear, /this\.selectedKey = null/);
});

/* ---- Onion skin and motion trail --------------------------------------- */

test('the onion range control drives the ghosts', () => {
  const select = html.slice(html.indexOf('id="anim-onion-range"'));
  assert.match(select.slice(0, select.indexOf('</select>')), /onchange="FECppEngine\.setOnionRange\(this\.value\)"/);
  const setter = methodBody('setOnionRange');
  assert.match(setter, /this\.onionSkin\.before = range/);
  assert.match(setter, /if \(this\.onionSkin\.enabled\) this\.updateOnionSkin\(\)/,
    'moving the range must redraw ghosts that are showing');
  assert.match(methodBody('toggleOnionSkin'), /this\.updateOnionSkin\(\)/);
});

test('the motion trail is bounded by its sample block and leaves playback alone', () => {
  const trail = methodBody('updateMotionTrail');
  assert.match(trail, /Math\.min\(64, Math\.round\(to - from\) \+ 1\)/,
    'the block is 64 floats; asking for more flattened the end of the path');
  assert.match(trail, /if \(window\.timelineConfig\?\.isPlaying\) return;/,
    'playback must not rebuild the path every frame');
  assert.match(trail, /const parentWorld = obj\.parent && obj\.parent !== eng\.sc/,
    'a parented object is drawn where it actually is');
  assert.match(trail, /point\.set\(coords\[0\]\[i\], coords\[1\]\[i\], coords\[2\]\[i\]\)\.applyMatrix4\(parentWorld\)/);

  /* The 64 float request matches the 64 float block that is allocated. */
  assert.match(trail, /this\.allocF32\(64\)/);
  assert.match(trail, /fe_anim_sample_channel\(slot, c, from, to, count, buf\.ptr, 64\)/);
});

test('the trail and the ghosts are hidden when the studio closes', () => {
  const close = bridge.slice(bridge.indexOf('/* 3b. Hide ghosts and trails when the Animation Studio closes */'));
  const body = close.slice(0, close.indexOf('/* 4. Listen for'));
  assert.match(body, /_onionGroup\.visible = false/);
  assert.match(body, /_trailGroup\.visible = false/);
});

/* ---- The channel map ---------------------------------------------------- */

test('every keyed channel is read back when the scene is evaluated', () => {
  const evaluate = methodBody('evaluateSceneAtFrame');
  /* Channels 0-9 were wired; 10 (roughness) was stored, drawn, and ignored. */
  for (let channel = 0; channel <= 10; channel++) {
    assert.match(evaluate, new RegExp(`fe_anim_get_keyframe_count\\(slot, ${channel}\\)`),
      `channel ${channel} must be applied on evaluation`);
  }
  assert.match(evaluate, /obj\.material\.roughness = Math\.max\(0, Math\.min\(1, v\[10\]\)\)/);
});

test('the dope sheet rows name the channels they draw', () => {
  const rowsStart = bridge.indexOf("const rows = [\n        { c: 0, label: 'Location X' }");
  assert.ok(rowsStart > 0, 'the dope sheet row table must exist');
  const rows = bridge.slice(rowsStart, bridge.indexOf('const rowH = m.plotH / rows.length', rowsStart));
  const labels = [...rows.matchAll(/label: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(labels.length, 11, 'one row per channel');
  assert.equal(labels[9], 'Lens/Light', 'channel 9 is the lens on a camera and the intensity on a light');
  assert.equal(labels[10], 'Roughness', 'channel 10 is the material roughness');
});

/* ---- The studio itself -------------------------------------------------- */

test('the studio refreshes on open, on close, and on every keying action', () => {
  const open = bridge.slice(bridge.indexOf('const origOpenAnim = window.openAnimationModal'), bridge.indexOf('/* 3b. Hide ghosts'));
  assert.match(open, /requestAnimationFrame\(refreshAnimationStudioUI\)/,
    'opening the sheet must paint the dope sheet, not wait for a scrub');

  const insert = methodBody('insertKeyframeForActive');
  assert.match(insert, /refreshAnimationStudioUI\(\)/);
  assert.match(insert, /renderTimelineRulerCanvas/);
  /* The ◆ on each axis keys exactly one channel. */
  assert.match(methodBody('insertAxisKeyframeForActive'), /this\.insertKeyframeForActive\(\[channel\], true\)/);
});
