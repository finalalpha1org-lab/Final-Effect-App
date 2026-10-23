import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

/* The landscape bridge must boot from the embedded base64 WASM (single-file and
   file:// builds never reach a server) and must survive a stale artifact that
   predates the newer Open World / ocean kernels instead of dying wholesale. */
const wasm=readFileSync('fe_core_engine.wasm');
const source=readFileSync('terrain-main-01.js','utf8').split('/* END LANDSCAPE CORE BRIDGE */')[0];
const base64=wasm.toString('base64');

function boot(extra={}){
  const context={console,URL,WebAssembly,Float32Array,Uint8Array,Uint32Array,Int32Array,
    document:{baseURI:'file:///storage/emulated/0/Download/Terrain_system_.html'},
    fetch:()=>{throw Error('fetch is blocked on file://')},
    atob:s=>Buffer.from(s,'base64').toString('binary'),
    __FE_CPP_WASM_BASE64__:base64,...extra};
  vm.createContext(context);
  vm.runInContext(source,context);
  return context.FELandscapeCore;
}

test('bridge boots from the embedded WASM when no server is reachable',async()=>{
  const core=boot();
  await core.loading;
  assert.equal(core.ready,true);
  assert.equal(core.error,null);
  assert.equal(core.backend,'C++ WASM');
  assert.equal(core.missing.length,0,'the current artifact ships every optional kernel');
  assert.equal(core.has('fe_terrain_brush_stroke'),true);
  assert.equal(core.has('fe_ocean_configure'),true);
  assert.ok(core.bytes()&&core.bytes().length===wasm.length,'the embedded bytes are kept for reuse');
});

test('ocean bridge drives the C++ cascades and matches the JS reference',async()=>{
  const core=boot();
  await core.loading;
  const ctx={};vm.createContext(ctx);
  vm.runInContext(readFileSync('tessendorf-ocean.js','utf8'),ctx);
  const {TessendorfOcean}=ctx.TessendorfOceanBundle;
  const lengths=[256,1024,4096];
  assert.equal(core.oceanConfigure(64,lengths,14,0,7),true);
  assert.equal(core.oceanResolution,64);
  assert.equal(core.oceanUpdate(3.2,1,1,3,2),true);
  const ocean=new TessendorfOcean();
  ocean.configure({resolution:64,lengths,windSpeed:14,windDirection:0,seed:7});
  const fields=ocean.update(3.2,{amplitude:1,choppiness:1});
  for(let c=0;c<3;c++){
    const cpp=core.oceanCascade(c),ref=fields[c].data;
    assert.equal(cpp.length,64*64*4);
    let maxAbs=0;
    for(let i=0;i<ref.length;i++)maxAbs=Math.max(maxAbs,Math.abs(cpp[i]-ref[i]));
    assert.ok(maxAbs<2e-5,`cascade ${c} deviates by ${maxAbs}`);
    const rgba=core.oceanCascadeRgba(c);
    assert.equal(rgba.length,64*64*4);
    for(let i=3;i<rgba.length;i+=4)assert.equal(rgba[i],255);
  }
  assert.equal(core.oceanConfigure(100,lengths,14,0,7),false,'power-of-two resolution');
  assert.equal(core.oceanConfigure(64,[0,1024,4096],14,0,7),false,'cascade lengths must be positive');
  assert.equal(core.oceanCascade(3),null);
  assert.equal(core.oceanCascadeRgba(3),null);
});

test('a stale artifact keeps the terrain kernels and falls back per subsystem',async()=>{
  const required=['fe_terrain_compute_normals','fe_terrain_brush_stroke','fe_terrain_erode_brush','fe_terrain_generate_layered','fe_terrain_compute_colors','fe_terrain_set_palette','fe_terrain_set_paint_colors','fe_terrain_erode_hydraulic','fe_terrain_erode_thermal'];
  const stub={__wasm_call_ctors(){},fe_malloc:()=>16};
  for(const name of required)stub[name]=()=>0;
  const fake={Module:class{constructor(){}},Instance:class{constructor(){this.exports=stub}}};
  const core=boot({WebAssembly:fake});
  await core.loading;
  assert.equal(core.ready,true,'the terrain kernels still bind');
  assert.ok(core.missing.includes('fe_ocean_configure'));
  assert.ok(core.missing.includes('fe_ow_height_grid'));
  assert.equal(core.has('fe_terrain_brush_stroke'),true);
  assert.equal(core.has('fe_ocean_update'),false);
  assert.equal(core.oceanConfigure(64,[256,1024,4096],14,0,7),false,'the shader falls back to the JS bundle');
  assert.equal(core.oceanUpdate(1,1,1,3,2),false);
  assert.equal(core.oceanCascade(0),null);
});
