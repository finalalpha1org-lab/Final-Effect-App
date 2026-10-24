
const SCATTER_BATCH=4096;
const ROOT_SPAN={pine:1.5,spruce:1.35,krumm:.8,juniper:.7,oak:4.4,birch:.6,palm:.8,acacia:1.8,joshua:1,deadtree:1.6,treefern:.5,shrub:.5,sage:.45,ashbush:.5,saguaro:.7,barrel:.45,prickly:.6,agave:.5};
const GROUND_UP=new THREE.Vector3(0,1,0),GROUND_N=new THREE.Vector3(),GROUND_Q=new THREE.Quaternion(),GROUND_E=new THREE.Euler();
function groundNormal(x,z,alignment=1){if(OW?.active)return OW.normalAt(x,z,alignment);const u=cl((x+S/2)/D,0,N-.001),v=cl((z+S/2)/D,0,N-.001),i=u|0,j=v|0,a=u-i,b=v-j,k=j*W+i,gx=((H[k+1]-H[k])*(1-b)+(H[k+W+1]-H[k+W])*b)/D,gz=((H[k+W]-H[k])*(1-a)+(H[k+W+1]-H[k+1])*a)/D;return GROUND_N.set(-gx*alignment,1,-gz*alignment).normalize()}





function growManualCapacity(k,required){const K=KIND[k];if(!K||required<=K.max)return true;const cap=Math.max(required,Math.ceil(Math.max(K.max,1)*1.5),K.max+1024),resize=old=>{const m=new THREE.InstancedMesh(old.geometry,old.material,cap);m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);m.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0,Math.min(old.instanceMatrix.array.length,m.instanceMatrix.array.length)));m.instanceColor=new THREE.BufferAttribute(new Float32Array(cap*3),3);m.instanceColor.array.set(old.instanceColor.array.subarray(0,Math.min(old.instanceColor.array.length,m.instanceColor.array.length)));m.instanceColor.setUsage(THREE.DynamicDrawUsage);m.count=Math.min(old.count,cap);m.frustumCulled=old.frustumCulled;m.castShadow=old.castShadow;m.receiveShadow=old.receiveShadow;m.userData={...old.userData};m.customDepthMaterial=old.customDepthMaterial;m.renderOrder=old.renderOrder;m.name=old.name;m.position.copy(old.position);m.quaternion.copy(old.quaternion);m.scale.copy(old.scale);m.layers.mask=old.layers.mask;m.updateMatrix();return m},next=[];try{for(const old of K.meshes)next.push(resize(old))}catch(e){if(!K.capacityWarned){K.capacityWarned=true;console.warn('Device memory is full; existing foliage was kept.');}return false}for(let i=0;i<K.meshes.length;i++){scene.remove(K.meshes[i]);scene.add(next[i])}K.meshes=next;if(K.lowMeshes){for(const low of K.lowMeshes){scene.remove(low);low.dispose?.();low.material?.dispose?.()}K.lowMeshes=null}if(K.impMesh){scene.remove(K.impMesh);K.impMesh.geometry?.dispose?.();K.impMesh.material?.dispose?.();K.impMesh=null;K.impAtlas=null;impostorWanted.delete(k)}K.max=cap;K.capacityWarned=false;return true}
const mAt=(x,z)=>OW?.active?OW.mIdx(x,z):mIdx(cl(Math.round((x+S/2)/D),0,N),cl(Math.round((z+S/2)/D),0,N));
const slope=(x,z)=>Math.hypot(hgt(x+1,z)-hgt(x-1,z),hgt(x,z+1)-hgt(x,z-1))/2;
const RULE={grass:[.8,0],tallgrass:[.82,0],flower:[.6,0],daisy:[.6,0],tulip:[.6,0],lavender:[.65,0],shrub:[.9,1.4],pine:[.75,3],oak:[.6,4.2],birch:[.6,2.8],palm:[.5,3.5],rock:[9,0],house:[.32,0],block:[.28,0],mid:[.27,0],tower:[.26,0]},BLD={house:4,block:5.6,mid:6.2,tower:4.4},bY=(x,z,b)=>Math.min(hgt(x,z),...[[1,1],[1,-1],[-1,1],[-1,-1]].map(([a,c])=>hgt(x+a*b*.6,z+c*b*.6))),SM={house:1,block:1,mid:1,tower:1,grass:1.35,tallgrass:1.05,flower:1.05,daisy:1,tulip:1,lavender:1, pine:1.05,oak:1.05,birch:1.05,palm:1.05,shrub:1.05,rock:.8};
function add(k,x,z,f=1,yaw=0,force=false,y0,sl0){
const K=KIND[k]||ensure(k),bd=BLD[k];if(!K)return 0;const edge=force?0.05:1+(bd||0);if(Math.abs(x)>S/2-edge||Math.abs(z)>S/2-edge)return 0;if(K.list.length>=K.max){if(!force)return 0;if(!growManualCapacity(k,K.list.length+1))return 0;if(K.list.length>=K.max)return 0}
const y=y0===undefined||bd?(bd?bY(x,z,bd):hgt(x,z)):y0,[ms,sp]=RULE[k]||[9,0],m=mAt(x,z),sl=sl0===undefined||bd?slope(x,z):sl0,minAbove=bd?.7:RK[k]?-.3:force?.05:.25,grassKind=k==='grass'||k==='tallgrass',waterDepth=wl-y,shallowWaterGrass=force&&grassKind&&waterDepth>=.45&&waterDepth<=shallowBrushDepth;if(y<wl+minAbove&&!shallowWaterGrass)return 0;
if(!force){if(!bd&&!RK[k]&&sl>ms)return 0;if(!bd&&!RK[k]&&k!='palm'&&f<1.5&&R()>veg)return 0;if(bd?m>1:k=='palm'?(biome==='jungle'?(m===2||m===4||m===5):m!=3):!RK[k]&&(['grass','tallgrass','flower','daisy','tulip','lavender'].includes(k)?m!=0:m>1))return 0;if((k=='grass'||k=='tallgrass')&&vn(x*.09+9,z*.09+4)*f<(k=='tallgrass'?.18:.32))return 0;if(k in TL&&y>snowL+TL[k])return 0;if(PATCH[k]&&vn(x*.05+3,z*.05+8)*f<.22+scatterClustering*.46)return 0;if(RK[k]&&f<1.5&&R()>.25+sl*.8)return 0}
const s=SM[k]*(1+(R()-.5)*2*K.vr);if(bd&&!force){for(const q in BLD)if(KIND[q].list.some(o=>(o.x-x)**2+(o.z-z)**2<(bd+BLD[q])**2*.8))return 0}else if(FP[k]&&!force){if(occBlocked(x,z,FP[k]*s*K.size,k,SPACING_KINDS.has(k)?br.minGap:0))return 0}else if(!force&&sp&&K.list.some(o=>(o.x-x)**2+(o.z-z)**2<(sp*(o.s+s)*.5)**2))return 0;
K.list.push({x,y,z,s,r:bd?yaw+Math.floor(R()*4)*1.5708:R()*6.28,a:bd?.94+R()*.12:.88+R()*.24,v:.82+R()*.3,manual:!!force});if(FP[k]&&!force)occAdd(x,z,FP[k]*s*K.size,k);return 1}
const RATE={grass:1.6,tallgrass:.9,flower:.6,daisy:.35,tulip:.3,lavender:.32,shrub:.25,pine:.15,oak:.12,birch:.14,palm:.1,rock:.12,house:.07,block:.05,mid:.04,tower:.03};
Object.assign(RULE,{spruce:[.85,2.2],krumm:[1.1,3],juniper:[1,1.3],saguaro:[.4,6],barrel:[.5,2.4],prickly:[.5,2.8],acacia:[.45,7],joshua:[.45,5],agave:[.6,2],sage:[.7,1.3],sandrock:[9,0],basalt:[9,0],deadtree:[.9,4],ashbush:[.9,1.6],treefern:[.8,2.2],fern:[.9,1.2]});
Object.assign(SM,{spruce:1,krumm:1,juniper:.9,saguaro:1,barrel:1,prickly:1,acacia:1,joshua:1,agave:1,sage:1,sandrock:.9,basalt:.9,deadtree:1,ashbush:1,treefern:1,fern:1});
Object.assign(RATE,{spruce:.12,krumm:.12,juniper:.2,saguaro:.05,barrel:.12,prickly:.1,acacia:.05,joshua:.06,agave:.12,sage:.25,sandrock:.12,basalt:.14,deadtree:.08,ashbush:.2,treefern:.1,fern:.3});
const FP={pine:2.4,oak:4.4,birch:2.4,palm:3.5,shrub:1,rock:1.1,spruce:1.9,krumm:1.5,juniper:1.8,saguaro:2.2,barrel:.6,prickly:1.2,acacia:5.4,joshua:2.4,agave:1.2,sage:.9,sandrock:1.1,basalt:1.1,deadtree:1.8,ashbush:.9,treefern:1.9};
const SPACING_KINDS=new Set(['pine','oak','birch','palm','shrub','spruce','krumm','juniper','saguaro','barrel','prickly','acacia','joshua','agave','sage','deadtree','ashbush','treefern','fern']);
let OCC=new Map();const OCS=4,ockey=(cx,cz)=>(cx+64)*256+(cz+64);
function occAdd(x,z,r,type){const k=ockey(Math.floor(x/OCS),Math.floor(z/OCS));let a=OCC.get(k);if(!a)OCC.set(k,a=[]);a.push(x,z,r,type)}
function occRebuild(){OCC=new Map();for(const k in FP){const K=KIND[k];if(K)K.list.forEach(o=>occAdd(o.x,o.z,FP[k]*o.s*K.size,k))}for(const q in BLD){const K=KIND[q];if(K)K.list.forEach(o=>occAdd(o.x,o.z,BLD[q],q))}}
function occBlocked(x,z,r,k,gap=0){const cx=Math.floor(x/OCS),cz=Math.floor(z/OCS),m=Math.ceil((r+6+gap)/OCS);for(let i=-m;i<=m;i++)for(let j=-m;j<=m;j++){const a=OCC.get(ockey(cx+i,cz+j));if(a)for(let t=0;t<a.length;t+=4){const dx=a[t]-x,dz=a[t+1]-z,treePair=SPACING_KINDS.has(k)&&SPACING_KINDS.has(a[t+3]);if(ScatterSpacing.overlaps(dx,dz,a[t+2],r,treePair,treePair?gap:0))return true}}return false}
const RK={rock:1,sandrock:1,basalt:1},NT={saguaro:1,barrel:1,prickly:1},PATCH={pine:1,oak:1,birch:1,spruce:1,deadtree:1},TL={spruce:-1,krumm:.5,juniper:1.5};
const BSP={hills:['grass','tallgrass','flower','daisy','tulip','lavender','pine','oak','birch','palm','shrub','rock'],alpine:['grass','tallgrass','flower','daisy','lavender','spruce','krumm','juniper','rock'],desert:['grass','tallgrass','daisy','tulip','lavender','sage','saguaro','barrel','prickly','acacia','joshua','agave','palm','flower','sandrock','rock'],volc:['grass','tallgrass','flower','daisy','lavender','fern','treefern','deadtree','ashbush','basalt','rock']};
const BTAB={hills:[['grass',.60],['flower',.09],['tallgrass',.09],['daisy',.035],['tulip',.02],['lavender',.025],['pine',.03],['oak',.05],['birch',.025],['palm',.05],['shrub',.13],['rock',.008]],alpine:[['grass',.48],['flower',.07],['tallgrass',.08],['daisy',.02],['lavender',.025],['spruce',.11],['krumm',.05],['juniper',.12],['rock',.035]],desert:[['grass',.30],['tallgrass',.05],['daisy',.015],['tulip',.01],['lavender',.01],['sage',.2],['saguaro',.02],['barrel',.03],['prickly',.05],['acacia',.02],['joshua',.02],['agave',.06],['palm',.03],['flower',.02],['sandrock',.04],['rock',.02]],volc:[['grass',.12],['tallgrass',.06],['flower',.01],['daisy',.01],['tulip',.01],['lavender',.02],['fern',.1],['treefern',.04],['deadtree',.05],['ashbush',.1],['basalt',.12],['rock',.025]]};
const LBL={grass:'🌿 Grass',tallgrass:'🌾 Tall Grass',flower:'🌼 Flowers',daisy:'🌼 Daisy',tulip:'🌷 Tulip',lavender:'💜 Lavender',pine:'🌲 Pine',oak:'🌳 Oak',birch:'🌿 Birch',palm:'🌴 Palm',shrub:'🪴 Shrubs',rock:'🪨 Rocks',spruce:'🌲 Spruce',krumm:'🌲 Mountain pine',juniper:'🪴 Juniper',saguaro:'🌵 Saguaro',barrel:'🌵 Barrel cactus',prickly:'🌵 Prickly pear',acacia:'🌳 Acacia',joshua:'🌴 Joshua tree',agave:'🪴 Agave',sage:'🪴 Sage',sandrock:'🪨 Sandstone',deadtree:'🪵 Burnt tree',treefern:'🌴 Tree fern',fern:'🌿 Fern',ashbush:'🪴 Ash shrub',basalt:'🪨 Basalt'};
const GT0={hills:[1,1,1],alpine:[.88,1,.95],desert:[1.55,1.25,.6],volc:[.75,.8,.7]};
Object.assign(BIO,{jungle:{p:[[.12,.34,.1],[.2,.2,.12],[.34,.34,.34],[.55,.5,.36],[.92,.94,.98]],s:60,v:1},taiga:{p:[[.13,.26,.11],[.26,.22,.15],[.3,.3,.32],[.5,.49,.45],[.92,.95,1]],s:36,v:.85},tundra:{p:[[.36,.4,.28],[.32,.28,.22],[.4,.4,.42],[.6,.56,.48],[.95,.96,1]],s:20,v:.4}});
Object.assign(GT0,{jungle:[.9,1.2,.8],taiga:[.8,.95,.85],tundra:[1.1,1.05,.8]});
Object.assign(BSP,{jungle:['grass','tallgrass','flower','daisy','tulip','lavender','palm','treefern','fern','shrub','oak','rock'],taiga:['grass','tallgrass','flower','daisy','lavender','spruce','juniper','krumm','shrub','rock'],tundra:['grass','tallgrass','daisy','lavender','krumm','juniper','rock']});
Object.assign(BTAB,{jungle:[['grass',.32],['tallgrass',.08],['flower',.07],['daisy',.03],['tulip',.02],['lavender',.025],['palm',.08],['treefern',.07],['fern',.15],['shrub',.15],['oak',.08],['rock',.08]],taiga:[['grass',.3],['tallgrass',.08],['flower',.04],['daisy',.02],['lavender',.02],['spruce',.22],['juniper',.08],['krumm',.06],['shrub',.1],['rock',.2]],tundra:[['grass',.5],['tallgrass',.08],['flower',.08],['daisy',.03],['lavender',.03],['krumm',.1],['juniper',.07],['rock',.25]]});

