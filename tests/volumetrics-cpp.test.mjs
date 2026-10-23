import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/* Eulerian smoke / fire core: staggered MAC grid, semi-Lagrangian transport,
   buoyancy, vorticity confinement, Jacobi pressure projection and a dual
   (surface-nets) isosurface. Everything here is CPU/wasm only - the volume
   shader is not part of this suite. */
const wasm=readFileSync('wasm/fe_core_engine.wasm');
const {instance:{exports:e}}=await WebAssembly.instantiate(wasm,{});
const f32=(ptr,n)=>new Float32Array(e.memory.buffer,ptr,n);
const stats=()=>f32(e.fe_vol_stats_ptr(),6);

function init(n=24){
  assert.equal(e.fe_vol_init(n,n,n),0);
  return {n,density:f32(e.fe_vol_density_ptr(),n**3),temp:f32(e.fe_vol_temperature_ptr(),n**3)};
}
const mass=g=>g.density.reduce((a,b)=>a+b,0);
const comY=g=>{
  let s=0,w=0;
  for(let k=0;k<g.n;k++)for(let j=0;j<g.n;j++)for(let i=0;i<g.n;i++){
    const d=g.density[(k*g.n+j)*g.n+i];
    s+=d*((j+.5)/g.n);w+=d;
  }
  return w>0?s/w:0;
};
const fill=(g,fn)=>{
  for(let k=0;k<g.n;k++)for(let j=0;j<g.n;j++)for(let i=0;i<g.n;i++){
    g.density[(k*g.n+j)*g.n+i]=fn((i+.5)/g.n-.5,(j+.5)/g.n-.5,(k+.5)/g.n-.5);
  }
};

test('smoke solver validates configuration and grid bounds',()=>{
  for(const name of ['fe_vol_init','fe_vol_step','fe_vol_source','fe_vol_surface',
    'fe_vol_density_ptr','fe_vol_temperature_ptr','fe_vol_velocity_y_ptr','fe_vol_stats_ptr',
    'fe_vol_surface_indices_ptr','fe_vol_surface_index_count'])
    assert.equal(typeof e[name],'function',`missing ${name}`);
  assert.equal(e.fe_vol_init(4,4,4),-1,'tiny grids are rejected');
  assert.equal(e.fe_vol_init(48,48,48),-1,'grids above the cell cap are rejected');
  assert.equal(e.fe_vol_step(1/60,4,1,.2,.2,20),-1,'step before init is rejected');
  init(16);
  assert.equal(e.fe_vol_grid_size(),16);
  assert.equal(e.fe_vol_source(.5,.5,.5,0,1,1,1),-1,'zero radius is rejected');
  assert.equal(e.fe_vol_source(.5,.5,.5,.2,1,1,1)>0,true);
  assert.equal(e.fe_vol_step(0,4,1,.2,.2,20),-1);
  assert.equal(e.fe_vol_step(1/60,-1,1,.2,.2,20),-1);
  assert.equal(e.fe_vol_step(1/60,4,1,.2,.2,0),-1);
  assert.equal(e.fe_vol_step(1/60,4,1,.2,.2,200),-1);
  assert.equal(e.fe_vol_reset(),0,'reset re-zeroes the configured grid');
});

test('pressure projection removes almost all divergence',()=>{
  const g=init(24);
  for(let n=0;n<3;n++)e.fe_vol_source(.5,.12,.5,.12,8,.4,.6);
  const before=mass(g),y0=comY(g);
  let worst=0;
  for(let f=0;f<60;f++){
    assert.equal(e.fe_vol_step(1/60,4,1,.3,.4,40),0);
    const s=stats();
    assert.ok(Number.isFinite(s[0])&&Number.isFinite(s[1]),'divergence stays finite');
    if(s[0]>worst)worst=s[0];
  }
  const s=stats();
  assert.ok(s[0]>1,'the advected field really is divergent before projection');
  assert.ok(s[1]<s[0]*.25,`projected divergence ${s[1].toFixed(2)} vs ${s[0].toFixed(2)}`);
  assert.ok(worst<2000,'no divergence blow-up across a second of simulation');
  assert.ok(comY(g)>y0+.05,`hot smoke rises (${y0.toFixed(3)} -> ${comY(g).toFixed(3)})`);
  assert.ok(mass(g)>before*.5,'smoke is not annihilated by the projection');
  for(let n=0;n<g.n**3;n++){
    assert.ok(Number.isFinite(g.density[n])&&Number.isFinite(g.temp[n]),'fields stay finite');
  }
});

