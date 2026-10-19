import * as THREE from 'three';
import { CSG } from 'three-csg-ts';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sourceIndices = (geometry) => geometry.index?.array ?? Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);
const assertPositions = (geometry) => {
  const p = geometry?.attributes?.position;
  if (!p || p.itemSize < 3 || p.count < 3 || p.count % 3 !== 0 && !geometry.index) throw new Error('Modifier needs a non-empty triangle mesh');
  for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) throw new Error(`Mesh has a non-finite vertex at index ${i}`);
  return p;
};
const updateBounds = (g) => { g.computeBoundingBox(); g.computeBoundingSphere(); return g; };
const attrCtor = (attr, length) => new attr.array.constructor(length);
const writeAttribute = (geometry, name, values, itemSize, sourceAttr) => {
  const ArrayType = sourceAttr?.array?.constructor || Float32Array;
  geometry.setAttribute(name, new THREE.BufferAttribute(new ArrayType(values), itemSize, sourceAttr?.normalized || false));
};
function ensureNormalsAndUv(geometry) {
  const g = geometry.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}
function vertexKey(x, y, z, eps) { return `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`; }

export function validateClosedManifold(geometry, label = 'Mesh', epsilon) {
  const p = assertPositions(geometry), idx = sourceIndices(geometry);
  if (idx.length < 12 || idx.length % 3) throw new Error(`${label} must be a closed manifold with at least four triangles`);
  const box = geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox);
  const diag = box ? box.getSize(new THREE.Vector3()).length() : 1;
  const eps = epsilon ?? Math.max(diag * 1e-7, 1e-9);
  const canonical = new Uint32Array(p.count), ids = new Map();
  let next = 0;
  for (let i = 0; i < p.count; i++) {
    const key = vertexKey(p.getX(i), p.getY(i), p.getZ(i), eps);
    if (!ids.has(key)) ids.set(key, next++);
    canonical[i] = ids.get(key);
  }
  const edges = new Map(); let validTriangles = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a >= p.count || b >= p.count || c >= p.count) throw new Error(`${label} has an out-of-range triangle index`);
    const ax=p.getX(a),ay=p.getY(a),az=p.getZ(a),bx=p.getX(b),by=p.getY(b),bz=p.getZ(b),cx=p.getX(c),cy=p.getY(c),cz=p.getZ(c);
    const area2=Math.hypot((by-ay)*(cz-az)-(bz-az)*(cy-ay),(bz-az)*(cx-ax)-(bx-ax)*(cz-az),(bx-ax)*(cy-ay)-(by-ay)*(cx-ax));
    if (area2 <= eps * eps) continue;
    validTriangles++;
    for (const [u,v] of [[canonical[a],canonical[b]],[canonical[b],canonical[c]],[canonical[c],canonical[a]]]) {
      if (u === v) continue;
      const lo=Math.min(u,v),hi=Math.max(u,v),key=`${lo}:${hi}`,edge=edges.get(key)||{count:0,direction:0};
      edge.count++; edge.direction += u < v ? 1 : -1; edges.set(key,edge);
    }
  }
  if (validTriangles < 4) throw new Error(`${label} has too few non-degenerate triangles`);
  let open=0, nonManifold=0, inconsistent=0;
  for (const edge of edges.values()) { if (edge.count === 1) open++; else if (edge.count !== 2) nonManifold++; else if (edge.direction !== 0) inconsistent++; }
  if (open || nonManifold || inconsistent) throw new Error(`${label} must be a consistently oriented closed manifold (boundary edges: ${open}, non-manifold edges: ${nonManifold}, winding conflicts: ${inconsistent})`);
  return { triangles: validTriangles, edges: edges.size, vertices: next };
}

export function booleanGeometry(targetGeometry, operandGeometry, operandMatrixElements, operation = 'Difference') {
  const op = String(operation).toLowerCase();
  if (!['difference','union','intersect','intersection'].includes(op)) throw new Error(`Unsupported Boolean operation: ${operation}`);
  validateClosedManifold(targetGeometry, 'Boolean target');
  validateClosedManifold(operandGeometry, 'Boolean operand');
  const aGeo = ensureNormalsAndUv(targetGeometry), bGeo = ensureNormalsAndUv(operandGeometry);
  const material = new THREE.MeshBasicMaterial();
  const aMesh = new THREE.Mesh(aGeo, material), bMesh = new THREE.Mesh(bGeo, material);
  try {
    aMesh.updateMatrix();
    bMesh.matrix.fromArray(Array.from(operandMatrixElements || new THREE.Matrix4().elements));
    bMesh.matrixAutoUpdate = false;
    bMesh.updateMatrixWorld(true);
    const a = CSG.fromMesh(aMesh), b = CSG.fromMesh(bMesh);
    const result = op === 'difference' ? a.subtract(b) : op === 'union' ? a.union(b) : a.intersect(b);
    const geometry = CSG.toGeometry(result, new THREE.Matrix4());
    if (!geometry.attributes.position || geometry.attributes.position.count % 3 !== 0) throw new Error('Boolean solver returned invalid triangle geometry');
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const p = geometry.attributes.position;
      if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) { geometry.dispose(); throw new Error('Boolean solver returned non-finite vertices'); }
    }
    geometry.computeVertexNormals();
    return updateBounds(geometry);
  } catch (error) {
    throw new Error(`Boolean ${operation} failed: ${error?.message || error}`);
  } finally {
    aGeo.dispose(); bGeo.dispose(); material.dispose();
  }
}

