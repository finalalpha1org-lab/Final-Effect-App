import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import {
  arrayGeometry, castGeometry, decimateGeometry, displaceGeometry, mirrorGeometry,
  smoothGeometry, solidifyGeometry, subdivideLoop, twistGeometry, waveGeometry, weldGeometry
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
    assert.equal(once.attributes.position.count, 26);
    assert.ok(finite(once));
    const uv = once.attributes.uv;
    assert.equal(uv.count, once.attributes.position.count);
    for (let i = 0; i < uv.count; i++) {
      assert.ok(uv.getX(i) >= -.001 && uv.getX(i) <= 1.001, `u ${uv.getX(i)}`);
      assert.ok(uv.getY(i) >= -.001 && uv.getY(i) <= 1.001, `v ${uv.getY(i)}`);
    }
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
