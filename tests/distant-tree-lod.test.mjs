import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* Distant trees are the easiest place to lie about a forest. A billboard that
   takes over while a tree is still 60 px tall reads as cardboard; a full-detail
   mesh at 2 km is a frame budget given away for nothing. These tests pin the
   three tiers to on-screen size, in pixels, and prove the third tier is baked
   from the same grown mesh the near tiers draw. */

const wasm = readFileSync('fe_core_engine.wasm');
const bridge = readFileSync('terrain-main-01.js', 'utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const studio = readFileSync('terrain-main-03.js', 'utf8');
const impostor = readFileSync('cpp/src/fe_impostor.cpp', 'utf8');

/* The studio's camera, from terrain-main-04.js: fov 55, and the vertical field
   of view is what turns a tree's height into pixels. */
const FOV = 55;
const half = (FOV * Math.PI) / 360;
const pixelsAt = (metres, distance, viewport) => (metres / (2 * distance * Math.tan(half))) * viewport;

async function boot() {
  const context = {
    console, URL, WebAssembly, Float32Array, Uint8Array, Uint32Array, Int32Array, Math, Promise,
    setTimeout, TextDecoder, TextEncoder,
    document: { baseURI: 'https://example.test/Terrain_system_.html' },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
  };
  vm.createContext(context);
  vm.runInContext(bridge, context);
  await context.FELandscapeCore.loading;
  return context.FELandscapeCore;
}

const MID = 750; /* the shipped default of lodFullDistance */
const FAR = Math.max(MID + 60, Math.max(MID * 1.6, MID + 140)); /* exactly as sync() computes it */

test('the tiers switch at sizes a tree can hide in, measured in pixels', () => {
  /* A 12 m oak — the tallest broadleaf the studio grows — at the two boundaries,
     on a 1080p screen and on a phone held sideways. */
  for (const [label, viewport] of [['1080p', 1080], ['720p', 720], ['phone', 390]]) {
    const full = pixelsAt(12, MID, viewport);
    const imp = pixelsAt(12, FAR, viewport);
    assert.ok(full < 40, `${label}: full detail must not run past ${full.toFixed(1)} px`);
    assert.ok(imp < 14, `${label}: an impostor must not appear above ${imp.toFixed(1)} px`);
    assert.ok(imp > 1, `${label}: ...but it must still be worth drawing (${imp.toFixed(1)} px)`);
  }
  /* Ground cover is much shorter, so its view radius is smaller: a lawn tuft must
     not survive as a billboard for a kilometre either. */
  const radius = studio.match(/const mid=lodFullDistance,radius=VIEW_RADIUS\[k\]\|\|2600,far=/);
  assert.ok(radius, 'the far radius still derives from the species view radius');
  assert.match(studio, /far=Math\.max\(mid\+60,Math\.min\(radius,Math\.max\(mid\*1\.6,mid\+140\)\)\)/,
    'and it is 1.6x the full-detail radius, not a fixed ring');
});

test('the kernel assigns three tiers, monotonically, with no hard ring of popping', async () => {
  const core = await boot();
  const count = 600;
  const xyz = new Float32Array(count * 3);
  const distances = [];
  for (let i = 0; i < count; i++) {
    /* A line of instances walking away from the camera out to 3 km, so every
       band is sampled with the real quadtree cull in front of it. */
    const d = 8 + (i / count) * 3000;
    xyz[i * 3] = ((i % 7) - 3) * 2;
    xyz[i * 3 + 1] = -0.5;
    xyz[i * 3 + 2] = -d;
    distances.push(Math.hypot(xyz[i * 3], xyz[i * 3 + 1] - 2, xyz[i * 3 + 2]));
  }
  const fov = (55 * Math.PI) / 180, aspect = 1, near = 0.1, far = 20000;
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0, -2, -0, 1];
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += proj[k * 4 + r] * view[c * 4 + k];
      vp[c * 4 + r] = sum;
    }
  }
  const result = core.lodTree({
    slot: 0, count, xyz, generation: 1, vp, camX: 0, camY: 2, camZ: 0,
    mid: MID, far: FAR, radius: 3200, margin: 8, options: 0
  });
  assert.ok(result && result.count > 200, `the quadtree must return a visible list (got ${result && result.count})`);

  const band = Math.max(120, MID * 2);
  const seen = new Set();
  for (let i = 0; i < result.count; i++) {
    const src = result.indices[i];
    const d = distances[src];
    /* 255 is the kernel's "culled" marker for an instance inside a kept node. */
    const tier = result.tiers[i];
    if (tier === 255) continue;
    seen.add(tier);
    assert.ok(tier <= 2, `a live instance has tiers 0..2 (got ${tier})`);
    if (tier === 2) assert.ok(d > FAR, `a ${d.toFixed(0)} m tree must not be a billboard before ${FAR} m`);
    if (tier === 1) assert.ok(d > MID, `the low mesh may not start inside ${MID} m`);
  }
  /* All three bands are in use: no tier is dead code. */
  for (const tier of [0, 1, 2]) assert.ok(seen.has(tier), `tier ${tier} must appear in a 3 km view`);

  /* The camera is what moves in the studio; the instance stays where it was
     planted. (Moving the tree instead would change the hash it is dithered by,
     which is not something the runtime ever does.) As the camera backs away the
     tier may only stay or deepen. */
  let previous = -1;
  const planted = new Float32Array([0, -0.5, 0]);
  for (const d of [300, 600, 750, 900, 1100, 1300, 1600, 2000, 2400, 3000]) {
    const eyeView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, -d, 1];
    const eyeVp = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += proj[k * 4 + r] * eyeView[c * 4 + k];
        eyeVp[c * 4 + r] = sum;
      }
    }
    const res = core.lodTree({
      slot: 0, count: 1, xyz: planted, generation: 2, vp: eyeVp, camX: 0, camY: 2, camZ: d,
      mid: MID, far: FAR, radius: 3200, margin: 1, options: 0
    });
    assert.ok(res && res.count === 1, `the tree ${d} m behind the camera must still be drawn`);
    const tier = res.tiers[0];
    assert.ok(tier >= previous, `backing away may never add detail (${d} m: ${tier} after ${previous})`);
    previous = tier;
  }
  assert.equal(previous, 2, 'at 2.5 km the tree is a billboard');
});

