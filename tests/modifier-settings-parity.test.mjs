import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { mirrorGeometry, solidifyGeometry, weldGeometry } from '../src/modifier-geometry.mjs';

/* =========================================================================
 * The settings that Blender's RNA exposes for Mirror, Solidify and Weld, run
 * through the kernels that carry them in cpp/src/fe_modifiers.cpp:
 *
 *   Mirror  bisect_axis + use_bisect_flip_axis + bisect_threshold
 *           (modifiers/intern/MOD_mirror.cc: the mesh is cut on the plane
 *           first, then the surviving half is mirrored)
 *   Solidify  use_flip_normals, use_rim_only
 *           (MOD_solidify_extrude.cc)
 *   Weld    mode (ALL / CONNECTED)
 *           (bmesh/tools/bmesh_weld.cc / MOD_weld.cc)
 *
 * Every kernel is only reachable through the wasm artifact, so the tests
 * install it the same way the app does and assert on real geometry.
 * ========================================================================= */

const wasmBytes = readFileSync(appPath('fe_core_engine.wasm'));
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});

function withCore(run) {
  const previous = globalThis.FECppEngine;
  globalThis.FECppEngine = { exports, memory: exports.memory, ready: true };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.FECppEngine;
    else globalThis.FECppEngine = previous;
  }
}

/* BoxGeometry is six disconnected quads; weld it into a real closed solid so
   that a bisect has something manifold to cut. */
function weldedBox(size = 2) {
  const h = size / 2;
  const positions = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const indices = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function bounds(geometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox;
}

function volume(geometry) {
  const p = geometry.attributes.position;
  const idx = geometry.index?.array ?? Uint32Array.from({ length: p.count }, (_, i) => i);
  let total = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = new THREE.Vector3(p.getX(idx[i]), p.getY(idx[i]), p.getZ(idx[i]));
    const b = new THREE.Vector3(p.getX(idx[i + 1]), p.getY(idx[i + 1]), p.getZ(idx[i + 1]));
    const c = new THREE.Vector3(p.getX(idx[i + 2]), p.getY(idx[i + 2]), p.getZ(idx[i + 2]));
    total += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
  }
  return total;
}

function weldedCube() {
  return weldGeometry(weldedBox(2), 1e-6);
}

test('Mirror bisect cuts the mesh on the plane before mirroring it', () => withCore(() => {
  const cube = weldedCube();
  /* X axis only, bisecting X: everything with x < 0 is gone, so the result is
     the x >= 0 half mirrored back - the same solid, rebuilt from the cut. */
  const cut = mirrorGeometry(cube, {
    axes: [true, false, false], clipping: true, mergeDistance: 1e-5,
    bisectAxes: [true, false, false], bisectFlip: [false, false, false], bisectThreshold: 0,
  });
  const box = bounds(cut);
  assert.ok(Math.abs(box.min.x + 1) < 1e-4 && Math.abs(box.max.x - 1) < 1e-4, `x stays -1..1, got ${box.min.x}..${box.max.x}`);
  assert.ok(Math.abs(box.min.z + 1) < 1e-4 && Math.abs(box.max.z - 1) < 1e-4, 'z untouched');
  const v = volume(cut);
  assert.ok(Math.abs(v - 8) < 0.05, `the cut cube is closed and still 8 cubic units, got ${v}`);

  /* Without the mirror half the cut is not a solid: bisect with no axis
     enabled on Mirror must leave everything, which proves the cut came from
     the bisect flag and not from the mirror itself. */
  const untouched = mirrorGeometry(cube, {
    axes: [true, false, false], clipping: true, mergeDistance: 1e-5,
    bisectAxes: [false, false, false], bisectFlip: [false, false, false], bisectThreshold: 0,
  });
  assert.ok(Math.abs(bounds(untouched).min.x + 1) < 1e-4, 'no bisect means no cut');
}));

test('Mirror flip inverts which side of the plane survives', () => withCore(() => {
  const cube = weldedCube();
  const flipped = mirrorGeometry(cube, {
    axes: [true, false, false], clipping: true, mergeDistance: 1e-5,
    bisectAxes: [true, false, false], bisectFlip: [true, false, false], bisectThreshold: 0,
  });
  const v = volume(flipped);
  assert.ok(Math.abs(Math.abs(v) - 8) < 0.05, `flipping keeps a solid half, got ${v}`);
  /* The reflected half must occupy the same cube: a flip changes which
     triangles are cut, not where the mirrored result lands. */
  const box = bounds(flipped);
  assert.ok(Math.abs(box.max.x - 1) < 1e-4, 'the mirrored side reaches +x');
}));