export function arrayGeometry(geometry, { count = 2, offset = [1.8,0,0], relative = [0,0,0] } = {}) {
  const src = geometry.clone(), p = assertPositions(src), copies = clamp(Math.round(count), 1, 100);
  if (copies === 1) return src;
  src.computeBoundingBox(); const size=src.boundingBox.getSize(new THREE.Vector3());
  const step=[0,1,2].map(i=>(Number(offset[i])||0)+(Number(relative[i])||0)*size.getComponent(i));
  const attrs=Object.entries(src.attributes), result=new THREE.BufferGeometry();
  for (const [name,attr] of attrs) {
    const values=attrCtor(attr,attr.array.length*copies);
    for(let copy=0;copy<copies;copy++) for(let i=0;i<attr.count;i++) for(let c=0;c<attr.itemSize;c++) {
      let value=attr.array[i*attr.itemSize+c];
      if(name==='position'&&c<3) value+=step[c]*copy;
      values[copy*attr.array.length+i*attr.itemSize+c]=value;
    }
    result.setAttribute(name,new THREE.BufferAttribute(values,attr.itemSize,attr.normalized));
  }
  if(src.index) {
    const base=src.index.array, idx=new Uint32Array(base.length*copies);
    for(let copy=0;copy<copies;copy++) for(let i=0;i<base.length;i++) idx[copy*base.length+i]=base[i]+copy*p.count;
    result.setIndex(new THREE.BufferAttribute(idx,1));
  }
  for(let copy=0;copy<copies;copy++) for(const group of src.groups) result.addGroup(group.start+copy*(src.index?.count||p.count),group.count,group.materialIndex);
  return updateBounds(result);
}

export function weldGeometry(geometry, distance = 1e-5) {
  const p=assertPositions(geometry), eps=Math.max(Number(distance)||0,1e-9), idx=sourceIndices(geometry), attrs=Object.entries(geometry.attributes);
  const unique=[], map=new Map(), oldToNew=new Uint32Array(p.count), values=Object.fromEntries(attrs.map(([n])=>[n,[]]));
  for(let i=0;i<p.count;i++) {
    const key=vertexKey(p.getX(i),p.getY(i),p.getZ(i),eps); let id=map.get(key);
    if(id===undefined){id=unique.length;map.set(key,id);unique.push([p.getX(i),p.getY(i),p.getZ(i)]);for(const [name,a] of attrs)for(let c=0;c<a.itemSize;c++)values[name].push(a.array[i*a.itemSize+c]);}
    oldToNew[i]=id;
  }
  const outIdx=[];
  for(let i=0;i+2<idx.length;i+=3){const a=oldToNew[idx[i]],b=oldToNew[idx[i+1]],c=oldToNew[idx[i+2]];if(a!==b&&b!==c&&c!==a)outIdx.push(a,b,c)}
  if(!outIdx.length) throw new Error('Weld removed all non-degenerate faces');
  const out=new THREE.BufferGeometry();
  for(const [name,attr] of attrs)writeAttribute(out,name,values[name],attr.itemSize,attr);
  out.setIndex(new THREE.BufferAttribute(outIdx.length>65535?new Uint32Array(outIdx):new Uint16Array(outIdx),1));
  if(out.attributes.normal) out.deleteAttribute('normal');
  out.computeVertexNormals(); return updateBounds(out);
}

export function triangulateGeometry(geometry) {
  const idx=sourceIndices(geometry);if(idx.length%3)throw new Error('Triangulate needs complete triangles');
  const out=geometry.index?geometry.toNonIndexed():geometry.clone();if(!out.attributes.normal)out.computeVertexNormals();return updateBounds(out);
}

