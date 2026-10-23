try{
/* ===== realistic procedural models: canvas textures, leaf cards, facades ===== */
const TEXA=Math.min(4,ren.capabilities.getMaxAnisotropy()||1);
const cv2=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return[c,c.getContext('2d')]};
const mkTex=(c,color=true)=>{const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;if('colorSpace'in t&&THREE.SRGBColorSpace!==undefined)t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;else if('encoding'in t)t.encoding=color?THREE.sRGBEncoding:THREE.LinearEncoding;t.anisotropy=TEXA;return t};
const hsl=(h,s,l)=>`hsl(${h},${s}%,${l}%)`;
function leafTex(){const[c,x]=cv2(256,256);x.strokeStyle='#3a2e1c';x.lineWidth=3;x.beginPath();x.moveTo(128,256);x.quadraticCurveTo(116,150,134,24);x.stroke();
for(let i=0;i<30;i++){const t=i/30,sd=i%2?1:-1,bx=128-10*(1-t)+4*t,by=248-t*220,ang=-1.57+sd*(.55+R()*.5),len=46+R()*30-t*14,w=11+R()*8;
x.save();x.translate(bx,by);x.rotate(ang);x.beginPath();x.moveTo(0,0);x.bezierCurveTo(len*.25,-w,len*.7,-w*.8,len,0);x.bezierCurveTo(len*.7,w*.8,len*.25,w,0,0);
const g=x.createLinearGradient(0,0,len,0);g.addColorStop(0,hsl(100+R()*20,45,25+R()*9));g.addColorStop(1,hsl(88+R()*30,50,35+R()*15));x.fillStyle=g;x.fill();
x.strokeStyle='rgba(190,215,120,.45)';x.lineWidth=1;x.beginPath();x.moveTo(0,0);x.lineTo(len*.95,0);for(let v=1;v<5;v++){x.moveTo(len*v/5,0);x.lineTo(len*v/5+len*.12,-w*.6);x.moveTo(len*v/5,0);x.lineTo(len*v/5+len*.12,w*.6)}x.stroke();x.restore()}
return mkTex(c)}
function leafTexSpecies(kind){const[c,x]=cv2(256,256),cfg={oak:{n:9,len:38,w:14,hue:92,sat:48,light:33},birch:{n:18,len:28,w:10,hue:102,sat:42,light:40},shrub:{n:22,len:22,w:12,hue:112,sat:43,light:32},sage:{n:16,len:26,w:9,hue:104,sat:27,light:44},ash:{n:14,len:32,w:8,hue:96,sat:46,light:35}}[kind]||{n:16,len:27,w:10,hue:100,sat:45,light:28};const draw=(px,py,ang,len,w)=>{x.save();x.translate(px,py);x.rotate(ang);x.beginPath();if(kind==='oak'){x.moveTo(0,0);for(let j=1;j<=5;j++){const q=j/6,yy=-w*Math.sin(q*3.1416);x.quadraticCurveTo(len*(q-.07),yy*1.55,len*q,yy*.58)}x.lineTo(len,0);for(let j=5;j>=1;j--){const q=j/6,yy=w*Math.sin(q*3.1416);x.quadraticCurveTo(len*(q+.07),yy*1.55,len*q,yy*.58)}x.closePath()}else{x.moveTo(0,0);x.quadraticCurveTo(len*.22,-w*1.25,len*.78,-w*.5);x.quadraticCurveTo(len,0,len*.78,w*.5);x.quadraticCurveTo(len*.22,w*1.25,0,0);x.closePath()}const g=x.createLinearGradient(0,-w,len,w);g.addColorStop(0,hsl(cfg.hue+R()*12,cfg.sat,cfg.light-7+R()*5));g.addColorStop(1,hsl(cfg.hue-5+R()*14,cfg.sat+5,cfg.light+8+R()*9));x.fillStyle=g;x.fill();x.strokeStyle='rgba(205,220,155,.42)';x.lineWidth=.65;x.beginPath();x.moveTo(1,0);x.lineTo(len*.94,0);for(let v=1;v<4;v++){const q=v/4;x.moveTo(len*q,0);x.lineTo(len*q+len*.1,-w*.55);x.moveTo(len*q,0);x.lineTo(len*q+len*.1,w*.55)}x.stroke();x.restore()};x.strokeStyle=kind==='birch'?'rgba(92,74,45,.9)':'rgba(70,53,32,.85)';x.lineWidth=2.1;x.beginPath();x.moveTo(128,254);x.quadraticCurveTo(111,132,132,10);x.stroke();if(kind==='acacia'){for(let j=0;j<7;j++){const yy=225-j*31,sg=j%2?1:-1;x.strokeStyle='rgba(80,78,49,.8)';x.lineWidth=1;x.beginPath();x.moveTo(128,yy);x.lineTo(128+sg*46,yy-18);x.stroke();for(let k=0;k<6;k++){const q=(k+.4)/6,px=128+sg*46*q,py=yy-18*q;draw(px,py,sg*(.1+R()*.25),13+R()*8,4+R()*2)}}}else{for(let i=0;i<cfg.n;i++){const t=(i+.45)/cfg.n,sg=i%2?1:-1,px=128+(t-.5)*17,py=245-t*224,len=cfg.len*(.72+R()*.58),w=cfg.w*(.72+R()*.52);draw(px,py,-1.57+sg*(.48+R()*.42),len,w)}}return mkTex(c)}
function needleTex(){const[c,x]=cv2(128,256);x.strokeStyle='#4a3a26';x.lineWidth=3;x.beginPath();x.moveTo(64,256);x.lineTo(64,10);x.stroke();
for(let i=0;i<260;i++){const t=R(),y=250-t*236,s=i%2?1:-1,len=(46-t*20)*(.6+R()*.4),a=s*(.5+R()*.55);x.strokeStyle=hsl(110+R()*16,38+R()*14,20+R()*16);x.lineWidth=1.3+R()*.6;x.beginPath();x.moveTo(64,y);x.lineTo(64+Math.sin(a)*len,y-Math.cos(a)*len*.7);x.stroke()}return mkTex(c)}
function grassTex(){const[c,x]=cv2(256,512);x.scale(2,2);for(let i=0;i<84;i++){const bx=4+R()*120,w=1.2+R()*2.1,tip=20+R()*116,bend=(R()-.5)*72,g=x.createLinearGradient(0,256,0,tip);g.addColorStop(0,hsl(76+R()*26,42+R()*12,8+R()*8));g.addColorStop(.56,hsl(82+R()*26,48+R()*12,20+R()*14));g.addColorStop(1,hsl(68+R()*38,45+R()*20,34+R()*24));x.fillStyle=g;x.beginPath();x.moveTo(bx-w,256);x.quadraticCurveTo(bx+bend*.3-w*.5,150,bx+bend,tip);x.quadraticCurveTo(bx+bend*.3+w*.5,150,bx+w,256);x.fill()}return mkTex(c)}
function barkTex(k){const[c,x]=cv2(256,512),b={oak:'rgb(86,65,48)',pine:'rgb(96,70,54)',birch:'rgb(224,221,212)',palm:'rgb(132,112,86)',char:'rgb(30,26,24)'}[k];x.fillStyle=b;x.fillRect(0,0,256,512);
if(k=='palm'){let y=0;while(y<512){const hg=14+R()*14,g=x.createLinearGradient(0,y,0,y+hg);g.addColorStop(0,'rgba(30,22,12,.5)');g.addColorStop(.18,'rgba(30,22,12,.18)');g.addColorStop(1,'rgba(30,22,12,0)');x.fillStyle=g;x.fillRect(0,y,256,hg);for(let q=0;q<6;q++){x.fillStyle='rgba(20,14,8,.35)';x.fillRect(R()*256,y+R()*3,10+R()*30,1+R()*2)}y+=hg}for(let i=0;i<700;i++){x.strokeStyle=`rgba(${R()<.5?'40,28,16':'170,150,120'},${.06+R()*.12})`;x.lineWidth=1+R()*1.5;const px=R()*256;x.beginPath();x.moveTo(px,R()*512);x.lineTo(px+(R()-.5)*4,R()*512);x.stroke()}}
else if(k=='birch'){for(let i=0;i<140;i++){x.fillStyle=`rgba(18,16,14,${.45+R()*.45})`;x.fillRect(R()*256,R()*512,12+R()*56,3+R()*5)}for(let i=0;i<120;i++){x.fillStyle=`rgba(150,145,135,${.15+R()*.2})`;x.fillRect(R()*256,R()*512,20+R()*40,12+R()*28)}}
else if(k=='char'){for(let i=0;i<260;i++){const px=R()*256;x.strokeStyle=R()<.5?`rgba(8,6,5,${.4+R()*.4})`:`rgba(110,100,92,${.12+R()*.2})`;x.lineWidth=1+R()*4;x.beginPath();x.moveTo(px,0);for(let y=48;y<=512;y+=48)x.lineTo(px+(R()-.5)*16,y);x.stroke()}for(let i=0;i<40;i++){x.fillStyle=`rgba(150,50,18,${.12+R()*.25})`;x.fillRect(R()*256,R()*512,2+R()*10,1+R()*4)}for(let i=0;i<70;i++){x.fillStyle=`rgba(120,116,110,${.1+R()*.16})`;x.fillRect(R()*256,R()*512,14+R()*40,8+R()*22)}}
else{for(let i=0;i<118;i++){const px=R()*256,x0=px+(R()-.5)*5;x.strokeStyle=R()<.55?`rgba(14,9,7,${.24+R()*.42})`:`rgba(125,100,78,${.14+R()*.28})`;x.lineWidth=1.2+R()*3.8;x.beginPath();x.moveTo(x0,0);for(let y=24+R()*18;y<=512;y+=28+R()*38)x.lineTo(x0+(R()-.5)*16,y);x.stroke()}}
if(k==='oak'||k==='pine'||k==='char'){for(let i=0;i<20;i++){const px=18+R()*220,py=28+R()*456,rx=2+R()*5,ry=7+R()*15,rot=(R()-.5)*.22;for(let j=0;j<3;j++){x.strokeStyle=j===0?'rgba(20,13,9,.42)':j===1?'rgba(160,125,96,.24)':'rgba(30,20,15,.2)';x.lineWidth=.8+R()*1.2;x.beginPath();x.ellipse(px,py,rx*(1+j*.38),ry*(1+j*.3),rot,0,6.2832);x.stroke()}}}
for(let i=0;i<3000;i++){const g=R()<.5?0:255;x.fillStyle=`rgba(${g},${g},${g},${R()*.1})`;x.fillRect(R()*256,R()*512,1+R()*3,1+R()*4)}return mkTex(c)}
function normFrom(c,str){const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data,H=new Float32Array(w*h);for(let i=0;i<w*h;i++)H[i]=(d[i*4]*.3+d[i*4+1]*.59+d[i*4+2]*.11)/255;
const[n,y]=cv2(w,h),o=y.createImageData(w,h),G=(a,b)=>H[((b+h)%h)*w+((a+w)%w)];
for(let j=0;j<h;j++)for(let i=0;i<w;i++){const dx=(G(i+1,j)-G(i-1,j))*str,dy=(G(i,j+1)-G(i,j-1))*str,l=Math.hypot(dx,dy,1),k=(j*w+i)*4;o.data[k]=(-dx/l*.5+.5)*255;o.data[k+1]=(dy/l*.5+.5)*255;o.data[k+2]=(1/l*.5+.5)*255;o.data[k+3]=255}
y.putImageData(o,0,0);return mkTex(n,false)}
function roughTex(c,base=.84){const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data,[n,y]=cv2(w,h),o=y.createImageData(w,h);for(let i=0;i<w*h;i++){const k=i*4,l=(d[k]*.3+d[k+1]*.59+d[k+2]*.11)/255,v=Math.round(cl(base+(.5-l)*.1+(R()-.5)*.045,.62,.98)*255);o.data[k]=o.data[k+1]=o.data[k+2]=v;o.data[k+3]=255}y.putImageData(o,0,0);return mkTex(n,false)}
function cactusTex(){const[c,x]=cv2(256,512),g=x.createLinearGradient(0,0,0,512);g.addColorStop(0,'rgb(86,128,72)');g.addColorStop(1,'rgb(64,104,58)');x.fillStyle=g;x.fillRect(0,0,256,512);
for(let i=0;i<12;i++){const px=i*256/12,gr=x.createLinearGradient(px-10,0,px+10,0);gr.addColorStop(0,'rgba(20,50,25,0)');gr.addColorStop(.5,'rgba(18,44,22,.55)');gr.addColorStop(1,'rgba(20,50,25,0)');x.fillStyle=gr;x.fillRect(px-10,0,20,512);
for(let y=6;y<512;y+=15+R()*8){x.fillStyle='rgba(236,226,170,.85)';x.beginPath();x.arc(px+(R()-.5)*3,y,1.3+R()*.8,0,6.283);x.fill();x.strokeStyle='rgba(220,208,150,.5)';x.lineWidth=.8;for(let k=0;k<4;k++){const a=R()*6.283;x.beginPath();x.moveTo(px,y);x.lineTo(px+Math.cos(a)*6,y+Math.sin(a)*6);x.stroke()}}}
for(let i=0;i<2200;i++){x.fillStyle=`rgba(${R()<.5?'30,70,34':'150,180,110'},${R()*.07})`;x.fillRect(R()*256,R()*512,1+R()*3,1+R()*3)}return mkTex(c)}
function petalTex(){const[c,x]=cv2(256,256);x.beginPath();x.moveTo(128,252);x.bezierCurveTo(92,210,58,108,128,12);x.bezierCurveTo(198,108,164,210,128,252);x.closePath();const g=x.createLinearGradient(0,252,0,12);g.addColorStop(0,'#fff1d4');g.addColorStop(.22,'#fffaf0');g.addColorStop(.7,'#ffffff');g.addColorStop(1,'#f8f5f0');x.fillStyle=g;x.fill();x.strokeStyle='rgba(230,195,160,.5)';x.lineWidth=1.1;x.stroke();x.strokeStyle='rgba(220,190,155,.28)';x.lineWidth=.8;for(let i=1;i<=7;i++){const q=i/8;x.beginPath();x.moveTo(128,240);x.quadraticCurveTo(128+(i%2?1:-1)*q*28,130,128+(i%2?1:-1)*q*33,34+q*26);x.stroke()}for(let i=0;i<120;i++){x.fillStyle=`rgba(175,145,115,${R()*.055})`;x.fillRect(66+R()*124,34+R()*192,1+R()*1.3,1+R()*1.3)}return mkTex(c)}
function frondTex(){const[c,x]=cv2(64,256);x.strokeStyle='#5a7a2e';x.lineWidth=3;x.beginPath();x.moveTo(32,256);x.lineTo(32,4);x.stroke();for(let i=0;i<46;i++){const t=i/46,y=250-i*5.3,len=6+30*Math.sin(Math.min(1,t*1.05+.05)*3.0),s=hsl(92+R()*14,48,26+t*18);x.strokeStyle=s;x.lineWidth=2.4;x.beginPath();x.moveTo(32,y);x.lineTo(32-len,y-len*.7);x.moveTo(32,y);x.lineTo(32+len,y-len*.7);x.stroke()}return mkTex(c)}
function roofTex(hu=10,sa=45,li=26){const[c,x]=cv2(128,128);x.fillStyle=hsl(hu,sa,Math.max(8,li-12));x.fillRect(0,0,128,128);for(let r=0;r<8;r++)for(let q=-1;q<9;q++){const px=q*16+(r%2)*8,py=r*16;x.fillStyle=hsl(hu+R()*8,sa,li+R()*10);x.fillRect(px+1,py+1,14,14);x.fillStyle='rgba(0,0,0,.35)';x.fillRect(px,py+13,16,3);x.fillStyle='rgba(255,255,255,.07)';x.fillRect(px+2,py+2,3,10)}return mkTex(c)}
const wallFill=(x,ox,oy,w,h,col)=>{x.fillStyle=col;x.fillRect(ox,oy,w,h);for(let i=0;i<w*h/22;i++){const g=R()<.5?0:255;x.fillStyle=`rgba(${g},${g},${g},${R()*.07})`;x.fillRect(ox+R()*w,oy+R()*h,1+R()*2,1+R()*2)}};
const glass=(x,ox,oy,w,h,a,b)=>{const g=x.createLinearGradient(0,oy,0,oy+h);g.addColorStop(0,a);g.addColorStop(1,b);x.fillStyle=g;x.fillRect(ox,oy,w,h);x.fillStyle='rgba(255,255,255,.14)';x.beginPath();x.moveTo(ox+w*.1,oy+h);x.lineTo(ox+w*.55,oy);x.lineTo(ox+w*.75,oy);x.lineTo(ox+w*.3,oy+h);x.fill()};
const litW=(y,ox,oy,w,h)=>{const g=y.createLinearGradient(0,oy,0,oy+h);g.addColorStop(0,'#ffe2a8');g.addColorStop(1,'#ffb866');y.fillStyle=g;y.fillRect(ox,oy,w,h)};
function pbrFrom(c){const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h),[o,ox]=cv2(w,h),od=ox.createImageData(w,h);for(let i=0;i<d.data.length;i+=4){const glass=d.data[i+2]>d.data[i]+18;od.data[i]=0;od.data[i+1]=glass?34:222;od.data[i+2]=glass?150:0;od.data[i+3]=255}ox.putImageData(od,0,0);return mkTex(o,false)}
function facade(cw,ch,cols,rows,cell){const[c,x]=cv2(cw*cols,ch*rows),[e,y]=cv2(cw*cols,ch*rows);y.fillStyle='#000';y.fillRect(0,0,e.width,e.height);for(let r=0;r<rows;r++)for(let q=0;q<cols;q++)cell(x,y,q*cw,r*ch,cw,ch,R()<.4);return[mkTex(c),mkTex(e),pbrFrom(c)]}
const stuccoC=(x,y,ox,oy,w,h,on)=>{wallFill(x,ox,oy,w,h,'#d8ccb4');x.fillStyle='rgba(60,50,40,.22)';x.fillRect(ox,oy+h-8,w,8);const ww=w*.36,wh=h*.46,wx=ox+(w-ww)/2,wy=oy+h*.2;x.fillStyle='#f4f0e6';x.fillRect(wx-5,wy-5,ww+10,wh+10);glass(x,wx,wy,ww,wh,'#7d97ae','#26333f');x.fillStyle='rgba(235,235,225,.9)';x.fillRect(wx+ww/2-1.5,wy,3,wh);x.fillRect(wx,wy+wh/2-1.5,ww,3);x.fillStyle=['#4d6b4a','#7a4b3a','#3d5a73'][(R()*3)|0];x.fillRect(wx-17,wy-5,10,wh+10);x.fillRect(wx+ww+7,wy-5,10,wh+10);x.fillStyle='#b9ad98';x.fillRect(wx-8,wy+wh+5,ww+16,5);if(on)litW(y,wx,wy,ww,wh)};
const brickFill=(x,ox,oy,w,h)=>{x.fillStyle='#8a8478';x.fillRect(ox,oy,w,h);for(let r=0;r<h/8;r++)for(let q=-1;q<w/22+1;q++){const px=ox+q*22+(r%2)*11,py=oy+r*8,x0=Math.max(px+1,ox),x1=Math.min(px+21,ox+w);if(x1<=x0)continue;x.fillStyle=hsl(8+R()*12,38+R()*14,28+R()*12);x.fillRect(x0,py+1,x1-x0,6)}x.fillStyle='rgba(0,0,0,.18)';x.fillRect(ox,oy+h-8,w,8)};
const plankFill=(x,ox,oy,w,h,hue,l)=>{x.fillStyle=hsl(hue,12,l);x.fillRect(ox,oy,w,h);for(let y=0;y<h;y+=9){x.fillStyle='rgba(0,0,0,.22)';x.fillRect(ox,oy+y,w,1.5);x.fillStyle='rgba(255,255,255,.06)';x.fillRect(ox,oy+y+2,w,1)}for(let i=0;i<w*h/60;i++){x.fillStyle=`rgba(0,0,0,${R()*.05})`;x.fillRect(ox+R()*w,oy+R()*h,8+R()*14,1)}};
const winC=wallFn=>(x,y,ox,oy,w,h,on)=>{wallFn(x,ox,oy,w,h);const ww=w*.36,wh=h*.46,wx=ox+(w-ww)/2,wy=oy+h*.2;x.fillStyle='#f1eee6';x.fillRect(wx-5,wy-5,ww+10,wh+10);glass(x,wx,wy,ww,wh,'#7d97ae','#26333f');x.fillStyle='rgba(235,235,225,.9)';x.fillRect(wx+ww/2-1.5,wy,3,wh);x.fillRect(wx,wy+wh/2-1.5,ww,3);x.fillStyle='#d8d3c6';x.fillRect(wx-8,wy+wh+5,ww+16,5);if(on)litW(y,wx,wy,ww,wh)};
const brickC=winC(brickFill),sidingC=winC((x,ox,oy,w,h)=>plankFill(x,ox,oy,w,h,35,66));
const aptC=(x,y,ox,oy,w,h,on)=>{wallFill(x,ox,oy,w,h,'#b9a99a');x.fillStyle='rgba(0,0,0,.18)';x.fillRect(ox,oy,w,5);const ww=w*.46,wh=h*.5,wx=ox+(w-ww)/2,wy=oy+h*.14;x.fillStyle='#3a3836';x.fillRect(wx-4,wy-4,ww+8,wh+8);glass(x,wx,wy,ww,wh,'#6e8aa3','#222d38');x.fillStyle='rgba(220,220,215,.85)';x.fillRect(wx+ww/2-1,wy,2,wh);x.fillStyle='rgba(40,40,42,.9)';x.fillRect(wx-10,wy+wh+4,ww+20,4);for(let i=0;i<=8;i++)x.fillRect(wx-10+i*(ww+18)/8,wy+wh+4,2,h*.2);if(on)litW(y,wx,wy,ww,wh)};
const offC=(x,y,ox,oy,w,h,on)=>{wallFill(x,ox,oy,w,h,'#9a9a98');x.fillStyle='#55585c';x.fillRect(ox,oy+h*.7,w,h*.3);glass(x,ox+4,oy+h*.08,w-8,h*.6,'#5f7f99','#1f2c38');x.fillStyle='#777';x.fillRect(ox,oy,3,h);x.fillStyle='#c9cdd0';x.fillRect(ox+w/2-1,oy+h*.08,2,h*.6);if(on)litW(y,ox+4,oy+h*.08,w-8,h*.6)};
const glsC=(x,y,ox,oy,w,h,on)=>{const t=[['#4d6d8a','#1b2a3a'],['#5b7a96','#223344'],['#456580','#18283a']][(R()*3)|0];glass(x,ox,oy,w,h*.82,t[0],t[1]);x.fillStyle='#2b3138';x.fillRect(ox,oy+h*.82,w,h*.18);x.fillStyle='#b8c0c8';x.fillRect(ox,oy,2,h);x.fillRect(ox+w/2,oy,1.5,h*.82);if(on)litW(y,ox+3,oy+3,w-6,h*.78)};
/* geometry helpers */
/* SW/PH are the skeletal wind channels: per-vertex compliance and branch phase.
   Only the grown species fill them; everything else leaves them at zero, which
   the material reads as "no skeletal bend". */
