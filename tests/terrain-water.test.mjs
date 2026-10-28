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

test('water is one continuous mesh with a shared adaptive inner/far ring boundary',()=>{
  assert.match(html,/function makeWaterGeometry\(q\)/,'the high-detail inner and low-detail far radii must share one buffer geometry');
  assert.doesNotMatch(html,/const wOut=new THREE\.Mesh/,'do not render a separate far-field water mesh that can leave a visible join');
  assert.doesNotMatch(html,/water\.add\(wOut\)/);
  assert.match(html,/water\.geometry=makeWaterGeometry\(q\)/);
});

test('adaptive water buffer has exactly one shared vertex row at the near/far join',()=>{
  const start=html.indexOf('const WATER_QUALITY=['),end=html.indexOf('const WH=',start),code=html.slice(start,end);
  class Attribute{constructor(array,itemSize){this.array=array;this.itemSize=itemSize}}
  class Geometry{constructor(){this.attributes={}}setAttribute(name,value){this.attributes[name]=value}setIndex(value){this.index=value}computeBoundingBox(){}computeBoundingSphere(){}}
  const api=new Function('THREE',`${code};return{WATER_QUALITY,makeWaterGeometry}`)({BufferAttribute:Attribute,BufferGeometry:Geometry});
  for(let q=0;q<api.WATER_QUALITY.length;q++){
    const cfg=api.WATER_QUALITY[q],g=api.makeWaterGeometry(q),theta=cfg.inner[0],near=cfg.inner[1],far=cfg.far[1],row=theta+1;
    assert.equal(g.attributes.position.array.length/3,(near+far+1)*row,'there is one, not two, vertex rows at the radius-190 boundary');
    for(let i=0;i<row;i++){const p=(near*row+i)*3,x=g.attributes.position.array[p],z=g.attributes.position.array[p+2];assert.ok(Math.abs(Math.hypot(x,z)-190)<1e-3,'all join vertices lie on the exact shared circle')}
    assert.equal(g.index.array.length,(near+far)*theta*6);
    const pos=g.attributes.position.array,radii=Array.from({length:near+far+1},(_,j)=>Math.hypot(pos[j*row*3],pos[j*row*3+2])),stepIn=radii[near]-radii[near-1],stepOut=radii[near+1]-radii[near];
    assert.ok(Math.abs(stepIn-stepOut)<stepIn*.01,'radial spacing must pass through the old join without a sudden mesh-density jump');
    for(let j=near+2;j<radii.length;j++)assert.ok(radii[j]-radii[j-1]>=radii[j-1]-radii[j-2]-1e-3,'far-field radial spacing should grow gradually, not jump at one ring');
  }
});

