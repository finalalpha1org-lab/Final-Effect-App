import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import {
  displaceGeometry, solidifyGeometry, wireframeGeometry3D, decimateGeometry, waveGeometry,
  castGeometry, carryVertexWeights, smoothGeometry, weldGeometry, simpleDeformGeometry,
  laplacianSmoothGeometry
} from '../src/modifier-geometry.mjs';

/* =========================================================================
 * Vertex groups: the weight layer Blender's modifiers read.
 *
 *   Solidify      thickness_vertex_group  (MOD_solidify_extrude.cc)
 *   Wireframe     thickness_vertex_group  (bmesh_wireframe.cc)
 *   Displace      vertex_group            (MOD_displace.cc)
 *   Wave / Cast   vertex_group
 *   Decimate      vertex_group + vertex_group_factor (bmesh_decimate_collapse.cc)
 *
 * The weight is uploaded through fe_mod_vgroup_ptr() / fe_mod_set_vgroup(),
 * and every kernel reads it with the same mix Blender uses:
 *
 *   (factor + weight * (1 - factor))
 *
 * so factor 1 means "the group changes nothing" and factor 0 means "the group
 * is the whole story".
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

function plane(segments = 4, size = 2) {
  const g = new THREE.PlaneGeometry(size, size, segments, segments);
  g.computeVertexNormals();
  return g;
}

/* A plane with the left half weighted 1 and the right half 0. */
function halfWeights(geometry) {
  const p = geometry.attributes.position;
  const w = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) w[i] = p.getX(i) < 0 ? 1 : 0;
  return w;
}

test('Solidify moves only the weighted side when the group factor is zero', () => {
  withCore(() => {
    const source = plane(8);
    const weights = halfWeights(source);
    /* weight factor 0: a vertex outside the group gets no thickness at all. */
    const out = solidifyGeometry(source, 0.2, 0, { vertexWeights: weights, thicknessVertexGroup: 0 });
    const p = out.attributes.position;
    let movedLeft = 0, movedRight = 0;
    for (let i = 0; i < p.count; i++) {
      const z = Math.abs(p.getZ(i));
      if (p.getX(i) < -0.5) movedLeft = Math.max(movedLeft, z);
      if (p.getX(i) > 0.5) movedRight = Math.max(movedRight, z);
    }
    assert.ok(movedLeft > 0.09, `the weighted half should sit at t/2 = 0.1, got ${movedLeft}`);
    assert.ok(movedRight < 1e-6, `the unweighted half must not move, got ${movedRight}`);
  });
});

test('a group factor of one makes the vertex group do nothing', () => {
  withCore(() => {
    const source = plane(6);
    const weights = halfWeights(source);
    const plain = solidifyGeometry(source, 0.15, 0);
    const mixed = solidifyGeometry(source, 0.15, 0, { vertexWeights: weights, thicknessVertexGroup: 1 });
    const a = plain.attributes.position.array, b = mixed.attributes.position.array;
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `vertex ${i} differs`);
  });
});

test('Displace leaves the unweighted vertices exactly where they were', () => {
  withCore(() => {
    const source = plane(6);
    const weights = halfWeights(source);
    const out = displaceGeometry(source, { strength: 0.4, midlevel: 0, frequency: 2, vertexWeights: weights });
    const p = out.attributes.position, src = source.attributes.position;
    let maxLeft = 0, maxRight = 0;
    for (let i = 0; i < p.count; i++) {
      const dz = Math.abs(p.getZ(i) - src.getZ(i));
      if (src.getX(i) < 0) maxLeft = Math.max(maxLeft, dz); else maxRight = Math.max(maxRight, dz);
    }
    assert.ok(maxLeft > 1e-3, 'the weighted half should move');
    assert.equal(maxRight, 0, 'the unweighted half must not move at all');
  });
});

