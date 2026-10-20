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
