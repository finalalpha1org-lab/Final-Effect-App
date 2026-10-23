
/* ===== weather, snow, seasons, storms, tornado, tsunami ===== */
const WX={rain:0,rainT:0,over:0,overT:0,storm:0,stormT:0,snowfall:0,snowfallT:0,cover:0,coverT:0,melt:1,snowAuto:true,seasonT:.32,seasonAuto:false,cycle:120,leafRate:4,waitLeaves:true,flash:0,fT:9,nextFlash:0,preset:'',
tor:{on:false,x:0,z:0,r:7,spd:9,dmg:true,dx:0,dz:0,t:0,ef:3},tsu:{on:false,f:-175,amp:9,spd:26,dir:0,dmg:true}};
let windUser=1,hemiBase=0,lastSky=0,lastFall=-1e9,lastSkyK=-1,lastDmg=0,lastDmg2=0;
const NR=7000,NS=6000,NF=2200;
const rU={uT:{value:0},uInt:{value:0},uCenter:{value:new THREE.Vector3()},uBox:{value:new THREE.Vector3(80,46,80)},uWind:{value:new THREE.Vector2(.2,.15)}};
const sU={uT:{value:0},uInt:{value:0},uCenter:{value:new THREE.Vector3()},uBox:{value:new THREE.Vector3(80,46,80)},uWind:{value:new THREE.Vector2(.2,.15)}};
const fU={uT:{value:0},uFall:{value:0},uWind:{value:new THREE.Vector2(.3,.2)}};