test('inverting the group swaps which side is affected', () => {
  withCore(() => {
    const source = plane(6);
    const weights = halfWeights(source);
    const out = displaceGeometry(source, { strength: 0.4, midlevel: 0, frequency: 2, vertexWeights: weights, invertVertexGroup: true });
    const p = out.attributes.position, src = source.attributes.position;
    let maxLeft = 0, maxRight = 0;
    for (let i = 0; i < p.count; i++) {
      const dz = Math.abs(p.getZ(i) - src.getZ(i));
      if (src.getX(i) < 0) maxLeft = Math.max(maxLeft, dz); else maxRight = Math.max(maxRight, dz);
    }
    assert.equal(maxLeft, 0, 'the inverted group leaves its own vertices alone');
    assert.ok(maxRight > 1e-3, 'and moves the rest');
  });
});

test('Wave and Cast weight their deformation the same way', () => {
  withCore(() => {
    const source = plane(6);
    const weights = halfWeights(source);
    const src = source.attributes.position;
    const wave = waveGeometry(source, { speed: 1, height: 2, width: 2, time: 0, axis: 'Y', vertexWeights: weights });
    const cast = castGeometry(source, { shape: 'Sphere', factor: 1, vertexWeights: weights });
    for (const [name, out] of [['wave', wave], ['cast', cast]]) {
      const p = out.attributes.position;
      let rightMoved = 0;
      for (let i = 0; i < p.count; i++) {
        if (src.getX(i) <= 0) continue;
        const d = Math.hypot(p.getX(i) - src.getX(i), p.getY(i) - src.getY(i), p.getZ(i) - src.getZ(i));
        rightMoved = Math.max(rightMoved, d);
      }
      assert.ok(rightMoved < 1e-6, `${name} moved an unweighted vertex by ${rightMoved}`);
    }
  });
});

test('Wireframe scales the frame thickness by the group', () => {
  withCore(() => {
    const source = plane(4);
    const weights = halfWeights(source);
    const out = wireframeGeometry3D(source, { thickness: 0.1, vertexWeights: weights, thicknessVertexGroup: 0 });
    /* The frame is the offset pair Solidify uses, so the weighted side stands
       0.05 off the plane (t/2 at offset 0) and the unweighted side stays on
       it - flat, not merely thin. */
    const p = out.attributes.position;
    let leftOff = 0, rightOff = 0;
    for (let i = 0; i < p.count; i++) {
      const z = Math.abs(p.getZ(i));
      if (p.getX(i) < -0.2) leftOff = Math.max(leftOff, z);
      if (p.getX(i) > 0.2) rightOff = Math.max(rightOff, z);
    }
    assert.ok(Math.abs(leftOff - 0.05) < 1e-4, `the weighted frame should sit at t/2 = 0.05, got ${leftOff}`);
    assert.ok(rightOff < 1e-6, `unweighted frames should have no thickness, got ${rightOff}`);
  });
});

test('Decimate never collapses an edge with an end outside the group', () => {
  withCore(() => {
    const source = new THREE.PlaneGeometry(2, 2, 12, 12);
    const before = source.index.count / 3;
    /* Left half in the group, right half out. With a strong factor the group
       protects the right half, so the collapse has to come from the left. */
    const weights = halfWeights(source);
    const out = decimateGeometry(source, 0.5, 65000, { vertexWeights: weights, vertexGroupFactor: 10 });
    const after = out.index.count / 3;
    assert.ok(after < before, `it still decimated: ${before} -> ${after}`);
    const p = out.attributes.position;
    /* Every vertex on the protected right half survives, one per original. */
    const rightBefore = [...Array(source.attributes.position.count).keys()]
      .filter(i => source.attributes.position.getX(i) > 0.2).length;
    const rightAfter = [...Array(p.count).keys()].filter(i => p.getX(i) > 0.2).length;
    assert.equal(rightAfter, rightBefore, 'the protected side kept all of its vertices');
  });
});

test('carryVertexWeights re-indexes a weight map onto a rebuilt mesh', () => {
  const source = new THREE.BoxGeometry(1, 1, 1);
  const weights = new Float32Array(source.attributes.position.count);
  for (let i = 0; i < weights.length; i++) weights[i] = source.attributes.position.getY(i) > 0 ? 1 : 0;
  const rebuilt = source.clone().toNonIndexed();
  /* Same positions, three times the vertices: every one of them is at a
     position the source had, so the weights come across exactly. */
  const carried = carryVertexWeights(weights, source, rebuilt);
  assert.equal(carried.length, rebuilt.attributes.position.count);
  for (let i = 0; i < carried.length; i++) {
    const expected = rebuilt.attributes.position.getY(i) > 0 ? 1 : 0;
    assert.equal(carried[i], expected, `vertex ${i}`);
  }
});

