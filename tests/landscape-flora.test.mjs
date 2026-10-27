import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* Grown flora: the tree skeletons and rock meshes used to be drawn in JS with a
   fixed recursive splitter. These tests pin the C++ kernel that replaced it —
   space colonisation, da Vinci taper, golden-angle leaf anchors, the ported
   rock recipe — plus the thin adapter and the page wiring, and the promise that
   a stale artifact keeps the previous JS builders instead of half-upgrading. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const floraSource = readFileSync('landscape-flora.js', 'utf8');
const html = readFileSync('Terrain_system_.html', 'utf8');
const models = readFileSync('terrain-main-02.js', 'utf8');
const scene = readFileSync('terrain-main-01.js', 'utf8');
const buildScript = readFileSync('scripts/build.mjs', 'utf8');
const cppBuild = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');

async function bootBridge(extra = {}) {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout, TextDecoder, TextEncoder,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }),
    ...extra
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  await context.FELandscapeCore.loading;
  assert.equal(context.FELandscapeCore.ready, true);
  return { context, core: context.FELandscapeCore };
}

/* The kernel table, in index order. The studio's bridge list must stay
   identical to it: one row per species, both sides. */
const SPECIES = ['oak', 'birch', 'acacia', 'shrub', 'ashbush', 'deadtree', 'fern', 'treefern',
  'grass', 'tallgrass', 'daisy', 'tulip', 'lavender', 'saguaro', 'barrel', 'agave', 'palm', 'pebble',
  'pine', 'spruce', 'krumm', 'juniper', 'prickly', 'joshua', 'sage', 'flower'];
const LEAF_STRIDE = 10;

function triangles(mesh) {
  const p = mesh.pos, idx = mesh.idx;
  let degenerate = 0, minY = Infinity, maxY = -Infinity, maxR = 0, minShade = Infinity, maxShade = -Infinity;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-10) degenerate++;
  }
  for (let i = 0; i < mesh.verts; i++) {
    const y = p[i * 3 + 1];
    maxY = Math.max(maxY, y);
    minY = Math.min(minY, y);
    maxR = Math.max(maxR, Math.hypot(p[i * 3], p[i * 3 + 2]));
    minShade = Math.min(minShade, mesh.col[i * 3]);
    maxShade = Math.max(maxShade, mesh.col[i * 3]);
  }
  return { degenerate, minY, maxY, maxR, minShade, maxShade };
}

test('the artifact ships the flora kernels and reports twenty-six species / three rocks', async () => {
  const { core } = await bootBridge();
  for (const name of ['fe_flora_tree', 'fe_flora_rock', 'fe_flora_pos_ptr', 'fe_flora_leaf_ptr', 'fe_flora_species_info', 'fe_flora_species_count', 'fe_flora_rock_kind_count',
    'fe_flora_sway_ptr', 'fe_flora_phase_ptr', 'fe_flora_leaf_stride', 'fe_flora_lsystem', 'fe_flora_lsystem_word']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
  }
  /* Leaf cards are grown with the tree, so the card ABI has to be there too. */
  for (const name of ['fe_flora_card_count', 'fe_flora_card_vert_count', 'fe_flora_card_index_count',
    'fe_flora_card_pos_ptr', 'fe_flora_card_col_ptr', 'fe_flora_card_part_ptr', 'fe_flora_card_idx_ptr',
    'fe_flora_part_ptr']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
  }
  /* Cross-realm objects are not reference-equal, so compare the fields. */
  const counts = core.floraCounts();
  assert.equal(counts.species, SPECIES.length);
  assert.equal(counts.rocks, 3);
});

