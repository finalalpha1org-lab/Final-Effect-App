import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('procedural rock meshes contain no zero-area pole facets',()=>{
  const start=html.indexOf('function rockG(pk)');
  const end=html.indexOf('/* ===== biome species:',start);
  assert.ok(start>=0&&end>start,'rock geometry generator should be present');
  let seed=123456789;
  const R=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296};
  const context={THREE,R,DQ:{rock:1.3},cl:(v,a,b)=>Math.max(a,Math.min(b,v))};
  vm.runInNewContext(html.slice(start,end)+';this.buildRock=rockG;',context);
  for(const kind of [undefined,'sand','basalt']){
    const g=context.buildRock(kind),p=g.attributes.position.array,idx=g.index.array;
    let degenerate=0;
    for(let i=0;i<idx.length;i+=3){
      const a=idx[i]*3,b=idx[i+1]*3,c=idx[i+2]*3;
      const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2];
      const vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
      const area2=Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx);
      if(area2<1e-10)degenerate++;
    }
    assert.equal(degenerate,0,`${kind??'standard'} rocks should not contain degenerate triangles`);
    const normals=g.attributes.normal.array;
    assert.ok(Array.from(normals).every(Number.isFinite),'rock normals should be finite');
  }
});

test('rocks avoid the high-frequency global detail/bump injection that produces zoom shimmer',()=>{
  assert.match(html,/mk\('rock',1000,\[0,1,2\]\.map\(v=>\[rockG\(\),\{nt:1,std:1,vi:v,vn:3\}\]\),true\)/,
    'rocks retain their vertex-colour/PBR material but bypass the general terrain-detail shader');
});