test('a far tree is the same tree, baked — not a billboard sprite', async () => {
  const core = await boot();
  assert.ok(typeof core.impostor === 'function', 'the studio asks the kernel to bake the atlas');
  const atlas = core.impostor(0, 4242, 2, 8);
  assert.ok(atlas && atlas.views >= 4, 'at least four azimuths are baked');
  /* One column per view. The whole point is that a tree is only a billboard when
     it is a few pixels tall, so the column has to be far sharper than the screen
     will ever show it: 64 px of crown for a 10 px tree is not what cardboard is
     made of. */
  /* `width` is one azimuth's tile; the texture the studio uploads is
     width x views wide, so a column is a full 64 px of crown even though the
     tree it stands in for is only a handful of pixels tall. */
  const column = atlas.width;
  assert.ok(column >= 48, `${column} px per azimuth is too coarse to survive a zoom`);
  assert.ok(atlas.views * column <= 1024, 'the whole atlas still fits in one texture');
  assert.ok(atlas.height >= 96, `the atlas is only ${atlas.height} px tall`);
  /* The quad follows the baked silhouette instead of a fixed card, so a wide
     acacia and a narrow spruce are not drawn on the same square. */
  assert.ok(atlas.quadW > 0 && atlas.quadH > 0, 'the bake reports the quad the studio draws');
  assert.ok(atlas.cropU > 0.2 && atlas.cropU <= 1, 'and the part of the tile the plant occupies');
  /* Coverage is the fraction of the column the plant actually paints: an empty
     atlas would mean a far forest of blanks. */
  assert.ok(atlas.coverage > 0.05, `the bake must actually contain the tree (coverage ${atlas.coverage.toFixed(2)})`);
  /* The bake reads the grown mesh: wood and leaf cards both, through the same
     private accessors the mesher fills. */
  assert.match(impostor, /fe_flora_geom::verts\(\)/, 'the bake reads the grown wood mesh');
  assert.match(impostor, /fe_flora_geom::card_verts\(\)/, 'and the leaf cards grown with it');
  assert.match(impostor, /rasterSurface\(pos, nrm, col, fe_flora_geom::idx\(\)/, 'the wood is rasterised, not sampled from a photo');
  /* ...and the column is chosen by the same formula on both sides. */
  assert.match(studio, /float u=a\/\(6\.28318530718\/uViews\);/, 'the shader picks its azimuth column the way the kernel bakes them');
  assert.match(impostor, /FE_EXPORT int32_t fe_impostor_column\(float cam_dx, float cam_dz\)/,
    'the kernel owns the column formula so the two cannot drift');
});

test('impostors are a setting, and turning them off leaves the low mesh in place', () => {
  assert.match(studio, /const IMPOSTOR_KEY='final3d\.impostors\.v1'/, 'the setting persists');
  assert.match(studio, /function setImpostors\(on\)/, 'and can be switched at runtime');
  assert.match(studio, /if\(k===undefined\)return;/, 'a bake for a species with no far instances is not run');
  assert.match(studio, /if\(!K\|\|K\.impMesh\|\|!K\.list\.length\)return/, 'and one atlas per species is enough');
  /* The bake happens off the frame: never inline in the render loop. */
  assert.match(studio, /IMPOSTOR_INFLIGHT=2/, 'at most two bakes are in flight');
  assert.match(studio, /f\.impostorAsync\(k,seed,detail\)\.then/, 'the atlas is baked through the kernel worker');
});
