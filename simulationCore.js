/* ============================================================================
   ULTRA-REALISTIC THREE.JS SIMULATION & WEBGL SHADER ENGINE
   Complete Simulation Engine, Render Loop Hook, and UI Bindings
   ============================================================================ */

// 1. Ultra-Realistic Simulation Engine Class
class UltraSimEngine {
  constructor(scene = null, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.simMesh = null;
    this.simType = 'none';
    this.subType = 'water';
    this.clock = new THREE.Clock();
    this.simMeshes = new Map();
  }

  getScene() {
    if (this.scene) return this.scene;
    if (typeof FE !== 'undefined' && FE.engines?.core?.sc) {
      this.scene = FE.engines.core.sc;
    }
    return this.scene;
  }

  getRenderer() {
    if (this.renderer) return this.renderer;
    if (typeof FE !== 'undefined' && FE.engines?.core?.r) {
      this.renderer = FE.engines.core.r;
    }
    return this.renderer;
  }

  getSimKey(type) {
    if (type === 'Cloth') return 'clothSim';
    if (type === 'SoftBody') return 'softBodySim';
    if (type === 'Fluid' || type === 'liquid' || type === 'fire' || type === 'smoke') return 'fluidSim';
    return 'physicsSim';
  }

  initSimulation(type, subTypeOrMesh, maybeParams) {
    const sc = this.getScene();
    if (!sc) return;

    // Direct string invocation: initSimulation('liquid', 'honey')
    if (typeof type === 'string' && (typeof subTypeOrMesh === 'string' || !subTypeOrMesh || typeof subTypeOrMesh !== 'object' || !subTypeOrMesh.isObject3D)) {
      const subType = typeof subTypeOrMesh === 'string' ? subTypeOrMesh.toLowerCase() : 'water';
      const simType = type.toLowerCase();

      if (this.simMesh) {
        sc.remove(this.simMesh);
        if (this.simMesh.geometry) this.simMesh.geometry.dispose();
        if (this.simMesh.material) this.simMesh.material.dispose();
        this.simMesh = null;
      }

      this.simType = simType;
      this.subType = subType;
      const height = 1.8;

      if (simType === 'liquid' || simType === 'fluid') {
        // Continuous Glossy Liquid Volume (Water / Honey style)
        const geometry = new THREE.CylinderGeometry(0.6, 0.5, height, 32, 32, true);
        const color = (subType === 'honey' ? 0xffaa00 : (subType === 'oil' ? 0xd97706 : (subType === 'slime' ? 0x10b981 : 0x0088ff)));

        const material = new THREE.MeshPhysicalMaterial({
          color: color,
          metalness: 0.1,
          roughness: 0.1,
          transmission: 0.9,
          thickness: 1.2,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide
        });

        this.simMesh = new THREE.Mesh(geometry, material);
        this.simMesh.name = 'UltraSim_LiquidMesh';
        this.simMesh.position.set(0, 0.9, 0);
        sc.add(this.simMesh);

      } else if (simType === 'fire' || simType === 'smoke' || simType === 'fire-smoke' || simType === 'fire + smoke') {
        const geometry = new THREE.ConeGeometry(0.7, height, 32, 32, true);
        const isFire = (simType === 'fire' || simType === 'fire-smoke' || simType === 'fire + smoke');
        const baseColor = isFire ? (subType === 'gas flame' ? new THREE.Color(0x00aaff) : new THREE.Color(0xff4500)) : new THREE.Color(0x777777);

        const material = new THREE.MeshStandardMaterial({
          color: baseColor,
          roughness: 0.8,
          metalness: 0.1,
          transparent: true,
          opacity: isFire ? 0.85 : 0.45,
          blending: isFire ? THREE.AdditiveBlending : THREE.NormalBlending,
          side: THREE.DoubleSide
        });

        this.simMesh = new THREE.Mesh(geometry, material);
        this.simMesh.name = 'UltraSim_VFXMesh';
        this.simMesh.position.set(0, 0.9, 0);
        sc.add(this.simMesh);
      }

      return;
    }

    // Mesh-based invocation from Modifiers Stack: initSimulation('Fluid', mesh, params)
    const mesh = subTypeOrMesh;
    const params = maybeParams || {};
    if (!mesh || !mesh.geometry) return;

    const simKey = this.getSimKey(type);
    mesh.userData[simKey] = { type, params, busy: false };

    if (type === 'Cloth' || type === 'SoftBody') {
      const pos = mesh.geometry.attributes.position;
      if (pos) {
        mesh.userData.origPositions = pos.array.slice();
        mesh.userData.prevPositions = pos.array.slice();
        mesh.userData.currPositions = pos.array.slice();
      }
      return;
    }

    if (type === 'Fluid') {
      const domainType = (params["Domain Type"] || params["Flow Type"] || "Liquid").toLowerCase();
      const liquidPreset = (params["Liquid Preset"] || "Water").toLowerCase();
      const firePreset = (params["Fire Preset"] || "Campfire").toLowerCase();

      let targetType = 'liquid';
      let targetSub = liquidPreset;

      if (domainType.includes('fire')) {
        targetType = 'fire';
        targetSub = firePreset;
      } else if (domainType.includes('smoke')) {
        targetType = 'smoke';
        targetSub = 'smoke';
      }

      this.initSimulation(targetType, targetSub);

      if (this.simMesh && mesh.position) {
        this.simMesh.position.copy(mesh.position);
      }
    }
  }