export function decimateGeometry(geometry, ratio = .5, maxFaces = 1200) {
  const g=weldGeometry(geometry,1e-7),p=g.attributes.position,idx=g.index.array;
  if(idx.length/3>maxFaces){g.dispose();throw new Error(`Decimate currently caps edge-collapse input at ${maxFaces} triangles; reduce source density first`)}
  const target=Math.max(1,Math.floor(idx.length/3*clamp(ratio,.01,1))),faces=[];for(let i=0;i<idx.length;i+=3)faces.push([idx[i],idx[i+1],idx[i+2]]);
  const attrs=Object.entries(g.attributes),arrays=Object.fromEntries(attrs.map(([name,a])=>[name,Array.from(a.array)]));
  while(faces.length>target){
    const edges=new Map();for(const tri of faces)for(const [a,b]of [[tri[0],tri[1]],[tri[1],tri[2]],[tri[2],tri[0]]]){const lo=Math.min(a,b),hi=Math.max(a,b),key=`${lo}:${hi}`,dx=arrays.position[lo*3]-arrays.position[hi*3],dy=arrays.position[lo*3+1]-arrays.position[hi*3+1],dz=arrays.position[lo*3+2]-arrays.position[hi*3+2],d=dx*dx+dy*dy+dz*dz;if(!edges.has(key)||d<edges.get(key).d)edges.set(key,{a:lo,b:hi,d})}
    const edge=[...edges.values()].sort((a,b)=>a.d-b.d)[0];if(!edge)break;const {a,b}=edge;
    for(const [name,attr]of attrs)for(let c=0;c<attr.itemSize;c++){const k=a*attr.itemSize+c,j=b*attr.itemSize+c;arrays[name][k]=(arrays[name][k]+arrays[name][j])*.5}
    for(let i=0;i<3;i++)arrays.position[a*3+i]=(arrays.position[a*3+i]+arrays.position[b*3+i])*.5;
    const kept=[];for(const tri of faces){for(let i=0;i<3;i++)if(tri[i]===b)tri[i]=a;if(new Set(tri).size===3)kept.push(tri)}
    if(kept.length===faces.length){active.add(b);break}faces.splice(0,faces.length,...kept);
  }
  if(!faces.length){g.dispose();throw new Error('Decimate collapsed the mesh to no triangles')}
  const remap=new Map(),out=new THREE.BufferGeometry(),values=Object.fromEntries(attrs.map(([name])=>[name,[]])),outIdx=[];
  for(const tri of faces)for(const old of tri){let id=remap.get(old);if(id===undefined){id=remap.size;remap.set(old,id);for(const [name,a]of attrs)for(let c=0;c<a.itemSize;c++)values[name].push(arrays[name][old*a.itemSize+c])}outIdx.push(id)}
  for(const [name,a]of attrs)if(name!=='normal')writeAttribute(out,name,values[name],a.itemSize,a);out.setIndex(new THREE.BufferAttribute(outIdx.length>65535?new Uint32Array(outIdx):new Uint16Array(outIdx),1));out.computeVertexNormals();g.dispose();return updateBounds(out);
}

export function mirrorGeometry(geometry, { axes = [true,false,false], clipping = false, mergeDistance = 1e-6 } = {}) {
  const src=geometry.clone(), p=assertPositions(src), idx=sourceIndices(src), enabled=axes.map(Boolean), flags=[];
  for(let bits=0;bits<(1<<enabled.filter(Boolean).length);bits++){const signs=[1,1,1];let j=0;for(let axis=0;axis<3;axis++)if(enabled[axis]){if(bits&(1<<j))signs[axis]=-1;j++}flags.push(signs)}
  const result=new THREE.BufferGeometry(), attrs=Object.entries(src.attributes);
  for(const [name,attr] of attrs){const values=attrCtor(attr,attr.array.length*flags.length);for(let k=0;k<flags.length;k++)for(let i=0;i<attr.count;i++)for(let c=0;c<attr.itemSize;c++){let v=attr.array[i*attr.itemSize+c];if(name==='position'&&c<3)v*=flags[k][c];else if(name==='normal'&&c<3)v*=flags[k][c];else if(name==='tangent'&&c<3)v*=flags[k][c];else if(name==='tangent'&&c===3)v*=flags[k][0]*flags[k][1]*flags[k][2];values[k*attr.array.length+i*attr.itemSize+c]=v}result.setAttribute(name,new THREE.BufferAttribute(values,attr.itemSize,attr.normalized))}
  const out=[];for(let k=0;k<flags.length;k++){const reflected=flags[k][0]*flags[k][1]*flags[k][2]<0;for(let i=0;i+2<idx.length;i+=3){const a=idx[i]+k*p.count,b=idx[i+1]+k*p.count,c=idx[i+2]+k*p.count;if(reflected)out.push(c,b,a);else out.push(a,b,c)}}
  result.setIndex(new THREE.BufferAttribute(out.length>65535?new Uint32Array(out):new Uint16Array(out),1));
  if(clipping&&flags.length>1){const welded=weldGeometry(result,mergeDistance);src.dispose();result.dispose();return welded}
  src.dispose();return updateBounds(result);
}

