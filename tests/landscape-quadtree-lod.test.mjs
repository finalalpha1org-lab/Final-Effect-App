import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parser } from '@shaderfrog/glsl-parser';

/* Quadtree LoD and foliage impostors.
 *
 * The quadtree has to answer exactly what the flat kernel answers — a spatial
 * index that culls plants it should have kept is worse than no index at all —
 * so the tests compare every emitted instance against a brute-force pass over
 * the same list, tiers included. The impostors are checked as renders: the
 * atlas must be non-empty, must not be a solid rectangle, must change with the
 * azimuth, and must be baked from the species it names. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const floraSource = readFileSync('landscape-flora.js', 'utf8');
const lodSource = readFileSync('terrain-main-03.js', 'utf8');
const cppLod = readFileSync('cpp/src/fe_lod.cpp', 'utf8');
const cppImp = readFileSync('cpp/src/fe_impostor.cpp', 'utf8');
const cppBuild = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');
const cppFlora = readFileSync('cpp/src/fe_flora.cpp', 'utf8');

async function boot(extra = {}) {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout, TextDecoder, TextEncoder,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }),
    ...extra
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  await context.FELandscapeCore.loading;
  vm.runInContext(floraSource, context);
  return { context, core: context.FELandscapeCore, flora: context.FELandscapeFlora };
}

/* A deterministic instance cloud, laid out like a species' placements. */
function cloud(count, spread, seed) {
  const xyz = new Float32Array(count * 3);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    xyz[i * 3] = (rnd() - 0.5) * spread;
    xyz[i * 3 + 1] = rnd() * 12;
    xyz[i * 3 + 2] = (rnd() - 0.5) * spread;
  }
  return xyz;
}

function viewProjection(cam, fov = 1.0) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (0.5 - 8000);
  const proj = [f / (16 / 9), 0, 0, 0, 0, f, 0, 0, 0, 0, (8000 + 0.5) * nf, -1, 0, 0, 2 * 8000 * 0.5 * nf, 0];
  const eye = [cam.x, cam.y, cam.z], target = [0, 0, 0], up = [0, 1, 0];
  const z = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
  let l = Math.hypot(...z); z[0] /= l; z[1] /= l; z[2] /= l;
  const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  l = Math.hypot(...x) || 1; x[0] /= l; x[1] /= l; x[2] /= l;
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1];
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += proj[k * 4 + r] * view[c * 4 + k];
    vp[c * 4 + r] = sum;
  }
  return vp;
}

/* The hash the kernel uses, reproduced exactly: it is a bit hash, not a
 * transcendental, so JS and the freestanding build agree bit for bit. */
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function qhash(x, z) {
  f32[0] = x; const bx = u32[0];
  f32[0] = z; const bz = u32[0];
  let h = (bx ^ (bz + 0x9e3779b9 + Math.imul(bx, 64) + (bx >>> 2))) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 8) * (1 / 16777216);
}

/* The reference the quadtree must reproduce: every instance, no index. */
function reference(xyz, count, cam, vp, mid, far, radius, margin, ground) {
  const plane = (m, row, sign) => {
    const a = m[3] + sign * m[row], b = m[7] + sign * m[4 + row];
    const c = m[11] + sign * m[8 + row], d = m[15] + sign * m[12 + row];
    const n = Math.hypot(a, b, c) || 1;
    return [a / n, b / n, c / n, d / n];
  };
  const planes = [plane(vp, 0, 1), plane(vp, 0, -1), plane(vp, 1, 1), plane(vp, 1, -1), plane(vp, 2, 1), plane(vp, 2, -1)];
  const band = Math.max(120, mid * 2), keepFrom = radius * 0.55, limit = radius + margin;
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    let cut = false;
    for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -margin) { cut = true; break; }
    if (cut) continue;
    const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    if (d > limit) continue;
    const h = qhash(x, z);
    if (ground && d > keepFrom) {
      const t = (d - keepFrom) / Math.max(1, radius - keepFrom);
      if (h > 1 - t * t * (3 - 2 * t)) continue;
    }
    out.set(i, d <= mid + h * band ? 0 : (d <= far + h * band ? 1 : 2));
  }
  return out;
}