test('inner and far water rings share angular samples so the seam cannot open at high quality',()=>{
  const start=html.indexOf('const WATER_QUALITY=['),end=html.indexOf('const WH=',start),block=html.slice(start,end);
  const rings=[...block.matchAll(/\{inner:\[(\d+),(\d+)\],far:\[(\d+),(\d+)\]/g)];
  assert.equal(rings.length,4,'all four water quality presets should define matching ring pairs');
  for(const [,innerTheta,,farTheta] of rings)assert.equal(innerTheta,farTheta,'inner and far rings need identical angular vertices at their shared radius');
});

test('terrain water is shader-displaced on a MeshPhysicalMaterial with depth tint and dynamic reflections',()=>{
  assert.match(html,/new THREE\.MeshPhysicalMaterial/);
  assert.match(html,/waterMat\.onBeforeCompile=/);
  assert.match(html,/uniform vec3 uTurbidColor,deep,shal/);
  assert.match(html,/transmission:Math\.max/);
  assert.match(html,/transformed\.y\+=waterWave\*amp\*waterFade/);
  assert.match(html,/float waterDepth=max\(wy\+tsH\(w\.xz\)-th\(w\.xz\),0\.\)/);
  assert.match(html,/new THREE\.CubeCamera/,'water reflections use the standard physical environment-map path');
  assert.match(html,/water\.visible=false/);
  assert.match(html,/waterReflectionCam\.update\(ren,scene\)/);
  assert.match(html,/waterMat\.envMap=waterReflectionRT\.texture/);
  assert.doesNotMatch(html,/uPlanarReflection|waterPlanarReflector|new THREE\.Reflector/,'do not overlay the broken projective reflection color on the water material');
  assert.match(html,/\{inner:\[320,160\],far:\[320,64\],reflection:128,interval:90/,'mobile uses a bounded cube reflection target');
  const probe=html.slice(html.indexOf('function updateWaterReflection()'),html.indexOf('const WATER_PROFILES=['));
  assert.doesNotMatch(probe,/waterQuality===0/,'mobile water still receives the low-resolution environment reflection');
  assert.match(html,/waterReflectionFailed=true;waterReflectionRetryAt=performance\.now\(\)\+3000/,'a reflection-capture failure retries without discarding the last valid environment texture');
  assert.doesNotMatch(html,/waterMat\.envMap=null/);
  assert.doesNotMatch(html,/showErr\('Water reflection probe failed/);
  assert.ok(html.includes('varying vec3 waterWorldNormal'));
  assert.ok(html.includes('waveNoise(w.xz*waterTriScale'));
  assert.ok(html.includes('waterTriW=pow(abs(normalize(waterWorldNormal)),vec3(4.))'));
  assert.ok(html.includes('waterMicroNormal'));
  assert.match(html,/waterMat\.customProgramCacheKey=\(\)=>'terrain-water-pbr-v\d+-[^']*triplanar[^']*'/, 'water shader defines a versioned cache key so injected shader edits invalidate programs');
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

test('water reflections use a standard MeshPhysicalMaterial environment map rather than a hand-projected color overlay',()=>{
  assert.match(html,/let waterReflectionRT=makeWaterReflectionTarget\(\)/);
  assert.match(html,/new THREE\.CubeCamera\(\.1,1600,waterReflectionRT\)/);
  assert.match(html,/waterReflectionCam\.renderTarget=waterReflectionRT/);
  assert.match(html,/waterReflectionCam\.update\(ren,scene\)/);
  assert.match(html,/waterMat\.envMap=waterReflectionRT\.texture/);
  assert.match(html,/waterMat\.envMapIntensity=exClamp\(U\.uReflect\.value,0,1\.5\)/);
  assert.doesNotMatch(html,/Reflector|uPlanarReflection|planarSrgbToLinear/,'avoid projective reflection overlays that create hard color bands');
  assert.match(html,/waterReflectionViewAnchor/);
  assert.match(html,/waterReflectionOrientationAnchor/,'camera rotation as well as camera position invalidates the captured view');
  assert.match(html,/now-waterReflectionViewMovedAt<350/,'reflection capture waits until the camera has stopped moving');
  assert.match(html,/waterReflectionFailed&&performance\.now\(\)<waterReflectionRetryAt/,'a transient capture error retries rather than permanently disabling reflections');
  assert.match(html,/waterReflectionRetryAt=performance\.now\(\)\+3000/);
  assert.match(html,/waterReflectionReady=true;waterReflectionFailed=false;waterReflectionRetryAt=0/);
});

test('reflection capture keeps procedural terrain, sky, lights and flora but restores/hides unrelated scene objects',()=>{
  const start=html.indexOf('function beginWaterReflectionCapture()'),end=html.indexOf('function updateWaterReflection()',start);
  assert.ok(start>=0&&end>start,'reflection capture needs an explicit world-only visibility mask');
  const source=html.slice(start,end);
  const terrain={visible:true},sky={visible:true},sun={visible:true,intensity:1,target:{visible:true}},hemi={visible:true},envFill={visible:true},water={visible:true},waterReflectionCam={visible:true};
  const cloud={visible:true},grass={visible:true},rock={visible:true},helper={visible:true},userObject={visible:true},alreadyHidden={visible:false},mapRoot={visible:true};
  const manualTree={visible:true,userData:{n:'Pine'}},manualRock={visible:true,userData:{n:'Rock'}},house={visible:true,userData:{n:'House'}};
  const ctx={ter:terrain,sky,sun,hemi,envFill,water,waterReflectionCam,clouds:[cloud],mapRoot,objs:[manualTree,manualRock,house],U:{uNS:{value:1},uNM:{value:2},uNP:{value:3}},KIND:{grass:{meshes:[grass],lowMeshes:[],shadowMeshes:[]},rock:{meshes:[rock],lowMeshes:[],shadowMeshes:[]}},scene:{children:[terrain,sky,sun,sun.target,hemi,envFill,water,cloud,grass,rock,helper,userObject,alreadyHidden,mapRoot,manualTree,manualRock,house]}};
  vm.runInNewContext(source+';this.begin=beginWaterReflectionCapture;',ctx);
  const restore=ctx.begin();assert.equal(water.visible,false);assert.equal(sun.visible,false,'suppress direct sunlight in the reflection capture to avoid a bright light-only water glint');for(const o of [terrain,sky,hemi,envFill,cloud,grass,rock,mapRoot,manualTree,manualRock])assert.equal(o.visible,true);for(const o of [helper,userObject,house])assert.equal(o.visible,false);assert.equal(alreadyHidden.visible,false);assert.deepEqual([ctx.U.uNS.value,ctx.U.uNM.value,ctx.U.uNP.value],[0,0,0]);
  restore();assert.equal(water.visible,true);assert.equal(sun.visible,true);for(const o of [helper,userObject,house])assert.equal(o.visible,true);assert.equal(alreadyHidden.visible,false);assert.deepEqual([ctx.U.uNS.value,ctx.U.uNM.value,ctx.U.uNP.value],[1,2,3]);
});

test('water keeps its PBR tint, Fresnel/depth/foam, and standard cubemap environment reflection',()=>{
  assert.ok(html.includes('waterFresnel=.02+.98*pow(1.-clamp(waterNdotV,0.,1.),5.)'));
  assert.ok(!html.includes('skyReflectionTint=mix(hor,top'),'do not overlay a synthetic sky tint over the captured world');
  assert.ok(html.includes('reflectedLight.directSpecular*=.22'),'retain the prior balanced direct specular response');
  assert.ok(html.includes('waterDepth=max(wy+tsH(w.xz)-th(w.xz),0.)'));
  assert.ok(html.includes('waterMat.transmission=Math.max'));
  assert.ok(html.includes('function createShoreSpray()')&&html.includes('function updateShoreSpray(dt)'));
  assert.ok(html.includes('Ocean shoreline spray'));
  assert.ok(html.includes('new THREE.CubeCamera')&&html.includes('waterReflectionCam.update(ren,scene)'),'water uses the established MeshPhysical environment reflection path');
  assert.ok(html.includes('waterMat.envMap=waterReflectionRT.texture'));
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
  assert.ok(html.includes('reflection:128,interval:90,transmission:.28'),'mobile reflections remain enabled at the bounded prior resolution');
  assert.ok(html.includes('{inner:[768,320],far:[768,128],reflection:192,interval:24,transmission:1}'));
  assert.ok(html.includes("[3,'Water: Ultra FFT']"));
  assert.ok(html.includes('FFT_RESOLUTION=[64,64,128,256]'));
});

test('terrain water has no WASM/SPH simulation path or particle-grid control',()=>{
  assert.doesNotMatch(html,/WATER_SIM|initWaterSPH|updateWaterSPH|sim_solver_sph_step|simulation_solver\.wasm|uSimTex/);
  assert.ok(html.includes('not a full Navier–Stokes/CFD solver or a guarantee of photographic realism'),'solver and rendering limits should remain explicit in the UI');
});

test('the colour a water preset actually puts on screen is physical, not a swatch', async () => {
  /* The authored `deep` and `shallow` values are only the brightness reference:
     `waterProfileFor` derives the colour the shader receives from the Jerlov
     absorption coefficients (Beer–Lambert), the CDOM load and the silt. That
     means the presets can be checked the way a photograph of the same water
     would be — hue and relative depth — instead of trusting the hex values. */
  const start = html.indexOf('const WATER_SILT=');
  const end = html.indexOf('function setWater(', start);
  assert.ok(start > 0 && end > start, 'the water optics block must exist');
  const block = html.slice(start, end);
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  const noCore = new Proxy({}, { get: () => undefined, has: () => true });
  const sandbox = new Function('cl', 'core', 'window', `${block}; return { WATER_PROFILES, waterProfileFor, waterOpticalFor, waterColumnColour, waterShallowColour };`);
  const api = sandbox(cl, noCore, {});

  const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const names = api.WATER_PROFILES.map((p) => p.name);
  assert.equal(names.length, 8, 'eight real water bodies');

  const seen = {};
  for (let i = 0; i < api.WATER_PROFILES.length; i++) {
    const p = api.waterProfileFor(i);
    for (const key of ['deep', 'shallow', 'turbid']) {
      const c = p[key];
      assert.equal(c.length, 3);
      for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${p.name}.${key} must be a linear colour in 0..1`);
      seen[`${i}:${key}`] = c;
    }
    /* Deep water is darker than the shallow edge: the column absorbs. */
    assert.ok(luma(p.deep) < luma(p.shallow), `${p.name}: deep must be darker than shallow (${luma(p.deep).toFixed(3)} vs ${luma(p.shallow).toFixed(3)})`);
    /* Secchi depth has to land in a range a diver would recognise. */
    assert.ok(p.secchi > 0.3 && p.secchi < 40, `${p.name} visibility ${p.secchi} m is not a real water body`);
    assert.ok(p.beaufort >= 0 && p.beaufort <= 11, `${p.name} sea state is inside the Beaufort scale`);
    assert.deepEqual(Object.keys(p.optics).sort(), ['absorb', 'scatter', 'type']);
  }

  /* Hue, in the linear space the shader mixes in. */
  const lake = api.waterProfileFor(4);
  assert.ok(lake.deep[2] > lake.deep[0] && lake.deep[1] > lake.deep[0], 'an alpine lake is blue, not brown');
  const lagoon = api.waterProfileFor(1);
  assert.ok(lagoon.shallow[1] > lagoon.shallow[0] * 1.6 && lagoon.shallow[2] > lagoon.shallow[0] * 1.6,
    `a lagoon over sand reads turquoise (${lagoon.shallow.map((v) => v.toFixed(3)).join(', ')})`);
  /* Silt and tannin both take the blue out of the light coming back off the
     bed, which is what separates these four from the ocean. */
  for (const index of [2, 5, 6, 7]) {
    const p = api.waterProfileFor(index);
    assert.ok(p.shallow[2] < p.shallow[0] && p.shallow[2] < p.shallow[1],
      `${p.name} must not read blue (${p.shallow.map((v) => v.toFixed(3)).join(', ')})`);
  }
  /* Tannin is a blue absorber rather than a dye, so a peat bog is amber. */
  const bog = api.waterProfileFor(7);
  assert.ok(bog.shallow[0] > bog.shallow[1] && bog.shallow[1] > bog.shallow[2],
    `a peat bog is amber, not green (${bog.shallow.map((v) => v.toFixed(3)).join(', ')})`);

  /* The visible surface colour, after the sRGB encode the canvas applies:
     nothing may clip to black or to white. */
  for (let i = 0; i < api.WATER_PROFILES.length; i++) {
    const p = api.waterProfileFor(i);
    const srgb = p.shallow.map(toSrgb);
    for (const v of srgb) assert.ok(v > 0.02 && v < 0.98, `${p.name} shallow clips in sRGB (${srgb.map((x) => x.toFixed(2)).join(', ')})`);
  }

  /* Transmission is how much of the bed a swimmer sees, so it has to follow
     the visibility and not the silt alone: a peat bog carries almost no
     suspended sediment but absorbs its own light within a metre, and deriving
     transmission from sediment alone made the darkest water in the list 92%
     transmissive — glass, with a bog's colour. */
  const clear = api.waterProfileFor(0), dark = api.waterProfileFor(7);
  assert.ok(clear.transparency > 0.5, `clear ocean transmits (${clear.transparency.toFixed(2)})`);
  assert.ok(dark.transparency < 0.45, `bog water does not (${dark.transparency.toFixed(2)})`);
  assert.ok(dark.secchi < 3, 'and the engine knows it: the bog sees under two metres');
  for (const [index, limit] of [[2, 0.2], [5, 0.3], [6, 0.2]]) {
    const p = api.waterProfileFor(index);
    assert.ok(p.transparency < limit, `${p.name} must not transmit like open water (${p.transparency.toFixed(2)})`);
  }
  /* Monotonic with visibility across the whole list: a shorter Secchi depth is
     never more transmissive. */
  const bySecchi = api.WATER_PROFILES.map((p, i) => api.waterProfileFor(i));
  for (const a of bySecchi) for (const b of bySecchi) {
    if (a.secchi < b.secchi * 0.5) assert.ok(a.transparency < b.transparency,
      `${a.name} (${a.secchi} m) cannot be more transmissive than ${b.name} (${b.secchi} m)`);
  }
  /* Re-reading a preset must not re-derive it (the hydration is idempotent). */
  const once = api.waterProfileFor(0).deep.slice();
  const twice = api.waterProfileFor(0).deep.slice();
  assert.deepEqual(once, twice, 'hydrating a preset twice must not drift its colour');
});
