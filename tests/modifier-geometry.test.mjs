import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  arrayGeometry, bevelGeometry, booleanGeometry, castGeometry, decimateGeometry, displaceGeometry, mirrorGeometry,
  shrinkwrapGeometry, smoothGeometry, solidifyGeometry, subdivideLoop,
  triangulateGeometry, twistGeometry, validateClosedManifold, waveGeometry, weldGeometry, weightedNormalGeometry,
} from '../src/modifier-geometry.mjs';

function volume(geometry) {
  const p=geometry.attributes.position,idx=geometry.index?.array??Uint32Array.from({length:p.count},(_,i)=>i);let total=0;
  for(let i=0;i+2<idx.length;i+=3){const a=new THREE.Vector3(p.getX(idx[i]),p.getY(idx[i]),p.getZ(idx[i])),b=new THREE.Vector3(p.getX(idx[i+1]),p.getY(idx[i+1]),p.getZ(idx[i+1])),c=new THREE.Vector3(p.getX(idx[i+2]),p.getY(idx[i+2]),p.getZ(idx[i+2]));total+=a.dot(new THREE.Vector3().crossVectors(b,c))/6;}
  return Math.abs(total);
}
function assertFinite(geometry) { const p=geometry.attributes.position; for(let i=0;i<p.count;i++) assert.ok(Number.isFinite(p.getX(i)+p.getY(i)+p.getZ(i))); }

test('Boolean Difference, Union and Intersection produce distinct real solids with transformed operand', () => {
  const target=new THREE.BoxGeometry(2,2,2), operand=new THREE.BoxGeometry(1.5,1.5,1.5), matrix=new THREE.Matrix4().makeTranslation(.5,0,0).elements;
  const cases=[['Difference',5.1875],['Union',8.5625],['Intersection',2.8125]];
  const measured=[];
  for(const [op,expected] of cases){const result=booleanGeometry(target,operand,matrix,op);assertFinite(result);assert.ok(result.attributes.position.count>=12);const v=volume(result);assert.ok(Math.abs(v-expected)<.03,`${op} volume ${v} != ${expected}`);measured.push(v);result.dispose();}
  assert.equal(new Set(measured.map(v=>v.toFixed(3))).size,3);
});

test('Bevel creates real chamfered closed geometry; width, segments, clamp and convex mesh inputs are honored',()=>{
  const source=new THREE.BoxGeometry(2,2,2),one=bevelGeometry(source,{width:.12,segments:1,clampOverlap:true}),many=bevelGeometry(source,{width:.12,segments:4,clampOverlap:true});
  assert.ok(one.attributes.position.count>source.index.count);assert.ok(many.attributes.position.count>one.attributes.position.count);assertFinite(one);assertFinite(many);validateClosedManifold(one,'Bevel output');
  assert.throws(()=>bevelGeometry(source,{width:2,segments:2,clampOverlap:false}),/overlaps/);
  const tetra=bevelGeometry(new THREE.TetrahedronGeometry(2,0),{width:.08,segments:2,clampOverlap:true});assertFinite(tetra);
});

test('Boolean rejects an open operand with an actionable manifold error', () => {
  const target=new THREE.BoxGeometry(2,2,2),open=new THREE.PlaneGeometry(1,1);
  assert.throws(()=>booleanGeometry(target,open,new THREE.Matrix4().elements,'Difference'),/closed manifold/);
});

test('Array duplicates real triangles and preserves custom vertex attributes', () => {
  const source=new THREE.BoxGeometry(1,1,1);source.setAttribute('tag',new THREE.Float32BufferAttribute(new Float32Array(source.attributes.position.count).fill(7),1));
  const result=arrayGeometry(source,{count:3,offset:[2,0,0]});
  assert.equal(result.index.count,source.index.count*3);assert.equal(result.attributes.tag.count,source.attributes.tag.count*3);assert.ok(Math.abs(result.boundingBox.max.x-result.boundingBox.min.x-5)<1e-6);assertFinite(result);
  const relative=arrayGeometry(new THREE.BoxGeometry(1,1,1),{count:2,offset:[0,0,0],relative:[2,0,0]});assert.ok(Math.abs(relative.boundingBox.max.x-relative.boundingBox.min.x-3)<1e-6);
});

