import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* How much vegetation a real island actually receives.
 *
 * The studio's scatter was reporting "a forest" while placing 45 trees on a
 * 7 261 m2 island - one tree per 161 m2 - and every one of them on flat ground,
 * because the slope gate rejected 0.6 and every tree footprint kept a 16 m
 * circle clear of *everything*, undergrowth included. Numbers like that do not
 * show up in a screenshot diff, so this test boots the real kernel, evaluates
 * the real placement gate and the real scatter() straight out of the shipped
 * source, and counts what comes out.
 *
 * Everything here is deterministic: the placement randomness is injected as a
 * seeded generator, and the kernel is seeded from the terrain seed. */

const sceneFile = readFileSync('terrain-main-01.js', 'utf8');
const scatterFile = readFileSync('terrain-main-03.js', 'utf8');
const src = scatterFile.split('\n');
const at = (prefix) => {
  const i = src.findIndex((line) => line.startsWith(prefix));
  assert.ok(i >= 0, `scatter source no longer contains a line starting with ${prefix}`);
  return i;
};
const slice = (a, b) => src.slice(a, b).join('\n');

const gate = slice(at('const mAt='), at('const BTAB=') + 1);
const ruleExtra = slice(at('Object.assign(RULE,{'), at('const FP=') - 1);
const addSrc = slice(at('function add(k,x,z'), at('const RATE='));
const scatterSrc = slice(at('function scatter(kb)'), at('function resnap()'));
const treeScale = sceneFile.match(/TREE_SIZE_SCALE=\{[^}]*\}/)[0];
const TREE_SIZE = new Function(`${treeScale};return TREE_SIZE_SCALE`)();

const WASM = 'wasm/fe_core_engine.wasm';
const N = 128, S = 200, W = N + 1, D = S / N, SEED = 12345, WL = 0, SNOW = 16;

async function boot() {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  const ex = instance.exports;
  assert.equal(ex.fe_terrain_init(N, S), 0);
  const palPtr = ex.fe_malloc(96);
  const pal = [.28,.5,.16,.42,.29,.17,.42,.42,.44,.64,.56,.38,.92,.94,.98,.64,.56,.38,.13,.13,.14].map((v) => Math.pow(v, 2.2));
  new Float32Array(ex.memory.buffer, palPtr, 21).set(pal);
  ex.fe_terrain_set_palette(palPtr, 7, SEED, WL, 1.3, SNOW, 0);
  ex.fe_terrain_generate_layered(SEED, 34, 0, 0, 0);
  const H = new Float32Array(ex.memory.buffer, ex.fe_terrain_get_height_ptr(), W * W);
  return { ex, H };
}

/* mulberry32: the placement gate and scatter() both draw from `R`, so seeding it
   makes the whole run reproducible. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run() {
  await import('../scatter-spacing.js');
  const { ex, H } = await boot();
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7 + SEED) * 43758.5453; return s - Math.floor(s); };
  const vn = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return hash(ix, iy) * (1 - u) * (1 - v) + hash(ix + 1, iy) * u * (1 - v) + hash(ix, iy + 1) * (1 - u) * v + hash(ix + 1, iy + 1) * u * v;
  };
  const hgt = (x, z) => {
    const u = cl((x + S / 2) / D, 0, N - .001), v = cl((z + S / 2) / D, 0, N - .001);
    const i = u | 0, j = v | 0, a = u - i, b = v - j, k = j * W + i;
    return H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + W] * (1 - a) * b + H[k + W + 1] * a * b;
  };
  const slopeAt = (i, j) => {
    const i0 = Math.max(0, i - 2), i1 = Math.min(N, i + 2), j0 = Math.max(0, j - 2), j1 = Math.min(N, j + 2);
    return Math.hypot((H[j * W + i1] - H[j * W + i0]) / ((i1 - i0) * D), (H[j1 * W + i] - H[j0 * W + i]) / ((j1 - j0) * D));
  };
  /* terrain-main-01's material rule, unchanged. */
  const mIdx = (i, j) => {
    const k = j * W + i, h = H[k], n = vn(i * .071 + SEED * .17, j * .071 - SEED * .11), cliff = 1.3 + (.5 - n) * .55;
    if (h < WL + .35 + n * .55) return 3;
    if (h > SNOW - 1 + (n - .5) * 2.2) return 4;
    if (slopeAt(i, j) > cliff) return 2;
    if (h > 9 + (n - .5) * 4) return 1;
    return 0;
  };
  const KIND = {};
  const scope = {
    KIND, hgt, vn, cl, S, wl: WL, snowL: SNOW, N, H, D, W, seed: SEED,
    R: seeded(20240211), veg: 1, scatterDensity: 1, scatterClustering: .35, shallowBrushDepth: 1.5,
    SCATTER_BATCH: 4096, biome: 'hills', detail: 2, OW: null, mIdx, TREE_SIZE_SCALE: TREE_SIZE,
    br: { minGap: .25, kind: 'grass', r: 4, den: 10 },
    ScatterSpacing: globalThis.ScatterSpacing,
    ensure: (n) => (KIND[n] || (KIND[n] = { list: [], max: 1e9, size: TREE_SIZE[n] || 1, vr: .35 })),
    growManualCapacity: () => false, debClear: () => {}, sync: () => {}, clearUnderB: () => {},
  };
  const harvest = (ptr, count) => new Float32Array(ex.memory.buffer, ptr, count * 4);
  const api = new Function(
    ...Object.keys(scope), 'window',
    `${treeScale};${gate};${ruleExtra};${addSrc};${scatterSrc};
     return { scatter, KIND, RULE, FP };`,
  )(...Object.values(scope), {
    FELandscapeCore: {
      ready: true,
      /* The terrain is already resident: re-initialising here would hand back a
         fresh zeroed grid and every candidate would be rejected as seabed. */
      scatterBegin: () => true,
      scatterBatch: ({ count, spread, seed, output }) => {
        const got = ex.fe_terrain_scatter_batch(count, spread, (seed >>> 0) || 1);
        if (got > 0) output.set(harvest(ex.fe_terrain_scatter_out_ptr(), got));
        return got;
      },
      scatterNatural: ({ count, spread, seed, water, maxSlope, clump, patch, output }) => {
        const got = ex.fe_terrain_scatter_natural(count, spread, (seed >>> 0) || 1, water, maxSlope, clump, patch);
        if (got > 0) output.set(harvest(ex.fe_terrain_scatter_out_ptr(), got));
        return got;
      },
    },
  });
  api.scatter();
  const land = [...H].filter((h) => h > WL + .25).length * D * D;
  const trees = ['pine', 'oak', 'birch', 'palm'].flatMap((k) => api.KIND[k]?.list || []);
  const count = (k) => api.KIND[k]?.list.length || 0;
  return { api, land, trees, count, hgt };
}