const BOXV=`attribute float aRnd;uniform float uT,uInt;uniform vec3 uCenter,uBox;uniform vec2 uWind;`;
const rainMesh=(()=>{const g=new THREE.BufferGeometry(),p=new Float32Array(NR*6),e=new Float32Array(NR*2),r=new Float32Array(NR*2);
for(let i=0;i<NR;i++){const x=(R()-.5)*80,y=R()*46,z=(R()-.5)*80,q=R();for(let k=0;k<2;k++){p[i*6+k*3]=x;p[i*6+k*3+1]=y;p[i*6+k*3+2]=z;e[i*2+k]=k;r[i*2+k]=q}}
g.setAttribute('position',new THREE.BufferAttribute(p,3));g.setAttribute('aEnd',new THREE.BufferAttribute(e,1));g.setAttribute('aRnd',new THREE.BufferAttribute(r,1));
const m=new THREE.LineSegments(g,new THREE.ShaderMaterial({uniforms:rU,transparent:true,depthWrite:false,fog:false,
vertexShader:BOXV+`attribute float aEnd;varying float vA;void main(){float spd=24.+aRnd*12.;float y=mod(position.y-uT*spd,uBox.y);vec2 off=mod(position.xz-uCenter.xz+uBox.xz*.5,uBox.xz)-uBox.xz*.5;vec3 wp=vec3(uCenter.x+off.x,uCenter.y-10.+y,uCenter.z+off.y);wp.xz+=uWind*(uBox.y-y)*.05;wp+=aEnd*vec3(-uWind.x*.55,1.7+aRnd*.9,-uWind.y*.55);float on=step(aRnd,uInt);vA=on*(1.-aEnd*.6)*.5;gl_Position=on>.5?projectionMatrix*viewMatrix*vec4(wp,1.):vec4(2.,2.,2.,1.);}`,
fragmentShader:`varying float vA;void main(){gl_FragColor=vec4(.78,.84,.92,vA);}`}));m.frustumCulled=false;m.visible=false;scene.add(m);return m})();
const snowMesh=(()=>{const g=new THREE.BufferGeometry(),p=new Float32Array(NS*3),r=new Float32Array(NS);for(let i=0;i<NS;i++){p[i*3]=(R()-.5)*80;p[i*3+1]=R()*46;p[i*3+2]=(R()-.5)*80;r[i]=R()}
g.setAttribute('position',new THREE.BufferAttribute(p,3));g.setAttribute('aRnd',new THREE.BufferAttribute(r,1));
const m=new THREE.Points(g,new THREE.ShaderMaterial({uniforms:sU,transparent:true,depthWrite:false,fog:false,
vertexShader:BOXV+`void main(){float y=mod(position.y-uT*(1.1+aRnd*1.3),uBox.y);vec2 off=mod(position.xz-uCenter.xz+uBox.xz*.5,uBox.xz)-uBox.xz*.5;vec3 wp=vec3(uCenter.x+off.x,uCenter.y-10.+y,uCenter.z+off.y);wp.x+=sin(uT*.7+aRnd*40.+y*.3)*1.2+uWind.x*(uBox.y-y)*.12;wp.z+=cos(uT*.6+aRnd*33.+y*.25)*1.2+uWind.y*(uBox.y-y)*.12;float on=step(aRnd,uInt);vec4 mv=viewMatrix*vec4(wp,1.);gl_PointSize=on*clamp(260./(-mv.z),1.5,9.);gl_Position=on>.5?projectionMatrix*mv:vec4(2.,2.,2.,1.);}`,
fragmentShader:`void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;gl_FragColor=vec4(1.,1.,1.,(1.-d*2.)*.9);}`}));m.frustumCulled=false;m.visible=false;scene.add(m);return m})();
const fallMesh=(()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(NF*3).fill(-200),3));g.setAttribute('aG',new THREE.BufferAttribute(new Float32Array(NF),1));g.setAttribute('aRnd',new THREE.BufferAttribute(Float32Array.from({length:NF},R),1));
const m=new THREE.Points(g,new THREE.ShaderMaterial({uniforms:fU,transparent:false,depthWrite:true,fog:false,
vertexShader:`attribute float aG,aRnd;uniform float uT,uFall;uniform vec2 uWind;varying vec3 vC;void main(){float ph=fract(uT*.1*(.6+aRnd*.8)+aRnd*9.);float y=mix(position.y,aG,ph*ph*.35+ph*.65);vec3 wp=vec3(position.x+sin(uT*1.5+aRnd*30.+ph*8.)*1.1*ph+uWind.x*ph*5.,y,position.z+cos(uT*1.3+aRnd*20.+ph*7.)*1.1*ph+uWind.y*ph*5.);float on=step(aRnd,uFall)*(1.-smoothstep(.9,1.,ph));vec4 mv=viewMatrix*vec4(wp,1.);gl_PointSize=on*clamp(110./(-mv.z),1.,6.);gl_Position=on>.5?projectionMatrix*mv:vec4(2.,2.,2.,1.);vec3 c=mix(vec3(.85,.45,.08),vec3(.7,.15,.07),fract(aRnd*11.));vC=mix(c,vec3(.9,.7,.12),step(.66,fract(aRnd*5.)));}`,
fragmentShader:`varying vec3 vC;void main(){vec2 q=gl_PointCoord-.5;if(length(q*vec2(1.,1.6))>.5)discard;gl_FragColor=vec4(vC,1.);}`}));m.frustumCulled=false;m.visible=false;scene.add(m);return m})();
const bolt=(()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(18*3),3));const m=new THREE.Line(g,new THREE.LineBasicMaterial({color:0xdfe8ff,fog:false}));m.frustumCulled=false;m.visible=false;scene.add(m);return m})();
const tU={uT:{value:0},uPos:{value:new THREE.Vector3()},uSz:{value:new THREE.Vector2(7,80)},uK:{value:0}},dU={uT:{value:0},uPos:{value:new THREE.Vector3()},uSz:{value:new THREE.Vector2(7,80)},uK:{value:0}},cU={uT:{value:0},uPos:{value:new THREE.Vector3()},uK:{value:0}};
const NOISEG=`float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}float fbm(vec2 p){return .5*vn(p)+.25*vn(p*2.1)+.125*vn(p*4.3)+.0625*vn(p*8.7);}`;
const torGrp=new THREE.Group(),funnel=new THREE.Mesh(new THREE.CylinderGeometry(1,.12,1,40,28,true).translate(0,.5,0),new THREE.ShaderMaterial({uniforms:tU,transparent:true,depthWrite:false,side:THREE.DoubleSide,fog:false,
vertexShader:`uniform float uT;uniform vec3 uPos;uniform vec2 uSz;varying float vH,vAng;varying vec3 vN,vWp;void main(){float h=position.y;vAng=atan(position.z,position.x);vec3 p=position;p.xz*=uSz.x*(.4+2.4*h);p.xz+=vec2(sin(h*3.+uT*.8),cos(h*2.6+uT*.7))*h*h*uSz.x*.9;vH=h;vN=normalize(vec3(position.x,0.,position.z));vec3 wp=uPos+vec3(p.x,h*uSz.y,p.z);vWp=wp;gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.);}`,
fragmentShader:`uniform float uT,uK;varying float vH,vAng;varying vec3 vN,vWp;`+NOISEG+`void main(){vec3 V=normalize(cameraPosition-vWp);float edge=pow(abs(dot(vN,V)),.7);float sw=fbm(vec2(cos(vAng)*3.+vH*5.-uT*1.1,sin(vAng)*3.-uT*.7+vH*3.));float d=smoothstep(.25,.85,sw)*.8+.2;float a=edge*d*(.55-.25*vH)*smoothstep(0.,.05,vH)*(1.-smoothstep(.85,1.,vH))*uK;vec3 col=mix(vec3(.26,.22,.17),vec3(.55,.55,.57),smoothstep(0.,.55,vH));col*=.75+.4*sw;gl_FragColor=vec4(col,a);}`}));
funnel.frustumCulled=false;
const torDust=(()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(700*3),3));g.setAttribute('aRnd',new THREE.BufferAttribute(Float32Array.from({length:700},R),1));
const m=new THREE.Points(g,new THREE.ShaderMaterial({uniforms:dU,transparent:true,depthWrite:false,fog:false,
vertexShader:`attribute float aRnd;uniform float uT,uK;uniform vec3 uPos;uniform vec2 uSz;varying float vD,vA;void main(){float k=fract(aRnd*7.1),dust=step(k,.55);float h=fract(aRnd*3.1+uT*(.05+.1*(1.-dust))*(.5+aRnd));float ang=uT*(1.6+aRnd*2.6)+aRnd*60.;float rad=uSz.x*(dust>.5?(.9+h*2.6+aRnd*.8):(.3+h*2.2)*(.5+fract(aRnd*7.3)*.8));float y=dust>.5?h*uSz.y*.22:h*h*uSz.y*.9;vec3 wp=uPos+vec3(cos(ang)*rad,y,sin(ang)*rad);vec4 mv=viewMatrix*vec4(wp,1.);gl_PointSize=dust>.5?clamp(900./(-mv.z)*(.7+h),4.,150.):clamp(80./(-mv.z),1.5,6.);gl_Position=projectionMatrix*mv;vD=dust;vA=uK*(dust>.5?.28*(1.-h*.6):.9);}`,
fragmentShader:`varying float vD,vA;void main(){vec2 q=gl_PointCoord-.5;float d=length(q);if(d>.5)discard;float a=vD>.5?pow(1.-2.*d,1.5)*vA:vA;gl_FragColor=vec4(vD>.5?vec3(.42,.36,.28):vec3(.18,.14,.1),a);}`}));m.frustumCulled=false;return m})();
const torCloud=new THREE.Mesh(new THREE.CircleGeometry(170,48).rotateX(-Math.PI/2),new THREE.ShaderMaterial({uniforms:cU,transparent:true,depthWrite:false,side:THREE.DoubleSide,fog:false,
vertexShader:`uniform vec3 uPos;varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*viewMatrix*vec4(uPos+vec3(position.x,0.,position.z),1.);}`,
fragmentShader:`uniform float uT,uK;varying vec3 vP;`+NOISEG+`void main(){float r=length(vP.xz)/170.;float n=fbm(vP.xz*.045+vec2(uT*.03,-uT*.02));float a=(1.-smoothstep(.2,1.,r))*(.35+.65*n)*uK*.85;gl_FragColor=vec4(vec3(.14,.15,.17)*(.7+.5*n),a);}`}));torCloud.frustumCulled=false;
torGrp.add(funnel,torDust,torCloud);torGrp.visible=false;scene.add(torGrp);
/* ---------- debris: planks, panels, roof tiles, bricks, logs and leaves that fly, float and settle ---------- */
const DEBMAX=1400,DB=[];let debDirty=false;
const debIM=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({roughness:.85,metalness:0}),DEBMAX);debIM.instanceColor=new THREE.BufferAttribute(new Float32Array(DEBMAX*3).fill(1),3);debIM.count=0;debIM.frustumCulled=false;debIM.castShadow=true;debIM.receiveShadow=true;scene.add(debIM);
const dbo=new THREE.Object3D(),dcol=new THREE.Color();
const DPAL={wall:[[.82,.78,.7],[.7,.66,.6]],roof:[[.42,.2,.16],[.3,.3,.32],[.5,.28,.2]],wood:[[.46,.33,.2],[.35,.25,.15],[.55,.42,.28]],brick:[[.55,.26,.2],[.5,.3,.25]],glass:[[.55,.7,.75]],leaf:[[.25,.3,.12],[.3,.22,.1]]};
function spawnDeb(x,y,z,n,type,vx,vz,spread,mode){const rnd=Math.random;for(let i=0;i<n;i++){if(DB.length>=DEBMAX){const j=DB.findIndex(d=>d.st==1);DB.splice(j<0?0:j,1)}
const pal=DPAL[type],c=pal[(rnd()*pal.length)|0],j=.85+rnd()*.3,sz=type=='wood'?[.08+rnd()*.1,.06+rnd()*.06,.8+rnd()*1.6]:type=='roof'?[.7+rnd()*.7,.04,.5+rnd()*.6]:type=='wall'?[.5+rnd()*.8,.4+rnd()*.7,.08]:type=='glass'?[.3+rnd()*.4,.3+rnd()*.4,.02]:type=='leaf'?[.5+rnd()*.5,.04,.4+rnd()*.4]:[.2+rnd()*.3,.15+rnd()*.2,.2+rnd()*.3];
DB.push({x:x+(rnd()-.5)*spread,y:y+rnd()*spread*.5,z:z+(rnd()-.5)*spread,vx:vx*.5+(rnd()-.5)*8,vy:rnd()*10+2,vz:vz*.5+(rnd()-.5)*8,rx:rnd()*6,ry:rnd()*6,rz:rnd()*6,wx:(rnd()-.5)*8,wy:(rnd()-.5)*8,wz:(rnd()-.5)*8,sx:sz[0],sy:sz[1],sz:sz[2],c:[c[0]*j,c[1]*j,c[2]*j],st:mode==2?2:0,m:rnd()*.6+.6})}debDirty=true}
function debClear(){DB.length=0;FL.length=0;PITS.length=0;pitsDirty=true;debDirty=true}
function tsJS(x,z){const A=U.uTa.value;if(A<=0)return 0;const L=U.uTl.value,d=x*U.uTdx.value+z*U.uTdz.value-U.uTf.value,ds=d>0?d*2.4:d*.6,e1=Math.exp(-Math.abs(ds)/L),s1=2*e1/(1+e1*e1),t2=(d-2.2*L)/(1.5*L),e2=Math.exp(-Math.abs(t2)),s2=2*e2/(1+e2*e2),dd=Math.max(wl-hgt(cl(x,-49.9,49.9),cl(z,-49.9,49.9)),0),sh=cl(Math.pow(36/Math.max(dd,5),.25),.85,1.7);return A*(s1*s1*sh+(d>0?-.38*s2*s2:0))}
function debStep(dt){const T=WX.tor,Q=WX.tsu;let any=debDirty;
for(let i=0;i<DB.length;i++){const d=DB[i];if(d.st==1)continue;any=true;const gy=hgt(cl(d.x,-49.5,49.5),cl(d.z,-49.5,49.5));
if(d.st==0){let wx=0,wz=0,lift=0;if(T.on||FXU.torS.value>.1){const w=torWind(d.x,d.z),r=Math.hypot(d.x-T.x,d.z-T.z);wx=w[0];wz=w[1];lift=(r<T.r*2.6?16*Math.exp(-Math.pow(r/(T.r*2.1),2)):0)*FXU.torS.value;if(d.y>70)lift=0}
const k=1.5/d.m;d.vx+=(wx-d.vx)*k*dt;d.vz+=(wz-d.vz)*k*dt;d.vy+=(lift-9.8)*dt;d.vy*=1-.25*dt;d.x+=d.vx*dt;d.y+=d.vy*dt;d.z+=d.vz*dt;d.rx+=d.wx*dt;d.ry+=d.wy*dt;d.rz+=d.wz*dt;
if(d.y<gy+.1&&d.vy<0){if(Q.on&&wl+tsJS(d.x,d.z)-gy>.4){d.st=2;d.y=wl+tsJS(d.x,d.z)}else{d.y=gy+Math.min(d.sx,d.sy,d.sz)*.4+.02;d.st=1;d.rx=d.sz<d.sy?Math.PI/2:0;d.rz=(Math.random()-.5)*.25}}}
else{const h=tsJS(d.x,d.z),tw=wl+h,dep=tw-gy;if(dep<.15&&(!Q.on||h<.3)){d.y=gy+Math.min(d.sx,d.sy,d.sz)*.4+.02;d.st=1;d.rx=d.sz<d.sy?Math.PI/2:0;d.rz=(Math.random()-.5)*.25}
else{const f=Q.on?1:.4;d.vx+=(U.uTdx.value*Q.spd*.55*f-d.vx)*.7*dt;d.vz+=(U.uTdz.value*Q.spd*.55*f-d.vz)*.7*dt;if(!Q.on){d.vx*=1-.5*dt;d.vz*=1-.5*dt}d.x+=d.vx*dt;d.z+=d.vz*dt;d.y=tw+Math.sin(WX.clk*2+i)*.12;d.ry+=d.wy*.15*dt;d.rx*=1-dt;d.rz*=1-dt}}}
if(any){let n=0;for(const d of DB){dbo.position.set(d.x,d.y,d.z);dbo.rotation.set(d.rx,d.ry,d.rz);dbo.scale.set(d.sx,d.sy,d.sz);dbo.updateMatrix();debIM.setMatrixAt(n,dbo.matrix);debIM.setColorAt(n,dcol.setRGB(d.c[0],d.c[1],d.c[2]));n++}debIM.count=n;debIM.instanceMatrix.needsUpdate=true;debIM.instanceColor.needsUpdate=true;debDirty=false}}
/* ---------- tornado: Rankine vortex wind field. Objects bend downwind, then fall, or are thrown, depending on wind speed ---------- */
const torVmax=()=>[0,38,52,68,85,105][WX.tor.ef];
function torWind(x,z){const T=WX.tor,dx=x-T.x,dz=z-T.z,r=Math.hypot(dx,dz)+.001,rc=T.r*1.2,vt=torVmax()*(r<rc?r/rc:Math.pow(rc/r,.65)),nx=dx/r,nz=dz/r;return[-nz*vt-nx*vt*.38+T.dx*T.spd*.6,nx*vt-nz*vt*.38+T.dz*T.spd*.6]}
const THR={grass:30,tallgrass:30,flower:30,daisy:30,tulip:30,lavender:30,fern:32,shrub:44,sage:44,ashbush:44,juniper:46,agave:50,barrel:60,prickly:50,krumm:52,birch:50,palm:52,joshua:54,acacia:56,treefern:48,saguaro:62,pine:60,spruce:60,oak:62,deadtree:54,house:58,block:84,mid:96,tower:108},GRND={grass:1,tallgrass:1,flower:1,daisy:1,tulip:1,lavender:1,fern:1},SMALLP={shrub:1,sage:1,ashbush:1,juniper:1,agave:1,barrel:1,prickly:1,krumm:1,treefern:1},BH={house:5,block:12,mid:24,tower:40},BN_={house:60,block:110,mid:150,tower:200};
const FL=[];
function qFall(f){const a0=f.dir[1],a2=-f.dir[0],h=f.rx/2,sn=Math.sin(h),c=Math.cos(h),x1=a0*sn,z1=a2*sn,w1=c,y2=Math.sin(f.yaw/2),w2=Math.cos(f.yaw/2);return[w1*0+x1*w2+0*0-z1*y2,w1*y2+0*w2+0*0+0,w1*0+x1*y2-0+z1*w2,w1*w2-0-0-0]}
function uproot(k,o,wx,wz,fly){const sp=Math.hypot(wx,wz)||1;o.fl=fly?{mode:'fly',x:o.x,y:o.y,z:o.z,ry:o.r,rx:0,rz:0,vx:wx*.45,vy:5+Math.random()*9,vz:wz*.45,ax:(Math.random()-.5)*5,ay:(Math.random()-.5)*3,az:(Math.random()-.5)*5}:{mode:'fall',x:o.x,y:o.y,z:o.z,dir:[wx/sp,wz/sp],yaw:o.r,rx:0};if(!fly)o.fl.q=qFall(o.fl);PITS.push([o.x,o.y,o.z,(FP[k]||2)*.45*o.s]);pitsDirty=true;FL.push([k,o])}
function buildingDebris(k,o,vx,vz,mode){const n=BN_[k]||40,h=BH[k]||5,b=BLD[k]||4;for(const[t,f]of[['wall',.3],['roof',.22],['wood',.22],['brick',.14],['glass',.12]])spawnDeb(o.x,o.y+h*.5,o.z,Math.round(n*f),t,vx,vz,b*1.4,mode)}
function torDamage(h){const T=WX.tor,R2=T.r*5;
for(const k in THR){const K=KIND[k];if(!K)continue;let ch=0;const keep=[];
for(const o of K.list){if(o.fl){keep.push(o);continue}const dx=o.x-T.x,dz=o.z-T.z;if(dx*dx+dz*dz>R2*R2){keep.push(o);continue}const w=torWind(o.x,o.z),v=Math.hypot(w[0],w[1]),th=THR[k];
if(v<th||Math.random()>1-Math.exp(-(.3+1.7*(v-th)/25)*h)){keep.push(o);continue}
ch=1;if(GRND[k])continue;if(BLD[k]){const severity=cl((v-th+8)/70,.12,1),before=o.damage||0;o.damage=cl(before+h*(.18+severity*.82)*1.1,0,1);const loseRoof=k==='house'&&!o.roofGone&&o.damage>=.65;if(loseRoof)o.roofGone=true;if(!o.debrisAt||T.t-o.debrisAt>.35){const pieces=loseRoof?12:Math.max(2,Math.round(2+severity*3));spawnDeb(o.x,o.y+(BH[k]||5)*(loseRoof?.82:.9),o.z,pieces,'roof',w[0]*.12,w[1]*.12,(BLD[k]||4)*.32,0);if(v>th+18&&Math.random()<.3)spawnDeb(o.x,o.y+(BH[k]||5)*.55,o.z,1,'glass',w[0]*.12,w[1]*.12,(BLD[k]||4)*.2,0);o.debrisAt=T.t}keep.push(o);continue}if(SMALLP[k]){spawnDeb(o.x,o.y+.5,o.z,5,'leaf',w[0],w[1],1,0);spawnDeb(o.x,o.y+.5,o.z,1,'wood',w[0],w[1],1,0);continue}
uproot(k,o,w[0],w[1],v>th+20&&Math.hypot(dx,dz)<T.r*2.4);keep.push(o)}
if(ch){K.list=keep;sync(k)}}}
function torStep(dt,e,now){const T=WX.tor;FXU.torS.value=e(FXU.torS.value,T.on?1:0,2);
if(T.on){T.t+=dt;T.x+=T.dx*T.spd*dt+Math.sin(T.t*.7)*.18*dt*T.spd;T.z+=T.dz*T.spd*dt+Math.cos(T.t*.6)*.18*dt*T.spd;if(Math.hypot(T.x,T.z)>95&&T.t>6)T.on=false}
const show=T.on||FXU.torS.value>.03;torGrp.visible=show;
if(show){const gy=hgt(cl(T.x,-S/2,S/2),cl(T.z,-S/2,S/2)),py=Math.max(gy,wl),hh=60+T.r*3,k=FXU.torS.value;tU.uPos.value.set(T.x,py,T.z);tU.uSz.value.set(T.r,hh);tU.uK.value=k;tU.uT.value+=dt;dU.uPos.value.copy(tU.uPos.value);dU.uSz.value.copy(tU.uSz.value);dU.uK.value=k;dU.uT.value+=dt;cU.uPos.value.set(T.x,py+hh*.98,T.z);cU.uK.value=k;cU.uT.value+=dt;
FXU.tor.value.set(T.x,T.z,T.r*1.2);FXU.torV.value=torVmax();FXU.torD.value.set(T.dx*T.spd,T.dz*T.spd)}
if(T.on&&T.dmg&&now-lastDmg>100){const h=(now-lastDmg)/1000;lastDmg=now;torDamage(Math.min(h,.3))}}
function flStep(dt){if(!FL.length)return;const kinds=new Set(),T=WX.tor;
for(let i=FL.length-1;i>=0;i--){const[k,o]=FL[i],f=o.fl;if(!f||f.mode=='down'){FL.splice(i,1);continue}kinds.add(k);
if(f.mode=='fall'){f.rx+=dt*(.25+f.rx*2.1);if(f.rx>=1.5){f.rx=1.5;f.mode='down'}f.q=qFall(f)}
else{let wx=0,wz=0,lift=0;if(T.on){const w=torWind(f.x,f.z),r=Math.hypot(f.x-T.x,f.z-T.z);wx=w[0];wz=w[1];lift=(r<T.r*2.6?17*Math.exp(-Math.pow(r/(T.r*2.2),2)):0)*FXU.torS.value}
f.vx+=(wx-f.vx)*.9*dt;f.vz+=(wz-f.vz)*.9*dt;f.vy+=(lift-9.8)*dt;f.vy*=1-.15*dt;f.x+=f.vx*dt;f.y+=f.vy*dt;f.z+=f.vz*dt;f.rx+=f.ax*dt;f.ry+=f.ay*dt;f.rz+=f.az*dt;
const gy=hgt(cl(f.x,-49.5,49.5),cl(f.z,-49.5,49.5));if(f.y<gy+.3&&f.vy<0){f.y=gy;f.mode='down';f.rx=1.25+Math.random()*.3;f.rz=(Math.random()-.5)*.6;spawnDeb(f.x,gy+1,f.z,6,'leaf',0,0,3)}}
o.x=f.x;o.z=f.z;o.y=f.y}
kinds.forEach(k=>sync(k))}
/* ---------- tsunami: draw-down, steep breaking front, shoaling, inundation damage, floating debris ---------- */
const TSU_LIM={house:2.5,block:5,mid:7,tower:10,oak:2.4,pine:2.4,spruce:2.4,birch:2.2,palm:3,acacia:2.6,joshua:2.4,deadtree:2.2,saguaro:2.6,treefern:2,shrub:1.4,sage:1.3,ashbush:1.3,juniper:1.4,agave:1.2,krumm:1.6,barrel:1.2,prickly:1.2,grass:.8,tallgrass:.9,flower:.8,daisy:.8,tulip:.8,lavender:.8,fern:.8};
function tsuDamage(){const Q=WX.tsu,vx=U.uTdx.value*Q.spd*.4,vz=U.uTdz.value*Q.spd*.4;
for(const k in KIND){if(RK[k])continue;const K=KIND[k],keep=[];let ch=0;
for(const o of K.list){const h=tsJS(o.x,o.z),lim=TSU_LIM[k]===undefined?1.2:TSU_LIM[k];if(h>.5&&wl+h-o.y>lim){ch=1;if(BLD[k])buildingDebris(k,o,vx,vz,2);else if(!GRND[k]){spawnDeb(o.x,o.y+1,o.z,2,'wood',vx,vz,2,2);spawnDeb(o.x,o.y+1.5,o.z,4,'leaf',vx,vz,3,2)}}else keep.push(o)}
if(ch){K.list=keep;sync(k)}}}
function tsuStep(dt,now){const Q=WX.tsu;if(!Q.on)return;Q.f+=Q.spd*dt;U.uTf.value=Q.f;FXU.wet.value=Math.max(FXU.wet.value,.85);if(Q.dmg&&now-lastDmg2>250){lastDmg2=now;tsuDamage()}if(Q.f>215){Q.on=false;U.uTa.value=0;U.uTf.value=-1e4}}
/* ---------- real directional shadows only; retain the foliage light-map refresh ---------- */
const blobO=new THREE.Object3D();
function rebuildTreeMap(){drawTreeMap()}
const PITS=[];let pitsDirty=false;
const pitTex=(()=>{const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d'),g=x.createRadialGradient(32,32,2,32,32,32);g.addColorStop(0,'rgba(48,30,18,.95)');g.addColorStop(.6,'rgba(62,40,24,.8)');g.addColorStop(1,'rgba(62,40,24,0)');x.fillStyle=g;x.fillRect(0,0,64,64);return new THREE.CanvasTexture(c)})();
const pitIM=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({map:pitTex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3}),400);pitIM.count=0;pitIM.frustumCulled=false;pitIM.renderOrder=3;scene.add(pitIM);
function rebuildPits(){let n=0;for(const p of PITS){if(n>=400)break;blobO.position.set(p[0],p[1]+.1,p[2]);blobO.scale.set(p[3]*2,1,p[3]*2);blobO.updateMatrix();pitIM.setMatrixAt(n++,blobO.matrix)}pitIM.count=n;pitIM.instanceMatrix.needsUpdate=true}
const tmC=document.createElement('canvas');tmC.width=tmC.height=256;const tmX=tmC.getContext('2d'),tmS=document.createElement('canvas');tmS.width=tmS.height=64;
{const x=tmS.getContext('2d'),g=x.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(.6,'rgba(255,255,255,.55)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64)}
const tmTex=new THREE.CanvasTexture(tmC);tmTex.flipY=false;FXU.treeMap.value=tmTex;
function drawTreeMap(){tmX.globalCompositeOperation='source-over';tmX.fillStyle='#000';tmX.fillRect(0,0,256,256);tmX.globalCompositeOperation='lighter';
for(const k of['oak','birch','shrub','acacia']){const K=KIND[k];if(!K)continue;const cr=(k=='oak'||k=='acacia'?5:k=='birch'?3.2:1.6)*K.size;K.list.forEach(o=>{if(o.fl)return;const r=cr*o.s*2.56,px=(o.x+50)*2.56,pz=(o.z+50)*2.56;tmX.drawImage(tmS,px-r,pz-r,r*2,r*2)})}
tmX.globalCompositeOperation='source-over';tmTex.needsUpdate=true}


/* ---------- procedural seabed: the sea floor continues far past the island, with shoals and sandbars ---------- */
const SB={depth:0,bars:1.3,rough:1,seed:0},SBA=new Float32Array(257*257),SBT=new THREE.DataTexture(SBA,257,257,THREE.RedFormat,THREE.FloatType);SBT.minFilter=SBT.magFilter=THREE.NearestFilter;U.hm2.value=SBT;
const OW_HM_SMALL_DATA=new Float32Array(129*129),OW_HM_LARGE_COARSE=new Float32Array(129*129),OW_HM_LARGE_DATA=new Float32Array(257*257),OW_HM_SMALL_TEX=new THREE.DataTexture(OW_HM_SMALL_DATA,129,129,THREE.RedFormat,THREE.FloatType),OW_HM_LARGE_TEX=new THREE.DataTexture(OW_HM_LARGE_DATA,257,257,THREE.RedFormat,THREE.FloatType);OW_HM_SMALL_TEX.minFilter=OW_HM_SMALL_TEX.magFilter=THREE.NearestFilter;OW_HM_LARGE_TEX.minFilter=OW_HM_LARGE_TEX.magFilter=THREE.NearestFilter;
function updateOpenWorldWaterHeightMaps(){if(!OW?.active)return;const ox=water.position.x,oz=water.position.z;U.hm.value=OW_HM_SMALL_TEX;U.hm2.value=OW_HM_LARGE_TEX;U.uTerrainOrigin.value.set(ox,oz);for(let j=0;j<=128;j++)for(let i=0;i<=128;i++){const k=j*129+i;OW_HM_SMALL_DATA[k]=OW.heightAt(ox-50+i*100/128,oz-50+j*100/128);OW_HM_LARGE_COARSE[k]=OW.heightAt(ox-420+i*840/128,oz-420+j*840/128)}for(let j=0;j<=256;j++)for(let i=0;i<=256;i++){const u=i*.5,v=j*.5,x=Math.min(127,u|0),z=Math.min(127,v|0),a=u-x,b=v-z,k=z*129+x;OW_HM_LARGE_DATA[j*257+i]=OW_HM_LARGE_COARSE[k]*(1-a)*(1-b)+OW_HM_LARGE_COARSE[k+1]*a*(1-b)+OW_HM_LARGE_COARSE[k+129]*(1-a)*b+OW_HM_LARGE_COARSE[k+130]*a*b}OW_HM_SMALL_TEX.needsUpdate=OW_HM_LARGE_TEX.needsUpdate=true}
OW.updateWaterMaps=updateOpenWorldWaterHeightMaps;
const fbmJ=(x,z)=>{let n=0,a=.5;for(let o=0;o<4;o++){n+=vn(x,z)*a;x=x*2.07+17.1;z=z*2.07+9.2;a/=2}return n/.9375},smJ=(a,b,x)=>{const q=cl((x-a)/(b-a),0,1);return q*q*(3-2*q)};
function seaH(x,z){if(GENC)return landH(x,z);const r=Math.hypot(x,z),d=Math.max(r-46,0),k=smJ(0,60,d),n=SB.rough*(fbmJ(x*.012+SB.seed,z*.012)-.5)*16*smJ(0,70,d)+(fbmJ(x*.07,z*.07+SB.seed)-.5)*2.4*smJ(0,40,d),bars=SB.bars*10*smJ(.5,.88,fbmJ(x*.02+SB.seed*1.7,z*.02-SB.seed))*smJ(8,60,d)*(1-smJ(230,430,d));
return Math.min(-14-SB.depth*k-6*(1-Math.exp(-d/120))-40*smJ(120,1000,d)+n+bars,-1.8)}
const SBK=140,SBM_=160,SBP=new Float32Array((SBK+1)*(SBM_+1)*3),SBN=new Float32Array(SBP.length),SBC=new Float32Array(SBP.length);
const SBM=(()=>{const g=new THREE.BufferGeometry(),I=new Uint32Array(SBK*SBM_*6);for(let k=0;k<SBK;k++)for(let m=0;m<SBM_;m++){const a=k*(SBM_+1)+m,b=a+1,c=a+SBM_+1,d=c+1;I.set([a,b,c,b,d,c],(k*SBM_+m)*6)}
g.setAttribute('position',new THREE.BufferAttribute(SBP,3));g.setAttribute('normal',new THREE.BufferAttribute(SBN,3));g.setAttribute('color',new THREE.BufferAttribute(SBC,3));g.setIndex(new THREE.BufferAttribute(I,1));
const mt=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.95,metalness:0});injectDetail(mt,false);const m=new THREE.Mesh(g,mt);m.frustumCulled=false;scene.add(m);return m})();
function buildSeabed(){for(let k=0;k<=SBK;k++){const R0=GENC?50:46,R1=GENC?2400:1500,r=R0*Math.pow(R1/R0,k/SBK);for(let m=0;m<=SBM_;m++){const th=m/SBM_*6.2832;let x=r*Math.cos(th),z=r*Math.sin(th);if(GENC){const q=1/Math.max(Math.abs(Math.cos(th)),Math.abs(Math.sin(th)));x*=q;z*=q}let h=seaH(x,z);if(!GENC&&r<58)h=Math.min(h,-14.25);const i=(k*(SBM_+1)+m)*3;SBP[i]=x;SBP[i+1]=h;SBP[i+2]=z;
const e=.8+r*.01,hx=seaH(x+e,z)-seaH(x-e,z),hz=seaH(x,z+e)-seaH(x,z-e),nl=Math.hypot(hx,2*e,hz),t=smJ(-3,-45,h),v=.9+.2*vn(x*.3,z*.3);SBN[i]=-hx/nl;SBN[i+1]=2*e/nl;SBN[i+2]=-hz/nl;if(GENC){const sl=Math.hypot(hx,hz)/(2*e);let c=mx3(PAL[0],PAL[1],sm(9,13,h));c=mx3(c,PAL[2],sm(rockT-.35,rockT+.35,sl));c=mx3(c,PAL[4],sm(snowL,snowL+3,h)*(1-sm(rockT-.2,rockT+.6,sl)*.5));SBC[i]=c[0]*v;SBC[i+1]=c[1]*v;SBC[i+2]=c[2]*v}else{SBC[i]=(.78+(.2-.78)*t)*v;SBC[i+1]=(.7+(.28-.7)*t)*v;SBC[i+2]=(.52+(.36-.52)*t)*v}}}
const a=SBM.geometry.attributes;a.position.needsUpdate=a.normal.needsUpdate=a.color.needsUpdate=true;
for(let j=0;j<257;j++)for(let i=0;i<257;i++)SBA[j*257+i]=seaH(i/256*840-420,j/256*840-420);SBT.needsUpdate=true}
let sbTimer=0;function sbSoon(){clearTimeout(sbTimer);sbTimer=setTimeout(buildSeabed,160)}
buildSeabed();
function damage(pred){let ch=0;for(const k in KIND){if(RK[k])continue;const K=KIND[k],n=K.list.length;K.list=K.list.filter(o=>!pred(o,k));if(K.list.length!=n){sync(k);ch++}}return ch}
function buildFall(){const g=fallMesh.geometry,P=g.attributes.position.array,G=g.attributes.aG.array,Rn=g.attributes.aRnd.array,src=[];
for(const k of['oak','birch','shrub','acacia']){const K=KIND[k];if(!K)continue;const hy=k=='oak'?7:k=='birch'?7.5:k=='acacia'?5:.9,rd=k=='oak'?3.5:k=='birch'?2:k=='acacia'?4:.8;K.list.forEach(o=>src.push([o.x,o.y+hy*o.s*K.size,o.z,o.y,rd*o.s*K.size]))}
for(let i=0;i<NF;i++){const s=src.length?src[(R()*src.length)|0]:[0,-200,0,-200,1],a=R()*6.283,r=Math.sqrt(R())*s[4];P[i*3]=s[0]+Math.cos(a)*r;P[i*3+1]=s[1]-R()*2.5;P[i*3+2]=s[2]+Math.sin(a)*r;G[i]=s[3];Rn[i]=R()}
g.attributes.position.needsUpdate=g.attributes.aG.needsUpdate=g.attributes.aRnd.needsUpdate=true}
function newBolt(){const P=bolt.geometry.attributes.position.array,cx=oc.target.x+(R()-.5)*90,cz=oc.target.z+(R()-.5)*90,n=P.length/3,gy=hgt(cl(cx,-50,50),cl(cz,-50,50));let x=cx,z=cz;for(let i=0;i<n;i++){const t=i/(n-1);P[i*3]=x;P[i*3+1]=95*(1-t)+gy*t;P[i*3+2]=z;x+=(R()-.5)*7;z+=(R()-.5)*7}bolt.geometry.attributes.position.needsUpdate=true}
function torSpawn(){const a=R()*6.283,T=WX.tor,x0=Math.cos(a)*72,z0=Math.sin(a)*72,tx=(R()-.5)*30,tz=(R()-.5)*30,l=Math.hypot(tx-x0,tz-z0)||1;T.x=x0;T.z=z0;T.dx=(tx-x0)/l;T.dz=(tz-z0)/l;T.on=true;T.t=0;torGrp.visible=true}
function torStop(){WX.tor.on=false}
function tsuLaunch(){const T=WX.tsu,a=T.dir*Math.PI/180;T.on=true;T.f=-175;U.uTa.value=T.amp;U.uTl.value=Math.max(12,T.amp*1.7);U.uTdx.value=Math.cos(a);U.uTdz.value=Math.sin(a);U.uTf.value=T.f}
function tsuReset(){WX.tsu.on=false;U.uTa.value=0;U.uTf.value=-1e4}
function wxPreset(p){WX.preset=p;const P={clear:[0,0,0,0],fog:[0,.88,0,0],drizzle:[.35,.55,0,0],rain:[.75,.85,0,0],storm:[1,1,1,0],blizzard:[0,.9,.5,1]}[p];WX.rainT=P[0];WX.overT=P[1];WX.stormT=P[2];WX.snowfallT=P[3];if(P[3]){WX.snowAuto=false;WX.coverT=Math.max(WX.coverT,.9)}}
function wxStep(dt,realDt=dt){const e=(c,t,k)=>c+(t-c)*Math.min(1,dt*k),sm=(a,b,x)=>{const q=cl((x-a)/(b-a),0,1);return q*q*(3-2*q)},now=(WX.clk=(WX.clk||0)+dt)*1000;
if(SKY.cycle.on){tod=(tod+realDt*24/Math.max(3600,SKY.cycle.length)*SKY.cycle.speed)%24;if(now-SKY.cycle.lastUpdate>80){SKY.cycle.lastUpdate=now;updSky()}}
if(WX.seasonAuto){const adv=dt/WX.cycle,t1=WX.seasonT,SH=WX.sh,cs=SH?Math.min(SH.e,SH.s0+SH.r*Math.max(0,WX.clk-SH.t0)):0;if(WX.waitLeaves&&t1<.75&&t1+adv>=.75&&cs<.97)WX.seasonT=.7499;else WX.seasonT=(t1+adv)%1;if(WX.seasonAuto)WX.snowAuto=true}
const t=WX.seasonT;let shed=0,aut=0,bloom=0;
if(t<.25){shed=0;aut=.85*(1-sm(0,.04,t));bloom=sm(.04,.16,t)*(1-sm(.2,.28,t))}else if(t<.5){}else if(t<.75){aut=sm(.5,.62,t);shed=sm(.6,.75,t)}else{aut=.85;shed=1}
if(WX.snowAuto){const snow=seasonalSnowState(t);WX.coverT=snow.cover;WX.snowfallT=snow.fall}
const stp=(c,tg,r)=>tg>c?Math.min(tg,c+r*dt):tg;{const R_=Math.min(.008,WX.leafRate*120/(Math.max(20,WX.cycle)*1400)),clk=WX.clk;let SH=WX.sh;if(!SH)SH=WX.sh={s0:0,t0:clk,e:0,r:R_};const curS=Math.min(SH.e,SH.s0+SH.r*Math.max(0,clk-SH.t0));if(WX.instant){SH.s0=curS;SH.e=Math.max(shed,curS);SH.t0=clk;SH.r=R_;WX.instant=false}else if(shed<SH.e-1e-4){SH.s0=SH.e=shed;SH.t0=clk;SH.r=R_}else if(shed>SH.e+1e-4||Math.abs(SH.r-R_)>1e-6){SH.s0=curS;SH.t0=clk;SH.e=Math.max(shed,curS);SH.r=R_}
FXU.s0.value=SH.s0;FXU.t0.value=SH.t0;FXU.sr.value=SH.r;FXU.se.value=SH.e;FXU.clk.value=clk;FXU.shed.value=Math.min(SH.e,SH.s0+SH.r*Math.max(0,clk-SH.t0));FXU.shedF.value=Math.min(1,FXU.shed.value*1.7)}FXU.aut.value=stp(FXU.aut.value,aut,.05);FXU.bloom.value=bloom;FXU.grow.value=stp(FXU.grow.value,t<.25?sm(0,.12,t):t<.75?1:0,.12);{const litT=t<.25?1-sm(0,.12,t):t<.6?0:t<.75?sm(.6,.75,t):1;FXU.lit.value=e(FXU.lit.value,litT,litT>FXU.lit.value?.08:.06)}
WX.rain=e(WX.rain,Math.max(WX.rainT,WX.tor.on?.55:0),1.2);WX.snowfall=e(WX.snowfall,WX.snowfallT,1.5);WX.storm=e(WX.storm,WX.stormT,.8);WX.over=e(WX.over,Math.max(WX.overT,WX.rainT*.9,WX.snowfallT*.75,WX.stormT,WX.tor.on?.92:0),.6);
{const d=WX.coverT-WX.cover,up=(.1+.3*WX.snowfall)*dt,dn=WX.melt/(WX.cycle*.1)*dt;WX.cover+=d>0?Math.min(d,up):-Math.min(-d,dn)}
const melting=WX.cover>WX.coverT+.02?.7:0;FXU.wet.value=e(FXU.wet.value,Math.max(WX.rain,melting),WX.rain>FXU.wet.value?.8:.08);FXU.snowK.value=WX.cover;
U.rain.value=WX.rain;U.ov.value=WX.over;WW.value=windUser*(1+WX.storm*1.2+(WX.tor.on?.8:0));U.uWindSpeed.value=exClamp(waterWindSpeed*windUser*(1+WX.storm*.5+(WX.tor.on?.5:0)),0,40);U.amp.value=ampUser*(1+WX.storm*1.1+WX.rain*.25);
if(WX.storm>.5&&now>WX.nextFlash){WX.fT=0;WX.nextFlash=now+3500+R()*7500;newBolt()}
WX.fT+=dt;WX.flash=WX.fT<.5?(1-WX.fT/.5)*(.6+.4*Math.sin(WX.fT*70))*WX.storm:0;U.flash.value=WX.flash;bolt.visible=WX.fT<.16;
const skk=WX.over*1000+WX.rain*700;if(Math.abs(skk-lastSkyK)>.5&&now-lastSky>140){lastSky=now;lastSkyK=skk;updSky()}
hemi.intensity=hemiBase+WX.flash*2.2;
rU.uT.value+=dt;rU.uInt.value=WX.rain;rainMesh.visible=WX.rain>.02;rU.uCenter.value.copy(oc.target);rU.uWind.value.set(.8*WW.value*.28,.6*WW.value*.28);
sU.uT.value+=dt;sU.uInt.value=WX.snowfall;snowMesh.visible=WX.snowfall>.02;sU.uCenter.value.copy(oc.target);sU.uWind.value.set(.8*WW.value*.3,.6*WW.value*.3);
fallMesh.visible=false;
torStep(dt,e,now);tsuStep(dt,now);debStep(dt);flStep(dt);FXU.sunI.value=cl(sun.intensity/2.2,0,1);if(PLANON)planetStep(dt);if(treeMapDirty&&now-treeMapT>300){treeMapDirty=false;treeMapT=now;rebuildTreeMap()}if(pitsDirty){pitsDirty=false;rebuildPits()}}