test('Mirror reflects about the local origin, reverses winding, and has no legacy translation', () => {
  const source=new THREE.BoxGeometry(1,1,1).translate(1,0,0),result=mirrorGeometry(source,{axes:[true,false,false]});
  assert.ok(Math.abs(result.boundingBox.min.x+1.5)<1e-6);assert.ok(Math.abs(result.boundingBox.max.x-1.5)<1e-6);assert.ok(Math.abs(volume(result)-2)<1e-5);assertFinite(result);
  const clipped=mirrorGeometry(source,{axes:[true,false,false],clipping:true});assert.ok(clipped.index);assert.ok(Math.abs(volume(clipped)-2)<1e-5);
});

test('Triangulate converts indexed mesh triangles to explicit non-indexed faces', () => {
  const source=new THREE.BoxGeometry(1,1,1),result=triangulateGeometry(source);
  assert.equal(result.index,null);assert.equal(result.attributes.position.count,source.index.count);assertFinite(result);
});

test('Weld merges duplicate vertices into indexed topology without changing a closed box', () => {
  const source=new THREE.BoxGeometry(2,2,2).toNonIndexed(),result=weldGeometry(source,1e-6);
  assert.equal(result.attributes.position.count,8);assert.equal(result.index.count,36);assert.ok(Math.abs(volume(result)-8)<1e-5);assertFinite(result);
});

test('Decimate collapses edges and reduces a box triangle count without sampling away the surface', () => {
  const source=new THREE.BoxGeometry(2,2,2),result=decimateGeometry(source,.5);
  assert.ok(result.index.count/3<source.index.count/3);assert.ok(result.index.count/3<=6);assertFinite(result);
});

test('Loop subdivision increases triangle count and smooths a box with finite output', () => {
  const result=subdivideLoop(new THREE.BoxGeometry(2,2,2),1);
  assert.equal(result.index.count/3,48);assertFinite(result);assert.ok(result.attributes.position.count>8);
});

test('Simple subdivision keeps the shape; Catmull-Clark is the one that rounds it', () => {
  /* Blender's two modes: Simple splits the triangles and moves nothing, so the
     silhouette is identical to the cube it came from; Catmull-Clark relaxes. */
  const source = new THREE.BoxGeometry(2, 2, 2);
  const simple = subdivideLoop(source, 2, { simple: true });
  assertFinite(simple);
  assert.equal(simple.index.count / 3, 192);
  assert.deepEqual(simple.boundingBox.min.toArray().map((v) => +v.toFixed(6)), [-1, -1, -1]);
  assert.deepEqual(simple.boundingBox.max.toArray().map((v) => +v.toFixed(6)), [1, 1, 1]);
  const smooth = subdivideLoop(source, 2);
  assert.ok(smooth.boundingBox.max.x < 0.95, `Catmull-Clark pulls the corners in, ${smooth.boundingBox.max.x}`);
});

test('subdivision reports the level it built, and never more than it can hold', () => {
  const source = new THREE.BoxGeometry(2, 2, 2);
  const capped = subdivideLoop(source, 10);
  const info = capped.userData.feSubdivision;
  assert.equal(info.requested, 10);
  assert.ok(info.levels >= 1 && info.levels < 10, `built ${info.levels}`);
  assert.equal(info.limited, true);
  assert.equal(capped.index.count / 3, 12 * 4 ** info.levels);
  const plain = subdivideLoop(source, 2);
  assert.deepEqual(plain.userData.feSubdivision, { requested: 2, levels: 2, simple: false, limited: false });
});

test('Solidify adds a closed rim to a plane and creates measurable thickness', () => {
  const result=solidifyGeometry(new THREE.PlaneGeometry(2,2),.2,0);
  assert.equal(result.index.count/3,12);assert.ok(Math.abs(result.boundingBox.max.z-result.boundingBox.min.z-.2)<1e-5);assertFinite(result);
  const closed=solidifyGeometry(new THREE.BoxGeometry(2,2,2),.1,0);assert.equal(closed.index.count/3,24);assert.ok(Math.abs(closed.boundingBox.max.x-closed.boundingBox.min.x-2.1)<1e-5);assertFinite(closed);
});

test('Wave time and Warp strength produce parameter-dependent vertex motion', () => {
  const source=new THREE.PlaneGeometry(2,2,4,4),waveA=waveGeometry(source,{speed:2,height:1,width:2,time:0}),waveB=waveGeometry(source,{speed:2,height:1,width:2,time:1}),twisted=twistGeometry(new THREE.BoxGeometry(1,2,1),1.5);
  assert.notDeepEqual(Array.from(waveA.attributes.position.array),Array.from(waveB.attributes.position.array));assert.notDeepEqual(Array.from(twisted.attributes.position.array),Array.from(new THREE.BoxGeometry(1,2,1).attributes.position.array));assertFinite(waveA);assertFinite(twisted);
});