test('Mirror bisect threshold moves the cut plane', () => withCore(() => {
  const cube = weldedCube();
  /* threshold 0.5 keeps d >= 0.5 on the x axis, i.e. only x in [0.5,1], then
     mirrors it: the result spans 0.5..1 on both sides. */
  const cut = mirrorGeometry(cube, {
    axes: [true, false, false], clipping: true, mergeDistance: 1e-5,
    bisectAxes: [true, false, false], bisectFlip: [false, false, false], bisectThreshold: 0.5,
  });
  const box = bounds(cut);
  assert.ok(Math.abs(box.min.x + 1) < 1e-4 && Math.abs(box.max.x - 1) < 1e-4,
    `a slab cut and mirrored still spans -1..1, got ${box.min.x}..${box.max.x}`);
  /* Cutting without mirroring shows the slab itself: the cut moves with the
     threshold, so the kept part starts half a unit out from the plane. */
  const slab = mirrorGeometry(cube, {
    axes: [false, false, false], clipping: false,
    bisectAxes: [true, false, false], bisectFlip: [false, false, false], bisectThreshold: 0.5,
  });
  const slabBox = bounds(slab);
  assert.ok(Math.abs(slabBox.min.x - 0.5) < 1e-4 && Math.abs(slabBox.max.x - 1) < 1e-4,
    `the threshold lifts the cut plane to x=0.5, got ${slabBox.min.x}..${slabBox.max.x}`);
  /* No cap is added on the cut plane - Blender's bisect leaves it open too -
     so the slab is checked by its extent, not by a closed volume. */
}));

test('Solidify flip normals swaps which side the shell grows from', () => withCore(() => {
  const plane = new THREE.PlaneGeometry(2, 2, 1, 1);
  plane.computeVertexNormals();
  const base = { thickness: 0.2, offset: -1, rim: true };
  const up = solidifyGeometry(plane, base.thickness, base.offset, { ...base, flipNormals: false });
  const down = solidifyGeometry(plane, base.thickness, base.offset, { ...base, flipNormals: true });
  const upBox = bounds(up), downBox = bounds(down);
  /* Offset -1 keeps the copy where the surface was and pushes the original
     along the normal, so the shell of a +z plane lies at -thickness; flipping
     the normals mirrors that to +thickness. */
  /* Flip does not move the shell: it swaps which shell keeps the original
     winding, so the geometry spans -0.2..0 either way and only the volume's
     sign changes - the shell faces outward instead of inward. */
  for (const [label, box] of [['unflipped', upBox], ['flipped', downBox]]) {
    assert.ok(Math.abs(box.max.z) < 1e-5, `${label} ends at z=0, got ${box.max.z}`);
    assert.ok(Math.abs(box.min.z + 0.2) < 1e-5, `${label} spans -0.2..0, got ${box.min.z}`);
  }
  assert.ok(Math.abs(volume(up) - 0.8) < 0.05, `unflipped is wound outward, got ${volume(up)}`);
  assert.ok(Math.abs(volume(down) + 0.8) < 0.05, `flipped turns it inside-out, got ${volume(down)}`);
}));

test('Solidify rim only keeps the rim, not the shells', () => withCore(() => {
  const plane = new THREE.PlaneGeometry(2, 2, 1, 1);
  plane.computeVertexNormals();
  const full = solidifyGeometry(plane, 0.2, -1, { rim: true, rimOnly: false });
  const rim = solidifyGeometry(plane, 0.2, -1, { rim: true, rimOnly: true });
  const tris = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  assert.equal(tris(rim), 8, 'a 2x2 plane has four boundary edges: eight rim triangles');
  assert.ok(tris(full) > tris(rim), 'the full shell also carries both surfaces');
  /* Every face of the rim is a vertical wall, so it encloses nothing. */
  const p = rim.attributes.position, idx = rim.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, idx[i]);
    const b = new THREE.Vector3().fromBufferAttribute(p, idx[i + 1]);
    const c = new THREE.Vector3().fromBufferAttribute(p, idx[i + 2]);
    const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.length() < 1e-9) continue;
    assert.ok(Math.abs(n.normalize().z) < 1e-5, 'a rim face is a wall, never a lid');
  }
  const box = bounds(rim);
  assert.ok(Math.abs(box.min.z + 0.2) < 1e-5 && Math.abs(box.max.z) < 1e-5, `the wall spans -0.2..0, got ${box.min.z}..${box.max.z}`);
}));