/* =========================================================================
 * Wave, ported from MOD_wave.cc's waveModifier_do. The properties that used to
 * be missing - narrowness, lifetime, damping, time offset, falloff, cyclic,
 * start position - are checked against the formula itself rather than a
 * snapshot.
 * ========================================================================= */

/* The body of waveModifier_do, in JavaScript, written from the upstream code:
 * the phase is the distance from the start point minus time * speed, the band
 * is |phase| < width, the profile is a gaussian minus its value at the edge,
 * and lifetime/damping scale the whole thing. */
function waveUpstream(o, x, y, z = 0) {
  const { height = 0, width = 1, speed = 1.5, time = 0, plane = 0, narrowness = 1,
    timeOffset = 0, lifetime = 0, damping = 0, startX = 0, startY = 0, falloff = 0, cyclic = false } = o;
  const w = Math.max(width, 1e-6);
  const minfac = 1 / Math.exp(w * narrowness * w * narrowness);
  const damp = damping === 0 ? 10 : damping;
  const ctime = time;
  let lifefac = height;
  if (lifetime !== 0 && ctime - timeOffset > lifetime) {
    const t = ctime - timeOffset - lifetime;
    lifefac = t > damp ? 0 : height * (1 - Math.sqrt(t / damp));
  }
  if (lifefac === 0) return z;
  const lx = x - startX, ly = y - startY;
  let amplit, dist;
  if (plane === 2) { amplit = Math.hypot(lx, ly); dist = amplit; }
  else if (plane === 1) { amplit = ly; dist = Math.abs(ly); }
  else { amplit = lx; dist = Math.abs(lx); }
  amplit -= (ctime - timeOffset) * speed;
  if (cyclic) {
    const span = 2 * w;
    /* C fmodf: remainder takes the sign of the dividend. */
    amplit = (amplit - w) % span + w;
  }
  let falloffFac = 1;
  if (falloff !== 0) falloffFac = Math.min(1, Math.max(0, 1 - dist / falloff));
  if (falloffFac === 0 || !(amplit > -w && amplit < w)) return z;
  const a = amplit * narrowness;
  return z + lifefac * (1 / Math.exp(a * a) - minfac) * falloffFac;
}

function assertWaveMatches(options, planeLabel) {
  const source = new THREE.PlaneGeometry(4, 4, 16, 16);
  const out = waveGeometry(source, options);
  const src = source.attributes.position, p = out.attributes.position;
  const plane = { X: 0, Y: 1, Radial: 2 }[options.axis ?? 'X'];
  for (let i = 0; i < p.count; i++) {
    const expected = waveUpstream({ ...options, plane },
      src.getX(i), src.getY(i), src.getZ(i));
    assert.ok(Math.abs(p.getZ(i) - expected) < 2e-3,
      `${planeLabel}: vertex ${i} moved ${p.getZ(i).toFixed(5)}, upstream says ${expected.toFixed(5)}`);
  }
  return out;
}

test('Wave is the travelling gaussian of MOD_wave.cc', () => {
  withCore(() => {
    assertWaveMatches({ height: 2, width: 1, speed: 0.5, time: 0.6, axis: 'X', narrowness: 1 }, 'MOD_WAVE_X');
    assertWaveMatches({ height: 1.5, width: 1.2, speed: -0.8, time: 0.3, axis: 'Y', narrowness: 1.7 }, 'MOD_WAVE_Y');
    assertWaveMatches({ height: 1, width: 0.8, speed: 0.4, time: 0.9, axis: 'Radial', narrowness: 0.9 }, 'X|Y circles');
  });
});

