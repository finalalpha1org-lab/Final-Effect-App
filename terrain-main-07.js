
/* UI */
const el=h=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstChild};
const G=(...c)=>{const d=el('<div class="g"></div>');d.append(...c);return d};
const btn=(t,f)=>{const b=el(`<button class="chip">${t}</button>`);b.onclick=f;return b};
function chips(items,cur,cb){const r=el('<div class="row"></div>');items.forEach(([id,l])=>{const b=el(`<button class="chip${id===cur?' on':''}">${l}</button>`);b.onclick=()=>{cb(id);build()};r.append(b)});return r}
function sl(l,min,max,st,v,cb){const d=el(`<label class="sl"><span>${l}</span><input type="range" min="${min}" max="${max}" step="${st}" value="${v}"><output></output></label>`),i=d.children[1],o=d.children[2],u=()=>o.textContent=+(+i.value).toFixed(2);i.oninput=()=>{u();cb(+i.value)};u();return d}
/* Floor grid and the two ground axes are viewport references, not part of the
   scene — Blender's grid is not in the artwork either. The parent app's Floor
   Grid setting drives this, and the chip in the Terrain sheet overrides it
   locally. Without either, there was no way to get the grid out of the way. */
let terrainGridOn=(()=>{try{return localStorage.getItem('fe_terrain_grid')!=='0'}catch(error){return true}})();
function setTerrainGrid(on,persist){
 terrainGridOn=!!on;
 if(typeof grid!=='undefined'&&grid)grid.visible=terrainGridOn;
 if(typeof gridAxes!=='undefined'&&gridAxes)for(const axis of gridAxes)axis.visible=terrainGridOn;
 if(persist!==false){try{localStorage.setItem('fe_terrain_grid',terrainGridOn?'1':'0')}catch(error){}}
}
setTerrainGrid(terrainGridOn,false);
function waterColorField(label,uniform){const d=el(`<label class="sl"><span>${label}</span><input type="color"><output></output></label>`),i=d.children[1];i.value='#'+uniform.value.getHexString();i.oninput=()=>uniform.value.set(i.value);return d}
function colorRow(ms){const d=el('<label class="sl"><span>Color</span><input type="color"><output></output></label>'),i=d.children[1];i.value='#'+ms[0].material.color.getHexString();i.oninput=()=>ms.forEach(m=>m.material.color.set(i.value));return d}
function paintTerrainWorldSurface(k,id,amount){const ai=k*4,total=SWA[ai]+SWA[ai+1]+SWA[ai+2]+SWA[ai+3]+SWB[ai]+SWB[ai+1]+SWB[ai+2]+SWB[ai+3]+SWC[ai]+SWC[ai+1]+SWC[ai+2]+SWC[ai+3],fade=1-amount;if(total>.001){for(let q=0;q<4;q++){SWA[ai+q]=SWA[ai+q]/total*fade;SWB[ai+q]=SWB[ai+q]/total*fade;SWC[ai+q]=SWC[ai+q]/total*fade}}else{SWA.fill(0,ai,ai+4);SWB.fill(0,ai,ai+4);SWC.fill(0,ai,ai+4)}if(id<4)SWA[ai+id]+=amount;else if(id<8)SWB[ai+id-4]+=amount;else if(id<12)SWC[ai+id-8]+=amount;MI[k]=255}
/* Surface realism sliders. The measured PBR layers (micro-structure normal
   maps, wetness, snow age, leaf translucency) are always user controls, never
   hidden constants; the stub keeps the panel usable if the module is slow. */
