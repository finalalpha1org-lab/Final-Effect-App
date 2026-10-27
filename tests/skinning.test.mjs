import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';

/* Skeleton skinning.
 *
 * A rig is the foundation of every animation workflow: posing, keying, IK,
 * retargeting, cloth attachment. Before this kernel the workspace could only
 * bend a mesh through its own bounding box — there were no bones, no bind pose
 * and no weights, so a character could not be animated at all.
 *
 * These tests are here for one reason: skinning is algebra where a wrong sign
 * still produces a moving mesh, only a wrong one. The reference is three.js's
 * own matrix stack, driven as a real rig (bind pose, pose, inverse bind), and
 * the analytic cases are worked by hand so a failure points at the term that is
 * wrong rather than at "the vertices moved".
 */

const WASM = 'wasm/fe_core_engine.wasm';

async function boot() {
  const mod = await WebAssembly.compile(readFileSync(WASM));
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports;
}

const TRS = 10; /* tx ty tz | qx qy qz qw | sx sy sz */

/* A rig fixture: `bones` is [{ parent, pos:[x,y,z], quat:[x,y,z,w] }]. */
function buildRig(exp, bones, verts, normals) {
  const B = bones.length, V = verts.length;
  const parentPtr = exp.fe_skin_begin(B, V);
  assert.ok(parentPtr > 0, 'fe_skin_begin must hand back the rig block');
  const parents = new Int32Array(exp.memory.buffer, parentPtr, B);
  const bind = new Float32Array(exp.memory.buffer, exp.fe_skin_bind_trs_ptr(), B * TRS);
  const pose = new Float32Array(exp.memory.buffer, exp.fe_skin_pose_trs_ptr(), B * TRS);
  const lengths = new Float32Array(exp.memory.buffer, exp.fe_skin_lengths_ptr(), B);
  bones.forEach((b, i) => {
    parents[i] = b.parent === undefined ? -1 : b.parent;
    const q = b.quat || [0, 0, 0, 1];
    const p = b.pos || [0, 0, 0];
    const s = b.scale || [1, 1, 1];
    bind.set([p[0], p[1], p[2], q[0], q[1], q[2], q[3], s[0], s[1], s[2]], i * TRS);
    pose.set([p[0], p[1], p[2], q[0], q[1], q[2], q[3], s[0], s[1], s[2]], i * TRS);
    lengths[i] = b.length === undefined ? 1 : b.length;
  });
  const restP = new Float32Array(exp.memory.buffer, exp.fe_skin_rest_pos_ptr(), V * 3);
  const restN = new Float32Array(exp.memory.buffer, exp.fe_skin_rest_nrm_ptr(), V * 3);
  verts.forEach((v, i) => restP.set(v, i * 3));
  if (normals) normals.forEach((n, i) => restN.set(n, i * 3));
  return { B, V, parents, bind, pose, lengths, restP, restN };
}

function poseBone(rig, bone, { pos, quat, scale }) {
  const o = bone * TRS;
  if (pos) rig.pose.set(pos, o);
  if (quat) rig.pose.set(quat, o + 3);
  if (scale) rig.pose.set(scale, o + 7);
}

function deform(exp, mode) {
  assert.equal(exp.fe_skin_solve(), 0, 'fe_skin_solve must accept the rig');
  assert.equal(exp.fe_skin_deform(mode || 0), 0, 'fe_skin_deform must run');
  const V = exp.fe_skin_vert_capacity();
  const out = new Float32Array(exp.memory.buffer, exp.fe_skin_out_pos_ptr(), V * 3).slice();
  const nrm = new Float32Array(exp.memory.buffer, exp.fe_skin_out_nrm_ptr(), V * 3).slice();
  return { out, nrm, V };
}

function setInfluences(exp, vertex, pairs) {
  const w = new Float32Array(exp.memory.buffer, exp.fe_skin_weights_ptr(), 4 * exp.fe_skin_vert_capacity());
  const i = new Uint16Array(exp.memory.buffer, exp.fe_skin_indices_ptr(), 4 * exp.fe_skin_vert_capacity());
  for (let s = 0; s < 4; s++) {
    const pair = pairs[s];
    w[vertex * 4 + s] = pair ? pair[1] : 0;
    i[vertex * 4 + s] = pair ? pair[0] : 0;
  }
  const sum = pairs.reduce((a, p) => a + (p ? p[1] : 0), 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, 'a fixture must hand in normalised weights');
}

