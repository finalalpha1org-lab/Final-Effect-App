import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('index.html'),'utf8');

test('source and selection rings are absent while the dedicated Spot cone halo remains separate',()=>{
  const start=html.indexOf('function createBlenderLightObject()'),end=html.indexOf('function createBlender3DCursorObject()',start);
  assert.ok(start>=0&&end>start);
  const light=html.slice(start,end);
  assert.doesNotMatch(light,/Light Selection Sphere|group\.ring|new THREE\.RingGeometry/);
  assert.match(light,/group\.raycast\s*=\s*function\(raycaster, intersections\)/,'light remains pickable independently of its visual marker');
  assert.doesNotMatch(html,/blenderLight\.ring|group\.ring|ring\.visible\s*=\s*\(newType/);
  const selectionStart=html.indexOf('function applyMeshSelectionOutline('),selectionEnd=html.indexOf('// 4. Cube emissive highlight',selectionStart);
  assert.ok(selectionStart>=0&&selectionEnd>selectionStart);
  assert.doesNotMatch(html.slice(selectionStart,selectionEnd),/RingGeometry|outlineRing/);
});

test('Spot retains its cone-end halo rings; Directional stays ray-only and editor helpers do not cast shadows',()=>{
  const start=html.indexOf('function createDynamicSpotHelper()'),sunStart=html.indexOf('function createDynamicSunHelper()',start),end=html.indexOf('function createBlenderLightObject()',sunStart),spot=html.slice(start,sunStart),directional=html.slice(sunStart,end);
  assert.ok(start>=0&&sunStart>start&&end>sunStart);
  assert.match(spot,/new Float32Array\(10\s*\*\s*3\)/);
  assert.match(spot,/new Float32Array\(8\s*\*\s*3\)/);
  assert.match(spot,/new THREE\.LineLoop/);
  assert.match(spot,/outerHalo/);
  assert.match(spot,/innerHalo/);
  assert.match(spot,/Math\.cos\(a\)/);
  assert.match(directional,/offsets=\[new THREE\.Vector3\(\),v\.clone\(\)\.multiplyScalar\(\.16\)/);
  assert.doesNotMatch(directional,/LineLoop|outerHalo|innerHalo|RingGeometry|sun disk/i);
  assert.match(lightHelperObjectBlock(),/if\s*\(\s*!object\.isLight\s*\)\s*\{\s*object\.castShadow\s*=\s*false;\s*object\.receiveShadow\s*=\s*false;/);
  assert.match(html,/newLight\.castShadow\s*=\s*castShadow/,'real light shadows remain controlled by the light settings, not editor helpers');
});

test('a compact solid light-source Sphere remains visible without a ring or shadows',()=>{
  const light=lightHelperObjectBlock();
  assert.match(light,/new THREE\.Mesh\(new THREE\.SphereGeometry\(0?\.18,\s*16,\s*12\)/);
  assert.match(light,/group\.lightMarker\s*=\s*marker/);
  assert.match(light,/marker\.castShadow\s*=\s*false;\s*marker\.receiveShadow\s*=\s*false/);
  assert.match(light,/marker\.userData\.isEditorHelper\s*=\s*true/);
  assert.match(html,/!child\.userData\?\.isEditorHelper/,'preview shadow/material passes must skip the light-source helper');
  assert.match(html,/group\.lightMarker\.material\.color\.set\(value\)/);
});

function lightHelperObjectBlock(){const a=html.indexOf('function createBlenderLightObject()'),b=html.indexOf('function createBlender3DCursorObject()',a);return html.slice(a,b)}