const FR=window.FELandscapeRealism||{settings:{detail:1,wetness:0,snowAge:0,translucency:1}},FRW=(k,v)=>{if(window.setLandscapeRealism)window.setLandscapeRealism(k,v)};
const PN={
terrain:()=>[chips([['raise','⛰ Raise'],['lower','🕳 Lower'],['flat','▬ Flatten'],['smooth','≈ Smooth'],['terrace','▤ Terrace'],['erode','💧 Erode'],['paint','🎨 Paint']],br.tool,v=>{br.tool=v;normalWorldMaterialBrush=false}),
btn('🗺 Biome / PBR material brush',()=>{br.tool='biome';normalWorldMaterialBrush=true;nav=false;setNav();build()}),
...(br.tool=='paint'||br.tool=='biome'?[chips([['classic','Classic materials'],['pbr','Biome / PBR material brush']],normalWorldMaterialBrush?'pbr':'classic',v=>{normalWorldMaterialBrush=v==='pbr';if(v==='pbr'){br.tool='biome';nav=false;setNav()}else if(br.tool==='biome')br.tool='paint'}),...(normalWorldMaterialBrush?[chips(OW_SURFACE_DEFS.map((m,i)=>[i,m.label]),normalWorldMaterial,v=>normalWorldMaterial=v),el('<div class="hint">Paint Hills, Alpine, Desert, Volcano, Sand Shores, Rocky Mountains, Grassy, Sand, Lava, Magma, Pebbles and Beach Sand. Warped world-space PBR texturing reduces visible tiling. This paints surface appearance only; it does not change global biome or foliage scatter.</div>')]:[chips([[0,'Grass'],[1,'Dirt'],[2,'Rock'],[3,'Sand'],[4,'Snow'],[5,'Road']],br.tex,v=>br.tex=v)])]:[]),
G(sl('Radius',2,20,1,br.r,v=>br.r=v),sl('Strength',.1,1,.05,br.str,v=>br.str=v),sl('Roughness',.2,1,.05,tm.roughness,v=>tm.roughness=v),sl('Normal map',0,2,.1,tm.normalScale.x,v=>tm.normalScale.set(v,v))),
G(sl('Micro detail',0,2,.05,FR.settings.detail,v=>FRW('detail',v)),sl('Wetness',0,1,.05,FR.settings.wetness,v=>FRW('wetness',v)),sl('Snow age (days)',0,300,10,FR.settings.snowAge,v=>FRW('snowAge',v)),sl('Leaf translucency',0,1.5,.05,FR.settings.translucency,v=>FRW('translucency',v))),
el('<div class="hint">Micro detail is the measured micro-structure of each material: turf strands, rock bedding, wind-packed snow, bark fibre, leaf veins. Wetness darkens surfaces and films them with water; snow age grows the grains and drops the albedo; leaf translucency lets a back-lit canopy glow. Move every slider to 0 to return to the flat procedural look.</div>'),
chips([['hills','🌿 Hills'],['alpine','🏔 Alpine'],['desert','🏜 Desert'],['volc','🌋 Volcanic'],['jungle','🌴 Jungle'],['taiga','🌲 Taiga'],['tundra','❄ Tundra']],biome,setBiome),
G(sl('Height scale',10,80,1,hs,v=>{const f=v/hs;hs=v;for(let k=0;k<W*W;k++)H[k]*=f;upd();resnap()}),sl('Rock slope',.5,3,.1,rockT,v=>{rockT=v;upd()}),sl('Snow line',2,16,.5,snowL,v=>{snowL=v;upd()})),
btn('🎲 Generate new terrain',()=>{water.visible=true;waterReflectionReady=false;push();gen();scatter()})],
plants:()=>[chips([['paint','🖌 Paint mode'],['select','👆 Tap model to edit']],foliageSelectMode?'select':'paint',v=>setFoliageSelectMode(v==='select')),...foliageSelectionControls(),chips([...Object.keys(LBL).map(k=>[k,LBL[k]]),['erase','🧽 Erase']],br.kind,v=>br.kind=v),
el(`<div class="hint">Foliage and trees keep the selected geometry at all viewing distances. ${OW.active?'Open World keeps plants chunk-local and enforces a 12,000-instance-per-species safety cap per active chunk.':'Manual placement has no fixed instance-count cap; device memory is the practical limit.'} Paint mode adds foliage without removing earlier plants. Painting only adds; use Erase to remove earlier plants. Select & edit mode edits or replaces only the tapped plant.</div>`),
G(sl('Brush radius',2,20,1,br.r,v=>br.r=v),sl('Brush density',1,30,1,br.den,v=>br.den=v),sl('Shallow-water grass depth (m)',.5,3,.1,shallowBrushDepth,v=>{shallowBrushDepth=v;try{localStorage.setItem('final3d.coastalGrassDepth.v1',String(v))}catch{}}),sl('Min tree spacing (auto-scatter)',0,4,.1,br.minGap,v=>br.minGap=v)),
G(sl('Auto-scatter density ×',1,2.5,.05,scatterDensity,v=>scatterDensity=v),sl('Grove clustering',0,1,.05,scatterClustering,v=>scatterClustering=v)),
el(`<div class="hint">Foliage bases follow terrain; brush painting adds without removing prior plants. Manual foliage can be painted across dry terrain, including beach sand and steep slopes; grass/tall grass also paints shallow seabed up to ${shallowBrushDepth.toFixed(1)} m. Deep water stays excluded; auto-scatter stays on land. Min tree spacing applies only to auto-scatter.</div>`),...floraGrowthControls(),...plantCtl(),chips([['spring','🌱 Spring'],['summer','☀️ Summer'],['autumn','🍂 Autumn'],['winter','❄️ Winter']],season,setSeason),
btn(OW.active?'🌱 Add natural scatter to loaded chunks':'🌱 Auto-scatter (natural)',()=>{push();if(OW.active)OW.scatterActive();else scatter(1)}),
btn('Clear all foliage',()=>{push();selectedFoliage=null;foliageSelectMode=false;ring.visible=false;updateFoliageGlow();if(OW.active)OW.clearAllFoliage();else for(const k in KIND){KIND[k].list=[];sync(k)}setNav();build()})],
sky:()=>[el('<div class="hint">Day/night cycle · orbiting suns, moons and planets share this clock</div>'),chips([['cycle',SKY.cycle.on?'Auto day/night: on':'Auto day/night: off']],0,()=>{SKY.cycle.on=!SKY.cycle.on;SKY.cycle.lastUpdate=0;updSky()}),G(sl('Day length (hours)',1,168,1,SKY.cycle.length/3600,v=>{SKY.cycle.length=v*3600}),sl('Cycle speed ×',.1,5,.1,SKY.cycle.speed,v=>{SKY.cycle.speed=v}),sl('Time of day',0,24,.1,tod,v=>{tod=v;updSky()}),sl('Sun angle',0,360,5,az,v=>{az=v;updSky()}),sl('Fog',0,20,.5,fogD*1000,v=>{fogD=v/1e3;updSky()})),...lightingCtl()],
quality:()=>qualityCtl(),
water:()=>[el('<div class="hint">WebGL/PBR MeshPhysical water: a three-cascade Tessendorf ocean uses the Phillips wind spectrum, gravity dispersion and CPU inverse 2D FFTs feed GPU vertex displacement. Each preset names a real water body (ocean, lagoon, reef, alpine lake, river, estuary, peat bog) whose shallow and deep colours are derived from its Jerlov optical type, CDOM load and suspended sediment by Beer-Lambert, so switching preset changes the physics, not just a swatch; they have distinct absorption colors, turbidity, roughness, reflection, refraction and wave profiles. World-space triplanar micro-normal/roughness detail, Fresnel, shoreline foam and dynamic CubeCamera environment reflections of the terrain, foliage and objects add surface detail. It is spectral ocean synthesis, not a full Navier–Stokes/CFD solver or a guarantee of photographic realism on every device.</div>'),chips([...WATER_PROFILES.map((p,i)=>[i,p.name]),['v',water.visible?'Shown':'Hidden']],wp,v=>v=='v'?water.visible=!water.visible:setWater(v)),
G(sl('Level',OW.active?-80:-6,8,.1,wl,v=>{wl=v;wlUserSet=true;if(OW.active){OW.config.waterLevel=v;if(OW.currentConfig)OW.currentConfig.waterLevel=v}water.position.y=v;U.wy.value=v;upd()}),sl('Wave height',0,2.5,.05,ampUser,v=>{ampUser=v;U.amp.value=v;waveAuto=false;updateSeaState()}),sl('Wave speed',0,5,.1,wspd,v=>wspd=v),sl('Wave chop',0,.6,.02,waveChop,v=>{waveChop=v;U.uChop.value=v;updateSeaState()}),sl('Rain',0,1,.05,WX.rainT,v=>{WX.rainT=v;WX.preset=''}),sl('Water clarity',.3,5,.1,U.clar.value,v=>U.clar.value=v)),
G(sl('Wave period (s)',2,18,.1,waterWavePeriod,v=>{waterWavePeriod=v;U.uWavePeriod.value=v;waveAuto=false;updateSeaState()}),sl('Wave scale ×',.4,2,.05,waterWaveScale,v=>{waterWaveScale=v;U.uWaveScale.value=v}),sl('Wind speed (m/s)',0,30,.5,waterWindSpeed,v=>{waterWindSpeed=v;U.uWindSpeed.value=v*windUser;waveAuto=false;updateSeaState()}),sl('Wind direction °',0,360,1,waterWindDir,v=>{waterWindDir=v;U.uWindDir.value.set(Math.cos(v*Math.PI/180),Math.sin(v*Math.PI/180))})),
el(`<div class="hint" id="fe-sea-state">${seaStateText()}</div>`),chips([['auto','Waves follow the weather']],waveAuto?'auto':'',v=>{waveAuto=!waveAuto;waveAutoApplied=-1;if(waveAuto){stepWaveClimate();msg('Waves now follow the climate wind')}else msg('Waves keep their own wind speed')}),el('<div class="hint">A fully developed sea: the height, the period and the wavelength are all derived from the same wind speed, so the sliders and the spectrum cannot disagree.</div>'),
G(waterColorField('Shallow color',U.shal),waterColorField('Deep color',U.deep)),
G(sl('Turbidity',0,1,.01,U.uTurbidity.value,v=>U.uTurbidity.value=v),sl('Transparency',0,1,.01,U.uTransparency.value,v=>U.uTransparency.value=v),sl('Surface roughness',.02,1,.01,U.uRoughness.value,v=>U.uRoughness.value=v),sl('Reflection intensity',0,1.5,.05,U.uReflect.value,v=>U.uReflect.value=v),sl('Refraction strength',0,1,.05,U.uRefraction.value,v=>U.uRefraction.value=v)),
G(sl('Foam amount',0,1.5,.05,U.uFoamAmt.value,v=>U.uFoamAmt.value=v),sl('Crest threshold',.55,.98,.01,U.uFoamThreshold.value,v=>U.uFoamThreshold.value=v),sl('Shore foam width',.1,2,.05,U.uShoreFoam.value,v=>U.uShoreFoam.value=v)),
G(sl('Seabed depth',-6,30,1,SB.depth,v=>{SB.depth=v;sbSoon()}),sl('Shoals and sandbars',0,2,.1,SB.bars,v=>{SB.bars=v;sbSoon()}),sl('Seabed roughness',0,2,.1,SB.rough,v=>{SB.rough=v;sbSoon()}))],
obj:()=>{const r=[chips(Object.keys(LIB).map(k=>[k,k]),place,v=>place=place==v?null:v),
el(`<div class="hint">${place?'Tap the terrain to place a '+place+'. Tap '+place+' again to stop.':sel?'Editing '+sel.userData.n+'. Drag the gizmo handles in the viewport.':'Choose an asset, then tap the terrain. Tap a placed object to edit it.'}</div>`)];
if(objs.length)r.push(el('<div class="hint">Scene Collection</div>'),chips(objs.map((o,i)=>[i,o.userData.n]),objs.indexOf(sel),i=>select(objs[i])));
if(sel){const t=tints(sel);r.push(chips([['translate','Move'],['rotate','Rotate'],['scale','Scale']],tc.getMode(),v=>tc.setMode(v)),G(nf('Location X',()=>sel.position.x,v=>sel.position.x=v),nf('Location Y',()=>-sel.position.z,v=>sel.position.z=-v),nf('Location Z',()=>sel.position.y,v=>sel.position.y=v),nf('Rotation Z °',()=>sel.rotation.y*57.2958,v=>sel.rotation.y=v/57.2958,1),nf('Scale X',()=>sel.scale.x,v=>sel.scale.x=v),nf('Scale Y',()=>sel.scale.z,v=>sel.scale.z=v),nf('Scale Z',()=>sel.scale.y,v=>sel.scale.y=v)),G(sl('Size',.2,4,.05,sel.scale.x,v=>sel.scale.setScalar(v)),...(t.length?[colorRow(t)]:[])),chips([['d','⧉ Duplicate'],['x','🗑 Delete']],0,v=>v=='d'?dup():del()))}return r}};
PN.city=()=>[chips([['house','🏠 Houses'],['block','🏢 Blocks'],['mid','🏬 Mid-rise'],['tower','🏙 Towers'],['erase','🧽 Erase']],br.kind,v=>br.kind=v),
G(sl('Brush radius',2,20,1,br.r,v=>br.r=v),sl('Density',1,30,1,br.den,v=>br.den=v),sl('City radius',12,70,1,cityR,v=>cityR=v),sl('City density',.3,1,.05,cityD,v=>cityD=v)),
chips([['l','Level ground: '+(cityLvl?'on':'off')],['r','Roads: '+(cityRoad?'on':'off')],['t','Tap to place: '+(cityTap?'on':'off')]],0,v=>{if(v=='l')cityLvl=!cityLvl;else if(v=='r')cityRoad=!cityRoad;else{cityTap=!cityTap;setNav()}}),
btn('🏙 Generate City at view center',()=>genCity({x:oc.target.x,z:oc.target.z})),...plantCtl(),
btn('Clear all buildings',()=>{push();for(const q in BLD){KIND[q].list=[];sync(q)}})];
PN.import=()=>[el('<div class="hint">Bring a real-world 3D map or city into the landscape: GLB / GLTF / OBJ models, or a heightmap image. Live Google 3D Tiles must be streamed by your host app, which can send a GLB here.</div>'),
fileBtn('🏙 Import 3D model / city (GLB, GLTF, OBJ)','',importModel),
G(sl('Heightmap relief (m)',5,80,1,dem,v=>dem=v)),fileBtn('🗻 Import heightmap image (PNG / JPG)','image/*',importHeightmap),
...(mapRoot?[Object.assign(el('<div class="hint"></div>'),{textContent:'Imported: '+mapName}),G(sl('Model size',.1,4,.05,mapK,v=>{mapK=v;fitMap()}),sl('Raise / lower',-20,40,.5,mapY,v=>{mapY=v;fitMap()}),sl('Rotate',0,360,5,mapR,v=>{mapR=v;fitMap()})),chips([['f','▭ Flatten terrain under model'],['x','🗑 Remove model']],0,v=>v=='f'?flattenUnder():rmMap())]:[])];
PN.weather=()=>{const CL=window.FELandscapeWeather,cs=CL&&CL.settings;const climate=CL?[
el('<div class="hint">Climate field: latitude, sea-level temperature and humidity decide the biome, the snow line, the fog and the incoming front. Rain darkens and glosses every surface; wind drives the sea, the grass and the tree tops.</div>'),
chips([['a','Climate-driven weather: '+(cs.enabled?'on':'off')],['r','Reset climate']],cs.enabled?0:-1,v=>{if(v=='a')CL.set('enabled',!cs.enabled);else CL.reset()}),
G(sl('Latitude °',-70,70,1,cs.latitude,v=>CL.set('latitude',v)),sl('Sea-level temperature °C',-20,40,.5,cs.temperature,v=>CL.set('temperature',v)),sl('Humidity',0,1,.02,cs.humidity,v=>CL.set('humidity',v))),
G(sl('Continentality',0,1,.02,cs.continentality,v=>CL.set('continentality',v)),sl('Prevailing wind m/s',0,30,.5,cs.wind,v=>CL.set('wind',v)),sl('Weather speed (world h / min)',1,240,1,cs.timeScale,v=>CL.set('timeScale',v))),
el('<div class="hint" id="fe-climate-readout">Reading the climate field…</div>'),
chips([['f','Fog from climate: '+(cs.fog?'on':'off')],['w','Wet surfaces from rain: '+(cs.wetnessFromRain?'on':'off')],['t','Storm tornadoes: '+(cs.autoTornado?'on':'off')]],0,v=>{if(v=='f')CL.set('fog',!cs.fog);else if(v=='w')CL.set('wetnessFromRain',!cs.wetnessFromRain);else CL.set('autoTornado',!cs.autoTornado)}),
btn('Long-wave tsunami at its real phase speed (you launch it)',()=>{const o=CL.tsunami(WX.tsu.amp,120);WX.tsu.spd=Math.max(10,Math.min(50,Math.round(o.speed)));tsuLaunch();const q=document.getElementById('fe-climate-readout');if(q)q.textContent='Long wave '+o.speed.toFixed(0)+' m/s · wavelength '+Math.round(o.wavelength/1000)+' km · run-up '+o.runup.toFixed(1)+' m'})]:[];
return [...climate,chips([['clear','☀ Clear'],['fog','🌫 Fog'],['drizzle','🌦 Drizzle'],['rain','🌧 Rain'],['storm','⛈ Storm'],['blizzard','🌨 Snow']],WX.preset,wxPreset),
G(sl('Rain',0,1,.05,WX.rainT,v=>{WX.rainT=v;WX.preset=''}),sl('Overcast',0,1,.05,WX.overT,v=>WX.overT=v),sl('Storm',0,1,.05,WX.stormT,v=>WX.stormT=v),sl('Wind',0,3,.1,windUser,v=>windUser=v)),
el('<div class="hint">Snow</div>'),
G(sl('Snowfall',0,1,.05,WX.snowfallT,v=>{WX.snowfallT=v;WX.snowAuto=false}),sl('Snow cover',0,1,.05,WX.coverT,v=>{WX.coverT=v;WX.snowAuto=false}),sl('Melt speed',0,3,.1,WX.melt,v=>WX.melt=v)),
chips([['a','Season-driven snow: '+(WX.snowAuto?'on':'off')]],0,()=>{WX.snowAuto=!WX.snowAuto}),
el('<div class="hint">Seasons</div>'),
el('<div class="hint">Spring stops seasonal snowfall; winter snow melts away while new leaves and blossoms grow in gradually. Use the snowfall control for a manual weather override.</div>'),
chips([['spring','🌸 Spring'],['summer','☀ Summer'],['autumn','🍂 Autumn'],['winter','❄ Winter']],season,setSeason),
G(sl('Season progress',0,1,.005,WX.seasonT,v=>{WX.seasonT=v}),sl('Year length (s)',20,600,10,WX.cycle,v=>WX.cycle=v),sl('Leaves per day per tree',1,10,1,WX.leafRate,v=>WX.leafRate=v)),
el('<div class="hint">Autumn shedding is staggered, not triggered all at once. Wind carries leaves gently; settled leaves lie flat against the ground.</div>'),
chips([['p','Auto cycle: '+(WX.seasonAuto?'on':'off')],['w','Wait for leaves: '+(WX.waitLeaves?'on':'off')]],0,v=>{if(v=='p'){WX.seasonAuto=!WX.seasonAuto;if(WX.seasonAuto)WX.snowAuto=true}else WX.waitLeaves=!WX.waitLeaves}),
el('<div class="hint">Tornado</div>'),
G(sl('Size',3,20,1,WX.tor.r,v=>WX.tor.r=v),sl('Speed',3,25,1,WX.tor.spd,v=>WX.tor.spd=v),sl('Intensity (EF)',1,5,1,WX.tor.ef,v=>WX.tor.ef=v)),
chips([['go','🌪 Spawn tornado'],['stop','Stop'],['d','Damage: '+(WX.tor.dmg?'on':'off')],['c','Clear debris']],0,v=>{if(v=='go')torSpawn();else if(v=='stop')torStop();else if(v=='c')debClear();else WX.tor.dmg=!WX.tor.dmg}),
el('<div class="hint">Tsunami · a tectonic event you launch yourself. The climate only supplies the wave physics (phase speed, wavelength, shoaling, run-up); nothing starts one on its own.</div>'),
G(sl('Height (m)',2,18,1,WX.tsu.amp,v=>WX.tsu.amp=v),sl('Speed (m/s)',10,50,1,WX.tsu.spd,v=>WX.tsu.spd=v),sl('Direction °',0,360,5,WX.tsu.dir,v=>WX.tsu.dir=v)),
chips([['go','🌊 Launch tsunami'],['stop','Reset'],['d','Damage: '+(WX.tsu.dmg?'on':'off')],['c','Clear debris']],0,v=>{if(v=='go')tsuLaunch();else if(v=='stop')tsuReset();else if(v=='c')debClear();else WX.tsu.dmg=!WX.tsu.dmg})]};