const qrot = (axis, deg) => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
};

test('an unposed rig is the identity, exactly', async () => {
  const exp = await boot();
  const verts = [[0, 0, 0], [1, 2, 3], [-4.5, 0.25, 8]];
  const rig = buildRig(exp, [
    { parent: -1 },
    { parent: 0, pos: [0, 1, 0] },
  ], verts, [[0, 1, 0], [1, 0, 0], [0, 0, 1]]);
  setInfluences(exp, 0, [[0, 1]]);
  setInfluences(exp, 1, [[1, 1]]);
  setInfluences(exp, 2, [[0, 1]]);
  const { out, nrm } = deform(exp, 0);
  for (let v = 0; v < verts.length; v++) {
    for (let k = 0; k < 3; k++) {
      assert.equal(out[v * 3 + k], verts[v][k], `vertex ${v} must not move in the rest pose`);
    }
  }
  assert.ok(Math.abs(nrm[1] - 1) < 1e-6, 'normals survive an identity pose');
});

test('a 90 degree bone rotation is the analytic rotation about the bone head', async () => {
  const exp = await boot();
  /* One bone at the origin, pointing up its local +Y. */
  const rig = buildRig(exp, [{ parent: -1, length: 1 }], [[0, 2.5, 0]], [[0, 1, 0]]);
  setInfluences(exp, 0, [[0, 1]]);
  poseBone(rig, 0, { quat: qrot([1, 0, 0], 90) });
  const { out } = deform(exp, 0);
  /* +X by +90 degrees sends (0, 2.5, 0) to (0, 0, 2.5). */
  assert.ok(Math.abs(out[0]) < 1e-5, `x ${out[0]}`);
  assert.ok(Math.abs(out[1]) < 1e-5, `y ${out[1]}`);
  assert.ok(Math.abs(out[2] - 2.5) < 1e-5, `z ${out[2]}`);
});

test('a child bone rotates about its own head, not the root', async () => {
  const exp = await boot();
  const rig = buildRig(exp, [
    { parent: -1, length: 1 },
    { parent: 0, pos: [0, 1, 0], length: 1 },
    { parent: 1, pos: [0, 2, 0], length: 1 },
  ], [[0, 2.5, 0]], [[0, 1, 0]]);
  setInfluences(exp, 0, [[2, 1]]); /* welded to the last bone */
  poseBone(rig, 1, { quat: qrot([1, 0, 0], 90) });
  const { out } = deform(exp, 0);
  /* The pivot is the child's head at (0, 1, 0): the vertex is 1.5 m along the
     bone, so the rotation sends it to (0, 1, 1.5). */
  assert.ok(Math.abs(out[0]) < 1e-5, `x ${out[0]}`);
  assert.ok(Math.abs(out[1] - 1) < 1e-5, `y ${out[1]}`);
  assert.ok(Math.abs(out[2] - 1.5) < 1e-5, `z ${out[2]}`);
});