const GA=()=>({P:[],N:[],C:[],T:[],I:[],RND:[],CEN:[],SW:[],PH:[]});
function gaV(g,p,n,c,t){g.P.push(p[0],p[1],p[2]);g.N.push(n[0],n[1],n[2]);g.C.push(c[0],c[1],c[2]);g.T.push(t[0],t[1]);g.RND.push(g.cr===undefined?Math.random():g.cr);g.CEN.push(...(g.cc||p));g.SW.push(g.sw===undefined?0:g.sw);g.PH.push(g.phv===undefined?0:g.phv);return g.P.length/3-1}
function gaQ(g,p,n,c,uv){const h0=g.cr!==undefined,hc=g.cc!==undefined;if(!h0)g.cr=Math.random();if(!hc)g.cc=[(p[0][0]+p[1][0]+p[2][0]+p[3][0])/4,(p[0][1]+p[1][1]+p[2][1]+p[3][1])/4,(p[0][2]+p[1][2]+p[2][2]+p[3][2])/4];const a=p.map((q,i)=>gaV(g,q,n,c,uv?uv[i]:[[0,0],[1,0],[1,1],[0,1]][i]));g.I.push(a[0],a[1],a[2],a[0],a[2],a[3]);if(!h0)g.cr=undefined;if(!hc)g.cc=undefined}
function gaT(g,p,n,c,uv){const h0=g.cr!==undefined,hc=g.cc!==undefined;if(!h0)g.cr=Math.random();if(!hc)g.cc=[(p[0][0]+p[1][0]+p[2][0])/3,(p[0][1]+p[1][1]+p[2][1])/3,(p[0][2]+p[1][2]+p[2][2])/3];const a=p.map((q,i)=>gaV(g,q,n,c,uv[i]));g.I.push(a[0],a[1],a[2]);if(!h0)g.cr=undefined;if(!hc)g.cc=undefined}
function gaGeo(g){const o=new THREE.BufferGeometry();o.setAttribute('position',new THREE.Float32BufferAttribute(g.P,3));o.setAttribute('normal',new THREE.Float32BufferAttribute(g.N,3));o.setAttribute('color',new THREE.Float32BufferAttribute(g.C,3));o.setAttribute('uv',new THREE.Float32BufferAttribute(g.T,2));o.setAttribute('aRnd',new THREE.Float32BufferAttribute(g.RND,1));o.setAttribute('aCen',new THREE.Float32BufferAttribute(g.CEN,3));o.setAttribute('aSway',new THREE.Float32BufferAttribute(g.SW,1));o.setAttribute('aPhase',new THREE.Float32BufferAttribute(g.PH,1));o.setIndex(g.I);return o}
function foliage(vols,cnt,sz,c0,c1){const g=GA();vols.forEach(([cx,cy_,cz,rx,ry,rz])=>{for(let i=0;i<cnt;i++){let x,y,z;do{x=R()*2-1;y=R()*2-1;z=R()*2-1}while(x*x+y*y+z*z>1);const d=Math.hypot(x,y,z)||1,ox=x/d,oy=y/d,oz=z/d;
const a=R()*6.283,e=(R()-.4)*1.5,r2x=Math.cos(a),r2z=Math.sin(a),ux=-Math.sin(a)*Math.sin(e),uz=Math.cos(a)*Math.sin(e),uy=Math.cos(e),s=sz*(.7+R()*.6),px=cx+x*rx,py=cy_+y*ry,pz=cz+z*rz;
const nx=ox*.85+ux*.15,ny=oy*.85+uy*.15+.12,nz=oz*.85+uz*.15,nl=Math.hypot(nx,ny,nz),n=[nx/nl,ny/nl,nz/nl],t=cl(.45+oy*.35+(d-.5)*.45,0,1)*(.85+R()*.3),c=[c0[0]+(c1[0]-c0[0])*t,c0[1]+(c1[1]-c0[1])*t,c0[2]+(c1[2]-c0[2])*t],h=s/2;
gaQ(g,[[px-r2x*h-ux*h,py-uy*h,pz-r2z*h-uz*h],[px+r2x*h-ux*h,py-uy*h,pz+r2z*h-uz*h],[px+r2x*h+ux*h,py+uy*h,pz+r2z*h+uz*h],[px-r2x*h+ux*h,py+uy*h,pz-r2z*h+uz*h]],n,c)}});return gaGeo(g)}
function strip(g,b,d,len,w,drop,c,rows){const hl=Math.hypot(d[0],d[2])||1,sx=-d[2]/hl,sz=d[0]/hl,ids=[];for(let i=0;i<=rows;i++){const t=i/rows,wd=w*(1-t*.35)*(i==rows?.5:1),p=[b[0]+d[0]*len*t,b[1]+d[1]*len*t-drop*t*t,b[2]+d[2]*len*t],n=[d[0]*.5,.8,d[2]*.5],cc=c.map(v=>v*(.75+.25*t));
ids.push(gaV(g,[p[0]-sx*wd,p[1],p[2]-sz*wd],n,cc,[0,t]),gaV(g,[p[0]+sx*wd,p[1],p[2]+sz*wd],n,cc,[1,t]))}
for(let i=0;i<rows;i++){const a=ids[i*2],b2=ids[i*2+1],c2=ids[i*2+2],d2=ids[i*2+3];g.I.push(a,b2,c2,b2,d2,c2)}}
const limb=(a,b,r0,r1)=>{const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],L=Math.hypot(dx,dy,dz)||1,ux=dx/L,uy=dy/L,uz=dz/L,g=cy(r1,r0,L,6).translate(0,L/2,0),p=g.attributes.position,s=Math.hypot(ux,uz),kx=s>1e-6?uz/s:1,kz=s>1e-6?-ux/s:0,c=uy;
for(let i=0;i<p.count;i++){let x=p.getX(i),y=p.getY(i),z=p.getZ(i);if(s<1e-6){if(uy<0){y=-y;z=-z}}else{const dt=kx*x+kz*z,rx=-kz*y,ry=kz*x-kx*z,rz=kx*y;x=x*c+rx*s+kx*dt*(1-c);y=y*c+ry*s;z=z*c+rz*s+kz*dt*(1-c)}p.setXYZ(i,x,y,z)}return g.translate(a[0],a[1],a[2])};
const bxT=(w,h,d,tw,th)=>{const g=new THREE.BoxGeometry(w,h,d),u=g.attributes.uv;for(let i=0;i<u.count;i++){const f=i>>2;let su,sv;if(f<2){su=d/tw;sv=h/th}else if(f<4){su=w/tw;sv=d/tw}else{su=w/tw;sv=h/th}u.setXY(i,u.getX(i)*su,u.getY(i)*sv)}return g};
const shd=t=>{const q=.7+.3*t;return[q,q,q]},flc=c=>()=>c,UB=[1,1,0],bkU=[3,4,.4];
/* textures */
const LFT=leafTex(),OAKL=leafTexSpecies('oak'),BIRL=leafTexSpecies('birch'),SHRL=leafTexSpecies('shrub'),ACAL=leafTexSpecies('acacia'),SAGL=leafTexSpecies('sage'),ASHL=leafTexSpecies('ash'),NDT=needleTex(),PTT=petalTex(),FRT=frondTex(),RFT=roofTex(),BT={oak:barkTex('oak'),pine:barkTex('pine'),birch:barkTex('birch'),palm:barkTex('palm'),char:barkTex('char'),cactus:cactusTex()};
const BN=Object.fromEntries(Object.entries(BT).map(([k,t])=>[k,normFrom(t.image,k=='palm'?1.8:k=='cactus'?2.5:4)]));
const BR=Object.fromEntries(Object.entries(BT).map(([k,t])=>[k,roughTex(t.image,k=='birch'?.88:k=='cactus'?.86:.9)]));
const HTV=[stuccoC,brickC,sidingC].map(f=>facade(128,128,3,3,f)),HT=HTV[0],AT=facade(128,96,3,3,aptC),OT=facade(96,96,3,3,offC),GT=facade(96,96,3,3,glsC);
/* grass tufts: crossed alpha cards, two layers */
const grassG=(()=>{const g=GA(),count=detail>=3?12:detail>=2?8:5;for(let i=0;i<count;i++){const a=R()*6.2832,ca=Math.cos(a),sa=Math.sin(a),height=.38+R()*.76,width=.018+R()*.032,lean=.08+R()*.34,curve=(R()-.5)*.18,base=[.11+R()*.1,.19+R()*.13,.035+R()*.04],tip=[.19+R()*.16,.32+R()*.2,.055+R()*.07],side=[-sa,0,ca],pt=(t,s)=>{const w=width*(.035+.965*Math.pow(1-t,.78)),cx=ca*lean*t*t+side[0]*curve*Math.sin(t*3.1416),cz=sa*lean*t*t+side[2]*curve*Math.sin(t*3.1416);return[cx+side[0]*s*w*.5,height*t,cz+side[2]*s*w*.5]};for(let j=0;j<3;j++){const t0=j/3,t1=(j+1)/3,m=(t0+t1)*.5,q=m*m*(3-2*m),col=base.map((v,k)=>v+(tip[k]-v)*q);gaQ(g,[pt(t0,-1),pt(t0,1),pt(t1,1),pt(t1,-1)],[ca,.02,sa],col)}}return gaGeo(g)})();
const tallGrassG=(()=>{const g=GA(),count=detail>=3?20:detail>=2?16:12;for(let i=0;i<count;i++){const a=R()*6.2832,ca=Math.cos(a),sa=Math.sin(a),height=1.05+R()*1.35,width=.014+R()*.024,lean=.12+R()*.43,curve=(R()-.5)*.22,base=[.10+R()*.08,.22+R()*.14,.035+R()*.035],tip=[.18+R()*.15,.36+R()*.2,.055+R()*.055],side=[-sa,0,ca],pt=(t,s)=>{const w=width*(.025+.975*Math.pow(1-t,.74)),cx=ca*lean*t*t+side[0]*curve*Math.sin(t*3.1416),cz=sa*lean*t*t+side[2]*curve*Math.sin(t*3.1416);return[cx+side[0]*s*w*.5,height*t,cz+side[2]*s*w*.5]};for(let j=0;j<4;j++){const t0=j/4,t1=(j+1)/4,m=(t0+t1)*.5,q=m*m*(3-2*m),col=base.map((v,k)=>v+(tip[k]-v)*q);gaQ(g,[pt(t0,-1),pt(t0,1),pt(t1,1),pt(t1,-1)],[ca,.025,sa],col)}}return gaGeo(g)})();