const posXYZ=(o,ch)=>{const v=()=>CelestialMath.cartesianFromSpherical(o),set=(x,y,z)=>{const angularSize=o.size;CelestialMath.setFromCartesian(o,x,y,z);o.size=angularSize;ch()},p=v();
return[sl('Position X',-200,200,1,Math.round(p[0]),vx=>{const q=v();set(vx,q[1],q[2])}),sl('Position Y',-200,200,1,Math.round(p[1]),vy=>{const q=v();set(q[0],vy,q[2])}),sl('Position Z',-200,200,1,Math.round(p[2]),vz=>{const q=v();set(q[0],q[1],vz)})]};
PN.skyx=()=>{const o=[],ch=()=>updSky(),sel=(arr,k)=>{SKYSEL[k]=Math.min(SKYSEL[k],Math.max(0,arr.length-1))};
sel(SKY.suns,'sun');sel(SKY.moons,'moon');sel(SKY.planets,'planet');sel(SKY.clouds,'cloud');
o.push(el('<div class="hint">Each sun, moon and planet keeps its own settings. Position changes preserve angular size.</div>'));
o.push(el('<div class="hint">Suns (up to 4)</div>'),chips(SKY.suns.map((s,i)=>[i,'☀ '+(i+1)]).concat(SKY.suns.length<4?[['+','＋ Sun']]:[]),SKYSEL.sun,v=>{if(v=='+'){SKY.suns.push(newSun());SKYSEL.sun=SKY.suns.length-1}else SKYSEL.sun=v;ch()}));
{const s=SKY.suns[SKYSEL.sun],i=SKYSEL.sun;if(i)o.push(chips([['orbit','Sync with day/night'],['fixed','Fixed position']],s.mode||'orbit',v=>{s.mode=v;ch()}));const pos=i?(s.mode=='fixed'?[...posXYZ(s,ch),sl('Azimuth °',0,360,5,s.az,v=>{s.az=v;ch()}),sl('Elevation °',-10,90,1,s.el,v=>{s.el=v;ch()})]:[sl('Orbit azimuth offset °',0,360,5,s.az,v=>{s.az=v;ch()}),sl('Orbit inclination °',0,60,1,s.el,v=>{s.el=v;ch()})]):[];o.push(G(sl('Angular size °',.3,25,.1,s.size,v=>skyField(SKY.suns,s.id,'size',v)),sl('Brightness',0,3,.05,s.inten,v=>{s.inten=v;ch()}),sl('Temperature K',1500,12000,100,s.temp,v=>{s.temp=v;ch()}),...pos));if(i)o.push(chips([['rm','Remove this sun']],0,()=>{SKY.suns.splice(i,1);SKYSEL.sun=0;ch()}))}
o.push(el('<div class="hint">Moons (up to 3) — phase controls illumination; position is adjusted separately</div>'),chips(SKY.moons.map((s,i)=>[i,'🌙 '+(i+1)]).concat(SKY.moons.length<3?[['+','＋ Moon']]:[]),SKYSEL.moon,v=>{if(v=='+'){SKY.moons.push(newMoon());SKYSEL.moon=SKY.moons.length-1}else SKYSEL.moon=v;ch()}));
if(SKY.moons.length){const m=SKY.moons[SKYSEL.moon],i=SKYSEL.moon;o.push(chips([['orbit','Follows time'],['fixed','Fixed position']],m.mode,v=>{m.mode=v;ch()}),G(sl('Angular size °',.5,25,.1,m.size,v=>skyField(SKY.moons,m.id,'size',v)),sl('Brightness',0,3,.05,m.inten,v=>{m.inten=v;ch()}),sl('Moonlight strength',0,3,.05,m.light,v=>{m.light=v;ch()}),sl('Moon phase ° (0 = new, 180 = full)',0,360,5,m.phase,v=>{m.phase=v;ch()}),sl('Colour K',3000,12000,100,m.temp,v=>{m.temp=v;ch()}),...(m.mode=='orbit'?[sl('Orbit azimuth °',0,360,5,m.az,v=>{m.az=v;ch()}),sl('Orbit position offset °',0,360,5,m.orbitPos,v=>{m.orbitPos=v;ch()})]:[sl('Azimuth °',0,360,5,m.az,v=>{m.az=v;ch()}),...posXYZ(m,ch),sl('Elevation °',-10,90,1,m.el,v=>{m.el=v;ch()})])),chips([['rm','Remove this moon']],0,()=>{SKY.moons.splice(i,1);SKYSEL.moon=0;ch()}))}
o.push(el('<div class="hint">Planets (up to 6)</div>'),chips(SKY.planets.map((p,i)=>[i,p.name]),SKYSEL.planet,v=>{SKYSEL.planet=v;ch()}));
if(SKY.planets.length<6)o.push(chips(Object.keys(PLANETS).map(k=>[k,'＋ '+PLANETS[k].name]),-1,v=>{SKY.planets.push(newPlanet(v));SKYSEL.planet=SKY.planets.length-1;ch()}));
if(SKY.planets.length){const p=SKY.planets[SKYSEL.planet],i=SKYSEL.planet,cs=(a,nm,idx)=>sl(nm,0,1,.01,a[idx],v=>{a[idx]=v;ch()});o.push(G(sl('Angular size °',.3,20,.1,p.size,v=>skyField(SKY.planets,p.id,'size',v)),sl('Brightness',0,3,.05,p.inten,v=>{p.inten=v;ch()}),...posXYZ(p,ch),sl('Azimuth °',0,360,5,p.az,v=>{p.az=v;ch()}),sl('Elevation °',-10,90,1,p.el,v=>{p.el=v;ch()}),sl('Phase (1 = full)',0,1,.01,p.phase,v=>{p.phase=v;ch()}),sl('Bands',0,24,1,p.bands,v=>{p.bands=v;ch()}),sl('Tilt',0,1.5,.05,p.tilt,v=>{p.tilt=v;ch()}),sl('Atmosphere glow',0,1.5,.05,p.atm,v=>{p.atm=v;ch()}),cs(p.c1,'Colour A red',0),cs(p.c1,'Colour A green',1),cs(p.c1,'Colour A blue',2),cs(p.c2,'Colour B red',0),cs(p.c2,'Colour B green',1),cs(p.c2,'Colour B blue',2)),chips([[0,'Rocky'],[1,'Gas giant'],[2,'Cloudy'],[3,'Earth-like']],p.type,v=>{p.type=v;ch()}),chips([['r',p.rings?'Rings: on':'Rings: off'],['f',p.follow?'Follows day/night':'Fixed in sky'],['rm','Remove']],0,v=>{if(v=='r')p.rings=p.rings?0:1;else if(v=='f')p.follow=p.follow?0:1;else{SKY.planets.splice(i,1);SKYSEL.planet=0}ch()}))}
o.push(el('<div class="hint">Clouds (up to 4 layers)</div>'),chips(SKY.clouds.map((c,i)=>[i,CTYPE[c.type]]),SKYSEL.cloud,v=>{SKYSEL.cloud=v;ch()}));
if(SKY.clouds.length<4)o.push(chips(CTYPE.map((n,i)=>[i,'＋ '+n]),-1,v=>{SKY.clouds.push(newCloud(v));SKYSEL.cloud=SKY.clouds.length-1;ch()}));
if(SKY.clouds.length){const c=SKY.clouds[SKYSEL.cloud],i=SKYSEL.cloud;o.push(G(sl('Coverage',0,1,.02,c.cov,v=>{c.cov=v;ch()}),sl('Density',0,1.5,.05,c.dens,v=>{c.dens=v;ch()}),sl('Altitude',.5,3,.05,c.alt,v=>{c.alt=v;ch()}),sl('Scale',.3,3,.05,c.scale,v=>{c.scale=v;ch()}),sl('Speed',0,5,.1,c.speed,v=>{c.speed=v;ch()}),sl('Direction °',0,360,5,c.dir,v=>{c.dir=v;ch()}),sl('Brightness',.2,1.6,.05,c.bright,v=>{c.bright=v;ch()})),chips([['rm','Remove this layer']],0,()=>{SKY.clouds.splice(i,1);SKYSEL.cloud=0;ch()}))}
o.push(el('<div class="hint">Aurora</div>'),chips([['t',SKY.aurora.on?'Aurora: on':'Aurora: off']],0,()=>{SKY.aurora.on=!SKY.aurora.on;ch()}),G(sl('Intensity',0,2,.05,SKY.aurora.inten,v=>{SKY.aurora.inten=v;ch()}),sl('Height',.3,2,.05,SKY.aurora.height,v=>{SKY.aurora.height=v;ch()}),sl('Speed',0,4,.1,SKY.aurora.speed,v=>{SKY.aurora.speed=v;ch()}),sl('Width',.3,3,.05,SKY.aurora.width,v=>{SKY.aurora.width=v;ch()}),sl('Colour shift',0,360,5,SKY.aurora.hue,v=>{SKY.aurora.hue=v;ch()})));
o.push(el('<div class="hint">Stars and atmosphere</div>'),G(sl('Star brightness',0,3,.05,SKY.stars.inten,v=>{SKY.stars.inten=v;ch()}),sl('Star density',0,3,.05,SKY.stars.density,v=>{SKY.stars.density=v;ch()}),sl('Twinkle',0,2,.05,SKY.stars.twinkle,v=>{SKY.stars.twinkle=v;ch()}),sl('Milky Way',0,3,.05,SKY.stars.milky,v=>{SKY.stars.milky=v;ch()}),sl('Sky brightness',.4,1.6,.05,SKY.atmo.bright,v=>{SKY.atmo.bright=v;ch()}),sl('Haze',0,1,.05,SKY.atmo.haze,v=>{SKY.atmo.haze=v;ch()}),sl('Latitude °',-80,80,1,SKY.atmo.lat,v=>{SKY.atmo.lat=v;ch()}),sl('Night ambient light',0,3,.05,SKY.night.ambient,v=>{SKY.night.ambient=v;ch()})));
return o};
PN.planet=()=>{const a=planetApply,o=[];o.push(chips([['view',PLANON?'🏝 Back to land':'🪐 View planet'],['gen','🎲 New planet'],['auto',PLAN.auto?'Descend on zoom: on':'Descend on zoom: off']],0,planetAct),el('<div id="pinfo" class="hint">'+PLAN.info+'</div>'),el('<div class="hint">Presets</div>'),chips(Object.keys(PLP).map(k=>[k,PLP[k].n]),'',planetPreset));if(PLANON)o.push(chips([['land','🧭 Build this surface here']],0,planetAct));
o.push(el('<div class="hint">Shape (regenerates the map)</div>'),G(sl('Seed',1,999,1,PLAN.seed,v=>{PLAN.seed=v;planetSoon()}),sl('Continent size',.4,3,.05,PLAN.cont,v=>{PLAN.cont=v;planetSoon()}),sl('Mountains',0,2,.05,PLAN.mount,v=>{PLAN.mount=v;a();planetSoon()})));
o.push(el('<div class="hint">Oceans and climate (instant)</div>'),G(sl('Ocean level',0,1,.01,PLAN.sea,v=>{PLAN.sea=v;a()}),sl('Temperature',-.5,.5,.01,PLAN.temp,v=>{PLAN.temp=v;a()}),sl('Moisture',-.5,.5,.01,PLAN.moist,v=>{PLAN.moist=v;a()}),sl('Ice caps',0,1.5,.05,PLAN.ice,v=>{PLAN.ice=v;a()})));
o.push(el('<div class="hint">Atmosphere and clouds</div>'),G(sl('Atmosphere density',0,2,.05,PLAN.atm,v=>{PLAN.atm=v;a()}),sl('Atmosphere colour',0,360,5,PLAN.hue,v=>{PLAN.hue=v;a()}),sl('Cloud cover',0,1,.02,PLAN.cloud,v=>{PLAN.cloud=v;a()}),sl('Cloud wind',0,5,.1,PLAN.wind,v=>{PLAN.wind=v;a()})));
o.push(el('<div class="hint">Night side and rotation</div>'),G(sl('City lights',0,2,.05,PLAN.lights,v=>{PLAN.lights=v;a()}),sl('Spin',0,5,.1,PLAN.spin,v=>PLAN.spin=v),sl('Axial tilt °',0,90,1,PLAN.tilt,v=>{PLAN.tilt=v;a()})),chips([['lava',PLAN.lava?'Lava world: on':'Lava world: off'],['alien',PLAN.alien?'Alien colours: on':'Alien colours: off']],0,planetAct));
return o};
{const _pt=PN.terrain;PN.terrain=()=>{const region=PLAN.landed,context=region?[el(`<div class="hint">Planet surface: ${region.c.kind} biome · ${Math.abs(region.lat).toFixed(1)}° ${region.lat>=0?'N':'S'}, ${Math.abs(region.lon).toFixed(1)}° ${region.lon>=0?'E':'W'} · seed ${Math.round(PLAN.seed)}</div>`),chips([['orbit','🪐 Return to planet orbit']],0,()=>{setTab('planet');planetEnter()})]:[];function runMapErosion(mode){const core=window.FELandscapeCore;if(!core.ready){showErr('C++ terrain engine is still loading');return}
/* Hydraulic erosion is a live run now: press to start, press again to stop.
   Strata and thermal stay one-shot because they are a single pass by nature. */
if(mode==='hydro'){if(typeof LIVE!=='undefined'&&LIVE.on)stopLiveErosion();else startLiveErosion();if(tab=='terrain')build();return}
const ok=mode==='strata'?core.strata({n:N,size:S,heights:H,height:9,strength:.55,tiltX:.03,tiltZ:.012,warp:7}):core.erode({mode:'thermal',n:N,size:S,heights:H,seed:(Math.round(seed*1000)+1)>>>0,droplets:12000,iterations:24,talus:Math.tan(.6),slump:.5});if(!ok){showErr('C++ erosion failed: '+(core.error||'unknown'));return}upd();msg('Whole-map '+(mode==='strata'?'strata terracing':'thermal erosion')+' completed in C++');if(tab=='terrain')build()}
return[...context,chips([['p','🪐 Create a whole planet']],0,()=>setTab('planet')),..._pt(),chips([['grid','Floor grid']],terrainGridOn?'grid':'',()=>setTerrainGrid(!terrainGridOn)),chips([['hydro','💧 Hydraulic erosion'],['thermal','⛰ Thermal erosion'],['strata','🪨 Strata terraces']],typeof LIVE!=='undefined'&&LIVE.on?'hydro':'',runMapErosion),
G(sl('Erosion area (m)',40,400,10,typeof LIVE!=='undefined'?LIVE.area:120,v=>{LIVE.area=v}),sl('Erosion rate ×',.25,3,.05,typeof LIVE!=='undefined'?LIVE.rate:1,v=>{LIVE.rate=v})),
(function(){const d=el('<div class="hint" id="erosion-live"></div>');d.textContent=typeof LIVE!=='undefined'&&LIVE.on?'Eroding \u00b7 press Hydraulic erosion again to stop':'Hydraulic erosion runs live: the kernel simulates a slice of rain each frame around the place you are looking at, and only the changed band is uploaded. Press the chip to start or stop.';return d})(),
el('<div class="hint">Whole-map erosion and strata terracing run in the C++ core. They modify terrain height and can be undone.</div>'),el('<div class="hint">Studio settings · every slider, the open-world setup and the climate are saved automatically as one JSON document and come back after a reload.</div>'),chips([['exp','Export settings JSON'],['imp','Load settings from JSON']],0,v=>{if(v==='exp')exportStudioSettings();else importStudioSettings()})]}}
$('#cls').onclick=()=>$('#bw').click();
function seaStateText(){
 const p=wavePhysicsForWind(waterWindSpeed);
 return`Wind ${p.wind.toFixed(1)} m/s · significant wave height ${ampUser.toFixed(2)} m · peak period ${waterWavePeriod.toFixed(1)} s · wavelength ${p.length.toFixed(0)} m`;
}
function updateSeaState(){const el=document.getElementById('fe-sea-state');if(el)el.textContent=seaStateText()}
/* One throw inside a sheet builder used to leave the drawer empty and the sheet
   useless, with the error only in the console. The sheet now reports which tab
   failed and still opens, so the rest of the studio stays reachable. */
