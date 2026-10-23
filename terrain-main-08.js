
/* pointer input */
const ray=new THREE.Raycaster(),m2=new THREE.Vector2(),ptrs=new Set();let down=null,painting=false,paintingTerrain=false,lastT=0,lastBrushPoint=null;
function pick(e,o){const r=cv.getBoundingClientRect();m2.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(m2,cam);const hits=ray.intersectObjects(o,true);return hits.find(h=>h.object===ter)||hits[0]}const activeSurfaceTargets=()=>OW?.active?[...OW.chunks.values()].map(c=>c.terrain):[ter,...objs];
const root=o=>{while(o.parent&&o.parent!==scene)o=o.parent;return o};
const apply=(p,dt,from)=>OW?.active?owBrush(p,dt,from):bt=='terrain'?sculpt(p,dt):plantAt(p,from);
function tap(e){if(OW?.active&&place){msg('Placeable scene objects remain in the default Terrain context.');return}if(bt=='city'&&cityTap&&!nav&&tab!='obj'){const h=pick(e,activeSurfaceTargets());if(h)genCity(h.point);return}if(place){const h=pick(e,activeSurfaceTargets());if(h){const o=LIB[place]();o.userData.n=nm(place);o.position.copy(h.point);o.rotation.y=R()*6.28;push();scene.add(o);objs.push(o);shade();select(o)}return}
const h=pick(e,objs);select(h?root(h.object):null)}
cv.oncontextmenu=e=>e.preventDefault();
cv.addEventListener('pointerdown',e=>{ptrs.add(e.pointerId);if(ptrs.size>1){const endedTerrain=painting&&paintingTerrain;painting=false;paintingTerrain=false;lastBrushPoint=null;down=null;if(endedTerrain)resnap();return}down={x:e.clientX,y:e.clientY};if(foliageSelectMode&&tab==='plants'&&!nav&&e.button!==2){selectFoliageAt(e);down=null;e.preventDefault();return}
if(brushTab()&&!nav&&e.button!==2){const h=pick(e,activeSurfaceTargets());if(h){painting=true;paintingTerrain=bt==='terrain'&&!OW?.active;try{cv.setPointerCapture(e.pointerId)}catch(_){}push();fl=h.point.y;lastT=performance.now();lastBrushPoint=h.point.clone();apply(h.point,.03)}}});
cv.addEventListener('pointermove',e=>{if(foliageSelectMode){if(!selectedFoliage)ring.visible=false;return}if(!brushTab()||nav||!(painting||e.pointerType=='mouse'))return;const h=pick(e,activeSurfaceTargets());ring.visible=!!h;if(!h)return;
ring.position.set(h.point.x,h.point.y+.3,h.point.z);ring.scale.setScalar(br.r);
const t=performance.now();if(painting&&t-lastT>8){apply(h.point,Math.min(.06,(t-lastT)/1000),lastBrushPoint);lastBrushPoint=h.point.clone();lastT=t}});
cv.addEventListener('pointerup',e=>{ptrs.delete(e.pointerId);if(e.pointerType!='mouse'&&!foliageSelectMode)ring.visible=false;if(painting){const endedTerrain=paintingTerrain;painting=false;paintingTerrain=false;lastBrushPoint=null;if(endedTerrain)resnap()}
if(down&&((panelOpen&&tab=='obj')||(bt=='city'&&cityTap&&!nav))&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<6&&!tc.dragging&&!tc.axis)tap(e);down=null});
cv.addEventListener('pointercancel',e=>{const endedTerrain=painting&&paintingTerrain;ptrs.delete(e.pointerId);painting=false;paintingTerrain=false;lastBrushPoint=null;if(endedTerrain)resnap()});