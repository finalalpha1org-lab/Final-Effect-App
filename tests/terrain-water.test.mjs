import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');
const fftSource=readFileSync(new URL('../src/tessendorf-ocean.mjs',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m=>m[1]).filter(s=>s.trim());

test('terrain page inline JavaScript parses after PBR water migration',()=>{
  assert.ok(scripts.length>0);
  for(const [index,source] of scripts.entries()){let parseError=null;try{new vm.Script(source,{filename:`terrain-inline-${index}.js`})}catch(error){parseError=error}assert.equal(parseError,null,parseError?.stack||`inline script ${index} syntax`)}
});

test('ocean, lagoon and murky profiles have independent color, wave and optical controls',()=>{
  const start=html.indexOf('const WATER_PROFILES=['),end=html.indexOf('function setWater(',start),block=html.slice(start,end);
  for(const name of ['Ocean','Lagoon','Murky'])assert.ok(block.includes(`name:'${name}'`));
  assert.match(block,/clarity:[^,]+,height:[^,]+,scale:[^,]+,speed:[^,]+,period:[^,]+/);
  assert.match(block,/roughness:[^,]+,reflect:[^,]+,refraction:[^,]+,turbidity:[^,]+/);
  assert.match(block,/foam:[^,]+,threshold:[^,]+,shore:[^,]+,wind:[^,]+,direction:[^}]+/);
  const profiles=new Function(`${block};return WATER_PROFILES`)(),distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  assert.ok(distance(profiles[0].deep,profiles[2].deep)>.12,'murky water must not inherit the ocean tint');
  assert.ok(distance(profiles[0].shallow,profiles[1].shallow)>.25,'lagoon water should visibly read as turquoise and shallow');
  assert.ok(profiles[2].roughness>profiles[0].roughness&&profiles[2].transparency<profiles[0].transparency&&profiles[2].turbidity>profiles[0].turbidity);
});

