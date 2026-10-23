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

/* =========================================================================
 * C++ kernel bridge
 *
 * The editor ships the compiled core, so every geometry modifier below first
 * hands its mesh to the C++ session and only falls back to the JS reference
 * implementation when the core is unavailable (headless tests, blocked wasm)
 * or when the mesh carries attributes the session does not carry.
 * ========================================================================= */
const cppExports = () => {
  const exp = globalThis.FECppEngine?.exports;
  return exp && typeof exp.fe_mod_begin === 'function' ? exp : null;
};
function kernelCapacities(geometry) {
  const p = geometry?.attributes?.position;
  if (!p) return null;
  const v = p.count;
  const src = geometry.index?.array;
  const t = src ? Math.floor(src.length / 3) : Math.floor(v / 3);
  if (!v || !t || (src && src.length % 3)) return null;
  return { v, t };
}
const MATRIX_IDENTITY = Object.freeze([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

function writeSessionMatrix(exp, elements) {
  const ptr = exp.fe_mod_matrix_ptr();
  if (!ptr) return false;
  const view = new Float32Array(exp.memory.buffer, ptr, 16);
  if (elements && elements.length >= 16) view.set(elements);
  else view.set(MATRIX_IDENTITY);
  return true;
}

function uploadTargetMesh(exp, targetGeometry, matrixElements) {
  const tp = targetGeometry?.attributes?.position;
  if (!tp || tp.itemSize < 3 || typeof exp.fe_mod_target_begin !== 'function') return false;
  const src = targetGeometry.index?.array;
  const verts = tp.count;
  const tris = src ? Math.floor(src.length / 3) : Math.floor(verts / 3);
  if (!verts || !tris) return false;
  if (exp.fe_mod_target_begin(verts, tris) !== 0) return false;
  const buf = exp.memory.buffer;
  new Float32Array(buf, exp.fe_mod_target_pos_ptr(), verts * 3).set(tp.array.subarray(0, verts * 3));
  const idx = new Uint32Array(buf, exp.fe_mod_target_idx_ptr(), tris * 3);
  if (targetGeometry.index) idx.set(src.subarray(0, tris * 3));
  else for (let i = 0; i < tris * 3; i++) idx[i] = i;
  return writeSessionMatrix(exp, matrixElements);
}

function runCppKernel(geometry, capsFn, call, prepare) {
  const exp = cppExports();
  if (!exp) return null;
  const base = kernelCapacities(geometry);
  if (!base) return null;
  const attrs = geometry.attributes;
  for (const name of Object.keys(attrs)) if (name !== 'position' && name !== 'normal' && name !== 'uv') return null;
  if (attrs.position.itemSize !== 3) return null;
  const hasUv = !!(attrs.uv && attrs.uv.itemSize === 2);
  if (attrs.uv && !hasUv) return null;
  const caps = capsFn ? capsFn(base.v, base.t) : [base.v, base.t];
  if (!caps) return null;
  const vcap = Math.ceil(caps[0]), tcap = Math.ceil(caps[1]);
  if (vcap < base.v || tcap < base.t || vcap > 131072 || tcap > 262144) return null;
  try {
    if (exp.fe_mod_begin(vcap, tcap, hasUv ? 1 : 0) !== 0) return null;
    const buf = exp.memory.buffer;
    new Float32Array(buf, exp.fe_mod_in_pos_ptr(), base.v * 3).set(attrs.position.array.subarray(0, base.v * 3));
    const idxView = new Uint32Array(buf, exp.fe_mod_in_idx_ptr(), base.t * 3);
    if (geometry.index) idxView.set(geometry.index.array.subarray(0, base.t * 3));
    else for (let i = 0; i < base.t * 3; i++) idxView[i] = i;
    if (hasUv) new Float32Array(buf, exp.fe_mod_in_uv_ptr(), base.v * 2).set(attrs.uv.array.subarray(0, base.v * 2));
    exp.fe_mod_set_counts(base.v, base.t);
    if (prepare && prepare(exp) === false) return null;
    if (call(exp) !== 0) return null;
    const counts = new Uint32Array(exp.memory.buffer, exp.fe_mod_counts_ptr(), 2);
    const outV = counts[0], outT = counts[1];
    if (!outV || !outT) return null;
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(exp.memory.buffer, exp.fe_mod_in_pos_ptr(), outV * 3).slice(), 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(exp.memory.buffer, exp.fe_mod_normals_ptr(), outV * 3).slice(), 3));
    if (hasUv) out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(exp.memory.buffer, exp.fe_mod_in_uv_ptr(), outV * 2).slice(), 2));
    out.setIndex(new THREE.BufferAttribute(new Uint32Array(exp.memory.buffer, exp.fe_mod_in_idx_ptr(), outT * 3).slice(), 1));
    return updateBounds(out);
  } catch { return null; }
}

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

