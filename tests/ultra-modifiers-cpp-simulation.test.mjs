import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { appPath } from './app-paths.mjs';
import {
  arrayGeometry,
  bevelGeometry,
  bindSurfaceDeform,
  booleanGeometry,
  castGeometry,
  createLatticeCageGeometry,
  decimateGeometry,
  displaceGeometry,
  armatureSkinGeometry,
  latticeDeformGeometry,
  mirrorGeometry,
  shrinkwrapGeometry,
  smoothGeometry,
  solidifyGeometry,
  subdivideLoop,
  surfaceDeformGeometry,
  triangulateGeometry,
  twistGeometry,
  waveGeometry,
  weightedNormalGeometry,
  weldGeometry,
  wireframeGeometry3D,
} from '../src/modifier-entry.mjs';

function auditTopology(geometry) {
  const pos = geometry?.attributes?.position;
  if (!pos) return { finite: false, triangles: 0 };
  for (let i = 0; i < pos.count; i++) {
    if (!Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))) return { finite: false, triangles: 0 };
  }
  const triangles = geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(pos.count / 3);
  return { finite: true, triangles };
}

test('all 20 procedural geometry & deform modifiers execute cleanly without NaNs or silent regressions', () => {
  /* 1. High-poly Decimate (up to 65k triangles, Garland-Heckbert QEM) */
  const hiSphere = new THREE.SphereGeometry(1, 48, 36); // 3,360 triangles (previously threw > 1200)
  const decimated = decimateGeometry(hiSphere, 0.35);
  assert.ok(auditTopology(decimated).finite);
  assert.ok(auditTopology(decimated).triangles < auditTopology(hiSphere).triangles * 0.65);

  /* 2. Concave Bevel (Torus / CSG mesh) */
  const torus = new THREE.TorusGeometry(1.0, 0.35, 12, 18);
  const beveledTorus = bevelGeometry(torus, { width: 0.12, segments: 2, clampOverlap: true });
  assert.ok(auditTopology(beveledTorus).finite);
  assert.ok(auditTopology(beveledTorus).triangles > auditTopology(torus).triangles);

  /* 3. Triangulate Keep Normals vs flat face normals */
  const smoothSphere = new THREE.SphereGeometry(1, 12, 8);
  const triSmooth = triangulateGeometry(smoothSphere, { keepNormals: true });
  const triFlat = triangulateGeometry(smoothSphere, { keepNormals: false });
  assert.equal(triSmooth.index, null);
  assert.equal(triFlat.index, null);
  let diffNormals = 0;
  for (let i = 0; i < triSmooth.attributes.normal.array.length; i++) {
    diffNormals += Math.abs(triSmooth.attributes.normal.array[i] - triFlat.attributes.normal.array[i]);
  }
  assert.ok(diffNormals > 0.5, 'Keep Normals preserves smooth normals vs flat face normals');

  /* 4. 3D Wireframe tube & hub mesh (with and without Replace Original) */
  const box = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const wireOnly = wireframeGeometry3D(box, { thickness: 0.05, replaceOriginal: true });
  const wireCombined = wireframeGeometry3D(box, { thickness: 0.05, replaceOriginal: false });
  assert.ok(auditTopology(wireOnly).finite);
  assert.ok(auditTopology(wireOnly).triangles >= 48);
  assert.equal(auditTopology(wireCombined).triangles, auditTopology(wireOnly).triangles + auditTopology(box).triangles);

  /* 5. Shrinkwrap spatial-hash broadphase & Above Surface mode */
  const clothSheet = new THREE.PlaneGeometry(1.5, 1.5, 16, 16);
  clothSheet.rotateX(-Math.PI / 2);
  clothSheet.translate(0, 1.8, 0);
  const targetSphere = new THREE.SphereGeometry(1.0, 32, 24);
  const identity = new THREE.Matrix4().elements;
  const wrappedAbove = shrinkwrapGeometry(clothSheet, targetSphere, identity, 0.08, 'Above Surface');
  assert.ok(auditTopology(wrappedAbove).finite);
  for (let i = 0; i < wrappedAbove.attributes.position.count; i++) {
    const r = Math.hypot(
      wrappedAbove.attributes.position.getX(i),
      wrappedAbove.attributes.position.getY(i),
      wrappedAbove.attributes.position.getZ(i)
    );
    assert.ok(r >= 1.04, `Above Surface keeps vertices outside sphere radius (got ${r})`);
  }

  /* 6. 3D Bernstein FFD Lattice Cage creation & deformation */
  const cyl = new THREE.CylinderGeometry(0.6, 0.6, 2.0, 16, 8);
  const cage = createLatticeCageGeometry(cyl, [2, 2, 2], 0.05);
  const cagePos = cage.attributes.position;
  for (let i = 0; i < cagePos.count; i++) {
    if (cagePos.getY(i) > 0.4) {
      cagePos.setXYZ(i, cagePos.getX(i) * 1.65, cagePos.getY(i), cagePos.getZ(i) * 1.65);
    }
  }
  const ffd = latticeDeformGeometry(
    cyl,
    cage.userData.restPositions,
    cagePos.array,
    cage.userData.divisions,
    identity,
    1.0
  );
  assert.ok(auditTopology(ffd).finite);
  ffd.computeBoundingBox();
  cyl.computeBoundingBox();
  assert.ok(ffd.boundingBox.max.x > cyl.boundingBox.max.x * 1.25, 'Lattice FFD widens top of cylinder');

  /* 7. Dual-Quaternion & LBS Armature Bone Skinning */
  const armMesh = new THREE.CylinderGeometry(0.35, 0.35, 2.4, 16, 16);
  const skinnedDqs = armatureSkinGeometry(armMesh, {
    influence: 1.0,
    preserveVolume: true,
    bendDeg: 45,
    twistDeg: 25,
  });
  assert.ok(auditTopology(skinnedDqs).finite);
  skinnedDqs.computeBoundingBox();
  assert.ok(Math.abs(skinnedDqs.boundingBox.min.x) > 0.45 || Math.abs(skinnedDqs.boundingBox.max.x) > 0.45);

  /* 8. Surface Deform bind + live tracking */
  const badge = new THREE.BoxGeometry(0.5, 0.1, 0.5, 4, 2, 4);
  badge.translate(0, 0.08, 0);
  const driverPlane = new THREE.PlaneGeometry(2, 2, 8, 8);
  driverPlane.rotateX(-Math.PI / 2);
  const binding = bindSurfaceDeform(badge, driverPlane, identity);
  /* Lift driver plane upward by +0.75 */
  const driverMoved = driverPlane.clone();
  driverMoved.translate(0, 0.75, 0);
  const deformedBadge = surfaceDeformGeometry(badge, binding, driverMoved, identity, 1.0);
  assert.ok(auditTopology(deformedBadge).finite);
  deformedBadge.computeBoundingBox();
  assert.ok(deformedBadge.boundingBox.min.y > 0.65, 'Surface Deform tracks deformed driver surface');

  /* 9. Remaining stack modifiers sanity check */
  assert.ok(auditTopology(arrayGeometry(box, { count: 3, offset: [2, 0, 0] })).finite);
  assert.ok(auditTopology(mirrorGeometry(box, { axes: [true, false, false], clipping: true })).finite);
  assert.ok(auditTopology(solidifyGeometry(new THREE.PlaneGeometry(1, 1), 0.12, -1)).finite);
  assert.ok(auditTopology(subdivideLoop(box, 2)).finite);
  assert.ok(auditTopology(weldGeometry(triFlat, 0.01)).finite);
  assert.ok(auditTopology(castGeometry(box, { shape: 'Sphere', factor: 0.8, radius: 1.0 })).finite);
  assert.ok(auditTopology(displaceGeometry(box, { strength: 0.25, midlevel: 0.5, frequency: 2 })).finite);
  assert.ok(auditTopology(smoothGeometry(subdivideLoop(box, 1), { factor: 0.5, iterations: 2 })).finite);
  assert.ok(auditTopology(twistGeometry(box, 1.1)).finite);
  assert.ok(auditTopology(waveGeometry(clothSheet, { speed: 1.5, height: 0.3, width: 2.0, time: 0.6 })).finite);
  assert.ok(auditTopology(weightedNormalGeometry(box, { weight: 60, keepSharp: true })).finite);
  const cutter = new THREE.BoxGeometry(1, 1, 1);
  const offsetMat = new THREE.Matrix4().makeTranslation(0.45, 0.45, 0.45).elements;
  assert.ok(auditTopology(booleanGeometry(box, cutter, offsetMat, 'Difference')).finite);
});

