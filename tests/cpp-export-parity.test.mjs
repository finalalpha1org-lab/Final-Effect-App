import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/* The export path moved into C++ (cpp/src/fe_export.cpp, cpp/src/fe_volatlas.cpp).
   A kernel that disagrees with the loop it replaced is a silent export bug: the
   file still downloads, the mesh is just very slightly wrong. So every case here
   runs twice — once through the wasm kernels, once through the JavaScript
   fallback that still ships with the app — and the two results are compared as
   bytes, not as approximate numbers.

   The fallbacks are not dead code. If the engine artifact fails to load, the
   exporters fall back to them, so they are also the specification. */

const wasm = readFileSync('wasm/fe_core_engine.wasm');
const { instance: { exports: ex } } = await WebAssembly.instantiate(wasm, {});

/* The same shape as FECppEngine for the parts the export modules touch. */
const scratchSlots = new Map();
const engine = {
  ready: true,
  exports: ex,
  memory: ex.memory,
  scratch(name, bytes) {
    const wanted = Math.max(1, bytes | 0);
    const slot = scratchSlots.get(name);
    if (slot && slot.length >= wanted) return slot;
    const next = { ptr: ex.fe_malloc(wanted), length: wanted };
    scratchSlots.set(name, next);
    return next;
  }
};

const CONSTRUCTORS = {
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array,
  ArrayBuffer, DataView, Buffer, console, Math, isFinite, Infinity, Map, Set,
  Promise, URL, TextEncoder, TextDecoder, Number, Object, Array, String, Error,
  JSON, Date, RegExp
};

function load(file, withEngine) {
  const context = { ...CONSTRUCTORS };
  if (withEngine) context.FECppEngine = engine;
  vm.createContext(context);
  vm.runInContext(readFileSync(file, 'utf8'), context);
  return context;
}

const W = { cpp: load('workspace-export.js', true).FEWorkspaceExport,
            js: load('workspace-export.js', false).FEWorkspaceExport };
const A = { cpp: load('volume-atlas.js', true).FEVolumeAtlas,
            js: load('volume-atlas.js', false).FEVolumeAtlas };
const L = { cpp: load('volume-library.js', true).FEVolumeLibrary,
            js: load('volume-library.js', false).FEVolumeLibrary };
const R = { cpp: load('render-export.js', true).FERenderExport,
            js: load('render-export.js', false).FERenderExport };

/* Byte equality, so -0 vs 0 or a last-bit rounding difference is a failure. */
function bytes(view) {
  if (!view) return null;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('hex');
}

/* Objects built inside a vm context have that realm's prototypes, which
   deepEqual rejects; compare plain copies. */
const plain = (value) => (value && typeof value === 'object' ? { ...value } : value);

function assertSameBaked(cpp, js, label) {
  assert.ok(cpp, `${label}: the C++ path returned nothing`);
  assert.equal(bytes(cpp.positions), bytes(js.positions), `${label}: positions differ`);
  assert.equal(bytes(cpp.normals), bytes(js.normals), `${label}: normals differ`);
  assert.equal(bytes(cpp.uvs), bytes(js.uvs), `${label}: uvs differ`);
  assert.equal(bytes(cpp.indices), bytes(js.indices), `${label}: indices differ`);
  assert.equal(cpp.vertexCount, js.vertexCount, `${label}: vertex count differs`);
}

/* ---- geometry doubles ---------------------------------------------------- */

function makeGeometry(positions, normals, uvs, index) {
  const attributes = {
    position: { array: new Float32Array(positions), itemSize: 3, count: positions.length / 3 }
  };
  if (normals) attributes.normal = { array: new Float32Array(normals), itemSize: 3, count: normals.length / 3 };
  if (uvs) attributes.uv = { array: new Float32Array(uvs), itemSize: 2, count: uvs.length / 2 };
  const geometry = { attributes, index: null };
  if (index) geometry.index = { array: index.array, count: index.array.length, itemSize: 1 };
  return geometry;
}

function makeInstanced(geometry, matrices, count) {
  const array = new Float32Array(matrices.length * 16);
  matrices.forEach((m, i) => array.set(m, i * 16));
  return {
    geometry,
    count: count === undefined ? matrices.length : count,
    instanceMatrix: { array },
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, -0.25, 1] }
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/* A column-major matrix built from a scale, a rotation about y and a
   translation — the same composition a scene graph produces. */
function worldMatrix(sx, sy, sz, angle, tx, ty, tz) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [
    c * sx, 0, -s * sx, 0,
    0, sy, 0, 0,
    s * sz, 0, c * sz, 0,
    tx, ty, tz, 1
  ];
}

