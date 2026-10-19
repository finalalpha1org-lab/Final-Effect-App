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

test('water keeps Fresnel/depth/foam and a dedicated reflection probe without a global material-darkening PMREM',()=>{
  assert.ok(html.includes('waterFresnel=.02+.98*pow(1.-clamp(waterNdotV,0.,1.),5.)'));
  assert.ok(html.includes('skyReflectionTint=mix(hor,top'));
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
  assert.ok(html.includes('reflection:64,interval:60,transmission:.28'));
  assert.ok(html.includes('{inner:[768,320],far:[640,128],reflection:192,interval:24,transmission:1}'));
  assert.ok(html.includes("[3,'Water: Ultra FFT']"));
  assert.ok(html.includes('FFT_RESOLUTION=[64,64,128,256]'));
});

test('terrain water has no WASM/SPH simulation path or particle-grid control',()=>{
  assert.doesNotMatch(html,/WATER_SIM|initWaterSPH|updateWaterSPH|sim_solver_sph_step|simulation_solver\.wasm|uSimTex/);
  assert.ok(html.includes('not a full Navier–Stokes/CFD solver or a guarantee of photographic realism'),'solver and rendering limits should remain explicit in the UI');
});
