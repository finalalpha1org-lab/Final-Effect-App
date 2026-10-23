import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

/* Offline contract for the temporal anti-aliasing pass. No GPU: the math is
   pure, and the render pipeline is exercised against a stub renderer that
   records every pass. */
class Mat4 {
  constructor(){this.elements=new Array(16).fill(0);this.elements[0]=this.elements[5]=this.elements[10]=this.elements[15]=1;}
  clone(){const m=new Mat4();m.elements=this.elements.slice();return m;}
  copy(other){this.elements=(other.elements||other).slice();return this;}
  invert(){return this;}
  multiplyMatrices(a,b){
    const ae=a.elements,be=b.elements,te=new Array(16);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++)te[c*4+r]=ae[r]*be[c*4]+ae[4+r]*be[c*4+1]+ae[8+r]*be[c*4+2]+ae[12+r]*be[c*4+3];
    this.elements=te;return this;
  }
}
class Vec2{constructor(x=0,y=0){this.x=x;this.y=y;}set(x,y){this.x=x;this.y=y;return this;}}
class Target{
  constructor(w,h,opts){this.width=w;this.height=h;this.options=opts||{};this.texture={};this.depthTexture=null;this.disposed=false;}
  dispose(){this.disposed=true;}
}
class Mat{constructor(o){Object.assign(this,o);}dispose(){}}
const THREE={
  Matrix4:Mat4, Vector2:Vec2, WebGLRenderTarget:Target,
  DepthTexture:class{constructor(w,h){this.width=w;this.height=h;}dispose(){}},
  LinearFilter:1, NearestFilter:2, RGBAFormat:3, UnsignedByteType:4, UnsignedIntType:5, sRGBEncoding:3001,
  ShaderMaterial:Mat,
  Mesh:class{constructor(g,m){this.geometry=g;this.material=m;this.frustumCulled=true;}},
  PlaneGeometry:class{dispose(){}},
  Scene:class{constructor(){this.children=[];}add(o){this.children.push(o);}},
  OrthographicCamera:class{constructor(...args){this.args=args;}}
};
function fakeRenderer(){
  const renderer={
    capabilities:{isWebGL2:true}, outputEncoding:3001,
    domElement:{width:800,height:600}, target:null, calls:[],
    getDrawingBufferSize(v){v.set(800,600);return v;},
    setRenderTarget(t){renderer.target=t;},
    render(scene,camera){renderer.calls.push({target:renderer.target,scene,camera});}
  };
  return renderer;
}
const ctx={THREE, Math, Number, Object, Array, Map, Set, console};
vm.createContext(ctx);
vm.runInContext(readFileSync('fe-taa.js','utf8'),ctx);
const {FE_TAA}=ctx;

const camera=()=>({
  projectionMatrix:new Mat4(), projectionMatrixInverse:new Mat4(),
  matrixWorld:new Mat4(), matrixWorldInverse:new Mat4(),
  updateMatrixWorld(){}
});

test('the jitter is a deterministic sub-pixel Halton sequence',()=>{
  assert.equal(FE_TAA.halton(1,2),0.5);
  assert.equal(FE_TAA.halton(2,2),0.25);
  assert.equal(FE_TAA.halton(3,2),0.75);
  const seen=new Set();
  for(let frame=0;frame<16;frame++){
    const a=FE_TAA.jitter(frame,1000,500);
    const b=FE_TAA.jitter(frame,1000,500);
    assert.deepEqual(a,b,'the same frame always jitters the same way');
    assert.ok(Math.abs(a.x)<=1/1000+1e-12,'x stays inside one pixel');
    assert.ok(Math.abs(a.y)<=1/500+1e-12,'y stays inside one pixel');
    seen.add(`${a.x.toFixed(6)}:${a.y.toFixed(6)}`);
  }
  assert.equal(seen.size,16,'no two frames share a sample offset');
});

test('reprojection maps world points through the previous view-projection',()=>{
  const identity=new Mat4();
  const centre=FE_TAA.projectToUv(identity,{x:0,y:0,z:0});
  assert.ok(Math.abs(centre.x-0.5)<1e-9&&Math.abs(centre.y-0.5)<1e-9);
  assert.equal(centre.valid,true);
  const outside=FE_TAA.projectToUv(identity,{x:2,y:0,z:0});
  assert.equal(outside.valid,false,'points outside the frustum reject the history');
  const shift=new Mat4();
  shift.elements[12]=-0.5; /* world x-0.5 */
  const moved=FE_TAA.projectToUv(shift,{x:0.5,y:0,z:0});
  assert.ok(Math.abs(moved.x-0.5)<1e-9,'translation is compensated');
});

