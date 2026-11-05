import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import {
  arrayGeometry, castGeometry, decimateGeometry, displaceGeometry, mirrorGeometry,
  shadeGeometry, smoothGeometry, solidifyGeometry, subdivideLoop, twistGeometry,
  waveGeometry, weldGeometry
} from '../src/modifier-geometry.mjs';

/* =========================================================================
 * These cases install the real compiled core as globalThis.FECppEngine, so the
 * modifier bridge takes the C++ path instead of the JS reference path. Every
 * assertion therefore proves the wasm session marshalling, the kernel maths and
 * the upload of the returned buffers.
 * ========================================================================= */

const wasmBytes = readFileSync(appPath('fe_core_engine.wasm'));
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const exports = instance.exports;

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

/* The points a mesh actually occupies, ignoring the corners the shading had to
   split. Two meshes with the same control topology have the same count even
   when one of them is drawn faceted and therefore carries three vertices per
   triangle in its buffer. */
function uniquePositions(geometry) {
  const p = geometry.attributes.position;
  const seen = new Set();
  for (let i = 0; i < p.count; i++) {
    seen.add(`${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`);
  }
  return seen.size;
}

function volume(geometry) {
  const p = geometry.attributes.position;
  const idx = geometry.index ? geometry.index.array : Uint32Array.from({ length: p.count }, (_, i) => i);
  let total = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, idx[i]);
    const b = new THREE.Vector3().fromBufferAttribute(p, idx[i + 1]);
    const c = new THREE.Vector3().fromBufferAttribute(p, idx[i + 2]);
    total += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
  }
  return Math.abs(total);
}

function finite(geometry) {
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) return false;
  }
  return true;
}

function sphere(seg = 24, rings = 16) {
  const positions = [], uvs = [], indices = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings, phi = v * Math.PI;
    for (let x = 0; x <= seg; x++) {
      const u = x / seg, theta = u * Math.PI * 2;
      positions.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
      uvs.push(u, 1 - v);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * (seg + 1) + x, b = a + seg + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

test('C++ weld collapses an unwelded box back to eight vertices', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
    const result = weldGeometry(source, 1e-6);
    assert.equal(result.attributes.position.count, 8);
    assert.equal(result.index.count, 36);
    assert.ok(Math.abs(volume(result) - 8) < 1e-4, `volume ${volume(result)}`);
    assert.ok(finite(result));
  });
});

test('C++ mirror doubles a solid and reverses winding without translating it', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(1, 1, 1).translate(1, 0, 0);
    const result = mirrorGeometry(source, { axes: [true, false, false] });
    assert.equal(result.attributes.position.count, source.attributes.position.count * 2);
    const box = result.boundingBox || (result.computeBoundingBox(), result.boundingBox);
    assert.ok(Math.abs(box.min.x + 1.5) < 1e-6, `min.x ${box.min.x}`);
    assert.ok(Math.abs(box.max.x - 1.5) < 1e-6, `max.x ${box.max.x}`);
    assert.ok(Math.abs(volume(result) - 2) < 1e-4, `volume ${volume(result)}`);
  });
});

test('C++ solidify builds a closed shell with the requested thickness', () => {
  withCore(() => {
    const result = solidifyGeometry(new THREE.PlaneGeometry(2, 2), .2, 0);
    assert.equal(result.index.count / 3, 12);
    const box = result.boundingBox || (result.computeBoundingBox(), result.boundingBox);
    assert.ok(Math.abs((box.max.z - box.min.z) - .2) < 1e-5, `thickness ${box.max.z - box.min.z}`);
    assert.ok(finite(result));
    assert.equal(result.attributes.uv.count, result.attributes.position.count);
  });
});

