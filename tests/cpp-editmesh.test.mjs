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
  const ok = exp.fe_edit_upload(8, posPtr, 12, triPtr, 0, 0);
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
    'fe_edit_build_render', 'fe_edit_build_render_split', 'fe_edit_upload_face_shade',
    'fe_edit_shade_state', 'fe_edit_face_shade_ptr', 'fe_edit_face_shade_count',
    'fe_edit_render_pos_ptr', 'fe_edit_render_nrm_ptr',
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
  assert.equal(exp.fe_edit_upload(exp.fe_edit_max_verts() + 1, posPtr, 1, triPtr, 0, 0), 0);
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
  /* Faces are quads: a cube's twelve triangles are the six sides it has, and a
     face is selected only when all of its corners are. */
  assert.equal(exp.fe_edit_sel_count(), 6);

  exp.fe_edit_select_none();
  exp.fe_edit_set_mode(0);
  assert.equal(exp.fe_edit_sel_count(), 0);
  exp.fe_edit_select_invert();
  assert.equal(exp.fe_edit_sel_count(), 8);

  /* A tap in the middle of the screen has to hit the front of the cube. The
     front and the back of an axis-aligned cube land on the same pixels, so the
     only thing that separates them is the depth buffer: the answer has to be
     one of the front face's two triangles (2 and 3), never the back (0 and 1). */
  const clip = new Float32Array(16);
  clip[0] = 0.5; clip[5] = 0.5; clip[10] = -0.5; clip[15] = 1;
  const pickWith = (matrix, x, y) => {
    exp.fe_arena_reset();
    const ptr = exp.fe_malloc(64);
    new Float32Array(exp.memory.buffer, ptr, 16).set(matrix);
    const value = exp.fe_edit_pick(ptr, x, y);
    exp.fe_arena_reset();
    return value;
  };
  exp.fe_edit_set_mode(2);
  const faceHit = pickWith(clip, 0.5, 0.5);
  assert.ok(faceHit === 2 || faceHit === 3, `tap at the centre of the cube returned triangle ${faceHit}`);

  /* In vertex mode the middle of a face is nowhere near a corner, and the pick
     says so instead of taking the nearest stray point - the old kernel ran the
     vertex pass in every mode and a tap on empty space selected the closest
     corner of the mesh. */
  exp.fe_edit_set_mode(0);
  assert.equal(pickWith(clip, 0.5, 0.5), -1, 'a tap in the middle of a face is not a tap on a point');

  /* Turn the camera and every corner gets its own pixel, so the tap has to come
     back with the corner it is actually on. The far corner 1 is hidden behind
     the body and has to be refused; the four front corners (4-7) are always in
     front and must all answer for themselves. */
  const turned = new Float32Array(16);
  {
    const ay = 0.44, ax = 0.31;
    const cyv = Math.cos(ay), syv = Math.sin(ay), cxv = Math.cos(ax), sxv = Math.sin(ax);
    const R = [
      [cyv, 0, syv],
      [sxv * syv, cxv, -sxv * cyv],
      [-cxv * syv, sxv, cxv * cyv]
    ];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) turned[col * 4 + row] = 0.5 * R[row][col];
    }
    turned[10] = -0.6; turned[15] = 1;
  }
  const projectBy = (matrix, v) => {
    const x = CUBE_VERTS[v * 3], y = CUBE_VERTS[v * 3 + 1], z = CUBE_VERTS[v * 3 + 2];
    const px = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const py = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    return [px * 0.5 + 0.5, 1 - (py * 0.5 + 0.5)];
  };
  for (let v = 0; v < 8; v++) {
    const [px, py] = projectBy(turned, v);
    const picked = pickWith(turned, px, py);
    if (v === 1) assert.equal(picked, -1, 'the corner hidden behind the body was picked');
    else if (v >= 4) assert.equal(picked, v, `a tap on visible corner ${v} answered with ${picked}`);
    else assert.ok(picked === v || picked === -1, `a tap on corner ${v} answered with ${picked}`);
  }
  exp.fe_edit_set_mode(0);

  /* Box select over the whole screen grabs every vertex. */
  exp.fe_edit_select_none();
  exp.fe_arena_reset();
  const boxPtr = exp.fe_malloc(64);
  new Float32Array(exp.memory.buffer, boxPtr, 16).set(clip);
  const boxed = exp.fe_edit_select_box(boxPtr, 0, 0, 1, 1, 0, 1);
  exp.fe_arena_reset();
  assert.equal(boxed, 8, 'a full-screen box did not select the cube');
});