function indexSubsetGeometry(g,fraction){const h=g.clone();const index=g.index;if(index){const keep=Math.max(6,Math.floor(index.count*fraction/3)*3);h.setIndex(new THREE.BufferAttribute(index.array.slice(0,keep),1))}return h}
const grassLowG=buildLowDetail(()=>indexSubsetGeometry(grassG,.42)),tallGrassLowG=buildLowDetail(()=>indexSubsetGeometry(tallGrassG,.5)),grassLowGeometry=grassLowG;


/* procedural flower varieties */
function curvedPetalPatch(g,c,a,len,width,kind,color,phase=0,quality=1){const rows=quality<.8?4:8,cols=quality<.8?2:4,ca=Math.cos(a),sa=Math.sin(a),tx=-sa,tz=ca,start=g.P.length/3;for(let i=0;i<=rows;i++){const u=i/rows,shape=Math.pow(Math.max(0,Math.sin(Math.PI*u)),.62),lift=Math.sin(u*Math.PI);for(let j=0;j<=cols;j++){const v=j/cols*2-1,side=v*width*.5*shape,radial=kind==='tulip'?.012+len*(.2*u+.48*Math.sin(u*Math.PI*.58)):kind==='lavender'?.006+len*.35*u:.01+len*u;let y;if(kind==='tulip')y=c[1]-.025+len*(.58*u+.31*lift)+width*.9*v*v*lift;else if(kind==='lavender')y=c[1]+len*.52*u+width*.22*lift;else y=c[1]+len*(.015*u+.06*lift)+width*.52*v*v*lift-.008*lift;const p=[c[0]+ca*radial+tx*side,y,c[2]+sa*radial+tz*side],nx=-ca*(kind==='tulip'?.24:.12)*lift-tx*.18*v*lift,ny=1,nz=-sa*(kind==='tulip'?.24:.12)*lift-tz*.18*v*lift,nl=Math.hypot(nx,ny,nz),shade=.91+.09*lift-.04*Math.abs(v)+.025*Math.sin(phase+u*8);gaV(g,p,[nx/nl,ny/nl,nz/nl],color.map(q=>q*shade),[.22+(v+1)*.28,u])}}for(let i=0;i<rows;i++)for(let j=0;j<cols;j++){const a0=start+i*(cols+1)+j,b=a0+1,c0=a0+cols+1,d=c0+1;g.I.push(a0,b,c0,b,d,c0)}}
function flowerParts(kind){
 const heads=FPs.map(([x,z,h])=>[x*1.25,z*1.25,h*(kind==='tulip'?1.1:kind==='lavender'?1.25:1)]),stem=mergeG(heads.map(([x,z,h])=>[cy(.009,.018,h,6).translate(x,h/2,z),t=>[.28+.12*t,.48+.22*t,.18],[1,1,0]])),petals=GA(),centerParts=[];
 if(kind==='daisy'){
  for(const[x,z,h]of heads){for(let j=0;j<14;j++){const a=j*Math.PI*2/14,plen=.108*(.88+R()*.24),pwid=.03*(.88+R()*.24);curvedPetalPatch(petals,[x,h,z],a,plen,pwid,'daisy',[.97,.95,.86],j*.7)}centerParts.push([blob(.038,x,h+.012,z,.3),t=>[.95,.61+.15*t,.055],[1,1,0]])}
 }else if(kind==='tulip'){
  for(const[x,z,h]of heads){const hue=R();for(let j=0;j<6;j++){const a=j*Math.PI/3+R()*.04,col=[.68+.16*hue,.18+.16*(1-hue),.2+.24*(j%2)],plen=.155*(.9+R()*.18),pwid=.058*(.9+R()*.18);curvedPetalPatch(petals,[x,h,z],a,plen,pwid,'tulip',col,j*.9)}centerParts.push([blob(.027,x,h+.04,z,.3),t=>[.82,.48+.16*t,.07],[1,1,0]])}
 }else{
  for(const[x,z,h]of heads){for(let j=0;j<11;j++){const u=j/10,y=h-.08+j*.031,a=j*2.399,r=.022+.012*Math.sin(Math.PI*u),bx=x+Math.cos(a)*r,bz=z+Math.sin(a)*r;for(const side of [-1,1])curvedPetalPatch(petals,[bx,y,bz],a+side*.78,.052,.024,'lavender',[.58+.12*(j%3),.34+.1*(j%2),.78+.12*(j%3)],a);centerParts.push([blob(.013,bx,y,bz,.06),t=>[.72,.42,.88],[1,1,1]])}
 }}
 const petalMesh=gaGeo(petals),centerMesh=mergeG(centerParts);
 return[[stem,{phys:1,roughness:.8,nt:1,w:.06,fx:'S'}],[fleafG,{map:LFT,cut:.3,ds:1,phys:1,nm:LEAF_PBR.generic.nm,ns:.32,rm:LEAF_PBR.generic.rm,roughness:.78,w:.06,fx:'S'}],[petalMesh,{map:PTT,cut:.14,ds:1,phys:1,nm:LEAF_PBR.petal.nm,ns:.18,rm:LEAF_PBR.petal.rm,roughness:kind==='tulip'?.76:.74,clearcoat:.07,w:.045,fx:'S'}],[centerMesh,{phys:1,roughness:.72,nt:1}]]
}
/* flowers */
const FPs=[[-.07,0,.55],[.12,.06,.45],[-.1,-.08,.4]];
const stemG=mergeG(FPs.map(([x,z,h])=>[cy(.01,.018,h,4).translate(x,h/2,z),t=>[.35+.3*t,.5+.3*t,.2],[1,1,0]]));
const fleafG=foliage([[0,.12,0,.28,.14,.28]],7,.34,[.6,.65,.55],[1,1,.9]);
const petG=(()=>{const g=GA();FPs.forEach(([x,z,h],i)=>{const color=PALF[(i*2+1)%PALF.length];for(let j=0;j<9;j++)curvedPetalPatch(g,[x,h,z],j*Math.PI*2/9+R()*.08,.085,.029,'daisy',color,j*.8)});return gaGeo(g)})();

