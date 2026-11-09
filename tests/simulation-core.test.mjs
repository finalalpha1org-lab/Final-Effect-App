import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const source=readFileSync(appPath('simulationCore.js'),'utf8');
const appHtml=readFileSync(appPath('index.html'),'utf8');
function makeEngine(){
  const document={baseURI:'https://sim.test/',addEventListener(){},getElementById(){return null}};
  const window={document,FE:{}};
  const context={window,document,THREE,WebAssembly,URL,fetch:async()=>{throw new Error('test: no WASM fetch')},console:{error(){},warn(){},log(){}}};
  vm.runInNewContext(source,context,{filename:'simulationCore.js'});
  const engine=Object.create(window.SimulationEngine.prototype);
  engine.arena={f32:(array)=>array,u8:(array)=>array};
  return engine;
}

test('WASM loader supports both the deployed root asset and the repository wasm/ path',()=>{
  assert.match(source,/const urls = \['\.\/simulation_solver\.wasm', '\.\/wasm\/simulation_solver\.wasm'\]/);
  assert.match(source,/WASM request failed at the app root and \.\/wasm\/ fallback paths/);
});

test('cloth auto-pinning does not freeze a horizontal sheet and pins a vertical top edge',()=>{
  const engine=makeEngine(),flat=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());flat.updateMatrixWorld(true);
  const horizontal=new Float32Array([-1,0,-1,1,0,-1,1,0,1,-1,0,1]),flatPins=new Uint8Array(4);
  engine.selectClothPins(flat,{rest:horizontal},flatPins,{});
  assert.equal([...flatPins].reduce((a,b)=>a+b,0),2);
  const vertical=new Float32Array([-1,-1,0,0,-1,0,1,-1,0,-1,0,0,0,0,0,1,0,0,-1,1,0,0,1,0,1,1,0]),verticalPins=new Uint8Array(9);
  engine.selectClothPins(flat,{rest:vertical},verticalPins,{});
  assert.equal([...verticalPins].reduce((a,b)=>a+b,0),3);
  assert.equal(verticalPins[6],1);assert.equal(verticalPins[8],1);
});

test('SPH density projection separates over-compressed particles and does not attract an under-dense pair',()=>{
  const engine=makeEngine();
  const dense={kind:'sph',count:2,positionPtr:new Float32Array([-.01,0,0,.01,0,0]),velocityPtr:new Float32Array(6),activePtr:new Uint8Array([1,1]),smoothingLength:.2,mass:.005,outflowEnabled:true,params:{}};
  const before=Math.abs(dense.positionPtr[0]-dense.positionPtr[3]);engine.projectLiquidDensity(dense,1/60);
  const after=Math.abs(dense.positionPtr[0]-dense.positionPtr[3]);assert.ok(after>before);assert.ok([...dense.positionPtr].every(Number.isFinite));
  const sparse={kind:'sph',count:2,positionPtr:new Float32Array([-.05,0,0,.05,0,0]),velocityPtr:new Float32Array(6),activePtr:new Uint8Array([1,1]),smoothingLength:.2,mass:1e-12,outflowEnabled:true,params:{}};
  const sparseBefore=[...sparse.positionPtr];engine.projectLiquidDensity(sparse,1/60);assert.deepEqual([...sparse.positionPtr],sparseBefore);
});

