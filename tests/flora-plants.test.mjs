import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* The plants people walk up to — palms, saguaros, barrel cacti, agave, grasses,
 * flowers and pebbles — are modelled in the C++ kernel from their own published
 * dimensions. These tests pin the real-world numbers, the material-group split
 * that lets one grown mesh feed the bark / leaf / petal materials the studio
 * already renders, and the wiring that swaps the JS primitives for those meshes
 * without ever blocking the first frame. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const floraSource = readFileSync('landscape-flora.js', 'utf8');
const models = readFileSync('terrain-main-02.js', 'utf8');
const cppBuild = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');

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
  return { context, core: context.FELandscapeCore };
}

const PLANTS = ['grass', 'tallgrass', 'daisy', 'tulip', 'lavender', 'saguaro', 'barrel', 'agave', 'palm', 'pebble'];
const KIND = Object.fromEntries(PLANTS.map((name, i) => [name, i + 8]));

function stats(mesh) {
  const p = mesh.pos, idx = mesh.idx;
  let minY = Infinity, maxY = -Infinity, maxR = 0, degenerate = 0, nonFinite = 0, badNormal = 0, outOfRange = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-10) degenerate++;
    if (idx[i] >= mesh.verts || idx[i + 1] >= mesh.verts || idx[i + 2] >= mesh.verts) outOfRange++;
  }
  for (let i = 0; i < mesh.verts; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
    maxY = Math.max(maxY, y); minY = Math.min(minY, y);
    maxR = Math.max(maxR, Math.hypot(x, z));
    const n = Math.hypot(mesh.nrm[i * 3], mesh.nrm[i * 3 + 1], mesh.nrm[i * 3 + 2]);
    if (Math.abs(n - 1) > 0.02) badNormal++;
  }
  return { minY, maxY, maxR, degenerate, nonFinite, badNormal, outOfRange };
}

test('every walk-up plant grows from its own published dimensions', async () => {
  const { core } = await boot();
  /* Height and spread in metres, straight out of the species descriptions in
     fe_flora.cpp. A palm is 7-12 m and a daisy is a hand's width. */
  const SIZE = {
    grass: { h: [0.18, 0.45], r: [0.05, 0.4] },
    tallgrass: { h: [0.9, 2.1], r: [0.15, 1.3] },
    daisy: { h: [0.08, 0.2], r: [0.01, 0.12] },
    tulip: { h: [0.3, 0.5], r: [0.02, 0.2] },
    lavender: { h: [0.4, 0.75], r: [0.02, 0.2] },
    saguaro: { h: [4.5, 7.0], r: [0.2, 1.6] },
    barrel: { h: [0.6, 1.0], r: [0.2, 0.6] },
    agave: { h: [0.6, 1.3], r: [0.3, 1.4] },
    palm: { h: [7, 12], r: [1.5, 5] },
    pebble: { h: [0.05, 0.2], r: [0.04, 0.2] }
  };
  for (const name of PLANTS) {
    const mesh = core.floraTree(KIND[name], 5150, 2);
    assert.ok(mesh && mesh.verts > 100, `${name} must grow a mesh`);
    const s = stats(mesh);
    const size = SIZE[name];
    assert.equal(s.nonFinite, 0, `${name} has a non-finite vertex`);
    assert.equal(s.outOfRange, 0, `${name} indexes past its vertex buffer`);
    assert.equal(s.degenerate, 0, `${name} must not contain zero-area triangles`);
    assert.equal(s.badNormal, 0, `${name} normals must be unit length`);
    /* A trunk socketed a few centimetres into the ground is deliberate — it is
       what stops a plant floating on a slope — but nothing may hang below it.
       A palm's and an agave's woody base sit 10 cm into the soil because the
       socket has to survive a 30 degree slope. */
    const socket = (name === 'agave' || name === 'palm') ? -0.12 : -0.08;
    assert.ok(s.minY > socket, `${name} must not sink below its own soil line (min y ${s.minY.toFixed(3)})`);
    assert.ok(s.maxY > size.h[0] && s.maxY < size.h[1], `${name} is ${s.maxY.toFixed(2)} m tall, expected ${size.h[0]}-${size.h[1]} m`);
    assert.ok(s.maxR > size.r[0] && s.maxR < size.r[1], `${name} spreads ${s.maxR.toFixed(2)} m, expected ${size.r[0]}-${size.r[1]} m`);
  }
});