function owHash(x,z){const s=Math.sin((x+OW.config.seed*.13)*12.9898+(z-OW.config.seed*.07)*78.233)*43758.5453;return s-Math.floor(s)}
function owKey(cx,cz){return cx+','+cz}
function owClonePlants(plants){const out={};for(const k in plants||{})out[k]=(plants[k]||[]).map(o=>({...o}));return out}
function owHeightConfig(){return{seed:OW.config.seed,mountainHeight:OW.config.mountainHeight,waterCoverage:OW.config.waterCoverage,waterLevel:OW.config.waterLevel,seaLevel:OW.config.waterLevel,worldSizeKm:OW.config.sizeKm,worldHalf:OW.config.sizeKm*500,blend:OW.config.blend,biomeMix:{...OW.config.biomeMix}}}
function owChunkAt(x,z){const cx=Math.floor((x+OW.chunkSize*.5)/OW.chunkSize),cz=Math.floor((z+OW.chunkSize*.5)/OW.chunkSize);return OW.chunks.get(owKey(cx,cz))||null}
function owSampleChunk(c,x,z){const step=c.size/c.segments,u=cl((x-(c.originX-c.size*.5))/step,0,c.segments-.0001),v=cl((z-(c.originZ-c.size*.5))/step,0,c.segments-.0001),i=u|0,j=v|0,a=u-i,b=v-j,k=j*(c.segments+1)+i;return c.heights[k]*(1-a)*(1-b)+c.heights[k+1]*a*(1-b)+c.heights[k+c.segments+1]*(1-a)*b+c.heights[k+c.segments+2]*a*b}
function owHeightAt(x,z){const cx=Math.floor((x+OW.chunkSize*.5)/OW.chunkSize),cz=Math.floor((z+OW.chunkSize*.5)/OW.chunkSize),key=owKey(cx,cz),active=OW.chunks.get(key);if(active)return owSampleChunk(active,x,z);const edit=OW.editStore.get(key);if(edit){const fake={...edit,originX:cx*OW.chunkSize,originZ:cz*OW.chunkSize};return owSampleChunk(fake,x,z)}return OpenWorldGenerator.heightAt(x,z,owHeightConfig())}
function owNormalAt(x,z,alignment=1){const step=OW.chunkSize/Math.max(OW.segments||64,16),e=Math.max(.5,step*.35),gx=(owHeightAt(x+e,z)-owHeightAt(x-e,z))/(2*e),gz=(owHeightAt(x,z+e)-owHeightAt(x,z-e))/(2*e);return new THREE.Vector3(-gx*alignment,1,-gz*alignment).normalize()}
function owColor(weights,k){const j=k*3;let r=0,g=0,b=0;const linear=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);for(let q=0;q<12;q++){const w=weights[k*12+q]||0,c=OW_SURFACE_DEFS[q].rgb;r+=linear(c[0]/255)*w;g+=linear(c[1]/255)*w;b+=linear(c[2]/255)*w}return[r,g,b]}
function owUpdateChunkGeometry(c,updateAll=true){const p=c.terrain.geometry.attributes.position,color=c.terrain.geometry.attributes.color.array,step=c.size/c.segments,row=c.segments+1;for(let j=0;j<=c.segments;j++)for(let i=0;i<=c.segments;i++){const k=j*row+i;p.setY(k,c.heights[k]);const col=owColor(c.surfaceWeights,k);color[k*3]=col[0];color[k*3+1]=col[1];color[k*3+2]=col[2]}p.needsUpdate=true;c.terrain.geometry.attributes.color.needsUpdate=true;c.terrain.geometry.computeVertexNormals();c.terrain.geometry.computeBoundingSphere();if(updateAll)c.dirtyTerrain=true}
function owCreateChunkGeometry(c){const row=c.segments+1,geo=new THREE.PlaneGeometry(c.size,c.size,c.segments,c.segments).rotateX(-Math.PI/2),p=geo.attributes.position,color=new Float32Array(row*row*3),wa=new Float32Array(row*row*4),wb=new Float32Array(row*row*4),wc=new Float32Array(row*row*4);for(let k=0;k<row*row;k++){p.setY(k,c.heights[k]);const col=owColor(c.surfaceWeights,k);color[k*3]=col[0];color[k*3+1]=col[1];color[k*3+2]=col[2];for(let q=0;q<4;q++){wa[k*4+q]=c.surfaceWeights[k*12+q];wb[k*4+q]=c.surfaceWeights[k*12+4+q];wc[k*4+q]=c.surfaceWeights[k*12+8+q]}}geo.setAttribute('color',new THREE.BufferAttribute(color,3));geo.setAttribute('surfaceWeightsA',new THREE.BufferAttribute(wa,4));geo.setAttribute('surfaceWeightsB',new THREE.BufferAttribute(wb,4));geo.setAttribute('surfaceWeightsC',new THREE.BufferAttribute(wc,4));geo.attributes.position.needsUpdate=true;geo.computeVertexNormals();geo.computeBoundingSphere();return geo}
function owResampleChunkData(data,newSegments){if(data.segments===newSegments)return data;const oldSegments=data.segments,oldRow=oldSegments+1,newRow=newSegments+1,heights=new Float32Array(newRow*newRow),surfaceWeights=new Float32Array(newRow*newRow*12),sample=(arr,components,u,v,q)=>{u=cl(u,0,oldSegments-.0001);v=cl(v,0,oldSegments-.0001);const i=u|0,j=v|0,a=u-i,b=v-j,k=(j*oldRow+i)*components+q;return arr[k]*(1-a)*(1-b)+arr[k+components]*a*(1-b)+arr[k+oldRow*components]*(1-a)*b+arr[k+(oldRow+1)*components]*a*b};for(let j=0;j<newRow;j++)for(let i=0;i<newRow;i++){const k=j*newRow+i,u=i/newSegments*oldSegments,v=j/newSegments*oldSegments;heights[k]=sample(data.heights,1,u,v,0);let sum=0;for(let q=0;q<12;q++){const value=Math.max(0,sample(data.surfaceWeights,12,u,v,q));surfaceWeights[k*12+q]=value;sum+=value}if(sum>.001)for(let q=0;q<12;q++)surfaceWeights[k*12+q]/=sum}return{...data,segments:newSegments,heights,surfaceWeights}}
function owUpdateChunkResolution(c,newSegments){const data=owResampleChunkData(c,newSegments),old=c.terrain.geometry;c.segments=data.segments;c.heights=data.heights;c.surfaceWeights=data.surfaceWeights;c.terrain.geometry=owCreateChunkGeometry(c);old.dispose();owSyncChunk(c);return c}
function owSetQuality(){if(!OW?.active)return;const segments=detail>=3?128:detail>=2?96:64;if(segments!==OW.segments){OW.segments=segments;for(const c of OW.chunks.values())owUpdateChunkResolution(c,segments);OW.waterMapsDirty=true}if(window.OW_API?.refreshFar)window.OW_API.refreshFar()}
function owStoreChunk(c){if(!c.dirty)return;OW.editStore.set(c.key,{cx:c.cx,cz:c.cz,size:c.size,segments:c.segments,originX:c.originX,originZ:c.originZ,heights:c.heights.slice(),surfaceWeights:c.surfaceWeights.slice(),plants:owClonePlants(c.plants),dirty:true,dirtyTerrain:!!c.dirtyTerrain})}
function owDisposeChunk(c){owStoreChunk(c);OW.group.remove(c.group);c.terrain.geometry.dispose();c.foliageMeshes.length=0}
function owChunkConfig(cx,cz,vegetationSeed){const variations={};for(const k in SM)variations[k]=KIND[k]?.vr??.35;const spacing={};for(const k in FP)spacing[k]=FP[k]*(KIND[k]?.size||TREE_SIZE_SCALE[k]||1)+(SPACING_KINDS.has(k)?br.minGap:0);return{cx,cz,chunkSize:OW.chunkSize,segments:OW.segments,sizeKm:OW.config.sizeKm,worldHalf:OW.config.sizeKm*500,seed:OW.config.seed,vegetationSeed:vegetationSeed||OW.config.seed,mountainHeight:OW.config.mountainHeight,waterCoverage:OW.config.waterCoverage,blend:OW.config.blend,seaLevel:OW.config.waterLevel,biomeMix:{...OW.config.biomeMix},clustering:scatterClustering,vegetationDensity:cl(OW.config.vegetationDensity*scatterDensity,0,2.5),maxPlantsPerChunk:detail>=3?26000:detail>=2?22000:16000,biomeTables:BTAB,rules:RULE,sizes:SM,variations,spacing}}
function owFallbackModel(kind){if(OW.fallbackModels.has(kind))return OW.fallbackModels.get(kind);const rock=['rock','sandrock','basalt'].includes(kind),flower=['flower','daisy','tulip','lavender'].includes(kind),grass=['grass','tallgrass','fern','treefern'].includes(kind),cactus=['saguaro','barrel','prickly','agave','joshua','palm','deadtree'].includes(kind);let geometry;if(rock)geometry=new THREE.DodecahedronGeometry(.72,0).translate(0,.5,0);else if(flower)geometry=new THREE.SphereGeometry(.22,8,6).translate(0,.82,0);else if(grass)geometry=new THREE.ConeGeometry(.14,1,5).translate(0,.5,0);else if(cactus)geometry=new THREE.CylinderGeometry(.16,.23,2.8,7).translate(0,1.4,0);else if(['shrub','sage','ashbush'].includes(kind))geometry=new THREE.SphereGeometry(.62,8,6).translate(0,.58,0);else geometry=new THREE.ConeGeometry(.78,4.2,7).translate(0,2.1,0);const colors={grass:0x4f8938,tallgrass:0x789c42,flower:0xe7b647,daisy:0xf4e9dc,tulip:0xd95350,lavender:0x9970d3,rock:0x8b8c84,sandrock:0xb4976c,basalt:0x555a60,fern:0x438649,treefern:0x31804a,saguaro:0x438447,barrel:0x72904c,prickly:0x5f8e49,agave:0x6f964b,sage:0x75905a,ashbush:0x5c6654,deadtree:0x66574d,palm:0x398451,joshua:0x4c8550},material=new THREE.MeshStandardMaterial({color:colors[kind]||0x5c873f,roughness:.86}),source={geometry,material,userData:{kind,pal:null,nt:0,vi:null,vn:null},castShadow:false,receiveShadow:true,layers:{mask:1},customDepthMaterial:null},K={list:[],size:1,vr:.25,tint:[1,1,1],meshes:[source],shadowMeshes:[]};OW.fallbackModels.set(kind,K);console.warn('Using basic Open World model fallback for',kind);return K}
function owSyncChunkUnsafe(c,onlyKind=null){if(!c||!OW.active)return;const remaining=[];for(const old of c.foliageMeshes){if(onlyKind&&old.userData.kind!==onlyKind)remaining.push(old);else c.group.remove(old)}c.foliageMeshes=remaining;const kinds=onlyKind?[onlyKind]:Object.keys(c.plants);for(const kind of kinds){const items=Array.isArray(c.plants[kind])?c.plants[kind]:[],resolved=ensure(kind),K=resolved&&Array.isArray(resolved.meshes)&&resolved.meshes.length?resolved:owFallbackModel(kind);if(!K||!items.length||!Array.isArray(K.meshes))continue;for(const src of K.meshes){if(!src?.geometry||!src.material||!src.userData)continue;const refs=[];for(const item of items){if(!item||!Number.isFinite(item.x)||!Number.isFinite(item.z))continue;const nv=Number(src.userData.vn)||0;if(nv>0&&((owHash(item.x*1.7,item.z*2.3)*997)|0)%nv!==src.userData.vi)continue;refs.push(item)}if(!refs.length)continue;const inst=new THREE.InstancedMesh(src.geometry,src.material,refs.length);inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);inst.instanceColor=new THREE.BufferAttribute(new Float32Array(refs.length*3).fill(1),3);inst.instanceColor.setUsage(THREE.DynamicDrawUsage);inst.count=refs.length;inst.frustumCulled=false;inst.castShadow=src.castShadow&&kind!=='grass'&&kind!=='tallgrass';inst.receiveShadow=src.receiveShadow;inst.layers.mask=src.layers.mask;inst.customDepthMaterial=src.customDepthMaterial;inst.name='Open World '+kind+' · '+c.cx+','+c.cz;inst.userData={kind,chunkKey:c.key,sourcePlants:refs};const dummy=new THREE.Object3D();for(let i=0;i<refs.length;i++){const o=refs[i],wx=o.x,wz=o.z,gy=owHeightAt(wx,wz);o.y=gy;const h2=owHash(o.x*1.7,o.z*2.3),h3=owHash(o.x,o.z),s=cl(o.s*K.size,TREE_SIZE_MIN[k]||0,TREE_SIZE_MAX[k]||Infinity),span=(ROOT_SPAN[k]||0)*s;let sink=0;if(span){let low=gy;for(let q=0;q<8;q++){const a=q*Math.PI/4;low=Math.min(low,owHeightAt(wx+Math.cos(a)*span,wz+Math.sin(a)*span))}sink=Math.min(Math.max(0,gy-low-.08),Math.min(.28*s,.16*span))}dummy.position.set(wx-c.originX,gy-(RK[k] ? .12*s : 0)-sink,wz-c.originZ);if(!BLD[k]){const align=RK[k] ? .7 : ROOT_SPAN[k] ? .28+h2*.24 : NT[k] ? .28 : 1;dummy.quaternion.setFromUnitVectors(GROUND_UP,owNormalAt(wx,wz,align));GROUND_Q.setFromAxisAngle(GROUND_UP,o.r||0);dummy.quaternion.multiply(GROUND_Q);const bend=k==='palm' ? .28 : (k==='acacia'||k==='joshua') ? .22 : (ROOT_SPAN[k]||NT[k]) ? .18 : .1;GROUND_E.set((h2-.5)*bend,0,(h3-.5)*bend,'YXZ');GROUND_Q.setFromEuler(GROUND_E);dummy.quaternion.multiply(GROUND_Q)}dummy.scale.set(s*(o.a||1),s,s*(o.a||1));dummy.updateMatrix();inst.setMatrixAt(i,dummy.matrix);const pal=src.userData.pal,c=pal?pal[(h2*pal.length)|0]:[1.05-h2*.2,1,.9+h2*.2],t=pal||src.userData.nt?[1,1,1]:K.tint,v=o.v??1;inst.setColorAt(i,tcol.setRGB(c[0]*v*t[0],c[1]*v*t[1],c[2]*v*t[2]))}inst.instanceMatrix.needsUpdate=true;inst.instanceColor.needsUpdate=true;c.group.add(inst);c.foliageMeshes.push(inst)}}}
function owSyncChunk(c,onlyKind=null){try{return owSyncChunkUnsafe(c,onlyKind)}catch(e){console.error('Open World foliage rendering failed:',e);owStatus('Foliage rendering issue · '+(e?.message||String(e)));return false}}
function owQueueSync(c){if(!c||c.syncQueued)return;c.syncQueued=true;requestAnimationFrame(()=>{c.syncQueued=false;if(OW.active&&OW.chunks.get(c.key)===c)owSyncChunk(c)})}
function owLoadChunk(cx,cz,generatedData=null){const key=owKey(cx,cz);if(OW.chunks.has(key))return OW.chunks.get(key);const saved=OW.editStore.get(key);let data=saved?{cx,cz,size:saved.size,segments:saved.segments,originX:saved.originX,originZ:saved.originZ,heights:saved.heights.slice(),surfaceWeights:saved.surfaceWeights.slice(),plants:owClonePlants(saved.plants)}:generatedData||OpenWorldGenerator.generateChunk(owChunkConfig(cx,cz));if(data.segments!==OW.segments)data=owResampleChunkData(data,OW.segments);const group=new THREE.Group();group.position.set(cx*OW.chunkSize,0,cz*OW.chunkSize);group.name='Open World chunk '+key;const terrain=new THREE.Mesh(owCreateChunkGeometry({...data,terrain:null}),tm);terrain.name='Open World terrain '+key;terrain.frustumCulled=false;terrain.receiveShadow=true;terrain.castShadow=false;const c={...data,key,cx,cz,group,terrain,foliageMeshes:[],dirty:!!saved,dirtyTerrain:!!saved?.dirtyTerrain};group.add(terrain);OW.group.add(group);OW.chunks.set(key,c);owSyncChunk(c);return c}
function owCenter(){if(exploreMode==='first'&&walkRig)return{x:walkRig.position.x,z:walkRig.position.z};if(exploreMode==='heli')return{x:heliX,z:heliZ};return{x:oc.target.x,z:oc.target.z}}
function owFindSpawn(){const cfg=owHeightConfig(),sea=cfg.seaLevel,half=OW.config.sizeKm*500,maxRadius=Math.max(0,Math.min(5000,half-OW.chunkSize*.5));let best={x:0,z:0,y:OpenWorldGenerator.heightAt(0,0,cfg)};for(let radius=0;radius<=maxRadius;radius+=256){const count=radius?Math.max(8,Math.ceil(2*Math.PI*radius/256)):1;for(let i=0;i<count;i++){const a=2*Math.PI*i/count,x=radius*Math.cos(a),z=radius*Math.sin(a),y=OpenWorldGenerator.heightAt(x,z,cfg);if(y>best.y)best={x,z,y};if(y<sea+20)continue;let dry=0;for(const dz of [-256,0,256])for(const dx of [-256,0,256])if(OpenWorldGenerator.heightAt(x+dx,z+dz,cfg)>sea+8)dry++;if(dry>=7)return{x,z,y}}}return best}
function owValidChunk(cx,cz){const half=OW.config.sizeKm*500,edge=OW.chunkSize*.5;return Math.abs(cx*OW.chunkSize)-edge<=half&&Math.abs(cz*OW.chunkSize)-edge<=half}
/* World size is a bound on the streamed grid, not an allocation. Only the 3x3
   neighbourhood of 256 m chunks is ever resident, so a 50 km world costs the
   same memory as a 1 km one: what changes is how far you can walk before the
   edge, not how much is held. Changing it therefore re-streams; it never grows
   a buffer by area, which is the out-of-memory path this had to avoid. */