/* The three modes are what decides a pick. Edges and faces are derived from
   the vertex flags inside the kernel (an edge is selected when both of its
   endpoints are), so the test asks the question that actually separates them:
   does the same rectangle take a corner's point in vertex mode and nothing at
   all in edge and face mode, where an element has to be *entirely* inside. */
test('a selection takes only the kind of element the mode asks for', () => {
  const exp = loadEngine();
  /* A turned camera, not the axis-aligned one: straight on, the front and back
     corners of the cube land on the same pixel and a corner rectangle cannot
     tell them apart. */
  const clip = new Float32Array(16);
  {
    const ay = 0.44, ax = 0.31;
    const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
    /* R = Rx * Ry, column-major, scaled to NDC and with a depth column. */
    const R = [
      [cy, 0, sy],
      [sx * sy, cx, -sx * cy],
      [-cx * sy, sx, cx * cy]
    ];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) clip[col * 4 + row] = 0.5 * R[row][col];
    }
    clip[10] = -0.6; clip[15] = 1;
  }
  const project = (x, y, z) => {
    const px = clip[0] * x + clip[4] * y + clip[8] * z + clip[12];
    const py = clip[1] * x + clip[5] * y + clip[9] * z + clip[13];
    return [(px * 0.5 + 0.5), 1 - (py * 0.5 + 0.5)];
  };
  const withClip = (fn) => {
    exp.fe_arena_reset();
    const ptr = exp.fe_malloc(64);
    new Float32Array(exp.memory.buffer, ptr, 16).set(clip);
    const value = fn(ptr);
    exp.fe_arena_reset();
    return value;
  };
  const box = (x0, y0, x1, y1) => withClip((ptr) => exp.fe_edit_select_box(ptr, x0, y0, x1, y1, 0, 1));
  /* The pick only *finds* the element under the finger; the bridge then hands
     that index back to the kernel, which is the step that selects it. */
  const tap = (x = 0.5, y = 0.5) => {
    const index = withClip((ptr) => exp.fe_edit_pick(ptr, x, y));
    if (index < 0) return index;
    exp.fe_arena_reset();
    const out = exp.fe_malloc(4);
    new Uint32Array(exp.memory.buffer, out, 1)[0] = index;
    exp.fe_edit_select_by_index(exp.fe_edit_get_mode(), 1, out, 0);
    exp.fe_arena_reset();
    return index;
  };
  const flagged = (ptr, count) => {
    const view = new Uint8Array(exp.memory.buffer, ptr, count);
    let set = 0;
    for (const flag of view) if (flag) set++;
    return set;
  };
  /* A thumb-sized rectangle around one corner, built from where that corner
     actually lands on screen. No other corner is anywhere near it. */
  const [cx0, cy0] = project(CUBE_VERTS[0], CUBE_VERTS[1], CUBE_VERTS[2]);
  for (let v = 1; v < 8; v++) {
    const [qx, qy] = project(CUBE_VERTS[v * 3], CUBE_VERTS[v * 3 + 1], CUBE_VERTS[v * 3 + 2]);
    assert.ok(Math.hypot(qx - cx0, qy - cy0) > 0.06, `corner ${v} projects onto corner 0`);
  }
  const corner = [cx0 - 0.02, cy0 - 0.02, cx0 + 0.02, cy0 + 0.02];

  uploadCube(exp);
  exp.fe_edit_set_mode(0);
  assert.equal(box(...corner), 1, 'vertex mode must take the point inside the rectangle');
  exp.fe_edit_set_mode(1);
  assert.equal(box(...corner), 0, 'edge mode must not take an edge it only half covers');
  exp.fe_edit_set_mode(2);
  assert.equal(box(...corner), 0, 'face mode must not take a face it only partly covers');

  /* The whole screen takes everything of the mode's own kind. The rectangle
     returns how many *points* ended up selected - an edge and a face are made
     of points - so the count that describes the mode's own kind is asked for
     separately. */
  uploadCube(exp);
  exp.fe_edit_set_mode(0);
  assert.equal(box(0, 0, 1, 1), 8, 'vertex mode must take the eight points');
  assert.equal(exp.fe_edit_sel_count(), 8, 'and count them as points');
  uploadCube(exp);
  exp.fe_edit_set_mode(1);
  box(0, 0, 1, 1);
  assert.equal(exp.fe_edit_sel_count(), 18, 'edge mode must take the eighteen edges');
  assert.equal(flagged(exp.fe_edit_face_sel_ptr(), exp.fe_edit_tri_count()), 12, 'and their twelve faces follow');
  uploadCube(exp);
  exp.fe_edit_set_mode(2);
  box(0, 0, 1, 1);
  /* Six faces, not twelve triangles: a cube's quads are paired by the kernel. */
  assert.equal(exp.fe_edit_sel_count(), 6, 'face mode must take the six faces');

  /* A tap answers the same way: one point, or the two ends of one edge, or the
     three corners of one face. It is aimed at a corner, because a tap in the
     middle of a face is not near a point in vertex mode. */
  uploadCube(exp);
  exp.fe_edit_set_mode(0);
  exp.fe_edit_select_none();
  assert.ok(tap(cx0, cy0) >= 0, 'a tap on a corner found no point');
  assert.equal(flagged(exp.fe_edit_vert_sel_ptr(), exp.fe_edit_vert_count()), 1, 'vertex mode taps one point');
  assert.equal(flagged(exp.fe_edit_face_sel_ptr(), exp.fe_edit_tri_count()), 0, 'vertex mode touches no face');

  uploadCube(exp);
  exp.fe_edit_set_mode(1);
  assert.ok(tap(cx0, cy0) >= 0, 'a tap on a corner found no edge');
  assert.equal(flagged(exp.fe_edit_edge_sel_ptr(), exp.fe_edit_edge_count()), 1, 'edge mode taps one edge');
  assert.equal(flagged(exp.fe_edit_vert_sel_ptr(), exp.fe_edit_vert_count()), 2, 'and takes exactly its two ends');

  uploadCube(exp);
  exp.fe_edit_set_mode(2);
  const picked = tap(cx0, cy0);
  assert.ok(picked >= 0 && picked < 12, `a tap on a corner found no face, got ${picked}`);
  /* A face is a quad here, so taking it flags both of its triangles and all
     four of its corners, and still counts as one face. */
  assert.equal(flagged(exp.fe_edit_face_sel_ptr(), exp.fe_edit_tri_count()), 2, 'face mode taps one face');
  assert.equal(exp.fe_edit_sel_count(), 1, 'the pair of triangles is one face');
  assert.equal(flagged(exp.fe_edit_vert_sel_ptr(), exp.fe_edit_vert_count()), 4, 'and takes exactly its four corners');
});