export function subdivideLoop(geometry, levels = 1, maxFaces = 200000) {
  let g=weldGeometry(geometry,1e-7); const levelCount=clamp(Math.round(levels),0,4);
  if(!levelCount)return g;
  for(let level=0;level<levelCount;level++){
    const p=g.attributes.position, idx=g.index.array, faceCount=idx.length/3;
    if(faceCount*4>maxFaces) { g.dispose(); throw new Error(`Subdivision would exceed ${maxFaces} triangles`); }
    const edgeMap=new Map(), neighbors=Array.from({length:p.count},()=>new Set());
    const edge=(a,b,opp)=>{const lo=Math.min(a,b),hi=Math.max(a,b),key=`${lo}:${hi}`;let e=edgeMap.get(key);if(!e){e={a:lo,b:hi,opposites:[]};edgeMap.set(key,e)}if(opp!==undefined)e.opposites.push(opp);neighbors[a].add(b);neighbors[b].add(a);};
    for(let i=0;i<idx.length;i+=3){const a=idx[i],b=idx[i+1],c=idx[i+2];edge(a,b,c);edge(b,c,a);edge(c,a,b)}
    const boundary=Array.from({length:p.count},()=>[]);for(const e of edgeMap.values())if(e.opposites.length===1){boundary[e.a].push(e.b);boundary[e.b].push(e.a)}
    const attrs=Object.entries(g.attributes), values=Object.fromEntries(attrs.map(([n])=>[n,[]]));
    const oldPos=Array.from({length:p.count},(_,i)=>new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i)));
    for(let i=0;i<p.count;i++){
      let q=oldPos[i].clone(), bn=boundary[i];
      if(bn.length>=2) q.multiplyScalar(.75).addScaledVector(oldPos[bn[0]],.125).addScaledVector(oldPos[bn[1]],.125);
      else {const ns=[...neighbors[i]],n=ns.length;if(n){const beta=n===3?3/16:3/(8*n);q.multiplyScalar(1-n*beta);for(const j of ns)q.addScaledVector(oldPos[j],beta)}}
      for(const [name,a] of attrs)for(let c=0;c<a.itemSize;c++)values[name].push(name==='position'?q.getComponent(c):a.array[i*a.itemSize+c]);
    }
    const edgeIndex=new Map();
    for(const [key,e] of edgeMap){const va=oldPos[e.a],vb=oldPos[e.b],q=va.clone().add(vb).multiplyScalar(.375);if(e.opposites.length===1)q.copy(va).add(vb).multiplyScalar(.5);else if(e.opposites.length>=2)q.addScaledVector(oldPos[e.opposites[0]],.125).addScaledVector(oldPos[e.opposites[1]],.125);const id=values.position.length/3;edgeIndex.set(key,id);for(const [name,a] of attrs)for(let c=0;c<a.itemSize;c++)values[name].push(name==='position'?q.getComponent(c):(a.array[e.a*a.itemSize+c]+a.array[e.b*a.itemSize+c])*.5)}
    const ei=(a,b)=>edgeIndex.get(`${Math.min(a,b)}:${Math.max(a,b)}`), out=[];for(let i=0;i<idx.length;i+=3){const a=idx[i],b=idx[i+1],c=idx[i+2],ab=ei(a,b),bc=ei(b,c),ca=ei(c,a);out.push(a,ab,ca,ab,b,bc,ca,bc,c,ab,bc,ca)}
    const next=new THREE.BufferGeometry();for(const [name,a]of attrs)if(name!=='normal')writeAttribute(next,name,values[name],a.itemSize,a);next.setIndex(new THREE.BufferAttribute(out.length>65535?new Uint32Array(out):new Uint16Array(out),1));next.computeVertexNormals();updateBounds(next);g.dispose();g=next;
  }
  return g;
}

export function solidifyGeometry(geometry, thickness = .1, offset = -1) {
  if(Math.abs(thickness)<1e-9)return geometry.clone();
  const src=geometry.clone(), p=assertPositions(src);if(!src.attributes.normal)src.computeVertexNormals();
  const n=src.attributes.normal, idx=sourceIndices(src), count=p.count, out=new THREE.BufferGeometry(), attrs=Object.entries(src.attributes), values=Object.fromEntries(attrs.map(([name])=>[name,[]]));
  const outer=thickness*(1-offset)*.5, inner=-thickness*(1+offset)*.5;
  for(let layer=0;layer<2;layer++)for(let i=0;i<count;i++)for(const [name,a]of attrs)for(let c=0;c<a.itemSize;c++){
    let v=a.array[i*a.itemSize+c];if(name==='position'&&c<3)v+=n.array[i*3+c]*(layer?inner:outer);values[name].push(v);
  }
  for(const [name,a]of attrs)writeAttribute(out,name,values[name],a.itemSize,a);
  const faces=[];for(let i=0;i+2<idx.length;i+=3){faces.push(idx[i],idx[i+1],idx[i+2],idx[i+2]+count,idx[i+1]+count,idx[i]+count)}
  const box=src.boundingBox|| (src.computeBoundingBox(),src.boundingBox), eps=Math.max(box.getSize(new THREE.Vector3()).length()*1e-7,1e-9), canonical=new Uint32Array(count), keys=new Map();let next=0;
  for(let i=0;i<count;i++){const key=vertexKey(p.getX(i),p.getY(i),p.getZ(i),eps);if(!keys.has(key))keys.set(key,next++);canonical[i]=keys.get(key)}
  const edges=new Map();for(let i=0;i+2<idx.length;i+=3){const tri=[idx[i],idx[i+1],idx[i+2]],a=old=>canonical[old];for(const [u,v]of [[tri[0],tri[1]],[tri[1],tri[2]],[tri[2],tri[0]]]){const cu=a(u),cv=a(v),lo=Math.min(cu,cv),hi=Math.max(cu,cv),key=`${lo}:${hi}`;let e=edges.get(key);if(!e){e={count:0,a:u,b:v,normal:new THREE.Vector3().crossVectors(new THREE.Vector3().fromBufferAttribute(p,tri[1]).sub(new THREE.Vector3().fromBufferAttribute(p,tri[0])),new THREE.Vector3().fromBufferAttribute(p,tri[2]).sub(new THREE.Vector3().fromBufferAttribute(p,tri[0]))).normalize()};edges.set(key,e)}e.count++}}
  for(const e of edges.values())if(e.count===1){const a=e.a,b=e.b,oa=new THREE.Vector3(p.getX(a)+n.getX(a)*outer,p.getY(a)+n.getY(a)*outer,p.getZ(a)+n.getZ(a)*outer),ob=new THREE.Vector3(p.getX(b)+n.getX(b)*outer,p.getY(b)+n.getY(b)*outer,p.getZ(b)+n.getZ(b)*outer),ib=new THREE.Vector3(p.getX(b)+n.getX(b)*inner,p.getY(b)+n.getY(b)*inner,p.getZ(b)+n.getZ(b)*inner),ia=new THREE.Vector3(p.getX(a)+n.getX(a)*inner,p.getY(a)+n.getY(a)*inner,p.getZ(a)+n.getZ(a)*inner);const want=new THREE.Vector3().subVectors(new THREE.Vector3().fromBufferAttribute(p,b),new THREE.Vector3().fromBufferAttribute(p,a)).cross(e.normal),got=new THREE.Vector3().crossVectors(ob.clone().sub(oa),ib.clone().sub(oa));if(got.dot(want)>=0)faces.push(a,b,b+count,a,b+count,a+count);else faces.push(b,a,a+count,b,a+count,b+count)}
  out.setIndex(new THREE.BufferAttribute(faces.length>65535?new Uint32Array(faces):new Uint16Array(faces),1));out.deleteAttribute('normal');out.computeVertexNormals();updateBounds(out);src.dispose();return out;
}

