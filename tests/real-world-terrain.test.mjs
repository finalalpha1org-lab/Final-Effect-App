import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

/* Real-world terrain pipeline: Google Elevation request shaping, response
   decoding, the C++ DEM resampler and its JS twin. No network is used here —
   fetch is injected, exactly like the browser path. */
const sandbox={console,URLSearchParams,Math,Number,String,Array,Float32Array,Error,Infinity,isFinite,parseFloat,localStorage:null};
vm.createContext(sandbox);
vm.runInContext(readFileSync('real-world-terrain.js','utf8'),sandbox);
const RWT=sandbox.RealWorldTerrain;

const wasm=readFileSync('wasm/fe_core_engine.wasm');
const {instance:{exports:e}}=await WebAssembly.instantiate(wasm,{});
const f32=(ptr,n)=>new Float32Array(e.memory.buffer,ptr,n);

test('elevation requests stay inside the 512-sample limit and walk north to south',()=>{
  const plan=RWT.elevationUrls({lat:6.0535,lon:80.221,spanM:4000,samples:33,key:'KEY'});
  assert.equal(plan.height,33);
  assert.equal(plan.samples,33);
  assert.equal(plan.urls.length,33);
  const lat=row=>Number(new URL(row).searchParams.get('path').split('|')[0].split(',')[0]);
  assert.ok(lat(plan.urls[0])>lat(plan.urls[32]),'row 0 is the northern edge');
  for(const url of plan.urls){
    const u=new URL(url);
    assert.ok(u.href.startsWith('https://maps.googleapis.com/maps/api/elevation/json'));
    assert.equal(u.searchParams.get('samples'),'33');
    assert.equal(u.searchParams.get('key'),'KEY');
    assert.equal(u.searchParams.get('solution_id'),RWT.SOLUTION_ID);
    assert.ok(Number(u.searchParams.get('samples'))<=RWT.MAX_SAMPLES);
    assert.equal(u.searchParams.get('path').split('|').length,2,'each row is a straight west→east path');
  }
  assert.throws(()=>RWT.elevationUrls({lat:95,lon:0,spanM:1000,samples:33}),/Latitude/);
  assert.throws(()=>RWT.elevationUrls({lat:6,lon:0,spanM:10,samples:33}),/Span/);
});

test('responses are decoded row-major with the north edge first',()=>{
  const json={status:'OK',results:[{elevation:10},{elevation:11}]};
  assert.deepEqual([...RWT.parseElevationResponse(json,2)],[10,11]);
  assert.throws(()=>RWT.parseElevationResponse({status:'REQUEST_DENIED',error_message:'bad key'},2),/REQUEST_DENIED · bad key/);
  assert.throws(()=>RWT.parseElevationResponse({status:'OK',results:[{elevation:1}]},2),/expected 2/);
});

test('fetchDem stitches rows and reports progress without hitting the network',async()=>{
  const rows=[[100,110,120],[130,140,150],[160,170,180]];
  let calls=0;
  const fetchImpl=async()=>({ok:true,status:200,json:async()=>({status:'OK',results:rows[calls++].map(elevation=>({elevation}))})});
  const progress=[];
  const r=await RWT.fetchDem({key:'K',lat:6,lon:80,spanM:1000,samples:3,fetchImpl,concurrency:2,onProgress:(d,t)=>progress.push(`${d}/${t}`)});
  assert.equal(r.width,3);assert.equal(r.height,3);assert.equal(r.spanM,1000);
  assert.deepEqual([...r.dem],[100,110,120,130,140,150,160,170,180]);
  assert.equal(r.min,100);assert.equal(r.max,180);
  assert.deepEqual(progress,['1/3','2/3','3/3']);
  await assert.rejects(()=>RWT.fetchDem({lat:6,lon:80,spanM:1000,samples:3}),/API key/);
});

test('the C++ DEM resampler matches its JS twin at metric scale',()=>{
  const dem=new Float32Array([0,80,160,240,  40,120,200,280,  60,140,220,300,  20,100,180,260,  0,60,120,180]);
  const demW=4,demH=5;
  assert.equal(e.fe_terrain_init(16,100),0);
  const ptr=e.fe_malloc(dem.length*4);
  f32(ptr,dem.length).set(dem);
  assert.equal(e.fe_terrain_apply_dem(ptr,demW,demH,2000,0,1,0),0);
  const cpp=Float32Array.from(f32(e.fe_terrain_get_height_ptr(),289));
  const js=RWT.resampleToTerrain({dem,demW,demH,n:16,size:100,spanM:2000,referenceM:0,exaggeration:1});
  let maxAbs=0;
  for(let i=0;i<js.length;i++)maxAbs=Math.max(maxAbs,Math.abs(cpp[i]-js[i]));
  assert.ok(maxAbs<1e-3,`C++/JS resample deviates by ${maxAbs}`);
  assert.ok(Math.abs(cpp[0]-0)<1e-3,'the north-west corner is the first DEM sample');
  assert.ok(Math.abs(cpp[288]-(180/2000*100))<1e-3,'the south-east corner uses the last sample');
  /* exaggeration and offset are applied in world units */
  assert.equal(e.fe_terrain_apply_dem(ptr,demW,demH,2000,0,2,5),0);
  const doubled=Float32Array.from(f32(e.fe_terrain_get_height_ptr(),289));
  assert.ok(Math.abs(doubled[288]-(180/2000*100*2+5))<1e-3);
  assert.equal(e.fe_terrain_apply_dem(ptr,demW,demH,2000,90,1,0),0);
  const referenced=Float32Array.from(f32(e.fe_terrain_get_height_ptr(),289));
  assert.ok(Math.abs(referenced[288]-((180-90)/2000*100))<1e-3,'reference elevation shifts the datum');
});

test('the DEM kernel rejects malformed grids and unusable scales',()=>{
  const ptr=e.fe_malloc(64);
  f32(ptr,16).set([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
  assert.equal(e.fe_terrain_init(16,100),0);
  assert.equal(e.fe_terrain_apply_dem(0,4,4,1000,0,1,0),-1);
  assert.equal(e.fe_terrain_apply_dem(ptr,1,4,1000,0,1,0),-1,'a 1-pixel DEM is rejected');
  assert.equal(e.fe_terrain_apply_dem(ptr,4,4,0,0,1,0),-1);
  assert.equal(e.fe_terrain_apply_dem(ptr,4,4,1000,0,50,0),-1,'exaggeration is capped');
  assert.equal(e.fe_terrain_apply_dem(ptr,4,4,1000,0,1,9999),-1);
});

test('the import panel is wired to the module and never ships an API key',()=>{
  const html=readFileSync('Terrain_system_.html','utf8');
  assert.ok(html.includes('<script src="./real-world-terrain.js"></script>'));
  const panel=readFileSync('terrain-main-07.js','utf8');
  assert.ok(panel.includes('Fetch real terrain (Google Elevation)'));
  assert.ok(panel.includes('fe_gmaps_key'),'the key is stored locally, not in the bundle');
  assert.ok(panel.includes('RealWorldTerrain.fetchDem'));
  assert.ok(panel.includes('applyRealWorldDem'));
  const bridge=readFileSync('terrain-main-01.js','utf8');
  assert.ok(bridge.includes('fe_terrain_apply_dem')&&bridge.includes('core.applyDem'));
  for(const file of ['index.html','Terrain_system_.html','real-world-terrain.js','terrain-main-07.js','terrain-main-04.js'])
    assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(readFileSync(file,'utf8')),`${file} must not contain an API key`);
});