test('Cast and procedural displacement change vertices according to parameters', () => {
  /* MOD_cast.cc: `radius` limits which vertices move, it is not a scale. A
     unit-radius source with a 0.5 radius has nothing inside the limit, so the
     mesh stays exactly where it was; `size` is what decides how far the cast
     pulls. */
  const source=new THREE.IcosahedronGeometry(1,1);
  const untouched=castGeometry(source,{shape:'Sphere',factor:1,radius:.5});
  assert.deepEqual(Array.from(untouched.attributes.position.array),Array.from(source.attributes.position.array),'0.5 radius leaves a unit sphere alone');
  const cast=castGeometry(source,{shape:'Cuboid',factor:1,radius:0,size:.5});
  const sphere=castGeometry(source,{shape:'Sphere',factor:1,radius:0,size:.5});
  const cylinder=castGeometry(source,{shape:'Cylinder',factor:1,radius:0,size:.5});
  const displaced=displaceGeometry(source,{strength:1,midlevel:.2,frequency:2});
  for(const result of [cast,sphere,cylinder,displaced]){assert.notDeepEqual(Array.from(result.attributes.position.array),Array.from(source.attributes.position.array));assertFinite(result)}
  /* A cast to `size` puts every moving vertex at that distance from the
     origin, which is what the sphere shape means. */
  const p=sphere.attributes.position;
  for(let i=0;i<p.count;i++) assert.ok(Math.abs(Math.hypot(p.getX(i),p.getY(i),p.getZ(i))-.5)<1e-5,`vertex ${i} should sit at 0.5`);
});

test('Laplacian smoothing and weighted normals produce valid geometry', () => {
  const source=new THREE.IcosahedronGeometry(1,1),smooth=smoothGeometry(source,{factor:.4,iterations:2}),normals=weightedNormalGeometry(source,{weight:75,keepSharp:true});
  assert.notDeepEqual(Array.from(smooth.attributes.position.array),Array.from(weldGeometry(source,1e-7).attributes.position.array));assertFinite(smooth);assertFinite(normals);
});

test('Shrinkwrap projects vertices onto the selected transformed target surface', () => {
  const source=new THREE.SphereGeometry(.25,8,6),target=new THREE.PlaneGeometry(4,4),matrix=new THREE.Matrix4().makeTranslation(0,0,1);
  const result=shrinkwrapGeometry(source,target,matrix.elements,0,'On Surface');
  assert.ok(Math.abs(result.boundingBox.min.z-1)<1e-5);assert.ok(Math.abs(result.boundingBox.max.z-1)<1e-5);assertFinite(result);
});

test('Closed box topology audit reports a manifold and finite triangle count', () => {
  const box=new THREE.BoxGeometry(1,1,1);const report=validateClosedManifold(box);
  assert.equal(report.triangles,12);assert.equal(report.edges,18);assert.equal(report.vertices,8);
});

/* ---- Shrinkwrap, the Project method ------------------------------------- */

test('Shrinkwrap Project casts along the chosen axis and lands on the target', () => {
  const source = new THREE.PlaneGeometry(2, 2, 4, 4);
  const target = new THREE.PlaneGeometry(4, 4, 2, 2);
  const at = (z) => new THREE.Matrix4().makeTranslation(0, 0, z).elements;

  /* A ray straight up hits the plane above it. */
  const up = shrinkwrapGeometry(source, target, at(1), 0, 'On Surface',
    { wrapMethod: 'Project', projectX: false, projectY: false, projectZ: true });
  assertFinite(up);
  const p = up.attributes.position;
  for (let i = 0; i < p.count; i++) assert.ok(Math.abs(p.getZ(i) - 1) < 1e-5, `vertex ${i} at z ${p.getZ(i)}`);

  /* The same plane below, with only the negative direction allowed. */
  const down = shrinkwrapGeometry(source, target, at(-1), 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, positive: false, negative: true });
  const q = down.attributes.position;
  for (let i = 0; i < q.count; i++) assert.ok(Math.abs(q.getZ(i) + 1) < 1e-5, `vertex ${i} at z ${q.getZ(i)}`);

  /* Positive is off, so the plane above is unreachable. */
  const oneWay = shrinkwrapGeometry(source, target, at(1), 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, positive: false, negative: true });
  const r = oneWay.attributes.position;
  for (let i = 0; i < r.count; i++) assert.ok(Math.abs(r.getZ(i)) < 1e-6, 'nothing is up there');
});

