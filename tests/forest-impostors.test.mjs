import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
const source=readFileSync('open-world.js','utf8');
const bridge=source.split('/* END FOREST IMPOSTOR BRIDGE */')[0];
function factory(){const ctx={console};vm.runInNewContext(bridge,ctx);return ctx.FEForestImpostors(THREE)}
function renderer(){let target=null,viewport=new THREE.Vector4(2,3,900,600),scissor=viewport.clone(),test=false,color=new THREE.Color('red'),alpha=.7;return{
 xr:{enabled:false},autoClear:true,toneMapping:THREE.ACESFilmicToneMapping,outputEncoding:THREE.sRGBEncoding,renders:[],
 getRenderTarget:()=>target,setRenderTarget:v=>target=v,getViewport:v=>v.copy(viewport),setViewport:(...v)=>viewport=v[0]?.isVector4?v[0].clone():new THREE.Vector4(...v),getScissor:v=>v.copy(scissor),setScissor:(...v)=>scissor=v[0]?.isVector4?v[0].clone():new THREE.Vector4(...v),getScissorTest:()=>test,setScissorTest:v=>test=v,getClearColor:v=>v.copy(color),getClearAlpha:()=>alpha,setClearColor:(c,a)=>{color=new THREE.Color(c);alpha=a},clear(){},render(s,c){this.renders.push({s,c:c.clone()})}
}}
const species=()=>({meshes:[{geometry:new THREE.ConeGeometry(2,10,12).translate(0,5,0),material:new THREE.MeshStandardMaterial({color:'green'}),userData:{}}]});
test('atlas bakes four angles, uses two-triangle cards and restores renderer state',()=>{
 const api=factory(),K=species(),r=renderer();assert.equal(api.request('pine',K),null);assert.equal(api.stats.pending,1);
 assert.equal(api.bake(r),true);const atlas=api.request('pine',K);
 assert.equal(r.renders.length,4);assert.equal(atlas.geometries.length,4);
 for(const [view,g]of atlas.geometries.entries()){assert.equal(g.index.count,6);assert.equal(g.attributes.position.count,4);for(let i=0;i<4;i++){const u=g.attributes.uv.getX(i);assert.ok(u>view/4&&u<(view+1)/4)}}
 assert.equal(atlas.target.width,1024);assert.equal(atlas.target.height,256);
 assert.equal(r.getRenderTarget(),null);assert.equal(r.autoClear,true);assert.equal(r.toneMapping,THREE.ACESFilmicToneMapping);assert.equal(r.getClearAlpha(),.7);assert.deepEqual(r.getViewport(new THREE.Vector4()).toArray(),[2,3,900,600]);
 assert.equal(api.bake(r),false);api.clear();assert.equal(api.stats.atlases,0);
});
test('atlas residency and bake work are bounded; source geometry is never disposed',()=>{
 const api=factory(),K=species(),r=renderer();let disposed=0;K.meshes[0].geometry.addEventListener('dispose',()=>disposed++);
 for(let i=0;i<40;i++)api.request('tree'+i,K);assert.equal(api.stats.pending,24);api.bake(r);assert.equal(r.renders.length,4);assert.equal(api.stats.pending,23);api.clear();assert.equal(disposed,0);
});
test('bake failure restores renderer and retains original mesh fallback',()=>{
 const api=factory(),K=species(),r=renderer();api.request('bad',K);r.render=()=>{throw Error('device allocation failure')};
 assert.equal(api.bake(r),false);assert.equal(api.request('bad',K),null);assert.equal(api.stats.pending,0);assert.equal(r.getRenderTarget(),null);assert.equal(r.autoClear,true);assert.equal(r.getScissorTest(),false);
});
test('forest uses chunk-local impostors only beyond mesh zone and keeps mesh fallback',()=>{
 assert.ok(source.includes("if(cat==='t'&&dItem>lodDistance-220)"));
 assert.ok(source.includes("key='impostor:'+item.k+':'+view+':'+c.fx+','+c.fz"));
 assert.ok(source.includes('if(atlas){'));assert.ok(source.includes('workerCode.toString()'));new vm.Script(source);
});
test('C++ bulk forest classifications validate bounds and match mesh/range/azimuth decisions',async()=>{
 const {instance:{exports:e}}=await WebAssembly.instantiate(readFileSync('fe_core_engine.wasm'),{});e.__wasm_call_ctors?.();
 assert.equal(e.fe_forest_classify(32769,0,0,10,1000),-1);assert.equal(e.fe_forest_classify(1,NaN,0,10,1000),-1);assert.equal(e.fe_forest_classify(1,0,0,100,10),-1);
 const input=new Float32Array(e.memory.buffer,e.fe_forest_input_ptr(),18);input.set([0,0,0,0,-200,0,-200,0,0,0,200,0,200,0,0,0,-200,Math.PI/2]);
 assert.equal(e.fe_forest_classify(6,0,0,10,1000),6);assert.deepEqual([...new Int32Array(e.memory.buffer,e.fe_forest_output_ptr(),6)],[-2,0,1,2,3,3]);
 input.set([2000,0,0,NaN,0,0]);e.fe_forest_classify(2,0,0,10,1000);assert.deepEqual([...new Int32Array(e.memory.buffer,e.fe_forest_output_ptr(),2)],[-1,-1]);
 // Full worker chunk capacity; no wrapping arena allocation.
 const full=new Float32Array(e.memory.buffer,e.fe_forest_input_ptr(),32768*3);full.fill(0);assert.equal(e.fe_forest_classify(32768,0,0,10,1000),32768);
});
test('background worker executes the real unified WASM classifier and clear invalidates selection',async()=>{
 const wasm=readFileSync('fe_core_engine.wasm');let code;let readyResolve,resultResolve;
 const ready=new Promise(r=>readyResolve=r),result=new Promise(r=>resultResolve=r);
 class BlobMock{constructor(parts){code=parts.join('')}}
 class URLMock extends URL{static createObjectURL(){return 'blob:forest'}static revokeObjectURL(){}}
 class WorkerMock{
  constructor(){const self={postMessage:d=>queueMicrotask(()=>{this.onmessage?.({data:d});if(d.type==='ready')readyResolve();if(d.type==='result')resultResolve()})};this.self=self;
   vm.runInNewContext(code,{self,WebAssembly,Float32Array,Int32Array,Math,Error,fetch:async()=>({ok:true,arrayBuffer:async()=>wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength)})});
  }
  postMessage(data){queueMicrotask(()=>this.self.onmessage({data}))}terminate(){}
 }
 const context={console,Worker:WorkerMock,Blob:BlobMock,URL:URLMock,document:{baseURI:'https://example.test/Terrain_system_.html'}};
 vm.runInNewContext(bridge,context);const api=context.FEForestImpostors(THREE),items=[{x:0,z:-200,r:0},{x:0,z:0,r:0}];
 api.classify(items,{x:0,z:0},10,1000);await ready;
 assert.equal(api.stats.cppWorker,true);api.classify(items,{x:0,z:0},10,1000);await result;
 assert.equal(api.view(items[0]),0);assert.equal(api.view(items[1]),-2);api.clear();assert.equal(api.view(items[0]),undefined);
});
test('complementary dither shaders preserve source hooks and update GPU uniforms without rebuilding',()=>{
 const api=factory(),sourceMat=new THREE.MeshStandardMaterial();let calls=0;sourceMat.onBeforeCompile=()=>calls++;
 const mesh=api.ditherMaterial(sourceMat,false),card=api.ditherMaterial(new THREE.MeshBasicMaterial(),true);
 const shader=()=>({uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader});
 const a=shader(),b=shader();mesh.onBeforeCompile(a,{});card.onBeforeCompile(b,{});
 assert.equal(calls,1);assert.notEqual(mesh,sourceMat);assert.ok(a.fragmentShader.includes('if(forestNoise < forestFade) discard;'));assert.ok(b.fragmentShader.includes('if(forestNoise >= forestFade) discard;'));
 assert.ok(a.vertexShader.includes('instanceMatrix * forestOrigin'));assert.ok(a.vertexShader.includes('forestOrigin.xz-forestCameraXZ'));
 assert.equal(a.uniforms.forestLodStart,b.uniforms.forestLodStart);api.setLodDistance(600,{x:40,z:80});
 assert.equal(a.uniforms.forestLodStart.value,540);assert.equal(b.uniforms.forestLodEnd.value,660);assert.deepEqual(a.uniforms.forestCameraXZ.value.toArray(),[40,80]);
 assert.notEqual(mesh.customProgramCacheKey(),card.customProgramCacheKey());assert.equal(mesh.transparent,false);assert.equal(mesh.depthWrite,true);
 let disposed=0;sourceMat.addEventListener('dispose',()=>disposed++);api.disposeMaterial(mesh);assert.equal(disposed,0);
});
test('LOD residency has hysteresis outside both ends of the visible fade and resets on clear',()=>{
 const api=factory(),o={};const state=d=>({...api.resident(o,d,500)});
 assert.deepEqual(state(300),{card:false,mesh:true});assert.deepEqual(state(405),{card:true,mesh:true});
 assert.equal(state(395).card,true);assert.equal(state(365).card,true);assert.equal(state(355).card,false);
 assert.equal(state(605).mesh,true);assert.equal(state(645).mesh,false);assert.equal(state(610).mesh,false);assert.equal(state(595).mesh,true);
 api.clear();assert.equal(state(395).card,false);
});