export function bevelGeometry(geometry,{width=.15,segments=4,clampOverlap=true}={}){
  if(!Number.isFinite(width)||width<0)throw new Error('Bevel width must be a finite non-negative value');
  if(width<=1e-7)return geometry.clone();
  const src=weldGeometry(geometry,1e-7);
  try{
    validateClosedManifold(src,'Bevel input');
    const p=src.attributes.position,idx=src.index.array,triCount=idx.length/3,faces=[],edgeMap=new Map(),normals=[];
    for(let f=0;f<triCount;f++){
      const a=idx[f*3],b=idx[f*3+1],c=idx[f*3+2],pa=new THREE.Vector3(p.getX(a),p.getY(a),p.getZ(a)),pb=new THREE.Vector3(p.getX(b),p.getY(b),p.getZ(b)),pc=new THREE.Vector3(p.getX(c),p.getY(c),p.getZ(c));
      const normal=new THREE.Vector3().crossVectors(pb.clone().sub(pa),pc.clone().sub(pa)).normalize();normals.push(normal);faces.push({id:f,verts:[a,b,c],edges:[[a,b],[b,c],[c,a]],normal,point:pa.clone().add(pb).add(pc).multiplyScalar(1/3)});
      for(const [u,v]of [[a,b],[b,c],[c,a]]){const lo=Math.min(u,v),hi=Math.max(u,v),key=`${lo}:${hi}`;let e=edgeMap.get(key);if(!e){e={a:lo,b:hi,faces:[]};edgeMap.set(key,e)}e.faces.push(f)}
    }
    let minEdge=Infinity;for(const e of edgeMap.values()){const dx=p.getX(e.a)-p.getX(e.b),dy=p.getY(e.a)-p.getY(e.b),dz=p.getZ(e.a)-p.getZ(e.b);minEdge=Math.min(minEdge,Math.hypot(dx,dy,dz))}
    const bevelWidth=clampOverlap?Math.min(width,minEdge*.45):width;if(!clampOverlap&&bevelWidth>=minEdge*.5)throw new Error('Bevel width overlaps adjacent edges; enable Clamp Overlap or reduce width');
    const adjacency=Array.from({length:triCount},()=>[]),coplanar=(a,b)=>a.normal.dot(b.normal)>.9995&&Math.abs(a.normal.dot(b.point.clone().sub(a.point)))<Math.max(minEdge*1e-5,1e-8);
    for(const e of edgeMap.values()){if(e.faces.length!==2)throw new Error('Bevel requires a closed two-manifold mesh');const a=faces[e.faces[0]],b=faces[e.faces[1]];if(coplanar(a,b)){adjacency[a.id].push(b.id);adjacency[b.id].push(a.id)}}
    const groups=[],faceGroup=new Int32Array(triCount).fill(-1);
    for(let seed=0;seed<triCount;seed++)if(faceGroup[seed]<0){const id=groups.length,stack=[seed],list=[];faceGroup[seed]=id;while(stack.length){const f=stack.pop();list.push(f);for(const n of adjacency[f])if(faceGroup[n]<0){faceGroup[n]=id;stack.push(n)}}groups.push(list)}
    const polyFaces=[];
    for(let id=0;id<groups.length;id++){
      const members=groups[id],memberSet=new Set(members),boundary=[];let normal=new THREE.Vector3(),point=new THREE.Vector3();
      for(const f of members){const face=faces[f];normal.add(face.normal);point.add(face.point);for(const [a,b]of face.edges){const e=edgeMap.get(`${Math.min(a,b)}:${Math.max(a,b)}`);if(e.faces.some(other=>!memberSet.has(other)))boundary.push([a,b])}}
      normal.normalize();point.multiplyScalar(1/members.length);
      if(boundary.length<3)throw new Error('Bevel could not build a polygon boundary for an input face');
      const next=new Map();for(const [a,b]of boundary){if(next.has(a))throw new Error('Bevel currently supports simple convex face loops without holes');next.set(a,b)}
      const loop=[],start=boundary[0][0];let v=start;for(let i=0;i<=boundary.length;i++){if(i===boundary.length)break;if(loop.includes(v))break;loop.push(v);v=next.get(v);if(v===undefined)throw new Error('Bevel face boundary is open')}
      if(v!==start||loop.length!==boundary.length)throw new Error('Bevel face boundary has multiple loops or an unsupported hole');
      polyFaces.push({id,loop,normal,point,inset:new Map()});
    }
    const convexTolerance=Math.max(minEdge*1e-5,1e-7);
    for(const face of polyFaces)for(let i=0;i<p.count;i++){const q=new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i));if(face.normal.dot(q.clone().sub(face.point))>convexTolerance)throw new Error('Bevel currently supports outward-oriented convex closed meshes; this mesh is concave or inconsistently oriented')}
    for(const face of polyFaces)for(let i=0;i<face.loop.length;i++){
      const id=face.loop[i],prev=face.loop[(i+face.loop.length-1)%face.loop.length],next=face.loop[(i+1)%face.loop.length],v=new THREE.Vector3(p.getX(id),p.getY(id),p.getZ(id));
      const ep=v.clone().sub(new THREE.Vector3(p.getX(prev),p.getY(prev),p.getZ(prev))).normalize(),en=new THREE.Vector3(p.getX(next),p.getY(next),p.getZ(next)).sub(v).normalize();
      const ip=new THREE.Vector3().crossVectors(face.normal,ep).normalize(),inn=new THREE.Vector3().crossVectors(face.normal,en).normalize(),bis=ip.clone().add(inn).normalize(),den=Math.max(bis.dot(ip),.05),distance=Math.min(bevelWidth/den,bevelWidth*4);
      face.inset.set(id,v.addScaledVector(bis,distance));
    }
    const positions=[],outNormals=[],uvs=[],uvAttr=src.attributes.uv;
    const uvAt=(id)=>uvAttr?new THREE.Vector2(uvAttr.getX(id),uvAttr.getY(id)):new THREE.Vector2(p.getX(id),p.getZ(id));
    const pushTri=(a,b,c,na,nb,nc,ua,ub,uc,want)=>{
      let cross=new THREE.Vector3().crossVectors(b.clone().sub(a),c.clone().sub(a));if(cross.lengthSq()<1e-18)return;
      if(want&&cross.dot(want)<0){[b,c]=[c,b];[nb,nc]=[nc,nb];[ub,uc]=[uc,ub]}
      for(const q of [a,b,c])positions.push(q.x,q.y,q.z);
      for(const q of [na,nb,nc]){const n=q.clone().normalize();outNormals.push(n.x,n.y,n.z)}
      for(const q of [ua,ub,uc])uvs.push(q.x,q.y);
    };
    for(const face of polyFaces){const ids=face.loop,points=ids.map(id=>face.inset.get(id)),uv=ids.map(uvAt);for(let i=1;i<points.length-1;i++)pushTri(points[0],points[i],points[i+1],face.normal,face.normal,face.normal,uv[0],uv[i],uv[i+1],face.normal)}
    const cornerPoints=new Map(),cornerNormals=new Map(),cornerAdd=(id,q,n)=>{let a=cornerPoints.get(id);if(!a)cornerPoints.set(id,a=[]);a.push(q.clone());let sum=cornerNormals.get(id);if(!sum)cornerNormals.set(id,sum=new THREE.Vector3());sum.add(n)};
    const seg=clamp(Math.round(segments),1,12);
    for(const e of edgeMap.values()){
      const f0=faceGroup[e.faces[0]],f1=faceGroup[e.faces[1]];if(f0===f1)continue;
      const a=e.a,b=e.b,A=polyFaces[f0],B=polyFaces[f1],a0=A.inset.get(a),a1=B.inset.get(a),b0=A.inset.get(b),b1=B.inset.get(b);
      const bis=A.normal.clone().add(B.normal).normalize(),angle=Math.acos(clamp(A.normal.dot(B.normal),-1,1)),bulge=bevelWidth*(1-Math.cos(angle*.5));
      const profile=(x,y,t)=>x.clone().lerp(y,t).addScaledVector(bis,bulge*Math.sin(Math.PI*t)),edgeA=[],edgeB=[],uvA=uvAt(a),uvB=uvAt(b),uvMix=(t)=>uvA.clone().lerp(uvB,t);
      for(let k=0;k<=seg;k++){const t=k/seg;edgeA.push(profile(a0,a1,t));edgeB.push(profile(b0,b1,t));cornerAdd(a,edgeA[k],A.normal.clone().lerp(B.normal,t).normalize());cornerAdd(b,edgeB[k],A.normal.clone().lerp(B.normal,t).normalize())}
      for(let k=0;k<seg;k++){const t0=k/seg,t1=(k+1)/seg,n0=A.normal.clone().lerp(B.normal,t0).normalize(),n1=A.normal.clone().lerp(B.normal,t1).normalize(),um0=uvMix(t0),um1=uvMix(t1),u0=uvAt(a),u1=uvAt(b);pushTri(edgeA[k],edgeB[k],edgeB[k+1],n0,n0,n1,um0,u0,um1,n0.clone().lerp(n1,.5));pushTri(edgeA[k],edgeB[k+1],edgeA[k+1],n0,n1,n1,um0,um1,um0,n0.clone().lerp(n1,.5))}
    }
    for(const [id,raw]of cornerPoints){const unique=new Map();for(const q of raw)unique.set(vertexKey(q.x,q.y,q.z,1e-6),q);const ring=[...unique.values()];if(ring.length<3)continue;const center=ring.reduce((sum,q)=>sum.add(q),new THREE.Vector3()).multiplyScalar(1/ring.length),normal=cornerNormals.get(id).normalize(),basis=new THREE.Vector3(Math.abs(normal.y)<.9?0:1,Math.abs(normal.y)<.9?1:0,0).cross(normal).normalize(),other=new THREE.Vector3().crossVectors(normal,basis);ring.sort((a,b)=>Math.atan2(a.clone().sub(center).dot(other),a.clone().sub(center).dot(basis))-Math.atan2(b.clone().sub(center).dot(other),b.clone().sub(center).dot(basis)));const uvCenter=new THREE.Vector2(center.x,center.z);for(let i=0;i<ring.length;i++)pushTri(center,ring[i],ring[(i+1)%ring.length],normal,normal,normal,uvCenter,new THREE.Vector2(ring[i].x,ring[i].z),new THREE.Vector2(ring[(i+1)%ring.length].x,ring[(i+1)%ring.length].z),normal)}
    if(positions.length<9)throw new Error('Bevel produced no usable faces');
    const out=new THREE.BufferGeometry();out.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));out.setAttribute('normal',new THREE.Float32BufferAttribute(outNormals,3));out.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));updateBounds(out);src.dispose();return out;
  }catch(error){src.dispose();throw error}
}