test('C++ subdivision quadruples triangles per level and keeps uv coverage', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const once = subdivideLoop(source, 1);
    assert.equal(once.index.count / 3, 48);
    /* One Catmull-Clark level of a cube is 26 points: the eight corners, one on
       every edge and one in the middle of every face. The buffer holds more
       vertices than that because a cube is flat-shaded, so the corners are
       split - the geometry is still those 26 points. */
    assert.equal(uniquePositions(once), 26);
    assert.ok(once.attributes.position.count > 26, 'a flat surface needs its corners split');
    assert.ok(finite(once));
    const uv = once.attributes.uv;
    assert.equal(uv.count, once.attributes.position.count);
    for (let i = 0; i < uv.count; i++) {
      assert.ok(uv.getX(i) >= -.001 && uv.getX(i) <= 1.001, `u ${uv.getX(i)}`);
      assert.ok(uv.getY(i) >= -.001 && uv.getY(i) <= 1.001, `v ${uv.getY(i)}`);
    }
  });
});

test('C++ Simple subdivision splits the mesh and moves nothing', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const simple = subdivideLoop(source, 2, { simple: true });
    assert.equal(simple.index.count / 3, 192, 'four triangles out of every one, twice');
    const box = simple.boundingBox || (simple.computeBoundingBox(), simple.boundingBox);
    assert.deepEqual(box.min.toArray().map((v) => +v.toFixed(6)), [-1, -1, -1], 'the silhouette is untouched');
    assert.deepEqual(box.max.toArray().map((v) => +v.toFixed(6)), [1, 1, 1]);
    /* Every corner of the box is still a corner of the subdivided mesh. */
    const p = simple.attributes.position;
    const corners = new Set();
    for (let i = 0; i < p.count; i++) corners.add(`${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`);
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      assert.ok(corners.has(`${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`), `corner ${x},${y},${z} survived`);
    }
    assert.equal(simple.userData.feSubdivision.simple, true);
    assert.equal(simple.userData.feSubdivision.levels, 2);
  });
});

test('C++ Catmull-Clark subdivision is the mode that changes the shape', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const smooth = subdivideLoop(source, 2);
    const simple = subdivideLoop(source, 2, { simple: true });
    assert.equal(smooth.index.count, simple.index.count, 'the same topology either way');
    /* Same points, in different places. Their buffers can differ in length -
       a coplanar face is split only where the shading needs it - so the
       comparison is of the points themselves. */
    assert.equal(uniquePositions(smooth), uniquePositions(simple));
    const a = smooth.attributes.position, b = simple.attributes.position;
    let moved = 0;
    for (let i = 0; i < a.count; i++) if (Math.abs(a.getX(i) - b.getX(i)) > 1e-6) moved++;
    assert.ok(moved > a.count * 0.5, `the smoothing is what moves the surface, ${moved} of ${a.count}`);
    assert.ok(smooth.boundingBox.max.x < 0.999, `and the corners pull in, ${smooth.boundingBox.max.x}`);
    assert.equal(simple.boundingBox.max.x, 1, 'while Simple leaves the box exactly 2 wide');
    assert.equal(smooth.userData.feSubdivision.simple, false);
    assert.equal(smooth.userData.feSubdivision.levels, 2);
  });
});

test('C++ subdivision builds the levels the session holds and reports the count', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const result = subdivideLoop(source, 10);
    const info = result.userData.feSubdivision;
    assert.equal(info.requested, 10, 'ten is what the slider asked for');
    assert.ok(info.levels >= 1 && info.levels < 10, `built ${info.levels}`);
    assert.equal(info.limited, true);
    assert.equal(result.index.count / 3, 12 * 4 ** info.levels, 'the mesh is exactly that many levels');
    assert.ok(result.attributes.position.count <= 131072, 'and it never passes the session');
    assert.ok(finite(result));
  });
});

test('C++ subdivision of nothing to do leaves the mesh alone and says so', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const result = subdivideLoop(source, 0);
    assert.equal(result.index.count / 3, 12);
    assert.deepEqual(result.userData.feSubdivision, { requested: 0, levels: 0, simple: false, limited: false });
  });
});

