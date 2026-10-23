import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

/* Numerical parity harness: the C++ core owns the Tessendorf ocean maths, and
   this suite pins it against the minified JS reference bundle that still ships
   as the fallback (tessendorf-ocean.js). Both must agree, cascade by cascade. */
const wasm=readFileSync('wasm/fe_core_engine.wasm');
const {instance:{exports:e}}=await WebAssembly.instantiate(wasm,{});
const f32=(ptr,n)=>new Float32Array(e.memory.buffer,ptr,n);
const ctx={};vm.createContext(ctx);
vm.runInContext(readFileSync('tessendorf-ocean.js','utf8'),ctx);
const {TessendorfOcean,ifft2D}=ctx.TessendorfOceanBundle;

const LENGTHS=[256,1024,4096];
const MAX_HEIGHT=3,MAX_DISPLACE=2;
function configure(res=128,lengths=LENGTHS,wind=14,dir=0,seed=7){
  return e.fe_ocean_configure(res,lengths[0],lengths[1],lengths[2],wind,dir,seed);
}
function jsFields(res,lengths,wind,dir,seed,time,amplitude=1,choppiness=1){
  const o=new TessendorfOcean();
  o.configure({resolution:res,lengths,windSpeed:wind,windDirection:dir,seed});
  return o.update(time,{amplitude,choppiness});
}
function cascade(i){return f32(e.fe_ocean_get_cascade_float4_ptr(i),e.fe_ocean_resolution()**2*4);}

test('ocean solver exports and rejects invalid configurations',()=>{
  for(const name of ['fe_ocean_field_ptr','fe_ocean_resolution','fe_ocean_configure','fe_ocean_update',
    'fe_ocean_get_cascade_float4_ptr','fe_ocean_get_cascade_rgba8_ptr','fe_ocean_ifft2d_f32'])
    assert.equal(typeof e[name],'function',`missing ${name}`);
  assert.equal(configure(100),-1,'resolutions must be powers of two');
  assert.equal(configure(512),-1,'resolutions above 256 are rejected');
  assert.equal(configure(64,[0,1024,4096]),-1,'zero cascade lengths are rejected');
  assert.equal(configure(64,[256,1024,4096],-1),-1,'negative wind speed is rejected');
  assert.equal(e.fe_ocean_update(0,1,1,3,2),-1,'update before configure is rejected');
  assert.equal(configure(),0);
  assert.equal(e.fe_ocean_resolution(),128);
  assert.equal(e.fe_ocean_update(NaN,1,1,3,2),-1);
  assert.equal(e.fe_ocean_update(1,-1,1,3,2),-1);
  assert.equal(e.fe_ocean_get_cascade_float4_ptr(3),0,'only three cascades exist');
  assert.equal(e.fe_ocean_get_cascade_rgba8_ptr(3),0);
  assert.equal(e.fe_ocean_ifft2d_f32(0,0,32),-1);
});

test('C++ ocean field matches the JS Tessendorf reference cascade for cascade',()=>{
  for(const [res,lengths,wind,dir,seed,time] of [
    [64,LENGTHS,14,0,7,3.2],
    [128,[180,700,2600],9,37,19,11.7],
    [64,[90,420,1500],22,220,3,0]
  ]){
    assert.equal(configure(res,lengths,wind,dir,seed),0);
    assert.equal(e.fe_ocean_update(time,1,1,MAX_HEIGHT,MAX_DISPLACE),res*res*4);
    const fields=jsFields(res,lengths,wind,dir,seed,time);
    for(let c=0;c<3;c++){
      const cpp=cascade(c),ref=fields[c].data;
      assert.equal(ref.length,cpp.length);
      let maxAbs=0,peak=0,dot=0,na=0,nb=0;
      for(let i=0;i<ref.length;i++){
        const d=Math.abs(cpp[i]-ref[i]);
        if(d>maxAbs)maxAbs=d;
        if(Math.abs(ref[i])>peak)peak=Math.abs(ref[i]);
        dot+=cpp[i]*ref[i];na+=cpp[i]*cpp[i];nb+=ref[i]*ref[i];
      }
      assert.ok(maxAbs<2e-5,`cascade ${c} deviates by ${maxAbs} (peak ${peak})`);
      assert.ok(dot/Math.sqrt(na*nb)>0.99999,`cascade ${c} correlation broke`);
      assert.ok(peak>0.05,'the field is not flat');
      for(let i=3;i<cpp.length;i+=4)assert.equal(cpp[i],1,'alpha stays opaque');
    }
  }
});

