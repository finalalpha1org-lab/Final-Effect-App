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
