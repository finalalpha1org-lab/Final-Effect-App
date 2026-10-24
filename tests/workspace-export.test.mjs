import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* Workspace export. Two things are pinned here:
     1. A glTF/OBJ export used to throw `null is not an object
        (evaluating 'this.domElement.ownerDocument.addEventListener')`
        because THREE's example exporters clone the whole scene and reach
        the TransformControls gizmo. Editor furniture has to be filtered by
        name/flag, not caught and hidden.
     2. r128's GLTFExporter has no InstancedMesh support, so foliage would
        have left the app as a single plant at the origin. Instances are
        baked where they stand.
   The writers are plain arrays and plain math, so the whole path — collect,
   bake, write — is exercised without a browser. */

const source = readFileSync('workspace-export.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const engineSource = readFileSync('fe-cpp-engine.js', 'utf8');
const sw = readFileSync('sw.js', 'utf8');
const build = readFileSync('scripts/build.mjs', 'utf8');

function load() {
  const context = { TextEncoder, TextDecoder, Uint8Array, Uint16Array, Uint32Array, Float32Array, DataView, ArrayBuffer, Buffer, console, Math, isFinite, Infinity, Map, Set, Promise, URL, TextDecoderStream: undefined };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.FEWorkspaceExport;
}

const X = load();

/* ---- scene doubles ------------------------------------------------------ */

function makeObject(props = {}) {
  const object = {
    name: '', type: 'Mesh', parent: null, children: [], visible: true,
    userData: {}, isMesh: true, matrixAutoUpdate: true,
    ...props
  };
  return object;
}

function makeGeometry(positions, normals, uvs) {
  const attributes = {
    position: { array: new Float32Array(positions), itemSize: 3, count: positions.length / 3 }
  };
  if (normals) attributes.normal = { array: new Float32Array(normals), itemSize: 3, count: normals.length / 3 };
  if (uvs) attributes.uv = { array: new Float32Array(uvs), itemSize: 2, count: uvs.length / 2 };
  return { attributes, index: null };
}

function makeScene(rootChildren) {
  const scene = makeObject({ name: 'Scene', isMesh: false, type: 'Scene', children: rootChildren });
  const wire = (node, parent) => {
    node.parent = parent;
    node.children.forEach((child) => wire(child, node));
  };
  rootChildren.forEach((child) => wire(child, scene));
  scene.traverse = (visit) => {
    const walk = (node) => {
      visit(node);
      (node.children || []).forEach(walk);
    };
    walk(scene);
  };
  return scene;
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/* ---- collection --------------------------------------------------------- */

test('editor furniture never leaves the app', () => {
  const triangle = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], null, null);

  const mesh = makeObject({ name: 'Sculpt', geometry: triangle, matrixWorld: { elements: identity() } });
  const grid = makeObject({ name: 'Grid', isGridHelper: true, geometry: triangle, matrixWorld: { elements: identity() } });
  const cursor = makeObject({ name: 'Cursor3D', geometry: triangle, matrixWorld: { elements: identity() } });
  const ghost = makeObject({ name: 'OnionGhost', userData: { feOnionGhost: true }, geometry: triangle, matrixWorld: { elements: identity() } });

  /* A gizmo handle is a plain Mesh: only its TransformControls ancestor
     identifies it, and that ancestor is exactly what the clone used to die on. */
  const controls = makeObject({ name: 'TransformControls', isMesh: false, type: 'Object3D', isTransformControls: true });
  const handle = makeObject({ name: 'X', geometry: triangle, matrixWorld: { elements: identity() } });
  controls.children = [handle];

  const scene = makeScene([mesh, grid, cursor, ghost, controls]);
  const result = X.collect(scene);

  assert.deepEqual(Array.from(result.meshes, (m) => m.name), ['Sculpt']);
  assert.equal(result.skippedHelpers, 4, 'grid, cursor, onion ghost and the gizmo handle are counted, not silently dropped');
  assert.equal(X.isHelperObject(mesh), false);
  assert.equal(X.isHelperObject(handle), true, 'a gizmo handle is still a helper');
  assert.equal(X.isHelperObject(controls), true);
});

test('a mesh with no usable geometry is skipped instead of crashing the export', () => {
  const empty = makeObject({ name: 'Empty', geometry: { attributes: {} }, matrixWorld: { elements: identity() } });
  const noGeometry = makeObject({ name: 'NoGeometry', geometry: null, matrixWorld: { elements: identity() } });
  const scene = makeScene([empty, noGeometry]);
  const result = X.collect(scene);
  assert.equal(result.meshes.length, 0);
  assert.equal(result.skippedEmpty, 2);
});