const centG=mergeG(FPs.map(([x,z,h])=>[blob(.032,x,h+.01,z,.1),flc([.9,.7,.15]),[1,1,0]]));
/* ---- branching trees: wood is real tubes, leaf cards start ON the twigs ---- */
function capLoop(g,c,n,u,v,r,sd,shade,reverse=false,rib=null){if(!(r>.004))return;const center=gaV(g,c,n,[shade,shade,shade],[.5,.5]),start=g.P.length/3;for(let j=0;j<=sd;j++){const a=j/sd*6.2832,cs=Math.cos(a),sn=Math.sin(a),rr=r*(rib?rib(a):1);gaV(g,[c[0]+(u[0]*cs+v[0]*sn)*rr,c[1]+(u[1]*cs+v[1]*sn)*rr,c[2]+(u[2]*cs+v[2]*sn)*rr],n,[shade,shade,shade],[.5+cs*.5,.5+sn*.5])}for(let j=0;j<sd;j++)reverse?g.I.push(center,start+j+1,start+j):g.I.push(center,start+j,start+j+1)}
function tube(g,a,b,r0,r1,sd,us,v0,cap){sd=Math.max(4,Math.round(sd*DQ.seg));const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],L=Math.hypot(dx,dy,dz)||1e-6,d=[dx/L,dy/L,dz/L];let ux,uy=0,uz;if(Math.abs(d[1])<.97){ux=d[2];uz=-d[0]}else{ux=1;uz=0}const ul=Math.hypot(ux,uy,uz)||1;ux/=ul;uz/=ul;const vx=d[1]*uz-d[2]*uy,vy=d[2]*ux-d[0]*uz,vz=d[0]*uy-d[1]*ux,u=[ux,uy,uz],v=[vx,vy,vz],o=g.P.length/3,off=v0===undefined?a[1]*us[1]:v0;
for(let i=0;i<2;i++){const c=i?b:a,r=i?r1:r0,sh=.68+.32*cl((c[1]+1)/8,0,1);for(let j=0;j<=sd;j++){const th=j/sd*6.2832,cs=Math.cos(th),sn=Math.sin(th),nx=ux*cs+vx*sn,ny=uy*cs+vy*sn,nz=uz*cs+vz*sn;gaV(g,[c[0]+nx*r,c[1]+ny*r,c[2]+nz*r],[nx,ny,nz],[sh,sh,sh],[j/sd*us[0],(i?L:0)*us[1]+off])}}
for(let j=0;j<sd;j++){const a0=o+j,a1=o+j+1,b0=o+sd+1+j,b1=o+sd+2+j;g.I.push(a0,a1,b0,a1,b1,b0)}if(cap!==false){const sh0=.68+.32*cl((a[1]+1)/8,0,1),sh1=.68+.32*cl((b[1]+1)/8,0,1);capLoop(g,a,[-d[0],-d[1],-d[2]],u,v,r0,sd,sh0,true);capLoop(g,b,d,u,v,r1,sd,sh1,false)}return off+L*us[1]}
function tubePath(g,P,Rd,sd,us,rib,caps=true){sd=Math.max(5,Math.round(sd*DQ.seg));const n=P.length,T=P.map((p,i)=>{const a=P[Math.max(0,i-1)],b=P[Math.min(n-1,i+1)],d=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],l=Math.hypot(d[0],d[1],d[2])||1;return[d[0]/l,d[1]/l,d[2]/l]});
let u=Math.abs(T[0][1])<.97?[T[0][2],0,-T[0][0]]:[1,0,0];const ul=Math.hypot(u[0],u[1],u[2])||1;u=u.map(q=>q/ul);const uStart=u.slice(),o=g.P.length/3;let vv=P[0][1]*us[1];
for(let i=0;i<n;i++){const t=T[i];if(i){const dd=u[0]*t[0]+u[1]*t[1]+u[2]*t[2];u=[u[0]-t[0]*dd,u[1]-t[1]*dd,u[2]-t[2]*dd];const l=Math.hypot(u[0],u[1],u[2])||1;u=u.map(q=>q/l);vv+=Math.hypot(P[i][0]-P[i-1][0],P[i][1]-P[i-1][1],P[i][2]-P[i-1][2])*us[1]}
const w=[t[1]*u[2]-t[2]*u[1],t[2]*u[0]-t[0]*u[2],t[0]*u[1]-t[1]*u[0]],sh=.68+.32*cl((P[i][1]+1)/8,0,1);for(let j=0;j<=sd;j++){const th=j/sd*6.2832,cs=Math.cos(th),sn=Math.sin(th),nx=u[0]*cs+w[0]*sn,ny=u[1]*cs+w[1]*sn,nz=u[2]*cs+w[2]*sn,rr=Rd[i]*(rib?rib(th):1);gaV(g,[P[i][0]+nx*rr,P[i][1]+ny*rr,P[i][2]+nz*rr],[nx,ny,nz],[sh,sh,sh],[j/sd*us[0],vv])}}
for(let i=0;i<n-1;i++)for(let j=0;j<sd;j++){const a0=o+i*(sd+1)+j,a1=a0+1,b0=a0+sd+1,b1=b0+1;g.I.push(a0,a1,b0,a1,b1,b0)}if(caps){const t0=T[0],w0=[t0[1]*uStart[2]-t0[2]*uStart[1],t0[2]*uStart[0]-t0[0]*uStart[2],t0[0]*uStart[1]-t0[1]*uStart[0]],sh0=.68+.32*cl((P[0][1]+1)/8,0,1),e=n-1,te=T[e],we=[te[1]*u[2]-te[2]*u[1],te[2]*u[0]-te[0]*u[2],te[0]*u[1]-te[1]*u[0]],sh1=.68+.32*cl((P[e][1]+1)/8,0,1);capLoop(g,P[0],[-t0[0],-t0[1],-t0[2]],uStart,w0,Rd[0],sd,sh0,true,rib);capLoop(g,P[e],te,u,we,Rd[e],sd,sh1,false,rib)}}
function lcard(g,b,d,size,c0,c1,ctr,tO){const dl=Math.hypot(d[0],d[1],d[2])||1,vx=d[0]/dl,vy=d[1]/dl,vz=d[2]/dl;let ux=vz,uz=-vx,ul=Math.hypot(ux,uz);if(ul<.2){ux=1;uz=0;ul=1}ux/=ul;uz/=ul;
const roll=R()*3.1416,cr=Math.cos(roll),sr=Math.sin(roll),wx=vy*uz,wy=vz*ux-vx*uz,wz=-vy*ux,ax=ux*cr+wx*sr,ay=wy*sr,az=uz*cr+wz*sr,h=size*.42;
let nx=vy*az-vz*ay,ny=vz*ax-vx*az,nz=vx*ay-vy*ax;const ox=b[0]-ctr[0],oy=b[1]-ctr[1],oz=b[2]-ctr[2],ol=Math.hypot(ox,oy,oz)||1;if(nx*ox+ny*oy+nz*oz<0){nx=-nx;ny=-ny;nz=-nz}
let fx=nx*.4+ox/ol*.6,fy=ny*.4+oy/ol*.6+.15,fz=nz*.4+oz/ol*.6;const fl=Math.hypot(fx,fy,fz)||1,t=(tO!==undefined?cl(tO,0,1):cl(.5+(oy/ol)*.3+(ol/ctr[3]-.5)*.5,0,1))*(.85+R()*.3),c=[c0[0]+(c1[0]-c0[0])*t,c0[1]+(c1[1]-c0[1])*t,c0[2]+(c1[2]-c0[2])*t],tp=[b[0]+vx*size,b[1]+vy*size,b[2]+vz*size];
gaQ(g,[[b[0]-ax*h,b[1]-ay*h,b[2]-az*h],[b[0]+ax*h,b[1]+ay*h,b[2]+az*h],[tp[0]+ax*h,tp[1]+ay*h,tp[2]+az*h],[tp[0]-ax*h,tp[1]-ay*h,tp[2]-az*h]],[fx/fl,fy/fl,fz/fl],c)}
let BLG=null;
function petalCard(g,c,s){const a=R()*6.283,t=R()*1.2,ra=[Math.cos(a),0,Math.sin(a)],ua=[-Math.sin(a)*Math.sin(t),Math.cos(t),Math.cos(a)*Math.sin(t)],h=s/2,col=g.bcol||[1,.82,.88];
gaQ(g,[[c[0]-ra[0]*h-ua[0]*h,c[1]-ua[1]*h,c[2]-ra[2]*h-ua[2]*h],[c[0]+ra[0]*h-ua[0]*h,c[1]-ua[1]*h,c[2]+ra[2]*h-ua[2]*h],[c[0]+ra[0]*h+ua[0]*h,c[1]+ua[1]*h,c[2]+ra[2]*h+ua[2]*h],[c[0]-ra[0]*h+ua[0]*h,c[1]+ua[1]*h,c[2]-ra[2]*h+ua[2]*h]],[0,1,0],col)}
function cluster(W,L,q,d,n,size,c0,c1,ctr,droop){n=n*DQ.leaf;n=Math.floor(n)+(R()<n%1?1:0);for(let k=0;k<n;k++){const b=[q[0]+(R()-.5)*.06,q[1]+(R()-.5)*.06,q[2]+(R()-.5)*.06],ld=[d[0]+(R()-.5)*.9,d[1]+(R()-.5)*.9-droop,d[2]+(R()-.5)*.9];tube(W,q,b,Math.max(.008,size*.018),.006,4,[1,.28]);lcard(L,b,ld,size*(.75+R()*.5),c0,c1,ctr)}if(BLG)for(let k=0;k<2;k++)petalCard(BLG,[q[0]+(R()-.5)*.25,q[1]+(R()-.5)*.25,q[2]+(R()-.5)*.25],size*(.28+R()*.18))}
function grow(W,L,p,d,len,r,dep,mx,o){const q=[p[0]+d[0]*len,p[1]+d[1]*len,p[2]+d[2]*len];tube(W,p,q,r,r*.72,5,[1,.35]);
if(dep>=mx){cluster(W,L,q,d,o.cards,o.size,o.c0,o.c1,o.ctr,o.droop);return}
const n=dep==0?3:(R()<.55?3:2);for(let i=0;i<n;i++){const s=.5+R()*.5,sp=[p[0]+(q[0]-p[0])*s,p[1]+(q[1]-p[1])*s,p[2]+(q[2]-p[2])*s],j=.75;let nd=[d[0]+(R()-.5)*j*1.6,d[1]+(R()-.5)*j+o.bias,d[2]+(R()-.5)*j*1.6];const nl=Math.hypot(nd[0],nd[1],nd[2])||1;nd=nd.map(v=>v/nl);grow(W,L,sp,nd,len*(.6+R()*.22),r*.6,dep+1,mx,o)}}
const dirA=(a,e)=>[Math.cos(a)*Math.cos(e),Math.sin(e),Math.sin(a)*Math.cos(e)];
/* A flared root collar merges into the trunk, with lateral roots and deep buried taproots. */
function rootsFrom(W,r0,kind,uv=[1,.55]){const cfg={pine:[8,3.1,.55,2.3],spruce:[8,3,.5,2.7],krumm:[7,2.8,.45,1.9],juniper:[7,2.1,.36,1.5],oak:[9,3.8,.6,3.5],birch:[6,2.8,.35,2.4],palm:[16,4.2,.25,1.6],acacia:[8,3.6,.6,3.2],joshua:[5,2.5,.35,2.3],deadtree:[7,3.2,.5,2.7],treefern:[12,2,.2,1.5],cactus:[9,1.8,.26,1.15],agave:[10,1.6,.18,.9],shrub:[7,1.7,.3,.9]}[kind]||[6,2.4,.35,1.8],n=cfg[0]+((R()*2)|0),depth=cfg[3],collarP=[[0,-.9,0],[0,-.6,0],[0,-.25,0],[0,.1,0],[0,.72,0]],collarR=[r0*.24,r0*.46,r0*.9,r0*1.18,r0*.62];tubePath(W,collarP,collarR,10,uv,null,false);
for(let i=0;i<n;i++){const a=i/n*6.283+(R()-.5)*.6,L=r0*cfg[1]*(.75+R()*.5),pts=[],rad=[];for(let k=0;k<=6;k++){const t=k/6,d=r0*.22+L*t,y=.09-.02*t-(depth-.07)*Math.pow(t,3.3),wob=Math.sin(t*5+i*2.1)*.08*L*t;pts.push([Math.cos(a)*d-Math.sin(a)*wob,y,Math.sin(a)*d+Math.cos(a)*wob]);rad.push(r0*cfg[2]*.52*Math.pow(1-t,.9)+.014)}tubePath(W,pts,rad,7,uv);if(L>1.2&&R()<.82){const sa=a+(R()-.5)*1.2,b=pts[3],e=[b[0]+Math.cos(sa)*L*.35,b[1]-.4-R()*.5,b[2]+Math.sin(sa)*L*.35];tube(W,b,e,rad[3]*.6,.014,5,uv)}}
const tapCount=kind==='palm'?8:kind==='cactus'||kind==='agave'?6:4;for(let i=0;i<tapCount;i++){const a=i/tapCount*6.283+(R()-.5)*.3,reach=r0*(kind==='palm'?.9:kind==='cactus'?.42:.52)*(.85+R()*.3),tip=depth*(1.15+R()*.18),ca=Math.cos(a),sa=Math.sin(a),pts=[[ca*r0*.03,-.18,sa*r0*.03],[ca*reach*.34,-.3,sa*reach*.34],[ca*reach*.72,-tip*.58,sa*reach*.72],[ca*reach,-tip,sa*reach]],rad=[r0*.28,r0*.19,Math.max(.018,r0*.095),.014];tubePath(W,pts,rad,5,uv)}}
function oakTreeJs(){BLG=GA();BLG.bcol=[1,.8,.88];const W=GA(),L=GA(),ctr=[0,6,0,3.6],o={cards:4,size:1.05,c0:[.66,.72,.6],c1:[1.15,1.15,1],ctr,droop:.25,bias:.12};let p=[0,0,0];{const pts=[[0,0,0]],rad=[.87],N=14,wx=(R()-.5)*.8,wz=(R()-.5)*.8;for(let i=1;i<=N;i++){const t=i/N;pts.push([wx*Math.sin(t*3)*.55+Math.sin(t*4+wx)*.04,4.2*t,wz*Math.sin(t*2.6)*.55+Math.cos(t*3+wz)*.04]);rad.push(.62*Math.pow(.5,t)+.25*Math.exp(-t*8))}rootsFrom(W,rad[0],'oak',[2.6,.68]);tubePath(W,pts,rad,10,[3.2,.9]);p=pts[N]}
const n=5+(R()*3|0);for(let i=0;i<n;i++){const a=i/n*6.283+R()*.6,e=.5+R()*.45;grow(W,L,[p[0],p[1]-.3-R()*.4,p[2]],dirA(a,e),1.8+R()*.7,.2+R()*.05,0,4,o)}
grow(W,L,p,[(R()-.5)*.3,1,(R()-.5)*.3],1.7,.19,0,4,o);const B=gaGeo(BLG);BLG=null;return[gaGeo(W),gaGeo(L),B]}
function birchTreeJs(){BLG=GA();BLG.bcol=[.96,.97,.82];const W=GA(),L=GA(),ctr=[0,6.5,0,2.4],o={cards:3,size:.8,c0:[.6,.7,.5],c1:[1.3,1.25,.9],ctr,droop:.5,bias:-.05};let p=[0,0,0];const lx=(R()-.5)*.5,lz=(R()-.5)*.5;{const pts=[],rad=[],N=14;for(let i=0;i<=N;i++){const t=i/N;pts.push([lx*1.8*t,8.1*t,lz*1.8*t]);rad.push(.16*(1-t*.7)+.05*Math.exp(-t*12))}rootsFrom(W,rad[0],'birch',[1.25,.62]);tubePath(W,pts,rad,8,[1.35,.78]);p=pts[N]}
for(let i=0;i<7;i++){const y=3.2+R()*4.2,f=y/p[1];grow(W,L,[p[0]*f,y,p[2]*f],dirA(R()*6.283,.5+R()*.4),.9+R()*.5,.05,0,4,o)}
grow(W,L,p,[0,1,0],.9,.05,0,3,o);const B=gaGeo(BLG);BLG=null;return[gaGeo(W),gaGeo(L),B]}
function shrubTreeJs(){BLG=GA();BLG.bcol=[1,.9,.6];const W=GA(),L=GA(),ctr=[0,.7,0,1.1],o={cards:3,size:.5,c0:[.66,.72,.6],c1:[1.15,1.15,1],ctr,droop:.1,bias:.05};rootsFrom(W,.055,'shrub',[1,.35]);
for(let i=0;i<7;i++)grow(W,L,[0,0,0],dirA(i/7*6.283+R()*.8,.7+R()*.5),.55+R()*.25,.025,0,3,o);const B=gaGeo(BLG);BLG=null;return[gaGeo(W),gaGeo(L),B]}
/* pine: conical crown, drooping whorl branches with needle sprays attached along the wood, thin leader on top */
function pineBranch(W,L,b,d,Rr,t,cbb){const cb=cbb||[1,1,1],dl=Math.hypot(d[0],d[1],d[2])||1,dd=[d[0]/dl,d[1]/dl,d[2]/dl],len=Rr,p1=[b[0]+dd[0]*len*.6,b[1]+dd[1]*len*.6,b[2]+dd[2]*len*.6],d2=[dd[0],dd[1]+.35,dd[2]],l2=Math.hypot(d2[0],d2[1],d2[2]),p2=[p1[0]+d2[0]/l2*len*.4,p1[1]+d2[1]/l2*len*.4,p1[2]+d2[2]/l2*len*.4];
tube(W,b,p1,.05*(1-t*.5)+.015,.035,4,[1,.5]);tube(W,p1,p2,.035,.015,4,[1,.5]);
(DQ.leaf>1.3?[.25,.45,.62,.8,1]:DQ.leaf<.8?[.6,1]:[.4,.75,1]).forEach(s=>{const A=s<=.6?[b,p1,s/.6]:[p1,p2,(s-.6)/.4],pos=[A[0][0]+(A[1][0]-A[0][0])*A[2],A[0][1]+(A[1][1]-A[0][1])*A[2],A[0][2]+(A[1][2]-A[0][2])*A[2]];
(DQ.leaf>1.3?[-.75,-.3,.3,.75]:[-.6,.6]).forEach(yw=>{const c1=Math.cos(yw),s1=Math.sin(yw),dir=[dd[0]*c1-dd[2]*s1,dd[1]*.4+.05,dd[0]*s1+dd[2]*c1];strip(L,pos,dir,(1.25-.6*s)*(.55+.45*(1-t))+.3,.5+.3*(1-t),.55,[(.7+R()*.3)*cb[0],(.78+R()*.3)*cb[1],(.7+R()*.2)*cb[2]],2)})})}
function pineTree(){const W=GA(),L=GA(),H=12+R()*3,lx=(R()-.5)*.5,lz=(R()-.5)*.5,tx=y=>lx*(y/H)*(y/H)*H*.14,tz=y=>lz*(y/H)*(y/H)*H*.14;let p=[0,0,0];{const pts=[],rad=[],N=18;for(let i=0;i<=N;i++){const t=i/N,y=H*t;pts.push([tx(y),y,tz(y)]);rad.push(.36*(1-t*.93)+.03+.2*Math.exp(-t*16))}rootsFrom(W,rad[0],'pine',[1.5,.5]);tubePath(W,pts,rad,10,[1.8,.72]);p=pts[N]}
const nW=Math.round(H*1.55);for(let k=0;k<nW;k++){const t=k/(nW-1),y=2.4+t*(H-2.9),Rr=(2.5*Math.pow(1-t,.85)+.2)*(.88+R()*.24),nb=Math.max(3,Math.round(7*(1-t*.55)));
for(let j=0;j<nb;j++){const a=j/nb*6.283+k*1.13+R()*.5;pineBranch(W,L,[tx(y),y,tz(y)],[Math.cos(a),-.32+t*.6,Math.sin(a)],Rr,t)}}
for(let j=0;j<7;j++){const a=j/7*6.283;strip(L,[p[0],H,p[2]],[Math.cos(a)*.4,1,Math.sin(a)*.4],.9,.32,.15,[.9,1,.8],2)}return[gaGeo(W),gaGeo(L)]}
/* palm: curved ringed trunk, crownshaft, arching fronds with real leaflets along the midrib, dead hanging fronds, coconuts */
function frond(L,W,b,a,e,len,dead,sc){sc=sc||1;const ca=Math.cos(a),sa=Math.sin(a),ce=Math.cos(e),se=Math.sin(e),g=dead?1.5:1.05,N=dead?11:20,pos=t=>[b[0]+ca*ce*len*t,b[1]+se*len*t-g*len*t*t*.5,b[2]+sa*ce*len*t];
tubePath(W,Array.from({length:7},(_,i)=>pos(i/6)),Array.from({length:7},(_,i)=>(.05*(1-i/6*.7)+.01)*sc),5,[.3,.3]);
for(let i=1;i<=N;i++){const t=.1+.88*(i+(R()-.5)*.5)/N,P=pos(t),P2=pos(t+.02),Tx=P2[0]-P[0],Ty=P2[1]-P[1],Tz=P2[2]-P[2],tl=Math.hypot(Tx,Ty,Tz)||1,tx=Tx/tl,ty=Ty/tl,tz=Tz/tl,sl=Math.hypot(tz,tx)||1,Sx=-tz/sl,Sz=tx/sl,ll=((dead?.8:1.3)*Math.pow(Math.max(0,Math.sin(Math.min(1,t*1.08)*3.1416)),.55)*(.55+.45*(1-t*.5))+.14)*(.85+R()*.3)*sc;
[-1,1].forEach(sd=>{const yaw=(R()-.5)*.35,cw=Math.cos(yaw),sw=Math.sin(yaw),dx0=Sx*sd*.8+tx*.55,dz0=Sz*sd*.8+tz*.55,dy1=ty*.55-.35-t*.15+(R()-.5)*.2;
strip(L,P,[dx0*cw-dz0*sw,dy1,dx0*sw+dz0*cw],ll,(.1+R()*.03)*sc,ll*(.35+R()*.25),dead?[.9,.65,.35]:[.7+R()*.3,.85+R()*.15,.55],2)})}}
function palmTree(){const W=GA(),L=GA(),Hh=8+R()*2,lean=.7+R()*1.2,la=R()*6.283,lx=Math.cos(la)*lean,lz=Math.sin(la)*lean;let p=[0,0,0];{const pts=[],rad=[],N=26,ph=R()*6;for(let i=0;i<=N;i++){const t=i/N;pts.push([lx*t*t+Math.sin(t*5+ph)*.07,Hh*t,lz*t*t+Math.cos(t*4+ph)*.07]);rad.push(.3*(1-t*.45)+.16*Math.exp(-t*14))}rootsFrom(W,rad[0],'palm',[1,.14]);tubePath(W,pts,rad,10,[1,.14]);p=pts[N]}
const top=p,tp=[top[0],top[1]+.7,top[2]];tube(W,top,tp,.2,.16,7,[1,1]);
for(let f=0;f<15;f++){const dead=f>=12;frond(L,W,[tp[0],tp[1]-.1,tp[2]],f*2.4+R()*.25,dead?-.7:.75-(f%4)*.12+(R()-.5)*.15,(dead?2.4:3.4)+R(),dead)}
for(let k=0;k<5;k++){const a=R()*6.283,c=Math.cos(a),s=Math.sin(a);tube(W,[top[0]+c*.22,top[1]+.3,top[2]+s*.22],[top[0]+c*.3,top[1]+.05,top[2]+s*.3],.13,.13,6,[.2,.2])}return[gaGeo(W),gaGeo(L)]}
function leafletTex(){const[c,x]=cv2(32,128),g=x.createLinearGradient(0,128,0,0);g.addColorStop(0,'#2f4a16');g.addColorStop(1,'#6f9a2c');x.fillStyle=g;x.beginPath();x.moveTo(16,128);x.bezierCurveTo(28,90,26,30,16,2);x.bezierCurveTo(6,30,4,90,16,128);x.fill();x.strokeStyle='rgba(210,230,140,.55)';x.lineWidth=1.5;x.beginPath();x.moveTo(16,126);x.lineTo(16,6);x.stroke();return mkTex(c)}
const LLT=leafletTex();
const LEAF_PBR={generic:{nm:normFrom(LFT.image,1.05),rm:roughTex(LFT.image,.82)},oak:{nm:normFrom(OAKL.image,.9),rm:roughTex(OAKL.image,.84)},birch:{nm:normFrom(BIRL.image,.8),rm:roughTex(BIRL.image,.82)},shrub:{nm:normFrom(SHRL.image,.85),rm:roughTex(SHRL.image,.86)},acacia:{nm:normFrom(ACAL.image,.8),rm:roughTex(ACAL.image,.88)},sage:{nm:normFrom(SAGL.image,.8),rm:roughTex(SAGL.image,.9)},ash:{nm:normFrom(ASHL.image,.8),rm:roughTex(ASHL.image,.85)},needle:{nm:normFrom(NDT.image,.9),rm:roughTex(NDT.image,.9)},palm:{nm:normFrom(LLT.image,.75),rm:roughTex(LLT.image,.88)},petal:{nm:normFrom(PTT.image,.38),rm:roughTex(PTT.image,.72)}};
/* rocks: convex fracture planes (soft-min) + multi-octave noise + strata, moss on upward faces */
function smoothNormals(g){const p=g.attributes.position,n=p.count,key=i=>Math.round(p.getX(i)*1e4)+','+Math.round(p.getY(i)*1e4)+','+Math.round(p.getZ(i)*1e4),acc=new Map();
for(let i=0;i<n;i+=3){const ax=p.getX(i),ay=p.getY(i),az=p.getZ(i),ux=p.getX(i+1)-ax,uy=p.getY(i+1)-ay,uz=p.getZ(i+1)-az,vx=p.getX(i+2)-ax,vy=p.getY(i+2)-ay,vz=p.getZ(i+2)-az,nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;for(let k=0;k<3;k++){const kk=key(i+k),a=acc.get(kk)||[0,0,0];a[0]+=nx;a[1]+=ny;a[2]+=nz;acc.set(kk,a)}}
const out=new Float32Array(n*3);for(let i=0;i<n;i++){const a=acc.get(key(i)),l=Math.hypot(a[0],a[1],a[2])||1;out[i*3]=a[0]/l;out[i*3+1]=a[1]/l;out[i*3+2]=a[2]/l}g.setAttribute('normal',new THREE.BufferAttribute(out,3))}
function rockGJs(pk){const mm=pk=='basalt'?0:pk=='sand'?.25:1,pm=pk=='sand'?[1.4,.98,.68]:pk=='basalt'?[.34,.33,.34]:[1,1,1],planes=Array.from({length:(pk=='basalt'?9:6)+(R()*3|0)},()=>{const a=R()*6.283,b=Math.acos(R()*2-1);return[Math.sin(b)*Math.cos(a),Math.cos(b),Math.sin(b)*Math.sin(a),.5+R()*.4]});
const ph=R()*10,sx=.95+R()*.4,sy=.55+R()*.35,sz=.8+R()*.4,n3=(x,y,z)=>Math.sin(x*2.3+1.3+ph)*Math.sin(y*2.9+2.1+ph*.7)*Math.sin(z*2.1+3.3-ph*.5);
const rad=(x,y,z)=>{const l=Math.hypot(x,y,z)||1;x/=l;y/=l;z/=l;let s=0;for(const[a,b,c,o]of planes){const d=a*x+b*y+c*z;if(d>.05)s+=Math.exp(-10*(o/d))}const r=s>0?Math.min(1.15,-Math.log(s)/10):1.1;return r*(1+.1*n3(x*2.2,y*2.2,z*2.2)+.05*n3(x*5,y*5,z*5)+.02*n3(x*11,y*11,z*11)+.012*n3(x*23,y*23,z*23)+.015*Math.sin(y*18+n3(x,y,z)*4))};
const pos=(x,y,z)=>{const l=Math.hypot(x,y,z)||1,r=rad(x,y,z);return[x/l*r*sx,y/l*r*sy+.45,z/l*r*sz]};
const NU=Math.round((pk?32:40)*DQ.rock),NV=Math.round((pk?20:26)*DQ.rock),P=[],Nm=[],C=[],T=[],I=[],e=.012;
for(let j=0;j<=NV;j++){const th=j/NV*Math.PI,st=Math.sin(th),ct=Math.cos(th);for(let i=0;i<=NU;i++){const f=i/NU*6.2832,sf=Math.sin(f),cf=Math.cos(f),d=[st*cf,ct,st*sf],e1=[ct*cf,-st,ct*sf],e2=[-sf,0,cf];
const pa=pos(d[0]+e1[0]*e,d[1]+e1[1]*e,d[2]+e1[2]*e),pb=pos(d[0]-e1[0]*e,d[1]-e1[1]*e,d[2]-e1[2]*e),pc=pos(d[0]+e2[0]*e,d[1]+e2[1]*e,d[2]+e2[2]*e),pd=pos(d[0]-e2[0]*e,d[1]-e2[1]*e,d[2]-e2[2]*e),p=pos(d[0],d[1],d[2]);
const u=[pa[0]-pb[0],pa[1]-pb[1],pa[2]-pb[2]],v=[pc[0]-pd[0],pc[1]-pd[1],pc[2]-pd[2]];let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const nl=Math.hypot(n[0],n[1],n[2]);
n=nl<1e-9?[d[0],d[1],d[2]]:[n[0]/nl,n[1]/nl,n[2]/nl];if(n[0]*p[0]+n[1]*(p[1]-.45)+n[2]*p[2]<0)n=[-n[0],-n[1],-n[2]];
P.push(p[0],p[1],p[2]);Nm.push(n[0],n[1],n[2]);T.push(i/NU,j/NV);
const x=p[0],y=p[1],z=p[2],nn=.5+.5*n3(x*3,y*3,z*3),bd=.5+.5*Math.sin(y*16+n3(x*2,y*2,z*2)*3),lc=.5+.5*n3(x*10,y*10,z*10),m=Math.max(0,n[1]-.55)*2.2*(.5+.5*nn)*(.5+.5*lc)*mm,q=.44+.12*nn+(pk=='sand'?.17:.07)*bd+.05*cl((y+.4)/1.6,0,1);
C.push(((q+.025)*(1-m)+.17*m)*pm[0],((q+.008)*(1-m)+.27*m)*pm[1],((q-.02)*(1-m)+.09*m)*pm[2])}}
for(let j=0;j<NV;j++)for(let i=0;i<NU;i++){const a=j*(NU+1)+i,b=a+1,c=a+NU+1,d=c+1;if(j>0)I.push(a,b,c);if(j<NV-1)I.push(b,d,c)}
const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(Nm,3));g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(T,2));g.setIndex(I);return g}
/* ===== biome species: spruce / mountain pine / juniper (alpine), cacti / acacia / joshua / agave / sage (desert), burnt tree / tree fern / fern / ash shrub (volcanic) ===== */
const ribF=n=>th=>1+.09*Math.cos(th*n);
function spruceTree(){const W=GA(),L=GA(),H=15+R()*4,lx=(R()-.5)*.4,lz=(R()-.5)*.4,tx=y=>lx*(y/H)*(y/H)*H*.14,tz=y=>lz*(y/H)*(y/H)*H*.14;let p;
{const pts=[],rad=[],N=20;for(let i=0;i<=N;i++){const t=i/N,y=-.3+(H+.3)*t;pts.push([tx(y),y,tz(y)]);rad.push(.34*(1-t*.94)+.025+.16*Math.exp(-t*16))}rootsFrom(W,rad[0],'spruce',[1.8,.52]);tubePath(W,pts,rad,10,[2.2,.68]);p=pts[N]}
const nW=Math.round(H*1.45);for(let k=0;k<nW;k++){const t=k/(nW-1),y=1.8+t*(H-2.3),Rr=(1.55*Math.pow(1-t,.8)+.16)*(.88+R()*.24),nb=Math.max(4,Math.round(7*(1-t*.5)));
for(let j=0;j<nb;j++){const a=j/nb*6.283+k*1.7+R()*.5;pineBranch(W,L,[tx(y),y,tz(y)],[Math.cos(a),-.55+t*.45,Math.sin(a)],Rr,t,[.5,.66,.6])}}
for(let j=0;j<8;j++){const a=j/8*6.283;strip(L,[p[0],H,p[2]],[Math.cos(a)*.3,1,Math.sin(a)*.3],1.1,.3,.1,[.5,.66,.58],2)}return[gaGeo(W),gaGeo(L)]}
function krummTree(){const W=GA(),L=GA(),lean=R()*6.283,lc=Math.cos(lean),ls=Math.sin(lean),cx=t=>lc*1.3*t*t+Math.sin(t*6)*.15,cz=t=>ls*1.3*t*t+Math.cos(t*5)*.15;let p;
{const pts=[],rad=[],N=10;for(let i=0;i<=N;i++){const t=i/N;pts.push([cx(t),2.6*t,cz(t)]);rad.push(.2*(1-t*.8)+.06*Math.exp(-t*8))}rootsFrom(W,rad[0],'krumm',[1,.6]);tubePath(W,pts,rad,8,[1,.6]);p=pts[N]}
for(let k=0;k<9;k++){const t=.25+k/9*.7,a=lean+(R()-.5)*2.4;pineBranch(W,L,[cx(t),2.6*t,cz(t)],[Math.cos(a),-.1+(R()-.5)*.3,Math.sin(a)],1.1*(1-t*.4),t*.6,[.62,.78,.62])}
for(let j=0;j<6;j++){const a=j/6*6.283;strip(L,p,[Math.cos(a)*.5,.9,Math.sin(a)*.5],.7,.25,.1,[.65,.8,.65],2)}return[gaGeo(W),gaGeo(L)]}
function juniperTree(){const W=GA(),L=GA();rootsFrom(W,.08,'juniper',[1,.55]);for(let i=0;i<11;i++){const a=i/11*6.283+R()*.4;pineBranch(W,L,[0,.05,0],[Math.cos(a),.12+R()*.3,Math.sin(a)],1.3+R()*.7,.85,[.42,.58,.52])}return[gaGeo(W),gaGeo(L)]}
function saguaroTree(){const W=GA(),Hh=5.5+R()*3;
{const pts=[],rad=[],N=14;for(let i=0;i<=N;i++){const t=i/N;pts.push([Math.sin(t*2)*.05,Hh*t,0]);rad.push(.42*(1-t*.12)*(i==0?1.12:1))}
for(let k=1;k<=3;k++){const ph=k/3*1.35;pts.push([0,Hh+.42*Math.sin(ph)*.8,0]);rad.push(.42*.88*Math.cos(ph))}rootsFrom(W,rad[0],'cactus',[1,.22]);tubePath(W,pts,rad,36,[1,.22],ribF(12))}
const na=2+(R()*3|0);for(let i=0;i<na;i++){const a=R()*6.283,y0=Hh*(.3+R()*.4),out=1+R()*.9,up=1.2+R()*1.8,ca=Math.cos(a),sa=Math.sin(a),rho=.65,q=[],pts=[],rad=[];
for(let s=0;s<=4;s++)q.push([out*s/4,y0]);for(let k=1;k<=6;k++){const ph=k/6*1.5708;q.push([out+rho*Math.sin(ph),y0+rho*(1-Math.cos(ph))])}for(let s=1;s<=4;s++)q.push([out+rho,y0+rho+up*s/4]);
q.forEach((c,j)=>{pts.push([ca*c[0],c[1],sa*c[0]]);rad.push(.27*(1-j/q.length*.2))});
const e=pts[pts.length-1];for(let k=1;k<=3;k++){const ph=k/3*1.35;pts.push([e[0],e[1]+.27*Math.sin(ph)*.8,e[2]]);rad.push(.27*.8*Math.cos(ph))}tubePath(W,pts,rad,24,[1,.22],ribF(8))}
return gaGeo(W)}
function barrelTree(){const W=GA(),R0=.45+R()*.25,N=12,pts=[],rad=[];for(let i=0;i<=N;i++){const t=i/N;pts.push([0,R0*1.5*t,0]);rad.push(R0*Math.pow(Math.sin(Math.PI*(.08+.84*t)),.55))}rootsFrom(W,rad[0],'cactus',[1,.5]);tubePath(W,pts,rad,32,[1,.5],ribF(16));return gaGeo(W)}
const rot3=(v,tl,yw)=>{let x=v[0],y=v[1],z=v[2];const c=Math.cos(tl),s=Math.sin(tl),y1=y*c-z*s,z1=y*s+z*c,c2=Math.cos(yw),s2=Math.sin(yw);return[x*c2+z1*s2,y1,-x*s2+z1*c2]};
function padG(g,c,sx,sy,tl,yw){const th=.07*sx*1.6,NI=10,NJ=6,o=g.P.length/3;for(let j=0;j<=NJ;j++){const ph=-1.5708+j/NJ*3.1416;for(let i=0;i<=NI;i++){const t=i/NI*6.2832,a=Math.cos(ph)*Math.cos(t),b=Math.sin(ph),d=Math.cos(ph)*Math.sin(t),p=rot3([a*sx,b*sy+sy,d*th],tl,yw),n=rot3([a/sx,b/sy,d/th],tl,yw),nl=Math.hypot(n[0],n[1],n[2])||1;gaV(g,[c[0]+p[0],c[1]+p[1],c[2]+p[2]],[n[0]/nl,n[1]/nl,n[2]/nl],[1,1,1],[i/NI*2,j/NJ*2])}}
for(let j=0;j<NJ;j++)for(let i=0;i<NI;i++){const a=o+j*(NI+1)+i,b=a+1,cc=a+NI+1,d=cc+1;g.I.push(a,cc,b,b,cc,d)}}
function pricklyTree(){const g=GA();function rec(c,tl,yw,s,d){padG(g,c,.55*s,.7*s,tl,yw);if(d>0){const n=2+(R()*2|0);for(let i=0;i<n;i++){const e=rot3([(R()-.5)*.8*.55*s,.7*s*2*.93,0],tl,yw);rec([c[0]+e[0],c[1]+e[1],c[2]+e[2]],tl+(R()-.5)*1.2,yw+(R()-.5)*1.6,s*.86,d-1)}}}rootsFrom(g,.24,'cactus',[1,.5]);rec([0,-.05,0],(R()-.5)*.5,R()*6.283,1,2);return gaGeo(g)}
function acaciaTreeJs(){const W=GA(),L=GA(),ctr=[0,5,0,6],o={cards:5,size:.85,c0:[.7,.75,.5],c1:[1.2,1.2,.85],ctr,droop:.15,bias:-.04};let p;
{const pts=[],rad=[],N=12,wx=(R()-.5)*.8,wz=(R()-.5)*.8;for(let i=0;i<=N;i++){const t=i/N;pts.push([wx*t*t*1.5,-.2+3.8*t,wz*t*t*1.5]);rad.push(.38*(1-t*.55)+.2*Math.exp(-t*9))}rootsFrom(W,rad[0],'acacia',[2,.4]);tubePath(W,pts,rad,9,[2,.4]);p=pts[N]}
const n=3+(R()*3|0);for(let i=0;i<n;i++){const a=i/n*6.283+R()*.8,e=.18+R()*.28;grow(W,L,[p[0],p[1]-.2-R()*.3,p[2]],dirA(a,e),2.3+R()*.8,.16+R()*.04,0,4,o)}return[gaGeo(W),gaGeo(L)]}
function joshuaTree(){const W=GA(),L=GA(),tips=[];function br(p,d,len,r,dep){const q=[p[0]+d[0]*len,p[1]+d[1]*len,p[2]+d[2]*len];tube(W,p,q,r,r*.8,7,[1,.3]);if(dep==0){tips.push([q,d]);return}for(let i=0;i<2;i++){let nd=[d[0]+(R()-.5)*1.3,d[1]*.8+.55,d[2]+(R()-.5)*1.3];const nl=Math.hypot(nd[0],nd[1],nd[2])||1;nd=nd.map(v=>v/nl);br(q,nd,len*.72,r*.72,dep-1)}}
let p;{const pts=[],rad=[],N=8,wx=(R()-.5)*.5,wz=(R()-.5)*.5;for(let i=0;i<=N;i++){const t=i/N;pts.push([wx*t,-.2+2.6*t,wz*t]);rad.push(.28*(1-t*.3)+.12*Math.exp(-t*10))}rootsFrom(W,rad[0],'joshua',[1,.3]);tubePath(W,pts,rad,9,[1,.3]);p=pts[N]}
for(let i=0;i<3;i++){const a=i*2.1+R()*.6;br(p,[Math.cos(a)*.7,.75,Math.sin(a)*.7],1.1,.2,2)}
tips.forEach(([q,d])=>{for(let k=0;k<46;k++){const a=R()*6.283,e=.2+R()*1.1;strip(L,q,[Math.cos(a)*Math.cos(e),Math.sin(e),Math.sin(a)*Math.cos(e)],.55+R()*.35,.045,.08,[.45+R()*.2,.62+R()*.2,.4],1)}for(let k=0;k<14;k++){const a=R()*6.283;strip(L,q,[Math.cos(a)*.5,-.9,Math.sin(a)*.5],.5+R()*.25,.04,.02,[.5,.4,.25],1)}});return[gaGeo(W),gaGeo(L)]}
function agaveTree(){const W=GA(),L=GA();rootsFrom(W,.16,'agave',[1,.5]);for(let k=0;k<24;k++){const a=k*2.4+R()*.2,f=k/24,e=.15+.95*Math.pow(f,.7);strip(L,[0,.05,0],[Math.cos(a)*Math.cos(e),Math.sin(e),Math.sin(a)*Math.cos(e)],.85+(1-f)*.5+R()*.2,.17,.3+(1-f)*.3,[.5+R()*.15,.72+R()*.12,.68],2)}return[gaGeo(W),gaGeo(L)]}
function sageTree(){const W=GA(),L=GA(),ctr=[0,.6,0,1],o={cards:3,size:.42,c0:[.6,.68,.5],c1:[1.05,1.08,.85],ctr,droop:.08,bias:.08};rootsFrom(W,.05,'shrub',[1,.35]);for(let i=0;i<9;i++)grow(W,L,[0,0,0],dirA(i/9*6.283+R()*.7,.8+R()*.45),.5+R()*.2,.02,0,3,o);return[gaGeo(W),gaGeo(L)]}
function ashBushTreeJs(){const W=GA(),L=GA(),ctr=[0,.6,0,1],o={cards:1,size:.34,c0:[.4,.44,.36],c1:[.75,.78,.62],ctr,droop:.1,bias:.1};rootsFrom(W,.05,'shrub',[1,.35]);for(let i=0;i<8;i++)grow(W,L,[0,0,0],dirA(i/8*6.283+R()*.8,.9+R()*.5),.55+R()*.25,.02,0,3,o);return[gaGeo(W),gaGeo(L)]}
function deadTree(){const W=GA(),H=7+R()*5,lx=(R()-.5)*.6,lz=(R()-.5)*.6,px=t=>lx*Math.sin(t*2.2),pz=t=>lz*Math.sin(t*2.2);
{const pts=[],rad=[],N=16;for(let i=0;i<=N;i++){const t=i/N;pts.push([px(t),-.3+(H+.3)*t*.97,pz(t)]);rad.push(.34*(1-t*.8)+.16*Math.exp(-t*12))}rootsFrom(W,rad[0],'deadtree',[2,.4]);tubePath(W,pts,rad,9,[2,.4])}
function db(p,d,len,r,dep){const q=[p[0]+d[0]*len,p[1]+d[1]*len,p[2]+d[2]*len];tube(W,p,q,r,r*.6,5,[1,.3]);if(dep>0)for(let i=0;i<(R()<.6?2:1);i++){const s=.4+R()*.5;let nd=[d[0]+(R()-.5)*1.2,d[1]+(R()-.5)*.6,d[2]+(R()-.5)*1.2];const nl=Math.hypot(nd[0],nd[1],nd[2])||1;db([p[0]+(q[0]-p[0])*s,p[1]+(q[1]-p[1])*s,p[2]+(q[2]-p[2])*s],nd.map(v=>v/nl),len*.6,r*.6,dep-1)}}
const nb=4+(R()*4|0);for(let i=0;i<nb;i++){const t=.3+R()*.6;db([px(t),-.3+(H+.3)*t*.97,pz(t)],dirA(R()*6.283,.2+R()*.7),1.5+R()*1.5,.1*(1-t*.5)+.03,2)}return gaGeo(W)}
function treeFernTree(){const W=GA(),L=GA(),Hh=2+R()*1.6;let p;{const pts=[],rad=[],N=10,lx=(R()-.5)*.6,lz=(R()-.5)*.6;for(let i=0;i<=N;i++){const t=i/N;pts.push([lx*t*t,-.1+Hh*t,lz*t*t]);rad.push(.16*(1-t*.2)+.05*Math.exp(-t*10))}rootsFrom(W,rad[0],'treefern',[1,.3]);tubePath(W,pts,rad,8,[1,.3]);p=pts[N]}
for(let f=0;f<13;f++)frond(L,W,[p[0],p[1],p[2]],f*2.4+R()*.25,.55+(f%3)*.18+(R()-.5)*.15,1.9+R()*.8,false,.5);return[gaGeo(W),gaGeo(L)]}
function fernTree(){const W=GA(),L=GA();for(let f=0;f<10;f++)frond(L,W,[0,.03,0],f*2.4+R()*.3,.5+R()*.9,.9+R()*.5,false,.32);return[gaGeo(W),gaGeo(L)]}
/* buildings: textured walls, roofs, concrete bases, lit windows at night */
const FND=[.42,.42,.44],CON=[.5,.5,.52],DRK=[.22,.22,.24];
const houseW=mergeG([[bxT(6,6,6,9,9).translate(0,3,0),shd,UB]]);
const houseR=(()=>{const g=GA(),e=3.65,y0=6,yr=8.3,rz=1.3,L=Math.hypot(e,yr-y0),Lf=Math.hypot(e-rz,yr-y0),T=2.8;
const face=(pts,uvs)=>{const a=pts[0],b=pts[1],c=pts[2],u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const l=Math.hypot(n[0],n[1],n[2])||1;n=n.map(q=>q/l);if(n[1]<0){n=n.map(q=>-q);pts=pts.length==4?[pts[0],pts[3],pts[2],pts[1]]:[pts[0],pts[2],pts[1]];uvs=uvs.length==4?[uvs[0],uvs[3],uvs[2],uvs[1]]:[uvs[0],uvs[2],uvs[1]]}pts.length==4?gaQ(g,pts,n,[1,1,1],uvs):gaT(g,pts,n,[1,1,1],uvs)};
face([[-e,y0,-e],[-e,y0,e],[0,yr,rz],[0,yr,-rz]],[[-e/T,0],[e/T,0],[rz/T,L/T],[-rz/T,L/T]]);
face([[e,y0,e],[e,y0,-e],[0,yr,-rz],[0,yr,rz]],[[e/T,0],[-e/T,0],[-rz/T,L/T],[rz/T,L/T]]);
face([[-e,y0,e],[e,y0,e],[0,yr,rz]],[[-e/T,0],[e/T,0],[0,Lf/T]]);
face([[e,y0,-e],[-e,y0,-e],[0,yr,-rz]],[[e/T,0],[-e/T,0],[0,Lf/T]]);
return gaGeo(g)})();
const FAS=[.93,.92,.9];
const houseB=mergeG([[bx(6.4,2.7,6.4).translate(0,-1.15,0),flc(FND),UB],[bx(.85,3.4,.85).translate(1.9,6.9,-.9),flc([.5,.25,.2]),UB],[bx(1.05,.18,1.05).translate(1.9,8.7,-.9),flc([.4,.38,.36]),UB],
[bx(1.5,2.3,.1).translate(0,1.15,3.02),flc([.92,.9,.86]),UB],[bx(1.1,2.1,.14).translate(0,1.05,3.06),flc([.26,.16,.1]),UB],
[bx(2.3,.15,1.8).translate(0,2.7,4),flc([.3,.28,.26]),UB],[bx(.12,2.6,.12).translate(-1,1.3,4.75),flc(FAS),UB],[bx(.12,2.6,.12).translate(1,1.3,4.75),flc(FAS),UB],
[bx(2.3,.22,.9).translate(0,.11,3.6),flc(CON),UB],[bx(1.4,.05,6).translate(0,.025,7),flc([.55,.54,.52]),UB],
[bx(7.4,.2,.15).translate(0,5.95,3.65),flc(FAS),UB],[bx(7.4,.2,.15).translate(0,5.95,-3.65),flc(FAS),UB],[bx(.15,.2,7.4).translate(3.65,5.95,0),flc(FAS),UB],[bx(.15,.2,7.4).translate(-3.65,5.95,0),flc(FAS),UB],
[bx(.25,.22,2.7).translate(0,8.32,0),flc([.18,.17,.17]),UB]]);
const flatTop=(w,h,extra)=>mergeG([[bx(w+.4,2.7,w+.4).translate(0,-1.15,0),flc(FND),UB],[bx(w+.4,.5,w+.4).translate(0,h+.25,0),flc(CON),UB],[bx(2.2,1.2,2.2).translate(w*.18,h+1.1,-w*.18),flc(DRK),UB],[bx(1.2,.8,1.2).translate(-w*.2,h+.9,w*.2),flc(DRK),UB],...extra]);
const entr=w=>[[bx(3,.2,1.6).translate(0,3,w/2+.8),flc(CON),UB],[bx(.12,3,.12).translate(-1.4,1.5,w/2+1.5),flc([.7,.7,.72]),UB],[bx(.12,3,.12).translate(1.4,1.5,w/2+1.5),flc([.7,.7,.72]),UB],[bx(1.6,2.4,.1).translate(0,1.2,w/2+.03),flc([.07,.1,.14]),UB]];
const ledges=(w,h,fh,pr)=>{const a=[];for(let f=1;f*fh<h-.5;f++)a.push([bx(w+pr,.14,w+pr).translate(0,f*fh,0),flc(CON),UB]);a.push([bx(w+.9,.32,w+.9).translate(0,h-.16,0),flc([.62,.6,.58]),UB],[bx(w+.25,.9,w+.25).translate(0,.45,0),flc([.34,.34,.36]),UB]);return a};
const balc=w=>[-2,2].flatMap(x=>[1,2,3].flatMap(f=>[[bx(2.4,.16,1.3).translate(x,f*3-.06,w/2+.65),flc(CON),UB],[bx(2.4,.9,.05).translate(x,f*3+.45,w/2+1.28),flc([.25,.26,.28]),UB]]));
const pil=(w,h,r)=>[[-1,-1],[1,-1],[-1,1],[1,1]].map(([a,b])=>[bx(r,h,r).translate(a*w/2,h/2,b*w/2),flc([.55,.57,.6]),UB]);
const RFV=[RFT,roofTex(215,8,30),roofTex(24,34,24)];
const blockW=mergeG([[bxT(8,12,8,12,9).translate(0,6,0),shd,UB]]),blockB=flatTop(8,12,[...ledges(8,12,3,.3),...balc(8),...entr(8)]);
const midW=mergeG([[bxT(9,24,9,9,9).translate(0,12,0),shd,UB]]),midB=flatTop(9,24,[...ledges(9,24,3,.28),...pil(9,24,.5),...entr(9)]);
const towerW=mergeG([[bxT(6,48,6,9,9).translate(0,24,0),shd,UB],[bxT(4,6,4,9,9).translate(0,51,0),shd,UB]]),towerB=flatTop(6,48,[...ledges(6,48,6,.16),...pil(6,48,.3),...entr(6),[bx(4.4,.4,4.4).translate(0,54.2,0),flc(CON),UB],[co(.3,8,6).translate(0,58.4,0),flc([.6,.6,.62]),UB]]);
/* instancing */