function hash3(x,y,z){const q=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453123;return q-Math.floor(q)}
function valueNoise3(x,y,z){const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),fx=x-ix,fy=y-iy,fz=z-iz,s=t=>t*t*(3-2*t);let v=0;for(let dz=0;dz<=1;dz++)for(let dy=0;dy<=1;dy++)for(let dx=0;dx<=1;dx++){const w=(dx? s(fx):1-s(fx))*(dy?s(fy):1-s(fy))*(dz?s(fz):1-s(fz));v+=hash3(ix+dx,iy+dy,iz+dz)*w}return v}
export function displaceGeometry(geometry,{strength=.35,midlevel=.5,frequency=1}={}){const g=geometry.clone();if(!g.attributes.normal)g.computeVertexNormals();const p=g.attributes.position,n=g.attributes.normal;for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),noise=valueNoise3(x*frequency+11,y*frequency+17,z*frequency+23);const d=(noise-clamp(midlevel,0,1))*strength;p.setXYZ(i,x+n.getX(i)*d,y+n.getY(i)*d,z+n.getZ(i)*d)}g.attributes.position.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}
export function waveGeometry(geometry,{speed=1.5,height=.6,width=2.5,time=0}={}){const g=geometry.clone(),p=g.attributes.position;if(!p)throw new Error('Wave needs vertex positions');for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),r=Math.hypot(x,z),phase=r*width*1.5-time*speed;p.setY(i,y+Math.sin(phase)*height*.2)}p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}
export function castGeometry(geometry,{shape='Sphere',factor=1,radius=1}={}){const g=geometry.clone(),p=g.attributes.position;g.computeBoundingBox();const center=g.boundingBox.getCenter(new THREE.Vector3()),size=g.boundingBox.getSize(new THREE.Vector3()),base=Math.max(size.x,size.y,size.z)*.5*Math.max(radius,0),f=clamp(factor,0,1);for(let i=0;i<p.count;i++){let x=p.getX(i)-center.x,y=p.getY(i)-center.y,z=p.getZ(i)-center.z,tx=x,ty=y,tz=z;if(shape==='Sphere'){const l=Math.hypot(x,y,z)||1;tx=x/l*base;ty=y/l*base;tz=z/l*base}else if(shape==='Cylinder'){const l=Math.hypot(x,z)||1;tx=x/l*base;tz=z/l*base}else if(shape==='Cuboid'){tx=clamp(x,-base,base);ty=clamp(y,-base,base);tz=clamp(z,-base,base)}p.setXYZ(i,center.x+THREE.MathUtils.lerp(x,tx,f),center.y+THREE.MathUtils.lerp(y,ty,f),center.z+THREE.MathUtils.lerp(z,tz,f))}p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}
export function smoothGeometry(geometry,{factor=.6,iterations=3}={}){let g=weldGeometry(geometry,1e-7);const f=clamp(factor,0,1);for(let iter=0;iter<clamp(Math.round(iterations),1,20);iter++){const p=g.attributes.position,idx=g.index.array,neighbors=Array.from({length:p.count},()=>new Set());for(let i=0;i<idx.length;i+=3){const a=idx[i],b=idx[i+1],c=idx[i+2];neighbors[a].add(b);neighbors[a].add(c);neighbors[b].add(a);neighbors[b].add(c);neighbors[c].add(a);neighbors[c].add(b)}const next=new Float32Array(p.array);for(let i=0;i<p.count;i++){const ns=[...neighbors[i]];if(!ns.length)continue;const avg=new THREE.Vector3();for(const j of ns)avg.add(new THREE.Vector3(p.getX(j),p.getY(j),p.getZ(j)));avg.multiplyScalar(1/ns.length);next[i*3]=THREE.MathUtils.lerp(p.getX(i),avg.x,f);next[i*3+1]=THREE.MathUtils.lerp(p.getY(i),avg.y,f);next[i*3+2]=THREE.MathUtils.lerp(p.getZ(i),avg.z,f)}p.array.set(next);p.needsUpdate=true}g.computeVertexNormals();return updateBounds(g)}
export function weightedNormalGeometry(geometry,{weight=50,keepSharp=true}={}){const g=geometry.clone(),p=g.attributes.position,idx=sourceIndices(g),out=new Float32Array(p.count*3),blend=clamp(weight/100,0,1);for(let i=0;i+2<idx.length;i+=3){const ia=idx[i],ib=idx[i+1],ic=idx[i+2],a=new THREE.Vector3(p.getX(ia),p.getY(ia),p.getZ(ia)),b=new THREE.Vector3(p.getX(ib),p.getY(ib),p.getZ(ib)),c=new THREE.Vector3(p.getX(ic),p.getY(ic),p.getZ(ic)),cross=new THREE.Vector3().crossVectors(b.clone().sub(a),c.clone().sub(a)),area=cross.length()*.5;if(area<1e-12)continue;const face=cross.normalize();for(const [id,u,v]of [[ia,b,c],[ib,c,a],[ic,a,b]]){const e1=u.clone().sub(new THREE.Vector3(p.getX(id),p.getY(id),p.getZ(id))).normalize(),e2=v.clone().sub(new THREE.Vector3(p.getX(id),p.getY(id),p.getZ(id))).normalize(),angle=Math.acos(clamp(e1.dot(e2),-1,1)),w=angle*((1-blend)+blend*area);out[id*3]+=face.x*w;out[id*3+1]+=face.y*w;out[id*3+2]+=face.z*w}}const old=g.attributes.normal;for(let i=0;i<p.count;i++){let n=new THREE.Vector3(out[i*3],out[i*3+1],out[i*3+2]);if(n.lengthSq()<1e-12&&old)n.fromBufferAttribute(old,i);n.normalize();if(keepSharp&&old){const original=new THREE.Vector3().fromBufferAttribute(old,i);if(original.lengthSq()>0&&n.dot(original)<.5)n.copy(original)}out[i*3]=n.x;out[i*3+1]=n.y;out[i*3+2]=n.z}g.setAttribute('normal',new THREE.BufferAttribute(out,3));return updateBounds(g)}
export function twistGeometry(geometry,strength=1.2){const g=geometry.clone(),p=g.attributes.position;for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),a=y*strength*.5,c=Math.cos(a),s=Math.sin(a);p.setXYZ(i,x*c-z*s,y,x*s+z*c)}p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}

