import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

await import(pathToFileURL(appPath('landscape-export-pack.js')).href);
await import(pathToFileURL(appPath('open-world-generator.js')).href);

const { measureChunks, mergedGridPlan, sampleWorldField, matricesToTransforms, packPlanetGlobe } = globalThis.LandscapeExportPack;

/* Two chunks side by side, each 100 m with one segment, so the arithmetic is
   readable: heights are the four corners of each chunk, Z then X. */
function pair() {
  return [
    { cx: 0, cz: 0, size: 100, segments: 1, originX: -50, originZ: 0, heights: Float32Array.from([0, 10, 20, 30]), surfaceWeights: new Float32Array(12).fill(0.5) },
    { cx: 1, cz: 0, size: 100, segments: 1, originX: 50, originZ: 0, heights: Float32Array.from([10, 110, 30, 130]), surfaceWeights: new Float32Array(12).fill(0.25) },
  ];
}

test('resident chunks are measured as the world-space box they cover', () => {
  const bounds = measureChunks(pair());
  assert.equal(bounds.count, 2);
  assert.equal(bounds.minX, -100);
  assert.equal(bounds.maxX, 100);
  assert.equal(bounds.minZ, -50);
  assert.equal(bounds.maxZ, 50);
  assert.equal(bounds.centerX, 0);
  assert.equal(bounds.centerZ, 0);
  assert.equal(bounds.sizeX, 200);
  assert.equal(bounds.sizeZ, 100);
  assert.equal(bounds.minHeight, 0);
  assert.equal(bounds.maxHeight, 130);
});

test('an empty world measures to nothing instead of an infinite box', () => {
  const bounds = measureChunks([]);
  assert.equal(bounds.count, 0);
  assert.equal(bounds.sizeX, 0);
  assert.equal(bounds.sizeZ, 0);
  assert.ok(Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxZ));
});

test('the merged grid is square, never finer than the source, and capped', () => {
  const bounds = { centerX: 0, centerZ: 0, sizeX: 768, sizeZ: 768 };
  const plan = mergedGridPlan(bounds, { maxSegments: 256, minStep: 2.6667 });
  assert.equal(plan.size, 768);
  assert.equal(plan.segments, 256);
  assert.equal(plan.step, 3);
  assert.equal(plan.vertices, 257 * 257);
  const coarse = mergedGridPlan(bounds, { maxSegments: 256, minStep: 20 });
  assert.equal(coarse.segments, 38);
  const silly = mergedGridPlan(bounds, { maxSegments: 4096, minStep: 0.001 });
  assert.ok(silly.segments <= 1024, 'a pathological request still cannot allocate an unbounded grid');
});

test('sampling joins neighbouring chunks without a step or a seam', () => {
  const records = pair();
  const plan = mergedGridPlan(measureChunks(records), { maxSegments: 64, minStep: 100 });
  const heights = sampleWorldField(records, plan, 'heights', 1);
  const row = plan.segments + 1;
  /* The same world point sampled from either side of the shared edge must be the
     same height: x = 0 is the east edge of chunk 0 and the west edge of chunk 1. */
  const middle = Math.round(plan.segments / 2);
  let shared = 0;
  for (let j = 0; j <= plan.segments; j++) {
    const z = plan.centerZ + (j / plan.segments - 0.5) * plan.size;
    if (Math.abs(z) > 50) continue; // outside the two chunks; the edge is clamped by design
    const slope = (z + 50) / 100;
    const fromLeft = 10 + 20 * slope;
    const fromRight = 10 + 20 * slope;
    assert.ok(Math.abs(fromLeft - fromRight) < 1e-4, `the two chunks share the edge at z ${z}`);
    const sampled = heights[j * row + middle];
    assert.ok(Math.abs(sampled - fromLeft) < 1e-3, `edge sample at z ${z} was ${sampled}, expected ${fromLeft}`);
    shared++;
  }
  assert.ok(shared >= 3, 'the shared edge was actually sampled');
  const northRow = Math.round(plan.segments);
  assert.ok(Math.abs(heights[northRow * 0 + plan.segments] - 110) < 1e-3, 'the east edge of the shared row');
  assert.ok(Math.abs(heights[northRow * row + plan.segments] - 130) < 1e-3, 'the far corner of the world');
});