test('Flow emits from the assigned mesh surface and tracer renderers use camera-facing fire/smoke sprites',()=>{
  const engine=makeEngine(),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,2,0,0,0,0,2],3));geometry.setIndex([0,1,2]);const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());mesh.position.set(4,3,-2);mesh.updateMatrixWorld(true);
  const points=engine.sampleMeshSurface(mesh,128,new Float32Array(128*3));assert.equal(points.length,384);for(let i=0;i<points.length;i+=3){assert.ok(points[i]>=3.99&&points[i]<=6.01);assert.ok(points[i+2]>=-2.01&&points[i+2]<=.01);assert.ok(Math.abs(points[i+1]-3)<.03)}
  assert.ok(source.includes('new THREE.PlaneGeometry(2, 2)'),'fire and smoke should use WebGL billboard cards rather than visible sphere blobs');
  assert.ok(source.includes('record.fireVisual')&&source.includes('record.smokeVisual'),'combined fire/smoke needs independently shaded fire and smoke layers');
  assert.ok(source.includes("tracerSpriteTexture('fire')")&&source.includes("tracerSpriteTexture('smoke')"),'render mode should use soft procedural flame and smoke sprites');
  assert.ok(source.includes('getActiveCamera')&&source.includes('object.quaternion.copy(camera.quaternion)'),'billboards should face the active viewport camera');
  assert.ok(source.includes("if(record.role==='Flow')positions.set(this.sampleMeshSurface(mesh,count,positions))"),'flow tracer birth positions must come from the emitter mesh');
  assert.ok(appHtml.includes('getActiveCamera:()=>isCameraView?sceneCamera:viewportCamera,getShadingMode:()=>currentShadingMode'),'simulation sprites must use the active viewport/shading state');
  assert.ok(appHtml.includes('stepPhysicsSimulations(1/60)'),'simulation domains should keep stepping in realtime while the viewport is open');
  assert.ok(appHtml.includes('Flow emits from the selected mesh surface'));
  assert.ok(appHtml.includes('up to 768 SPH particles and 96 surface cells'),'the actual browser solver budget should not be mislabeled as a 256³ solver');
});

test('liquid preview retains the physical water material and explicitly bounded surface resolution',()=>{
  assert.ok(source.includes("preset === 'Water' ? 0x2d91b4")||source.includes('MeshPhysicalMaterial({ color, metalness: 0'));
  assert.ok(source.includes('const MAX_PARTICLES = 768'));
  assert.ok(source.includes("'Surface Resolution', 64)), 16, 96"),'isosurface reconstruction should use the higher 96-cell setting without claiming a 256³ solver');
  assert.ok(source.includes("'Resolution', 80) / 8), 4, 12"),'the flow grid preset should expose the expanded particle budget');
});

test('Collision modifier projects deformable nodes onto real mesh triangles and applies friction/restitution',()=>{
  const engine=makeEngine(),scene=new THREE.Scene();engine.scene=()=>scene;engine.collisionSurfaceCache=new Map();engine.arena={f32:a=>a,u8:a=>a};
  const cg=new THREE.BufferGeometry();cg.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,0,0,2,2,0,0],3));cg.setIndex([0,1,2]);const collider=new THREE.Mesh(cg,new THREE.MeshBasicMaterial());collider.userData.collisionSettings={'Collision Quality':5,'Outer Thickness':.05,'Inner Thickness':.03,'Particle Damping':.1,'Cloth Friction':.5,'Restitution':.08,'Single Sided':true,enabled:true};scene.add(collider);collider.updateMatrixWorld(true);
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());mesh.updateMatrixWorld(true);const state={positionPtr:new Float32Array([.4,.01,.4]),previousPtr:new Float32Array([.4,.03,.4]),pinsPtr:new Uint8Array([0]),nodeCount:1};
  engine.resolveMeshCollisions(mesh,state,{},'Cloth',1/60);assert.ok(state.positionPtr[1]>=.049);assert.ok(state.previousPtr[1]<state.positionPtr[1]);
  const cache=engine.buildCollisionSurface(collider,collider.userData.collisionSettings);assert.ok(cache.triangles.length>0&&typeof cache.grid.get==='function','collider triangles should be indexed in a spatial broadphase');
});

test('deformables use stable fixed substeps, rotated-world gravity, floor contact and volume controls',()=>{
  assert.match(source,/DEFORMABLE_FIXED_STEP = 1 \/ 120/);
  assert.match(source,/localGravity\.applyMatrix3\(new THREE\.Matrix3\(\)\.setFromMatrix4\(inverseWorld\)\)/);
  assert.match(source,/resolveGroundContact\(mesh, state, params, type\)/);
  assert.match(source,/number\(params, 'Volume Preservation', 0\.85\)/);
  assert.match(source,/number\(params, 'Bending Resistance', 0\.5\)/);
});