const TV=(fn,wo,lo)=>[0,1,2].flatMap(v=>{const[a,b]=fn();return[[a,{...wo,vi:v,vn:3}],[b,{...lo,vi:v,vn:3}]]});
const TV3=(fn,wo,lo,bo)=>[0,1,2].flatMap(v=>{const[a,b,c]=fn();return[[a,{...wo,vi:v,vn:3}],[b,{...lo,vi:v,vn:3}],[c,{...bo,vi:v,vn:3}]]});
/* ===== grown flora: space colonisation lives in the engine =====
   The skeleton of every broadleaf tree comes from the C++ kernel, which grows
   it with attraction points (Runions et al. 2007), sizes the limbs with da
   Vinci's rule and hands back golden-angle leaf anchors. The JS side only turns
   those anchors into the same leaf cards the rest of the studio uses, so the
   materials, wind, shadows and instancing do not change at all. When the
   artifact is older than the kernel the original builders run instead and the
   trees are swapped in place as soon as the engine is ready. */
const GROWN_CFG={
 oak:{c0:[.66,.72,.6],c1:[1.15,1.15,1],ctr:[0,6,0,3.6],bcol:[1,.8,.88],petal:1},
 birch:{c0:[.6,.7,.5],c1:[1.3,1.25,.9],ctr:[0,6.5,0,2.4],bcol:[.96,.97,.82],petal:1},
 shrub:{c0:[.66,.72,.6],c1:[1.15,1.15,1],ctr:[0,.7,0,1.1],bcol:[1,.9,.6],petal:1},
 acacia:{c0:[.7,.75,.5],c1:[1.2,1.2,.85],ctr:[0,5,0,6],bcol:null,petal:0},
 ashbush:{c0:[.4,.44,.36],c1:[.75,.78,.62],ctr:[0,.6,0,1],bcol:null,petal:0},
 fern:{c0:[.44,.64,.3],c1:[.92,1.02,.55],ctr:[0,.28,0,.62],bcol:null,petal:0},
 treefern:{c0:[.38,.6,.26],c1:[.86,1.0,.5],ctr:[0,1.6,0,1.15],bcol:null,petal:0}
};
const GROWN_JOBS=[];
function grownTree(kind){
 const f=window.FELandscapeFlora;if(!f||typeof f.tree!=='function')return null;
 const cfg=GROWN_CFG[kind];if(!cfg)return null;
 const t=f.tree(kind);if(!t||!t.wood||!t.leaf||!t.leaf.length)return null;
 const L=GA(),a=t.leaf,st=t.leafStride||8;let B=null;
 for(let i=0;i+st<=a.length;i+=st){
  const b=[a[i]+(R()-.5)*.06,a[i+1]+(R()-.5)*.06,a[i+2]+(R()-.5)*.06];
  /* Cards inherit the compliance and phase of the twig they sit on, so a leaf
     cannot stay behind while its branch swings. Kernels older than the skeletal
     wind export eight floats per leaf and those two channels stay at zero. */
  L.sw=st>8?a[i+8]:0;L.phv=st>8?a[i+9]:0;
  lcard(L,b,[a[i+3],a[i+4],a[i+5]],a[i+6],cfg.c0,cfg.c1,cfg.ctr,a[i+7]);
  if(cfg.petal&&((i/st)|0)%2===0){if(!B){B=GA();B.bcol=cfg.bcol}petalCard(B,[b[0]+(R()-.5)*.25,b[1]+(R()-.5)*.25,b[2]+(R()-.5)*.25],a[i+6]*.3)}
 }
 L.sw=0;L.phv=0;
 return cfg.petal?[t.wood,gaGeo(L),B?gaGeo(B):gaGeo(L)]:[t.wood,gaGeo(L)];
}
function treeBuilder(kind,legacy,per){
 let job=GROWN_JOBS.find(j=>j.kind===kind);
 if(!job)GROWN_JOBS.push(job={kind,per:per||3,legacy,parts:[]});
 return ()=>{try{const g=grownTree(kind);if(g){if(job.parts.length<3)job.parts.push(g);return g}}catch(e){showErr('Grown '+kind+': '+e.message)}return legacy()};
}
const ROCK_GROWN={granite:'granite',sand:'sandstone',basalt:'basalt'};
function rockBuilder(pk){
 const key=pk||'rock',id=ROCK_GROWN[pk||'granite']||'granite';
 let job=GROWN_JOBS.find(j=>j.kind===key);
 if(!job)GROWN_JOBS.push(job={kind:key,per:1,rock:id,parts:[]});
 try{const f=window.FELandscapeFlora,g=f&&typeof f.rock==='function'?f.rock(id):null;if(g){job.parts.push(g);return g}}catch(e){showErr('Grown rock: '+e.message)}
 return rockGJs(pk);
}
/* Swap one InstancedMesh onto a grown geometry and keep the LOD twin, the
   selection bounds and the procedural caveat honest about the new mesh. */