test('the whole kinematics match a three.js rig, bone by bone', async () => {
  const exp = await boot();
  const bones = [
    { parent: -1, pos: [0, 0, 0], quat: qrot([0, 0, 1], 20) },
    { parent: 0, pos: [0, 1, 0], quat: qrot([1, 0, 0], -35) },
    { parent: 1, pos: [0, 0.8, 0], quat: qrot([0, 1, 0], 55) },
    { parent: 0, pos: [0.3, 0.4, 0], quat: qrot([0, 0, 1], 70) },
  ];
  const verts = [[0, 1.2, 0], [0.1, 0.8, 0.2], [0.3, 0.5, 0], [0.9, 0.9, -0.4]];
  buildRig(exp, bones, verts, verts.map(() => [0, 1, 0]));

  /* Reference: the same hierarchy as Object3Ds, bound and posed. */
  const objects = bones.map((b) => {
    const o = new THREE.Object3D();
    o.position.fromArray(b.pos);
    o.quaternion.fromArray(b.quat);
    return o;
  });
  objects.forEach((o, i) => {
    const parent = bones[i].parent;
    if (parent >= 0) objects[parent].add(o);
  });
  objects.forEach((o) => o.updateMatrixWorld(true));
  const inverseBind = objects.map((o) => new THREE.Matrix4().copy(o.matrixWorld).invert());

  /* Pose: bend the first two bones. */
  objects[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.6);
  objects[1].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.9);
  objects.forEach((o) => o.updateMatrixWorld(true));
  const skin = objects.map((o, i) => new THREE.Matrix4().multiplyMatrices(o.matrixWorld, inverseBind[i]));

  /* The same pose into the kernel. */
  const rig = { };
  rig.bind = new Float32Array(exp.memory.buffer, exp.fe_skin_bind_trs_ptr(), bones.length * TRS);
  rig.pose = new Float32Array(exp.memory.buffer, exp.fe_skin_pose_trs_ptr(), bones.length * TRS);
  rig.pose.set(rig.bind);
  rig.pose.set([0, 0, 0, ...qrot([0, 0, 1], -34.377)], 0);       /* -0.6 rad */
  rig.pose.set([0, 1, 0, ...qrot([1, 0, 0], 51.566)], TRS);      /* 0.9 rad */

  setInfluences(exp, 0, [[3, 0.7], [0, 0.3]]);
  setInfluences(exp, 1, [[1, 1]]);
  setInfluences(exp, 2, [[2, 0.6], [1, 0.4]]);
  setInfluences(exp, 3, [[3, 1]]);
  const { out } = deform(exp, 0);

  for (let v = 0; v < verts.length; v++) {
    const p = new THREE.Vector3(...verts[v]);
    /* Weighted sum of the reference skin matrices, exactly what LBS is. */
    const w = [0, 0, 0, 0], idx = [0, 0, 0, 0];
    const wp = new Float32Array(exp.memory.buffer, exp.fe_skin_weights_ptr(), 4 * exp.fe_skin_vert_capacity());
    const ip = new Uint16Array(exp.memory.buffer, exp.fe_skin_indices_ptr(), 4 * exp.fe_skin_vert_capacity());
    for (let s = 0; s < 4; s++) { w[s] = wp[v * 4 + s]; idx[s] = ip[v * 4 + s]; }
    const want = new THREE.Vector3();
    for (let s = 0; s < 4; s++) {
      if (!w[s]) continue;
      want.addScaledVector(p.clone().applyMatrix4(skin[idx[s]]), w[s]);
    }
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(out[v * 3 + k] - want.getComponent(k)) < 1e-4,
        `vertex ${v} component ${k}: ${out[v * 3 + k]} vs ${want.getComponent(k)}`);
    }
  }
});

