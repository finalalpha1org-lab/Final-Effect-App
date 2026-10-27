import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* The studio used to build its terrain plane, and every open-world chunk, with
 * THREE.PlaneGeometry. That call is 130 ms of the boot at 513x513 on a desktop:
 * three pushes positions and uvs into plain arrays and allocates a 1.57 million
 * element JS array for the index before converting. feGridGeometry writes the
 * same plane straight into typed arrays.
 *
 * "The same" has to mean the same, or every existing texture, wind direction and
 * normal flips. These tests pin the layout against three's own output. */

const source = readFileSync('terrain-main-01.js', 'utf8');
const world = readFileSync('terrain-main-03.js', 'utf8');
const start = source.indexOf('function feGridGeometry(');
const end = source.indexOf('const tg=feGridGeometry', start);

function loadBuilder() {
  assert.ok(start > 0 && end > start, 'terrain-main-01.js defines the grid builder');
  const body = source.slice(start, end);
  return new Function('THREE', `${body}\nreturn feGridGeometry;`)(THREE);
}

const feGridGeometry = loadBuilder();

function compare(n, span) {
  const reference = new THREE.PlaneGeometry(span, span, n, n).rotateX(-Math.PI / 2);
  const built = feGridGeometry(n, span);
  const check = (name, size, epsilon) => {
    const a = reference.attributes[name].array;
    const b = built.attributes[name].array;
    assert.equal(b.length, a.length, `${name} length at n=${n}`);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Math.abs(a[i] - b[i]) <= epsilon, `${name}[${i}] ${b[i]} != ${a[i]} at n=${n}`);
    }
    void size;
  };
  check('position', 3, 1e-4);
  check('normal', 3, 1e-6);
  check('uv', 2, 1e-6);
  const ia = reference.index.array, ib = built.index.array;
  assert.equal(ib.length, ia.length, `index length at n=${n}`);
  for (let i = 0; i < ia.length; i++) assert.equal(ib[i], ia[i], `index[${i}] at n=${n}`);
  return built;
}

test('the fast grid is the same plane three builds, cell for cell', () => {
  for (const [n, span] of [[1, 4], [4, 10], [16, 1000], [64, 250.5], [128, 1000]]) {
    const built = compare(n, span);
    assert.equal(built.attributes.position.count, (n + 1) * (n + 1));
    assert.equal(built.index.count, n * n * 6);
    assert.equal(built.index.array.BYTES_PER_ELEMENT, 4, 'a 512 grid needs 32-bit indices');
  }
});

test('the grid is centred on the origin and spans the requested size', () => {
  const span = 640, n = 8;
  const geo = feGridGeometry(n, span);
  const p = geo.attributes.position.array;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
    maxY = Math.max(maxY, p[i + 1]);
  }
  assert.equal(minX, -span / 2);
  assert.equal(maxX, span / 2);
  assert.equal(minZ, -span / 2);
  assert.equal(maxZ, span / 2);
  assert.equal(maxY, 0, 'the grid is flat until the kernel writes heights');
});

test('every triangle faces up, so the lighting and the shadow pass agree', () => {
  const n = 4;
  const geo = feGridGeometry(n, 100);
  const p = geo.attributes.position.array, idx = geo.index.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.fromArray(p, idx[i] * 3);
    b.fromArray(p, idx[i + 1] * 3);
    c.fromArray(p, idx[i + 2] * 3);
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    assert.ok(normal.y > 0, `triangle ${i / 3} is wound the wrong way`);
  }
});

test('the studio and the open-world chunks both build their planes with it', () => {
  assert.match(source, /const tg=feGridGeometry\(N,S\)/, 'the root terrain mesh');
  assert.match(world, /geo=feGridGeometry\(c\.segments,c\.size\)/, 'every streamed chunk');
  assert.ok(!source.includes('new THREE.PlaneGeometry(S,S,N,N)'), 'the slow path is gone from the studio');
  assert.ok(!world.includes('new THREE.PlaneGeometry(c.size,c.size'), 'and from the chunk builder');
});
