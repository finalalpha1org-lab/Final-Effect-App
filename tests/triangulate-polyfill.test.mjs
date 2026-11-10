/* ============================================================================
   Triangulate - the tessellator, and the modifier that uses it.

   cpp/src/fe_polyfill.cpp is a port of Blender's BLI_polyfill_calc (see
   NOTICE). The contract it has to keep is the one Blender documented above
   that function:

     "The algorithm guarantees all triangles are assigned (number of coords - 2)
      and that triangles will have non-overlapping indices (even for degenerate
      geometry)."

   So every test here counts triangles and measures area. A tessellator that
   loses a triangle punches a hole in the model; one that overlaps two makes a
   face double-sided and breaks the depth buffer.
   ========================================================================= */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import { triangulateGeometry } from '../src/modifier-geometry.mjs';

const wasmBytes = readFileSync(appPath('wasm/fe_core_engine.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);

function core() {
  const exp = new WebAssembly.Instance(wasmModule, {}).exports;
  return {
    exp,
    f32(ptr, len) { return new Float32Array(exp.memory.buffer, ptr, len); },
    u32(ptr, len) { return new Uint32Array(exp.memory.buffer, ptr, len); }
  };
}

/* Cut one mesh's worth of faces in a single call. `verts` is a flat xyz list,
   `faces` a list of corner rings of vertex indices. */
function tessellate(c, verts, faces, quadMethod = 0, ngonMethod = 0) {
  const { exp } = c;
  assert.equal(exp.fe_polyfill_begin(), 0, 'the scratch block is allocated');
  const vbuf = c.f32(exp.fe_polyfill_positions_ptr(), verts.length);
  vbuf.set(verts);
  let corners = 0;
  for (const face of faces) corners += face.length;
  const ring = c.u32(exp.fe_polyfill_ring_ptr(), corners);
  const start = c.u32(exp.fe_polyfill_start_ptr(), faces.length + 1);
  let at = 0;
  for (let f = 0; f < faces.length; f++) {
    start[f] = at;
    for (const v of faces[f]) ring[at++] = v;
  }
  start[faces.length] = at;
  const count = exp.fe_polyfill_build(verts.length / 3, faces.length, corners, quadMethod, ngonMethod);
  assert.ok(count >= 0, `the cut succeeds (code ${count})`);
  const out = c.u32(exp.fe_polyfill_tris_ptr(), count * 3).slice();
  const tris = [];
  for (let i = 0; i < count; i++) tris.push([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
  return tris;
}

const area3 = (verts, tri) => {
  const p = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  const [a, b, c] = tri.map(p);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
};
const totalArea = (verts, tris) => tris.reduce((sum, tri) => sum + area3(verts, tri), 0);
const normalZ = (verts, tri) => {
  const p = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  const [a, b, c] = tri.map(p);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return ux * vy - uy * vx;
};

test('an n-gon yields exactly n-2 triangles and keeps the whole area', () => {
  const c = core();
  const n = 12;
  const verts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    verts.push(Math.cos(a), Math.sin(a), 0);
  }
  const tris = tessellate(c, verts, [Array.from({ length: n }, (_, i) => i)]);
  assert.equal(tris.length, n - 2, 'a polygon of n corners is n-2 triangles');
  const expected = (n / 2) * Math.sin((2 * Math.PI) / n);
  assert.ok(Math.abs(totalArea(verts, tris) - expected) < 1e-5,
    `the cut covers the polygon (${totalArea(verts, tris)} vs ${expected})`);
});

test('a concave n-gon is cut along its notch, not across it', () => {
  const c = core();
  /* An L: the ear clipper has to notice that corner 3 points inwards. */
  const verts = [0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0];
  const tris = tessellate(c, verts, [[0, 1, 2, 3, 4, 5]]);
  assert.equal(tris.length, 4, 'six corners are four triangles');
  assert.ok(Math.abs(totalArea(verts, tris) - 3) < 1e-5, 'the L covers three unit squares');
  /* No triangle may contain the reflex corner and both of its neighbours at
     once - that is the cut a fan would make across the notch. */
  for (const tri of tris) assert.ok(!(tri.includes(3) && tri.includes(1) && tri.includes(4)),
    'the notch is not spanned by a single triangle');
});

test('a quad is cut on its shorter diagonal, and the winding is kept', () => {
  const c = core();
  /* A quad whose diagonal 1-3 is much longer than 0-2: the short cut is 0-2. */
  const verts = [0, 0, 0, 4, 0, 0, 1, 1, 0, 0, 1, 0];
  const tris = tessellate(c, verts, [[0, 1, 2, 3]], 1, 0);
  assert.equal(tris.length, 2);
  assert.deepEqual(tris, [[0, 1, 2], [0, 2, 3]], 'the shorter diagonal is 0-2');
  assert.ok(Math.abs(totalArea(verts, tris) - 2.5) < 1e-6, 'both halves add up to the quad');
  for (const tri of tris) assert.ok(normalZ(verts, tri) > 0, 'every triangle faces the way the ring wound');
});

test('a face on any plane keeps the normal it had', () => {
  const c = core();
  const faces = {
    zUp: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    zDown: [0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
    yUp: [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0],
    xUp: [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1],
    diagonal: [0, 0, 0, 1, 1, 0, 2, 2, 1, 1, 1, 1]
  };
  const expected = { zUp: [0, 0, 1], zDown: [0, 0, -1], yUp: [0, 1, 0], xUp: [1, 0, 0] };
  for (const [name, verts] of Object.entries(faces)) {
    const tris = tessellate(c, verts, [[0, 1, 2, 3]], 1, 0);
    assert.equal(tris.length, 2, `${name}: two triangles`);
    if (!expected[name]) continue;
    for (const tri of tris) {
      const p = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
      const [a, b, cc] = tri.map(p);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const len = Math.hypot(...n) || 1;
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(n[k] / len - expected[name][k]) < 1e-5,
          `${name}: triangle faces ${expected[name]}, got ${n.map((x) => (x / len).toFixed(2))}`);
      }
    }
  }
});

test('a degenerate face still produces its n-2 triangles', () => {
  const c = core();
  /* Five collinear corners: no ear is strictly convex, so this is the path that
     would stop half way without Blender's two-pass search and desperate mode. */
  const verts = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0];
  const tris = tessellate(c, verts, [[0, 1, 2, 3, 4]]);
  assert.equal(tris.length, 3, 'n-2 triangles even with no area');
});

test('a self-intersecting ring terminates with n-2 triangles', () => {
  const c = core();
  /* A pentagram: every corner is a tip, and the naive recursive version of
     this algorithm never returns. */
  const verts = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 4;
    verts.push(Math.cos(a), Math.sin(a), 0);
  }
  const tris = tessellate(c, verts, [Array.from({ length: 10 }, (_, i) => i)]);
  assert.equal(tris.length, 8);
});