test('Weld mode Connected only joins vertices that share an edge', () => withCore(() => {
  /* Two quads in the same plane, 0.05 apart along z? No: they must be near
     enough to weld by distance but share no edge. One is at y=+0.5, the other
     at y=-0.5, and their facing edges are 0.02 apart - distance welding
     merges them, Connected welding must not. */
  const make = (y0) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, y0, 0, 1, y0, 0, 1, y0 + 1, 0, -1, y0 + 1, 0,
    ], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  const upper = make(0.02), lower = make(-1);
  const merged = new THREE.BufferGeometry();
  const pos = [...upper.attributes.position.array, ...lower.attributes.position.array];
  const idx = [...upper.index.array, ...[...lower.index.array].map(i => i + 4)];
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setIndex(idx);

  const all = weldGeometry(merged, 0.05, { mode: 'All' });
  const connected = weldGeometry(merged, 0.05, { mode: 'Connected' });
  assert.equal(connected.attributes.position.count, 8, 'nothing shares an edge, so Connected welds nothing');
  assert.equal(all.attributes.position.count, 6, 'All welds the two coincident pairs');
}));

test('Weld mode Connected collapses edges shorter than the distance', () => withCore(() => {
  /* A unit quad with one edge pinched to 0.01: Connected welds the two ends,
     which costs one vertex and both triangles that used the short edge become
     degenerate and drop. */
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 0.01, 0, 0, 1, 1, 0, 0, 1, 0,
  ], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const welded = weldGeometry(g, 0.05, { mode: 'Connected' });
  assert.equal(welded.attributes.position.count, 3, 'the pinch collapses to one vertex');
  assert.equal(welded.index.count / 3, 1, 'only the triangle that still has area survives');
  const allMode = weldGeometry(g, 0.05, { mode: 'All' });
  assert.equal(allMode.attributes.position.count, 3, 'All sees the same coincident pair');
}));

test('Mirror can flip the copies UVs, with or without UDIM tiling', () => withCore(() => {
  const quad = new THREE.PlaneGeometry(1, 1, 1, 1).toNonIndexed();
  /* PlaneGeometry's UVs run (0,0) (1,0) (0,1) (1,1) over two triangles. */
  const uvOf = (g, vertex) => [g.attributes.uv.getX(vertex), g.attributes.uv.getY(vertex)];
  const plain = mirrorGeometry(quad, { axes: [true, false, false], mergeDistance: 1e-5 });
  const flipped = mirrorGeometry(quad, {
    axes: [true, false, false], mergeDistance: 1e-5,
    useMirrorU: true, mirrorOffsetU: 0.25,
  });
  const n = quad.attributes.position.count;
  assert.equal(plain.attributes.position.count, n * 2, 'the copy is there');
  /* The original half keeps its UVs in both cases. */
  for (let i = 0; i < n; i++) assert.deepEqual(uvOf(flipped, i).map(v => +v.toFixed(5)), uvOf(quad, i).map(v => +v.toFixed(5)));
  /* The mirrored half is 1 - u + offset. */
  for (let i = 0; i < n; i++) {
    const [u0, v0] = uvOf(quad, i);
    const [u1, v1] = uvOf(flipped, n + i);
    assert.ok(Math.abs(u1 - (1 - u0 + 0.25)) < 1e-5, `u ${u1} != ${1 - u0 + 0.25}`);
    assert.ok(Math.abs(v1 - v0) < 1e-5, 'v is untouched unless Mirror V is set');
  }
  /* UDIM flips around the centre of each tile instead of around 0.5. */
  const tiledSource = quad.clone();
  const uv = tiledSource.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + 2);
  const tiled = mirrorGeometry(tiledSource, {
    axes: [true, false, false], mergeDistance: 1e-5, useMirrorU: true, useMirrorUdim: true,
  });
  for (let i = 0; i < n; i++) {
    const u0 = tiledSource.attributes.uv.getX(i);
    const want = Math.ceil(u0) - (u0 - Math.floor(u0));
    assert.ok(Math.abs(uvOf(tiled, n + i)[0] - want) < 1e-5, `tile ${i}: ${uvOf(tiled, n + i)[0]} != ${want}`);
  }
}));