function owChunkBytes(c){return (c.heights?c.heights.length*4:0)+(c.surfaceWeights?c.surfaceWeights.length*4:0)}
function owMemory(){
 let bytes=0;
 for(const c of OW.chunks.values())bytes+=owChunkBytes(c);
 for(const s of OW.editStore.values())bytes+=owChunkBytes(s)+96;
 return{chunks:OW.chunks.size,edits:OW.editStore.size,bytes};
}
function owSetWorldSize(km){
 const asked=Number(km),next=cl(Math.round(Number.isFinite(asked)?asked:OW.config.sizeKm),1,50);
 if(next===OW.config.sizeKm)return false;
 OW.config.sizeKm=next;
 if(OW.currentConfig)OW.currentConfig.sizeKm=next;
 if(!OW.active)return true;
 const half=next*500;
 for(const key of [...OW.editStore.keys()]){
  const v=OW.editStore.get(key);
  if(Math.abs(v.cx*OW.chunkSize)>half||Math.abs(v.cz*OW.chunkSize)>half)OW.editStore.delete(key);
 }
 for(const [key,c] of [...OW.chunks]){
  if(owValidChunk(c.cx,c.cz))continue;
  owDisposeChunk(c);OW.chunks.delete(key);
 }
 OW.lastCenterX=OW.lastCenterZ=NaN;
 setOpenWorldWaterRadius(true);
 owRefresh(true);
 owStatus('World size '+next+' km \u00b7 '+OW.chunks.size+' chunks resident');
 return true;
}
window.__feWorldSize=owSetWorldSize;

window.__feWorldMemory=owMemory;
/* --- Live erosion ----------------------------------------------------------
   One press erodes the patch you are looking at, a slice per frame. The kernel
   keeps the seed, the droplet cursor and the dirty rectangle, so this side only
   asks for the next slice and then uploads the band that changed. The run pauses
   itself when the result cannot be seen: hidden tab, another sheet open, the
   patch off screen, or a brush stroke in progress. */
/* `area` is the width of the square patch in metres — the same number the sheet
   shows — so the radius handed to the kernel is half of it. */
