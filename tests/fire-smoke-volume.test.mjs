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
  LinearFilter:1,ClampToEdgeWrapping:2,RGBAFormat:3,NormalBlending:4,BackSide:5,RepeatWrapping:9,
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
  const libCtx={};vm.createContext(libCtx);vm.runInContext(readFileSync('volume-library.js','utf8'),libCtx);
  sandbox.FEVolumeLibrary=libCtx.FEVolumeLibrary;
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

test('the core bakes a seamless, deterministic detail-noise tile',()=>{
  assert.equal(cpp.fe_vol_noise_generate(64,20261023,4),0,'the core accepts a 64² tile');
  const size=cpp.fe_vol_noise_size();
  assert.equal(size,64);
  const tile=new Uint8Array(cpp.memory.buffer,cpp.fe_vol_noise_ptr(),size*size*4).slice();
  assert.equal(tile[3],255,'the tile is fully opaque');
  let min=255,max=0;
  for(let i=0;i<tile.length;i+=4){min=Math.min(min,tile[i]);max=Math.max(max,tile[i]);}
  assert.ok(max-min>60,'the billow channel carries real contrast');
  assert.equal(cpp.fe_vol_noise_generate(64,20261023,4),0);
  const again=new Uint8Array(cpp.memory.buffer,cpp.fe_vol_noise_ptr(),size*size*4).slice();
  assert.ok(tile.every((v,i)=>v===again[i]),'the same seed rebuilds the same tile');
  assert.equal(cpp.fe_vol_noise_generate(8,1,3),-3,'tiles below 16² are rejected');
  /* Seam check: the wrap column must look like any interior column, otherwise
     the scrolled detail would tear. */
  let seam=0,inner=0;
  for(let y=0;y<size;y++){
    seam+=Math.abs(tile[(y*size)*4]-tile[(y*size+size-1)*4]);
    inner+=Math.abs(tile[(y*size+10)*4]-tile[(y*size+11)*4]);
  }
  assert.ok(seam/size < inner/size,'the tile is seamless across the wrap edge');
  assert.equal(cpp.fe_vol_noise_generate(64,77,4),0);
  const other=new Uint8Array(cpp.memory.buffer,cpp.fe_vol_noise_ptr(),size*size*4).slice();
  assert.ok(tile.some((v,i)=>v!==other[i]),'a new seed changes the pattern');
});

test('every volume look control reaches the shader as a live uniform',()=>{
  const {engine}=boot(cpp);
  const look={...params,'Volume Quality':'Cinematic','Volume Steps':40,Detail:1.5,'Detail Scale':4,'Detail Speed':1.2,'Self Shadow':.5,'Scatter Samples':3,Ambient:.3,Extinction:1.6,Emission:2};
  const rec={bounds:[0,0,0,2,3,2],domainType:'Fire + Smoke',role:'Domain',params:look,status:'running'};
  assert.equal(engine.createVolumeSimulation(null,look,rec),true);
  assert.equal(rec.volume.grid,32,'Cinematic lifts the desktop ceiling to 32³');
  const u=rec.visual.material.uniforms;
  assert.equal(u.uSteps.value,40,'the step budget is user controlled');
  assert.equal(u.uDetail.value,1.5);
  assert.equal(u.uDetailScale.value,4);
  assert.equal(u.uDetailSpeed.value,1.2);
  assert.equal(u.uSelfShadow.value,.5);
  assert.equal(u.uScatter.value,3);
  assert.equal(u.uAmbient.value,.3);
  assert.equal(u.uExtinction.value,1.6);
  assert.equal(u.uEmission.value,2);
  assert.equal(u.uNoise.value.width,64,'the baked tile is bound as a 64² texture');
  assert.equal(u.uNoise.value.image.data.length,64*64*4);
  const shader=rec.visual.material.fragmentShader;
  for(const key of ['uNoise','detailField','uDetailScale','uDetailSpeed','uSelfShadow','uScatter','uAmbient','uExtinction','uEmission']){
    assert.ok(shader.includes(key),`the shader consumes ${key}`);
  }
  assert.ok(shader.includes('smoothstep(0.02, 0.28, dens)'),'detail is masked off at the silhouette, so shape is never lost');
  assert.ok(shader.includes('if (s >= uScatter) break;'),'the scatter taps are capped by the setting');
});

test('Volume Quality moves the budget, not the look, and Mobile stays at 20³',()=>{
  const mobile=boot(cpp,{coarse:true});
  const look={...params,'Volume Quality':'Mobile'};
  const rec={bounds:[0,0,0,2,3,2],domainType:'Fire + Smoke',role:'Domain',params:look,status:'running'};
  assert.equal(mobile.engine.createVolumeSimulation(null,look,rec),true);
  assert.equal(rec.volume.grid,20,'Mobile caps the volume grid at 20³');
  assert.equal(rec.volume.detail,1,'the detail amount keeps its own default');
  const balanced=boot(cpp);
  const recBalanced={bounds:[0,0,0,2,3,2],domainType:'Fire + Smoke',role:'Domain',params,status:'running'};
  assert.equal(balanced.engine.createVolumeSimulation(null,params,recBalanced),true);
  assert.equal(recBalanced.volume.grid,28,'Balanced keeps the standard desktop tier');
});

