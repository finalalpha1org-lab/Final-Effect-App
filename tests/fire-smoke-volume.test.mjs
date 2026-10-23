import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

/* End-to-end glue test for the voxel fire/smoke path: the real shipped
   simulationCore.js is loaded in a VM with a minimal THREE stub, and the real
   fe_core_engine.wasm drives the grid. No GPU is involved - the raymarch
   material is checked structurally, the field/atlas plumbing numerically. */
class Vec3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}normalize(){const l=Math.hypot(this.x,this.y,this.z)||1;this.x/=l;this.y/=l;this.z/=l;return this;}}
class Vec2{constructor(x=0,y=0){this.x=x;this.y=y;}}
class Obj{
  constructor(){this.parent=null;this.children=[];}
  add(o){this.children.push(o);o.parent=this;}
  remove(o){const i=this.children.indexOf(o);if(i>=0)this.children.splice(i,1);o.parent=null;}
  traverse(fn){fn(this);for(const c of this.children)c.traverse?c.traverse(fn):fn(c);}
}
class Mesh extends Obj{
  constructor(geometry,material){super();this.geometry=geometry;this.material=material;this.position=new Vec3();this.frustumCulled=true;this.renderOrder=0;}
}
const THREE={
  Vector3:Vec3,Vector2:Vec2,Color:class{constructor(c){this.c=c;}},Object3D:Obj,Mesh,
  BoxGeometry:class{constructor(w,h,d){this.params=[w,h,d];}dispose(){}},
  DataTexture:class{constructor(data,w,h,fmt){this.image={data};this.width=w;this.height=h;this.needsUpdate=false;}dispose(){this.disposed=true;}},
  ShaderMaterial:class{constructor(o){Object.assign(this,o);}dispose(){}},
  Matrix4:class{makeScale(){return this;}},
  LinearFilter:1,ClampToEdgeWrapping:2,RGBAFormat:3,NormalBlending:4,BackSide:5,
  AdditiveBlending:6,DynamicDrawUsage:7,DoubleSide:8
};

function boot(cppExports,device={}){
  const scene=new Obj();
  const sandbox={console,performance,THREE,setTimeout,clearTimeout,requestAnimationFrame:()=>0,
    Uint8Array,Float32Array,Uint32Array,Uint8ClampedArray,ArrayBuffer,DataView,Map,Set,Promise,Math,Number,String,Array,Object,JSON,Error,RegExp,parseInt,parseFloat,isNaN,isFinite};
  sandbox.window=sandbox;sandbox.self=sandbox;sandbox.globalThis=sandbox;
  sandbox.document={addEventListener(){},getElementById(){return null;},createElement(){return {getContext(){return {};},style:{}};}};
  sandbox.navigator={hardwareConcurrency:device.cores??8};
  if(device.coarse)sandbox.matchMedia=()=>({matches:true});
  sandbox.FE={engines:{core:{sc:scene}},toast(){}};
  const atlasCtx={};vm.createContext(atlasCtx);vm.runInContext(readFileSync('volume-atlas.js','utf8'),atlasCtx);
  sandbox.FEVolumeAtlas=atlasCtx.FEVolumeAtlas;
  if(cppExports)sandbox.FECppEngine={ready:true,exports:cppExports};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('simulationCore.js','utf8'),sandbox);
  return {engine:sandbox.SimEngine,scene,sandbox};
}
const wasm=readFileSync('wasm/fe_core_engine.wasm');
const {instance:{exports:cpp}}=await WebAssembly.instantiate(wasm,{});
const params={Resolution:80,'Heat Emission':1.2,'Smoke Density':1,'Dissipation Rate':0.15,Buoyancy:0.8,'Vorticity Confinement':0.12,'Time Scale':1,Fuel:1};
const record=()=>({bounds:[0,0,0,2,3,2],domainType:'Fire + Smoke',role:'Domain',params,status:'running'});

test('a fire/smoke domain becomes a voxel volume backed by the C++ solver',()=>{
  const {engine,scene}=boot(cpp);
  const rec=record();
  assert.equal(engine.createVolumeSimulation(null,params,rec),true,'the volume path must accept the domain');
  assert.equal(rec.kind,'volume');
  assert.equal(rec.volume.grid,28,'a desktop tier maps Resolution 80 to 28³');
  const tilesX=Math.ceil(Math.sqrt(rec.volume.grid));
  assert.equal(rec.volume.texture.width,rec.volume.grid*tilesX,'the atlas tiles every slice');
  assert.equal(rec.volume.data.length,rec.volume.texture.width*rec.volume.texture.height*4);
  assert.equal(rec.visual.name,'Smoke & Fire Volume');
  assert.equal(rec.visual.material.transparent,true);
  assert.equal(rec.visual.material.depthWrite,false);
  assert.equal(scene.children.length,1,'the volume mesh is added to the core scene');
  assert.equal(cpp.fe_vol_init(24,24,24),0,'the C++ grid is live at the same size');
  const gl=rec.visual.material;
  assert.ok(gl.fragmentShader.includes('uAtlas')&&gl.fragmentShader.includes('atlasUv'),'the shader samples the slice atlas');
  assert.ok(gl.fragmentShader.includes('cameraPosition')&&gl.fragmentShader.includes('uBoxMin'),'the shader ray-marches the world box');
  assert.ok(gl.fragmentShader.includes('uFireGain')&&gl.fragmentShader.includes('uSmokeGain'));
  assert.equal(gl.uniforms.uTiles.value.x*gl.uniforms.uTiles.value.y>=rec.volume.grid,true,'every slice has a tile');
  assert.ok(gl.fragmentShader.includes('blackbody'),'fire uses a Planckian ramp');
  assert.ok(gl.fragmentShader.includes('Catmull-Rom'),'slice sampling is cubic, not linear');
  assert.ok(gl.fragmentShader.includes('densityAt(uvw + uSunDir'),'the shader marches toward the sun for self-shadowing');
  assert.ok(gl.uniforms.uSunDir.value.y>0,'the light direction points up');
});