export function shrinkwrapGeometry(geometry,targetGeometry,relativeMatrixElements,offset=0,mode='On Surface',maxPairs=5000000){
  assertPositions(geometry);const target=ensureNormalsAndUv(targetGeometry),tp=target.attributes.position,ti=sourceIndices(target),count=geometry.attributes.position.count,triangles=ti.length/3;if(count*triangles>maxPairs){target.dispose();throw new Error(`Shrinkwrap would require ${count*triangles} point/triangle tests; reduce mesh density or use a BVH target`)}
  const matrix=new THREE.Matrix4().fromArray(Array.from(relativeMatrixElements||new THREE.Matrix4().elements)),tris=[];
  for(let i=0;i+2<ti.length;i+=3){const a=new THREE.Vector3(tp.getX(ti[i]),tp.getY(ti[i]),tp.getZ(ti[i])).applyMatrix4(matrix),b=new THREE.Vector3(tp.getX(ti[i+1]),tp.getY(ti[i+1]),tp.getZ(ti[i+1])).applyMatrix4(matrix),c=new THREE.Vector3(tp.getX(ti[i+2]),tp.getY(ti[i+2]),tp.getZ(ti[i+2])).applyMatrix4(matrix);const cross=new THREE.Vector3().crossVectors(b.clone().sub(a),c.clone().sub(a));if(cross.lengthSq()>1e-24)tris.push({triangle:new THREE.Triangle(a,b,c),normal:cross.normalize()})}
  if(!tris.length){target.dispose();throw new Error('Shrinkwrap target has no non-degenerate triangles')}
  const g=geometry.clone(),p=g.attributes.position,q=new THREE.Vector3(),best=new THREE.Vector3(),candidate=new THREE.Vector3(),normal=new THREE.Vector3();
  for(let i=0;i<p.count;i++){q.set(p.getX(i),p.getY(i),p.getZ(i));let bestD=Infinity;for(const item of tris){item.triangle.closestPointToPoint(q,candidate);const d=candidate.distanceToSquared(q);if(d<bestD){bestD=d;best.copy(candidate);normal.copy(item.normal)}}if(mode==='Outside Surface'&&q.sub(best).dot(normal)<0)normal.negate();best.addScaledVector(normal,offset);p.setXYZ(i,best.x,best.y,best.z)}
  target.dispose();p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)
}
