import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const wasm=readFileSync('wasm/fe_core_engine.wasm');
const {instance:{exports:e}}=await WebAssembly.instantiate(wasm,{});
e.__wasm_call_ctors?.();
const f32=(ptr,n)=>new Float32Array(e.memory.buffer,ptr,n);
function params(seed=1234,mountain=42,water=28,half=4096,sea=-24,blend=.6,mix=[1,1,1,1]){
 const ptr=e.fe_malloc(16);f32(ptr,4).set(mix);
 return e.fe_ow_set_params(seed,mountain,water,half,sea,blend,ptr);
}

test('Open World kernels are exported and validate their inputs',()=>{
 for(const name of ['fe_ow_set_params','fe_ow_height_at','fe_ow_biome_weights_at','fe_ow_height_grid','fe_ow_surface_grid','fe_ow_plan_chunks','fe_ow_hydro_set_grid','fe_ow_hydro_trace','fe_lod_classify'])assert.equal(typeof e[name],'function',`missing ${name}`);
 assert.equal(params(),0);
 assert.equal(params(1234,150,28),-1,'mountain height is capped at 100');
 assert.equal(params(1234,42,28,0),-1,'a zero world half is rejected');
 assert.equal(e.fe_ow_height_grid(4,0,0,256),-1,'segments below 8 are rejected');
 assert.equal(e.fe_ow_height_grid(64,0,0,0),-1);
 assert.equal(e.fe_ow_plan_chunks(0,0,99,256,4096),-1,'an oversized radius is rejected');
 assert.equal(e.fe_ow_hydro_set_grid(8,4096,0),-1,'hydro grids below 16 are rejected');
});

test('Open World chunk height and surface grids are deterministic and normalised',()=>{
 params();assert.equal(e.fe_ow_height_grid(64,512,-256,256),4225);
 const h=f32(e.fe_ow_height_ptr(),4225),copy=Float32Array.from(h);
 assert.ok(h.every(Number.isFinite),'chunk heights must be finite');
 assert.ok(Math.min(...h)>-400&&Math.max(...h)<800,'chunk heights stay in a plausible world range');
 assert.ok(Math.abs(h[0]-e.fe_ow_height_at(512-128,-256-128))<1e-3,'grid vertex 0 must equal the point sampler');
 assert.ok(Math.abs(h[64]-e.fe_ow_height_at(512-128+64*4,-256-128))<1e-3,'row stride follows chunk_size/segments');
 assert.equal(e.fe_ow_height_grid(64,512,-256,256),4225);
 assert.deepEqual(h,copy,'the same chunk must regenerate identically');
 assert.equal(e.fe_ow_surface_grid(64,512,-256,256),50700);
 const w=f32(e.fe_ow_surface_ptr(),4225*12);
 for(let k=0;k<60;k++){let total=0;for(let q=0;q<12;q++){const v=w[k*12+q];assert.ok(v>=0&&v<=1,'surface weights stay in 0..1');total+=v}assert.ok(Math.abs(total-1)<1e-3,'surface weights are normalised')}
 const bioPtr=e.fe_malloc(16);
 assert.equal(e.fe_ow_biome_weights_at(120,-40,60,bioPtr),0);
 const bio=f32(bioPtr,4);
 assert.ok(Math.abs(bio.reduce((a,b)=>a+b,0)-1)<1e-3,'biome weights are normalised');
});

test('chunk planning returns a nearest-first ring inside the world bounds',()=>{
 assert.equal(e.fe_ow_plan_chunks(0,0,4,256,4096),81);
 const cells=new Int32Array(e.memory.buffer,e.fe_ow_plan_cells_ptr(),81*3);
 const dist=f32(e.fe_ow_plan_distance_ptr(),81);
 assert.equal(cells[0],0);assert.equal(cells[1],0);assert.equal(dist[0],0,'the centre chunk sorts first');
 for(let i=1;i<81;i++)assert.ok(dist[i]>=dist[i-1],'planning order is nearest first');
 for(let i=0;i<81;i++)assert.ok(Math.abs(cells[i*3])*256-128<=4096&&Math.abs(cells[i*3+1])*256-128<=4096,'every planned chunk intersects the world');
 assert.equal(e.fe_ow_plan_chunks(1000,1000,2,256,4096),0,'plans outside the world stay empty');
});

