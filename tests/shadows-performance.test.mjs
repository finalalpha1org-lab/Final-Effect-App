import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('directional sunlight casts real shadows onto terrain; rocks cast but do not self-receive',()=>{
  assert.match(html,/new THREE\.WebGLRenderer\(\{canvas:cv,antialias:true,powerPreference:'high-performance'\}\)/);
  assert.match(html,/ter\.receiveShadow=true;ter\.castShadow=false/,'terrain should receive object shadows without shadowing itself');
  assert.match(html,/sun\.castShadow=true/);
  assert.match(html,/sun\.shadow\.bias=-\.0002/);
  assert.match(html,/sun\.shadow\.normalBias=\.018/,'normal bias must stay small so real contact shadows do not detach');
  assert.match(html,/sun\.shadow\.radius=\.8/,'keep directional shadows defined rather than overly diffuse');
  assert.match(html,/NO_SELF_SHADOW_RECEIVE/);
  assert.match(html,/m\.castShadow=isLow\?SHADOW_LOW_DETAIL\.has\(n\):!!sh/);
  assert.match(html,/mk\('rock',1000,\[0,1,2\]\.map\(v=>\[rockG\(\),\{nt:1,std:1,vi:v,vn:3\}\]\),true\)/,'rocks must cast into the real directional shadow map');
  assert.match(html,/m\.receiveShadow=!NO_SELF_SHADOW_RECEIVE\.has\(n\)/);
  assert.match(html,/hemisphere\/environment lights.*fill only/i);
});

test('fake radial blob contact-shadow decals are absent; only the directional shadow map shades object contact',()=>{
  assert.doesNotMatch(html,/const blobIM=new THREE\.InstancedMesh/,'do not draw screen-facing fake shadow planes beneath rocks/buildings');
  assert.doesNotMatch(html,/function rebuildBlobs\(/,'fake rock/building contact shadows must not be regenerated after edits');
  assert.match(html,/function rebuildTreeMap\(\)\{drawTreeMap\(\)\}/,'retain the foliage-light map update without rendering blob shadows');
});

test('grass and tall grass cast real sparse low-mesh shadows without duplicating their visible instances',()=>{
  assert.match(html,/function makeBotanicalShadowProxy\(/);
  assert.match(html,/SHADOW_PROXY_STRIDE=8/);
  assert.match(html,/proxy\.layers\.set\(1\)/);
  assert.match(html,/sc\.layers\.enable\(1\)/);
  assert.match(html,/K\.shadowMeshes=K\.meshes\.map/);
  assert.match(html,/const shadow=K\.shadowMeshes\?\.\[mi\]/);
});

test('GPU smooth preview uses adaptive WebGL render resolution while preserving scene density and shadows',()=>{
  assert.match(html,/smoothPreviewAuto=true/);
  assert.match(html,/function updateSmoothPreview\(/);
  assert.match(html,/function applyPreviewPixelRatio\(/);
  assert.match(html,/GPU Smooth Preview/);
  assert.match(html,/WebGL2 GPU/);
  assert.match(html,/ren\.setPixelRatio\(Math\.min\(devicePixelRatio,2\)\)/);
  assert.match(html,/ren\.setPixelRatio\(ratio\)/);
  assert.match(html,/ren\.setSize\(innerWidth,innerHeight,false\)/);
  assert.match(html,/shadows and foliage placements are preserved/i);
});