function shake(seed, count) {
  let state = seed >>> 0;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = ((state >>> 8) / 0x1000000) * 4 - 2;
  }
  return out;
}

/* ---- baking --------------------------------------------------------------- */

test('C++ bake reproduces the JavaScript bake bit for bit', () => {
  const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1.5];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5];
  const index = { array: new Uint16Array([0, 1, 2, 0, 2, 3, 0, 1, 4]) };
  const geometry = makeGeometry(positions, normals, uvs, index);

  const matrices = [
    IDENTITY,
    worldMatrix(1, 1, 1, 0.7, 2, -3, 0.5),
    worldMatrix(2.5, 0.4, 1.25, -1.1, 0.125, 7, -9.5),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], /* singular: normal falls back */
    null
  ];
  matrices.forEach((matrix, i) => {
    assertSameBaked(W.cpp.bakeGeometry(geometry, matrix), W.js.bakeGeometry(geometry, matrix), `matrix ${i}`);
  });
});

test('C++ bake handles meshes without normals or uvs, indexed or not', () => {
  const plain = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bakedCpp = W.cpp.bakeGeometry(plain, worldMatrix(1, 1, 1, 0, 4, 5, 6));
  const bakedJs = W.js.bakeGeometry(plain, worldMatrix(1, 1, 1, 0, 4, 5, 6));
  assertSameBaked(bakedCpp, bakedJs, 'unindexed');
  assert.equal(bakedCpp.normals, null, 'no normal attribute, no normal buffer');
  assert.equal(bakedCpp.uvs, null, 'no uv attribute, no uv buffer');
  assert.equal(bakedCpp.indices.length, 3, 'a non-indexed mesh gets sequential indices');

  const indexed = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], null, null,
    { array: new Uint32Array([0, 2, 1]) });
  assertSameBaked(W.cpp.bakeGeometry(indexed, IDENTITY), W.js.bakeGeometry(indexed, IDENTITY), 'indexed');
});

test('C++ bake survives interleaved attributes and degenerate input', () => {
  /* itemSize 4 positions: xyz plus a weight the kernels must skip. */
  const stride = new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]);
  const geometry = {
    attributes: { position: { array: stride, itemSize: 4, count: 3 } },
    index: null
  };
  assertSameBaked(W.cpp.bakeGeometry(geometry, IDENTITY), W.js.bakeGeometry(geometry, IDENTITY), 'interleaved');
  assert.equal(W.cpp.bakeGeometry({ attributes: {} }, IDENTITY), null, 'no positions means no bake');
});

test('C++ bake matches on a large mesh that needs 32-bit indices', () => {
  const count = 66000; /* past the Uint16 ceiling */
  const positions = shake(7, count * 3);
  const normals = shake(9, count * 3);
  const geometry = makeGeometry(positions, normals, null);
  const cpp = W.cpp.bakeGeometry(geometry, worldMatrix(0.75, 1.5, 2, 0.3, 1, 2, 3));
  const js = W.js.bakeGeometry(geometry, worldMatrix(0.75, 1.5, 2, 0.3, 1, 2, 3));
  assertSameBaked(cpp, js, 'wide indices');
  assert.ok(cpp.indices instanceof Uint32Array, 'a 66k-vertex mesh exports 32-bit indices');
});

/* ---- instancing ------------------------------------------------------------ */

test('C++ instanced bake reproduces the concatenated JavaScript bake', () => {
  const geometry = makeGeometry(
    [-1, -1, 0, 1, -1, 0, 1, 1, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 0, 1, 0, 1, 1],
    { array: new Uint16Array([0, 1, 2]) }
  );
  const matrices = [
    worldMatrix(1, 1, 1, 0, 0, 0, 0),
    worldMatrix(1, 1, 1, 0.5, 3, 0, 0),
    worldMatrix(0.5, 2, 0.5, 1.25, -2, 1, 4),
    worldMatrix(1, 1, 1, 2, 0, -3, 0)
  ];
  const instanced = makeInstanced(geometry, matrices);
  const cpp = W.cpp.bakeInstanced(instanced, {});
  const js = W.js.bakeInstanced(instanced, {});
  assertSameBaked(cpp, js, 'instanced');
  assert.equal(cpp.instanceCount, 4);
  assert.equal(cpp.vertexCount, 12, 'four copies of a triangle');
  assert.equal(cpp.indices[3], 3, 'each copy offsets its indices by the vertices before it');

  /* maxInstances truncates, and the count comes from the object, not the array. */
  const limitedCpp = W.cpp.bakeInstanced(instanced, { maxInstances: 2 });
  const limitedJs = W.js.bakeInstanced(instanced, { maxInstances: 2 });
  assertSameBaked(limitedCpp, limitedJs, 'instanced, truncated');
  assert.equal(limitedCpp.instanceCount, 2);
});

