/* Forest impostors: GPU bridge only; atlas baking is limited to one species per frame.
   Four azimuths share one 1024x256 RGBA target. No source geometry is owned here. */
(function(root){
'use strict';
root.FEForestImpostors=function(THREE){
 const cache=new Map(),queue=[],failed=new WeakSet(),MAX_ATLASES=24;
 const stats={atlases:0,pending:0,instances:0,triangles:0};
 let clock=0;
 // Heavy bulk distance/azimuth selection runs in a worker using the unified C++ WASM.
 // Rendering can proceed with mesh/JS selection while WASM starts or if workers fail.
 let worker=null,workerReady=false,inFlight=false,epoch=0,lastJob='',lastItems=[],selection=new WeakMap();
 const workerCode=function(){
  let ex;
  self.onmessage=async({data:d})=>{try{
   if(d.type==='init'){
    const result=await WebAssembly.instantiate(d.buffer,{});ex=result.instance.exports;ex.__wasm_call_ctors?.();
    if(!ex.fe_forest_classify)throw Error('Forest C++ exports unavailable');self.postMessage({type:'ready'});return;
   }
   if(d.type==='classify'&&ex){
    const output=new Int32Array(d.records.length/3);
    for(let base=0;base<output.length;base+=32768){const n=Math.min(32768,output.length-base);
     new Float32Array(ex.memory.buffer,ex.fe_forest_input_ptr(),n*3).set(d.records.subarray(base*3,(base+n)*3));
     if(ex.fe_forest_classify(n,d.x,d.z,d.near,d.far)!==n)throw Error('Invalid forest classification input');
     output.set(new Int32Array(ex.memory.buffer,ex.fe_forest_output_ptr(),n),base);
    }
    self.postMessage({type:'result',epoch:d.epoch,output},[output.buffer]);
   }
  }catch(error){self.postMessage({type:'error',message:String(error)})}};
 };
 // Single WASM source of truth: the page's embedded bytes or FELandscapeCore.
 // The add-on never performs network requests itself.
 function forestWasmBytes(){
  try{
   let bytes=root.__FE_FOREST_WASM_BYTES__;
   if(!bytes&&root.FELandscapeCore?.bytes)bytes=root.FELandscapeCore.bytes();
   if(!bytes&&typeof root.__FE_CPP_WASM_BASE64__==='string'&&root.__FE_CPP_WASM_BASE64__.length>64&&typeof root.atob==='function'){
    const binary=root.atob(root.__FE_CPP_WASM_BASE64__),fresh=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)fresh[i]=binary.charCodeAt(i);bytes=fresh;
   }
   if(!bytes)return null;
   const copy=new Uint8Array(bytes.byteLength||bytes.length);copy.set(bytes);
   root.__FE_FOREST_WASM_BYTES__=bytes;return copy;
  }catch(error){return null}
 }
 function startWorker(){
  if(worker||typeof Worker==='undefined')return;
  let url;
  try{url=URL.createObjectURL(new Blob(['('+workerCode.toString()+')()'],{type:'text/javascript'}));worker=new Worker(url);
   worker.onmessage=({data:d})=>{
    if(d.type==='ready'){workerReady=true;stats.cppWorker=true;stats.selectionUpdated=true}
    if(d.type==='error'){console.warn('Forest worker fallback:',d.message);worker.terminate();workerReady=false;inFlight=false;stats.cppWorker=false;return}
    if(d.type==='result'){inFlight=false;if(d.epoch!==epoch)return;const next=new WeakMap();for(let i=0;i<lastItems.length;i++)next.set(lastItems[i],d.output[i]);selection=next;stats.selectionUpdated=true}
   };
   worker.onerror=()=>{worker.terminate();workerReady=false;inFlight=false;stats.cppWorker=false};
   const bytes=forestWasmBytes();
   if(!bytes){worker.terminate();worker=null;workerReady=false;return}
   worker.postMessage({type:'init',buffer:bytes.buffer},[bytes.buffer]);
  }catch(error){workerReady=false}finally{if(url)URL.revokeObjectURL(url)}
 }
 function classify(items,cp,near,far){
  startWorker();if(!workerReady||inFlight)return;
  const signature=[cp.x.toFixed(1),cp.z.toFixed(1),near,far,items.length,epoch].join(':');if(signature===lastJob&&items.every((o,i)=>o===lastItems[i]))return;lastJob=signature;
  const records=new Float32Array(items.length*3);for(let i=0;i<items.length;i++){const o=items[i];records.set([o.x,o.z,o.r||0],i*3)}
  lastItems=items;inFlight=true;worker.postMessage({type:'classify',epoch,records,x:cp.x,z:cp.z,near,far},[records.buffer]);
 }

 // GPU-side distance fade updates every rendered frame, not only on streaming ticks.
 const lodUniforms={start:{value:440},end:{value:560},camera:{value:new THREE.Vector2()}};
 let residency=new WeakMap();
 function resident(item,d,center){let state=residency.get(item);if(!state){state={card:d>center-100,mesh:d<center+100};residency.set(item,state)}
 if(d>center-100)state.card=true;else if(d<center-140)state.card=false;
 if(d<center+100)state.mesh=true;else if(d>center+140)state.mesh=false;
 return state;}
 function ditherMaterial(source,card){
  if(Array.isArray(source))return source.map(m=>ditherMaterial(m,card));
  const material=source.clone(),previous=source.onBeforeCompile,oldKey=source.customProgramCacheKey.bind(source);
  material.onBeforeCompile=function(shader,renderer){
   previous.call(this,shader,renderer);
   shader.uniforms.forestCameraXZ=lodUniforms.camera;shader.uniforms.forestLodStart=lodUniforms.start;shader.uniforms.forestLodEnd=lodUniforms.end;
   shader.vertexShader='uniform vec2 forestCameraXZ;\nvarying float vForestDistance;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
    vec4 forestOrigin = vec4(0.0,0.0,0.0,1.0);
    #ifdef USE_INSTANCING
    forestOrigin = instanceMatrix * forestOrigin;
    #endif
    forestOrigin = modelMatrix * forestOrigin;
    vForestDistance = length(forestOrigin.xz-forestCameraXZ);`);
   shader.fragmentShader='uniform float forestLodStart;\nuniform float forestLodEnd;\nvarying float vForestDistance;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <alphatest_fragment>',`#include <alphatest_fragment>
    float forestFade = smoothstep(forestLodStart,forestLodEnd,vForestDistance);
    // Stable complementary screen-door coverage; no transparency sorting/depth-write changes.
    vec2 forestPixel = floor(gl_FragCoord.xy);
    float forestNoise = fract(52.9829189 * fract(dot(forestPixel,vec2(0.06711056,0.00583715))));
    ${card?'if(forestNoise >= forestFade) discard;':'if(forestNoise < forestFade) discard;'}
   `);
  };
  material.customProgramCacheKey=()=>oldKey()+':forest-dither-v1:'+Number(card);
  return material;
 }
 function disposeMaterial(material){for(const m of Array.isArray(material)?material:[material])m?.dispose()}
 function setLodDistance(distance,cp){if(cp)lodUniforms.camera.value.set(cp.x,cp.z);lodUniforms.start.value=distance-60;lodUniforms.end.value=distance+60}

 function request(key,K){
  const old=cache.get(key);if(old){old.used=++clock;return old.ready?old:null}
  if(failed.has(K)||!K?.meshes?.length)return null;
  // Bounded residency: never allocate an unbounded atlas for every procedural variant.
  if(cache.size>=MAX_ATLASES)return null;
  const entry={key,K,used:++clock,ready:false};cache.set(key,entry);queue.push(entry);stats.pending=queue.length;return null;
 }
 function bake(renderer){
  const e=queue.shift();stats.pending=queue.length;if(!e)return false;
  const scene=new THREE.Scene(),box=new THREE.Box3(),identity=new THREE.Matrix4(),white=new THREE.Color(1,1,1);
  let target;
  const previous={target:renderer.getRenderTarget(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),test:renderer.getScissorTest(),color:renderer.getClearColor(new THREE.Color()).clone(),alpha:renderer.getClearAlpha(),auto:renderer.autoClear,xr:renderer.xr.enabled,tone:renderer.toneMapping};
  try{
   for(const src of e.K.meshes){
    if(!src.geometry||!src.material||(src.userData.vn&&src.userData.vi!==0))continue;
    const g=src.geometry;if(!g.boundingBox)g.computeBoundingBox();box.union(g.boundingBox);
    const mesh=new THREE.InstancedMesh(g,src.material,1);mesh.setMatrixAt(0,identity);const pal=src.userData.pal;mesh.setColorAt(0,pal?.length?new THREE.Color(...pal[0]):white);mesh.frustumCulled=false;scene.add(mesh);
   }
   if(box.isEmpty())throw Error('Empty foliage bounds');
   const center=box.getCenter(new THREE.Vector3()),extent=box.getSize(new THREE.Vector3());
   // Square orthographic views keep the same silhouette scale at every azimuth.
   const span=Math.max(Math.hypot(extent.x,extent.z),extent.y,.1)*1.12;
   target=new THREE.WebGLRenderTarget(1024,256,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,depthBuffer:true,stencilBuffer:false});
   target.texture.generateMipmaps=false;target.texture.encoding=renderer.outputEncoding;
   scene.add(new THREE.HemisphereLight(0xffffff,0x606050,1));
   const sun=new THREE.DirectionalLight(0xffffff,.8);sun.position.set(3,8,5);scene.add(sun);
   const camera=new THREE.OrthographicCamera(-span/2,span/2,span/2,-span/2,.01,span*5);
   renderer.xr.enabled=false;renderer.toneMapping=THREE.NoToneMapping;renderer.autoClear=false;
   renderer.setRenderTarget(target);renderer.setClearColor(0x000000,0);renderer.setScissorTest(false);renderer.clear();renderer.setScissorTest(true);
   for(let view=0;view<4;view++){
    const a=view*Math.PI/2;camera.position.set(center.x+Math.sin(a)*span*2,center.y,center.z+Math.cos(a)*span*2);camera.lookAt(center);
    renderer.setViewport(view*256,0,256,256);renderer.setScissor(view*256,0,256,256);renderer.render(scene,camera);
   }
   e.target=target;e.center=center;e.span=span;e.geometries=[];
   for(let view=0;view<4;view++){
    const g=new THREE.PlaneGeometry(span,span),uv=g.attributes.uv;
    // Half-texel inset prevents adjacent atlas view bleeding.
    for(let i=0;i<uv.count;i++)uv.setX(i,(view+(uv.getX(i)*255+.5)/256)/4);
    e.geometries.push(g);
   }
   e.material=new THREE.MeshBasicMaterial({map:target.texture,alphaTest:.45,side:THREE.DoubleSide,fog:true});
   e.ready=true;stats.atlases++;return true;
  }catch(error){target?.dispose();cache.delete(e.key);failed.add(e.K);console.warn('Forest impostor kept mesh fallback:',error);return false}
  finally{
   // Dispose only temporary instance buffers; source geometry/materials remain shared.
   for(const o of scene.children)if(o.isInstancedMesh)o.dispose?.();
   renderer.setRenderTarget(previous.target);renderer.setViewport(previous.viewport);renderer.setScissor(previous.scissor);renderer.setScissorTest(previous.test);renderer.setClearColor(previous.color,previous.alpha);renderer.autoClear=previous.auto;renderer.xr.enabled=previous.xr;renderer.toneMapping=previous.tone;
  }
 }
 function clear(){residency=new WeakMap();epoch++;lastJob="";selection=new WeakMap();lastItems=[];for(const e of cache.values()){e.target?.dispose();e.material?.dispose();for(const g of e.geometries||[])g.dispose()}cache.clear();queue.length=0;stats.atlases=stats.pending=stats.instances=stats.triangles=0}
 return{request,bake,clear,stats,classify,ditherMaterial,disposeMaterial,setLodDistance,resident,view:item=>selection.get(item)};
};
})(globalThis);
/* END FOREST IMPOSTOR BRIDGE */
/* Final Effect — Open World add-on (open-world.js)
   Load after the main inline script and before the closing body tag.
   Adds: Generate Open World Map → huge procedural world (streamed terrain LOD, biomes, rivers, lakes, ponds, waterfalls, foliage),
   separate from the default terrain, with its own lighting/sky/weather/quality/foliage settings and Explore Mode support. */
(function(){'use strict';
/* ================= Part 1 — world model (pure maths, no THREE) ================= */
const OWM=(()=>{
const imul=Math.imul,sqrt=Math.sqrt,floor=Math.floor,abs=Math.abs,min=Math.min,max=Math.max,hypot=Math.hypot;
const ss=(a,b,x)=>{const t=min(1,max(0,(x-a)/(b-a)));return t*t*(3-2*t)};
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const hash=(ix,iz,s)=>{let h=(imul(ix,374761393)+imul(iz,668265263)+imul(s|0,1442695041))|0;h=imul(h^(h>>>13),1274126177);h^=h>>>16;return(h>>>0)/4294967296};
const noise=(x,z,s)=>{const ix=floor(x),iz=floor(z),fx=x-ix,fz=z-iz,u=fx*fx*(3-2*fx),v=fz*fz*(3-2*fz),a=hash(ix,iz,s),b=hash(ix+1,iz,s),c=hash(ix,iz+1,s),d=hash(ix+1,iz+1,s);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v};
const fbm=(x,z,o,s)=>{let a=.5,sum=0,nm=0;for(let i=0;i<o;i++){sum+=a*noise(x,z,s+i*7);nm+=a;const nx=(x*.8-z*.6)*2.03+13.7,nz=(x*.6+z*.8)*2.03-7.1;x=nx;z=nz;a*=.5}return sum/nm};
const ridge=(x,z,o,s)=>{let a=.5,sum=0,nm=0,w=1;for(let i=0;i<o;i++){let n=1-abs(noise(x,z,s+i*5)*2-1);n*=n;sum+=a*n*w;nm+=a;w=clamp(n*1.6,.25,1);const nx=(x*.8-z*.6)*2.1+5.3,nz=(x*.6+z*.8)*2.1-9.1;x=nx;z=nz;a*=.5}return sum/nm};
function rng(seed){let a=seed|0;return()=>{a=(a+0x6D2B79F5)|0;let t=imul(a^(a>>>15),1|a);t=(t+imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
const BK=['hills','desert','volc','jungle','taiga','tundra','alpine'];
const MK=[.85,.45,.5,.75,.9,.5,1.5],RK_=[1,.6,.8,1.2,.9,.5,.8],TFIX=[.5,.86,.62,.8,.33,.15,.3];
let P=null,S=null; // params, state
const wc=new Float64Array(7),CL=new Float64Array(3);
function configure(p){
  P=Object.assign({snowOff:0,seed:1234,size:8192,biome:'mixed',land:0,mount:1,relief:1,rough:1,sea:0,rivers:7,riverW:1,lakes:5,lakeSize:1,ponds:16,falls:3,fallH:1},p);
  P.half=P.size/2;const r=rng(P.seed*977+13);S={sd:Array.from({length:16},()=>(r()*100000)|0),vol:new Map()};
  S.lk=[];S.lkG=new Map();S.seg=null;S.rv=[];S.falls=[];S.sources=[];S.gs=null;S.gn=0;
  return P}
/* climate: CL[0]=temperature 0..1, CL[1]=moisture 0..1 */
function climate(x,z){const half=P.half,k=1/(P.size*.35),Tn=fbm(x*k+40,z*k-30,3,S.sd[9]),Mn=fbm(x*k*1.4-17,z*k*1.4+23,3,S.sd[10]);
  CL[0]=clamp(.55+(Tn-.5)*1.05-(z/half)*.30,0,1);CL[1]=clamp(Mn*1.15-.07,0,1)}
function weights(x,z,h,tl){const bm=P.biome;
  if(bm!=='mixed'){wc.fill(0);const i=BK.indexOf(bm);wc[i<0?0:i]=1;CL[0]=TFIX[i<0?0:i];CL[1]=bm==='desert'?.15:bm==='jungle'?.85:.5;return}
  climate(x,z);const T=CL[0],M=CL[1];
  const tu=ss(.34,.2,T),ta=ss(.2,.32,T)*ss(.54,.4,T),de=ss(.56,.66,T)*ss(.5,.34,M),ju=ss(.56,.66,T)*ss(.5,.62,M);
  const vm=ss(.7,.84,fbm(x/(P.size*.17)+77,z/(P.size*.17)-31,2,S.sd[11]));
  let hl=max(.06,1-tu-ta-de-ju);const sum=hl+tu+ta+de+ju,k=(1-vm)/sum;
  wc[0]=hl*k;wc[1]=de*k;wc[2]=vm;wc[3]=ju*k;wc[4]=ta*k;wc[5]=tu*k;wc[6]=0;
  if(h!==undefined){const al=ss(tl-30,tl+140,h);if(al>0){for(let i=0;i<6;i++)wc[i]*=1-al;wc[6]=al}}}
const snowLine=T=>120+880*Math.pow(clamp(T,0,1),1.2)+P.snowOff;
const treeLine=T=>200+500*clamp(T,0,1);
function volcano(x,z){let v=0;const C=2400,cx=floor(x/C),cz=floor(z/C);
  for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++){const a=cx+i,b=cz+j,h1=hash(a,b,S.sd[12]);if(h1>.62)continue;
    const px=(a+.2+.6*hash(a,b,S.sd[12]+1))*C,pz=(b+.2+.6*hash(a,b,S.sd[12]+2))*C,R=520+560*hash(a,b,S.sd[12]+3),H=190+220*hash(a,b,S.sd[12]+4),q=hypot(x-px,z-pz)/R;
    if(q<1){let t=H*Math.pow(1-q,1.6);t-=H*.3*(1-ss(.02,.17,q));v=max(v,t)}}
  return v}
/* terrain before lakes / rivers */
function baseH(x,z){const half=P.half,sd=S.sd;
  const wx=(fbm(x*.0009+3.1,z*.0009+9.7,3,sd[0])-.5)*half*.16,wz=(fbm(x*.0009-8.3,z*.0009+1.9,3,sd[1])-.5)*half*.16,X=x+wx,Z=z+wz;
  const ax=abs(x/half),az=abs(z/half),a2=ax*ax,b2=az*az,r=Math.pow(a2*a2+b2*b2,.25);
  const c=fbm(X/(P.size*.3),Z/(P.size*.3),4,sd[2]);
  const cm=(c-.5)*1.55+(.8-r*1.05)+P.land*.4;
  let e=cm>0?Math.pow(cm,.9)*140:cm*260;
  const edge=ss(.9,1.03,r);
  weights(x,z,undefined,0);let mk=0,rk=0;for(let i=0;i<7;i++){mk+=wc[i]*MK[i];rk+=wc[i]*RK_[i]}
  const T0=CL[0],wV=wc[2],wD=wc[1];
  const land=ss(-.03,.18,cm);
  const mm=fbm(X/(P.size*.2)+11,Z/(P.size*.2)-5,3,sd[3]),mmask=ss(.4,.64,mm)*ss(.02,.35,cm);
  const rd=ridge(X*.0013,Z*.0013,6,sd[4]),mt=mmask*Math.pow(rd,1.6)*520*P.mount*mk;
  const hl=(fbm(X*.0032,Z*.0032,4,sd[5])-.5)*2*55*P.relief*rk*ss(-.02,.2,cm);
  const fd=((fbm(X*.022,Z*.022,3,sd[6])-.5)*7+(noise(X*.16,Z*.16,sd[7])-.5)*.9)*P.rough*land;
  let h=e+mt+hl+fd;
  if(wD>.02){const d1=1-abs(noise(X*.006,Z*.011,sd[8])*2-1);h+=Math.pow(d1,2)*9*wD*land}
  if(wV>.02)h+=volcano(x,z)*wV*land;
  h=h*(1-edge)+(-140)*edge;
  return h+P.sea*0}
/* ---------- lakes & ponds ---------- */
const LK_CELL=256,lkKey=(cx,cz)=>(cx+512)*1024+(cz+512);
function lakeShape(lk,x,z){const k=1/(lk.R*.9);return lk.R*(1+.36*(noise(x*k+lk.s*3.1,z*k-lk.s*1.7,lk.s|0)-.5))}
function addLake(lk){const i=S.lk.length;S.lk.push(lk);const r=lk.R*1.25*1.9,x0=floor((lk.x-r)/LK_CELL),x1=floor((lk.x+r)/LK_CELL),z0=floor((lk.z-r)/LK_CELL),z1=floor((lk.z+r)/LK_CELL);
  for(let a=x0;a<=x1;a++)for(let b=z0;b<=z1;b++){const k=lkKey(a,b);let l=S.lkG.get(k);if(!l)S.lkG.set(k,l=[]);l.push(i)}return i}
function applyLakes(x,z,h){const l=S.lkG.get(lkKey(floor(x/LK_CELL),floor(z/LK_CELL)));if(!l)return h;
  for(let n=0;n<l.length;n++){const lk=S.lk[l[n]],dx=x-lk.x,dz=z-lk.z,d=sqrt(dx*dx+dz*dz);if(d>lk.R*1.6*1.9)continue;
    const Re=lakeShape(lk,x,z),q=d/Re;if(q>1.9)continue;
    let tg,w;if(q<1){const b=1-q*q;tg=lk.L-lk.depth*Math.pow(b,.75)+(noise(x*.08,z*.08,lk.s|0)-.5)*.3*b;w=1}
    else{tg=lk.L+.12+min(.38*(q-1)*lk.R,14);w=1-ss(1,1.9,q)}
    h=h*(1-w)+tg*w}
  return h}
function lakeLevel(x,z,h){const l=S.lkG.get(lkKey(floor(x/LK_CELL),floor(z/LK_CELL)));if(!l)return-1e9;
  for(let n=0;n<l.length;n++){const lk=S.lk[l[n]],dx=x-lk.x,dz=z-lk.z;if(dx*dx+dz*dz>lk.R*lk.R*2.1)continue;if(sqrt(dx*dx+dz*dz)/lakeShape(lk,x,z)<1.02&&(h===undefined||h<lk.L))return lk.L}
  return-1e9}
/* ---------- rivers ---------- */
const SG_CELL=96,sgKey=(cx,cz)=>(cx+1024)*2048+(cz+1024);
function buildSegments(){const rv=S.rv;let n=0;for(const r of rv)n+=max(0,r.x.length-1);
  const g={n,x0:new Float32Array(n),z0:new Float32Array(n),x1:new Float32Array(n),z1:new Float32Array(n),b0:new Float32Array(n),b1:new Float32Array(n),w0:new Float32Array(n),w1:new Float32Array(n),d0:new Float32Array(n),d1:new Float32Array(n),f0:new Float32Array(n),f1:new Float32Array(n),rid:new Int32Array(n),grid:new Map()};
  let k=0;for(const r of rv){for(let i=0;i<r.x.length-1;i++,k++){g.x0[k]=r.x[i];g.z0[k]=r.z[i];g.x1[k]=r.x[i+1];g.z1[k]=r.z[i+1];g.b0[k]=r.bed[i];g.b1[k]=r.bed[i+1];g.w0[k]=r.w[i];g.w1[k]=r.w[i+1];g.d0[k]=r.dW[i];g.d1[k]=r.dW[i+1];g.f0[k]=r.fall?r.fall[i]:0;g.f1[k]=r.fall?r.fall[i+1]:0;g.rid[k]=r.id;
    const R=5.3*max(r.w[i],r.w[i+1]),a=floor((min(r.x[i],r.x[i+1])-R)/SG_CELL),b=floor((max(r.x[i],r.x[i+1])+R)/SG_CELL),c=floor((min(r.z[i],r.z[i+1])-R)/SG_CELL),d=floor((max(r.z[i],r.z[i+1])+R)/SG_CELL);
    for(let p=a;p<=b;p++)for(let q=c;q<=d;q++){const key=sgKey(p,q);let l=g.grid.get(key);if(!l)g.grid.set(key,l=[]);l.push(k)}}}
  S.seg=g}
function applyRivers(x,z,h){const g=S.seg;if(!g||!g.n)return h;const l=g.grid.get(sgKey(floor(x/SG_CELL),floor(z/SG_CELL)));if(!l)return h;
  let cur=-1,bd=1e18,bi=0,bk=1;
  for(let n=0;n<=l.length;n++){const k=n<l.length?l[n]:-1,rid=k>=0?g.rid[k]:-2;
    if(rid!==cur){if(cur>=0&&bd<1e17){h=bi*(1-bk)+h*bk}cur=rid;bd=1e18}
    if(k<0)break;
    const x0=g.x0[k],z0=g.z0[k],vx=g.x1[k]-x0,vz=g.z1[k]-z0,l2=vx*vx+vz*vz+1e-9;let t=((x-x0)*vx+(z-z0)*vz)/l2;t=t<0?0:t>1?1:t;
    const dx=x-(x0+vx*t),dz=z-(z0+vz*t),d2=dx*dx+dz*dz,w=g.w0[k]+(g.w1[k]-g.w0[k])*t,w5=w*5.2;if(d2>w5*w5||d2>=bd)continue;
    const d=sqrt(d2),bed=g.b0[k]+(g.b1[k]-g.b0[k])*t,dW=g.d0[k]+(g.d1[k]-g.d0[k])*t;bd=d2;bi=bed+dW*2.1*ss(.5*w,1.25*w,d);bk=ss(1.2*w,5*w,d)}
  return h}
/* water surface level if (x,z) is in a river / lake (else -1e9) */
function riverLevel(x,z){const g=S.seg;if(!g||!g.n)return-1e9;const l=g.grid.get(sgKey(floor(x/SG_CELL),floor(z/SG_CELL)));if(!l)return-1e9;let best=-1e9;
  for(let n=0;n<l.length;n++){const k=l[n],x0=g.x0[k],z0=g.z0[k],vx=g.x1[k]-x0,vz=g.z1[k]-z0,l2=vx*vx+vz*vz+1e-9;let t=((x-x0)*vx+(z-z0)*vz)/l2;t=t<0?0:t>1?1:t;
    const dx=x-(x0+vx*t),dz=z-(z0+vz*t),w=g.w0[k]+(g.w1[k]-g.w0[k])*t;if(dx*dx+dz*dz>w*w*.7)continue;const s=g.b0[k]+(g.b1[k]-g.b0[k])*t+g.d0[k]+(g.d1[k]-g.d0[k])*t;if(s>best)best=s}
  return best}
function hasWater(x0,z0,x1,z1){const g=S.seg;if(g&&g.n){for(let a=floor(x0/SG_CELL);a<=floor(x1/SG_CELL);a++)for(let b=floor(z0/SG_CELL);b<=floor(z1/SG_CELL);b++)if(g.grid.has(sgKey(a,b)))return true}
  for(let a=floor(x0/LK_CELL);a<=floor(x1/LK_CELL);a++)for(let b=floor(z0/LK_CELL);b<=floor(z1/LK_CELL);b++)if(S.lkG.has(lkKey(a,b)))return true;return false}
function waterLevel(x,z){const a=lakeLevel(x,z),b=riverLevel(x,z);return max(a,b)}
function height(x,z){let h=baseH(x,z);h=applyLakes(x,z,h);return applyRivers(x,z,h)}
/* ---------- hydrology generation ---------- */
function gsAt(x,z){const g=S.gs,n=S.gn,cs=S.cs,u=clamp((x+P.half)/cs,0,n-1.001),v=clamp((z+P.half)/cs,0,n-1.001),i=u|0,j=v|0,a=u-i,b=v-j,k=j*n+i;return g[k]*(1-a)*(1-b)+g[k+1]*a*(1-b)+g[k+n]*(1-a)*b+g[k+n+1]*a*b}
function* generate(){ // generator: yields progress 0..1
  const n=S.gn=P.size>=16384?320:P.size>=8192?288:P.size>=4096?224:160,cs=S.cs=P.size/(n-1),sea=P.sea;S.gs=new Float32Array(n*n);
  for(let j=0;j<n;j++){for(let i=0;i<n;i++)S.gs[j*n+i]=baseH(i*cs-P.half,j*cs-P.half);if(j%6==5)yield .3*j/n}
  for(let p=0;p<2;p++){const s=S.gs.slice();for(let j=1;j<n-1;j++)for(let i=1;i<n-1;i++){let a=0;for(let q=-1;q<=1;q++)for(let w=-1;w<=1;w++)a+=s[(j+q)*n+i+w];S.gs[j*n+i]=a/9}yield .32+.02*p}
  /* Native hydrology: priority-flood drainage and downhill river tracing run in
     the C++ core; the JS solver below stays as the fallback. */
  let traces=null;
  /* One RNG for everything that follows the height grid. Defining it before the
     hydrology branch keeps the lakes/ponds pass identical on both paths: the
     native solver and the JS fallback must not change what `place` sees. */
  const rn=rng(P.seed*31+7);
  const hydroCpp=root.FELandscapeCore&&root.FELandscapeCore.ready&&typeof root.FELandscapeCore.owHydroSet==='function'?root.FELandscapeCore:null;
  if(hydroCpp){
    try{
      const grid=hydroCpp.owHydroSet({n,span:P.size,sea,heights:S.gs});
      const res=grid?hydroCpp.owHydroTrace({rivers:P.rivers,minLength:520,spacing:max(420,P.size/(P.rivers+2)*.62),seed:((P.seed*31+7)>>>0)||1}):null;
      if(res&&res.count>0){
        traces=[];
        for(let i=0;i<res.count;i++){
          const m=i*6,first=res.meta[m+2],len=res.meta[m+3],pts=new Array(len);
          for(let q=0;q<len;q++)pts[q]=[res.points[(first+q)*2],res.points[(first+q)*2+1]];
          const code=res.meta[m+4];
          traces.push({sx:res.meta[m]/100,sz:res.meta[m+1]/100,pts,end:code===2?'join':code===1?'edge':'sea',join:res.meta[m+5]>=0?res.meta[m+5]:null,id:i});
        }
      }
    }catch(error){traces=null}
  }
  if(!traces){
  /* priority-flood: every cell gets a drainage parent that leads to the sea or the world edge */
  const N2=n*n,F=Float32Array.from(S.gs),par=new Int32Array(N2).fill(-1),closed=new Uint8Array(N2),heap=new Int32Array(N2+8);let hs=0;
  const push=i=>{let c=hs++;while(c>0){const p=(c-1)>>1;if(F[heap[p]]<=F[i])break;heap[c]=heap[p];c=p}heap[c]=i};
  const pop=()=>{const top=heap[0],last=heap[--hs];let c=0;for(;;){let l=2*c+1;if(l>=hs)break;if(l+1<hs&&F[heap[l+1]]<F[heap[l]])l++;if(F[heap[l]]>=F[last])break;heap[c]=heap[l];c=l}heap[c]=last;return top};
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){const k=j*n+i;if(i==0||j==0||i==n-1||j==n-1||S.gs[k]<=sea+.5){closed[k]=1;push(k)}}
  const eps=.002*cs;let it=0;
  while(hs>0){const c=pop(),ci=c%n,cj=(c/n)|0;for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){if(!di&&!dj)continue;const ni=ci+di,nj=cj+dj;if(ni<0||nj<0||ni>=n||nj>=n)continue;const k=nj*n+ni;if(closed[k])continue;closed[k]=1;par[k]=c;if(F[k]<=F[c]+eps)F[k]=F[c]+eps;push(k)}
    if((++it&16383)==0)yield .36+.1*it/N2}
  S.F=F;yield .48;
  /* river sources: high land, well spread, long enough drainage */
  const cand=[];for(let i=0;i<1400;i++){const x=(rn()-.5)*P.size*.84,z=(rn()-.5)*P.size*.84,h=gsAt(x,z);if(h>sea+40)cand.push({x,z,h})}
  cand.sort((a,b)=>b.h-a.h);
  const used=new Int16Array(N2).fill(-1),sp=max(420,P.size/(P.rivers+2)*.62);traces=[];let id=0;
  const cellOf=(x,z)=>{const i=clamp(Math.round((x+P.half)/cs),0,n-1),j=clamp(Math.round((z+P.half)/cs),0,n-1);return j*n+i};
  for(const s of cand){if(traces.length>=P.rivers)break;if(traces.some(t=>hypot(t.sx-s.x,t.sz-s.z)<sp))continue;
    let c=cellOf(s.x,s.z);if(used[c]>=0)continue;const pts=[],cells=[];let end='sea',join=null;
    for(let g2=0;g2<4000;g2++){pts.push([(c%n)*cs-P.half,((c/n)|0)*cs-P.half]);cells.push(c);const p=par[c];
      if(S.gs[c]<=sea+.9){end='sea';break}
      if(p<0){end='edge';break}
      if(used[p]>=0){join=used[p];pts.push([(p%n)*cs-P.half,((p/n)|0)*cs-P.half]);end='join';break}
      c=p}
    let len=0;for(let i=1;i<pts.length;i++)len+=hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);if(len<520||pts.length<6)continue;
    for(const k of cells)used[k]=id;traces.push({sx:s.x,sz:s.z,pts,end,join,id:id++});yield .5+.05*traces.length/P.rivers}
  }
  yield .48;
  /* resample (smooth + Catmull–Rom) and give every river a width and a bed */
  const rv=[];
  for(const t of traces){let P0=t.pts.map(p=>[p[0],p[1]]);
    for(let pass=0;pass<4;pass++){const q=P0.map(p=>p.slice());for(let i=1;i<P0.length-1;i++){const a=P0[max(0,i-2)],b=P0[min(P0.length-1,i+2)];q[i][0]=(a[0]+P0[i-1][0]+P0[i][0]+P0[i+1][0]+b[0])/5;q[i][1]=(a[1]+P0[i-1][1]+P0[i][1]+P0[i+1][1]+b[1])/5}P0=q}
    const out=[],cr=(a,b,c,d,u)=>.5*((2*b)+(-a+c)*u+(2*a-5*b+4*c-d)*u*u+(-a+3*b-3*c+d)*u*u*u);
    for(let i=0;i<P0.length-1;i++){const a=P0[max(0,i-1)],b=P0[i],c=P0[i+1],d=P0[min(P0.length-1,i+2)],len=hypot(c[0]-b[0],c[1]-b[1]),m=max(2,Math.round(len/6));for(let k=0;k<m;k++){const u=k/m;out.push([cr(a[0],b[0],c[0],d[0],u),cr(a[1],b[1],c[1],d[1],u)])}}
    out.push(P0[P0.length-1].slice());
    const m=out.length,ph=rng(P.seed*13+t.id*101+5)()*50;let total=0;const cum=[0];for(let i=1;i<m;i++){total+=hypot(out[i][0]-out[i-1][0],out[i][1]-out[i-1][1]);cum.push(total)}
    const X=new Float32Array(m),Z=new Float32Array(m),W=new Float32Array(m),DW=new Float32Array(m),BED=new Float32Array(m),FALL=new Float32Array(m);
    for(let i=0;i<m;i++){const sn=cum[i]/total,a=out[max(0,i-1)],b=out[min(m-1,i+1)];let tx=b[0]-a[0],tz=b[1]-a[1];const tl=hypot(tx,tz)||1;tx/=tl;tz/=tl;
      const ramp=min(1,cum[i]/60)*min(1,(total-cum[i])/60),off=(noise(cum[i]*.02+ph,t.id*3.7,S.sd[13])-.5)*2*(1.5+5*sn)*P.riverW*ramp;
      X[i]=out[i][0]-tz*off;Z[i]=out[i][1]+tx*off;const wn=.85+.3*noise(cum[i]*.01+ph,5.5,S.sd[14]);W[i]=(2.6+10.5*Math.pow(sn,.75))*P.riverW*wn;DW[i]=(.85+.95*sn)*Math.sqrt(P.riverW)}
    rv.push({x:X,z:Z,w:W,dW:DW,bed:BED,fall:FALL,total,cum:Float32Array.from(cum),end:t.end,id:t.id,joinTo:t.join===null?-1:t.join})}
  S.rv=rv;yield .56;
  /* waterfalls on the steepest stretches */
  const slopeAt=(r,i)=>{const j=min(r.x.length-1,i+8),s=max(0,i-8);return(gsAt(r.x[s],r.z[s])-gsAt(r.x[j],r.z[j]))/max(1,r.cum[j]-r.cum[s])};
  const fc=[];for(const r of rv)for(let i=14;i<r.x.length-20;i+=4){if(r.cum[i]<r.total*.1||r.cum[i]>r.total*.88)continue;const sl=slopeAt(r,i);if(sl>.045)fc.push({r,i,sl})}
  fc.sort((a,b)=>b.sl-a.sl);const falls=[];for(const c of fc){if(falls.length>=P.falls)break;if(falls.every(f=>hypot(f.r.x[f.i]-c.r.x[c.i],f.r.z[f.i]-c.r.z[c.i])>170))falls.push(c)}
  for(const r of rv){const m=r.x.length,fs=falls.filter(f=>f.r===r),dropAt=new Float32Array(m);
    for(const f of fs){const H=clamp((4+f.sl*34)*P.fallH,4,24);r.fall[f.i]=1;f.H=H;for(let i=f.i;i<m;i++){const d=r.cum[i]-r.cum[f.i];dropAt[i]=max(dropAt[i],H*(d<2.5?d/2.5:Math.exp(-(d-2.5)/55)))}}
    let prev=1e9;for(let i=0;i<m;i++){const F0=gsAt(r.x[i],r.z[i]);prev=r.bed[i]=min(prev-.004,F0-2.4*r.dW[i]-dropAt[i])}
    if(r.end==='sea'){const k0=max(0,m-24);for(let i=k0;i<m;i++){const t=(i-k0)/(m-1-k0),tgt=sea-1.6*r.dW[i];r.bed[i]=min(r.bed[i],r.bed[i]*(1-t)+tgt*t)}}
  }
  /* tributaries meet the parent bed */
  for(const r of rv){if(r.joinTo<0)continue;const par2=rv.find(q=>q.id===r.joinTo);if(!par2)continue;const m=r.x.length,ex=r.x[m-1],ez=r.z[m-1];let bj=1e9,pd=1e9;
    for(let i=0;i<par2.x.length;i++){const d=hypot(par2.x[i]-ex,par2.z[i]-ez);if(d<pd){pd=d;bj=par2.bed[i]}}
    const k0=max(0,m-20);for(let i=k0;i<m;i++){const t=(i-k0)/(m-1-k0);r.bed[i]=min(r.bed[i],r.bed[i]*(1-t)+bj*t)}let prev=1e9;for(let i=0;i<m;i++){prev=r.bed[i]=min(prev-.002,r.bed[i])}}
  S.falls=falls.map(f=>({x:f.r.x[f.i],z:f.r.z[f.i],r:f.r,i:f.i,H:f.H}));
  buildSegments();yield .6;
  /* lakes + ponds, kept clear of rivers */
  const rpts=new Map(),rk=(x,z)=>floor(x/64)*4096+floor(z/64);for(const r of rv)for(let i=0;i<r.x.length;i+=3){const k=rk(r.x[i],r.z[i]);let l=rpts.get(k);if(!l)rpts.set(k,l=[]);l.push(r.x[i],r.z[i])}
  const nearRiver=(x,z,rad)=>{const m=Math.ceil(rad/64)+1,cx=floor(x/64),cz=floor(z/64);for(let a=-m;a<=m;a++)for(let b=-m;b<=m;b++){const l=rpts.get((cx+a)*4096+cz+b);if(l)for(let i=0;i<l.length;i+=2)if(hypot(l[i]-x,l[i+1]-z)<rad)return true}return false};
  const sepOK=(c,l,k)=>l.every(o=>hypot(o.x-c.x,o.z-c.z)>(o.R+c.R)*k+50);
  const place=(count,Rmin,Rmax,flat,minRing,depthF,tag)=>{if(count<=0)return;const cands=[];
    for(let i=0;i<count*60;i++){const x=(rn()-.5)*P.size*.86,z=(rn()-.5)*P.size*.86,R=Rmin+(Rmax-Rmin)*rn(),h=baseH(x,z);if(h<sea+minRing)continue;
      let mn=1e9,mx=-1e9;for(let k=0;k<12;k++){const a=k*.5236,hh=baseH(x+Math.cos(a)*R*1.3,z+Math.sin(a)*R*1.3);if(hh<mn)mn=hh;if(hh>mx)mx=hh}
      const range=mx-mn;if(range/R>flat||mn<sea+minRing)continue;if(nearRiver(x,z,R*1.9+40))continue;cands.push({x,z,R,L:mn+range*.3,score:range/R+rn()*.03,depth:depthF(R),s:(rn()*1000)|0,tag})}
    cands.sort((a,b)=>a.score-b.score);const got=[];for(const c of cands){if(got.length>=count)break;if(sepOK(c,got,1.8)&&sepOK(c,S.lk,1.5))got.push(c)}for(const c of got)addLake(c)};
  place(P.lakes,70*P.lakeSize,190*P.lakeSize,.22,4,R=>clamp(R*.07,3,16),'lake');yield .75;
  place(P.ponds,7*P.lakeSize,26*P.lakeSize,.3,3,R=>clamp(R*.13,1,3.2),'pond');yield .85;
  /* spawn: beside the longest river, else open land near the centre */
  let sp0=null;const lr=rv.slice().sort((a,b)=>b.total-a.total)[0];
  if(lr){const i=floor(lr.x.length*.4);sp0={x:lr.x[i]+lr.w[i]*2.5,z:lr.z[i]}}else{sp0={x:0,z:0};for(let r=0;r<P.half*.7;r+=25){let ok=false;for(let a=0;a<6.28;a+=.4){const x=Math.cos(a)*r,z=Math.sin(a)*r;if(height(x,z)>sea+3){sp0={x,z};ok=true;break}}if(ok)break}}
  S.spawn=sp0;yield 1}
/* biome weights at a point (public, includes altitude) */
function biomeAt(x,z,h,out){weights(x,z,undefined,0);const T=CL[0],tl=treeLine(T);if(P.biome==='mixed'){const al=ss(tl-30,tl+140,h);if(al>0){for(let i=0;i<6;i++)wc[i]*=1-al;wc[6]=al}}
  for(let i=0;i<7;i++)out[i]=wc[i];return T}
return{configure,generate,hasWater,height,baseH,waterLevel,lakeLevel,riverLevel,biomeAt,snowLine,treeLine,hash,noise,fbm,ss,clamp,rng,BK,get P(){return P},get S(){return S},climate,CL,wc,gsAt}
})();

/* ================= Part 2 — runtime: state, tiles, height cache, water ================= */
const {ss,clamp:cl2}=OWM;
const OW={active:false,busy:false,ready:false,tok:0,
 P:{seed:1234,size:8192,biome:'mixed',land:0,mount:1,relief:1,rough:1,sea:-24,rivers:7,riverW:1,lakes:5,lakeSize:1,ponds:16,falls:3,fallH:1,snowOff:0},
 Q:1,dens:{cover:1,flowers:1,shrubs:1,trees:1,rocks:1},fk:'grass',ctx:null,def:null,root:null,info:'Choose a world and press Generate.',pending:false};
window.OW_STATE=OW;
const QS=[{n:'Low',K:1.25,Rc:45,Rs:110,Rr:150,Rt:170,Rf:1200,farCellCap:16,farCoverCell:16,farShrubCell:2,farRockCell:1,lf:35},{n:'Medium',K:1.6,Rc:70,Rs:170,Rr:230,Rt:260,Rf:2200,farCellCap:11,farCoverCell:16,farShrubCell:3,farRockCell:2,lf:55},{n:'High',K:2,Rc:100,Rs:250,Rr:330,Rt:380,Rf:3200,farCellCap:8,farCoverCell:16,farShrubCell:4,farRockCell:2,lf:80},{n:'Ultra',K:2.6,Rc:140,Rs:350,Rr:450,Rt:520,Rf:4800,farCellCap:5,farCoverCell:16,farShrubCell:5,farRockCell:3,lf:120}]
const owCam=new THREE.Vector3(),_v3=new THREE.Vector3(),owViewDir=new THREE.Vector3(),owViewProjection=new THREE.Matrix4(),owViewFrustum=new THREE.Frustum(),owCullSphere=new THREE.Sphere();
function owCamUpdate(){cam.updateWorldMatrix(true,false);cam.getWorldPosition(owCam);return owCam}
function owUpdateViewFrustum(){cam.updateWorldMatrix(true,false);cam.matrixWorldInverse.copy(cam.matrixWorld).invert();owViewProjection.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);owViewFrustum.setFromProjectionMatrix(owViewProjection);cam.getWorldDirection(owViewDir);return owViewDir}
function owInstanceInView(item,kind,K,far=false){const cat=CATK(kind),scale=Math.max(.25,(item.s||1)*(K?.size||TREE_SIZE_SCALE[kind]||1)),height=cat==='t'?22*scale:cat==='s'?5*scale:cat==='r'?3.5*scale:2.4*scale,width=cat==='t'?12*scale:cat==='s'?4*scale:cat==='r'?3.5*scale:1.8*scale;owCullSphere.center.set(item.x,(item.y||0)+height*.52,item.z);owCullSphere.radius=Math.hypot(width,height*.62)+(far?5:1);return owViewFrustum.intersectsSphere(owCullSphere)}
const owWait=()=>new Promise(r=>requestAnimationFrame(()=>r()));
/* ---------- biome palette → vertex colour ---------- */
const WB=new Float64Array(7),CC=[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const BKEY=OWM.BK;
function owColor(x,z,h,g,o){const P=OW.P,T=OWM.biomeAt(x,z,h,WB);
  for(let c=0;c<5;c++){let r=0,gg=0,b=0;for(let i=0;i<7;i++){const w=WB[i];if(w<.003)continue;const p=BIO[BKEY[i]].p[c];r+=p[0]*w;gg+=p[1]*w;b+=p[2]*w}CC[c][0]=r;CC[c][1]=gg;CC[c][2]=b}
  const broad=OWM.noise(x*.004+9,z*.004-4,5),mid=OWM.noise(x*.02,z*.02+3,6),fine=OWM.noise(x*.09-5,z*.09,7),field=broad*.56+mid*.3+fine*.14;
  const ground=ss(.4,.68,field);let r=CC[0][0],gg=CC[0][1],b=CC[0][2];const k=ground*.62;r+=(CC[1][0]-r)*k;gg+=(CC[1][1]-gg)*k;b+=(CC[1][2]-b)*k;
  const rockT=ss(.5,1.15,g+(broad-.5)*.32+(mid-.5)*.16)*.9,rk=cl2(rockT+ss(.72,.92,field)*.18*(1-rockT),0,1);r+=(CC[2][0]-r)*rk;gg+=(CC[2][1]-gg)*rk;b+=(CC[2][2]-b)*rk;
  const sea=P.sea,wl=OWM.waterLevel(x,z);let sand=1-ss(sea-.3+(broad-.5)*.6,sea+2.4+(broad-.5)*1.4,h);
  if(wl>-1e8){const dd=Math.abs(h-wl);sand=Math.max(sand,(1-ss(.2,1.7,dd))*.85);if(h<wl-.2){r*=.62;gg*=.66;b*=.6}}
  sand=cl2(sand*(1-rk*.55),0,1);r+=(CC[3][0]-r)*sand;gg+=(CC[3][1]-gg)*sand;b+=(CC[3][2]-b)*sand;
  const sn=OWM.snowLine(T)+(broad-.5)*70+(mid-.5)*30,snow=ss(sn-14,sn+46,h)*(1-rk*.4);r+=(CC[4][0]-r)*snow;gg+=(CC[4][1]-gg)*snow;b+=(CC[4][2]-b)*snow;
  if(h<sea-.3){const d=ss(sea-.3,sea-18,h);r=r*(1-d*.5)+.1*d*.5;gg=gg*(1-d*.45)+.2*d*.45;b=b*(1-d*.3)+.22*d*.3}
  const v=.9+.18*broad+.08*(mid-.5)+.06*(fine-.5);o[0]=r*v;o[1]=gg*v;o[2]=b*v}
/* ---------- shared tile topology ---------- */
const TG=64,TN=TG+1,TV=TN*TN,TVT=TV+4*TN,H3=TG+3;
const OWIDX=(()=>{const a=[];for(let j=0;j<TG;j++)for(let i=0;i<TG;i++){const A=j*TN+i,B=(j+1)*TN+i,C=A+1,D=B+1;a.push(A,B,C,B,D,C)}
 const edge=(e,k)=>e==0?k:e==1?TG*TN+k:e==2?k*TN:k*TN+TG;
 for(let e=0;e<4;e++)for(let k=0;k<TG;k++){const t0=edge(e,k),t1=edge(e,k+1),s0=TV+e*TN+k,s1=s0+1;a.push(t0,s0,t1,t1,s0,s1)}
 return new THREE.BufferAttribute(new Uint16Array(a),1)})();
/* Three vec4 weight sets, exactly the three attributes the detail shader
   declares. The cached 64-segment topology used to ship only A and B, so
   `owBuildNode` wrote `surfaceWeightsC: undefined` into every tile geometry.
   Rendering survived that (three just skips the missing attribute) but
   `geometry.dispose()` walks `for (const name in geometry.attributes)` and
   called `attributes.remove(undefined)`, which throws inside three — every
   tile release broke the frame: "Open World: remove@three.min.js". One
   undefined attribute was the whole crash. */
const OWZA=new THREE.BufferAttribute(new Float32Array(TVT*4),4),OWZB=new THREE.BufferAttribute(new Float32Array(TVT*4),4),OWZC=new THREE.BufferAttribute(new Float32Array(TVT*4),4);
const OW_TOPOLOGY=new Map([[TG,{seg:TG,tn:TN,tv:TV,tvt:TVT,h3:H3,index:OWIDX,weightsA:OWZA,weightsB:OWZB,weightsC:OWZC}]]);
/* Every tile of one segment count shares these attribute objects. Disposing
   one tile must not delete the GPU buffer its siblings are still drawing from,
   so ownership is tracked here and the shared buffers are detached before the
   per-tile release. */
const OW_SHARED=new WeakSet();
function owTileSegments(n){return n.size>=512?32:64}
function owTileTopology(seg){let t=OW_TOPOLOGY.get(seg);if(t)return t;const tn=seg+1,tv=tn*tn,tvt=tv+4*tn,h3=seg+3,ix=[];for(let j=0;j<seg;j++)for(let i=0;i<seg;i++){const a=j*tn+i,b=(j+1)*tn+i,c=a+1,d=b+1;ix.push(a,b,c,b,d,c)}const edge=(e,k)=>e===0?k:e===1?seg*tn+k:e===2?k*tn:k*tn+seg;for(let e=0;e<4;e++)for(let k=0;k<seg;k++){const a=edge(e,k),b=edge(e,k+1),c=tv+e*tn+k,d=c+1;ix.push(a,c,b,b,c,d)}t={seg,tn,tv,tvt,h3,index:new THREE.BufferAttribute(new Uint16Array(ix),1),weightsA:new THREE.BufferAttribute(new Float32Array(tvt*4),4),weightsB:new THREE.BufferAttribute(new Float32Array(tvt*4),4),weightsC:new THREE.BufferAttribute(new Float32Array(tvt*4),4)};OW_SHARED.add(t.index);OW_SHARED.add(t.weightsA);OW_SHARED.add(t.weightsB);OW_SHARED.add(t.weightsC);OW_TOPOLOGY.set(seg,t);return t}
/* The cached topology is created before this helper exists, so it is registered
   once here rather than inside the factory. */
for(const t of OW_TOPOLOGY.values()){OW_SHARED.add(t.index);OW_SHARED.add(t.weightsA);OW_SHARED.add(t.weightsB);if(t.weightsC)OW_SHARED.add(t.weightsC)}
let owTerrainMat=null;
function owMakeTerrainMat(){const m=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.84,metalness:0,normalMap:tm.normalMap,normalScale:new THREE.Vector2(.08,.08),side:THREE.DoubleSide});m.color.setScalar(.9);m.envMapIntensity=.5;
 injectDetail(m,false);const f=m.onBeforeCompile;m.onBeforeCompile=function(s,r){f.call(this,s,r);s.fragmentShader=s.fragmentShader.replace('uLit*(grm','0.*(grm')};m.customProgramCacheKey=()=>'ow-terrain-v1';return m}
/* ---------- height cache (blocks of 64 m @ 2 m) ---------- */
const blocks=new Map(),BNK=33;
function owBlock(bx,bz){const key=(bx+4096)*8192+(bz+4096);let b=blocks.get(key);if(b)return b;b=new Float32Array(BNK*BNK);const x0=bx*64,z0=bz*64;for(let j=0;j<BNK;j++)for(let i=0;i<BNK;i++)b[j*BNK+i]=OWM.height(x0+i*2,z0+j*2);blocks.set(key,b);
 if(blocks.size>800){let n=0;for(const k of blocks.keys()){blocks.delete(k);if(++n>100)break}}return b}
function owHgt(x,z){const u=x*.5,v=z*.5,ix=Math.floor(u),iz=Math.floor(v),fx=u-ix,fz=v-iz,b=owBlock(ix>>5,iz>>5),lx=ix&31,lz=iz&31,k=lz*BNK+lx;
 return b[k]*(1-fx)*(1-fz)+b[k+1]*fx*(1-fz)+b[k+BNK]*(1-fx)*fz+b[k+BNK+1]*fx*fz}
let OWSL=0;
function owHS(x,z){const u=x*.5,v=z*.5,ix=Math.floor(u),iz=Math.floor(v),fx=u-ix,fz=v-iz,b=owBlock(ix>>5,iz>>5),lx=ix&31,lz=iz&31,k=lz*BNK+lx,h00=b[k],h10=b[k+1],h01=b[k+BNK],h11=b[k+BNK+1],gx=((h10-h00)*(1-fz)+(h11-h01)*fz)*.5,gz=((h01-h00)*(1-fx)+(h11-h10)*fx)*.5;OWSL=Math.sqrt(gx*gx+gz*gz);return h00*(1-fx)*(1-fz)+h10*fx*(1-fz)+h01*(1-fx)*fz+h11*fx*fz}
/* ---------- terrain tiles (quad-tree, ready-before-swap, skirts) ---------- */
const TMP3=[0,0,0];let owFrameNo=0;const ownodes=[],wantQ=[],drawn=[];let prevDrawn=[],roots=[],owQ=QS[1];
function owMkNode(l,x0,z0,size,parent){const n={l,x0,z0,size,cx:x0+size/2,cz:z0+size/2,cy:parent?parent.cy:60,built:false,split:false,ch:null,mesh:null,lastDraw:owFrameNo,par:parent};ownodes.push(n);return n}
function owBuildNode(n){const top=owTileTopology(owTileSegments(n)),seg=top.seg,tn=top.tn,tv=top.tv,tvt=top.tvt,h3=top.h3,sp=n.size/seg,hg=new Float32Array(h3*h3);
 for(let j=0;j<h3;j++)for(let i=0;i<h3;i++)hg[j*h3+i]=OWM.height(n.x0+(i-1)*sp,n.z0+(j-1)*sp);
 const pos=new Float32Array(tvt*3),nor=new Float32Array(tvt*3),col=new Float32Array(tvt*3),uv=new Float32Array(tvt*2),skd=Math.max(3,sp*1.8+2);let mn=1e9,mx=-1e9;
 for(let j=0;j<tn;j++)for(let i=0;i<tn;i++){const k=j*tn+i,x=n.x0+i*sp,z=n.z0+j*sp,c=(j+1)*h3+i+1,h=hg[c],dx=(hg[c+1]-hg[c-1])/(2*sp),dz=(hg[c+h3]-hg[c-h3])/(2*sp),nl=Math.hypot(dx,1,dz);
  pos[k*3]=x;pos[k*3+1]=h;pos[k*3+2]=z;nor[k*3]=-dx/nl;nor[k*3+1]=1/nl;nor[k*3+2]=-dz/nl;owColor(x,z,h,Math.hypot(dx,dz),TMP3);col[k*3]=TMP3[0];col[k*3+1]=TMP3[1];col[k*3+2]=TMP3[2];uv[k*2]=x*.01;uv[k*2+1]=z*.01;if(h<mn)mn=h;if(h>mx)mx=h}
 for(let e=0;e<4;e++)for(let k=0;k<tn;k++){const src=e===0?k:e===1?seg*tn+k:e===2?k*tn:k*tn+seg,d=tv+e*tn+k;pos[d*3]=pos[src*3];pos[d*3+1]=pos[src*3+1]-skd;pos[d*3+2]=pos[src*3+2];nor.copyWithin(d*3,src*3,src*3+3);col.copyWithin(d*3,src*3,src*3+3);uv[d*2]=uv[src*2];uv[d*2+1]=uv[src*2+1]}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('normal',new THREE.BufferAttribute(nor,3));g.setAttribute('color',new THREE.BufferAttribute(col,3));g.setAttribute('uv',new THREE.BufferAttribute(uv,2));
 /* Never store a hole in geometry.attributes: an undefined entry is harmless
    while drawing and fatal when the geometry is released. */
 const put=(name,attr)=>{if(attr&&attr.array)g.setAttribute(name,attr)};
 put('surfaceWeightsA',top.weightsA);put('surfaceWeightsB',top.weightsB);put('surfaceWeightsC',top.weightsC);if(top.index)g.setIndex(top.index);
 g.boundingSphere=new THREE.Sphere(new THREE.Vector3(n.cx,(mn+mx)/2,n.cz),Math.hypot(n.size*.5*1.42,(mx-mn)/2+skd)+1);
 if(!owTerrainMat)owTerrainMat=owMakeTerrainMat();const m=new THREE.Mesh(g,owTerrainMat);m.receiveShadow=true;m.castShadow=false;m.visible=false;m.matrixAutoUpdate=false;m.name='OW tile L'+n.l;OW.root.add(m);n.mesh=m;n.segments=seg;n.cy=(mn+mx)/2;n.built=true;if(mode=='wire')owTerrainMat.wireframe=true}
/* Release one tile. Shared topology attributes are detached first, and the
   whole release is guarded: a renderer that refuses one geometry must not take
   the streaming loop down with it. */
function owReleaseGeometry(g){
 if(!g)return;
 try{
  const at=g.attributes||{};
  for(const name in at){const a=at[name];if(!a||!a.array||OW_SHARED.has(a))delete at[name]}
  if(g.index&&OW_SHARED.has(g.index))g.index=null;
  g.dispose();
 }catch(e){console.warn('Open World: geometry release skipped —',e&&e.message)}
}
function owDisposeNode(n){if(n.mesh){OW.root.remove(n.mesh);owReleaseGeometry(n.mesh.geometry);n.mesh.geometry=null;n.mesh=null}n.built=false}
function owInitTiles(){owDisposeAllTiles();const half=OW.P.half||OW.P.size/2,RS=2048,nr=Math.ceil(OW.P.size/RS);roots=[];for(let j=0;j<nr;j++)for(let i=0;i<nr;i++)roots.push(owMkNode(5,-OW.P.size/2+i*RS,-OW.P.size/2+j*RS,RS,null));owQ=QS[OW.Q]}
function owDisposeAllTiles(){for(const n of ownodes)owDisposeNode(n);ownodes.length=0;roots=[];prevDrawn=[];drawn.length=0;blocks.clear()}
function owTileInView(n){owCullSphere.center.set(n.cx,n.cy,n.cz);const terrainRadius=Math.hypot(n.size*.72,320),prefetchMargin=Math.max(256,n.size*.4);owCullSphere.radius=terrainRadius+prefetchMargin;return owViewFrustum.intersectsSphere(owCullSphere)}
function owVisit(n,cp){if(!owTileInView(n))return;const dx=n.cx-cp.x,dz=n.cz-cp.z,dy=n.cy-cp.y,d=Math.sqrt(dx*dx+dz*dz+dy*dy),K=Math.max(owQ.K,detail>=3?2.8:detail>=2?2.2:1.6),threshold=n.size*K,wantSplit=n.l>0&&d<threshold*.8,keepSplit=n.l>0&&d<threshold*1.4;
 if(keepSplit&&!n.ch){const h=n.size/2,l=n.l-1;n.ch=[owMkNode(l,n.x0,n.z0,h,n),owMkNode(l,n.x0+h,n.z0,h,n),owMkNode(l,n.x0,n.z0+h,h,n),owMkNode(l,n.x0+h,n.z0+h,h,n)]}
 if(n.ch){if(n.split){if(!keepSplit&&n.built)n.split=false;else if(!n.built)wantQ.push([d,n])}
  else if(keepSplit){let all=true;for(const c of n.ch)if(!c.built){wantQ.push([Math.hypot(c.cx-cp.x,c.cz-cp.z),c]);all=false}if(all&&wantSplit)n.split=true}}
 if(n.split){for(const c of n.ch)owVisit(c,cp)}else{if(n.built)drawn.push(n);else wantQ.push([d,n])}}
function owTiles(budget){owFrameNo++;const cp=owCam;wantQ.length=0;drawn.length=0;for(const r of roots)owVisit(r,cp);
 wantQ.sort((a,b)=>a[0]-b[0]);const t0=performance.now();let built=0;for(let i=0;i<wantQ.length&&(built==0||performance.now()-t0<budget);i++){const n=wantQ[i][1];if(!n.built){owBuildNode(n);built++}}
 for(const m of prevDrawn)m.visible=false;prevDrawn.length=0;for(const n of drawn){if(n.mesh){n.mesh.visible=true;n.lastDraw=owFrameNo;prevDrawn.push(n.mesh)}}
 if(owFrameNo%180===0)for(const n of ownodes)if(n.mesh&&owFrameNo-n.lastDraw>700&&!n.split)owDisposeNode(n);
 OW.tilePending=wantQ.length;return built}
/* ---------- world-aware replacements for the main-script helpers ---------- */
const _hgt=window.hgt,_groundNormal=window.groundNormal,_sync=window.sync;
window.hgt=function(x,z){return OW.active&&OW.ready?owHgt(x,z):_hgt(x,z)};
window.groundNormal=function(x,z,a=1){if(!(OW.active&&OW.ready))return _groundNormal(x,z,a);const gx=(owHgt(x+1,z)-owHgt(x-1,z))*.5,gz=(owHgt(x,z+1)-owHgt(x,z-1))*.5;return GROUND_N.set(-gx*a,1,-gz*a).normalize()};
function withWorldCam(fn){if(!OW.active||!cam.parent||cam.parent===scene)return fn();const lx=cam.position.x,ly=cam.position.y,lz=cam.position.z;owCamUpdate();cam.position.copy(owCam);try{return fn()}finally{cam.position.set(lx,ly,lz)}}
window.sync=function(k,all){if(!OW.active)return _sync(k,all);const saved=[];for(const q in ROOT_SPAN){saved.push([q,ROOT_SPAN[q]]);ROOT_SPAN[q]=0}try{return withWorldCam(()=>_sync(k,all))}finally{for(const[q,v]of saved)ROOT_SPAN[q]=v}};
{const f=window.updateFoliageLOD;window.updateFoliageLOD=function(n){return withWorldCam(()=>f(n))};const g=window.updateWaterReflection;window.updateWaterReflection=function(){return withWorldCam(()=>g())};
 const bw=window.beginWaterReflectionCapture;window.beginWaterReflectionCapture=function(){const rest=bw();if(!OW.active)return rest;const hid=[];const h=o=>{if(o&&o.visible){o.visible=false;hid.push(o)}};for(const k in KIND){const K=KIND[k];K.meshes.forEach(h);(K.lowMeshes||[]).forEach(h);(K.shadowMeshes||[]).forEach(h)}h(OW.far);return()=>{rest();for(const o of hid)o.visible=true}}}
/* ---------- sea: follow the camera, depth window around it ---------- */
const SEAW={cx:1e9,cz:1e9,row:-1,tmp:null,nx:0,nz:0};let owSeaFar=null;
Object.assign(U,{uSeaC:{value:new THREE.Vector2()},uOW:{value:0}});
function owPatchWater(){const f=waterMat.onBeforeCompile;let bad=false;
 waterMat.onBeforeCompile=function(s,r){f.call(this,s,r);s.uniforms.uSeaC=U.uSeaC;s.uniforms.uOW=U.uOW;
  const P=src=>{const a='uniform float uTf,uTl,uTa,uTdx,uTdz;',b='float th2(vec2 p){p-=uTerrainOrigin;vec2 g=clamp((p+420.)/840.*256.,0.,255.999);',c='return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}float th1',d='float th(vec2 p){float k=';
   if(!(src.includes(a)&&src.includes(b)&&src.includes(c)&&src.includes(d))){bad=true;return src}
   return src.replace(a,a+'uniform vec2 uSeaC;uniform float uOW;').replace(b,'float th2(vec2 p){vec2 pc=p-uSeaC;float edgeK=smoothstep(380.,418.,max(abs(pc.x),abs(pc.y)));vec2 g=clamp((pc+420.)/840.*256.,0.,255.999);').replace(c,'return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),-90.,edgeK*uOW);}float th1').replace(d,'float th(vec2 p){if(uOW>.5)return th2(p);float k=')};
  s.vertexShader=P(s.vertexShader);s.fragmentShader=P(s.fragmentShader);if(bad)console.warn('Open World: water depth patch not applied (shader text changed)')};
 waterMat.customProgramCacheKey=()=>'terrain-water-pbr-v4-triplanar-fft-ow1';waterMat.needsUpdate=true;
 owSeaFar=new THREE.Mesh(new THREE.RingGeometry(1400,19000,160,18).rotateX(-Math.PI/2),waterMat);owSeaFar.frustumCulled=false;owSeaFar.visible=false;owSeaFar.name='OW far sea';water.add(owSeaFar)}
function owSeaStep(budgetRows){const c=owCam;water.position.x=c.x;water.position.z=c.z;
 if(SEAW.row<0){const dx=c.x-SEAW.cx,dz=c.z-SEAW.cz;if(dx*dx+dz*dz>160*160){SEAW.nx=Math.round(c.x/8)*8;SEAW.nz=Math.round(c.z/8)*8;SEAW.row=0;if(!SEAW.tmp)SEAW.tmp=new Float32Array(257*257)}}
 if(SEAW.row>=0){const end=Math.min(257,SEAW.row+budgetRows);for(let j=SEAW.row;j<end;j++)for(let i=0;i<257;i++)SEAW.tmp[j*257+i]=OWM.height(SEAW.nx+i/256*840-420,SEAW.nz+j/256*840-420);SEAW.row=end;
  if(end>=257){SBA.set(SEAW.tmp);SBT.needsUpdate=true;U.uSeaC.value.set(SEAW.nx,SEAW.nz);SEAW.cx=SEAW.nx;SEAW.cz=SEAW.nz;SEAW.row=-1}}}
/* ---------- rivers, lakes, ponds, waterfalls ---------- */
let owWMat=null;const owWMeshes=[];let owMist=null;
function owWaterMat(){if(owWMat)return owWMat;const f=THREE.Color;
 const u=Object.assign({},U,{uWShal:{value:new f(.12,.34,.29)},uWDeep:{value:new f(.015,.09,.11)}});
 owWMat=new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,side:THREE.DoubleSide,fog:false,
 vertexShader:'attribute vec4 aInfo;attribute vec2 aInfo2;varying vec3 vW,vN;varying vec2 vUv,vI2;varying vec4 vI;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;vN=normalize(mat3(modelMatrix)*normal);vUv=uv;vI=aInfo;vI2=aInfo2;gl_Position=projectionMatrix*viewMatrix*w;}',
 fragmentShader:'#define SKQ 1\nuniform vec3 top,hor,sun,sd;uniform float t,cov,ni,ov,flash;'+SKYU+SKYF+`uniform vec3 fc,uWShal,uWDeep;uniform float fd;varying vec3 vW,vN;varying vec2 vUv,vI2;varying vec4 vI;
void main(){vec3 V=normalize(cameraPosition-vW);float kind=vI2.y,wd=max(vI2.x,1.),slope=vI.y;
 vec2 q=kind>.5?vec2((vUv.x-.5)*wd*2.,vUv.y*6.):vW.xz;float sp=kind>.5?(1.1+slope*9.):.12;vec2 fo=kind>.5?vec2(0.,-t*sp):vec2(t*.04,t*.025);
 vec2 p=q*(kind>.5?vec2(.9,.45):vec2(.55,.55))+fo;float e=.12,n0=fbm(p),nx=fbm(p+vec2(e,0.)),nz=fbm(p+vec2(0.,e));float amp=kind>.5?(.9+slope*2.5):.55;
 vec3 N=normalize(vN+vec3(n0-nx,0.,n0-nz)*amp*2.2*clamp(1.-slope*1.2,.25,1.));float ndv=max(dot(N,V),0.),fr=.02+.98*pow(1.-ndv,5.);
 vec3 R=reflect(-V,N);R.y=abs(R.y)+.03;vec3 refl=skyColor(normalize(R));
 float dep=smoothstep(0.,.9,vI.x);vec3 base=mix(uWShal,uWDeep,dep);float lum=.28+.72*(1.-ni);vec3 body=pow(base*lum,vec3(.4545));
 vec3 col=mix(body,refl,clamp(fr*.95+.1,0.,1.));
 float bank=kind>.5?(1.-smoothstep(0.,.2,min(vUv.x,1.-vUv.x)))*smoothstep(.35,.7,fbm(q*vec2(1.4,.6)+fo)):0.;float sf=smoothstep(.16,.62,slope),streak=fbm(vec2(q.x*1.6,q.y*.22+fo.y*1.4));
 float foam=clamp(bank*.55+sf*(.7+.5*streak),0.,1.);col=mix(col,vec3(.93,.96,1.)*(.5+.5*(1.-ni)),foam);
 float a=mix(.5,.94,dep);a=max(a,foam*.92);a*=vI.z*(kind>.5?smoothstep(0.,.1,min(vUv.x,1.-vUv.x))*.5+.5:1.);
 float dist=length(vW-cameraPosition),fog=1.-exp(-fd*fd*dist*dist);col=mix(col,fc,fog);gl_FragColor=vec4(col,a*(1.-fog*.35));}`});
 owWMat.name='OW river/lake water';return owWMat}
function owDisposeWater(){for(const m of owWMeshes){OW.root.remove(m);owReleaseGeometry(m.geometry)}owWMeshes.length=0;if(owMist){OW.root.remove(owMist);owReleaseGeometry(owMist.geometry);owMist=null}}
function owRiverMesh(r,sea){const m=r.x.length,pos=new Float32Array(m*9),nor=new Float32Array(m*9),uv=new Float32Array(m*6),inf=new Float32Array(m*12),inf2=new Float32Array(m*6),idx=[];
 const surf=new Float32Array(m);for(let i=0;i<m;i++){surf[i]=r.bed[i]+r.dW[i];if(r.end==='sea'){const e=Math.max(0,1-(r.cum[m-1]-r.cum[i])/70);surf[i]=Math.max(surf[i],sea+.2*e+.02)}}
 for(let i=0;i<m;i++){const a=Math.max(0,i-1),b=Math.min(m-1,i+1);let tx=r.x[b]-r.x[a],tz=r.z[b]-r.z[a];const tl=Math.hypot(tx,tz)||1;tx/=tl;tz/=tl;const hw=r.w[i]*1.18,L=Math.max(.5,r.cum[b]-r.cum[a]),dy=(surf[b]-surf[a])/L,slope=Math.min(2.5,Math.max(0,-dy)),y=surf[i];
  const lx=-tz,lz=tx,ty=dy,ax=tx,ay=ty,az=tz,nx0=ay*lz-az*0,ny0=az*lx-ax*lz,nz0=ax*0-ay*lx,nl=Math.hypot(nx0,ny0,nz0)||1;let nx=nx0/nl,ny=ny0/nl,nz=nz0/nl;if(ny<0){nx=-nx;ny=-ny;nz=-nz}
  const fade=Math.min(1,r.cum[i]/25)*(r.end==='sea'?Math.min(1,(r.cum[m-1]-r.cum[i])/25+.25):1),dep=Math.min(1,r.dW[i]/2);
  for(let s=0;s<3;s++){const o=i*3+s,u=s*.5,off=(u-.5)*2*hw;pos[o*3]=r.x[i]+lx*off;pos[o*3+1]=y;pos[o*3+2]=r.z[i]+lz*off;nor[o*3]=nx;nor[o*3+1]=ny;nor[o*3+2]=nz;uv[o*2]=u;uv[o*2+1]=r.cum[i]/6;
   inf[o*4]=s==1?dep:dep*.25;inf[o*4+1]=slope;inf[o*4+2]=fade;inf[o*4+3]=0;inf2[o*2]=r.w[i];inf2[o*2+1]=1}}
 for(let i=0;i<m-1;i++)for(let s=0;s<2;s++){const a=i*3+s,b=a+1,c=a+3,d=c+1;idx.push(a,b,c,b,d,c)}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('normal',new THREE.BufferAttribute(nor,3));g.setAttribute('uv',new THREE.BufferAttribute(uv,2));g.setAttribute('aInfo',new THREE.BufferAttribute(inf,4));g.setAttribute('aInfo2',new THREE.BufferAttribute(inf2,2));g.setIndex(idx);g.computeBoundingSphere();return g}
function owLakeMesh(lk){const NA=48,NR=5,P=OW.P,pos=[],nor=[],uv=[],inf=[],inf2=[],idx=[],sh=[];
 for(let a=0;a<NA;a++){const th=a/NA*6.2832,c=Math.cos(th),s=Math.sin(th),st=Math.max(1,lk.R/70);let r=0;for(;r<lk.R*2.4;r+=st){if(OWM.height(lk.x+c*r,lk.z+s*r)>=lk.L-.01&&r>st*2)break}sh.push(Math.min(r,lk.R*2.4))}
 const vert=(x,z,dep)=>{pos.push(x,lk.L,z);nor.push(0,1,0);uv.push(x*.02,z*.02);inf.push(Math.min(1,dep/(lk.depth*.8)),0,1,0);inf2.push(lk.R,0)};
 vert(lk.x,lk.z,lk.L-OWM.height(lk.x,lk.z));for(let k=1;k<=NR;k++)for(let a=0;a<NA;a++){const th=a/NA*6.2832,rr=sh[a]*(k/NR)*(k==NR?1.04:1),x=lk.x+Math.cos(th)*rr,z=lk.z+Math.sin(th)*rr;vert(x,z,Math.max(0,lk.L-OWM.height(x,z)))}
 for(let a=0;a<NA;a++)idx.push(0,1+a,1+(a+1)%NA);for(let k=1;k<NR;k++)for(let a=0;a<NA;a++){const A=1+(k-1)*NA+a,B=1+(k-1)*NA+(a+1)%NA,C=A+NA,D=B+NA;idx.push(A,C,B,B,C,D)}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setAttribute('aInfo',new THREE.Float32BufferAttribute(inf,4));g.setAttribute('aInfo2',new THREE.Float32BufferAttribute(inf2,2));g.setIndex(idx);g.computeBoundingSphere();return g}
function owBuildWater(){owDisposeWater();const S=OWM.S,mat=owWaterMat();
 for(const r of S.rv){const m=new THREE.Mesh(owRiverMesh(r,OW.P.sea),mat);m.renderOrder=3;m.frustumCulled=true;m.name='OW river '+r.id;OW.root.add(m);owWMeshes.push(m)}
 for(const lk of S.lk){const m=new THREE.Mesh(owLakeMesh(lk),mat);m.renderOrder=3;m.name='OW '+lk.tag;OW.root.add(m);owWMeshes.push(m)}
 /* waterfall mist */
 const fs=S.falls;if(fs.length){const N=60,pos=new Float32Array(fs.length*N*3),rnd=new Float32Array(fs.length*N);let k=0;for(const f of fs){const r=f.r,i=Math.min(r.x.length-1,f.i+2),y=r.bed[i]+r.dW[i];for(let q=0;q<N;q++,k++){const a=Math.random()*6.283,d=Math.random()*(r.w[i]*1.6+2);pos[k*3]=r.x[i]+Math.cos(a)*d;pos[k*3+1]=y+.6;pos[k*3+2]=r.z[i]+Math.sin(a)*d;rnd[k]=Math.random()}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('aRnd',new THREE.BufferAttribute(rnd,1));
  owMist=new THREE.Points(g,new THREE.ShaderMaterial({uniforms:{uT:U.t,fc:U.fc,fd:U.fd,ni:U.ni},transparent:true,depthWrite:false,fog:false,
   vertexShader:'attribute float aRnd;uniform float uT;varying float vA;void main(){float ph=fract(uT*.18*(.6+aRnd)+aRnd*7.);vec3 p=position+vec3(sin(aRnd*40.+uT*.6)*1.5*ph,ph*9.*(.5+aRnd),cos(aRnd*30.+uT*.5)*1.5*ph);vec4 mv=viewMatrix*vec4(p,1.);gl_PointSize=clamp((70.+aRnd*60.)*(.4+ph)/(-mv.z),2.,120.);vA=(1.-ph)*smoothstep(0.,.1,ph)*.38;gl_Position=projectionMatrix*mv;}',
   fragmentShader:'uniform vec3 fc;uniform float fd,ni;varying float vA;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;gl_FragColor=vec4(vec3(.9,.95,1.)*(.35+.65*(1.-ni)),vA*(1.-d*2.));}'}));
  owMist.frustumCulled=false;owMist.renderOrder=4;OW.root.add(owMist)}}

/* ================= Part 3 — foliage streaming (grass, flowers, shrubs, rocks, trees) + far forest ================= */
const COVER=new Set(['grass','tallgrass','flower','daisy','tulip','lavender','fern']),CATK=k=>COVER.has(k)?'c':RK[k]?'r':FP[k]>=1.8?'t':'s';
const TAB={c:[],s:[],r:[],t:[]},BFAC=[1,.06,.12,1.3,1.2,.22,.3],COVER_RHO=2.4,SMALL_RHO=.02,ROCK_RHO=.0016;
function owBuildTabs(){for(const cat in TAB)TAB[cat]=BKEY.map(b=>{const lst=(BTAB[b]||[]).filter(([k])=>CATK(k)===cat),tot=lst.reduce((a,[,w])=>a+w,0);let c=0;return tot>0?{kinds:lst.map(x=>x[0]),cum:lst.map(([,w])=>(c+=w/tot))}:null})}
const pickB=(w,rr)=>{let a=0;for(let i=0;i<7;i++){a+=w[i];if(rr<=a)return i}return 0},pickK=(t,rr)=>{for(let i=0;i<t.kinds.length;i++)if(rr<=t.cum[i])return t.kinds[i];return t.kinds[t.kinds.length-1]};
const fol={cells:new Map(),far:new Map(),q:[],fq:[],lastX:1e9,lastZ:1e9,dirty:false,farDirty:false,lastBuild:0,syncQ:[],sig:{},kinds:[],farMesh:null,farPools:new Map(),farSig:'',lastViewDir:new THREE.Vector3(),viewReady:false,viewPending:false};
const cand=new Map(),ckey=(a,b)=>(a+4096)*8192+(b+4096),seedI=()=>(OW.P.seed|0)+((OW.salt|0)*7919),hsh=(a,b,s)=>OWM.hash(a,b,seedI()+s),rr0=(a,b,s)=>OWM.rng((hsh(a,b,s)*4294967296)|0);
const TDW=new Float64Array(7);let TDh=0,TDT=0;
/* tree density (0..1.3) at a point; leaves height in TDh and biome weights in TDW */
function treeDensity(x,z){const P=OW.P,h=OWM.height(x,z);TDh=h;if(h<P.sea+.7)return 0;if(h<OWM.waterLevel(x,z)+.5)return 0;
 const T=OWM.biomeAt(x,z,h,WB);TDT=T;for(let i=0;i<7;i++)TDW[i]=WB[i];let bf=0;for(let i=0;i<7;i++)bf+=WB[i]*BFAC[i];
 const M=OWM.CL[1],mask=ss(.38,.62,OWM.fbm(x*.0035+5,z*.0035-9,3,P.seed&0xffff)),moist=.35+.65*ss(.2,.6,M),tl=OWM.treeLine(T);
 return Math.max(mask*moist,.1)*bf*(1-ss(tl-40,tl+30,h))}
const slopeOf=(x,z)=>Math.hypot(OWM.height(x+1,z)-OWM.height(x-1,z),OWM.height(x,z+1)-OWM.height(x,z-1))*.5;
function candsOf(ix,iz){const key=ckey(ix,iz);let a=cand.get(key);if(a)return a;const r=rr0(ix,iz,23),x0=ix*64,z0=iz*64,dn=OW.dens.trees;a=[];
 for(let i=0;i<110;i++){const x=x0+r()*64,z=z0+r()*64,u=r(),pr=r(),kr=r(),sr=r(),rot=r()*6.283,av=r(),vv=r(),br=r(),d=treeDensity(x,z);if(u*1.25>d*dn)continue;
  const b=pickB(TDW,br),tab=TAB.t[b];if(!tab)continue;const k=pickK(tab,kr),K=owEnsureSpecies(k);if(!K)continue;if(slopeOf(x,z)>(RULE[k]?RULE[k][0]:.7))continue;
  const s=SM[k]*(1+(sr-.5)*2*K.vr);a.push({x,z,pr,k,s,fp:FP[k]||2,r:rot,a:.88+av*.24,v:.82+vv*.3,y:TDh,acc:0,ci:ix,cj:iz})}
 if(cand.size>2500){let n=0;for(const k of cand.keys()){cand.delete(k);if(++n>600)break}}cand.set(key,a);return a}
function treeAcc(c){if(c.acc)return c.acc===1;for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){const arr=candsOf(c.ci+di,c.cj+dj);for(const n of arr){if(n===c||n.pr<=c.pr)continue;const dx=n.x-c.x,dz=n.z-c.z,dm=(c.fp*c.s+n.fp*n.s)*.8;if(dx*dx+dz*dz<dm*dm&&treeAcc(n)){c.acc=2;return false}}}c.acc=1;return true}
function mkInst(k,x,y,z,s,r,a,v){return{x,y,z,s,r,a,v,manual:false}}
function treePrep(c){for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){if(!cand.has(ckey(c.ix+di,c.iz+dj))){candsOf(c.ix+di,c.iz+dj);return false}}return true}
function genTrees(c){const arr=candsOf(c.ix,c.iz);for(const t of arr){if(!treeAcc(t))continue;let y=t.y;const span=(ROOT_SPAN[t.k]||0)*t.s;if(span){let low=y;for(let q=0;q<4;q++){const a=q*1.5708+.6;low=Math.min(low,OWM.height(t.x+Math.cos(a)*span*.6,t.z+Math.sin(a)*span*.6))}y-=Math.min(Math.max(0,y-low-.08),Math.min(.28*t.s,.16*span))}
  (c.k[t.k]||(c.k[t.k]=[])).push(mkInst(t.k,t.x,y,t.z,t.s,t.r,t.a,t.v))}c.tDone=true}
const ENV=new Float64Array(10);
function* genGroundG(c){const P=OW.P,dn=OW.dens,r=rr0(c.ix,c.iz,11),x0=c.ix*64,z0=c.iz*64,sea=P.sea,EG=9,eg=new Float32Array(EG*EG*10);
 {const hc=Math.max(OWM.height(x0,z0),OWM.height(x0+64,z0),OWM.height(x0,z0+64),OWM.height(x0+64,z0+64),OWM.height(x0+32,z0+32));if(hc<sea-3){c.gDone=true;return}}
 const hasW=OWM.hasWater(x0,z0,x0+64,z0+64);
 for(let j=0;j<EG;j++)for(let i=0;i<EG;i++){const x=x0+i*8,z=z0+j*8,h=OWM.height(x,z),T=OWM.biomeAt(x,z,h,WB),o=(j*EG+i)*10;for(let q=0;q<7;q++)eg[o+q]=WB[q];eg[o+7]=T;eg[o+8]=OWM.treeLine(T);eg[o+9]=OWM.snowLine(T)}
 const env=(x,z)=>{const u=(x-x0)/8,v=(z-z0)/8,i=Math.min(7,u|0),j=Math.min(7,v|0),fu=u-i,fv=v-j,o=(j*EG+i)*10,w00=(1-fu)*(1-fv),w10=fu*(1-fv),w01=(1-fu)*fv,w11=fu*fv;for(let q=0;q<10;q++)ENV[q]=eg[o+q]*w00+eg[o+10+q]*w10+eg[o+EG*10+q]*w01+eg[o+EG*10+10+q]*w11};
 const add=(k,x,z,y,s)=>{(c.k[k]||(c.k[k]=[])).push(mkInst(k,x,y,z,s,r()*6.283,.88+r()*.24,.82+r()*.3))},K_=k=>owEnsureSpecies(k);
 /* ground cover */
 const nC=Math.round(4096*COVER_RHO*dn.cover);
 for(let i=0;i<nC;i++){if((i&511)===511)yield;const x=x0+r()*64,z=z0+r()*64,y=owHS(x,z),sl0=OWSL;const rb=r(),rk=r(),rs=r(),rg=r();if(y<sea+.35)continue;env(x,z);
  const tl=ENV[8],sn=ENV[9];if(y>sn-25||(y>tl&&rg>1-ss(tl,tl+170,y)))continue;
  const b=pickB(ENV,rb),tab=TAB.c[b];if(!tab)continue;const k=pickK(tab,rk),K=K_(k);if(!K)continue;
  if(hasW&&OWM.waterLevel(x,z)>y-.2)continue;if(sl0>(RULE[k]?RULE[k][0]:.8))continue;
  if((k==='grass'||k==='tallgrass')&&OWM.noise(x*.09+9,z*.09+4,seedI()&255)*1.7<(k==='tallgrass'?.18:.32))continue;
  const fl=k==='flower'||k==='daisy'||k==='tulip'||k==='lavender';if(fl){if(rg>dn.flowers)continue;if(dn.flowers>1&&r()<dn.flowers-1)add(k,x+.6,z+.4,owHgt(x+.6,z+.4),SM[k]*(1+(rs-.5)*2*K.vr))}
  add(k,x,z,y,SM[k]*(1+(rs-.5)*2*K.vr))}
 /* shrubs / small plants */
 const nS=Math.round(4096*SMALL_RHO*dn.shrubs);
 for(let i=0;i<nS;i++){if((i&511)===511)yield;const x=x0+r()*64,z=z0+r()*64,y=owHS(x,z),sl0=OWSL,rb=r(),rk=r(),rs=r();if(y<sea+.45)continue;env(x,z);const tl=ENV[8];if(y>tl+20)continue;
  const b=pickB(ENV,rb),tab=TAB.s[b];if(!tab)continue;const k=pickK(tab,rk),K=K_(k);if(!K)continue;if(hasW&&OWM.waterLevel(x,z)>y-.25)continue;
  if(sl0>(RULE[k]?RULE[k][0]:.7))continue;add(k,x,z,y,SM[k]*(1+(rs-.5)*2*K.vr))}
 /* rocks */
 const nR=Math.round(4096*ROCK_RHO*dn.rocks);
 for(let i=0;i<nR;i++){const x=x0+r()*64,z=z0+r()*64,y=owHgt(x,z),rb=r(),rk=r(),rs=r();if(y<sea-.2)continue;env(x,z);const b=pickB(ENV,rb),tab=TAB.r[b];if(!tab)continue;const k=pickK(tab,rk),K=K_(k);if(!K)continue;if(hasW){const wl_=OWM.waterLevel(x,z);if(wl_>-1e8&&y<wl_-.6)continue}
  add(k,x,z,y,SM[k]*(.5+rs*1.7)*(1+(rs-.5)*K.vr))}
 c.gDone=true}
function genGround(c){for(const _ of genGroundG(c));}
/* Procedural far foliage: preserve the main app's tree species, geometry and material variants. */
function* genFarCellG(c){const r=rr0(c.fx,c.fz,37),x0=c.fx*128,z0=c.fz*128,dn=OW.dens,Q=QS[OW.Q],trees=[],cover=[],shrubs=[],rocks=[],models=new Map(),N=11,sp=128/N,half=OW.P.size*.5,flowers=new Set(['flower','daisy','tulip','lavender']);let work=0;
 const Kof=k=>{let K=models.get(k);if(!models.has(k)){K=owEnsureSpecies(k);models.set(k,K)}return K},plant=(k,x,z,y,sc,rot,aa,vv)=>{const K=Kof(k);if(!K||!K.meshes?.length)return null;return{x,y,z,k,s:SM[k]*(1+(sc-.5)*2*K.vr),r:rot,a:.88+aa*.24,v:.82+vv*.3}};
 for(let j=0;j<N;j++)for(let i=0;i<N;i++){const x=x0+(i+.5+(r()-.5)*.8)*sp,z=z0+(j+.5+(r()-.5)*.8)*sp,u=r(),kr=r(),br=r(),sc=r(),rot=r()*6.2832,aa=r(),vv=r(),d=treeDensity(x,z);if(Math.abs(x)<=half&&Math.abs(z)<=half&&u<=d*dn.trees*.8){const b=pickB(TDW,br),tab=TAB.t[b];if(tab){const k=pickK(tab,kr),item=plant(k,x,z,TDh,sc,rot,aa,vv);if(item)trees.push(item)}}if((++work&31)===0)yield}
 const GN=11,gsp=128/GN;for(let j=0;j<GN;j++)for(let i=0;i<GN;i++){const x=x0+(i+.5+(r()-.5)*.65)*gsp,z=z0+(j+.5+(r()-.5)*.65)*gsp;if(Math.abs(x)<=half&&Math.abs(z)<=half){const h=owHgt(x,z);if(h>=OW.P.sea+.35){const water=OWM.waterLevel(x,z);if(water<=-1e8||water<=h-.2){const sl0=slopeOf(x,z);OWM.biomeAt(x,z,h,WB);const b=pickB(WB,r()),catPick=r(),cat=catPick<.72?'c':catPick<.92?'s':'r',tab=TAB[cat][b];if(tab){const k=pickK(tab,r());if(sl0<=(RULE[k]?RULE[k][0]:.8)&&(!flowers.has(k)||r()<=Math.min(1,dn.flowers))&&(cat!=='c'||r()<=Math.min(1,dn.cover))&&(cat!=='s'||r()<=Math.min(1,dn.shrubs))&&(cat!=='r'||r()<=Math.min(1,dn.rocks))){const item=plant(k,x,z,h,r(),r()*6.2832,r(),r());if(item)(cat==='c'?cover:cat==='s'?shrubs:rocks).push(item)}}}}}if((++work&31)===0)yield}
 const priority=(a,b)=>owHash(a.x*7.17,a.z*3.91)-owHash(b.x*7.17,b.z*3.91),limit=(items,n)=>{items.sort(priority);items.length=Math.min(items.length,Math.max(0,Math.floor(n)));return items};c.list=[...limit(trees,Q.farCellCap),...limit(cover,Q.farCoverCell*dn.cover),...limit(shrubs,Q.farShrubCell*dn.shrubs),...limit(rocks,Q.farRockCell*dn.rocks)];c.done=true}
function genFarCell(c){for(const _ of genFarCellG(c));}
function owEnsureFar(){if(fol.farMesh)return;const g=new THREE.Group();g.name='Open World procedural far foliage';fol.farMesh=g;fol.farPools=new Map();OW.far=g;OW.root.add(g)}
function owClearFar(){for(const p of fol.farPools.values()){p.mesh.count=0;p.mesh.visible=false}}
function owAdoptKMeshes(){if(!OW.def)return;for(const k in KIND){const K=KIND[k];for(const m of [...(K.meshes||[]),...(K.shadowMeshes||[])]){if(!m||m.parent===OW.root)continue;const parent=m.parent||scene;if(!OW.def.meshParents.some(v=>v.m===m))OW.def.meshParents.push({kind:k,m,parent});OW.root.attach(m)}}}
function owEnsureSpecies(k){const before=KIND[k]?.meshes,K=ensure(k);if(OW.active&&K&&K.meshes!==before)owAdoptKMeshes();return K}
function owRestoreKMeshes(d){for(const v of d?.meshParents||[]){const K=KIND[v.kind];if(!K||![...(K.meshes||[]),...(K.shadowMeshes||[])].includes(v.m)||!v.parent||v.m.parent===v.parent)continue;v.parent.attach(v.m)}}
const forestImpostors=window.FEForestImpostors(THREE);
const dmy=new THREE.Object3D(),tc3=new THREE.Color();
function forestView(item,cp){const a=Math.atan2(cp.x-item.x,cp.z-item.z)-(item.r||0);return ((Math.round(a/(Math.PI/2))%4)+4)%4}
function syncForestCards(batches,group){
 const active=new Set();let count=0;
 for(const[key,b]of batches){active.add(key);let pool=fol.farPools.get(key);const n=b.items.length;
  if(!pool||pool.capacity<n){if(pool){group.remove(pool.mesh);pool.mesh.dispose?.();if(pool.ownedMaterial)forestImpostors.disposeMaterial(pool.mesh.material)}const capacity=Math.max(n,pool?Math.ceil(pool.capacity*1.25):1),mesh=new THREE.InstancedMesh(b.atlas.geometries[b.view],forestImpostors.ditherMaterial(b.atlas.material,true),capacity);mesh.frustumCulled=false;mesh.castShadow=false;mesh.name='Forest impostors '+key;mesh.userData={farLod:true,impostor:true,chunk:b.chunk};pool={mesh,capacity,ownedMaterial:true};fol.farPools.set(key,pool);group.add(mesh)}
  const mesh=pool.mesh;
  for(let i=0;i<n;i++){const o=b.items[i],s=cl(o.s*b.K.size,TREE_SIZE_MIN[o.k]||0,TREE_SIZE_MAX[o.k]||Infinity),a=o.a||1;
   dmy.rotation.set(0,Math.atan2(owCam.x-o.x,owCam.z-o.z),0);dmy.scale.set(s*a,s,s*a);
   // Atlas is centered on the source bounds, including any asymmetric crown.
   const offset=b.atlas.center.clone().multiply(new THREE.Vector3(s*a,s,s*a));offset.applyAxisAngle(GROUND_UP,o.r||0);
   dmy.position.set(o.x+offset.x,owHeightAt(o.x,o.z)+offset.y,o.z+offset.z);dmy.updateMatrix();mesh.setMatrixAt(i,dmy.matrix);
   const tint=b.K.tint||[1,1,1],v=o.v??1;mesh.setColorAt(i,tc3.setRGB(tint[0]*v,tint[1]*v,tint[2]*v));
  }
  mesh.count=n;mesh.visible=n>0;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;count+=n;
 }
 forestImpostors.stats.instances=count;forestImpostors.stats.triangles=count*2;return active;
}
function rebuildFar(){forestImpostors.setLodDistance(Math.max(QS[OW.Q].Rt+160,500),owCam);const group=fol.farMesh;if(!group)return;owUpdateViewFrustum();const Q=QS[OW.Q],cp=owCam,batches=new Map(),cards=new Map(),models=new Map();let trees=0;
 const cells=[...fol.far.values()].filter(c=>c.done).map(c=>({c,d:Math.hypot(c.fx*128+64-cp.x,c.fz*128+64-cp.z)})).filter(o=>o.d>Math.min(Q.Rc,Q.Rs,Q.Rr,Q.Rt)+32&&o.d<=Q.Rf);
 forestImpostors.classify(cells.flatMap(({c})=>c.list),cp,Math.max(Q.Rt+160,500),Q.Rf);
 for(const{c}of cells)for(const item of c.list){let K=models.get(item.k);if(!models.has(item.k)){K=owEnsureSpecies(item.k);models.set(item.k,K)}const cat=CATK(item.k),inner=(cat==='c'?Q.Rc:cat==='s'?Q.Rs:cat==='r'?Q.Rr:Q.Rt)+45,dItem=Math.hypot(item.x-cp.x,item.z-cp.z);if(!K||!K.meshes?.length||dItem<inner||dItem>Q.Rf||!owInstanceInView(item,item.k,K,true))continue;const lodDistance=Math.max(Q.Rt+160,500);let fadeMesh=false;
 // Warm the atlas before entering the overlap; meshes themselves already reside in KIND.
 if(cat==='t'&&dItem>lodDistance-220){
 const atlas=forestImpostors.request(item.k,K);
 if(atlas){fadeMesh=true;const residency=forestImpostors.resident(item,dItem,lodDistance);
  if(residency.card){const selected=forestImpostors.view(item),view=selected>=0?selected:forestView(item,cp),key='impostor:'+item.k+':'+view+':'+c.fx+','+c.fz;let b=cards.get(key);if(!b)cards.set(key,b={atlas,view,K,chunk:[c.fx,c.fz],items:[]});b.items.push(item);}
  // Residency margin beyond the visible fade avoids churn at the transition endpoints.
  if(!residency.mesh){trees++;continue}
 }
 }const h2=owHash(item.x*1.7,item.z*2.3),h3=owHash(item.x,item.z);let used=false;for(let si=0;si<K.meshes.length;si++){const src=K.meshes[si];if(!src?.geometry||!src.material||!src.userData)continue;const nv=Number(src.userData.vn)||0;if(nv>0&&((h2*997)|0)%nv!==src.userData.vi)continue;const key=item.k+':'+si+(fadeMesh?':fade':'');let batch=batches.get(key);if(!batch)batches.set(key,batch={src,K,fadeMesh,items:[]});batch.items.push({item,h2,h3});used=true}if(used)trees++}
 const active=syncForestCards(cards,group);for(const[key,batch]of batches){active.add(key);const{src,K,items,fadeMesh}=batch;let pool=fol.farPools.get(key),need=items.length;if(!pool||pool.src!==src||pool.capacity<need){if(pool){group.remove(pool.mesh);pool.mesh.dispose?.();if(pool.ownedMaterial)forestImpostors.disposeMaterial(pool.mesh.material)}const capacity=Math.max(need,pool?Math.ceil(pool.capacity*1.25):1),mesh=new THREE.InstancedMesh(src.geometry,fadeMesh?forestImpostors.ditherMaterial(src.material,false):src.material,capacity);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.instanceColor=new THREE.BufferAttribute(new Float32Array(capacity*3).fill(1),3);mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);mesh.count=0;mesh.frustumCulled=false;mesh.castShadow=false;mesh.receiveShadow=false;mesh.layers.mask=src.layers.mask;mesh.name='Open World far '+key;mesh.userData={kind:key.split(':')[0],farLod:true};pool={src,mesh,capacity,ownedMaterial:fadeMesh};fol.farPools.set(key,pool);group.add(mesh)}
  const mesh=pool.mesh;for(let i=0;i<items.length;i++){const{item,h2,h3}=items[i],kind=item.k,gy=owHeightAt(item.x,item.z),s=cl(item.s*K.size,TREE_SIZE_MIN[kind]||0,TREE_SIZE_MAX[kind]||Infinity),span=(ROOT_SPAN[kind]||0)*s;let sink=0;if(span){let low=gy;for(let q=0;q<4;q++){const a=q*Math.PI*.5;low=Math.min(low,owHeightAt(item.x+Math.cos(a)*span,item.z+Math.sin(a)*span))}sink=Math.min(Math.max(0,gy-low-.08),Math.min(.28*s,.16*span))}dmy.position.set(item.x,gy-sink,item.z);if(!BLD[kind]){const align=RK[kind] ? .7 : ROOT_SPAN[kind] ? .28+h2*.24 : NT[kind] ? .28 : 1;dmy.quaternion.setFromUnitVectors(GROUND_UP,owNormalAt(item.x,item.z,align));GROUND_Q.setFromAxisAngle(GROUND_UP,item.r||0);dmy.quaternion.multiply(GROUND_Q);const bend=kind==='palm' ? .28 : (kind==='acacia'||kind==='joshua') ? .22 : (ROOT_SPAN[kind]||NT[kind]) ? .18 : .1;GROUND_E.set((h2-.5)*bend,0,(h3-.5)*bend,'YXZ');GROUND_Q.setFromEuler(GROUND_E);dmy.quaternion.multiply(GROUND_Q)}dmy.scale.set(s*(item.a||1),s,s*(item.a||1));dmy.updateMatrix();mesh.setMatrixAt(i,dmy.matrix);const pal=src.userData.pal,col=pal?pal[(h2*pal.length)|0]:[1.05-h2*.2,1,.9+h2*.2],tint=pal||src.userData.nt?[1,1,1]:K.tint,v=item.v??1;mesh.setColorAt(i,tc3.setRGB(col[0]*v*tint[0],col[1]*v*tint[1],col[2]*v*tint[2]))}mesh.count=items.length;mesh.visible=items.length>0;mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;}
 for(const[key,pool]of fol.farPools)if(!active.has(key)){group.remove(pool.mesh);pool.mesh.dispose?.();if(pool.ownedMaterial)forestImpostors.disposeMaterial(pool.mesh.material);fol.farPools.delete(key)}fol.farSig=String(trees)}
/* streaming controller */
function folClear(){for(const p of fol.farPools.values()){fol.farMesh?.remove(p.mesh);p.mesh.dispose?.();if(p.ownedMaterial)forestImpostors.disposeMaterial(p.mesh.material)}fol.farPools.clear();forestImpostors.clear();fol.cells.clear();fol.far.clear();owClearFar();fol.q.length=0;fol.fq.length=0;cand.clear();fol.sig={};fol.lastX=fol.lastZ=1e9;fol.dirty=fol.farDirty=true;fol.syncQ.length=0;for(const k in KIND){KIND[k].list=[];}}
function folPlan(){owUpdateViewFrustum();fol.lastViewDir.copy(owViewDir);fol.viewReady=true;fol.viewPending=true;fol.lastBuild=0;fol.sig={};const c=owCam,Q=QS[OW.Q],Rg=Math.max(Q.Rc,Q.Rs,Q.Rr),Rn=Math.max(Rg,Q.Rt)+70,r=Math.ceil(Rn/64),cx=Math.floor(c.x/64),cz=Math.floor(c.z/64);fol.q.length=0;
 for(let j=cz-r;j<=cz+r;j++)for(let i=cx-r;i<=cx+r;i++){const d=Math.hypot(i*64+32-c.x,j*64+32-c.z);if(d>Rn)continue;const key=ckey(i,j);let cell=fol.cells.get(key);if(!cell){cell={ix:i,iz:j,k:{},gDone:false,tDone:false};fol.cells.set(key,cell)}
  const nG=d<=Rg+70&&!cell.gDone,nT=d<=Q.Rt+70&&!cell.tDone;if(nG||nT)fol.q.push([d,cell,nG,nT])}
 for(const[key,cell]of fol.cells){if(Math.hypot(cell.ix*64+32-c.x,cell.iz*64+32-c.z)>Rn*1.25+64)fol.cells.delete(key)}
 fol.q.sort((a,b)=>a[0]-b[0]);fol.fq.length=0;const rf=Math.ceil(Q.Rf/128),fx=Math.floor(c.x/128),fz=Math.floor(c.z/128),lim=Q.Rf,half=OW.P.size/2;
 for(let j=fz-rf;j<=fz+rf;j++)for(let i=fx-rf;i<=fx+rf;i++){const d=Math.hypot(i*128+64-c.x,j*128+64-c.z);if(d>lim||d<Math.min(Q.Rc,Q.Rs,Q.Rr,Q.Rt)+32||Math.abs(i*128+64)>half||Math.abs(j*128+64)>half)continue;const key=ckey(i,j);let cell=fol.far.get(key);if(!cell){cell={fx:i,fz:j,done:false,list:[]};fol.far.set(key,cell)}if(!cell.done)fol.fq.push([d,cell])}
 for(const[key,cell]of fol.far){if(Math.hypot(cell.fx*128+64-c.x,cell.fz*128+64-c.z)>lim*1.2+128)fol.far.delete(key)}fol.fq.sort((a,b)=>a[0]-b[0]);fol.lastX=c.x;fol.lastZ=c.z;fol.dirty=true;fol.farDirty=true}
function folGen(budget,farBudget){let t0=performance.now(),n=0;while(fol.q.length&&performance.now()-t0<budget){const it=fol.q[0],cell=it[1];
  if(it[2]&&!cell.gDone){if(!cell.gIt)cell.gIt=genGroundG(cell);let r;do{r=cell.gIt.next()}while(!r.done&&performance.now()-t0<budget);if(!r.done)break;cell.gIt=null}
  it[2]=false;if(it[3]&&!cell.tDone){if(!treePrep(cell))continue;genTrees(cell);it[3]=false}fol.q.shift();fol.dirty=true;n++}
 t0=performance.now();while(fol.fq.length&&performance.now()-t0<farBudget){const cell=fol.fq[0][1];if(cell.done){fol.fq.shift();continue}if(!cell.farJob)cell.farJob=genFarCellG(cell);let result;do{result=cell.farJob.next()}while(!result.done&&performance.now()-t0<farBudget);if(!result.done)break;cell.farJob=null;fol.fq.shift();fol.farDirty=true;n++}return n}
function folRebuild(){owUpdateViewFrustum();const Q=QS[OW.Q],cp=owCam;for(const k of fol.kinds){const K=KIND[k];if(!K)continue;const cat=CATK(k),R=(cat==='c'?Q.Rc:cat==='s'?Q.Rs:cat==='r'?Q.Rr:Q.Rt)+45,arr=[];
  for(const cell of fol.cells.values()){if(cat==='t'?!cell.tDone:!cell.gDone)continue;if(Math.hypot(cell.ix*64+32-cp.x,cell.iz*64+32-cp.z)>R)continue;const l=cell.k[k];if(l)for(const item of l)if(owInstanceInView(item,k,K,false))arr.push(item)}
  if(arr.length>K.max)arr.length=K.max;const sg=arr.length*131+(arr.length?arr[0].x*7+arr[arr.length-1].z*3:0);if(fol.sig[k]===sg)continue;fol.sig[k]=sg;K.list=arr;if(!fol.syncQ.includes(k))fol.syncQ.push(k)}
 fol.dirty=false;fol.lastBuild=performance.now()}
function folTick(budget){const c=owCam,P=OW.fp||(OW.fp={});let t=performance.now();owUpdateViewFrustum();const moved=Math.hypot(c.x-fol.lastX,c.z-fol.lastZ)>18,turned=!fol.viewReady||fol.lastViewDir.dot(owViewDir)<.985;if(moved)folPlan();else if(turned){fol.lastViewDir.copy(owViewDir);fol.viewReady=true;fol.sig={};fol.viewPending=true;fol.lastBuild=0;fol.dirty=fol.farDirty=true}P.plan=performance.now()-t;t=performance.now();folGen(budget,budget*.5);P.gen=performance.now()-t;const now=performance.now();t=now;
 if(fol.dirty&&(fol.viewPending||now-fol.lastBuild>250&&(fol.q.length<4||now-fol.lastBuild>1200)))folRebuild();P.reb=performance.now()-t;
 if(fol.syncQ.length){const k=fol.syncQ.shift();try{sync(k)}catch(e){console.warn('OW sync',k,e)}}
 t=performance.now();if(fol.farDirty&&(fol.viewPending||now-fol.lastBuild>60&&fol.fq.length<3)){rebuildFar();fol.farDirty=false}P.far=performance.now()-t;if(!fol.dirty&&!fol.farDirty)fol.viewPending=false}

/* ================= Part 4 — enter / exit, isolated settings, explore, UI ================= */
const kcSave=()=>{const o={};for(const k in KIND){const K=KIND[k];o[k]={size:K.size,vr:K.vr,tint:K.tint.slice()}}return o},kcLoad=o=>{for(const k in o){const K=KIND[k];if(!K)continue;K.size=o[k].size;K.vr=o[k].vr;K.tint=o[k].tint.slice()}};
function ctxSave(){return{A:captureStudioSettings(),exp:ren.toneMappingExposure,SAFE:Object.assign({},SAFE),shQ,pxQ,det:DET.value,lf:lodFullDistance,detail,smooth:smoothPreviewAuto,kc:kcSave(),biome,season}}
function ctxLoad(c){restoreStudioSettings(c.A);ren.toneMappingExposure=c.exp;const gOld=SAFE.ground;Object.assign(SAFE,c.SAFE);if(gOld!==SAFE.ground){if(SAFE.ground){tm.onBeforeCompile=()=>{};tm.customProgramCacheKey=()=>'plainT'}else injectDetail(tm,false);tm.needsUpdate=true}
 if(shQ!==c.shQ){shQ=c.shQ;sun.shadow.mapSize.set(shQ,shQ);if(sun.shadow.map){sun.shadow.map.dispose();sun.shadow.map=null}}
 pxQ=c.pxQ;DET.value=c.det;lodFullDistance=c.lf;lodPending=true;lodIndex=0;smoothPreviewAuto=c.smooth;adaptiveScale=1;applyPreviewPixelRatio();if(c.detail!==detail)applyDetail(c.detail);kcLoad(c.kc);biome=c.biome;season=c.season;
 waterReflectionReady=false;sun.shadow.needsUpdate=true;updSky()}
const owEls={};
function owUI(){const css=document.createElement('style');css.textContent='#owBack{position:fixed;z-index:12;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 46px);padding:7px 14px;border-radius:999px;border:1px solid var(--ln);background:var(--pn);color:var(--ink);font:600 12px system-ui;display:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}#owHud{position:fixed;z-index:11;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 80px);padding:4px 10px;border-radius:9px;background:rgba(0,0,0,.5);color:#fff;font:11px system-ui;display:none;pointer-events:none;white-space:nowrap}#owLoad{position:fixed;inset:0;z-index:30;background:rgba(10,16,24,.82);color:#fff;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;font:14px system-ui}#owLoad .bar{width:min(300px,70vw);height:6px;border-radius:9px;background:rgba(255,255,255,.18);overflow:hidden}#owLoad .bar i{display:block;height:100%;width:0;background:#3ddc97;transition:width .2s}';document.head.appendChild(css);
 owEls.hud=el('<div id="owHud"></div>');owEls.load=el('<div id="owLoad"><div id="owLt">Open World</div><div class="bar"><i id="owLb"></i></div><div id="owLs" style="font-size:12px;opacity:.75"></div></div>');
 document.body.append(owEls.hud,owEls.load)}
function owLoad(msg,p,sub){owEls.load.style.display='flex';document.getElementById('owLt').textContent=msg;document.getElementById('owLb').style.width=Math.round(cl(p,0,1)*100)+'%';document.getElementById('owLs').textContent=sub||'';OW.info=msg}
const owLoadHide=()=>{owEls.load.style.display='none'};
function owKinds(){const set=new Set(['grass','tallgrass','flower','daisy','tulip','lavender','rock']),bs=OW.P.biome==='mixed'?BKEY:[OW.P.biome];for(const b of bs)for(const[k]of(BTAB[b]||[]))set.add(k);return[...set]}
async function owBuildWorld(){const P=OW.P;OW.ready=false;OWM.configure(Object.assign({},P));owLoad('Generating world…',0,'terrain, rivers, lakes');
 const gen=OWM.generate();let t0=performance.now(),done=false;while(!done){const r=gen.next();if(r.done)done=true;else if(performance.now()-t0>10){owLoad('Generating world…',r.value*.45,'terrain, rivers, lakes');await owWait();t0=performance.now()}}
 const S=OWM.S;OW.spawn={x:S.spawn.x,z:S.spawn.z};OW.spawn.y=OWM.height(OW.spawn.x,OW.spawn.z);
 owBuildTabs();OW.kinds=fol.kinds=owKinds();let i=0;for(const k of OW.kinds){owLoad('Preparing plants…',.45+.2*(i++/OW.kinds.length),LBL[k]||k);owEnsureSpecies(k);await owWait()}
 owLoad('Building water…',.66,'');owInitTiles();OW.ready=true;owBuildWater();folClear();owEnsureFar();fol.kinds=OW.kinds;OW.P.half=OWM.P.half;
 if(!OW.def)return;SEAW.cx=SEAW.cz=1e9;SEAW.row=-1;
 const sp=OW.spawn,gy=sp.y;oc.target.set(sp.x,gy+1,sp.z);cam.position.set(sp.x+55,gy+34,sp.z+75);cam.up.set(0,1,0);oc.update();owCamUpdate();
 owLoad('Building terrain…',.7,'');let spin=0;while(spin++<900){await owWait();const pend=(wantQ.length||0)+fol.q.length+fol.fq.length+fol.syncQ.length;const built=ownodes.filter(n=>n.built).length;owLoad('Building terrain & plants…',.7+.29*Math.min(1,spin/60),built+' tiles · '+pend+' queued');if(spin>12&&pend===0&&drawn.length>0&&fol.cells.size>0&&fol.syncQ.length===0&&!fol.farDirty)break}
 owLoadHide()}
function owSaveDefault(){const d={ctx:ctxSave(),vis:new Map(),lists:{},meshParents:[],cam:{p:cam.position.clone(),t:oc.target.clone(),u:cam.up.clone(),near:cam.near,far:cam.far,minD:oc.minDistance,maxD:oc.maxDistance,q:cam.quaternion.clone()},tab,nav,bt,wl,wpos:water.position.clone(),skyRO:sky.renderOrder,skyDT:sky.material.depthTest,wv:water.visible,mode};
 const hide=o=>{if(o&&!d.vis.has(o)){d.vis.set(o,o.visible);o.visible=false}};[ter,SBM,pitIM,debIM,grid,sbx,ring,torGrp,tc,window.__defaultOpenWorldGroup,...objs].forEach(hide);if(mapRoot)hide(mapRoot);for(const o of TERRAIN_EDITOR_HELPERS)hide(o);
 for(const k in KIND){d.lists[k]=KIND[k].list;KIND[k].list=[]}OW.def=d;owAdoptKMeshes()}
async function owEnter(){if(OW.busy)return;OW.busy=true;owEls.load.style.display='flex';
 try{if(!OW.active){if(exploreMode)deactivateExplore(false);closeExploreSheet();if(typeof PLANON!=='undefined'&&PLANON)planetExit();select(null);try{torStop();tsuReset()}catch(e){}debClear();
   owSaveDefault();for(const k in KIND)window.sync(k);OW.active=true;OW.root.visible=true;
   if(OW.ctx)ctxLoad(OW.ctx);else{fogD=.0006;biome=OW.P.biome==='mixed'?'hills':OW.P.biome==='alpine'||BIO[OW.P.biome]?OW.P.biome:'hills';if(KIND.grass)KIND.grass.tint=kt('grass')}fogD=Math.min(Number.isFinite(fogD)?fogD:.00035,.00035);updSky();
   wl=OW.P.sea;water.position.set(0,wl,0);water.visible=true;U.uOW.value=1;owSeaFar.visible=true;SBM.visible=false;
   cam.near=.5;cam.far=16000;cam.updateProjectionMatrix();oc.minDistance=1;oc.maxDistance=20000;sky.renderOrder=-1000;sky.material.depthTest=false;
   lodFullDistance=QS[OW.Q].lf;lodPending=true;lodIndex=0;owEls.hud.style.display='block';owTabs()}
  await owBuildWorld();updSky();setTab('openworld')}
 catch(e){console.error(e);showErr('Open World: '+(e.stack||e.message));owLoadHide();if(OW.def){OW.active=true;OW.root.visible=true;OW.busy=false;await owExit()}}
 OW.busy=false;OW.pending=false}
async function owRegen(){if(OW.busy||!OW.active)return;OW.busy=true;try{OW.ready=false;if(exploreMode)deactivateExplore(false);owDisposeAllTiles();owDisposeWater();folClear();for(const k in KIND)window.sync(k);wl=OW.P.sea;water.position.y=wl;await owBuildWorld();updSky();setTab('openworld')}catch(e){console.error(e);showErr('Open World: '+(e.stack||e.message));owLoadHide()}OW.busy=false;OW.pending=false}
async function owExit(){if(!OW.active||OW.busy)return;OW.busy=true;const d=OW.def;try{if(exploreMode)deactivateExplore(false);closeExploreSheet();OW.ctx=ctxSave();
  OW.ready=false;OW.active=false;OW.root.visible=false;owSeaFar.visible=false;U.uOW.value=0;U.uSeaC.value.set(0,0);sky.position.set(0,0,0);sky.renderOrder=d.skyRO;sky.material.depthTest=d.skyDT;
  owDisposeAllTiles();owDisposeWater();folClear();for(const k in KIND)KIND[k].list=d.lists[k]||[];
  ctxLoad(d.ctx);owRestoreKMeshes(d);water.position.copy(d.wpos);wl=d.wl;water.position.y=wl;water.visible=d.wv;for(const[o,v]of d.vis)o.visible=v;
  cam.near=d.cam.near;cam.far=d.cam.far;cam.up.copy(d.cam.u);cam.updateProjectionMatrix();oc.minDistance=d.cam.minD;oc.maxDistance=d.cam.maxD;cam.position.copy(d.cam.p);oc.target.copy(d.cam.t);oc.update();
  buildSeabed();for(const k in KIND)_sync(k);occRebuild();debClear();treeMapDirty=true;owEls.hud.style.display='none';OW.def=null;owTabs();tab='terrain';nav=false;bt='terrain';setTab('terrain');shade()}
 catch(e){console.error(e);showErr('Open World exit: '+(e.stack||e.message))}OW.busy=false}
/* ---------- per-frame work ---------- */
function owFrame(){if(!OW.active||!OW.root)return;owCamUpdate();owUpdateViewFrustum();const c=owCam;sky.position.copy(c);rU.uCenter.value.copy(c);sU.uCenter.value.copy(c);
 if(OW.ready){forestImpostors.setLodDistance(Math.max(QS[OW.Q].Rt+160,500),owCam);if(forestImpostors.bake(ren)||forestImpostors.stats.selectionUpdated){fol.farDirty=true;forestImpostors.stats.selectionUpdated=false;}owUpdateViewFrustum();const b=OW.busy,P=OW.prof||(OW.prof={}),t0=performance.now();owTiles(b?34:4);const t1=performance.now();folTick(b?30:3);const t2=performance.now();owSeaStep(b?60:10);const t3=performance.now();P.tiles=t1-t0;P.fol=t2-t1;P.sea=t3-t2}
 if((owFrameNo&7)===0&&OW.ready){const g=owHgt(c.x,c.z);owEls.hud.textContent='X '+Math.round(c.x)+'  Z '+Math.round(c.z)+'  ·  alt '+Math.round(c.y-g)+' m above ground  ·  '+Math.round(g)+' m elevation  ·  '+drawn.length+' tiles · '+forestImpostors.stats.instances+' tree cards'+(forestImpostors.stats.cppWorker?' · C++ worker':'' )}}
{const r=ren.render;ren.render=function(s,c,...a){if(s===scene&&c===cam&&OW.active){try{owFrame()}catch(e){if(!OW.err){OW.err=1;showErr('Open World: '+(e.stack||e.message))}}}return r.call(this,s,c,...a)}}
/* ---------- shadows, helpers, weather limits ---------- */
{const f=window.updateDirectionalShadowFocus;window.updateDirectionalShadowFocus=function(now=performance.now()){if(!(OW.active&&OW.ready))return f(now);if(now-shadowFocusAt<220)return;shadowFocusAt=now;const c=exploreMode?owCamUpdate():oc.target,fx=c.x,fz=c.z,fy=owHgt(fx,fz),radius=90;
  if(Math.abs(fx-shadowFocusX)<2&&Math.abs(fz-shadowFocusZ)<2&&Math.abs(fy-shadowFocusY)<2&&radius===shadowFocusRadius)return;shadowFocusX=fx;shadowFocusY=fy;shadowFocusZ=fz;shadowFocusRadius=radius;sun.target.position.set(fx,fy,fz);sun.position.copy(U.sd.value).multiplyScalar(160).add(sun.target.position);sun.target.updateMatrixWorld(true);sun.updateMatrixWorld(true);sc.left=sc.bottom=-radius;sc.right=sc.top=radius;sc.near=1;sc.far=360;sc.updateProjectionMatrix()}}
{const u=window.updSky;window.updSky=function(){u();if(OW.active){for(const o of TERRAIN_EDITOR_HELPERS)o.visible=false}}}
{const s=window.shade;window.shade=function(){s();if(owTerrainMat)owTerrainMat.wireframe=mode=='wire'}}
{const t=window.torSpawn,l=window.tsuLaunch,n=()=>msg('Tornado and tsunami are only available on the default terrain.');window.torSpawn=function(){if(OW.active)return n();return t()};window.tsuLaunch=function(){if(OW.active)return n();return l()}}
/* ---------- Explore Mode on the open world ---------- */
const OWX={mul:2.2};
const owWL=(x,z)=>Math.max(water.position.y,OWM.waterLevel(x,z));
function owDry(x,z){for(let r=0;r<400;r+=6)for(let a=0;a<6.283;a+=.5){const px=x+Math.cos(a)*r,pz=z+Math.sin(a)*r,h=owHgt(px,pz);if(h>owWL(px,pz)+.25&&slope(px,pz)<1.1)return{x:px,z:pz,y:h}}return{x,z,y:owHgt(x,z)}}
{const f=window.findExploreSpawn;window.findExploreSpawn=function(){if(!(OW.active&&OW.ready))return f();const c=owCamUpdate();const o=OW.spawn&&exploreTab==='first'?owDry(OW.spawn.x,OW.spawn.z):owDry(c.x,c.z);return o}}
{const f=window.updateExplore;window.updateExplore=function(dt){if(!(OW.active&&OW.ready))return f(dt);if(!exploreMode)return;dt=exClamp(dt,0,.05);const lim=OW.P.size*.485,M=OWX.mul;
 if(exploreMode==='first'){if(!walkRig)return;const p=walkRig.position;let groundY=owHgt(p.x,p.z),waterLevel=owWL(p.x,p.z),inWater=water.visible&&groundY<waterLevel-.08;const forward=-joyY,side=joyX,speed=(inWater?2.65:3.6)*M,dx=(-Math.sin(exploreYaw)*forward+Math.cos(exploreYaw)*side)*speed*dt,dz=(-Math.cos(exploreYaw)*forward-Math.sin(exploreYaw)*side)*speed*dt,nx=exClamp(p.x+dx,-lim,lim),nz=exClamp(p.z+dz,-lim,lim),nextGround=owHgt(nx,nz),nWL=owWL(nx,nz),nextWater=water.visible&&nextGround<nWL-.08,stepUp=nextGround-p.y;
  if(canExploreMove(inWater,nextWater,water.visible,nextGround,nWL,stepUp,slope(nx,nz))){p.x=nx;p.z=nz}groundY=owHgt(p.x,p.z);waterLevel=owWL(p.x,p.z);inWater=water.visible&&groundY<waterLevel-.08;if(inWater)walkJumping=false;
  [p.y,walkVelocityY]=stepExploreVertical(p.y,walkVelocityY,groundY,waterLevel,inWater,dt,gravityEnabled||walkJumping,gravityEnabled?gravityStrength:9.8);if(!inWater&&walkJumping&&p.y<=groundY+.001&&walkVelocityY<=0)walkJumping=false;walkRig.rotation.y=exploreYaw;cam.rotation.order='YXZ';cam.rotation.set(explorePitch,0,0,'YXZ');return}
 const forward=(exploreKeys.has('w')||exploreKeys.has('arrowup')?1:0)-(exploreKeys.has('s')||exploreKeys.has('arrowdown')?1:0)-joyY,turn=exClamp((exploreKeys.has('arrowright')||exploreKeys.has('d')?1:0)-(exploreKeys.has('arrowleft')||exploreKeys.has('a')?1:0)+joyX,-1,1);heliYaw-=turn*dt*1.15;
 const viewYaw=heliYaw+exploreYaw,tvx=-Math.sin(viewYaw)*forward*heliSpeed*M,tvz=-Math.cos(viewYaw)*forward*heliSpeed*M,k=1-Math.exp(-3.2*dt);heliVelocityX+=(tvx-heliVelocityX)*k;heliVelocityZ+=(tvz-heliVelocityZ)*k;const ox=heliX,oz=heliZ;heliX=exClamp(heliX+heliVelocityX*dt,-lim,lim);heliZ=exClamp(heliZ+heliVelocityZ*dt,-lim,lim);if(heliX!==ox+heliVelocityX*dt)heliVelocityX=0;if(heliZ!==oz+heliVelocityZ*dt)heliVelocityZ=0;
 const ty=Math.max(owHgt(heliX,heliZ),wl)+heliAltitude;heliY+=(ty-heliY)*(1-Math.exp(-2.2*dt));cam.position.set(heliX,heliY+1.55,heliZ);cam.up.set(0,1,0);cam.rotation.order='YXZ';cam.rotation.set(explorePitch,viewYaw,0,'YXZ');cam.updateMatrixWorld(true)}}
/* ---------- UI ---------- */
const OWT_HIDE=['terrain','planet','city','obj','import'];
function owTabs(){[...document.getElementById('tabs').children].forEach(b=>{const id=b.dataset.id;b.style.display=OW.active&&OWT_HIDE.includes(id)?'none':'';if(id==='plants')b.lastChild.textContent='Foliage'})}
{const f=window.setTab;window.setTab=function(id){if(OW.active&&OWT_HIDE.includes(id))id='openworld';f(id);if(OW.active){bt='openworld';nav=true;setNav()}owTabs()}}
{const f=window.showPanel;window.showPanel=function(v){f(v);if(OW.active&&(tab==='terrain'||tab==='plants'||tab==='city')){bt='openworld';nav=true;setNav()}}}
const hint=t=>el('<div class="hint">'+t+'</div>'),setP=(k,v)=>{OW.P[k]=v;if(OW.active)OW.pending=true};
let rsT=0;const restreamSoon=()=>{clearTimeout(rsT);rsT=setTimeout(owRestream,400)};
function owRestream(){if(!OW.active||!OW.ready)return;folClear();fol.kinds=OW.kinds;owClearFar()}
const statTxt=()=>{const S=OWM.S;if(!S||!S.rv)return'';return'World '+(OW.P.size/1000).toFixed(1)+' km × '+(OW.P.size/1000).toFixed(1)+' km · '+S.rv.length+' rivers · '+S.lk.filter(l=>l.tag==='lake').length+' lakes · '+S.lk.filter(l=>l.tag==='pond').length+' ponds · '+S.falls.length+' waterfalls'};
PN.openworld=()=>{const o=[],act=OW.active,P=OW.P;
 o.push(hint('Open World builds a separate procedural map many times larger than the default terrain: continents, biomes, rivers, lakes, ponds, waterfalls and streamed foliage. The default terrain is untouched and you can return to it any time. Lighting, Sky, Weather, Water, Quality and Foliage edits made here stay in this world only.'));
 o.push(el('<div id="owinfo" class="hint" style="color:var(--ink)">'+(act&&OW.ready?statTxt():OW.info)+(OW.pending?'  — settings changed: press Regenerate to apply.':'')+'</div>'));
 o.push(chips(act?[['regen','🔄 Regenerate with these settings'],['back','⬅ Return to default terrain']]:[['go','🌍 Generate & enter open world']],0,v=>{if(v==='go')owEnter();else if(v==='regen')owRegen();else owExit()}));
 o.push(hint('World size'),chips([[2048,'2 km'],[4096,'4 km'],[8192,'8 km'],[16384,'16 km']],P.size,v=>setP('size',v)));
 o.push(hint('Biome'),chips([['mixed','🌍 Mixed'],['hills','🌿 Hills'],['alpine','🏔 Alpine'],['desert','🏜 Desert'],['volc','🌋 Volcanic'],['jungle','🌴 Jungle'],['taiga','🌲 Taiga'],['tundra','❄ Tundra']],P.biome,v=>setP('biome',v)));
 o.push(G(sl('Seed',1,9999,1,P.seed,v=>setP('seed',v)),sl('Land amount',-1,1,.05,P.land,v=>setP('land',v)),sl('Mountain height',0,2.2,.05,P.mount,v=>setP('mount',v)),sl('Hills relief',0,2,.05,P.relief,v=>setP('relief',v)),sl('Surface roughness',0,2,.05,P.rough,v=>setP('rough',v)),sl('Sea level (m)',-30,30,1,P.sea,v=>setP('sea',v)),sl('Snow line offset (m)',-250,250,10,P.snowOff,v=>setP('snowOff',v))));
 o.push(chips([['seed','🎲 Random seed']],0,()=>{P.seed=1+Math.floor(Math.random()*9998);if(act)OW.pending=true}));
 o.push(hint('Rivers, lakes, ponds and waterfalls'),G(sl('Rivers',0,14,1,P.rivers,v=>setP('rivers',v)),sl('River width ×',.5,2.5,.05,P.riverW,v=>setP('riverW',v)),sl('Lakes',0,10,1,P.lakes,v=>setP('lakes',v)),sl('Lake & pond size ×',.5,2.5,.05,P.lakeSize,v=>setP('lakeSize',v)),sl('Ponds',0,40,1,P.ponds,v=>setP('ponds',v)),sl('Waterfalls',0,10,1,P.falls,v=>setP('falls',v)),sl('Waterfall height ×',.5,2,.05,P.fallH,v=>setP('fallH',v))));
 if(owWMat)o.push(hint('River & lake colour (live)'),G(waterColorField('Shallow',owWMat.uniforms.uWShal),waterColorField('Deep',owWMat.uniforms.uWDeep)));
 o.push(hint('Explore'),G(sl('Walk / fly speed ×',1,8,.1,OWX.mul,v=>{OWX.mul=v})),hint('Use the Explore Mode button below (walk or free flight). Rivers and lakes are swimmable.'));
 return o};
{const f=PN.plants;PN.plants=()=>{if(!OW.active)return f();const o=[],D=OW.dens,k=OW.fk,K=KIND[k]||{};
 o.push(hint('Foliage in the open world streams around you (grass, flowers, shrubs, rocks and trees near; a lightweight forest to the horizon). These settings belong to this world only.'));
 o.push(G(sl('Grass & cover density ×',0,2.5,.05,D.cover,v=>{D.cover=v;restreamSoon()}),sl('Flowers ×',0,2.5,.05,D.flowers,v=>{D.flowers=v;restreamSoon()}),sl('Shrubs ×',0,2.5,.05,D.shrubs,v=>{D.shrubs=v;restreamSoon()}),sl('Trees ×',0,2.5,.05,D.trees,v=>{D.trees=v;restreamSoon()}),sl('Rocks ×',0,3,.05,D.rocks,v=>{D.rocks=v;restreamSoon()})));
 o.push(hint('Species'),chips(OW.kinds.map(q=>[q,LBL[q]||q]),k,v=>{OW.fk=v}));
 if(KIND[k]){const t=el('<label class="sl"><span>Tint</span><input type="color"><output></output></label>'),i=t.children[1];i.value='#'+new THREE.Color(...K.tint.map(v=>cl(v,0,1))).getHexString();i.oninput=()=>{const c=new THREE.Color(i.value);K.tint=[c.r,c.g,c.b];sync(k)};
  o.push(G(sl('Size ×',.3,3,.05,K.size,v=>{K.size=v;sync(k)}),sl('Variation',0,.9,.05,K.vr,v=>{K.vr=v;restreamSoon()}),t,sl('Wind',0,3,.1,windUser,v=>windUser=v)))}
 o.push(chips([['spring','🌱 Spring'],['summer','☀️ Summer'],['autumn','🍂 Autumn'],['winter','❄️ Winter']],season,setSeason));
 o.push(btn('🌱 Re-scatter (new random layout)',()=>{OW.salt=(OW.salt|0)+1;owRestream()}));return o}}
{const f=PN.quality;PN.quality=()=>{const a=f();if(!OW.active)return a;return[hint('Open World streaming quality (view distance, tile detail, plant radius)'),chips(QS.map((q,i)=>[i,q.n]),OW.Q,v=>{OW.Q=v;owQ=QS[v];lodFullDistance=QS[v].lf;lodPending=true;lodIndex=0;owRestream()}),...a]}}
{const f=PN.weather;PN.weather=()=>{const a=f();if(!OW.active)return a;const i=a.findIndex(n=>n.textContent==='Tornado');const o=i<0?a:a.slice(0,i);o.push(hint('Tornado and tsunami are only available on the default terrain.'));return o}}
{const f=PN.terrain;PN.terrain=()=>f()}
/* ---------- init ---------- */
(function init(){try{
 if(typeof OWM==='undefined')throw new Error('world model missing');
 OW.root=new THREE.Group();OW.root.name='Open World';OW.root.visible=false;scene.add(OW.root);owUI();owPatchWater();owBuildTabs();owTabs();
 OW.Q=cl(detail,0,3);owQ=QS[OW.Q];
 window.OW_API={forestImpostors,owWaterMat,genGround,genTrees,genFarCell,owBuildNode,folRebuild,folPlan,owMkNode,owColor,candsOf,treeAcc,owEnter,owExit,owRegen,owFrame,QS,fol,OWM,OW,owHgt,owTiles,drawn,ownodes,refreshFar:()=>{if(OW.active){owAdoptKMeshes();fol.farDirty=true;fol.lastBuild=0;rebuildFar()}},owTerrainMat:()=>owTerrainMat,owWMeshes,PNopen:()=>PN.openworld()};if(tab==='openworld')build();console.log('Open World add-on ready')}catch(e){console.error(e);showErr('Open World add-on failed to start: '+(e.stack||e.message))}})();

})();