test('SimulationEngine loads freestanding C++20 fe_core_engine.wasm and steps Cloth, SoftBody, Liquid PBF-FLIP, and Smoke/Fire+Smoke cleanly', async () => {
  const code = readFileSync(appPath('simulationCore.js'), 'utf8');
  const wasmBytes = readFileSync(appPath('wasm/fe_core_engine.wasm'));
  const wasmB64 = wasmBytes.toString('base64');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 3, 6);
  const badge = { textContent: '' };

  const makeMockCanvas = () => ({
    width: 256,
    height: 256,
    getContext() {
      return {
        clearRect() {},
        save() {},
        restore() {},
        beginPath() {},
        moveTo() {},
        bezierCurveTo() {},
        closePath() {},
        clip() {},
        fillRect() {},
        arc() {},
        fill() {},
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
      };
    },
  });

  const windowObj = {
    THREE,
    WebAssembly,
    __FE_CPP_WASM_BASE64__: wasmB64,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    FE: {
      engines: { core: { sc: scene, viewportCamera: camera, getActiveCamera: () => camera, getShadingMode: () => 'solid' } },
      toast() {},
    },
    document: {
      baseURI: 'http://localhost:3000/',
      addEventListener() {},
      getElementById: (id) => (id === 'tb-status-badge' ? badge : null),
      createElement: (tag) => (tag === 'canvas' ? makeMockCanvas() : {}),
    },
  };
  windowObj.window = windowObj;
  vm.runInNewContext(code, windowObj);

  const engine = windowObj.SimEngine;
  const ok = await engine.ready;
  assert.equal(ok, true);
  assert.equal(engine.isCppBackend, true, 'SimulationEngine must detect C++20 backend magic 0x43505033');
  assert.equal(badge.textContent, '', 'the engine writes no text into viewport chrome; readiness pills are gone');
  assert.match(engine.getSolverDiagnostics().backendLabel, /C\+\+20\/WASM/, 'solver backend details stay available for diagnostics');

  /* 1. Cloth with C++20 XPBD + aerodynamic curl wind + zero-copy normal/strain scatter */
  const clothGeo = new THREE.PlaneGeometry(2, 2, 16, 16);
  const clothMesh = new THREE.Mesh(clothGeo, new THREE.MeshStandardMaterial());
  clothMesh.position.set(0, 2.2, 0);
  scene.add(clothMesh);
  engine.initSimulation('Cloth', clothMesh, {
    'Fabric Preset': 'Silk Satin',
    'Quality': 8,
    'Wind Speed': 4.5,
    'Wind Turbulence': 0.5,
    'Self Collision': true,
    'Pinning Mode': 'Auto Top Edge',
  });
  await engine.ready;
  for (let f = 0; f < 10; f++) engine.stepSimulation('Cloth', clothMesh, 1 / 60);
  assert.equal(clothMesh.userData.clothSim.status, 'running');
  assert.ok(clothMesh.geometry.attributes.aStrain, 'C++20 cloth populates per-vertex wrinkle strain attribute');
  assert.equal(clothMesh.material.userData.ultraSimShader, 'cloth-vellum');

  /* 2. SoftBody with C++20 Tetrahedral Volume Conservation + SSS Jelly Shader */
  const sbGeo = new THREE.SphereGeometry(0.8, 14, 10);
  const sbMesh = new THREE.Mesh(sbGeo, new THREE.MeshStandardMaterial());
  sbMesh.position.set(2.5, 1.4, 0);
  scene.add(sbMesh);
  engine.initSimulation('SoftBody', sbMesh, {
    'Soft Body Preset': 'Translucent Jelly',
    'Volume Preservation': 0.92,
    'Stiffness': 0.55,
    'Goal Strength': 0.25,
  });
  await engine.ready;
  for (let f = 0; f < 10; f++) engine.stepSimulation('SoftBody', sbMesh, 1 / 60);
  assert.equal(sbMesh.userData.softBodySim.status, 'running');
  assert.equal(sbMesh.material.userData.ultraSimShader, 'softbody-sss');

  /* 3. Liquid Domain with C++20 Spatial-Hash PBF/FLIP + Crack-Free Taubin SDF Surface + Whitewater Spray */
  const domainMesh = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.4), new THREE.MeshStandardMaterial());
  domainMesh.name = 'Cube';
  domainMesh.position.set(-2.5, 1.2, 0);
  scene.add(domainMesh);
  engine.initSimulation('Fluid', domainMesh, {
    Type: 'Domain',
    'Domain Type': 'Liquid',
    'Liquid Preset': 'Water',
    Resolution: 80,
    'Surface Resolution': 48,
    'Vorticity Confinement': 0.22,
  });
  await engine.ready;
  for (let f = 0; f < 6; f++) engine.stepSimulation('Fluid', domainMesh, 1 / 60);
  const fluidRec = domainMesh.userData.fluidSim;
  assert.equal(fluidRec.status, 'running');
  assert.equal(fluidRec.surfaceReady, true, 'C++20 smooth liquid surface mesh reconstructed');
  assert.ok(fluidRec.visual.geometry.drawRange.count >= 36, 'Persistent DynamicDrawUsage liquid mesh has active triangles');
  assert.equal(fluidRec.visual.material.userData.ultraSimShader, 'liquid-pbr');
  assert.ok(fluidRec.sprayVisual?.isInstancedMesh, 'Whitewater spray InstancedMesh active');

  /* 4. Smoke & Fire+Smoke Pyro (verifies C++20 curl-noise pyro + fixed cl() clamp bug) */
  const pyroMesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.0, 2.0), new THREE.MeshStandardMaterial());
  pyroMesh.name = 'Cube_Pyro';
  pyroMesh.position.set(0, 1.5, -3);
  scene.add(pyroMesh);
  engine.initSimulation('Fluid', pyroMesh, {
    Type: 'Domain',
    'Domain Type': 'Fire + Smoke',
    'Fire & Smoke Preset': 'Campfire & Smoke',
    'Flow Rate': 45,
  });
  await engine.ready;
  for (let f = 0; f < 6; f++) engine.stepSimulation('Fluid', pyroMesh, 1 / 60);
  assert.equal(pyroMesh.userData.fluidSim.status, 'running');
  assert.ok(pyroMesh.userData.fluidSim.fireVisual && pyroMesh.userData.fluidSim.smokeVisual);
});