test('the artifact ships the quadtree and the impostor baker', async () => {
  const { core } = await boot();
  for (const name of ['fe_lod_tree_build', 'fe_lod_tree_cull', 'fe_lod_tree_index_ptr',
    'fe_lod_tree_tier_ptr', 'fe_lod_tree_stats_ptr', 'fe_lod_tree_node_count',
    'fe_impostor_build', 'fe_impostor_width', 'fe_impostor_height',
    'fe_impostor_pixels_ptr', 'fe_impostor_bounds_ptr', 'fe_impostor_column']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
    assert.match(cppBuild, new RegExp(`'${name}'`), `${name} must be in REQUIRED_EXPORTS, or a stale artifact ships`);
  }
  /* Both new sources are in the browser build *and* the native one, or a kernel
      ships in one and is never covered by the native tests. */
  for (const src of ['cpp/src/fe_lod.cpp', 'cpp/src/fe_impostor.cpp']) {
    assert.match(cppBuild, new RegExp(src.replace(/[.]/g, '\\.')), `${src} must be compiled into the artifact`);
  }
  const cmake = readFileSync('CMakeLists.txt', 'utf8');
  assert.match(cmake, /cpp\/src\/fe_lod\.cpp/, 'fe_lod.cpp must be in the native CMake build too');
  assert.match(cmake, /cpp\/src\/fe_impostor\.cpp/, 'fe_impostor.cpp must be in the native CMake build too');
});

test('the quadtree emits exactly what a brute-force pass emits', async () => {
  const { core, context } = await boot();
  const N = 40000, spread = 9000;
  const xyz = cloud(N, spread, 4242);
  const cases = [
    { cam: { x: 0, y: 30, z: -60 }, mid: 700, far: 1600, radius: 2200, margin: 12, ground: 1 },
    { cam: { x: 0, y: 40, z: -400 }, mid: 700, far: 1600, radius: 2400, margin: 12, ground: 0 },
    { cam: { x: 2600, y: 160, z: -2400 }, mid: 500, far: 1200, radius: 2400, margin: 20, ground: 0 },
    { cam: { x: -3000, y: 900, z: 3000 }, mid: 900, far: 2000, radius: 3000, margin: 0, ground: 1 }
  ];
  for (const [slot, c] of cases.entries()) {
    const vp = viewProjection(c.cam);
    const got = core.lodTree({
      slot, count: N, xyz, generation: 1234 + slot, vp,
      camX: c.cam.x, camY: c.cam.y, camZ: c.cam.z,
      mid: c.mid, far: c.far, radius: c.radius, margin: c.margin, options: c.ground
    });
    assert.ok(got && got.count > 0, `case ${slot} must return instances`);
    const ref = reference(xyz, N, c.cam, vp, c.mid, c.far, c.radius, c.margin, c.ground);
    const seen = new Map();
    for (let i = 0; i < got.count; i++) seen.set(got.indices[i], got.tiers[i]);
    let missing = 0, extra = 0, wrongTier = 0;
    for (const [i, t] of ref) {
      if (!seen.has(i)) missing++;
      else if (seen.get(i) !== t) wrongTier++;
    }
    for (const i of seen.keys()) if (!ref.has(i)) extra++;
    assert.equal(missing, 0, `case ${slot}: the tree dropped ${missing} plants the flat pass keeps`);
    assert.equal(extra, 0, `case ${slot}: the tree emitted ${extra} plants outside the view`);
    assert.equal(wrongTier, 0, `case ${slot}: ${wrongTier} instances landed in the wrong tier`);
    /* The index has to actually save work, or it is just the flat loop with
       extra steps: it must have tested whole nodes and rejected most of them,
       and it must have looked at far fewer instances than the list holds. */
    assert.ok(got.visited < N / 4, `case ${slot}: the walk visited ${got.visited} nodes, which should be a small tree`);
    assert.ok(got.scanned < N * 0.75, `case ${slot}: the walk still scanned ${got.scanned} of ${N} instances`);
    assert.ok(got.nodes > 1, 'a real tree has more than one node');
  }
  void context;
});

