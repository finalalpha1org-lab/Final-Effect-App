import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

/* The per-frame budget. Two rules are pinned here:
 *   1. the render loop allocates nothing (no arrays, closures or objects),
 *   2. the instance buffers are written in place — the geometry goes to the GPU
 *      once and a frame only updates matrices/colours that were allocated at
 *      build time.
 * Everything else (draw-call merging, WebGPU) is deliberately out of scope and
 * is described in docs/PERFORMANCE.md instead of being pretended here. */

const LOOP = readFileSync('terrain-main-09.js', 'utf8');
const TERRAIN = readFileSync('terrain-main-01.js', 'utf8');
const SYNC = readFileSync('terrain-main-03.js', 'utf8');

function loopBody() {
  const start = LOOP.indexOf('function loop(){');
  const end = LOOP.indexOf("[()=>{try{if(window.__feRestoreStudioConfig", start);
  assert.ok(start > 0 && end > start, 'the render loop is in terrain-main-09.js');
  return LOOP.slice(start, end);
}

test('the render loop allocates nothing per frame', () => {
  const body = loopBody();
  for (const bad of ['.forEach(', '.map(', '.filter(', '[...', 'Array.from', 'new THREE', 'JSON.parse', '.slice(']) {
    assert.equal(body.includes(bad), false, `the frame loop must not contain ${bad}`);
  }
  /* The two loops that used to allocate a closure per frame are plain loops. */
  assert.match(body, /for\(let ci=0;ci<clouds\.length;ci\+\+\)/, 'clouds are stepped with an index loop');
  assert.match(body, /for\(let ni=0;ni<nfs\.length;ni\+\+\)nfs\[ni\]\(\);/, 'per-frame callbacks are called by index');
  assert.match(body, /updateFoliageLOD\(n\);/, 'the LoD refresh still runs');
});

test('the LoD kind list is built once, not once per frame', () => {
  const source = SYNC.slice(SYNC.indexOf('let lodKindList=null;'), SYNC.indexOf('let season='));
  assert.match(source, /const dirty=typeof window!=='undefined'&&window\.__feFoliageLodDirty===true;/, 'a new species marks the cache dirty');
  assert.match(source, /if\(!lodKindList\|\|dirty\)\{/, 'and only then is the list rebuilt');
  assert.match(source, /const kinds=foliageLodKinds\(\);/, 'the loop reads the cached list');
  assert.equal(/\[\.\.\.LOD_KINDS\]/.test(source), false, 'and no longer spreads the set every frame');

  /* Two calls in a row return the same array instance. */
  const context = {
    console, Math, Array, window: {}, KIND: { grass: { list: [1] }, oak: { list: [1] }, empty: { list: [] } },
    LOD_KINDS: new Set(['grass', 'oak', 'missing', 'empty'])
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.indexOf('function updateFoliageLOD')), context);
  const first = context.foliageLodKinds();
  const second = context.foliageLodKinds();
  assert.equal(first, second, 'the cached list is reused');
  assert.deepEqual([...first], ['grass', 'oak', 'empty'], 'kinds without an instance list are skipped');
  context.window.__feFoliageLodDirty = true;
  const third = context.foliageLodKinds();
  assert.notEqual(third, first, 'a newly created species invalidates the cache');
});

test('geometry is uploaded once and frames only rewrite preallocated buffers', () => {
  /* InstancedMesh with a capacity fixed at build time, dynamic usage, count=0. */
  assert.match(TERRAIN, /new THREE\.InstancedMesh\(g,material,max\)/, 'one instanced mesh per kind and part');
  assert.match(TERRAIN, /instanceMatrix\.setUsage\(THREE\.DynamicDrawUsage\)/, 'the matrix buffer is dynamic');
  assert.match(TERRAIN, /m\.count=0;/, 'and starts empty');
  assert.match(TERRAIN, /new Float32Array\(max\*3\)\.fill\(1\)/, 'the colour buffer is allocated up front');
  /* sync() writes into those buffers and only flags them dirty. */
  assert.match(SYNC, /target\.setMatrixAt\(i,dm\.matrix\)/, 'matrices are written in place');
  assert.match(SYNC, /target\.setColorAt\(i,tcol\.setRGB/, 'colours are written in place');
  assert.match(SYNC, /m\.count=ci;m\.visible=ci>0;/, 'only the count changes');
  const syncBody = SYNC.slice(SYNC.indexOf('function sync(k,allInstances=false){'), SYNC.indexOf('const LOD_KINDS=new Set'));
  assert.ok(syncBody.length > 500, 'sync() is the thing being inspected');
  assert.equal(/new THREE\.InstancedMesh/.test(syncBody), false, 'sync never creates a mesh');
  assert.match(syncBody, /if\(lodScratch\.length<n\*3\)lodScratch=new Float32Array\(n\*3\)/, 'the one scratch buffer only grows when a kind outgrows it');
  assert.equal((syncBody.match(/new Float32Array/g) || []).length, 1, 'and that is the only allocation in a refresh');
});

test('instances the core classifies as past the far plane never reach the GPU', () => {
  assert.match(SYNC, /if\(lodTiers&&lodTiers\[sourceIndex\]<0\)return;/, 'the cull tier is honoured');
  assert.match(SYNC, /useLow=lodTiers\[sourceIndex\]===1/, 'and the low tier still picks the decimated mesh');
  assert.match(TERRAIN, /core\.lodClassify=function\(state\)/, 'the classification is a core call');
});