function build(){
 nfs=[];
 const make=PN[tab];
 if(typeof make!=='function'){showErr('Panel: no builder for '+tab);return}
 let nodes;
 try{nodes=make()}
 catch(error){showErr('Panel ('+tab+'): '+String((error&&(error.stack||error.message))||error).slice(0,700));return}
 try{$('#dr').replaceChildren(...nodes)}
 catch(error){showErr('Panel ('+tab+'): '+String((error&&(error.stack||error.message))||error).slice(0,700))}
}
/* ---- studio settings: one JSON document -------------------------------
   Every landscape sheet writes straight into a live variable, so until now a
   reload threw the whole studio back to its defaults. The full set is now
   serialised into a single JSON document with three sections (studio,
   open-world, climate), written to localStorage on a short debounce, and it
   can be exported as a file or pasted back in. A native build has no
   localStorage; the same document is what it writes to disk. */
const STUDIO_CONFIG_KEY='fe_landscape_config_v1',STUDIO_CONFIG_KIND='landscape-settings';
let studioConfigTimer=0,studioConfigDirty=false;
function studioConfigDoc(){
  const wx=window.FELandscapeWeather;
  return{app:'final-effect',kind:STUDIO_CONFIG_KIND,version:1,savedAt:new Date().toISOString(),
    studio:captureStudioSettings(),
    openWorld:{...OW.config,biomeMix:{...OW.config.biomeMix}},
    climate:wx?{...wx.settings}:null};
}
function serializeStudioConfig(){return JSON.stringify(studioConfigDoc(),null,1)}
function persistStudioConfig(){
  try{localStorage.setItem(STUDIO_CONFIG_KEY,JSON.stringify(studioConfigDoc()));return true}
  catch(error){return false}
}
function readStudioConfig(){
  try{
    const raw=localStorage.getItem(STUDIO_CONFIG_KEY);
    if(!raw)return null;
    const doc=JSON.parse(raw);
    return doc&&doc.kind===STUDIO_CONFIG_KIND&&doc.studio?doc:null;
  }catch(error){return null}
}
/* Unknown or differently typed fields are ignored, so an older or newer
   document can never inject a string where the studio expects a number. */