export function arrayGeometry(geometry, { count = 2, offset = [1.8,0,0], relative = [0,0,0], rotationPerStep = 0 } = {}) {
  const copies = clamp(Math.round(count), 1, 100);
  const viaCpp = copies > 1 ? runCppKernel(geometry, (v,t)=>[v*copies, t*copies],
    exp => exp.fe_mod_array(copies, Number(offset[0])||0, Number(offset[1])||0, Number(offset[2])||0,
                            Number(relative[0])||0, Number(relative[1])||0, Number(relative[2])||0, Number(rotationPerStep)||0)) : null;
  if (viaCpp) return viaCpp;
  const src = geometry.clone(), p = assertPositions(src);
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
  const viaCpp = runCppKernel(geometry, null, exp => exp.fe_mod_weld(Math.max(Number(distance)||0, 1e-9)));
  if (viaCpp) return viaCpp;
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

export function triangulateGeometry(geometry, { keepNormals = true } = {}) {
  const idx=sourceIndices(geometry);if(idx.length%3)throw new Error('Triangulate needs complete triangles');
  const out=geometry.index?geometry.toNonIndexed():geometry.clone();
  if(!keepNormals&&out.attributes.normal)out.deleteAttribute('normal');
  if(!out.attributes.normal)out.computeVertexNormals();
  return updateBounds(out);
}

export function decimateGeometry(geometry, ratio = .5, maxFaces = 65000, { preserveBoundary = true } = {}) {
  /* Small meshes keep the higher-quality QEM collapse; the C++ clustering pass
     takes over once QEM would block the main thread. */
  const current = kernelCapacities(geometry);
  const viaCpp = current && current.t > 12000
    ? runCppKernel(geometry, null, exp => exp.fe_mod_decimate(clamp(Number(ratio)||.5, .01, 1), preserveBoundary ? 1 : 0))
    : null;
  if (viaCpp) return viaCpp;
  const g=weldGeometry(geometry,1e-7),p=g.attributes.position,idx=g.index.array;
  const initialFaces=idx.length/3;
  if(initialFaces>maxFaces){g.dispose();throw new Error(`Decimate currently caps edge-collapse input at ${maxFaces} triangles; reduce source density first`)}
  const target=Math.max(1,Math.floor(initialFaces*clamp(ratio,.01,1)));
  if(initialFaces<=target)return g;

  const vCount=p.count,attrs=Object.entries(g.attributes);
  const arrays=Object.fromEntries(attrs.map(([name,a])=>[name,new Float64Array(a.array)]));
  const pos=arrays.position;

  /* Per-vertex symmetric 4x4 Garland-Heckbert plane error quadric (10 floats) */
  const quadrics=new Float64Array(vCount*10);
  const faceVerts=new Int32Array(idx.length);
  const faceAlive=new Uint8Array(initialFaces).fill(1);
  const vertFaces=Array.from({length:vCount},()=>[]);

  for(let f=0;f<initialFaces;f++){
    const a=idx[f*3],b=idx[f*3+1],c=idx[f*3+2];
    faceVerts[f*3]=a;faceVerts[f*3+1]=b;faceVerts[f*3+2]=c;
    vertFaces[a].push(f);vertFaces[b].push(f);vertFaces[c].push(f);
    const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2];
    const ux=pos[b*3]-ax,uy=pos[b*3+1]-ay,uz=pos[b*3+2]-az;
    const vx=pos[c*3]-ax,vy=pos[c*3+1]-ay,vz=pos[c*3+2]-az;
    let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    const len=Math.hypot(nx,ny,nz);
    if(len>1e-12){
      nx/=len;ny/=len;nz/=len;
      const d=-(nx*ax+ny*ay+nz*az);
      const q=[nx*nx,nx*ny,nx*nz,nx*d,ny*ny,ny*nz,ny*d,nz*nz,nz*d,d*d];
      for(const v of [a,b,c]){const o=v*10;for(let k=0;k<10;k++)quadrics[o+k]+=q[k]}
    }
  }

  const evalQuadric=(o,x,y,z)=>{
    const q0=quadrics[o],q1=quadrics[o+1],q2=quadrics[o+2],q3=quadrics[o+3],q4=quadrics[o+4],q5=quadrics[o+5],q6=quadrics[o+6],q7=quadrics[o+7],q8=quadrics[o+8],q9=quadrics[o+9];
    return Math.max(0,q0*x*x+2*q1*x*y+2*q2*x*z+2*q3*x+q4*y*y+2*q5*y*z+2*q6*y+q7*z*z+2*q8*z+q9);
  };

  /* Binary min-heap of candidate collapses with lazy version invalidation */
  const vertStamp=new Uint32Array(vCount);
  const heapCost=[],heapA=[],heapB=[],heapSA=[],heapSB=[];
  const heapPush=(cost,a,b,sa,sb)=>{
    let i=heapCost.length;
    heapCost.push(cost);heapA.push(a);heapB.push(b);heapSA.push(sa);heapSB.push(sb);
    while(i>0){
      const p=(i-1)>>1;
      if(heapCost[p]<=heapCost[i])break;
      [heapCost[p],heapCost[i]]=[heapCost[i],heapCost[p]];
      [heapA[p],heapA[i]]=[heapA[i],heapA[p]];
      [heapB[p],heapB[i]]=[heapB[i],heapB[p]];
      [heapSA[p],heapSA[i]]=[heapSA[i],heapSA[p]];
      [heapSB[p],heapSB[i]]=[heapSB[i],heapSB[p]];
      i=p;
    }
  };
  const heapPop=()=>{
    const top={cost:heapCost[0],a:heapA[0],b:heapB[0],sa:heapSA[0],sb:heapSB[0]};
    const last=heapCost.length-1;
    if(last===0){heapCost.pop();heapA.pop();heapB.pop();heapSA.pop();heapSB.pop();return top}
    heapCost[0]=heapCost.pop();heapA[0]=heapA.pop();heapB[0]=heapB.pop();heapSA[0]=heapSA.pop();heapSB[0]=heapSB.pop();
    let i=0;
    for(;;){
      const l=i*2+1,r=l+1;let s=i;
      if(l<heapCost.length&&heapCost[l]<heapCost[s])s=l;
      if(r<heapCost.length&&heapCost[r]<heapCost[s])s=r;
      if(s===i)break;
      [heapCost[s],heapCost[i]]=[heapCost[i],heapCost[s]];
      [heapA[s],heapA[i]]=[heapA[i],heapA[s]];
      [heapB[s],heapB[i]]=[heapB[i],heapB[s]];
      [heapSA[s],heapSA[i]]=[heapSA[i],heapSA[s]];
      [heapSB[s],heapSB[i]]=[heapSB[i],heapSB[s]];
      i=s;
    }
    return top;
  };

  const edgeCostAndPush=(u,v)=>{
    if(u===v)return;
    const lo=Math.min(u,v),hi=Math.max(u,v);
    const mx=(pos[lo*3]+pos[hi*3])*.5,my=(pos[lo*3+1]+pos[hi*3+1])*.5,mz=(pos[lo*3+2]+pos[hi*3+2])*.5;
    const dx=pos[lo*3]-pos[hi*3],dy=pos[lo*3+1]-pos[hi*3+1],dz=pos[lo*3+2]-pos[hi*3+2];
    const d2=dx*dx+dy*dy+dz*dz;
    const qErr=evalQuadric(lo*10,mx,my,mz)+evalQuadric(hi*10,mx,my,mz);
    heapPush(qErr+d2*0.02,lo,hi,vertStamp[lo],vertStamp[hi]);
  };

  const seenInit=new Set();
  for(let f=0;f<initialFaces;f++){
    const a=faceVerts[f*3],b=faceVerts[f*3+1],c=faceVerts[f*3+2];
    for(const [u,v]of [[a,b],[b,c],[c,a]]){
      const lo=Math.min(u,v),hi=Math.max(u,v),key=lo*vCount+hi;
      if(!seenInit.has(key)){seenInit.add(key);edgeCostAndPush(lo,hi)}
    }
  }

  const collapsed=new Uint8Array(vCount);
  let liveFaces=initialFaces;

  while(liveFaces>target&&heapCost.length>0){
    const item=heapPop();
    const a=item.a,b=item.b;
    if(collapsed[a]||collapsed[b]||vertStamp[a]!==item.sa||vertStamp[b]!==item.sb)continue;

    /* Check that collapsing b -> a removes at least one face */
    let removedCount=0;
    for(const f of vertFaces[b]){
      if(!faceAlive[f])continue;
      const v0=faceVerts[f*3],v1=faceVerts[f*3+1],v2=faceVerts[f*3+2];
      if(v0===a||v1===a||v2===a)removedCount++;
    }
    if(!removedCount)continue;
    if(liveFaces-removedCount<1)continue;

    for(const [name,attr]of attrs){
      const arr=arrays[name],is=attr.itemSize,ka=a*is,kb=b*is;
      for(let c=0;c<is;c++)arr[ka+c]=(arr[ka+c]+arr[kb+c])*.5;
    }
    for(let k=0;k<10;k++)quadrics[a*10+k]+=quadrics[b*10+k];
    collapsed[b]=1;
    vertStamp[a]++;vertStamp[b]++;

    const neighborSet=new Set();
    for(const f of vertFaces[b]){
      if(!faceAlive[f])continue;
      for(let k=0;k<3;k++)if(faceVerts[f*3+k]===b)faceVerts[f*3+k]=a;
      const v0=faceVerts[f*3],v1=faceVerts[f*3+1],v2=faceVerts[f*3+2];
      if(v0===v1||v1===v2||v2===v0){
        faceAlive[f]=0;liveFaces--;
      }else{
        vertFaces[a].push(f);
      }
    }
    vertFaces[b].length=0;

    const keptA=[];
    for(const f of vertFaces[a]){
      if(!faceAlive[f])continue;
      keptA.push(f);
      for(let k=0;k<3;k++){const v=faceVerts[f*3+k];if(v!==a&&!collapsed[v])neighborSet.add(v)}
    }
    vertFaces[a]=keptA;
    for(const nb of neighborSet)edgeCostAndPush(a,nb);
  }

  const remap=new Map(),out=new THREE.BufferGeometry(),values=Object.fromEntries(attrs.map(([name])=>[name,[]])),outIdx=[];
  for(let f=0;f<initialFaces;f++){
    if(!faceAlive[f])continue;
    const v0=faceVerts[f*3],v1=faceVerts[f*3+1],v2=faceVerts[f*3+2];
    if(v0===v1||v1===v2||v2===v0)continue;
    for(const old of [v0,v1,v2]){
      let id=remap.get(old);
      if(id===undefined){
        id=remap.size;remap.set(old,id);
        for(const [name,a]of attrs)for(let c=0;c<a.itemSize;c++)values[name].push(arrays[name][old*a.itemSize+c]);
      }
      outIdx.push(id);
    }
  }
  if(!outIdx.length){g.dispose();throw new Error('Decimate collapsed the mesh to no triangles')}
  for(const [name,a]of attrs)if(name!=='normal')writeAttribute(out,name,values[name],a.itemSize,a);
  out.setIndex(new THREE.BufferAttribute(outIdx.length>65535?new Uint32Array(outIdx):new Uint16Array(outIdx),1));
  out.computeVertexNormals();g.dispose();return updateBounds(out);
}

