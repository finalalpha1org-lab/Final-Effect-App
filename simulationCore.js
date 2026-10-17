/* ============================================================================
   ULTRA-PERFORMANCE THREE.SIMULATION & WEBGL SHADER ENGINE
   Optimized 60 FPS Continuous Glossy Liquids & Volumetric VFX
   ============================================================================ */

var UltraSimEngine = class UltraSimEngine {
  constructor() {
    this.simMeshes = new Map();
    this.clock = (typeof THREE !== 'undefined' && THREE.Clock) ? new THREE.Clock() : null;
    this.frameCount = 0;
  }

  getSimKey(type) {
    if (type === 'Cloth') return 'clothSim';
    if (type === 'SoftBody') return 'softBodySim';
    if (type === 'Fluid') return 'fluidSim';
    return 'physicsSim';
  }

  initSimulation(type, mesh, params = {}) {
    if (!mesh || !mesh.geometry) return;
    const eng = FE.engines?.core;
    if (!eng || !eng.sc) return;

    const simKey = this.getSimKey(type);
    mesh.userData[simKey] = {
      type,
      params,
      busy: false
    };

    if (type === 'Cloth' || type === 'SoftBody') {
      this.initClothSoftBody(mesh, type, params);
      return;
    }

    if (type === 'Fluid') {
      this.initFluidSimulation(mesh, params);
    }
  }

  initClothSoftBody(mesh, type, params) {
    const pos = mesh.geometry.attributes.position;
    if (!pos) return;
    mesh.userData.origPositions = pos.array.slice();
    mesh.userData.prevPositions = pos.array.slice();
    mesh.userData.currPositions = pos.array.slice();
  }

  initFluidSimulation(mesh, params) {
    const eng = FE.engines?.core;
    if (!eng || !eng.sc) return;

    this.removeSimulation('Fluid', mesh);

    const role = params["Type"] || "Domain";
    const domainType = params["Domain Type"] || params["Flow Type"] || "Liquid";
    const liquidPreset = params["Liquid Preset"] || "Water";
    const firePreset = params["Fire Preset"] || "Campfire";
    const smokePreset = params["Smoke Preset"] || "Normal Smoke";

    if (role === 'Domain') {
      if (!mesh.userData.savedDomainMaterial) {
        mesh.userData.savedDomainMaterial = mesh.material;
      }
      mesh.material = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        wireframe: true,
        transparent: true,
        opacity: 0.20
      });
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 })
      );
      mesh.add(edges);
      mesh.userData.domainEdges = edges;
    }

    const box = new THREE.Box3().setFromObject(mesh);
    const sizeX = Math.max(0.8, box.max.x - box.min.x);
    const sizeY = Math.max(0.8, box.max.y - box.min.y);
    const sizeZ = Math.max(0.8, box.max.z - box.min.z);
    const centerX = (box.min.x + box.max.x) * 0.5;
    const centerY = (box.min.y + box.max.y) * 0.5;
    const centerZ = (box.min.z + box.max.z) * 0.5;

    let simMesh = null;
    let poolMesh = null;

    if (domainType === 'Liquid') {
      const radiusTop = sizeX * 0.28;
      const radiusBottom = sizeX * 0.38;
      const height = sizeY * 0.85;

      const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 24, 24, true);
      geometry.userData.basePositions = geometry.attributes.position.array.slice();

      let liquidColor = 0x0ea5e9;
      let deepColor = 0x0369a1;
      let roughness = 0.04;
      let metalness = 0.10;
      let transmission = 0.90;
      let thickness = 1.2;
      let ior = 1.333;

      if (liquidPreset === 'Honey') {
        liquidColor = 0xffaa00;
        deepColor = 0xb45309;
        roughness = 0.12;
        metalness = 0.05;
        transmission = 0.82;
        thickness = 2.4;
        ior = 1.50;
      } else if (liquidPreset === 'Oil') {
        liquidColor = 0xd97706;
        deepColor = 0x78350f;
        roughness = 0.08;
        metalness = 0.20;
        transmission = 0.75;
        thickness = 1.8;
        ior = 1.48;
      } else if (liquidPreset === 'Slime') {
        liquidColor = 0x10b981;
        deepColor = 0x064e3b;
        roughness = 0.18;
        metalness = 0.02;
        transmission = 0.70;
        thickness = 1.6;
        ior = 1.38;
      }

      const material = new THREE.MeshPhysicalMaterial({
        color: liquidColor,
        emissive: deepColor,
        emissiveIntensity: 0.15,
        metalness: metalness,
        roughness: roughness,
        transmission: transmission,
        thickness: thickness,
        ior: ior,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false
      });

      simMesh = new THREE.Mesh(geometry, material);
      simMesh.position.set(centerX, centerY, centerZ);
      eng.sc.add(simMesh);

      const poolGeo = new THREE.PlaneGeometry(sizeX * 0.96, sizeZ * 0.96, 20, 20);
      poolGeo.rotateX(-Math.PI / 2);
      poolGeo.userData.basePositions = poolGeo.attributes.position.array.slice();

      const poolMat = new THREE.MeshPhysicalMaterial({
        color: liquidColor,
        emissive: deepColor,
        emissiveIntensity: 0.10,
        metalness: metalness,
        roughness: roughness,
        transmission: transmission,
        thickness: thickness,
        ior: ior,
        transparent: true,
        opacity: 0.90,
        side: THREE.DoubleSide,
        depthWrite: false
      });

      poolMesh = new THREE.Mesh(poolGeo, poolMat);
      poolMesh.position.set(centerX, box.min.y + 0.04, centerZ);
      eng.sc.add(poolMesh);

    } else if (domainType === 'Fire' || domainType === 'Smoke' || domainType === 'Fire + Smoke') {
      const isFire = (domainType === 'Fire' || domainType === 'Fire + Smoke');
      const height = sizeY * 0.90;
      const radius = sizeX * 0.45;

      const geometry = new THREE.ConeGeometry(radius, height, 24, 24, true);
      geometry.userData.basePositions = geometry.attributes.position.array.slice();

      let baseColor = new THREE.Color(0xff4500);
      let emissiveColor = new THREE.Color(0xff8800);
      let opacity = 0.85;
      let blending = THREE.AdditiveBlending;

      if (firePreset === 'Gas Flame') {
        baseColor = new THREE.Color(0x00aaff);
        emissiveColor = new THREE.Color(0x00eeff);
      } else if (firePreset === 'Wildfire') {
        baseColor = new THREE.Color(0xff2200);
        emissiveColor = new THREE.Color(0xffaa00);
        opacity = 0.92;
      }

      if (domainType === 'Smoke') {
        baseColor = new THREE.Color(0x888888);
        emissiveColor = new THREE.Color(0x333333);
        opacity = 0.50;
        blending = THREE.NormalBlending;
        if (smokePreset === 'Heavy Fog') {
          baseColor = new THREE.Color(0xdddddd);
          opacity = 0.65;
        } else if (smokePreset === 'Dark Soot') {
          baseColor = new THREE.Color(0x222222);
          opacity = 0.80;
        }
      }

      const material = new THREE.MeshStandardMaterial({
        color: baseColor,
        emissive: emissiveColor,
        emissiveIntensity: isFire ? 0.8 : 0.0,
        roughness: 0.7,
        metalness: 0.1,
        transparent: true,
        opacity: opacity,
        blending: blending,
        side: THREE.DoubleSide,
        depthWrite: false
      });

      simMesh = new THREE.Mesh(geometry, material);
      simMesh.position.set(centerX, centerY - 0.05, centerZ);
      eng.sc.add(simMesh);
    }

    mesh.userData.simMesh = simMesh;
    mesh.userData.poolMesh = poolMesh;
    mesh.userData.fluidSim = { type: 'Fluid', params, simMesh, poolMesh };
    this.simMeshes.set(mesh.uuid, { mesh, simMesh, poolMesh, params });
  }

  stepSimulation(type, mesh, dt = 1/60) {
    if (!mesh) return;

    if (type === 'Cloth' || type === 'SoftBody') {
      this.stepClothSoftBody(mesh, type, dt);
      return;
    }

    if (type === 'Fluid') {
      this.stepFluidSimulation(mesh, dt);
    }
  }

  stepClothSoftBody(mesh, type, dt) {
    const pos = mesh.geometry.attributes.position;
    if (!pos || !mesh.userData.currPositions) return;

    const curr = mesh.userData.currPositions;
    const prev = mesh.userData.prevPositions;
    const orig = mesh.userData.origPositions;
    const time = performance.now() * 0.001;

    for (let i = 0; i < curr.length; i += 3) {
      const vx = (curr[i] - prev[i]) * 0.98;
      const vy = (curr[i+1] - prev[i+1]) * 0.98;
      const vz = (curr[i+2] - prev[i+2]) * 0.98;

      prev[i] = curr[i];
      prev[i+1] = curr[i+1];
      prev[i+2] = curr[i+2];

      const wind = Math.sin(time * 2.5 + curr[i] * 0.5) * 0.003;
      curr[i] += vx + wind;
      curr[i+1] += vy - 9.8 * dt * dt * 0.5;
      curr[i+2] += vz;

      if (type === 'SoftBody') {
        curr[i] += (orig[i] - curr[i]) * 0.1;
        curr[i+1] += (orig[i+1] - curr[i+1]) * 0.1;
        curr[i+2] += (orig[i+2] - curr[i+2]) * 0.1;
      }

      if (curr[i+1] < 0) {
        curr[i+1] = 0;
        prev[i+1] = 0;
      }
    }

    pos.array.set(curr);
    pos.needsUpdate = true;
    if (this.frameCount % 2 === 0) mesh.geometry.computeVertexNormals();
  }

  stepFluidSimulation(mesh, dt) {
    const simMesh = mesh.userData.simMesh;
    const poolMesh = mesh.userData.poolMesh;
    if (!simMesh) return;

    this.frameCount++;
    const elapsedTime = performance.now() * 0.001;
    const params = mesh.userData.fluidSim?.params || {};
    const flowSpeed = parseFloat(params["Flow Speed"] || 3.5);
    const turbulence = parseFloat(params["Turbulence"] !== undefined ? params["Turbulence"] : 0.35);

    const pos = simMesh.geometry.attributes.position;
    const base = simMesh.geometry.userData.basePositions;
    if (!pos || !base) return;

    const isLiquid = (simMesh.geometry.type === 'CylinderGeometry');

    for (let i = 0; i < pos.count; i++) {
      const idx = i * 3;
      const bx = base[idx];
      const by = base[idx + 1];
      const bz = base[idx + 2];

      if (isLiquid) {
        const wave = Math.sin(elapsedTime * flowSpeed + by * 6.0) * (0.02 + turbulence * 0.04);
        const swirl = Math.cos(elapsedTime * (flowSpeed * 0.8) + by * 4.0) * (0.02 + turbulence * 0.04);
        pos.setX(i, bx * (1.0 + wave));
        pos.setZ(i, bz * (1.0 + swirl));
      } else {
        const turbX = Math.cos(elapsedTime * (flowSpeed * 1.2) + by * 4.0) * (0.04 + turbulence * 0.08);
        const turbZ = Math.sin(elapsedTime * (flowSpeed * 1.2) + by * 4.0) * (0.04 + turbulence * 0.08);
        const taper = Math.max(0.2, (by + 1.0) * 0.5);
        pos.setX(i, (bx + turbX) * taper);
        pos.setZ(i, (bz + turbZ) * taper);
      }
    }
    pos.needsUpdate = true;

    if (poolMesh) {
      const pPos = poolMesh.geometry.attributes.position;
      const pBase = poolMesh.geometry.userData.basePositions;
      if (pPos && pBase) {
        for (let i = 0; i < pPos.count; i++) {
          const idx = i * 3;
          const px = pBase[idx];
          const pz = pBase[idx + 2];
          const ripple = Math.sin(px * 8.0 + elapsedTime * 4.0) * Math.cos(pz * 8.0 + elapsedTime * 3.5) * 0.035;
          pPos.setY(i, ripple);
        }
        pPos.needsUpdate = true;
      }
    }
  }

  resetSimulation(type, mesh) {
    if (!mesh) return;
    const params = mesh.userData.fluidSim?.params || mesh.userData.clothSim?.params || mesh.userData.softBodySim?.params || {};
    this.initSimulation(type, mesh, params);
  }

  removeSimulation(type, mesh) {
    if (!mesh) return;
    const simKey = this.getSimKey(type);
    delete mesh.userData[simKey];

    if (mesh.userData.domainEdges) {
      mesh.remove(mesh.userData.domainEdges);
      mesh.userData.domainEdges.geometry.dispose();
      mesh.userData.domainEdges.material.dispose();
      delete mesh.userData.domainEdges;
    }

    if (mesh.userData.simMesh) {
      const s = mesh.userData.simMesh;
      if (s.parent) s.parent.remove(s);
      s.geometry.dispose();
      if (s.material) s.material.dispose();
      delete mesh.userData.simMesh;
    }

    if (mesh.userData.poolMesh) {
      const p = mesh.userData.poolMesh;
      if (p.parent) p.parent.remove(p);
      p.geometry.dispose();
      if (p.material) p.material.dispose();
      delete mesh.userData.poolMesh;
    }

    if (mesh.userData.savedDomainMaterial) {
      mesh.material = mesh.userData.savedDomainMaterial;
      delete mesh.userData.savedDomainMaterial;
    }

    this.simMeshes.delete(mesh.uuid);
  }
}

var SimulationEngine = UltraSimEngine;
window.SimulationEngine = UltraSimEngine;
try {
  window.SimEngine = new UltraSimEngine();
} catch (e) {
  console.warn("UltraSimEngine instantiation deferred:", e);
}