test('Wave narrowness sharpens the crest and cyclic wraps the phase', () => {
  withCore(() => {
    const source = new THREE.PlaneGeometry(4, 4, 16, 16);
    const at = (g, x) => {
      const p = g.attributes.position, s = source.attributes.position;
      for (let i = 0; i < p.count; i++) if (Math.abs(s.getX(i) - x) < 1e-6) return Math.abs(p.getZ(i));
      return 0;
    };
    const wide = waveGeometry(source, { height: 1, width: 1, speed: 1, time: 0, axis: 'X', narrowness: 0.5 });
    const sharp = waveGeometry(source, { height: 1, width: 1, speed: 1, time: 0, axis: 'X', narrowness: 2 });
    assert.ok(at(sharp, -0.75) / at(sharp, 0) < at(wide, -0.75) / at(wide, 0),
      `narrowness makes the ridge sharper: sharp ${(at(sharp, -0.75) / at(sharp, 0)).toFixed(3)} vs wide ${(at(wide, -0.75) / at(wide, 0)).toFixed(3)}`);

    /* Cyclic folds the phase back into [-width, width), so a clock far past the
       band still produces a wave instead of a flat plane. */
    const late = waveGeometry(source, { height: 1, width: 1, speed: 1, time: 40, axis: 'X', cyclic: true });
    let moved = 0;
    for (let i = 0; i < late.attributes.position.count; i++) moved = Math.max(moved, Math.abs(late.attributes.position.getZ(i)));
    assert.ok(moved > 0.1, `cyclic keeps the wave alive at t=40, moved ${moved}`);
    for (const v of [-0.5, 0, 0.5, 1.25]) {
      const flat = waveGeometry(source, { height: 1, width: 1, speed: 1, time: 40, axis: 'X' });
      assert.equal(at(flat, v), 0, 'without cyclic everything outside the band stays still');
    }
  });
});

test('Wave lifetime and damping retire the wave after it has expired', () => {
  withCore(() => {
    const peak = (options) => {
      const g = waveGeometry(new THREE.PlaneGeometry(4, 4, 8, 8), options);
      let m = 0;
      for (let i = 0; i < g.attributes.position.count; i++) m = Math.max(m, Math.abs(g.attributes.position.getZ(i)));
      return m;
    };
    const full = 1 - 1 / Math.exp(4); /* crest height at width 2, narrowness 1 */
    const young = peak({ height: 1, width: 2, speed: 0, time: 1, axis: 'X', lifetime: 5, damping: 2 });
    const old = peak({ height: 1, width: 2, speed: 0, time: 6.5, axis: 'X', lifetime: 5, damping: 2 });
    const dead = peak({ height: 1, width: 2, speed: 0, time: 20, axis: 'X', lifetime: 5, damping: 2 });
    assert.ok(Math.abs(young - full) < 2e-3, `full height inside the lifetime, got ${young}`);
    assert.ok(Math.abs(old - full * (1 - Math.sqrt(1.5 / 2))) < 2e-3,
      `damped to height * (1 - sqrt(x/damp)), got ${old}`);
    assert.equal(dead, 0, 'past lifetime + damping it is gone');
  });
});

test('Wave falloff fades with distance and start position moves the origin', () => {
  withCore(() => {
    const source = new THREE.PlaneGeometry(4, 4, 16, 16);
    const at = (g, x) => {
      const p = g.attributes.position, s = source.attributes.position;
      for (let i = 0; i < p.count; i++) if (Math.abs(s.getX(i) - x) < 1e-6) return Math.abs(p.getZ(i));
      return 0;
    };
    const out = waveGeometry(source, { height: 1, width: 2, speed: 0, time: 0, axis: 'X', falloff: 3 });
    assert.ok(at(out, 0) > 0.9, `full height at the origin, got ${at(out, 0)}`);
    assert.ok(at(out, 1.75) < 0.02, `faded at 1.75 from a falloff of 3, got ${at(out, 1.75)}`);
    assert.ok(at(out, 0) > 20 * at(out, 1.75), 'far is at least an order of magnitude below near');

    /* Start X shifts the whole pattern: the crest moves with it. */
    const crest = (g) => {
      let best = -Infinity, where = 0;
      for (let i = 0; i < g.attributes.position.count; i++) {
        const z = g.attributes.position.getZ(i);
        if (z > best) { best = z; where = source.attributes.position.getX(i); }
      }
      return where;
    };
    const origin = waveGeometry(source, { height: 1, width: 1, speed: 0, time: 0, axis: 'X' });
    const shifted = waveGeometry(source, { height: 1, width: 1, speed: 0, time: 0, axis: 'X', startX: 1 });
    assert.equal(crest(origin), 0, 'crest at the origin by default');
    assert.equal(crest(shifted), 1, 'crest follows Start X');
  });
});

