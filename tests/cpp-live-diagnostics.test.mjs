import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';

const engineSource=fs.readFileSync('fe-cpp-engine.js','utf8');
const start=engineSource.indexOf('FECppEngine.runLiveSelfTest =');
const end=engineSource.indexOf('\n  async function openCppDiagnosticsModal',start);
/* The artifact helpers are shipped code, not test fixtures: slice them in so the
   harness measures the real REQUIRED_KERNELS list and the real summary text. */
const helpersStart=engineSource.indexOf('const REQUIRED_KERNELS');
const helpersEnd=engineSource.indexOf('const FECppEngine = {',helpersStart);
const helpers=engineSource.slice(helpersStart,helpersEnd);
const wasm=fs.readFileSync('wasm/fe_core_engine.wasm');

/* Runs the shipped self-test slice against the shipped wasm. `landscape` is an
   optional FELandscapeCore stub, matching the page where the bridge is present. */
async function runSelfTest(landscape,{stale=[]}={}){
  const {instance}=await WebAssembly.instantiate(wasm,{});
  /* WebAssembly export objects are frozen, so the harness copies them into a
     plain object before removing kernels to model an older binary. */
  const e=Object.assign({},instance.exports);e.__wasm_call_ctors?.();
  const engine={ready:true,exports:e,memory:e.memory,init:async()=>{},serializeAnimation:()=>null,
    artifact:null,artifactBytes:wasm.byteLength,
    /* A deployment that serves an older binary: the kernels are simply absent and
       a cache-busted refetch cannot help, because the server file is old too. */
    ensureFreshArtifact:async()=>engine.artifact.complete,
    allocF32(n){const ptr=e.fe_malloc(n*4);return{ptr,view:new Float32Array(e.memory.buffer,ptr,n)}},
    allocU32(n){const ptr=e.fe_malloc(n*4);return{ptr,view:new Uint32Array(e.memory.buffer,ptr,n)}}};
  const ctx={FECppEngine:engine,performance,Uint8ClampedArray,Math};
  if(landscape!==undefined)ctx.window={FELandscapeCore:landscape};
  vm.runInNewContext(helpers+'\n'+engineSource.slice(start,end),ctx);
  engine.describe=()=>ctx.describeArtifact(e,wasm.byteLength);
  engine.artifactSummary=()=>{
    const a=engine.artifact;
    if(!a)return 'Engine artifact not loaded';
    const size=a.bytes?`${(a.bytes/1024).toFixed(0)} KB · `:'';
    return `${size}${a.exports} exports${a.complete?'':` · missing ${a.missing.length} kernel${a.missing.length===1?'':'s'}`}`;
  };
  for(const name of stale) delete e[name];
  engine.artifact=engine.describe();
  return engine.runLiveSelfTest();
}

test('actual on-device self-test passes against current WASM artifact',async()=>{
  const report=await runSelfTest();
  assert.equal(report.ok,true,JSON.stringify(report.results));
  assert.equal(report.results.length,8);
  const landscape=report.results.find(r=>r.name==='Landscape & Ocean Kernels');
  assert.ok(landscape,'the landscape/ocean check must run');
  assert.ok(landscape.ok,'the ocean kernel must run inside the engine');
  assert.match(landscape.detail,/Wave field 32²/);
  const smoke=report.results.find(r=>r.name==='Smoke & Fire Volume Solver');
  assert.ok(smoke,'the volumetric solver must be exercised in the same report');
  assert.equal(smoke.ok,true,smoke.detail);
  assert.match(smoke.detail,/16³ MAC grid/);
  assert.match(smoke.detail,/surface verts/);
  assert.match(smoke.detail,/div \d+\.\d+→\d+\.\d+/);
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

test('a stale artifact names the missing kernels instead of a vague failure',async()=>{
  const report=await runSelfTest(undefined,{stale:['fe_vol_init','fe_vol_step','fe_vol_surface','fe_ocean_configure','fe_ocean_update']});
  assert.equal(report.ok,false,'a stale artifact must fail loudly');
  const ocean=report.results.find(r=>r.name==='Landscape & Ocean Kernels');
  assert.equal(ocean.ok,false);
  assert.match(ocean.detail,/artifact is stale|Engine artifact/i);
  assert.match(ocean.detail,/fe_ocean_configure/);
  const smoke=report.results.find(r=>r.name==='Smoke & Fire Volume Solver');
  assert.equal(smoke.ok,false);
  assert.match(smoke.detail,/artifact is stale|no volume kernel/i);
  assert.ok(report.artifact.missing.includes('fe_vol_init'),'the report exposes the missing kernels');
  assert.equal(report.artifact.modules.volumetrics,false);
});

test('the shipped artifact reports every subsystem as present',async()=>{
  const report=await runSelfTest();
  assert.equal(report.artifact.complete,true);
  /* Arrays built inside the vm realm have their own prototype, so compare
     serialised snapshots rather than using deepStrictEqual across realms. */
  assert.equal(JSON.stringify(report.artifact.missing),'[]');
  assert.ok(Object.values(report.artifact.modules).every(Boolean),'every REQUIRED_KERNELS module is satisfied');
  assert.match(report.artifactSummary,/exports/);
  const core=report.results.find(r=>r.name==='Core Engine (ABI v1)');
  assert.match(core.detail,/exports/,'the ABI row reports the artifact size');
});

test('the benchmark sheet draws vector icons instead of emoji',()=>{
  const ui=engineSource.slice(engineSource.indexOf('async function openCppDiagnosticsModal'),engineSource.indexOf('window.openCppDiagnosticsModal ='));
  assert.ok(ui.length>2000,'the diagnostics sheet is found in the shipped engine');
  assert.doesNotMatch(ui,/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,'no emoji or dingbat glyphs in the sheet');
  for(const name of ['flask','gear','refresh','cube3d','close']) assert.match(ui,new RegExp(`data-ico="${name}"`),`${name} icon is present`);
});