test('a whole mesh is cut in one call, quads and n-gons together', () => {
  const c = core();
  /* A 16-sided cylinder: two n-gon caps and sixteen side quads. */
  const s = 16;
  const verts = [];
  for (let i = 0; i < s; i++) { const a = (i / s) * Math.PI * 2; verts.push(Math.cos(a), Math.sin(a), 0); }
  for (let i = 0; i < s; i++) { const a = (i / s) * Math.PI * 2; verts.push(Math.cos(a), Math.sin(a), 1); }
  const faces = [Array.from({ length: s }, (_, i) => i), Array.from({ length: s }, (_, i) => s + (s - 1 - i))];
  for (let i = 0; i < s; i++) faces.push([i, (i + 1) % s, s + ((i + 1) % s), s + i]);
  const tris = tessellate(c, verts, faces, 1, 0);
  assert.equal(tris.length, 2 * (s - 2) + 2 * s, 'both caps and all sides are triangulated');
  assert.equal(c.exp.fe_polyfill_quad_count(), s, 'the sides are counted as quads');
  assert.equal(c.exp.fe_polyfill_ngon_count(), 2, 'the two caps are counted as n-gons');
  const capArea = totalArea(verts, tris.filter((t) => t.every((v) => v < s)));
  const expected = (s / 2) * Math.sin((2 * Math.PI) / s);
  assert.ok(Math.abs(capArea - expected) < 1e-5, 'the bottom cap covers its polygon exactly');
});

test('the third pass refuses a mesh past its caps instead of writing off the end', () => {
  const c = core();
  const { exp } = c;
  assert.equal(exp.fe_polyfill_begin(), 0);
  assert.equal(exp.fe_polyfill_build(exp.fe_polyfill_max_vertices() + 1, 1, 3, 0, 0), -3);
  assert.equal(exp.fe_polyfill_build(4, exp.fe_polyfill_max_faces() + 1, 12, 0, 0), -3);
  assert.equal(exp.fe_polyfill_build(4, 1, exp.fe_polyfill_max_corners() + 1, 0, 0), -3);
  assert.equal(exp.fe_polyfill_build(0, 0, 0, 0, 0), 0, 'nothing to do is not an error');
});

/* ------------------------------------------------------------------ modifier -- */