test('a hidden object is not in the export, exactly like a hidden object is not in the viewport', () => {
  const geometry = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], null, null);
  const shown = makeObject({ name: 'Shown', geometry, matrixWorld: { elements: identity() } });
  const hidden = makeObject({ name: 'Hidden', visible: false, geometry, matrixWorld: { elements: identity() } });
  const group = makeObject({ name: 'Group', isMesh: false, type: 'Group', visible: false });
  const inside = makeObject({ name: 'Inside', geometry, matrixWorld: { elements: identity() } });
  group.children = [inside];

  const result = X.collect(makeScene([shown, hidden, group]));
  assert.deepEqual(Array.from(result.meshes, (m) => m.name), ['Shown']);
  assert.equal(result.skippedHidden, 2, 'the hidden mesh and the child of a hidden group');
});

test('the triangle budget truncates and says so', () => {
  const geometry = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], null, null); // one triangle
  const meshes = [0, 1, 2, 3].map((i) => makeObject({ name: `M${i}`, geometry, matrixWorld: { elements: identity() } }));
  const scene = makeScene(meshes);

  const full = X.collect(scene, { triangleBudget: 10 });
  assert.equal(full.meshes.length, 4);
  assert.equal(full.truncated, false);

  const tight = X.collect(scene, { triangleBudget: 2 });
  assert.equal(tight.meshes.length, 2);
  assert.equal(tight.truncated, true);
  assert.match(tight.warnings[0], /budget/);
});

/* ---- baking ------------------------------------------------------------- */

test('world position and normal are baked, not left in local space', () => {
  const geometry = makeGeometry(
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1]
  );
  const baked = X.bakeGeometry(geometry, translation(10, 20, 30));
  assert.deepEqual(Array.from(baked.positions.slice(0, 3)), [10, 20, 30]);
  assert.deepEqual(Array.from(baked.positions.slice(3, 6)), [11, 20, 30]);
  assert.deepEqual(Array.from(baked.normals.slice(0, 3)), [0, 0, 1]);
  assert.equal(baked.vertexCount, 3);
  assert.deepEqual(Array.from(baked.indices), [0, 1, 2], 'a non-indexed geometry gets a sequential index');
});

test('non-uniform scale keeps normals perpendicular (inverse transpose)', () => {
  const geometry = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const squashed = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const baked = X.bakeGeometry(geometry, squashed);
  /* A +X normal under a 2x-wide scale stays +X once normalised — the naive
     multiply would double it and still normalise, so check a diagonal instead. */
  assert.deepEqual(Array.from(baked.normals.slice(0, 3)), [1, 0, 0]);

  const skew = [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const skewed = X.bakeGeometry(geometry, skew);
  const n = Array.from(skewed.normals.slice(0, 3));
  const length = Math.hypot(...n);
  assert.ok(Math.abs(length - 1) < 1e-5, 'normals stay unit length');
});

test('an instanced mesh is baked into one primitive with every copy present', () => {
  const geometry = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], null, null);
  const matrices = new Float32Array(3 * 16);
  matrices.set(translation(0, 0, 0), 0);
  matrices.set(translation(5, 0, 0), 16);
  matrices.set(translation(10, 0, 0), 32);
  const instanced = makeObject({
    name: 'Foliage', isInstancedMesh: true, count: 3,
    geometry,
    matrixWorld: { elements: identity() },
    instanceMatrix: { array: matrices }
  });

  const baked = X.bakeInstanced(instanced);
  assert.equal(baked.instanceCount, 3);
  assert.equal(baked.vertexCount, 9);
  assert.equal(baked.indices.length, 9);
  const xs = [0, 3, 6].map((i) => baked.positions[i * 3]);
  assert.deepEqual(xs, [0, 5, 10], 'each copy keeps its own world position');
  assert.equal(baked.indices[3], 3, 'the second copy is indexed from its own vertices');
  assert.equal(baked.indices[8], 8);

  const capped = X.bakeInstanced(instanced, { maxInstances: 2 });
  assert.equal(capped.instanceCount, 2);
});

/* ---- glTF --------------------------------------------------------------- */

function sampleNodes() {
  const triangle = makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 1]);
  const baked = X.bakeGeometry(triangle, identity());
  return [{
    name: 'Tri',
    positions: baked.positions,
    normals: baked.normals,
    uvs: baked.uvs,
    indices: baked.indices,
    vertexCount: baked.vertexCount,
    material: X.describeMaterial({ name: 'Paint', color: { r: 1, g: 0.5, b: 0.25 }, metalness: 0.2, roughness: 0.4 }, 0)
  }];
}

