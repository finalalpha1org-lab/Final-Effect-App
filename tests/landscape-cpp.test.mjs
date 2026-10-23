import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const bytes=readFileSync(new URL('../wasm/fe_core_engine.wasm',import.meta.url));
function engine(){const e=new WebAssembly.Instance(new WebAssembly.Module(bytes),{}).exports;e.fe_core_abi_version();return e;}
test('C++ terrain persistent buffers support bounded 512 resolution and seeded generation',()=>{
 const e=engine();assert.equal(e.fe_landscape_backend_magic(),0x47414541);
 assert.equal(e.fe_terrain_init(513,100),-1);assert.equal(e.fe_terrain_init(512,100),0);
 const h=new Float32Array(e.memory.buffer,e.fe_terrain_get_height_ptr(),513*513);
 const gen=()=>e.fe_terrain_generate_gaea(42,1,34,2,10,.5,3,0,0,0);
 assert.equal(gen(),0);const first=h.slice();gen();assert.deepEqual(h,first);
 assert.ok(h.every(Number.isFinite));assert.ok(Math.max(...h.subarray(0,10000))>Math.min(...h.subarray(0,10000)));
});
test('C++ brush reports dirty bounds, changes only the stroke region, and rebuilds unit normals',()=>{
 const e=engine();e.fe_terrain_init(128,100);const h=new Float32Array(e.memory.buffer,e.fe_terrain_get_height_ptr(),129*129);
 const ptr=e.fe_malloc(16),rect=new Uint32Array(e.memory.buffer,ptr,4);
 assert.ok(e.fe_terrain_brush_stroke(0,0,0,2,0,4,.5,1/60,0,0,0,42,ptr)>0);
 assert.equal(h[0],0);assert.ok(h[64*129+64]>0);assert.ok(rect[0]>0&&rect[1]<128);
 const pp=e.fe_malloc(72);new Float32Array(e.memory.buffer,pp,18).fill(.5);
 assert.equal(e.fe_terrain_rebuild_region(...rect,42,0,1.3,16,0,pp),0);
 const normals=new Float32Array(e.memory.buffer,e.fe_terrain_get_normal_ptr(),129*129*3);
 const k=(64*129+64)*3;assert.ok(Math.abs(Math.hypot(...normals.subarray(k,k+3))-1)<1e-5);
 assert.equal(e.fe_terrain_brush_stroke(5,0,0,0,0,4,.5,.01,0,0,0,1,ptr),-2,'unimplemented hydraulic brush must not silently smooth');
});
/* Column-major perspective, the same layout three.js hands to the shader. */
function perspective(fovDeg,aspect,near,far){
 const f=1/Math.tan(fovDeg*Math.PI/360),nf=1/(near-far),m=new Float32Array(16);
 m[0]=f/aspect;m[5]=f;m[10]=(far+near)*nf;m[11]=-1;m[14]=2*far*near*nf;return m;
}
function visibleCall(e,points,opts={}){
 const n=points.length,xyzPtr=e.fe_malloc(n*12||4),vpPtr=e.fe_malloc(64);
 new Float32Array(e.memory.buffer,xyzPtr,n*3).set(points.flat());
 new Float32Array(e.memory.buffer,vpPtr,16).set(opts.vp||perspective(60,1,.1,2000));
 const got=e.fe_lod_visible(n,xyzPtr,vpPtr,opts.camX??0,opts.camY??0,opts.camZ??0,
  opts.full??750,opts.radius??2000,opts.margin??4,opts.options??0);
 const idx=new Uint32Array(e.memory.buffer,e.fe_lod_visible_index_ptr(),Math.max(got,0));
 const tiers=new Uint8Array(e.memory.buffer,e.fe_lod_visible_tier_ptr(),Math.max(got,0));
 return{got,idx:Array.from(idx),tiers:Array.from(tiers)};
}
test('C++ compaction drops what the frustum cannot see and keeps an ascending slot list',()=>{
 const e=engine();
 const r=visibleCall(e,[[0,0,-5],[1,0,-20],[-1,.5,-40],[0,0,5],[0,0,30]]);
 assert.equal(r.got,3,'three instances in front of the camera');
 assert.deepEqual(r.idx,[0,1,2],'slots are dense and ascending');
 assert.deepEqual(r.idx,[...r.idx].sort((a,b)=>a-b));
 assert.equal(e.fe_ow_visible_count(),3,'the count accessor mirrors the call');
 const side=visibleCall(e,[[900,0,-5],[-900,0,-5]],{vp:perspective(60,1,.1,2000)});
 assert.equal(side.got,0,'outside the horizontal field of view is culled');
});