test('stepping advances the animation clock and re-syncs the live knobs',()=>{
  const {engine}=boot(cpp);
  const rec=record();
  assert.equal(engine.createVolumeSimulation(null,params,rec),true);
  const u=rec.visual.material.uniforms;
  assert.equal(u.uTime.value,0);
  engine.stepVolumeSimulation(rec,0.2);
  assert.ok(rec.volume.time>0,'the detail pattern drifts with the simulation clock');
  assert.equal(u.uTime.value,rec.volume.time,'the shader clock follows the solver');
  rec.volume.detail=0.25;
  rec.volume.emission=0.5;
  engine.syncVolumeUniforms(rec);
  assert.equal(u.uDetail.value,0.25,'editing a knob updates the material without a rebuild');
  assert.equal(u.uEmission.value,0.5);
});

test('Baked Library plays the baked frames and leaves the solver alone',()=>{
  const {engine,sandbox}=boot(cpp);
  sandbox.FEVolumeLibraryData=sandbox.FEVolumeLibrary.parse(readFileSync('volume-library.bin'));
  const look={...params,'Volume Source':'Baked Library','Library Variant':'Smoke','Library Motion':1.5};
  const rec={bounds:[0,0,0,2,3,2],domainType:'Fire + Smoke',role:'Domain',params:look,status:'running'};
  assert.equal(engine.createVolumeSimulation(null,look,rec),true);
  assert.ok(rec.volume.library,'the baked variant is resolved');
  assert.equal(rec.volume.library.variant.name,'Smoke');
  const u=rec.visual.material.uniforms;
  assert.equal(u.uLibMix.value,1,'the shader reads the baked field');
  assert.equal(u.uLibGrid.value,20);
  assert.equal(u.uLibAtlas.value.width,320,'the atlas holds 12 frames x 20 slices');
  assert.equal(rec.visual.material.fragmentShader.includes('libField'),true);
  rec.visual.material.uniforms.uLibA.value=-1;
  engine.stepVolumeSimulation(rec,0.1);
  assert.ok(rec.volume.time>0,'the clip clock advances');
  assert.ok(u.uLibA.value>=0,'frame A is driven by the clock');
  assert.ok(u.uLibBlend.value>=0&&u.uLibBlend.value<=1,'the two frames cross-fade');
  assert.equal(u.uTime.value,rec.volume.time);
});

test('a missing library keeps the live solver instead of going black',()=>{
  const {engine}=boot(cpp);
  const look={...params,'Volume Source':'Baked Library'};
  const rec={bounds:[0,0,0,2,3,2],domainType:'Fire + Smoke',role:'Domain',params:look,status:'running'};
  assert.equal(engine.createVolumeSimulation(null,look,rec),true);
  assert.equal(rec.volume.library,null,'no data means no library');
  assert.equal(rec.visual.material.uniforms.uLibMix.value,0);
  assert.equal(rec.kind,'volume','the live volume path still runs');
});

test('Temporal Blend lowers frame-to-frame shimmer in the C++ field',async()=>{
  const measure=async(temporal)=>{
    const {instance:{exports:ex}}=await WebAssembly.instantiate(wasm,{});
    ex.fe_vol_init(20,20,20);
    ex.fe_vol_set_temporal(temporal);
    const cells=20**3;
    let previous=null,total=0,samples=0;
    for(let f=0;f<26;f++){
      ex.fe_vol_source(0.5,0.08,0.5,0.15,7,0.5,0.6);
      ex.fe_vol_step(1/30,1.4,2.4,0.45,1.1,20);
      if(f>8){
        const den=new Float32Array(ex.memory.buffer,ex.fe_vol_density_ptr(),cells).slice();
        if(previous){
          let sum=0;
          for(let i=0;i<cells;i++) sum+=Math.abs(den[i]-previous[i]);
          total+=sum/cells; samples++;
        }
        previous=den;
      }
    }
    return {shimmer:total/samples,field:previous};
  };
  const live=await measure(0);
  const calm=await measure(0.85);
  assert.ok(live.shimmer>0,'the raw field moves every frame');
  assert.ok(calm.shimmer<live.shimmer*0.75,'the temporal filter calms the surface');
  let liveMass=0,calmMass=0;
  for(let i=0;i<live.field.length;i++){liveMass+=live.field[i];calmMass+=calm.field[i];}
  assert.ok(calmMass>liveMass*0.6,'the filter does not eat the plume');
  assert.equal(cpp.fe_vol_set_temporal(-1),0,'negative values clamp instead of throwing');
  assert.equal(cpp.fe_vol_temporal(),0,'the shared instance is back to zero');
});

