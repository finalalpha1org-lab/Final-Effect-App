import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appPath } from './app-paths.mjs';

const app = readFileSync(appPath('index.html'), 'utf8');
const terrain = readFileSync(appPath('Terrain_system_.html'), 'utf8');
const simulation = readFileSync(appPath('simulationCore.js'), 'utf8');

test('Explore has first-person jump and model-free free-flight altitude step controls', () => {
  for (const id of ['exJumpButton','exHeliAltitudeDown','exHeliAltitudeUp','exHeliAltitudeStepDown','exHeliAltitudeStepUp']) assert.ok(terrain.includes(`id="${id}"`), `${id} should exist`);
  assert.ok(terrain.includes('function jumpExplore()'));
  assert.ok(/walkVelocityY=Math\.sqrt\(2\*jumpGravity\*\.65\)/.test(terrain));
  assert.ok(terrain.includes("getElementById('exJumpButton').onclick=jumpExplore"));
  assert.ok(terrain.includes('if(exploreMode!==\'first\'||!walkRig)return false'));
  assert.ok(terrain.includes('gravityEnabled||walkJumping'),'jump should continue against configurable gravity');
  assert.ok(terrain.includes('function adjustExploreAltitude(delta)'));
  assert.ok(/setExploreAltitude\(heliAltitude\+Math\.sign\(delta\)\*5\)/.test(terrain));
  assert.ok(terrain.includes("getElementById('exHeliAltitudeDown').onclick=()=>adjustExploreAltitude(-5)"));
  assert.ok(terrain.includes("getElementById('exHeliAltitudeUp').onclick=()=>adjustExploreAltitude(5)"));
  assert.ok(terrain.includes('No aircraft model is shown'));
});

test('First-person jump has a grounded launch and a short gravity-driven arc', () => {
  const start=terrain.indexOf('function setExploreAltitude'),end=terrain.indexOf('function setExploreSpeed',start);
  assert.ok(start>=0&&end>start);
  const context={exploreMode:'first',walkRig:{position:{x:0,y:0,z:0}},hgt:()=>0,water:{visible:false,position:{y:0}},gravityEnabled:true,gravityStrength:9.8,walkVelocityY:0,walkJumping:false,exClamp:(v,a,b)=>Math.max(a,Math.min(b,v))};
  vm.runInNewContext(terrain.slice(start,end)+';this.jumpExplore=jumpExplore;',context);
  assert.equal(context.jumpExplore(),true);
  assert.ok(Math.abs(context.walkVelocityY-Math.sqrt(2*9.8*.65))<1e-8);
  assert.equal(context.walkJumping,true);
  const s=terrain.indexOf('function stepExploreVertical'),e=terrain.indexOf('function updateExplore',s),physics={exClamp:(v,a,b)=>Math.max(a,Math.min(b,v))};
  vm.runInNewContext(terrain.slice(s,e)+';this.stepExploreVertical=stepExploreVertical;',physics);
  let y=0,v=context.walkVelocityY,peak=0,time=0;
  for(let i=0;i<480;i++){[y,v]=physics.stepExploreVertical(y,v,0,0,false,1/240,true,9.8);peak=Math.max(peak,y);time+=1/240;if(i>0&&y===0&&v===0)break}
  assert.ok(Math.abs(peak-.65)<.04,`expected a ~0.65 m hop, got ${peak}`);
  assert.ok(time<.9,'the jump should not hang in the air');
  assert.equal(y,0,'gravity should return the camera rig to the ground');
});

test('OrbitControls stay locked during Explore pointer-look and restore with the saved camera', () => {
  assert.ok(terrain.includes('if(exploreMode||e.target!==cv)return;'));
  assert.ok(terrain.includes('if(exploreMode){ptD.clear();return}'));
  assert.ok(terrain.includes('oc.enabled=false;lookPointerId=e.pointerId'));
  assert.ok(terrain.includes('oc.enabled=false;const dx=e.clientX-lastLookX'));
  assert.ok(terrain.includes('Object.assign(oc,exploreSaved.controls)'));
});

