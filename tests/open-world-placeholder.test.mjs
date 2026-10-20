import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('Open World is a blank placeholder until the user asks to enable it',()=>{
  assert.ok(html.includes("btn('🌍 Generate Open World Map',()=>setTab('openworld'))"),'the Terrain shortcut only opens the Open World sheet');
  assert.ok(html.includes('PN.openworld=()=>[];'),'the Open World bottom sheet has no controls or content');
  assert.ok(html.includes('function generateOpenWorldMap(){}'),'the map action is intentionally inert');
  assert.ok(!html.includes("btn('🌍 Generate Open World Map',generateOpenWorldMap)"),'no UI button invokes generation');
  assert.ok(!html.includes('open-world-generator.js')&&!html.includes('OpenWorldTerrainBundle'),'the generator bundle is not loaded');
  assert.ok(html.includes('ren.render(scene,cam'),'the normal scene remains the only rendered scene');
  assert.ok(html.includes("['openworld','🌍','Open World']"),'the blank sheet remains reachable');
});

test('normal terrain generation and material painting remain available',()=>{
  assert.ok(html.includes('function paintTerrainWorldSurface('));
  assert.ok(html.includes('normalWorldMaterialBrush'));
  assert.ok(html.includes("btn('🎲 Generate new terrain'"));
});
