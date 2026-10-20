import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createStandaloneTerrainHtml } from '../scripts/standalone-html.mjs';
import { appPath } from './app-paths.mjs';

const build=readFileSync(appPath('../scripts/build.mjs'),'utf8');
const worker=readFileSync(appPath('../worker.js'),'utf8');

test('standalone Terrain HTML embeds all local helpers and keeps the Three CDN dependency',()=>{
  const src='<script src="./celestial-math.js"></script><script src="./scatter-spacing.js"></script><script src="./tessendorf-ocean.js"></script><script src="https://cdn.example/three.js"></script>';
  const out=createStandaloneTerrainHtml(src,{celestialMath:'window.CelestialMath={};',scatterSpacing:'window.ScatterSpacing={};',tessendorf:'window.TessendorfOcean={};'});
  for(const name of ['celestial-math.js','scatter-spacing.js','tessendorf-ocean.js'])assert.ok(!out.includes('src="./'+name+'"'));
  for(const marker of ['window.CelestialMath','window.ScatterSpacing','window.TessendorfOcean'])assert.ok(out.includes(marker));
  assert.ok(out.includes('https://cdn.example/three.js'),'only the existing external Three.js CDN requirement remains');
});

test('standalone generation is part of every app build and has a live download route',()=>{
  assert.ok(build.includes('createStandaloneTerrainHtml'));
  assert.ok(!build.includes('open-world-generator.mjs'));
  assert.ok(build.includes('writeFileSync("build/client/Terrain-System-Standalone.html"'));
  assert.ok(worker.includes('/download/Terrain-System-Standalone.html'));
  assert.ok(worker.includes('Content-Disposition'));
});

test('standalone generation rejects missing or unsafe inline scripts',()=>{
  assert.throws(()=>createStandaloneTerrainHtml('<html></html>',{celestialMath:'x',scatterSpacing:'y',tessendorf:'z'}),/Expected exactly one/);
  const src='<script src="./celestial-math.js"></script><script src="./scatter-spacing.js"></script><script src="./tessendorf-ocean.js"></script>';
  assert.throws(()=>createStandaloneTerrainHtml(src,{celestialMath:'</script>',scatterSpacing:'y',tessendorf:'z'}),/Unsafe closing script marker/);
});
