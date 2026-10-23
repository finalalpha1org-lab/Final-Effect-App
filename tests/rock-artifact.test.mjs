import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');
const wasmBytes=readFileSync(appPath('fe_core_engine.wasm'));

function degenerateTriangles(pos,idx){
  let degenerate=0;
  for(let i=0;i<idx.length;i+=3){
    const a=idx[i]*3,b=idx[i+1]*3,c=idx[i+2]*3;
    const ux=pos[b]-pos[a],uy=pos[b+1]-pos[a+1],uz=pos[b+2]-pos[a+2];
    const vx=pos[c]-pos[a],vy=pos[c+1]-pos[a+1],vz=pos[c+2]-pos[a+2];
    const area2=Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx);
    if(area2<1e-10)degenerate++;
  }
  return degenerate;
}

test('procedural rock meshes contain no zero-area pole facets',()=>{
  /* The rocks that ship now come from the C++ kernel, so the pole-facet and
     normal guarantees are asserted against the actual artifact the studio
     builds its InstancedMesh from - not only against the JS fallback. */
  const instance=new WebAssembly.Instance(new WebAssembly.Module(wasmBytes),{});
  const e=instance.exports;
  const f32=(p,n)=>new Float32Array(e.memory.buffer,p,n);
  assert.equal(e.fe_flora_rock_kind_count(),3,'granite, sandstone and basalt must all be available');
  for(let kind=0;kind<3;kind++){
    e.fe_flora_rock(kind,7+kind*13,2);
    const nv=e.fe_flora_vert_count(),ni=e.fe_flora_index_count();
    assert.ok(nv>500&&ni>1500,`rock ${kind} should build a full mesh (got ${nv} verts / ${ni} indices)`);
    const pos=f32(e.fe_flora_pos_ptr(),nv*3);
    const nrm=f32(e.fe_flora_nrm_ptr(),nv*3);
    const col=f32(e.fe_flora_col_ptr(),nv*3);
    const idx=new Uint32Array(e.memory.buffer,e.fe_flora_idx_ptr(),ni);
    assert.equal(degenerateTriangles(pos,idx),0,`engine rock ${kind} should not contain degenerate triangles`);
    assert.ok(Array.from(nrm).every(Number.isFinite),'engine rock normals should be finite');
    assert.ok(Array.from(nrm).some(v=>Math.abs(v)>0.5),'engine rocks must carry real surface normals');
    assert.ok(Array.from(col).every(Number.isFinite)&&Array.from(col).some(v=>v>0.05),
      'engine rocks must carry per-vertex mineral / lichen colour, not black');
  }
});

test('the JS rock fallback still produces watertight, finite meshes',()=>{
  const start=html.indexOf('function rockGJs(pk)');
  const end=html.indexOf('/* ===== biome species:',start);
  assert.ok(start>=0&&end>start,'rock fallback generator should be present for artifacts older than the flora kernel');
  let seed=123456789;
  const R=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296};
  const context={THREE,R,DQ:{rock:1.3},cl:(v,a,b)=>Math.max(a,Math.min(b,v))};
  vm.runInNewContext(html.slice(start,end)+';this.buildRock=rockGJs;',context);
  for(const kind of [undefined,'sand','basalt']){
    const g=context.buildRock(kind),p=g.attributes.position.array,idx=g.index.array;
    assert.equal(degenerateTriangles(p,idx),0,`${kind??'standard'} rocks should not contain degenerate triangles`);
    const normals=g.attributes.normal.array;
    assert.ok(Array.from(normals).every(Number.isFinite),'rock normals should be finite');
  }
});

test('rocks avoid the high-frequency global detail/bump injection that produces zoom shimmer',()=>{
  assert.match(html,/mk\('rock',1000,\[0,1,2\]\.map\(v=>\[rockBuilder\(\),\{nt:1,std:1,vi:v,vn:3\}\]\),true\)/,
    'rocks retain their vertex-colour/PBR material but bypass the general terrain-detail shader');
  assert.match(html,/function rockBuilder\(pk\)/,'rocks resolve through the grown-flora builder so they can upgrade in place');
});
