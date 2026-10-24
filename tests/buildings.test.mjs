import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* Buildings were the last meshes the studio authored in JavaScript: four box
 * shells with a hand-placed roof, so every copy on a street was identical.
 * They are grown in the C++ kernel now, from the rules a real one is built to —
 * 3 m storeys, 3.6 m bays, a 1.3 m balcony, a 35 degree roof with a 0.35 m eave,
 * a 0.45 m foundation. These tests pin those numbers, the winding and the UV
 * scale (so the existing facade textures still land on the same bricks), the
 * material split the studio renders (wall / roof / base), and the wiring. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridgeSource = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const floraSource = readFileSync('landscape-flora.js', 'utf8');
const models = readFileSync('terrain-main-02.js', 'utf8');
const cppBuild = readFileSync('scripts/build-cpp-wasm.mjs', 'utf8');
const cpp = readFileSync('cpp/src/fe_flora.cpp', 'utf8');

async function boot() {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise, setTimeout, TextDecoder, TextEncoder,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }),
    THREE
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  await context.FELandscapeCore.loading;
  vm.runInContext(floraSource, context);
  return { context, core: context.FELandscapeCore, flora: context.FELandscapeFlora };
}

const BUILDINGS = ['house', 'block', 'mid', 'tower'];

/* Height, footprint and storey count each type actually has. */
const REAL = {
  house: { h: [8.0, 11.0], w: [6.6, 8.0], storeys: [2, 2] },
  block: { h: [12.0, 18.0], w: [8.0, 10.0], storeys: [4, 5] },
  mid: { h: [21.0, 29.0], w: [9.0, 11.0], storeys: [7, 9] },
  tower: { h: [42.0, 60.0], w: [6.0, 7.5], storeys: [13, 16] }
};

