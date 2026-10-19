import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('index.html'),'utf8');
const start=html.indexOf('const modifiersData = {'),end=html.indexOf('\nlet modStack',start);
const registry=html.slice(start,end);
const names=[...registry.matchAll(/\{name:"([^"]+)"/g)].map(match=>match[1]);
const expected=['Array','Bevel','Boolean','Decimate','Mirror','Solidify','Subdivision Surface','Triangulate','Weld','Wireframe','Armature','Cast','Displace','Lattice','Shrinkwrap','Smooth','Surface Deform','Warp','Wave','Weighted Normal','Collision','Cloth','Soft Body','Fluid'].sort();

test('modifier registry audit enumerates all current categories and 24 modifiers',()=>{
  assert.equal(names.length,24);
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

test('Final3D export includes each object’s modifier configuration',()=>{
  assert.match(html,/modifiers:\s*\(obj\.userData\?\.modStack\s*\|\|\s*\[\]\)\.map/);
});