test('foliage terrain LOD classification culls far instances and keeps near ones detailed',()=>{
 const pts=new Float32Array([0,0,0, 0,0,300, 0,0,2000, 0,0,9000]);
 const ptr=e.fe_malloc(pts.length*4);f32(ptr,pts.length).set(pts);
 assert.equal(e.fe_lod_classify(4,ptr,0,0,0,750,1),4);
 const tiers=new Int8Array(e.memory.buffer,e.fe_lod_out_ptr(),4);
 assert.equal(tiers[0],0,'the instance under the camera is full detail');
 assert.equal(tiers[1],0,'300 m stays inside the full-detail radius');
 assert.equal(tiers[2],1,'2 km drops to the low tier');
 assert.equal(tiers[3],-1,'9 km is culled for ground cover');
 assert.equal(e.fe_lod_classify(4,ptr,0,0,0,750,0),4);
 assert.equal(new Int8Array(e.memory.buffer,e.fe_lod_out_ptr(),4)[3],1,'trees survive to 14 km');
 assert.equal(e.fe_lod_classify(4,ptr,0,0,0,20,1),-1,'invalid full distance is rejected');
});

test('hydrology traces downhill rivers and rejects bad grids',()=>{
 const n=64,span=4096;
 const inp=f32(e.fe_ow_hydro_input_ptr(),n*n);
 for(let j=0;j<n;j++)for(let i=0;i<n;i++){const dx=(i-n/2)/n,dz=(j-n/2)/n;inp[j*n+i]=600*Math.exp(-(dx*dx+dz*dz)*12)+20}
 assert.equal(e.fe_ow_hydro_set_grid(n,span,0),n*n);
 assert.equal(e.fe_ow_hydro_trace(7,520,600,12345),7);
 const meta=new Int32Array(e.memory.buffer,e.fe_ow_river_meta_ptr(),7*6);
 let total=0;
 for(let i=0;i<7;i++){
  const first=meta[i*6+2],len=meta[i*6+3];
  assert.ok(len>=6,'every accepted river keeps enough samples');
  assert.ok(Math.abs(meta[i*6]/100)<=span/2&&Math.abs(meta[i*6+1]/100)<=span/2,'river sources stay inside the map');
  total=Math.max(total,first+len);
 }
 const pts=f32(e.fe_ow_river_points_ptr(),total*2);
 for(let i=0;i<total;i++)assert.ok(Math.abs(pts[i*2])<=span/2&&Math.abs(pts[i*2+1])<=span/2,'river points stay inside the map');
 const copy=Float32Array.from(pts);
 assert.equal(e.fe_ow_hydro_set_grid(n,span,0),n*n);
 assert.equal(e.fe_ow_hydro_trace(7,520,600,12345),7);
 assert.deepEqual(f32(e.fe_ow_river_points_ptr(),total*2),copy,'the same seed reproduces the same rivers');
 assert.equal(e.fe_ow_hydro_trace(0,520,600,1),-1,'a zero river budget is rejected');
 assert.equal(e.fe_ow_hydro_set_grid(400,4096,0),-1,'grids above the 320-cell budget are rejected');
});

test('Open World generation, scheduling and hydrology route through the C++ bridge with JS fallbacks',async()=>{
 const {readFileSync:read}=await import('node:fs');
 const bridge=read('terrain-main-01.js','utf8'),gen=read('open-world-generator.js','utf8'),ow=read('open-world.js','utf8'),studio=read('terrain-main-03.js','utf8');
 assert.ok(bridge.includes('core.owHeightGrid=function(state)')&&bridge.includes('core.owSurfaceGrid=function(state)'));
 assert.ok(bridge.includes('core.owPlan=function(state)')&&bridge.includes('core.owHydroTrace=function(state)'));
 assert.ok(bridge.includes('core.lodClassify=function(state)'));
 assert.ok(gen.includes('const c=cppCore();if(c){const v=c.owHeightAt(cfg,x,z);if(v!==null)return v}'),'height sampling prefers C++ and keeps the JS fallback');
 assert.ok(gen.includes('heights.set(g);nativeGrid=true'),'chunk heights come from the C++ grid');
 assert.ok(gen.includes('surfaceWeights.set(w);nativeSurfaces=true'),'surface weights come from the C++ grid');
 assert.ok(ow.includes('hydroCpp.owHydroTrace(')&&ow.includes('if(!traces)'),'hydrology prefers C++ and keeps the JS solver');
 assert.ok(studio.includes('owPlan({cx,cz,radius:OW.radius'),'chunk scheduling uses the C++ planner');
 assert.ok(studio.includes('lodClassify({count:n,xyz'),'foliage LOD classification uses the C++ kernel');
});