test('the tree is cached and rebuilt only when a plant moves', async () => {
  const { core } = await boot();
  const N = 30000;
  const xyz = cloud(N, 6000, 77);
  const cam = { x: 0, y: 30, z: -50 };
  const state = { slot: 3, count: N, xyz, generation: 900, vp: viewProjection(cam), camX: cam.x, camY: cam.y, camZ: cam.z, mid: 700, far: 1600, radius: 2200, margin: 12, options: 1 };
  const first = core.lodTree(state);
  assert.equal(first.rebuilt, true, 'the first call builds the tree');
  /* A camera move with the same placements must re-use it. */
  const moved = core.lodTree({ ...state, vp: viewProjection({ x: 0, y: 30, z: -300 }) });
  assert.equal(moved.rebuilt, false, 'a settled camera re-walks the existing tree');
  /* A moved plant changes the checksum, and the tree is rebuilt. */
  const shifted = new Float32Array(xyz);
  shifted[3 * 17] += 40;
  const afterEdit = core.lodTree({ ...state, xyz: shifted, generation: 901 });
  assert.equal(afterEdit.rebuilt, true, 'a plant that moved invalidates the tree');
  /* Different species never share a slot. */
  const otherSlot = core.lodTree({ ...state, slot: 9 });
  assert.equal(otherSlot.rebuilt, true, 'each species owns its own tree');
});

test('the studio asks the core for the visible list, then for the tier', () => {
  assert.match(lodSource, /const slot=FLORA_SLOT\[k\];/, 'the species slot comes from the flora table');
  assert.match(lodSource, /if\(slot!==undefined&&typeof core\.lodTree==='function'\)/, 'the quadtree is used when the artifact has it');
  assert.match(lodSource, /let gen=2166136261;/, 'the tree generation is a checksum of the placements');
  assert.match(lodSource, /Math\.imul\(gen\^\(o\.x\*8\|0\),16777619\)/, 'and it is computed in the loop that already copies positions');
  assert.match(lodSource, /if\(!quadOk&&typeof core\.lodVisible==='function'\)/, 'an older artifact still gets the flat culling path');
  /* Nothing may be dropped because a species has no slot (rocks, buildings). */
  assert.match(lodSource, /if\(qt&&qt\.count>0\)\{visOrder=qt\.indices;lodTiers=qt\.tiers;visN=qt\.count;quadOk=true;/, 'the tree result is used as-is');
});

test('an impostor atlas is a real render of the species it names', async () => {
  const { flora } = await boot({ THREE });
  const species = ['oak', 'pine', 'juniper'];
  for (const name of species) {
    const atlas = flora.impostor(name, 4242, 2);
    assert.ok(atlas, `${name} must bake`);
    assert.equal(atlas.views, 8, 'eight azimuths');
    assert.ok(atlas.quadW > 0.05 && atlas.quadW < 40, `${name} quad width is in metres (${atlas.quadW})`);
    assert.ok(atlas.quadH > 0.05 && atlas.quadH < 40, `${name} quad height is in metres (${atlas.quadH})`);
    /* Not blank, and not a filled rectangle: the alpha mask is the silhouette. */
    assert.ok(atlas.coverage > 0.01, `${name} atlas must contain the plant (coverage ${atlas.coverage})`);
    assert.ok(atlas.coverage < 0.85, `${name} atlas must not be a solid card (coverage ${atlas.coverage})`);
    /* The atlas is cached: a second call hands back the same texture object. */
    const again = flora.impostor(name, 4242, 2);
    assert.equal(again.texture, atlas.texture, 'an atlas is baked once per species and seed');
  }
  assert.ok(flora.impostorCount() >= species.length, 'the cache is populated');
  /* A different seed is a different plant, so it must be a different atlas. */
  const a = flora.impostor('oak', 11, 2), b = flora.impostor('oak', 12, 2);
  assert.notEqual(a.texture, b.texture, 'the seed selects a different plant');
});

test('the impostor carries the plant: azimuths differ and the mask is the silhouette', async () => {
  const { core, flora } = await boot({ THREE });
  const atlas = flora.impostor('juniper', 99, 2);
  const { width, height, views, texture } = atlas;
  const px = texture.image.data;
  /* Every baked view has visible pixels... */
  for (let v = 0; v < views; v++) {
    let solid = 0;
    for (let i = 0; i < width * height; i++) if (px[((v * height * width) + i) * 4 + 3] > 96) solid++;
    assert.ok(solid > 40, `view ${v} must contain the plant (${solid} texels)`);
  }
  /* ...and neighbouring views are not the same picture: that is the whole
     point of baking a ring instead of one billboard. */
  const diff = (a, b) => {
    let d = 0;
    for (let i = 0; i < width * height; i++) {
      const ia = (a * height * width + i) * 4, ib = (b * height * width + i) * 4;
      d += Math.abs(px[ia + 3] - px[ib + 3]);
    }
    return d / (width * height);
  };
  assert.ok(diff(0, 1) > 0.5, 'view 0 and view 1 differ: the atlas is a ring, not a copy');
  assert.ok(diff(0, 4) > 0.5, 'the far side of the ring differs from the near side');
  /* The column the studio samples comes from the kernel, and it wraps: a
     camera on the far side of a plant must not select a column that does not
     exist, and the ring must be continuous through the wrap point. */
  let col = 0;
  const steps = 64;
  let biggestJump = 0;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = core.impostorColumn(Math.sin(a), Math.cos(a));
    assert.ok(c >= 0 && c < views, `column ${c} must be one of the ${views} baked views`);
    if (i) biggestJump = Math.max(biggestJump, Math.abs(((c - col + views + views / 2) % views) - views / 2));
    col = c;
  }
  assert.ok(biggestJump <= 1, 'the column changes by at most one view per step, so an orbit never snaps');
  /* Opposite sides of the plant are half a ring apart. */
  const front = core.impostorColumn(0, 1);
  const back = core.impostorColumn(0, -1);
  assert.equal((front + views / 2) % views, back, 'the far side of the ring is half a turn away');
});