function adoptGeometry(K,m,geo){
 if(!m||!geo)return;
 m.geometry=geo;
 if(m.userData&&m.userData.lodGeom)m.userData.lodGeom=geo;
 K.selectionBounds=null;K.selectionGrid=null;K.selectionGridDirty=true;
}
let grownTries=0;
function applyGrown(){
 if(!GROWN_JOBS.length)return;
 let pending=0;
 for(const job of GROWN_JOBS){
  const K=KIND[job.kind];if(!K||!K.meshes||!K.meshes.length)continue;
  if(job.rock){
   for(let v=0;v<3;v++){
    let g=job.parts[v];
    if(!g){const f=window.FELandscapeFlora;g=f&&typeof f.rock==='function'?f.rock(job.rock):null;if(g)job.parts[v]=g}
    if(!g){pending++;break}
    adoptGeometry(K,K.meshes[v],g);
   }
  }else{
   for(let v=0;v<3;v++){
    let parts=job.parts[v];
    if(!parts){parts=grownTree(job.kind);if(parts)job.parts[v]=parts}
    if(!parts){pending++;break}
    for(let s=0;s<job.per&&s<parts.length;s++)adoptGeometry(K,K.meshes[v*job.per+s],parts[s]);
   }
  }
  if(K.lowMeshes)K.lowMeshes.forEach((low,i)=>{const m=K.meshes[i];if(m)low.geometry=m.userData&&m.userData.lodGeom?m.userData.lodGeom:m.geometry});
 }
 if(pending&&grownTries++<4)setTimeout(()=>{try{applyGrown()}catch(e){showErr('Grown flora: '+e.message)}},500);
}
/* terrain-main-01 builds lazy species from other blocks; it calls back here so a
   species that appeared after the artifact finished loading is grown too. */
