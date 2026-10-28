import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Edit Mode is a C++ kernel (`fe_edit_*`), so it is tested twice:
 *
 *   1. natively — cpp/tests/fe_editmesh_tests.cpp compiles against the two
 *      kernel translation units and asserts topology after every operation;
 *   2. through the shipped artifact — the same operations are driven through
 *      wasm/fe_core_engine.wasm, because the native binary and the browser
 *      build are two different compilations of the same sources and only the
 *      second one is what a user actually runs.
 *
 * A kernel change that breaks the editor therefore fails `npm test`, not just
 * the emscripten/zig CI job. */

const CUBE_VERTS = new Float32Array([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
]);

const CUBE_TRIS = new Uint32Array([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6,
  3, 0, 4, 3, 4, 7
]);

/* ---- native suite -------------------------------------------------------- */

const NATIVE_SOURCES = [
  'cpp/src/fe_heap.cpp',
  'cpp/src/fe_scatter.cpp',
  'cpp/src/fe_skin.cpp',
  'cpp/src/fe_editmesh.cpp',
  'cpp/src/fe_editmesh_tools.cpp',
  'cpp/tests/fe_editmesh_tests.cpp'
];

function findCompiler() {
  const candidates = [
    { cmd: 'c++', args: [] },
    { cmd: 'g++', args: [] },
    { cmd: 'clang++', args: [] },
    { cmd: 'python3', args: ['-m', 'ziglang', 'c++'] },
    { cmd: 'python', args: ['-m', 'ziglang', 'c++'] }
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.cmd, [...candidate.args, '--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

test('native C++ Edit Mode suite passes', () => {
  const compiler = findCompiler();
  assert.ok(compiler, 'No C++ compiler found. Install g++/clang++ (or pip install ziglang) to run the Edit Mode kernel tests.');
  const outDir = join(tmpdir(), 'fe-editmesh-tests');
  mkdirSync(outDir, { recursive: true });
  const binary = join(outDir, 'fe_editmesh_tests');
  const sources = NATIVE_SOURCES;

  /* Rebuild only when a source changed: the suite is ~2 s of compilation and
     it runs on every `npm test`. */
  const newest = Math.max(...sources.map((file) => statSync(file).mtimeMs));
  const fresh = existsSync(binary) && statSync(binary).mtimeMs >= newest;
  if (!fresh) {
    const args = [...compiler.args, '-std=c++20', '-O2', '-Wall', '-Wextra', ...sources, '-o', binary, '-lm'];
    const build = spawnSync(compiler.cmd, args, { encoding: 'utf8' });
    assert.equal(build.status, 0, `Edit Mode kernel did not compile:\n${build.stderr || build.stdout}`);
  }

  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, `Edit Mode kernel tests failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /All Final Effect C\+\+20 Edit Mode tests passed/);
  assert.doesNotMatch(run.stdout, /FAIL /);
});

/* ---- wasm artifact ------------------------------------------------------- */

const artifact = readFileSync('wasm/fe_core_engine.wasm');

function loadEngine() {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact), {});
  return instance.exports;
}

function uploadCube(exp) {
  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(CUBE_VERTS.byteLength);
  const triPtr = exp.fe_malloc(CUBE_TRIS.byteLength);
  assert.ok(posPtr && triPtr, 'scratch arena refused the cube upload');
  new Float32Array(exp.memory.buffer, posPtr, CUBE_VERTS.length).set(CUBE_VERTS);
  new Uint32Array(exp.memory.buffer, triPtr, CUBE_TRIS.length).set(CUBE_TRIS);
  const ok = exp.fe_edit_upload(8, posPtr, 12, triPtr, 0);
  exp.fe_arena_reset();
  assert.equal(ok, 1, 'fe_edit_upload rejected the unit cube');
}

function positions(exp) {
  const nv = exp.fe_edit_vert_count();
  return new Float32Array(exp.memory.buffer, exp.fe_edit_pos_interleaved_ptr(), nv * 3);
}

function indices(exp) {
  const nt = exp.fe_edit_tri_count();
  return new Uint32Array(exp.memory.buffer, exp.fe_edit_idx_ptr(), nt * 3);
}

function signedVolume(exp) {
  const p = positions(exp);
  const t = indices(exp);
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return volume;
}

function assertIntegrity(exp, where) {
  const nv = exp.fe_edit_vert_count();
  const nt = exp.fe_edit_tri_count();
  assert.ok(nv <= exp.fe_edit_max_verts(), `${where}: vertex count above the kernel limit`);
  const p = positions(exp);
  const t = indices(exp);
  for (let i = 0; i < p.length; i++) assert.ok(Number.isFinite(p[i]), `${where}: non-finite coordinate ${i}`);
  for (let i = 0; i < t.length; i++) assert.ok(t[i] < nv, `${where}: index ${t[i]} outside ${nv} vertices`);
  for (let i = 0; i < t.length; i += 3) {
    assert.ok(t[i] !== t[i + 1] && t[i + 1] !== t[i + 2] && t[i] !== t[i + 2], `${where}: degenerate triangle ${i / 3}`);
  }
}

test('shipped wasm exposes the whole Edit Mode surface', () => {
  const exp = loadEngine();
  const required = [
    'fe_edit_reset', 'fe_edit_upload', 'fe_edit_vert_count', 'fe_edit_tri_count', 'fe_edit_edge_count',
    'fe_edit_max_verts', 'fe_edit_pos_interleaved_ptr', 'fe_edit_idx_ptr',
    'fe_edit_edge_ptr', 'fe_edit_edge_b_ptr', 'fe_edit_edge_face_ptr', 'fe_edit_edge_sel_ptr',
    'fe_edit_vert_sel_ptr', 'fe_edit_face_sel_ptr', 'fe_edit_stats_ptr', 'fe_edit_bounds_ptr',
    'fe_edit_set_mode', 'fe_edit_select_all', 'fe_edit_select_none', 'fe_edit_select_invert',
    'fe_edit_select_by_index', 'fe_edit_select_linked', 'fe_edit_select_more', 'fe_edit_select_less',
    'fe_edit_select_similar', 'fe_edit_select_random', 'fe_edit_select_box', 'fe_edit_select_circle',
    'fe_edit_pick', 'fe_edit_select_loop', 'fe_edit_set_proportional',
    'fe_edit_move', 'fe_edit_rotate', 'fe_edit_scale', 'fe_edit_shrink_fatten', 'fe_edit_shear',
    'fe_edit_to_sphere', 'fe_edit_bend', 'fe_edit_randomize', 'fe_edit_align', 'fe_edit_mirror',
    'fe_edit_slide', 'fe_edit_set_shade', 'fe_edit_mark_sharp', 'fe_edit_mark_seam',
    'fe_edit_recalc_normals', 'fe_edit_flip_normals',
    'fe_edit_build_render', 'fe_edit_render_pos_ptr', 'fe_edit_render_nrm_ptr',
    'fe_edit_render_idx_ptr', 'fe_edit_render_vert_count', 'fe_edit_render_idx_count',
    'fe_edit_undo_push', 'fe_edit_undo', 'fe_edit_redo', 'fe_edit_undo_depth', 'fe_edit_redo_depth',
    'fe_edit_extrude', 'fe_edit_inset', 'fe_edit_subdivide', 'fe_edit_merge_center',
    'fe_edit_merge_distance', 'fe_edit_delete', 'fe_edit_duplicate', 'fe_edit_poke', 'fe_edit_fill',
    'fe_edit_bridge', 'fe_edit_bisect', 'fe_edit_bevel', 'fe_edit_symmetrize', 'fe_edit_split',
    'fe_edit_collapse',
    'fe_edit_weld_count', 'fe_edit_edge_display_ptr', 'fe_edit_set_display_angle',
    'fe_edit_detect_smooth', 'fe_edit_gizmo_pivot', 'fe_edit_gizmo_size', 'fe_edit_gizmo_pick',
    'fe_edit_gizmo_begin', 'fe_edit_gizmo_drag', 'fe_edit_gizmo_end', 'fe_edit_gizmo_active'
  ];
  for (const name of required) {
    assert.equal(typeof exp[name], 'function', `wasm is missing ${name}`);
  }
});

test('upload builds the expected topology and refuses oversized meshes', () => {
  const exp = loadEngine();
  uploadCube(exp);
  assert.equal(exp.fe_edit_vert_count(), 8);
  assert.equal(exp.fe_edit_tri_count(), 12);
  assert.equal(exp.fe_edit_edge_count(), 18);
  assert.equal(exp.fe_edit_has_color(), 0);
  assert.equal(exp.fe_edit_max_verts(), 16384);

  /* The edge table is struct-of-arrays: both halves must describe the same
     edge, and every endpoint must be a real vertex. */
  const ne = exp.fe_edit_edge_count();
  const a = new Uint32Array(exp.memory.buffer, exp.fe_edit_edge_ptr(), ne);
  const b = new Uint32Array(exp.memory.buffer, exp.fe_edit_edge_b_ptr(), ne);
  for (let e = 0; e < ne; e++) {
    assert.ok(a[e] < 8 && b[e] < 8, `edge ${e} points outside the cube`);
    assert.notEqual(a[e], b[e], `edge ${e} has equal endpoints`);
  }

  /* Too large for the kernel: refused instead of truncated. */
  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(3 * 4 * 8);
  const triPtr = exp.fe_malloc(12);
  assert.equal(exp.fe_edit_upload(exp.fe_edit_max_verts() + 1, posPtr, 1, triPtr, 0), 0);
  exp.fe_arena_reset();
  /* The refused upload must leave the previous mesh untouched. */
  assert.equal(exp.fe_edit_vert_count(), 8);
});

test('selection is shared by the three modes and the tap ray respects depth', () => {
  const exp = loadEngine();
  uploadCube(exp);

  exp.fe_edit_select_all();
  assert.equal(exp.fe_edit_sel_count(), 8);
  exp.fe_edit_set_mode(1);
  assert.equal(exp.fe_edit_sel_count(), 18);
  exp.fe_edit_set_mode(2);
  assert.equal(exp.fe_edit_sel_count(), 12);

  exp.fe_edit_select_none();
  exp.fe_edit_set_mode(0);
  assert.equal(exp.fe_edit_sel_count(), 0);
  exp.fe_edit_select_invert();
  assert.equal(exp.fe_edit_sel_count(), 8);

  /* A tap in the middle of the screen has to hit the front of the cube: with a
     depth buffer the pick returns one of the near corners, never the far one. */
  const clip = new Float32Array(16);
  clip[0] = 0.5; clip[5] = 0.5; clip[10] = -0.5; clip[15] = 1;
  exp.fe_arena_reset();
  const clipPtr = exp.fe_malloc(64);
  new Float32Array(exp.memory.buffer, clipPtr, 16).set(clip);
  const hit = exp.fe_edit_pick(clipPtr, 0.5, 0.5);
  exp.fe_arena_reset();
  assert.ok(hit >= 0 && hit < 8, `tap at the centre of the cube returned ${hit}`);

  /* Box select over the whole screen grabs every vertex. */
  exp.fe_edit_select_none();
  exp.fe_arena_reset();
  const boxPtr = exp.fe_malloc(64);
  new Float32Array(exp.memory.buffer, boxPtr, 16).set(clip);
  const boxed = exp.fe_edit_select_box(boxPtr, 0, 0, 1, 1, 0, 1);
  exp.fe_arena_reset();
  assert.equal(boxed, 8, 'a full-screen box did not select the cube');
});

test('transform, undo and redo round-trip through the artifact', () => {
  const exp = loadEngine();
  uploadCube(exp);
  exp.fe_edit_select_all();
  exp.fe_edit_undo_push();
  assert.equal(exp.fe_edit_undo_depth(), 1);
  assert.equal(exp.fe_edit_move(0.5, 0, 0, 0), 8);
  let p = positions(exp);
  for (let v = 0; v < 8; v++) assert.ok(Math.abs(p[v * 3] - (CUBE_VERTS[v * 3] + 0.5)) < 1e-5);
  assert.ok(Math.abs(signedVolume(exp) - 8) < 1e-4, 'moving every vertex changed the volume');

  assert.equal(exp.fe_edit_undo(), 1);
  p = positions(exp);
  assert.ok(Math.abs(p[0] + 1) < 1e-5, 'undo did not restore the position');
  assert.equal(exp.fe_edit_redo(), 1);
  p = positions(exp);
  assert.ok(Math.abs(p[0] + 0.5) < 1e-5, 'redo did not reapply the move');

  /* Axis lock: only X moves. */
  exp.fe_edit_undo_push();
  exp.fe_edit_move(1, 1, 1, 1);
  p = positions(exp);
  assert.ok(Math.abs(p[1] + 1) < 1e-5, 'the X axis lock let Y move');
  assert.ok(Math.abs(p[2] + 1) < 1e-5, 'the X axis lock let Z move');
});

test('topology tools keep the mesh valid in the browser build', () => {
  const exp = loadEngine();
  uploadCube(exp);

  exp.fe_edit_select_all();
  exp.fe_edit_select_none();
  exp.fe_edit_select_all();

  /* Extrude a closed shell: the original shell stays and a moved copy is
     appended, which is what makes the operation visible at all. */
  const extruded = exp.fe_edit_extrude(0.4, 0);
  assert.ok(extruded > 0, 'extrude reported no geometry');
  assert.equal(exp.fe_edit_vert_count(), 16);
  assert.equal(exp.fe_edit_tri_count(), 24);
  assertIntegrity(exp, 'extrude');

  exp.fe_edit_undo();
  assert.equal(exp.fe_edit_vert_count(), 8);
  assert.equal(exp.fe_edit_tri_count(), 12);

  /* Subdivide every face: 12 -> 48 triangles, volume unchanged. */
  exp.fe_edit_undo_push();
  assert.ok(exp.fe_edit_subdivide(0, 0) > 0);
  assert.equal(exp.fe_edit_tri_count(), 48);
  assert.ok(Math.abs(signedVolume(exp) - 8) < 1e-3, 'subdivide moved the surface');
  assertIntegrity(exp, 'subdivide');

  exp.fe_edit_undo();
  exp.fe_edit_set_mode(2);
  exp.fe_edit_select_all();
  exp.fe_edit_undo_push();
  assert.ok(exp.fe_edit_bevel(0.1, 0) > 0);
  assertIntegrity(exp, 'bevel');
  exp.fe_edit_undo();

  /* Merge every vertex into the median, then compact: a single vertex and no
     triangles survive, which is the honest result of collapsing a mesh. */
  exp.fe_edit_set_mode(0);
  exp.fe_edit_select_all();
  exp.fe_edit_undo_push();
  exp.fe_edit_merge_center();
  assert.equal(exp.fe_edit_vert_count(), 1);
  assert.equal(exp.fe_edit_tri_count(), 0);
  exp.fe_edit_undo();
  assert.equal(exp.fe_edit_tri_count(), 12);
});

test('render mesh splits normals only where the surface is sharp', () => {
  const exp = loadEngine();
  uploadCube(exp);
  exp.fe_edit_set_shade(1);
  exp.fe_edit_build_render();
  assert.equal(exp.fe_edit_render_vert_count(), 8);
  assert.equal(exp.fe_edit_render_idx_count(), 36);
  assert.equal(exp.fe_edit_render_split_count(), 0);

  const smoothPos = new Float32Array(exp.memory.buffer, exp.fe_edit_render_pos_ptr(), 8 * 3);
  for (let i = 0; i < smoothPos.length; i++) assert.ok(Number.isFinite(smoothPos[i]));

  exp.fe_edit_select_all();
  assert.equal(exp.fe_edit_mark_sharp(1), 18);
  exp.fe_edit_build_render();
  assert.ok(exp.fe_edit_render_vert_count() > 8, 'all-sharp cube still shares corner normals');
  assert.equal(exp.fe_edit_render_idx_count(), 36);
  const splitPos = new Float32Array(exp.memory.buffer, exp.fe_edit_render_pos_ptr(), exp.fe_edit_render_vert_count() * 3);
  for (let i = 0; i < splitPos.length; i++) assert.ok(Number.isFinite(splitPos[i]));
});

test('every Edit Mode command the sheet can fire exists in the bridge command table', () => {
  /* The UI is data-driven: a button whose id has no implementation is a dead
     control, so the table and the buttons are checked against each other. */
  const html = readFileSync('index.html', 'utf8');
  const bridge = readFileSync('edit-mode.js', 'utf8');
  const commands = new Set([...bridge.matchAll(/\{ id: '([a-z-]+)', cat: '/g)].map((m) => m[1]));
  assert.ok(commands.size >= 40, `only ${commands.size} commands found in the Edit Mode table`);
  for (const command of commands) {
    assert.ok(
      bridge.includes(`'${command}'`) || bridge.includes(`${command}:`),
      `command ${command} is declared without an implementation`
    );
  }
  /* The mode selector already lists Edit Mode; the sheet must be in the page. */
  assert.match(html, /\['edit','Edit Mode'\]/);
  assert.match(html, /id="edit-sheet"/);
  assert.match(html, /id="edit-category-bar"/);
  for (const cat of ['select', 'transform', 'mesh', 'normals']) {
    assert.ok(html.includes(`data-edit-category="${cat}"`), `the ${cat} category button is missing`);
  }
});

/* ---- the bridge ---------------------------------------------------------- */

const KERNEL_FOR_TOOL = {
  pick: 'fe_edit_pick',
  box: 'fe_edit_select_box',
  circle: 'fe_edit_select_circle',
  all: 'fe_edit_select_all',
  none: 'fe_edit_select_none',
  invert: 'fe_edit_select_invert',
  linked: 'fe_edit_select_linked',
  more: 'fe_edit_select_more',
  less: 'fe_edit_select_less',
  similar: 'fe_edit_select_similar',
  random: 'fe_edit_select_random',
  loop: 'fe_edit_select_loop',
  move: 'fe_edit_move',
  rotate: 'fe_edit_rotate',
  scale: 'fe_edit_scale',
  shrink: 'fe_edit_shrink_fatten',
  slide: 'fe_edit_slide',
  shear: 'fe_edit_shear',
  sphere: 'fe_edit_to_sphere',
  bend: 'fe_edit_bend',
  randomize: 'fe_edit_randomize',
  align: 'fe_edit_align',
  mirror: 'fe_edit_mirror',
  exact: 'fe_edit_move',
  extrude: 'fe_edit_extrude',
  inset: 'fe_edit_inset',
  subdivide: 'fe_edit_subdivide',
  bevel: 'fe_edit_bevel',
  poke: 'fe_edit_poke',
  duplicate: 'fe_edit_duplicate',
  split: 'fe_edit_split',
  fill: 'fe_edit_fill',
  bridge: 'fe_edit_bridge',
  merge: 'fe_edit_merge_center',
  weld: 'fe_edit_merge_distance',
  collapse: 'fe_edit_collapse',
  bisect: 'fe_edit_bisect',
  symmetrize: 'fe_edit_symmetrize',
  delete: 'fe_edit_delete',
  recalc: 'fe_edit_recalc_normals',
  flip: 'fe_edit_flip_normals',
  smooth: 'fe_edit_set_shade',
  flat: 'fe_edit_set_shade',
  sharp: 'fe_edit_mark_sharp',
  seam: 'fe_edit_mark_seam'
};

test('every Edit Mode tool is a real kernel call, and every icon exists', async () => {
  const vm = await import('node:vm');
  const context = {
    console,
    FE: { current: 'core' },
    document: {
      /* `loading` keeps FEIcons from hydrating a document that does not exist:
         this test only needs the icon table, not the DOM pass. */
      readyState: 'loading',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    addEventListener() {},
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    }
  };
  vm.createContext(context);
  vm.runInContext(readFileSync('fe-icons.js', 'utf8'), context);
  vm.runInContext(readFileSync('edit-mode.js', 'utf8'), context);
  const EditMode = context.FEEditMode;
  assert.ok(EditMode, 'edit-mode.js did not publish FEEditMode');

  const exp = loadEngine();
  const tools = EditMode.TOOLS;
  const implemented = new Set(EditMode.implemented());
  const gestures = new Set([...EditMode.gestures(), ...EditMode.taps()]);
  assert.ok(tools.length >= 40, `only ${tools.length} tools declared`);
  assert.equal(new Set(tools.map((tool) => tool.id)).size, tools.length, 'tool ids are unique');
  assert.equal(EditMode.CATEGORIES.length, 4, 'the bar has four categories');

  for (const tool of tools) {
    assert.ok(tool.label && tool.icon, `${tool.id} needs a label and an icon`);
    assert.ok(context.FEIcons.names.includes(tool.icon), `${tool.id} uses the unknown icon ${tool.icon}`);
    assert.ok(KERNEL_FOR_TOOL[tool.id], `${tool.id} has no kernel entry point mapped`);
    assert.equal(typeof exp[KERNEL_FOR_TOOL[tool.id]], 'function', `${tool.id} calls missing ${KERNEL_FOR_TOOL[tool.id]}`);
    if (!gestures.has(tool.id)) {
      assert.ok(implemented.has(tool.id), `${tool.id} has no command implementation`);
    }
  }

  /* The gesture tools are the ones that own a one-finger drag; nothing else may
     silently swallow the gesture that orbits the viewport. */
  for (const id of gestures) assert.ok(tools.some((tool) => tool.id === id), `${id} is a gesture for an unknown tool`);
  /* The default tool must not swallow the drag that orbits the viewport. */
  assert.ok(!EditMode.gestures().includes('pick'), 'Select must not capture the one-finger drag');

  /* Static markup: the bar and the sheet must exist before the script runs. */
  const html = readFileSync('index.html', 'utf8');
  assert.ok(html.includes('id="edit-category-bar"'), 'the category bar is missing');
  assert.ok(html.includes('id="edit-sheet"'), 'the sub-toolbar sheet is missing');
  for (const id of EditMode.CATEGORIES.map((cat) => cat.id)) {
    assert.ok(html.includes(`data-edit-category="${id}"`), `the ${id} category button is missing`);
  }
  for (const mode of ['vertex', 'edge', 'face']) {
    assert.ok(html.includes(`data-edit-mode="${mode}"`), `the ${mode} selection button is missing`);
  }
});

/* ---- what the viewport actually hands over ------------------------------- */

/* three.js gives a cube 24 vertices: four per face, so each face can carry its
   own normal. A modeller thinks of that as eight points and twelve edges, and
   so must the editor, or every quad grows a diagonal and every corner looks
   torn. This is the exact input `upload()` builds from the viewport. */
const SPLIT_CUBE_FACES = [
  { n: [0, 0, 1], quad: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], quad: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { n: [1, 0, 0], quad: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], quad: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], quad: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], quad: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] }
];

function makeSplitCube() {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const face of SPLIT_CUBE_FACES) {
    const base = positions.length / 3;
    for (const v of face.quad) {
      positions.push(v[0], v[1], v[2]);
      normals.push(face.n[0], face.n[1], face.n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices)
  };
}

test('a viewport cube uploads as eight welded points, not twenty-four', () => {
  const exp = loadEngine();
  const mesh = makeSplitCube();
  assert.equal(mesh.positions.length / 3, 24, 'the fixture must be a split cube');

  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(mesh.positions.byteLength);
  const triPtr = exp.fe_malloc(mesh.indices.byteLength);
  const nrmPtr = exp.fe_malloc(mesh.normals.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, mesh.positions.length).set(mesh.positions);
  new Uint32Array(exp.memory.buffer, triPtr, mesh.indices.length).set(mesh.indices);
  new Float32Array(exp.memory.buffer, nrmPtr, mesh.normals.length).set(mesh.normals);

  /* Faceted: the six faces carry six different normals, so the editor must go
     on shading the cube flat instead of rounding it. */
  assert.equal(exp.fe_edit_detect_smooth(posPtr, nrmPtr, 24), 0);
  assert.equal(exp.fe_edit_upload(24, posPtr, 12, triPtr, 0), 1);
  exp.fe_arena_reset();

  assert.equal(exp.fe_edit_vert_count(), 8, 'the split corners were not welded');
  assert.equal(exp.fe_edit_tri_count(), 12);
  assert.equal(exp.fe_edit_edge_count(), 18);
  assert.equal(exp.fe_edit_weld_count(), 16, 'sixteen of the twenty-four corners are duplicates');

  /* Only the twelve edges of the cube are drawn: the six quad diagonals are
     not edges of the surface. */
  const ne = exp.fe_edit_edge_count();
  const shown = new Uint8Array(exp.memory.buffer, exp.fe_edit_edge_display_ptr(), ne);
  let drawn = 0;
  for (let e = 0; e < ne; e++) drawn += shown[e] ? 1 : 0;
  assert.equal(drawn, 12, 'a cube draws twelve edges, not eighteen');

  assert.equal(exp.fe_edit_get_shade(), 1, 'upload leaves the shading at smooth until the bridge decides');
  exp.fe_edit_set_shade(0);
  assert.equal(exp.fe_edit_get_shade(), 0);

  /* The same mesh, authored smooth: one shared normal per corner. Detect must
     answer before the weld, because afterwards there is nothing to compare. */
  const smooth = new Float32Array(mesh.normals.length);
  for (let v = 0; v < 24; v++) {
    const l = Math.hypot(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]) || 1;
    smooth[v * 3] = mesh.positions[v * 3] / l;
    smooth[v * 3 + 1] = mesh.positions[v * 3 + 1] / l;
    smooth[v * 3 + 2] = mesh.positions[v * 3 + 2] / l;
  }
  exp.fe_arena_reset();
  const p2 = exp.fe_malloc(smooth.byteLength);
  const n2 = exp.fe_malloc(smooth.byteLength);
  new Float32Array(exp.memory.buffer, p2, smooth.length).set(positionsOf(mesh));
  new Float32Array(exp.memory.buffer, n2, smooth.length).set(smooth);
  assert.equal(exp.fe_edit_detect_smooth(p2, n2, 24), 1);
  exp.fe_arena_reset();
});

function positionsOf(mesh) { return mesh.positions; }

test('the gizmo turns a finger drag into a kernel move, in one axis', () => {
  const exp = loadEngine();
  const mesh = makeSplitCube();
  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(mesh.positions.byteLength);
  const triPtr = exp.fe_malloc(mesh.indices.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, mesh.positions.length).set(mesh.positions);
  new Uint32Array(exp.memory.buffer, triPtr, mesh.indices.length).set(mesh.indices);
  exp.fe_edit_upload(24, posPtr, 12, triPtr, 0);
  exp.fe_arena_reset();
  exp.fe_edit_select_all();

  /* A projection with a distinct screen direction per axis, column-major. */
  const clip = new Float32Array([
    0.4, 0, 0, 0,
    0, 0.4, 0, 0,
    0.2, 0.2, 0, 0,
    0, 0, 0, 1
  ]);
  const clipPtr = exp.fe_malloc(clip.byteLength);
  new Float32Array(exp.memory.buffer, clipPtr, 16).set(clip);

  const pivotPtr = exp.fe_malloc(12);
  assert.equal(exp.fe_edit_gizmo_pivot(pivotPtr), 8);
  const pivot = Array.from(new Float32Array(exp.memory.buffer, pivotPtr, 3));
  pivot.forEach((value) => assert.ok(Math.abs(value) < 1e-6, 'the cube pivot is its centre'));

  const size = exp.fe_edit_gizmo_size(clipPtr);
  assert.ok(size > 0, 'the gizmo needs an on-screen size');

  /* Where the X arrow's midpoint lands, using the same projection the kernel
     uses. Fingers cannot hit a mathematical line, so the pick radius is a
     share of the viewport, not a share of the model. */
  const project = (x, y, z) => {
    const e = clip;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return [((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5,
      1 - (((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5)];
  };
  const [px, py] = project(0, 0, 0);
  const [tx, ty] = project(size, 0, 0);
  const mx = (px + tx) / 2;
  const my = (py + ty) / 2;

  assert.equal(exp.fe_edit_gizmo_pick(clipPtr, mx, my, 1, 0.06, 0), 0);
  assert.equal(exp.fe_edit_gizmo_pick(clipPtr, 0.02, 0.98, 1, 0.06, 0), -1);

  exp.fe_edit_undo_push();
  assert.equal(exp.fe_edit_gizmo_begin(clipPtr, mx, my, 1, 0.06, 0), 0);
  const outPtr = exp.fe_malloc(12);
  assert.equal(exp.fe_edit_gizmo_drag(clipPtr, px + (tx - px) * 0.75, py + (ty - py) * 0.75, 1, outPtr), 0);
  const out = Array.from(new Float32Array(exp.memory.buffer, outPtr, 3));
  assert.ok(Math.abs(out[0] - size * 0.25) < 1e-3, `expected a quarter handle, got ${out[0]}`);

  /* Every corner moved by that amount in X and by nothing in Y or Z. */
  const nv = exp.fe_edit_vert_count();
  const positions = new Float32Array(exp.memory.buffer, exp.fe_edit_pos_interleaved_ptr(), nv * 3);
  for (let v = 0; v < nv; v++) {
    /* The whole cube slid along X: the corners that were at -1 are now at
       -1 + step, the ones at +1 are at 1 + step, and nothing else moved. */
    assert.ok(Math.abs(Math.abs(positions[v * 3] - out[0]) - 1) < 1e-3,
      `corner ${v} must be one unit either side of the old face, shifted by the drag`);
    assert.ok(Math.abs(Math.abs(positions[v * 3 + 1]) - 1) < 1e-6, 'Y must not move');
    assert.ok(Math.abs(Math.abs(positions[v * 3 + 2]) - 1) < 1e-6, 'Z must not move');
  }
  exp.fe_edit_gizmo_end();
  assert.equal(exp.fe_edit_gizmo_active(), -1);
  /* One snapshot for the whole drag: undo returns the cube to where it was. */
  exp.fe_edit_undo();
  assertIntegrity(exp, 'gizmo drag');
  exp.fe_arena_reset();
});