  update() {
    if (!this.simMesh || !this.simMesh.geometry) return;
    const elapsedTime = this.clock.getElapsedTime();
    const positions = this.simMesh.geometry.attributes.position;
    if (!positions) return;

    for (let i = 0; i < positions.count; i++) {
      const vx = positions.getX(i);
      const vy = positions.getY(i);
      const vz = positions.getZ(i);

      if (this.simMesh.geometry.type === 'CylinderGeometry') {
        positions.setX(i, vx + Math.sin(elapsedTime * 3 + vy * 5) * 0.005);
      } else {
        positions.setX(i, vx + Math.cos(elapsedTime * 4 + vy * 3) * 0.008);
        positions.setZ(i, vz + Math.sin(elapsedTime * 4 + vy * 3) * 0.008);
      }
    }
    positions.needsUpdate = true;
  }

  stepSimulation(type, mesh, dt = 1/60) {
    this.update();

    if (mesh && (type === 'Cloth' || type === 'SoftBody')) {
      const pos = mesh.geometry?.attributes.position;
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
      mesh.geometry.computeVertexNormals();
    }
  }

  resetSimulation(type, mesh) {
    if (this.simType !== 'none') {
      this.initSimulation(this.simType, this.subType);
    }
  }

  removeSimulation(type, mesh) {
    const sc = this.getScene();
    if (this.simMesh && sc) {
      sc.remove(this.simMesh);
      if (this.simMesh.geometry) this.simMesh.geometry.dispose();
      if (this.simMesh.material) this.simMesh.material.dispose();
      this.simMesh = null;
    }
    if (mesh && mesh.userData) {
      const simKey = this.getSimKey(type);
      delete mesh.userData[simKey];
    }
  }
}

// 2. Global Initialization & Main Render Loop Hook
const simEngine = new UltraSimEngine();
window.UltraSimEngine = UltraSimEngine;
window.SimulationEngine = UltraSimEngine;
window.SimEngine = simEngine;
window.simEngine = simEngine;

// Hook into Main Animation Loop
function animateSimulationLoop() {
  requestAnimationFrame(animateSimulationLoop);
  if (window.simEngine) {
    window.simEngine.update();
  }
}
animateSimulationLoop();

// 3. UI Event Bindings (Connects UI Preset Clicks to the Engine)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sim-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const type = e.target.dataset.simType || 'liquid';
      const subType = e.target.dataset.subType || 'water';
      if (window.simEngine) {
        window.simEngine.initSimulation(type, subType);
      }
    });
  });
});

// Dynamic event delegation for runtime-created buttons
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.sim-preset-btn');
  if (btn) {
    const type = btn.dataset.simType || 'liquid';
    const subType = btn.dataset.subType || 'water';
    if (window.simEngine) {
      window.simEngine.initSimulation(type, subType);
    }
  }
});