function applyStudioConfig(doc){
  if(!doc||typeof doc!=='object'||doc.kind!==STUDIO_CONFIG_KIND||!doc.studio||typeof doc.studio!=='object')return false;
  restoreStudioSettings(doc.studio);
  if(Number.isFinite(doc.studio.seed))window.__feStartupSeed=doc.studio.seed;
  if(doc.openWorld&&typeof doc.openWorld==='object'){
    const c=OW.config;
    for(const k in c){if(k==='biomeMix')continue;if(!Object.prototype.hasOwnProperty.call(doc.openWorld,k))continue;if(typeof doc.openWorld[k]===typeof c[k])c[k]=doc.openWorld[k]}
    /* The biome mix is merged, never replaced: a document that names one
       influence must not silently zero the other three. */
    if(doc.openWorld.biomeMix&&typeof doc.openWorld.biomeMix==='object')for(const k in c.biomeMix)if(Number.isFinite(doc.openWorld.biomeMix[k]))c.biomeMix[k]=doc.openWorld.biomeMix[k];
  }
  const wx=window.FELandscapeWeather;
  if(wx&&doc.climate&&typeof doc.climate==='object'){
    for(const k in wx.settings)if(Object.prototype.hasOwnProperty.call(doc.climate,k)&&typeof doc.climate[k]===typeof wx.settings[k])wx.settings[k]=doc.climate[k];
    if(typeof wx.syncKernel==='function')wx.syncKernel();
  }
  return true;
}
function queueStudioConfigSave(){
  studioConfigDirty=true;
  if(studioConfigTimer)return;
  studioConfigTimer=setTimeout(()=>{studioConfigTimer=0;if(studioConfigDirty){studioConfigDirty=false;persistStudioConfig()}},700);
}
function restorePersistedStudioConfig(){
  const doc=readStudioConfig();
  return doc?applyStudioConfig(doc):false;
}
window.__feRestoreStudioConfig=restorePersistedStudioConfig;
window.__feSerializeStudioConfig=serializeStudioConfig;
const studioPanel=typeof document!=='undefined'?document.getElementById('panel'):null;
if(studioPanel){
  studioPanel.addEventListener('input',queueStudioConfigSave,true);
  studioPanel.addEventListener('change',queueStudioConfigSave,true);
  studioPanel.addEventListener('click',queueStudioConfigSave,true);
}
window.addEventListener('pagehide',()=>{if(studioConfigDirty||studioConfigTimer)persistStudioConfig()});
function exportStudioSettings(){
  showLandscapeExportFallback(serializeStudioConfig(),'Studio settings JSON. Copy it as a backup, or paste a saved document into this box and press Load settings from JSON.');
  return true;
}
function importStudioSettings(){
  const box=document.getElementById('exp');
  let doc=null;
  try{doc=JSON.parse((box&&box.value)||'')}catch(error){showErr('That is not a JSON document');return false}
  if(!applyStudioConfig(doc)){showErr('That JSON is not a studio settings document');return false}
  try{gen(window.__feStartupSeed);scatter();updSky();build()}catch(error){showErr('Settings restored, but the scene could not be rebuilt: '+(error&&error.message))}
  persistStudioConfig();
  msg('Studio settings loaded');
  return true;
}

/* ---- Climate biomes: an explicit action, never an automatic one --------
   The painted layers (SWA/SWB/SWC on the default island, twelve weights per
   vertex on open-world chunks) belong to the artist. The climate field is
   consulted only when this action is pressed, it writes one fully weighted
   surface per vertex, and it pushes an undo step first so a press is always
   reversible. */
const CLIMATE_SURFACE_KEYS=OW_SURFACE_DEFS.map(d=>d.key);
function climateSurfaceIds(){
  const wx=window.FELandscapeWeather;
  if(!wx||!wx.BIOMES||!wx.BIOME_SURFACE)return null;
  return wx.BIOMES.map(b=>CLIMATE_SURFACE_KEYS.indexOf(wx.BIOME_SURFACE[b]));
}
function setOwStatus(text){const n=document.getElementById('owstatus');if(n)n.textContent=text}
/* `all` repaints every vertex; `free` only touches ground that carries no
   painted weight, so a hand-painted island keeps its own biomes and the climate
   fills the rest. Both are explicit presses. */
let climateApplyMode='all';
function paintedWeightAt(weights,base,count){let sum=0;for(let q=0;q<count;q++)sum+=weights[base+q];return sum}
function climateBatch(){
  const wx=window.FELandscapeWeather,core=window.FELandscapeCore;
  if(!wx||!core||!core.ready||typeof core.climateBiomeGrid!=='function')return null;
  if(typeof wx.syncKernel==='function')wx.syncKernel();
  const ids=climateSurfaceIds();
  if(!ids)return null;
  const hour=wx.state&&Number.isFinite(wx.state.clock)?((wx.state.clock%24)+24)%24:12;
  const batch=[];
  if(OW&&OW.active&&OW.chunks&&OW.chunks.size){
    for(const c of OW.chunks.values()){
      const grid=core.climateBiomeGrid(c.heights,c.segments+1,c.size,c.originX,c.originZ,hour);
      if(!grid)return null;
      batch.push({grid:Uint8Array.from(grid),chunk:c});
    }
  }else{
    const grid=core.climateBiomeGrid(H,W,S,0,0,hour);
    if(!grid)return null;
    batch.push({grid:Uint8Array.from(grid),chunk:null});
  }
  return {batch,ids,biomes:wx.BIOMES};
}
function applyClimateBiomes(){
  const plan=climateBatch();
  if(!plan){setOwStatus('Climate biomes need the engine build — reload the page and try again');return false}
  const {batch,ids,biomes}=plan;
  const tally=new Array(biomes.length).fill(0);
  push();
  let kept=0,keptChunks=0,chunks=0;
  for(const {grid,chunk} of batch){
    if(chunk){
      chunks++;
      /* A painted open-world chunk is one tile of the artist's map: it keeps its
         surface weave as a whole, so a fill can never speckle a chunk he has
         worked on. The island below stays per-vertex, because there a stroke is
         a region, not a tile. */
      let painted=false;
      if(climateApplyMode==='free'){
        for(let k=0;k<grid.length&&!painted;k++)if(paintedWeightAt(chunk.surfaceWeights,k*12,12)>.001)painted=true;
        if(painted){kept+=grid.length;keptChunks++;for(let k=0;k<grid.length;k++)tally[grid[k]]++;continue}
        for(let k=0;k<grid.length;k++){
          const id=ids[grid[k]];
          if(id<0)continue;
          chunk.surfaceWeights.fill(0,k*12,k*12+12);
          chunk.surfaceWeights[k*12+id]=1;
        }
      }else{
        chunk.surfaceWeights.fill(0);
        for(let k=0;k<grid.length;k++){const id=ids[grid[k]];if(id>=0)chunk.surfaceWeights[k*12+id]=1}
      }
      chunk.dirty=true;
      owUpdateChunkGeometry(chunk);
    }else{
      if(climateApplyMode==='free'){
        for(let k=0;k<grid.length;k++){
          if(SWA[k*4]+SWA[k*4+1]+SWA[k*4+2]+SWA[k*4+3]+SWB[k*4]+SWB[k*4+1]+SWB[k*4+2]+SWB[k*4+3]+SWC[k*4]+SWC[k*4+1]+SWC[k*4+2]+SWC[k*4+3]>.001){kept++;continue}
          const id=ids[grid[k]],b=k*4;
          if(id<0)continue;
          SWA[b]=SWA[b+1]=SWA[b+2]=SWA[b+3]=0;
          SWB[b]=SWB[b+1]=SWB[b+2]=SWB[b+3]=0;
          SWC[b]=SWC[b+1]=SWC[b+2]=SWC[b+3]=0;
          if(id<4)SWA[b+id]=1;else if(id<8)SWB[b+id-4]=1;else if(id<12)SWC[b+id-8]=1;
          MI[k]=255;
        }
      }else{
        SWA.fill(0);SWB.fill(0);SWC.fill(0);MI.fill(255);
        for(let k=0;k<grid.length;k++){
          const id=ids[grid[k]],b=k*4;
          if(id<0)continue;
          if(id<4)SWA[b+id]=1;else if(id<8)SWB[b+id-4]=1;else if(id<12)SWC[b+id-8]=1;
        }
      }
    }
    for(let k=0;k<grid.length;k++)tally[grid[k]]++;
  }
  if(!batch.length)return false;
  if(batch[0].chunk===null)upd();
  const total=tally.reduce((a,b)=>a+b,0)||1;
  const top=tally.map((n,i)=>({n,i})).filter(x=>x.n).sort((a,b)=>b.n-a.n).slice(0,3)
    .map(x=>`${(window.FELandscapeWeather.BIOME_LABELS||{})[biomes[x.i]]||biomes[x.i]} ${Math.round(x.n/total*100)}%`);
  const suffix=climateApplyMode!=='free'?'':chunks
    ?` · ${keptChunks} of ${chunks} chunks kept from your painting`
    :` · ${Math.round(kept/Math.max(1,kept+total)*100)}% kept from your painting`;
  setOwStatus('Climate biomes applied · '+top.join(' · ')+suffix);
  return {cells:total,tally,kept,keptChunks,chunks};
}

