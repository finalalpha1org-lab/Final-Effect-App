import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('Open World ships a generator, streamed scene and real controls',()=>{
  assert.ok(html.includes("['openworld','🌍','Open World']"),'Open World remains reachable');
  assert.ok(html.includes('PN.openworld=()=>'),'the bottom sheet exposes real controls');
  assert.ok(html.includes('OpenWorldGenerator.createChunkJob'),'chunks come from the real generator');
  assert.ok(html.includes('function owStart()')&&html.includes('function owDeactivate()'),'Open World can be entered and exited');
  assert.ok(html.includes('ren.render(scene,cam)'),'the main scene remains the single render loop');
});

test('normal terrain generation and material painting remain available',()=>{
  assert.ok(html.includes('function paintTerrainWorldSurface('));
  assert.ok(html.includes('normalWorldMaterialBrush'));
  assert.ok(html.includes("btn('🎲 Generate new terrain'"));
});