const world = await run();

test('a hills island carries a wood, not a handful of trees', () => {
  const trees = world.trees.length;
  const perTree = world.land / Math.max(1, trees);
  assert.ok(trees >= 140, `only ${trees} trees on ${Math.round(world.land)} m2 of island (one per ${Math.round(perTree)} m2)`);
  assert.ok(perTree < 70, `one tree per ${Math.round(perTree)} m2 still reads as scattered clumps`);
  for (const kind of ['pine', 'oak', 'birch', 'palm']) {
    assert.ok(world.count(kind) > 0, `${kind} never appears`);
  }
  /* Oak holds the largest crown, so it is the first species the old footprint
     rule starved: three of them made it onto the whole island. */
  assert.ok(world.count('oak') >= 12, `oak is still starved: ${world.count('oak')}`);
});

test('trees stand on the hillsides, not only on the flats', () => {
  const steep = world.trees.filter((o) => {
    const dz = world.hgt(o.x, o.z + 1) - world.hgt(o.x, o.z - 1);
    const dx = world.hgt(o.x + 1, o.z) - world.hgt(o.x - 1, o.z);
    return Math.hypot(dx, dz) / 2 >= .6;
  }).length;
  assert.ok(steep >= world.trees.length * .35,
    `${steep}/${world.trees.length} trees are on slopes of 31 degrees or more; a wood survives on hillsides`);
});

test('no quarter of the island is left without trees', () => {
  const CELL = 25, cells = new Map();
  for (const o of world.trees) {
    const key = `${Math.floor(o.x / CELL)},${Math.floor(o.z / CELL)}`;
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  const landCells = new Set();
  for (let x = -96; x < 96; x += 6) for (let z = -96; z < 96; z += 6) {
    if (world.hgt(x, z) > .25) landCells.add(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
  }
  let bare = 0;
  for (const cell of landCells) if (!cells.get(cell)) bare++;
  assert.ok(landCells.size > 15, 'the test island should have land');
  assert.ok(bare / landCells.size <= .15, `${bare}/${landCells.size} land cells of 25 m have no tree at all`);
});

test('boulders and undergrowth are no longer evicted by the first tree', () => {
  assert.ok(world.count('rock') >= 110, `only ${world.count('rock')} rocks`);
  assert.ok(world.count('shrub') >= 900, `only ${world.count('shrub')} shrubs`);
  const flowers = world.count('flower') + world.count('daisy') + world.count('tulip') + world.count('lavender');
  assert.ok(flowers >= 20000, `only ${flowers} wildflowers`);
});

test('nothing in the scatter is planted under water', () => {
  for (const kind in world.api.KIND) {
    const worst = world.api.KIND[kind].list.reduce((m, o) => Math.min(m, o.y), Infinity);
    if (worst === Infinity) continue;
    assert.ok(worst >= WL - .35, `${kind} has an instance at y=${worst.toFixed(2)}, below the water line`);
  }
});