test('stepping the volume runs the solver and refreshes the texture from the real fields',()=>{
  const {engine}=boot(cpp);
  const rec=record();
  assert.equal(engine.createVolumeSimulation(null,params,rec),true);
  rec.volume.texture.needsUpdate=false;
  engine.stepVolumeSimulation(rec,0.2);
  assert.equal(rec.volume.texture.needsUpdate,true,'the GPU texture is marked dirty');
  const grid=rec.volume.grid,cells=grid**3;
  const density=new Float32Array(cpp.memory.buffer,cpp.fe_vol_density_ptr(),cells);
  const temperature=new Float32Array(cpp.memory.buffer,cpp.fe_vol_temperature_ptr(),cells);
  let maxDensity=0,maxTemp=0,hotIdx=0;
  for(let i=0;i<cells;i++){
    if(density[i]>maxDensity){maxDensity=density[i];hotIdx=i;}
    if(temperature[i]>maxTemp)maxTemp=temperature[i];
  }
  assert.ok(maxDensity>0,'density reached the grid');
  assert.ok(maxTemp>0,'temperature reached the grid');
  /* The atlas is the byte view of the same grid, tile by tile. */
  const g=grid;
  const tilesX=Math.ceil(Math.sqrt(g));
  const width=rec.volume.texture.width;
  const x=hotIdx%g,y=Math.floor(hotIdx/g)%g,z=Math.floor(hotIdx/(g*g));
  const texel=(((Math.floor(z/tilesX)*g+y)*width)+((z%tilesX)*g+x))*4;
  assert.equal(rec.volume.data[texel],Math.round(Math.min(1,density[hotIdx]/0.8)*255),'density byte matches the field');
  assert.equal(rec.volume.data[texel+1],Math.round(Math.min(1,temperature[hotIdx]/2.2)*255),'temperature byte matches the field');
  assert.equal(rec.volume.data[texel+3],255);
});

test('only one volume domain runs at a time and removal frees the solver',()=>{
  const {engine}=boot(cpp);
  const first=record();
  assert.equal(engine.createVolumeSimulation(null,params,first),true);
  assert.equal(engine.createVolumeSimulation(null,params,record()),false,'a second volume domain falls back');
  const mesh={userData:{fluidSim:first}};
  engine.simMeshes.set(mesh.uuid||'m1',first);
  engine.removeSimulation('Fluid',mesh);
  assert.equal(first.volumeTexture,null,'the volume texture is released');
  assert.equal(engine.createVolumeSimulation(null,params,record()),true,'the solver is free again');
});

test('without the C++ volume kernel the modifier keeps the particle path',()=>{
  const {engine}=boot(null);
  const rec=record();
  assert.equal(engine.createVolumeSimulation(null,params,rec),false,'no engine means no volume');
  assert.equal(rec.kind,undefined,'the record is left untouched for the caller fallback');
  const missing={ready:true,exports:{}};
  const second=boot(missing);
  assert.equal(second.engine.createVolumeSimulation(null,params,record()),false,'missing exports fall back');
  const source=readFileSync('simulationCore.js','utf8');
  assert.ok(source.includes("const volume = params['Volume Solver'] !== false && this.createVolumeSimulation(mesh, params, record);"));
  assert.ok(source.includes('if (!volume) this.createBuoyantParticles(mesh, params, record);'),'particles stay the fallback');
  assert.ok(source.includes("} else if (record.kind === 'volume') {")&&source.includes('this.stepVolumeSimulation(record, dt);'),'the fixed-step loop drives the volume');
  assert.ok(source.includes("if (record.kind === 'volume') return;"),'volumes do not run the particle instance updater');
});

test('the Fluid modifier exposes the volume solver for fire and smoke domains',()=>{
  const html=readFileSync('index.html','utf8');
  assert.ok(html.includes('["Volume Solver","check",true]'),'the modifier gets a live toggle');
  assert.ok(html.includes('<script src="volume-atlas.js"></script>'));
  for(const list of ['fireOnly','smokeOnly','fireSmokeOnly']){
    const start=html.indexOf(`const ${list} = [`);
    assert.ok(start>0,`${list} exists`);
    const end=html.indexOf('];',start);
    assert.ok(html.slice(start,end).includes('"Volume Solver"'),`${list} shows the toggle`);
  }
  const liquidStart=html.indexOf('const liquidOnly = [');
  assert.ok(!html.slice(liquidStart,html.indexOf('];',liquidStart)).includes('"Volume Solver"'),'liquid domains do not show it');
  assert.ok(readFileSync('sw.js','utf8').includes("'./volume-atlas.js'"),'the atlas ships in the offline cache');
});

test('coarse-pointer devices keep the smaller volume grid',()=>{
  const {engine}=boot(cpp,{coarse:true,cores:8});
  const rec=record();
  assert.equal(engine.createVolumeSimulation(null,params,rec),true);
  assert.equal(rec.volume.grid,24,'phones stay on the 24³ budget');
  const low=boot(cpp,{cores:2});
  const lowRec=record();
  assert.equal(low.engine.createVolumeSimulation(null,params,lowRec),true);
  assert.equal(lowRec.volume.grid,24,'four-core machines stay on the smaller grid too');
});