test('bark is displaced geometry, and its furrows tilt the shading normal', async () => {
  /* PBR lists displacement next to albedo and roughness, and on a tree that has
     to mean vertices: a bump map cannot roughen a silhouette. Every ring vertex
     carries the joint it was emitted around (the `cen` channel), so each ring's
     radial profile can be read straight off the artifact: `r` is how far the
     vertex stands from the joint, and the angle between the vertex's radial
     direction and its normal is the slope of the furrow wall it sits on. A
     smooth tube has every normal exactly radial; a displaced one does not. */
  const { core } = await boot();
  const SPECIES = { oak: 0, birch: 1, acacia: 2 };
  const tilt = {};
  for (const [name, kind] of Object.entries(SPECIES)) {
    const mesh = core.floraTree(kind, 4242, 2);
    const rings = new Map();
    for (let i = 0; i < mesh.verts; i++) {
      const dx = mesh.pos[i * 3] - mesh.cen[i * 3];
      const dy = mesh.pos[i * 3 + 1] - mesh.cen[i * 3 + 1];
      const dz = mesh.pos[i * 3 + 2] - mesh.cen[i * 3 + 2];
      const r = Math.hypot(dx, dy, dz);
      if (r < 1e-4) continue;
      const key = `${mesh.cen[i * 3]},${mesh.cen[i * 3 + 1]},${mesh.cen[i * 3 + 2]}`;
      const dot = (mesh.nrm[i * 3] * dx + mesh.nrm[i * 3 + 1] * dy + mesh.nrm[i * 3 + 2] * dz) / r;
      const group = rings.get(key) || [];
      group.push({ r, tilt: (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI });
      rings.set(key, group);
    }
    /* Mid-limb rings only: the root flare is a separate effect. */
    const mid = [...rings.values()].filter((g) => g.length >= 6 && g[0].r > 0.1 && g[0].r < 0.45);
    assert.ok(mid.length > 4, `${name} must have mid-limb rings to measure`);
    tilt[name] = Math.max(...mid.flat().map((v) => v.tilt));
    assert.ok(tilt[name] > 2.5, `${name} bark furrows must tilt the surface normals (${tilt[name].toFixed(1)} deg)`);
    /* ...but a ridge is a furrow, not a saw blade: the wall never leans so far
       that the limb reads as a cog. */
    assert.ok(tilt[name] < 35, `${name} furrow wall leans ${tilt[name].toFixed(1)} deg — too deep`);
    /* The relief is real depth, so it also has to survive the invariants that a
       displaced mesh can break. */
    const s = stats(mesh);
    assert.equal(s.degenerate, 0, `${name} displacement must not collapse a triangle`);
    assert.equal(s.badNormal, 0, `${name} displaced normals must stay unit length`);
    assert.equal(s.nonFinite, 0, `${name} displacement must stay finite`);
  }
  /* Same radius, different species: oak is deeply fissured, birch is papery.
     That ratio is what makes the two read as different trees at arm's length. */
  assert.ok(tilt.oak > tilt.birch * 1.5,
    `oak furrows (${tilt.oak.toFixed(1)} deg) must cut deeper than birch (${tilt.birch.toFixed(1)} deg)`);
  assert.ok(tilt.acacia > tilt.birch, 'acacia is fissured too');
});

test('a plant is deterministic for a seed and a different plant for another', async () => {
  const { core } = await boot();
  for (const name of PLANTS) {
    const a = core.floraTree(KIND[name], 4242, 2);
    const b = core.floraTree(KIND[name], 4242, 2);
    assert.equal(Array.from(a.pos).join(','), Array.from(b.pos).join(','), `${name} must be deterministic for one seed`);
    const c = core.floraTree(KIND[name], 777, 2);
    const spread = (m) => {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < m.verts; i++) { mn = Math.min(mn, m.pos[i * 3]); mx = Math.max(mx, m.pos[i * 3]); }
      return mx - mn;
    };
    assert.ok(Math.abs(spread(a) - spread(c)) > 1e-4 || a.verts !== c.verts, `${name} must not repeat itself across seeds`);
  }
});

test('detail scales the cost instead of the shape', async () => {
  const { core } = await boot();
  for (const name of ['palm', 'saguaro', 'barrel', 'grass']) {
    const low = core.floraTree(KIND[name], 99, 0);
    const high = core.floraTree(KIND[name], 99, 3);
    assert.ok(low.verts < high.verts, `${name} detail 0 must be cheaper than detail 3`);
    assert.ok(low.verts > 20, `${name} detail 0 must still be a plant`);
  }
});