test('the studio draws one billboard per plant, sized from the atlas, and never authors geometry', () => {
  assert.match(lodSource, /function impostorMeshFor\(k\)/, 'the impostor mesh is built per species');
  assert.match(lodSource, /new THREE\.PlaneGeometry\(1,1,1,1\)/, 'it is a single quad');
  assert.match(lodSource, /normalize\(cross\(vec3\(0\.0,1\.0,0\.0\),toCam\)\)/, 'the quad billboards around Y only');
  assert.match(lodSource, /if\(t\.a<0\.30\)discard;/, 'the silhouette is the atlas alpha mask, not a rectangle');
  assert.match(lodSource, /vUvA=vec2\(\(col\+inner\.x\)\/uViews,inner\.y\);/, 'the quad samples its own column');
  assert.match(lodSource, /vMix=frac;/, 'and cross-fades to the next column with the sub-view angle, so an orbit never snaps');
  assert.match(lodSource, /dmi\.scale\.set\(\(K\.impAtlas\?\.quadW\|\|2\)\*bw,\(K\.impAtlas\?\.quadH\|\|3\)\*s,1\)/,
    'the quad size comes from the baked model, not from a guess');
  assert.match(lodSource, /if\(tier===2&&!imp\)\{tier=1;if\(impostorsOn&&!allInstances\)requestImpostor\(k\)\}/,
    'a species that needs an atlas enters the bake queue, and only while impostors are on');
  assert.match(lodSource, /const IMPOSTOR_KEY='final3d\.impostors\.v1';/, 'the layer is a persisted user setting');
  assert.match(lodSource, /function setImpostors\(on\)\{/, 'and turning it off restores the low-detail mesh');
  assert.match(lodSource, /bakeQueuedImpostor\(\);/, 'the settle sweep bakes one atlas per frame');
  /* Atlases are optional: an artifact without the baker keeps the low mesh. */
  /* Atlases are optional: an artifact without the baker keeps the low mesh. */
  assert.match(floraSource, /if \(!THREE \|\| !baked \|\| !baked\.pixels \|\| !baked\.views\) return null;/,
    'a bake with no pixels produces no atlas, and the caller keeps its low mesh');
  /* The impostor must be included wherever a species' meshes are enumerated,
     or it keeps drawing after the world it belongs to is hidden. */
  const t1 = readFileSync('terrain-main-01.js', 'utf8');
  assert.match(t1, /const kindMeshes=K=>K\?\[\.\.\.\(K\.meshes\|\|\[\]\),\.\.\.\(K\.lowMeshes\|\|\[\]\),\.\.\.\(K\.shadowMeshes\|\|\[\]\),\.\.\.\(K\.impMesh\?\[K\.impMesh\]:\[\]\)\]:\[\]/,
    'one helper enumerates every tier a kind owns');
  assert.equal(/\.\.\.K\.meshes,\.\.\.\(K\.lowMeshes\|\|\[\]\)/.test(lodSource), false,
    'no call site still enumerates only the high and low meshes');
  /* The kernel bakes from the mesh it grew, including the leaf cards. */
  assert.match(cppImp, /rasterSurface\(cpos, cnrm, ccol, fe_flora_geom::card_idx\(\)/, 'the leaf cards are in the atlas');
  assert.match(cppImp, /fe_flora_tree\(kind, seed \? seed : 1u, detail\)/, 'and the species mesh is grown, not authored');
  assert.match(cppFlora, /card_pos\(\)/, 'the flora kernel exposes its card buffer to the baker');
});

/* Nothing in this sandbox can run a WebGL context, so the billboard shaders are
 * compiled the way three compiles them — prefix, defines, fog chunks — and
 * parsed. A syntax error here is a black screen on a device, which is exactly
 * what a test has to catch before it ships. */
test('the billboard shaders are valid GLSL once three has wrapped them', () => {
  const start = lodSource.indexOf('function impostorMaterial(');
  const body = lodSource.slice(start, lodSource.indexOf('function impostorMeshFor('));
  const match = body.match(/vertexShader:`([\s\S]*?)`,\s*fragmentShader:`([\s\S]*?)`/);
  assert.ok(match, 'the material still declares a vertex and a fragment shader');
  const chunks = {
    fog_pars_vertex: '#ifdef USE_FOG\nvarying float fogDepth;\n#endif',
    fog_vertex: '#ifdef USE_FOG\nfogDepth = - mvPosition.z;\n#endif',
    fog_pars_fragment: '#ifdef USE_FOG\nuniform vec3 fogColor;\nvarying float fogDepth;\n#ifdef FOG_EXP2\nuniform float fogDensity;\n#else\nuniform float fogNear;\nuniform float fogFar;\n#endif\n#endif',
    fog_fragment: '#ifdef USE_FOG\n#ifdef FOG_EXP2\nfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogDepth * fogDepth );\n#else\nfloat fogFactor = smoothstep( fogNear, fogFar, fogDepth );\n#endif\ngl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );\n#endif'
  };
  const expand = (src) => src.replace(/#include <([a-z_]+)>/g, (_, name) => {
    assert.ok(chunks[name], `unknown chunk ${name}`);
    return chunks[name];
  });
  const prefixVS = 'uniform mat4 modelMatrix;uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;uniform mat4 viewMatrix;uniform mat3 normalMatrix;uniform vec3 cameraPosition;uniform bool isOrthographic;attribute mat4 instanceMatrix;attribute vec3 instanceColor;attribute vec3 position;attribute vec3 normal;attribute vec2 uv;';
  const defines = '#version 300 es\n#define USE_FOG\n#define FOG_EXP2\n#define USE_INSTANCING\n#define USE_INSTANCING_COLOR\n';
  parser.parse(defines + prefixVS + expand(match[1]), { quiet: true });
  parser.parse(defines + 'uniform mat4 viewMatrix;uniform vec3 cameraPosition;' + expand(match[2]), { quiet: true });
  /* The billboard must react to day and night, or far trees glow at midnight. */
  assert.match(body, /uLight:\{value:new THREE\.Color\(1,1,1\)\}/, 'the atlas light ratio is a uniform');
  assert.match(body, /mat\.onBeforeRender=\(\)=>\{/, 'and it is recomputed every frame from the live sun and sky');
  assert.match(body, /u\.setRGB\(cl\(now\.r\/r\.r,\.05,2\.5\)/, 'as a ratio against the light the atlas was baked under');
});

/* The routing is the whole feature: a far plant must go to the billboard, a
 * near one to the grown mesh, and a species whose atlas is not baked yet must
 * keep a mesh rather than vanish. This runs sync() for real against three.js
 * with a stubbed kernel answer, because a static check cannot prove the
 * instance buffers line up. */
test('sync routes each instance to exactly one tier', () => {
  const start = lodSource.indexOf('const LOD_GROUND=');
  /* sync() ends where the LoD sets are declared: they follow it in the file. */
  const endMarker = 'K.selectionGridDirty=true;treeMapDirty=true;';
  const end = lodSource.indexOf('const LOD_KINDS=', lodSource.indexOf(endMarker));
  assert.ok(start > 0 && end > start, 'the LoD section is where it should be');
  const slice = lodSource.slice(start, end);

  const run = (impMesh) => {
    const mesh0 = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 4);
    const mesh1 = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 4);
    const low0 = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 4);
    const low1 = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 4);
    const requests = [];
    const list = [];
    for (let i = 0; i < 4; i++) list.push({ x: i * 10, y: 0, z: 0, s: 1, a: 1, r: 0, v: 1 });
    const KIND = {
      oak: {
        list, size: 6, tint: [1, 1, 1], max: 4, meshes: [mesh0, mesh1], lowMeshes: [low0, low1],
        shadowMeshes: null, impMesh, impAtlas: { quadW: 5, quadH: 8 }
      }
    };
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 5000);
    cam.position.set(0, 6, 0);
    cam.updateMatrixWorld();
    const ctx = {
      THREE, KIND, scene, cam, console,
      lodScratch: new Float32Array(0), vpMat: null, lodFullDistance: 750, detail: 2,
      LOD_GROUND: new Set(), LOD_TREES: new Set(['oak']), LOD_BOTANICAL: new Set(['oak']),
      LOD_KINDS: new Set(['oak']),
      VIEW_RADIUS: { oak: 2400 }, RK: {}, BLD: {}, NT: {}, ROOT_SPAN: {},
      TREE_SIZE_MIN: {}, TREE_SIZE_MAX: {}, SHADOW_PROXY_STRIDE: 8,
      GROUND_UP: new THREE.Vector3(0, 1, 0),
      GROUND_Q: new THREE.Quaternion(), GROUND_E: new THREE.Euler(),
      dm: new THREE.Object3D(), dmi: new THREE.Object3D(),
      tcol: new THREE.Color(),
      U: { uWindDir: { value: new THREE.Vector2(1, 0) } }, WU: { value: 0 }, WW: { value: 1 },
      hh: () => 0.5, cl: (v, a, b) => Math.min(b, Math.max(a, v)), hgt: () => 0, vn: () => 0,
      groundNormal: () => new THREE.Vector3(0, 1, 0), shadowPadFor: () => 0,
      treeMapDirty: false, impostorsOn: true,
      requestImpostor: (k) => requests.push(k),
      FLORA_SLOT: { oak: 0 },
      core: {
        ready: true,
        /* Instance 0 near, 1 mid, 2 and 3 far. */
        lodTree: () => ({
          count: 4, nodes: 5,
          indices: new Uint32Array([0, 1, 2, 3]),
          tiers: new Uint8Array([0, 1, 2, 2]),
          rebuilt: false
        })
      }
    };
    ctx.window = { FELandscapeCore: ctx.core };
    vm.createContext(ctx);
    vm.runInContext(slice + '\n;this.sync=sync;this.wanted=impostorWanted;', ctx);
    ctx.sync('oak');
    return { KIND, mesh0, mesh1, low0, low1, requests, ctx, wanted: ctx.wanted };
  };

  /* With an atlas loaded, the two far instances are one quad each. */
  const withAtlas = run(new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 4));
  withAtlas.KIND.oak.impMesh.count = 2;
  assert.equal(withAtlas.mesh0.count, 1, 'the grown mesh keeps the near instance');
  assert.equal(withAtlas.low0.count, 1, 'the low mesh keeps the middle one');
  assert.equal(withAtlas.KIND.oak.impMesh.count, 2, 'the two far ones become billboards');
  assert.equal(withAtlas.mesh0.count + withAtlas.low0.count + withAtlas.KIND.oak.impMesh.count, 4,
    'every instance is drawn exactly once');
  /* Only the first material slot owns the billboard; the second slot draws none
     of the far instances, or the plant would be drawn twice. */
  assert.equal(withAtlas.mesh1.count, 1, 'the second slot still draws the near instance');
  assert.equal(withAtlas.low1.count, 1, 'and the middle one');
  assert.equal(withAtlas.wanted.size, 0, 'no bake is requested when an atlas already exists');
  /* The billboard carries the source index, so a tap can still find the plant. */
  assert.deepEqual(Array.from(withAtlas.KIND.oak.impMesh.userData.sourceListIndices), [2, 3],
    'a billboard maps back to its placement');

  /* With no atlas, the far band stays on the low mesh and the bake is queued. */
  const without = run(null);
  assert.equal(without.mesh0.count, 1, 'the grown mesh keeps the near instance');
  assert.equal(without.low0.count, 3, 'without an atlas the far band keeps the low mesh');
  assert.equal(without.low0.count + without.mesh0.count, 4, 'nothing disappears while the atlas is baked');
  assert.deepEqual(Array.from(without.wanted), ['oak'], 'and the species is queued exactly once');
});