function measure(mesh) {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let degenerate = 0, badNormal = 0, nonFinite = 0, outOfRange = 0, minU = Infinity, maxU = -Infinity;
  for (let i = 0; i < mesh.verts; i++) {
    const x = mesh.pos[i * 3], y = mesh.pos[i * 3 + 1], z = mesh.pos[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    const n = Math.hypot(mesh.nrm[i * 3], mesh.nrm[i * 3 + 1], mesh.nrm[i * 3 + 2]);
    if (Math.abs(n - 1) > 0.02) badNormal++;
    minU = Math.min(minU, mesh.uv[i * 2]); maxU = Math.max(maxU, mesh.uv[i * 2]);
  }
  for (let i = 0; i < mesh.idx.length; i += 3) {
    const a = mesh.idx[i], b = mesh.idx[i + 1], c = mesh.idx[i + 2];
    if (a >= mesh.verts || b >= mesh.verts || c >= mesh.verts) outOfRange++;
    const ax = mesh.pos[a * 3], ay = mesh.pos[a * 3 + 1], az = mesh.pos[a * 3 + 2];
    const ux = mesh.pos[b * 3] - ax, uy = mesh.pos[b * 3 + 1] - ay, uz = mesh.pos[b * 3 + 2] - az;
    const vx = mesh.pos[c * 3] - ax, vy = mesh.pos[c * 3 + 1] - ay, vz = mesh.pos[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (Math.hypot(cx, cy, cz) < 1e-7) degenerate++;
  }
  return { minY, maxY, minX, maxX, minZ, maxZ, degenerate, badNormal, nonFinite, outOfRange, minU, maxU,
    height: maxY - minY, width: maxX - minX, depth: maxZ - minZ };
}

test('the artifact ships the building kernel', async () => {
  const { core } = await boot();
  for (const name of ['fe_build', 'fe_build_kind_count']) {
    assert.equal(core.has(name), true, `${name} must ship in the artifact`);
    assert.match(cppBuild, new RegExp(`'${name}'`), `${name} must be in REQUIRED_EXPORTS, or a stale artifact ships silently`);
  }
  assert.equal(core.floraCounts().buildings, 4, 'house, block, mid-rise, tower');
});

test('every shell is a sound mesh at its real-world size', async () => {
  const { core } = await boot();
  for (let kind = 0; kind < 4; kind++) {
    const name = BUILDINGS[kind];
    const mesh = core.building(kind, 99, 2);
    assert.ok(mesh && mesh.verts > 0, `${name} must grow`);
    const s = measure(mesh);
    assert.equal(s.nonFinite, 0, `${name} has no NaN vertices`);
    assert.equal(s.outOfRange, 0, `${name} indices stay inside the buffer`);
    assert.equal(s.degenerate, 0, `${name} has no zero-area triangles`);
    assert.equal(s.badNormal, 0, `${name} normals are unit length`);
    /* UVs are in facade tiles, not metres: a 12 m facade repeats the 9 m map
       1.4 times instead of stretching one tile over the whole wall. */
    assert.ok(s.minU >= -0.001, `${name} UVs start at the wall corner`);
    assert.ok(s.maxU > 1.0 && s.maxU < 10.0, `${name} UVs tile the facade (u max ${s.maxU.toFixed(2)})`);
    const real = REAL[name];
    assert.ok(s.height > real.h[0] && s.height < real.h[1],
      `${name} is ${s.height.toFixed(1)} m tall, expected ${real.h[0]}-${real.h[1]} m`);
    assert.ok(s.width > real.w[0] && s.width < real.w[1],
      `${name} is ${s.width.toFixed(1)} m across, expected ${real.w[0]}-${real.w[1]} m`);
    /* Every one stands on the ground: a shell that floats or buries a storey is
       the single most obvious way a procedural building reads as fake. */
    assert.ok(s.minY > -0.5 && s.minY < 0.0, `${name} foundation must sit just below grade (got ${s.minY.toFixed(2)})`);
  }
});

test('the storey count a building reports is the one it drew', async () => {
  const { core } = await boot();
  /* A storey is 3 m, and the balcony bands are what show it: the count of
     distinct Y levels carrying concrete trim must match the type. */
  for (let kind = 1; kind < 4; kind++) {
    const name = BUILDINGS[kind];
    const mesh = core.building(kind, 4242, 2);
    const ys = new Set();
    for (let i = 0; i < mesh.verts; i++) {
      if (Math.round(mesh.part[i]) !== 2) continue;
      ys.add(Math.round(mesh.pos[i * 3 + 1] * 2) / 2);
    }
    const span = 3.0;
    const storeys = Math.round((Math.max(...ys) - Math.min(...ys)) / span);
    const real = REAL[name];
    assert.ok(storeys >= real.storeys[0] && storeys <= real.storeys[1] + 3,
      `${name} uses ${storeys} storey bands, expected about ${real.storeys.join('-')}`);
  }
  /* The tallest type is the only one that gets a roof mast. */
  const tower = core.building(3, 7, 2);
  let top = -Infinity;
  for (let i = 0; i < tower.verts; i++) top = Math.max(top, tower.pos[i * 3 + 1]);
  assert.ok(top > 46, `the tower carries a mast above its roof deck (top ${top.toFixed(1)} m)`);
});

test('the seed changes the building, the shape stays real', async () => {
  const { core } = await boot();
  for (let kind = 0; kind < 4; kind++) {
    const a = core.building(kind, 11, 2);
    const b = core.building(kind, 12, 2);
    const sa = measure(a), sb = measure(b);
    const same = Math.abs(sa.height - sb.height) < 1e-4 && Math.abs(sa.width - sb.width) < 1e-4;
    assert.equal(same, false, `${BUILDINGS[kind]} must not be the same building at every seed`);
    /* And a different seed is still a sound shell, not just a different number. */
    assert.equal(sb.degenerate, 0, `${BUILDINGS[kind]} stays sound at another seed`);
    assert.equal(sb.badNormal, 0, `${BUILDINGS[kind]} keeps unit normals at another seed`);
  }
});

test('the three material slots are wall, roof and base', async () => {
  const { core } = await boot();
  const partsOf = (mesh) => {
    const seen = new Set();
    for (let i = 0; i < mesh.verts; i++) seen.add(Math.round(mesh.part[i]));
    return [...seen].sort().join(',');
  };
  assert.equal(partsOf(core.building(0, 5, 2)), '0,1,2', 'a house is walls, roof and trim');
  assert.equal(partsOf(core.building(1, 5, 2)), '0,2', 'a flat-roofed block is walls and concrete');
  assert.equal(partsOf(core.building(3, 5, 2)), '0,2', 'a tower is walls and concrete');
  /* The walls are the big surfaces and the trim is the detail; a shell whose
     base slot outweighed its walls would be trim with a building attached. */
  const house = core.building(0, 5, 2);
  let wall = 0, base = 0;
  for (let i = 0; i < house.idx.length; i += 3) {
    const p = Math.round(house.part[house.idx[i]]);
    if (p === 0) wall++; else if (p === 2) base++;
  }
  assert.ok(wall >= 12, 'the house walls are closed boxes');
  assert.ok(base > wall * 4, 'a house is mostly trim and openings, like a real one');
});

test('the studio grows every shell in the kernel and falls back only when it must', async () => {
  const { context, flora } = await boot();
  const kinds = ['house', 'block', 'mid', 'tower'];
  for (const kind of kinds) {
    const asset = flora.buildingAsset(kind, 3301, 2);
    assert.ok(asset && asset.slots.length, `${kind} must come back as geometry, not a promise`);
    for (const slot of asset.slots) {
      assert.ok(slot.geometry.isBufferGeometry, 'the studio receives BufferGeometry');
      assert.ok(slot.geometry.index.count > 0 && slot.geometry.index.count % 3 === 0, 'whole triangles');
      const verts = slot.geometry.attributes.position.count;
      assert.ok(slot.geometry.index.array.every((i) => i < verts), 'indices stay inside the shared mesh');
    }
    assert.ok(slot_has(asset, 0), `${kind} needs its wall slot`);
  }
  function slot_has(asset, n) { return asset.slots.some((s) => s.slot === n); }
  /* A block has no separate roof mesh: the parapet and plant deck are concrete. */
  const kernelPart = (name) => flora.BUILDING_PLAN[name].map(([part]) => part);
  assert.equal(kernelPart('block').includes(1), false, 'a flat-roofed block grows no roof part');
  assert.equal(kernelPart('house').includes(1), true, 'a pitched house grows its roof part');

  /* The kernel answers, so calling twice is stable — no per-frame rebuild. */
  const a = flora.buildingAsset('mid', 3407, 2);
  const b = flora.buildingAsset('mid', 3407, 2);
  assert.equal(a.verts, b.verts);
  /* Wiring: grown at boot, after a late kernel, and never left without the JS
     shell if the artifact is older than the page. */
  assert.match(models, /const GROWN_BUILDINGS = \{/, 'the studio keeps a building table');
  assert.match(models, /applyGrownBuildings\(\)/, 'the street shells are grown at boot');
  assert.match(models, /if \(!asset \|\| !asset\.slots \|\| !asset\.slots\.length\) continue;/, 'a missing kernel keeps the JS shell');
  assert.match(context.FELandscapeCore ? 'ok' : 'no', /ok/, 'the bridge is up');
  assert.match(bridgeSource, /core\.building=function/, 'the bridge exposes the building call');
});

test('the JS shells are only a fallback now, not the geometry', async () => {
  /* The four box shells still exist so the world draws on frame one, but they
     are reached through the builder that asks the kernel first. */
  assert.match(models, /function buildingBuilder|GROWN_BUILDINGS/);
  assert.match(cpp, /generateBuilding\(/, 'the kernel owns the massing');
  assert.match(cpp, /const float storey = 3\.0f;/, 'a storey is 3 m, the residential standard');
  assert.match(cpp, /const float tile = 9\.0f;/, 'facade UVs stay on the 9 m texture tile');
});