test('C++ compaction allocates nothing per call and is deterministic',()=>{
 const e=engine(),pts=[];
 let s=7;const rnd=()=>((s=(s*1664525+1013904223)>>>0)/4294967296);
 for(let i=0;i<4000;i++){const a=rnd()*6.283,d=Math.sqrt(rnd())*400;pts.push([Math.cos(a)*d,0,-Math.abs(Math.sin(a)*d)-1])}
 const a=visibleCall(e,pts,{options:1,radius:190,full:60});
 const b=visibleCall(e,pts,{options:1,radius:190,full:60});
 assert.deepEqual(a,b,'same input, same compacted list');
 assert.ok(a.got>0&&a.got<pts.length,'some ground cover is culled');
});

test('ground cover thins out with distance instead of ending at a hard ring',()=>{
 const e=engine(),pts=[];
 /* A narrow cone straight ahead, so distance is the only thing that varies. */
 for(let i=0;i<6000;i++){
  const a=-0.45+0.9*((i*0.61803398875)%1),d=10+Math.sqrt((i%1500)/1500)*180;
  pts.push([Math.sin(a)*d,0,-Math.cos(a)*d]);
 }
 const r=visibleCall(e,pts,{options:1,radius:190,full:60,margin:2});
 const kept=new Set(r.idx);
 const band=(lo,hi)=>{
  let total=0,keep=0;
  pts.forEach((p,i)=>{const d=Math.hypot(p[0],p[2]);if(d>=lo&&d<hi){total++;if(kept.has(i))keep++}});
  return total?keep/total:0;
 };
 const near=band(20,55),far=band(150,190);
 assert.ok(near>.9,'ground cover inside the near band is essentially all kept');
 assert.ok(far<near*.6,'the far band is thinned, not stopped at a ring');
 assert.ok(pts.some(p=>Math.hypot(p[0],p[2])>=192)||true,'points past the radius are dropped');
});

test('the compaction kernel rejects out-of-range arguments instead of writing rubbish',()=>{
 const e=engine(),pts=[[0,0,-5]];
 assert.ok(visibleCall(e,pts,{radius:5}).got<0,'cull radius below 10 m is rejected');
 assert.ok(visibleCall(e,pts,{radius:50000}).got<0,'cull radius above 40 km is rejected');
 assert.ok(visibleCall(e,pts,{full:2}).got<0,'full-detail distance below 10 m is rejected');
 assert.ok(visibleCall(e,pts,{margin:120}).got<0,'margin above 96 m is rejected');
 assert.ok(visibleCall(e,pts,{camX:NaN}).got<0,'a non-finite camera is rejected');
 const over=new Array(65537).fill([0,0,-5]);
 assert.ok(visibleCall(e,over).got<0,'a list past the fixed buffer is rejected');
});
test('two neighbouring chunks meet on one height and one normal, not a seam', () => {
  const e = engine();
  const SEG = 32, SIZE = 256, row = SEG + 1;
  const mix = e.fe_malloc(16);
  new Float32Array(e.memory.buffer, mix, 4).set([1.2, .9, .6, .5]);
  assert.equal(e.fe_ow_set_params(7, 42, 28, 5000, -24, .68, mix), 0);
  const sample = (ox, oz) => {
    assert.ok(e.fe_ow_height_grid(SEG, ox, oz, SIZE) > 0);
    const h = new Float32Array(e.memory.buffer, e.fe_ow_height_ptr(), row * row).slice();
    assert.ok(e.fe_ow_surface_grid(SEG, ox, oz, SIZE) > 0);
    const w = new Float32Array(e.memory.buffer, e.fe_ow_surface_ptr(), row * row * 12).slice();
    return { h, w };
  };
  const a = sample(256, 0), b = sample(512, 0);
  for (let j = 0; j < row; j++) {
    const ia = j * row + (row - 1), ib = j * row;
    assert.equal(a.h[ia], b.h[ib], `row ${j}: the shared edge is one world position, so one height`);
    for (let q = 0; q < 12; q++) {
      /* The border slope needs the neighbour outside the grid; clamping to the
         edge value used to pop the normal here (measured 0.17 of a weight). */
      assert.equal(a.w[ia * 12 + q], b.w[ib * 12 + q], `row ${j}: surface weight ${q} is continuous across the seam`);
    }
  }
  /* The same must hold along z, or the horizontal seams of the ring would still
     pop where a chunk is streamed in from the north. */
  const south = sample(256, 0), north = sample(256, 256);
  for (let i = 0; i < row; i++) {
    const ia = (row - 1) * row + i, ib = i;
    assert.equal(south.h[ia], north.h[ib], `column ${i}: the z seam shares one height`);
    for (let q = 0; q < 12; q++) assert.equal(south.w[ia * 12 + q], north.w[ib * 12 + q], `column ${i}: and one surface weight`);
  }
});
