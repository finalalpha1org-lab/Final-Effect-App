/* Rust/WASM numerical solver bridge for cloth, soft-body, liquid and buoyant tracers. */
(function installSimulationEngine(global) {
  const MAX_PARTICLES = 768;
  const DEFORMABLE_FIXED_STEP = 1 / 120;
  const MAX_DEFORMABLE_SUBSTEPS = 8;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const number = (params, key, fallback) => {
    const value = Number.parseFloat(params?.[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  const tracerPresets = (domainType, params = {}) => {
    const combined = params['Fire & Smoke Preset'] || 'Campfire & Smoke';
    if (domainType === 'Fire + Smoke') {
      const presets = combined === 'Wildfire Blast' ? ['Wildfire', 'Heavy Fog'] : combined === 'Torch & Soot' ? ['Torch', 'Dark Soot'] : ['Campfire', 'Normal Smoke'];
      return { fire: presets[0], smoke: presets[1] };
    }
    return { fire: params['Fire Preset'] || 'Campfire', smoke: params['Smoke Preset'] || 'Normal Smoke' };
  };
  const tracerLifetime = (record) => clamp((record.count / Math.max(number(record.params, 'Flow Rate', 40), 1)) * (1.2 + number(record.params, 'Flame Height', 1.5) / 1.5), 1, 20);
  const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
  const tracerSpriteCache = new Map();
  function tracerSpriteTexture(kind) {
    if (tracerSpriteCache.has(kind)) return tracerSpriteCache.get(kind);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,128,128);
    if(kind==='fire'){
      ctx.save();ctx.beginPath();ctx.moveTo(64,7);ctx.bezierCurveTo(92,35,99,63,88,94);ctx.bezierCurveTo(81,116,44,124,31,99);ctx.bezierCurveTo(15,73,38,51,40,30);ctx.bezierCurveTo(48,44,50,52,52,60);ctx.bezierCurveTo(61,46,57,27,64,7);ctx.closePath();ctx.clip();
      const g=ctx.createRadialGradient(62,76,2,64,70,62);g.addColorStop(0,'rgba(255,255,224,1)');g.addColorStop(.2,'rgba(255,219,78,.98)');g.addColorStop(.48,'rgba(255,119,22,.86)');g.addColorStop(.78,'rgba(202,38,4,.55)');g.addColorStop(1,'rgba(84,11,0,0)');ctx.fillStyle=g;ctx.fillRect(0,0,128,128);ctx.restore();
    }else{
      let state=0x8f31a5;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296};
      for(let i=0;i<18;i++){const x=28+rand()*72,y=27+rand()*76,r=13+rand()*25,g=ctx.createRadialGradient(x,y,1,x,y,r);g.addColorStop(0,`rgba(245,248,250,${.28+rand()*.14})`);g.addColorStop(.55,`rgba(178,188,198,${.14+rand()*.08})`);g.addColorStop(1,'rgba(110,120,130,0)');ctx.fillStyle=g;ctx.fillRect(x-r,y-r,r*2,r*2)}
      const g=ctx.createRadialGradient(64,66,8,64,64,65);g.addColorStop(0,'rgba(255,255,255,.10)');g.addColorStop(.45,'rgba(225,232,238,.10)');g.addColorStop(1,'rgba(150,160,170,0)');ctx.fillStyle=g;ctx.fillRect(0,0,128,128);
    }
    const tex=new THREE.CanvasTexture(canvas);tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;tex.minFilter=THREE.LinearFilter;tex.magFilter=THREE.LinearFilter;if('colorSpace'in tex&&THREE.SRGBColorSpace!==undefined)tex.colorSpace=THREE.SRGBColorSpace;else if('encoding'in tex)tex.encoding=THREE.sRGBEncoding;tex.needsUpdate=true;tracerSpriteCache.set(kind,tex);return tex;
  }

  class WasmArena {
    constructor(exports) {
      this.memory = exports.memory;
      const heap = exports.__heap_base;
      const start = Number(heap?.value ?? heap ?? 65536);
      this.next = align(start + 256, 16);
    }

    alloc(byteLength, alignment = 4) {
      const pointer = align(this.next, alignment);
      const end = pointer + Math.max(byteLength, alignment);
      if (!Number.isSafeInteger(end)) throw new Error('WASM memory allocation overflow');
      const currentBytes = this.memory.buffer.byteLength;
      if (end > currentBytes) {
        const pages = Math.ceil((end - currentBytes) / 65536);
        this.memory.grow(pages);
      }
      this.next = end;
      return pointer;
    }

    allocF32(length) { return this.alloc(length * 4, 4); }
    allocU32(length) { return this.alloc(length * 4, 4); }
    allocU8(length) { return this.alloc(length, 1); }
    f32(pointer, length) { return new Float32Array(this.memory.buffer, pointer, length); }
    u32(pointer, length) { return new Uint32Array(this.memory.buffer, pointer, length); }
    u8(pointer, length) { return new Uint8Array(this.memory.buffer, pointer, length); }
    writeF32(pointer, values) { this.f32(pointer, values.length).set(values); }
    writeU32(pointer, values) { this.u32(pointer, values.length).set(values); }
    writeU8(pointer, values) { this.u8(pointer, values.length).set(values); }
  }

  function meshTopology(geometry, type, params = {}) {
    const attribute = geometry?.attributes?.position;
    if (!attribute || attribute.itemSize < 3 || attribute.count < 3) throw new Error('Simulation mesh needs a 3D position attribute');
    const originalCount = attribute.count;
    const vertexMap = new Uint32Array(originalCount);
    const originalPositions = new Float32Array(originalCount * 3);
    const unique = [];
    const uniqueByPosition = new Map();
    for (let i = 0; i < originalCount; i++) {
      const x = attribute.getX(i), y = attribute.getY(i), z = attribute.getZ(i);
      originalPositions.set([x, y, z], i * 3);
      const key = `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
      let node = uniqueByPosition.get(key);
      if (node === undefined) { node = unique.length / 3; uniqueByPosition.set(key, node); unique.push(x, y, z); }
      vertexMap[i] = node;
    }
    const sourceIndices = geometry.index?.array;
    const indexCount = sourceIndices?.length ?? originalCount;
    const edgeRecords = new Map(), faces = [];
    const registerEdge = (rawA, rawB, rawOpposite) => {
      const a = vertexMap[rawA], b = vertexMap[rawB], opposite = vertexMap[rawOpposite];
      if (a === b || opposite === a || opposite === b) return;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}:${hi}`;
      let record = edgeRecords.get(key);
      if (!record) { record = { a: lo, b: hi, opposites: [] }; edgeRecords.set(key, record); }
      if (!record.opposites.includes(opposite)) record.opposites.push(opposite);
    };
    for (let i = 0; i + 2 < indexCount; i += 3) {
      const a = sourceIndices ? sourceIndices[i] : i;
      const b = sourceIndices ? sourceIndices[i + 1] : i + 1;
      const c = sourceIndices ? sourceIndices[i + 2] : i + 2;
      const fa = vertexMap[a], fb = vertexMap[b], fc = vertexMap[c];
      if (fa !== fb && fb !== fc && fc !== fa) faces.push(fa, fb, fc);
      registerEdge(a, b, c); registerEdge(b, c, a); registerEdge(c, a, b);
    }
    if (!edgeRecords.size) throw new Error('Simulation mesh has no triangle-edge constraints');
    const rest = new Float32Array(unique);
    const distance = (a, b) => { const ia = a * 3, ib = b * 3; return Math.hypot(rest[ia] - rest[ib], rest[ia + 1] - rest[ib + 1], rest[ia + 2] - rest[ib + 2]); };
    const baseEdges = [...edgeRecords.values()].map(edge => ({ ...edge, length: distance(edge.a, edge.b) }));
    const sortedLengths = baseEdges.map(edge => edge.length).filter(value => value > 1e-8).sort((a, b) => a - b);
    const medianLength = sortedLengths[Math.floor(sortedLengths.length / 2)] || 1;
    const structural = Math.max(number(params, 'Structural Stiffness', 15), 1);
    const shearWeight = clamp(number(params, 'Shear Stiffness', 5) / structural, 0, 1);
    const bendWeight = clamp(number(params, 'Bend Stiffness', 2) / structural, 0, 1) * clamp(number(params, 'Bending Resistance', 0.5), 0, 1);
    const constraints = [], seen = new Set();
    const addConstraint = (a, b, weight) => {
      if (a === b) return;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}:${hi}`;
      if (seen.has(key)) return;
      seen.add(key); constraints.push({ a: lo, b: hi, length: distance(lo, hi), weight: clamp(weight, 0, 1) });
    };
    for (const edge of baseEdges) {
      const isShearDiagonal = type === 'Cloth' && edge.length > medianLength * 1.35;
      addConstraint(edge.a, edge.b, isShearDiagonal ? shearWeight : 1);
      if (type === 'Cloth' && edge.opposites.length === 2) addConstraint(edge.opposites[0], edge.opposites[1], bendWeight);
    }
    const edgePairs = new Uint32Array(constraints.length * 2), edgeLengths = new Float32Array(constraints.length), edgeWeights = new Float32Array(constraints.length);
    for (let i = 0; i < constraints.length; i++) {
      const edge = constraints[i]; edgePairs[i * 2] = edge.a; edgePairs[i * 2 + 1] = edge.b;
      edgeLengths[i] = edge.length; edgeWeights[i] = edge.weight;
    }
    return { attribute, vertexMap, originalPositions, rest, edgePairs, edgeLengths, edgeWeights, faces: new Uint32Array(faces) };
  }

  function withSoftBodyVolume(topology) {
    const surfaceNodes = topology.rest.length / 3;
    const faces = topology.faces;
    if (surfaceNodes < 4 || !faces || faces.length < 12 || faces.length / 3 > 8192) return topology;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < topology.rest.length; i += 3) { cx += topology.rest[i]; cy += topology.rest[i + 1]; cz += topology.rest[i + 2]; }
    cx /= surfaceNodes; cy /= surfaceNodes; cz /= surfaceNodes;
    let signedTotal = 0;
    const tetrahedra = [], restVolumes = [];
    for (let i = 0; i + 2 < faces.length; i += 3) {
      const ia = faces[i] * 3, ib = faces[i + 1] * 3, ic = faces[i + 2] * 3;
      const ax = topology.rest[ia] - cx, ay = topology.rest[ia + 1] - cy, az = topology.rest[ia + 2] - cz;
      const bx = topology.rest[ib] - cx, by = topology.rest[ib + 1] - cy, bz = topology.rest[ib + 2] - cz;
      const dx = topology.rest[ic] - cx, dy = topology.rest[ic + 1] - cy, dz = topology.rest[ic + 2] - cz;
      const volume = (ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx)) / 6;
      if (!Number.isFinite(volume) || Math.abs(volume) < 1e-10) continue;
      tetrahedra.push(surfaceNodes, faces[i], faces[i + 1], faces[i + 2]);
      restVolumes.push(volume); signedTotal += volume;
    }
    if (tetrahedra.length < 12 || Math.abs(signedTotal) < 1e-8) return topology;
    const orientation = Math.sign(signedTotal);
    if (restVolumes.some(volume => Math.sign(volume) !== orientation)) return topology;
    const rest = new Float32Array((surfaceNodes + 1) * 3);
    rest.set(topology.rest); rest[surfaceNodes * 3] = cx; rest[surfaceNodes * 3 + 1] = cy; rest[surfaceNodes * 3 + 2] = cz;
    const edgePairs = Array.from(topology.edgePairs), edgeLengths = Array.from(topology.edgeLengths), edgeWeights = Array.from(topology.edgeWeights);
    let edgeLengthTotal = 0;
    for (const length of edgeLengths) edgeLengthTotal += length;
    for (let node = 0; node < surfaceNodes; node++) {
      const i = node * 3, dx = rest[i] - cx, dy = rest[i + 1] - cy, dz = rest[i + 2] - cz;
      edgePairs.push(surfaceNodes, node); edgeLengths.push(Math.hypot(dx, dy, dz)); edgeWeights.push(0.45);
    }
    return { ...topology, rest, edgePairs: new Uint32Array(edgePairs), edgeLengths: new Float32Array(edgeLengths), edgeWeights: new Float32Array(edgeWeights), volumeTets: new Uint32Array(tetrahedra), volumeRest: new Float32Array(restVolumes), surfaceNodeCount: surfaceNodes, averageEdgeLength: edgeLengthTotal / Math.max(topology.edgeLengths.length, 1) };
  }

  function boundsFromPoints(points, padding = 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      minX = Math.min(minX, points[i]); minY = Math.min(minY, points[i + 1]); minZ = Math.min(minZ, points[i + 2]);
      maxX = Math.max(maxX, points[i]); maxY = Math.max(maxY, points[i + 1]); maxZ = Math.max(maxZ, points[i + 2]);
    }
    const sx = Math.max(maxX - minX, 0.25), sy = Math.max(maxY - minY, 0.25), sz = Math.max(maxZ - minZ, 0.25);
    return new Float32Array([minX - Math.max(sx * 0.5, padding), minY - Math.max(sy * 2, padding), minZ - Math.max(sz * 0.5, padding), maxX + Math.max(sx * 0.5, padding), maxY + Math.max(sy * 0.5, padding), maxZ + Math.max(sz * 0.5, padding)]);
  }

  function worldBounds(mesh, padding = 0) {
    mesh.updateWorldMatrix?.(true, false);
    mesh.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) throw new Error('Fluid mesh has empty world bounds');
    const sx = Math.max(box.max.x - box.min.x, 0.25), sy = Math.max(box.max.y - box.min.y, 0.25), sz = Math.max(box.max.z - box.min.z, 0.25);
    return new Float32Array([
      box.min.x - padding, box.min.y - padding, box.min.z - padding,
      box.max.x + padding, box.max.y + padding, box.max.z + padding,
    ]);
  }

  function lattice(bounds, params, liquid) {
    const sx = bounds[3] - bounds[0], sy = bounds[4] - bounds[1], sz = bounds[5] - bounds[2];
    const maxDim = Math.max(sx, sy, sz, 0.25);
    const resolution = clamp(Math.round(number(params, 'Resolution', 80) / 8), 4, 12);
    let nx = Math.max(3, Math.round(resolution * sx / maxDim));
    let ny = Math.max(3, Math.round(resolution * sy / maxDim));
    let nz = Math.max(3, Math.round(resolution * sz / maxDim));
    while (nx * ny * nz > MAX_PARTICLES) {
      if (nx >= ny && nx >= nz) nx--;
      else if (ny >= nz) ny--;
      else nz--;
    }
    const fillBottom = liquid ? 0.58 : 0.18;
    const insetX = sx * 0.08, insetZ = sz * 0.08;
    const lowX = bounds[0] + insetX, highX = bounds[3] - insetX;
    const lowZ = bounds[2] + insetZ, highZ = bounds[5] - insetZ;
    const lowY = bounds[1] + sy * 0.08, highY = bounds[1] + sy * fillBottom;
    const positions = [];
    for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const x = lowX + (ix + 0.5) * (highX - lowX) / nx;
      const y = lowY + (iy + 0.5) * (highY - lowY) / ny;
      const z = lowZ + (iz + 0.5) * (highZ - lowZ) / nz;
      if (liquid) {
        const rx = (x - (lowX + highX) * 0.5) / Math.max((highX - lowX) * 0.5, 1e-4);
        const rz = (z - (lowZ + highZ) * 0.5) / Math.max((highZ - lowZ) * 0.5, 1e-4);
        if (rx * rx + rz * rz > 1.15) continue;
      }
      positions.push(x, y, z);
    }
    const particlePositions = new Float32Array(positions);
    const spacing = maxDim / Math.max(nx, ny, nz);
    const h = Math.max(spacing * 1.9, 0.08);
    const h2 = h * h, h3 = h2 * h, h6 = h3 * h3, h9 = h6 * h3, poly6 = 315 / (64 * Math.PI * Math.max(h9, 1e-12));
    let kernelTotal = 0;
    for (let i = 0; i < particlePositions.length; i += 3) {
      let rho = 0;
      for (let j = 0; j < particlePositions.length; j += 3) {
        const dx = particlePositions[i] - particlePositions[j], dy = particlePositions[i + 1] - particlePositions[j + 1], dz = particlePositions[i + 2] - particlePositions[j + 2];
        const q = h2 - dx * dx - dy * dy - dz * dz;
        if (q > 0) rho += poly6 * q * q * q;
      }
      kernelTotal += rho;
    }
    const averageKernel = kernelTotal / Math.max(particlePositions.length / 3, 1);
    const mass = averageKernel > 1e-8 ? 1 / averageKernel : 1;
    return { positions: particlePositions, spacing, smoothingLength: h, mass, radius: spacing * 0.56 };
  }

  function closestPointOnTriangle(px,py,pz,t,out){
    const ax=t.a[0],ay=t.a[1],az=t.a[2],abx=t.b[0]-ax,aby=t.b[1]-ay,abz=t.b[2]-az,acx=t.c[0]-ax,acy=t.c[1]-ay,acz=t.c[2]-az,apx=px-ax,apy=py-ay,apz=pz-az,d1=abx*apx+aby*apy+abz*apz,d2=acx*apx+acy*apy+acz*apz;
    if(d1<=0&&d2<=0){out[0]=ax;out[1]=ay;out[2]=az;return}
    const bpx=px-t.b[0],bpy=py-t.b[1],bpz=pz-t.b[2],d3=abx*bpx+aby*bpy+abz*bpz,d4=acx*bpx+acy*bpy+acz*bpz;
    if(d3>=0&&d4<=d3){out[0]=t.b[0];out[1]=t.b[1];out[2]=t.b[2];return}
    const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);out[0]=ax+v*abx;out[1]=ay+v*aby;out[2]=az+v*abz;return}
    const cpx=px-t.c[0],cpy=py-t.c[1],cpz=pz-t.c[2],d5=abx*cpx+aby*cpy+abz*cpz,d6=acx*cpx+acy*cpy+acz*cpz;
    if(d6>=0&&d5<=d6){out[0]=t.c[0];out[1]=t.c[1];out[2]=t.c[2];return}
    const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);out[0]=ax+w*acx;out[1]=ay+w*acy;out[2]=az+w*acz;return}
    const va=d3*d6-d5*d4;if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));out[0]=t.b[0]+w*(t.c[0]-t.b[0]);out[1]=t.b[1]+w*(t.c[1]-t.b[1]);out[2]=t.b[2]+w*(t.c[2]-t.b[2]);return}
    const inv=1/(va+vb+vc),v=vb*inv,w=vc*inv;out[0]=ax+abx*v+acx*w;out[1]=ay+aby*v+acy*w;out[2]=az+abz*v+acz*w;
  }

  class UltraSimEngine {
    constructor() {
      this.simMeshes = new Map();
      this.effectors = new Map();
      this.collisionSurfaceCache = new Map();
      this.frameCount = 0;
      this.wasm = null;
      this.arena = null;
      this.loadError = null;
      this.ready = this.loadWasm().then(() => { this.updateStatusBadge(); return true; }).catch((error) => {
        this.loadError = error;
        console.error('[SimulationEngine] Rust/WASM solver could not be loaded; simulations are stopped rather than replaced with fake motion.', error);
        global.FE?.toast?.(`WASM physics unavailable: ${error?.message || error}`);
        this.updateStatusBadge();
        return false;
      });
      global.document?.addEventListener('DOMContentLoaded', () => this.updateStatusBadge(), { once: true });
    }

    updateStatusBadge() {
      const badge = global.document?.getElementById('tb-status-badge');
      if (!badge) return;
      if (this.loadError) { badge.textContent = 'Physics: WASM unavailable'; return; }
      if (!this.wasm) { badge.textContent = 'Physics: Loading Rust/WASM…'; return; }
      const records = [...this.simMeshes.values()];
      const failed = records.find(record => record.status === 'error');
      const active = records.filter(record => record.status === 'running').length;
      badge.textContent = failed ? `Physics error · ${failed.type}` : active ? `Physics: Rust/WASM v${this.abiVersion} · ${active} active` : `Physics: Rust/WASM v${this.abiVersion} ready`;
    }

    getSimKey(type) {
      if (type === 'Cloth') return 'clothSim';
      if (type === 'SoftBody') return 'softBodySim';
      if (type === 'Fluid') return 'fluidSim';
      return 'physicsSim';
    }

    async loadWasm() {
      if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not available in this browser');
      const urls = ['./simulation_solver.wasm', './wasm/simulation_solver.wasm'];
      let response = null;
      for (const path of urls) {
        const candidate = await fetch(new URL(path, document.baseURI), { cache: 'no-cache' });
        if (candidate.ok) { response = candidate; break; }
      }
      if (!response) throw new Error('WASM request failed at the app root and ./wasm/ fallback paths');
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const exports = instance.exports;
      const required = ['memory', '__heap_base', 'sim_solver_abi_version', 'sim_solver_deformable_step', 'sim_solver_sph_step', 'sim_solver_buoyant_tracer_step'];
      for (const name of required) if (!exports[name]) throw new Error(`WASM solver export missing: ${name}`);
      const abiVersion = exports.sim_solver_abi_version();
      if (![1, 2].includes(abiVersion)) throw new Error(`Unsupported solver ABI version ${abiVersion}`);
      this.abiVersion = abiVersion;
      this.wasm = exports;
      this.arena = new WasmArena(exports);
    }

    initSimulation(type, mesh, params = {}) {
      if (!mesh?.geometry?.attributes?.position || !['Cloth', 'SoftBody', 'Fluid'].includes(type)) return;
      this.removeSimulation(type, mesh);
      const record = { type, mesh, geometry: mesh.geometry, params: { ...params }, status: 'loading', failureReported: false, stepAccumulator: 0 };
      mesh.userData ??= {};
      mesh.userData[this.getSimKey(type)] = record;
      if (type === 'Fluid') mesh.userData.fluidSim = record;
      this.simMeshes.set(mesh.uuid, record);
      this.updateStatusBadge();
      this.ready.then((ok) => {
        if (this.simMeshes.get(mesh.uuid) !== record) return;
        if (!ok) { record.status = 'error'; record.error = this.loadError?.message || 'WASM unavailable'; this.updateStatusBadge(); return; }
        try {
          if (type === 'Fluid') this.initFluidSimulation(mesh, record.params, record);
          else this.initClothSoftBody(mesh, type, record.params, record);
          record.status = 'running';
          this.updateStatusBadge();
        } catch (error) {
          this.fail(record, error);
        }
      });
    }

    fail(record, error) {
      record.status = 'error';
      record.error = error?.message || String(error);
      if (!record.failureReported) {
        record.failureReported = true;
        console.error(`[SimulationEngine] ${record.type} solver stopped: ${record.error}`, error);
        global.FE?.toast?.(`${record.type} simulation stopped: ${record.error}`);
        this.updateStatusBadge();
      }
    }

    selectClothPins(mesh, topology, pinned, params = {}) {
      const mode = params['Pinning Mode'] || 'Auto Top Edge';
      if (mode === 'Free' || !pinned.length) return;
      mesh.updateWorldMatrix?.(true, false); mesh.updateMatrixWorld?.(true);
      const matrix = mesh.matrixWorld || new THREE.Matrix4(), count = pinned.length, world = new Float64Array(count * 3), v = new THREE.Vector3();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let node = 0; node < count; node++) {
        const i = node * 3; v.set(topology.rest[i], topology.rest[i + 1], topology.rest[i + 2]).applyMatrix4(matrix);
        world[i] = v.x; world[i + 1] = v.y; world[i + 2] = v.z;
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      }
      const spanY = maxY - minY, spanX = maxX - minX, spanZ = maxZ - minZ;
      if (mode !== 'Two Corners') {
        const cutoff = maxY - Math.max(spanY * 0.025, Math.max(spanX, spanZ) * 0.002, 1e-4);
        for (let node = 0; node < count; node++) if (world[node * 3 + 1] >= cutoff) pinned[node] = 1;
      }
      let pinnedCount = 0; for (const value of pinned) pinnedCount += value;
      if (mode === 'Two Corners' || !pinnedCount || pinnedCount > count * 0.75) {
        pinned.fill(0);
        const axis = spanX >= spanZ ? 0 : 2;
        let low = Infinity, high = -Infinity, lo = 0, hi = 0;
        for (let node = 0; node < count; node++) {
          const value = world[node * 3 + axis];
          if (value < low) { low = value; lo = node; }
          if (value > high) { high = value; hi = node; }
        }
        pinned[lo] = 1; pinned[hi] = 1;
        if (lo === hi && count > 1) pinned[count - 1] = 1;
      }
    }

    initClothSoftBody(mesh, type, params, record) {
      const baseTopology = meshTopology(mesh.geometry, type, params);
      const topology = type === 'SoftBody' ? withSoftBodyVolume(baseTopology) : baseTopology;
      const nodeCount = topology.rest.length / 3;
      const edgeCount = topology.edgeLengths.length;
      const pinned = new Uint8Array(nodeCount);
      if (type === 'Cloth') this.selectClothPins(mesh, topology, pinned, params);
      const bounds = boundsFromPoints(topology.rest);
      const arena = this.arena;
      const positionPtr = arena.allocF32(topology.rest.length);
      const previousPtr = arena.allocF32(topology.rest.length);
      const restPtr = arena.allocF32(topology.rest.length);
      const pinsPtr = arena.allocU8(pinned.length);
      const edgesPtr = arena.allocU32(topology.edgePairs.length);
      const lengthsPtr = arena.allocF32(topology.edgeLengths.length);
      const edgeWeightsPtr = arena.allocF32(topology.edgeWeights.length);
      const boundsPtr = arena.allocF32(6);
      arena.writeF32(positionPtr, topology.rest);
      arena.writeF32(previousPtr, topology.rest);
      arena.writeF32(restPtr, topology.rest);
      arena.writeU8(pinsPtr, pinned);
      arena.writeU32(edgesPtr, topology.edgePairs);
      arena.writeF32(lengthsPtr, topology.edgeLengths);
      arena.writeF32(edgeWeightsPtr, topology.edgeWeights);
      arena.writeF32(boundsPtr, bounds);
      record.solver = { ...topology, nodeCount, edgeCount, positionPtr, previousPtr, restPtr, pinsPtr, edgesPtr, lengthsPtr, edgeWeightsPtr, boundsPtr, bounds };
      record.originalPositions = topology.originalPositions.slice();
      mesh.userData.origPositions = record.originalPositions.slice();
      mesh.userData.prevPositions = record.originalPositions.slice();
      mesh.userData.currPositions = record.originalPositions.slice();
    }

    buildCollisionSurface(collider,settings={}) {
      collider.updateWorldMatrix?.(true,false);collider.updateMatrixWorld?.(true);const geometry=collider.geometry,attr=geometry?.attributes?.position;if(!attr||attr.count<3)return null;const quality=clamp(Math.round(number(settings,'Collision Quality',5)),1,12),matrix=collider.matrixWorld,e=matrix.elements,key=e.map(v=>Math.round(v*1e5)/1e5).join(','),cached=this.collisionSurfaceCache.get(collider.uuid);if(cached&&cached.geometry===geometry&&cached.positionVersion===attr.version&&cached.matrixKey===key&&cached.quality===quality)return cached;
      const indices=geometry.index?.array,total=Math.floor((indices?.length??attr.count)/3),stride=Math.max(1,Math.ceil(total/(quality*256))),triangles=[],a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3(),min=new THREE.Vector3(Infinity,Infinity,Infinity),max=new THREE.Vector3(-Infinity,-Infinity,-Infinity);
      for(let face=0;face<total;face+=stride){const j=face*3,ia=indices?indices[j]:j,ib=indices?indices[j+1]:j+1,ic=indices?indices[j+2]:j+2;a.fromBufferAttribute(attr,ia).applyMatrix4(matrix);b.fromBufferAttribute(attr,ib).applyMatrix4(matrix);c.fromBufferAttribute(attr,ic).applyMatrix4(matrix);normal.crossVectors(b.clone().sub(a),c.clone().sub(a));if(normal.lengthSq()<1e-14)continue;normal.normalize();const tri={a:[a.x,a.y,a.z],b:[b.x,b.y,b.z],c:[c.x,c.y,c.z],n:[normal.x,normal.y,normal.z],min:[Math.min(a.x,b.x,c.x),Math.min(a.y,b.y,c.y),Math.min(a.z,b.z,c.z)],max:[Math.max(a.x,b.x,c.x),Math.max(a.y,b.y,c.y),Math.max(a.z,b.z,c.z)]};triangles.push(tri);min.min(a).min(b).min(c);max.max(a).max(b).max(c)}
      if(!triangles.length)return null;const size=max.clone().sub(min),cellSize=Math.max(Math.max(size.x,size.y,size.z)/(quality*2),Math.max(number(settings,'Outer Thickness',.02),number(settings,'Inner Thickness',.02))*1.5,.04),nx=Math.max(1,Math.ceil(size.x/cellSize)),ny=Math.max(1,Math.ceil(size.y/cellSize)),nz=Math.max(1,Math.ceil(size.z/cellSize)),grid=new Map(),globalTriangles=[];
      const cell=(v,lo,n)=>clamp(Math.floor((v-lo)/cellSize),0,n-1),id=(x,y,z)=>x+nx*(y+ny*z);
      triangles.forEach((tri,index)=>{const x0=cell(tri.min[0],min.x,nx),x1=cell(tri.max[0],min.x,nx),y0=cell(tri.min[1],min.y,ny),y1=cell(tri.max[1],min.y,ny),z0=cell(tri.min[2],min.z,nz),z1=cell(tri.max[2],min.z,nz),cover=(x1-x0+1)*(y1-y0+1)*(z1-z0+1);if(cover>96){globalTriangles.push(index);return}for(let z=z0;z<=z1;z++)for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const k=id(x,y,z),list=grid.get(k)||[];list.push(index);grid.set(k,list)}});
      const surface={geometry,positionVersion:attr.version,matrixKey:key,quality,triangles,min:min.toArray(),max:max.toArray(),cellSize,nx,ny,nz,grid,globalTriangles,stamp:0,stamps:new Uint32Array(triangles.length),point:new Float64Array(3)};this.collisionSurfaceCache.set(collider.uuid,surface);return surface;
    }

    collisionHits(mesh,particle=false) {
      const scene=this.scene(),hits=[];scene.traverse(object=>{if(!object?.isMesh||object===mesh||object.isInstancedMesh||!object.visible)return;const settings=object.userData?.collisionSettings;if(!settings||settings.enabled===false)return;if(particle&&settings['Particle Collision']===false)return;if(!particle&&settings['Cloth/Soft Body Collision']===false)return;const surface=this.buildCollisionSurface(object,settings);if(surface)hits.push({surface,settings,object})});return hits;
    }

    nearestCollisionHit(surface,x,y,z,margin,settings,index=0) {
      const min=surface.min,max=surface.max;if(x<min[0]-margin||x>max[0]+margin||y<min[1]-margin||y>max[1]+margin||z<min[2]-margin||z>max[2]+margin)return null;surface.stamp=(surface.stamp+1)>>>0||1;const stamp=surface.stamp,ix=clamp(Math.floor((x-min[0])/surface.cellSize),0,surface.nx-1),iy=clamp(Math.floor((y-min[1])/surface.cellSize),0,surface.ny-1),iz=clamp(Math.floor((z-min[2])/surface.cellSize),0,surface.nz-1),reach=clamp(Math.ceil(margin/surface.cellSize),0,2),candidate=[];
      for(let dz=-reach;dz<=reach;dz++)for(let dy=-reach;dy<=reach;dy++)for(let dx=-reach;dx<=reach;dx++){const gx=ix+dx,gy=iy+dy,gz=iz+dz;if(gx<0||gy<0||gz<0||gx>=surface.nx||gy>=surface.ny||gz>=surface.nz)continue;const list=surface.grid.get(gx+surface.nx*(gy+surface.ny*gz));if(list)candidate.push(...list)}candidate.push(...surface.globalTriangles);
      let best=null,bestD2=margin*margin;for(const ti of candidate){if(surface.stamps[ti]===stamp)continue;surface.stamps[ti]=stamp;const t=surface.triangles[ti];if(x<t.min[0]-margin||x>t.max[0]+margin||y<t.min[1]-margin||y>t.max[1]+margin||z<t.min[2]-margin||z>t.max[2]+margin)continue;closestPointOnTriangle(x,y,z,t,surface.point);const dx=x-surface.point[0],dy=y-surface.point[1],dz=z-surface.point[2],d2=dx*dx+dy*dy+dz*dz;if(d2>bestD2)continue;const signed=dx*t.n[0]+dy*t.n[1]+dz*t.n[2];if(settings['Single Sided']&&signed<0)continue;bestD2=d2;best={tri:t,q:[surface.point[0],surface.point[1],surface.point[2]],signed,distance:Math.sqrt(d2)}}return best;
    }

    resolveMeshCollisions(mesh,state,params,type,dt) {
      if(!state?.nodeCount||dt<=0)return;const settingsList=this.collisionHits(mesh,false);if(!settingsList.length)return;const positions=this.arena.f32(state.positionPtr,state.nodeCount*3),previous=this.arena.f32(state.previousPtr,state.nodeCount*3),pinned=this.arena.u8(state.pinsPtr,state.nodeCount),matrix=mesh.matrixWorld,inverse=matrix.clone().invert(),cur=new THREE.Vector3(),prior=new THREE.Vector3(),wc=new THREE.Vector3(),wp=new THREE.Vector3(),v=new THREE.Vector3(),normal=new THREE.Vector3();
      for(let node=0;node<state.nodeCount;node++){if(pinned[node])continue;const i=node*3;cur.set(positions[i],positions[i+1],positions[i+2]).applyMatrix4(matrix);prior.set(previous[i],previous[i+1],previous[i+2]).applyMatrix4(matrix);let resolved=false;for(const item of settingsList){const s=item.settings,outer=clamp(number(s,'Outer Thickness',.02),0,1),inner=clamp(number(s,'Inner Thickness',.02),0,1),margin=Math.max(outer,inner);if(!margin)continue;const hit=this.nearestCollisionHit(item.surface,cur.x,cur.y,cur.z,margin,s,node);if(!hit)continue;const side=hit.signed<0?-1:1;normal.set(hit.tri.n[0]*side,hit.tri.n[1]*side,hit.tri.n[2]*side);const offset=hit.signed<0?inner:outer;if(hit.distance>offset)continue;const permeability=clamp(number(s,'Permeability',0),0,1),mix=(Math.sin(node*127.1+item.object.uuid.length*311.7)*43758.5453)%1;if(Math.abs(mix)<permeability)continue;const target=new THREE.Vector3(hit.q[0],hit.q[1],hit.q[2]).addScaledVector(normal,offset);v.subVectors(cur,prior).multiplyScalar(1/dt);const vn=v.dot(normal),friction=clamp(number(s,type==='Cloth'?'Cloth Friction':'Particle Friction',.3),0,1),damping=clamp(number(s,'Particle Damping',.1),0,1),restitution=clamp(number(s,'Restitution',.08),0,1);v.addScaledVector(normal,-vn);v.multiplyScalar(1-friction);v.addScaledVector(normal,vn<0?-vn*restitution:vn*(1-damping));wc.copy(target);wp.copy(target).addScaledVector(v,-dt).applyMatrix4(inverse);wc.applyMatrix4(inverse);positions[i]=wc.x;positions[i+1]=wc.y;positions[i+2]=wc.z;previous[i]=wp.x;previous[i+1]=wp.y;previous[i+2]=wp.z;cur.copy(target);resolved=true;break}if(resolved)continue}
    }

    resolveParticleCollisions(record,dt) {
      if(!record?.positionPtr||dt<=0)return;const hits=this.collisionHits(record.mesh,true);if(!hits.length)return;const positions=this.arena.f32(record.positionPtr,record.count*3),velocities=this.arena.f32(record.velocityPtr,record.count*3),active=record.activePtr?this.arena.u8(record.activePtr,record.count):record.activeMask;
      for(let i=0;i<record.count;i++){if(active&&active[i]===0)continue;const b=i*3;for(const item of hits){const s=item.settings,margin=clamp(Math.max(number(s,'Outer Thickness',.02),number(s,'Inner Thickness',.02))+Math.max(record.radius||0,0),0,1.5);if(margin<=0)continue;const hit=this.nearestCollisionHit(item.surface,positions[b],positions[b+1],positions[b+2],margin,s,i);if(!hit)continue;const side=hit.signed<0?-1:1,nx=hit.tri.n[0]*side,ny=hit.tri.n[1]*side,nz=hit.tri.n[2]*side,offset=hit.signed<0?number(s,'Inner Thickness',.02)+record.radius:number(s,'Outer Thickness',.02)+record.radius;if(hit.distance>offset)continue;if(s['Kill Particles']){if(active)active[i]=0;continue}const permeability=clamp(number(s,'Permeability',0),0,1),mix=Math.abs((Math.sin(i*127.1+item.object.uuid.length*311.7)*43758.5453)%1);if(mix<permeability)continue;const vn=velocities[b]*nx+velocities[b+1]*ny+velocities[b+2]*nz,friction=clamp(number(s,'Particle Friction',.2),0,1),damping=clamp(number(s,'Particle Damping',.1),0,1),rest=clamp(number(s,'Restitution',.08),0,1),tx=(velocities[b]-vn*nx)*(1-friction),ty=(velocities[b+1]-vn*ny)*(1-friction),tz=(velocities[b+2]-vn*nz)*(1-friction),normalOut=vn<0?-vn*rest:vn*(1-damping);velocities[b]=tx+normalOut*nx;velocities[b+1]=ty+normalOut*ny;velocities[b+2]=tz+normalOut*nz;positions[b]=hit.q[0]+nx*offset;positions[b+1]=hit.q[1]+ny*offset;positions[b+2]=hit.q[2]+nz*offset;break}}
    }

    stepClothSoftBody(mesh, type, dt) {
      const record = mesh?.userData?.[this.getSimKey(type)], state = record?.solver;
      if (!state || record.status !== 'running') return;
      const params = record.params, stepDt = clamp(dt, 1e-5, 1 / 30);
      const iterations = clamp(Math.round(number(params, 'Quality', 5)), 1, 20);
      const goalStrength = type === 'SoftBody' ? clamp(number(params, 'Goal Strength', 0.5), 0, 1) : 0;
      const rawDamping = clamp(number(params, 'Damping', 0.1) + (type === 'SoftBody' ? number(params, 'Goal Damping', 0) * goalStrength * 0.25 : 0), 0, 0.95);
      const damping = 1 - Math.pow(1 - rawDamping, stepDt * 60);
      const gravity = Math.max(0, number(params, 'Gravity', 9.8));
      const rawStiffness = type === 'Cloth' ? number(params, 'Structural Stiffness', 15) / 100 : clamp(number(params, 'Stiffness', 0.5), 0, 1);
      const stiffness = type === 'SoftBody' ? rawStiffness * rawStiffness * 0.35 : rawStiffness;
      const goal = type === 'SoftBody' ? goalStrength * goalStrength * 0.12 : 0;
      const stretch = type === 'Cloth' ? number(params, 'Stretch Resistance', 0.9) : 1;
      const compression = type === 'Cloth' ? number(params, 'Compression Resistance', 0.9) : 1;
      const plasticity = type === 'SoftBody' ? number(params, 'Plasticity', 0) : 0;
      const margin = type === 'SoftBody' ? number(params, 'Collision Margin', 0.02) : 0;
      const airDrag = clamp(number(params, 'Air Drag', 0.05), 0, 0.95);
      const friction = 1 - Math.pow(1 - airDrag, stepDt * 60 / (iterations + 1));
      mesh.updateWorldMatrix?.(true, false); mesh.updateMatrixWorld?.(true);
      const inverseWorld = mesh.matrixWorld?.clone?.().invert?.();
      const localGravity = new THREE.Vector3(0, -gravity, 0);
      if (inverseWorld) localGravity.applyMatrix3(new THREE.Matrix3().setFromMatrix4(inverseWorld));
      const rc = this.abiVersion >= 2
        ? this.wasm.sim_solver_deformable_step(state.positionPtr, state.previousPtr, state.restPtr, state.pinsPtr,
          state.edgesPtr, state.lengthsPtr, state.edgeWeightsPtr, state.nodeCount, state.edgeCount,
          stepDt, 0, damping, stiffness, goal, stretch, compression, plasticity, margin, iterations,
          state.boundsPtr, number(params, 'Bounce', type === 'SoftBody' ? 0.12 : 0.02), friction)
        : this.wasm.sim_solver_deformable_step(state.positionPtr, state.previousPtr, state.restPtr, state.pinsPtr,
          state.edgesPtr, state.lengthsPtr, state.nodeCount, state.edgeCount,
          stepDt, 0, damping, type === 'Cloth' ? 0 : stiffness, goal, iterations,
          state.boundsPtr, number(params, 'Bounce', type === 'SoftBody' ? 0.12 : 0.02), friction);
      if (rc < 0) { this.fail(record, new Error(record.type + ' solver returned ' + rc)); return; }
      const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3), pinned = this.arena.u8(state.pinsPtr, state.nodeCount), dt2 = stepDt * stepDt;
      for (let node = 0; node < state.nodeCount; node++) if (!pinned[node]) { const i = node * 3; positions[i] += localGravity.x * dt2; positions[i + 1] += localGravity.y * dt2; positions[i + 2] += localGravity.z * dt2; }
      if (this.abiVersion < 2 && type === 'Cloth') this.projectClothConstraints(state, stiffness, stretch, compression, iterations, margin);
      if (this.abiVersion < 2 && type === 'SoftBody' && plasticity > 0) this.updatePlasticRestLengths(state, plasticity, stepDt);
      if (type === 'SoftBody' && state.volumeTets?.length) this.projectSoftBodyVolume(state, number(params, 'Volume Preservation', 0.85), margin, iterations);
      this.resolveGroundContact(mesh, state, params, type);
      this.resolveMeshCollisions(mesh,state,params,type,stepDt);
      for (let vertex = 0; vertex < state.vertexMap.length; vertex++) {
        const source = state.vertexMap[vertex] * 3;
        state.attribute.setXYZ(vertex, positions[source], positions[source + 1], positions[source + 2]);
      }
      state.attribute.needsUpdate = true;
      if ((this.frameCount++ & 1) === 0) mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }

    resolveGroundContact(mesh, state, params, type) {
      const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3), previous = this.arena.f32(state.previousPtr, state.nodeCount * 3), pinned = this.arena.u8(state.pinsPtr, state.nodeCount);
      const floor = number(params, 'Ground Height', 0) + (type === 'SoftBody' ? clamp(number(params, 'Collision Margin', 0.02), 0, 0.5) : 0);
      const friction = clamp(number(params, 'Ground Friction', type === 'Cloth' ? 0.3 : 0.25), 0, 1), bounce = clamp(number(params, 'Bounce', type === 'SoftBody' ? 0.12 : 0.02), 0, 1);
      mesh.updateWorldMatrix?.(true, false); mesh.updateMatrixWorld?.(true);
      const matrix = mesh.matrixWorld, inverse = matrix?.clone?.().invert?.();
      if (!inverse) return;
      const current = new THREE.Vector3(), prior = new THREE.Vector3(), worldCurrent = new THREE.Vector3(), worldPrior = new THREE.Vector3();
      for (let node = 0; node < state.nodeCount; node++) {
        if (pinned[node]) continue;
        const i = node * 3;
        current.set(positions[i], positions[i + 1], positions[i + 2]); worldCurrent.copy(current).applyMatrix4(matrix);
        if (worldCurrent.y >= floor) continue;
        prior.set(previous[i], previous[i + 1], previous[i + 2]); worldPrior.copy(prior).applyMatrix4(matrix);
        let vx = worldCurrent.x - worldPrior.x, vy = worldCurrent.y - worldPrior.y, vz = worldCurrent.z - worldPrior.z;
        worldCurrent.y = floor;
        if (vy < 0) vy = -vy * bounce;
        vx *= 1 - friction; vz *= 1 - friction;
        worldPrior.set(worldCurrent.x - vx, worldCurrent.y - vy, worldCurrent.z - vz);
        current.copy(worldCurrent).applyMatrix4(inverse); prior.copy(worldPrior).applyMatrix4(inverse);
        positions[i] = current.x; positions[i + 1] = current.y; positions[i + 2] = current.z;
        previous[i] = prior.x; previous[i + 1] = prior.y; previous[i + 2] = prior.z;
      }
    }

    projectClothConstraints(state, stiffness, stretch, compression, iterations, collisionMargin = 0) {
      const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3), previous = this.arena.f32(state.previousPtr, state.nodeCount * 3);
      const pinned = this.arena.u8(state.pinsPtr, state.nodeCount), lengths = this.arena.f32(state.lengthsPtr, state.edgeCount), bounds = state.bounds;
      const stiffnessValue = clamp(stiffness, 0, 1), stretchValue = clamp(stretch, 0, 1), compressionValue = clamp(compression, 0, 1), margin = clamp(collisionMargin, 0, 0.5);
      for (let iteration = 0; iteration < clamp(Math.round(iterations), 1, 32); iteration++) {
        for (let edge = 0; edge < state.edgeCount; edge++) {
          const a = state.edgePairs[edge * 2], b = state.edgePairs[edge * 2 + 1];
          if (a >= state.nodeCount || b >= state.nodeCount || a === b) continue;
          const ia = a * 3, ib = b * 3, dx = positions[ib] - positions[ia], dy = positions[ib + 1] - positions[ia + 1], dz = positions[ib + 2] - positions[ia + 2];
          const distance = Math.hypot(dx, dy, dz), target = Math.max(lengths[edge], 1e-6);
          if (distance < 1e-7) continue;
          const wa = pinned[a] ? 0 : 1, wb = pinned[b] ? 0 : 1, total = wa + wb;
          if (!total) continue;
          const error = distance - target, directional = error > 0 ? stretchValue : compressionValue;
          const weight = clamp(state.edgeWeights?.[edge] ?? 1, 0, 1), correction = error / distance * stiffnessValue * directional * weight;
          const da = correction * wa / total, db = correction * wb / total;
          const dax = dx * da, day = dy * da, daz = dz * da, dbx = dx * db, dby = dy * db, dbz = dz * db;
          positions[ia] += dax; positions[ia + 1] += day; positions[ia + 2] += daz; previous[ia] += dax; previous[ia + 1] += day; previous[ia + 2] += daz;
          positions[ib] -= dbx; positions[ib + 1] -= dby; positions[ib + 2] -= dbz; previous[ib] -= dbx; previous[ib + 1] -= dby; previous[ib + 2] -= dbz;
        }
        for (let node = 0; node < state.nodeCount; node++) if (!pinned[node]) {
          const base = node * 3;
          for (let axis = 0; axis < 3; axis++) { const value = clamp(positions[base + axis], bounds[axis] + margin, bounds[axis + 3] - margin), delta = value - positions[base + axis]; positions[base + axis] = value; previous[base + axis] += delta; }
        }
      }
    }

    updatePlasticRestLengths(state, plasticity, dt) {
      const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3), lengths = this.arena.f32(state.lengthsPtr, state.edgeCount), edges = state.edgePairs;
      const amount = clamp(plasticity, 0, 1) * clamp(dt, 0, 1 / 30) * 0.05;
      for (let edge = 0; edge < state.edgeCount; edge++) {
        const a = edges[edge * 2] * 3, b = edges[edge * 2 + 1] * 3;
        const distance = Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
        const target = Math.max(lengths[edge], 1e-6), error = distance - target;
        if (Math.abs(error) / target > 0.08) lengths[edge] = target + error * amount;
      }
    }

    projectSoftBodyVolume(state, stiffness, collisionMargin = 0, iterations = 5) {
      const tetCount = state.volumeTets.length / 4;
      const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3);
      const previous = this.arena.f32(state.previousPtr, state.nodeCount * 3);
      const pinned = this.arena.u8(state.pinsPtr, state.nodeCount);
      const restVolumes = state.volumeRest;
      const alpha = clamp(stiffness, 0, 1);
      const maxCorrection = Math.max((state.averageEdgeLength || 0.1) * 0.2, 1e-4);
      for (let iteration = 0; iteration < clamp(Math.round(iterations), 1, 16); iteration++) {
        for (let t = 0; t < tetCount; t++) {
          const ia = state.volumeTets[t * 4] * 3, ib = state.volumeTets[t * 4 + 1] * 3;
          const ic = state.volumeTets[t * 4 + 2] * 3, id = state.volumeTets[t * 4 + 3] * 3;
          const ux = positions[ib] - positions[ia], uy = positions[ib + 1] - positions[ia + 1], uz = positions[ib + 2] - positions[ia + 2];
          const vx = positions[ic] - positions[ia], vy = positions[ic + 1] - positions[ia + 1], vz = positions[ic + 2] - positions[ia + 2];
          const wx = positions[id] - positions[ia], wy = positions[id + 1] - positions[ia + 1], wz = positions[id + 2] - positions[ia + 2];
          const volume = (ux * (vy * wz - vz * wy) + uy * (vz * wx - vx * wz) + uz * (vx * wy - vy * wx)) / 6;
          const error = volume - restVolumes[t];
          if (!Number.isFinite(error) || Math.abs(error) < 1e-9) continue;
          const gb = [(vy * wz - vz * wy) / 6, (vz * wx - vx * wz) / 6, (vx * wy - vy * wx) / 6];
          const gc = [(wy * uz - wz * uy) / 6, (wz * ux - wx * uz) / 6, (wx * uy - wy * ux) / 6];
          const gd = [(uy * vz - uz * vy) / 6, (uz * vx - ux * vz) / 6, (ux * vy - uy * vx) / 6];
          const ga = [-(gb[0] + gc[0] + gd[0]), -(gb[1] + gc[1] + gd[1]), -(gb[2] + gc[2] + gd[2])];
          const nodes = [ia / 3, ib / 3, ic / 3, id / 3], gradients = [ga, gb, gc, gd];
          let denominator = 0;
          for (let n = 0; n < 4; n++) if (!pinned[nodes[n]]) { const g = gradients[n]; denominator += g[0] * g[0] + g[1] * g[1] + g[2] * g[2]; }
          if (denominator < 1e-18 || alpha <= 0) continue;
          let lambda = -error * alpha / denominator;
          let largest = 0;
          for (let n = 0; n < 4; n++) if (!pinned[nodes[n]]) { const g = gradients[n]; largest = Math.max(largest, Math.abs(lambda) * Math.hypot(g[0], g[1], g[2])); }
          if (largest > maxCorrection) lambda *= maxCorrection / largest;
          for (let n = 0; n < 4; n++) {
            const node = nodes[n]; if (pinned[node]) continue;
            const base = node * 3, g = gradients[n];
            for (let axis = 0; axis < 3; axis++) { const delta = lambda * g[axis]; positions[base + axis] += delta; previous[base + axis] += delta; }
          }
        }
      }
      const bounds = state.bounds, margin = clamp(collisionMargin, 0, 0.5);
      for (let node = 0; node < state.nodeCount; node++) {
        const base = node * 3;
        for (let axis = 0; axis < 3; axis++) {
          const low = bounds[axis] + margin, high = bounds[axis + 3] - margin;
          const corrected = clamp(positions[base + axis], low, high), delta = corrected - positions[base + axis];
          positions[base + axis] = corrected; previous[base + axis] += delta;
        }
      }
    }

    getFluidBox(mesh, role) {
      const padding = role === 'Flow' ? Math.max(mesh.scale?.length?.() || 0, 1) : 0;
      return worldBounds(mesh, padding);
    }

    sampleMeshSurface(mesh,count,fallback) {
      const geometry=mesh?.geometry,attribute=geometry?.attributes?.position;if(!attribute||attribute.count<3)return fallback.slice();
      mesh.updateWorldMatrix?.(true,false);mesh.updateMatrixWorld?.(true);const matrix=mesh.matrixWorld||new THREE.Matrix4(),indices=geometry.index?.array,limit=indices?.length??attribute.count,triangles=[],cumulative=[];let total=0;const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),normal=new THREE.Vector3();
      for(let i=0;i+2<limit;i+=3){const ia=indices?indices[i]:i,ib=indices?indices[i+1]:i+1,ic=indices?indices[i+2]:i+2;a.fromBufferAttribute(attribute,ia).applyMatrix4(matrix);b.fromBufferAttribute(attribute,ib).applyMatrix4(matrix);c.fromBufferAttribute(attribute,ic).applyMatrix4(matrix);ab.subVectors(b,a);ac.subVectors(c,a);normal.crossVectors(ab,ac);const area=normal.length()*.5;if(area<1e-10)continue;total+=area;triangles.push([a.clone(),b.clone(),c.clone(),normal.normalize()]);cumulative.push(total)}
      if(total<1e-10)return fallback.slice();const out=new Float32Array(count*3);
      for(let i=0;i<count;i++){const pick=Math.random()*total;let lo=0,hi=cumulative.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(cumulative[mid]<pick)lo=mid+1;else hi=mid}const tri=triangles[lo],u=Math.sqrt(Math.random()),v=Math.random(),wa=1-u,wb=u*(1-v),wc=u*v,offset=tri[3].clone().multiplyScalar(.015);a.copy(tri[0]).multiplyScalar(wa).addScaledVector(tri[1],wb).addScaledVector(tri[2],wc).add(offset);out.set([a.x,a.y,a.z],i*3)}return out;
    }

    initFluidSimulation(mesh, params, record) {
      const role = params.Type || 'Domain';
      const domainType = role === 'Domain' ? (params['Domain Type'] || 'Liquid') : (params['Flow Type'] || 'Liquid');
      const box = this.getFluidBox(mesh, role);
      record.role = role;
      record.domainType = domainType;
      record.bounds = box;
      record.boundsPtr = this.arena.allocF32(6);
      this.arena.writeF32(record.boundsPtr, box);
      if (role === 'Effector') {
        this.effectors.set(mesh.uuid, record);
        record.kind = 'effector';
        return;
      }
      if (role === 'Domain') {
        record.savedMaterial = mesh.material;
        mesh.material = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.14 });
        record.domainEdges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 }));
        mesh.add(record.domainEdges);
      }
      if (domainType === 'Liquid') this.createLiquidParticles(mesh, params, record);
      else if (['Fire', 'Smoke', 'Fire + Smoke'].includes(domainType)) this.createBuoyantParticles(mesh, params, record);
      else throw new Error(`Unsupported fluid domain type: ${domainType}`);
      mesh.userData.simMesh = record.visual;
      mesh.userData.poolMesh = null;
      mesh.userData.fluidSim = record;
      this.simMeshes.set(mesh.uuid, record);
    }

    createLiquidParticles(mesh, params, record) {
      const box = record.bounds;
      const fluid = lattice(box, params, true);
      const count = fluid.positions.length / 3;
      if (record.role === 'Flow') fluid.positions = this.sampleMeshSurface(mesh, count, fluid.positions);
      if (count < 2) throw new Error('Liquid domain generated fewer than two particles');
      const arena = this.arena;
      record.kind = 'sph';
      record.count = count;
      record.smoothingLength = fluid.smoothingLength;
      record.mass = fluid.mass;
      record.radius = fluid.radius;
      record.positionPtr = arena.allocF32(count * 3);
      record.velocityPtr = arena.allocF32(count * 3);
      record.densityPtr = arena.allocF32(count);
      record.pressurePtr = arena.allocF32(count);
      record.forcePtr = arena.allocF32(count * 3);
      record.activePtr = arena.allocU8(count);
      record.activeMask = new Uint8Array(count).fill(1);
      record.flowAges = new Float32Array(count);
      record.flowBehavior = record.role === 'Flow' ? (params['Flow Behavior'] || 'Inflow') : (params['Internal Inflow'] === true ? 'Inflow' : 'Geometry');
      record.outflowEnabled = record.flowBehavior === 'Outflow';
      record.exitBounds = box.slice();
      if (record.outflowEnabled) {
        const pad = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]) * 1.5;
        arena.writeF32(record.boundsPtr, new Float32Array([box[0] - pad, box[1] - pad, box[2] - pad, box[3] + pad, box[4] + pad, box[5] + pad]));
      }
      record.emitAccumulator = 0; record.emitCursor = 0;
      arena.writeU8(record.activePtr, record.activeMask);
      arena.writeF32(record.positionPtr, fluid.positions);
      const initialVelocity = new Float32Array(count * 3);
      const flowScale = Math.max(0, number(params, 'Flow Speed', 4)) / 4;
      const velocity = [number(params, 'Velocity X', 0) * flowScale, number(params, 'Velocity Y', 0) * flowScale, number(params, 'Velocity Z', 0) * flowScale];
      for (let i = 0; i < count; i++) initialVelocity.set(velocity, i * 3);
      arena.writeF32(record.velocityPtr, initialVelocity);
      record.initialPositions = fluid.positions.slice();
      record.sourcePositions = fluid.positions.slice();
      if (record.role !== 'Flow') for (let i = 0; i < count; i++) record.sourcePositions[i * 3 + 1] = box[1] + (box[4] - box[1]) * 0.1;
      record.initialVelocities = initialVelocity;
      record.visual = new THREE.Mesh(new THREE.BufferGeometry(), this.liquidMaterial(params));
      record.visual.frustumCulled = false; record.visual.castShadow = true; record.visual.receiveShadow = true; record.visual.renderOrder = 2;
      record.visual.userData.solverSurface = 'SPH density isosurface'; record.surfaceFrame = 0; record.surfaceReady = false;
      this.scene().add(record.visual);
      record.mesh.userData.fluidSurfaceScale = Math.max(box[3] - box[0], box[5] - box[2]);
    }

    createBuoyantParticles(mesh, params, record) {
      const box = record.bounds;
      const isFire = domainTypeHasFire(record.domainType);
      const smokeDensity = clamp(number(params, 'Smoke Density', 1), 0.1, 3);
      const densityFactor = record.domainType === 'Fire + Smoke' ? 0.5 + smokeDensity * 0.5 : (isFire ? 1 : smokeDensity);
      const baseCount = number(params, 'Flow Rate', 40) * (isFire ? 4 : 2) * densityFactor;
      const count = clamp(Math.round(baseCount), 96, MAX_PARTICLES);
      const fluid = lattice(box, { ...params, Resolution: 40 }, false);
      const positions = new Float32Array(count * 3), velocities = new Float32Array(count * 3);
      const temperatures = new Float32Array(count), ages = new Float32Array(count);
      const columns = Math.ceil(Math.sqrt(count));
      const centerX = (box[0] + box[3]) * 0.5, centerZ = (box[2] + box[5]) * 0.5;
      const sizeX = box[3] - box[0], sizeY = box[4] - box[1], sizeZ = box[5] - box[2];
      const { fire: firePreset } = tracerPresets(record.domainType, params);
      const presetHeat = firePreset === 'Wildfire' ? 1.35 : firePreset === 'Gas Flame' ? 1.1 : firePreset === 'Torch' ? 0.95 : 1;
      const baseTemperature = isFire ? clamp(number(params, 'Heat Emission', 1.2) * presetHeat / 2, 0.2, 1.5) : clamp(0.2 + smokeDensity * 0.08, 0.2, 0.55);
      const flowScale = Math.max(0, number(params, 'Flow Speed', 4)) / 4;
      const initialVelocity = [number(params, 'Velocity X', 0) * flowScale, number(params, 'Velocity Y', 0) * flowScale, number(params, 'Velocity Z', 0) * flowScale];
      for (let i = 0; i < count; i++) {
        const x = ((i % columns) + 0.5) / columns - 0.5;
        const z = (Math.floor(i / columns) % columns + 0.5) / columns - 0.5;
        const layer = Math.floor(i / (columns * columns));
        const base = i * 3;
        positions[base] = centerX + x * sizeX * 0.22;
        positions[base + 1] = box[1] + sizeY * (0.08 + (layer % 4) * 0.012);
        positions[base + 2] = centerZ + z * sizeZ * 0.22;
        velocities.set(initialVelocity, base);
        temperatures[i] = record.domainType === 'Fire + Smoke' && i % 3 === 0 ? 0.22 : baseTemperature;
        ages[i] = ((i * 17) % 31) / 31 * 0.5;
      }
      if(record.role==='Flow')positions.set(this.sampleMeshSurface(mesh,count,positions));
      const arena = this.arena;
      record.kind = 'tracer'; record.count = count; record.radius = Math.max(fluid.radius, Math.max(sizeX, sizeZ) / 40);
      record.positionPtr = arena.allocF32(count * 3); record.velocityPtr = arena.allocF32(count * 3);
      record.temperaturePtr = arena.allocF32(count); record.agePtr = arena.allocF32(count);
      arena.writeF32(record.positionPtr, positions); arena.writeF32(record.velocityPtr, velocities);
      arena.writeF32(record.temperaturePtr, temperatures); arena.writeF32(record.agePtr, ages);
      record.initialPositions = positions.slice(); record.sourcePositions = positions.slice(); record.initialVelocities = velocities.slice();
      record.initialTemperatures = temperatures.slice();
      record.flowBehavior = record.role === 'Flow' ? (params['Flow Behavior'] || 'Inflow') : (params['Internal Inflow'] === true ? 'Inflow' : 'Geometry');
      record.inflowEnabled = record.flowBehavior === 'Inflow' && (record.role === 'Flow' ? params['Use Flow'] !== false : params['Internal Inflow'] === true);
      record.outflowEnabled = record.flowBehavior === 'Outflow';
      record.activeMask = new Uint8Array(count).fill(1);
      record.emitAccumulator = 0; record.emitCursor = 0;
      record.exitBounds = box.slice();
      if (record.outflowEnabled) {
        const pad = Math.max(sizeX, sizeY, sizeZ) * 1.5;
        this.arena.writeF32(record.boundsPtr, new Float32Array([box[0] - pad, box[1] - pad, box[2] - pad, box[3] + pad, box[4] + pad, box[5] + pad]));
      }
      const renderMode=global.FE?.engines?.core?.getShadingMode?.()||'solid',group=new THREE.Group();
      const hasFire=domainTypeHasFire(record.domainType),hasSmoke=record.domainType==='Smoke'||record.domainType==='Fire + Smoke';
      record.visual=group;record.visualMode=renderMode;record.fireVisual=hasFire?this.createParticleVisual(count,record.radius,this.tracerMaterial('fire',record.domainType,params,renderMode),0xffffff):null;record.smokeVisual=hasSmoke?this.createParticleVisual(count,record.radius,this.tracerMaterial('smoke',record.domainType,params,renderMode),0xffffff):null;
      if(record.fireVisual)group.add(record.fireVisual);if(record.smokeVisual)group.add(record.smokeVisual);group.userData.solverParticleVisual=true;group.userData.solverRadius=record.radius;
      this.updateParticleInstances(record);this.scene().add(group);
    }

    liquidMaterial(params) {
      const preset = params['Liquid Preset'] || 'Water';
      const color = preset === 'Honey' ? 0xd99a22 : preset === 'Oil' ? 0x653c20 : preset === 'Slime' ? 0x32a77c : 0x2d91b4;
      const ior = preset === 'Honey' ? 1.5 : preset === 'Oil' ? 1.48 : preset === 'Slime' ? 1.38 : 1.333;
      return new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness: preset === 'Water' ? 0.038 : 0.08, transmission: preset === 'Water' ? 0.78 : 0.72, thickness: preset === 'Water' ? 0.55 : 1.1, ior, clearcoat: 1, clearcoatRoughness: 0.025, transparent: false, opacity: 1, side: THREE.DoubleSide, depthWrite: true, envMapIntensity: 1.45 });
    }

    tracerMaterial(kind, domainType, params = {}, renderMode = 'solid') {
      const rendered = renderMode === 'rendered' || renderMode === 'material';
      const { smoke: smokePreset } = tracerPresets(domainType, params);
      if (kind === 'fire') return new THREE.MeshBasicMaterial({ map: tracerSpriteTexture('fire'), color: 0xffffff, transparent: true, opacity: rendered ? 1 : .9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide, vertexColors: true, toneMapped: false });
      const density = clamp(number(params, 'Smoke Density', 1), 0.1, 3);
      const baseOpacity = smokePreset === 'Heavy Fog' ? .72 : smokePreset === 'Dark Soot' ? .58 : smokePreset === 'Steam' ? .52 : .5;
      const common = { map: tracerSpriteTexture('smoke'), color: 0xffffff, transparent: true, opacity: clamp(baseOpacity * (.72 + density * .28), .18, .82), depthWrite: false, depthTest: true, side: THREE.DoubleSide, vertexColors: true };
      return rendered ? new THREE.MeshStandardMaterial({ ...common, roughness: 1, metalness: 0, emissive: new THREE.Color(0x14181c), emissiveIntensity: .12 }) : new THREE.MeshBasicMaterial(common);
    }

    createParticleVisual(count, radius, material, color) {
      const geometry = new THREE.PlaneGeometry(2, 2);
      const visual = new THREE.InstancedMesh(geometry, material, count);
      visual.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      visual.frustumCulled = false;
      visual.renderOrder = material?.blending === THREE.AdditiveBlending ? 4 : 3;
      const tint = new THREE.Color(color);
      for (let i = 0; i < count; i++) visual.setColorAt(i, tint);
      if (visual.instanceColor) visual.instanceColor.needsUpdate = true;
      visual.userData.solverParticleVisual = true;
      visual.userData.solverRadius = radius;
      visual.userData.spriteKind = material?.map === tracerSpriteTexture('fire') ? 'fire' : 'smoke';
      return visual;
    }

    initializeInstances(record, positions, radius) {
      const object = new THREE.Object3D();
      for (let i = 0; i < record.count; i++) {
        const base = i * 3;
        object.position.set(positions[base], positions[base + 1], positions[base + 2]);
        object.scale.setScalar(radius);
        object.updateMatrix();
        record.visual.setMatrixAt(i, object.matrix);
      }
      record.visual.instanceMatrix.needsUpdate = true;
    }

    scene() {
      const scene = global.FE?.engines?.core?.sc;
      if (!scene) throw new Error('Core scene is unavailable');
      return scene;
    }

    stepSimulation(type, mesh, dt = 1 / 60) {
      const record = mesh?.userData?.[this.getSimKey(type)];
      if (!record || record.status !== 'running') return;
      const timeScale = clamp(number(record.params, 'Time Scale', 1), 0, 4);
      if (type === 'Cloth' || type === 'SoftBody') {
        const frameTime = clamp((Number(dt) || 1 / 60) * timeScale, 0, 1 / 15);
        record.stepAccumulator = Math.min((record.stepAccumulator || 0) + frameTime, 1 / 15);
        let steps = 0;
        while (record.stepAccumulator + 1e-8 >= DEFORMABLE_FIXED_STEP && steps < MAX_DEFORMABLE_SUBSTEPS) {
          this.stepClothSoftBody(mesh, type, DEFORMABLE_FIXED_STEP);
          record.stepAccumulator -= DEFORMABLE_FIXED_STEP; steps++;
        }
      } else if (type === 'Fluid') {
        const step = clamp((Number(dt) || 1 / 60) * timeScale, 0, 1 / 30);
        this.stepFluidSimulation(mesh, step);
      }
    }

    stepFluidSimulation(mesh, dt) {
      const record = mesh?.userData?.fluidSim;
      if (!record || record.status !== 'running' || record.kind === 'effector') return;
      const params = record.params;
      const liquidPreset = params['Liquid Preset'] || 'Water';
      const viscosityScale = liquidPreset === 'Honey' ? 8 : liquidPreset === 'Slime' ? 4 : liquidPreset === 'Oil' ? 2 : 1;
      const tensionScale = liquidPreset === 'Honey' ? 0.45 : liquidPreset === 'Slime' ? 0.8 : liquidPreset === 'Oil' ? 0.25 : 1;
      let rc = 0;
      if (record.kind === 'sph') {
        this.prepareLiquidFlow(record, dt);
        this.applyVorticityConfinement(record, dt);
        if (this.abiVersion < 2) this.applySphSurfaceTension(record, dt, number(params, 'Surface Tension', 0.25) * tensionScale);
        rc = this.abiVersion >= 2
          ? this.wasm.sim_solver_sph_step(
            record.positionPtr, record.velocityPtr, record.densityPtr, record.pressurePtr, record.forcePtr, record.activePtr,
            record.count, dt, record.mass, 1, record.smoothingLength, number(params, 'Pressure', 1.8),
            number(params, 'Viscosity', 0.01) * viscosityScale, number(params, 'Surface Tension', 0.25) * tensionScale, 0, -number(params, 'Gravity', 9.8), 0,
            record.boundsPtr, number(params, 'Bounce', 0.3), number(params, 'Damping', 0.03), record.flowBehavior === 'Outflow' ? 1 : 0,
          )
          : this.wasm.sim_solver_sph_step(
            record.positionPtr, record.velocityPtr, record.densityPtr, record.pressurePtr, record.forcePtr,
            record.count, dt, record.mass, 1, record.smoothingLength, number(params, 'Pressure', 1.8),
            number(params, 'Viscosity', 0.01) * viscosityScale, 0, -number(params, 'Gravity', 9.8), 0,
            record.boundsPtr, number(params, 'Bounce', 0.3), number(params, 'Damping', 0.03),
          );
      } else if (record.kind === 'tracer') {
        this.recycleExpired(record);
        rc = this.wasm.sim_solver_buoyant_tracer_step(
          record.positionPtr, record.velocityPtr, record.temperaturePtr, record.agePtr, record.count, dt,
          number(params, 'Gravity', 9.8), number(params, 'Buoyancy', 0.8),
          number(params, 'Dissipation Rate', 0.15) * 2, domainTypeHasFire(record.domainType) ? 0.08 / Math.max(number(params, 'Fuel', 1), 0.1) : number(params, 'Dissipation Rate', 0.15),
          tracerLifetime(record), record.boundsPtr, number(params, 'Bounce', 0.3),
        );
      }
      if (rc < 0) { this.fail(record, new Error(`fluid solver returned ${rc}`)); return; }
      if (record.kind === 'sph') this.projectLiquidDensity(record, dt);
      if (record.kind === 'tracer') this.resolveTracerOutflow(record);
      else if (record.kind === 'sph') this.resolveLiquidOutflow(record);
      this.resolveParticleCollisions(record,dt);
      this.resolveEffectors(record, dt);
      this.updateParticleInstances(record);
      if (record.visual) record.visual.visible = mesh.visible && (record.kind !== 'sph' || record.surfaceReady);
    }

    projectLiquidDensity(record, dt) {
      if (record.kind !== 'sph' || dt <= 0) return;
      const count = record.count, positions = this.arena.f32(record.positionPtr, count * 3), velocities = this.arena.f32(record.velocityPtr, count * 3), active = this.arena.u8(record.activePtr, count);
      const h = Math.max(record.smoothingLength || 0.1, 1e-3), h2 = h * h, mass = Math.max(record.mass || 0, 1e-8), rho0 = 1;
      const poly6 = 315 / (64 * Math.PI * Math.max(h ** 9, 1e-12)), spiky = -45 / (Math.PI * Math.max(h ** 6, 1e-12));
      const density = record.pbfDensity || (record.pbfDensity = new Float32Array(count));
      const lambda = record.pbfLambda || (record.pbfLambda = new Float32Array(count));
      const gradSum = record.pbfGradSum || (record.pbfGradSum = new Float32Array(count * 3));
      const denominator = record.pbfDenominator || (record.pbfDenominator = new Float32Array(count));
      const delta = record.pbfDelta || (record.pbfDelta = new Float32Array(count * 3));
      density.fill(0); lambda.fill(0); gradSum.fill(0); denominator.fill(0); delta.fill(0);
      for (let i = 0; i < count; i++) {
        if (!active[i]) continue;
        const a = i * 3, ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
        let rho = 0, gx = 0, gy = 0, gz = 0, denom = 0;
        for (let j = 0; j < count; j++) {
          if (!active[j]) continue;
          const b = j * 3, dx = ax - positions[b], dy = ay - positions[b + 1], dz = az - positions[b + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2) continue;
          const q = h2 - r2; rho += mass * poly6 * q * q * q;
          if (i === j || r2 < 1e-12) continue;
          const r = Math.sqrt(r2), scale = mass / rho0 * spiky * (h - r) * (h - r) / r, cx = dx * scale, cy = dy * scale, cz = dz * scale;
          gx += cx; gy += cy; gz += cz; denom += cx * cx + cy * cy + cz * cz;
        }
        density[i] = rho; gradSum[a] = gx; gradSum[a + 1] = gy; gradSum[a + 2] = gz;
        denominator[i] = denom + gx * gx + gy * gy + gz * gz;
        const compression = Math.max(rho / rho0 - 1, 0);
        lambda[i] = -compression / (denominator[i] + 1e-4);
      }
      for (let i = 0; i < count; i++) {
        if (!active[i] || lambda[i] === 0) continue;
        const a = i * 3, ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
        let dxSum = 0, dySum = 0, dzSum = 0;
        for (let j = 0; j < count; j++) {
          if (i === j || !active[j]) continue;
          const b = j * 3, dx = ax - positions[b], dy = ay - positions[b + 1], dz = az - positions[b + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (r2 <= 1e-12 || r2 >= h2) continue;
          const r = Math.sqrt(r2), scale = mass / rho0 * (lambda[i] + lambda[j]) * spiky * (h - r) * (h - r) / r;
          dxSum += dx * scale; dySum += dy * scale; dzSum += dz * scale;
        }
        const length = Math.hypot(dxSum, dySum, dzSum), maxCorrection = h * 0.06, scale = length > maxCorrection ? maxCorrection / length : 1;
        delta[a] = dxSum * scale; delta[a + 1] = dySum * scale; delta[a + 2] = dzSum * scale;
      }
      for (let i = 0; i < count; i++) if (active[i]) {
        const a = i * 3;
        positions[a] += delta[a]; positions[a + 1] += delta[a + 1]; positions[a + 2] += delta[a + 2];
        velocities[a] += delta[a] / dt; velocities[a + 1] += delta[a + 1] / dt; velocities[a + 2] += delta[a + 2] / dt;
      }
      if (!record.outflowEnabled && record.bounds) {
        const b = record.bounds, pad = Math.max(record.radius * 0.35, 1e-4), bounce = clamp(number(record.params, 'Bounce', 0.3), 0, 1);
        for (let i = 0; i < count; i++) if (active[i]) {
          const a = i * 3;
          for (let axis = 0; axis < 3; axis++) {
            const lo = b[axis] + pad, hi = b[axis + 3] - pad;
            if (positions[a + axis] < lo) { positions[a + axis] = lo; velocities[a + axis] = Math.abs(velocities[a + axis]) * bounce; }
            else if (positions[a + axis] > hi) { positions[a + axis] = hi; velocities[a + axis] = -Math.abs(velocities[a + axis]) * bounce; }
          }
        }
      }
    }

    applySphSurfaceTension(record, dt, strength) {
      const tension = clamp(strength, 0, 2);
      if (tension <= 0 || dt <= 0 || record.kind !== 'sph') return;
      const count = record.count, positions = this.arena.f32(record.positionPtr, count * 3), velocities = this.arena.f32(record.velocityPtr, count * 3);
      const densities = this.arena.f32(record.densityPtr, count), active = this.arena.u8(record.activePtr, count), h = Math.max(record.smoothingLength, 1e-3), h2 = h * h;
      const force = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        if (!active[i]) continue;
        const a = i * 3;
        for (let j = 0; j < count; j++) {
          if (i === j || !active[j]) continue;
          const b = j * 3, dx = positions[a] - positions[b], dy = positions[a + 1] - positions[b + 1], dz = positions[a + 2] - positions[b + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (r2 <= 1e-10 || r2 >= h2) continue;
          const r = Math.sqrt(r2), gap = h - r, scale = tension * record.mass * gap * gap / (h2 * Math.max(densities[j], 0.2)) * 0.02 / r;
          force[a] -= dx * scale; force[a + 1] -= dy * scale; force[a + 2] -= dz * scale;
        }
      }
      for (let i = 0; i < count; i++) if (active[i]) {
        const a = i * 3, rho = Math.max(densities[i], 0.2);
        velocities[a] += force[a] / rho * dt; velocities[a + 1] += force[a + 1] / rho * dt; velocities[a + 2] += force[a + 2] / rho * dt;
      }
    }

    applyVorticityConfinement(record, dt) {
      const strength = clamp(number(record.params, 'Vorticity Confinement', number(record.params, 'Turbulence', 0)), 0, 1);
      if (strength <= 0 || dt <= 0 || record.kind !== 'sph') return;
      const count = record.count, positions = this.arena.f32(record.positionPtr, count * 3), velocities = this.arena.f32(record.velocityPtr, count * 3);
      const density = this.arena.f32(record.densityPtr, count), active = this.arena.u8(record.activePtr, count);
      const h = Math.max(record.smoothingLength, 1e-3), h2 = h * h, spiky = -45 / (Math.PI * Math.max(h ** 6, 1e-12));
      const omega = new Float32Array(count * 3), magnitude = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        if (!active[i]) continue;
        const a = i * 3, px = positions[a], py = positions[a + 1], pz = positions[a + 2], vix = velocities[a], viy = velocities[a + 1], viz = velocities[a + 2];
        let ox = 0, oy = 0, oz = 0;
        for (let j = 0; j < count; j++) {
          if (i === j || !active[j]) continue;
          const b = j * 3, dx = px - positions[b], dy = py - positions[b + 1], dz = pz - positions[b + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (r2 <= 1e-10 || r2 >= h2) continue;
          const r = Math.sqrt(r2), grad = spiky * (h - r) * (h - r) / r * record.mass / Math.max(density[j], 0.2), gx = dx * grad, gy = dy * grad, gz = dz * grad;
          const dvx = velocities[b] - vix, dvy = velocities[b + 1] - viy, dvz = velocities[b + 2] - viz;
          ox += dvy * gz - dvz * gy; oy += dvz * gx - dvx * gz; oz += dvx * gy - dvy * gx;
        }
        omega[a] = ox; omega[a + 1] = oy; omega[a + 2] = oz; magnitude[i] = Math.hypot(ox, oy, oz);
      }
      const maxAcceleration = 12 * strength;
      for (let i = 0; i < count; i++) {
        if (!active[i]) continue;
        const a = i * 3, px = positions[a], py = positions[a + 1], pz = positions[a + 2];
        let gx = 0, gy = 0, gz = 0;
        for (let j = 0; j < count; j++) {
          if (i === j || !active[j]) continue;
          const b = j * 3, dx = px - positions[b], dy = py - positions[b + 1], dz = pz - positions[b + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (r2 <= 1e-10 || r2 >= h2) continue;
          const r = Math.sqrt(r2), grad = spiky * (h - r) * (h - r) / r * record.mass / Math.max(density[j], 0.2), dm = magnitude[j] - magnitude[i];
          gx += dm * dx * grad; gy += dm * dy * grad; gz += dm * dz * grad;
        }
        const len = Math.hypot(gx, gy, gz); if (len < 1e-8) continue;
        gx /= len; gy /= len; gz /= len;
        const ox = omega[a], oy = omega[a + 1], oz = omega[a + 2];
        let fx = strength * h * (gy * oz - gz * oy), fy = strength * h * (gz * ox - gx * oz), fz = strength * h * (gx * oy - gy * ox);
        const forceLength = Math.hypot(fx, fy, fz);
        if (forceLength > maxAcceleration && forceLength > 0) { const scale = maxAcceleration / forceLength; fx *= scale; fy *= scale; fz *= scale; }
        velocities[a] += fx * dt; velocities[a + 1] += fy * dt; velocities[a + 2] += fz * dt;
      }
    }

    prepareLiquidFlow(record, dt) {
      const params = record.params;
      const behavior = record.flowBehavior || 'Geometry';
      const enabled = behavior === 'Inflow' && (record.role === 'Flow' ? params['Use Flow'] !== false : params['Internal Inflow'] === true);
      const active = this.arena.u8(record.activePtr, record.count);
      const ages = record.flowAges;
      for (let i = 0; i < ages.length; i++) ages[i] += dt;
      if (!enabled) return;
      const rate = Math.max(0, record.role === 'Flow' ? number(params, 'Flow Rate', 40) : number(params, 'Inflow Rate', 40));
      record.emitAccumulator += dt * rate;
      const births = Math.min(Math.floor(record.emitAccumulator), record.count);
      record.emitAccumulator -= births;
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const velocities = this.arena.f32(record.velocityPtr, record.count * 3);
      for (let n = 0; n < births; n++) {
        let index = -1;
        for (let k = 0; k < record.count; k++) {
          const candidate = (record.emitCursor + k) % record.count;
          if (active[candidate] === 0 || ages[candidate] > 2.5) { index = candidate; break; }
        }
        if (index < 0) index = record.emitCursor % record.count;
        record.emitCursor = (index + 1) % record.count;
        const base = index * 3;
        positions.set(record.sourcePositions.subarray(base, base + 3), base);
        velocities.set(record.initialVelocities.subarray(base, base + 3), base);
        active[index] = 1; ages[index] = 0;
      }
    }

    recycleExpired(record) {
      const ages = this.arena.f32(record.agePtr, record.count);
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const velocities = this.arena.f32(record.velocityPtr, record.count * 3);
      const temperatures = this.arena.f32(record.temperaturePtr, record.count);
      const maxAge = tracerLifetime(record);
      for (let i = 0; i < record.count; i++) if (ages[i] >= maxAge) {
        const base = i * 3;
        if (record.inflowEnabled) {
          positions.set(record.sourcePositions.subarray(base, base + 3), base);
          velocities.set(record.initialVelocities.subarray(base, base + 3), base);
          temperatures[i] = record.initialTemperatures[i];
          ages[i] = 0;
          record.activeMask[i] = 1;
        } else {
          temperatures[i] = 0;
          velocities.fill(0, base, base + 3);
          record.activeMask[i] = 0;
        }
      }
    }

    resolveLiquidOutflow(record) {
      if (!record.outflowEnabled || !record.exitBounds) return;
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const velocities = this.arena.f32(record.velocityPtr, record.count * 3);
      const active = this.arena.u8(record.activePtr, record.count);
      const b = record.exitBounds;
      for (let i = 0; i < record.count; i++) {
        if (active[i] === 0) continue;
        const p = i * 3;
        if (positions[p] < b[0] || positions[p] > b[3] || positions[p + 1] < b[1] || positions[p + 1] > b[4] || positions[p + 2] < b[2] || positions[p + 2] > b[5]) {
          active[i] = 0;
          velocities.fill(0, p, p + 3);
        }
      }
    }

    resolveTracerOutflow(record) {
      if (!record.outflowEnabled || !record.exitBounds) return;
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const velocities = this.arena.f32(record.velocityPtr, record.count * 3);
      const b = record.exitBounds;
      for (let i = 0; i < record.count; i++) {
        const p = i * 3;
        if (positions[p] < b[0] || positions[p] > b[3] || positions[p + 1] < b[1] || positions[p + 1] > b[4] || positions[p + 2] < b[2] || positions[p + 2] > b[5]) {
          record.activeMask[i] = 0;
          velocities.fill(0, p, p + 3);
        }
      }
    }

    updateFluidSurface(record) {
      if (record.surfaceReady) { record.surfaceFrame++; if (record.surfaceFrame % 2 === 1) return; }
      const count = record.count, positions = this.arena.f32(record.positionPtr, count * 3), active = this.arena.u8(record.activePtr, count);
      const h = Math.max(record.smoothingLength || 0.1, 0.05), h2 = h * h, poly6 = 315 / (64 * Math.PI * Math.max(h ** 9, 1e-12));
      let lowX, lowY, lowZ, highX, highY, highZ;
      if (record.outflowEnabled) {
        lowX = lowY = lowZ = Infinity; highX = highY = highZ = -Infinity;
        for (let i = 0; i < count; i++) if (active[i]) { const b = i * 3; lowX = Math.min(lowX, positions[b]); lowY = Math.min(lowY, positions[b + 1]); lowZ = Math.min(lowZ, positions[b + 2]); highX = Math.max(highX, positions[b]); highY = Math.max(highY, positions[b + 1]); highZ = Math.max(highZ, positions[b + 2]); }
        if (!Number.isFinite(lowX)) { record.surfaceReady = false; record.visual.visible = false; return; }
        lowX -= h * 0.75; lowY -= h * 0.75; lowZ -= h * 0.75; highX += h * 0.75; highY += h * 0.75; highZ += h * 0.75;
      } else {
        const b = record.bounds, pad = h * 0.45;
        lowX = b[0] - pad; lowY = b[1] - pad; lowZ = b[2] - pad; highX = b[3] + pad; highY = b[4] + pad; highZ = b[5] + pad;
      }
      const sx = Math.max(highX - lowX, 0.25), sy = Math.max(highY - lowY, 0.25), sz = Math.max(highZ - lowZ, 0.25), maxDim = Math.max(sx, sy, sz);
      const cells = clamp(Math.round(number(record.params, 'Surface Resolution', 64)), 16, 96);
      const nx = Math.max(6, Math.round(cells * sx / maxDim)), ny = Math.max(6, Math.round(cells * sy / maxDim)), nz = Math.max(6, Math.round(cells * sz / maxDim));
      const dx = sx / nx, dy = sy / ny, dz = sz / nz, wx = nx + 1, wy = ny + 1, totalNodes = wx * wy * (nz + 1);
      const field = new Float32Array(totalNodes), nodePos = new Float32Array(totalNodes * 3), idAt = (x, y, z) => x + wx * (y + wy * z);
      for (let z = 0; z <= nz; z++) for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) { const id = idAt(x, y, z), p = id * 3; nodePos[p] = lowX + x * dx; nodePos[p + 1] = lowY + y * dy; nodePos[p + 2] = lowZ + z * dz; }
      for (let i = 0; i < count; i++) {
        if (!active[i]) continue;
        const p = i * 3, x = positions[p], y = positions[p + 1], z = positions[p + 2];
        if (!Number.isFinite(x + y + z)) continue;
        const gx = (x - lowX) / dx, gy = (y - lowY) / dy, gz = (z - lowZ) / dz;
        const rx = Math.ceil(h / dx), ry = Math.ceil(h / dy), rz = Math.ceil(h / dz);
        const x0 = Math.max(0, Math.floor(gx) - rx), x1 = Math.min(nx, Math.floor(gx) + rx), y0 = Math.max(0, Math.floor(gy) - ry), y1 = Math.min(ny, Math.floor(gy) + ry), z0 = Math.max(0, Math.floor(gz) - rz), z1 = Math.min(nz, Math.floor(gz) + rz);
        for (let iz = z0; iz <= z1; iz++) for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
          const ox = lowX + ix * dx - x, oy = lowY + iy * dy - y, oz = lowZ + iz * dz - z, q = h2 - ox * ox - oy * oy - oz * oz;
          if (q > 0) field[idAt(ix, iy, iz)] += record.mass * poly6 * q * q * q;
        }
      }
      const iso = clamp(number(record.params, 'Surface Density', 0.48), 0.12, 1.5), corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]], tetra = [[0,5,1,6],[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6]];
      const vertexIndices = new Map(), surfacePositions = [], surfaceIndices = [];
      const edgeVertex = (a, b) => {
        const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * totalNodes + hi, cached = vertexIndices.get(key);
        if (cached !== undefined) return cached;
        const va = field[a], vb = field[b], t = clamp((iso - va) / (vb - va || 1e-12), 0, 1), pa = a * 3, pb = b * 3, index = surfacePositions.length / 3;
        surfacePositions.push(nodePos[pa] + (nodePos[pb] - nodePos[pa]) * t, nodePos[pa + 1] + (nodePos[pb + 1] - nodePos[pa + 1]) * t, nodePos[pa + 2] + (nodePos[pb + 2] - nodePos[pa + 2]) * t);
        vertexIndices.set(key, index); return index;
      };
      const centroid = (ids) => { const c = [0,0,0]; for (const id of ids) { const p = id * 3; c[0] += nodePos[p]; c[1] += nodePos[p + 1]; c[2] += nodePos[p + 2]; } return c.map(v => v / ids.length); };
      const triangle = (a, b, c, outward) => {
        if (a === b || b === c || c === a) return;
        const ia = a * 3, ib = b * 3, ic = c * 3, abx = surfacePositions[ib] - surfacePositions[ia], aby = surfacePositions[ib + 1] - surfacePositions[ia + 1], abz = surfacePositions[ib + 2] - surfacePositions[ia + 2], acx = surfacePositions[ic] - surfacePositions[ia], acy = surfacePositions[ic + 1] - surfacePositions[ia + 1], acz = surfacePositions[ic + 2] - surfacePositions[ia + 2];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        if (nx * nx + ny * ny + nz * nz < 1e-14) return;
        if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) surfaceIndices.push(a, c, b); else surfaceIndices.push(a, b, c);
      };
      const processTetra = (ids) => {
        const inside = [], outside = [];
        for (const id of ids) (field[id] >= iso ? inside : outside).push(id);
        if (!inside.length || !outside.length) return;
        const inCenter = centroid(inside), outCenter = centroid(outside), outward = [outCenter[0] - inCenter[0], outCenter[1] - inCenter[1], outCenter[2] - inCenter[2]];
        if (inside.length === 1) { const a = inside[0]; triangle(edgeVertex(a,outside[0]), edgeVertex(a,outside[1]), edgeVertex(a,outside[2]), outward); }
        else if (inside.length === 3) { const a = outside[0]; triangle(edgeVertex(a,inside[0]), edgeVertex(a,inside[1]), edgeVertex(a,inside[2]), outward); }
        else { const a = inside[0], b = inside[1], c = outside[0], d = outside[1], p0 = edgeVertex(a,c), p1 = edgeVertex(a,d), p2 = edgeVertex(b,d), p3 = edgeVertex(b,c); triangle(p0,p1,p2,outward); triangle(p0,p2,p3,outward); }
      };
      const cube = new Uint32Array(8);
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        let min = Infinity, max = -Infinity;
        for (let c = 0; c < 8; c++) { const o = corners[c]; cube[c] = idAt(x + o[0], y + o[1], z + o[2]); const v = field[cube[c]]; min = Math.min(min, v); max = Math.max(max, v); }
        if (min >= iso || max < iso) continue;
        for (const t of tetra) processTetra([cube[t[0]], cube[t[1]], cube[t[2]], cube[t[3]]]);
      }
      if (surfaceIndices.length < 3) { record.surfaceReady = false; record.visual.visible = false; return; }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(surfacePositions), 3));
      const indexArray = surfacePositions.length / 3 > 65535 ? new Uint32Array(surfaceIndices) : new Uint16Array(surfaceIndices);
      geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      const previousGeometry = record.visual.geometry; record.visual.geometry = geometry; previousGeometry?.dispose?.();
      record.surfaceReady = true;
    }

    updateParticleInstances(record) {
      if (record.kind === 'sph') { this.updateFluidSurface(record); return; }
      const positions=this.arena.f32(record.positionPtr,record.count*3),temperatures=record.temperaturePtr?this.arena.f32(record.temperaturePtr,record.count):null,ages=record.agePtr?this.arena.f32(record.agePtr,record.count):null,active=record.activePtr?this.arena.u8(record.activePtr,record.count):record.activeMask;
      const mode=global.FE?.engines?.core?.getShadingMode?.()||'solid';
      if(record.visualMode!==mode){record.visualMode=mode;if(record.fireVisual){record.fireVisual.material.dispose();record.fireVisual.material=this.tracerMaterial('fire',record.domainType,record.params,mode)}if(record.smokeVisual){record.smokeVisual.material.dispose();record.smokeVisual.material=this.tracerMaterial('smoke',record.domainType,record.params,mode)}}
      const camera=global.FE?.engines?.core?.getActiveCamera?.()||global.FE?.engines?.core?.viewportCamera,object=new THREE.Object3D(),color=new THREE.Color(),density=clamp(number(record.params,'Smoke Density',1),.1,3),expansion=clamp(number(record.params,'Expansion Rate',1.2),.1,2.5),{fire:firePreset,smoke:smokePreset}=tracerPresets(record.domainType,record.params);
      const fire=record.fireVisual,smoke=record.smokeVisual;
      for(let i=0;i<record.count;i++){
        const base=i*3,visible=!(active&&active[i]===0);object.position.set(positions[base],positions[base+1],positions[base+2]);if(camera?.quaternion)object.quaternion.copy(camera.quaternion);else object.quaternion.identity();
        const heat=temperatures?clamp(temperatures[i],0,1.5):0,age=ages?ages[i]:0,isHot=visible&&!!fire&&(record.domainType==='Fire'||record.domainType==='Fire + Smoke'&&heat>.52);
        if(fire){object.scale.set(record.radius*.8*(isHot ? .7+heat*.45 : 0),record.radius*(1.35+Math.min(heat,.8))*(isHot?1:0),1);object.updateMatrix();fire.setMatrixAt(i,object.matrix);if(isHot){if(firePreset==='Gas Flame')color.setRGB(.12,.48,1);else if(firePreset==='Wildfire')color.setRGB(1,.12,.015);else if(firePreset==='Torch')color.setRGB(1,.46,.07);else color.setRGB(1,.28+.25*(1-heat/1.5),.035)}else color.setRGB(0,0,0);fire.setColorAt(i,color)}
        if(smoke){const isVisible=visible&&(!fire||!isHot),growth=cl(.8+age*expansion*.16,.8,3.6),sc=isVisible?record.radius*growth*(.78+density*.12):0;object.scale.set(sc,sc*1.12,1);object.updateMatrix();smoke.setMatrixAt(i,object.matrix);if(isVisible){if(smokePreset==='Steam')color.setRGB(.72,.82,.92);else if(smokePreset==='Heavy Fog')color.setRGB(.82,.84,.86);else if(smokePreset==='Dark Soot')color.setRGB(.19,.2,.22);else{const grey=cl(.32+Math.min(age*.045,.3),.25,.68);color.setRGB(grey,grey,grey)}}else color.setRGB(0,0,0);smoke.setColorAt(i,color)}
      }
      for(const visual of [fire,smoke])if(visual){visual.instanceMatrix.needsUpdate=true;if(visual.instanceColor)visual.instanceColor.needsUpdate=true}
      this.frameCount++;
    }
    resolveEffectors(record, dt = 1 / 60) {
      if (!this.effectors.size || !record.positionPtr || !record.velocityPtr) return;
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const velocities = this.arena.f32(record.velocityPtr, record.count * 3);
      const active = record.activePtr ? this.arena.u8(record.activePtr, record.count) : record.activeMask;
      for (const effector of this.effectors.values()) {
        const mesh = effector.mesh;
        mesh.updateWorldMatrix?.(true, false);
        const box = new THREE.Box3().setFromObject(mesh);
        if (box.isEmpty()) continue;
        const guide = effector.params['Effector Type'] === 'Guide';
        const strength = clamp(number(effector.params, 'Bounce', 0.3), 0, 1);
        const thickness = number(effector.params, 'Surface Thickness', 0.1);
        const guideDirection = new THREE.Vector3();
        if (guide) mesh.getWorldDirection(guideDirection);
        const min = [box.min.x - thickness, box.min.y - thickness, box.min.z - thickness];
        const max = [box.max.x + thickness, box.max.y + thickness, box.max.z + thickness];
        for (let i = 0; i < record.count; i++) {
          if (active && active[i] === 0) continue;
          const b = i * 3, x = positions[b], y = positions[b + 1], z = positions[b + 2];
          if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) continue;
          if (guide) {
            const blend = clamp(strength * dt * 5, 0, 0.35);
            const speed = Math.max(Math.hypot(velocities[b], velocities[b + 1], velocities[b + 2]), 1);
            velocities[b] = velocities[b] * (1 - blend) + guideDirection.x * speed * blend;
            velocities[b + 1] = velocities[b + 1] * (1 - blend) + guideDirection.y * speed * blend;
            velocities[b + 2] = velocities[b + 2] * (1 - blend) + guideDirection.z * speed * blend;
            continue;
          }
          const distances = [x - min[0], max[0] - x, y - min[1], max[1] - y, z - min[2], max[2] - z];
          let face = 0;
          for (let k = 1; k < 6; k++) if (distances[k] < distances[face]) face = k;
          const axis = Math.floor(face / 2), isMin = face % 2 === 0;
          const value = isMin ? min[axis] : max[axis];
          positions[b + axis] = value + (isMin ? -1e-3 : 1e-3);
          velocities[b + axis] = (isMin ? -1 : 1) * Math.abs(velocities[b + axis]) * strength;
        }
      }
    }

    removeSimulation(type, mesh) {
      if (!mesh) return;
      const key = this.getSimKey(type);
      const record = this.simMeshes.get(mesh.uuid) || mesh.userData?.[key];
      if (record?.domainEdges) {
        if (record.domainEdges.parent) record.domainEdges.parent.remove(record.domainEdges);
        record.domainEdges.geometry?.dispose?.();
        record.domainEdges.material?.dispose?.();
      }
      if (record?.visual) {
        if (record.visual.parent) record.visual.parent.remove(record.visual);
        if (record.visual.traverse) record.visual.traverse(node=>{node.geometry?.dispose?.();if(node.material)for(const material of [].concat(node.material))material?.dispose?.()});
        else {record.visual.geometry?.dispose?.();record.visual.material?.dispose?.()}
      }
      if (record?.savedMaterial) mesh.material = record.savedMaterial;
      this.effectors.delete(mesh.uuid);
      this.simMeshes.delete(mesh.uuid);
      this.updateStatusBadge();
      delete mesh.userData?.[key];
      if (type === 'Fluid') {
        delete mesh.userData?.fluidSim; delete mesh.userData?.simMesh; delete mesh.userData?.poolMesh;
      }
      if (type === 'Cloth' || type === 'SoftBody') {
        delete mesh.userData.origPositions; delete mesh.userData.prevPositions; delete mesh.userData.currPositions;
      }
    }

    resetSimulation(type, mesh) {
      const record = mesh?.userData?.[this.getSimKey(type)];
      if (!record) return;
      const params = { ...record.params };
      this.removeSimulation(type, mesh);
      this.initSimulation(type, mesh, params);
    }
  }

  function domainTypeHasFire(type) { return type === 'Fire' || type === 'Fire + Smoke'; }

  global.SimulationEngine = UltraSimEngine;
  global.SimEngine = new UltraSimEngine();
})(window);
