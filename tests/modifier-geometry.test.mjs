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
  const source=new THREE.IcosahedronGeometry(1,1),cast=castGeometry(source,{shape:'Cuboid',factor:1,radius:.5}),sphere=castGeometry(source,{shape:'Sphere',factor:1,radius:.5}),cylinder=castGeometry(source,{shape:'Cylinder',factor:1,radius:.5}),displaced=displaceGeometry(source,{strength:1,midlevel:.2,frequency:2});
  for(const result of [cast,sphere,cylinder,displaced]){assert.notDeepEqual(Array.from(result.attributes.position.array),Array.from(source.attributes.position.array));assertFinite(result)}
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
