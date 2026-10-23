import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStandaloneTerrainHtml } from '../scripts/standalone-html.mjs';
import { appPath } from './app-paths.mjs';

const build=readFileSync(appPath('../scripts/build.mjs'),'utf8');
const worker=readFileSync(appPath('../worker.js'),'utf8');
const addon=readFileSync(appPath('open-world.js'),'utf8');

test('standalone Terrain HTML embeds ordered main-script chunks and the Open World add-on',()=>{
  const names=Array.from({length:9},(_,i)=>`terrain-main-${String(i+1).padStart(2,'0')}.js`),parts=names.map((name,i)=>[name,`window.terrainPart${i+1}=true;`]);
  const src='<script src="./celestial-math.js"></script><script src="./scatter-spacing.js"></script><script src="./tessendorf-ocean.js"></script><script src="./open-world-generator.js"></script>'+names.map(n=>`<script src="./${n}"></script>`).join('')+'<script>window.mainReady=true;</script><script src="./open-world.js"></script><script src="https://cdn.example/three.js"></script>';
  const out=createStandaloneTerrainHtml(src,{celestialMath:'window.CelestialMath={};',scatterSpacing:'window.ScatterSpacing={};',tessendorf:'window.TessendorfOcean={};',openWorld:'window.OpenWorldGenerator={};',terrainMainParts:parts,openWorldAddon:'window.OpenWorldAddon={};'});
  for(const name of ['celestial-math.js','scatter-spacing.js','tessendorf-ocean.js','open-world-generator.js','open-world.js',...names])assert.ok(!out.includes('src="./'+name+'"'));
  for(const marker of ['window.CelestialMath','window.ScatterSpacing','window.TessendorfOcean','window.OpenWorldGenerator','window.OpenWorldAddon',...parts.map(([,s])=>s)])assert.ok(out.includes(marker));
  assert.ok(out.indexOf('window.terrainPart9=true;')<out.indexOf('window.mainReady=true;')&&out.indexOf('window.mainReady=true;')<out.indexOf('window.OpenWorldAddon={}'),'the add-on loads after every main script chunk');
  assert.ok(out.includes('https://cdn.example/three.js'),'the main Three.js CDN requirement remains unchanged');
  assert.doesNotMatch(addon,/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(/,'the reviewed add-on must not add network/relay behavior');
  assert.doesNotThrow(()=>new vm.Script(addon,{filename:'open-world.js'}),'the add-on source parses without executing');
});

test('standalone generation is part of every app build and has a live download route',()=>{
  assert.ok(build.includes('createStandaloneTerrainHtml'));
  assert.ok(build.includes('openWorldAddon: readFileSync("build/client/open-world.js"'));
  assert.ok(build.includes('openWorld: readFileSync("build/client/open-world-generator.js"'));
  assert.ok(build.includes('await transform(source')&&build.includes('minify: true'),'downloaded helper assets are minified without changing graphics resources');
  assert.ok(build.includes('terrainMainFiles=Array.from({length:9}')&&build.includes('terrainMainParts: terrainMainFiles.map'),'large main code is split into cacheable classic-script chunks');
  assert.ok(build.includes('minifyInlineScripts')&&build.includes('createStandaloneTerrainHtml(optimizedTerrainHtml'),'deployed and standalone terrain pages receive whitespace/syntax-only inline minification');
  assert.ok(build.includes('writeFileSync("build/client/Terrain-System-Standalone.html"'));
  assert.ok(worker.includes('/download/Terrain-System-Standalone.html'));
  assert.ok(worker.includes('Content-Disposition'));
});

test('standalone generation rejects missing or unsafe inline scripts',()=>{
  const helpers={celestialMath:'x',scatterSpacing:'y',tessendorf:'z',openWorld:'w',terrainMainParts:[],openWorldAddon:'v'};
  assert.throws(()=>createStandaloneTerrainHtml('<html></html>',helpers),/Expected exactly one/);
  const src='<script src="./celestial-math.js"></script><script src="./scatter-spacing.js"></script><script src="./tessendorf-ocean.js"></script><script src="./open-world-generator.js"></script><script src="./open-world.js"></script>';
  assert.throws(()=>createStandaloneTerrainHtml(src,{...helpers,openWorldAddon:'</script>'}),/Unsafe closing script marker/);
});