/* =========================================================================
 * The second wave of readers: Weld (selection), Smooth, Simple Deform and
 * Laplacian Smooth. Each of them treats the group its own way, because
 * upstream does:
 *
 *   Weld            membership   (weight > 0) != invert  -> merged or not
 *   Smooth          factor       f_new = f_vgroup * fac, skipped at 0
 *   Simple Deform   blend        lerp(orig, deformed, weight)
 *   Laplacian       row scale    every entry of the row times wpaint
 * ========================================================================= */

/* A grid with its middle row pulled up, so smoothing has something to do. */
function ridge(segments = 6, size = 2) {
  const g = new THREE.PlaneGeometry(size, size, segments, segments);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, Math.sin(x * 2.3) * Math.cos(y * 1.7) * 0.25);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function positions(geometry) {
  const p = geometry.attributes.position;
  return Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)]);
}

test('Smooth moves only the weighted vertices, and not the unweighted ones at all', () => {
  withCore(() => {
    const source = ridge();
    const weights = halfWeights(source);
    const out = smoothGeometry(source, { factor: 0.8, iterations: 2, vertexWeights: weights });
    const before = positions(source), after = positions(out);
    let moved = 0, still = 0;
    for (let i = 0; i < before.length; i++) {
      const d = Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1], after[i][2] - before[i][2]);
      if (weights[i] === 0) { assert.ok(d < 1e-6, `weight-0 vertex ${i} moved ${d}`); still++; }
      else if (d > 1e-3) moved++;
    }
    assert.ok(moved > 5, `the weighted half smoothed, ${moved} vertices moved`);
    assert.ok(still > 5, 'and the unweighted half is untouched');

    /* factor 1 makes the group irrelevant: same result as no group at all. */
    const plain = smoothGeometry(source, { factor: 0.8, iterations: 2 });
    const gated = smoothGeometry(source, { factor: 0.8, iterations: 2, vertexWeights: weights.map(() => 1) });
    const a = positions(gated), b = positions(plain);
    for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(a[i][k] - b[i][k]) < 1e-7, 'an all-ones group is the same as no group');
    }
  });
});

test('Weld keeps vertices outside the group out of the merge', () => {
  withCore(() => {
    /* Eight vertices, two coincident squares: every vertex has a twin. */
    const g = new THREE.BufferGeometry();
    const quad = (ox) => [
      ox, 0, 0, ox + 1, 0, 0, ox + 1, 1, 0,
      ox, 0, 0, ox + 1, 1, 0, ox, 1, 0
    ];
    const pos = new Float32Array([...quad(0), ...quad(0)]);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    /* Two triangles per copy, over six vertices each. */
    const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    g.setIndex(idx);
    g.computeVertexNormals();

    /* Without a group the two copies collapse onto one. */
    assert.equal(weldGeometry(g, 1e-4).attributes.position.count, 4,
      'four corners: both copies of the square, and both triangles in each copy, are the same square');

    /* Selecting everything but one vertex leaves that vertex unmergeable. */
    const weights = new Float32Array(12).fill(1);
    weights[6] = 0;
    const out = weldGeometry(g, 1e-4, { vertexWeights: weights });
    assert.equal(out.attributes.position.count, 5, 'the unselected corner keeps its own slot');

    /* Inverting the group selects only that vertex, so nothing merges. */
    const inverted = weldGeometry(g, 1e-4, { vertexWeights: weights, invertVertexGroup: true });
    assert.equal(inverted.attributes.position.count, 12, 'only one vertex is selected, so nothing can meet anything');
  });
});

