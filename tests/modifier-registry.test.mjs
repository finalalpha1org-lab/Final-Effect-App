import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('index.html'),'utf8');
const start=html.indexOf('const modifiersData = {'),end=html.indexOf('\nlet modStack',start);
const registry=html.slice(start,end);
const names=[...registry.matchAll(/\{name:"([^"]+)"/g)].map(match=>match[1]);
const expected=['Array','Bevel','Boolean','Decimate','Build','Edge Split','Laplacian Smooth','Mirror','Screw','Solidify','Subdivision Surface','Triangulate','Weld','Wireframe','Armature','Cast','Displace','Lattice','Shrinkwrap','Simple Deform','Smooth','Surface Deform','Warp','Wave','Weighted Normal','Collision','Cloth','Soft Body','Fluid'].sort();

test('modifier registry audit enumerates all current categories and 29 modifiers',()=>{
  assert.equal(names.length,29);
  assert.deepEqual([...names].sort(),expected);
  assert.match(registry,/Generate:\s*\[/);
  assert.match(registry,/Deform:\s*\[/);
  assert.match(registry,/Normals:\s*\[/);
  assert.match(registry,/Physics:\s*\[/);
});

test('Collision is a configurable mesh-surface physics modifier wired into simulation and remains separate from geometry evaluation',()=>{
  const evaluator=html.slice(html.indexOf('function updateModifiersOnScene'),html.indexOf('window.updateModifiersOnScene = updateModifiersOnScene'));
  assert.ok(registry.includes('{name:"Collision", fields:['));
  for(const field of ['Collision Quality','Outer Thickness','Inner Thickness','Particle Damping','Particle Friction','Cloth Friction','Restitution','Permeability','Kill Particles','Single Sided'])assert.ok(registry.includes(field));
  assert.match(evaluator,/userData\.collisionSettings=\{\.\.\.collisionMod\.values,enabled:true\}/);
  assert.match(evaluator,/else delete targetObj\.userData\.collisionSettings/);
  const sim=readFileSync(appPath('simulationCore.js'),'utf8');
  assert.ok(sim.includes('buildCollisionSurface(collider,settings={})')&&sim.includes('nearestCollisionHit(surface'));
  assert.ok(sim.includes('resolveMeshCollisions(mesh,state,params,type,stepDt)')&&sim.includes('resolveParticleCollisions(record,dt)'));
});

test('critical Boolean is operand-backed; unsupported rig/cage modifiers fail explicitly instead of using a fake taper',()=>{
  const evaluator=html.slice(html.indexOf('function updateModifiersOnScene'),html.indexOf('window.updateModifiersOnScene = updateModifiersOnScene'));
  assert.match(registry,/\["Operand Object","select",\[\]\]/);
  assert.match(registry,/\["Operation","select",\["Difference","Union","Intersection"\]\]/);
  assert.match(evaluator,/applyBooleanModifier\(targetObj, currentGeo, p\)/);
  assert.match(evaluator,/Lattice needs an editable control-cage object/);
  assert.match(evaluator,/needs a rig\/bone-weight or bind-target workflow/);
  assert.doesNotMatch(evaluator,/applyLatticeModifier\(currentGeo, inf/);
});

test('the project file carries each object’s modifier configuration',()=>{
  /* The hand-rolled .final3d writer used to spell the stack out itself, one
     `modifiers: (obj.userData?.modStack || []).map(...)` per object. The project
     file (`.fe3d` / `.fe3a`, fe-project.js) stores the engine's own autosave
     blob instead, and every object's userData - where modStack lives - travels
     inside it; tests/fe-project.test.mjs reads that back out of the bytes. */
  assert.ok(!/modifiers:\s*\(obj\.userData\?\.modStack/.test(html), 'one scene description, not two');
  assert.ok(html.includes('<script src="fe-project.js"></script>'), 'the project writer is shipped');
  const project=readFileSync(appPath('fe-project.js'),'utf8');
  assert.ok(project.includes('serializeAutosave()'), 'and it saves the scene through the engine round trip');
});
