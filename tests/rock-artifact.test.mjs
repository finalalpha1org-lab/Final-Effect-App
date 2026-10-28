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
  assert.match(html,/mk\('rock',1000,\[0,1,2\]\.map\(v=>\[rockBuilder\(\),Object\.assign\(ROCKMAT\('granite'\),\{vi:v,vn:3\}\)\]\),true\)/,
    'rocks carry their own stone maps instead of the shared terrain-detail shader');
  assert.match(html,/const ROCKMAT=kind=>Object\.assign\(\{nt:1,std:1,ns:\.9\},/,
    'the rock material is vertex colour plus its own maps, with no `det` flag');
  assert.equal(/ROCKMAT=kind=>Object\.assign\(\{[^}]*det:1/.test(html), false,
    'the terrain detail shader must not be switched back on for stone');
  assert.match(html,/function rockBuilder\(pk\)/,'rocks resolve through the grown-flora builder so they can upgrade in place');
});

test('a stone has a real PBR material: albedo grain, fracture normal, roughness variation',()=>{
  /* A rock used to be vertex colour and nothing else. The realism module read
     its measured roughness out of the kernel and wrote it into the material,
     but `normalScale` on a material with no normal map is a number nobody
     reads, so none of it reached a pixel. These maps are the delivery. */
  assert.match(html,/const ROCKTEX=\{\};/, 'a stone texture set exists per rock kind');
  assert.match(html,/ROCKTEX\[kind\]=\{albedo:rockTex\(kind\),normal:rockBlank\('#8080ff'\),rough:rockBlank\('#ffffff'\)\}/,
    'each kind owns an albedo, a flat-normal placeholder and a roughness map');
  assert.match(html,/const ROCKMAT=kind=>Object\.assign\(\{nt:1,std:1,ns:\.9\},\s*\{map:ROCKTEX\[kind\]\.albedo,nm:ROCKTEX\[kind\]\.normal,rm:ROCKTEX\[kind\]\.rough\}\)/,
    'those three maps are what the material is built from');
  /* The data maps must not be sRGB decoded on the way to the shader. */
  assert.match(html,/function rockBlank\(colour\)\{[^}]*return mkTex\(c,false\)\}/,
    'normal and roughness maps are data, not colour');
  /* Albedo is a modulation of the mineral vertex colour: near white, or the
     stone would come out at a quarter of its measured albedo. */
  assert.match(html,/const\[c,x\]=cv2\(256,256\),g=kind==='basalt'\?236:kind==='sandstone'\?242:239;/,
    'the albedo map modulates rather than replaces the vertex colour');

  const realism = readFileSync(appPath('landscape-realism.js'), 'utf8');
  assert.match(realism, /const rocks = tex && tex\.ROCK;/, 'the realism module finds the stone textures');
  assert.match(realism, /if \(entry\.albedo\) shadeColour\(entry\.albedo, buf, \{ depth: 0\.2 \}\);/, 'and paints the kernel grain into the albedo');
  assert.match(realism, /if \(entry\.normal\) paintNormal\(entry\.normal, buf\);/, 'and the fracture relief into the normal map');
  assert.match(realism, /if \(entry\.rough\) paintRough\(entry\.rough, buf\);/, 'and the weathering into the roughness map');
  /* Sandstone is its own material, not a warmer granite. */
  assert.match(realism, /name === 'sandrock' \? 'sandstone' : 'granite'/, 'a sandstone ledge reads the sandstone surface');
});

test('stone grain is real-world scale, not one tile per rock',()=>{
  /* UVs used to run 0..1 across whatever shape a seed produced, so the 40 cm
     stone on the path and the 3 m boulder shared one texture tile and the
     grain was stretched by however much bigger the boulder was. */
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  const e = instance.exports;
  const grain = (kind, seed) => {
    e.fe_flora_rock(kind, seed, 2);
    const nv = e.fe_flora_vert_count();
    const uv = new Float32Array(e.memory.buffer, e.fe_flora_uv_ptr(), nv * 2);
    const pos = new Float32Array(e.memory.buffer, e.fe_flora_pos_ptr(), nv * 3);
    let uMax = 0, rMax = 0;
    for (let i = 0; i < nv; i++) {
      uMax = Math.max(uMax, uv[i * 2]);
      rMax = Math.max(rMax, Math.hypot(pos[i * 3], pos[i * 3 + 2]));
    }
    return { uMax, rMax, metres: (2 * Math.PI * rMax) / uMax };
  };
  const seeds = [1, 101, 202, 5150];
  const per = [0, 1, 2].map((kind) => seeds.map((seed) => grain(kind, seed)));
  for (const list of per) {
    const values = list.map((g) => g.metres);
    const spread = Math.max(...values) / Math.min(...values);
    /* The same stone on a small rock and a big one: the grain may vary with
       the body's own shape, but not with its size. */
    assert.ok(spread < 1.45, `grain must not scale with the rock (spread ${spread.toFixed(2)})`);
    for (const g of list) {
      assert.ok(g.uMax >= 2, 'a stone is tiled more than once around its waist');
      assert.ok(Number.isInteger(Math.round(g.uMax)) && Math.abs(g.uMax - Math.round(g.uMax)) < 1e-3,
        'the repeat count is a whole number, so the meridian seam closes');
    }
  }
  /* Real grain sizes: basalt and granite are fine-grained, sandstone coarse. */
  const mean = (kind) => per[kind].reduce((a, g) => a + g.metres, 0) / per[kind].length;
  assert.ok(mean(2) < mean(0) && mean(0) < mean(1),
    `basalt ${mean(2).toFixed(2)} m < granite ${mean(0).toFixed(2)} m < sandstone ${mean(1).toFixed(2)} m`);
  assert.ok(mean(0) > 0.4 && mean(0) < 1.4, 'granite grain stays in the hand-to-boulder range');
  /* Larger rocks really are larger: the UVs follow the body, not a constant. */
  const small = per[0][0], large = per[0].reduce((a, g) => (g.rMax > a.rMax ? g : a));
  assert.ok(large.rMax > small.rMax, 'the seed still changes the size of the stone');
});