test('terrain water is shader-displaced on a MeshPhysicalMaterial with depth tint and dynamic reflections',()=>{
  assert.match(html,/new THREE\.MeshPhysicalMaterial/);
  assert.match(html,/waterMat\.onBeforeCompile=/);
  assert.match(html,/uniform vec3 uTurbidColor,deep,shal/);
  assert.match(html,/transmission:Math\.max/);
  assert.match(html,/transformed\.y\+=waterWave\*amp\*waterFade/);
  assert.match(html,/float waterDepth=max\(wy\+tsH\(w\.xz\)-th\(w\.xz\),0\.\)/);
  assert.match(html,/new THREE\.CubeCamera/);
  assert.match(html,/water\.visible=false/);
  assert.match(html,/waterReflectionCam\.update\(ren,scene\)/);
  assert.match(html,/waterMat\.envMap=waterReflectionRT\.texture/);
  assert.match(html,/\{inner:\[320,160\],far:\[320,64\],reflection:128,interval:90/,'mobile uses a bounded, low-frequency reflection capture instead of disabling water reflections');
  const probe=html.slice(html.indexOf('function updateWaterReflection()'),html.indexOf('const WATER_PROFILES=['));
  assert.doesNotMatch(probe,/waterQuality===0/,'mobile water still receives the low-resolution environment reflection');
  assert.match(html,/waterReflectionFailed=true;waterReflectionRetryAt=performance\.now\(\)\+3000;if\(waterMat\.envMap!==null\)\{waterMat\.envMap=null;waterMat\.needsUpdate=true\}/,'a probe failure briefly falls back to Fresnel and retries later without spamming a red banner');
  assert.doesNotMatch(html,/showErr\('Water reflection probe failed/);
  assert.ok(html.includes('varying vec3 waterWorldNormal'));
  assert.ok(html.includes('waveNoise(w.xz*waterTriScale'));
  assert.ok(html.includes('waterTriW=pow(abs(normalize(waterWorldNormal)),vec3(4.))'));
  assert.ok(html.includes('waterMicroNormal'));
  assert.ok(html.includes("terrain-water-pbr-v4-triplanar-fft"));
});

test('ocean vertex displacement is driven by three Tessendorf inverse-FFT cascades',()=>{
  assert.ok(html.includes('TessendorfOceanBundle.TessendorfOcean'));
  assert.ok(html.includes('Phillips wind spectrum, gravity dispersion'));
  assert.ok(html.includes('uniform highp sampler2D hm,hm2,uFFT0,uFFT1,uFFT2'));
  assert.ok(html.includes('fftHeight(texture2D(uFFT0')&&html.includes('fftHeight(texture2D(uFFT1')&&html.includes('fftHeight(texture2D(uFFT2'));
  assert.ok(html.includes('transformed.xz+=waterHorizontal*amp*uChop*waterFade'));
  assert.ok(fftSource.includes('Math.sqrt(GRAVITY * k)'),'spectral frequencies should follow deep-water gravity dispersion');
  assert.ok(fftSource.includes('ifft2D(hr, hi, n)')&&fftSource.includes('ifft2D(xr, xi, n)')&&fftSource.includes('ifft2D(zr, zi, n)'),'height and horizontal displacement must come from inverse FFTs');
  assert.ok(html.includes('const FFT_LENGTHS=[256,1024,4096]'),'three spatial scales should reduce visible short-period tiling');
  assert.ok(!html.includes('waveCount=N>6?11.:3.'),'legacy Gerstner sine-stack must not remain the primary ocean solver');
});

test('water reflection probe renders into the exact cubemap sampled by the material and remains stable through zoom',()=>{
  assert.match(html,/const restoreReflectionScene=beginWaterReflectionCapture\(\),rx=exploreMode\?cam\.position\.x:oc\.target\.x,rz=exploreMode\?cam\.position\.z:oc\.target\.z;waterReflectionCam\.position\.set\(rx,water\.position\.y\+\.15,rz\)/,'OrbitControls zoom must not drag the cubemap probe around with the camera dolly, and the probe must capture only the procedural world');
  assert.match(html,/let waterReflectionRT=makeWaterReflectionTarget\(\)/);
  assert.match(html,/new THREE\.CubeCamera\(\.1,1600,waterReflectionRT\)/,'the capture must write to the texture sampled by the water material');
  assert.match(html,/waterReflectionCam\.renderTarget=waterReflectionRT/);
  assert.doesNotMatch(html,/waterReflectionWorkRT/,'do not capture into a buffer that the water never samples');
  assert.match(html,/waterReflectionViewAnchor/);
  assert.match(html,/now-waterReflectionViewMovedAt<350/,'reflection capture waits until the camera has stopped moving');
  assert.match(html,/waterReflectionFailed&&performance\.now\(\)<waterReflectionRetryAt/,'a transient capture error should use fallback briefly, not permanently disable reflections');
  assert.match(html,/waterReflectionRetryAt=performance\.now\(\)\+3000/);
  assert.match(html,/waterReflectionReady=true;waterReflectionFailed=false;waterReflectionRetryAt=0/);
  assert.match(html,/waterMat\.envMap=waterReflectionRT\.texture/);
});

test('reflection capture keeps procedural terrain, sky, lights and flora but restores/hides unrelated scene objects',()=>{
  const start=html.indexOf('function beginWaterReflectionCapture()'),end=html.indexOf('function updateWaterReflection()',start);
  assert.ok(start>=0&&end>start,'reflection capture needs an explicit world-only visibility mask');
  const source=html.slice(start,end);
  const terrain={visible:true},sky={visible:true},sun={visible:true,target:{visible:true}},hemi={visible:true},envFill={visible:true},water={visible:true},waterReflectionCam={visible:true};
  const cloud={visible:true},grass={visible:true},rock={visible:true},helper={visible:true},userObject={visible:true},alreadyHidden={visible:false},mapRoot={visible:true};
  const manualTree={visible:true,userData:{n:'Pine'}},manualRock={visible:true,userData:{n:'Rock'}},house={visible:true,userData:{n:'House'}};
  const ctx={ter:terrain,sky,sun,hemi,envFill,water,waterReflectionCam,clouds:[cloud],mapRoot,objs:[manualTree,manualRock,house],U:{uNS:{value:1},uNM:{value:2},uNP:{value:3}},KIND:{grass:{meshes:[grass],lowMeshes:[],shadowMeshes:[]},rock:{meshes:[rock],lowMeshes:[],shadowMeshes:[]}},scene:{children:[terrain,sky,sun,sun.target,hemi,envFill,water,waterReflectionCam,cloud,grass,rock,helper,userObject,alreadyHidden,mapRoot,manualTree,manualRock,house]}};
  vm.runInNewContext(source+';this.begin=beginWaterReflectionCapture;',ctx);
  const restore=ctx.begin();assert.equal(water.visible,false);for(const o of [terrain,sky,sun,hemi,envFill,cloud,grass,rock,mapRoot,manualTree,manualRock])assert.equal(o.visible,true);for(const o of [helper,userObject,house])assert.equal(o.visible,false);assert.equal(alreadyHidden.visible,false);assert.deepEqual([ctx.U.uNS.value,ctx.U.uNM.value,ctx.U.uNP.value],[0,0,0]);
  restore();assert.equal(water.visible,true);for(const o of [helper,userObject,house])assert.equal(o.visible,true);assert.equal(alreadyHidden.visible,false);assert.deepEqual([ctx.U.uNS.value,ctx.U.uNM.value,ctx.U.uNP.value],[1,2,3]);
});

test('water keeps Fresnel/depth/foam and a dedicated reflection probe without a global material-darkening PMREM',()=>{
  assert.ok(html.includes('waterFresnel=.02+.98*pow(1.-clamp(waterNdotV,0.,1.),5.)'));
  assert.ok(!html.includes('skyReflectionTint=mix(hor,top'),'do not overlay a synthetic sky tint over the captured world');
  assert.ok(html.includes('reflectedLight.directSpecular*=.22'),'reduce the inaccurate direct-light hotspot while retaining the environment map');
  assert.ok(html.includes('waterDepth=max(wy+tsH(w.xz)-th(w.xz),0.)'));
  assert.ok(html.includes('waterMat.transmission=Math.max'));
  assert.ok(html.includes('function createShoreSpray()')&&html.includes('function updateShoreSpray(dt)'));
  assert.ok(html.includes('Ocean shoreline spray'));
  assert.ok(html.includes('new THREE.CubeCamera')&&html.includes('waterReflectionCam.update(ren,scene)'),'water retains its own live sky/scene reflections');
  assert.ok(html.includes('scene.environment=null')&&!html.includes('scene.environment=rt.texture'),'the lighting toggle must not install a dark global environment into every PBR material');
});

test('terrain surface uses PBR material and world-space triplanar albedo/roughness/AO detail',()=>{
  assert.ok(html.includes('function terrainDetailTex(kind)'));
  assert.ok(html.includes('new THREE.MeshStandardMaterial({vertexColors:true,roughness:.84,metalness:0'));
  assert.ok(html.includes('float triGray(sampler2D tex,vec3 p,vec3 w,float sc)'));
  for(const name of ['uTriGrass','uTriSoil','uTriRock','uTriSnow','uTriRough'])assert.ok(html.includes(name));
  assert.ok(html.includes('ambientOcclusion*=mix(.78,1.,clamp(tAO,.3,1.))'));
});

test('FFT cascades fade by footprint and water quality exposes a higher-resolution Ultra option',()=>{
  assert.ok(html.includes('float f0=1.-smoothstep(90.,420.,footprint),f1=1.-smoothstep(520.,1900.,footprint),f2=1.'));
  assert.match(html,/waterMat=new THREE\.MeshPhysicalMaterial\([^\n]*transparent:false[^\n]*depthWrite:true/);
  assert.ok(html.includes('ter.receiveShadow=true;ter.castShadow=false'),'terrain should receive object shadows without self-shadowing acne');
  assert.ok(html.includes('sun.shadow.bias=-.0002;sun.shadow.normalBias=.018'),'shadow acne near rock/root contact should be mitigated with depth/normal bias');
  assert.ok(html.includes('reflection:128,interval:90,transmission:.28'),'mobile reflections remain enabled at a low frequency and safe resolution');
  assert.ok(html.includes('{inner:[768,320],far:[640,128],reflection:192,interval:24,transmission:1}'));
  assert.ok(html.includes("[3,'Water: Ultra FFT']"));
  assert.ok(html.includes('FFT_RESOLUTION=[64,64,128,256]'));
});

test('terrain water has no WASM/SPH simulation path or particle-grid control',()=>{
  assert.doesNotMatch(html,/WATER_SIM|initWaterSPH|updateWaterSPH|sim_solver_sph_step|simulation_solver\.wasm|uSimTex/);
  assert.ok(html.includes('not a full Navier–Stokes/CFD solver or a guarantee of photographic realism'),'solver and rendering limits should remain explicit in the UI');
});