test('Detail Contrast and Fire Tint are real shader controls',()=>{
  const {engine}=boot(cpp);
  const look={...params,'Detail Contrast':2.2,'Fire Tint':'Blue'};
  const rec={bounds:[0,0,0,2,3,2],domainType:'Fire',role:'Domain',params:look,status:'running'};
  assert.equal(engine.createVolumeSimulation(null,look,rec),true);
  const u=rec.visual.material.uniforms;
  assert.equal(u.uDetailContrast.value,2.2);
  assert.ok(Math.abs(u.uFireTint.value.z-1.3)<1e-6,'Blue pushes the blue channel');
  assert.ok(Math.abs(u.uFireTint.value.x-0.55)<1e-6);
  const shader=rec.visual.material.fragmentShader;
  assert.ok(shader.includes('uDetailContrast'),'contrast pivots the tile around 0.5');
  assert.ok(shader.includes('blackbody(heat) * uFireTint'),'the tint multiplies the Planckian ramp');
});

test('flame colour is the Planckian locus, so temperature decides hue', () => {
  const { sandbox } = boot(null);
  const { blackbodyRGB, planckianXY, fireTemperatureRange } = sandbox.SimulationEngine;

  /* A blackbody near 6500 K is the standard white point: x 0.3127, y 0.3290.
     The analytic colour-matching fit lands within a couple of thousandths. */
  const [wx, wy] = planckianXY(6500);
  assert.ok(Math.abs(wx - 0.3127) < 0.01, `white point x was ${wx}`);
  assert.ok(Math.abs(wy - 0.329) < 0.01, `white point y was ${wy}`);

  /* A 900 K ember is red and has essentially no green or blue in it, while a
     3000 K flame is close to white. The old four-stop ramp could not express
     the difference because it had no temperature in it. */
  const ember = blackbodyRGB(900);
  const wood = blackbodyRGB(1900);
  const hot = blackbodyRGB(3000);
  const blue = blackbodyRGB(10000);
  assert.equal(Math.max(...ember), 1, 'the hottest channel is normalised to 1');
  assert.ok(ember[1] < 0.25 && ember[2] < 0.05, 'an ember is red, not orange');
  assert.ok(wood[1] > ember[1] + 0.2 && wood[1] < 0.7, 'wood fire adds green, not blue');
  assert.ok(wood[2] < 0.05, 'a 1900 K flame has no blue left');
  assert.ok(hot[2] > wood[2] + 0.2 && hot[1] > 0.6, 'a 3000 K flame is warm white');
  assert.ok(blue[2] > 0.9 && blue[0] < 0.9, 'a 10000 K body is bluish white');
  for (const rgb of [ember, wood, hot, blue]) {
    for (const channel of rgb) assert.ok(channel >= 0 && channel <= 1, 'channels stay in range');
  }
  /* Monotonic along the locus: blue only appears once the body is hot. */
  const blues = [900, 1400, 1900, 2400, 3200].map((k) => blackbodyRGB(k)[2]);
  for (let i = 1; i < blues.length; i++) assert.ok(blues[i] >= blues[i - 1], `blue rose at sample ${i}`);
  const reds = [1200, 2000, 3000, 5000, 8000].map((k) => planckianXY(k)[0]);
  for (let i = 1; i < reds.length; i++) assert.ok(reds[i] < reds[i - 1], 'the locus marches away from red as it heats');

  /* Presets carry real Kelvin ranges, and every one sits inside the LUT. */
  const torch = fireTemperatureRange('Torch');
  const campfire = fireTemperatureRange('Campfire');
  assert.ok(torch[0] < torch[1] && torch[1] > campfire[1], 'a torch burns hotter than a campfire');
  assert.deepEqual(fireTemperatureRange('No Such Fire'), campfire, 'an unknown preset falls back to a campfire');
  for (const name of ['Campfire', 'Wildfire', 'Torch', 'Gas Flame', 'Candle']) {
    const [low, high] = fireTemperatureRange(name);
    assert.ok(low >= 700 && high <= 3000, `${name} stays inside the blackbody LUT`);
  }
});

test('the volume shader reads flame colour from the blackbody LUT at the preset temperature', () => {
  const { engine } = boot(cpp);
  const rec = record();
  assert.equal(engine.createVolumeSimulation(null, params, rec), true);
  const gl = rec.visual.material;
  assert.ok(gl.fragmentShader.includes('uniform sampler2D uBlackbody'), 'the shader owns a blackbody LUT');
  assert.ok(gl.fragmentShader.includes('texture2D(uBlackbody, vec2(t, 0.5))'), 'flame colour is a LUT fetch, not a ramp');
  assert.ok(gl.fragmentShader.includes('uHeatK0 + (uHeatK1 - uHeatK0) * clamp(heat'), 'heat is remapped to real Kelvin');
  const lut = gl.uniforms.uBlackbody.value;
  assert.equal(lut.width, 128, 'the LUT is one row of 128 temperatures');
  assert.equal(lut.image.data.length, 128 * 4);
  assert.equal(gl.uniforms.uHeatK0.value, 900, 'a campfire starts at 900 K');
  assert.equal(gl.uniforms.uHeatK1.value, 1900, 'and peaks at 1900 K');
  /* The first texel is the coldest, the last the hottest, and blue must rise
     along the row or the LUT was built upside down. */
  const data = lut.image.data;
  assert.ok(data[1] < data[(127 * 4) + 1], 'green rises with temperature');
  assert.equal(data[3], 255, 'the LUT is opaque');
});