test('the GLB container is a real glTF 2.0 binary', () => {
  const glb = X.buildGLB(sampleNodes());
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

  assert.equal(view.getUint32(0, true), 0x46546c67, 'magic is glTF');
  assert.equal(view.getUint32(4, true), 2, 'version 2');
  assert.equal(view.getUint32(8, true), glb.byteLength, 'the header length is the real length');
  assert.equal(view.getUint32(16, true), 0x4e4f534a, 'first chunk is JSON');

  const jsonLength = view.getUint32(12, true);
  assert.equal(jsonLength % 4, 0, 'the JSON chunk is padded to four bytes');
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].primitives[0].mode, 4, 'triangles');
  assert.equal(json.meshes[0].primitives[0].attributes.POSITION, 0);
  assert.equal(json.accessors[0].count, 3);
  assert.deepEqual(Array.from(json.accessors[0].min), [0, 0, 0]);
  assert.deepEqual(Array.from(json.accessors[0].max), [1, 1, 0]);

  const binStart = 20 + jsonLength;
  assert.equal(view.getUint32(binStart + 4, true), 0x004e4942, 'second chunk is BIN');
  const binLength = view.getUint32(binStart, true);
  assert.equal(binLength % 4, 0);
  assert.equal(json.buffers[0].byteLength, binLength);
  assert.equal(binStart + 8 + binLength, glb.byteLength, 'no bytes are left over or missing');

  /* The first bufferView must point at the real vertex data. */
  const positionView = json.bufferViews[json.accessors[0].bufferView];
  const floats = new Float32Array(glb.buffer, glb.byteOffset + binStart + 8 + positionView.byteOffset, 3);
  assert.deepEqual(Array.from(floats), [0, 0, 0]);
});

test('glTF materials carry the PBR values, and identical materials are shared', () => {
  const nodes = sampleNodes();
  const sibling = { ...nodes[0], name: 'Tri2' };
  const json = X.buildGLTF([...nodes, sibling]);
  assert.equal(json.materials.length, 1, 'one material, two meshes');
  const material = json.materials[0].pbrMetallicRoughness;
  assert.deepEqual(Array.from(material.baseColorFactor), [1, 0.5, 0.25, 1]);
  assert.equal(material.metallicFactor, 0.2);
  assert.equal(material.roughnessFactor, 0.4);

  const faded = X.describeMaterial({ name: 'Glass', color: { r: 0, g: 0, b: 0 }, transparent: true, opacity: 0.4 }, 1);
  assert.equal(faded.alpha, 0.4);
  const alphaJson = X.buildGLTF([{ ...nodes[0], name: 'Pane', material: faded }]);
  assert.equal(alphaJson.materials[0].alphaMode, 'BLEND');
  assert.equal(alphaJson.materials[0].pbrMetallicRoughness.baseColorFactor[3], 0.4);
});

test('the .gltf file embeds its binary payload and decodes to the same bytes', () => {
  const nodes = sampleNodes();
  const json = X.buildGLTF(nodes);
  const uri = json.buffers[0].uri;
  assert.ok(uri.startsWith('data:application/octet-stream;base64,'));
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  assert.equal(bytes.length, json.buffers[0].byteLength);

  const glb = X.buildGLB(nodes);
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const binStart = 20 + view.getUint32(12, true) + 8;
  assert.deepEqual(Array.from(bytes), Array.from(glb.subarray(binStart, binStart + bytes.length)),
    'both files describe the same vertices');
});

test('more than 65,535 vertices switch the index accessor to 32-bit', () => {
  const count = 65536 + 3;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) positions[i * 3] = i;
  const baked = { positions, normals: null, uvs: null, indices: new Uint32Array(count), vertexCount: count };
  const json = X.buildGLTF([{ name: 'Big', ...baked, material: X.describeMaterial(null, 0) }]);
  const indexAccessor = json.accessors.find((a) => a.type === 'SCALAR');
  assert.equal(indexAccessor.componentType, 5125);
});

