import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('Open World is a blank placeholder with no generator, state, or scene hooks',()=>{
  assert.ok(html.includes("btn('🌍 Generate Open World Map',()=>setTab('openworld'))"),'the Terrain shortcut only opens the blank sheet');
  assert.ok(html.includes('PN.openworld=()=>[];'),'the bottom sheet contains no controls');
  assert.ok(html.includes("['openworld','🌍','Open World']"),'the placeholder remains reachable');
  for(const token of ['generateOpenWorldMap','generateOpenWorldTerrain','buildOpenWorldMesh','paintOpenWorld','openWorldActive','openWorldScene','openWorldMesh','OPEN_WORLD_SIZE','open-world-generator.js','OpenWorldTerrainBundle'])assert.ok(!html.includes(token),'unexpected generator residue: '+token);
  assert.ok(html.includes('ren.render(scene,cam)'),'the normal scene remains the only rendered scene');
});

test('normal terrain generation and material painting remain available',()=>{
  assert.ok(html.includes('function paintTerrainWorldSurface('));
  assert.ok(html.includes('normalWorldMaterialBrush'));
  assert.ok(html.includes("btn('🎲 Generate new terrain'"));
});