test('Shrinkwrap Project honours the limit, the axes and face culling', () => {
  const source = new THREE.PlaneGeometry(2, 2, 4, 4);
  const target = new THREE.PlaneGeometry(4, 4, 2, 2);
  const at = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z).elements;

  /* Far away with a limit shorter than the distance: nothing moves. */
  const limited = shrinkwrapGeometry(source, target, at(0, 0, 10), 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, projectLimit: 1 });
  const l = limited.attributes.position;
  for (let i = 0; i < l.count; i++) assert.ok(Math.abs(l.getZ(i)) < 1e-6, 'the limit keeps the projection from travelling');

  /* Inside the limit it lands. */
  const inside = shrinkwrapGeometry(source, target, at(0, 0, .5), 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, projectLimit: 1 });
  const ins = inside.attributes.position;
  for (let i = 0; i < ins.count; i++) assert.ok(Math.abs(ins.getZ(i) - .5) < 1e-5, 'inside the limit, it lands');

  /* Axis selection: a plane standing in YZ is reached along X only. */
  const wall = new THREE.PlaneGeometry(4, 4, 2, 2).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const alongX = shrinkwrapGeometry(source, wall, at(2, 0, 0), 0, 'On Surface',
    { wrapMethod: 'Project', projectX: true, projectY: false, projectZ: false });
  const ax = alongX.attributes.position;
  let landed = 0;
  for (let i = 0; i < ax.count; i++) if (Math.abs(ax.getX(i) - 2) < 1e-5) landed++;
  assert.ok(landed > 20, `most vertices reach the wall, ${landed} did`);
  /* And the Z axis alone never reaches it. */
  const alongZ = shrinkwrapGeometry(source, wall, at(2, 0, 0), 0, 'On Surface',
    { wrapMethod: 'Project', projectX: false, projectY: false, projectZ: true });
  const az = alongZ.attributes.position, sp = source.attributes.position;
  for (let i = 0; i < az.count; i++) {
    assert.ok(Math.abs(az.getX(i) - sp.getX(i)) < 1e-6 && Math.abs(az.getZ(i) - sp.getZ(i)) < 1e-6,
      'a Z ray does not find a wall along X');
  }

  /* The target faces +Z. A ray going +Z meets its back face: keeping front
     faces only culls it, keeping back faces keeps it. */
  const front = shrinkwrapGeometry(source, target, at(0, 0, 1), 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, cullFace: 'Front' });
  const f = front.attributes.position;
  for (let i = 0; i < f.count; i++) assert.ok(Math.abs(f.getZ(i)) < 1e-6, 'the back face is culled');
  const back = shrinkwrapGeometry(source, target, at(0, 0, 1), 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, cullFace: 'Back' });
  const b = back.attributes.position;
  for (let i = 0; i < b.count; i++) assert.ok(Math.abs(b.getZ(i) - 1) < 1e-5, 'keeping back faces lets it land');
});

test('Shrinkwrap blends onto the surface by the vertex group weight', () => {
  const source = new THREE.PlaneGeometry(2, 2, 4, 4);
  const target = new THREE.PlaneGeometry(4, 4, 2, 2);
  const matrix = new THREE.Matrix4().makeTranslation(0, 0, 1).elements;
  const weights = new Float32Array(source.attributes.position.count).fill(.5);
  const out = shrinkwrapGeometry(source, target, matrix, 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, vertexWeights: weights });
  const p = out.attributes.position;
  for (let i = 0; i < p.count; i++) assert.ok(Math.abs(p.getZ(i) - .5) < 1e-5,
    `a half weight lands halfway (vertex ${i} at ${p.getZ(i)})`);
  const inverted = shrinkwrapGeometry(source, target, matrix, 0, 'On Surface',
    { wrapMethod: 'Project', projectZ: true, vertexWeights: weights, invertVertexGroup: true });
  const q = inverted.attributes.position;
  for (let i = 0; i < q.count; i++) assert.ok(Math.abs(q.getZ(i) - .5) < 1e-5, 'and so does one half of the invert');
});
