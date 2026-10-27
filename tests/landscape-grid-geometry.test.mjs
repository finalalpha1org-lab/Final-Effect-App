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

/* ---------------------------------------------------------------- */
/* Chunk normals                                                     */
/* ---------------------------------------------------------------- */

const wasm = readFileSync('fe_core_engine.wasm');
let instance = null;
async function kernel() {
  if (!instance) {
    const { instance: made } = await WebAssembly.instantiate(wasm, {});
    instance = made.exports;
  }
  return instance;
}

/* The reference the kernel has to reproduce: central differences over the grid,
   one-sided and halved at the borders, exactly like the root terrain. */
function referenceNormals(heights, row, step) {
  const out = new Float32Array(row * row * 3);
  const last = row - 1;
  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) {
      const xl = heights[j * row + (i > 0 ? i - 1 : i)];
      const xr = heights[j * row + (i < last ? i + 1 : i)];
      const zd = heights[(j > 0 ? j - 1 : j) * row + i];
      const zu = heights[(j < last ? j + 1 : j) * row + i];
      const gx = (xr - xl) / (step * (i > 0 && i < last ? 2 : 1));
      const gz = (zu - zd) / (step * (j > 0 && j < last ? 2 : 1));
      const length = Math.hypot(-gx, 1, -gz);
      const k = (j * row + i) * 3;
      out[k] = -gx / length;
      out[k + 1] = 1 / length;
      out[k + 2] = -gz / length;
    }
  }
  return out;
}

test('fe_grid_normals reproduces the root terrain normal for every grid size', async () => {
  const ex = await kernel();
  for (const [row, step] of [[2, 1], [5, 2.5], [33, 3.125], [129, 15.625]]) {
    const count = row * row;
    const heights = new Float32Array(count);
    let state = 1337;
    for (let i = 0; i < count; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      heights[i] = (state / 4294967296) * 40 - 12;
    }
    new Float32Array(ex.memory.buffer, ex.fe_grid_height_ptr(), count).set(heights);
    assert.equal(ex.fe_grid_normals(row, step), 0, `row ${row} is accepted`);
    const produced = new Float32Array(ex.memory.buffer, ex.fe_grid_normal_ptr(), count * 3).slice();
    const wanted = referenceNormals(heights, row, step);
    for (let i = 0; i < wanted.length; i++) {
      assert.ok(Math.abs(produced[i] - wanted[i]) < 1e-5, `normal[${i}] at row ${row}`);
    }
  }
});

test('a flat chunk gets straight-up normals and a bad request is refused', async () => {
  const ex = await kernel();
  const row = 9, count = row * row;
  new Float32Array(ex.memory.buffer, ex.fe_grid_height_ptr(), count).fill(5);
  assert.equal(ex.fe_grid_normals(row, 2), 0);
  const normals = new Float32Array(ex.memory.buffer, ex.fe_grid_normal_ptr(), count * 3);
  for (let k = 0; k < count; k++) {
    /* -gx/length is -0 when the slope is zero; the value is what matters. */
    assert.ok(Math.abs(normals[k * 3]) === 0, 'x is zero');
    assert.equal(normals[k * 3 + 1], 1, 'y is up');
    assert.ok(Math.abs(normals[k * 3 + 2]) === 0, 'z is zero');
  }
  assert.equal(ex.fe_grid_normals(1, 2), -1, 'a single point has no slope');
  assert.equal(ex.fe_grid_normals(130, 2), -1, 'the chunk buffer stops at 129 rows');
  assert.equal(ex.fe_grid_normals(row, 0), -1, 'a zero step has no gradient');
  assert.equal(ex.fe_grid_normals(row, -1), -1);
});

test('the chunk builder and the stroke update both ask the kernel first', () => {
  assert.match(world, /function owChunkNormals\(c,geo\)/, 'one helper decides');
  assert.match(world, /core\.gridNormals\(\{row:c\.segments\+1,step:c\.size\/c\.segments,heights:c\.heights,output:out\}\)/,
    'the tile is handed to the kernel as it stands');
  assert.match(world, /geo\.computeVertexNormals\(\);/, 'and three is still the fallback');
  assert.match(world, /pos\.needsUpdate=true;c\.terrain\.geometry\.attributes\.color\.needsUpdate=true;owChunkNormals\(c,c\.terrain\.geometry\)/, 'the live brush stroke');
  assert.match(world, /p\.needsUpdate=true;.*owChunkNormals\(c,c\.terrain\.geometry\)/, 'the chunk refresh');
  assert.match(world, /owChunkNormals\(c,geo\)/, 'the chunk build');
  assert.match(source, /core\.gridNormals=function\(state\)/, 'the bridge exposes it');
  assert.ok(!/c\.terrain\.geometry\.computeVertexNormals\(\)/.test(world), 'the per-stroke three.js call is gone');
});