window.__feGrowSpecies=applyGrown;
try{const c=window.FELandscapeCore;if(c&&c.loading&&c.loading.then)c.loading.then(()=>{try{applyGrown()}catch(e){showErr('Grown flora: '+e.message)}})}catch(e){}
function buildEager(){mk('grass',105000,[[grassG,{std:1,ds:1,w:.11,fx:'gl',tk:25,lodGeom:grassLowG}]],false);
mk('flower',24000,[[stemG,{phys:1,roughness:.8,w:.09,nt:1,fx:'S',tk:25}],[fleafG,{map:LFT,cut:.3,ds:1,phys:1,nm:LEAF_PBR.generic.nm,ns:.32,rm:LEAF_PBR.generic.rm,roughness:.78,w:.09,fx:'S',tk:25}],[petG,{map:PTT,cut:.14,ds:1,phys:1,nm:LEAF_PBR.petal.nm,ns:.18,rm:LEAF_PBR.petal.rm,roughness:.74,clearcoat:.07,w:.09,pal:PALF,fx:'S',tk:25}],[centG,{phys:1,roughness:.72,w:.09,nt:1,fx:'S',tk:25}]],false);
mk('tallgrass',80000,[[tallGrassG,{std:1,ds:1,w:.14,fx:'gl',tk:22,lodGeom:tallGrassLowG}]],false);
mk('daisy',14000,flowerParts('daisy'),false);
mk('tulip',12000,flowerParts('tulip'),false);
mk('lavender',12000,flowerParts('lavender'),false);
mk('pine',2000,TV(pineTree,{map:BT.pine,w:.0016,nt:1,phys:1,roughness:.9,clearcoat:.035,nm:BN.pine,ns:.55,rm:BR.pine},{map:NDT,cut:.35,ds:1,phys:1,nm:LEAF_PBR.needle.nm,ns:.3,rm:LEAF_PBR.needle.rm,roughness:.76,w:.0016,wf:.02}),true);
mk('oak',1500,TV3(treeBuilder('oak',oakTreeJs,3),{map:BT.oak,w:.0015,nt:1,phys:1,roughness:.9,clearcoat:.035,nm:BN.oak,ns:.55,rm:BR.oak},{map:OAKL,cut:.38,ds:1,phys:1,nm:LEAF_PBR.oak.nm,ns:.28,rm:LEAF_PBR.oak.rm,roughness:.78,w:.0015,wf:.03,fx:'sa'},{map:PTT,cut:.14,ds:1,phys:1,nm:LEAF_PBR.petal.nm,ns:.2,rm:LEAF_PBR.petal.rm,roughness:.67,clearcoat:.15,w:.0015,wf:.03,fx:'b',nt:1}),true);
mk('birch',1500,TV3(treeBuilder('birch',birchTreeJs,3),{map:BT.birch,w:.0022,nt:1,phys:1,roughness:.9,clearcoat:.035,nm:BN.birch,ns:.55,rm:BR.birch},{map:BIRL,cut:.38,ds:1,phys:1,nm:LEAF_PBR.birch.nm,ns:.26,rm:LEAF_PBR.birch.rm,roughness:.78,w:.0022,wf:.04,fx:'sa'},{map:PTT,cut:.14,ds:1,phys:1,nm:LEAF_PBR.petal.nm,ns:.2,rm:LEAF_PBR.petal.rm,roughness:.67,clearcoat:.15,w:.0022,wf:.04,fx:'b',nt:1}),true);
mk('palm',1000,TV(palmTree,{map:BT.palm,w:.002,nt:1,phys:1,roughness:.9,clearcoat:.035,nm:BN.palm,ns:.55,rm:BR.palm},{map:LLT,cut:.32,ds:1,phys:1,nm:LEAF_PBR.palm.nm,ns:.25,rm:LEAF_PBR.palm.rm,roughness:.76,w:.0025,wf:.03}),true);
mk('shrub',4000,TV3(treeBuilder('shrub',shrubTreeJs,3),{map:BT.oak,w:.015,nt:1,phys:1,roughness:.9,clearcoat:.035,nm:BN.oak,ns:.55,rm:BR.oak,tk:8},{map:SHRL,cut:.35,ds:1,phys:1,nm:LEAF_PBR.shrub.nm,ns:.28,rm:LEAF_PBR.shrub.rm,roughness:.8,w:.015,wf:.025,fx:'sa',tk:8},{map:PTT,cut:.14,ds:1,phys:1,nm:LEAF_PBR.petal.nm,ns:.2,rm:LEAF_PBR.petal.rm,roughness:.67,clearcoat:.15,w:.015,wf:.025,fx:'b',nt:1,tk:8}),true);
mk('rock',1000,[0,1,2].map(v=>[rockBuilder(),{nt:1,std:1,vi:v,vn:3}]),true);KIND.rock.vr=.7;
mk('house',1500,[...[0,1,2].flatMap(v=>[[houseW,{pbr:HTV[v][2],map:HTV[v][0],em:HTV[v][1],bump:.5,vi:v,vn:3,sn:1,part:'wall'}],[houseR,{std:1,map:RFV[v],ds:1,bump:.8,vi:v,vn:3,sn:1,part:'roof'}]]),[houseB,{nt:1,sn:1,part:'base'}]],true);
mk('block',500,[[blockW,{pbr:AT[2],map:AT[0],em:AT[1],bump:.5,sn:1,part:'shell'}],[blockB,{nt:1,sn:1,part:'base'}]],true);
mk('mid',400,[[midW,{pbr:OT[2],map:OT[0],em:OT[1],bump:.5,sn:1,part:'shell'}],[midB,{nt:1,sn:1,part:'base'}]],true);
mk('tower',250,[[towerW,{pbr:GT[2],map:GT[0],em:GT[1],bump:.4,sn:1,part:'shell'}],[towerB,{nt:1,sn:1,part:'base'}]],true);
['house','block','mid','tower'].forEach(k=>KIND[k].vr=.08);}
buildEager();
const SX=(fn,o)=>[0,1,2].map(v=>[fn(),{...o,vi:v,vn:3}]);
const LZTK={sage:8,ashbush:8,juniper:8,krumm:3,agave:8,fern:12,treefern:2.5};
function lazyBuild(k){const[max,fn]=LZREG[k],parts=fn();parts.forEach(p=>{p[1].tk=LZTK[k]||1});mk(k,max,parts,true);KIND[k].vr=.35;KIND[k].tint=kt(k);if(mode=='wire')shade()}
const LZ=(k,max,fn)=>{LZREG[k]=[max,fn];LAZY[k]=()=>lazyBuild(k)};
const bk=(t,w,ns)=>({map:BT[t],w,nt:1,phys:1,roughness:.9,clearcoat:.035,nm:BN[t],ns:ns||.65,rm:BR[t]});
LZ('spruce',1500,()=>TV(spruceTree,bk('pine',.0014),{map:NDT,cut:.35,ds:1,phys:1,nm:LEAF_PBR.needle.nm,ns:.3,rm:LEAF_PBR.needle.rm,roughness:.76,w:.0014,wf:.02}));
LZ('krumm',1500,()=>TV(krummTree,bk('pine',.006),{map:NDT,cut:.35,ds:1,phys:1,nm:LEAF_PBR.needle.nm,ns:.3,rm:LEAF_PBR.needle.rm,roughness:.76,w:.006,wf:.02}));
LZ('juniper',3000,()=>TV(juniperTree,bk('pine',.01),{map:NDT,cut:.35,ds:1,phys:1,nm:LEAF_PBR.needle.nm,ns:.3,rm:LEAF_PBR.needle.rm,roughness:.76,w:.01,wf:0}));
LZ('saguaro',1200,()=>SX(saguaroTree,{map:BT.cactus,nt:1,std:1,nm:BN.cactus,ns:.65,rm:BR.cactus}));
LZ('barrel',2000,()=>SX(barrelTree,{map:BT.cactus,nt:1,std:1,nm:BN.cactus,ns:.65,rm:BR.cactus}));
LZ('prickly',2000,()=>SX(pricklyTree,{map:BT.cactus,nt:1,std:1,nm:BN.cactus,ns:.65,rm:BR.cactus}));
LZ('acacia',1200,()=>TV(treeBuilder('acacia',acaciaTreeJs,2),bk('oak',.002),{map:ACAL,cut:.35,ds:1,phys:1,nm:LEAF_PBR.acacia.nm,ns:.28,rm:LEAF_PBR.acacia.rm,roughness:.8,w:.002,wf:.03}));
LZ('joshua',1200,()=>TV(joshuaTree,bk('oak',.003),{map:LLT,cut:.32,ds:1,phys:1,nm:LEAF_PBR.palm.nm,ns:.25,rm:LEAF_PBR.palm.rm,roughness:.76,w:.003,wf:.02}));
LZ('agave',2000,()=>TV(agaveTree,bk('cactus',.004),{map:LLT,cut:.32,ds:1,phys:1,nm:LEAF_PBR.palm.nm,ns:.25,rm:LEAF_PBR.palm.rm,roughness:.76,w:.004}));
LZ('sage',3000,()=>TV(sageTree,bk('oak',.015),{map:SAGL,cut:.35,ds:1,phys:1,nm:LEAF_PBR.sage.nm,ns:.28,rm:LEAF_PBR.sage.rm,roughness:.82,w:.015,wf:.025}));
LZ('sandrock',800,()=>[0,1,2].map(v=>[rockBuilder('sand'),{nt:1,std:1,det:1,vi:v,vn:3}]));
LZ('basalt',1200,()=>[0,1,2].map(v=>[rockBuilder('basalt'),{nt:1,std:1,det:1,vi:v,vn:3}]));
LZ('deadtree',1200,()=>SX(deadTree,{map:BT.char,nt:1,std:1,nm:BN.char,ns:.65,rm:BR.char,w:.0016}));
LZ('ashbush',3000,()=>TV(treeBuilder('ashbush',ashBushTreeJs,2),bk('char',.015),{map:ASHL,cut:.35,ds:1,phys:1,nm:LEAF_PBR.ash.nm,ns:.28,rm:LEAF_PBR.ash.rm,roughness:.82,w:.015,wf:.025}));
/* Ferns are the grammar species: `fernTree`/`treeFernTree` stay as the fallback
   for an artifact without the kernel, but the fronds themselves are rewritten
   from production rules in C++. */
LZ('treefern',1500,()=>TV(treeBuilder('treefern',treeFernTree,2),bk('palm',.003),{map:LLT,cut:.32,ds:1,phys:1,nm:LEAF_PBR.palm.nm,ns:.25,rm:LEAF_PBR.palm.rm,roughness:.76,w:.003,wf:.03}));
LZ('fern',3000,()=>TV(treeBuilder('fern',fernTree,2),bk('palm',.01),{map:LLT,cut:.32,ds:1,phys:1,nm:LEAF_PBR.palm.nm,ns:.25,rm:LEAF_PBR.palm.rm,roughness:.76,w:.01,wf:.02}));
/* The build routines run inside this try-block, so their const textures
   are block scoped. Publish them so the realism module can re-synthesise
   bark / leaf micro-structure into the very same canvases the meshes use. */
window.__feLandscapeTex={BT,BN,BR,LEAF_PBR,LFT,OAKL,BIRL,SHRL};
}catch(e){MODELS_ERR=e;showErr('Models fallback: '+e.message);fallbackModels()}