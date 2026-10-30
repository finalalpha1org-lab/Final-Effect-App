import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const wasm=readFileSync('fe_core_engine.wasm');
const source=readFileSync('terrain-main-01.js','utf8');
async function core(){const context={console,URL,WebAssembly,Float32Array,document:{baseURI:'https://example.test/Terrain_system_.html'},fetch:async()=>({ok:true,arrayBuffer:async()=>wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength)})};vm.runInNewContext(source.split('/* END LANDSCAPE CORE BRIDGE */')[0],context);await context.FELandscapeCore.loading;assert.equal(context.FELandscapeCore.ready,true);return context.FELandscapeCore}
function reference(h,tool){const out=h.slice(),n=16,w=17;for(let j=0;j<w;j++)for(let i=0;i<w;i++){let d=Math.hypot(i-8,j-8)/4;if(d>=1)continue;let f=(1-d*d)**2,k=j*w+i,a=Math.min(1,f*.02*10*.6);if(tool==='raise')out[k]+=f*.6*.02*10;if(tool==='lower')out[k]-=f*.6*.02*10;if(tool==='flat')out[k]+=(2-out[k])*a;if(tool==='terrace')out[k]+=(Math.round(out[k]/3)*3-out[k])*a;if(tool==='smooth'){let avg=(h[j*w+Math.max(i-1,0)]+h[j*w+Math.min(i+1,n)]+h[Math.max(j-1,0)*w+i]+h[Math.min(j+1,n)*w+i])/4;out[k]+=(avg-out[k])*Math.min(1,f*.02*14*.6)}}return out}
test('live bridge executes C++ sculpt tools and matches existing brush arithmetic',async()=>{const c=await core();for(const tool of ['raise','lower','flat','smooth','terrace']){const h=Float32Array.from({length:289},(_,i)=>Math.sin(i*.6)*3),expected=reference(h,tool);assert.equal(c.brush({n:16,size:16,heights:h,x:0,z:0,radius:4,strength:.6,dt:.02,target:2,seed:12,tool}),true);for(let i=0;i<h.length;i++)assert.ok(Math.abs(h[i]-expected[i])<.00001,`${tool} ${i}`)}assert.equal(c.commands,5)});
test('restored/imported height data replaces stale native state on the next stroke',async()=>{const c=await core(),h=new Float32Array(289);const args={n:16,size:16,heights:h,x:0,z:0,radius:4,strength:.6,dt:.02,target:2,seed:12,tool:'raise'};c.brush(args);h.fill(10);c.brush(args);assert.ok(h[144]>10);assert.equal(h[0],10);h.fill(30);assert.equal(c.brush({...args,tool:'paint'}),false);assert.equal(h[144],30)});
test('C++ erosion modifies finite terrain, is deterministic and rejects invalid parameters',async()=>{const c=await core(),initial=Float32Array.from({length:289},(_,i)=>Math.sin(i*.17)*4),a=initial.slice(),b=initial.slice();const args={n:16,size:16,x:0,z:0,radius:4,strength:.6,dt:.02,seed:12,tool:'erode'};assert.ok(c.brush({...args,heights:a}));assert.ok(c.brush({...args,heights:b}));assert.deepEqual(a,b);assert.ok(a.some((v,i)=>v!==initial[i]));assert.ok(a.every(Number.isFinite));const before=a.slice();assert.equal(c.brush({...args,heights:a,radius:-1}),false);assert.deepEqual(a,before)});
test('GPU normal upload receives finite unit slope normals computed by C++',async()=>{const c=await core(),h=Float32Array.from({length:289},(_,k)=>(k%17)*.5+Math.floor(k/17)*.25),out=new Float32Array(289*3);assert.equal(c.normals({n:16,size:16,heights:h,output:out}),true);const length=Math.hypot(.5,1,.25);for(let k=0;k<289;k++){assert.ok(Math.abs(out[k*3]+.5/length)<1e-6);assert.ok(Math.abs(out[k*3+1]-1/length)<1e-6);assert.ok(Math.abs(out[k*3+2]+.25/length)<1e-6)}});
function terrainState(over={}){
 const n=32,heights=new Float32Array((n+1)*(n+1));
 return Object.assign({n,size:200,heights,seed:12.5,hs:34,continental:false,base:0,mountain:0,
  pal:new Float32Array([.28,.5,.16,.42,.29,.17,.42,.42,.44,.64,.56,.38,.92,.94,.98,.13,.13,.14]),
  paint:new Uint8Array([103,129,76,139,148,139,185,145,87,57,54,52,218,198,145,112,108,100,83,133,59,185,150,96,183,54,16,107,24,44,122,118,109,226,207,154]),
  water:0,rock:1.3,snow:16,desert:false,
  weightsA:new Float32Array((n+1)*(n+1)*4),weightsB:new Float32Array((n+1)*(n+1)*4),weightsC:new Float32Array((n+1)*(n+1)*4),
  materials:new Uint8Array((n+1)*(n+1)).fill(255)},over);
}
test('C++ generation owns the seeded heightfield and matches itself every run',async()=>{
 const c=await core(),a=terrainState(),b=terrainState(),other=terrainState({seed:77});
 assert.equal(c.generate(a),true);assert.equal(c.generate(b),true);
 assert.deepEqual(a.heights,b.heights,'same seed must reproduce the same terrain');
 assert.equal(c.generate(other),true);assert.notDeepEqual(a.heights,other.heights,'different seeds must differ');
 assert.ok(a.heights.every(Number.isFinite));
 const w=33,edge=a.heights[w*w-1];assert.ok(edge<-13&&edge>-15,'non-continental maps fade the border down to the sea');
 const centre=a.heights[Math.floor(w*w/2)];assert.notEqual(centre,edge);
 const continental=terrainState({continental:true,base:2,mountain:48});assert.equal(c.generate(continental),true);
 assert.notDeepEqual(continental.heights,a.heights);assert.ok(continental.heights.every(Number.isFinite));
 assert.equal(c.generate(terrainState({hs:-1})),false,'invalid height scale is rejected');
});
test('C++ shading blends painted PBR weights and falls back to the biome palette',async()=>{
 const c=await core(),s=terrainState(),out=new Float32Array((33)*(33)*3);
 assert.equal(c.generate(s),true);
 s.output=out;assert.equal(c.colors({...s,rect:[0,32,0,32]}),true);
 assert.ok(out.every(Number.isFinite));assert.ok(out.every(v=>v>=0&&v<=1.3));
 const sand=[185,150,96],k=5*33+5;for(const w of ['weightsA','weightsB','weightsC'])s[w].fill(0);
 s.weightsB[k*4+3]=1;s.materials[k]=255; // paint slot 7 = Sand
 assert.equal(c.colors({...s,rect:[k%33,k%33,Math.floor(k/33),Math.floor(k/33)]}),true);
 for(let q=0;q<3;q++)assert.ok(Math.abs(out[k*3+q]-sand[q]/255)<.06,`painted channel ${q}`); // the shade kernel keeps its ±6% colour variation
 s.weightsB.fill(0);s.materials[k]=2; // palette rock
 assert.equal(c.colors({...s,rect:[k%33,k%33,Math.floor(k/33),Math.floor(k/33)]}),true);
 assert.ok(Math.abs(out[k*3]-.42)<.04&&Math.abs(out[k*3+1]-.42)<.04&&Math.abs(out[k*3+2]-.44)<.04);
 assert.equal(c.colors({...s,rect:[9,3,0,1]}),false,'reversed colour rect is rejected');
});
test('default studio generation and shading route through the C++ kernel with a JS fallback',async()=>{
 const fs=await import('node:fs');const src=fs.readFileSync('terrain-main-01.js','utf8');
 assert.ok(src.includes('const native=window.FELandscapeCore.generate({n:N,size:S,heights:H,seed,hs,continental:!!GENC,base:PLC.base,mountain:PLC.mtn});if(!native)for('));
 assert.ok(src.includes('window.FELandscapeCore.colors({n:N,size:S,heights:H,weightsA:SWA,weightsB:SWB,weightsC:SWC,materials:MI,pal:PAL,paint:OW_PAINT_RGB'));
 /* The fallback now also covers a kernel that reports success but writes
    nothing: the zeroed colour buffer used to be uploaded as black ground. */
 assert.ok(src.includes('if(!native||!coloursLookReal(rx0,rx1,rz0,rz1))for(let j=rz0;j<=rz1;j++)for(let i=rx0;i<=rx1;i++)col(i,j)'),'JS colour fallback remains for WASM failure, and for an empty kernel reply');
 assert.ok(src.includes('function coloursLookReal('),'the kernel reply is sampled before it is trusted');
 assert.ok(src.includes('const OW_PAINT_RGB=new Uint8Array(OW_SURFACE_DEFS.flatMap(d=>d.rgb))'));
});
test('C++ whole-map thermal erosion conserves material and rejects invalid angles',async()=>{
 const c=await core(),n=48,st=terrainState({n,heights:new Float32Array((n+1)*(n+1)),weightsA:new Float32Array((n+1)*(n+1)*4),weightsB:new Float32Array((n+1)*(n+1)*4),weightsC:new Float32Array((n+1)*(n+1)*4),materials:new Uint8Array((n+1)*(n+1)).fill(255)});
 st.size=200;c.generate(st);
 const before=st.heights.reduce((a,b)=>a+b,0),copy=Float32Array.from(st.heights);
 assert.equal(c.erode({...st,mode:'thermal',iterations:30,talus:Math.tan(.55),slump:.5}),true);
 assert.ok(st.heights.some((v,i)=>v!==copy[i]),'thermal slumping must move material');
 assert.ok(st.heights.every(Number.isFinite));
 const after=st.heights.reduce((a,b)=>a+b,0);
 assert.ok(Math.abs(after-before)<Math.max(1e-3,Math.abs(before)*1e-6),'talus transfer must conserve mass');
 const first=Float32Array.from(st.heights),again=Float32Array.from(first);st.heights.set(copy);
 assert.equal(c.erode({...st,mode:'thermal',iterations:30,talus:Math.tan(.55),slump:.5}),true);
 assert.deepEqual(st.heights,again,'thermal erosion must be deterministic');
 assert.equal(c.erode({...st,mode:'thermal',iterations:30,talus:0,slump:.5}),false);
 assert.equal(c.erode({...st,mode:'thermal',iterations:0,talus:1,slump:.5}),false);
});
test('C++ whole-map hydraulic droplets are seeded, bounded and finite',async()=>{
 const c=await core(),st=terrainState({n:40,size:200});
 st.heights=new Float32Array(41*41);c.generate(st);
 const a=Float32Array.from(st.heights),b=Float32Array.from(st.heights);
 assert.equal(c.erode({...st,mode:'hydraulic',droplets:1500,seed:7}),true);const first=Float32Array.from(st.heights);
 st.heights.set(b);assert.equal(c.erode({...st,mode:'hydraulic',droplets:1500,seed:7}),true);
 assert.deepEqual(st.heights,first,'same seed must reproduce the same erosion');
 assert.ok(st.heights.some((v,i)=>v!==a[i]));assert.ok(st.heights.every(Number.isFinite));
 const drift=st.heights.reduce((sum,v,i)=>sum+Math.abs(v-a[i]),0)/Math.max(1,a.reduce((s,v)=>s+Math.abs(v),0));
 assert.ok(drift<.2,'droplet erosion must stay bounded instead of flattening or exploding the map');
});
test('studio exposes whole-map erosion controls wired to the C++ bridge',async()=>{
 const fs=await import('node:fs');const src=fs.readFileSync('terrain-main-07.js','utf8'),bridge=fs.readFileSync('terrain-main-01.js','utf8');
 assert.ok(src.includes("['hydro','💧 Hydraulic erosion']")&&src.includes("['thermal','⛰ Thermal erosion']"));
 /* Hydraulic erosion is a live run now, so the panel no longer hands the chip
    mode to the blocking kernel: it starts the slice-by-slice run instead. */
 assert.ok(src.includes("if(mode==='hydro'){")&&src.includes('startLiveErosion()'),'the hydraulic chip starts the live run');
 assert.ok(src.includes("core.erode({mode:'thermal'"),'thermal erosion keeps the single blocking pass');
 assert.ok(bridge.includes('core.erode=function(state)')&&bridge.includes('fe_terrain_erode_hydraulic')&&bridge.includes('fe_terrain_erode_thermal'));
});
test('C++ strata terracing pulls heights toward tilted bands without breaking the grid',async()=>{
 const c=await core(),n=64,st=terrainState({n,size:200});
 st.heights=new Float32Array((n+1)*(n+1));c.generate(st);
 const before=Float32Array.from(st.heights);
 assert.equal(c.strata({...st,height:9,strength:.55,tiltX:.03,tiltZ:.012,warp:7}),true);
 assert.ok(st.heights.every(Number.isFinite),'terraced heights must stay finite');
 assert.ok(st.heights.some((v,i)=>v!==before[i]),'strata must reshape the surface');
 const drift=st.heights.reduce((s,v,i)=>s+Math.abs(v-before[i]),0)/Math.max(1,before.reduce((s,v)=>s+Math.abs(v),0));
 assert.ok(drift<.6,'strata must only partially pull heights toward band floors');
 st.heights.set(before);assert.equal(c.strata({...st,height:9,strength:.55,tiltX:.03,tiltZ:.012,warp:7}),true);
 const again=Float32Array.from(st.heights);st.heights.set(before);
 assert.equal(c.strata({...st,height:9,strength:.55,tiltX:.03,tiltZ:.012,warp:7}),true);
 assert.deepEqual(st.heights,again,'strata terracing must be deterministic');
 assert.equal(c.strata({...st,height:0,strength:.5,tiltX:0,tiltZ:0,warp:0}),false);
 assert.equal(c.strata({...st,height:9,strength:2,tiltX:0,tiltZ:0,warp:0}),false);
});
test('C++ scatter batch is seeded, in-span and matches sampled heights',async()=>{
 const c=await core(),n=48,st=terrainState({n,size:200});
 st.heights=new Float32Array((n+1)*(n+1));c.generate(st);
 const out=new Float32Array(4096*4);
 assert.equal(c.scatterBegin(st),true);
 assert.equal(c.scatterBatch({...st,count:1000,spread:180,seed:31,output:out}),1000);
 const copy=Float32Array.from(out);
 assert.equal(c.scatterBatch({...st,count:1000,spread:180,seed:31,output:out}),1000);
 assert.deepEqual(out,copy,'same seed must reproduce the same candidates');
 const w=n+1;const jsHeight=(x,z)=>{const u=Math.min(Math.max((x/200+.5)*n,0),n-.001),v=Math.min(Math.max((z/200+.5)*n,0),n-.001),i=u|0,j=v|0,a=u-i,b=v-j,k=j*w+i,H=st.heights;return H[k]*(1-a)*(1-b)+H[k+1]*a*(1-b)+H[k+w]*(1-a)*b+H[k+w+1]*a*b};
 for(let i=0;i<1000;i++){const x=out[i*4],z=out[i*4+1],y=out[i*4+2],sl=out[i*4+3];
  assert.ok(Math.abs(x)<=90.0001&&Math.abs(z)<=90.0001,'candidates stay inside the spread');
  assert.ok(Math.abs(y-jsHeight(x,z))<1e-2,'height must come from the bilinear heightfield sample');
  assert.ok(sl>=0&&sl<50,'slope is a non-negative central difference');}
 assert.ok(new Set(Array.from({length:200},(_,i)=>out[i*4].toFixed(2))).size>150,'candidates are spread, not stacked');
 assert.equal(c.scatterBatch({...st,count:0,spread:180,seed:1,output:out}),0);
 assert.equal(c.scatterBatch({...st,count:20000,spread:180,seed:1,output:out}),0);
});
test('auto-scatter routes candidates through the C++ batch with a JS fallback',async()=>{
 const fs=await import('node:fs');const src=fs.readFileSync('terrain-main-03.js','utf8'),bridge=fs.readFileSync('terrain-main-01.js','utf8');
 assert.ok(bridge.includes('core.scatterBegin=function(state)')&&bridge.includes('core.scatterBatch=function(state)'));
 assert.ok(src.includes('core.scatterBatch({count:batch,spread:S*.96'));
 assert.ok(src.includes('for(let i=done;i<count;i++)add(pick(),(R()-.5)*S*.96,(R()-.5)*S*.96)'),'JS fallback must stay, and resume from the first unfinished candidate');
 assert.ok(src.includes('function add(k,x,z,f=1,yaw=0,force=false,y0,sl0)'));
 assert.ok(src.includes('SCBUF[o+2],SCBUF[o+3]'),'native candidates must pass precomputed height and slope');
});
test('terrain panel exposes C++ strata terracing next to erosion',async()=>{
 const fs=await import('node:fs');const src=fs.readFileSync('terrain-main-07.js','utf8');
 assert.ok(src.includes("['strata','🪨 Strata terraces']"));
 assert.ok(src.includes("mode==='strata'?core.strata({n:N,size:S,heights:H,height:9,strength:.55"));
});