test('sampling carries every component of a multi-channel field', () => {
  const records = [{
    cx: 0, cz: 0, size: 10, segments: 1, originX: 0, originZ: 0,
    surfaceWeights: Float32Array.from(Array.from({ length: 48 }, (_, i) => i)),
  }];
  const plan = { size: 10, segments: 1, step: 10, centerX: 0, centerZ: 0, vertices: 4 };
  const field = sampleWorldField(records, plan, 'surfaceWeights', 12);
  assert.equal(field.length, 4 * 12);
  assert.equal(field[0], 0);
  assert.equal(field[11], 11);
  assert.equal(field[13], 13, 'corner (1,0) of channel 1');
  assert.equal(field[2 * 12 + 11], 35, 'corner (0,1) of channel 11');
});

test('per-chunk instance matrices are folded into world space as position + quaternion + scale', () => {
  const matrices = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 3, 1,
  ]);
  const colors = Float32Array.from([0.5, 0.25, 1]);
  const merged = matricesToTransforms([
    { key: 'oak|trunk', count: 1, matrices, colors, originX: 100, originZ: -200 },
    { key: 'oak|trunk', count: 1, matrices, colors, originX: 0, originZ: 0 },
    { key: 'oak|leaf', count: 1, matrices, colors, originX: 5, originZ: 5 },
  ]);
  assert.equal(merged.length, 2);
  const trunk = merged.find((part) => part.key === 'oak|trunk');
  assert.equal(trunk.count, 2);
  assert.deepEqual(Array.from(trunk.transforms.slice(0, 10)), [102, 0, -197, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(trunk.transforms.slice(10, 20)), [2, 0, 3, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(trunk.colors), [0.5, 0.25, 1, 0.5, 0.25, 1]);
  assert.equal(merged.find((part) => part.key === 'oak|leaf').count, 1);
});

test('recomposing a merged transform reproduces the instance matrix three.js built', () => {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3(3, -1, 2);
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.9, -0.3, 'YXZ'));
  const scale = new THREE.Vector3(2, 1.5, 2);
  matrix.compose(position, quaternion, scale);
  const part = matricesToTransforms([{
    key: 'acacia|canopy', count: 1, matrices: Float32Array.from(matrix.toArray()), originX: 10, originZ: -5,
  }])[0];
  const rebuilt = new THREE.Object3D();
  rebuilt.position.set(part.transforms[0], part.transforms[1], part.transforms[2]);
  rebuilt.quaternion.set(part.transforms[3], part.transforms[4], part.transforms[5], part.transforms[6]);
  rebuilt.scale.set(part.transforms[7], part.transforms[8], part.transforms[9]);
  rebuilt.updateMatrix();
  const original = matrix.toArray();
  const back = rebuilt.matrix.toArray();
  for (let i = 0; i < 16; i++) {
    if (i === 12 || i === 14) continue; // the chunk centre is added on purpose
    assert.ok(Math.abs(back[i] - original[i]) < 1e-5, `matrix element ${i}`);
  }
  assert.ok(Math.abs(part.transforms[0] - 13) < 1e-6, 'the chunk centre is added to the position');
  assert.ok(Math.abs(part.transforms[2] + 3) < 1e-6);
});

