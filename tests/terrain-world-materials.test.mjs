import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('six named PBR surfaces remain paintable on normal terrain',()=>{
  for(const name of ['Hills','Alpine','Desert','Volcano','Sand Shores','Rocky Mountains'])assert.ok(html.includes("label:'"+name+"'"),'missing '+name+' surface');
  for(const sampler of ['uSurf0','uSurf1','uSurf2','uSurf3','uSurf4','uSurf5'])assert.ok(html.includes(sampler),'missing '+sampler+' PBR map');
  assert.ok(html.includes('surfaceWeightsA'));assert.ok(html.includes('surfaceWeightsB'));assert.ok(html.includes('surfRough'));
  assert.ok(html.includes("surfaceWeightsA',new THREE.BufferAttribute(SWA,4)"),'normal terrain carries blendable paint weights');
  assert.ok(html.includes('paintTerrainWorldSurface(k,normalWorldMaterial,cl(f*2*br.str,0,1))'),'normal terrain paints the same materials with a soft weight falloff');
  assert.ok(html.includes('SA:shareHistoryArray(SWA.slice('),'PBR paint is included in terrain undo/redo snapshots');
});

test('the empty Open World sheet exposes no map material brush',()=>{
  assert.ok(html.includes('PN.openworld=()=>[];'));
  assert.ok(html.includes("btn('🌍 Generate Open World Map',()=>setTab('openworld'))"));
  assert.ok(!html.includes("btn('🌍 Generate Open World Map',generateOpenWorldMap)"));
});