test('C++ decimation collapses a large sphere toward the requested ratio', () => {
  withCore(() => {
    /* Above 12k triangles the bridge routes Decimate to the C++ clustering
       kernel; smaller meshes keep the JS QEM collapse. */
    const source = sphere(100, 80);
    const faces = source.index.count / 3;
    const result = decimateGeometry(source, .35);
    const outFaces = result.index.count / 3;
    assert.ok(outFaces < faces * .5, `decimated ${outFaces} of ${faces}`);
    assert.ok(finite(result));
    assert.ok(result.attributes.position.count > 3);
  });
});

test('C++ deformers change geometry, keep topology and stay finite', () => {
  withCore(() => {
    const source = new THREE.IcosahedronGeometry(1, 2);
    const faces = source.index ? source.index.count / 3 : source.attributes.position.count / 3;

    const displaced = displaceGeometry(source, { strength: .4, midlevel: .5, frequency: 2, octaves: 3, seed: 9 });
    assert.equal(displaced.index.count / 3, faces);
    assert.notDeepEqual(Array.from(displaced.attributes.position.array), Array.from(source.attributes.position.array));
    assert.ok(finite(displaced));

    const axial = displaceGeometry(source, { strength: .4, direction: 'Y' });
    assert.ok(finite(axial));

    const plane = new THREE.PlaneGeometry(2, 2, 6, 6);
    const waveA = waveGeometry(plane, { speed: 2, height: 1, width: 2, time: 0, axis: 'Y' });
    const waveB = waveGeometry(plane, { speed: 2, height: 1, width: 2, time: 1, axis: 'Y', phase: .5 });
    assert.notDeepEqual(Array.from(waveA.attributes.position.array), Array.from(waveB.attributes.position.array));

    const twisted = twistGeometry(new THREE.BoxGeometry(1, 2, 1), 1.5, 'Y');
    assert.ok(finite(twisted));
    assert.notDeepEqual(Array.from(twisted.attributes.position.array), Array.from(new THREE.BoxGeometry(1, 2, 1).attributes.position.array));

    const cast = castGeometry(source, { shape: 'Cuboid', factor: 1, radius: .8, size: 1 });
    assert.ok(finite(cast));
    assert.notDeepEqual(Array.from(cast.attributes.position.array), Array.from(source.attributes.position.array));
  });
});

test('C++ array copies keep custom-free attributes and honour the offset', () => {
  withCore(() => {
    const source = new THREE.BoxGeometry(1, 1, 1);
    const result = arrayGeometry(source, { count: 3, offset: [2, 0, 0] });
    assert.equal(result.index.count, source.index.count * 3);
    assert.equal(result.attributes.uv.count, source.attributes.uv.count * 3);
    const box = result.boundingBox || (result.computeBoundingBox(), result.boundingBox);
    assert.ok(Math.abs((box.max.x - box.min.x) - 5) < 1e-6, `width ${box.max.x - box.min.x}`);
  });
});

test('C++ smoothing with volume preservation keeps a sphere closer to its volume', () => {
  withCore(() => {
    const source = sphere(16, 12);
    const before = volume(source);
    const plain = smoothGeometry(source, { factor: .6, iterations: 3 });
    const preserved = smoothGeometry(source, { factor: .6, iterations: 3, preserveVolume: true });
    assert.ok(finite(plain) && finite(preserved));
    assert.ok(volume(preserved) > volume(plain), 'Taubin pass retains more volume than plain Laplacian');
    assert.ok(volume(preserved) <= before * 1.05);
  });
});

test('the modifier bridge falls back to JS when the core is absent', () => {
  const previous = globalThis.FECppEngine;
  delete globalThis.FECppEngine;
  try {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const welded = weldGeometry(source.toNonIndexed(), 1e-6);
    assert.equal(welded.attributes.position.count, 8);
  } finally {
    if (previous !== undefined) globalThis.FECppEngine = previous;
  }
});

/* How many faces read as flat: every corner normal agrees with the face's own
   direction. A face marked flat next to a smooth one only looks like this if
   the corners were actually split, so this counts the shading the way any
   viewer would - from the geometry alone. */
