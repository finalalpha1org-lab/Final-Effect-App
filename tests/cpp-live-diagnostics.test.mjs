import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
test('actual on-device self-test passes against current WASM artifact', async()=>{
const s=fs.readFileSync('fe-cpp-engine.js','utf8');const a=s.indexOf('FECppEngine.runLiveSelfTest =');const b=s.indexOf('\n  async function openCppDiagnosticsModal',a);
const {instance}=await WebAssembly.instantiate(fs.readFileSync('wasm/fe_core_engine.wasm'),{});const e=instance.exports;e.__wasm_call_ctors?.();
const engine={ready:true,exports:e,memory:e.memory,init:async()=>{},serializeAnimation:()=>null,allocF32(n){let ptr=e.fe_malloc(n*4);return{ptr,view:new Float32Array(e.memory.buffer,ptr,n)}},allocU32(n){let ptr=e.fe_malloc(n*4);return{ptr,view:new Uint32Array(e.memory.buffer,ptr,n)}}};vm.runInNewContext(s.slice(a,b),{FECppEngine:engine,performance,Uint8ClampedArray,Math});const report=await engine.runLiveSelfTest();assert.equal(report.ok,true,JSON.stringify(report.results));assert.equal(report.results.length,7);assert.ok(report.results.some(r=>r.name==='Landscape & Ocean Kernels'));
});