test('Simple Deform blends toward the deformed position by the weight', () => {
  withCore(() => {
    const box = new THREE.BoxGeometry(2, 2, 2, 2, 2, 2);
    const p = box.attributes.position;
    const half = new Float32Array(p.count).fill(0.5);
    const twisted = simpleDeformGeometry(box, { mode: 'Twist', axis: 'Z', angle: 90 });
    const blended = simpleDeformGeometry(box, { mode: 'Twist', axis: 'Z', angle: 90, vertexWeights: half });
    const src = positions(box), full = positions(twisted), mid = positions(blended);
    for (let i = 0; i < src.length; i++) {
      for (let a = 0; a < 3; a++) {
        const want = src[i][a] + (full[i][a] - src[i][a]) * 0.5;
        assert.ok(Math.abs(mid[i][a] - want) < 1e-5,
          `vertex ${i} axis ${a}: ${mid[i][a]} should be halfway between ${src[i][a]} and ${full[i][a]}`);
      }
    }
    /* Weight 0 is exactly where it started. */
    const frozen = simpleDeformGeometry(box, { mode: 'Twist', axis: 'Z', angle: 90, vertexWeights: new Float32Array(p.count) });
    const still = positions(frozen);
    for (let i = 0; i < src.length; i++) for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(still[i][k] - src[i][k]) < 1e-7, 'a zero group leaves the mesh alone');
    }
  });
});

test('Laplacian Smooth scales each vertex row by its weight', () => {
  withCore(() => {
    const source = ridge(4, 2);
    const weights = halfWeights(source);
    const out = laplacianSmoothGeometry(source, { repeat: 3, lambda: 0.4, lambdaBorder: 0.4, vertexWeights: weights });
    const before = positions(source), after = positions(out);
    let moved = 0;
    for (let i = 0; i < before.length; i++) {
      const d = Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1], after[i][2] - before[i][2]);
      if (weights[i] === 0) assert.ok(d < 1e-5, `weight-0 vertex ${i} moved ${d}`);
      else if (d > 1e-3) moved++;
    }
    assert.ok(moved > 3, `the weighted half relaxed, ${moved} vertices moved`);

    /* A softer row moves less: the diagonal is 1 + |lambda| * wpaint while the
       off-diagonals are proportional to wpaint, so the map is monotone in the
       weight without being linear in it. Every weighted vertex should land
       between where it started and where full weight puts it. */
    const half = laplacianSmoothGeometry(source, {
      repeat: 3, lambda: 0.4, lambdaBorder: 0.4,
      vertexWeights: Float32Array.from(weights, w => w * 0.5)
    });
    const full = positions(out), halfPos = positions(half);
    let bracketed = 0, tested = 0;
    for (let i = 0; i < before.length; i++) {
      if (weights[i] === 0) continue;
      const dFull = Math.hypot(full[i][0] - before[i][0], full[i][1] - before[i][1], full[i][2] - before[i][2]);
      const dHalf = Math.hypot(halfPos[i][0] - before[i][0], halfPos[i][1] - before[i][1], halfPos[i][2] - before[i][2]);
      if (dFull < 1e-4) continue;
      tested++;
      if (dHalf > 0 && dHalf < dFull) bracketed++;
    }
    assert.ok(tested > 3 && bracketed >= tested - 1,
      `a half weight lands between zero and full for ${bracketed}/${tested} vertices`);
  });
});

/* =========================================================================
 * Cast, ported from MOD_cast.cc (sphere_do / cuboid_do). The centre is the
 * object origin - not the bounding-box centre the old kernel used - `radius`
 * limits which vertices move, `size` is the distance the cast pulls to, and
 * `use_x/y/z` choose the components.
 * ========================================================================= */