export function mirrorGeometry(geometry, { axes = [true,false,false], clipping = false, mergeDistance = 1e-6 } = {}) {
  const mirrorAxes = axes.map(Boolean);
  const mirrorCopies = 1 << mirrorAxes.filter(Boolean).length;
  const viaCpp = runCppKernel(geometry, (v,t)=>[v*mirrorCopies, t*mirrorCopies],
    exp => exp.fe_mod_mirror((mirrorAxes[0]?1:0)|(mirrorAxes[1]?2:0)|(mirrorAxes[2]?4:0), clipping ? 1 : 0, mergeDistance));
  if (viaCpp) return viaCpp;
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
  const levelCount = clamp(Math.round(levels), 0, 4);
  const viaCpp = levelCount > 0 ? runCppKernel(geometry, (v,t) => {
    let cv = v, ct = t;
    for (let i = 0; i < levelCount; i++) { cv += ct * 3; ct *= 4; if (cv > 131072 || ct > 262144) return null; }
    return [cv, ct];
  }, exp => exp.fe_mod_subdivide(Math.min(levelCount, 3))) : null;
  if (viaCpp) return viaCpp;
  let g=weldGeometry(geometry,1e-7);
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

export function solidifyGeometry(geometry, thickness = .1, offset = -1, { rim = true, evenThickness = true } = {}) {
  const viaCpp = Math.abs(thickness) < 1e-9 ? null : runCppKernel(geometry, (v,t)=>[v*2, t*5],
    exp => exp.fe_mod_solidify(Number(thickness)||0, Number(offset)||0, rim ? 1 : 0, evenThickness ? 1 : 0));
  if (viaCpp) return viaCpp;
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
    let isConcave=false;
    for(const face of polyFaces){for(let i=0;i<p.count;i++){const q=new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i));if(face.normal.dot(q.clone().sub(face.point))>convexTolerance){isConcave=true;break}}if(isConcave)break}
    if(isConcave){
      /* Concave closed two-manifold (e.g., Torus or Boolean CSG solid):
       * Perform crease-preserving Loop subdivision + smooth edge fillet relaxation */
      const segLevels=clamp(Math.round(Math.log2(Math.max(1,segments))+1),1,2);
      const sub=subdivideLoop(src,segLevels);
      const filleted=smoothGeometry(sub,{factor:clamp(bevelWidth/(minEdge+1e-6)*.85,.08,.65),iterations:Math.max(1,Math.min(4,Math.round(segments)))});
      sub.dispose();src.dispose();
      return filleted;
    }
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
export function displaceGeometry(geometry,{strength=.35,midlevel=.5,frequency=1,direction='Normal',octaves=1,seed=0}={}){
  const dirIndex = { Normal: 0, X: 1, Y: 2, Z: 3 }[direction] ?? 0;
  const viaCpp = runCppKernel(geometry, null,
    exp => exp.fe_mod_displace(Number(strength)||0, Number(midlevel)||0, Number(frequency)||1, Number(seed)||0, Number(octaves)||1, dirIndex));
  if (viaCpp) return viaCpp;
  const g=geometry.clone();if(!g.attributes.normal)g.computeVertexNormals();const p=g.attributes.position,n=g.attributes.normal;
  const fixed = dirIndex === 1 ? new THREE.Vector3(1,0,0) : dirIndex === 2 ? new THREE.Vector3(0,1,0) : dirIndex === 3 ? new THREE.Vector3(0,0,1) : null;
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    let noise=0, amp=.5, norm=0, fx=x*frequency+11, fy=y*frequency+17, fz=z*frequency+23;
    for(let o=0;o<Math.max(1,Math.min(6,Math.round(octaves)));o++){noise+=valueNoise3(fx,fy,fz)*amp;norm+=amp;fx*=2.03;fy*=2.01;fz*=1.99;amp*=.5}
    noise=norm?noise/norm:0;
    const d=(noise-clamp(midlevel,0,1))*strength;
    const dx=fixed?fixed.x:n.getX(i), dy=fixed?fixed.y:n.getY(i), dz=fixed?fixed.z:n.getZ(i);
    p.setXYZ(i,x+dx*d,y+dy*d,z+dz*d)}
  p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}
export function waveGeometry(geometry,{speed=1.5,height=.6,width=2.5,time=0,axis='Y',phase=0}={}){
  const axisIndex = { X: 0, Y: 1, Z: 2 }[axis] ?? 1;
  const viaCpp = runCppKernel(geometry, null,
    exp => exp.fe_mod_wave(Number(height)||0, Number(width)||0, Number(speed)||0, Number(time)||0, axisIndex, Number(phase)||0));
  if (viaCpp) return viaCpp;
  const g=geometry.clone(),p=g.attributes.position;if(!p)throw new Error('Wave needs vertex positions');
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    const r=axisIndex===0?Math.hypot(y,z):axisIndex===1?Math.hypot(x,z):Math.hypot(x,y);
    const w=Math.sin(r*width*1.5-time*speed+phase)*height*.2;
    if(axisIndex===1)p.setY(i,y+w);else if(axisIndex===0)p.setX(i,x+w);else p.setZ(i,z+w)}
  p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}
export function castGeometry(geometry,{shape='Sphere',factor=1,radius=1,size=1}={}){
  const shapeIndex = { Sphere: 0, Cylinder: 1, Cuboid: 2 }[shape] ?? 0;
  const viaCpp = runCppKernel(geometry, null,
    exp => exp.fe_mod_cast(shapeIndex, Number(factor)||0, Number(radius)||0, Number(size)||1));
  if (viaCpp) return viaCpp;
  const g=geometry.clone(),p=g.attributes.position;g.computeBoundingBox();
  const center=g.boundingBox.getCenter(new THREE.Vector3()),bbox=g.boundingBox.getSize(new THREE.Vector3());
  const base=Math.max(bbox.x,bbox.y,bbox.z)*.5*Math.max(radius,0)*clamp(Number(size)||1,.05,8),f=clamp(factor,0,1);
  for(let i=0;i<p.count;i++){let x=p.getX(i)-center.x,y=p.getY(i)-center.y,z=p.getZ(i)-center.z,tx=x,ty=y,tz=z;
    if(shape==='Sphere'){const l=Math.hypot(x,y,z)||1;tx=x/l*base;ty=y/l*base;tz=z/l*base}
    else if(shape==='Cylinder'){const l=Math.hypot(x,z)||1;tx=x/l*base;tz=z/l*base}
    else if(shape==='Cuboid'){tx=clamp(x,-base,base);ty=clamp(y,-base,base);tz=clamp(z,-base,base)}
    p.setXYZ(i,center.x+THREE.MathUtils.lerp(x,tx,f),center.y+THREE.MathUtils.lerp(y,ty,f),center.z+THREE.MathUtils.lerp(z,tz,f))}
  p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}
