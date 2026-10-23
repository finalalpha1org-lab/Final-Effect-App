import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';

const engineSource=fs.readFileSync('fe-cpp-engine.js','utf8');
const start=engineSource.indexOf('FECppEngine.runLiveSelfTest =');
const end=engineSource.indexOf('\n  async function openCppDiagnosticsModal',start);
const wasm=fs.readFileSync('wasm/fe_core_engine.wasm');

/* Runs the shipped self-test slice against the shipped wasm. `landscape` is an
   optional FELandscapeCore stub, matching the page where the bridge is present. */
async function runSelfTest(landscape){
  const {instance}=await WebAssembly.instantiate(wasm,{});
  const e=instance.exports;e.__wasm_call_ctors?.();
  const engine={ready:true,exports:e,memory:e.memory,init:async()=>{},serializeAnimation:()=>null,
    allocF32(n){const ptr=e.fe_malloc(n*4);return{ptr,view:new Float32Array(e.memory.buffer,ptr,n)}},
    allocU32(n){const ptr=e.fe_malloc(n*4);return{ptr,view:new Uint32Array(e.memory.buffer,ptr,n)}}};
  const ctx={FECppEngine:engine,performance,Uint8ClampedArray,Math};
  if(landscape!==undefined)ctx.window={FELandscapeCore:landscape};
  vm.runInNewContext(engineSource.slice(start,end),ctx);
  return engine.runLiveSelfTest();
}

test('actual on-device self-test passes against current WASM artifact',async()=>{
  const report=await runSelfTest();
  assert.equal(report.ok,true,JSON.stringify(report.results));
  assert.equal(report.results.length,7);
  const landscape=report.results.find(r=>r.name==='Landscape & Ocean Kernels');
  assert.ok(landscape,'the landscape/ocean check must run');
  assert.ok(landscape.ok,'the ocean kernel must run inside the engine');
  assert.match(landscape.detail,/Wave field 32²/);
});

test('a fully bound landscape bridge keeps every check green',async()=>{
  const report=await runSelfTest({ready:true,missing:[]});
  assert.equal(report.ok,true,JSON.stringify(report.results));
  const landscape=report.results.find(r=>r.name==='Landscape & Ocean Kernels');
  assert.match(landscape.detail,/Every terrain, Open World and ocean kernel bound/);
});

test('a stale artifact names the kernels that fell back to JS instead of failing silently',async()=>{
  const report=await runSelfTest({ready:true,missing:['fe_terrain_scatter_natural']});
  assert.equal(report.ok,false,'a degraded subsystem must be reported as a failure');
  const landscape=report.results.find(r=>r.name==='Landscape & Ocean Kernels');
  assert.equal(landscape.ok,false);
  assert.match(landscape.detail,/1 kernel on JS fallback: fe_terrain_scatter_natural/);
  const two=await runSelfTest({ready:true,missing:['fe_ocean_update','fe_lod_classify']});
  assert.match(two.results.find(r=>r.name==='Landscape & Ocean Kernels').detail,/2 kernels on JS fallback: fe_ocean_update, fe_lod_classify/);
});