test('Edit mode waits for an explicit sub-tool choice instead of opening Move automatically', () => {
  const start=app.indexOf('function renderSubToolbar()'),end=app.indexOf('window.renderSubToolbar',start);
  assert.ok(start>=0&&end>start);
  const body=app.slice(start,end);
  assert.ok(body.includes('closeAllFloatingPanels()'));
  const code=body.replace(/toolbar\.innerHTML\s*=\s*`[\s\S]*?`;/,'');
  assert.ok(!/openFloatingPanel\(['"]move['"]\)/.test(code),'the explicit Move button may open its panel, but Edit entry must not call it');
});

test('Annotate creates world-space 3D lines and is bounded to the actual viewport', () => {
  const start=app.indexOf('function pick3DAnnotationPoint'),end=app.indexOf('// Camera projection helpers',start);
  assert.ok(start>=0&&end>start);
  const body=app.slice(start,end);
  assert.ok(body.includes('rendererCanvas = eng?.renderer?.domElement'));
  assert.ok(/new THREE\.Raycaster\(\)/.test(body));
  assert.ok(/new THREE\.Line\(/.test(body));
  assert.ok(/new THREE\.TubeGeometry\(curve,segments,radius,5,false\)/.test(body),'finished strokes should become thick world-space meshes');
  assert.ok(/Number\(getScreenElement\('#anno-size'\)/.test(body),'the stroke-width control should affect 3D annotation');
  assert.ok(/userData\.isAnnotation\s*=\s*true/.test(body));
  assert.ok(/intersectPlane\(ground, point\)/.test(body));
  const viewport=app.indexOf('<div class="viewport">'),annotation=app.indexOf('<canvas id="annotation-canvas"'),layer=app.indexOf('<div class="layer-bar">');
  assert.ok(viewport>=0&&annotation>viewport&&layer>annotation,'annotation input canvas must stay inside the 3D viewport');
});

test('Light selection rings are absent, light picking remains virtual, and helper geometry never casts/receives shadows', () => {
  assert.ok(!/new THREE\.SphereGeometry\(0\.56, 16, 12\)/.test(app));
  assert.ok(!/Light Selection Sphere|new THREE\.RingGeometry\(0\.26, 0\.38, 32\)/.test(app));
  assert.ok(/group\.raycast\s*=\s*function\(raycaster, intersections\)/.test(app));
  assert.ok(/group\.traverse\(object => \{\s*if \(!object\.isLight\) \{\s*object\.castShadow = false;\s*object\.receiveShadow = false;/.test(app));
  assert.ok(/group\.traverse\(node => \{ node\.castShadow = false; node\.receiveShadow = false; \}\)/.test(app));
});

test('default workspace remains a Cube and Material/Rendered modes retain its real shadow behavior', () => {
  const start=app.indexOf('// Default Cube at [0, 0, 0]'),end=app.indexOf('// Initial lookAt [0, 0, 0]',start);
  assert.ok(start>=0&&end>start);
  const setup=app.slice(start,end);
  assert.match(setup,/new THREE\.BoxGeometry\(1\.4,\s*1\.4,\s*1\.4\)/);
  assert.match(setup,/cube\.name\s*=\s*'Cube'/);
  assert.match(app,/id="chip-cube"[^>]*>Cube<\/button>/);
  const materialStart=app.indexOf("} else if (shading === 'material') {"),renderStart=app.indexOf("} else if (shading === 'rendered') {",materialStart),renderEnd=app.indexOf("if (activeLight?.isSpotLight) updateSpotHelper();",renderStart);
  assert.ok(materialStart>=0&&renderStart>materialStart&&renderEnd>renderStart);
  assert.match(app.slice(materialStart,renderStart),/mesh\.castShadow\s*=\s*true;\s*mesh\.receiveShadow\s*=\s*true/);
  assert.match(app.slice(materialStart,renderStart),/shadowFloor\.visible\s*=\s*true/);
  assert.match(app.slice(renderStart,renderEnd),/mesh\.castShadow\s*=\s*true;\s*mesh\.receiveShadow\s*=\s*true/);
  assert.match(app.slice(renderStart,renderEnd),/shadowFloor\.visible\s*=\s*true/);
  const restoreStart=app.indexOf('this.restoreAutosave=async data=>'),restoreEnd=app.indexOf('historyCtl=history;',restoreStart);
  assert.ok(restoreStart>=0&&restoreEnd>restoreStart);
  assert.doesNotMatch(app.slice(restoreStart,restoreEnd),/cube\.geometry=restored\.geometry/);
});

test('workspace autosave recovery selects the default mesh instead of reopening a saved Light selection', () => {
  const start=app.indexOf('this.restoreAutosave=async data=>'),end=app.indexOf('historyCtl=history;',start);
  assert.ok(start>=0&&end>start);
  const restore=app.slice(start,end);
  assert.match(restore,/const recoveredDefaultMesh=this\.cube\?\.parent===sc\?'cube'/);
  assert.match(restore,/activeObject=recoveredDefaultMesh/);
  assert.doesNotMatch(restore,/activeObject=camData\.activeObject/);
  assert.match(restore,/selectObject\(activeObject,'autosave-recovery'\)/);
});

test('Fluid exposes a higher-resolution, explicitly bounded simulation budget', () => {
  assert.ok(/\["Resolution","range",32,96,80,8\]/.test(app));
  assert.ok(/\["Surface Resolution","range",16,96,64,4\]/.test(app));
  assert.ok(simulation.includes('const MAX_PARTICLES = 768'));
  assert.ok(/number\(record\.params, 'Surface Resolution', 64\)\), 16, 96/.test(simulation));
  assert.ok(app.includes('768 SPH particles and 96 surface cells'));
  assert.ok(app.includes('not a 256³ grid/full CFD solver'));
});