const LIVE={on:false,area:120,rate:1,trim:1,ran:0,total:0,rect:[0,0,0,0],hasRect:false,lastW:0,lastH:0,uploadAt:0,statusAt:0,paused:'',dots:50000};
const liveProj=new THREE.Vector3();
function liveErosionStatus(text){
 const n=typeof document!=='undefined'?document.getElementById('erosion-live'):null;
 if(n)n.textContent=text;
}
function liveErosionBrushing(){
 try{return typeof painting!=='undefined'&&!!painting}catch(error){return false}
}
function liveErosionVisible(){
 const x=oc.target.x,z=oc.target.z;
 liveProj.set(x,hgt(x,z),z).project(cam);
 return liveProj.z<1&&liveProj.z>-1&&Math.abs(liveProj.x)<1.25&&Math.abs(liveProj.y)<1.25;
}
function liveErosionPause(text){
 if(LIVE.paused===text)return;
 LIVE.paused=text;
 liveErosionStatus(text);
}
function liveErosionUnion(){
 const r=window.FELandscapeCore.erosionRect;
 if(!LIVE.hasRect){LIVE.rect[0]=r[0];LIVE.rect[1]=r[1];LIVE.rect[2]=r[2];LIVE.rect[3]=r[3];LIVE.hasRect=true;return}
 if(r[0]<LIVE.rect[0])LIVE.rect[0]=r[0];
 if(r[1]>LIVE.rect[1])LIVE.rect[1]=r[1];
 if(r[2]<LIVE.rect[2])LIVE.rect[2]=r[2];
 if(r[3]>LIVE.rect[3])LIVE.rect[3]=r[3];
}
function liveErosionFlush(){
 if(!LIVE.hasRect)return;
 const r=LIVE.rect;
 LIVE.lastW=r[1]-r[0]+1;LIVE.lastH=r[3]-r[2]+1;
 /* One cell of padding keeps the normal of the band edge honest. */
 updLive(Math.max(0,r[0]-1),Math.min(N,r[1]+1),Math.max(0,r[2]-1),Math.min(N,r[3]+1));
 LIVE.hasRect=false;
}
function startLiveErosion(){
 const core=window.FELandscapeCore;
 if(!core||!core.ready||typeof core.erosionBegin!=='function'){showErr('Live erosion needs the engine build — reload the page and try again');return false}
 if(typeof OW!=='undefined'&&OW.active){showErr('Live erosion works on the island terrain — return to the default terrain first');return false}
 if(LIVE.on)return true;
 if(!core.erosionBegin({n:N,size:S,droplets:LIVE.dots,heights:H,seed:(Math.round(seed*1000)+1)>>>0})){
  showErr('Erosion could not start: '+(core.error||'unknown'));return false;
 }
 /* One undo step for the whole run, taken after the kernel accepted it and
    before the first droplet, so a refused run leaves no empty history entry. */
 push();
 LIVE.on=true;LIVE.ran=0;
 /* The kernel is the authority on how many droplets the run accepted. */
 LIVE.total=typeof core.erosionRemaining==='function'?core.erosionRemaining():LIVE.dots;
 LIVE.hasRect=false;LIVE.trim=1;LIVE.paused='';LIVE.statusAt=0;
 liveErosionStatus('Eroding · 0 / '+LIVE.total+' droplets');
 if(tab==='terrain')build();
 return true;
}
function stopLiveErosion(reason){
 const core=window.FELandscapeCore;
 if(!LIVE.on)return false;
 if(core&&typeof core.erosionCancel==='function')core.erosionCancel();
 liveErosionFlush();
 LIVE.on=false;
 upd();
 /* The ground moved under whatever was standing on it, so the plants settle
    onto the new surface instead of hanging in the air or sinking. */
 resnap();
 liveErosionStatus(reason||('Erosion stopped · '+LIVE.ran+' droplets'));
 if(tab==='terrain')build();
 return true;
}
function liveErosionTick(now){
 if(!LIVE.on)return;
 if(typeof document!=='undefined'&&document.hidden){liveErosionPause('Paused · the tab is in the background');return}
 if(tab!=='terrain'){liveErosionPause('Paused · open the Terrain sheet to keep eroding');return}
 if(liveErosionBrushing()){liveErosionPause('Paused · you are brushing the ground');return}
 if(!liveErosionVisible()){liveErosionPause('Paused · the eroded patch is off screen');return}
 const core=window.FELandscapeCore;
 if(!core||!core.ready||typeof core.erosionStep!=='function'){stopLiveErosion('Erosion stopped · the engine went away');return}
 if(LIVE.paused)liveErosionPause('');
 const x=oc.target.x,z=oc.target.z;
 core.erosionRegion(x,z,LIVE.area*.5);
 /* The slice size follows the measured cost, so a slow phone runs fewer
    droplets instead of dropping frames. */
 const want=cl(Math.round(700*LIVE.rate*LIVE.trim),140,1800);
 const t0=nowMs();
 const ran=core.erosionStep(want);
 if(ran>0){
  LIVE.ran+=ran;
  if(core.erosionRead(H))liveErosionUnion();
 }
 if(LIVE.hasRect&&now-LIVE.uploadAt>33){LIVE.uploadAt=now;liveErosionFlush()}
 /* The cost that matters is the whole tick: the droplets, and the band upload
    on the frames that carry one. Trimming against the droplet loop alone would
    ignore the four uploads a second that are most likely to drop a frame. */
 const cost=nowMs()-t0;
 if(cost>3.2)LIVE.trim=Math.max(.18,LIVE.trim*.8);
 else if(cost<1.3)LIVE.trim=Math.min(1.8,LIVE.trim*1.06);
 if(core.erosionRemaining()===0){
  /* A regenerated grid cancels the kernel run, so "no droplets left" is only a
     finish when the run actually consumed its budget. */
  if(LIVE.ran>=LIVE.total)stopLiveErosion('Erosion finished · '+LIVE.ran+' droplets');
  else stopLiveErosion('Erosion stopped · the terrain was rebuilt');
  return;
 }
 if(!core.erosionActive()&&LIVE.ran<LIVE.total){stopLiveErosion('Erosion stopped · the terrain was rebuilt');return}
 if(now-LIVE.statusAt>250){
  LIVE.statusAt=now;
  /* Progress and the size of the patch, not a frame time: the sheet is not a
     profiler. */
  const r=LIVE.rect;
  const size=LIVE.hasRect?(r[1]-r[0]+1)+'×'+(r[3]-r[2]+1)+' cells':
   (LIVE.lastW?'about '+LIVE.lastW+'×'+LIVE.lastH+' cells':LIVE.area+' m patch');
  liveErosionStatus('Eroding · '+LIVE.ran+' / '+LIVE.total+' droplets · '+size);
 }
}
window.__feLiveErosion=LIVE;
window.__feStartLiveErosion=startLiveErosion;
window.__feStopLiveErosion=stopLiveErosion;
window.__feLiveErosionTick=liveErosionTick;
function owStatus(text){const n=document.getElementById('owstatus');if(n)n.textContent=text}
function owPump(token){if(token!==OW.token||!OW.active)return;if(!OW.activeJob&&!OW.queue.length){OW.generating=false;if(OW.waterMapsDirty){OW.waterMapsDirty=false;updateOpenWorldWaterHeightMaps()}owStatus('Ready · '+OW.chunks.size+' terrain chunks loaded · '+[...OW.chunks.values()].reduce((n,c)=>n+Object.values(c.plants).reduce((a,b)=>a+b.length,0),0).toLocaleString()+' plants');return}try{if(!OW.activeJob){const next=OW.queue.shift();if(OW.editStore.has(next.key)){owLoadChunk(next.cx,next.cz);requestAnimationFrame(()=>owPump(token));return}OW.activeJob={...next,job:OpenWorldGenerator.createChunkJob(owChunkConfig(next.cx,next.cz))}}const current=OW.activeJob,result=current.job.step(8,1024);if(result.done){OW.activeJob=null;owLoadChunk(current.cx,current.cz,result.chunk);OW.generated=true;owStatus('Loaded '+current.key+' · '+OW.chunks.size+' chunks active, '+OW.queue.length+' queued')}else owStatus('Generating '+current.key+' · '+result.phase+' '+Math.round(result.progress*100)+'%')}catch(e){console.error('Open World chunk generation failed:',e);owStatus('Generation error: '+(e?.message||e));OW.activeJob=null;OW.generating=false;return}requestAnimationFrame(()=>owPump(token))}
function owRefresh(force=false){if(!OW?.active)return;const p=owCenter(),half=OW.config.sizeKm*500,x=cl(p.x,-half,half),z=cl(p.z,-half,half),cx=Math.floor((x+OW.chunkSize*.5)/OW.chunkSize),cz=Math.floor((z+OW.chunkSize*.5)/OW.chunkSize);if(!force&&cx===OW.lastCenterX&&cz===OW.lastCenterZ)return;OW.lastCenterX=cx;OW.lastCenterZ=cz;const desired=new Set(),jobs=[],planCore=window.FELandscapeCore&&window.FELandscapeCore.ready&&typeof window.FELandscapeCore.owPlan==='function'?window.FELandscapeCore.owPlan({cx,cz,radius:OW.radius,chunkSize:OW.chunkSize,worldHalf:half}):null;
if(planCore&&planCore.count){for(let i=0;i<planCore.count;i++){const ax=planCore.cells[i*3],az=planCore.cells[i*3+1],d=planCore.cells[i*3+2],key=owKey(ax,az);desired.add(key);if(!OW.chunks.has(key)&&!OW.queue.some(q=>q.key===key))jobs.push({cx:ax,cz:az,key,d})}}
else for(let dz=-OW.radius;dz<=OW.radius;dz++)for(let dx=-OW.radius;dx<=OW.radius;dx++){const ax=cx+dx,az=cz+dz,key=owKey(ax,az);if(!owValidChunk(ax,az))continue;desired.add(key);if(!OW.chunks.has(key)&&!OW.queue.some(q=>q.key===key))jobs.push({cx:ax,cz:az,key,d:dx*dx+dz*dz})}for(const [key,c] of OW.chunks){if(!desired.has(key)){owDisposeChunk(c);OW.chunks.delete(key)}}OW.queue=OW.queue.filter(q=>desired.has(q.key));if(OW.activeJob&&!desired.has(OW.activeJob.key))OW.activeJob=null;jobs.sort((a,b)=>a.d-b.d);OW.queue.push(...jobs);water.position.x=cx*OW.chunkSize;water.position.z=cz*OW.chunkSize;OW.waterMapsDirty=true;if(OW.queue.length&&!OW.generating){OW.generating=true;const token=OW.token;requestAnimationFrame(()=>owPump(token))}if(!OW.queue.length)owStatus('Ready · '+OW.chunks.size+' chunks loaded')}
function owCurrentSettings(){return{sizeKm:cl(+OW.config.sizeKm,1,50),seed:Math.round(cl(+OW.config.seed,1,999999)),blend:cl(+OW.config.blend,0,1),mountainHeight:cl(+OW.config.mountainHeight,0,100),waterCoverage:cl(+OW.config.waterCoverage,0,100),waterLevel:cl(+OW.config.waterLevel,-80,0),vegetationDensity:cl(+OW.config.vegetationDensity,0,2.5),biomeMix:{hills:cl(+OW.config.biomeMix.hills,0,2),alpine:cl(+OW.config.biomeMix.alpine,0,2),desert:cl(+OW.config.biomeMix.desert,0,2),volc:cl(+OW.config.biomeMix.volc,0,2)}}}
function owSameSettings(a,b){return!!a&&!!b&&Object.keys(a).every(k=>k==='biomeMix'?Object.keys(a.biomeMix||{}).every(n=>a.biomeMix[n]===b.biomeMix?.[n]):a[k]===b[k])}
function owStart(){const next=owCurrentSettings(),resume=OW.generated&&!OW.active&&owSameSettings(next,OW.currentConfig);if(exploreMode)deactivateExplore(false);if(!OW.active){OW.savedScene={visibility:new Map(),camera:{position:cam.position.clone(),target:oc.target.clone(),maxDistance:oc.maxDistance},water:water.position.clone(),waterLevel:wl,waterLevelUserSet:wlUserSet};const keep=[ter,...Object.values(KIND).flatMap(K=>kindMeshes(K)),...objs,...(mapRoot?[mapRoot]:[]),...(typeof SBM!=='undefined'?[SBM]:[])];for(const o of keep){OW.savedScene.visibility.set(o,o.visible);o.visible=false}}if(!resume){OW.config=next;OW.currentConfig={...next,biomeMix:{...next.biomeMix}};for(const c of OW.chunks.values())owDisposeChunk(c);OW.chunks.clear();OW.editStore.clear();OW.history.length=OW.redo.length=0;OW.queue.length=0;OW.activeJob=null;OW.generated=false}OW.active=true;OW.group.visible=true;water.visible=true;setOpenWorldWaterRadius(true);wl=OW.config.waterLevel;U.wy.value=wl;water.position.y=wl;OW.segments=detail>=3?128:detail>=2?96:64;OW.lastCenterX=OW.lastCenterZ=NaN;const spawn=owFindSpawn(),dx=spawn.x-oc.target.x,dz=spawn.z-oc.target.z;oc.target.x=spawn.x;oc.target.z=spawn.z;cam.position.x+=dx;cam.position.z+=dz;const dy=spawn.y+6-oc.target.y;oc.target.y+=dy;cam.position.y+=dy;OW.token++;OW.generating=false;OW.activeJob=null;waterReflectionReady=false;water.position.y=wl;bt=tab==='plants'?'plants':tab==='terrain'?'terrain':'openworld';nav=false;setNav();owRefresh(true);msg(resume?'Resuming Open World':'Generating streamed Open World');build();}
function owDeactivate(){if(!OW?.active)return;OW.token++;OW.queue.length=0;OW.activeJob=null;OW.generating=false;for(const c of OW.chunks.values())owDisposeChunk(c);OW.chunks.clear();OW.group.visible=false;OW.active=false;OW.waterMapsDirty=false;setOpenWorldWaterRadius(false);if(OW.savedScene){for(const[o,v]of OW.savedScene.visibility)o.visible=v;for(const K of Object.values(KIND))for(const m of kindMeshes(K))m.visible=m.count>0;cam.position.copy(OW.savedScene.camera.position);oc.target.copy(OW.savedScene.camera.target);oc.maxDistance=OW.savedScene.camera.maxDistance;wl=OW.savedScene.waterLevel;wlUserSet=OW.savedScene.waterLevelUserSet===true;U.wy.value=wl;water.position.copy(OW.savedScene.water);U.hm.value=hmTex;U.hm2.value=SBT;U.uTerrainOrigin.value.set(0,0);cam.updateMatrixWorld(true);oc.update();OW.savedScene=null}OW.selected=null;waterReflectionReady=false;ring.visible=false;owStatus('Open World paused; generated chunks and edits are retained.');}
function owHeightBrush(p,dt){const r=Math.max(.1,br.r),changed=new Set();for(const c of OW.chunks.values()){const row=c.segments+1,step=c.size/c.segments,src=br.tool==='smooth'||br.tool==='erode'?c.heights.slice():null;let minI=c.segments,maxI=0,minJ=c.segments,maxJ=0,any=false;for(let j=0;j<=c.segments;j++)for(let i=0;i<=c.segments;i++){const wx=c.originX-c.size*.5+i*step,wz=c.originZ-c.size*.5+j*step,d=Math.hypot(wx-p.x,wz-p.z)/r;if(d>=1)continue;const f=(1-d*d)**2,k=j*row+i,old=c.heights[k];if(['biome','paint'].includes(br.tool)){if(br.tool==='biome'||normalWorldMaterialBrush){const amount=cl(f*2*br.str,0,1),base=k*12,total=c.surfaceWeights.subarray(base,base+12).reduce((a,b)=>a+b,0),fade=1-amount;if(total>.001)for(let q=0;q<12;q++)c.surfaceWeights[base+q]=c.surfaceWeights[base+q]/total*fade;else for(let q=0;q<12;q++)c.surfaceWeights[base+q]=0;let id=br.tool==='biome'||normalWorldMaterialBrush?normalWorldMaterial:[6,1,5,7,1,10][br.tex]||0;c.surfaceWeights[base+id]+=amount}else if(f>.2){const base=k*12;for(let q=0;q<12;q++)c.surfaceWeights[base+q]=q===[6,1,5,7,1,10][br.tex]?1:0}any=true}else{switch(br.tool){case'raise':c.heights[k]+=br.str*f*dt*10;break;case'lower':c.heights[k]-=br.str*f*dt*10;break;case'flat':c.heights[k]+=(fl-old)*Math.min(1,f*dt*10*br.str);break;case'smooth':case'erode':{const a=(src[k-(i>0)]+src[k+(i<c.segments)]+src[k-(j>0)*row]+src[k+(j<c.segments)*row])/4;c.heights[k]+=(a-old)*Math.min(1,f*dt*(br.tool==='erode'?5:14)*br.str)}break;case'terrace':c.heights[k]+=(Math.round(old/3)*3-old)*Math.min(1,f*dt*10*br.str);break;default:break}if(c.heights[k]!==old)any=true}if(any){minI=Math.min(minI,i);maxI=Math.max(maxI,i);minJ=Math.min(minJ,j);maxJ=Math.max(maxJ,j)}}if(!any)continue;c.dirty=true;if(!['biome','paint'].includes(br.tool))c.dirtyTerrain=true;const pos=c.terrain.geometry.attributes.position,color=c.terrain.geometry.attributes.color.array;for(let j=minJ;j<=maxJ;j++)for(let i=minI;i<=maxI;i++){const k=j*row+i;pos.setY(k,c.heights[k]);const col=owColor(c.surfaceWeights,k);color[k*3]=col[0];color[k*3+1]=col[1];color[k*3+2]=col[2]}pos.needsUpdate=true;c.terrain.geometry.attributes.color.needsUpdate=true;c.terrain.geometry.computeVertexNormals();c.terrain.geometry.computeBoundingSphere();if(!['biome','paint'].includes(br.tool))owQueueSync(c);changed.add(c)}return changed}
function owBrush(p,dt,from){if(bt==='plants')return owPlantAt(p,from);const touched=owHeightBrush(p,dt);if(touched.size)waterReflectionReady=false}
function owSelectFoliageAt(e){const rect=cv.getBoundingClientRect();m2.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(m2,cam);const hits=ray.intersectObjects([OW.group],true),hit=hits.find(h=>h.object?.isInstancedMesh&&h.object.userData?.kind&&Number.isInteger(h.instanceId));if(!hit){OW.selected=null;selectedFoliage=null;ring.visible=false;updateFoliageGlow();build();msg('No Open World foliage hit. Zoom in or tap closer to a plant.');return false}const refs=hit.object.userData.sourcePlants,item=refs?.[hit.instanceId],chunk=OW.chunks.get(hit.object.userData.chunkKey);if(!item||!chunk){OW.selected=null;return false}OW.selected={kind:hit.object.userData.kind,item,chunk};selectedFoliage=null;updateFoliageGlow();ring.position.set(item.x,item.y+.08,item.z);ring.scale.setScalar(cl((ROOT_SPAN[OW.selected.kind]||1)*item.s*.22,.55,4));ring.visible=true;build();msg('Selected '+(LBL[OW.selected.kind]||OW.selected.kind)+' in Open World.');return true}
function owSnapshot(){return[...OW.chunks].map(([key,c])=>({key,cx:c.cx,cz:c.cz,size:c.size,segments:c.segments,originX:c.originX,originZ:c.originZ,heights:c.heights.slice(),surfaceWeights:c.surfaceWeights.slice(),plants:owClonePlants(c.plants),dirtyTerrain:c.dirtyTerrain,dirty:true}))}
function owApplySnapshot(s){for(const d of s||[]){OW.editStore.set(d.key,d);const c=OW.chunks.get(d.key);if(!c)continue;c.heights.set(d.heights);c.surfaceWeights.set(d.surfaceWeights);c.plants=owClonePlants(d.plants);c.dirty=c.dirtyTerrain=!!d.dirtyTerrain;owUpdateChunkGeometry(c);owSyncChunk(c)}}
function owPushHistory(){if(!OW.active)return;OW.history.push(owSnapshot());while(OW.history.length>OW.maxHistory)OW.history.shift();OW.redo.length=0}
function owUndo(){if(!OW.history.length)return;OW.redo.push(owSnapshot());owApplySnapshot(OW.history.pop())}
function owRedo(){if(!OW.redo.length)return;OW.history.push(owSnapshot());owApplySnapshot(OW.redo.pop())}
OW.heightAt=owHeightAt;OW.normalAt=owNormalAt;OW.applyQuality=owSetQuality;OW.mIdx=(x,z)=>{const h=owHeightAt(x,z),weights=OpenWorldGenerator.biomeWeights(x,z,h,owHeightConfig());if(h<wl+.2)return 3;return weights.indexOf(Math.max(...weights))};OW.start=owStart;OW.deactivate=owDeactivate;OW.refresh=owRefresh;OW.syncChunk=owSyncChunk;OW.syncAllChunksForKind=k=>{for(const c of OW.chunks.values())owSyncChunk(c,k)};OW.pushHistory=owPushHistory;OW.undo=owUndo;OW.redo=owRedo;OW.selectFoliageAt=owSelectFoliageAt;OW.clearAllFoliage=()=>{OW.selected=null;updateFoliageGlow();for(const c of OW.chunks.values()){c.plants={};c.dirty=true;owSyncChunk(c)}for(const d of OW.editStore.values())d.plants={};ring.visible=false};
function owPlantAt(p,from=null){const touched=new Set(),dx=from?p.x-from.x:0,dz=from?p.z-from.z:0,l2=dx*dx+dz*dz,hit=o=>{const u=from&&l2?cl(((o.x-from.x)*dx+(o.z-from.z)*dz)/l2,0,1):0,cx=from?from.x+dx*u:p.x,cz=from?from.z+dz*u:p.z;return Math.hypot(o.x-cx,o.z-cz)<=br.r};if(br.kind==='erase'){for(const c of OW.chunks.values())for(const k in c.plants){const old=c.plants[k]||[],next=old.filter(o=>!hit(o));if(next.length!==old.length){c.plants[k]=next;c.dirty=true;touched.add(c);if(OW.selected?.chunk===c&&!next.includes(OW.selected.item))OW.selected=null}}for(const c of touched)owQueueSync(c);ring.visible=false;return}const k=br.kind,K=ensure(k);if(!K)return;const cover=['grass','tallgrass'].includes(k),flowers=['flower','daisy','tulip','lavender'].includes(k),n=Math.max(1,Math.round(br.den*RATE[k]))*(cover?6:flowers?4:3),step=Math.max(.12,Math.min(.55,br.r*.14)),dist=Math.hypot(dx,dz),samples=from?Math.max(1,Math.min(512,Math.ceil(dist/step))):1,half=OW.config.sizeKm*500;for(let j=0;j<samples;j++){const u=from?(j+.5)/samples:1,cx=from?from.x+dx*u:p.x,cz=from?from.z+dz*u:p.z;for(let i=0;i<n;i++){const a=i*2.3999632297+j*1.6180339887+(R()-.5)*.12,d=br.r*Math.sqrt((i+.5)/n)*(.96+R()*.08),x=cl(cx+Math.cos(a)*d,-half+.5,half-.5),z=cl(cz+Math.sin(a)*d,-half+.5,half-.5),c=owChunkAt(x,z);if(!c)continue;const y=owHeightAt(x,z),depth=wl-y,shallow=cover&&depth>=.45&&depth<=shallowBrushDepth;if(y<wl+.05&&!shallow)continue;const list=c.plants[k]||(c.plants[k]=[]);if(list.length>=OW.maxManualPlantsPerChunk)continue;list.push({x,y,z,s:SM[k]*(1+(R()-.5)*2*K.vr),r:R()*6.283,a:.88+R()*.24,v:.82+R()*.3,manual:true});c.dirty=true;touched.add(c)}}for(const c of touched)owQueueSync(c)}
OW.maxManualPlantsPerChunk=12000;OW.scatterActive=()=>{const chunks=[...OW.chunks.values()];if(!chunks.length)return;const token=OW.token,vegetationSeed=Math.floor(R()*2e9)+1;let i=0;const next=()=>{if(!OW.active||token!==OW.token||i>=chunks.length){owStatus('Natural scatter complete · '+chunks.length+' loaded chunks');return}const c=chunks[i++],extra=OpenWorldGenerator.generateChunk(owChunkConfig(c.cx,c.cz,vegetationSeed));for(const k in extra.plants){const list=c.plants[k]||(c.plants[k]=[]);for(const o of extra.plants[k]){if(list.length>=OW.maxManualPlantsPerChunk)break;o.y=owHeightAt(o.x,o.z);list.push(o)}}c.dirty=true;owQueueSync(c);owStatus('Natural scatter · '+i+'/'+chunks.length+' chunks');requestAnimationFrame(next)};next()};
function plantAt(p,from=null){if(br.kind=='erase'){const dx=from?p.x-from.x:0,dz=from?p.z-from.z:0,l2=dx*dx+dz*dz,hit=o=>{const u=from&&l2?cl(((o.x-from.x)*dx+(o.z-from.z)*dz)/l2,0,1):0,cx=from?from.x+dx*u:p.x,cz=from?from.z+dz*u:p.z;return Math.hypot(o.x-cx,o.z-cz)<=br.r};occRebuild();for(const k in KIND){if(bt=='city'&&!BLD[k]||bt=='plants'&&BLD[k])continue;const K=KIND[k],n=K.list.length;K.list=K.list.filter(o=>!hit(o));if(K.list.length!=n){if(selectedFoliage?.kind===k&&!K.list.includes(selectedFoliage.item)){selectedFoliage=null;ring.visible=false}sync(k)}}occRebuild();return}
const k=br.kind,manualPaint=bt=='plants',cover=['grass','tallgrass'].includes(k),flowers=['flower','daisy','tulip','lavender'].includes(k),n=Math.max(1,Math.round(br.den*RATE[k]))*(manualPaint?(cover?6:flowers?4:3):2);if(!manualPaint)occRebuild();const dx=from?p.x-from.x:0,dz=from?p.z-from.z:0,dist=Math.hypot(dx,dz),step=manualPaint?Math.max(.12,Math.min(.55,br.r*.14)):Math.max(.25,Math.min(1,br.r*.18)),samples=manualPaint&&from?Math.max(1,Math.min(512,Math.ceil(dist/step))):1;
for(let j=0;j<samples;j++){const u=from?(j+.5)/samples:1,cx=from?from.x+dx*u:p.x,cz=from?from.z+dz*u:p.z;for(let i=0;i<n;i++){const a=manualPaint?i*2.3999632297+j*1.6180339887+(R()-.5)*.12:R()*6.283,d=manualPaint?br.r*Math.sqrt((i+.5)/n)*(.96+R()*.08):Math.sqrt(R())*br.r;add(k,cl(cx+Math.cos(a)*d,-S/2+.05,S/2-.05),cl(cz+Math.sin(a)*d,-S/2+.05,S/2-.05),1.7,cityAng,manualPaint)}}if(BLD[k])for(const q in KIND)if(!BLD[q]){const Q=KIND[q],n0=Q.list.length;Q.list=Q.list.filter(o=>Math.hypot(o.x-p.x,o.z-p.z)>br.r);if(Q.list.length!=n0)sync(q)}sync(k)}

