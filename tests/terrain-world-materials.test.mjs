import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('biome/PBR brush exposes the requested 12 terrain surfaces on normal terrain',()=>{
  const names=['Hills','Alpine','Desert','Volcano','Sand Shores','Rocky Mountains','Grassy','Sand','Lava','Magma','Pebbles','Beach Sand'];
  for(const name of names)assert.ok(html.includes("label:'"+name+"'"),'missing '+name+' surface');
  assert.ok(html.includes('OW_SURFACE_DEFS.map(owSurfaceTexture)'));
  assert.ok(html.includes('OW_SURFACE_ATLAS'));
  assert.ok(html.includes('uSurfAtlas'));
  assert.ok(html.includes('Biome / PBR material brush'));
  assert.ok(html.includes("btn('🗺 Biome / PBR material brush'"));
  assert.ok(html.includes("...(br.tool=='paint'||br.tool=='biome'?"),'the material palette is part of the terrain brush panel');
  assert.ok(html.includes('Warped world-space PBR texturing reduces visible tiling'));
  assert.ok(html.includes('surfAtlasUv')&&html.includes('surfWarp'),'triplanar sampling must vary coordinates in world space to break visible repetition');
  assert.ok(html.includes('vec2 tile=vec2(mod(id,4.),2.-floor(id/4.));'),'CanvasTexture.flipY requires atlas rows to map surface IDs to the matching palette row');
  for(const name of ['surfaceWeightsA','surfaceWeightsB','surfaceWeightsC'])assert.ok(html.includes(name),'missing '+name+' blend channel');
  assert.ok(html.includes("setAttribute('surfaceWeightsC',new THREE.BufferAttribute(SWC,4))"));
  assert.ok(html.includes('surfaceWeightsA:b64(SWA),surfaceWeightsB:b64(SWB),surfaceWeightsC:b64(SWC)'),'export carries all paint weights');
  assert.ok(html.includes('SA:shareHistoryArray(SWA.slice(')&&html.includes('SC:shareHistoryArray(SWC.slice('),'undo/redo stores all paint weights');
  assert.ok(html.includes('oldSB.length===W*W*2'),'older six-layer paint snapshots migrate into the expanded material channels');
});

test('the additive brush routes and blends all 12 PBR materials',()=>{
  const start=html.indexOf('function paintTerrainWorldSurface('),end=html.indexOf('\n',start),source=html.slice(start,end);
  const ctx={SWA:new Float32Array(4),SWB:new Float32Array(4),SWC:new Float32Array(4),MI:new Uint8Array(1)};
  vm.runInNewContext(source+';this.paint=paintTerrainWorldSurface;',ctx);
  ctx.paint(0,10,1);assert.equal(ctx.SWC[2],1);assert.equal(ctx.MI[0],255);
  ctx.paint(0,7,.5);assert.equal(ctx.SWC[2],.5);assert.equal(ctx.SWB[3],.5);
  ctx.paint(0,0,.25);assert.ok(Math.abs(ctx.SWA[0]-.25)<1e-6);assert.ok(Math.abs(ctx.SWB[3]-.375)<1e-6);assert.ok(Math.abs(ctx.SWC[2]-.375)<1e-6);
});

test('normal terrain PBR paint uses a soft falloff and remains in terrain undo history',()=>{
  assert.ok(html.includes("paintTerrainWorldSurface(k,normalWorldMaterial,cl(f*2*br.str,0,1))"));
  assert.ok(html.includes('normalWorldMaterialBrush'));
  assert.ok(html.includes("case'biome':if(f>.035)paintTerrainWorldSurface(k,normalWorldMaterial,cl(f*2*br.str,0,1))"),'the dedicated biome brush paints the selected PBR material');
  assert.ok(html.includes('SA:shareHistoryArray(SWA.slice('));
});

test('Open World is a real streamed mode instead of a blank placeholder',()=>{
  assert.ok(html.includes('PN.openworld=()=>'));
  assert.ok(html.includes('Generate Open World Map'));
  assert.ok(html.includes('function owStart()')&&html.includes('OpenWorldGenerator.createChunkJob'));
  assert.ok(!html.includes('PN.openworld=()=>[];'),'the retired blank placeholder must not return');
});