export function smoothGeometry(geometry,{factor=.6,iterations=3,preserveVolume=false,boundary='Smooth'}={}){
  const viaCpp = runCppKernel(geometry, null,
    exp => exp.fe_mod_smooth(Math.round(iterations), Number(factor)||0, preserveVolume ? 1 : 0, boundary === 'Fixed' ? 0 : 1));
  if (viaCpp) return viaCpp;
  let g=weldGeometry(geometry,1e-7);const f=clamp(factor,0,1);
  for(let iter=0;iter<clamp(Math.round(iterations),1,20);iter++){const p=g.attributes.position,idx=g.index.array,neighbors=Array.from({length:p.count},()=>new Set());
    for(let i=0;i<idx.length;i+=3){const a=idx[i],b=idx[i+1],c=idx[i+2];neighbors[a].add(b);neighbors[a].add(c);neighbors[b].add(a);neighbors[b].add(c);neighbors[c].add(a);neighbors[c].add(b)}
    const next=new Float32Array(p.array);for(let i=0;i<p.count;i++){const ns=[...neighbors[i]];if(!ns.length)continue;const avg=new THREE.Vector3();
      for(const j of ns)avg.add(new THREE.Vector3(p.getX(j),p.getY(j),p.getZ(j)));avg.multiplyScalar(1/ns.length);
      next[i*3]=THREE.MathUtils.lerp(p.getX(i),avg.x,f);next[i*3+1]=THREE.MathUtils.lerp(p.getY(i),avg.y,f);next[i*3+2]=THREE.MathUtils.lerp(p.getZ(i),avg.z,f)}
    p.array.set(next);p.needsUpdate=true}
  g.computeVertexNormals();return updateBounds(g)}
export function weightedNormalGeometry(geometry,{weight=50,keepSharp=true}={}){const g=geometry.clone(),p=g.attributes.position,idx=sourceIndices(g),out=new Float32Array(p.count*3),blend=clamp(weight/100,0,1);for(let i=0;i+2<idx.length;i+=3){const ia=idx[i],ib=idx[i+1],ic=idx[i+2],a=new THREE.Vector3(p.getX(ia),p.getY(ia),p.getZ(ia)),b=new THREE.Vector3(p.getX(ib),p.getY(ib),p.getZ(ib)),c=new THREE.Vector3(p.getX(ic),p.getY(ic),p.getZ(ic)),cross=new THREE.Vector3().crossVectors(b.clone().sub(a),c.clone().sub(a)),area=cross.length()*.5;if(area<1e-12)continue;const face=cross.normalize();for(const [id,u,v]of [[ia,b,c],[ib,c,a],[ic,a,b]]){const e1=u.clone().sub(new THREE.Vector3(p.getX(id),p.getY(id),p.getZ(id))).normalize(),e2=v.clone().sub(new THREE.Vector3(p.getX(id),p.getY(id),p.getZ(id))).normalize(),angle=Math.acos(clamp(e1.dot(e2),-1,1)),w=angle*((1-blend)+blend*area);out[id*3]+=face.x*w;out[id*3+1]+=face.y*w;out[id*3+2]+=face.z*w}}const old=g.attributes.normal;for(let i=0;i<p.count;i++){let n=new THREE.Vector3(out[i*3],out[i*3+1],out[i*3+2]);if(n.lengthSq()<1e-12&&old)n.fromBufferAttribute(old,i);n.normalize();if(keepSharp&&old){const original=new THREE.Vector3().fromBufferAttribute(old,i);if(original.lengthSq()>0&&n.dot(original)<.5)n.copy(original)}out[i*3]=n.x;out[i*3+1]=n.y;out[i*3+2]=n.z}g.setAttribute('normal',new THREE.BufferAttribute(out,3));return updateBounds(g)}
export function twistGeometry(geometry,strength=1.2,axis='Y'){
  const axisIndex = { X: 1, Y: 0, Z: 2 }[axis] ?? 0;
  const viaCpp = runCppKernel(geometry, null, exp => exp.fe_mod_twist(Number(strength)||0, axisIndex));
  if (viaCpp) return viaCpp;
  const g=geometry.clone(),p=g.attributes.position;
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    if(axisIndex===0){const a=y*strength*.5,c=Math.cos(a),s=Math.sin(a);p.setXYZ(i,x*c-z*s,y,x*s+z*c)}
    else if(axisIndex===1){const a=x*strength*.5,c=Math.cos(a),s=Math.sin(a);p.setXYZ(i,x,y*c-z*s,y*s+z*c)}
    else {const a=z*strength*.5,c=Math.cos(a),s=Math.sin(a);p.setXYZ(i,x*c-y*s,x*s+y*c,z)}}
  p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)}

export function shrinkwrapGeometry(geometry,targetGeometry,relativeMatrixElements,offset=0,mode='On Surface',maxPairs=50000000){
  assertPositions(geometry);assertPositions(targetGeometry);
  const count=geometry.attributes.position.count,triangles=sourceIndices(targetGeometry).length/3;
  if(count*triangles>maxPairs)throw new Error(`Shrinkwrap would require ${count*triangles} point/triangle tests; reduce mesh density or use a BVH target`);
  const modeIndex=mode==='Above Surface'?1:(mode==='Outside Surface'?2:0);
  const viaCpp=runCppKernel(geometry,null,
    exp=>exp.fe_mod_shrinkwrap(modeIndex,Number(offset)||0),
    exp=>uploadTargetMesh(exp,targetGeometry,relativeMatrixElements));
  if(viaCpp)return viaCpp;
  const target=ensureNormalsAndUv(targetGeometry),tp=target.attributes.position,ti=sourceIndices(target);
  const matrix=new THREE.Matrix4().fromArray(Array.from(relativeMatrixElements||new THREE.Matrix4().elements)),tris=[];
  for(let i=0;i+2<ti.length;i+=3){
    const a=new THREE.Vector3(tp.getX(ti[i]),tp.getY(ti[i]),tp.getZ(ti[i])).applyMatrix4(matrix);
    const b=new THREE.Vector3(tp.getX(ti[i+1]),tp.getY(ti[i+1]),tp.getZ(ti[i+1])).applyMatrix4(matrix);
    const c=new THREE.Vector3(tp.getX(ti[i+2]),tp.getY(ti[i+2]),tp.getZ(ti[i+2])).applyMatrix4(matrix);
    const cross=new THREE.Vector3().crossVectors(b.clone().sub(a),c.clone().sub(a));
    if(cross.lengthSq()>1e-24){
      tris.push({triangle:new THREE.Triangle(a,b,c),normal:cross.normalize()});
    }
  }
  if(!tris.length){target.dispose();throw new Error('Shrinkwrap target has no non-degenerate triangles')}

  const g=geometry.clone(),p=g.attributes.position,q=new THREE.Vector3(),best=new THREE.Vector3(),candidate=new THREE.Vector3(),normal=new THREE.Vector3();
  for(let i=0;i<p.count;i++){
    q.set(p.getX(i),p.getY(i),p.getZ(i));
    /* Exact nearest-triangle scan. The old spatial hash could miss the closest
       face when the query sat more than three cells away from the surface, so
       the reference path is exhaustive and deterministic. */
    let bestD=Infinity;
    for(const item of tris){
      item.triangle.closestPointToPoint(q,candidate);
      const d=candidate.distanceToSquared(q);if(d<bestD){bestD=d;best.copy(candidate);normal.copy(item.normal)}
    }
    const delta=q.clone().sub(best);
    if(mode==='Outside Surface'&&delta.dot(normal)<0)normal.negate();
    if(mode==='Above Surface'){
      const signed=delta.dot(normal);
      const minClearance=Number(offset)||0;
      if(signed<minClearance){
        const push=best.clone().addScaledVector(normal,minClearance);
        p.setXYZ(i,push.x,push.y,push.z);
      }
      continue;
    }
    best.addScaledVector(normal,offset);p.setXYZ(i,best.x,best.y,best.z);
  }
  target.dispose();p.needsUpdate=true;g.computeVertexNormals();return updateBounds(g)
}

