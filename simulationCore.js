/* Freestanding C++20/WASM numerical solver bridge for Houdini/LiquiGen-grade cloth, soft-body, FLIP/PBF liquid & turbulent pyro. */
(function installSimulationEngine(global) {
  const MAX_PARTICLES = 768;
  const CPP_ULTRA_MAX_PARTICLES = 960;
  const MAX_SURFACE_VERTS = 49152;
  const MAX_SURFACE_INDICES = 147456;
  const DEFORMABLE_FIXED_STEP = 1 / 120;
  const MAX_DEFORMABLE_SUBSTEPS = 8;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const cl = clamp;
  const number = (params, key, fallback) => {
    const value = Number.parseFloat(params?.[key]);
    return Number.isFinite(value) ? value : fallback;
  };

  const tracerPresets = (domainType, params = {}) => {
    const combined = params['Fire & Smoke Preset'] || 'Campfire & Smoke';
    if (domainType === 'Fire + Smoke') {
      const presets = combined === 'Wildfire Blast'
        ? ['Wildfire', 'Heavy Fog']
        : combined === 'Torch & Soot'
          ? ['Torch', 'Dark Soot']
          : ['Campfire', 'Normal Smoke'];
      return { fire: presets[0], smoke: presets[1] };
    }
    return { fire: params['Fire Preset'] || 'Campfire', smoke: params['Smoke Preset'] || 'Normal Smoke' };
  };

  const tracerLifetime = (record) => clamp(
    (record.count / Math.max(number(record.params, 'Flow Rate', 40), 1)) * (1.2 + number(record.params, 'Flame Height', 1.5) / 1.5),
    1,
    20
  );
  const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
  /* The C++ volumetric solver keeps one static grid, so only one volume
     domain can be live at a time; extra domains keep the particle path. */
  let volumeLocks = 0;

  /* ---- Procedural Studio + Sky HDRI Reflection Texture (works offline & in all viewport modes) ---- */
  let cachedStudioEnvMap = null;
  function getStudioEnvMap() {
    if (cachedStudioEnvMap) return cachedStudioEnvMap;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    /* Crisp physical sky + studio softbox reflection dome */
    const sky = ctx.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0.00, '#1e3a5f');
    sky.addColorStop(0.32, '#4b83b8');
    sky.addColorStop(0.49, '#cfe6f7');
    sky.addColorStop(0.51, '#334155');
    sky.addColorStop(0.75, '#161e29');
    sky.addColorStop(1.00, '#090d14');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 512, 256);

    /* Key sun / studio softbox specular highlight */
    const sun = ctx.createRadialGradient(168, 58, 2, 168, 58, 64);
    sun.addColorStop(0.0, 'rgba(255,253,245,1.0)');
    sun.addColorStop(0.22, 'rgba(255,244,214,0.88)');
    sun.addColorStop(0.55, 'rgba(186,230,253,0.28)');
    sun.addColorStop(1.0, 'rgba(186,230,253,0.0)');
    ctx.fillStyle = sun;
    ctx.fillRect(90, 0, 160, 130);

    /* Cool rim softbox card for crisp Fresnel liquid & silk edges */
    const rim = ctx.createRadialGradient(388, 76, 4, 388, 76, 58);
    rim.addColorStop(0.0, 'rgba(224,242,254,0.92)');
    rim.addColorStop(0.4, 'rgba(125,211,252,0.35)');
    rim.addColorStop(1.0, 'rgba(56,189,248,0.0)');
    ctx.fillStyle = rim;
    ctx.fillRect(320, 12, 140, 130);

    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.EquirectangularReflectionMapping !== undefined) {
      tex.mapping = THREE.EquirectangularReflectionMapping;
    }
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    cachedStudioEnvMap = tex;
    return tex;
  }

  const tracerSpriteCache = new Map();
  function tracerSpriteTexture(kind) {
    if (tracerSpriteCache.has(kind)) return tracerSpriteCache.get(kind);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);
    if (kind === 'fire') {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(128, 14);
      ctx.bezierCurveTo(186, 68, 204, 126, 178, 190);
      ctx.bezierCurveTo(162, 232, 90, 246, 62, 198);
      ctx.bezierCurveTo(30, 146, 74, 100, 80, 58);
      ctx.bezierCurveTo(96, 86, 102, 104, 106, 120);
      ctx.bezierCurveTo(122, 92, 114, 52, 128, 14);
      ctx.closePath();
      ctx.clip();
      const g = ctx.createRadialGradient(126, 154, 4, 128, 138, 124);
      g.addColorStop(0.00, 'rgba(255,255,238,1)');
      g.addColorStop(0.18, 'rgba(255,228,108,0.98)');
      g.addColorStop(0.45, 'rgba(255,124,24,0.88)');
      g.addColorStop(0.76, 'rgba(206,36,4,0.52)');
      g.addColorStop(1.00, 'rgba(64,8,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
      ctx.restore();
    } else if (kind === 'foam') {
      const g = ctx.createRadialGradient(128, 128, 4, 128, 128, 112);
      g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
      g.addColorStop(0.32, 'rgba(238,250,255,0.72)');
      g.addColorStop(0.68, 'rgba(196,232,250,0.22)');
      g.addColorStop(1.00, 'rgba(180,224,248,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    } else {
      let state = 0x8f31a5;
      const rand = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
      };
      for (let i = 0; i < 28; i++) {
        const x = 52 + rand() * 152, y = 50 + rand() * 156, r = 24 + rand() * 54;
        const g = ctx.createRadialGradient(x, y, 2, x, y, r);
        g.addColorStop(0.00, `rgba(248,250,252,${0.26 + rand() * 0.14})`);
        g.addColorStop(0.55, `rgba(176,186,198,${0.13 + rand() * 0.08})`);
        g.addColorStop(1.00, 'rgba(105,116,128,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const g = ctx.createRadialGradient(128, 130, 14, 128, 128, 126);
      g.addColorStop(0.00, 'rgba(255,255,255,0.12)');
      g.addColorStop(0.45, 'rgba(225,232,238,0.10)');
      g.addColorStop(1.00, 'rgba(145,156,168,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if ('colorSpace' in tex && THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('encoding' in tex) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    tracerSpriteCache.set(kind, tex);
    return tex;
  }

  class WasmArena {
    /* Buffers for the simulation core are taken from the kernel's own heap.
     * This class used to be a second bump allocator that started at the end of
     * linear memory and grew it itself; now that kernels allocate lazily from
     * __heap_base, two allocators growing the same region would hand out the
     * same address twice. fe_heap_alloc is the single owner. */
    constructor(exports) {
      this.memory = exports.memory;
      this.allocRaw = (bytes, alignment) => exports.fe_heap_alloc(bytes, alignment);
    }

    alloc(byteLength, alignment = 4) {
      const pointer = this.allocRaw(Math.max(1, byteLength), alignment);
      if (!pointer) throw new Error('WASM memory allocation failed');
      return pointer;
    }

    allocF32(length) { return this.alloc(Math.max(1, length) * 4, 4); }
    allocU32(length) { return this.alloc(Math.max(1, length) * 4, 4); }
    allocU8(length)  { return this.alloc(Math.max(1, length), 1); }
    f32(pointer, length) { return new Float32Array(this.memory.buffer, pointer, length); }
    u32(pointer, length) { return new Uint32Array(this.memory.buffer, pointer, length); }
    u8(pointer, length)  { return new Uint8Array(this.memory.buffer, pointer, length); }
    writeF32(pointer, values) { if (values.length) this.f32(pointer, values.length).set(values); }
    writeU32(pointer, values) { if (values.length) this.u32(pointer, values.length).set(values); }
    writeU8(pointer, values)  { if (values.length) this.u8(pointer, values.length).set(values); }
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
      originalPositions[i * 3] = x;
      originalPositions[i * 3 + 1] = y;
      originalPositions[i * 3 + 2] = z;
      const key = `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
      let node = uniqueByPosition.get(key);
      if (node === undefined) {
        node = unique.length / 3;
        uniqueByPosition.set(key, node);
        unique.push(x, y, z);
      }
      vertexMap[i] = node;
    }
    const sourceIndices = geometry.index?.array;
    const indexCount = sourceIndices?.length ?? originalCount;
    const renderIndices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) renderIndices[i] = sourceIndices ? sourceIndices[i] : i;

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
      const a = renderIndices[i], b = renderIndices[i + 1], c = renderIndices[i + 2];
      const fa = vertexMap[a], fb = vertexMap[b], fc = vertexMap[c];
      if (fa !== fb && fb !== fc && fc !== fa) faces.push(fa, fb, fc);
      registerEdge(a, b, c);
      registerEdge(b, c, a);
      registerEdge(c, a, b);
    }
    if (!edgeRecords.size) throw new Error('Simulation mesh has no triangle-edge constraints');
    const rest = new Float32Array(unique);
    const distance = (a, b) => {
      const ia = a * 3, ib = b * 3;
      return Math.hypot(rest[ia] - rest[ib], rest[ia + 1] - rest[ib + 1], rest[ia + 2] - rest[ib + 2]);
    };
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
      seen.add(key);
      constraints.push({ a: lo, b: hi, length: distance(lo, hi), weight: clamp(weight, 0, 1) });
    };
    for (const edge of baseEdges) {
      const isShearDiagonal = type === 'Cloth' && edge.length > medianLength * 1.35;
      addConstraint(edge.a, edge.b, isShearDiagonal ? shearWeight : 1);
      if (edge.opposites.length === 2) addConstraint(edge.opposites[0], edge.opposites[1], type === 'Cloth' ? bendWeight : 0.35);
    }
    const edgePairs = new Uint32Array(constraints.length * 2), edgeLengths = new Float32Array(constraints.length), edgeWeights = new Float32Array(constraints.length);
    for (let i = 0; i < constraints.length; i++) {
      const edge = constraints[i];
      edgePairs[i * 2] = edge.a;
      edgePairs[i * 2 + 1] = edge.b;
      edgeLengths[i] = edge.length;
      edgeWeights[i] = edge.weight;
    }
    return {
      attribute,
      vertexMap,
      renderIndices,
      originalPositions,
      rest,
      edgePairs,
      edgeLengths,
      edgeWeights,
      faces: new Uint32Array(faces),
      medianEdgeLength: medianLength
    };
  }

  function withSoftBodyVolume(topology) {
    const surfaceNodes = topology.rest.length / 3;
    const faces = topology.faces;
    if (surfaceNodes < 4 || !faces || faces.length < 12 || faces.length / 3 > 8192) return topology;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < topology.rest.length; i += 3) {
      cx += topology.rest[i];
      cy += topology.rest[i + 1];
      cz += topology.rest[i + 2];
    }
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
      restVolumes.push(volume);
      signedTotal += volume;
    }
    if (tetrahedra.length < 12 || Math.abs(signedTotal) < 1e-8) return topology;
    const orientation = Math.sign(signedTotal);
    if (restVolumes.some(volume => Math.sign(volume) !== orientation)) return topology;
    const rest = new Float32Array((surfaceNodes + 1) * 3);
    rest.set(topology.rest);
    rest[surfaceNodes * 3] = cx;
    rest[surfaceNodes * 3 + 1] = cy;
    rest[surfaceNodes * 3 + 2] = cz;
    const edgePairs = Array.from(topology.edgePairs), edgeLengths = Array.from(topology.edgeLengths), edgeWeights = Array.from(topology.edgeWeights);
    let edgeLengthTotal = 0;
    for (const length of edgeLengths) edgeLengthTotal += length;
    for (let node = 0; node < surfaceNodes; node++) {
      const i = node * 3, dx = rest[i] - cx, dy = rest[i + 1] - cy, dz = rest[i + 2] - cz;
      edgePairs.push(surfaceNodes, node);
      edgeLengths.push(Math.hypot(dx, dy, dz));
      edgeWeights.push(0.55);
    }
    return {
      ...topology,
      rest,
      edgePairs: new Uint32Array(edgePairs),
      edgeLengths: new Float32Array(edgeLengths),
      edgeWeights: new Float32Array(edgeWeights),
      volumeTets: new Uint32Array(tetrahedra),
      volumeRest: new Float32Array(restVolumes),
      surfaceNodeCount: surfaceNodes,
      averageEdgeLength: edgeLengthTotal / Math.max(topology.edgeLengths.length, 1)
    };
  }

  function boundsFromPoints(points, padding = 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      minX = Math.min(minX, points[i]); minY = Math.min(minY, points[i + 1]); minZ = Math.min(minZ, points[i + 2]);
      maxX = Math.max(maxX, points[i]); maxY = Math.max(maxY, points[i + 1]); maxZ = Math.max(maxZ, points[i + 2]);
    }
    const sx = Math.max(maxX - minX, 0.25), sy = Math.max(maxY - minY, 0.25), sz = Math.max(maxZ - minZ, 0.25);
    return new Float32Array([
      minX - Math.max(sx * 2.5, padding, 4),
      minY - Math.max(sy * 4.0, padding, 6),
      minZ - Math.max(sz * 2.5, padding, 4),
      maxX + Math.max(sx * 2.5, padding, 4),
      maxY + Math.max(sy * 2.5, padding, 4),
      maxZ + Math.max(sz * 2.5, padding, 4)
    ]);
  }

  function worldBounds(mesh, padding = 0) {
    mesh.updateWorldMatrix?.(true, false);
    mesh.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) throw new Error('Fluid mesh has empty world bounds');
    return new Float32Array([
      box.min.x - padding, box.min.y - padding, box.min.z - padding,
      box.max.x + padding, box.max.y + padding, box.max.z + padding
    ]);
  }

  function lattice(bounds, params, liquid, useCppBudget = false) {
    const sx = bounds[3] - bounds[0], sy = bounds[4] - bounds[1], sz = bounds[5] - bounds[2];
    const maxDim = Math.max(sx, sy, sz, 0.25);
    const resolution = clamp(Math.round(number(params, 'Resolution', 80) / 8), 4, 12);
    const scaledRes = (liquid && useCppBudget) ? Math.round(resolution * 1.25) : resolution;
    const cap = (liquid && useCppBudget) ? CPP_ULTRA_MAX_PARTICLES : MAX_PARTICLES;
    let nx = Math.max(3, Math.round(scaledRes * sx / maxDim));
    let ny = Math.max(3, Math.round(scaledRes * sy / maxDim));
    let nz = Math.max(3, Math.round(scaledRes * sz / maxDim));
    while (nx * ny * nz > cap) {
      if (nx >= ny && nx >= nz) nx--;
      else if (ny >= nz) ny--;
      else nz--;
    }
    const fillBottom = liquid ? 0.56 : 0.18;
    const insetX = sx * 0.08, insetZ = sz * 0.08;
    const lowX = bounds[0] + insetX, highX = bounds[3] - insetX;
    const lowZ = bounds[2] + insetZ, highZ = bounds[5] - insetZ;
    const lowY = bounds[1] + sy * 0.06, highY = bounds[1] + sy * fillBottom;
    const positions = [];
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          /* Slight deterministic jitter breaks grid-aliasing staircases while keeping crystal symmetry */
          const jx = (((ix * 73 + iy * 19 + iz * 37) % 11) - 5) * 0.008;
          const jz = (((ix * 41 + iy * 53 + iz * 17) % 11) - 5) * 0.008;
          const x = lowX + (ix + 0.5 + jx) * (highX - lowX) / nx;
          const y = lowY + (iy + 0.5) * (highY - lowY) / ny;
          const z = lowZ + (iz + 0.5 + jz) * (highZ - lowZ) / nz;
          if (liquid) {
            const rx = (x - (lowX + highX) * 0.5) / Math.max((highX - lowX) * 0.5, 1e-4);
            const rz = (z - (lowZ + highZ) * 0.5) / Math.max((highZ - lowZ) * 0.5, 1e-4);
            if (rx * rx + rz * rz > 1.15) continue;
          }
          positions.push(x, y, z);
        }
      }
    }
    const particlePositions = new Float32Array(positions);
    const spacing = maxDim / Math.max(nx, ny, nz);
    const h = Math.max(spacing * 1.85, 0.08);
    const h2 = h * h, h3 = h2 * h, h6 = h3 * h3, h9 = h6 * h3, poly6 = 315 / (64 * Math.PI * Math.max(h9, 1e-12));
    let kernelTotal = 0;
    const sampleStride = Math.max(1, Math.floor((particlePositions.length / 3) / 192));
    let sampled = 0;
    for (let i = 0; i < particlePositions.length; i += 3 * sampleStride) {
      let rho = 0;
      for (let j = 0; j < particlePositions.length; j += 3) {
        const dx = particlePositions[i] - particlePositions[j];
        const dy = particlePositions[i + 1] - particlePositions[j + 1];
        const dz = particlePositions[i + 2] - particlePositions[j + 2];
        const q = h2 - dx * dx - dy * dy - dz * dz;
        if (q > 0) rho += poly6 * q * q * q;
      }
      kernelTotal += rho;
      sampled++;
    }
    const averageKernel = kernelTotal / Math.max(sampled, 1);
    const mass = averageKernel > 1e-8 ? 1 / averageKernel : 1;
    return { positions: particlePositions, spacing, smoothingLength: h, mass, radius: spacing * 0.54 };
  }

  function closestPointOnTriangle(px, py, pz, t, out) {
    const ax = t.a[0], ay = t.a[1], az = t.a[2];
    const abx = t.b[0] - ax, aby = t.b[1] - ay, abz = t.b[2] - az;
    const acx = t.c[0] - ax, acy = t.c[1] - ay, acz = t.c[2] - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
    const bpx = px - t.b[0], bpy = py - t.b[1], bpz = pz - t.b[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = t.b[0]; out[1] = t.b[1]; out[2] = t.b[2]; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
    const cpx = px - t.c[0], cpy = py - t.c[1], cpz = pz - t.c[2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = t.c[0]; out[1] = t.c[1]; out[2] = t.c[2]; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      out[0] = t.b[0] + w * (t.c[0] - t.b[0]);
      out[1] = t.b[1] + w * (t.c[1] - t.b[1]);
      out[2] = t.b[2] + w * (t.c[2] - t.b[2]);
      return;
    }
    const inv = 1 / (va + vb + vc), v = vb * inv, w = vc * inv;
    out[0] = ax + abx * v + acx * w;
    out[1] = ay + aby * v + acy * w;
    out[2] = az + abz * v + acz * w;
  }

  /* ---- Photorealistic Custom Shader Injectors (Three.js r128 Compatible) ---- */
  function enhanceLiquidPhysicalShader(material, preset) {
    const uniforms = {
      uSimTime: { value: 0 },
      uEnvTex: { value: getStudioEnvMap() },
      uHasEnvTex: { value: getStudioEnvMap() ? 1 : 0 },
      uAbsorption: {
        value: preset === 'Honey'
          ? new THREE.Vector3(0.45, 1.65, 4.8)
          : preset === 'Oil'
            ? new THREE.Vector3(1.8, 2.9, 5.2)
            : preset === 'Slime'
              ? new THREE.Vector3(2.8, 0.55, 2.1)
              : new THREE.Vector3(2.45, 0.42, 0.16)
      },
      uIor: { value: preset === 'Honey' ? 1.50 : preset === 'Oil' ? 1.48 : preset === 'Slime' ? 1.38 : 1.333 },
      uFoamTint: {
        value: preset === 'Honey'
          ? new THREE.Vector3(1.0, 0.94, 0.76)
          : preset === 'Slime'
            ? new THREE.Vector3(0.84, 1.0, 0.92)
            : new THREE.Vector3(0.95, 0.99, 1.0)
      }
    };
    material.userData.liquidUniforms = uniforms;
    material.userData.ultraSimShader = 'liquid-pbr';
    material.customProgramCacheKey = () => `fe-ultra-liquid-${preset}-v3`;

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec2 aFoam;
          varying vec2 vFoamSpeed;
          varying vec3 vWorldPosSim;
          varying vec3 vWorldNrmSim;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vFoamSpeed = aFoam;
          vec4 simWp = modelMatrix * vec4(transformed, 1.0);
          vWorldPosSim = simWp.xyz;
          vWorldNrmSim = normalize(mat3(modelMatrix) * objectNormal);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uSimTime;
          uniform sampler2D uEnvTex;
          uniform float uHasEnvTex;
          uniform vec3 uAbsorption;
          uniform float uIor;
          uniform vec3 uFoamTint;
          varying vec2 vFoamSpeed;
          varying vec3 vWorldPosSim;
          varying vec3 vWorldNrmSim;

          vec2 feDirToEquirect(vec3 dir) {
            vec3 d = normalize(dir);
            float u = atan(d.z, d.x) * 0.15915494 + 0.5;
            float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830988 + 0.5;
            return vec2(u, v);
          }`
        )
        .replace(
          '#include <dithering_fragment>',
          `if (uHasEnvTex > 0.5) {
            vec3 Vw = normalize(cameraPosition - vWorldPosSim);
            /* Subtle capillary micro-ripple normal detail */
            float cap1 = sin(vWorldPosSim.x * 26.0 + uSimTime * 4.2) * cos(vWorldPosSim.z * 24.0 - uSimTime * 3.7);
            float cap2 = sin((vWorldPosSim.x + vWorldPosSim.z) * 43.0 - uSimTime * 5.8);
            vec3 Nw = normalize(vWorldNrmSim + vec3(cap1, 0.0, cap2) * 0.018);
            if (!gl_FrontFacing) Nw = -Nw;

            float ndotv = clamp(dot(Nw, Vw), 0.0, 1.0);
            float f0 = pow((1.0 - uIor) / (1.0 + uIor), 2.0);
            float fresnel = f0 + (1.0 - f0) * pow(1.0 - ndotv, 5.0);

            vec3 reflDir = reflect(-Vw, Nw);
            vec3 refrDirR = refract(-Vw, Nw, 1.0 / (uIor * 0.992));
            vec3 refrDirG = refract(-Vw, Nw, 1.0 / uIor);
            vec3 refrDirB = refract(-Vw, Nw, 1.0 / (uIor * 1.008));
            if (length(refrDirG) < 0.001) refrDirG = reflDir;

            vec3 envRefl = texture2D(uEnvTex, feDirToEquirect(reflDir)).rgb;
            vec3 envRefr = vec3(
              texture2D(uEnvTex, feDirToEquirect(refrDirR)).r,
              texture2D(uEnvTex, feDirToEquirect(refrDirG)).g,
              texture2D(uEnvTex, feDirToEquirect(refrDirB)).b
            );

            /* Beer-Lambert volumetric absorption + internal caustic shimmer */
            float optDepth = mix(1.35, 0.22, ndotv);
            vec3 transmittance = exp(-uAbsorption * optDepth);
            float caustic = pow(max(0.0, sin(vWorldPosSim.x * 14.0 + uSimTime * 3.1) * sin(vWorldPosSim.z * 14.0 - uSimTime * 2.6)), 3.0) * 0.22;
            vec3 bodyColor = envRefr * transmittance + transmittance * caustic * 0.45;

            /* Subsurface wave-crest forward scatter */
            vec3 sunDir = normalize(vec3(0.45, 0.82, 0.35));
            float crestSss = pow(clamp(dot(-Vw, sunDir + Nw * 0.45), 0.0, 1.0), 3.0) * (1.0 - ndotv) * 0.42;
            bodyColor += transmittance * crestSss;

            /* Crisp GGX-like sun specular glint */
            vec3 H = normalize(Vw + sunDir);
            float sunGlint = pow(max(dot(Nw, H), 0.0), 220.0) * 1.85;

            vec3 optical = mix(bodyColor, envRefl * 1.28, clamp(fresnel * 1.15, 0.04, 0.96)) + vec3(sunGlint);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, optical, 0.72);

            /* Aerated whitewater crest & vortex foam from C++ solver */
            float foamMask = clamp(vFoamSpeed.x * 1.15 + smoothstep(2.2, 5.5, vFoamSpeed.y) * 0.45, 0.0, 0.92);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, uFoamTint, foamMask);
            gl_FragColor.a = clamp(mix(0.84, 0.99, fresnel + foamMask * 0.65), 0.80, 1.0);
          }
          #include <dithering_fragment>`
        );
    };
    return material;
  }

  function enhanceDeformableShader(mesh, type, params = {}) {
    const preset = params[type === 'Cloth' ? 'Fabric Preset' : 'Soft Body Preset'] || (type === 'Cloth' ? 'Silk Satin' : 'Translucent Jelly');
    if (preset === 'Keep Mesh Material') return;
    if (!mesh.userData.savedSimBaseMaterial && mesh.material) {
      mesh.userData.savedSimBaseMaterial = mesh.material;
    }
    const baseColor = mesh.userData.savedSimBaseMaterial?.color?.clone?.() || new THREE.Color(type === 'Cloth' ? 0x6366f1 : 0xec4899);

    let color = baseColor.clone();
    let roughness = 0.45, metalness = 0.02, sheenStrength = 0.55, sssStrength = 0.25, clearcoat = 0.0;
    if (type === 'Cloth') {
      if (preset === 'Silk Satin')   { roughness = 0.24; sheenStrength = 0.85; sssStrength = 0.28; clearcoat = 0.18; }
      else if (preset === 'Velvet')  { roughness = 0.68; sheenStrength = 1.15; sssStrength = 0.16; }
      else if (preset === 'Cotton')  { roughness = 0.78; sheenStrength = 0.35; sssStrength = 0.22; }
      else if (preset === 'Denim')   { roughness = 0.84; sheenStrength = 0.28; sssStrength = 0.08; }
      else if (preset === 'Leather') { roughness = 0.32; sheenStrength = 0.22; sssStrength = 0.06; clearcoat = 0.35; }
    } else {
      if (preset === 'Translucent Jelly') { roughness = 0.08; sheenStrength = 0.35; sssStrength = 0.85; clearcoat = 1.0; }
      else if (preset === 'Silicone Gel') { roughness = 0.18; sheenStrength = 0.28; sssStrength = 0.58; clearcoat = 0.75; }
      else if (preset === 'Latex Rubber') { roughness = 0.28; sheenStrength = 0.20; sssStrength = 0.22; clearcoat = 0.45; }
      else if (preset === 'Memory Foam')  { roughness = 0.82; sheenStrength = 0.32; sssStrength = 0.14; clearcoat = 0.0; }
    }

    const mat = new THREE.MeshPhysicalMaterial({
      color,
      roughness,
      metalness,
      clearcoat,
      clearcoatRoughness: 0.06,
      envMap: getStudioEnvMap(),
      envMapIntensity: type === 'SoftBody' ? 1.15 : 0.75,
      side: THREE.DoubleSide
    });
    mat.userData.ultraSimShader = type === 'Cloth' ? 'cloth-vellum' : 'softbody-sss';
    mat.customProgramCacheKey = () => `fe-ultra-${type}-${preset}-v3`;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSheenStrength = { value: sheenStrength };
      shader.uniforms.uSssStrength = { value: sssStrength };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aStrain;
          varying float vSimStrain;
          varying vec3 vSimWorldPos;
          varying vec3 vSimWorldNrm;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vSimStrain = aStrain;
          vSimWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vSimWorldNrm = normalize(mat3(modelMatrix) * objectNormal);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uSheenStrength;
          uniform float uSssStrength;
          varying float vSimStrain;
          varying vec3 vSimWorldPos;
          varying vec3 vSimWorldNrm;`
        )
        .replace(
          '#include <dithering_fragment>',
          `{
            vec3 Vw = normalize(cameraPosition - vSimWorldPos);
            vec3 Nw = normalize(vSimWorldNrm);
            if (!gl_FrontFacing) Nw = -Nw;
            float ndotv = clamp(dot(Nw, Vw), 0.0, 1.0);

            /* Charlie microfiber grazing sheen + wrinkle fold cavity AO */
            float sheen = pow(1.0 - ndotv, 3.2) * uSheenStrength;
            float foldAo = clamp(1.0 + min(vSimStrain, 0.0) * 0.42, 0.58, 1.0);
            float stretchSheen = max(vSimStrain, 0.0) * 0.18;

            /* Subsurface translucent wrap illumination */
            vec3 keyDir = normalize(vec3(0.48, 0.78, 0.40));
            float wrap = clamp((dot(Nw, keyDir) + 0.55) / 1.55, 0.0, 1.0);
            float backTrans = pow(clamp(dot(-Vw, keyDir + Nw * 0.35), 0.0, 1.0), 2.4) * uSssStrength;

            gl_FragColor.rgb *= foldAo;
            gl_FragColor.rgb += diffuseColor.rgb * (backTrans * 0.72 + wrap * uSssStrength * 0.18);
            gl_FragColor.rgb += mix(diffuseColor.rgb, vec3(1.0), 0.55) * (sheen * 0.36 + stretchSheen);
          }
          #include <dithering_fragment>`
        );
    };

    mesh.material = mat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  class UltraSimEngine {
    constructor() {
      this.simMeshes = new Map();
      this.effectors = new Map();
      this.collisionSurfaceCache = new Map();
      this.frameCount = 0;
      this.simClock = 0;
      this.wasm = null;
      this.arena = null;
      this.isCppBackend = false;
      this.loadError = null;
      this.ready = this.loadWasm().then(() => { this.updateStatusBadge(); return true; }).catch((error) => {
        this.loadError = error;
        console.error('[SimulationEngine] C++20/WASM solver could not be loaded; simulations are stopped rather than replaced with fake motion.', error);
        global.FE?.toast?.(`Physics unavailable: ${error?.message || error}`);
        this.updateStatusBadge();
        return false;
      });
      global.document?.addEventListener('DOMContentLoaded', () => this.updateStatusBadge(), { once: true });
    }

    getSolverDiagnostics() {
      return {
        ready: !!this.wasm,
        isCppBackend: !!this.isCppBackend,
        backendLabel: this.isCppBackend ? 'C++20/WASM v3 (XPBD + PBF/FLIP + Smooth SDF)' : `WASM v${this.abiVersion || 0}`,
        abiVersion: this.abiVersion || 0,
        activeSimulations: [...this.simMeshes.values()].filter(r => r.status === 'running').length
      };
    }

    /* There is no solver badge in the viewport: simulation state is exposed
       through getSolverDiagnostics() and the ⚙ diagnostics sheet only. This
       clears the pill an older shell may still have cached. */
    updateStatusBadge() {
      const stale = global.document?.getElementById?.('tb-status-badge');
      if (stale?.remove) stale.remove();
    }

    getSimKey(type) {
      if (type === 'Cloth') return 'clothSim';
      if (type === 'SoftBody') return 'softBodySim';
      if (type === 'Fluid') return 'fluidSim';
      return 'physicsSim';
    }

    async loadWasm() {
      if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not available in this browser');
      let bytes = null;
      if (global.__FE_CPP_WASM_BASE64__ && typeof atob === 'function') {
        const bin = atob(global.__FE_CPP_WASM_BASE64__);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        bytes = u8.buffer;
      }
      if (!bytes) {
        const cppUrls = ['./fe_core_engine.wasm', './wasm/fe_core_engine.wasm'];
        const urls = ['./simulation_solver.wasm', './wasm/simulation_solver.wasm'];
        let response = null;
        for (const path of [...cppUrls, ...urls]) {
          try {
            const targetUrl = document?.baseURI ? new URL(path, document.baseURI) : path;
            const candidate = await fetch(targetUrl, { cache: 'no-cache' });
            if (candidate && candidate.ok) { response = candidate; break; }
          } catch (_) {}
        }
        if (!response) throw new Error('WASM request failed at the app root and ./wasm/ fallback paths');
        bytes = await response.arrayBuffer();
      }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const exports = instance.exports;
      if (typeof exports.fe_core_abi_version === 'function') exports.fe_core_abi_version();
      const required = ['memory', '__heap_base', 'fe_heap_alloc', 'sim_solver_abi_version', 'sim_solver_deformable_step', 'sim_solver_sph_step', 'sim_solver_buoyant_tracer_step'];
      for (const name of required) if (!exports[name]) throw new Error(`WASM solver export missing: ${name}`);
      const abiVersion = exports.sim_solver_abi_version();
      if (![1, 2, 3].includes(abiVersion)) throw new Error(`Unsupported solver ABI version ${abiVersion}`);
      this.abiVersion = abiVersion;
      this.isCppBackend = typeof exports.fe_sim_backend_magic === 'function' && exports.fe_sim_backend_magic() === 0x43505033;
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
        if (!ok) {
          record.status = 'error';
          record.error = this.loadError?.message || 'WASM unavailable';
          this.updateStatusBadge();
          return;
        }
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
      mesh.updateWorldMatrix?.(true, false);
      mesh.updateMatrixWorld?.(true);
      const matrix = mesh.matrixWorld || new THREE.Matrix4(), count = pinned.length, world = new Float64Array(count * 3), v = new THREE.Vector3();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let node = 0; node < count; node++) {
        const i = node * 3;
        v.set(topology.rest[i], topology.rest[i + 1], topology.rest[i + 2]).applyMatrix4(matrix);
        world[i] = v.x; world[i + 1] = v.y; world[i + 2] = v.z;
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      }
      const spanY = maxY - minY, spanX = maxX - minX, spanZ = maxZ - minZ;
      if (mode !== 'Two Corners') {
        const cutoff = maxY - Math.max(spanY * 0.025, Math.max(spanX, spanZ) * 0.002, 1e-4);
        for (let node = 0; node < count; node++) if (world[node * 3 + 1] >= cutoff) pinned[node] = 1;
      }
      let pinnedCount = 0;
      for (const value of pinned) pinnedCount += value;
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

      /* C++20 zero-copy surface faces, volume tetrahedra & render scatter buffers */
      const renderVertCount = topology.attribute.count;
      const facesPtr = topology.faces?.length ? arena.allocU32(topology.faces.length) : 0;
      const volumeTetsPtr = topology.volumeTets?.length ? arena.allocU32(topology.volumeTets.length) : 0;
      const volumeRestPtr = topology.volumeRest?.length ? arena.allocF32(topology.volumeRest.length) : 0;
      const vertexMapPtr = arena.allocU32(topology.vertexMap.length);
      const renderIndicesPtr = topology.renderIndices?.length ? arena.allocU32(topology.renderIndices.length) : 0;
      const renderPosPtr = arena.allocF32(renderVertCount * 3);
      const renderNrmPtr = arena.allocF32(renderVertCount * 3);
      const renderStrainPtr = arena.allocF32(renderVertCount);

      arena.writeF32(positionPtr, topology.rest);
      arena.writeF32(previousPtr, topology.rest);
      arena.writeF32(restPtr, topology.rest);
      arena.writeU8(pinsPtr, pinned);
      arena.writeU32(edgesPtr, topology.edgePairs);
      arena.writeF32(lengthsPtr, topology.edgeLengths);
      arena.writeF32(edgeWeightsPtr, topology.edgeWeights);
      arena.writeF32(boundsPtr, bounds);
      if (facesPtr) arena.writeU32(facesPtr, topology.faces);
      if (volumeTetsPtr) arena.writeU32(volumeTetsPtr, topology.volumeTets);
      if (volumeRestPtr) arena.writeF32(volumeRestPtr, topology.volumeRest);
      arena.writeU32(vertexMapPtr, topology.vertexMap);
      if (renderIndicesPtr) arena.writeU32(renderIndicesPtr, topology.renderIndices);

      /* Prepare DynamicDrawUsage buffers & per-vertex wrinkle/strain attribute */
      topology.attribute.setUsage?.(THREE.DynamicDrawUsage);
      if (!mesh.geometry.attributes.normal || mesh.geometry.attributes.normal.count !== renderVertCount) {
        mesh.geometry.computeVertexNormals();
      }
      mesh.geometry.attributes.normal?.setUsage?.(THREE.DynamicDrawUsage);
      const strainAttr = new THREE.Float32BufferAttribute(new Float32Array(renderVertCount), 1);
      strainAttr.setUsage?.(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aStrain', strainAttr);

      enhanceDeformableShader(mesh, type, params);

      record.solver = {
        ...topology,
        nodeCount,
        edgeCount,
        renderVertCount,
        surfaceTriCount: Math.floor((topology.faces?.length || 0) / 3),
        tetCount: Math.floor((topology.volumeTets?.length || 0) / 4),
        positionPtr,
        previousPtr,
        restPtr,
        pinsPtr,
        edgesPtr,
        lengthsPtr,
        edgeWeightsPtr,
        boundsPtr,
        facesPtr,
        volumeTetsPtr,
        volumeRestPtr,
        vertexMapPtr,
        renderIndicesPtr,
        renderPosPtr,
        renderNrmPtr,
        renderStrainPtr,
        strainAttr,
        bounds
      };
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

    resolveMeshCollisions(mesh,state,params,type,stepDt) {
      const dt=stepDt;
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
      const iterations = clamp(Math.round(number(params, 'Quality', 8)), 2, 24);
      const goalStrength = type === 'SoftBody' ? clamp(number(params, 'Goal Strength', 0.5), 0, 1) : 0;
      const rawDamping = clamp(number(params, 'Damping', 0.08) + (type === 'SoftBody' ? number(params, 'Goal Damping', 0) * goalStrength * 0.25 : 0), 0, 0.95);
      const damping = 1 - Math.pow(1 - rawDamping, stepDt * 60);
      const gravity = Math.max(0, number(params, 'Gravity', 9.8));
      const rawStiffness = type === 'Cloth' ? clamp(number(params, 'Structural Stiffness', 15) / 45, 0.05, 1) : clamp(number(params, 'Stiffness', 0.5), 0.02, 1);
      const stiffness = type === 'SoftBody' ? Math.max(rawStiffness * 0.72, 0.05) : rawStiffness;
      const goal = type === 'SoftBody' ? goalStrength * goalStrength * 0.08 : 0;
      const stretch = type === 'Cloth' ? number(params, 'Stretch Resistance', 0.9) : 0.96;
      const compression = type === 'Cloth' ? number(params, 'Compression Resistance', 0.9) : 0.92;
      const volumePreservation = type === 'SoftBody' ? number(params, 'Volume Preservation', 0.85) : 0;
      const plasticity = type === 'SoftBody' ? number(params, 'Plasticity', 0) : 0;
      const margin = type === 'SoftBody' ? number(params, 'Collision Margin', 0.02) : 0.005;
      const airDrag = clamp(number(params, 'Air Drag', 0.05), 0, 0.95);
      const friction = 1 - Math.pow(1 - airDrag, stepDt * 60 / (iterations + 1));

      mesh.updateWorldMatrix?.(true, false);
      mesh.updateMatrixWorld?.(true);
      const inverseWorld = mesh.matrixWorld?.clone?.().invert?.();
      const invRot = inverseWorld ? new THREE.Matrix3().setFromMatrix4(inverseWorld) : null;
      const localGravity = new THREE.Vector3(0, -gravity, 0);
      if (inverseWorld) localGravity.applyMatrix3(new THREE.Matrix3().setFromMatrix4(inverseWorld));

      const windSpeed = type === 'Cloth' ? number(params, 'Wind Speed', 0) : 0;
      const windTurbulence = type === 'Cloth' ? clamp(number(params, 'Wind Turbulence', 0.25), 0, 1.5) : 0;
      const localWind = new THREE.Vector3(windSpeed * 0.35, 0, windSpeed);
      if (invRot && windSpeed !== 0) localWind.applyMatrix3(invRot);
      const selfColRadius = (type === 'Cloth' && params['Self Collision'] !== false)
        ? Math.min((state.medianEdgeLength || 0.08) * 0.42, 0.05)
        : 0;

      let rc = 0;
      if (this.isCppBackend && typeof this.wasm.fe_sim_xpbd_deformable_step === 'function') {
        rc = this.wasm.fe_sim_xpbd_deformable_step(
          state.positionPtr, state.previousPtr, state.restPtr, state.pinsPtr,
          state.edgesPtr, state.lengthsPtr, state.edgeWeightsPtr,
          state.nodeCount, state.edgeCount,
          state.facesPtr, state.surfaceTriCount,
          state.volumeTetsPtr, state.volumeRestPtr, state.tetCount,
          stepDt,
          localGravity.x, localGravity.y, localGravity.z,
          damping, stiffness, goal, stretch, compression,
          volumePreservation, plasticity, selfColRadius,
          localWind.x, localWind.y, localWind.z, windTurbulence, this.simClock, airDrag,
          margin, iterations, state.boundsPtr,
          number(params, 'Bounce', type === 'SoftBody' ? 0.18 : 0.02), friction
        );
      } else {
        rc = this.wasm.sim_solver_deformable_step(
          state.positionPtr, state.previousPtr, state.restPtr, state.pinsPtr,
          state.edgesPtr, state.lengthsPtr, state.edgeWeightsPtr, state.nodeCount, state.edgeCount,
          stepDt, 0, damping, stiffness, goal, stretch, compression, plasticity, margin, iterations,
          state.boundsPtr, number(params, 'Bounce', type === 'SoftBody' ? 0.12 : 0.02), friction
        );
        const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3), pinned = this.arena.u8(state.pinsPtr, state.nodeCount), dt2 = stepDt * stepDt;
        for (let node = 0; node < state.nodeCount; node++) if (!pinned[node]) {
          const i = node * 3;
          positions[i] += localGravity.x * dt2;
          positions[i + 1] += localGravity.y * dt2;
          positions[i + 2] += localGravity.z * dt2;
        }
        if (type === 'SoftBody' && state.volumeTets?.length) this.projectSoftBodyVolume(state, volumePreservation, margin, iterations);
      }

      if (rc < 0) { this.fail(record, new Error(record.type + ' solver returned ' + rc)); return; }

      this.resolveGroundContact(mesh, state, params, type);
      this.resolveMeshCollisions(mesh, state, params, type, stepDt);

      /* Zero-copy C++20 scatter + smooth welded vertex normals + wrinkle strain field */
      if (this.isCppBackend && typeof this.wasm.fe_sim_scatter_mesh_and_normals === 'function') {
        this.wasm.fe_sim_scatter_mesh_and_normals(
          state.positionPtr, state.restPtr, state.nodeCount,
          state.vertexMapPtr, state.renderVertCount,
          state.renderIndicesPtr, state.renderIndices?.length || 0,
          state.renderPosPtr, state.renderNrmPtr, state.renderStrainPtr
        );
        state.attribute.array.set(this.arena.f32(state.renderPosPtr, state.renderVertCount * 3));
        state.attribute.needsUpdate = true;
        const nrmAttr = mesh.geometry.attributes.normal;
        if (nrmAttr && nrmAttr.array.length === state.renderVertCount * 3) {
          nrmAttr.array.set(this.arena.f32(state.renderNrmPtr, state.renderVertCount * 3));
          nrmAttr.needsUpdate = true;
        }
        if (state.strainAttr) {
          state.strainAttr.array.set(this.arena.f32(state.renderStrainPtr, state.renderVertCount));
          state.strainAttr.needsUpdate = true;
        }
      } else {
        const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3);
        for (let vertex = 0; vertex < state.vertexMap.length; vertex++) {
          const source = state.vertexMap[vertex] * 3;
          state.attribute.setXYZ(vertex, positions[source], positions[source + 1], positions[source + 2]);
        }
        state.attribute.needsUpdate = true;
        if ((this.frameCount++ & 1) === 0) mesh.geometry.computeVertexNormals();
      }
      if ((this.frameCount++ & 3) === 0) mesh.geometry.computeBoundingSphere();

      /* Notify any Surface Deform dependents bound to this simulating deformable! */
      if (typeof global.refreshModifierDependents === 'function' && (this.frameCount & 1) === 0) {
        global.refreshModifierDependents(mesh);
      }
    }

    resolveGroundContact(mesh, state, params, type) {
      const positions = this.arena.f32(state.positionPtr, state.nodeCount * 3);
      const previous = this.arena.f32(state.previousPtr, state.nodeCount * 3);
      const pinned = this.arena.u8(state.pinsPtr, state.nodeCount);
      const floor = number(params, 'Ground Height', 0) + (type === 'SoftBody' ? clamp(number(params, 'Collision Margin', 0.02), 0, 0.5) : 0.004);
      const friction = clamp(number(params, 'Ground Friction', type === 'Cloth' ? 0.35 : 0.28), 0, 1);
      const bounce = clamp(number(params, 'Bounce', type === 'SoftBody' ? 0.18 : 0.02), 0, 1);
      mesh.updateWorldMatrix?.(true, false);
      mesh.updateMatrixWorld?.(true);
      const matrix = mesh.matrixWorld, inverse = matrix?.clone?.().invert?.();
      if (!inverse) return;
      const current = new THREE.Vector3(), prior = new THREE.Vector3(), worldCurrent = new THREE.Vector3(), worldPrior = new THREE.Vector3();
      for (let node = 0; node < state.nodeCount; node++) {
        if (pinned[node]) continue;
        const i = node * 3;
        current.set(positions[i], positions[i + 1], positions[i + 2]);
        worldCurrent.copy(current).applyMatrix4(matrix);
        if (worldCurrent.y >= floor) continue;
        prior.set(previous[i], previous[i + 1], previous[i + 2]);
        worldPrior.copy(prior).applyMatrix4(matrix);
        let vx = worldCurrent.x - worldPrior.x, vy = worldCurrent.y - worldPrior.y, vz = worldCurrent.z - worldPrior.z;
        worldCurrent.y = floor;
        if (vy < 0) vy = -vy * bounce;
        vx *= 1 - friction; vz *= 1 - friction;
        worldPrior.set(worldCurrent.x - vx, worldCurrent.y - vy, worldCurrent.z - vz);
        current.copy(worldCurrent).applyMatrix4(inverse);
        prior.copy(worldPrior).applyMatrix4(inverse);
        positions[i] = current.x; positions[i + 1] = current.y; positions[i + 2] = current.z;
        previous[i] = prior.x; previous[i + 1] = prior.y; previous[i + 2] = prior.z;
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
          const gb = [(vy * wz - vz * wy) / 6, (vz * wx - vx * wz) / 6, (vx * wy - vy * vx) / 6];
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
        record.domainEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 })
        );
        mesh.add(record.domainEdges);
      }
      if (domainType === 'Liquid') this.createLiquidParticles(mesh, params, record);
      else if (['Fire', 'Smoke', 'Fire + Smoke'].includes(domainType)) {
        /* Fire and smoke run as a voxel volume when the C++ core is available.
           The particle tracers remain the fallback for a device without the
           kernel, for a second simultaneous domain, and when the modifier
           turns the volume solver off. */
        const volume = params['Volume Solver'] !== false && this.createVolumeSimulation(mesh, params, record);
        if (!volume) this.createBuoyantParticles(mesh, params, record);
      }
      else throw new Error(`Unsupported fluid domain type: ${domainType}`);
      mesh.userData.simMesh = record.visual;
      mesh.userData.poolMesh = null;
      mesh.userData.fluidSim = record;
      this.simMeshes.set(mesh.uuid, record);
    }

    createLiquidParticles(mesh, params, record) {
      const box = record.bounds;
      const fluid = lattice(box, params, true, this.isCppBackend);
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
      record.foamEnergyPtr = arena.allocF32(count);
      record.activePtr = arena.allocU8(count);
      record.activeMask = new Uint8Array(count).fill(1);
      record.flowAges = new Float32Array(count);
      record.flowBehavior = record.role === 'Flow'
        ? (params['Flow Behavior'] || 'Inflow')
        : (params['Internal Inflow'] === true ? 'Inflow' : 'Geometry');
      record.outflowEnabled = record.flowBehavior === 'Outflow';
      record.exitBounds = box.slice();
      if (record.outflowEnabled) {
        const pad = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]) * 1.5;
        arena.writeF32(record.boundsPtr, new Float32Array([box[0] - pad, box[1] - pad, box[2] - pad, box[3] + pad, box[4] + pad, box[5] + pad]));
      }
      record.emitAccumulator = 0;
      record.emitCursor = 0;
      arena.writeU8(record.activePtr, record.activeMask);
      arena.writeF32(record.positionPtr, fluid.positions);
      arena.writeF32(record.foamEnergyPtr, new Float32Array(count));

      const initialVelocity = new Float32Array(count * 3);
      const flowScale = Math.max(0, number(params, 'Flow Speed', 4)) / 4;
      const velocity = [
        number(params, 'Velocity X', 0) * flowScale,
        number(params, 'Velocity Y', 0) * flowScale,
        number(params, 'Velocity Z', 0) * flowScale
      ];
      for (let i = 0; i < count; i++) initialVelocity.set(velocity, i * 3);
      arena.writeF32(record.velocityPtr, initialVelocity);
      record.initialPositions = fluid.positions.slice();
      record.sourcePositions = fluid.positions.slice();
      if (record.role !== 'Flow') {
        for (let i = 0; i < count; i++) record.sourcePositions[i * 3 + 1] = box[1] + (box[4] - box[1]) * 0.82;
      }
      record.initialVelocities = initialVelocity;

      /* Pre-allocate persistent DynamicDrawUsage liquid surface mesh + WASM reconstruction buffers (ZERO per-frame GC!) */
      if (this.isCppBackend) {
        record.surfPosPtr = arena.allocF32(MAX_SURFACE_VERTS * 3);
        record.surfNrmPtr = arena.allocF32(MAX_SURFACE_VERTS * 3);
        record.surfFoamPtr = arena.allocF32(MAX_SURFACE_VERTS * 2);
        record.surfIdxPtr = arena.allocU32(MAX_SURFACE_INDICES);
        record.surfCountsPtr = arena.allocU32(2);
      }

      const surfGeo = new THREE.BufferGeometry();
      const posBuf = new THREE.Float32BufferAttribute(new Float32Array(MAX_SURFACE_VERTS * 3), 3);
      const nrmBuf = new THREE.Float32BufferAttribute(new Float32Array(MAX_SURFACE_VERTS * 3), 3);
      const foamBuf = new THREE.Float32BufferAttribute(new Float32Array(MAX_SURFACE_VERTS * 2), 2);
      const idxBuf = new THREE.BufferAttribute(new Uint32Array(MAX_SURFACE_INDICES), 1);
      posBuf.setUsage?.(THREE.DynamicDrawUsage);
      nrmBuf.setUsage?.(THREE.DynamicDrawUsage);
      foamBuf.setUsage?.(THREE.DynamicDrawUsage);
      idxBuf.setUsage?.(THREE.DynamicDrawUsage);
      surfGeo.setAttribute('position', posBuf);
      surfGeo.setAttribute('normal', nrmBuf);
      surfGeo.setAttribute('aFoam', foamBuf);
      surfGeo.setIndex(idxBuf);
      surfGeo.setDrawRange(0, 0);

      record.visual = new THREE.Mesh(surfGeo, this.liquidMaterial(params));
      record.visual.frustumCulled = false;
      record.visual.castShadow = true;
      record.visual.receiveShadow = true;
      record.visual.renderOrder = 2;
      record.visual.userData.solverSurface = 'C++20 PBF-FLIP smooth SDF surface';
      record.visual.userData.ultraSimShader = 'liquid-pbr';
      record.surfaceFrame = 0;
      record.surfaceReady = false;
      this.scene().add(record.visual);

      /* Secondary Whitewater Spray & Crest Foam InstancedMesh */
      const sprayMat = new THREE.MeshBasicMaterial({
        map: tracerSpriteTexture('foam'),
        color: 0xffffff,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      record.sprayVisual = this.createParticleVisual(Math.min(count, 512), record.radius * 0.42, sprayMat, 0xf0f9ff);
      record.sprayVisual.renderOrder = 3;
      this.scene().add(record.sprayVisual);

      record.mesh.userData.fluidSurfaceScale = Math.max(box[3] - box[0], box[5] - box[2]);
      /* Reconstruct initial resting fluid surface immediately so frame 0 looks crisp */
      this.updateFluidSurface(record);
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
      record.kind = 'tracer';
      record.count = count;
      record.radius = Math.max(fluid.radius, Math.max(sizeX, sizeZ) / 36);
      record.positionPtr = arena.allocF32(count * 3);
      record.velocityPtr = arena.allocF32(count * 3);
      record.temperaturePtr = arena.allocF32(count);
      record.agePtr = arena.allocF32(count);
      record.activePtr = arena.allocU8(count);
      record.activeMask = new Uint8Array(count).fill(1);
      arena.writeF32(record.positionPtr, positions);
      arena.writeF32(record.velocityPtr, velocities);
      arena.writeF32(record.temperaturePtr, temperatures);
      arena.writeF32(record.agePtr, ages);
      arena.writeU8(record.activePtr, record.activeMask);

      record.initialPositions = positions.slice();
      record.sourcePositions = positions.slice();
      record.initialVelocities = velocities.slice();
      record.initialTemperatures = temperatures.slice();
      record.flowBehavior = record.role === 'Flow' ? (params['Flow Behavior'] || 'Inflow') : (params['Internal Inflow'] === true ? 'Inflow' : 'Geometry');
      record.inflowEnabled = record.flowBehavior === 'Inflow' && (record.role === 'Flow' ? params['Use Flow'] !== false : params['Internal Inflow'] === true);
      record.outflowEnabled = record.flowBehavior === 'Outflow';
      record.emitAccumulator = 0;
      record.emitCursor = 0;
      record.exitBounds = box.slice();
      if (record.outflowEnabled) {
        const pad = Math.max(sizeX, sizeY, sizeZ) * 1.5;
        this.arena.writeF32(record.boundsPtr, new Float32Array([box[0] - pad, box[1] - pad, box[2] - pad, box[3] + pad, box[4] + pad, box[5] + pad]));
      }
      const renderMode = global.FE?.engines?.core?.getShadingMode?.() || 'solid';
      const group = new THREE.Group();
      const hasFire = domainTypeHasFire(record.domainType), hasSmoke = record.domainType === 'Smoke' || record.domainType === 'Fire + Smoke';
      record.visual = group;
      record.visualMode = renderMode;
      record.fireVisual = hasFire ? this.createParticleVisual(count, record.radius, this.tracerMaterial('fire', record.domainType, params, renderMode), 0xffffff) : null;
      record.smokeVisual = hasSmoke ? this.createParticleVisual(count, record.radius, this.tracerMaterial('smoke', record.domainType, params, renderMode), 0xffffff) : null;
      if (record.fireVisual) group.add(record.fireVisual);
      if (record.smokeVisual) group.add(record.smokeVisual);
      group.userData.solverParticleVisual = true;
      group.userData.solverRadius = record.radius;
      this.updateParticleInstances(record);
      this.scene().add(group);
    }

    volumeShader() {
      return {
        vertexShader: `
varying vec3 vWorld;
void main(){
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`,
        fragmentShader: `
precision highp float;
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform vec3 uBoxMin, uBoxMax, uSunDir;
uniform vec2 uTiles, uAtlasSize;
uniform float uGrid, uDensityScale, uTempScale, uSigma, uFireGain, uSmokeGain, uSteps;
uniform float uDetail, uDetailScale, uDetailSpeed, uTime, uSelfShadow, uAmbient, uEmission, uExtinction, uFrame;
uniform float uDetailContrast;
uniform vec3 uFireTint;
uniform int uScatter;
/* Baked "cinema" set: frames x slices tiled in one atlas, two frames blended. */
uniform sampler2D uLibAtlas;
uniform vec2 uLibTiles, uLibSize;
uniform float uLibGrid, uLibA, uLibB, uLibBlend, uLibMix;
varying vec3 vWorld;
vec2 atlasUv(vec2 xy, float slice){
  float tx = mod(slice, uTiles.x);
  float ty = floor(slice / uTiles.x);
  vec2 texel = xy * (uGrid - 1.0) + 0.5;
  return (vec2(tx, ty) * uGrid + texel) / uAtlasSize;
}
/* Catmull-Rom across four neighbouring slices: linear blending leaves visible
   steps when the grid is only 24-28 cells tall, the cubic keeps the falloff
   smooth without another texture. */
vec2 sampleField(vec3 uvw){
  float s = clamp(uvw.z, 0.0, 1.0) * (uGrid - 1.0);
  float s0 = floor(s);
  float t = s - s0;
  float last = uGrid - 1.0;
  vec2 xy = clamp(uvw.xy, 0.0, 1.0);
  vec2 p0 = texture2D(uAtlas, atlasUv(xy, max(s0 - 1.0, 0.0))).rg;
  vec2 p1 = texture2D(uAtlas, atlasUv(xy, s0)).rg;
  vec2 p2 = texture2D(uAtlas, atlasUv(xy, min(s0 + 1.0, last))).rg;
  vec2 p3 = texture2D(uAtlas, atlasUv(xy, min(s0 + 2.0, last))).rg;
  vec2 v = 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t);
  return max(v, vec2(0.0)) * vec2(uDensityScale, uTempScale);
}
/* Planckian ramp: dull ember -> orange flame -> white-hot core. */
vec3 blackbody(float heat){
  vec3 c = mix(vec3(0.55, 0.05, 0.01), vec3(1.0, 0.26, 0.03), smoothstep(0.0, 0.32, heat));
  c = mix(c, vec3(1.0, 0.62, 0.15), smoothstep(0.32, 0.64, heat));
  return mix(c, vec3(1.0, 0.95, 0.78), smoothstep(0.64, 1.0, heat));
}
float densityAt(vec3 uvw){
  if (uvw.x < 0.0 || uvw.y < 0.0 || uvw.z < 0.0 || uvw.x > 1.0 || uvw.y > 1.0 || uvw.z > 1.0) return 0.0;
  return max(sampleField(uvw).x, 0.0);
}
vec2 libUv(float tile, vec2 xy){
  float tx = mod(tile, uLibTiles.x);
  float ty = floor(tile / uLibTiles.x);
  vec2 texel = xy * (uLibGrid - 1.0) + 0.5;
  return (vec2(tx, ty) * uLibGrid + texel) / uLibSize;
}
vec2 libField(vec3 uvw){
  float s = clamp(uvw.z, 0.0, 1.0) * (uLibGrid - 1.0);
  float s0 = floor(s), t = s - s0;
  float s1 = min(s0 + 1.0, uLibGrid - 1.0);
  vec2 a0 = texture2D(uLibAtlas, libUv(uLibA * uLibGrid + s0, uvw.xy)).rg;
  vec2 a1 = texture2D(uLibAtlas, libUv(uLibA * uLibGrid + s1, uvw.xy)).rg;
  vec2 b0 = texture2D(uLibAtlas, libUv(uLibB * uLibGrid + s0, uvw.xy)).rg;
  vec2 b1 = texture2D(uLibAtlas, libUv(uLibB * uLibGrid + s1, uvw.xy)).rg;
  return mix(mix(a0, a1, t), mix(b0, b1, t), uLibBlend);
}
/* Three scrolling reads of the baked tile: billows, wisps and a slow mask.
   The grid is only 24-28 cells tall, so this is where small detail comes from. */
float detailField(vec3 uvw){
  if (uDetail <= 0.001) return 1.0;
  float drift = uTime * uDetailSpeed;
  vec3 q = uvw * uDetailScale;
  float a = texture2D(uNoise, vec2(q.x * 0.31 + drift * 0.07, q.z * 0.31 - drift * 0.11) + uvw.y * 0.37).r;
  float b = texture2D(uNoise, vec2(q.z * 0.67 - drift * 0.05, q.y * 0.67 + drift * 0.09) + uvw.x * 0.23).g;
  float c = texture2D(uNoise, vec2(q.y * 1.13 + drift * 0.13, q.x * 1.13 - drift * 0.04)).b;
  float n = a * 0.55 + b * 0.32 + c * 0.26;
  /* Contrast pivots around the tile mean, so 1.0 is the untouched pattern. */
  return clamp((n - 0.5) * clamp(uDetailContrast, 0.2, 3.0) + 0.5, 0.0, 1.6);
}
void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 rdx = vec3(abs(rd.x) < 1e-4 ? 1e-4 : rd.x, abs(rd.y) < 1e-4 ? 1e-4 : rd.y, abs(rd.z) < 1e-4 ? 1e-4 : rd.z);
  vec3 tA = (uBoxMin - ro) / rdx;
  vec3 tB = (uBoxMax - ro) / rdx;
  vec3 tmin = min(tA, tB), tmax = max(tA, tB);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf <= tn) discard;
  float span = tf - tn;
  float stepLen = span / max(uSteps, 1.0);
  /* Frame-indexed jitter: with temporal history each frame samples a
     different set of depths, so the grain averages out instead of crawling. */
  float jitter = fract(sin(dot(gl_FragCoord.xy + vec2(uFrame * 5.588238, uFrame * 3.1731), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 col = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= uSteps) break;
    float t = tn + (float(i) + jitter) * stepLen;
    vec3 uvw = (ro + rd * t - uBoxMin) / (uBoxMax - uBoxMin);
    if (uvw.x < 0.0 || uvw.y < 0.0 || uvw.z < 0.0 || uvw.x > 1.0 || uvw.y > 1.0 || uvw.z > 1.0) continue;
    vec2 field = sampleField(uvw);
    if (uLibMix > 0.0) {
      vec2 baked = libField(uvw) * vec2(uDensityScale, uTempScale);
      field = mix(field, baked, clamp(uLibMix, 0.0, 1.0));
    }
    float dens = max(field.x, 0.0);
    float temp = max(field.y, 0.0);
    float heat = smoothstep(0.18, 1.6, temp);
    /* Silhouette guard: the detail term fades to 1.0 where the base density
       approaches the surface, so no slider can eat the shape the solver made. */
    float edge = smoothstep(0.02, 0.28, dens);
    float detail = detailField(uvw);
    float detailAmount = clamp(uDetail, 0.0, 2.0) * 0.5 * edge;
    dens *= mix(1.0, mix(0.55, 1.45, detail), detailAmount);
    temp *= mix(1.0, mix(0.82, 1.18, detail), detailAmount * 0.5);
    float fire = heat * uFireGain;
    float smoke = dens * uSmokeGain;
    float sigma = (smoke * 0.85 + fire * 1.35) * uSigma * uExtinction;
    if (sigma <= 0.0) continue;
    /* Sun march: the first tap is always taken, Scatter Samples adds up to
       three more so the user trades GPU time for softer multiple scattering. */
    float shade = densityAt(uvw + uSunDir * 0.03);
    for (int s = 1; s < 4; s++) {
      if (s >= uScatter) break;
      shade += densityAt(uvw + uSunDir * (0.03 + float(s) * 0.035)) * (0.75 - float(s) * 0.15);
    }
    float light = mix(1.0, exp(-shade * uDensityScale * 1.7), clamp(uSelfShadow, 0.0, 1.0));
    vec3 fireCol = blackbody(heat) * uFireTint;
    vec3 smokeCol = mix(vec3(0.26, 0.28, 0.32), vec3(0.64, 0.66, 0.7), clamp(dens * uDensityScale, 0.0, 1.0));
    vec3 emission = fireCol * fire * (1.3 + 1.1 * light) * uEmission
                  + smokeCol * smoke * (0.10 + 0.55 * light + uAmbient);
    float a = 1.0 - exp(-sigma * stepLen);
    col += trans * emission * a;
    trans *= 1.0 - a;
    if (trans < 0.02) break;
  }
  float alpha = 1.0 - trans;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col / max(alpha, 0.004), alpha);
}`
      };
    }

    volumeMaterial(record, isFire, isSmoke, box) {
      const v = record.volume;
      const shaders = this.volumeShader();
      return new THREE.ShaderMaterial({
        uniforms: {
          uAtlas: { value: v.texture },
          uBoxMin: { value: new THREE.Vector3(box[0], box[1], box[2]) },
          uBoxMax: { value: new THREE.Vector3(box[3], box[4], box[5]) },
          uSunDir: { value: new THREE.Vector3(0.35, 1, 0.25).normalize() },
          uTiles: { value: new THREE.Vector2(v.layout.tilesX, v.layout.tilesY) },
          uAtlasSize: { value: new THREE.Vector2(v.layout.width, v.layout.height) },
          uGrid: { value: v.grid },
          uDensityScale: { value: v.densityScale },
          uTempScale: { value: v.tempScale },
          uSigma: { value: 2.4 },
          uFireGain: { value: isFire ? 1 : 0 },
          uSmokeGain: { value: isSmoke ? 1 : 0 },
          uSteps: { value: v.steps },
          uNoise: { value: v.noise },
          uDetail: { value: v.detail },
          uDetailScale: { value: v.detailScale },
          uDetailSpeed: { value: v.detailSpeed },
          uTime: { value: v.time },
          uSelfShadow: { value: v.selfShadow },
          uScatter: { value: v.scatter },
          uAmbient: { value: v.ambient },
          uExtinction: { value: v.extinction },
          uEmission: { value: v.emission },
          uLibAtlas: { value: v.library ? v.library.texture : v.noise },
          uLibTiles: { value: new THREE.Vector2(v.library ? v.library.atlas.tilesX : 1, v.library ? v.library.atlas.tilesY : 1) },
          uLibSize: { value: new THREE.Vector2(v.library ? v.library.atlas.width : 1, v.library ? v.library.atlas.height : 1) },
          uLibGrid: { value: v.library ? v.library.atlas.grid : 1 },
          uLibA: { value: 0 },
          uLibB: { value: 0 },
          uLibBlend: { value: 0 },
          uLibMix: { value: v.library ? 1 : 0 },
          uDetailContrast: { value: v.detailContrast },
          uFireTint: { value: volumeTint(v.fireTint) },
          uFrame: { value: 0 }
        },
        vertexShader: shaders.vertexShader,
        fragmentShader: shaders.fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.BackSide,
        blending: THREE.NormalBlending
      });
    }

    volumeSourcePoint(mesh, record) {
      const box = record.bounds;
      const spanX = Math.max(box[3] - box[0], 1e-3), spanY = Math.max(box[4] - box[1], 1e-3), spanZ = Math.max(box[5] - box[2], 1e-3);
      if (record.role === 'Flow' && mesh && typeof mesh.getWorldPosition === 'function') {
        const world = mesh.getWorldPosition(new THREE.Vector3());
        return {
          x: clamp((world.x - box[0]) / spanX, 0.08, 0.92),
          y: clamp((world.y - box[1]) / spanY, 0.06, 0.5),
          z: clamp((world.z - box[2]) / spanZ, 0.08, 0.92)
        };
      }
      return {
        x: clamp((((box[0] + box[3]) * 0.5) - box[0]) / spanX, 0.1, 0.9),
        y: 0.08,
        z: clamp((((box[2] + box[5]) * 0.5) - box[2]) / spanZ, 0.1, 0.9)
      };
    }

    /* Resolve the requested baked variant, packing its atlas once per process.
       Returns null (and starts the download) when the binary is not there yet,
       so the live solver simply keeps running. */
    volumeLibraryVariant(params, isFire, isSmoke) {
      const data = global.FEVolumeLibraryData;
      const lib = global.FEVolumeLibrary;
      if (!data || !lib) { loadVolumeLibrary(); return null; }
      const fallbackName = isSmoke && !isFire ? 'Smoke' : 'Fire';
      const variant = lib.find(data, String(params['Library Variant'] || fallbackName)) || lib.find(data, fallbackName);
      if (!variant) return null;
      const cache = this.libraryTextures || (this.libraryTextures = new Map());
      const key = `${variant.name}:${variant.grid}:${variant.frames}`;
      let entry = cache.get(key);
      if (!entry) {
        const atlas = lib.packAtlas(variant);
        const texture = new THREE.DataTexture(atlas.data, atlas.width, atlas.height, THREE.RGBAFormat);
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        entry = { atlas, texture, variant };
        cache.set(key, entry);
      }
      return { atlas: entry.atlas, texture: entry.texture, variant: entry.variant, motion: clamp(number(params, 'Library Motion', 1), 0.2, 3) };
    }

    createVolumeSimulation(mesh, params, record) {
      const engine = global.FECppEngine;
      const exports = engine && engine.ready !== false ? engine.exports : null;
      if (!exports || typeof exports.fe_vol_init !== 'function' || typeof exports.fe_vol_step !== 'function') return false;
      const atlas = global.FEVolumeAtlas;
      if (!atlas || typeof atlas.pack !== 'function' || typeof atlas.layout !== 'function') return false;
      if (volumeLocks > 0) return false;
      /* Mobile keeps the 24³ budget; larger desktop GPUs get 28³ with the same
         per-step cost envelope. Resolution 32..96 scales this target. */
      const coarse = !!(global.matchMedia && global.matchMedia('(pointer:coarse)').matches);
      const cores = Number(global.navigator?.hardwareConcurrency) || 8;
      const ceiling = volumeGridCeiling(params, coarse, cores);
      const grid = Math.max(16, Math.round(clamp(number(params, 'Resolution', 80) / 80 * ceiling, 16, ceiling)));
      if (exports.fe_vol_init(grid, grid, grid) !== 0) return false;
      const box = record.bounds;
      const sizeX = Math.max(box[3] - box[0], 1e-3), sizeY = Math.max(box[4] - box[1], 1e-3), sizeZ = Math.max(box[5] - box[2], 1e-3);
      const info = atlas.layout(grid);
      const data = new Uint8Array(info.width * info.height * 4);
      const texture = new THREE.DataTexture(data, info.width, info.height, THREE.RGBAFormat);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      const isFire = domainTypeHasFire(record.domainType);
      const isSmoke = record.domainType === 'Smoke' || record.domainType === 'Fire + Smoke';
      const heatEmission = clamp(number(params, 'Heat Emission', 1.2), 0.2, 3);
      const smokeDensity = clamp(number(params, 'Smoke Density', 1), 0.1, 3);
      const dissipation = clamp(number(params, 'Dissipation Rate', 0.15), 0.01, 1);
      const library = String(params['Volume Source'] || 'Live Simulation') === 'Baked Library'
        ? this.volumeLibraryVariant(params, isFire, isSmoke) : null;
      record.volume = {
        exports, grid, data, texture, layout: info,
        library,
        densityScale: 0.8, tempScale: 2.2,
        accum: 0, stepInterval: 1 / 30,
        timeScale: clamp(number(params, 'Time Scale', 1), 0.1, 4),
        buoyancy: clamp(number(params, 'Buoyancy', 0.8), -1, 3) * 0.45 + (isFire ? 0.08 : 0),
        vorticity: clamp(number(params, 'Vorticity Confinement', 0.12), 0, 1) * 8,
        dissipation: dissipation * 1.2,
        cooling: 0.3 + dissipation,
        iterations: 20,
        heatPerSecond: (isFire ? 10 : 1.2) * heatEmission * clamp(number(params, 'Fuel', 1), 0.1, 2),
        smokePerSecond: (isSmoke ? 3 : 0.2) * smokeDensity,
        source: this.volumeSourcePoint(mesh, record),
        steps: clamp(Math.round(number(params, 'Volume Steps', 0)) || clamp(Math.round(grid * 2), 32, 64), 16, 64),
        noise: volumeNoiseTexture(),
        time: 0,
        detail: clamp(number(params, 'Detail', 1), 0, 2),
        detailScale: clamp(number(params, 'Detail Scale', 2.5), 0.5, 8),
        detailSpeed: clamp(number(params, 'Detail Speed', 0.6), 0, 3),
        selfShadow: clamp(number(params, 'Self Shadow', 1), 0, 1),
        scatter: Math.round(clamp(number(params, 'Scatter Samples', 2), 1, 4)),
        ambient: clamp(number(params, 'Ambient', 0.15), 0, 1),
        extinction: clamp(number(params, 'Extinction', 1), 0.2, 3),
        emission: clamp(number(params, 'Emission', 1.3), 0, 3),
        quality: String(params['Volume Quality'] || 'Balanced'),
        detailContrast: clamp(number(params, 'Detail Contrast', 1), 0.2, 3),
        fireTint: String(params['Fire Tint'] || 'Natural'),
        temporal: clamp(number(params, 'Temporal Blend', 0), 0, 0.95)
      };
      record.kind = 'volume';
      const material = this.volumeMaterial(record, isFire, isSmoke, box);
      const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
      const visual = new THREE.Mesh(geometry, material);
      visual.position.set((box[0] + box[3]) * 0.5, (box[1] + box[4]) * 0.5, (box[2] + box[5]) * 0.5);
      visual.frustumCulled = false;
      visual.renderOrder = 2;
      visual.name = 'Smoke & Fire Volume';
      record.visual = visual;
      record.volumeTexture = texture;
      record.volumeData = data;
      volumeLocks++;
      this.seedVolumeSource(record, 0.05);
      this.writeVolumeTexture(record);
      this.scene().add(visual);
      return true;
    }

    seedVolumeSource(record, dt) {
      const v = record.volume, exports = v && v.exports;
      if (!exports || typeof exports.fe_vol_source !== 'function') return;
      const heat = v.heatPerSecond * dt, density = v.smokePerSecond * dt;
      if (heat <= 0 && density <= 0) return;
      exports.fe_vol_source(v.source.x, v.source.y, v.source.z, 0.12, heat, density, 0.25 * (heat + density));
    }

    stepVolumeSimulation(record, dt) {
      const v = record.volume;
      if (!v) return;
      /* Baked mode never touches the solver: it only advances the two frame
         indices the shader blends. */
      if (v.library) {
        v.time = (v.time + dt * v.library.motion) % 3600;
        const material = record.visual && record.visual.material;
        const frame = global.FEVolumeLibrary ? global.FEVolumeLibrary.frameAt(v.library.variant, v.time, 1) : { a: 0, b: 0, blend: 0 };
        if (material && material.uniforms) {
          const u = material.uniforms;
          if (u.uTime) u.uTime.value = v.time;
          if (u.uLibA) u.uLibA.value = frame.a;
          if (u.uLibB) u.uLibB.value = frame.b;
          if (u.uLibBlend) u.uLibBlend.value = frame.blend;
        }
        return;
      }
      v.accum = Math.min(v.accum + dt * v.timeScale, 0.12);
      if (v.accum < v.stepInterval) return;
      const stepDt = Math.min(v.accum, 0.05);
      v.accum = 0;
      v.time = (v.time + stepDt) % 3600;
      v.frame = (v.frame | 0) + 1;
      const volumeUniforms = record.visual && record.visual.material && record.visual.material.uniforms;
      if (volumeUniforms && volumeUniforms.uFrame) volumeUniforms.uFrame.value = v.frame;
      if (typeof v.exports.fe_vol_set_temporal === 'function') v.exports.fe_vol_set_temporal(v.temporal);
      this.seedVolumeSource(record, stepDt);
      const rc = v.exports.fe_vol_step(stepDt, v.buoyancy, v.vorticity, v.dissipation, v.cooling, v.iterations);
      if (rc < 0) {
        record.status = 'error';
        this.updateStatusBadge();
        return;
      }
      this.writeVolumeTexture(record);
      this.syncVolumeUniforms(record);
    }

    syncVolumeUniforms(record) {
      const v = record.volume;
      const material = record.visual && record.visual.material;
      if (!v || !material || !material.uniforms) return;
      const u = material.uniforms;
      if (u.uTime) u.uTime.value = v.time;
      if (u.uSteps) u.uSteps.value = v.steps;
      if (u.uDetail) u.uDetail.value = v.detail;
      if (u.uDetailScale) u.uDetailScale.value = v.detailScale;
      if (u.uDetailSpeed) u.uDetailSpeed.value = v.detailSpeed;
      if (u.uSelfShadow) u.uSelfShadow.value = v.selfShadow;
      if (u.uScatter) u.uScatter.value = v.scatter;
      if (u.uAmbient) u.uAmbient.value = v.ambient;
      if (u.uExtinction) u.uExtinction.value = v.extinction;
      if (u.uEmission) u.uEmission.value = v.emission;
    }

    writeVolumeTexture(record) {
      const v = record.volume;
      if (!v || !v.exports || !global.FEVolumeAtlas) return;
      const cells = v.grid * v.grid * v.grid;
      const buffer = v.exports.memory.buffer;
      const density = new Float32Array(buffer, v.exports.fe_vol_density_ptr(), cells);
      const temperature = new Float32Array(buffer, v.exports.fe_vol_temperature_ptr(), cells);
      global.FEVolumeAtlas.pack({ density, temperature, grid: v.grid, out: record.volumeData, densityScale: v.densityScale, temperatureScale: v.tempScale });
      v.texture.needsUpdate = true;
    }

    liquidMaterial(params) {
      const preset = params['Liquid Preset'] || 'Water';
      const color = preset === 'Honey' ? 0xd99a22 : preset === 'Oil' ? 0x653c20 : preset === 'Slime' ? 0x32a77c : 0x2d91b4;
      const ior = preset === 'Honey' ? 1.5 : preset === 'Oil' ? 1.48 : preset === 'Slime' ? 1.38 : 1.333;
      const mat = new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness: preset === 'Water' ? 0.025 : 0.065, transmission: preset === 'Water' ? 0.78 : 0.72, ior, clearcoat: 1, clearcoatRoughness: 0.018, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: true, envMap: getStudioEnvMap(), envMapIntensity: 1.55 });
      return enhanceLiquidPhysicalShader(mat, preset);
    }

    tracerMaterial(kind, domainType, params = {}, renderMode = 'solid') {
      const rendered = renderMode === 'rendered' || renderMode === 'material';
      const { smoke: smokePreset } = tracerPresets(domainType, params);
      if (kind === 'fire') return new THREE.MeshBasicMaterial({ map: tracerSpriteTexture('fire'), color: 0xffffff, transparent: true, opacity: rendered ? 1 : .94, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide, vertexColors: true, toneMapped: false });
      const density = clamp(number(params, 'Smoke Density', 1), 0.1, 3);
      const baseOpacity = smokePreset === 'Heavy Fog' ? .72 : smokePreset === 'Dark Soot' ? .58 : smokePreset === 'Steam' ? .52 : .5;
      const common = { map: tracerSpriteTexture('smoke'), color: 0xffffff, transparent: true, opacity: clamp(baseOpacity * (.72 + density * .28), .18, .84), depthWrite: false, depthTest: true, side: THREE.DoubleSide, vertexColors: true };
      return rendered ? new THREE.MeshStandardMaterial({ ...common, roughness: 1, metalness: 0, emissive: new THREE.Color(0x14181c), emissiveIntensity: .12 }) : new THREE.MeshBasicMaterial(common);
    }

    createParticleVisual(count, radius, material, color) {
      const geometry = new THREE.PlaneGeometry(2, 2);
      const visual = new THREE.InstancedMesh(geometry, material, count);
      visual.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      visual.frustumCulled = false;
      visual.renderOrder = material?.blending === THREE.AdditiveBlending ? 4 : 3;
      const tint = new THREE.Color(color);
      const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < count; i++) {
        visual.setColorAt(i, tint);
        visual.setMatrixAt(i, zeroMat);
      }
      visual.instanceMatrix.needsUpdate = true;
      if (visual.instanceColor) visual.instanceColor.needsUpdate = true;
      visual.userData.solverParticleVisual = true;
      visual.userData.solverRadius = radius;
      visual.userData.spriteKind = material?.map === tracerSpriteTexture('fire') ? 'fire' : 'smoke';
      return visual;
    }

    scene() {
      const scene = global.FE?.engines?.core?.sc;
      if (!scene) throw new Error('Core scene is unavailable');
      return scene;
    }

    stepSimulation(type, mesh, dt = 1 / 60) {
      const record = mesh?.userData?.[this.getSimKey(type)];
      if (!record || record.status !== 'running') return;
      const rawDt = clamp(Number(dt) || 1 / 60, 1 / 240, 1 / 24);
      const timeScale = clamp(number(record.params, 'Time Scale', 1), 0, 4);
      this.simClock += rawDt * timeScale * 0.5;
      if (type === 'Cloth' || type === 'SoftBody') {
        const frameTime = clamp(rawDt * timeScale, 0, 1 / 18);
        record.stepAccumulator = Math.min((record.stepAccumulator || 0) + frameTime, 1 / 18);
        let steps = 0;
        while (record.stepAccumulator + 1e-8 >= DEFORMABLE_FIXED_STEP && steps < MAX_DEFORMABLE_SUBSTEPS) {
          this.stepClothSoftBody(mesh, type, DEFORMABLE_FIXED_STEP);
          record.stepAccumulator -= DEFORMABLE_FIXED_STEP;
          steps++;
        }
      } else if (type === 'Fluid') {
        const step = clamp(rawDt * timeScale, 0, 1 / 30);
        this.stepFluidSimulation(mesh, step);
      }
    }

    stepFluidSimulation(mesh, dt) {
      const record = mesh?.userData?.fluidSim;
      if (!record || record.status !== 'running' || record.kind === 'effector') return;
      const params = record.params;
      const liquidPreset = params['Liquid Preset'] || 'Water';
      const viscosityScale = liquidPreset === 'Honey' ? 8 : liquidPreset === 'Slime' ? 4 : liquidPreset === 'Oil' ? 2 : 1;
      const tensionScale = liquidPreset === 'Honey' ? 0.55 : liquidPreset === 'Slime' ? 0.9 : liquidPreset === 'Oil' ? 0.3 : 1;
      let rc = 0;

      if (record.kind === 'sph') {
        this.prepareLiquidFlow(record, dt);
        if (this.isCppBackend && typeof this.wasm.fe_sim_liquid_pbf_step === 'function') {
          /* Real-time C++20 Spatial-Hashed PBF + Tensile Correction + XSPH + Vorticity + Whitewater */
          rc = this.wasm.fe_sim_liquid_pbf_step(
            record.positionPtr, record.velocityPtr, record.densityPtr, record.pressurePtr,
            record.foamEnergyPtr, record.activePtr, record.count, dt,
            record.mass, 1, record.smoothingLength,
            number(params, 'Pressure', 1.8),
            number(params, 'Viscosity', 0.01) * viscosityScale,
            number(params, 'Surface Tension', 0.25) * tensionScale,
            clamp(number(params, 'Vorticity Confinement', number(params, 'Turbulence', 0.14)), 0, 1),
            2,
            0, -number(params, 'Gravity', 9.8), 0,
            record.boundsPtr, number(params, 'Bounce', 0.3), number(params, 'Damping', 0.03),
            record.flowBehavior === 'Outflow' ? 1 : 0
          );
          if (rc >= 0) {
            this.resolveParticleCollisions(record, dt);
            this.resolveEffectors(record, dt);
          }
        } else {
          rc = this.wasm.sim_solver_sph_step(
            record.positionPtr, record.velocityPtr, record.densityPtr, record.pressurePtr, record.forcePtr, record.activePtr,
            record.count, dt, record.mass, 1, record.smoothingLength, number(params, 'Pressure', 1.8),
            number(params, 'Viscosity', 0.01) * viscosityScale, number(params, 'Surface Tension', 0.25) * tensionScale,
            0, -number(params, 'Gravity', 9.8), 0,
            record.boundsPtr, number(params, 'Bounce', 0.3), number(params, 'Damping', 0.03),
            record.flowBehavior === 'Outflow' ? 1 : 0
          );
          if (rc >= 0) this.projectLiquidDensity(record, dt);
          this.resolveLiquidOutflow(record);
          this.resolveParticleCollisions(record, dt);
          this.resolveEffectors(record, dt);
        }
        if (record.visual?.material?.userData?.liquidUniforms) {
          record.visual.material.userData.liquidUniforms.uSimTime.value = this.simClock;
        }
      } else if (record.kind === 'volume') {
        this.stepVolumeSimulation(record, dt);
      } else if (record.kind === 'tracer') {
        this.recycleExpired(record);
        if (this.isCppBackend && typeof this.wasm.fe_sim_pyro_step === 'function') {
          rc = this.wasm.fe_sim_pyro_step(
            record.positionPtr, record.velocityPtr, record.temperaturePtr, record.agePtr, record.activePtr,
            record.count, dt, this.simClock,
            number(params, 'Gravity', 9.8), number(params, 'Buoyancy', 0.8),
            clamp(number(params, 'Vorticity Confinement', number(params, 'Turbulence', 0.42)), 0, 2),
            number(params, 'Dissipation Rate', 0.15) * 2,
            domainTypeHasFire(record.domainType) ? 0.08 / Math.max(number(params, 'Fuel', 1), 0.1) : number(params, 'Dissipation Rate', 0.15),
            clamp(number(params, 'Expansion Rate', 1.2) * 0.35, 0, 2),
            tracerLifetime(record), record.boundsPtr, number(params, 'Bounce', 0.3)
          );
        } else {
          rc = this.wasm.sim_solver_buoyant_tracer_step(
            record.positionPtr, record.velocityPtr, record.temperaturePtr, record.agePtr, record.count, dt,
            number(params, 'Gravity', 9.8), number(params, 'Buoyancy', 0.8),
            number(params, 'Dissipation Rate', 0.15) * 2,
            domainTypeHasFire(record.domainType) ? 0.08 / Math.max(number(params, 'Fuel', 1), 0.1) : number(params, 'Dissipation Rate', 0.15),
            tracerLifetime(record), record.boundsPtr, number(params, 'Bounce', 0.3)
          );
        }
        this.resolveTracerOutflow(record);
        this.resolveParticleCollisions(record, dt);
        this.resolveEffectors(record, dt);
      }

      if (rc < 0) { this.fail(record, new Error(`fluid solver returned ${rc}`)); return; }
      this.updateParticleInstances(record);
      if (record.visual) record.visual.visible = mesh.visible && (record.kind !== 'sph' || record.surfaceReady);
      if (record.sprayVisual) record.sprayVisual.visible = mesh.visible && record.surfaceReady;
    }

    projectLiquidDensity(record, dt) {
      if (record.kind !== 'sph' || dt <= 0) return;
      const count = record.count;
      const positions = this.arena.f32(record.positionPtr, count * 3);
      const velocities = this.arena.f32(record.velocityPtr, count * 3);
      const active = this.arena.u8(record.activePtr, count);
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
        const b = record.bounds, pad = Math.max((record.radius || 0.05) * 0.35, 1e-4), bounce = clamp(number(record.params, 'Bounce', 0.3), 0, 1);
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
          if (active[candidate] === 0 || ages[candidate] > 2.8) { index = candidate; break; }
        }
        if (index < 0) index = record.emitCursor % record.count;
        record.emitCursor = (index + 1) % record.count;
        const base = index * 3;
        positions.set(record.sourcePositions.subarray(base, base + 3), base);
        velocities.set(record.initialVelocities.subarray(base, base + 3), base);
        active[index] = 1;
        ages[index] = 0;
      }
    }

    recycleExpired(record) {
      const ages = this.arena.f32(record.agePtr, record.count);
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const velocities = this.arena.f32(record.velocityPtr, record.count * 3);
      const temperatures = this.arena.f32(record.temperaturePtr, record.count);
      const active = record.activePtr ? this.arena.u8(record.activePtr, record.count) : record.activeMask;
      const maxAge = tracerLifetime(record);
      for (let i = 0; i < record.count; i++) if (ages[i] >= maxAge) {
        const base = i * 3;
        if (record.inflowEnabled) {
          positions.set(record.sourcePositions.subarray(base, base + 3), base);
          velocities.set(record.initialVelocities.subarray(base, base + 3), base);
          temperatures[i] = record.initialTemperatures[i];
          ages[i] = 0;
          record.activeMask[i] = 1;
          if (active) active[i] = 1;
        } else {
          temperatures[i] = 0;
          velocities.fill(0, base, base + 3);
          record.activeMask[i] = 0;
          if (active) active[i] = 0;
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
      const active = record.activePtr ? this.arena.u8(record.activePtr, record.count) : null;
      const b = record.exitBounds;
      for (let i = 0; i < record.count; i++) {
        const p = i * 3;
        if (positions[p] < b[0] || positions[p] > b[3] || positions[p + 1] < b[1] || positions[p + 1] > b[4] || positions[p + 2] < b[2] || positions[p + 2] > b[5]) {
          record.activeMask[i] = 0;
          if (active) active[i] = 0;
          velocities.fill(0, p, p + 3);
        }
      }
    }

    updateFluidSurface(record) {
      const cells = clamp(Math.round(number(record.params, 'Surface Resolution', 64)), 16, 96);
      const iso = clamp(number(record.params, 'Surface Density', 0.42), 0.12, 1.5);

      /* Fast Path: 100% C++20 Narrow-Band Filtered SDF + Crack-Free Isosurface + Taubin Smoother + Analytic Normals */
      if (this.isCppBackend && typeof this.wasm.fe_sim_reconstruct_liquid_mesh === 'function' && record.surfPosPtr) {
        const rc = this.wasm.fe_sim_reconstruct_liquid_mesh(
          record.positionPtr,
          record.velocityPtr,
          record.foamEnergyPtr,
          record.activePtr,
          record.count,
          record.boundsPtr,
          record.smoothingLength,
          record.mass,
          iso,
          cells,
          1,
          record.outflowEnabled ? 1 : 0,
          record.surfPosPtr,
          record.surfNrmPtr,
          record.surfFoamPtr,
          MAX_SURFACE_VERTS,
          record.surfIdxPtr,
          MAX_SURFACE_INDICES,
          record.surfCountsPtr
        );
        const counts = this.arena.u32(record.surfCountsPtr, 2);
        const vertCount = counts[0], idxCount = counts[1];
        if (rc <= 0 || vertCount < 3 || idxCount < 3) {
          record.surfaceReady = false;
          if (record.visual) record.visual.visible = false;
          return;
        }
        const geo = record.visual.geometry;
        geo.attributes.position.array.subarray(0, vertCount * 3).set(this.arena.f32(record.surfPosPtr, vertCount * 3));
        geo.attributes.normal.array.subarray(0, vertCount * 3).set(this.arena.f32(record.surfNrmPtr, vertCount * 3));
        if (geo.attributes.aFoam) {
          geo.attributes.aFoam.array.subarray(0, vertCount * 2).set(this.arena.f32(record.surfFoamPtr, vertCount * 2));
          geo.attributes.aFoam.needsUpdate = true;
        }
        geo.index.array.subarray(0, idxCount).set(this.arena.u32(record.surfIdxPtr, idxCount));
        geo.attributes.position.needsUpdate = true;
        geo.attributes.normal.needsUpdate = true;
        geo.index.needsUpdate = true;
        geo.setDrawRange(0, idxCount);
        record.surfaceReady = true;

        /* Update airborne whitewater spray & crest foam droplets */
        if (record.sprayVisual) {
          const camera = global.FE?.engines?.core?.getActiveCamera?.() || global.FE?.engines?.core?.viewportCamera;
          const pos = this.arena.f32(record.positionPtr, record.count * 3);
          const foam = this.arena.f32(record.foamEnergyPtr, record.count);
          const active = this.arena.u8(record.activePtr, record.count);
          const dummy = record._sprayDummy || (record._sprayDummy = new THREE.Object3D());
          const maxSpray = record.sprayVisual.count;
          const stride = Math.max(1, Math.floor(record.count / maxSpray));
          for (let s = 0; s < maxSpray; s++) {
            const pi = (s * stride) % record.count;
            const e = active[pi] ? foam[pi] : 0;
            if (e > 0.34) {
              const b = pi * 3;
              dummy.position.set(pos[b], pos[b + 1] + record.radius * 0.28, pos[b + 2]);
              if (camera?.quaternion) dummy.quaternion.copy(camera.quaternion);
              const sc = record.radius * (0.22 + e * 0.48);
              dummy.scale.set(sc, sc, 1);
            } else {
              dummy.scale.set(0, 0, 0);
            }
            dummy.updateMatrix();
            record.sprayVisual.setMatrixAt(s, dummy.matrix);
          }
          record.sprayVisual.instanceMatrix.needsUpdate = true;
        }
        return;
      }

      /* Fallback path when running with legacy non-C++ WASM */
      if (record.surfaceReady) { record.surfaceFrame++; if (record.surfaceFrame % 2 === 1) return; }
      const count = record.count, positions = this.arena.f32(record.positionPtr, count * 3), active = this.arena.u8(record.activePtr, count);
      const h = Math.max(record.smoothingLength || 0.1, 0.05), h2 = h * h, poly6 = 315 / (64 * Math.PI * Math.max(h ** 9, 1e-12));
      const b = record.bounds, pad = h * 0.45;
      const lowX = b[0] - pad, lowY = b[1] - pad, lowZ = b[2] - pad, highX = b[3] + pad, highY = b[4] + pad, highZ = b[5] + pad;
      const sx = Math.max(highX - lowX, 0.25), sy = Math.max(highY - lowY, 0.25), sz = Math.max(highZ - lowZ, 0.25), maxDim = Math.max(sx, sy, sz);
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
        for (let iz = Math.max(0, Math.floor(gz) - rz); iz <= Math.min(nz, Math.floor(gz) + rz); iz++)
          for (let iy = Math.max(0, Math.floor(gy) - ry); iy <= Math.min(ny, Math.floor(gy) + ry); iy++)
            for (let ix = Math.max(0, Math.floor(gx) - rx); ix <= Math.min(nx, Math.floor(gx) + rx); ix++) {
              const ox = lowX + ix * dx - x, oy = lowY + iy * dy - y, oz = lowZ + iz * dz - z, q = h2 - ox * ox - oy * oy - oz * oz;
              if (q > 0) field[idAt(ix, iy, iz)] += record.mass * poly6 * q * q * q;
            }
      }
      record.surfaceReady = field.some(v => v >= iso);
    }

    updateParticleInstances(record) {
      if (record.kind === 'volume') return;
      if (record.kind === 'sph') { this.updateFluidSurface(record); return; }
      const positions = this.arena.f32(record.positionPtr, record.count * 3);
      const temperatures = record.temperaturePtr ? this.arena.f32(record.temperaturePtr, record.count) : null;
      const ages = record.agePtr ? this.arena.f32(record.agePtr, record.count) : null;
      const active = record.activePtr ? this.arena.u8(record.activePtr, record.count) : record.activeMask;
      const mode = global.FE?.engines?.core?.getShadingMode?.() || 'solid';
      if (record.visualMode !== mode) {
        record.visualMode = mode;
        if (record.fireVisual) { record.fireVisual.material.dispose(); record.fireVisual.material = this.tracerMaterial('fire', record.domainType, record.params, mode); }
        if (record.smokeVisual) { record.smokeVisual.material.dispose(); record.smokeVisual.material = this.tracerMaterial('smoke', record.domainType, record.params, mode); }
      }
      const camera = global.FE?.engines?.core?.getActiveCamera?.() || global.FE?.engines?.core?.viewportCamera;
      const object = record._billboardDummy || (record._billboardDummy = new THREE.Object3D());
      const color = record._billboardColor || (record._billboardColor = new THREE.Color());
      const density = clamp(number(record.params, 'Smoke Density', 1), .1, 3);
      const expansion = clamp(number(record.params, 'Expansion Rate', 1.2), .1, 2.5);
      const { fire: firePreset, smoke: smokePreset } = tracerPresets(record.domainType, record.params);
      const fire = record.fireVisual, smoke = record.smokeVisual;
      for (let i = 0; i < record.count; i++) {
        const base = i * 3, visible = !(active && active[i] === 0);
        object.position.set(positions[base], positions[base + 1], positions[base + 2]);
        if (camera?.quaternion) object.quaternion.copy(camera.quaternion);
        else object.quaternion.identity();
        const heat = temperatures ? clamp(temperatures[i], 0, 1.5) : 0, age = ages ? ages[i] : 0;
        const isHot = visible && !!fire && (record.domainType === 'Fire' || record.domainType === 'Fire + Smoke' && heat > .48);
        if (fire) {
          object.scale.set(record.radius * .85 * (isHot ? .72 + heat * .48 : 0), record.radius * (1.42 + Math.min(heat, .85)) * (isHot ? 1 : 0), 1);
          object.updateMatrix();
          fire.setMatrixAt(i, object.matrix);
          if (isHot) {
            if (firePreset === 'Gas Flame') color.setRGB(.14, .54, 1);
            else if (firePreset === 'Wildfire') color.setRGB(1, .16, .02);
            else if (firePreset === 'Torch') color.setRGB(1, .50, .08);
            else color.setRGB(1, .30 + .28 * (1 - heat / 1.5), .04);
          } else color.setRGB(0, 0, 0);
          fire.setColorAt(i, color);
        }
        if (smoke) {
          const isVisible = visible && (!fire || !isHot);
          const growth = cl(.82 + age * expansion * .18, .82, 3.8);
          const sc = isVisible ? record.radius * growth * (.80 + density * .14) : 0;
          object.scale.set(sc, sc * 1.14, 1);
          object.updateMatrix();
          smoke.setMatrixAt(i, object.matrix);
          if (isVisible) {
            if (smokePreset === 'Steam') color.setRGB(.74, .84, .94);
            else if (smokePreset === 'Heavy Fog') color.setRGB(.82, .85, .88);
            else if (smokePreset === 'Dark Soot') color.setRGB(.18, .19, .22);
            else { const grey = cl(.34 + Math.min(age * .048, .32), .26, .70); color.setRGB(grey, grey, grey); }
          } else color.setRGB(0, 0, 0);
          smoke.setColorAt(i, color);
        }
      }
      for (const visual of [fire, smoke]) if (visual) {
        visual.instanceMatrix.needsUpdate = true;
        if (visual.instanceColor) visual.instanceColor.needsUpdate = true;
      }
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
      if (record?.sprayVisual) {
        if (record.sprayVisual.parent) record.sprayVisual.parent.remove(record.sprayVisual);
        record.sprayVisual.geometry?.dispose?.();
        record.sprayVisual.material?.dispose?.();
      }
      if (record?.visual) {
        if (record.visual.parent) record.visual.parent.remove(record.visual);
        if (record.visual.traverse) {
          record.visual.traverse(node => {
            node.geometry?.dispose?.();
            if (node.material) for (const material of [].concat(node.material)) material?.dispose?.();
          });
        } else {
          record.visual.geometry?.dispose?.();
          record.visual.material?.dispose?.();
        }
      }
      if (record?.volumeTexture) {
        record.volumeTexture.dispose?.();
        record.volumeTexture = null;
      }
      if (record?.kind === 'volume') volumeLocks = Math.max(0, volumeLocks - 1);
      if (record?.savedMaterial) mesh.material = record.savedMaterial;
      if ((type === 'Cloth' || type === 'SoftBody') && mesh.userData?.savedSimBaseMaterial) {
        if (mesh.material && mesh.material !== mesh.userData.savedSimBaseMaterial) mesh.material.dispose?.();
        mesh.material = mesh.userData.savedSimBaseMaterial;
        delete mesh.userData.savedSimBaseMaterial;
      }
      this.effectors.delete(mesh.uuid);
      this.simMeshes.delete(mesh.uuid);
      this.updateStatusBadge();
      delete mesh.userData?.[key];
      if (type === 'Fluid') {
        delete mesh.userData?.fluidSim;
        delete mesh.userData?.simMesh;
        delete mesh.userData?.poolMesh;
      }
      if (type === 'Cloth' || type === 'SoftBody') {
        delete mesh.userData.origPositions;
        delete mesh.userData.prevPositions;
        delete mesh.userData.currPositions;
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
  try { loadVolumeLibrary(); } catch (_) {}

  /* ---- Baked detail-noise tile -----------------------------------------
     The core owns this pattern: fe_vol_noise_generate() fills a seamless RGBA
     tile (billows / wisps / slow mask) that the raymarcher scrolls three times
     over the domain. The JS mirror only runs when the wasm core is absent, so
     the shader never samples an empty texture. */
  let volumeNoiseCache = null;
  function volumeFallbackNoise(size) {
    const bytes = new Uint8Array(size * size * 4);
    const hash = (x, y, salt) => {
      let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
      h = (h ^ (h >>> 13)) * 1274126177;
      h ^= h >>> 16;
      return (h >>> 8) / 16777215;
    };
    const smooth = (t) => t * t * (3 - 2 * t);
    const octave = (u, v, freq, salt) => {
      const x = u * freq, y = v * freq;
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = smooth(x - ix), fy = smooth(y - iy);
      const wrap = (n) => ((n % freq) + freq) % freq;
      const a = hash(wrap(ix), wrap(iy), salt), b = hash(wrap(ix + 1), wrap(iy), salt);
      const c = hash(wrap(ix), wrap(iy + 1), salt), d = hash(wrap(ix + 1), wrap(iy + 1), salt);
      const top = a + (b - a) * fx, bottom = c + (d - c) * fx;
      return top + (bottom - top) * fy;
    };
    const fbm = (u, v, base, octaves, salt) => {
      let sum = 0, amp = 0.5, norm = 0, freq = base;
      for (let o = 0; o < octaves; o++) { sum += octave(u, v, freq, salt + o * 131) * amp; norm += amp; freq *= 2; amp *= 0.5; }
      return norm > 0 ? sum / norm : 0;
    };
    const toByte = (value) => Math.max(0, Math.min(255, Math.round(value * 255)));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size, v = (y + 0.5) / size, o = (y * size + x) * 4;
        bytes[o] = toByte(fbm(u, v, 4, 4, 20261023));
        bytes[o + 1] = toByte(fbm(u, v, 8, 5, 20360));
        bytes[o + 2] = toByte(fbm(u, v, 2, 2, 20450));
        bytes[o + 3] = 255;
      }
    }
    return bytes;
  }
  /* Volume Quality only moves the cell budget; the look itself stays editable
     through the individual knobs below. Mobile never exceeds 20³, Cinematic may
     reach 32³ on a desktop tier, and a 4-core machine keeps the 24³ ceiling. */
  function volumeTint(name) {
    const tints = {
      Natural: [1, 1, 1],
      Amber: [1.18, 0.82, 0.52],
      Blue: [0.55, 0.78, 1.3],
      Green: [0.62, 1.22, 0.72]
    };
    return new THREE.Vector3(...(tints[name] || tints.Natural));
  }
  function volumeGridCeiling(params, coarse, cores) {
    const quality = String(params['Volume Quality'] || 'Balanced');
    const base = coarse || cores <= 4 ? 24 : 28;
    if (quality === 'Mobile') return Math.min(base, 20);
    if (quality === 'Cinematic' && base > 20) return Math.min(32, base + 4);
    return base;
  }
  /* The baked library is optional: a missing file just keeps the live solver.
     It is fetched once, parsed with the pure volume-library.js reader. */
  let volumeLibraryPromise = null;
  function loadVolumeLibrary() {
    if (global.FEVolumeLibraryData) return Promise.resolve(global.FEVolumeLibraryData);
    if (volumeLibraryPromise) return volumeLibraryPromise;
    const lib = global.FEVolumeLibrary;
    if (!lib || typeof global.fetch !== 'function') return Promise.resolve(null);
    volumeLibraryPromise = global.fetch('./volume-library.bin')
      .then((response) => (response && response.ok !== false ? response.arrayBuffer() : null))
      .then((buffer) => (buffer ? lib.parse(buffer) : null))
      .then((data) => { if (data) global.FEVolumeLibraryData = data; return data; })
      .catch(() => null);
    return volumeLibraryPromise;
  }
  function volumeNoiseTexture() {
    if (volumeNoiseCache) return volumeNoiseCache;
    const size = 64;
    const engine = global.FECppEngine;
    const exports = engine && engine.ready !== false ? engine.exports : null;
    let bytes = null;
    if (exports && typeof exports.fe_vol_noise_generate === 'function' && typeof exports.fe_vol_noise_ptr === 'function') {
      if (exports.fe_vol_noise_generate(size, 20261023, 4) === 0 && exports.fe_vol_noise_size() === size) {
        bytes = new Uint8Array(exports.memory.buffer, exports.fe_vol_noise_ptr(), size * size * 4).slice();
      }
    }
    if (!bytes) bytes = volumeFallbackNoise(size);
    const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    volumeNoiseCache = texture;
    return texture;
  }

  global.SimulationEngine = UltraSimEngine;
  global.SimEngine = new UltraSimEngine();
})(window);