test('merging ignores empty parts so an unloaded chunk cannot add a dead instance', () => {
  const merged = matricesToTransforms([
    { key: 'grass', count: 0, matrices: new Float32Array(0) },
    { key: 'grass', count: 2, matrices: new Float32Array(32).fill(0) },
    null,
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 2);
  assert.equal(merged[0].transforms.length, 20);
  assert.equal(merged[0].colors.length, 6);
  assert.deepEqual(Array.from(merged[0].colors), [1, 1, 1, 1, 1, 1], 'uncoloured instances default to white');
  assert.deepEqual(Array.from(merged[0].transforms.slice(3, 7)), [0, 0, 0, 1], 'a zero matrix keeps an identity rotation');
});

test('the planet globe uses three.js SphereGeometry vertex order so the Workspace can rebuild it index for index', () => {
  const segments = 12;
  const rings = 6;
  const radius = 60;
  const globe = packPlanetGlobe({ segments, rings, radius, relief: () => 0 });
  const sphere = new THREE.SphereGeometry(radius, segments, rings);
  assert.equal(globe.vertexCount, sphere.attributes.position.count);
  assert.equal(globe.triangleCount, rings * segments * 2);
  for (let i = 0; i < globe.vertexCount; i++) {
    const x = sphere.attributes.position.getX(i);
    const y = sphere.attributes.position.getY(i);
    const z = sphere.attributes.position.getZ(i);
    assert.ok(Math.abs(x - globe.positions[i * 3]) < 1e-4, `vertex ${i} x`);
    assert.ok(Math.abs(y - globe.positions[i * 3 + 1]) < 1e-4, `vertex ${i} y`);
    assert.ok(Math.abs(z - globe.positions[i * 3 + 2]) < 1e-4, `vertex ${i} z`);
    assert.ok(Math.abs(globe.radii[i] - radius) < 1e-4);
  }
});

test('planet relief moves the radius and the normals stay outward over the whole sphere', () => {
  const relief = (x, y) => 1.5 * Math.max(0, x) - 0.5 * Math.max(0, -y);
  const globe = packPlanetGlobe({ segments: 16, rings: 8, radius: 10, relief });
  assert.ok(globe.maxRadius > 11 && globe.minRadius < 9.6);
  for (let i = 0; i < globe.vertexCount; i++) {
    const x = globe.positions[i * 3];
    const y = globe.positions[i * 3 + 1];
    const z = globe.positions[i * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    assert.ok(Math.abs(length - globe.radii[i]) < 1e-3, `vertex ${i} sits on its radius`);
    const dot = (globe.normals[i * 3] * x + globe.normals[i * 3 + 1] * y + globe.normals[i * 3 + 2] * z) / length;
    assert.ok(dot > 0.5, `vertex ${i} normal points out (${dot})`);
    assert.ok(Math.abs(Math.hypot(globe.normals[i * 3], globe.normals[i * 3 + 1], globe.normals[i * 3 + 2]) - 1) < 1e-3);
  }
});

test('the date line and both poles share a normal instead of showing a crease', () => {
  const globe = packPlanetGlobe({ segments: 24, rings: 12, radius: 5, relief: () => 0 });
  const row = globe.segments + 1;
  const normalAt = (i, j) => [globe.normals[(j * row + i) * 3], globe.normals[(j * row + i) * 3 + 1], globe.normals[(j * row + i) * 3 + 2]];
  for (let j = 0; j <= globe.rings; j++) {
    const left = normalAt(0, j);
    const right = normalAt(globe.segments, j);
    for (let q = 0; q < 3; q++) assert.ok(Math.abs(left[q] - right[q]) < 1e-5, `seam row ${j}`);
  }
  const pole = globe.normals.slice(0, 3);
  for (let i = 0; i < row; i++) {
    for (let q = 0; q < 3; q++) {
      assert.ok(Math.abs(globe.normals[i * 3 + q] - pole[q]) < 1e-5, `north pole column ${i}`);
    }
  }
});

test('a merged open world reproduces the generator height at every shared world point', () => {
  /* The axis convention is the fragile part: the studio stores chunk heights
     row-major on X then Z around the chunk centre, and the Workspace rebuilds a
     PlaneGeometry whose rows run on +Z. Sampling four real chunks at non-zero
     chunk coordinates and comparing with the generator's own analytic height
     catches an accidental transpose or a half-chunk origin slip. */
  const { generateChunk, heightAt } = globalThis.OpenWorldGenerator;
  const cfg = {
    chunkSize: 256, segments: 24, sizeKm: 12, worldHalf: 6000, seed: 90125, vegetationSeed: 90125,
    mountainHeight: 48, waterCoverage: 35, blend: 0.58, seaLevel: -28,
    biomeMix: { hills: 1, alpine: 1, desert: 1, volc: 1 }, clustering: 0.5, vegetationDensity: 0.9, maxPlantsPerChunk: 50,
  };
  const chunks = [];
  for (const cx of [-1, 0]) for (const cz of [-1, 0]) chunks.push(generateChunk(Object.assign({}, cfg, { cx, cz })));
  assert.equal(chunks.length, 4);
  const bounds = measureChunks(chunks);
  assert.equal(bounds.sizeX, 512);
  assert.equal(bounds.sizeZ, 512);
  const plan = mergedGridPlan(bounds, { maxSegments: 192, minStep: cfg.chunkSize / cfg.segments });
  const heights = sampleWorldField(chunks, plan, 'heights', 1);
  const row = plan.segments + 1;
  let sampled = 0;
  for (let j = 0; j <= plan.segments; j += 4) {
    for (let i = 0; i <= plan.segments; i += 4) {
      const x = plan.centerX + (i / plan.segments - 0.5) * plan.size;
      const z = plan.centerZ + (j / plan.segments - 0.5) * plan.size;
      const covered = chunks.some((c) => Math.abs(x - c.originX) <= c.size * 0.5 - 0.01 && Math.abs(z - c.originZ) <= c.size * 0.5 - 0.01);
      if (!covered) continue;
      assert.ok(Math.abs(heights[j * row + i] - heightAt(x, z, cfg)) < 1e-3, `height at ${x},${z}`);
      sampled++;
    }
  }
  assert.ok(sampled > 50, 'the sample grid actually landed inside the world');
});