/* ---- True 3D Volumetric Strut Wireframe Modifier ---- */
export function wireframeGeometry3D(geometry,{thickness=.03,replaceOriginal=true}={}){
  const p=assertPositions(geometry),idx=sourceIndices(geometry),r=clamp(Number(thickness)||.03,.002,.5)*.5;
  const box=geometry.boundingBox||(geometry.computeBoundingBox(),geometry.boundingBox);
  const eps=Math.max((box?box.getSize(new THREE.Vector3()).length():1)*1e-6,1e-8);
  const uniq=[],keyMap=new Map(),canon=new Uint32Array(p.count);
  for(let i=0;i<p.count;i++){
    const k=vertexKey(p.getX(i),p.getY(i),p.getZ(i),eps);
    let id=keyMap.get(k);if(id===undefined){id=uniq.length;keyMap.set(k,id);uniq.push(new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i)))}
    canon[i]=id;
  }
  const edges=new Map();
  for(let i=0;i+2<idx.length;i+=3){
    const a=canon[idx[i]],b=canon[idx[i+1]],c=canon[idx[i+2]];
    for(const [u,v]of [[a,b],[b,c],[c,a]]){
      if(u===v)continue;
      const lo=Math.min(u,v),hi=Math.max(u,v),ek=`${lo}:${hi}`;
      if(!edges.has(ek))edges.set(ek,[lo,hi]);
    }
  }
  if(!edges.size)throw new Error('Wireframe found no valid triangle edges');

  const outPos=[],outNrm=[],outUv=[],outIdx=[];
  if(!replaceOriginal){
    const base=geometry.index?geometry.clone():weldGeometry(geometry,1e-7);
    if(!base.attributes.normal)base.computeVertexNormals();
    const bp=base.attributes.position,bn=base.attributes.normal,bu=base.attributes.uv,bi=sourceIndices(base);
    for(let i=0;i<bp.count;i++){
      outPos.push(bp.getX(i),bp.getY(i),bp.getZ(i));
      outNrm.push(bn.getX(i),bn.getY(i),bn.getZ(i));
      outUv.push(bu?bu.getX(i):0,bu?bu.getY(i):0);
    }
    for(let i=0;i<bi.length;i++)outIdx.push(bi[i]);
    base.dispose();
  }

  /* 4-sided diamond prism strut per unique edge + octahedral vertex joints */
  const tangent=new THREE.Vector3(),uAxis=new THREE.Vector3(),vAxis=new THREE.Vector3(),up=new THREE.Vector3();
  for(const [ia,ib]of edges.values()){
    const pa=uniq[ia],pb=uniq[ib];
    tangent.subVectors(pb,pa);
    const len=tangent.length();if(len<1e-8)continue;
    tangent.multiplyScalar(1/len);
    up.set(Math.abs(tangent.y)<.9?0:1,Math.abs(tangent.y)<.9?1:0,0);
    uAxis.crossVectors(tangent,up).normalize();
    vAxis.crossVectors(tangent,uAxis).normalize();

    const dirs=[uAxis,vAxis,uAxis.clone().negate(),vAxis.clone().negate()];
    const baseIdx=outPos.length/3;
    for(let end=0;end<2;end++){
      const origin=end?pb:pa;
      for(let s=0;s<4;s++){
        const d=dirs[s];
        outPos.push(origin.x+d.x*r,origin.y+d.y*r,origin.z+d.z*r);
        outNrm.push(d.x,d.y,d.z);
        outUv.push(s/4,end);
      }
    }
    for(let s=0;s<4;s++){
      const sn=(s+1)%4;
      const a0=baseIdx+s,a1=baseIdx+sn,b0=baseIdx+4+s,b1=baseIdx+4+sn;
      outIdx.push(a0,b0,b1,a0,b1,a1);
    }
  }
  /* Compact octahedral joint hubs at unique vertices so corners are sealed */
  const hubDirs=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const hubFaces=[[0,2,4],[4,2,1],[1,2,5],[5,2,0],[4,3,0],[1,3,4],[5,3,1],[0,3,5]];
  const hr=r*1.08;
  for(const center of uniq){
    const baseIdx=outPos.length/3;
    for(const [dx,dy,dz]of hubDirs){
      outPos.push(center.x+dx*hr,center.y+dy*hr,center.z+dz*hr);
      outNrm.push(dx,dy,dz);
      outUv.push(.5,.5);
    }
    for(const [f0,f1,f2]of hubFaces)outIdx.push(baseIdx+f0,baseIdx+f1,baseIdx+f2);
  }

  const out=new THREE.BufferGeometry();
  out.setAttribute('position',new THREE.Float32BufferAttribute(outPos,3));
  out.setAttribute('normal',new THREE.Float32BufferAttribute(outNrm,3));
  out.setAttribute('uv',new THREE.Float32BufferAttribute(outUv,2));
  out.setIndex(new THREE.BufferAttribute(outIdx.length>65535?new Uint32Array(outIdx):new Uint16Array(outIdx),1));
  return updateBounds(out);
}