/* Smooth shading is geometry, not a flag the renderer may or may not honour:
   one normal per corner of a cube, leaning equally on all three of its faces.
   Area weighting leaves the quad that owns the corner counting twice, which is
   the lopsided surface a user reads as "smooth does not work". */
test('smooth shading emits one symmetric normal per corner', () => {
  const exp = loadEngine();
  uploadCube(exp);
  exp.fe_edit_set_shade(1);
  assert.equal(exp.fe_edit_get_shade(), 1);
  const verts = exp.fe_edit_build_render();
  assert.equal(verts, 8, 'a cube with no sharp edges keeps its eight corners');
  const normals = new Float32Array(exp.memory.buffer, exp.fe_edit_render_nrm_ptr(), verts * 3);
  const near = (a, b) => Math.abs(a - b) < 2e-3;
  for (let i = 0; i < verts; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    assert.ok(near(Math.hypot(nx, ny, nz), 1), `normal ${i} is not a unit vector`);
    assert.ok(near(Math.abs(nx), 0.5773503), `normal ${i} leans on x less than on the other axes`);
    assert.ok(near(Math.abs(ny), 0.5773503), `normal ${i} leans on y less than on the other axes`);
    assert.ok(near(Math.abs(nz), 0.5773503), `normal ${i} leans on z less than on the other axes`);
  }

  /* A sharp edge splits that corner back into two normals, so smooth and flat
     really are two different meshes and flat shading needs no flag. */
  exp.fe_edit_set_mode(1);
  exp.fe_edit_select_all();
  exp.fe_edit_mark_sharp(1);
  const split = exp.fe_edit_build_render();
  assert.ok(split > 8, `marking every edge sharp must split the corners, got ${split}`);

  exp.fe_edit_set_shade(0);
  assert.equal(exp.fe_edit_get_shade(), 0);
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
  assert.equal(exp.fe_edit_upload(24, posPtr, 12, triPtr, 0, nrmPtr), 1);
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

  /* Uploaded with its own normals, the cube arrives faceted: the kernel reads
     the six different face directions off the corners it is about to weld and
     keeps every face flat, instead of rounding a cube the user built to be
     sharp. */
  assert.equal(exp.fe_edit_get_shade(), 0, 'the per-face normals must arrive as flat faces');
  assert.equal(exp.fe_edit_shade_state(), 0, 'and every one of the twelve faces is flat');
  exp.fe_edit_set_shade(1);
  assert.equal(exp.fe_edit_get_shade(), 1);
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

/* The line across a face. A quad is two triangles in the buffer, and if each of
   them takes its own normal the render draws the diagonal - the crease the user
   keeps finding in the middle of a face that Blender, which stores quads, never
   shows. Shading is decided per face, so both halves carry one normal, and the
   wireframe is drawn from the face rings, so the diagonal is not an edge of the
   model at all. */
test('a bent face keeps one normal, and its diagonal is not a wireframe edge', () => {
  const exp = loadEngine();
  exp.fe_arena_reset();
  const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const faces = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const posPtr = exp.fe_malloc(quad.byteLength);
  const triPtr = exp.fe_malloc(faces.byteLength);
  const nrmPtr = exp.fe_malloc(normals.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, quad.length).set(quad);
  new Uint32Array(exp.memory.buffer, triPtr, faces.length).set(faces);
  new Float32Array(exp.memory.buffer, nrmPtr, normals.length).set(normals);
  assert.equal(exp.fe_edit_upload(4, posPtr, 2, triPtr, 0, nrmPtr), 1);
  exp.fe_arena_reset();

  /* One face, four corners: the two triangles are the two halves of a quad. */
  assert.equal(exp.fe_edit_face_count(), 1);
  assert.deepEqual(
    Array.from(new Uint32Array(exp.memory.buffer, exp.fe_edit_face_ring_ptr(), 4)),
    [0, 1, 2, 3],
    'the ring of the face is its four corners'
  );
  assert.equal(exp.fe_edit_flat_planar(), 0, 'nothing has been rendered yet');

  /* Bend it: lift one corner out of the plane the quad was drawn in. */
  exp.fe_arena_reset();
  const selPtr = exp.fe_malloc(4);
  new Uint32Array(exp.memory.buffer, selPtr, 1)[0] = 2;
  exp.fe_edit_select_by_index(0, 1, selPtr, 0);
  exp.fe_arena_reset();
  exp.fe_edit_move(0, 0, 0.6, 0);

  const verts = exp.fe_edit_build_render();
  assert.equal(verts, 4, 'a bent face still needs one vertex per corner, not per triangle');
  assert.equal(exp.fe_edit_flat_planar(), 0, 'a bent face cannot be shaded by derivative normals');
  const renderNormals = new Float32Array(exp.memory.buffer, exp.fe_edit_render_nrm_ptr(), verts * 3);
  for (let v = 1; v < verts; v++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(renderNormals[v * 3 + c] - renderNormals[c]) < 1e-5,
        `corner ${v} points a different way than corner 0, which is the diagonal showing`);
    }
  }
  assert.ok(Math.abs(Math.hypot(renderNormals[0], renderNormals[1], renderNormals[2]) - 1) < 1e-4, 'and it is a unit normal');

  /* The wireframe is the face boundary: four lines, and the diagonal the two
     triangles share is not one of them. */
  const starts = new Uint32Array(exp.memory.buffer, exp.fe_edit_face_start_ptr(), 2);
  const ring = new Uint32Array(exp.memory.buffer, exp.fe_edit_face_ring_ptr(), exp.fe_edit_face_ring_count());
  const drawn = new Set();
  for (let f = 0; f + 1 < starts.length; f++) {
    const n = starts[f + 1] - starts[f];
    for (let i = 0; i < n; i++) {
      const a = ring[starts[f] + i], b = ring[starts[f] + (i + 1) % n];
      drawn.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  }
  assert.deepEqual(Array.from(drawn).sort(), ['0:1', '0:3', '1:2', '2:3'], 'four edges around the quad, no 0:2 diagonal');
});

/* Blender keeps a flag per face. A face marked flat next to smooth neighbours
   needs two different normals at the same point, and two normals at one point
   is not a shared vertex - the kernel has to break the corners apart, and that
   split is what the viewport and every exporter after it can actually read. */
test('one face stays flat while the faces around it stay smooth', () => {
  const exp = loadEngine();
  const mesh = makeSplitCube();
  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(mesh.positions.byteLength);
  const triPtr = exp.fe_malloc(mesh.indices.byteLength);
  const nrmPtr = exp.fe_malloc(mesh.normals.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, mesh.positions.length).set(mesh.positions);
  new Uint32Array(exp.memory.buffer, triPtr, mesh.indices.length).set(mesh.indices);
  new Float32Array(exp.memory.buffer, nrmPtr, mesh.normals.length).set(mesh.normals);
  assert.equal(exp.fe_edit_upload(24, posPtr, 12, triPtr, 0, nrmPtr), 1);
  exp.fe_arena_reset();

  const faceCount = exp.fe_edit_face_shade_count();
  assert.equal(faceCount, 12, 'one flag per triangle');
  const flags = () => new Uint8Array(exp.memory.buffer, exp.fe_edit_face_shade_ptr(), faceCount);
  assert.equal(flags().reduce((a, b) => a + b, 0), 0, 'a faceted cube starts with every face flat');

  /* All flat is the one case the material still draws by itself: the indexed
     mesh comes back untouched, so a dense flat mesh never triples its corners. */
  assert.equal(exp.fe_edit_build_render(), 8, 'an all-flat cube keeps its shared vertices');

  /* Mark one face, in Face mode: the rest of the cube must not move. */
  exp.fe_edit_set_mode(2);
  exp.fe_arena_reset();
  const facePtr = exp.fe_malloc(4);
  new Uint32Array(exp.memory.buffer, facePtr, 1)[0] = 0;
  exp.fe_edit_select_by_index(2, 1, facePtr, 0);
  exp.fe_arena_reset();
  exp.fe_edit_set_shade(1);

  assert.equal(exp.fe_edit_shade_state(), 2, 'one smooth face in a flat cube is a mixed mesh');
  /* The flag is per triangle - it has to be, that is what the render pass
     reads - but the face the user picked is the quad, so both of its triangles
     follow the tap and the five quads around it do not. */
  assert.equal(flags().filter((v) => v).length, 2, 'exactly the selected quad went smooth');
  assert.equal(exp.fe_edit_get_shade(), 1, 'and the mesh now has smoothing somewhere');

  /* The render pass splits those corners, which is the only way one face can be
     flat and its neighbour smooth across a point they share. */
  const mixed = exp.fe_edit_build_render();
  assert.ok(mixed > 8, `a mixed mesh must break its flat corners apart, got ${mixed}`);
  assert.equal(exp.fe_edit_render_split_count(), mixed - 8, 'every extra vertex is a split corner');

  /* Leaving Edit Mode has to carry the shading out as geometry, so the same
     pass runs with the all-flat shortcut switched off. */
  assert.equal(exp.fe_edit_build_render_split(), mixed, 'the mixed mesh is already split');

  exp.fe_edit_set_mode(0);
  exp.fe_edit_select_all();
  exp.fe_edit_set_shade(0);
  assert.equal(exp.fe_edit_shade_state(), 0, 'shading the whole mesh flat is still one call');
  exp.fe_edit_select_none();
  assert.equal(exp.fe_edit_build_render(), 8, 'and the all-flat shortcut comes back');
  /* Forced, the cube splits where faces meet, not where triangles meet: eight
     corners, three faces on each, is twenty-four - one vertex per corner per
     face. Before the shading was resolved per face rather than per triangle it
     was thirty-six, because each triangle of a quad took its own copy. */
  assert.equal(exp.fe_edit_build_render_split(), 24, 'a corner gets one vertex per face it belongs to');

  /* Flags that were written down are restored as they are, not re-derived from
     normals: a cage has shared vertices and averaged normals, so deriving would
     forget that the cube was ever flat. */
  const restored = new Uint8Array(faceCount);
  restored[3] = 1;
  exp.fe_arena_reset();
  const flagPtr = exp.fe_malloc(faceCount);
  new Uint8Array(exp.memory.buffer, flagPtr, faceCount).set(restored);
  assert.equal(exp.fe_edit_upload_face_shade(flagPtr, faceCount), faceCount);
  exp.fe_arena_reset();
  assert.deepEqual(Array.from(flags()), Array.from(restored), 'the flags survived the round trip');
  assert.equal(exp.fe_edit_upload_face_shade(0, 0), 0, 'a missing buffer is refused, not guessed at');
});

/* ---------------------------------------------------------------------------
 * A triangle inside a face
 *
 * Two of them exist, and both are visible for the same reason: the kernel
 * decides something per triangle that belongs to the whole face.
 *
 *   1. shading - half of a quad flat and half of it smooth draws the diagonal,
 *      because the smooth half is interpolated and the flat half is not;
 *   2. topology - a face that a tool cut into triangles and could not pair
 *      back into a quad is drawn as the triangles it is stored as.
 *
 * These tests pin both, from the shipped artifact.
 * ------------------------------------------------------------------------- */

function cloneCubeWithMixedNormals() {
  const mesh = makeSplitCube();
  /* The first quad's two triangles are the first two: give the second one
     corner normals that lean away from the face. Its own vote comes out
     smooth while its partner's comes out flat - exactly the pair that used to
     draw a diagonal across a face whose two halves disagreed. */
  const normals = Float32Array.from(mesh.normals);
  const face = SPLIT_CUBE_FACES[0];
  /* Corners 1, 2 and 3 are the quad's second triangle (0,1,2 then 0,2,3).
     Push their normals square to the face: that half votes smooth while the
     first half keeps voting flat. */
  const tilted = [face.n[1] + face.n[2], face.n[2] + face.n[0], face.n[0] + face.n[1]];
  for (let k = 1; k <= 3; k++) {
    const at = k * 3;
    normals[at] = tilted[0];
    normals[at + 1] = tilted[1];
    normals[at + 2] = tilted[2];
  }
  return { ...mesh, normals };
}

test('a face is shaded as one face, whichever way its triangles round', () => {
  const exp = loadEngine();
  const mesh = cloneCubeWithMixedNormals();
  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(mesh.positions.byteLength);
  const triPtr = exp.fe_malloc(mesh.indices.byteLength);
  const nrmPtr = exp.fe_malloc(mesh.normals.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, mesh.positions.length).set(mesh.positions);
  new Uint32Array(exp.memory.buffer, triPtr, mesh.indices.length).set(mesh.indices);
  new Float32Array(exp.memory.buffer, nrmPtr, mesh.normals.length).set(mesh.normals);
  assert.equal(exp.fe_edit_upload(24, posPtr, 12, triPtr, 0, nrmPtr), 1);
  exp.fe_arena_reset();

  const count = exp.fe_edit_face_shade_count();
  assert.equal(count, 12, 'one flag per triangle');
  const flags = new Uint8Array(exp.memory.buffer, exp.fe_edit_face_shade_ptr(), count);
  assert.equal(flags[0], flags[1], 'the two triangles of one quad must agree about being flat');
  assert.equal(flags[2], flags[3], 'and so must the next quad');
  for (let quad = 0; quad < 6; quad++) {
    assert.equal(
      flags[quad * 2], flags[quad * 2 + 1],
      `quad ${quad} is half flat and half smooth, which is the triangle the user sees`
    );
  }

  /* The tie went smooth - a shape that really is flat votes flat with both
     halves - so that quad is a smooth face in a flat cube. */
  assert.equal(flags[0], 1, 'a quad whose halves disagree is smooth, not half smooth');
  assert.equal(flags[2], 0, 'the quad next to it is still flat');
  assert.equal(exp.fe_edit_shade_state(), 2, 'one smooth quad in a flat cube is a mixed mesh');
  const split = exp.fe_edit_build_render();
  assert.ok(split > 8, 'a mixed mesh splits its corners, and it starts at eight');
});

test('a fan of triangles that lie in one plane is one face, not thirty-three', () => {
  const exp = loadEngine();
  /* A thirty-two sided cap, triangulated the way a fan is: from corner zero.
     No app declared this one; it is the shape a tool leaves behind. */
  const segments = 32;
  const positions = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    positions[i * 3] = Math.cos(angle);
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(angle);
  }
  const triangles = [];
  for (let i = 1; i + 1 < segments; i++) triangles.push(0, i, i + 1);
  const indices = new Uint32Array(triangles);

  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(positions.byteLength);
  const triPtr = exp.fe_malloc(indices.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, positions.length).set(positions);
  new Uint32Array(exp.memory.buffer, triPtr, indices.length).set(indices);
  assert.equal(exp.fe_edit_upload(segments, posPtr, triangles.length / 3, triPtr, 0, 0), 1);
  exp.fe_arena_reset();

  assert.equal(exp.fe_edit_tri_count(), 30, 'the fan is thirty triangles');
  assert.equal(exp.fe_edit_face_count(), 1, 'one flat panel is one face');
  assert.equal(exp.fe_edit_face_ring_count(), segments, 'and it carries the ring of the polygon');
  assert.equal(exp.fe_edit_ngon_count(), 1, 'a thirty-two sided face is an n-gon');
});