test('Cast pulls to `size` from the object origin, and `radius` only limits', () => {
  withCore(() => {
    const source = new THREE.IcosahedronGeometry(1, 1);
    /* size 2, no radius limit, sphere: every vertex lands on radius 2. */
    const out = castGeometry(source, { shape: 'Sphere', factor: 1, radius: 0, size: 2 });
    const p = out.attributes.position;
    for (let i = 0; i < p.count; i++) {
      assert.ok(Math.abs(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) - 2) < 1e-5,
        `vertex ${i} should be at 2 from the origin, is ${Math.hypot(p.getX(i), p.getY(i), p.getZ(i)).toFixed(4)}`);
    }

    /* use_radius_as_size makes the radius the distance instead. */
    const fromRadius = castGeometry(source, { shape: 'Sphere', factor: 1, radius: 0.75, useRadiusAsSize: true });
    const q = fromRadius.attributes.position;
    /* radius > 0 also limits, and a unit sphere is outside 0.75 everywhere,
       so the two flags together leave it alone; that is upstream's order too. */
    assert.deepEqual(Array.from(q.array), Array.from(source.attributes.position.array),
      'the radius limit is applied before the size is read from it');

    /* Half the radius: every vertex within 0.5 of the origin moves to 0.5. */
    const sphere = new THREE.SphereGeometry(1, 24, 16);
    const inner = castGeometry(sphere, { shape: 'Sphere', factor: 1, radius: 0.5, size: 0.5 });
    const r = inner.attributes.position, s = sphere.attributes.position;
    for (let i = 0; i < r.count; i++) {
      const d = Math.hypot(s.getX(i), s.getY(i), s.getZ(i));
      if (d > 0.5 + 1e-6) continue;
      assert.ok(Math.abs(Math.hypot(r.getX(i), r.getY(i), r.getZ(i)) - 0.5) < 1e-5, 'inside the radius, cast to 0.5');
    }
  });
});

test('Cast honours the axis toggles and the cylinder rule', () => {
  withCore(() => {
    const source = new THREE.IcosahedronGeometry(1, 1);
    const xOnly = castGeometry(source, { shape: 'Sphere', factor: 1, radius: 0, size: 2, useY: false, useZ: false });
    const p = xOnly.attributes.position, s = source.attributes.position;
    for (let i = 0; i < p.count; i++) {
      assert.ok(Math.abs(p.getY(i) - s.getY(i)) < 1e-6 && Math.abs(p.getZ(i) - s.getZ(i)) < 1e-6,
        'with Y and Z off, only x moves');
      /* The direction is normalised on the full vector, exactly as
         sphere_do() does, and only then is the enabled component written. */
      const d = Math.hypot(s.getX(i), s.getY(i), s.getZ(i));
      assert.ok(Math.abs(p.getX(i) - (s.getX(i) / d) * 2) < 1e-5, 'x takes its scaled direction');
    }
    /* A cylinder clears MOD_CAST_Z, so z is never touched even with Z on. */
    const cyl = castGeometry(source, { shape: 'Cylinder', factor: 1, radius: 0, size: 2 });
    const c = cyl.attributes.position;
    for (let i = 0; i < c.count; i++) {
      assert.ok(Math.abs(c.getZ(i) - s.getZ(i)) < 1e-6, 'a cylinder does not move along its own axis');
      /* A vertex on the axis has no planar direction to normalise, so it is
         left where it is - normalize_v3() of a zero vector is the zero vector. */
      if (Math.hypot(s.getX(i), s.getY(i)) < 1e-6) continue;
      assert.ok(Math.abs(Math.hypot(c.getX(i), c.getY(i)) - 2) < 1e-5, 'and it casts on the XY plane');
    }
    assert.deepEqual(positions(castGeometry(source, { shape: 'Sphere', factor: 0, radius: 0, size: 2 })), positions(source),
      'factor 0 is a no-op');
  });
});

