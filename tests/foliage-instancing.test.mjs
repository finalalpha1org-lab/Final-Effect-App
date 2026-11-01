import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* Trees never reached the screen.
 *
 * A species has three geometry variants, and every instance is assigned to one
 * of them by a hash of its position. `sync()` walks the visible instances once
 * per mesh and skipped the ones that belong to another variant - with `return`,
 * which leaves the whole callback. So a variant mesh drew the leading run of
 * instances that happened to match it and then stopped for good: with a random
 * hash the first instance almost never matched, and the island rendered with
 * grass, flowers, and not one tree, rock or house on it.
 *
 * The whole point of that loop is to distribute the instances, so the test is
 * a count: every tree in the list has to end up on some mesh. */

const src = readFileSync('terrain-main-03.js', 'utf8');
const SYNC = (() => {
  const start = src.indexOf('function sync(k,allInstances=false){');
  const end = src.indexOf('\nconst LOD_KINDS=', start);
  assert.ok(start > 0 && end > start, 'sync() is no longer where this test expects it');
  return src.slice(start, end);
})();

function harness(count = 32) {
  const KIND = {};
  class Inst extends THREE.InstancedMesh {
    constructor(g, m, n) { super(g, m, n); this.count = 0; }
  }
  const list = [];
  for (let i = 0; i < count; i++) list.push({ x: i * 2.3 - 20, y: 0, z: (i % 7) * 3, s: 1, r: 0, a: 1, v: 1 });
  const meshes = [0, 1, 2].flatMap((vi) => [0, 1].map((part) => {
    const m = new Inst(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), count * 3);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 9).fill(1), 3);
    m.userData = { vn: 3, vi, part };
    return m;
  }));
  KIND.oak = { list, max: count * 3, size: 1.7, meshes, shadowMeshes: [], vr: .35, tint: [1, 1, 1] };
  const camera = new THREE.PerspectiveCamera(55, 1, .5, 5000);
  camera.position.set(0, 20, 60);
  const ctx = {
    THREE, KIND,
    LOD_GROUND: new Set(['grass']), LOD_BOTANICAL: new Set(['oak']), LOD_TREES: new Set(['oak']),
    LOD_KINDS: new Set(['oak']), IMPOSTOR_KINDS: new Set(), FLORA_SLOT: { oak: 0 },
    RK: {}, BLD: {}, NT: {}, ROOT_SPAN: { oak: 4.4 }, TREE_SIZE_MIN: {}, TREE_SIZE_MAX: {}, SPACING_KINDS: new Set(),
    VIEW_RADIUS: { oak: 2400 }, SHADOW_PROXY_STRIDE: 8, lodFullDistance: 750,
    hh: (x, z) => { const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return v - Math.floor(v); },
    vn: () => .5, cl: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    hgt: () => 0, groundNormal: () => new THREE.Vector3(0, 1, 0),
    GROUND_UP: new THREE.Vector3(0, 1, 0), GROUND_Q: new THREE.Quaternion(), GROUND_N: new THREE.Vector3(), GROUND_E: new THREE.Euler(),
    cam: camera, vpMat: null, lodScratch: new Float32Array(0), impostorsOn: true, impostorWanted: new Set(),
    requestImpostor() {}, shadowPadFor: () => 0, treeMapDirty: false, lodPending: false,
    dm: new THREE.Object3D(), dmi: new THREE.Object3D(), tcol: new THREE.Color(),
    window: {}, detail: 2, nowMs: () => 0, lowMeshesFor: () => null,
  };
  const sync = new Function(...Object.keys(ctx), SYNC + ';return sync')(...Object.values(ctx), { ready: false });
  return { sync, KIND, meshes, list };
}

/* Which variant an instance got, exactly as sync() decides it. */
const variantOf = (o) => {
  const v = Math.sin(o.x * 1.7 * 12.9898 + o.z * 2.3 * 78.233) * 43758.5453;
  return ((v - Math.floor(v)) * 997 | 0) % 3;
};

test('every tree instance is submitted, not just the matching prefix', () => {
  const { sync, KIND, meshes, list } = harness(96);
  sync('oak', true);
  /* Each instance is drawn once per part mesh of its own variant. */
  let submitted = 0;
  meshes.forEach((m) => { submitted += m.count; });
  assert.ok(submitted >= list.length, `${submitted} instance slots submitted for ${list.length} trees`);
  /* No variant mesh may be empty: that is the signature of the aborted loop. */
  meshes.forEach((m) => {
    const owns = list.filter((o) => variantOf(o) === m.userData.vi).length;
    assert.ok(owns > 0, 'the test data must spread instances across variants');
    assert.equal(m.count, owns, `variant ${m.userData.vi} part ${m.userData.part} drew ${m.count} of its ${owns} trees`);
  });
});

test('the variant assignment is shared, not first-match-wins', () => {
  const { sync, meshes, list } = harness(96);
  sync('oak', true);
  /* Sum of the first-variant meshes equals the number of instances assigned to
     that variant: the loop visited the whole list for that mesh. */
  const v0 = meshes.filter((m) => m.userData.vi === 0);
  const owns = list.filter((o) => variantOf(o) === 0).length;
  v0.forEach((m) => assert.equal(m.count, owns));
  assert.ok(owns > 10, `variant 0 owns ${owns} of ${list.length} trees`);
});