test('every species grows a body with finite normals, sound triangles and no black shade', async () => {
  const { core } = await bootBridge();
  const grown = {};
  /* A daisy is not a small oak: the floor is the vertex count that species'
     own dimensions imply at detail 2, not one number for all eighteen. */
  /* Vert floors are per species: a 705-vertex wildflower tuft is a whole plant,
     a 1 000-vertex floor would just be a number borrowed from a tree. */
  const MIN_VERTS = { grass: 300, tallgrass: 240, daisy: 180, tulip: 140, lavender: 900, saguaro: 780,
    barrel: 500, agave: 340, palm: 7000, pebble: 120, flower: 600, pine: 4000, spruce: 6000,
    krumm: 3000, juniper: 3000, prickly: 2500, joshua: 1500, sage: 1200 };
  for (let kind = 0; kind < SPECIES.length; kind++) {
    const tree = core.floraTree(kind, 4242 + kind, 2);
    const floor = MIN_VERTS[SPECIES[kind]] || 1000;
    assert.ok(tree && tree.verts >= floor, `${SPECIES[kind]} must grow a body (got ${tree && tree.verts} verts, floor ${floor})`);
    assert.equal(tree.pos.length, tree.verts * 3);
    assert.equal(tree.nrm.length, tree.verts * 3);
    assert.equal(tree.uv.length, tree.verts * 2);
    assert.equal(tree.col.length, tree.verts * 3);
    assert.equal(tree.rnd.length, tree.verts);
    assert.equal(tree.cen.length, tree.verts * 3);
    assert.equal(tree.idx.length, tree.indices);
    assert.ok(Array.from(tree.nrm).every(Number.isFinite), `${SPECIES[kind]} normals must be finite`);
    const t = triangles(tree);
    assert.equal(t.degenerate, 0, `${SPECIES[kind]} must not contain degenerate triangles`);
    assert.ok(t.minShade > 0.05 && t.maxShade <= 1.4, `${SPECIES[kind]} procedural shade ${t.minShade.toFixed(2)}..${t.maxShade.toFixed(2)} must not contain black vertices`);
    /* Real heights in metres, from the species' published size range. */
    const HEIGHT = { grass: [0.18, 0.42], tallgrass: [0.9, 2.0], daisy: [0.08, 0.20], tulip: [0.3, 0.5],
      lavender: [0.4, 0.7], saguaro: [4.5, 7.0], barrel: [0.6, 1.0], agave: [0.6, 1.3],
      palm: [7, 12], pebble: [0.05, 0.2], fern: [0.3, 0.6], treefern: [2, 4],
      /* Pinus sylvestris 10-25 m, Picea abies to 30 m, krummholz stays under 2 m,
         Juniperus communis is a 1-4 m shrub, Joshua trees run 5-15 m and
         sagebrush is waist high. */
      pine: [8, 18], spruce: [10, 20], krumm: [0.8, 2.2], juniper: [1.2, 3.6],
      prickly: [0.4, 1.6], joshua: [4, 9], sage: [0.5, 1.4], flower: [0.3, 0.6] };
    const range = HEIGHT[SPECIES[kind]] || [0.35, 14];
    assert.ok(t.maxY > range[0] && t.maxY < range[1], `${SPECIES[kind]} height ${t.maxY.toFixed(2)} m must sit in its real range ${range[0]}-${range[1]} m`);
    grown[SPECIES[kind]] = { t, tree };
  }

  /* Real proportions: a birch is a slender 9 m column, an acacia is a wide
     umbrella, a shrub and an ash bush stay near the ground, and a dead tree
     carries no leaves at all. */
  assert.ok(grown.birch.t.maxY > grown.oak.t.maxY * 0.9, 'birch grows taller than the oak');
  assert.ok(grown.birch.t.maxR < grown.oak.t.maxR * 0.85, 'birch stays slender while the oak spreads');
  assert.ok(grown.acacia.t.maxR > grown.acacia.t.maxY * 0.55, 'acacia forms a wide flat canopy');
  assert.ok(grown.shrub.t.maxY < 2.5 && grown.ashbush.t.maxY < 2.5, 'shrubs stay below eye height');
  assert.ok(grown.shrub.t.maxY < grown.oak.t.maxY * 0.4, 'a shrub is not a small oak');
  assert.equal(grown.deadtree.tree.leaves, 0, 'a dead tree carries no leaf cards');

  for (const name of ['oak', 'birch', 'acacia', 'shrub', 'ashbush']) {
    const { tree, t } = grown[name];
    assert.ok(tree.leaves > 100, `${name} must place leaf anchors (got ${tree.leaves})`);
    assert.equal(tree.leafStride, LEAF_STRIDE);
    assert.equal(tree.leaf.length, tree.leaves * LEAF_STRIDE, 'leaf stride is position, direction, size, shade, compliance, phase');
    let offCrown = 0, unit = 0, shadeMin = 1, shadeMax = 0;
    for (let i = 0; i < tree.leaves; i++) {
      const o = i * LEAF_STRIDE;
      const size = tree.leaf[o + 6], shade = tree.leaf[o + 7];
      const len = Math.hypot(tree.leaf[o + 3], tree.leaf[o + 4], tree.leaf[o + 5]);
      if (Math.abs(len - 1) > 1e-3) unit++;
      if (Math.hypot(tree.leaf[o], tree.leaf[o + 2]) > t.maxR * 1.25) offCrown++;
      if (shade < 0 || shade > 1) shadeMin = -1;
      assert.ok(tree.leaf[o + 8] >= 0 && tree.leaf[o + 8] <= 1, `${name} leaf compliance must stay in 0..1`);
      assert.ok(Number.isFinite(tree.leaf[o + 9]), `${name} leaf phase must be a real angle`);
      assert.ok(size > 0.05 && size < 4, `${name} leaf size ${size} must be plausible`);
      shadeMin = Math.min(shadeMin, shade);
      shadeMax = Math.max(shadeMax, shade);
    }
    assert.equal(unit, 0, `${name} leaf anchors need unit-length directions`);
    assert.equal(offCrown, 0, `${name} leaf anchors must sit inside the grown crown`);
    assert.ok(shadeMin >= 0 && shadeMax <= 1, `${name} leaf shade must stay in 0..1`);
  }
});

test('trunks taper with da Vinci rule and the root flares below the ground', async () => {
  const { core } = await bootBridge();
  const info = (kind) => {
    const t = core.floraTree(kind, 909, 2);
    return { t, trim: [t.info[0], t.info[1], t.info[2], t.info[3], t.info[4], t.info[5]] };
  };
  const oak = info(0);
  /* species info = trunkTop, trunkRadius, crownY, crownRX, crownRY, leafSize */
  assert.ok(oak.trim[0] > 2 && oak.trim[0] < 8, `oak trunk clears the ground (got ${oak.trim[0]})`);
  assert.ok(oak.trim[1] > 0.2 && oak.trim[1] < 1.2, `oak trunk radius is plausible (got ${oak.trim[1]})`);
  assert.ok(oak.trim[3] > oak.trim[1] * 2, 'the crown is wider than the trunk is thick');
  assert.ok(oak.trim[5] > 0.5, 'oak leaves are broad');

  let base = 0, mid = 0, flare = Infinity, trunkRadius = oak.trim[1];
  for (let i = 0; i < oak.t.verts; i++) {
    const x = oak.t.pos[i * 3], y = oak.t.pos[i * 3 + 1], z = oak.t.pos[i * 3 + 2];
    const r = Math.hypot(x, z);
    if (Math.abs(y) < 0.25) base = Math.max(base, r);
    if (y > 2 && y < 2.5) mid = Math.max(mid, r);
    if (r < 1.2) flare = Math.min(flare, y);
  }
  assert.ok(base > mid * 1.2, `the trunk must thicken towards the base (${base.toFixed(2)} vs ${mid.toFixed(2)})`);
  assert.ok(mid < trunkRadius * 1.05, 'the trunk narrows again above the root flare');
  assert.ok(base > trunkRadius, 'the root flare is the widest part of the trunk');
  assert.ok(flare < 0, 'the root flare has to reach below y=0 so the tree does not float on the terrain');

  const birch = info(1);
  assert.ok(birch.trim[1] < oak.trim[1] * 0.6, 'a birch trunk is thinner than an oak trunk');
  assert.ok(birch.trim[2] > oak.trim[2], 'the birch crown starts higher up the trunk');
});

test('space colonisation gives every seed its own tree, not a copy', async () => {
  const { core } = await bootBridge();
  const fingerprint = (seed) => {
    const t = core.floraTree(0, seed, 2);
    const p = t.pos;
    let h = 0;
    for (let i = 0; i < p.length; i += 97) h = (h * 31 + Math.round(p[i] * 1000)) % 1000000007;
    return { h, verts: t.verts, leaves: t.leaves, height: Math.max(...Array.from({ length: t.verts }, (_, i) => p[i * 3 + 1])) };
  };
  const a = fingerprint(11), b = fingerprint(22), c = fingerprint(33);
  assert.notEqual(a.h, b.h, 'two seeds must not grow the same skeleton');
  assert.notEqual(b.h, c.h, 'two seeds must not grow the same skeleton');
  assert.notEqual(a.verts + ':' + a.leaves, b.verts + ':' + b.leaves, 'different seeds must differ in topology, not just in rotation');
  assert.ok(Math.abs(a.height - b.height) > 0.02, 'branch tips should land at different heights');

  /* The engine is deterministic: the same seed replays the same tree, which is
     what makes the render reproducible and the fallback swap safe. */
  const again = fingerprint(11);
  assert.equal(again.h, a.h);
  assert.equal(again.verts, a.verts);
});

