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
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout,
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

const SPECIES = ['oak', 'birch', 'acacia', 'shrub', 'ashbush', 'deadtree'];

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

test('the artifact ships the flora kernels and reports six species / three rocks', async () => {
  const { core } = await bootBridge();
  for (const name of ['fe_flora_tree', 'fe_flora_rock', 'fe_flora_pos_ptr', 'fe_flora_leaf_ptr', 'fe_flora_species_info', 'fe_flora_species_count', 'fe_flora_rock_kind_count']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
  }
  /* Cross-realm objects are not reference-equal, so compare the fields. */
  const counts = core.floraCounts();
  assert.equal(counts.species, 6);
  assert.equal(counts.rocks, 3);
});

test('every species grows a body with finite normals, sound triangles and no black shade', async () => {
  const { core } = await bootBridge();
  const grown = {};
  for (let kind = 0; kind < 6; kind++) {
    const tree = core.floraTree(kind, 4242 + kind, 2);
    assert.ok(tree && tree.verts > 1000, `${SPECIES[kind]} must grow a body (got ${tree && tree.verts} verts)`);
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
    assert.ok(t.maxY > 0.4, `${SPECIES[kind]} must grow upward`);
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
    assert.equal(tree.leaf.length, tree.leaves * 8, 'leaf stride is position, direction, size, shade');
    let offCrown = 0, unit = 0, shadeMin = 1, shadeMax = 0;
    for (let i = 0; i < tree.leaves; i++) {
      const o = i * 8;
      const size = tree.leaf[o + 6], shade = tree.leaf[o + 7];
      const len = Math.hypot(tree.leaf[o + 3], tree.leaf[o + 4], tree.leaf[o + 5]);
      if (Math.abs(len - 1) > 1e-3) unit++;
      if (Math.hypot(tree.leaf[o], tree.leaf[o + 2]) > t.maxR * 1.25) offCrown++;
      if (shade < 0 || shade > 1) shadeMin = -1;
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
  assert.equal(Array.from(flora.ROCK_KINDS).join(','), 'granite,sandstone,basalt');
  const counts = flora.counts();
  assert.equal(counts.species, 6);
  assert.equal(counts.rocks, 3);

  const tree = flora.tree('oak', 1234, 2);
  assert.ok(tree && tree.wood, 'oak must convert to a BufferGeometry');
  for (const name of ['position', 'normal', 'color', 'uv', 'aRnd', 'aCen']) {
    assert.ok(tree.wood.attributes[name], `grown wood needs the ${name} attribute the shared shaders sample`);
  }
  assert.ok(tree.wood.index && tree.wood.index.count > 0, 'grown wood must be indexed');
  assert.ok(tree.wood.index.count % 3 === 0);
  assert.ok(tree.leaf instanceof Float32Array && tree.leaf.length % 8 === 0, 'leaf anchors keep the 8-float stride');
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