PN.openworld=()=>{const c=OW.config;return[el('<div class="hint">Separate seeded terrain streamed as 256 m chunks around the camera. Only a 3×3 neighborhood is active; deterministic chunks and edited terrain are retained independently of the normal island. Hills, Alpine, Desert and Volcano biomes blend naturally. Existing sky, weather, water, quality and foliage tools remain shared.</div>'),G(sl('World size (km)',1,50,1,c.sizeKm,v=>{if(typeof owSetWorldSize==='function')owSetWorldSize(v);else c.sizeKm=v}),sl('Seed',1,999999,1,c.seed,v=>c.seed=v)),el('<div class="hint">Only the chunks around you are held in memory, so a larger world streams further instead of using more memory.</div>'),G(sl('Hills influence ×',0,2,.05,c.biomeMix.hills,v=>c.biomeMix.hills=v),sl('Alpine influence ×',0,2,.05,c.biomeMix.alpine,v=>c.biomeMix.alpine=v),sl('Desert influence ×',0,2,.05,c.biomeMix.desert,v=>c.biomeMix.desert=v),sl('Volcano influence ×',0,2,.05,c.biomeMix.volc,v=>c.biomeMix.volc=v)),G(sl('Natural biome blend',0,1,.05,c.blend,v=>c.blend=v),sl('Mountain height',0,100,1,c.mountainHeight,v=>c.mountainHeight=v),sl('Water coverage',0,100,1,c.waterCoverage,v=>c.waterCoverage=v),sl('Sea level (m)',-100,0,1,c.waterLevel,v=>c.waterLevel=v),sl('Vegetation density ×',0,2.5,.05,c.vegetationDensity,v=>c.vegetationDensity=v)),el('<div class="hint">World presets · all four biome systems remain available</div>'),chips([['temperate','Temperate'],['desert','Desert'],['alpine','Alpine'],['island','Island']],'',v=>{if(v==='temperate')Object.assign(c,{blend:.68,biomeMix:{hills:1.4,alpine:.9,desert:.55,volc:.4},mountainHeight:42,waterCoverage:28,waterLevel:-24,vegetationDensity:.95});else if(v==='desert')Object.assign(c,{blend:.42,biomeMix:{hills:.5,alpine:.2,desert:1.9,volc:.55},mountainHeight:35,waterCoverage:18,waterLevel:-26,vegetationDensity:.75});else if(v==='alpine')Object.assign(c,{blend:.35,biomeMix:{hills:.55,alpine:1.9,desert:.2,volc:.8},mountainHeight:82,waterCoverage:32,waterLevel:-28,vegetationDensity:.8});else Object.assign(c,{blend:.58,biomeMix:{hills:1.2,alpine:.55,desert:1.2,volc:.55},mountainHeight:48,waterCoverage:56,waterLevel:-32,vegetationDensity:.9})}),el('<div class="hint">Climate biomes · your painted layers stay exactly as they are until you apply the climate map. The action is undoable.</div>'),chips([['all','Apply to all ground'],['free','Fill unpainted ground only']],climateApplyMode,v=>{climateApplyMode=v}),btn('<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" style="vertical-align:-2px"><path d="M2 13c2-1 4-1.6 6-1.6S12.2 12 14 13"/><path d="M2.6 9.2c1.9-.9 3.9-1.4 5.4-1.4s3.5.5 5.4 1.4"/><path d="M4.6 5.6C5.6 4.2 7 3.4 8 3.4s2.4.8 3.4 2.2"/></svg> Apply Climate Biomes',()=>applyClimateBiomes()),el(`<div class="hint" id="owstatus">${OW.active?(OW.generating?'Streaming chunks…':OW.chunks.size+' chunks loaded'):OW.generated?'World generated · press Enter to resume':'Ready to generate'}</div>`),...(OW.active?[btn('🌿 Foliage & scatter settings',()=>setTab('plants'))]:[]),btn(OW.active?'Regenerate Open World Map':OW.generated?'Enter Open World':'Generate Open World Map',()=>OW.start()),btn('Return to default terrain',()=>{OW.deactivate();setTab('terrain')})]};
const TABS=[['terrain','⛰','Terrain'],['openworld','🌍','Open World'],['planet','🪐','Planet'],['plants','🌲','Foliage'],['city','🏙','City'],['quality','✨','Quality'],['sky','☀️','Lighting'],['skyx','🌌','Sky'],['water','🌊','Water'],['weather','⛈','Weather'],['obj','🪑','Objects'],['import','🌍','Import']];
TABS.forEach(([id,i,l])=>{const b=el(`<button class="tab" data-id="${id}"><i>${i}</i>${l}</button>`);b.onclick=()=>setTab(id);$('#tabs').append(b)});
const brushTab=()=>OW?.active?(bt=='terrain'||bt=='openworld'||bt=='plants'): (bt=='terrain'||bt=='plants'||bt=='city'&&!cityTap);
function setNav(){const p=brushTab()&&!nav;oc.mouseButtons={LEFT:p?-1:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.ROTATE,RIGHT:THREE.MOUSE.PAN};oc.touches={ONE:p?-1:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN};
$('#mode').style.display='';$('#mode').textContent=foliageSelectMode?'👆 Select foliage':nav?'✋ Orbit':'🖌 Brush';$('#mode').classList.toggle('on',!nav)}
const ring=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({length:64},(_,i)=>new THREE.Vector3(Math.cos(i/64*6.283),0,Math.sin(i/64*6.283)))),new THREE.LineBasicMaterial({color:0xffffff,depthTest:false,transparent:true}));
ring.renderOrder=9;ring.userData.isEditorHelper=true;TERRAIN_EDITOR_HELPERS.add(ring);ring.visible=false;scene.add(ring);
const foliageGlowGroup=new THREE.Group(),foliageGlowMaterial=new THREE.MeshBasicMaterial({color:0x79f6ff,wireframe:true,transparent:true,opacity:.88,depthTest:false,depthWrite:false,toneMapped:false});foliageGlowGroup.name='Selected foliage outline';foliageGlowGroup.userData.isEditorHelper=true;scene.add(foliageGlowGroup);
function updateFoliageGlow(){while(foliageGlowGroup.children.length)foliageGlowGroup.remove(foliageGlowGroup.children[0]);if(!foliageSelectMode)return;const s=getSelectedFoliage();if(!s)return;const {kind,K,item}=s,wx=item.fl?.x??item.x,wz=item.fl?.z??item.z,gy=item.fl?.y??hgt(wx,wz),h2=OW?.active?owHash(item.x*1.7,item.z*2.3):hh(item.x*1.7,item.z*2.3),h3=OW?.active?owHash(item.x,item.z):hh(item.x,item.z),size=cl(item.s*K.size,TREE_SIZE_MIN[kind]||0,TREE_SIZE_MAX[kind]||Infinity),span=(ROOT_SPAN[kind]||0)*size;let sink=0;if(span){let low=gy;for(let q=0;q<8;q++){const a=q*Math.PI/4;low=Math.min(low,hgt(wx+Math.cos(a)*span,wz+Math.sin(a)*span))}sink=Math.min(Math.max(0,gy-low-.08),Math.min(.28*size,.16*span))}const pos=new THREE.Vector3(wx,gy-(RK[kind] ? .12*size : 0)-sink,wz),q=new THREE.Quaternion();if(!item.fl){const align=RK[kind] ? .7 : ROOT_SPAN[kind] ? .28+h2*.24 : NT[kind] ? .28 : 1;q.setFromUnitVectors(GROUND_UP,groundNormal(wx,wz,align));q.multiply(new THREE.Quaternion().setFromAxisAngle(GROUND_UP,item.r||0));const bend=kind==='palm' ? .28 : (kind==='acacia'||kind==='joshua') ? .22 : (ROOT_SPAN[kind]||NT[kind]) ? .18 : .1;q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((h2-.5)*bend,0,(h3-.5)*bend,'YXZ')))}else if(item.fl.q)q.set(item.fl.q[0],item.fl.q[1],item.fl.q[2],item.fl.q[3]);for(const src of K.meshes||[]){if(!src?.geometry)continue;const nv=Number(src.userData?.vn)||0;if(nv>0&&((h2*997)|0)%nv!==src.userData.vi)continue;const mesh=new THREE.Mesh(src.geometry,foliageGlowMaterial);mesh.position.copy(pos);mesh.quaternion.copy(q);mesh.scale.set(size*(item.a||1)*1.045,size*1.045,size*(item.a||1)*1.045);mesh.renderOrder=15;mesh.frustumCulled=false;foliageGlowGroup.add(mesh)}}
function setTab(id){if(exploreMode)closeExploreSheet();if(foliageSelectMode&&id!=='plants')foliageSelectMode=false;if(id!=='plants')updateFoliageGlow();tab=id;place=null;select(null);ring.visible=false;if(id=='city'&&!BLD[br.kind]&&br.kind!='erase')br.kind='house';if(id=='plants'&&BLD[br.kind])br.kind='grass';if(OW?.active){if(id=='terrain'||id=='plants'){bt=id;nav=false}else if(id=='openworld'){bt='openworld';nav=false}else nav=true}else if(id=='terrain'||id=='plants'||id=='city'){bt=id;nav=false}else{if(id=='openworld'){bt='openworld';nav=true}else nav=true}panelOpen=true;$('#panel').hidden=false;$('#bg').classList.add('on');[...$('#tabs').children].forEach(b=>b.classList.toggle('on',b.dataset.id==id));setNav();build()}
[['wire','Wire'],['solid','Solid'],['render','Render']].forEach(([id,l])=>{const b=el(`<button class="${id==mode?'on':''}">${l}</button>`);b.onclick=()=>{mode=id;[...$('#sh').children].forEach(c=>c.classList.toggle('on',c===b));shade()};$('#sh').append(b)});
$('#mode').onclick=()=>{if(foliageSelectMode){foliageSelectMode=false;ring.visible=false;updateFoliageGlow();nav=true}else nav=!nav;setNav();build()};
const b64=a=>{const u=ArrayBuffer.isView(a)?new Uint8Array(a.buffer,a.byteOffset,a.byteLength):new Uint8Array(a);let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)};
const landscapeTextureCache=new Map();
function packLandscapeTexture(tex){if(!tex?.image)return null;const key=tex.uuid;if(landscapeTextureCache.has(key))return landscapeTextureCache.get(key);const image=tex.image,w=image.width||image.videoWidth,h=image.height||image.videoHeight;if(!w||!h)return null;let pixels=null;try{if(image.data&&ArrayBuffer.isView(image.data)&&image.data.length===w*h*4)pixels=image.data;else{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.drawImage(image,0,0,w,h);pixels=x.getImageData(0,0,w,h).data}}catch(e){return null}const packed={width:w,height:h,type:pixels.constructor.name,data:b64(pixels),repeat:tex.repeat?.toArray?.()||[1,1],wrapS:tex.wrapS,wrapT:tex.wrapT,flipY:tex.flipY,encoding:tex.encoding};landscapeTextureCache.set(key,packed);return packed}
function packLandscapeGeometry(source){const g=source.index?source.toNonIndexed():source,attributes={};for(const name in g.attributes){const a=g.attributes[name];attributes[name]={itemSize:a.itemSize,normalized:!!a.normalized,type:a.array.constructor.name,data:b64(a.array)}}const packed={attributes,groups:g.groups?.map(x=>({start:x.start,count:x.count,materialIndex:x.materialIndex}))||[]};if(g!==source)g.dispose();return packed}
function packLandscapeMaterial(material){if(Array.isArray(material))return material.map(packLandscapeMaterial);const m=material;if(!m)return null;const packed={type:m.type,color:m.color?.getHexString?.()||'ffffff',roughness:m.roughness,metalness:m.metalness,shininess:m.shininess,specular:m.specular?.getHexString?.(),emissive:m.emissive?.getHexString?.(),emissiveIntensity:m.emissiveIntensity,transparent:m.transparent,opacity:m.opacity,alphaTest:m.alphaTest,side:m.side,vertexColors:m.vertexColors,wireframe:m.wireframe,bumpScale:m.bumpScale,normalScale:m.normalScale?.toArray?.(),envMapIntensity:m.envMapIntensity,textures:{}};for(const key of ['map','normalMap','bumpMap','roughnessMap','metalnessMap','alphaMap','emissiveMap'])if(m[key])packed.textures[key]=packLandscapeTexture(m[key]);return packed}
function packLandscapeNode(o){const packed={name:o.name||o.type||'Object',type:o.type,position:o.position.toArray(),quaternion:o.quaternion.toArray(),scale:o.scale.toArray(),visible:o.visible,geometry:o.geometry?packLandscapeGeometry(o.geometry):null,material:o.material?packLandscapeMaterial(o.material):null,children:o.children?.map(packLandscapeNode)||[]};if(o.isInstancedMesh){packed.instances={count:o.count,matrices:b64(o.instanceMatrix.array.subarray(0,o.count*16)),colors:o.instanceColor?b64(o.instanceColor.array.subarray(0,o.count*3)):null}}return packed}
function packLandscapePart(m){return{name:m.name,part:m.userData.part||'',count:m.count,variant:{index:m.userData.vi??null,total:m.userData.vn??null},matrices:b64(m.instanceMatrix.array.subarray(0,m.count*16)),colors:m.instanceColor?b64(m.instanceColor.array.subarray(0,m.count*3)):null,geometry:packLandscapeGeometry(m.geometry),material:packLandscapeMaterial(m.material)}}
const landscapeImportChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('final-effect-landscape-import'):null,pendingLandscapeImports=new Map();
function showLandscapeExportFallback(json,message){$('#exp').value=json;$('#ovt').textContent=message+' Scene data: '+Math.round(json.length/1024)+' KB. Copy it if you want a manual backup.';$('#ov').hidden=false}
function finishLandscapeImportAck(data){const pending=pendingLandscapeImports.get(data.requestId);if(!pending)return;clearTimeout(pending.timer);pendingLandscapeImports.delete(data.requestId);if(data.success){$('#ov').hidden=true;$('#imp').title='Imported to the 3D Workspace';$('#fps').textContent='Imported to 3D Workspace';setTimeout(()=>{$('#fps').textContent=''},2200)}else showLandscapeExportFallback(pending.json(),'Import failed: '+(data.error||'workspace did not accept the scene.'))}
window.addEventListener('message',e=>{if(e.data?.type==='final-effect:import:ack')finishLandscapeImportAck(e.data);else if(e.data?.type==='final-effect:edit-imported-landscape'){$('#fps').textContent='Edit this landscape, then press Import to update Workspace';$('#imp').title='Re-import edited landscape into the 3D Workspace';}});
if(landscapeImportChannel)landscapeImportChannel.onmessage=e=>{if(e.data?.type==='final-effect:import:ack')finishLandscapeImportAck(e.data)};
window.addEventListener('message',e=>{const d=e.data||{};if(d.type==='FE_GLOBAL_SETTINGS'){setHistoryLimit(d.settings?.undoLimit);if(d.settings&&typeof d.settings.grid==='boolean'){setTerrainGrid(d.settings.grid,false);if(typeof tab!=='undefined'&&tab==='terrain'&&typeof build==='function')build()}}else if(d.type==='FE_HISTORY_ACTION'){if(d.action==='undo')undo();else if(d.action==='redo')redo()}else if(d.type==='FE_AUTOSAVE_REQUEST'){try{const target=window.parent!==window?window.parent:window;target.postMessage({type:'FE_AUTOSAVE_DATA',studio:'landscape',requestId:d.requestId,payload:makeLandscapeAutosave()},'*')}catch(error){console.warn('Landscape autosave failed:',error);const target=window.parent!==window?window.parent:window;target.postMessage({type:'FE_AUTOSAVE_DATA',studio:'landscape',requestId:d.requestId,error:error?.message||String(error)},'*')}}else if(d.type==='FE_AUTOSAVE_RESTORE'){try{const ok=restoreLandscapeAutosave(d.payload);const target=window.parent!==window?window.parent:window;target.postMessage({type:'FE_AUTOSAVE_RESTORED',studio:'landscape',success:!!ok,savedAt:d.savedAt},'*');if(ok)$('#fps').textContent='Recovered auto-saved landscape'}catch(error){console.error('Landscape restore failed:',error)}}});
/* ---- What Import sends: the scene the studio is actually showing --------
   Import used to pack the root 100 m grid whatever the studio was showing, so
   a generated open world or a procedural planet arrived in the 3D Workspace as
   the default terrain. The payload now names its `source` and every mode packs
   the same `terrain` / `foliage` / `water` / `sky` / `weather` sections, so the
   Workspace rebuilds each of them through the path it already had:
     terrain  the root grid (and any landed planetary region inside it)
     world    every resident open-world chunk, merged into one heightfield
     planet   the procedural globe, displaced and coloured where it was made */