test('rocks are clipped solids with mineral colour and lichen only where it belongs', async () => {
  const { core } = await bootBridge();
  const rocks = [];
  for (let kind = 0; kind < 3; kind++) {
    const rock = core.floraRock(kind, 5150, 2);
    assert.ok(rock && rock.verts > 500 && rock.indices > 1500, `rock ${kind} must build a full mesh`);
    const t = triangles(rock);
    assert.equal(t.degenerate, 0, `rock ${kind} must not contain degenerate triangles`);
    assert.ok(t.maxY > 0.5 && t.maxR > 0.4, `rock ${kind} must have volume`);
    let green = 0, sum = [0, 0, 0];
    for (let i = 0; i < rock.verts; i++) {
      const r = rock.col[i * 3], g = rock.col[i * 3 + 1], b = rock.col[i * 3 + 2];
      sum[0] += r; sum[1] += g; sum[2] += b;
      if (g - r > 0.02) green++;
    }
    rocks.push({ kind, t, green, avg: sum.map((v) => v / rock.verts) });
  }
  assert.ok(rocks[0].green > 50, 'granite carries lichen on its upward faces');
  assert.equal(rocks[2].green, 0, 'basalt has no lichen growth in this recipe');
  assert.ok(rocks[1].avg[0] > rocks[1].avg[2] * 1.6, 'sandstone is warm');
  assert.ok(rocks[2].avg.every((v) => v < 0.3), 'basalt is dark');
  assert.ok(rocks[0].avg.every((v) => v > 0.05 && v < 0.9), 'granite is a mid-grey');

  const a = core.floraRock(0, 101, 2), b = core.floraRock(0, 202, 2);
  const extent = (r) => {
    let minX = 9, maxX = -9;
    for (let i = 0; i < r.verts; i++) { minX = Math.min(minX, r.pos[i * 3]); maxX = Math.max(maxX, r.pos[i * 3]); }
    return maxX - minX;
  };
  assert.ok(Math.abs(extent(a) - extent(b)) > 0.05, 'two seeds must not produce the same boulder');

  assert.equal(core.floraRock(0, 5, 0).verts < core.floraRock(0, 5, 2).verts, true, 'detail 0 builds a coarser rock than detail 2');
});

test('the adapter hands the studio BufferGeometry without changing any material', async () => {
  const { context } = await bootBridge({ THREE });
  vm.runInContext(floraSource, context);
  const flora = context.FELandscapeFlora;
  assert.ok(flora, 'landscape-flora.js must install FELandscapeFlora');
  assert.equal(Array.from(flora.KINDS).join(','), SPECIES.join(','));
  assert.equal(Array.from(flora.KINDS).join(','), SPECIES.join(','));
  assert.equal(Array.from(flora.ROCK_KINDS).join(','), 'granite,sandstone,basalt');
  const counts = flora.counts();
  assert.equal(counts.species, SPECIES.length);
  assert.equal(counts.rocks, 3);

  const tree = flora.tree('oak', 1234, 2);
  assert.ok(tree && tree.wood, 'oak must convert to a BufferGeometry');
  for (const name of ['position', 'normal', 'color', 'uv', 'aRnd', 'aCen', 'aSway', 'aPhase']) {
    assert.ok(tree.wood.attributes[name], `grown wood needs the ${name} attribute the shared shaders sample`);
  }
  assert.ok(tree.wood.index && tree.wood.index.count > 0, 'grown wood must be indexed');
  assert.ok(tree.wood.index.count % 3 === 0);
  assert.ok(tree.leaf instanceof Float32Array && tree.leaf.length % LEAF_STRIDE === 0, `leaf anchors keep the ${LEAF_STRIDE}-float stride`);
  assert.ok(tree.info && tree.info.length === 8, 'species info survives the bridge');

  const rock = flora.rock('sandstone', 77, 2);
  assert.ok(rock && rock.attributes.position.count > 500, 'rocks convert to a BufferGeometry too');
  assert.equal(flora.state.used >= 2, true, 'the adapter counts what the engine produced');
  assert.equal(flora.state.fallbacks, 0);

  assert.equal(flora.tree('not-a-tree'), null, 'unknown species never fabricates geometry');
  assert.equal(flora.rock('not-a-rock'), null, 'unknown rock never fabricates geometry');
  assert.equal(flora.detailLevel(3), 3);
  assert.equal(flora.detailLevel(undefined), 2);
});

test('a deployment without the flora kernel keeps the JS builders instead of failing', async () => {
  const context = {
    console, Float32Array, Uint32Array, Uint8Array, Math, Promise,
    THREE,
    FELandscapeCore: { ready: false, error: 'stale artifact' }
  };
  vm.createContext(context);
  vm.runInContext(floraSource, context);
  const flora = context.FELandscapeFlora;
  assert.equal(flora.tree('oak'), null);
  assert.equal(flora.rock('granite'), null);
  const counts = flora.counts();
  assert.equal(counts.species, 0);
  assert.equal(counts.rocks, 0);
  assert.equal(flora.state.ready, false);
  assert.ok(flora.state.fallbacks >= 2, 'the fallback path has to be visible, not silent');
});