test('Cast is weighted and can be centred on a control object', () => {
  withCore(() => {
    const source = new THREE.IcosahedronGeometry(1, 1);
    const p = source.attributes.position;
    const weights = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) weights[i] = p.getY(i) > 0 ? 1 : 0;
    const out = castGeometry(source, { shape: 'Sphere', factor: 1, radius: 0, size: 2, vertexWeights: weights });
    const q = out.attributes.position, s = positions(source);
    for (let i = 0; i < p.count; i++) {
      if (weights[i] === 0) assert.ok(Math.abs(q.getX(i) - s[i][0]) < 1e-6 && Math.abs(q.getY(i) - s[i][1]) < 1e-6 && Math.abs(q.getZ(i) - s[i][2]) < 1e-6,
        `weight-0 vertex ${i} stays put`);
      else assert.ok(Math.abs(Math.hypot(q.getX(i), q.getY(i), q.getZ(i)) - 2) < 1e-5, 'weighted vertices cast');
    }

    /* A control object at (3, 0, 0) makes the cast a sphere around it. */
    const offset = castGeometry(new THREE.SphereGeometry(0.5, 16, 12), {
      shape: 'Sphere', factor: 1, radius: 0, size: 1, objectCenter: [3, 0, 0]
    });
    const o = offset.attributes.position;
    let worst = 0;
    for (let i = 0; i < o.count; i++) worst = Math.max(worst, Math.abs(Math.hypot(o.getX(i) - 3, o.getY(i), o.getZ(i)) - 1));
    assert.ok(worst < 1e-4, `the cast is centred on the control object (worst ${worst})`);
  });
});

test('Cast use_transform casts in the control object’s frame', () => {
  withCore(() => {
    /* A stretch, not a rotation: a box turned by a quarter turn is the same
       box, so it could not tell the two paths apart. With use_transform the
       cast is the control object's own box, stretched with it. */
    const rel = new THREE.Matrix4().makeTranslation(2, 0, 0)
      .multiply(new THREE.Matrix4().makeScale(2, 1, 1));
    const elements = Array.from(rel.elements);
    const source = new THREE.IcosahedronGeometry(1, 1);
    const size = 1, centre = new THREE.Vector3(2, 0, 0);

    const onBox = (geometry, matrix, offset) => {
      const p = geometry.attributes.position;
      let worst = 0, moved = 0;
      const inv = matrix ? matrix.clone().invert() : null;
      for (let i = 0; i < p.count; i++) {
        const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
        if (inv) v.applyMatrix4(inv); else v.sub(offset);
        /* cuboid_do() puts every vertex on the box surface, so the largest
           of its three coordinates is exactly the box half-extent. */
        const extent = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
        worst = Math.max(worst, Math.abs(extent - size));
        if (v.length() === 0) worst = Infinity;
      }
      if (matrix) {
        const src = source.attributes.position;
        for (let i = 0; i < p.count; i++) {
          if (Math.hypot(p.getX(i) - src.getX(i), p.getY(i) - src.getY(i), p.getZ(i) - src.getZ(i)) > 1e-3) moved++;
        }
      }
      return { worst, moved };
    };

    const plain = castGeometry(source, {
      shape: 'Cuboid', factor: 1, radius: 0, size, objectCenter: [2, 0, 0], objectMatrix: elements
    });
    const turned = castGeometry(source, {
      shape: 'Cuboid', factor: 1, radius: 0, size, objectCenter: [2, 0, 0], objectMatrix: elements, useTransform: true
    });

    /* Without the transform the box is the control object's centre with the
       plain half-extent, in object space. */
    const a = onBox(plain, null, centre);
    assert.ok(a.worst < 1e-4, `plain cast lands on the axis-aligned box, worst ${a.worst}`);

    /* With it the box is the control object's own box, so the same vertices
       read back through the matrix lie on the same ±1 box. A stretched box
       reaches x = 0 and the plain one never does. */
    const b = onBox(turned, rel, centre);
    assert.ok(b.worst < 1e-4, `use_transform lands on the turned box, worst ${b.worst}`);
    const ax = plain.attributes.position, bx = turned.attributes.position;
    let moved = 0;
    for (let i = 0; i < ax.count; i++) {
      if (Math.hypot(ax.getX(i) - bx.getX(i), ax.getY(i) - bx.getY(i), ax.getZ(i) - bx.getZ(i)) > 1e-3) moved++;
    }
    assert.ok(moved > ax.count / 2, `the frame turns the cast, ${moved}/${ax.count} vertices differ`);
  });
});