/* ---- True 3D Bernstein Free-Form Deformation (FFD) Lattice Cage & Evaluator ---- */
function cppLatticeCagePositions(targetGeometry, nx, ny, nz, padRatio) {
  const exp = cppExports();
  if (!exp || typeof exp.fe_mod_lattice_cage !== 'function') return null;
  const base = kernelCapacities(targetGeometry);
  if (!base) return null;
  for (const name of Object.keys(targetGeometry.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') return null;
  try {
    if (exp.fe_mod_begin(base.v, base.t, 0) !== 0) return null;
    const buf = exp.memory.buffer;
    new Float32Array(buf, exp.fe_mod_in_pos_ptr(), base.v * 3).set(targetGeometry.attributes.position.array.subarray(0, base.v * 3));
    const idx = new Uint32Array(buf, exp.fe_mod_in_idx_ptr(), base.t * 3);
    if (targetGeometry.index) idx.set(targetGeometry.index.array.subarray(0, base.t * 3));
    else for (let i = 0; i < base.t * 3; i++) idx[i] = i;
    exp.fe_mod_set_counts(base.v, base.t);
    const points = exp.fe_mod_lattice_cage(nx, ny, nz, padRatio);
    if (points <= 0) return null;
    return Array.from(new Float32Array(exp.memory.buffer, exp.fe_mod_lattice_rest_ptr(), points * 3));
  } catch { return null; }
}

export function createLatticeCageGeometry(targetGeometry,divisions=[2,2,2],padRatio=0.04){
  assertPositions(targetGeometry);
  const nx=clamp(Math.round(divisions[0]||2),1,4),ny=clamp(Math.round(divisions[1]||2),1,4),nz=clamp(Math.round(divisions[2]||2),1,4);
  const id=(i,j,k)=>i+(nx+1)*(j+(ny+1)*k);
  let positions=cppLatticeCagePositions(targetGeometry,nx,ny,nz,padRatio);
  let boundsMin,boundsMax;
  if(positions){
    boundsMin=[Infinity,Infinity,Infinity];boundsMax=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<positions.length;i+=3)for(let a=0;a<3;a++){boundsMin[a]=Math.min(boundsMin[a],positions[i+a]);boundsMax[a]=Math.max(boundsMax[a],positions[i+a]);}
  }else{
    targetGeometry.computeBoundingBox();
    const box=targetGeometry.boundingBox.clone();
    const size=box.getSize(new THREE.Vector3());
    const pad=Math.max(size.length()*(padRatio>0?padRatio:.04),.04);
    box.min.subScalar(pad);box.max.addScalar(pad);
    positions=[];
    for(let k=0;k<=nz;k++)for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){
      positions.push(
        THREE.MathUtils.lerp(box.min.x,box.max.x,i/nx),
        THREE.MathUtils.lerp(box.min.y,box.max.y,j/ny),
        THREE.MathUtils.lerp(box.min.z,box.max.z,k/nz)
      );
    }
    boundsMin=box.min.toArray();boundsMax=box.max.toArray();
  }
  /* Triangulate outer 6 faces of the FFD lattice so it is selectable, sculptable & editable in Edit Mode */
  const indices=[];
  const quad=(a,b,c,d)=>{indices.push(a,b,c,a,c,d)};
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    quad(id(i,j,nz),id(i+1,j,nz),id(i+1,j+1,nz),id(i,j+1,nz));
    quad(id(i+1,j,0),id(i,j,0),id(i,j+1,0),id(i+1,j+1,0));
  }
  for(let k=0;k<nz;k++)for(let j=0;j<ny;j++){
    quad(id(nx,j,k+1),id(nx,j,k),id(nx,j+1,k),id(nx,j+1,k+1));
    quad(id(0,j,k),id(0,j,k+1),id(0,j+1,k+1),id(0,j+1,k));
  }
  for(let k=0;k<nz;k++)for(let i=0;i<nx;i++){
    quad(id(i,ny,k+1),id(i+1,ny,k+1),id(i+1,ny,k),id(i,ny,k));
    quad(id(i,0,k),id(i+1,0,k),id(i+1,0,k+1),id(i,0,k+1));
  }
  const cage=new THREE.BufferGeometry();
  cage.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  cage.setIndex(indices);
  cage.computeVertexNormals();
  cage.userData={divisions:[nx,ny,nz],restPositions:Array.from(positions),boundsMin,boundsMax};
  return updateBounds(cage);
}

function bernstein(n,i,t){
  let binom=1;for(let k=1;k<=i;k++)binom=binom*(n-k+1)/k;
  return binom*Math.pow(1-t,n-i)*Math.pow(t,i);
}

export function latticeDeformGeometry(geometry,restCagePositions,deformedCagePositions,divisions=[2,2,2],relativeMatrixElements=null,strength=1){
  const p=assertPositions(geometry);
  const nx=clamp(Math.round(divisions[0]||2),1,4),ny=clamp(Math.round(divisions[1]||2),1,4),nz=clamp(Math.round(divisions[2]||2),1,4);
  const expected=(nx+1)*(ny+1)*(nz+1)*3;
  if(!restCagePositions||!deformedCagePositions||restCagePositions.length<expected||deformedCagePositions.length<expected){
    throw new Error('Lattice control-cage vertex count does not match FFD resolution');
  }
  const viaCpp=runCppKernel(geometry,null,
    exp=>exp.fe_mod_lattice_apply(nx,ny,nz,clamp(Number(strength)??1,0,2)),
    exp=>{
      const points=(nx+1)*(ny+1)*(nz+1);
      if(exp.fe_mod_lattice_alloc(points)!==0)return false;
      const buf=exp.memory.buffer;
      new Float32Array(buf,exp.fe_mod_lattice_rest_ptr(),points*3).set(Float32Array.from(restCagePositions).subarray(0,points*3));
      new Float32Array(buf,exp.fe_mod_lattice_deform_ptr(),points*3).set(Float32Array.from(deformedCagePositions).subarray(0,points*3));
      return writeSessionMatrix(exp,relativeMatrixElements);
    });
  if(viaCpp)return viaCpp;
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for(let i=0;i<expected;i+=3){
    minX=Math.min(minX,restCagePositions[i]);maxX=Math.max(maxX,restCagePositions[i]);
    minY=Math.min(minY,restCagePositions[i+1]);maxY=Math.max(maxY,restCagePositions[i+1]);
    minZ=Math.min(minZ,restCagePositions[i+2]);maxZ=Math.max(maxZ,restCagePositions[i+2]);
  }
  const sx=Math.max(maxX-minX,1e-5),sy=Math.max(maxY-minY,1e-5),sz=Math.max(maxZ-minZ,1e-5);
  const mat=relativeMatrixElements?new THREE.Matrix4().fromArray(Array.from(relativeMatrixElements)):new THREE.Matrix4();
  const defPts=new Float64Array(expected);
  const tmp=new THREE.Vector3();
  for(let i=0;i<expected;i+=3){
    tmp.set(deformedCagePositions[i],deformedCagePositions[i+1],deformedCagePositions[i+2]).applyMatrix4(mat);
    defPts[i]=tmp.x;defPts[i+1]=tmp.y;defPts[i+2]=tmp.z;
  }
  const out=geometry.clone(),op=out.attributes.position,blend=clamp(Number(strength)??1,0,2);
  const bx=new Float64Array(nx+1),by=new Float64Array(ny+1),bz=new Float64Array(nz+1);
  const id=(i,j,k)=>(i+(nx+1)*(j+(ny+1)*k))*3;
  for(let v=0;v<op.count;v++){
    const vx=op.getX(v),vy=op.getY(v),vz=op.getZ(v);
    const u=clamp((vx-minX)/sx,0,1),w=clamp((vy-minY)/sy,0,1),t=clamp((vz-minZ)/sz,0,1);
    for(let i=0;i<=nx;i++)bx[i]=bernstein(nx,i,u);
    for(let j=0;j<=ny;j++)by[j]=bernstein(ny,j,w);
    for(let k=0;k<=nz;k++)bz[k]=bernstein(nz,k,t);
    let fx=0,fy=0,fz=0;
    for(let k=0;k<=nz;k++)for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){
      const weight=bx[i]*by[j]*bz[k],c=id(i,j,k);
      fx+=defPts[c]*weight;fy+=defPts[c+1]*weight;fz+=defPts[c+2]*weight;
    }
    op.setXYZ(v,vx+(fx-vx)*blend,vy+(fy-vy)*blend,vz+(fz-vz)*blend);
  }
  op.needsUpdate=true;out.computeVertexNormals();return updateBounds(out);
}