test('the page and both build scripts ship the grown flora', () => {
  assert.ok(html.includes('<script src="./landscape-flora.js"></script>'), 'the studio must load the flora adapter');
  const adapterAt = html.indexOf('./landscape-flora.js');
  const modelsAt = html.indexOf('./terrain-main-02.js');
  assert.ok(adapterAt > 0 && adapterAt < modelsAt, 'the adapter must load before the builders it feeds');

  assert.match(buildScript, /"landscape-flora\.js"/, 'the offline build must inline the adapter');
  assert.match(cppBuild, /'cpp\/src\/fe_flora\.cpp'/, 'the wasm build must compile the flora kernel');
  assert.match(cppBuild, /'fe_flora_tree',\s*'fe_flora_rock'/, 'the wasm build must require the grown flora exports');

  /* Every tree and rock call site goes through the grown builder; the original
     JS generators survive only as the documented fallback. */
  assert.match(models, /function treeBuilder\(kind,legacy,per\)\{/);
  assert.match(models, /function rockBuilder\(pk\)\{/);
  assert.match(models, /mk\('oak',1500,TV3\(treeBuilder\('oak',oakTreeJs,3\)/);
  assert.match(models, /mk\('birch',1500,TV3\(treeBuilder\('birch',birchTreeJs,3\)/);
  assert.match(models, /mk\('shrub',4000,TV3\(treeBuilder\('shrub',shrubTreeJs,3\)/);
  assert.match(models, /LZ\('acacia',1200,\(\)=>TV\(treeBuilder\('acacia',acaciaTreeJs,2\)/);
  assert.match(models, /LZ\('ashbush',3000,\(\)=>TV\(treeBuilder\('ashbush',ashBushTreeJs,2\)/);
  assert.match(models, /mk\('rock',1000,\[0,1,2\]\.map\(v=>\[rockBuilder\(\),\{nt:1,std:1,vi:v,vn:3\}\]\),true\)/);
  assert.match(models, /LZ\('sandrock',800,\(\)=>\[0,1,2\]\.map\(v=>\[rockBuilder\('sand'\)/);
  assert.match(models, /LZ\('basalt',1200,\(\)=>\[0,1,2\]\.map\(v=>\[rockBuilder\('basalt'\)/);
  assert.doesNotMatch(models, /\[rockG\(/, 'no call site may still resolve the removed rockG name');
  assert.match(models, /function rockGJs\(pk\)\{/, 'the JS rock recipe stays as the fallback');
  assert.match(models, /function oakTreeJs\(\)\{/, 'the JS tree builder stays as the fallback');

  /* A species built after the artifact finished loading is grown in place, and
     the swap keeps the LOD twin and the selection bounds honest. */
  assert.match(scene, /window\.__feGrowSpecies&&window\.__feGrowSpecies\(\)/, 'lazily built species must trigger the grown swap');
  assert.match(models, /window\.__feGrowSpecies=applyGrown;/);
  assert.match(models, /if\(K\.lowMeshes\)K\.lowMeshes\.forEach/);
  assert.match(models, /K\.selectionBounds=null;K\.selectionGrid=null;K\.selectionGridDirty=true;/);
});

/* ------------------------------------------------------------------ */
/* The grammar is real: production rules, rewritten in the kernel      */
/* ------------------------------------------------------------------ */
test('the kernel really rewrites fern production rules instead of faking a splitter', async () => {
  const { core } = await bootBridge();
  assert.equal(core.lsystem(0, 7).word, 'X', 'iteration 0 is the bare axiom X');
  const one = core.lsystem(1, 7);
  assert.equal(one.rules, 2, 'the grammar carries two productions');
  /* X -> F[+X]F[-X]+X, with the mirrored alternative chosen per seed. */
  assert.match(one.word, /^F\[[+-]X\]F\[[+-]X\][+-]X$/);
  assert.equal(one.symbols, 12);

  let previousF = 0;
  for (let it = 0; it <= 5; it++) {
    const pass = core.lsystem(it, 1234);
    assert.equal(pass.word.length, pass.symbols, 'the reported symbol count is the real word length');
    assert.match(pass.word, /^[FX+\-\[\]\\/&^]+$/, 'the word only uses turtle symbols');
    const f = (pass.word.match(/F/g) || []).length;
    const x = (pass.word.match(/X/g) || []).length;
    /* F -> FF doubles every segment, X -> F[+X]F[-X]+X adds two. The closed
       form 2(3^n - 2^n) is what a real rewrite produces; a recursive branch
       splitter cannot hit it by accident. */
    assert.equal(f, 2 * (Math.pow(3, it) - Math.pow(2, it)), `pass ${it}: F count must follow F->FF`);
    assert.equal(x, Math.pow(3, it), `pass ${it}: X count must follow the single non-terminal`);
    assert.ok(f >= previousF, 'the word can only grow');
    previousF = f;
  }
  /* Brackets balance, so the turtle stack is never popped empty. */
  const deep = core.lsystem(5, 77).word;
  let depth = 0, maxDepth = 0;
  for (const c of deep) {
    if (c === '[') { depth++; maxDepth = Math.max(maxDepth, depth); }
    if (c === ']') depth--;
    assert.ok(depth >= 0, 'no unmatched pop');
  }
  assert.equal(depth, 0, 'every push is closed');
  assert.ok(maxDepth >= 4, 'the frond nests several branch orders deep');
});

test('the grammar is stochastic per seed and deterministic per (seed, pass)', async () => {
  const { core } = await bootBridge();
  assert.equal(core.lsystem(4, 99).word, core.lsystem(4, 99).word, 'one seed must replay exactly');
  const words = new Set();
  for (let seed = 1; seed <= 12; seed++) words.add(core.lsystem(4, seed).word);
  assert.ok(words.size > 3, `seeds must produce different fronds (got ${words.size} of 12)`);
});

test('ferns and tree ferns are grown from the grammar by the same kernel entry point', async () => {
  const { core } = await bootBridge();
  const fern = core.floraTree(6, 31, 2), treefern = core.floraTree(7, 31, 2);
  for (const [name, tree, maxY, minLeaves] of [['fern', fern, 0.9, 400], ['treefern', treefern, 3.8, 800]]) {
    assert.ok(tree && tree.verts > 900, `${name} must build frond geometry (got ${tree && tree.verts})`);
    const t = triangles(tree);
    assert.equal(t.degenerate, 0, `${name} must not contain degenerate triangles`);
    assert.ok(t.maxY > maxY * 0.45 && t.maxY < maxY, `${name} fronds arch to ${t.maxY.toFixed(2)} m, not a flat mat`);
    assert.ok(tree.leaves >= minLeaves, `${name} pins pinnae along every rachis (got ${tree.leaves})`);
    assert.equal(tree.leaf.length, tree.leaves * LEAF_STRIDE);
  }
  /* A tree fern stands on a trunk; a bracken sits on the ground and spreads. */
  const t = triangles(fern);
  assert.ok(t.minY < 0.05, 'the bracken rises straight out of the soil');
  assert.ok(t.maxR > 0.3, `the bracken spreads its fronds wide (got ${t.maxR.toFixed(2)} m)`);
  assert.ok(treefern.verts > fern.verts, 'the tree fern carries a trunk as well as fronds');
});

/* ------------------------------------------------------------------ */
/* Skeletal wind: the hierarchy, not a height law                      */
/* ------------------------------------------------------------------ */
test('every grown species bakes per-vertex compliance and branch phase', async () => {
  const { core } = await bootBridge();
  /* How each kind is allowed to move is part of the asset: a canopy whips, a
     cactus flexes, a pebble does not move at all. One law for all eighteen
     would either turn a saguaro into a flag or a birch into a statue. */
  const TREES = ['oak', 'birch', 'acacia', 'shrub', 'ashbush', 'deadtree', 'fern', 'treefern',
    'pine', 'spruce', 'krumm', 'juniper', 'joshua', 'sage', 'palm'];
  const HERBS = ['grass', 'tallgrass', 'daisy', 'tulip', 'lavender'];
  const SUCCULENTS = ['saguaro', 'barrel', 'agave', 'prickly'];
  const CONIFER = ['pine', 'spruce', 'krumm', 'juniper'];
  for (let kind = 0; kind < SPECIES.length; kind++) {
    const tree = core.floraTree(kind, 909 + kind, 2);
    const name = SPECIES[kind];
    assert.ok(tree.sway && tree.sway.length === tree.verts, `${name} needs one compliance value per vertex`);
    assert.ok(tree.phase && tree.phase.length === tree.verts, `${name} needs one phase value per vertex`);
    let maxY = 0, rootMax = 0, tipMax = 0, phMin = Infinity, phMax = -Infinity;
    for (let i = 0; i < tree.verts; i++) maxY = Math.max(maxY, tree.pos[i * 3 + 1]);
    for (let i = 0; i < tree.verts; i++) {
      const y = tree.pos[i * 3 + 1], s = tree.sway[i];
      assert.ok(s >= 0 && s <= 1, `${name} compliance stays in 0..1 (got ${s})`);
      assert.ok(Number.isFinite(tree.phase[i]), `${name} phase must be finite`);
      /* The collar is the bottom slice of *that plant*, not the bottom 6 cm of
         the world: a 12 cm daisy has no 6 cm trunk, and a spruce carries
         needles down to the soil, which bend with the branch that holds them. */
      /* Ground-hugging species (conifers with needles to the soil, a sagebrush
         whose leaves start at the crown) have no bare collar to hold still. */
      const groundHugging = CONIFER.indexOf(name) >= 0 || name === 'sage' || name === 'prickly';
      if (y < Math.min(0.06, maxY * 0.10) && !groundHugging) rootMax = Math.max(rootMax, s);
      if (y > maxY * 0.65) tipMax = Math.max(tipMax, s);
      phMin = Math.min(phMin, tree.phase[i]);
      phMax = Math.max(phMax, tree.phase[i]);
    }
    assert.ok(rootMax < 0.3, `${name} root collar must stay stiff (got ${rootMax.toFixed(2)})`);
    if (name === 'pebble') {
      assert.equal(tipMax, 0, 'a river stone does not sway');
      assert.equal(phMax, 0, 'and it has no branch phase to swing on');
      continue;
    }
    if (SUCCULENTS.includes(name)) {
      assert.ok(tipMax > 0.1 && tipMax < 0.6, `${name} is stiff: ${tipMax.toFixed(2)} must stay under a canopy's swing`);
      continue;
    }
    /* Softness must grow from the collar to the tip for every plant, and a
       skeletal branch swings further than a petal. */
    assert.ok(tipMax > 0.4, `${name} outer limbs must swing (got ${tipMax.toFixed(2)})`);
    assert.ok(tipMax > rootMax, `${name} must be softer at the tip than at the collar`);
    if (CONIFER.includes(name)) {
      /* A conifer's outer sprays flex, but a wind-shaped krummholz at the
         treeline is stiffer than an oak crown — that difference is the point. */
      assert.ok(tipMax > 0.35, `${name} needles must still flex (got ${tipMax.toFixed(2)})`);
    } else if (TREES.includes(name) || name === 'grass' || name === 'tallgrass') {
      assert.ok(tipMax > 0.6, `${name} skeletal limbs must swing further (got ${tipMax.toFixed(2)})`);
    }
    if (TREES.includes(name) || HERBS.includes(name)) {
      /* A single-stemmed annual (daisy, tulip) carries one phase; a crown or a
         clump carries many. What must never happen is a missing phase. */
      assert.ok(Number.isFinite(phMin) && Number.isFinite(phMax), `${name} phase must be a real angle`);
    }
    if (TREES.includes(name) || name === 'palm') {
      assert.ok(phMax - phMin > 1.0, `${name} branch phases must differ across the crown`);
    }
  }
});

test('compliance is a property of the branch path, not of the height', async () => {
  const { core } = await bootBridge();
  const tree = core.floraTree(0, 4711, 2); /* oak: wide crown, low side limbs */
  /* In one thin height band there must be both stiff and compliant vertices —
     a height-only law (y^2) can never produce that spread. */
  let bandSwing = 0;
  for (let y0 = 2; y0 < 6; y0 += 0.5) {
    let lo = 1, hi = 0;
    for (let i = 0; i < tree.verts; i++) {
      const y = tree.pos[i * 3 + 1];
      if (y < y0 || y >= y0 + 0.5) continue;
      lo = Math.min(lo, tree.sway[i]);
      hi = Math.max(hi, tree.sway[i]);
    }
    if (hi > lo) bandSwing = Math.max(bandSwing, hi - lo);
  }
  assert.ok(bandSwing > 0.35, `a single height band must contain stiff and compliant wood (spread ${bandSwing.toFixed(2)})`);
});

test('the wind shader bends the skeleton and the JS builders carry the channels', () => {
  assert.match(scene, /attribute float aSway;attribute float aPhase;/, 'the foliage shader has to read the skeletal channels');
  assert.match(scene, /const SKEL='float skH=max\(position\.y,0\.\);float skA=aSway\*aSway\*clamp\(skH\*\.34,\.12,1\.\);/, 'the bend is driven by compliance and scaled by the plant height, so a bracken does not sway like an oak');
  assert.match(scene, /transformed\.xz\+=wd\*\(skA\*uW\*/, 'the skeleton moves along the wind direction');
  assert.match(scene, /aPhase\*1\.6/, 'neighbouring limbs must swing out of phase');
  assert.match(scene, /float wv=position\.y\*position\.y\*uW;/, 'unskinned foliage keeps the old height law');
  assert.match(models, /g\.SW\.push\(g\.sw===undefined\?0:g\.sw\)/, 'JS geometry carries a compliance channel');
  assert.match(models, /o\.setAttribute\('aSway',new THREE\.Float32BufferAttribute\(g\.SW,1\)\)/);
  assert.match(models, /L\.sw=st>8\?a\[i\+8\]:0;L\.phv=st>8\?a\[i\+9\]:0;/, 'leaf cards inherit their twig compliance');
});

test('the grown bridge exposes the grammar and the skeletal channels', async () => {
  const { core } = await bootBridge();
  const word = core.lsystem(3, 5);
  assert.ok(word && word.word.length > 60);
  const flora = { lsystem: core.lsystem };
  assert.equal(typeof flora.lsystem, 'function');
  assert.match(floraSource, /function lsystem\(iterations, seed\)/, 'the adapter exposes the grammar');
  assert.match(floraSource, /setAttribute\('aSway', new THREE\.Float32BufferAttribute\(mesh\.sway, 1\)\)/);
  assert.match(bridgeSource, /core\.lsystem=function\(iterations,seed\)\{/);
  assert.match(bridgeSource, /const stride=typeof Ex\.fe_flora_leaf_stride==='function'/, 'the bridge must not assume the 8-float stride');
});

test('a rule set can be uploaded and rewritten in the kernel at runtime', async () => {
  const { core } = await bootBridge();
  /* The classic "plant" grammar: F -> F[+F]F[-F]F, whose segment count grows
     as 5^n. Nothing about this word exists in the shipped C++. */
  const accepted = core.lsystemLoad({ axiom: 'F', rules: [{ pre: 'F', alts: ['F[+F]F[-F]F', 'F[-F]F[+F]F'] }] });
  assert.equal(accepted, 1, 'the kernel accepts a one-production grammar');
  let previous = 1;
  for (let it = 0; it <= 4; it++) {
    const run = core.lsystemRun(it, 11);
    assert.ok(run, 'run must return the expanded word');
    const f = (run.word.match(/F/g) || []).length;
    assert.equal(f, Math.pow(5, it), `uploaded grammar must follow F -> F[+F]F[-F]F (pass ${it})`);
    assert.ok(f >= previous);
    previous = f;
  }
  /* Two productions, both stochastic: F keeps its width, X drives the height. */
  assert.equal(core.lsystemLoad({ axiom: 'X', rules: [
    { pre: 'X', alts: ['F[+X][-X]FX', 'F[-X][+X]FX'] },
    { pre: 'F', alts: ['FF'] }
  ] }), 2);
  const bush = core.lsystemRun(4, 3);
  assert.ok(bush && bush.word.length > 200, 'the second rule set expands too');
  assert.match(bush.word, /^[FX+\-\[\]]+$/, 'no symbol outside the turtle alphabet');
  assert.equal(core.lsystemRun(4, 3).word, bush.word, 'one seed replays exactly');
  assert.notEqual(core.lsystemRun(4, 4).word, bush.word, 'another seed picks other alternatives');

  /* A rule with no alternatives is malformed and must be refused, not silently
     swapped for the previous grammar. */
  assert.equal(core.lsystemLoad({ axiom: 'X', rules: [{ pre: 'X', alts: [] }] }), -1, 'an empty alternative list is rejected');
  const plant = core.lsystemPlant({ fronds: 7, step: 0.04, tilt: 0.7, droop: 0.02, leafSize: 0.04, iterations: 3, seed: 21, detail: 2 });
  assert.ok(plant && plant.verts > 200, 'the uploaded grammar grows real geometry');
  assert.equal(plant.leaf.length, plant.leaves * 10, 'grammar-grown plants keep the 10-float leaf anchors');
  assert.ok(plant.sway && plant.sway.length === plant.verts, 'and the skeletal wind channels');
});

test('the custom-rule path is exposed by the adapter and costs nothing when absent', async () => {
  const { core } = await bootBridge();
  assert.equal(typeof core.lsystemLoad, 'function');
  assert.equal(typeof core.lsystemRun, 'function');
  assert.equal(typeof core.lsystemPlant, 'function');
  const context = {
    console, Float32Array, Uint32Array, Uint8Array, Math, Promise, THREE,
    FELandscapeCore: { ready: false, error: 'stale artifact' }
  };
  vm.createContext(context);
  vm.runInContext(floraSource, context);
  assert.equal(context.FELandscapeFlora.plant({ rules: [] }), null, 'no kernel means no fabricated grammar');
  assert.equal(context.FELandscapeFlora.rules(3, 1), null);
  assert.ok(context.FELandscapeFlora.state.fallbacks >= 1);
});

test('a runaway grammar is clamped by the kernel budgets, never by luck', async () => {
  const { core } = await bootBridge();
  core.lsystemLoad({ axiom: 'X', rules: [
    { pre: 'X', alts: ['F[+X]F[-X]+X'] },
    { pre: 'F', alts: ['FF'] }
  ] });
  const big = core.lsystemPlant({ fronds: 24, step: 0.05, tilt: 0.1, droop: 0.001, leafSize: 0.05, iterations: 5, seed: 3, detail: 3 });
  assert.ok(big && big.verts > 20000, 'the plant fills the budget before it is cut off');
  assert.ok(big.verts <= 24000, 'never past MAX_VERT');
  assert.ok(big.leaves <= 3200, 'never past MAX_LEAF');
  assert.equal(big.pos.length, big.verts * 3);
  assert.ok(Array.from(big.pos).every(Number.isFinite), 'no NaN escapes a clamped walk');
  assert.ok(Array.from(big.nrm).every(Number.isFinite));
  /* A horizontal frond makes a flat rosette, not a degenerate mesh. */
  const flat = core.lsystemPlant({ fronds: 1, step: 0.01, tilt: 0.6, droop: 0.05, leafSize: 0.05, iterations: 1, seed: 2, detail: 1 });
  assert.ok(flat && flat.verts > 0, 'a low budget call still returns geometry');
});

/* ------------------------------------------------------------------ */
/* Runtime shape controls and the editable grammar                     */
/* ------------------------------------------------------------------ */

test('the shape sliders scale the grown species and clamp at the kernel', async () => {
  const { core } = await bootBridge();
  const height = (kind, seed) => {
    const m = core.floraTree(kind, seed, 2);
    let hi = 0;
    for (let i = 0; i < m.verts; i++) hi = Math.max(hi, m.pos[i * 3 + 1]);
    return { h: hi, verts: m.verts };
  };
  const base = height(0, 7);
  core.floraSetShape(1.5, 1.4);
  const tall = height(0, 7);
  assert.ok(tall.h > base.h * 1.3, `1.5x height should grow the oak (${base.h.toFixed(2)} -> ${tall.h.toFixed(2)})`);
  assert.ok(tall.verts > base.verts, 'more branch density must add geometry');
  core.floraSetShape(0.6, 0.6);
  const small = height(0, 7);
  assert.ok(small.h < base.h * 0.75, 'the slider shrinks the plant too');
  assert.ok(small.verts < base.verts);
  /* The kernel owns the limits, so a wild slider value cannot blow a buffer. */
  assert.equal(core.floraSetShape(99, 99), 250, 'height clamps to 2.5x');
  assert.equal(core.floraSetShape(-5, 0), 30, 'height clamps to 0.3x');
  core.floraSetShape(1, 1);
  assert.ok(Math.abs(height(0, 7).h - base.h) < 1e-3, 'back to the species table');
});

test('an uploaded grammar rewrites in the kernel and drives the ferns', async () => {
  const { core } = await bootBridge();
  const fern = () => core.floraTree(6, 7, 2);
  const before = fern().verts;
  const accepted = core.lsystemLoad({
    axiom: 'X',
    rules: [{ pre: 'X', alts: ['F[+X][-X]FX'] }, { pre: 'F', alts: ['F'] }]
  });
  assert.equal(accepted, 2, 'both productions are accepted');
  const word = core.lsystemRun(3, 7);
  assert.equal(word.symbols, 131, 'the rewrite happens in the kernel');
  assert.equal(word.word.includes('X'), true);
  assert.notEqual(fern().verts, before, 'the fern species grows from the uploaded grammar');
  assert.equal(core.lsystemReset(), 0, 'the built-in grammar comes back');
  assert.equal(fern().verts, before);
  assert.equal(core.lsystemRun(3, 7), null, 'and there is no uploaded rule set any more');
});

test('the sheet validates grammar text before anything reaches the kernel', () => {
  const panel = readFileSync('terrain-main-07.js', 'utf8');
  const block = panel.slice(panel.indexOf('const FLORA_DEFAULT_GRAMMAR'), panel.indexOf('window.__feLoadGrammar'));
  const context = {
    console, Error, String, Number, Math, setTimeout,
    FELandscapeCore: { ready: false, loading: Promise.resolve() },
    FELandscapeFlora: { shape: { height: 1, density: 1 }, setShape() {}, resetRules() {} },
    el: () => ({}), btn: () => ({}), sl: () => ({}), G: () => ({}),
    queueStudioConfigSave() {}
  };
  vm.createContext(context);
  context.window = context;
  vm.runInContext(block, context);
  const parse = (text) => vm.runInContext(`parseGrammar(${JSON.stringify(text)})`, context);

  const spec = parse('X -> F[+X]F[-X]+X | F[-X]F[+X]-X\nF -> FF');
  assert.equal(spec.axiom, 'X');
  assert.equal(spec.rules.length, 2);
  assert.equal(spec.rules[1].pre, 'F', 'the second production is the doubling rule');
  assert.equal(spec.rules[1].alts.length, 1);
  assert.equal(spec.rules[1].alts[0], 'FF');
  assert.equal(parse('# comment\naxiom: F\nF -> F[+F]F').axiom, 'F', 'comments and an axiom line are supported');
  assert.equal(parse('X \u2192 F[+X]F[-X]').rules[0].pre, 'X', 'the arrow may be typed as a unicode arrow');
  for (const bad of ['', 'X F F', 'G -> FF', 'X -> FG', 'XY -> FF', 'X -> ']) {
    assert.throws(() => parse(bad), /./, `"${bad}" must be refused`);
  }
  /* The panel ships the editor, both actions and the two shape sliders. */
  assert.match(panel, /textarea class="grammar"/, 'the sheet has a rule editor');
  assert.match(panel, /Apply grammar/, 'and an explicit apply action');
  assert.match(panel, /Restore built-in grammar/, 'and a way back');
  assert.match(panel, /sl\('Tree height ×'/, 'tree height is a runtime control');
  assert.match(panel, /sl\('Branch density ×'/, 'so is branch density');
  assert.match(panel, /__feRegrowFlora/, 'applying a control rebuilds the grown species');
});

test('a shape change rebuilds the grown species a few at a time, never all at once', () => {
  const start = models.indexOf('let grownQueue=null'), end = models.indexOf('function applyGrown(jobs)');
  assert.ok(start > 0 && end > start, 'the sliced rebuild lives in terrain-main-02.js');
  const frames = [];
  let rebuilt = 0;
  const context = {
    Math, Date, Array, console, window: {},
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    /* Each species takes ~2 ms, so a 3 ms budget cannot finish six of them. */
    applyGrown: (jobs) => { rebuilt += jobs.length; const t = Date.now(); while (Date.now() - t < 2) {} },
    GROWN_JOBS: [{ kind: 'oak' }]
  };
  vm.createContext(context);
  vm.runInContext(models.slice(start, end) + ';this.queue=queueGrownRebuild;this.frames=()=>grownQueue;this.pending=()=>grownQueueAt;', context);
  context.queue([1, 2, 3, 4, 5, 6]);
  assert.equal(rebuilt, 0, 'queueing never blocks the frame that moved the slider');
  assert.equal(frames.length, 1, 'it schedules the rebuild on the next frame');
  frames.shift()();
  assert.ok(rebuilt > 0 && rebuilt < 6, 'the first frame rebuilds some species, not all six');
  assert.equal(frames.length, 1, 'and schedules the rest on the frame after that');
  let guard = 0;
  while (frames.length && rebuilt < 6 && guard++ < 20) frames.shift()();
  assert.equal(rebuilt, 6, 'every species is rebuilt across the following frames');
  assert.equal(context.frames(), null, 'the queue drains instead of leaking');
});

test('the rebuild never frees or re-allocates an instance buffer', () => {
  const block = models.slice(models.indexOf('function regrowFlora'), models.indexOf('function applyGrown(jobs)'));
  assert.match(block, /job\.parts=\[\];touched\.push\(job\);/, 'only the grown geometry cache is dropped');
  assert.equal(/new Float32Array|new THREE\.|dispose\(/.test(block), false, 'the placements, matrices and instance buffers are untouched');
  const apply = models.slice(models.indexOf('function applyGrown(jobs)'), models.indexOf('/* terrain-main-01 builds lazy species'));
  assert.match(apply, /const list=jobs&&jobs\.length\?jobs:GROWN_JOBS;/, 'a slice can rebuild a single species');
  assert.equal(/new THREE\.InstancedMesh/.test(apply), false, 'and it adopts geometry into the existing meshes');
});

test('the documented sway law is the one the kernel compiles', () => {
  const flora = readFileSync('cpp/src/fe_flora.cpp', 'utf8');
  const doc = readFileSync('docs/FLORA.md', 'utf8');
  assert.match(flora, /const float path = clampf\(\(len - s\.trunkTop \* 0\.5f\) \/ \(treeH \* 0\.55f\)/, 'compliance follows the branch path');
  assert.match(flora, /const float thin = clampf\(1\.0f - radius \/ maxf\(0\.02f, s\.trunkRadius \* 0\.60f\)/, 'and is thinned by the local radius');
  assert.match(flora, /return clampf\(path \* \(0\.55f \+ 0\.45f \* thin\)/, 'thick limbs keep 55 % of the path compliance');
  assert.ok(doc.includes('thin = clamp(1 − radius / (0.60 · trunkRadius), 0, 1)'), 'the doc states that radius term');
  assert.ok(doc.includes('sway = clamp(path · (0.55 + 0.45·thin), 0, 1)'), 'and the combined law');
  assert.ok(doc.includes('float skB = (sin(uT * skW + aPhase) + 0.42 * sin(uT * skW * 2.1 + aPhase * 1.6 + 1.1))'), 'the doc shader is the shipped shader');
});

test('branches are round limbs, not triangular planks', () => {
  /* The facet count used to be `3 + r0*7`, which gave every branch thinner than
     about 4 cm exactly three sides. A crown is almost entirely those, so the
     tree read as a pile of flat planks instead of round wood. */
  const flora = readFileSync('cpp/src/fe_flora.cpp', 'utf8');
  assert.match(flora, /const float floorSides = s\.tubes <= 4 \? 3\.0f : 4\.0f;/, 'woody species never drop to a triangle');
  assert.match(flora, /const int32_t sides = int32_t\(clampf\(4\.0f \+ r0 \* 120\.0f, floorSides, float\(s\.tubes\)\)\);/, 'facets follow the radius');
  assert.equal(flora.includes('clampf(3.0f + r0 * 7.0f'), false, 'the plank formula is gone');
});

test('the crown of a real tree is thick enough to read as round', async () => {
  const { core } = await bootBridge();
  /* An oak used to come out at roughly 3 000 vertices, most of them in
     3-sided prisms. Round wood costs more and reads as wood. */
  const oak = core.floraTree(0, 4242, 2);
  assert.ok(oak.verts > 6000, `an oak should be a body of round limbs (got ${oak.verts})`);
  assert.ok(oak.verts <= 24000, 'and stay inside the kernel buffer');
  for (let kind = 0; kind < SPECIES.length; kind++) {
    const tree = core.floraTree(kind, 99 + kind, 2);
    assert.ok(tree.verts <= 24000, `${SPECIES[kind]} stays inside the vertex buffer (got ${tree.verts})`);
  }
});

test('bark is scaled by circumference, so the crown is not smeared', () => {
  /* `j / sides` wrapped one whole bark tile around every limb from a 2 cm twig
     to a 1.2 m trunk. Along the branch the scale was metric (uvScale per metre),
     across it was not, so the grain stretched sideways on exactly the thin wood
     that fills a crown. */
  const flora = readFileSync('cpp/src/fe_flora.cpp', 'utf8');
  assert.match(flora, /const float uSpan = maxf\(0\.12f, kTwoPi \* \(\(r0 \+ r1\) \* 0\.5f\) \* uvScale\);/, 'the ring spans a metric arc length');
  assert.match(flora, /\(float\(j\) \/ float\(sides\)\) \* uSpan/, 'and the facet uses it');
  const ring = flora.slice(flora.indexOf('for (int32_t j = 0; j <= sides; ++j)'), flora.indexOf('const int32_t stride = sides + 1;'));
  assert.equal(ring.includes('float(j) / float(sides),'), false, 'the stretched uv is gone');
});

test('every triangle is wound outward, so bark and rock are not drawn inside-out', async () => {
  const { core } = await bootBridge();
  const meshes = [['oak', core.floraTree(0, 4242, 2)], ['birch', core.floraTree(1, 4242, 2)], ['pine', core.floraTree(18, 4242, 2)], ['rock', core.floraRock(0, 5150, 2)]];
  for (const [name, mesh] of meshes) {
    const pos = mesh.pos, nrm = mesh.nrm, idx = mesh.idx;
    let agree = 0, triangles = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (Math.hypot(nx, ny, nz) < 1e-12) continue;
      const vx = nrm[a] + nrm[b] + nrm[c], vy = nrm[a + 1] + nrm[b + 1] + nrm[c + 1], vz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
      triangles++;
      if (nx * vx + ny * vy + nz * vz > 0) agree++;
    }
    /* The default material is FrontSide: a reversed winding culls the bark we
       should see and draws the hollow inside of the trunk instead. */
    assert.ok(triangles > 500, `${name} has triangles`);
    assert.ok(agree === triangles, `${name}: ${triangles - agree} of ${triangles} triangles face inward`);
  }
});

test('a tree grows out of the ground with a buttressed collar, not stood on it', async () => {
  const { core } = await bootBridge();
  const tree = core.floraTree(0, 4242, 2);
  const pos = tree.pos;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < tree.verts; i++) {
    const y = pos[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  assert.ok(minY < -0.01, 'the foot is buried below the ground plane so it cannot float on a slope');
  const radiusAt = (low, high) => {
    let r = 0;
    for (let i = 0; i < tree.verts; i++) {
      const y = pos[i * 3 + 1];
      if (y < low || y > high) continue;
      r = Math.max(r, Math.hypot(pos[i * 3], pos[i * 3 + 2]));
    }
    return r;
  };
  const collar = radiusAt(minY - 1e-4, minY + 0.08);
  const stem = radiusAt(maxY * 0.3, maxY * 0.34);
  assert.ok(collar > stem * 1.15, `the collar (${collar.toFixed(3)}) must be visibly wider than the stem (${stem.toFixed(3)})`);
});

test('a lateral branch is rooted inside its parent instead of butted against it', async () => {
  /* The join is in the kernel, so pin the rule rather than the pixels: a limb
     that leaves at an angle is sunk back along its own axis and flares, a
     leader continues the parent's line at the parent's radius. */
  const cpp = readFileSync('cpp/src/fe_flora.cpp', 'utf8');
  assert.match(cpp, /const bool leader = dot\(dir, pdir\) > 0\.75f;/);
  assert.match(cpp, /const float sink = leader \? 0\.0f : r0 \* 0\.85f;/);
  assert.match(cpp, /const float rootR = leader \? r0 \* 0\.98f : maxf\(r0 \* 0\.50f, r1 \* 1\.20f\);/);
  /* Winding is fixed in one place for every emitter in the file. */
  assert.match(cpp, /gIdx\[gIdxN\+\+\] = uint32_t\(a\);\n  gIdx\[gIdxN\+\+\] = uint32_t\(c\);\n  gIdx\[gIdxN\+\+\] = uint32_t\(b\);/);
});
