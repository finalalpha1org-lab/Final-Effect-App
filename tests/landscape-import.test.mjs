import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const landscape=readFileSync(appPath('Terrain_system_.html'),'utf8');
const workspace=readFileSync(appPath('index.html'),'utf8');
const workspaceScripts=[...workspace.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match=>match[1]).filter(script=>script.trim());

test('workspace inline JavaScript parses after landscape import integration',()=>{
  assert.ok(workspaceScripts.length>0);
  for(const [index,script] of workspaceScripts.entries())assert.doesNotThrow(()=>new Function(script),`workspace inline script ${index} syntax`);
});

test('global settings expose bounded history and local auto-save intervals, and both studios handle recovery/history',()=>{
  assert.match(workspace,/undoLimit:100,autoSave:true,autoSaveMinutes:2/);
  assert.match(workspace,/<input type="number" id="set-undo-limit" min="1" max="1000"/);
  for(const [minutes,label] of [['2','Every 2 minutes'],['5','Every 5 minutes'],['10','Every 10 minutes'],['60','Every hour']])assert.ok(workspace.includes(`<option value="${minutes}">${label}</option>`));
  assert.match(workspace,/indexedDB\.open\(AUTOSAVE_DB,1\)/);
  assert.match(workspace,/this\.undo=undoHistory;this\.redo=redoHistory/);
  assert.match(workspace,/this\.serializeAutosave=\(\)=>/);
  assert.match(workspace,/function scheduleCoreHistory/);
  assert.ok(workspace.includes("type:'FE_HISTORY_ACTION'"));
  assert.ok(landscape.includes('function setHistoryLimit(v)'));
  assert.ok(landscape.includes('function makeLandscapeAutosave()'));
  assert.ok(landscape.includes('function restoreLandscapeAutosave(payload)'));
});

test('Import button sends a versioned full-detail scene and can reach the workspace from a separate tab',()=>{
  assert.match(landscape,/version:2/);
  assert.match(landscape,/colors:b64\(C\.array\)/);
  assert.match(landscape,/parts:K\.meshes\.map\(packLandscapePart\)/);
  assert.match(landscape,/sync\(k,true\)/);
  assert.match(landscape,/landscapeImportChannel\.postMessage\(message\)/);
  assert.match(landscape,/final-effect:import:ack/);
  assert.match(landscape,/getJson=\(\)=>js\|\|\(js=JSON\.stringify\(d\)\)/);
  assert.match(landscape,/final-effect:edit-imported-landscape/);
});