test('ocean RGBA8 packing matches the shader encoding of the float field',()=>{
  assert.equal(configure(64),0);
  assert.equal(e.fe_ocean_update(2.5,1,1,MAX_HEIGHT,MAX_DISPLACE),64*64*4);
  const n=64,cpp=cascade(0);
  const rgba=new Uint8Array(e.memory.buffer,e.fe_ocean_get_cascade_rgba8_ptr(1),n*n*4);
  const src=cascade(1);
  const cl=(v,a,b)=>v<a?a:v>b?b:v;
  for(let i=0;i<n*n;i++){
    for(let k=0;k<3;k++){
      const want=Math.round(cl(src[i*4+k]/((k===0?2*MAX_HEIGHT:2*MAX_DISPLACE))+.5,0,1)*255);
      assert.equal(rgba[i*4+k],want,`byte ${i*4+k} differs from the JS encoder`);
    }
    assert.equal(rgba[i*4+3],255);
  }
  assert.equal(e.fe_ocean_get_cascade_rgba8_ptr(0),e.fe_ocean_get_cascade_rgba8_ptr(1),'one shared scratch buffer');
});

test('ocean inverse FFT matches the reference transform',()=>{
  const n=32,re=new Float32Array(n*n),im=new Float32Array(n*n);
  let s=99;const rnd=()=>{s=(s*1103515245+12345)>>>0;return s/4294967296};
  for(let i=0;i<n*n;i++){re[i]=rnd()*2-1;im[i]=rnd()*2-1}
  const ptr=e.fe_malloc(n*n*8);
  f32(ptr,n*n).set(re);f32(ptr+n*n*4,n*n).set(im);
  assert.equal(e.fe_ocean_ifft2d_f32(ptr,ptr+n*n*4,n),0);
  const jr=Float64Array.from(re),ji=Float64Array.from(im);
  ifft2D(jr,ji,n);
  const cr=f32(ptr,n*n),ci=f32(ptr+n*n*4,n*n);
  let maxAbs=0;
  for(let i=0;i<n*n;i++)maxAbs=Math.max(maxAbs,Math.abs(cr[i]-jr[i]),Math.abs(ci[i]-ji[i]));
  assert.ok(maxAbs<1e-6,`inverse FFT deviates by ${maxAbs}`);
});

test('ocean updates are deterministic and evolve with time',()=>{
  assert.equal(configure(64),0);
  assert.equal(e.fe_ocean_update(4.25,1,1,3,2),64*64*4);
  const first=Float32Array.from(cascade(0));
  assert.equal(e.fe_ocean_update(4.25,1,1,3,2),64*64*4);
  assert.deepEqual(cascade(0),first,'the same time must rebuild the same sea state');
  assert.equal(e.fe_ocean_update(9.5,1,1,3,2),64*64*4);
  let moved=0;
  const later=cascade(0);
  for(let i=0;i<first.length;i+=4)moved=Math.max(moved,Math.abs(later[i]-first[i]));
  assert.ok(moved>1e-3,'the surface must move forward in time');
  assert.equal(configure(64,LENGTHS,14,0,8),0);
  assert.equal(e.fe_ocean_update(4.25,1,1,3,2),64*64*4);
  let diff=0;
  for(let i=0;i<first.length;i+=4)diff=Math.max(diff,Math.abs(cascade(0)[i]-first[i]));
  assert.ok(diff>1e-3,'a different seed must build a different spectrum');
});