function landscapeExportMode(){if(PLANON&&PLAN.done)return 'planet';if(OW&&OW.active&&OW.chunks.size)return 'world';return 'terrain'}
function landscapeExportSky(){return{timeOfDay:tod,sunAngle:az,clouds:cov,fog:fogD,studio:SKY}}
function landscapeExportWeather(){return{rain:WX.rainT,overcast:WX.overT,storm:WX.stormT,snowfall:WX.snowfallT,snowCover:WX.coverT,wind:windUser,seasonProgress:WX.seasonT}}
function landscapeExportWater(level,span){return{level,visible:water.visible,waveHeight:ampUser,waveSpeed:wspd,waveChop,wavePeriod:waterWavePeriod,waveScale:waterWaveScale,windSpeed:waterWindSpeed,windDirection:waterWindDir,roughness:U.uRoughness.value,reflectivity:U.uReflect.value,refraction:U.uRefraction.value,transparency:U.uTransparency.value,clarity:U.clar.value,turbidity:U.uTurbidity.value,foam:U.uFoamAmt.value,foamThreshold:U.uFoamThreshold.value,shoreFoam:U.uShoreFoam.value,shallow:U.shal.value.toArray(),deep:U.deep.value.toArray(),profile:WATER_PROFILES[wp]?.name||'Ocean',quality:waterQuality,innerRadius:Math.max(190,span*.35),farRadius:Math.max(1400,span*2.2)}}
function landscapeExportSurface(normalPixels,normalImage){return{normalMap:normalPixels,normalMapSize:normalImage?[normalImage.width||128,normalImage.height||128]:[128,128],materialNames:['grass','dirt','rock','sand','snow'],pbrSurfaceNames:OW_SURFACE_DEFS.map(x=>x.label),palette:PAL,biome,heightScale:hs,rockSlope:rockT,snowLine:snowL,roughness:tm.roughness,metalness:tm.metalness,normalStrength:tm.normalScale.x,shininess:tm.shininess??0,specular:tm.specular?.getHexString?.()||'000000'}}
function landscapeExportNormalPixels(){const image=tm.normalMap?.image;if(!image)return{normalPixels:null,normalImage:null};const w=image.width||128,h=image.height||128,c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.drawImage(image,0,0,w,h);return{normalPixels:b64(x.getImageData(0,0,w,h).data),normalImage:image}}
function landscapeExportTerrain(surface){
 const f={};for(const k in KIND){const K=KIND[k];sync(k,true);f[k]={count:K.list.length,size:K.size,tint:K.tint,data:b64(enc(K.list)),parts:K.meshes.map(packLandscapePart)}}for(const k in KIND)sync(k);
 return{source:'terrain',terrain:{size:S,segments:N,vertexCount:W*W,heights:b64(H),materials:b64(MI),surfaceWeightsA:b64(SWA),surfaceWeightsB:b64(SWB),surfaceWeightsC:b64(SWC),colors:b64(C.array),...surface},foliage:{layout:'exact instanced geometry + matrices; source layout x7 per instance: x,y,z,scale,rotY,aspect,brightness',kinds:f},water:landscapeExportWater(wl,S),map:mapRoot?{name:mapName,scale:mapBase*mapK,rotationDeg:mapR,y:mapRoot.position.y,node:packLandscapeNode(mapRoot)}:null,objects:objs.map(packLandscapeNode)}
}
/* The open world renders one InstancedMesh per species part inside each chunk
   group, with matrices relative to that chunk. Merging them into world space
   hands the Workspace the same geometry+matrix list the root grid sends, so the
   plants arrive as the trees that were grown, not as placeholder cones. */
/* Everything the Workspace imports is placed around its own origin: the merged
   heightfield is sampled in grid space, so the plants have to lose the same
   world centre or they would sit beside the terrain instead of on it. */
function landscapeExportWorldFoliage(pack,centerX,centerZ){
 const entries=[],meta=new Map(),totals=new Map(),lists=new Map();
 for(const c of OW.chunks.values()){
  for(const mesh of c.foliageMeshes||[]){
   if(!mesh||!mesh.isInstancedMesh||!mesh.count||!mesh.geometry)continue;
   const kind=mesh.userData?.kind;if(!kind)continue;
   const src=(KIND[kind]?.meshes||[]).find(m=>m.geometry===mesh.geometry&&m.material===mesh.material);
   const part=src?.userData?.part||mesh.userData?.part||'body';
   const key=kind+'|'+part+'|'+(src?.userData?.vi??'');
   if(!meta.has(key))meta.set(key,{kind,part,geometry:mesh.geometry,material:mesh.material});
   entries.push({key,count:mesh.count,matrices:mesh.instanceMatrix.array,colors:mesh.instanceColor?.array||null,originX:c.originX-centerX,originZ:c.originZ-centerZ});
   totals.set(kind,(totals.get(kind)||0)+mesh.count);
  }
  for(const kind in c.plants||{}){const list=c.plants[kind];if(Array.isArray(list)&&list.length)lists.set(kind,(lists.get(kind)||[]).concat(list))}
 }
 const merged=pack.matricesToTransforms(entries),kinds={};
 for(const part of merged){
  const info=meta.get(part.key);if(!info)continue;
  const K=KIND[info.kind]||{};
  if(!kinds[info.kind])kinds[info.kind]={count:totals.get(info.kind)||part.count,size:K.size||1,tint:K.tint||[1,1,1],layout:'world space instance matrices',parts:[]};
  kinds[info.kind].parts.push({name:info.kind,part:info.part,count:part.count,transforms:part.transforms,colors:part.colors,geometry:packLandscapeGeometry(info.geometry),material:packLandscapeMaterial(info.material)});
 }
 for(const kind of lists.keys())if(!kinds[kind]||!kinds[kind].parts?.length){const K=KIND[kind]||{};kinds[kind]={count:lists.get(kind).length,size:K.size||1,tint:K.tint||[1,1,1],data:b64(enc(lists.get(kind)))}}
 return Object.keys(kinds).length?{layout:'exact instanced geometry + matrices in world space; x7 per instance: x,y,z,scale,rotY,aspect,brightness',kinds}:null;
}
function landscapeExportWorld(surface){
 const pack=window.LandscapeExportPack;
 if(!pack)throw new Error('The world export helper did not load.');
 const records=[];
 for(const c of OW.chunks.values())if(c&&c.heights&&c.surfaceWeights)records.push(c);
 records.sort((a,b)=>a.cx-b.cx||a.cz-b.cz);
 const bounds=pack.measureChunks(records);
 if(!bounds.count)throw new Error('The open world has no generated terrain yet. Wait for the chunks to finish loading, then press Import.');
 let step=Infinity;for(const r of records)step=Math.min(step,Math.max(.5,r.size/Math.max(1,r.segments)));
 const plan=pack.mergedGridPlan(bounds,{maxSegments:192,minStep:step});
 const heights=pack.sampleWorldField(records,plan,'heights',1);
 const weights=pack.sampleWorldField(records,plan,'surfaceWeights',12);
 const colors=new Float32Array(plan.vertices*3);
 for(let k=0;k<plan.vertices;k++){const rgb=owColor(weights,k);colors[k*3]=rgb[0];colors[k*3+1]=rgb[1];colors[k*3+2]=rgb[2]}
 return{source:'world',terrain:{size:plan.size,segments:plan.segments,vertexCount:plan.vertices,heights:b64(heights),colors:b64(colors),...surface},foliage:landscapeExportWorldFoliage(pack,plan.centerX,plan.centerZ),water:landscapeExportWater(OW.config.waterLevel,plan.size),map:null,objects:[],
  info:{chunks:records.length,sizeKm:OW.config.sizeKm,seed:OW.config.seed,worldSize:plan.size,worldSegments:plan.segments,worldCenter:[Math.round(plan.centerX*100)/100,Math.round(plan.centerZ*100)/100],vegetationDensity:OW.config.vegetationDensity}}
}
/* A planet cannot become a heightfield: the studio shows a globe, so the
   Workspace receives a globe — the same radius, the same `planetRelief`
   displacement and the same surface classification the shader colours. */