function scatter(kb){for(const k in KIND)if(!(kb&&BLD[k]))KIND[k].list=[];debClear();occRebuild();const density=cl(scatterDensity,1,2.5),big=BTAB[biome].filter(([n])=>FP[n]>=1.8),bw=big.reduce((a,[,w])=>a+w,0),ph=n=>RK[n]?0:FP[n]>=.9?1:2,smallBudget=36000*density,grassMixBonus=Math.round(36000*density),tallGrassMixBonus=Math.round(42000*density),wildflowerMixBonus=Math.round(7000*density),flowers=new Set(['flower','daisy','tulip','lavender']),coverBoost=n=>n==='grass'?3.1:n==='tallgrass'?3.2:flowers.has(n)?4:1,tab=BTAB[biome].filter(([n])=>!(FP[n]>=1.8)).map(([n,w])=>[n,Math.round(smallBudget*w*coverBoost(n))+(n==='grass'?grassMixBonus:n==='tallgrass'?tallGrassMixBonus:flowers.has(n)?wildflowerMixBonus:0)]).sort((a,b)=>ph(a[0])-ph(b[0]));
const bigCount=Math.round(36000*bw*5*density),SCBUF=new Float32Array(SCATTER_BATCH*4);
let uploaded=false;const pickBig=()=>{let r=R()*bw,k=big[0][0];for(const[n,w]of big){if(r<w){k=n;break}r-=w}return k};
const COVER_KINDS=new Set(['grass','tallgrass','flower','daisy','tulip','lavender']);
function scatterFill(count,pick,cover){
 const core=window.FELandscapeCore;let done=0;
 if(core&&core.ready&&core.scatterBegin&&core.scatterBatch){
  if(!uploaded)uploaded=!!core.scatterBegin({n:N,size:S,heights:H});
  if(uploaded){
   /* Ground cover asks the core for terrain-filtered, clumped candidates so the
      expensive grass/flower budgets land where they can actually grow. Every
      other kind keeps the jittered-grid candidates. */
   const natural=cover&&typeof core.scatterNatural==='function';
   while(done<count){const batch=Math.min(SCATTER_BATCH,count-done),seedBatch=(Math.round((seed||0)*1000)+done+1)>>>0;
    const got=natural
      ?core.scatterNatural({count:batch,spread:S*.96,seed:seedBatch,water:wl,maxSlope:cover.maxSlope,clump:cover.clump,patch:cover.patch,output:SCBUF})
      :core.scatterBatch({count:batch,spread:S*.96,seed:seedBatch,output:SCBUF});
    if(!got)break;
    for(let i=0;i<got;i++){const o=i*4;add(pick(),SCBUF[o],SCBUF[o+1],1,0,false,SCBUF[o+2],SCBUF[o+3])}
    done+=got;if(got<batch)break}
   if(done>=count)return}}
 for(let i=done;i<count;i++)add(pick(),(R()-.5)*S*.96,(R()-.5)*S*.96);
}
scatterFill(bigCount,pickBig);
for(const[n,c]of tab)scatterFill(c,()=>n,COVER_KINDS.has(n)?{maxSlope:(RULE[n]||[9])[0],clump:.25+scatterClustering*.45,patch:22}:null);
if(kb)clearUnderB();for(const k in KIND)sync(k)}
function resnap(){for(const k in KIND){KIND[k].list.forEach(o=>o.y=BLD[k]?bY(o.x,o.z,BLD[k]):hgt(o.x,o.z));sync(k)}}