/* ---- Volume-Preserving Dual-Quaternion / LBS Armature Skinning ---- */
export function armatureSkinGeometry(geometry,{influence=1,preserveVolume=true,bendDeg=25,twistDeg=0,rigRelativeMatrixElements=null}={}){
  const p=assertPositions(geometry);
  const out=geometry.clone(),op=out.attributes.position;
  out.computeBoundingBox();
  const minY=out.boundingBox.min.y,maxY=out.boundingBox.max.y,spanY=Math.max(maxY-minY,1e-4);
  const midY=minY+spanY*.5;
  const inf=clamp(Number(influence)??1,0,1);
  if(inf<=1e-6)return out;
  const viaCpp=runCppKernel(geometry,null,
    exp=>exp.fe_mod_armature(inf,preserveVolume?1:0,Number(bendDeg)||0,Number(twistDeg)||0),
    exp=>writeSessionMatrix(exp,rigRelativeMatrixElements));
  if(viaCpp){out.dispose();return viaCpp;}

  const bendRad=(Number(bendDeg)||0)*Math.PI/180*inf;
  const twistRad=(Number(twistDeg)||0)*Math.PI/180*inf;

  /* Upper-bone rigid transform around joint pivot (0, midY, 0) + optional Rig Object delta */
  const pivot=new THREE.Vector3(out.boundingBox.getCenter(new THREE.Vector3()).x,midY,out.boundingBox.getCenter(new THREE.Vector3()).z);
  const mPivotToOrigin=new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z);
  const mOriginToPivot=new THREE.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z);
  const mBend=new THREE.Matrix4().makeRotationZ(bendRad);
  const mTwist=new THREE.Matrix4().makeRotationY(twistRad);
  const mBone1=new THREE.Matrix4().multiply(mOriginToPivot).multiply(mBend).multiply(mTwist).multiply(mPivotToOrigin);
  if(rigRelativeMatrixElements){
    const mRig=new THREE.Matrix4().fromArray(Array.from(rigRelativeMatrixElements));
    mBone1.premultiply(mRig);
  }

  /* Extract unit quaternion + translation for Dual-Quaternion volume-preserving skinning */
  const e=mBone1.elements;
  const trace=e[0]+e[5]+e[10];
  let qx,qy,qz,qw;
  if(trace>0){const s=.5/Math.sqrt(trace+1);qw=.25/s;qx=(e[6]-e[9])*s;qy=(e[8]-e[2])*s;qz=(e[1]-e[4])*s}
  else if(e[0]>e[5]&&e[0]>e[10]){const s=2*Math.sqrt(1+e[0]-e[5]-e[10]);qw=(e[6]-e[9])/s;qx=.25*s;qy=(e[4]+e[1])/s;qz=(e[8]+e[2])/s}
  else if(e[5]>e[10]){const s=2*Math.sqrt(1+e[5]-e[0]-e[10]);qw=(e[8]-e[2])/s;qx=(e[4]+e[1])/s;qy=.25*s;qz=(e[9]+e[6])/s}
  else{const s=2*Math.sqrt(1+e[10]-e[0]-e[5]);qw=(e[1]-e[4])/s;qx=(e[8]+e[2])/s;qy=(e[9]+e[6])/s;qz=.25*s}
  const qLen=Math.hypot(qx,qy,qz,qw)||1;qx/=qLen;qy/=qLen;qz/=qLen;qw/=qLen;
  if(qw<0){qx=-qx;qy=-qy;qz=-qz;qw=-qw}
  const tx=e[12],ty=e[13],tz=e[14];
  /* Dual part q_d = 0.5 * t * q_r */
  const dqx=.5*(tx*qw+ty*qz-tz*qy),dqy=.5*(-tx*qz+ty*qw+tz*qx),dqz=.5*(tx*qy-ty*qx+tz*qw),dqw=.5*(-tx*qx-ty*qy-tz*qz);

  const v0=new THREE.Vector3(),v1=new THREE.Vector3();
  for(let i=0;i<op.count;i++){
    const x=op.getX(i),y=op.getY(i),z=op.getZ(i);
    const tNorm=clamp((y-minY)/spanY,0,1);
    /* Smooth C2 heat-diffusion weight along bone chain */
    const w1=tNorm*tNorm*(3-2*tNorm);
    const w0=1-w1;
    if(!preserveVolume){
      v0.set(x,y,z);v1.set(x,y,z).applyMatrix4(mBone1);
      op.setXYZ(i,v0.x*w0+v1.x*w1,v0.y*w0+v1.y*w1,v0.z*w0+v1.z*w1);
    }else{
      /* Volume-preserving Dual Quaternion blend */
      let rx=qx*w1,ry=qy*w1,rz=qz*w1,rw=w0+qw*w1;
      let ex=dqx*w1,ey=dqy*w1,ez=dqz*w1,ew=dqw*w1;
      const invNorm=1/(Math.hypot(rx,ry,rz,rw)||1);
      rx*=invNorm;ry*=invNorm;rz*=invNorm;rw*=invNorm;
      ex*=invNorm;ey*=invNorm;ez*=invNorm;ew*=invNorm;
      /* Screw translation t = 2 * q_e * conj(q_r) */
      const btx=2*(-ew*rx+ex*rw-ey*rz+ez*ry);
      const bty=2*(-ew*ry+ex*rz+ey*rw-ez*rx);
      const btz=2*(-ew*rz-ex*ry+ey*rx+ez*rw);
      /* Rotate point by unit quaternion r + translate by bt */
      const ix=rw*x+ry*z-rz*y,iy=rw*y+rz*x-rx*z,iz=rw*z+rx*y-ry*x,iw=-rx*x-ry*y-rz*z;
      const sx=ix*rw+iw*-rx+iy*-rz-iz*-ry+btx;
      const sy=iy*rw+iw*-ry+iz*-rx-ix*-rz+bty;
      const sz=iz*rw+iw*-rz+ix*-ry-iy*-rx+btz;
      op.setXYZ(i,sx,sy,sz);
    }
  }
  op.needsUpdate=true;out.computeVertexNormals();return updateBounds(out);
}

/* ---- Barycentric + Normal Surface Deform Binding & Evaluator ---- */
function cppBindSurfaceDeform(geometry, targetGeometry, matrixElements) {
  const exp = cppExports();
  if (!exp || typeof exp.fe_mod_sd_bind !== 'function') return null;
  const base = kernelCapacities(geometry);
  if (!base) return null;
  for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') return null;
  if (geometry.attributes.position.itemSize !== 3) return null;
  try {
    if (exp.fe_mod_begin(base.v, base.t, 0) !== 0) return null;
    const buf = exp.memory.buffer;
    new Float32Array(buf, exp.fe_mod_in_pos_ptr(), base.v * 3).set(geometry.attributes.position.array.subarray(0, base.v * 3));
    const idx = new Uint32Array(buf, exp.fe_mod_in_idx_ptr(), base.t * 3);
    if (geometry.index) idx.set(geometry.index.array.subarray(0, base.t * 3));
    else for (let i = 0; i < base.t * 3; i++) idx[i] = i;
    exp.fe_mod_set_counts(base.v, base.t);
    if (!uploadTargetMesh(exp, targetGeometry, matrixElements)) return null;
    if (exp.fe_mod_sd_bind() !== 0) return null;
    const triCount = exp.fe_mod_sd_tri_count();
    if (!triCount) return null;
    const ord = new Uint32Array(exp.memory.buffer, exp.fe_mod_sd_ordinal_ptr(), base.v).slice();
    const bary = new Float32Array(exp.memory.buffer, exp.fe_mod_sd_bary_ptr(), base.v * 3).slice();
    const scal = new Float32Array(exp.memory.buffer, exp.fe_mod_sd_scalars_ptr(), base.v * 2).slice();
    const tris = new Uint32Array(exp.memory.buffer, exp.fe_mod_sd_tris_ptr(), triCount * 3).slice();
    const normalOffset = new Float32Array(base.v), refScale = new Float32Array(base.v);
    for (let i = 0; i < base.v; i++) { normalOffset[i] = scal[i * 2]; refScale[i] = scal[i * 2 + 1]; }
    const triIndices = new Array(triCount);
    for (let t = 0; t < triCount; t++) triIndices[t] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    return { triIndices, vertexTri: ord, bary, normalOffset, refScale, targetVertexCount: targetGeometry.attributes.position.count };
  } catch { return null; }
}