function faceShading(geometry) {
  const p = geometry.attributes.position;
  const n = geometry.attributes.normal;
  const idx = geometry.index.array;
  let flat = 0, smooth = 0;
  for (let f = 0; f < idx.length / 3; f++) {
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
    const ux = p.getX(b) - ax, uy = p.getY(b) - ay, uz = p.getZ(b) - az;
    const vx = p.getX(c) - ax, vy = p.getY(c) - ay, vz = p.getZ(c) - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    let isFlat = true;
    for (const k of [a, b, c]) {
      if (nx * n.getX(k) + ny * n.getY(k) + nz * n.getZ(k) < 0.9995) isFlat = false;
    }
    if (isFlat) flat++; else smooth++;
  }
  return { flat, smooth, tris: idx.length / 3, verts: p.count };
}

test('per-face flags survive subdivision, so a flat cube stays flat', () => {
  withCore(() => {
    /* A cube arrives from three with a normal per face, which the modifier
       bridge reads as every face flat. Subdividing it used to hand back
       averaged normals - a rounded cube - while the editor still called the
       mesh faceted. */
    const box = new THREE.BoxGeometry(2, 2, 2);
    for (const options of [{ simple: true }, { simple: false }]) {
      const result = subdivideLoop(box, 2, options);
      const shading = faceShading(result);
      assert.equal(shading.tris, 192, 'two levels of a cube is 192 triangles');
      assert.equal(shading.flat, 192, `${options.simple ? 'Simple' : 'Catmull-Clark'} must keep every face flat`);
      assert.equal(shading.smooth, 0);
      assert.equal(result.userData.feFaceShading.length, 192, 'and carry one flag per triangle forward');
      assert.equal(Array.from(result.userData.feFaceShading).filter((v) => v).length, 0, 'none of them flipped to smooth');
    }
  });
});

test('one flagged face stays flat through subdivision while the rest round off', () => {
  withCore(() => {
    const sphere = new THREE.SphereGeometry(1, 16, 8);
    const triCount = sphere.index.count / 3;
    const flags = new Uint8Array(triCount).fill(1);
    for (let i = 0; i < 8; i++) flags[i] = 0;
    sphere.userData.feFaceShading = flags;

    const level1 = subdivideLoop(sphere, 1);
    const shading1 = faceShading(level1);
    assert.equal(shading1.tris, triCount * 4);
    assert.equal(shading1.flat, 32, 'the eight flagged triangles become four each');
    assert.equal(shading1.smooth, triCount * 4 - 32, 'and the sphere around them stays round');

    /* The flags are the truth across levels, not the normals they produced:
       subdividing again feeds the written flags back in, so the flat patch
       grows with the surface instead of blurring away. */
    const level2 = subdivideLoop(sphere, 2);
    const shading2 = faceShading(level2);
    assert.equal(shading2.flat, 8 * 16, 'a level two patch is sixteen times the level one patch');
    assert.ok(shading2.smooth > 0, 'and the rest of the sphere is still smooth');
  });
});

test('the normal-split pass leaves a mesh the shading it arrived with', () => {
  withCore(() => {
    const sphere = new THREE.SphereGeometry(1, 16, 8);
    const smooth = shadeGeometry(sphere.clone());
    assert.equal(faceShading(smooth).flat, 0, 'a smooth sphere must not come back faceted');
    assert.equal(faceShading(smooth).smooth, sphere.index.count / 3);
    assert.equal(smooth.userData.feFaceShading.length, sphere.index.count / 3, 'and it now carries its flags');

    const box = new THREE.BoxGeometry(2, 2, 2);
    box.userData.feFaceShading = new Uint8Array(12).fill(0);
    const flat = shadeGeometry(box.clone());
    assert.equal(faceShading(flat).flat, 12, 'a flagged-flat cube must stay flat');
    /* Three already hands a cube over with a corner per face, so the pass has
       nothing to break apart here - it must not split anything twice either. */
    assert.equal(flat.attributes.position.count, 24);
    assert.deepEqual(Array.from(flat.attributes.position.array), Array.from(box.attributes.position.array), 'and must not move a point');
  });
});