const PLANET_IMPORT_RGB={ocean:[.016,.05,.11],temperate:[.11,.24,.08],jungle:[.05,.2,.07],desert:[.62,.5,.3],alpine:[.38,.37,.35],ice:[.8,.86,.9],volcanic:[.18,.09,.06]};
const planetLinear=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);
function landscapePlanetShade(dir){
 const lon=Math.atan2(dir.z,dir.x),lat=Math.asin(cl(dir.y,-1,1)),i=cl(Math.floor((lon/6.2831853+.5)*PW),0,PW-1),j=cl(Math.floor((.5-lat/Math.PI)*PH),0,PH-1),o=(j*PW+i)*4;
 const c=pClass(PD[o]/255,PD[o+1]/255,PD[o+2]/255,PD[o+3]);
 let rgb=(PLANET_IMPORT_RGB[c.kind]||PLANET_IMPORT_RGB.temperate).slice();
 if(c.kind==='ocean'){const depth=cl(-c.h*2.2,0,.7);rgb=rgb.map(v=>v*(1-depth*.55))}
 const ice=Math.max(c.kind==='ice'?1:0,PLAN.ice>.3?smJ(.72,.93,Math.abs(dir.y))*Math.min(1,PLAN.ice):0);
 if(ice>0)rgb=rgb.map((v,q)=>v+(PLANET_IMPORT_RGB.ice[q]-v)*ice);
 const lift=cl(c.h*1.1,0,.35);
 return rgb.map(v=>planetLinear(cl(v*(1+lift*.35),0,1)));
}
function landscapeExportPlanet(){
 const pack=window.LandscapeExportPack;
 if(!pack)throw new Error('The world export helper did not load.');
 const globe=pack.packPlanetGlobe({segments:192,rings:96,radius:PLAN.R,relief:(x,y,z)=>planetRelief({x,y,z}),colour:(x,y,z)=>landscapePlanetShade({x,y,z})});
 const radii=new Float32Array(globe.radii),normals=new Int8Array(globe.vertexCount*3),colors=new Uint8Array(globe.vertexCount*3);
 for(let i=0;i<globe.vertexCount;i++){
  for(let q=0;q<3;q++){normals[i*3+q]=Math.round(cl(globe.normals[i*3+q],-1,1)*127);colors[i*3+q]=Math.round(cl(globe.colors[i*3+q],0,1)*255)}
 }
 const water=landscapeExportWater(0,PLAN.R*8);water.visible=false;
 return{source:'planet',terrain:null,planet:{kind:'globe',radius:PLAN.R,segments:globe.segments,rings:globe.rings,vertexCount:globe.vertexCount,triangleCount:globe.triangleCount,sea:PLAN.sea,seed:PLAN.seed,relief:[globe.minRadius-globe.radius,globe.maxRadius-globe.radius],radii:b64(radii),normals:b64(normals),colors:b64(colors)},foliage:null,water,map:null,objects:[],
  info:{radius:PLAN.R,seed:PLAN.seed,sea:PLAN.sea,landed:!!PLAN.landed}}
}
function landscapeExportScene(){
 const mode=landscapeExportMode(),{normalPixels,normalImage}=landscapeExportNormalPixels(),surface=landscapeExportSurface(normalPixels,normalImage);
 return Object.assign({mode,sky:landscapeExportSky(),weather:landscapeExportWeather()},mode==='planet'?landscapeExportPlanet():mode==='world'?landscapeExportWorld(surface):landscapeExportTerrain(surface));
}
function importToGrid(){
 /* The x7 plant layout is sent as typed arrays, which stream through
    postMessage without base64; the manual-copy fallback still has to produce
    valid JSON, so binary sections become placeholders instead of 20 MB of
    comma-separated numbers. */
 let d,js;const getJson=()=>js||(js=d?JSON.stringify(d,(key,value)=>ArrayBuffer.isView(value)?'<'+value.constructor.name+' '+value.length+'>':value):'');
 try{
  landscapeTextureCache.clear();
  const scene=landscapeExportScene();
  d={app:'final-effect',version:3,units:'m',axes:{up:'Y',note:'data is three.js Y-up; the UI shows Blender-style Z-up'},source:scene.source,info:scene.info||null,terrain:scene.terrain,planet:scene.planet||null,water:scene.water,sky:scene.sky,weather:scene.weather,foliage:scene.foliage,map:scene.map,objects:scene.objects};
  const requestId='land-'+Date.now()+'-'+Math.random().toString(36).slice(2),message={type:'final-effect:import',requestId,payload:d};let host=null;try{if(window.parent!==window&&window.parent.FE?.engines)host=window.parent;else if(window.opener?.FE?.engines)host=window.opener}catch(e){}let sent=false;if(host){try{host.postMessage(message,'*');sent=true}catch(e){sent=false}}if(!sent&&landscapeImportChannel){try{landscapeImportChannel.postMessage(message);sent=true}catch(e){sent=false}}if(!sent){showLandscapeExportFallback(getJson(),'Could not reach the 3D Workspace. Open the main app and retry Import.');return}const timer=setTimeout(()=>{const pending=pendingLandscapeImports.get(requestId);if(pending){pendingLandscapeImports.delete(requestId);showLandscapeExportFallback(pending.json(),'No 3D Workspace acknowledgement was received. Keep the main app open and retry.')}},20000);pendingLandscapeImports.set(requestId,{json:getJson,timer});$('#ov').hidden=true;$('#imp').title='Sending the '+(scene.source==='world'?'open world':scene.source==='planet'?'planet':'landscape')+' to the 3D Workspace…'
 }catch(e){console.error('Landscaping export failed:',e);showLandscapeExportFallback(d?getJson():'','Could not prepare the landscaping scene: '+(e?.message||e))}
}
$('#imp').onclick=importToGrid;
$('#cp').onclick=()=>{const t=$('#exp');t.focus();t.select();t.setSelectionRange(0,1e9);try{navigator.clipboard.writeText(t.value)}catch(e){}try{document.execCommand('copy')}catch(e){}};
$('#cl').onclick=()=>$('#ov').hidden=true;

/* ---- grown geometry: shape sliders and the fern rule editor -------------
   The core grows the trees (space colonisation) and the ferns (a real
   L-system). Both are runtime parameters: height and branch density scale a
   copy of the species table, and the grammar text is parsed here, packed into
   the kernel's byte layout and rewritten in the kernel. No rule is ever
   rewritten in JavaScript. */
const FLORA_DEFAULT_GRAMMAR='X -> F[+X]F[-X]+X | F[-X]F[+X]-X\nF -> FF';
const FLORA_SYMBOLS='FX+-&^/[]';
let floraRuleText='',floraRegrowTimer=0;
function floraShapeState(){const f=window.FELandscapeFlora;return f&&f.shape?f.shape:{height:1,density:1}}
function queueFloraRegrow(){
  if(floraRegrowTimer)clearTimeout(floraRegrowTimer);
  floraRegrowTimer=setTimeout(()=>{
    floraRegrowTimer=0;
    if(typeof window.__feRegrowFlora==='function')window.__feRegrowFlora(['oak','birch','acacia','shrub','ashbush','deadtree','fern','treefern']);
  },220);
}
function setFloraShape(height,density){
  const f=window.FELandscapeFlora;
  if(!f||typeof f.setShape!=='function')return;
  const s=floraShapeState();
  f.setShape(height===null?s.height:height,density===null?s.density:density);
  queueFloraRegrow();
  queueStudioConfigSave();
}
/* `X -> F[+X]F[-X]+X | F[-X]F[+X]-X`, one production per line, `|` for the
   second alternative, an optional `axiom: X` line. */
function parseGrammar(text){
  const lines=String(text==null?'':text).split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&l.charAt(0)!=='#');
  if(!lines.length)throw Error('Add at least one production');
  let axiom='X';
  const rules=[];
  for(const line of lines){
    const clean=line.replace(/\u2192/g,'->').replace(/=/g,'->');
    if(/^axiom\s*:/i.test(clean)){axiom=clean.split(':')[1].trim();continue}
    const parts=clean.split('->');
    if(parts.length!==2)throw Error('"'+line+'" needs one -> between the two sides');
    const pre=parts[0].trim();
    if(pre.length!==1)throw Error('The left side must be a single symbol, not "'+pre+'"');
    if(FLORA_SYMBOLS.indexOf(pre)<0)throw Error('"'+pre+'" is not a symbol the turtle draws');
    const alts=parts[1].split('|').map(a=>a.trim()).filter(Boolean);
    if(!alts.length)throw Error('The right side of '+pre+' is empty');
    for(const alt of alts)for(const ch of alt)if(FLORA_SYMBOLS.indexOf(ch)<0)throw Error('"'+ch+'" is not a symbol the turtle draws');
    rules.push({pre,alts});
  }
  for(const ch of axiom)if(FLORA_SYMBOLS.indexOf(ch)<0)throw Error('"'+ch+'" is not a symbol the turtle draws');
  return {axiom,rules};
}
function loadGrammar(text,regrow){
  const spec=parseGrammar(text);
  const core=window.FELandscapeCore;
  if(!core||!core.ready||typeof core.lsystemLoad!=='function')throw Error('The grown-flora core is still loading');
  const accepted=core.lsystemLoad(spec);
  if(accepted<1)throw Error('The core rejected that rule set');
  const word=typeof core.lsystemRun==='function'?core.lsystemRun(3,7):null;
  if(regrow!==false&&typeof window.__feRegrowFlora==='function')window.__feRegrowFlora(['fern','treefern']);
  return {rules:accepted,symbols:word?word.symbols:0};
}
function floraGrowthControls(){
  const shape=floraShapeState();
  const ta=el('<textarea class="grammar" spellcheck="false" aria-label="Fern grammar"></textarea>');
  ta.value=floraRuleText||FLORA_DEFAULT_GRAMMAR;
  ta.oninput=()=>{floraRuleText=ta.value};
  const msg=el('<div class="hint" id="fe-grammar-status">One production per line · the rewrite runs in the core</div>');
  const apply=btn('Apply grammar',()=>{
    try{
      const r=loadGrammar(ta.value);
      floraRuleText=ta.value;
      window.__feFloraRuleText=floraRuleText;
      msg.textContent='Grammar applied · '+r.rules+' production'+(r.rules===1?'':'s')+' · '+r.symbols+' symbols after three passes';
    }catch(error){msg.textContent=String((error&&error.message)||error)}
    queueStudioConfigSave();
  });
  const reset=btn('Restore built-in grammar',()=>{
    floraRuleText=FLORA_DEFAULT_GRAMMAR;
    ta.value=FLORA_DEFAULT_GRAMMAR;
    window.__feFloraRuleText=floraRuleText;
    const f=window.FELandscapeFlora;
    if(f&&typeof f.resetRules==='function')f.resetRules();
    if(typeof window.__feRegrowFlora==='function')window.__feRegrowFlora(['fern','treefern']);
    msg.textContent='Built-in frond grammar restored';
    queueStudioConfigSave();
  });
  const row=el('<div class="row"></div>');
  row.append(apply,reset);
  return[
    el('<div class="hint">Grown geometry · tree height and branch density rebuild the grown species; the grammar below rewrites the ferns. Foliage never repaints the ground.</div>'),
    G(sl('Tree height ×',.5,1.8,.05,shape.height,v=>setFloraShape(v,null)),sl('Branch density ×',.4,1.6,.05,shape.density,v=>setFloraShape(null,v))),
    el('<div class="hint">Fern grammar · symbols F X + - &amp; ^ / [ ]</div>'),
    ta,row,msg
  ];
}
window.__feLoadGrammar=loadGrammar;
window.__feFloraDefaultGrammar=FLORA_DEFAULT_GRAMMAR;
(function applyStoredGrammar(){
  const c=window.FELandscapeCore;
  if(!c)return;
  const run=()=>{
    const text=window.__fePendingGrammar;
    if(!text||text===FLORA_DEFAULT_GRAMMAR)return;
    try{loadGrammar(text,false);floraRuleText=text;window.__feFloraRuleText=text}catch(error){}
  };
  if(c.loading&&typeof c.loading.then==='function')c.loading.then(run,run);
  else setTimeout(run,0);
})();