test('buoyancy is temperature driven and dissipation removes smoke',()=>{
  const a=init(20);
  e.fe_vol_source(.5,.4,.5,.15,0,1,0);
  for(let f=0;f<20;f++)e.fe_vol_step(1/60,4,0,.2,0,20);
  const neutral=comY(a);
  const b=init(20);
  e.fe_vol_source(.5,.4,.5,.15,6,1,0);
  for(let f=0;f<20;f++)e.fe_vol_step(1/60,4,0,.2,0,20);
  assert.ok(comY(b)>neutral+.02,`a hot puff rises while a cold one does not (${neutral.toFixed(3)} vs ${comY(b).toFixed(3)})`);

  const c=init(20);
  e.fe_vol_source(.5,.5,.5,.3,0,1,0);
  const start=mass(c);
  for(let f=0;f<30;f++)e.fe_vol_step(1/60,0,0,3,0,10);
  assert.ok(mass(c)<start*.6,`dissipation removes smoke (${mass(c).toFixed(2)} of ${start.toFixed(2)})`);
});

test('the solver is deterministic for identical inputs',()=>{
  const run=()=>{
    const g=init(20);
    e.fe_vol_source(.5,.3,.5,.2,5,.5,.2);
    for(let f=0;f<20;f++)e.fe_vol_step(1/60,3,1,.2,.2,25);
    return Float32Array.from(g.density);
  };
  const a=run(),b=run();
  assert.equal(a.length,b.length);
  let diff=0;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])diff++;
  assert.equal(diff,0,'bit-identical fields for identical seeds and times');
  assert.ok(a.some(v=>v>1e-3),'the run actually produced smoke');
});

test('surface nets produce a closed manifold with outward normals',()=>{
  init(28);
  const g={n:28,density:f32(e.fe_vol_density_ptr(),28**3)};
  const R=.32;
  fill(g,(x,y,z)=>R-Math.hypot(x,y,z));
  const verts=e.fe_vol_surface(0,1e6);
  assert.ok(verts>0,`isosurface extracted (${verts} verts)`);
  const idxCount=e.fe_vol_surface_index_count();
  assert.equal(idxCount%3,0);
  const pos=f32(e.fe_vol_surface_positions_ptr(),verts*3);
  const nrm=f32(e.fe_vol_surface_normals_ptr(),verts*3);
  const idx=new Uint32Array(e.memory.buffer,e.fe_vol_surface_indices_ptr(),idxCount);

  let radial=0;
  for(let v=0;v<verts;v++){
    const x=pos[v*3]-.5,y=pos[v*3+1]-.5,z=pos[v*3+2]-.5,r=Math.hypot(x,y,z);
    assert.ok(Math.abs(r-R)<2/28,`vertex radius ${r.toFixed(3)} near ${R}`);
    assert.ok(Math.abs(Math.hypot(nrm[v*3],nrm[v*3+1],nrm[v*3+2])-1)<1e-3,'normals are unit length');
    if((nrm[v*3]*x+nrm[v*3+1]*y+nrm[v*3+2]*z)/r>0)radial++;
  }
  assert.ok(radial>verts*.95,'normals point outward');

  const edges=new Map();
  const key=(a,b)=>a<b?`${a}_${b}`:`${b}_${a}`;
  for(let t=0;t<idxCount;t+=3){
    const a=idx[t],b=idx[t+1],c=idx[t+2];
    assert.ok(a<verts&&b<verts&&c<verts,'indices stay inside the vertex buffer');
    for(const k of [key(a,b),key(b,c),key(c,a)])edges.set(k,(edges.get(k)||0)+1);
  }
  let bad=0;
  for(const count of edges.values())if(count!==2)bad++;
  assert.equal(bad,0,`every edge is shared by exactly two triangles (${edges.size} edges)`);
});

test('surface extraction rejects empty fields and oversized grids',()=>{
  init(20);
  assert.equal(e.fe_vol_surface(0,1e6),0,'a zero density field has no surface');
  init(40);
  assert.equal(e.fe_vol_surface(0,1e6),-1,'the mesher refuses grids above its cap');
});