test('Jacobian foam marks folded crests and stays off in calm water',()=>{
  assert.equal(typeof e.fe_ocean_get_cascade_foam_ptr,'function');
  assert.equal(configure(128),0);
  assert.equal(e.fe_ocean_update(3.2,0,1,MAX_HEIGHT,MAX_DISPLACE),128*128*4);
  const flat=Float32Array.from(new Float32Array(e.memory.buffer,e.fe_ocean_get_cascade_foam_ptr(0),128*128));
  assert.ok(flat.every(v=>v===0),'zero amplitude must stay glassy');
  const coverage=()=>{
    const foam=new Float32Array(e.memory.buffer,e.fe_ocean_get_cascade_foam_ptr(0),128*128);
    let hot=0,max=0;
    for(const v of foam){assert.ok(v>=0&&v<=1,'foam stays normalised');if(v>.2)hot++;if(v>max)max=v}
    return {pct:hot/foam.length,max};
  };
  assert.equal(e.fe_ocean_update(3.2,1,1,MAX_HEIGHT,MAX_DISPLACE),128*128*4);
  const normal=coverage();
  assert.ok(normal.pct>.02&&normal.pct<.25,`whitecap coverage ${(normal.pct*100).toFixed(1)}%`);
  assert.ok(normal.max>.5,'at least one crest must break');
  assert.equal(e.fe_ocean_update(3.2,1,.25,MAX_HEIGHT,MAX_DISPLACE),128*128*4);
  assert.ok(coverage().pct<normal.pct,'a calmer sea must break less often');
  const first=Float32Array.from(new Float32Array(e.memory.buffer,e.fe_ocean_get_cascade_foam_ptr(0),128*128));
  assert.equal(e.fe_ocean_update(3.2,1,.25,MAX_HEIGHT,MAX_DISPLACE),128*128*4);
  assert.deepEqual(new Float32Array(e.memory.buffer,e.fe_ocean_get_cascade_foam_ptr(0),128*128),first,'foam is deterministic');
  assert.equal(e.fe_ocean_get_cascade_foam_ptr(3),0);
});

test('the water shader samples the C++ foam field and the bridge exposes it',()=>{
  const src=readFileSync('terrain-main-01.js','utf8');
  assert.ok(src.includes('uFFTFoam'),'the foam sampler needs a uniform');
  assert.ok(src.includes('texture2D(uFFTFoam,vec2(w.xz/uFFTLen0+.5))'),'the shader must sample the C++ foam at the cascade-0 scale');
  assert.ok(src.includes('core.oceanCascadeFoam'));
  assert.ok(src.includes("'terrain-water-pbr-v9-triplanar-fft-foam-shore-sets'"),'the program cache key must change with the shader');
  assert.ok(src.includes('clearFoamTexture()'),'the JS fallback must not keep stale foam');
});

test('shore foam widens with wave sets and stays tied to the live sliders',()=>{
  const src=readFileSync('terrain-main-01.js','utf8');
  assert.ok(src.includes('float waveSet=clamp(.55+.45*sin(t*1.05-dot(w.xz,uWindDir)*.22)'),'a travelling wave set pulses the run-up');
  assert.ok(src.includes('float shoreBandW=max(uShoreFoam,.05)*(.72+.6*runup)*(.6+.8*min(amp,2.));'),'the band widens with the slab and the swell');
  assert.ok(src.includes('float shoreBand=1.-smoothstep(0.,max(shoreBandW,.02),waterDepth);'),'the band is depth driven, not a flat plateau');
  assert.ok(src.includes('float shoreLip=1.-smoothstep(0.,max(uShoreFoam*.3,.03),waterDepth);'),'a bright lip marks the waterline');
  assert.ok(src.includes('shoreFoam=(shoreBand*mix(.34,.86,runup)+shoreLip*runup*.5)'),'the two bands combine');
  assert.ok(src.includes('*mix(.5,1.18,shoreLace)*smoothstep(0.,.02,waterDepth);'),'lace breaks the band and it fades at the very edge');
  for(const slider of ['uFoamAmt','uFoamThreshold','uShoreFoam'])
    assert.ok(src.includes("'"+slider+"'"),slider+' must stay a live uniform');
  assert.ok(src.includes('foamMask=clamp((crestFoam*mix(.55,1.25,foamNoise)+shoreFoam'),'shore foam still feeds the shared foam mask');
});