test('the material groups split one mesh into wood, foliage and bloom', async () => {
  const { core } = await boot();
  const partsOf = (mesh) => {
    const seen = new Set();
    for (let i = 0; i < mesh.verts; i++) seen.add(Math.round(mesh.part[i]));
    return seen;
  };
  /* A palm is a trunk plus leaflets; a cactus is one fleshy body; a daisy is a
     stem, leaves and a bloom. Those are the three material slots the studio
     renders, so the kernel has to name them. */
  assert.equal([...partsOf(core.floraTree(KIND.palm, 7, 2))].sort().join(','), '0,1', 'palm = trunk + leaflets');
  /* The fourth slot is the darkest part of a head — a composite's disc
     florets, a tulip's stamens, a lavender bud. It is not the petal. */
  assert.equal([...partsOf(core.floraTree(KIND.daisy, 7, 2))].sort().join(','), '0,1,2,3', 'daisy = stem + leaf + ray florets + disc');
  assert.equal([...partsOf(core.floraTree(KIND.tulip, 7, 2))].sort().join(','), '0,1,2,3', 'tulip = stem + leaf + tepals + stamens');
  assert.equal([...partsOf(core.floraTree(KIND.lavender, 7, 2))].sort().join(','), '0,1,2,3', 'lavender = stem + leaf + florets + buds');
  assert.equal([...partsOf(core.floraTree(KIND.agave, 7, 2))].sort().join(','), '0,1', 'agave = caudex + rosette');
  assert.equal([...partsOf(core.floraTree(KIND.barrel, 7, 2))].sort().join(','), '0,2', 'barrel = body + crown');
  assert.equal([...partsOf(core.floraTree(KIND.saguaro, 7, 2))].sort().join(','), '0', 'saguaro is one body');
  assert.equal([...partsOf(core.floraTree(KIND.grass, 7, 2))].sort().join(','), '1', 'grass is all foliage');
  for (const mesh of PLANTS.map((n) => core.floraTree(KIND[n], 7, 2))) {
    for (let i = 0; i < mesh.verts; i++) {
      const p = mesh.part[i];
      assert.ok(p >= 0 && p <= 3, 'part ids stay inside the material slots');
    }
  }
});

test('the build requires the part channel, so a stale artifact cannot ship', async () => {
  assert.match(cppBuild, /'fe_flora_part_ptr'/, 'the wasm build must require fe_flora_part_ptr');
  assert.match(floraSource, /fe_flora_part_ptr|mesh\.part/, 'the bridge reads the part channel');
});

test('one call grows a plant and hands back geometry for every material slot', async () => {
  const { context } = await boot({ THREE });
  vm.runInContext(floraSource, context);
  const flora = context.FELandscapeFlora;
  assert.ok(flora.PLANT_KINDS.join(',').includes('palm'), 'the bridge publishes the plant kinds');
  assert.equal(flora.KINDS.length, 26, 'the species list must match the kernel table');
  const palm = flora.grownAsset('palm', 1234, 2);
  assert.ok(palm && palm.slots.length === 2, 'a palm feeds two material slots');
  assert.equal(palm.slots.map((g) => g.slot).join(','), '0,1', 'trunk then leaflets');
  for (const group of palm.slots) {
    const index = group.geometry.index;
    assert.ok(index.count > 0 && index.count % 3 === 0, 'every slot is a whole number of triangles');
    const verts = group.geometry.attributes.position.count;
    assert.ok(Array.from(index.array).every((i) => i < verts), 'slot indices stay inside the shared mesh');
  }
  /* Two slots, one upload: the geometries must share the attribute objects. */
  assert.equal(palm.slots[0].geometry.attributes.position, palm.slots[1].geometry.attributes.position,
    'slots share the vertex buffer');
  assert.equal(palm.slots[0].geometry.attributes.aSway, palm.slots[1].geometry.attributes.aSway,
    'and the wind channels');

  /* A one-material plant is passed through whole rather than split. */
  const saguaro = flora.grownAsset('saguaro', 77, 2);
  assert.ok(saguaro && saguaro.slots.length === 1 && saguaro.slots[0].slot === 0);
  assert.ok(saguaro.slots[0].geometry.index.count > 300, 'the whole cactus is one slot');

  /* A card-grown tree gets its wood from the mesh and its leaves from the
     card buffer the same call filled. */
  const oak = flora.grownAsset('oak', 99, 2);
  assert.ok(oak && oak.cards > 100, 'the oak must carry kernel-grown leaf cards');
  assert.equal(oak.slots.map((g) => g.slot).join(','), '0,1,2', 'wood, foliage, blossom');
  const blossom = oak.slots.find((g) => g.slot === 2);
  assert.ok(blossom && blossom.geometry.index.count > 0, 'the blossom slot is not empty');
  /* The two slots are different geometry: the trunk carries tubes, the crown
     carries quads, and neither is a copy of the other. */
  const wood = oak.slots[0].geometry.index.count, leaves = oak.slots[1].geometry.index.count;
  assert.ok(wood > 0 && leaves > 500, `wood ${wood} and leaves ${leaves} must both be real`);
  assert.ok(oak.slots[1].geometry.index.count % 6 === 0, 'leaf cards are whole quads');
  assert.ok(!oak.slots[0].geometry.index.array.includes(oak.slots[1].geometry.index.array[0]) ||
    oak.slots[0].geometry.attributes.position !== oak.slots[1].geometry.attributes.position,
    'wood and leaves are separate buffers');
});