/* Species slot in the kernel for every kind the quadtree can index. Built once
   from the flora table, so a kind without a species (rocks, buildings) simply
   misses and keeps the flat culling path. */
const FLORA_SLOT=(()=>{const t={},f=window.FELandscapeFlora;if(f&&Array.isArray(f.KINDS))f.KINDS.forEach((n,i)=>{t[n]=i});return t})();
const LOD_GROUND=new Set(['grass','tallgrass','flower','daisy','tulip','lavender']);
const LOD_TREES=new Set(['pine','oak','birch','palm','spruce','krumm','juniper','acacia','joshua','saguaro','barrel','prickly','treefern','deadtree']);
const LOD_BOTANICAL=new Set([...LOD_GROUND,...LOD_TREES,'shrub','fern','ashbush','agave','sage']);
function plantLodTier(k,d,x=0,z=0,full=750,wasLow){
 const far=LOD_GROUND.has(k)?8000:14000;
 if(!(d<far))return -1;
 const h=hh(x*.731+13.7,z*.917-7.3),threshold=full+h*Math.max(120,full*2),band=full;
 if(wasLow===undefined)return d<=threshold?0:1;
 return wasLow?(d<threshold-band?0:1):(d<=threshold+band?0:1);
}
/* ---- foliage impostors -------------------------------------------------- *
 * Past the low-detail band a tree is a few pixels tall, so it is drawn as one
 * camera-facing quad sampling an atlas the kernel baked from that very tree.
 *
 * Three things make this an impostor rather than a sticker:
 *   - the atlas is a real render of the grown mesh (wood *and* leaf cards),
 *     supersampled and key-lit by the same light the scene uses;
 *   - the quad billboards around Y only, because foliage does not look right
 *     tipping over as the camera tilts;
 *   - the column is chosen from the camera's azimuth, and the kernel owns that
 *     formula (fe_impostor_column) so the shader, the studio and the tests
 *     cannot drift apart.
 * Atlases are baked one per frame, on demand, and cached per species and seed. */
const IMPOSTOR_KINDS=new Set(['oak','birch','acacia','shrub','ashbush','deadtree','treefern','fern',
 'pine','spruce','krumm','juniper','palm','joshua','sage','saguaro','barrel','prickly','agave']);
const impostorWanted=new Set();
/* A layer of the picture, so it is a setting like every other one: off means
   the far band keeps the low-detail mesh it had before impostors existed. */
const IMPOSTOR_KEY='final3d.impostors.v1';
let impostorsOn=(()=>{try{return localStorage.getItem(IMPOSTOR_KEY)!=='0'}catch{return true}})();
function setImpostors(on){
 impostorsOn=!!on;
 try{localStorage.setItem(IMPOSTOR_KEY,impostorsOn?'1':'0')}catch{}
 for(const k in KIND){if(KIND[k].impMesh){KIND[k].impMesh.visible=false;KIND[k].impMesh.count=0}}
 impostorWanted.clear();
 for(const k of LOD_BOTANICAL)if(KIND[k])sync(k);
}
/* The atlas is baked under a fixed key light, so the billboard carries a light
   ratio instead of a light model: whatever the sun and sky are doing now,
   divided by what they were doing when the atlas was baked. A noon impostor is
   therefore matched exactly, and a dusk one darkens with the trees beside it. */
function sceneLightMix(out){
 let r=0,g=0,b=0;
 try{
  if(typeof sun!=='undefined'&&sun){const k=Math.max(0,sun.intensity);r+=sun.color.r*k;g+=sun.color.g*k;b+=sun.color.b*k}
  if(typeof hemi!=='undefined'&&hemi){const k=Math.max(0,hemi.intensity)*.5;r+=hemi.color.r*k;g+=hemi.color.g*k;b+=hemi.color.b*k}
  if(typeof envFill!=='undefined'&&envFill){const k=Math.max(0,envFill.intensity)*.35;r+=envFill.color.r*k;g+=envFill.color.g*k;b+=envFill.color.b*k}
 }catch{}
 return out.setRGB(Math.max(r,.02),Math.max(g,.02),Math.max(b,.02));
}
function impostorMaterial(tex,views,crop,off,ref){
 const mat=new THREE.ShaderMaterial({
  uniforms:{uAtlas:{value:tex},uViews:{value:views},
   /* Which part of the tile the plant occupies. */
   uCrop:{value:new THREE.Vector2(crop.x,crop.y)},uOff:{value:new THREE.Vector2(off.x,off.y)},
   uLight:{value:new THREE.Color(1,1,1)},
   uT:WU,uW:WW,uWindDir:U.uWindDir},
  fog:true,
  side:THREE.DoubleSide,
  vertexShader:`
   uniform float uViews;uniform float uT;uniform float uW;
   uniform vec2 uWindDir;uniform vec2 uCrop;uniform vec2 uOff;
   varying vec2 vUvA;varying vec2 vUvB;varying float vMix;varying vec3 vTint;
   #include <fog_pars_vertex>
   void main(){
    vec3 root=(instanceMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
    float sx=length(instanceMatrix[0].xyz);
    float sy=length(instanceMatrix[1].xyz);
    vec3 toCam=vec3(cameraPosition.x-root.x,0.0,cameraPosition.z-root.z);
    float d=length(toCam);
    toCam=d>0.0001?toCam/d:vec3(0.0,0.0,1.0);
    vec3 side=normalize(cross(vec3(0.0,1.0,0.0),toCam));
    /* One quad per plant, standing on the instance origin. */
    vec3 pos=root+side*(position.x*sx)+vec3(0.0,1.0,0.0)*((position.y+0.5)*sy);
    /* Foliage sways from the base: the top of the quad moves, the foot does not. */
    float h=clamp(position.y+0.5,0.0,1.0);
    float sway=sin(uT*1.7+root.x*0.11+root.z*0.07)+0.4*sin(uT*2.9+root.z*0.05);
    pos.xz+=uWindDir*(sway*uW*0.06*h*h*sy);
    /* Which baked azimuth we are looking from, wrapping like the kernel does. */
    float a=atan(toCam.x,toCam.z);
    a=a<0.0?a+6.28318530718:a;
    float u=a/(6.28318530718/uViews);
    float col=floor(u);
    /* Blend to the next column with the sub-view angle, so an orbit dissolves
       from one azimuth to the next instead of snapping between eight poses. */
    float frac=u-col;
    /* Map the quad onto the cropped part of the tile; no transparent margin is
       ever drawn, and every view shares one quad size. */
    vec2 inner=vec2(uOff.x+uv.x*uCrop.x,uOff.y+uv.y*uCrop.y);
    vUvA=vec2((col+inner.x)/uViews,inner.y);
    vUvB=vec2((mod(col+1.0,uViews)+inner.x)/uViews,inner.y);
    vMix=frac;
    #ifdef USE_INSTANCING_COLOR
     vTint=instanceColor;
    #else
     vTint=vec3(1.0);
    #endif
    vec4 mvPosition=viewMatrix*vec4(pos,1.0);
    gl_Position=projectionMatrix*mvPosition;
    #include <fog_vertex>
   }`,
  fragmentShader:`
   uniform sampler2D uAtlas;uniform vec3 uLight;
   varying vec2 vUvA;varying vec2 vUvB;varying float vMix;varying vec3 vTint;
   #include <fog_pars_fragment>
   void main(){
    vec4 t=mix(texture2D(uAtlas,vUvA),texture2D(uAtlas,vUvB),vMix);
    /* The atlas alpha is coverage, so the cutout is the silhouette of the
       model and not a rectangle with a tree painted on it. */
    if(t.a<0.30)discard;
    vec3 c=t.rgb*vTint*uLight;
    gl_FragColor=vec4(c,1.0);
    #include <fog_fragment>
   }`
 });
 mat.userData.ref=ref;mat.userData.now=new THREE.Color();
 mat.onBeforeRender=()=>{
  const now=sceneLightMix(mat.userData.now),r=mat.userData.ref;
  const u=mat.uniforms.uLight.value;
  u.setRGB(cl(now.r/r.r,.05,2.5),cl(now.g/r.g,.05,2.5),cl(now.b/r.b,.05,2.5));
 };
 return mat;
}
/* Build the billboard once the atlas exists. Split from impostorMeshFor so the
   async path can hand in pixels that arrived from the worker. */
function impostorMeshFromAtlas(k,atlas){
 const K=KIND[k];
 if(!K||K.impMesh)return K?.impMesh||null;
 if(!IMPOSTOR_KINDS.has(k)||!atlas||!atlas.texture)return null;
 const quad=new THREE.PlaneGeometry(1,1,1,1);
 const crop=atlas.cropU&&atlas.cropV?{x:atlas.cropU,y:atlas.cropV}:{x:1,y:1};
 const off={x:atlas.offU||0,y:0};
 const ref=sceneLightMix(new THREE.Color());
 const m=new THREE.InstancedMesh(quad,impostorMaterial(atlas.texture,atlas.views,crop,off,ref),Math.max(1,K.max));
 m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
 m.instanceColor=new THREE.BufferAttribute(new Float32Array(Math.max(1,K.max)*3).fill(1),3);
 m.instanceColor.setUsage(THREE.DynamicDrawUsage);
 m.count=0;m.frustumCulled=false;m.castShadow=false;m.receiveShadow=false;m.layers.mask=K.meshes[0]?.layers?.mask??1;
 m.name=k+' impostor';m.userData={kind:k,impostor:true,quadW:atlas.quadW,quadH:atlas.quadH,views:atlas.views,offThread:!!atlas.offThread};
 scene.add(m);K.impMesh=m;K.impAtlas=atlas;
 return m;
}
/* The synchronous route, for an already-cached atlas. */
function impostorMeshFor(k){
 const K=KIND[k];
 if(K.impMesh)return K.impMesh;
 if(!IMPOSTOR_KINDS.has(k))return null;
 const f=window.FELandscapeFlora;
 if(!f||typeof f.impostor!=='function')return null;
 /* Same species, same seed, same detail as the mesh the studio is drawing —
   the atlas is a render of that plant, not of a different one like it. */
 const seed=typeof f.seedFor==='function'?f.seedFor(k):undefined;
 return impostorMeshFromAtlas(k,f.impostor(k,seed,detail));
}
/* How many atlases may be baking at once. The worker runs them off the main
   thread, so the only limit is memory: two in flight keeps the queue moving
   without holding several instances' worth of species data at the same time. */
const IMPOSTOR_INFLIGHT=2;
let impostorBakes=0;
/* Baking is 20–36 ms of rasterising per species, so it never happens in a
   frame: it goes to the kernel worker, at most IMPOSTOR_INFLIGHT at a time, and
   only for a species that actually has far instances. When the worker answers,
   that species is re-routed immediately instead of waiting for the camera. */
function bakeQueuedImpostor(){
 if(!impostorWanted.size||impostorBakes>=IMPOSTOR_INFLIGHT)return;
 const f=window.FELandscapeFlora;
 const async=!!(f&&typeof f.impostorAsync==='function');
 const k=impostorWanted.values().next().value;
 if(k===undefined)return;
 impostorWanted.delete(k);
 const K=KIND[k];
 if(!K||K.impMesh||!K.list.length)return;
 if(!async){if(impostorMeshFor(k))sync(k);return}
 const seed=typeof f.seedFor==='function'?f.seedFor(k):undefined;
 impostorBakes++;
 f.impostorAsync(k,seed,detail).then(atlas=>{
  impostorBakes--;
  if(!atlas){/* Nothing to draw with: the far band keeps the low mesh. */return}
  if(!KIND[k])return;
  if(impostorMeshFromAtlas(k,atlas))sync(k);
 }).catch(error=>{
  impostorBakes--;
  if(typeof showErr==='function')showErr('Foliage impostor: '+(error&&error.message||error));
 });
}
/* A new detail level grows every plant again, so the atlases that were baked
   from the old meshes are stale. The pixels are dropped, not just the meshes:
   otherwise a tree keeps its old silhouette until the next reload. */
function resetImpostors(){
 for(const k in KIND){const K=KIND[k];if(!K.impMesh)continue;
  scene.remove(K.impMesh);K.impMesh.geometry?.dispose?.();K.impMesh.material?.dispose?.();
  K.impMesh=null;K.impAtlas=null}
 impostorWanted.clear();
 const f=window.FELandscapeFlora;if(f&&typeof f.impostorReset==='function')f.impostorReset();
}
function requestImpostor(k){if(IMPOSTOR_KINDS.has(k)&&!KIND[k]?.impMesh)impostorWanted.add(k)}