test('C++ instanced bake crosses the 16-bit index ceiling like concat() did', () => {
  const count = 40000; /* x 2 copies = 80000 vertices */
  const geometry = makeGeometry(shake(3, count * 3), null, null,
    { array: new Uint32Array([0, 1, 2]) });
  const instanced = makeInstanced(geometry, [IDENTITY, worldMatrix(1, 1, 1, 0, 10, 0, 0)]);
  const cpp = W.cpp.bakeInstanced(instanced, {});
  const js = W.js.bakeInstanced(instanced, {});
  assertSameBaked(cpp, js, 'instanced wide');
  assert.ok(cpp.indices instanceof Uint32Array, 'the concatenated primitive is wide');
});

test('a missing engine falls back to the JavaScript bake', () => {
  const geometry = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const software = W.js.bakeGeometry(geometry, IDENTITY);
  assert.ok(software && software.positions.length === 9, 'the fallback still bakes');
});

/* ---- volume atlas --------------------------------------------------------- */

function fillGrid(grid, scale) {
  const density = new Float32Array(grid ** 3);
  const temperature = new Float32Array(grid ** 3);
  for (let i = 0; i < density.length; i++) {
    density[i] = (Math.sin(i * 0.11) * 0.5 + 0.5) * scale;
    temperature[i] = (Math.cos(i * 0.07) * 0.5 + 0.5) * scale * 2;
  }
  return { density, temperature };
}

test('C++ atlas packing reproduces FEVolumeAtlas.pack byte for byte', () => {
  for (const grid of [4, 16, 24, 40]) {
    const { density, temperature } = fillGrid(grid, 3.5);
    const options = { density, temperature, grid, densityScale: 3.5, temperatureScale: 7 };
    const cpp = A.cpp.pack(options);
    const js = A.js.pack(options);
    assert.equal(bytes(cpp.data), bytes(js.data), `grid ${grid}: atlas differs`);
    assert.equal(cpp.width, js.width);
    assert.equal(cpp.height, js.height);
    assert.equal(cpp.tilesX, js.tilesX);
    assert.equal(cpp.tilesY, js.tilesY);
    assert.deepEqual(plain(A.cpp.layout(grid)), plain(A.js.layout(grid)), `grid ${grid}: layout differs`);
  }
});

test('C++ atlas packing clamps and quantises exactly like the JavaScript one', () => {
  const grid = 8;
  const density = new Float32Array(grid ** 3);
  const temperature = new Float32Array(grid ** 3);
  const edge = [0, 1, -5, 12.5, 0.5, 0.001953125, 0.999, NaN, Infinity, -Infinity];
  for (let i = 0; i < density.length; i++) {
    density[i] = edge[i % edge.length];
    temperature[i] = edge[(i * 3) % edge.length];
  }
  const options = { density, temperature, grid, densityScale: 4, temperatureScale: 4 };
  assert.equal(bytes(A.cpp.pack(options).data), bytes(A.js.pack(options).data), 'edge values differ');
});