test('the studio grows every plant and tree it places, and keeps the JS mesh until it can', () => {
  /* Every species the studio places is in the grown table, wired to the slots
     that species actually builds. Nothing is left drawing the old primitive. */
  const SPECIES = ['grass', 'tallgrass', 'daisy', 'tulip', 'lavender', 'pine', 'spruce', 'krumm',
    'juniper', 'saguaro', 'barrel', 'prickly', 'agave', 'joshua', 'sage', 'palm'];
  const table = models.slice(models.indexOf('const GROWN_PLANTS = {'), models.indexOf('function applyGrownPlants'));
  for (const name of SPECIES) {
    assert.match(table, new RegExp(`\\b${name}: \\{ slots: \\d`), `${name} must be grown in the kernel`);
  }
  /* Material slots match what the studio builds for each kind. */
  assert.match(table, /pine: \{ slots: 2, plan: \[\[0, 0\], \[1, 1\]\]/);
  assert.match(table, /grass: \{ slots: 1, plan: \[\[-1, 0\]\], seed: \d+, lawn: 1 \}/,
    'a lawn is instanced in the tens of thousands, so it uses the card-fidelity geometry');
  assert.match(table, /daisy: \{ slots: 4/, 'a flower feeds stem, leaf, petal and disc');

  /* Called right after the eager build so a ready kernel replaces the
     primitives on the first frame... */
  assert.match(models, /buildEager\(\);[\s\S]{0,400}applyGrownPlants\(\)/, 'the plants are grown straight after the eager build');
  /* ...and again when a lazily loaded kernel arrives, and when a lazy species
     is built for the first time. */
  assert.match(models, /c\.loading\.then\(\(\)=>\{[\s\S]{0,300}applyGrownPlants\(\)/, 'a late kernel still grows the plants');
  assert.match(models, /if\(GROWN_PLANTS\[k\]\)\{try\{applyGrownPlants\(k\)\}/, 'a lazily built species is grown the moment it exists');
  /* The primitive stays until the kernel answers: no species may be left
     without a mesh because the artifact was missing. */
  assert.match(models, /if \(!asset \|\| !asset\.slots/, 'a missing kernel keeps the previous geometry');
  assert.match(models, /adoptGeometry\(K, mesh, group\.geometry, lowFor\(group\.slot\)\)/, 'the grown mesh is swapped onto the instanced mesh');
  /* LOD and shadows follow the new geometry, or they keep the old silhouette. */
  assert.match(models, /low\.geometry = \(m\.userData && m\.userData\.lodGeom\) \|\| m\.geometry/,
    'the low-detail twin is rebuilt from the grown plant');
  assert.match(models, /proxy\.geometry = \(m\.userData && m\.userData\.lodGeom\) \|\| m\.geometry/,
    'the grass shadow proxy follows the grown blade');
  /* Trees get their leaves from the kernel too, with the old placer only as a
     fallback for an artifact older than the page. */
  assert.match(models, /const asset=f\.grownAsset\?f\.grownAsset\(kind\):null;/,
    'a tree grows its wood and leaves in one kernel call');
  assert.match(models, /Fallback: previous artifact, build the cards here/, 'the JS placer survives only as a fallback');
});