function polyEngine(exp) {
  const sandbox = {
    window: { THREE, FECppEngine: { ready: true, exports: exp } },
    THREE,
    console
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(readFileSync(appPath('fe-poly.js'), 'utf8'), sandbox, { filename: 'fe-poly.js' });
  /* In a browser `window` *is* `globalThis`; in a test it is not, so both the
     face layer and the modifier's kernel bridge have to be given the engine. */
  globalThis.FECppEngine = { ready: true, exports: exp };
  globalThis.FEPoly = sandbox.window.FEPoly;
  return sandbox.window.FEPoly;
}

function octagonGeometry() {
  /* A cap built the way the app builds one: eight triangles fanning out of a
     centre vertex, with the ring declared so the face layer knows it is one
     face and not eight. */
  const n = 8;
  const positions = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    positions.push(Math.cos(a), Math.sin(a), 0);
  }
  const index = [];
  for (let i = 0; i < n; i++) index.push(0, 1 + i, 1 + ((i + 1) % n));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.userData.feFaces = [Array.from({ length: n }, (_, i) => 1 + i)];
  geometry.userData.feFaceVerts = positions.length / 3;
  return geometry;
}

/* A modifier returns a triangle soup: three vertices per triangle, no index. */
function trianglesOf(geometry) {
  assert.equal(geometry.index, null, 'the modifier returns non-indexed faces');
  const pos = geometry.attributes.position;
  assert.equal(pos.count % 3, 0);
  const tris = [];
  for (let i = 0; i < pos.count; i += 3) {
    tris.push([
      [pos.getX(i), pos.getY(i), pos.getZ(i)],
      [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)],
      [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)]
    ]);
  }
  return tris;
}

const triArea = ([a, b, c]) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
};

test('the Triangulate modifier cuts an n-gon cap into n-2 triangles', () => {
  const { exp } = core();
  polyEngine(exp);
  const geometry = octagonGeometry();
  const out = triangulateGeometry(geometry, { quadMethod: 'Shortest Diagonal', ngonMethod: 'Ear Clip' });
  const tris = trianglesOf(out);
  assert.equal(tris.length, 6, 'an eight-corner cap is six triangles');
  const capArea = tris.reduce((sum, t) => sum + triArea(t), 0);
  assert.ok(Math.abs(capArea - (8 / 2) * Math.sin(Math.PI / 4)) < 1e-5, 'the cut covers the octagon');
  /* The fan's centre vertex is at the origin; a real tessellation of the ring
     never uses it, so no triangle may have a corner there. */
  for (const tri of tris) {
    for (const p of tri) assert.ok(Math.hypot(p[0], p[1]) > 0.5, 'the centre vertex is gone');
  }
});

test('the fan method fans from the first corner, the ear clipper does not', () => {
  const { exp } = core();
  polyEngine(exp);
  const geometry = octagonGeometry();
  /* The face is the ring [1..8]; vertex 1 sits at (1, 0, 0). */
  const atFirst = (tri) => tri.some((p) => Math.hypot(p[0] - 1, p[1]) < 1e-5);
  const fan = trianglesOf(triangulateGeometry(geometry, { ngonMethod: 'Fan' }));
  assert.equal(fan.length, 6);
  for (const tri of fan) assert.ok(atFirst(tri), 'every fan triangle touches the first corner');
  const ear = trianglesOf(triangulateGeometry(geometry, { ngonMethod: 'Ear Clip' }));
  assert.equal(ear.length, 6);
  assert.ok(ear.some((tri) => !atFirst(tri)), 'an ear-clipped ring is not a fan');
});

test('a quad modifier cuts the box on one diagonal per face', () => {
  const { exp } = core();
  polyEngine(exp);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tris = trianglesOf(triangulateGeometry(box, { quadMethod: 'Shortest Diagonal' }));
  assert.equal(tris.length, 12, 'six quads are twelve triangles');
  /* Every triangle is half of a face, so no edge may be longer than the face
     diagonal - a cut across a face's own diagonal would be the whole quad. */
  for (const tri of tris) {
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= Math.SQRT2 + 1e-5,
        'no triangle spans more than a face diagonal');
    }
  }
});

test('without a face list the modifier still returns a usable triangle mesh', () => {
  const { exp } = core();
  polyEngine(exp);
  delete globalThis.FEPoly;
  delete globalThis.FECppEngine;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const out = triangulateGeometry(geometry);
  assert.equal(out.index, null);
  assert.equal(out.attributes.position.count, 36);
  assert.ok(out.attributes.normal, 'normals survive the fallback');
});
