import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';

const html=readFileSync(appPath('Terrain_system_.html'),'utf8');

test('normal Terrain settings panel builder and tabs remain wired',()=>{
  assert.ok(html.includes('function build(){\n nfs=[];'),'normal settings require their shared panel builder');
  assert.ok(html.includes("$('#dr').replaceChildren(...nodes)"),'and the builder still fills the drawer');
  assert.ok(html.includes("if(typeof make!=='function'){showErr('Panel: no builder for '+tab);return}"),'a missing builder reports itself instead of leaving an empty sheet');
  assert.ok(html.includes("$('#cls').onclick=()=>$('#bw').click();"),'the normal panel close control must remain wired');
  assert.match(html,/const TABS=\[\['terrain','⛰','Terrain'\]/,'normal Terrain remains the first tab');
  for(const label of ['Planet','Foliage','City','Quality','Lighting','Sky','Water','Weather','Objects','Import'])assert.ok(html.includes(`'${label}'`),`${label} settings remain available`);
});

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

test('vegetation keeps leaves in high detail nearer to the camera and fades to low LOD before distant culling',()=>{
  const start=html.indexOf('const LOD_GROUND='),end=html.indexOf('function sync(',start);
  assert.ok(start>=0&&end>start,'distance LOD policy should be declared before instance synchronization');
  const mk=hash=>{const ctx={cl:(v,a,b)=>Math.min(b,Math.max(a,v)),hh:()=>hash};vm.runInNewContext(html.slice(start,end)+';this.plantLodTier=plantLodTier;this.LOD_BOTANICAL=LOD_BOTANICAL;',ctx);return ctx};
  const lowHash=mk(.1),highHash=mk(.9);
  assert.equal(lowHash.plantLodTier('grass',249,12,7,750),0,'all ground cover is high-detail within the old 250 m guarantee');
  assert.equal(highHash.plantLodTier('oak',750,12,7,750),0,'tree leaves remain high-detail through the extended 750 m radius');
  assert.equal(lowHash.plantLodTier('grass',2000,12,7,750),1);
  assert.equal(highHash.plantLodTier('grass',2000,12,7,750),0,'stable per-instance thresholds spread the transition across distance');
  const boundaryHash=mk(.46);
  assert.equal(boundaryHash.plantLodTier('grass',2000,12,7,750,false),0,'high-detail instances keep their mesh while zoom oscillates inside the LOD hysteresis band');
  assert.equal(boundaryHash.plantLodTier('grass',2000,12,7,750,true),1,'low-detail instances keep their mesh while zoom oscillates inside the LOD hysteresis band');
  assert.equal(lowHash.plantLodTier('oak',3000,12,7,750),1,'far detail is reached gradually, not at one global ring');
  assert.equal(lowHash.plantLodTier('grass',8000,12,7,750),-1);
  assert.equal(lowHash.plantLodTier('oak',14000,12,7,750),-1);
  assert.ok(lowHash.LOD_BOTANICAL.has('daisy')&&lowHash.LOD_BOTANICAL.has('oak'));
  assert.ok(html.includes('m.count=ci')&&html.includes('low.count=li'),'instances must be routed to high or low meshes, never probabilistically deleted');
  assert.ok(html.includes('function buildLowDetail(fn)')&&html.includes('Object.assign(DQ,{leaf:Math.max(.42,saved.leaf*.42)'),'far LOD should regenerate simpler trees');
  assert.ok(html.includes('grassLowGeometry')&&html.includes('lodGeom:grassLowG')&&html.includes('lodGeom:tallGrassLowG'),'far grass should use reduced-polygon tuft meshes');
  assert.ok(html.includes('lowMat.normalMap=null')&&html.includes('lowMat.roughnessMap=null'),'far LOD should reduce material maps as well as geometry');
  assert.ok(html.includes("LOD_FULL_KEY='final3d.lodFullDistance.v2'")&&html.includes('Full foliage detail radius (m)')&&html.includes('setLodFullDistance'),'the extended full-detail radius must be adjustable and persisted locally');
  assert.ok(html.includes('full=750')&&html.includes('250,2500'),'near foliage should remain high-detail by default, with a longer adjustable radius');
  assert.ok(html.includes("['quality','✨','Quality']")&&html.includes('quality:()=>qualityCtl()'),'quality/LOD controls need their own tab');
  assert.ok(html.includes('KIND[k].list.forEach'),'LOD refresh should route stored placements without erasing their source list');
  assert.match(html,/now-lodMotionAt<240/,'do not switch foliage geometry while the camera is still moving');
  assert.match(html,/now-previewCameraMovedAt<900/,'do not change GPU render scale during a zoom gesture');
});

test('camera zoom defers foliage LOD and adaptive resolution until motion settles',()=>{
  const vec=(x=0,y=0,z=0)=>({x,y,z,clone(){return vec(this.x,this.y,this.z)},copy(o){this.x=o.x;this.y=o.y;this.z=o.z;return this},distanceToSquared(o){return (this.x-o.x)**2+(this.y-o.y)**2+(this.z-o.z)**2}});
  const lodStart=html.indexOf('const LOD_KINDS='),lodEnd=html.indexOf('let season=',lodStart),lodCalls=[];
  /* `bakeQueuedImpostor` lives above the sliced region; a stub is enough here
     because this test is about the settle timer, not about atlas baking. */
  const lodCtx={LOD_BOTANICAL:new Set(['grass']),LOD_GROUND:new Set(['grass']),LOD_TREES:new Set(),KIND:{grass:{list:[{}]}},cam:{position:vec()},lodFullDistance:750,cl:(v,a,b)=>Math.min(b,Math.max(a,v)),hh:()=>.5,sync:k=>lodCalls.push(k),localStorage:{setItem(){}},bakeQueuedImpostor(){},impostorWanted:new Set()};
  vm.runInNewContext(html.slice(lodStart,lodEnd)+';this.step=updateFoliageLOD',lodCtx);
  lodCtx.cam.position.x=.1;lodCtx.step(100);assert.equal(lodCalls.length,0,'no mesh-tier changes occur during zoom');
  lodCtx.step(300);assert.equal(lodCalls.length,0,'LOD remains queued inside the settle delay');
  lodCtx.step(341);assert.equal(lodCalls.length,1,'LOD refresh begins after the camera settles');
  const previewStart=html.indexOf('function updateSmoothPreview('),previewEnd=html.indexOf(String.fromCharCode(10),previewStart),scaleCalls=[];
  const previewCtx={adaptiveFPS:60,smoothPreviewAuto:true,adaptiveLast:0,adaptiveSlow:0,adaptiveFast:0,adaptiveScale:1,previewCameraMovedAt:0,previewCameraAnchor:vec(),cam:{position:vec()},applyPreviewPixelRatio(){scaleCalls.push(1)}};
  vm.runInNewContext(html.slice(previewStart,previewEnd)+';this.step=updateSmoothPreview',previewCtx);
  previewCtx.cam.position.x=1;previewCtx.step(20,1000);previewCtx.step(20,1700);
  assert.equal(previewCtx.adaptiveScale,1);assert.equal(scaleCalls.length,0,'adaptive pixel ratio stays fixed while moving and settling');
  previewCtx.step(20,2000);previewCtx.step(20,3200);
  assert.ok(previewCtx.adaptiveScale<1&&scaleCalls.length===1,'resolution may adjust after stable low-FPS samples, not during the zoom');
});

test('grass keeps its original green PBR look and blade proportions',()=>{
  assert.ok(!html.includes('const GRASS_BLADE=grassBladeAtlas()'),'no dark atlas should mute the original vertex colors');
  assert.ok(html.includes('height=.38+R()*.76,width=.018+R()*.032'));
  assert.ok(html.includes('height=1.05+R()*1.35,width=.014+R()*.024'));
  assert.ok(html.includes("mk('grass',105000,[[grassG,{std:1,ds:1,w:.11,fx:'gl',tk:25"));
  assert.ok(html.includes("mk('tallgrass',80000,[[tallGrassG,{std:1,ds:1,w:.14,fx:'gl',tk:22"));
  assert.ok(html.includes('const tallGrassG=')&&html.includes('height=1.05+R()*1.35'),'tall grass keeps taller blades than lawn grass');
});

test('flower petals are smaller, cupped and matte instead of oversized flat plastic shapes',()=>{
  assert.ok(html.includes('plen=.108*(.88+R()*.24)')&&html.includes('pwid=.03*(.88+R()*.24)'),'daisy petals should have slight per-floret variation');
  assert.ok(html.includes('plen=.155*(.9+R()*.18)')&&html.includes('pwid=.058*(.9+R()*.18)'),'tulips should use compact overlapping cup petals');
  assert.ok(html.includes('width*.52*v*v*lift')&&html.includes('width*.9*v*v*lift'),'petal surfaces should cup rather than remain flat');
  assert.ok(html.includes("roughness:kind==='tulip'?.76:.74,clearcoat:.07"),'flower surfaces should be satin-matte, not plastic-glossy');
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

test('spring resets forced blizzards, stops new snowfall, melts cover, and starts growth/bloom gradually',()=>{
  const start=html.indexOf('function seasonalSnowState('),end=html.indexOf('function setSeason(',start);assert.ok(start>=0&&end>start);
  const ctx={sm:(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)}};
  vm.runInNewContext(html.slice(start,end)+';this.seasonalSnowState=seasonalSnowState;',ctx);
  assert.deepEqual({...ctx.seasonalSnowState(.08)},{cover:0,fall:0},'selected spring must neither accumulate snow nor keep a permanent snow blanket');
  assert.equal(ctx.seasonalSnowState(.9).fall,.9,'winter should still snow');
  assert.ok(html.includes("WX.snowAuto=true;const snow=seasonalSnowState(WX.seasonT)"));
  assert.ok(html.includes("if(s==='spring'){WX.melt=Math.max(WX.melt,2.2)"));
  assert.ok(html.includes('bloom=sm(.04,.16,t)*(1-sm(.2,.28,t))'));
  assert.ok(html.includes('t<.25?sm(0,.12,t):t<.75?1:0'),'spring foliage should grow in gradually rather than appear fully grown at once');
});

test('manual grass brush lays evenly spaced, dense additive stamps along fast strokes',()=>{
  const start=html.indexOf('function plantAt('),end=html.indexOf('function scatter(',start);assert.ok(start>=0&&end>start);
  const calls=[],context={br:{kind:'grass',r:2,den:10,minGap:.25},bt:'plants',RATE:{grass:1.6},BLD:{},KIND:{},FP:{},S:100,cityAng:0,R:()=>.5,cl:(v,a,b)=>Math.min(b,Math.max(a,v)),occRebuild(){},occBlocked(){return false},occAdd(){},sync(){},add:(...args)=>{calls.push(args);return 1}};
  vm.runInNewContext(html.slice(start,end)+';this.plantAt=plantAt;',context);
  context.plantAt({x:0,z:0});assert.equal(calls.length,96,'the manual grass stamp should fill the brush instead of producing sparse random clumps');
  assert.ok(calls.every(x=>x[0]==='grass'&&x[5]===true),'manual strokes must remain additive forced placements');
  const radii=calls.map(x=>Math.hypot(x[1],x[2]));assert.ok(Math.min(...radii)<.3&&Math.max(...radii)>1.8,'points should cover the full brush disk');
  const first=calls.length;context.plantAt({x:4,z:0},{x:0,z:0});assert.ok(calls.length-first>1000,'interpolated strokes should fill the gap between pointer samples');
});

test('first person is camera-only with a grounded 1.8 m eye height',()=>{
  assert.ok(!html.includes('function makeExploreBody()'),'the procedural character should be removed from Explore');
  assert.ok(html.includes('const WALK_EYE_HEIGHT=1.8'));
  assert.ok(html.includes('walkRig.add(cam);cam.position.set(0,WALK_EYE_HEIGHT,0);'),'the camera stays at eye height above the terrain-following walk rig');
  assert.ok(!html.includes('bodyParts')&&!html.includes('bodyModel'));
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

test('auto-scatter greatly boosts green ground cover and flowers while reducing all auto-scattered rocks',()=>{
  assert.match(html,/mk\('grass',105000/);
  assert.match(html,/mk\('tallgrass',80000/);
  assert.match(html,/mk\('flower',24000/);
  assert.match(html,/mk\('daisy',14000/);
  assert.match(html,/mk\('tulip',12000/);
  assert.match(html,/mk\('lavender',12000/);
  assert.match(html,/grassMixBonus=Math\.round\(36000\*density\)/);
  assert.match(html,/tallGrassMixBonus=Math\.round\(42000\*density\)/);
  assert.match(html,/wildflowerMixBonus=Math\.round\(7000\*density\)/);
  assert.ok(html.includes("coverBoost=n=>n==='grass'?3.1:n==='tallgrass'?3.2:flowers.has(n)?4:1"));
  assert.ok(html.includes("n==='grass'?grassMixBonus:n==='tallgrass'?tallGrassMixBonus:flowers.has(n)?wildflowerMixBonus:0"));
  for(const weight of ["['rock',.008]","['rock',.035]","['sandrock',.04]","['rock',.02]","['basalt',.12]","['rock',.025]"])assert.ok(html.includes(weight),`auto-scatter rock weight ${weight} remains intentionally reduced`);
});

test('manual foliage can fill dry sand and steep land while limiting only deep-water planting',()=>{
  assert.match(html,/shallowBrushDepth=1\.5/);
  assert.match(html,/savedCoastDepth!==null&&Number\.isFinite\(Number\(savedCoastDepth\)\)/);
  assert.match(html,/shallowWaterGrass=force&&grassKind&&waterDepth>=\.45&&waterDepth<=shallowBrushDepth/);
  assert.ok(!html.includes('protectedBeachSand'),'the manual brush should not leave a forbidden beach-sand strip');
  assert.ok(html.includes('including beach sand and steep slopes'));
  assert.match(html,/Shallow-water grass depth \(m\)/);
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
  /* The budget was cut from 1.25 to 0.6: three lights stacking to three times
     the needed irradiance is what blew the island out to pastel white. The
     fill still rises at night and with cloud; it no longer swamps the sun. */
  assert.equal(ctx.level(true,0,0),0.6,'ON should noticeably increase light at night');
  assert.ok(ctx.level(true,1,0)>.4&&ctx.level(true,.5,.8)>ctx.level(true,.5,0),'fill should adapt to day and cloud cover');
  assert.ok(ctx.level(true,0,0)>ctx.level(true,1,0),'the fill is strongest when the sun is down');
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
  assert.ok(html.includes('function plantLodTier(k,d,x=0,z=0,full=750,wasLow)'),'LOD should use a user-adjustable full-detail distance and stable per-instance fade with hysteresis');
  assert.ok(html.includes('const far=LOD_GROUND.has(k)?8000:14000'),'plants/trees should remain visible much farther before final culling');
  assert.ok(html.includes('target=useLow?low:m'),'each placed instance must render in either high- or low-detail mesh');
  assert.ok(html.includes('K.lowMeshes'),'instanced vegetation should own low-detail geometry batches');
  assert.ok(html.includes('function updateFoliageLOD(now)'),'camera movement must trigger incremental quality-LOD refreshes');
  assert.ok(!html.includes('&&gr&&!o.manual')&&!html.includes('hh(o.x*1.71+17+(k.length*7)'),'manual plants must not be randomly thinned by distance');
  assert.ok(html.includes('const cap=Math.max(required,Math.ceil(Math.max(K.max,1)*1.5),K.max+1024)'),'manual brush capacity must grow without the old fixed 131072 cap');
  assert.ok(!html.includes('131072'),'there must be no arbitrary manual foliage instance limit');
  assert.ok(html.includes('if(K.list.length>=K.max)return 0}'),'full-capacity brush attempts must preserve existing instances');
  assert.ok(!html.includes('K.list.splice(victim,1)'),'painting must never evict previously planted foliage');
  assert.ok(html.includes('KM:Object.fromEntries')&&html.includes('Uint8Array.from(KIND[k].list,o=>o.manual?1:0)'),'undo/redo snapshots must encode and preserve each manual-plant flag');
  assert.ok(html.includes('s.KM?.[k]'),'undo/redo must restore manual-plant flags');
  assert.ok(html.includes('manualPaint?(cover?6:flowers?4:3):2'),'manual ground-cover brushes should be denser than the previous sparse stamps');
  assert.ok(html.includes('Math.min(512,Math.ceil(dist/step))')&&html.includes('i*2.3999632297+j*1.6180339887'),'fast manual strokes should interpolate and distribute points evenly');
  assert.ok(html.includes('Manual placement has no fixed instance-count cap; device memory is the practical limit.'));
  assert.ok(html.includes('Painting only adds; use Erase to remove earlier plants.'));
});

test('terrain brush resnap moves plants, trees and rocks to the edited ground height',()=>{
  const start=html.indexOf('function resnap(){'),end=html.indexOf('\n',start);
  assert.ok(start>=0&&end>start,'terrain resnap helper should be present');
  const kinds={};for(const k of ['grass','tallgrass','flower','pine','oak','rock','sandrock','basalt'])kinds[k]={list:[{x:4,z:-3,y:0}]};
  let height=2;const synced=[];
  const ctx={KIND:kinds,BLD:{house:4},hgt:()=>height,bY:()=>height+1,sync:k=>synced.push(k)};
  vm.runInNewContext(html.slice(start,end)+';this.resnap=resnap',ctx);
  ctx.resnap();for(const k of Object.keys(kinds))assert.equal(kinds[k].list[0].y,2,`${k} follows a raised terrain surface`);
  height=-1;ctx.resnap();for(const k of Object.keys(kinds))assert.equal(kinds[k].list[0].y,-1,`${k} follows a lowered terrain surface`);
  assert.equal(synced.length,Object.keys(kinds).length*2,'each raise/lower resnap refreshes every instanced category');
  assert.match(html,/const endedTerrain=painting&&paintingTerrain;ptrs\.delete\(e\.pointerId\);painting=false;paintingTerrain=false;lastBrushPoint=null;if\(endedTerrain\)resnap\(\)/,'pointer-cancel paths still resnap terrain instances');
  assert.match(html,/if\(painting\)\{const endedTerrain=paintingTerrain;painting=false;paintingTerrain=false;lastBrushPoint=null;if\(endedTerrain\)resnap\(\)\}/,'every completed terrain-brush gesture resnaps instances even if the selected tab changes mid-drag');
  assert.match(html,/rootSink=Math\.min\(Math\.max\(0,o\.y-lowY-\.08\),Math\.min\(\.28\*s,\.16\*span\)\)/,'rooted plants should sink modestly into raised or sloped soil while trunks remain above ground');
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
  const context={window,document:{activeElement:{}},exJoystick,exJoyKnob,cv,oc:{enabled:true},exploreMode:'first',joyPointerId:null,joyX:0,joyY:0,lookPointerId:null,lastLookX:0,lastLookY:0,exploreYaw:0,explorePitch:0,exploreKeys:new Set(),exClamp:(v,a,b)=>Math.max(a,Math.min(b,v)),showWalkJoystick:true,closeExploreSheet:()=>{}};
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