test('C++ atlas sampling and playback match the library reader', () => {
  const grid = 6, frames = 3;
  const data = new Uint8Array(grid ** 3 * frames * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 255;
  const variant = { name: 'smoke', grid, frames, fps: 24, data };

  const cpp = L.cpp.packAtlas(variant);
  const js = L.js.packAtlas(variant);
  assert.equal(bytes(cpp.data), bytes(js.data), 'library atlas differs');
  assert.equal(cpp.width, js.width);
  assert.equal(cpp.height, js.height);
  assert.equal(cpp.tilesX, js.tilesX);
  assert.equal(cpp.tilesY, js.tilesY);

  const probes = [[0.5, 0.5, 0.5], [0, 0, 0], [1, 1, 1], [0.13, 0.87, 0.42], [0.999, 0.001, 0.5]];
  for (const frame of [0, 1, 2]) {
    for (const [u, v, w] of probes) {
      const a = L.cpp.sample(variant, frame, u, v, w, [0, 0]);
      const b = L.js.sample(variant, frame, u, v, w, [0, 0]);
      assert.deepEqual([...a], [...b], `sample f${frame} ${u},${v},${w}`);
    }
  }

  for (const seconds of [0, 0.02, 0.05, 0.5, 1.75, 12.5]) {
    for (const motion of [0, 0.5, 1, 3]) {
      const a = L.cpp.frameAt(variant, seconds, motion);
      const b = L.js.frameAt(variant, seconds, motion);
      assert.deepEqual(plain(a), plain(b), `frameAt ${seconds}s x${motion}`);
    }
  }
  assert.deepEqual(plain(L.cpp.frameAt(null, 1, 1)), { a: 0, b: 0, blend: 0 }, 'no variant means frame zero');
});

/* ---- packaging CRC --------------------------------------------------------- */

test('C++ CRC-32 matches the table-driven JavaScript one on every length', () => {
  const bytes = shake(11, 4096).map((v) => Math.abs(Math.round(v * 40)) & 255);
  const data = Uint8Array.from(bytes);
  for (const length of [0, 1, 2, 3, 7, 255, 1024, 4096]) {
    const slice = data.subarray(0, length);
    assert.equal(R.cpp.crc32(slice), R.js.crc32(slice), `length ${length}`);
  }
  /* The known check value: "123456789" hashes to 0xCBF43926. */
  const check = new TextEncoder().encode('123456789');
  assert.equal(R.js.crc32(check), 0xCBF43926, 'the reference implementation is standard');
  assert.equal(R.cpp.crc32(check), 0xCBF43926, 'the kernel is standard too');
});

/* ---- temporal anti-aliasing maths ------------------------------------------ */

const TAA = { cpp: load('fe-taa.js', true).FE_TAA, js: load('fe-taa.js', false).FE_TAA };

test('C++ Halton and jitter reproduce the JavaScript sampling sequence', () => {
  for (let index = 0; index < 70; index++) {
    for (const base of [2, 3]) {
      assert.equal(TAA.cpp.halton(index, base), TAA.js.halton(index, base), `halton ${index}/${base}`);
    }
  }
  for (const frame of [0, 1, 2, 17, 63, 64, 65, 200]) {
    for (const [w, h] of [[1, 1], [1920, 1080], [390, 844], [0, 0]]) {
      const a = plain(TAA.cpp.jitter(frame, w, h));
      const b = plain(TAA.js.jitter(frame, w, h));
      assert.equal(a.x, b.x, `jitter x ${frame} ${w}x${h}`);
      assert.equal(a.y, b.y, `jitter y ${frame} ${w}x${h}`);
    }
  }
});

test('C++ reprojection matches the JavaScript one, including off-screen points', () => {
  const viewProjection = [0.75, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.2, 0];
  const points = [
    { x: 0, y: 0, z: -5 }, { x: 3, y: 2, z: -12 }, { x: -40, y: 0, z: -1 },
    { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }
  ];
  for (const world of points) {
    const a = plain(TAA.cpp.projectToUv(viewProjection, world));
    const b = plain(TAA.js.projectToUv(viewProjection, world));
    assert.equal(a.x, b.x, `uv x at ${world.x},${world.y},${world.z}`);
    assert.equal(a.y, b.y, `uv y at ${world.x},${world.y},${world.z}`);
    assert.equal(a.valid, b.valid, `valid flag at ${world.x},${world.y},${world.z}`);
  }
});

/* ---- blackbody colour ------------------------------------------------------ */

const BLACKBODY_MIN_K = 700, BLACKBODY_MAX_K = 3000, BLACKBODY_LUT = 128;

function loadSimulation(withEngine) {
  const context = { ...CONSTRUCTORS, WebAssembly, URL: URL };
  context.window = { document: { baseURI: 'https://sim.test/', addEventListener() {}, getElementById() { return null; } }, FE: {} };
  context.document = context.window.document;
  context.fetch = async () => { throw new Error('test: no fetch'); };
  if (withEngine) context.window.FECppEngine = engine;
  vm.createContext(context);
  vm.runInContext(readFileSync('simulationCore.js', 'utf8'), context);
  return context.window.SimulationEngine;
}

test('the C++ blackbody ramp is the JavaScript ramp, byte for byte', () => {
  const Sim = loadSimulation(false);
  const software = Sim.volumeBlackbodyLutSoftware();

  /* Run the same table through the kernel. */
  const slot = engine.scratch('test-blackbody-lut', BLACKBODY_LUT * 4);
  assert.equal(ex.fe_color_blackbody_lut(BLACKBODY_MIN_K, BLACKBODY_MAX_K, BLACKBODY_LUT, slot.ptr), 0);
  const kernel = Buffer.from(new Uint8Array(ex.memory.buffer, slot.ptr, BLACKBODY_LUT * 4));
  assert.equal(kernel.toString('hex'), Buffer.from(software).toString('hex'),
    'the fire temperature ramp differs between the kernel and the shader fallback');
});

test('the C++ blackbody hue answers agree with the JavaScript colour maths', () => {
  const Sim = loadSimulation(false);
  const rgbSlot = engine.scratch('test-blackbody-rgb', 3 * 8);
  for (const kelvin of [500, 700, 800, 1000, 1500, 1900, 2300, 3000, 6500, 12000, 40000]) {
    const js = [...Sim.blackbodyRGBSoftware(kelvin)];
    assert.equal(ex.fe_color_blackbody_rgb(kelvin, rgbSlot.ptr), 0);
    const wasm = Array.from(new Float64Array(ex.memory.buffer, rgbSlot.ptr, 3));
    for (let c = 0; c < 3; c++) {
      /* The kernel carries its own exp/pow (there is no libm in a freestanding
         wasm build), so the agreement is to double precision, not to the bit. */
      assert.ok(Math.abs(wasm[c] - js[c]) < 1e-12, `${kelvin} K channel ${c}: ${wasm[c]} vs ${js[c]}`);
    }
  }
});

test('the C++ library header walk reads the same variants as the JavaScript one', () => {
  /* 'FELIB1', two variants, hand-built to the documented layout. */
  const parts = [];
  const push = (...bytes) => parts.push(...bytes);
  const u16 = (v) => push(v & 255, (v >> 8) & 255);
  push(70, 69, 76, 73, 66, 49, 0, 0, 2); /* magic, two zero bytes, count */
  const addVariant = (name, grid, frames, fps) => {
    push(name.length);
    for (const ch of name) push(ch.charCodeAt(0));
    u16(grid);
    u16(frames);
    push(fps, 0);
    for (let i = 0; i < grid ** 3 * 2 * frames; i++) push((i * 7) & 255);
  };
  addVariant('campfire', 2, 2, 24);
  addVariant('smoke', 2, 1, 12);
  const file = Uint8Array.from(parts);

  const a = L.cpp.parse(file);
  const b = L.js.parse(file);
  assert.equal(a.variants.length, b.variants.length);
  a.variants.forEach((variant, i) => {
    const other = b.variants[i];
    assert.equal(variant.name, other.name);
    assert.equal(variant.grid, other.grid);
    assert.equal(variant.frames, other.frames);
    assert.equal(variant.fps, other.fps);
    assert.equal(bytes(variant.data), bytes(other.data), `variant ${i} payload differs`);
  });

  /* Both readers refuse a corrupt file. */
  const broken = file.slice();
  broken[0] = 88;
  assert.throws(() => L.cpp.parse(broken), /bad magic/);
  assert.throws(() => L.js.parse(broken), /bad magic/);
  assert.throws(() => L.cpp.parse(file.subarray(0, file.length - 4)), /truncated/);
  assert.throws(() => L.js.parse(file.subarray(0, file.length - 4)), /truncated/);
});

/* ---- end to end: a real geometry through the kernel into a GLB ------------- */

test('a real THREE mesh bakes through the kernel into a valid GLB', () => {
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  const matrix = new THREE.Matrix4().makeRotationY(0.6);
  matrix.setPosition(2, -1, 0.5);

  const cpp = W.cpp.bakeGeometry(geometry, matrix.elements);
  const js = W.js.bakeGeometry(geometry, matrix.elements);
  assertSameBaked(cpp, js, 'sphere');

  const nodes = [{
    name: 'Sphere',
    positions: cpp.positions,
    normals: cpp.normals,
    uvs: cpp.uvs,
    indices: cpp.indices,
    vertexCount: cpp.vertexCount,
    material: W.cpp.describeMaterial(null, 0)
  }];
  const glb = W.cpp.buildGLB(nodes);
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546C67, 'glTF magic');
  assert.equal(view.getUint32(4, true), 2, 'glTF 2.0');
  assert.equal(view.getUint32(8, true), glb.byteLength, 'the declared length is the file length');

  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb.buffer, glb.byteOffset + 20, jsonLength)).trim());
  assert.equal(json.meshes[0].primitives[0].indices !== undefined, true, 'the primitive has an index accessor');
  assert.equal(json.accessors[0].count, cpp.vertexCount, 'the accessor counts the baked vertices');
  assert.equal(json.meshes[0].primitives[0].mode || 4, 4, 'the primitive is triangles');

  /* The same scene through the JavaScript fallback produces the same file. */
  const jsNodes = [{ ...nodes[0], positions: js.positions, normals: js.normals, uvs: js.uvs, indices: js.indices }];
  assert.equal(Buffer.from(W.cpp.buildGLB(jsNodes)).toString('hex'), Buffer.from(glb).toString('hex'),
    'the C++ bake and the JavaScript bake export the same GLB');
});