export function bindSurfaceDeform(geometry,targetGeometry,relativeMatrixElements){
  const p=assertPositions(geometry),tp=assertPositions(targetGeometry),ti=sourceIndices(targetGeometry);
  const viaCpp=cppBindSurfaceDeform(geometry,targetGeometry,relativeMatrixElements);
  if(viaCpp)return viaCpp;
  const mat=new THREE.Matrix4().fromArray(Array.from(relativeMatrixElements||new THREE.Matrix4().elements));
  const tris=[];
  for(let i=0;i+2<ti.length;i+=3){
    const ia=ti[i],ib=ti[i+1],ic=ti[i+2];
    const a=new THREE.Vector3(tp.getX(ia),tp.getY(ia),tp.getZ(ia)).applyMatrix4(mat);
    const b=new THREE.Vector3(tp.getX(ib),tp.getY(ib),tp.getZ(ib)).applyMatrix4(mat);
    const c=new THREE.Vector3(tp.getX(ic),tp.getY(ic),tp.getZ(ic)).applyMatrix4(mat);
    const cross=new THREE.Vector3().crossVectors(b.clone().sub(a),c.clone().sub(a));
    const len=cross.length();
    if(len>1e-10)tris.push({ia,ib,ic,tri:new THREE.Triangle(a,b,c),normal:cross.multiplyScalar(1/len),scale:Math.sqrt(len*.5)});
  }
  if(!tris.length)throw new Error('Surface Deform target has no valid triangles');
  const triIdx=new Uint32Array(p.count),bary=new Float32Array(p.count*3),nOff=new Float32Array(p.count),refScale=new Float32Array(p.count);
  const q=new THREE.Vector3(),cp=new THREE.Vector3(),bc=new THREE.Vector3();
  for(let v=0;v<p.count;v++){
    q.set(p.getX(v),p.getY(v),p.getZ(v));
    let bestD=Infinity,bestT=0;
    for(let t=0;t<tris.length;t++){
      tris[t].tri.closestPointToPoint(q,cp);
      const d=cp.distanceToSquared(q);if(d<bestD){bestD=d;bestT=t}
    }
    const chosen=tris[bestT];
    chosen.tri.closestPointToPoint(q,cp);
    chosen.tri.getBarycoord(cp,bc);
    triIdx[v]=bestT;
    bary[v*3]=bc.x;bary[v*3+1]=bc.y;bary[v*3+2]=bc.z;
    nOff[v]=q.clone().sub(cp).dot(chosen.normal);
    refScale[v]=Math.max(chosen.scale,1e-5);
  }
  return {
    triIndices:Array.from(tris,t=>[t.ia,t.ib,t.ic]),
    vertexTri:triIdx,
    bary,
    normalOffset:nOff,
    refScale,
    targetVertexCount:tp.count
  };
}

export function surfaceDeformGeometry(geometry,binding,currentTargetGeometry,relativeMatrixElements,strength=1){
  const p=assertPositions(geometry),tp=assertPositions(currentTargetGeometry);
  if(!binding||tp.count!==binding.targetVertexCount||binding.vertexTri.length!==p.count){
    throw new Error('Surface Deform binding is out of date with target topology; re-bind surface.');
  }
  if(binding.triIndices){
    const viaCpp=runCppKernel(geometry,null,
      exp=>exp.fe_mod_sd_apply(clamp(Number(strength)??1,0,1)),
      exp=>{
        if(!uploadTargetMesh(exp,currentTargetGeometry,relativeMatrixElements))return false;
        const verts=binding.vertexTri.length,triCount=binding.triIndices.length;
        if(exp.fe_mod_sd_upload(verts,triCount)!==0)return false;
        const buf=exp.memory.buffer;
        new Uint32Array(buf,exp.fe_mod_sd_ordinal_ptr(),verts).set(binding.vertexTri);
        new Float32Array(buf,exp.fe_mod_sd_bary_ptr(),verts*3).set(binding.bary);
        const trisView=new Uint32Array(buf,exp.fe_mod_sd_tris_ptr(),triCount*3);
        for(let t=0;t<triCount;t++){const tri=binding.triIndices[t];trisView[t*3]=tri[0];trisView[t*3+1]=tri[1];trisView[t*3+2]=tri[2];}
        const scalView=new Float32Array(buf,exp.fe_mod_sd_scalars_ptr(),verts*2);
        for(let i=0;i<verts;i++){scalView[i*2]=binding.normalOffset[i];scalView[i*2+1]=binding.refScale[i];}
        return true;
      });
    if(viaCpp)return viaCpp;
  }
  const mat=new THREE.Matrix4().fromArray(Array.from(relativeMatrixElements||new THREE.Matrix4().elements));
  const out=geometry.clone(),op=out.attributes.position,blend=clamp(Number(strength)??1,0,1);
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),n=new THREE.Vector3();
  for(let v=0;v<op.count;v++){
    const [ia,ib,ic]=binding.triIndices[binding.vertexTri[v]];
    a.set(tp.getX(ia),tp.getY(ia),tp.getZ(ia)).applyMatrix4(mat);
    b.set(tp.getX(ib),tp.getY(ib),tp.getZ(ib)).applyMatrix4(mat);
    c.set(tp.getX(ic),tp.getY(ic),tp.getZ(ic)).applyMatrix4(mat);
    n.crossVectors(b.clone().sub(a),c.clone().sub(a));
    const len=n.length(),curScale=len>1e-10?Math.sqrt(len*.5):binding.refScale[v];
    if(len>1e-10)n.multiplyScalar(1/len);else n.set(0,1,0);
    const bu=binding.bary[v*3],bv=binding.bary[v*3+1],bw=binding.bary[v*3+2];
    const ratio=clamp(curScale/binding.refScale[v],.25,4);
    const tx=a.x*bu+b.x*bv+c.x*bw+n.x*binding.normalOffset[v]*ratio;
    const ty=a.y*bu+b.y*bv+c.y*bw+n.y*binding.normalOffset[v]*ratio;
    const tz=a.z*bu+b.z*bv+c.z*bw+n.z*binding.normalOffset[v]*ratio;
    op.setXYZ(v,THREE.MathUtils.lerp(op.getX(v),tx,blend),THREE.MathUtils.lerp(op.getY(v),ty,blend),THREE.MathUtils.lerp(op.getZ(v),tz,blend));
  }
  op.needsUpdate=true;out.computeVertexNormals();return updateBounds(out);
}