test('auto weights are a normalised convex combination near the bone', async () => {
  const exp = await boot();
  /* Three bones in a 3 m column. A bone's position is its offset from its
     parent, so these heads land at y = 0, 1 and 2 — not 0, 1 and 3. */
  buildRig(exp, [
    { parent: -1, pos: [0, 0, 0], length: 1 },
    { parent: 0, pos: [0, 1, 0], length: 1 },
    { parent: 1, pos: [0, 1, 0], length: 1 },
  /* Off the bone axis by 5 cm: a vertex exactly on a shared joint is genuinely
     equidistant from the bone above and the bone below, and splitting it is the
     correct answer there, not a tie to be broken. */
  ], [[0.05, 0.3, 0], [0.05, 1.3, 0], [0.05, 2.3, 0], [0.05, 1.5, 0]], [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]]);
  assert.equal(exp.fe_skin_auto_weights(4, 4), 0, 'auto weights must run');

  const W = new Float32Array(exp.memory.buffer, exp.fe_skin_weights_ptr(), 4 * 4);
  const I = new Uint16Array(exp.memory.buffer, exp.fe_skin_indices_ptr(), 4 * 4);
  for (let v = 0; v < 4; v++) {
    let sum = 0, max = 0, maxBone = -1;
    for (let s = 0; s < 4; s++) {
      const w = W[v * 4 + s];
      assert.ok(w >= 0 && w <= 1, `weight ${w} out of range`);
      assert.ok(I[v * 4 + s] < 3, `bone index ${I[v * 4 + s]} out of range`);
      sum += w;
      if (w > max) { max = w; maxBone = I[v * 4 + s]; }
    }
    assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${v} weights sum to ${sum}`);
    assert.equal(maxBone, v === 3 ? 1 : v, `vertex ${v} is dominated by the bone it sits on`);
    assert.ok(max > 0.5, `vertex ${v} dominance ${max}`);
  }
});

test('dual quaternions survive a half turn where linear blending collapses', async () => {
  const exp = await boot();
  /* Two root bones so each skin matrix is just its own pose. */
  const rig = buildRig(exp, [
    { parent: -1, length: 1 },
    { parent: -1, length: 1 },
  ], [[1, 0, 0]], [[1, 0, 0]]);
  /* The second bone is bound upright and *posed* half a turn: the skin matrix
     is then a 180 degree rotation, which is the case that breaks LBS. */
  rig.pose.set(qrot([0, 1, 0], 180), TRS + 3);
  setInfluences(exp, 0, [[0, 0.5], [1, 0.5]]);

  const linear = deform(exp, 0).out;
  const radiusLinear = Math.hypot(linear[0], linear[1], linear[2]);
  assert.ok(radiusLinear < 0.05, `linear blend skinning collapses the twist, radius ${radiusLinear}`);

  const dual = deform(exp, 1).out;
  const radiusDual = Math.hypot(dual[0], dual[1], dual[2]);
  assert.ok(Math.abs(radiusDual - 1) < 1e-4, `dual quaternions keep the surface on its radius, got ${radiusDual}`);
  assert.ok(Math.abs(dual[2] + 1) < 1e-4, 'and place it at the halfway rotation (about -Z)');
  void rig;
});

test('a bad rig is refused instead of drawn', async () => {
  const exp = await boot();
  assert.equal(exp.fe_skin_begin(0, 1), 0, 'no bones is not a rig');
  assert.equal(exp.fe_skin_begin(257, 1), 0, 'more than 256 bones is refused');
  assert.equal(exp.fe_skin_begin(1, 0), 0, 'no vertices is not a mesh');
  assert.equal(exp.fe_skin_begin(1, 65537), 0, 'more than 65536 vertices is refused');

  /* A cycle must be reported, not walked forever. */
  const rig = buildRig(exp, [
    { parent: 1 },
    { parent: 0 },
  ], [[0, 0, 0]], null);
  rig.parents[0] = 1;
  rig.parents[1] = 0;
  assert.equal(exp.fe_skin_solve(), -3, 'a cyclic hierarchy is refused');

  const good = buildRig(exp, [{ parent: -1 }], [[0, 0, 0]], null);
  void good;
  assert.equal(exp.fe_skin_set_weight(0, 5, 0.5), -2, 'an out-of-range bone is refused');
  assert.equal(exp.fe_skin_set_weight(9, 0, 0.5), -2, 'an out-of-range vertex is refused');
});

test('65k vertices with four influences fit in a frame', async () => {
  const exp = await boot();
  const B = 24, V = 65536;
  const parentPtr = exp.fe_skin_begin(B, V);
  assert.ok(parentPtr > 0);
  const parents = new Int32Array(exp.memory.buffer, parentPtr, B);
  const bind = new Float32Array(exp.memory.buffer, exp.fe_skin_bind_trs_ptr(), B * TRS);
  const pose = new Float32Array(exp.memory.buffer, exp.fe_skin_pose_trs_ptr(), B * TRS);
  const lengths = new Float32Array(exp.memory.buffer, exp.fe_skin_lengths_ptr(), B);
  for (let b = 0; b < B; b++) {
    parents[b] = b === 0 ? -1 : b - 1;
    bind.set([0, b * 0.25, 0, 0, 0, 0, 1, 1, 1, 1], b * TRS);
    lengths[b] = 0.25;
  }
  pose.set(bind);
  const restP = new Float32Array(exp.memory.buffer, exp.fe_skin_rest_pos_ptr(), V * 3);
  for (let v = 0; v < V; v++) restP.set([(v % 64) * 0.02, (v % 400) * 0.01, 0.1], v * 3);
  assert.equal(exp.fe_skin_auto_weights(4, 4), 0);

  pose.set(qrot([0, 0, 1], 12), 3);
  assert.equal(exp.fe_skin_solve(), 0);
  exp.fe_skin_deform(0);
  const t0 = performance.now();
  for (let pass = 0; pass < 3; pass++) {
    exp.fe_skin_solve();
    exp.fe_skin_deform(0);
  }
  const per = (performance.now() - t0) / 3;
  /* 65 536 vertices x 4 influences. A phone is several times slower than this
     machine, so the budget is generous — it still fails if the inner loop
     stops being a flat four-tap accumulate. */
  assert.ok(per < 40, `skinning 65k vertices took ${per.toFixed(2)} ms per pass`);
});