function lowMeshesFor(k){
 const K=KIND[k];
 if(K.lowMeshes)return K.lowMeshes;
 if(!LOD_KINDS.has(k)){K.lowMeshes=null;return null}
 K.lowMeshes=K.meshes.map(m=>{
  const lowMat=m.material.clone();
  lowMat.onBeforeCompile=m.material.onBeforeCompile;
  lowMat.customProgramCacheKey=m.material.customProgramCacheKey;
  lowMat.normalMap=null;lowMat.roughnessMap=null;lowMat.bumpMap=null;lowMat.needsUpdate=true;
  const low=new THREE.InstancedMesh(m.userData.lodGeom||m.geometry,lowMat,m.instanceMatrix.count);
  low.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  low.instanceColor=new THREE.BufferAttribute(new Float32Array(m.instanceMatrix.count*3).fill(1),3);
  low.instanceColor.setUsage(THREE.DynamicDrawUsage);
  low.count=0;low.frustumCulled=false;low.castShadow=false;low.receiveShadow=m.receiveShadow;
  low.layers.mask=m.layers.mask;low.name=(m.name||k)+' low';low.userData={...m.userData,lowLod:true,sourceListIndices:[]};
  scene.add(low);return low;
 });
 return K.lowMeshes;
}
/* One scratch buffer for the visibility call, grown once and then reused, so a
   camera settle never allocates. */
let lodScratch=new Float32Array(0);
let vpMat=null;
/* How far an instance of a kind is worth submitting. Ground cover also thins
   out inside its radius (the core does that), which is the overdraw budget. */
const VIEW_RADIUS={grass:190,tallgrass:210,flower:120,daisy:120,tulip:120,lavender:150,clover:130,shrub:600,ashbush:600,joshua:900,cactus:700,saguaro:700,barrel:520,rock:900,sandrock:900,basalt:900,pine:2400,oak:2400,birch:2400,palm:2000,acacia:2000,deadtree:2200,house:4200,block:4200,mid:4200,tower:5200};
/* A caster just outside the view still lands in the 60 m shadow box, so it is
   kept; a caster 100 m behind the camera cannot shadow anything on screen. */
function shadowPadFor(K){if(!K.meshes||!K.meshes.length)return 0;for(let i=0;i<K.meshes.length;i++)if(K.meshes[i].castShadow)return 60;return 0}
function sync(k,allInstances=false){
 const K=KIND[k],gr=['grass','tallgrass','flower','daisy','tulip','lavender'].includes(k),tl=gr ? .4 : RK[k] ? .5 : (BLD[k]||NT[k]) ? 0 : .07,T=K.tint;
 const lowAll=LOD_KINDS.has(k)?lowMeshesFor(k):null;
 /* The core answers with a compacted list of instance indices plus their tier;
   the bridge never walks the invisible ones. */
 const core=window.FELandscapeCore,n=K.list.length;
 let lodTiers=null,visOrder=null,visN=0,quadOk=false;
 if(n&&!allInstances&&core&&core.ready){
  if(lodScratch.length<n*3)lodScratch=new Float32Array(n*3);
  const xyz=lodScratch;
  /* One rolling checksum, computed while the positions are already being
     copied. It is the quadtree's generation: a plant that moved changes it, a
     camera that moved does not, so the tree survives every camera settle. */
  let gen=2166136261;
  for(let i=0;i<n;i++){const o=K.list[i];xyz[i*3]=o.x;xyz[i*3+1]=o.y;xyz[i*3+2]=o.z;
   gen=Math.imul(gen^(o.x*8|0),16777619)^Math.imul(gen^(o.z*8|0),2246822519)}
  const slot=FLORA_SLOT[k];
  if(!vpMat)vpMat=new THREE.Matrix4();
  cam.updateMatrixWorld();
  vpMat.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);
  /* `far` must never be below `mid`: the core rejects the call outright, and a
     ground-cover species (view radius 190 m) would be culled to nothing. Past
     `far`, a tree is under ten pixels tall and the impostor takes over; that is
     1.6x the full-detail radius, not some distant ring that a 1 km world never
     reaches. */
  const mid=lodFullDistance,radius=VIEW_RADIUS[k]||2600,far=Math.max(mid+60,Math.min(radius,Math.max(mid*1.6,mid+140))),
   margin=Math.min(90,Math.max(6,(K.size||1)*2+shadowPadFor(K))),groundOpt=LOD_GROUND.has(k)?1:0;
  if(slot!==undefined&&typeof core.lodTree==='function'){
   const qt=core.lodTree({slot,count:n,xyz,generation:gen,vp:vpMat.elements,camX:cam.position.x,camY:cam.position.y,camZ:cam.position.z,
    mid,far,radius,margin,options:groundOpt});
   /* Only the counts are kept: the index and tier arrays are views into the
      core's memory and the next species overwrites them. */
   if(qt&&qt.count>0){visOrder=qt.indices;lodTiers=qt.tiers;visN=qt.count;quadOk=true;
    K.lodStats={visible:qt.count,nodes:qt.nodes,visited:qt.visited,scanned:qt.scanned,rebuilt:qt.rebuilt}}
  }
  if(!quadOk&&typeof core.lodVisible==='function'){
   const vis=core.lodVisible({count:n,xyz,vp:vpMat.elements,camX:cam.position.x,camY:cam.position.y,camZ:cam.position.z,full:lodFullDistance,radius,far,margin,options:groundOpt});
   /* A degenerate matrix must never empty the world: if the core reports
      nothing while the kind clearly has instances, fall back to no culling. */
   if(vis&&vis.count>0){visOrder=vis.indices;lodTiers=vis.tiers;visN=vis.count}
   else if(core.lodClassify)lodTiers=core.lodClassify({count:n,xyz,camX:cam.position.x,camY:cam.position.y,camZ:cam.position.z,full:lodFullDistance,ground:LOD_GROUND.has(k)});
  }else if(!quadOk&&lowAll&&LOD_BOTANICAL.has(k)&&core.lodClassify){
   lodTiers=core.lodClassify({count:n,xyz,camX:cam.position.x,camY:cam.position.y,camZ:cam.position.z,full:lodFullDistance,ground:LOD_GROUND.has(k)});
  }
 }
 K.meshes.forEach((m,mi)=>{
  const pal=m.userData.pal,low=lowAll?.[mi]||null;
  let ci=0,li=0,ii=0;
  const sourceListIndices=[],lowSourceListIndices=[],impSourceListIndices=[];
  /* Dense list: matrix index i is the visible slot, and sourceIndex is only
     used to look the instance up (and to map a tap back to its plant). */
  const total=visOrder?visN:K.list.length;
  for(let q=0;q<total;q++){
   const sourceIndex=visOrder?visOrder[q]:q;
   const tierIndex=visOrder?q:sourceIndex;
   if(visOrder===null&&lodTiers&&lodTiers[sourceIndex]<0)continue;
   const o=K.list[sourceIndex];
   const nv=m.userData.vn;
   if(nv&&((hh(o.x*1.7,o.z*2.3)*997)|0)%nv!=m.userData.vi)return;
   const h2=hh(o.z,o.x),h3=hh(o.x,o.z),s=cl(o.s*K.size,TREE_SIZE_MIN[k]||0,TREE_SIZE_MAX[k]||Infinity);
   let rootSink=0,span=(ROOT_SPAN[k]||0)*s;
   if(span){let lowY=o.y;for(let q=0;q<12;q++){const a=q*Math.PI/6;for(const f of [.5,1])lowY=Math.min(lowY,hgt(o.x+Math.cos(a)*span*f,o.z+Math.sin(a)*span*f))}rootSink=Math.min(Math.max(0,o.y-lowY-.08),Math.min(.28*s,.16*span))}
   dm.position.set(o.x,o.y-(RK[k] ? .12*s : 0)-rootSink,o.z);
   if(!BLD[k]){const align=RK[k] ? .7 : ROOT_SPAN[k] ? .28+h2*.24 : NT[k] ? .28 : 1;dm.quaternion.setFromUnitVectors(GROUND_UP,groundNormal(o.x,o.z,align));GROUND_Q.setFromAxisAngle(GROUND_UP,o.r);dm.quaternion.multiply(GROUND_Q);const bend=k=='palm' ? .28 : (k=='acacia'||k=='joshua') ? .22 : (ROOT_SPAN[k]||NT[k]) ? .18 : .1;GROUND_E.set((h2-.5)*bend,0,(h3-.5)*bend,'YXZ');GROUND_Q.setFromEuler(GROUND_E);dm.quaternion.multiply(GROUND_Q)}else dm.rotation.set((h2-.5)*tl,o.r,(h3-.5)*tl,'YXZ');
   if(o.fl){dm.position.set(o.fl.x,o.fl.y,o.fl.z);if(o.fl.q)dm.quaternion.set(o.fl.q[0],o.fl.q[1],o.fl.q[2],o.fl.q[3]);else dm.rotation.set(o.fl.rx,o.fl.ry,o.fl.rz,'YXZ')}
   const bw=BLD[k]?K.size*o.a:s*o.a;
   dm.scale.set(bw,s,bw);
   if(BLD[k]&&m.userData.part==='roof'&&o.roofGone)dm.scale.set(0,0,0);
   dm.updateMatrix();
   /* Three tiers: the grown mesh, its low twin, and the baked impostor. The
      kernel hands back the tier per instance; if the atlas for this species is
      not ready yet the far instances stay on the low mesh and the bake is
      queued, so a plant never disappears while its atlas is being drawn. */
   let tier=0;
   if(!allInstances&&LOD_BOTANICAL.has(k)){
    if(lodTiers)tier=lodTiers[tierIndex]|0;
    else{const cx=cam.position.x,cz=cam.position.z,d=Math.hypot(o.x-cx,o.y-cam.position.y,o.z-cz);
     tier=plantLodTier(k,d,o.x,o.z,lodFullDistance)}
    if(tier<0)tier=0;
   }
   const imp=impostorsOn?(K.impMesh||null):null;
   if(tier===2&&!imp){tier=1;if(impostorsOn&&!allInstances)requestImpostor(k)}
   /* An impostor is one quad for the whole plant, so only the first material
      slot owns it; the rest of the plant's slots skip these instances. */
   if(tier===2&&mi>0)continue;
   let target,i;
   if(tier===2&&imp){
    dmi.position.set(o.x,o.y-rootSink,o.z);
    dmi.quaternion.identity();
    dmi.scale.set((K.impAtlas?.quadW||2)*bw,(K.impAtlas?.quadH||3)*s,1);
    dmi.updateMatrix();
    target=imp;i=ii++;impSourceListIndices[i]=sourceIndex;
    target.setMatrixAt(i,dmi.matrix);
   }else{
    const useLow=tier===1&&!!low;
    target=useLow?low:m;
    i=useLow?li++:ci++;
    target.setMatrixAt(i,dm.matrix);
    (useLow?lowSourceListIndices:sourceListIndices)[i]=sourceIndex;
   }
   let c=pal?pal[(h2*pal.length)|0]:[1.05-h2*.2,1,.9+h2*.2];
   if(gr&&!pal){const d=vn(o.x*.03+50,o.z*.03+20);c=[c[0]*(.85+d*.5),c[1]*(1-d*.15),c[2]*(1-d*.4)]}
   const v=o.v,t=pal||m.userData.nt?[1,1,1]:T,dmgTint=BLD[k]?1-(o.damage||0)*.14:1;
   target.setColorAt(i,tcol.setRGB(c[0]*v*t[0]*dmgTint,c[1]*v*t[1]*dmgTint,c[2]*v*t[2]*dmgTint));
  }
  m.count=ci;m.visible=ci>0;m.userData.sourceListIndices=sourceListIndices;m.instanceMatrix.needsUpdate=true;m.instanceColor.needsUpdate=true;
  if(low){low.count=li;low.visible=li>0;low.userData.sourceListIndices=lowSourceListIndices;low.instanceMatrix.needsUpdate=true;low.instanceColor.needsUpdate=true}
  const impMesh=K.impMesh;
  if(impMesh&&mi===0){impMesh.count=ii;impMesh.visible=ii>0;impMesh.userData.sourceListIndices=impSourceListIndices;impMesh.instanceMatrix.needsUpdate=true;impMesh.instanceColor.needsUpdate=true}
  const shadow=K.shadowMeshes?.[mi];
  if(shadow){const stride=Math.max(SHADOW_PROXY_STRIDE,Math.ceil(ci/Math.max(1,shadow.instanceMatrix.count)));let si=0;for(let j=0;j<ci;j+=stride){shadow.instanceMatrix.array.set(m.instanceMatrix.array.subarray(j*16,j*16+16),si*16);shadow.instanceColor.array.set(m.instanceColor.array.subarray(j*3,j*3+3),si*3);si++}shadow.count=si;shadow.visible=si>0;shadow.instanceMatrix.needsUpdate=true;shadow.instanceColor.needsUpdate=true}
 });
 K.selectionGridDirty=true;treeMapDirty=true;
}

const LOD_KINDS=new Set([...LOD_GROUND,...LOD_BOTANICAL,...LOD_TREES]);
const lodCameraAnchor=cam.position.clone();
let lodMotionAt=0,lodSettled=false;
/* The render loop must not allocate. The kind list and its camera anchor are
   built once, and the per-frame work is a distance compare plus, at most, one
   matrix rebuild. */