test('a poke keeps its fan: a triangle the user asked for stays a face', () => {
  const exp = loadEngine();
  uploadCube(exp);
  exp.fe_edit_set_mode(2);
  exp.fe_arena_reset();
  const facePtr = exp.fe_malloc(4);
  new Uint32Array(exp.memory.buffer, facePtr, 1)[0] = 0;
  exp.fe_edit_select_by_index(2, 1, facePtr, 0);
  exp.fe_arena_reset();

  exp.fe_edit_poke();
  exp.fe_arena_reset();
  /* One centre for the whole face, not one per triangle: a quad poked becomes
     four triangles round a single point, the way Blender's poke does, instead
     of six round two points with the quad's own diagonal still drawn through
     the middle of the face. The other five quads are untouched. */
  assert.equal(exp.fe_edit_tri_count(), 12 - 2 + 4, 'the quad became four triangles');
  assert.equal(exp.fe_edit_face_count(), 5 + 4, 'five quads plus four triangle faces');

  const faces = exp.fe_edit_face_count();
  const starts = new Uint32Array(exp.memory.buffer, exp.fe_edit_face_start_ptr(), faces + 1).slice();
  let triangles = 0;
  for (let f = 0; f < faces; f++) if (starts[f + 1] - starts[f] === 3) triangles++;
  assert.equal(triangles, 4, 'the fan is four triangle faces, not one fused polygon');
});

