import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('tall grass and distinct flower species are procedural, brushable, and included in biome scatter',()=>{
  assert.match(html,/const tallGrassG=\(\(\)=>/);
  assert.match(html,/mk\('tallgrass',\d+,\[\[tallGrassG/);
  for(const kind of ['daisy','tulip','lavender'])assert.match(html,new RegExp(`mk\\('${kind}',\\d+,flowerParts\\('${kind}'\\)`));
  for(const kind of ['tallgrass','daisy','tulip','lavender']){
    assert.match(html,new RegExp(`\\b${kind}:'`));
    assert.ok(html.includes(`'${kind}'`));
  }
  assert.match(html,/Object\.keys\(LBL\)\.map\(k=>\[k,LBL\[k\]\]\)/);
  assert.match(html,/GRND=\{[^}]*tallgrass:1[^}]*daisy:1[^}]*tulip:1[^}]*lavender:1/);
});

test('flowers use curved species-specific petals and vegetation uses textured WebGL PBR materials',()=>{
  assert.ok(html.includes('function curvedPetalPatch('),'flower petals should have curved, subdivided geometry rather than a single flat card');
  assert.ok(html.includes('for(let j=0;j<14;j++){const a=j*Math.PI*2/14'),'daisies should have a full ray-floret ring');
  assert.ok(html.includes("j<6;j++){const a=j*Math.PI/3"),'tulips should use six cupped petals');
  assert.ok(html.includes('j<11;j++){const u=j/10'),'lavender should form clustered florets along the spike');
  assert.ok(html.includes('new THREE.MeshPhysicalMaterial({...P,roughness:o.roughness??.78,metalness:0'),'foliage/flower surface materials should use the WebGL PBR physical material');
  assert.ok(html.includes('normalMap=o.nm')&&html.includes('roughnessMap=o.rm'),'PBR foliage should use species-detail normal and roughness maps');
  assert.ok(html.includes('LEAF_PBR={generic:')&&html.includes('oak:{nm:normFrom(OAKL.image')&&html.includes('petal:{nm:normFrom(PTT.image'),'leaf, bark/needle and petal textures should have detail maps');
  assert.ok(html.includes("rootsFrom(W,rad[0],'oak',[2.6,.68]);tubePath(W,pts,rad,10,[3.2,.9])"),'large oak bark UVs should tile at a non-stretched world scale');
});

test('vegetation stays full detail within 250 m and transitions gradually without thinning instances',()=>{
  const start=html.indexOf('const LOD_GROUND='),end=html.indexOf('function sync(',start);
  assert.ok(start>=0&&end>start,'distance LOD policy should be declared before instance synchronization');
  const mk=hash=>{const ctx={cl:(v,a,b)=>Math.min(b,Math.max(a,v)),hh:()=>hash};vm.runInNewContext(html.slice(start,end)+';this.plantLodTier=plantLodTier;this.LOD_BOTANICAL=LOD_BOTANICAL;',ctx);return ctx};
  const lowHash=mk(.1),highHash=mk(.9);
  assert.equal(lowHash.plantLodTier('grass',249,12,7,250),0,'all ground cover is high-detail before 250 m');
  assert.equal(highHash.plantLodTier('oak',250,12,7,250),0,'trees are also high-detail at the 250 m boundary');
  assert.equal(lowHash.plantLodTier('grass',500,12,7,250),1);
  assert.equal(highHash.plantLodTier('grass',500,12,7,250),0,'stable per-instance thresholds spread the transition across distance');
  assert.equal(lowHash.plantLodTier('oak',900,12,7,250),1,'the far-detail tier is reached gradually, not at one global ring');
  assert.equal(lowHash.plantLodTier('grass',1600,12,7,250),-1);
  assert.equal(lowHash.plantLodTier('oak',2400,12,7,250),-1);
  assert.ok(lowHash.LOD_BOTANICAL.has('daisy')&&lowHash.LOD_BOTANICAL.has('oak'));
  assert.ok(html.includes('m.count=ci')&&html.includes('low.count=li'),'instances must be routed to high or low meshes, never probabilistically deleted');
  assert.ok(html.includes('function buildLowDetail(fn)')&&html.includes('Object.assign(DQ,{leaf:Math.max(.42,saved.leaf*.42)'),'far LOD should regenerate simpler trees');
  assert.ok(html.includes('grassLowGeometry')&&html.includes('lodGeom:grassLowG')&&html.includes('lodGeom:tallGrassLowG'),'far grass should use reduced-polygon tuft meshes');
  assert.ok(html.includes('lowMat.normalMap=null')&&html.includes('lowMat.roughnessMap=null'),'far LOD should reduce material maps as well as geometry');
  assert.ok(html.includes('LOD_FULL_KEY=')&&html.includes('Full foliage detail radius (m)')&&html.includes('setLodFullDistance'),'the full-detail radius must be adjustable and persisted locally');
  assert.ok(html.includes("['quality','✨','Quality']")&&html.includes('quality:()=>qualityCtl()'),'quality/LOD controls need their own tab');
  assert.ok(html.includes('KIND[k].list.forEach'),'LOD refresh should route stored placements without erasing their source list');
});

test('procedural petal patches have curved, indexed and finite geometry',()=>{
  const start=html.indexOf('function curvedPetalPatch('),end=html.indexOf('function flowerParts(',start);assert.ok(start>=0&&end>start);
  const gaV=(g,p,n,c,uv)=>{g.P.push(...p);g.N.push(...n);g.C.push(...c);g.T.push(...uv);return g.P.length/3-1};
  const ctx={gaV,Math};vm.runInNewContext(html.slice(start,end)+';this.curvedPetalPatch=curvedPetalPatch;',ctx);
  const make=kind=>{const g={P:[],N:[],C:[],T:[],I:[]};ctx.curvedPetalPatch(g,[0,1,0],0,.2,.07,kind,[1,.8,.6],.4);return g};
  for(const kind of ['daisy','tulip']){const g=make(kind),ys=[];for(let i=1;i<g.P.length;i+=3)ys.push(g.P[i]);assert.ok(g.P.length/3>=45);assert.ok(Math.max(...ys)-Math.min(...ys)>.01);assert.ok(g.I.length>100);assert.ok(g.I.every(i=>i>=0&&i<g.P.length/3));assert.ok(g.P.concat(g.N,g.C,g.T).every(Number.isFinite));}
});

test('sky has four procedural cloud layers and round, randomly colored star discs',()=>{
  assert.match(html,/clouds:\[\{type:0,[^\]]+\},\{type:1,/);
  assert.match(html,/\{type:2,cov:[^}]+\},\{type:3,cov:/);
  assert.match(html,/Clouds \(up to 4 layers\)/);
  assert.match(html,/float radius=mix\(\.025,\.12,mag\)/);
  assert.match(html,/disc=1\.-smoothstep\(radius\*\.48,radius,dist\)/);
  assert.match(html,/mix\(vec3\(\.52,\.68,1\.\),vec3\(1\.,\.67,\.43\),temp\)/);
});

test('first-person avatar is 1.7–1.8 m tall with a matching eye height',()=>{
  const start=html.indexOf('function makeExploreBody()'),end=html.indexOf('function exploreSurface',start);
  assert.ok(start>=0&&end>start,'avatar builder must be present');
  const context={THREE,bodyModel:null,bodyParts:null};
  vm.runInNewContext(html.slice(start,end)+';this.makeExploreBody=makeExploreBody;',context);
  const body=context.makeExploreBody();body.visible=true;
  const bounds=new THREE.Box3().setFromObject(body);
  assert.ok(bounds.max.y>=1.7&&bounds.max.y<=1.8,`avatar top should be human height, got ${bounds.max.y}`);
  assert.ok(bounds.min.y>=0&&bounds.min.y<.04,`avatar feet should meet the ground, got ${bounds.min.y}`);
  assert.ok(html.includes('cam.position.set(0,1.68,0);'),'first-person eyes should be about 1.68 m high');
  assert.ok(html.includes('enter visible water to swim with buoyancy'),'Explore UI should explain the swimming behavior');
});

test('first-person can cross into water and swim buoyantly while land gravity remains active',()=>{
  const start=html.indexOf('function canExploreMove'),end=html.indexOf('function updateExplore',start);
  assert.ok(start>=0&&end>start,'water movement and vertical physics helpers must be present');
  const context={exClamp:(v,a,b)=>Math.max(a,Math.min(b,v))};
  vm.runInNewContext(html.slice(start,end)+';this.canExploreMove=canExploreMove;this.stepExploreVertical=stepExploreVertical;',context);
  const move=context.canExploreMove;
  assert.equal(move(false,true,true,-2,0,-2,2),true,'land-to-water entry should not be blocked by the shoreline');
  assert.equal(move(true,false,true,.2,0,1.2,.3),true,'a swimmer should be able to climb onto a beach');
  assert.equal(move(false,false,true,1,0,.5,2),false,'steep land movement should remain blocked');
  assert.equal(move(false,false,false,-2,0,-2,.2),true,'with water hidden, terrain remains walkable');
  const step=context.stepExploreVertical;
  let y=0,v=0;
  for(let i=0;i<240;i++)[y,v]=step(y,v,-6,0,true,1/60,true,9.8);
  assert.ok(y<-.8&&y>-1.25,`gravity and buoyancy should settle the swimmer below the surface, got ${y}`);
  assert.ok(Number.isFinite(v));
  y=0;v=0;
  for(let i=0;i<240;i++)[y,v]=step(y,v,-6,0,true,1/60,false,9.8);
  assert.ok(Math.abs(y+.88)<.08,'without gravity, buoyancy should still hold a stable swimming depth');
  y=2;v=0;
  for(let i=0;i<120;i++)[y,v]=step(y,v,0,0,false,1/60,true,9.8);
  assert.equal(y,0,'gravity should continue to land the character on dry terrain');
});

test('auto-scatter increases normal and tall grass together while preserving separate capacities',()=>{
  assert.match(html,/mk\('grass',65000/);
  assert.match(html,/mk\('tallgrass',55000/);
  assert.match(html,/mk\('flower',16000/);
  assert.match(html,/mk\('daisy',8000/);
  assert.match(html,/grassMixBonus=Math\.round\(18000\*density\)/);
  assert.match(html,/tallGrassMixBonus=Math\.round\(26000\*density\)/);
  assert.match(html,/wildflowerMixBonus=Math\.round\(3500\*density\)/);
  assert.ok(html.includes("n==='grass'||n==='tallgrass'?1.6:flowers.has(n)?2.3:1"));
  assert.ok(html.includes("n==='grass'?grassMixBonus:n==='tallgrass'?tallGrassMixBonus:flowers.has(n)?wildflowerMixBonus:0"));
});

test('coastal brush permits shallow seabed grass but preserves the sandy shoreline',()=>{
  assert.match(html,/shallowBrushDepth=1\.5/);
  assert.match(html,/savedCoastDepth!==null&&Number\.isFinite\(Number\(savedCoastDepth\)\)/);
  assert.match(html,/shallowWaterGrass=force&&grassKind&&waterDepth>=\.45&&waterDepth<=shallowBrushDepth/);
  assert.match(html,/protectedBeachSand=force&&grassKind&&m===3&&y>=wl-\.45&&!shallowWaterGrass/);
  assert.match(html,/Shallow-water grass depth \(m\)/);
  assert.match(html,/clear surf\/beach-sand strip is preserved/);
  assert.match(html,/y<wl\+minAbove&&!shallowWaterGrass/);
});

test('star field has a denser default and higher coarse/fine occupancy',()=>{
  assert.match(html,/stars:\{inten:1,twinkle:1,milky:1,density:1\.25\}/);
  assert.ok(html.includes('starOn=step(1.-.0065*uSt.w,h)'));
  assert.ok(html.includes('fineActive=step(1.-.0026*uSt.w'));
});

test('environment lighting adds a separate fill light and OFF changes no material assignments',()=>{
  const start=html.indexOf('function environmentFillLevel('),end=html.indexOf('\nconst S=',start);
  assert.ok(start>=0&&end>start,'environment fill should have a pure, testable intensity function');
  const ctx={cl:(v,a,b)=>Math.min(b,Math.max(a,v))};vm.runInNewContext(html.slice(start,end)+';this.level=environmentFillLevel;',ctx);
  assert.equal(ctx.level(false,0,0),0,'OFF should only set the added fill-light intensity to zero');
  assert.equal(ctx.level(true,0,0),1.25,'ON should noticeably increase light at night');
  assert.ok(ctx.level(true,1,0)>.8&&ctx.level(true,.5,.8)>ctx.level(true,.5,0),'fill should adapt to day and cloud cover');
  assert.ok(html.includes("envFill.intensity=environmentFillLevel(!SAFE.env,day,WX.over)"));
  assert.ok(html.includes('scene.environment=null;'),'the unstable global PMREM must not be injected into every material');
  assert.ok(!html.includes('scene.environment=rt.texture'));
  assert.ok(html.includes("if(v=='env')updSky()"),'the toggle should only recompute the dedicated fill-light intensity');
  const a=html.indexOf('function safeToggle(v)'),b=html.indexOf('/* ===== Sky Studio',a),toggle=html.slice(a,b);
  assert.doesNotMatch(toggle,/material|\.visible|dispose/,'the environment toggle must not replace, hide, or dispose user materials');
  assert.ok(html.includes('OFF disables that light only. Materials and textures stay assigned.'));
});

test('manual foliage uses mesh-quality LOD, stays present at distance, and preserves brush history',()=>{
  assert.ok(html.includes('if(!allInstances&&LOD_BOTANICAL.has(k))'),'manual and automatic vegetation should choose a geometry LOD by camera distance');
  assert.ok(html.includes('Math.hypot(o.x-cx,o.y-cam.position.y,o.z-cz)'),'LOD distance must include camera altitude');
  assert.ok(html.includes('function plantLodTier(k,d,x=0,z=0,full=250)'),'LOD should use a user-adjustable full-detail distance and stable per-instance fade');
  assert.ok(html.includes('const far=LOD_GROUND.has(k)?1600:2400'),'plants/trees should only be culled well beyond normal terrain viewing distances');
  assert.ok(html.includes('target=useLow?low:m'),'each placed instance must render in either high- or low-detail mesh');
  assert.ok(html.includes('K.lowMeshes'),'instanced vegetation should own low-detail geometry batches');
  assert.ok(html.includes('function updateFoliageLOD(now)'),'camera movement must trigger incremental quality-LOD refreshes');
  assert.ok(!html.includes('&&gr&&!o.manual')&&!html.includes('hh(o.x*1.71+17+(k.length*7)'),'manual plants must not be randomly thinned by distance');
  assert.ok(html.includes('const limit=131072;'),'manual brush capacity should grow before refusing new plants');
  assert.ok(html.includes('if(K.list.length>=K.max)return 0}'),'full-capacity brush attempts must preserve existing instances');
  assert.ok(!html.includes('K.list.splice(victim,1)'),'painting must never evict previously planted foliage');
  assert.ok(html.includes('KM:Object.fromEntries')&&html.includes('Uint8Array.from(KIND[k].list,o=>o.manual?1:0)'),'undo/redo snapshots must encode and preserve each manual-plant flag');
  assert.ok(html.includes('s.KM?.[k]'),'undo/redo must restore manual-plant flags');
  assert.ok(html.includes('manualPaint?3:2'),'manual brush stamps should stay dense across species');
  assert.ok(html.includes('Painting only adds; use Erase to remove earlier plants.'));
});

test('simultaneous joystick and look pointers remain independently owned through release',()=>{
  const start=html.indexOf('function joySet(e)');
  const end=html.indexOf('exButton.onclick=',start);
  assert.ok(start>=0&&end>start,'Explore pointer handlers must be present');
  const windowHandlers={};
  const window={addEventListener:(name,fn)=>{(windowHandlers[name]??=[]).push(fn)}};
  const elementHandlers={};
  const exJoystick={addEventListener:(name,fn)=>{(elementHandlers[name]??=[]).push(fn)},getBoundingClientRect:()=>({left:10,top:10,width:100,height:100}),setPointerCapture:()=>{}};
  const exJoyKnob={style:{transform:''}},cv={setPointerCapture:()=>{}};
  const context={window,document:{activeElement:{}},exJoystick,exJoyKnob,cv,exploreMode:'first',joyPointerId:null,joyX:0,joyY:0,lookPointerId:null,lastLookX:0,lastLookY:0,exploreYaw:0,explorePitch:0,exploreKeys:new Set(),exClamp:(v,a,b)=>Math.max(a,Math.min(b,v)),showWalkJoystick:true,closeExploreSheet:()=>{}};
  vm.runInNewContext(html.slice(start,end),context);
  const pointer=(pointerId,target,clientX,clientY,pointerType='touch')=>({pointerId,target,clientX,clientY,pointerType,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){this.stopped=true}});
  const fire=(name,e)=>{for(const fn of windowHandlers[name]||[]){fn(e);if(e.stopped)break}};
  const joyTarget={};
  let e=pointer(101,joyTarget,60,60);fire('pointerdown',e);elementHandlers.pointerdown[0](e);
  e=pointer(202,cv,160,120);fire('pointerdown',e);
  e=pointer(101,joyTarget,95,60);fire('pointermove',e);
  assert.ok(context.joyX>.6,'joystick pointer should still drive movement');
  const xBeforeLook=context.joyX;
  e=pointer(202,cv,190,140);fire('pointermove',e);
  assert.ok(context.exploreYaw<-.1&&context.explorePitch<-.05,'second pointer should pan view independently');
  assert.equal(context.joyX,xBeforeLook,'look motion must not contaminate joystick axis');
  e=pointer(202,cv,190,140);fire('pointerup',e);
  assert.equal(context.lookPointerId,null);
  assert.ok(context.joyX>.6,'releasing look pointer must not stop joystick');
  e=pointer(101,joyTarget,95,60);fire('pointerup',e);
  assert.equal(context.joyX,0);
});

test('sky GLSL avoids the reserved active identifier in the star shader',()=>{
  const start=html.indexOf('vec3 starsCol('),end=html.indexOf('vec3 auroraCol',start);
  assert.ok(start>=0&&end>start,'stars shader function must be present');
  const stars=html.slice(start,end);
  assert.ok(!stars.includes('active='));
  assert.ok(!stars.includes('*active*'));
  assert.match(stars,/starOn/);
});

test('Explore uses disjoint joystick/look pointer IDs and exposes model-free Free Flight',()=>{
  assert.match(html,/if\(!exploreMode\|\|joyPointerId!==null&&joyPointerId!==e\.pointerId\)return/);
  assert.match(html,/window\.addEventListener\('pointermove',handleJoystickMove,true\)/);
  assert.match(html,/lookPointerId!==null&&lookPointerId!==e\.pointerId/);
  assert.match(html,/joyPointerId===e\.pointerId\|\|lookPointerId!==e\.pointerId/);
  assert.match(html,/Free Flight Mode/);
  assert.match(html,/Start Free Flight/);
  assert.doesNotMatch(html,/makeExploreHelicopter|updateHelicopterPose|heliVehicle/);
});