let lodKindList=null;
function foliageLodKinds(){
 const dirty=typeof window!=='undefined'&&window.__feFoliageLodDirty===true;
 if(!lodKindList||dirty){
  if(typeof window!=='undefined')window.__feFoliageLodDirty=false;
  lodKindList=[];
  for(const k of LOD_KINDS)if(KIND[k]&&Array.isArray(KIND[k].list))lodKindList.push(k);
 }
 return lodKindList;
}
/* Culling is only valid for the view it was computed for, so a settled camera
   re-builds every kind once, time-sliced across frames. Moving or rotating
   restarts the settle timer; nothing is queued while the camera is in motion,
   because a stale visible list is a missing plant. */
const lodQuat=typeof THREE!=='undefined'&&THREE.Quaternion?new THREE.Quaternion():null;
let lodSweep=0,lodSweeping=false;
function updateFoliageLOD(now){
 const moved=cam.position.distanceToSquared(lodCameraAnchor)>.0025;
 const turned=!!(lodQuat&&cam.quaternion)&&cam.quaternion.angleTo(lodQuat)>0.09;
 if(moved||turned){lodCameraAnchor.copy(cam.position);if(lodQuat&&cam.quaternion)lodQuat.copy(cam.quaternion);lodMotionAt=now;lodSettled=false;lodSweeping=false;return}
 /* Queued atlases drain whenever the camera is still, not only inside a sweep:
    a species queued on the last frame of one would otherwise wait for the next
    camera move before its far band switched tiers. Baking is skipped while the
    camera is moving, so it never costs a frame mid-gesture. */
 if(impostorWanted.size)bakeQueuedImpostor();
 if(!lodSettled){
  if(now-lodMotionAt<240)return;
  lodSettled=true;lodSweeping=true;lodSweep=0;
 }
 if(!lodSweeping)return;
 const kinds=foliageLodKinds();
 if(!kinds.length){lodSweeping=false;return}
 const start=(typeof performance!=='undefined'?performance:Date).now();
 while(lodSweep<kinds.length){
  const k=kinds[lodSweep++];
  if(KIND[k]&&Array.isArray(KIND[k].list)&&KIND[k].list.length)sync(k);
  if((typeof performance!=='undefined'?performance:Date).now()-start>3)return;
 }
 lodSweeping=false;
}
let season='summer';
const SEAS={spring:{},summer:{},autumn:{},winter:{}};
const kt=(k,s)=>(SEAS[s||season][k]||[1,1,1]).map((v,i)=>v*(k=='grass'||k=='tallgrass'?GT0[biome][i]:1));
function seasonalSnowState(t){const winter=sm(.78,.84,t)*(1-sm(.92,.985,t)),springMelt=1-sm(0,.08,t);return{cover:Math.max(winter,springMelt),fall:winter*.9}}
function setSeason(s){season=s;WX.seasonT={spring:.08,summer:.32,autumn:.66,winter:.9}[s];WX.seasonAuto=false;WX.instant=true;WX.snowAuto=true;const snow=seasonalSnowState(WX.seasonT);WX.coverT=snow.cover;WX.snowfallT=snow.fall;if(s==='spring'){WX.melt=Math.max(WX.melt,2.2);if(WX.preset==='blizzard')WX.preset=''}}
const plantCtl=()=>{const K=ensure(br.kind)||(OW?.active?owFallbackModel(br.kind):null);if(!K)return[];const t=el('<label class="sl"><span>Tint</span><input type="color"><output></output></label>'),i=t.children[1];i.value='#'+new THREE.Color(...K.tint.map(v=>cl(v,0,1))).getHexString();i.oninput=()=>{const c=new THREE.Color(i.value);K.tint=[c.r,c.g,c.b];syncFoliageKind(br.kind)};
return[G(sl('Size ×',.3,3,.05,K.size,v=>{K.size=v;syncFoliageKind(br.kind)}),sl('Variation',0,.9,.05,K.vr,v=>K.vr=v),t,sl('Wind',0,3,.1,windUser,v=>windUser=v))]};

const FOLIAGE_SELECT_CELL=8;
function getSelectedFoliage(){if(OW?.active&&OW.selected){const {kind,item,chunk}=OW.selected,K=ensure(kind)||owFallbackModel(kind),index=chunk?.plants?.[kind]?.indexOf(item)??-1;if(index<0){OW.selected=null;return null}return{kind,K,item,index,owChunk:chunk}}if(!selectedFoliage)return null;const K=KIND[selectedFoliage.kind],index=K?K.list.indexOf(selectedFoliage.item):-1;if(index<0){selectedFoliage=null;return null}return{kind:selectedFoliage.kind,K,item:selectedFoliage.item,index}}
function rebuildFoliageSelectionIndex(K){const grid=new Map();for(let i=0;i<K.list.length;i++){const o=K.list[i],x=o.fl?.x??o.x,z=o.fl?.z??o.z,cx=Math.floor(x/FOLIAGE_SELECT_CELL),cz=Math.floor(z/FOLIAGE_SELECT_CELL),key=cx+','+cz;let cell=grid.get(key);if(!cell)grid.set(key,cell=[]);cell.push(i)}K.selectionGrid=grid;K.selectionGridDirty=false;if(!K.selectionBounds){let minY=Infinity,maxY=-Infinity,rx=0,rz=0;for(const m of K.meshes){const g=m.geometry;if(!g.boundingBox)g.computeBoundingBox();const b=g.boundingBox;if(!b)continue;minY=Math.min(minY,b.min.y);maxY=Math.max(maxY,b.max.y);rx=Math.max(rx,Math.abs(b.min.x),Math.abs(b.max.x));rz=Math.max(rz,Math.abs(b.min.z),Math.abs(b.max.z))}if(!Number.isFinite(minY)){minY=0;maxY=1;rx=rz=.5}K.selectionBounds={minY,maxY,centerY:(minY+maxY)*.5,radius:Math.max(.45,Math.hypot(rx,rz,(maxY-minY)*.5))}}}
function syncFoliageKind(k){if(OW?.active){if(OW.selected?.kind===k)OW.syncChunk(OW.selected.chunk,k);else OW.syncAllChunksForKind(k)}else sync(k)}
function selectedFoliageSlider(label,min,max,step,value,cb){const d=el(`<label class="sl"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output></output></label>`),i=d.children[1],out=d.children[2];let saved=false;const update=()=>out.textContent=(+i.value).toFixed(2);i.onpointerdown=()=>{saved=false};i.onkeydown=()=>{saved=false};i.oninput=()=>{if(!saved){push();saved=true}update();cb(+i.value)};i.onchange=()=>{saved=false};update();return d}
function foliageSelectionControls(){const s=getSelectedFoliage();if(!s)return foliageSelectMode?[el('<div class="hint">Select mode: tap a grass, flower, rock, shrub or tree to edit that individual plant.</div>')]:[];const {kind,K,item}=s,title=LBL[kind]||kind,min=TREE_SIZE_MIN[kind]||.3,max=TREE_SIZE_MAX[kind]||4,size=cl(item.s*K.size,min,max);return[el(`<div class="hint"><b>Selected: ${title}</b> · only this planted instance is edited. Its brush remains additive.</div>`),G(selectedFoliageSlider('Selected size ×',min,max,.05,size,v=>{item.s=v/Math.max(K.size,.001);syncFoliageKind(kind);updateFoliageGlow()}),selectedFoliageSlider('Shape variation ×',.5,1.5,.05,cl(item.a??1,.5,1.5),v=>{item.a=v;syncFoliageKind(kind);updateFoliageGlow()})),...(br.kind!=='erase'?[btn('Replace selected with '+(LBL[br.kind]||br.kind),()=>replaceSelectedFoliage(br.kind))]:[]),btn('Remove selected foliage',removeSelectedFoliage)]}
function removeSelectedFoliage(){const s=getSelectedFoliage();if(!s)return;push();if(s.owChunk){s.owChunk.plants[s.kind].splice(s.index,1);s.owChunk.dirty=true;OW.selected=null;OW.syncChunk(s.owChunk,s.kind)}else{s.K.list.splice(s.index,1);s.K.selectionGridDirty=true;selectedFoliage=null;occRebuild();sync(s.kind)}ring.visible=false;updateFoliageGlow();build();msg('Removed selected '+(LBL[s.kind]||s.kind)+'.')}
function replaceSelectedFoliage(nextKind){const s=getSelectedFoliage();if(!s||!nextKind||nextKind==='erase'||nextKind===s.kind)return false;const target=ensure(nextKind)||(OW?.active?owFallbackModel(nextKind):null);if(!target)return false;if(!s.owChunk&&target.list.length>=target.max&&!growManualCapacity(nextKind,target.list.length+1)){msg('Could not replace: no instance capacity available.');return false}push();const old=s.item,relative=old.s/(SM[s.kind]||1),item={x:old.x,y:hgt(old.x,old.z),z:old.z,s:(SM[nextKind]||1)*relative,r:old.r,a:old.a,v:old.v,manual:!!old.manual};if(s.owChunk){s.owChunk.plants[s.kind].splice(s.index,1);(s.owChunk.plants[nextKind]||(s.owChunk.plants[nextKind]=[])).push(item);s.owChunk.dirty=true;OW.selected={kind:nextKind,item,chunk:s.owChunk};OW.syncChunk(s.owChunk)}else{s.K.list.splice(s.index,1);target.list.push(item);s.K.selectionGridDirty=target.selectionGridDirty=true;occRebuild();sync(s.kind);sync(nextKind);selectedFoliage={kind:nextKind,item}}br.kind=nextKind;setNav();updateFoliageGlow();build();msg('Replaced selected foliage with '+(LBL[nextKind]||nextKind)+'.');return true}
function selectFoliageAt(e){if(OW?.active)return OW.selectFoliageAt(e);const ground=pick(e,[ter]);if(!ground){selectedFoliage=null;ring.visible=false;updateFoliageGlow();build();return false}const origin=ray.ray.origin,dir=ray.ray.direction,dist=origin.distanceTo(ground.point),touch=e.pointerType!=='mouse',padAngle=(touch?5:2.4)*Math.PI/180,searchRadius=cl(dist*.16+7,12,46),samples=[0,3,6,10,15,22,30,40],seen=new Set(),candidates=[];for(const dy of samples){if(Math.abs(dir.y)<.002)continue;const t=(ground.point.y+dy-origin.y)/dir.y;if(t<0||t>dist+45)continue;const x=origin.x+dir.x*t,z=origin.z+dir.z*t,r=cl(t*Math.tan(padAngle)+1.5,3,searchRadius),minX=Math.floor((x-r)/FOLIAGE_SELECT_CELL),maxX=Math.floor((x+r)/FOLIAGE_SELECT_CELL),minZ=Math.floor((z-r)/FOLIAGE_SELECT_CELL),maxZ=Math.floor((z+r)/FOLIAGE_SELECT_CELL);for(const kind in KIND){if(BLD[kind])continue;const K=KIND[kind];if(!K.list.length)continue;if(K.selectionGridDirty||!K.selectionGrid)rebuildFoliageSelectionIndex(K);for(let cx=minX;cx<=maxX;cx++)for(let cz=minZ;cz<=maxZ;cz++){const cell=K.selectionGrid.get(cx+','+cz);if(cell)for(const index of cell){const key=kind+':'+index;if(!seen.has(key)){seen.add(key);candidates.push({kind,K,index,item:K.list[index]})}}}}}let best=null,bestAlong=Infinity;for(const c of candidates){const o=c.item,b=c.K.selectionBounds;if(!o||!b)continue;const size=cl(o.s*c.K.size,TREE_SIZE_MIN[c.kind]||0,TREE_SIZE_MAX[c.kind]||Infinity),x=o.fl?.x??o.x,y=o.fl?.y??o.y,z=o.fl?.z??o.z,cy=y+b.centerY*size,along=(x-origin.x)*dir.x+(cy-origin.y)*dir.y+(z-origin.z)*dir.z;if(along<0||along>dist+45||along>=bestAlong)continue;const dx=origin.x+dir.x*along-x,dy=origin.y+dir.y*along-cy,dz=origin.z+dir.z*along-z,pad=Math.max(touch ? .7 : .25,along*Math.tan(padAngle)),rad=b.radius*size+pad;if(dx*dx+dy*dy+dz*dz<=rad*rad){best={...c,size};bestAlong=along}}selectedFoliage=best?{kind:best.kind,item:best.item}:null;updateFoliageGlow();if(best){ring.position.set(best.item.fl?.x??best.item.x,(best.item.fl?.y??best.item.y)+.08,best.item.fl?.z??best.item.z);ring.scale.setScalar(cl(best.K.selectionBounds.radius*best.size*.3,.55,4));ring.visible=true;msg('Selected '+(LBL[best.kind]||best.kind)+'. Edit its size/variation or replace the model in Foliage settings.')}else{ring.visible=false;msg('No foliage hit. Zoom in or tap closer to a plant.')}build();return!!best}
function setFoliageSelectMode(on){foliageSelectMode=!!on;if(foliageSelectMode){nav=false;ring.visible=false;if(!OW?.active)for(const k in KIND)if(!BLD[k]&&KIND[k].list.length&&(KIND[k].selectionGridDirty||!KIND[k].selectionGrid))rebuildFoliageSelectionIndex(KIND[k])}else ring.visible=false;setNav();updateFoliageGlow()}