test('a liquid domain binds the FLIP grid the engine ships and steps it instead of PBF',()=>{
  const wasmBytes=readFileSync(appPath('wasm/fe_core_engine.wasm'));
  const exp=new WebAssembly.Instance(new WebAssembly.Module(wasmBytes),{}).exports;
  const arena={
    f32:(ptr,len)=>new Float32Array(exp.memory.buffer,ptr,len),
    u8:(ptr,len)=>new Uint8Array(exp.memory.buffer,ptr,len),
    writeF32:(ptr,data)=>new Float32Array(exp.memory.buffer,ptr,data.length).set(data)
  };
  const engine=makeEngine();
  engine.wasm=exp;engine.arena=arena;engine.isCppBackend=true;engine.flipOwner=null;
  const boundsPtr=exp.fe_malloc(24);
  /* A 2 x 2 x 1 box, the shape of a default liquid domain. */
  const box=[-1,0,-0.5,1,2,0.5];
  arena.writeF32(boundsPtr,new Float32Array(box));
  const record={useFlip:true,boundsPtr,flipCellTarget:0.08,flipGridKey:''};

  assert.equal(engine.bindFlipGrid(record),true,'the grid binds');
  assert.ok(record.flipResolution>=8&&record.flipResolution<=48,'the grid is inside the solver cap');
  assert.equal(record.flipResolution,Math.round(2/0.08),'the cell target sets the resolution from the longest axis');
  assert.ok(Math.abs(record.flipCellSize-0.08)<0.006,'the cell lands on the particle spacing');
  assert.equal(exp.fe_flip_grid_nx(),record.flipResolution);
  assert.equal(exp.fe_flip_grid_nz(),Math.round(1/record.flipCellSize),'the short axis takes the same cell size');
  assert.equal(exp.fe_flip_cell_count(),exp.fe_flip_grid_nx()*exp.fe_flip_grid_ny()*exp.fe_flip_grid_nz());
  assert.equal(engine.flipOwner,record,'the bound domain owns the grid');

  /* Binding twice is free; binding a different box re-inits. */
  assert.equal(engine.bindFlipGrid(record),true);
  const other=exp.fe_malloc(24);
  arena.writeF32(other,new Float32Array([-2,0,-2,2,4,2]));
  const second={useFlip:true,boundsPtr:other,flipCellTarget:0.16,flipGridKey:''};
  assert.equal(engine.bindFlipGrid(second),true);
  assert.equal(engine.flipOwner,second);
  assert.equal(record.useFlip,true);
  assert.equal(typeof exp.fe_flip_step,'function','the step kernel the domain calls exists');
});

test('liquid presets map onto a FLIP ratio and a viscosity',()=>{
  const engine=makeEngine();
  const water=engine.liquidPresetPhysics('Water');
  const honey=engine.liquidPresetPhysics('Honey');
  const oil=engine.liquidPresetPhysics('Oil');
  assert.ok(water.ratio>honey.ratio,'water keeps more of the particle velocity than honey');
  assert.ok(honey.viscosity>oil.viscosity&&oil.viscosity>water.viscosity,'honey is the thickest');
  for (const p of [water,honey,oil,engine.liquidPresetPhysics('Slime')]) {
    assert.ok(p.ratio>=0&&p.ratio<=1);
    assert.ok(p.viscosity>=0);
  }
});

test('the fluid step prefers FLIP for a liquid domain and keeps PBF as the fallback',()=>{
  assert.match(source,/record\.kind === 'sph' && record\.useFlip && this\.bindFlipGrid\(record\)/);
  assert.match(source,/this\.wasm\.fe_flip_step\(/);
  assert.match(source,/record\.flowBehavior === 'Outflow' \? 1 : 0,\s*\n\s*record\.flipMetricsPtr/);
  assert.match(source,/record\.useFlip = flipReady && count <= 65536/);
  assert.match(source,/const FLIP_MAX_PARTICLES = 16384;/,'the FLIP lattice budget is stated, not implied');
  assert.ok(source.indexOf('fe_flip_step(')<source.indexOf('fe_sim_liquid_pbf_step(\n'),'FLIP is tried before the PBF path');
});