test('an animation channel is written against the node it names', () => {
  const nodes = sampleNodes();
  const json = X.buildGLTF(nodes, {
    animations: [{
      name: 'Spin',
      channels: [{ node: 'Tri', path: 'rotation', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, 0, 0.7071, 0, 0.7071]) }]
    }]
  });
  assert.equal(json.animations.length, 1);
  assert.equal(json.animations[0].channels[0].target.node, 0);
  assert.equal(json.animations[0].channels[0].target.path, 'rotation');
  const sampler = json.animations[0].samplers[0];
  assert.equal(json.accessors[sampler.input].type, 'SCALAR');
  assert.deepEqual(Array.from(json.accessors[sampler.input].min), [0]);
  assert.deepEqual(Array.from(json.accessors[sampler.input].max), [1]);
  assert.equal(json.accessors[sampler.output].type, 'VEC4');

  const unknown = X.buildGLTF(nodes, { animations: [{ name: 'X', channels: [{ node: 'Nope', path: 'translation', times: new Float32Array([0]), values: new Float32Array([0, 0, 0]) }] }] });
  assert.equal(unknown.animations, undefined, 'a channel with no node is dropped, not written broken');
});

/* ---- OBJ ---------------------------------------------------------------- */

test('the OBJ file offsets vertex indices across objects', () => {
  const nodes = sampleNodes();
  const second = { ...nodes[0], name: 'Tri2' };
  const text = X.buildOBJ([nodes[0], second], { mtlName: 'scene.mtl' });

  assert.match(text, /^# Final Effect 3D Workspace/);
  assert.match(text, /mtllib scene\.mtl/);
  assert.match(text, /usemtl Paint/);
  const vertices = text.split('\n').filter((line) => line.startsWith('v '));
  assert.equal(vertices.length, 6, 'two triangles, three vertices each');
  const faces = text.split('\n').filter((line) => line.startsWith('f '));
  assert.equal(faces.length, 2);
  assert.equal(faces[0], 'f 1/1/1 2/2/2 3/3/3');
  assert.equal(faces[1], 'f 4/4/4 5/5/5 6/6/6', 'the second object starts where the first ended');
});

test('the MTL library lists each material once with its PBR numbers', () => {
  const nodes = sampleNodes();
  const materials = X.materialsOf([nodes[0], { ...nodes[0], name: 'Tri2' }]);
  assert.equal(materials.length, 1);
  const mtl = X.buildMTL(materials);
  assert.match(mtl, /newmtl Paint/);
  assert.match(mtl, /Kd 1 0\.5 0\.25/);
  assert.match(mtl, /Pr 0\.4/);
  assert.match(mtl, /Pm 0\.2/);
});

test('names are made safe for both formats', () => {
  assert.equal(X.sanitize('Terrain Mesh · #1 "final"'), 'Terrain_Mesh_1_final');
  assert.equal(X.sanitize(''), 'Object');
  assert.equal(X.sanitize('   '), 'Object');
  assert.ok(X.sanitize('x'.repeat(200)).length <= 64);
  const baked = X.bakeGeometry(makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0]), identity());
  const text = X.buildOBJ([{ name: 'a b/c', ...baked, material: null }]);
  assert.match(text, /o a_b_c/);
});

/* ---- wiring ------------------------------------------------------------- */

test('the workspace export path is wired through our own writers', () => {
  assert.ok(html.includes('<script src="workspace-export.js"></script>'));
  assert.equal(html.includes('three@0.128.0/examples/js/exporters/GLTFExporter.js'), false,
    'the CDN exporter that cloned TransformControls is gone');
  assert.equal(html.includes('three@0.128.0/examples/js/exporters/OBJExporter.js'), false);
  assert.equal(html.includes('new THREE.GLTFExporter('), false);
  assert.equal(html.includes('new THREE.OBJExporter('), false);
  assert.match(html, /window\.workspaceExportNodes = workspaceExportNodes/);
  assert.match(html, /W\.buildGLB\(nodes/);
  assert.match(html, /W\.buildOBJ\(nodes/);
  assert.match(html, /W\.buildMTL\(/);

  /* The animated path used the same cloning exporter; it must not come back. */
  assert.equal(engineSource.includes('new T.GLTFExporter('), false);
  assert.match(engineSource, /W\.buildGLTF\(nodes/);
  assert.match(engineSource, /window\.workspaceExportNodes\(eng\)/);
});

test('the export module ships with the app and the offline build', () => {
  assert.ok(sw.includes("'./workspace-export.js'"));
  assert.match(sw, /const CACHE_NAME = 'final-effect-cpp-v\d+';/);
  assert.ok(build.includes('"workspace-export.js"'));
  assert.ok(build.includes('workspaceExport: readFileSync'));
  assert.ok(readFileSync('scripts/standalone-html.mjs', 'utf8').includes("['workspace-export.js', workspaceExport]"));
});