test('Workspace reconstructs transferred terrain, PBR water, instanced geometry and placed model meshes',()=>{
  assert.match(workspace,/function buildLandscapeGeometry\(/);
  assert.match(workspace,/function buildLandscapeWater\(/);
  assert.ok(workspace.includes('float landscapeWave(vec2 p,out vec2 g,out vec2 horizontal)'));
  assert.ok(workspace.includes('transformed.xz+=importWaterHorizontal*uLWHeight*uLWChop*importWaterFade'));
  assert.match(workspace,/new T\.InstancedMesh\(geom,mat,part\.count\)/);
  assert.match(workspace,/decodeLandscapeArray\(payload\.terrain\.colors,Float32Array\)/);
  assert.match(workspace,/if\(payload\.map\?\.node\)/);
  assert.match(workspace,/landscapeImportChannel\.onmessage/);
  assert.match(workspace,/function applyLandscapeWorld\(/);
  assert.match(workspace,/targetScene\.environment=details\.texture/);
  assert.match(workspace,/Imported Sun Light/);
  assert.match(workspace,/function addLandscapeWeather\(/);
  assert.match(workspace,/function addLandscapeWind\(/);
  assert.match(workspace,/weatherWind=/);
  assert.match(workspace,/landscapeWater=true/);
  assert.match(workspace,/applyLandscapeAwareShadingWorld/);
  assert.match(workspace,/function editImportedLandscape\(/);
  assert.match(workspace,/FE\.open\('landscape'\)/);
  assert.match(workspace,/chip-ImportedLandscape/);
  assert.match(workspace,/editLandscapeBtn\.hidden=/);
  assert.doesNotMatch(workspace,/!eng\.sc\.getObjectByName\('ImportedLandscape'\)/);
});

test('landscape import installs sky lighting, weather, water env map, wind hooks, and replaces atomically',()=>{
  const begin=workspace.indexOf('const LANDSCAPE_ARRAY_TYPES='),finish=workspace.indexOf('/* =========================================================\n   3. OBJECT SELECTION',begin);
  assert.ok(begin>=0&&finish>begin,'landscape host helpers are present');
  const source=workspace.slice(begin,finish),factory=new Function('T','document','FE','selectObject','applyMeshSelectionOutline','updateLayerBarActionIcons','getActiveObjectMesh','atob','console',`${source}\nreturn {buildLandscapeFromPayload};`);
  const fakeCanvas={width:0,height:0,getContext(){return{createImageData(w,h){return{data:new Uint8ClampedArray(w*h*4)}},putImageData(){},createRadialGradient(){return{addColorStop(){}}},fillRect(){}}}};
  const api=factory(THREE,{createElement:()=>fakeCanvas,getElementById:()=>null,querySelector:()=>null},{engines:{}},()=>{},()=>{},()=>{},()=>null,globalThis.atob,console);
  const encode=(values,Type=Float32Array)=>{const a=new Type(values),bytes=new Uint8Array(a.buffer,a.byteOffset,a.byteLength);return Buffer.from(bytes).toString('base64')};
  const geometry={attributes:{position:{type:'Float32Array',itemSize:3,data:encode([0,0,0,1,0,0,0,1,0])},normal:{type:'Float32Array',itemSize:3,data:encode([0,0,1,0,0,1,0,0,1])}},groups:[]};
  const material={type:'MeshStandardMaterial',color:'ffffff',side:2,roughness:.7,metalness:0,transparent:false,opacity:1,alphaTest:0,wireframe:false,textures:{}};
  const matrices=new Float32Array(16);matrices[0]=matrices[5]=matrices[10]=matrices[15]=1;matrices[12]=3;
  const payload={app:'final-effect',version:2,terrain:{size:4,segments:2,heights:encode([-1,0,1,0,2,0,1,0,-1]),colors:encode(Array(27).fill(.5)),normalMap:encode(new Uint8Array(16).fill(128),Uint8Array),normalMapSize:[2,2],normalStrength:.5,snowLine:2},water:{visible:true,level:2,waveHeight:.4,waveSpeed:1,waveChop:.1,wavePeriod:5,waveScale:1,windSpeed:8,windDirection:45,roughness:.2,reflectivity:.8,refraction:.5,transparency:.8,clarity:1,turbidity:.1,foam:.4,foamThreshold:.8,shoreFoam:1,shallow:[.1,.5,.6],deep:[.02,.1,.2],profile:'Lagoon',quality:0,innerRadius:3,farRadius:10},foliage:{kinds:{tree:{parts:[{name:'leaves',count:1,geometry,material,matrices:encode(matrices),colors:encode([.2,.7,.3])}]}}},objects:[{name:'Test Object',position:[5,0,0],quaternion:[0,0,0,1],scale:[1,1,1],geometry,material}],map:{name:'Test Map',node:{name:'Map Root',position:[0,0,5],quaternion:[0,0,0,1],scale:[1,1,1],geometry,material,children:[]}},sky:{timeOfDay:13,sunAngle:20,fog:250,clouds:.5,studio:{suns:[{mode:'orbit',az:0,el:0,inten:1}],clouds:[{cov:.5}],atmo:{lat:35}}},weather:{rain:.3,overcast:.6,storm:.2,snowfall:.2,snowCover:.3,wind:1.5}};
  const scene=new THREE.Scene(),group=api.buildLandscapeFromPayload(payload,scene,THREE),water=group.getObjectByName('Water Near Field'),foliage=group.children.find(o=>o.isInstancedMesh);
  assert.ok(group.getObjectByName('Terrain Mesh'));
  assert.equal(water.material.type,'MeshPhysicalMaterial');
  assert.equal(water.material.envMap,scene.environment);
  assert.equal(scene.background,scene.environment);
  const waterShader={uniforms:{},vertexShader:THREE.ShaderLib.physical.vertexShader,fragmentShader:THREE.ShaderLib.physical.fragmentShader};water.material.onBeforeCompile(waterShader);
  assert.ok(waterShader.vertexShader.includes('\nattribute float aLandscapeDepth;'));
  assert.ok(waterShader.fragmentShader.includes('\nfloat importedAtten='));
  assert.ok(!waterShader.vertexShader.includes('\\nattribute float aLandscapeDepth;'));
  assert.ok(group.getObjectByName('Imported Sun Light'));
  assert.ok(group.getObjectByName('Imported Sky World Light'));
  assert.ok(group.getObjectByName('Rainfall'));
  assert.ok(group.getObjectByName('Snowfall'));
  assert.match(foliage.material.customProgramCacheKey(),/landscape-weather-wind-v1/);
  const windShader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};foliage.material.onBeforeCompile(windShader);
  assert.ok(windShader.vertexShader.includes('\nfloat landscapeWindHeight='));
  assert.ok(!windShader.vertexShader.includes('\\nfloat landscapeWindHeight='));
  const oldEnvironment=scene.environment,next=api.buildLandscapeFromPayload({...payload,sky:{...payload.sky,timeOfDay:18}},scene,THREE);
  assert.notEqual(next,group);
  assert.equal(group.parent,null);
  assert.equal(scene.getObjectByName('ImportedLandscape'),next);
  assert.notEqual(scene.environment,oldEnvironment);
  assert.equal(next._landscapeWorldRestore.environment,null);
});