test('the gizmo turns a finger drag into a kernel move, in one axis', () => {
  const exp = loadEngine();
  const mesh = makeSplitCube();
  exp.fe_arena_reset();
  const posPtr = exp.fe_malloc(mesh.positions.byteLength);
  const triPtr = exp.fe_malloc(mesh.indices.byteLength);
  new Float32Array(exp.memory.buffer, posPtr, mesh.positions.length).set(mesh.positions);
  new Uint32Array(exp.memory.buffer, triPtr, mesh.indices.length).set(mesh.indices);
  exp.fe_edit_upload(24, posPtr, 12, triPtr, 0, 0);
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

/* ---- written-down faces --------------------------------------------------
 * A face used to be guessed from the shape: two triangles that share their
 * longest side and are nearly coplanar are one quad. That guess fails the
 * moment an edit bends the quad - the diagonal came back and the user saw a
 * line running through the middle of a face they had not split.
 *
 * Now each triangle carries the id of the face it belongs to (fe_edit_tri_tag_*),
 * written by whatever made the geometry and kept through every edit. These
 * tests pin that: the ids travel with the triangles, a tool says what it built,
 * and no deformation can turn six sides into twelve triangles.
 */

function faceSizes(exp) {
  const faces = exp.fe_edit_face_count();
  const starts = new Uint32Array(exp.memory.buffer, exp.fe_edit_face_start_ptr(), faces + 1).slice();
  const sizes = [];
  for (let f = 0; f < faces; f++) sizes.push(starts[f + 1] - starts[f]);
  return sizes;
}

function triTags(exp) {
  const count = exp.fe_edit_tri_tag_count();
  assert.equal(count, exp.fe_edit_tri_count(), 'every triangle has a tag slot');
  return Array.from(new Uint32Array(exp.memory.buffer, exp.fe_edit_tri_tag_ptr(), count));
}

function tagHistogram(tags) {
  const counts = new Map();
  for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  return counts;
}

function selectFaceByIndex(exp, index) {
  exp.fe_edit_set_mode(2);
  exp.fe_edit_select_none();
  exp.fe_arena_reset();
  const ptr = exp.fe_malloc(4);
  new Uint32Array(exp.memory.buffer, ptr, 1)[0] = index;
  exp.fe_edit_select_by_index(2, 1, ptr, 0);
  exp.fe_arena_reset();
}

test('every triangle of the cube carries the id of its face', () => {
  const exp = loadEngine();
  uploadCube(exp);
  const tags = triTags(exp);
  assert.equal(new Set(tags).size, 6, 'six sides, six ids');
  for (const [tag, count] of tagHistogram(tags)) {
    assert.equal(count, 2, `face id ${tag} must cover both triangles of its quad`);
  }
});

test('a corner dragged out of the cube leaves six four-corner faces', () => {
  const exp = loadEngine();
  uploadCube(exp);
  /* Every position-coincident slot of the corner has to move, or the box tears:
     the upload welds, so one index per corner is enough here, but drag it far
     enough to bend all three faces that share it. */
  exp.fe_edit_set_mode(0);
  exp.fe_edit_select_none();
  exp.fe_arena_reset();
  const ptr = exp.fe_malloc(4);
  new Uint32Array(exp.memory.buffer, ptr, 1)[0] = 6;   /* the (+1,+1,+1) corner */
  exp.fe_edit_select_by_index(0, 1, ptr, 0);
  exp.fe_arena_reset();
  assert.equal(exp.fe_edit_move(2.2, 1.4, 1.6, 0), 1);

  assert.deepEqual(faceSizes(exp), [4, 4, 4, 4, 4, 4], 'a bent cube is still six quads');
  const tags = triTags(exp);
  assert.equal(new Set(tags).size, 6, 'the ids are the same six faces as before the drag');
  for (const [, count] of tagHistogram(tags)) assert.equal(count, 2);

  /* The cage wireframe draws the faces, not the triangles: only the twelve edges
     of the box are shown, never a face's internal diagonal. */
  const edges = exp.fe_edit_edge_count();
  const shown = new Uint8Array(exp.memory.buffer, exp.fe_edit_edge_display_ptr(), edges);
  let drawn = 0;
  for (let e = 0; e < edges; e++) drawn += shown[e] ? 1 : 0;
  assert.equal(drawn, 12, 'a cube has twelve sides, and not one of the six face diagonals is drawn');
});

test('a rim wall that a tool builds is one face, not two triangles', () => {
  const exp = loadEngine();
  uploadCube(exp);
  selectFaceByIndex(exp, 0);
  assert.equal(exp.fe_edit_inset(0.2, 0), 8, 'four rim walls of two triangles each');
  exp.fe_arena_reset();
  /* Five untouched sides, the inset face, and four walls - ten faces, and every
     one of them four corners: a wall is a quad however it was triangulated. */
  assert.equal(exp.fe_edit_face_count(), 10);
  assert.deepEqual(faceSizes(exp), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  for (const [tag, count] of tagHistogram(triTags(exp))) {
    assert.equal(count, 2, `face id ${tag} must be one quad, not a triangle`);
  }
});

test('extruding a whole face keeps the walls as quads', () => {
  const exp = loadEngine();
  uploadCube(exp);
  selectFaceByIndex(exp, 2);
  assert.equal(exp.fe_edit_extrude(0.4, 0), 8);
  exp.fe_arena_reset();
  assert.equal(exp.fe_edit_face_count(), 10);
  assert.deepEqual(faceSizes(exp), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
});

test('a poke puts one centre in a face, so the quad keeps no diagonal', () => {
  const exp = loadEngine();
  uploadCube(exp);
  selectFaceByIndex(exp, 0);
  exp.fe_edit_poke();
  exp.fe_arena_reset();
  /* Four triangles round one point, plus the five sides that were not poked. */
  assert.equal(exp.fe_edit_face_count(), 9);
  const sizes = faceSizes(exp);
  assert.equal(sizes.filter((n) => n === 3).length, 4, 'the fan is four triangles');
  assert.equal(sizes.filter((n) => n === 4).length, 5, 'the other five sides are untouched quads');
});

test('a subdivide cuts faces into faces, not into one hidden ring', () => {
  const exp = loadEngine();
  uploadCube(exp);
  exp.fe_edit_set_mode(2);
  exp.fe_edit_select_all();
  exp.fe_edit_subdivide(0, 0);
  exp.fe_arena_reset();
  assert.equal(exp.fe_edit_face_count(), 24, 'six sides cut into four each');
  assert.deepEqual(new Set(faceSizes(exp)), new Set([4]), 'every piece is a quad');
});

test('the ids survive the deformation tools and the undo stack', () => {
  const exp = loadEngine();
  uploadCube(exp);
  exp.fe_edit_set_mode(2);
  exp.fe_edit_select_all();
  const before = faceSizes(exp);
  exp.fe_edit_bend(35, 0);
  exp.fe_edit_to_sphere(1);
  exp.fe_edit_randomize(0.2, 11);
  exp.fe_arena_reset();
  assert.deepEqual(faceSizes(exp), before, 'bend, to-sphere and randomize cannot split a face');
  exp.fe_edit_undo();
  exp.fe_edit_undo();
  exp.fe_edit_undo();
  exp.fe_arena_reset();
  assert.deepEqual(faceSizes(exp), before, 'and undo puts the same faces back');
});

test('a mesh re-uploaded with the same triangle table does not inherit the old faces', () => {
  const exp = loadEngine();
  uploadCube(exp);
  selectFaceByIndex(exp, 0);
  exp.fe_edit_inset(0.2, 0);
  exp.fe_arena_reset();
  /* A fresh upload is a fresh mesh: the ids of the *previous* mesh must not
     claim triangles of this one, even though the first twelve triangles are the
     same size and in the same order. */
  uploadCube(exp);
  assert.equal(exp.fe_edit_face_count(), 6);
  assert.deepEqual(faceSizes(exp), [4, 4, 4, 4, 4, 4]);
  const fresh = triTags(exp);
  assert.equal(new Set(fresh).size, 6, 'six ids for six sides - the reset did not hand over the old ones');
  for (const [, count] of tagHistogram(fresh)) assert.equal(count, 2);
});