test('the pass renders scene, composite and copy, and ping-pongs history',()=>{
  const renderer=fakeRenderer();
  const taa=FE_TAA.create(renderer,{blend:0.12});
  assert.ok(taa,'the pass needs WebGL2');
  const scene={name:'scene'}, cam=camera();
  const original=cam.projectionMatrix.elements.slice();

  taa.render(scene,cam);
  assert.equal(renderer.calls.length,3,'scene + composite + copy');
  assert.equal(renderer.calls[0].target,taa.targets.sceneTarget,'the scene goes to the colour+depth target');
  assert.equal(renderer.calls[0].scene,scene);
  assert.deepEqual(cam.projectionMatrix.elements,original,'the jitter is restored after the pass');
  assert.equal(taa.frame,1);

  const firstHistory=taa.targets.history;
  taa.render(scene,cam);
  assert.equal(taa.frame,2);
  assert.notEqual(taa.targets.history,firstHistory,'history ping-pongs every frame');
  assert.equal(renderer.calls[5].target,null,'the last pass writes to the screen');
  assert.equal(taa.targets.sceneTarget.depthTexture instanceof ctx.THREE.DepthTexture,true);

  taa.reset();
  taa.render(scene,cam);
  assert.equal(taa.ok,true);
});

test('a resize rebuilds the targets and clears history',()=>{
  const renderer=fakeRenderer();
  const taa=FE_TAA.create(renderer,{blend:0.2});
  taa.render({},camera());
  const before=taa.targets.history;
  taa.setSize(640,360);
  assert.equal(taa.targets.history.width,640);
  assert.equal(taa.targets.history.height,360);
  assert.notEqual(taa.targets.history,before,'new attachments after a resize');
  assert.equal(taa.targets.sceneTarget.depthTexture.width,640);
});

test('disabling the pass and a non-WebGL2 device both fall back to a plain render',()=>{
  const renderer=fakeRenderer();
  const taa=FE_TAA.create(renderer,{blend:0.12});
  taa.setEnabled(false);
  const cam=camera();
  taa.render({},cam);
  assert.equal(renderer.calls.length,1,'one direct render when disabled');
  assert.equal(renderer.calls[0].target,null);

  const gl1=fakeRenderer();
  gl1.capabilities={isWebGL2:false};
  assert.equal(FE_TAA.create(gl1),null,'no depth textures means no TAA, not a broken frame');
});

test('the shader does a depth-based reprojection with neighbourhood clipping',()=>{
  const shader=FE_TAA.shader;
  for(const anchor of ['uPrevViewProj','tHistory','tDepth','uInvProjection','uCameraWorld','uAlpha','uSrgb']){
    assert.ok(shader.includes(anchor),`the composite shader uses ${anchor}`);
  }
  assert.ok(shader.includes('neighbourhoodMin')&&shader.includes('neighbourhoodMax'),'history is clipped to the current 3x3 neighbourhood');
  assert.ok(shader.includes('clamp(history, lo, hi)'));
  assert.ok(shader.includes('prevUv.x > 0.0'),'off-screen history is rejected');
});

test('the workspace wires the pass, exposes both toggles and keeps a fallback',()=>{
  const html=readFileSync('index.html','utf8');
  assert.ok(html.includes('<script src="fe-taa.js"></script>'));
  assert.ok(html.includes('window.FE_TAA.create(this.r'),'the engine creates the pass lazily');
  assert.ok(html.includes('this.taa.render(this.sc, activeCam)'));
  assert.ok(html.includes('else this.r.render(this.sc, activeCam)'),'a failed pass falls back to a direct render');
  assert.ok(html.includes('id="ws-taa"')&&html.includes('id="ws-taa-blend"'),'the viewport sheet controls it');
  assert.ok(html.includes('id="set-taa"')&&html.includes('id="set-taa-blend"'),'the global sheet stores it');
  assert.ok(html.includes('taa:true'),'enabled by default');
  assert.ok(html.includes('if (this.taa) this.taa.reset();'),'a resize clears the history');

  const core=readFileSync('simulationCore.js','utf8');
  assert.ok(core.includes('uFrame'),'the volume raymarch is frame-indexed for the history');
  assert.ok(core.includes('v.frame = (v.frame | 0) + 1;'),'the frame counter advances with the volume clock');
});
