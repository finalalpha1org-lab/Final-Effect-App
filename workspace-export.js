/* ===========================================================================
 * workspace-export.js — glTF 2.0 / OBJ writers for the 3D Workspace
 * ---------------------------------------------------------------------------
 * Blender's exporters walk the evaluated depsgraph and skip editor-only
 * objects. This file does the same in miniature: it collects the real meshes,
 * bakes their world transform (and every instanced copy) into plain arrays,
 * and writes the files itself.
 *
 * Why own writers instead of THREE.GLTFExporter / THREE.OBJExporter:
 *   1. Both example exporters clone the scene graph, and r128's clone reaches
 *      TransformControls, whose constructor keeps `document.ownerDocument`
 *      (null on a document) and throws. The old export died there.
 *   2. r128's GLTFExporter has no InstancedMesh support, so landscape foliage
 *      would export as one plant standing at the origin.
 *   3. They load from a CDN; a test cannot prove them offline.
 * The maths here is plain arrays, so `tests/workspace-export.test.mjs` can
 * feed it synthetic geometry without a browser.
 * =========================================================================== */
(function (global) {
  'use strict';

  const GIZMO_ANCESTORS = ['isTransformControls', 'isTransformControlsGizmo', 'isTransformControlsPlane'];
  const HELPER_FLAGS = ['isGridHelper', 'isPolarGridHelper', 'isAxesHelper', 'isBoxHelper',
    'isCameraHelper', 'isDirectionalLightHelper', 'isSpotLightHelper', 'isPointLightHelper',
    'isHemisphereLightHelper', 'isSkeletonHelper', 'isArrowHelper'];
  const HELPER_NAMES = new Set(['Cursor3D', 'StudioFloor', 'ShadowFloor', 'SelectionOutlineHelper', 'ModifierHelper']);

  /* ---- scene filtering --------------------------------------------------- */

  function isGizmoAncestor(node) {
    return GIZMO_ANCESTORS.some((flag) => node[flag] === true || node.type === 'TransformControls' ||
      node.type === 'TransformControlsGizmo' || node.type === 'TransformControlsPlane');
  }

  /* Editor furniture: gizmos, grids, cursors, onion ghosts, light helpers.
     Anything the user cannot render also must not leave the app. */
  function isHelperObject(object) {
    if (!object) return true;
    for (let node = object; node; node = node.parent) {
      if (isGizmoAncestor(node)) return true;
      if (HELPER_FLAGS.some((flag) => node[flag] === true)) return true;
      if (node.userData && (node.userData.isEditorHelper === true || node.userData.feExcludeFromExport === true)) return true;
      if (node.userData && node.userData.feOnionGhost) return true;
      if (HELPER_NAMES.has(node.name)) return true;
    }
    return false;
  }

  /* Hidden in the viewport means hidden in the file — Blender exports the
     depsgraph, and a hidden collection is not in it. */
  function isVisibleInHierarchy(object) {
    for (let node = object; node; node = node.parent) {
      if (node.visible === false) return false;
    }
    return true;
  }

  function isExportableGeometry(object) {
    const geometry = object && object.geometry;
    const position = geometry && geometry.attributes && geometry.attributes.position;
    return !!(position && position.array && position.itemSize >= 3 && position.count > 0);
  }

  function triangleCount(object) {
    const geometry = object && object.geometry;
    if (!geometry) return 0;
    if (geometry.index && geometry.index.count) return Math.floor(geometry.index.count / 3);
    const position = geometry.attributes && geometry.attributes.position;
    return position ? Math.floor(position.count / 3) : 0;
  }

  /* Walks the scene exactly once and returns the objects worth writing.
     `options.budget` is a triangle ceiling — a phone cannot serialise a
     million grass blades, and a truncated file is worse than an honest one,
     so the cut is reported back to the caller. */
  function collect(scene, options) {
    const opts = options || {};
    const budget = Number(opts.triangleBudget) > 0 ? Number(opts.triangleBudget) : 900000;
    const meshes = [];
    const lights = [];
    const cameras = [];
    const result = {
      meshes, lights, cameras,
      triangles: 0,
      skippedHelpers: 0,
      skippedEmpty: 0,
      skippedHidden: 0,
      truncated: false,
      warnings: []
    };
    if (!scene) {
      result.warnings.push('No scene to export.');
      return result;
    }

    scene.traverse((object) => {
      if (object === scene) return;
      if (object.isLight) {
        if (!isHelperObject(object.parent)) lights.push(object);
        return;
      }
      if (object.isCamera) {
        if (!isHelperObject(object.parent)) cameras.push(object);
        return;
      }
      if (!object.isMesh && !object.isInstancedMesh) return;
      if (isHelperObject(object)) { result.skippedHelpers++; return; }
      if (!isVisibleInHierarchy(object)) { result.skippedHidden++; return; }
      if (!isExportableGeometry(object)) { result.skippedEmpty++; return; }

      const instances = object.isInstancedMesh ? Math.max(1, object.count | 0) : 1;
      const tris = triangleCount(object) * instances;
      if (result.triangles + tris > budget) {
        result.truncated = true;
        return;
      }
      result.triangles += tris;
      meshes.push(object);
    });

    if (result.truncated) {
      result.warnings.push(`Scene is larger than the ${Math.round(budget / 1000)}k-triangle export budget; some objects were left out.`);
    }
    return result;
  }

  /* ---- matrix helpers (column-major, same layout as THREE.Matrix4) ------- */

  function transformPoint(m, x, y, z, out) {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }

  /* Inverse transpose of the upper-left 3x3, so non-uniform scaling keeps
     normals perpendicular to the surface instead of skewing them. */
  function normalMatrix(m) {
    const a = m[0], b = m[1], c = m[2];
    const d = m[4], e = m[5], f = m[6];
    const g = m[8], h = m[9], i = m[10];
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det || !isFinite(det)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const s = 1 / det;
    // inverse = adj/det; transpose of that is the cofactor matrix / det
    return [
      A * s, B * s, C * s,
      (c * h - b * i) * s, (a * i - c * g) * s, (b * g - a * h) * s,
      (b * f - c * e) * s, (c * d - a * f) * s, (a * e - b * d) * s
    ];
  }

  function transformNormal(n, x, y, z, out) {
    out[0] = n[0] * x + n[1] * y + n[2] * z;
    out[1] = n[3] * x + n[4] * y + n[5] * z;
    out[2] = n[6] * x + n[7] * y + n[8] * z;
    const len = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= len; out[1] /= len; out[2] /= len;
    return out;
  }

  function multiply(a, b) {
    const out = new Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          a[row] * b[col * 4] +
          a[4 + row] * b[col * 4 + 1] +
          a[8 + row] * b[col * 4 + 2] +
          a[12 + row] * b[col * 4 + 3];
      }
    }
    return out;
  }

  /* ---- geometry baking --------------------------------------------------- */

  function readIndices(geometry, vertexCount) {
    const index = geometry.index;
    if (index && index.array && index.count) {
      const source = index.array;
      const out = vertexCount > 65535 ? new Uint32Array(index.count) : new Uint16Array(index.count);
      for (let i = 0; i < index.count; i++) out[i] = source[i];
      return out;
    }
    const out = vertexCount > 65535 ? new Uint32Array(vertexCount) : new Uint16Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) out[i] = i;
    return out;
  }

  /* ---- C++ bake bridge ---------------------------------------------------
     cpp/src/fe_export.cpp bakes a mesh, and every instanced copy of it, into
     world space: the column-major transform, the inverse-transpose for the
     normals, the renormalise, the instance concat and the index offset. This
     file now only copies typed arrays in and out.

     The JavaScript loops are kept as bakeGeometrySoftware /
     bakeInstancedSoftware. They are the fallback when the engine artifact is
     missing, and they are the oracle the parity suite compares the C++ path
     against, byte for byte. */

  function engine() {
    const eng = typeof globalThis !== 'undefined' ? globalThis.FECppEngine : null;
    if (!eng || !eng.ready || !eng.exports || !eng.memory) return null;
    if (typeof eng.exports.fe_export_bake !== 'function' || typeof eng.scratch !== 'function') return null;
    return eng;
  }

  /* The OBJ/MTL writers live in cpp/src/fe_writer.cpp; this is the engine check
     they need. */
  function writerEngine() {
    const eng = engine();
    if (!eng || typeof eng.exports.fe_writer_obj_mesh !== 'function') return null;
    return eng;
  }

  /* The six-decimal formatter the OBJ writer used. The kernel has the same one
     in C++; this stays as the fallback and as the parity oracle. */
  function objFloat(value) {
    if (!isFinite(value)) return '0';
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded === 0 ? 0 : rounded);
  }

  /* Fill a float32 region of engine memory from an attribute, honouring the
     attribute's itemSize: the kernels always read xyz (or uv) packed. */
  function putAttribute(view, attribute, count, components) {
    const array = attribute.array;
    const itemSize = attribute.itemSize || components;
    if (itemSize === components) {
      if (array.length >= count * components) view.set(array.subarray(0, count * components));
      return;
    }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < components; c++) view[i * components + c] = array[i * itemSize + c] || 0;
    }
  }

  /* One mesh through the C++ kernel, or undefined when the engine cannot take
     it (no artifact, out of range, refused allocation). */
  function bakeGeometryCpp(eng, geometry, matrix) {
    const attributes = geometry.attributes || {};
    const position = attributes.position;
    if (!position || !position.array || !position.count) return undefined;
    const count = position.count;
    const normal = attributes.normal && attributes.normal.array ? attributes.normal : null;
    const uv = attributes.uv && attributes.uv.array ? attributes.uv : null;
    const indices = readIndices(geometry, count);
    const ex = eng.exports;

    if (ex.fe_export_begin(count, indices.length, 1) !== 0) return undefined;
    if (ex.fe_export_set_counts(count, indices.length, normal ? 1 : 0, uv ? 1 : 0) !== 0) return undefined;

    const matrixSlot = eng.scratch('export-matrix', 16 * 8);
    const m = matrix && matrix.length >= 16 ? matrix : IDENTITY_MATRIX;
    const buffer = eng.memory.buffer;
    new Float64Array(buffer, matrixSlot.ptr, 16).set(m);

    putAttribute(new Float32Array(buffer, ex.fe_export_src_pos_ptr(), count * 3), position, count, 3);
    if (normal) putAttribute(new Float32Array(buffer, ex.fe_export_src_nrm_ptr(), count * 3), normal, count, 3);
    if (uv) putAttribute(new Float32Array(buffer, ex.fe_export_src_uv_ptr(), count * 2), uv, count, 2);
    new Uint32Array(buffer, ex.fe_export_src_idx_ptr(), indices.length).set(indices);

    if (ex.fe_export_bake(matrixSlot.ptr) !== 0) return undefined;
    return readBaked(ex, eng, !!normal, !!uv);
  }

  /* N instanced copies through the same kernel: base world matrix x each
     instance matrix, concatenated exactly as concat() used to. */
  function bakeInstancedCpp(eng, object, options) {
    const base = object.matrixWorld ? object.matrixWorld.elements : null;
    const instanceArray = object.instanceMatrix && object.instanceMatrix.array;
    if (!base || !instanceArray) return undefined;
    const geometry = object.geometry;
    const attributes = geometry && geometry.attributes ? geometry.attributes : {};
    const position = attributes.position;
    if (!position || !position.array || !position.count) return undefined;

    const opts = options || {};
    const total = Math.max(1, object.count | 0);
    const limit = Number(opts.maxInstances) > 0 ? Math.min(total, Number(opts.maxInstances)) : total;
    if (!limit || limit > 65536) return undefined;
    if (instanceArray.length < limit * 16) return undefined;

    const count = position.count;
    const normal = attributes.normal && attributes.normal.array ? attributes.normal : null;
    const uv = attributes.uv && attributes.uv.array ? attributes.uv : null;
    const indices = readIndices(geometry, count);
    const ex = eng.exports;

    if (ex.fe_export_begin(count, indices.length, limit) !== 0) return undefined;
    if (ex.fe_export_set_counts(count, indices.length, normal ? 1 : 0, uv ? 1 : 0) !== 0) return undefined;

    const matrixSlot = eng.scratch('export-matrix', 16 * 8);
    const instanceSlot = eng.scratch('export-instances', limit * 16 * 4);
    const buffer = eng.memory.buffer;
    new Float64Array(buffer, matrixSlot.ptr, 16).set(base);
    new Float32Array(buffer, instanceSlot.ptr, limit * 16).set(instanceArray.subarray(0, limit * 16));

    putAttribute(new Float32Array(buffer, ex.fe_export_src_pos_ptr(), count * 3), position, count, 3);
    if (normal) putAttribute(new Float32Array(buffer, ex.fe_export_src_nrm_ptr(), count * 3), normal, count, 3);
    if (uv) putAttribute(new Float32Array(buffer, ex.fe_export_src_uv_ptr(), count * 2), uv, count, 2);
    new Uint32Array(buffer, ex.fe_export_src_idx_ptr(), indices.length).set(indices);

    if (ex.fe_export_bake_instanced(matrixSlot.ptr, instanceSlot.ptr, limit) !== limit) return undefined;
    const baked = readBaked(ex, eng, !!normal, !!uv);
    baked.instanceCount = limit;
    return baked;
  }

  /* Copy the kernel's output block out of engine memory. The copies are made
     here on purpose: the next bake overwrites the block. */
  function readBaked(ex, eng, hasNormals, hasUv) {
    const buffer = eng.memory.buffer;
    const vertexCount = ex.fe_export_out_vertex_count();
    const indexCount = ex.fe_export_out_index_count();
    const positions = new Float32Array(buffer, ex.fe_export_out_pos_ptr(), vertexCount * 3).slice();
    const normals = hasNormals ? new Float32Array(buffer, ex.fe_export_out_nrm_ptr(), vertexCount * 3).slice() : null;
    const uvs = hasUv ? new Float32Array(buffer, ex.fe_export_out_uv_ptr(), vertexCount * 2).slice() : null;
    /* Uint16 when the whole primitive fits, which is the width readIndices()
       and concat() picked before this kernel existed. */
    const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    indices.set(new Uint32Array(buffer, ex.fe_export_out_idx_ptr(), indexCount));
    return { positions, normals, uvs, indices, vertexCount };
  }

  const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  /* One mesh, transformed into world space. Returns typed arrays only, so the
     caller decides how to package them (glTF buffers, OBJ text, …). */
  function bakeGeometry(geometry, matrix) {
    const eng = engine();
    if (eng) {
      const baked = bakeGeometryCpp(eng, geometry, matrix);
      if (baked) return baked;
    }
    return bakeGeometrySoftware(geometry, matrix);
  }

  function bakeGeometrySoftware(geometry, matrix) {
    const attributes = geometry.attributes || {};
    const position = attributes.position;
    if (!position || !position.array) return null;
    const count = position.count;
    const m = matrix || IDENTITY_MATRIX;
    const nm = normalMatrix(m);
    const positions = new Float32Array(count * 3);
    const normals = attributes.normal && attributes.normal.array ? new Float32Array(count * 3) : null;
    const uvs = attributes.uv && attributes.uv.array ? new Float32Array(count * 2) : null;
    const point = [0, 0, 0];
    const normal = [0, 0, 0];

    for (let i = 0; i < count; i++) {
      const p = i * position.itemSize;
      transformPoint(m, position.array[p], position.array[p + 1], position.array[p + 2], point);
      positions[i * 3] = point[0];
      positions[i * 3 + 1] = point[1];
      positions[i * 3 + 2] = point[2];

      if (normals) {
        const n = i * attributes.normal.itemSize;
        transformNormal(nm, attributes.normal.array[n], attributes.normal.array[n + 1], attributes.normal.array[n + 2], normal);
        normals[i * 3] = normal[0];
        normals[i * 3 + 1] = normal[1];
        normals[i * 3 + 2] = normal[2];
      }
      if (uvs) {
        const t = i * attributes.uv.itemSize;
        uvs[i * 2] = attributes.uv.array[t];
        uvs[i * 2 + 1] = attributes.uv.array[t + 1];
      }
    }

    return { positions, normals, uvs, indices: readIndices(geometry, count), vertexCount: count };
  }

  /* An InstancedMesh is one geometry plus N matrices. glTF 2.0 has no core
     instancing, so the copies are baked into a single primitive — the export
     looks like the viewport instead of like one plant at the origin. */
  function bakeInstanced(object, options) {
    const eng = engine();
    if (eng) {
      const baked = bakeInstancedCpp(eng, object, options);
      if (baked) return baked;
    }
    return bakeInstancedSoftware(object, options);
  }

  function bakeInstancedSoftware(object, options) {
    const opts = options || {};
    const base = object.matrixWorld ? object.matrixWorld.elements : null;
    const instanceArray = object.instanceMatrix && object.instanceMatrix.array;
    if (!base || !instanceArray) return null;
    const total = Math.max(1, object.count | 0);
    const limit = Number(opts.maxInstances) > 0 ? Math.min(total, Number(opts.maxInstances)) : total;

    let first = null;
    for (let i = 0; i < limit; i++) {
      const slice = Array.prototype.slice.call(instanceArray, i * 16, i * 16 + 16);
      const baked = bakeGeometrySoftware(object.geometry, multiply(base, slice));
      if (!baked) return null;
      if (!first) first = baked;
      else first = concat(first, baked);
    }
    if (first) first.instanceCount = limit;
    return first;
  }

  /* Append b to a, offsetting b's indices so both copies share one index
     buffer. Only the fallback needs this now: the C++ kernel writes N copies
     into one output block directly, and the parity suite pins the two equal. */
  function concat(a, b) {
    const positions = new Float32Array(a.positions.length + b.positions.length);
    positions.set(a.positions, 0);
    positions.set(b.positions, a.positions.length);

    let normals = null;
    if (a.normals && b.normals) {
      normals = new Float32Array(a.normals.length + b.normals.length);
      normals.set(a.normals, 0);
      normals.set(b.normals, a.normals.length);
    }
    let uvs = null;
    if (a.uvs && b.uvs) {
      uvs = new Float32Array(a.uvs.length + b.uvs.length);
      uvs.set(a.uvs, 0);
      uvs.set(b.uvs, a.uvs.length);
    }
    const vertexCount = a.vertexCount + b.vertexCount;
    const indices = vertexCount > 65535 ? new Uint32Array(a.indices.length + b.indices.length)
      : new Uint16Array(a.indices.length + b.indices.length);
    indices.set(a.indices, 0);
    const offset = a.vertexCount;
    for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + offset;
    return { positions, normals, uvs, indices, vertexCount, instanceCount: (a.instanceCount || 1) };
  }

  /* ---- materials --------------------------------------------------------- */

  function materialName(material, index) {
    const raw = (material && material.name) || `Material_${(index || 0) + 1}`;
    return sanitize(raw);
  }

  function describeMaterial(material, index) {
    if (!material) {
      return { name: `Material_${(index || 0) + 1}`, baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.8, emissive: [0, 0, 0], doubleSided: true, alpha: 1 };
    }
    const color = material.color || {};
    const emissive = material.emissive || {};
    const opacity = material.opacity === undefined ? 1 : material.opacity;
    const transparent = material.transparent === true && opacity < 1;
    return {
      name: materialName(material, index),
      baseColor: [num(color.r, 1), num(color.g, 1), num(color.b, 1), transparent ? clamp01(opacity) : 1],
      metallic: clamp01(num(material.metalness, 0)),
      roughness: clamp01(num(material.roughness, 0.8)),
      emissive: [num(emissive.r, 0), num(emissive.g, 0), num(emissive.b, 0)],
      doubleSided: material.side === 2 || material.side === undefined,
      alpha: transparent ? clamp01(opacity) : 1
    };
  }

  function num(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
  function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

  function sanitize(text) {
    return String(text || 'Object').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'Object';
  }

  /* ---- glTF 2.0 ---------------------------------------------------------- */

  function align4(n) { return (n + 3) & ~3; }

  function roundFloat(value) {
    return Math.round(value * 100000) / 100000;
  }

  function boundsOf(array) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < array.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = array[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
    return { min: min.map(roundFloat), max: max.map(roundFloat) };
  }

  /* Builds the JSON document and the binary payload together, so .glb and
     .gltf can never disagree about accessors or counts. */
  function buildGltfDocument(nodes, options) {
    const opts = options || {};
    const json = {
      asset: { version: '2.0', generator: 'Final Effect 3D Workspace' },
      scene: 0,
      scenes: [{ name: opts.sceneName || 'Workspace', nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: []
    };
    const chunks = [];
    let byteOffset = 0;
    const materialIndex = new Map();

    function pushView(array, target) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      const view = { buffer: 0, byteOffset: align4(byteOffset), byteLength: bytes.byteLength };
      if (target) view.target = target;
      if (view.byteOffset !== byteOffset) {
        chunks.push(new Uint8Array(view.byteOffset - byteOffset));
        byteOffset = view.byteOffset;
      }
      chunks.push(bytes);
      byteOffset += bytes.byteLength;
      json.bufferViews.push(view);
      return json.bufferViews.length - 1;
    }

    nodes.forEach((node) => {
      const materialKey = node.material ? node.material.name : 'none';
      if (!materialIndex.has(materialKey)) {
        materialIndex.set(materialKey, json.materials.length);
        json.materials.push(gltfMaterial(node.material));
      }
      const primitive = { attributes: {}, material: materialIndex.get(materialKey), mode: 4 };

      const positionView = pushView(node.positions, 34962);
      const bounds = boundsOf(node.positions);
      json.accessors.push({
        bufferView: positionView, componentType: 5126, count: node.vertexCount, type: 'VEC3',
        min: bounds.min, max: bounds.max
      });
      primitive.attributes.POSITION = json.accessors.length - 1;

      if (node.normals) {
        const view = pushView(node.normals, 34962);
        json.accessors.push({ bufferView: view, componentType: 5126, count: node.vertexCount, type: 'VEC3' });
        primitive.attributes.NORMAL = json.accessors.length - 1;
      }
      if (node.uvs) {
        const view = pushView(node.uvs, 34962);
        json.accessors.push({ bufferView: view, componentType: 5126, count: node.vertexCount, type: 'VEC2' });
        primitive.attributes.TEXCOORD_0 = json.accessors.length - 1;
      }
      const wide = node.vertexCount > 65535;
      const indexView = pushView(node.indices, 34963);
      json.accessors.push({
        bufferView: indexView,
        componentType: wide ? 5125 : 5123,
        count: node.indices.length,
        type: 'SCALAR'
      });
      primitive.indices = json.accessors.length - 1;

      json.meshes.push({ name: node.name, primitives: [primitive] });
      json.nodes.push({ name: node.name, mesh: json.meshes.length - 1 });
      json.scenes[0].nodes.push(json.nodes.length - 1);
    });

    /* ---- animations (optional) ---------------------------------------
       A channel names its node, so the caller does not have to know the
       order the meshes were collected in. Times are seconds. */
    if (opts.animations && opts.animations.length) {
      const byName = new Map();
      json.nodes.forEach((node, index) => { if (node.name) byName.set(node.name, index); });
      json.animations = [];
      opts.animations.forEach((clip) => {
        const animation = { name: sanitize(clip.name || 'Action'), channels: [], samplers: [] };
        (clip.channels || []).forEach((channel) => {
          const nodeIndex = byName.get(channel.node);
          if (nodeIndex === undefined || !channel.times || !channel.values) return;
          const times = channel.times instanceof Float32Array ? channel.times : new Float32Array(channel.times);
          const values = channel.values instanceof Float32Array ? channel.values : new Float32Array(channel.values);
          const timeView = pushView(times, 34962);
          const timeBounds = boundsOfTimes(times);
          json.accessors.push({ bufferView: timeView, componentType: 5126, count: times.length, type: 'SCALAR', min: [timeBounds.min], max: [timeBounds.max] });
          const timeAccessor = json.accessors.length - 1;
          const valueView = pushView(values, 34962);
          const stride = channel.path === 'rotation' ? 4 : 3;
          json.accessors.push({ bufferView: valueView, componentType: 5126, count: Math.floor(values.length / stride), type: stride === 4 ? 'VEC4' : 'VEC3' });
          const valueAccessor = json.accessors.length - 1;
          animation.samplers.push({ input: timeAccessor, output: valueAccessor, interpolation: 'LINEAR' });
          animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: nodeIndex, path: channel.path } });
        });
        if (animation.channels.length) json.animations.push(animation);
      });
      if (!json.animations.length) delete json.animations;
    }

    const totalBytes = align4(byteOffset);
    if (totalBytes !== byteOffset) chunks.push(new Uint8Array(totalBytes - byteOffset));
    const binary = new Uint8Array(totalBytes);
    let cursor = 0;
    chunks.forEach((chunk) => { binary.set(chunk, cursor); cursor += chunk.byteLength; });
    json.buffers.push({ byteLength: totalBytes });
    return { json, binary };
  }

  function gltfMaterial(material) {
    const source = material || describeMaterial(null, 0);
    const entry = {
      name: source.name,
      pbrMetallicRoughness: {
        baseColorFactor: source.baseColor.map((v) => roundFloat(v)),
        metallicFactor: roundFloat(source.metallic),
        roughnessFactor: roundFloat(source.roughness)
      }
    };
    if (source.emissive && (source.emissive[0] || source.emissive[1] || source.emissive[2])) {
      entry.emissiveFactor = source.emissive.map((v) => roundFloat(v));
    }
    if (source.doubleSided) entry.doubleSided = true;
    if (source.alpha < 1) { entry.alphaMode = 'BLEND'; }
    return entry;
  }

  function boundsOfTimes(array) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < array.length; i++) {
      if (array[i] < min) min = array[i];
      if (array[i] > max) max = array[i];
    }
    if (!isFinite(min)) return { min: 0, max: 0 };
    return { min: roundFloat(min), max: roundFloat(max) };
  }

  function utf8(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return new Uint8Array(bytes);
  }

  function buildGLB(nodes, options) {
    const { json, binary } = buildGltfDocument(nodes, options);
    let jsonBytes = utf8(JSON.stringify(json));
    const jsonPadded = align4(jsonBytes.byteLength);
    const padded = new Uint8Array(jsonPadded);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.byteLength);

    const total = 12 + 8 + jsonPadded + 8 + binary.byteLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);        // 'glTF'
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonPadded, true);
    view.setUint32(16, 0x4e4f534a, true);       // 'JSON'
    out.set(padded, 20);
    let cursor = 20 + jsonPadded;
    view.setUint32(cursor, binary.byteLength, true);
    view.setUint32(cursor + 4, 0x004e4942, true); // 'BIN\0'
    out.set(binary, cursor + 8);
    return out;
  }

  function base64(bytes) {
    if (typeof Buffer === 'function') return Buffer.from(bytes).toString('base64');
    let text = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      text += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)] +
        (b === undefined ? '=' : B64[((b & 15) << 2) | ((c || 0) >> 6)]) +
        (c === undefined ? '=' : B64[c & 63]);
    }
    return text;
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function buildGLTF(nodes, options) {
    const { json, binary } = buildGltfDocument(nodes, options);
    json.buffers[0].uri = `data:application/octet-stream;base64,${base64(binary)}`;
    return json;
  }

  /* ---- OBJ --------------------------------------------------------------- */

  function buildMTL(materials) {
    const list = materials || [];
    const eng = writerEngine();
    if (eng && typeof eng.exports.fe_writer_mtl_material === 'function') {
      const text = buildMTLThroughEngine(eng, list);
      if (text !== null) return text;
    }
    return buildMTLSoftware(list);
  }

  function buildMTLThroughEngine(eng, materials) {
    const ex = eng.exports;
    const budget = 512 + materials.length * 512;
    if (ex.fe_writer_begin(budget) < 0) return null;
    if (ex.fe_writer_mtl_header() !== 0) return null;
    const emissiveSlot = eng.scratch('mtl-emissive', 3 * 8);
    for (const material of materials) {
      const name = putText(eng, 'mtl-name', material.name || 'Material');
      const base = material.baseColor || [0.8, 0.8, 0.8, 1];
      const emissive = material.emissive;
      const emissiveBuffer = eng.memory.buffer;
      const hasEmissive = !!(emissive && (emissive[0] || emissive[1] || emissive[2]));
      let emissivePtr = 0;
      if (hasEmissive) {
        new Float64Array(emissiveBuffer, emissiveSlot.ptr, 3).set([emissive[0], emissive[1], emissive[2]]);
        emissivePtr = emissiveSlot.ptr;
      }
      if (ex.fe_writer_mtl_material(name.ptr, name.length, base[0], base[1], base[2], base[3],
        material.roughness, material.metallic, emissivePtr, hasEmissive ? 1 : 0) !== 0) return null;
    }
    return new TextDecoder().decode(new Uint8Array(eng.memory.buffer, ex.fe_writer_text_ptr(), ex.fe_writer_text_length()).slice());
  }

  function buildMTLSoftware(materials) {
    const lines = ['# Final Effect 3D Workspace material library'];
    (materials || []).forEach((material) => {
      const [r, g, b, a] = material.baseColor;
      lines.push('', `newmtl ${material.name}`);
      lines.push(`Ka 0.0 0.0 0.0`);
      lines.push(`Kd ${objFloat(r)} ${objFloat(g)} ${objFloat(b)}`);
      lines.push(`Ks ${objFloat((1 - material.roughness) * 0.5)} ${objFloat((1 - material.roughness) * 0.5)} ${objFloat((1 - material.roughness) * 0.5)}`);
      lines.push(`Ns ${objFloat(Math.max(1, (1 - material.roughness) * 900))}`);
      lines.push(`d ${objFloat(a)}`);
      lines.push('illum 2');
      lines.push(`Pr ${objFloat(material.roughness)}`);
      lines.push(`Pm ${objFloat(material.metallic)}`);
      if (material.emissive && (material.emissive[0] || material.emissive[1] || material.emissive[2])) {
        lines.push(`Ke ${objFloat(material.emissive[0])} ${objFloat(material.emissive[1])} ${objFloat(material.emissive[2])}`);
      }
    });
    return lines.join('\n') + '\n';
  }

  function buildOBJ(nodes, options) {
    const opts = options || {};
    const eng = writerEngine();
    if (eng) {
      const text = buildOBJThroughEngine(eng, nodes, opts);
      if (text !== null) return text;
    }
    return buildOBJSoftware(nodes, options);
  }

  /* One contiguous append buffer for the whole document. The budget is an upper
     bound on the longest line each mesh can produce; if it is still short the
     kernel says so (-2) and one retry with double the room is enough. */
  function objBudget(nodes) {
    let bytes = 256;
    nodes.forEach((node) => {
      const vertices = node.vertexCount || 0;
      const indices = node.indices ? node.indices.length : 0;
      /* A `v` line is at most ~43 bytes, a `vt` ~32 and a `vn` ~40; the index
         writer reuses those vertices, so 72 per vertex plus 16 per index is a
         deliberate under-estimate - the caller retries with double the room and
         only falls back to the JavaScript writer if that is still not enough. */
      bytes += 72 * vertices + 16 * indices + 256;
    });
    return bytes;
  }

  function buildOBJThroughEngine(eng, nodes, opts) {
    const ex = eng.exports;
    let budget = objBudget(nodes);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ex.fe_writer_begin(budget) < 0) return null;
      const triangles = nodes.reduce((sum, n) => sum + Math.floor(n.indices.length / 3), 0);
      const mtl = opts.mtlName ? putText(eng, 'obj-mtllib', opts.mtlName) : null;
      if (ex.fe_writer_obj_header(nodes.length, triangles,
        mtl ? mtl.ptr : 0, mtl ? mtl.length : 0) !== 0) return null;

      let base = 1;
      let overflow = false;
      for (const node of nodes) {
        const writer = writeObjMesh(eng, node, base);
        if (writer === null) { overflow = true; break; }
        if (writer < 0) return null;
        base += node.vertexCount;
      }
      if (!overflow) {
        return new TextDecoder().decode(new Uint8Array(eng.memory.buffer, ex.fe_writer_text_ptr(), ex.fe_writer_text_length()).slice());
      }
      budget *= 2;
    }
    return null;
  }

  /* Copy a UTF-8 string into a named scratch block and hand back its pointer. */
  function putText(eng, slotName, text) {
    const bytes = utf8(String(text == null ? '' : text));
    const slot = eng.scratch(slotName, Math.max(1, bytes.length));
    if (bytes.length) new Uint8Array(eng.memory.buffer, slot.ptr, bytes.length).set(bytes);
    return { ptr: slot.ptr, length: bytes.length };
  }

  /* Returns 0 ok, -2 no room, null for "the engine cannot take this mesh". */
  function writeObjMesh(eng, node, base) {
    const ex = eng.exports;
    const vertices = node.vertexCount || 0;
    const positions = node.positions;
    const normals = node.normals;
    const uvs = node.uvs;
    const indices = node.indices || new Uint32Array(0);
    if (!positions) return null;

    const name = sanitize(node.name);
    const material = node.material ? { name: String(node.material.name) } : null;
    /* Every scratch block is reserved before any view is created: a reservation
       can grow linear memory, and growth detaches the views made earlier. */
    const positionSlot = eng.scratch('obj-positions', Math.max(1, vertices * 3) * 4);
    const normalSlot = normals ? eng.scratch('obj-normals', Math.max(1, vertices * 3) * 4) : null;
    const uvSlot = uvs ? eng.scratch('obj-uvs', Math.max(1, vertices * 2) * 4) : null;
    const indexSlot = eng.scratch('obj-indices', Math.max(1, indices.length) * 4);
    const nameText = putText(eng, 'obj-name', name);
    const materialText = material ? putText(eng, 'obj-material', material.name) : null;

    const buffer = eng.memory.buffer;
    new Float32Array(buffer, positionSlot.ptr, vertices * 3).set(positions.subarray(0, vertices * 3));
    if (normalSlot) new Float32Array(buffer, normalSlot.ptr, vertices * 3).set(normals.subarray(0, vertices * 3));
    if (uvSlot) new Float32Array(buffer, uvSlot.ptr, vertices * 2).set(uvs.subarray(0, vertices * 2));
    new Uint32Array(buffer, indexSlot.ptr, indices.length).set(indices);

    const rc = ex.fe_writer_obj_mesh(nameText.ptr, nameText.length,
      materialText ? materialText.ptr : 0, materialText ? materialText.length : 0,
      positionSlot.ptr, positions.length,
      normalSlot ? normalSlot.ptr : 0, normals ? normals.length : 0,
      uvSlot ? uvSlot.ptr : 0, uvs ? uvs.length : 0,
      indexSlot.ptr, indices.length, base);
    if (rc === -2) return -2;
    if (rc !== 0) return null;
    return 0;
  }

  function buildOBJSoftware(nodes, options) {
    const opts = options || {};
    const lines = ['# Final Effect 3D Workspace'];
    lines.push(`# ${nodes.length} meshes, ${nodes.reduce((sum, n) => sum + Math.floor(n.indices.length / 3), 0)} triangles`);
    if (opts.mtlName) lines.push(`mtllib ${opts.mtlName}`);
    let base = 1;
    const materials = [];
    const seen = new Set();

    nodes.forEach((node) => {
      const material = node.material;
      if (material && !seen.has(material.name)) {
        seen.add(material.name);
        materials.push(material);
      }
      lines.push('', `o ${sanitize(node.name)}`);
      if (material) lines.push(`usemtl ${material.name}`);
      const p = node.positions;
      for (let i = 0; i < p.length; i += 3) {
        lines.push(`v ${objFloat(p[i])} ${objFloat(p[i + 1])} ${objFloat(p[i + 2])}`);
      }
      const uv = node.uvs;
      if (uv) {
        for (let i = 0; i < uv.length; i += 2) lines.push(`vt ${objFloat(uv[i])} ${objFloat(uv[i + 1])}`);
      }
      const n = node.normals;
      if (n) {
        for (let i = 0; i < n.length; i += 3) lines.push(`vn ${objFloat(n[i])} ${objFloat(n[i + 1])} ${objFloat(n[i + 2])}`);
      }
      const indices = node.indices;
      for (let i = 0; i < indices.length; i += 3) {
        const a = base + indices[i], b = base + indices[i + 1], c = base + indices[i + 2];
        if (uv && n) lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
        else if (n) lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
        else if (uv) lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
        else lines.push(`f ${a} ${b} ${c}`);
      }
      base += node.vertexCount;
    });

    return lines.join('\n') + '\n';
  }

  /* ---- FBX ---------------------------------------------------------------
     FBX is a binary container by default, but the ASCII form (7.4) is the same
     data in text, and every importer — Blender, Maya, Unity, Unreal, Substance —
     reads it. The button for it has always been in the export sheet and the
     function behind it never existed, which threw on load and took the rest of
     that script down with it. This writes the document properly: one Geometry,
     Model and Material per node, wired with OO connections, normals and UVs per
     vertex. Only what the scene actually has is emitted; nothing is faked. */

  function fbxFloat(value) {
    if (!isFinite(value)) return '0';
    const rounded = Math.round(value * 1e5) / 1e5;
    return String(rounded === 0 ? 0 : rounded);
  }

  function fbxArray(values) {
    const parts = [];
    for (let i = 0; i < values.length; i += 1) parts.push(fbxFloat(values[i]));
    return `*${values.length} {\n\t\t\t\t${parts.join(',')}\n\t\t\t}`;
  }

  /* Every FBX string is quoted and has its backslashes doubled. */
  function fbxName(text) {
    return `"${String(text == null ? '' : text).replace(/\\/g, '\\\\').replace(/"/g, '')}"`;
  }

  function fbxProperty(name, type, subtype, flags, value) {
    return `\t\t\tP: ${fbxName(name)}, ${fbxName(type)}, ${fbxName(subtype)}, ${fbxName(flags)},${value}\n`;
  }

  function buildFBX(nodes, options) {
    const opts = options || {};
    const list = (nodes || []).filter((node) => node && node.vertexCount > 0 && node.indices && node.indices.length >= 3);
    const triangles = list.reduce((sum, node) => sum + Math.floor(node.indices.length / 3), 0);
    const materials = materialsOf(list);
    const time = '1970-01-01 10:00:00:000';
    const out = [];

    out.push('; FBX 7.4.0 project file');
    out.push('; Final Effect 3D Workspace');
    out.push(`; ${list.length} meshes, ${triangles} triangles, ${materials.length} materials`);
    out.push('; ----------------------------------------------------');
    out.push('');
    out.push('FBXHeaderExtension:  {');
    out.push('\tFBXHeaderVersion: 1003');
    out.push('\tFBXVersion: 7400');
    out.push('\tCreator: "Final Effect 3D Workspace"');
    out.push(`\tCreationTimeStamp:  { Version: 1000 Year: 1970 Month: 1 Day: 1 Hour: 10 Minute: 0 Second: 0 Millisecond: 0 }`);
    out.push('}');
    out.push('GlobalSettings:  {');
    out.push('\tVersion: 1000');
    out.push('\tProperties70:  {');
    out.push('\t\tP: "UpAxis", "int", "Integer", "",1');
    out.push('\t\tP: "UpAxisSign", "int", "Integer", "",1');
    out.push('\t\tP: "FrontAxis", "int", "Integer", "",2');
    out.push('\t\tP: "FrontAxisSign", "int", "Integer", "",1');
    out.push('\t\tP: "CoordAxis", "int", "Integer", "",0');
    out.push('\t\tP: "CoordAxisSign", "int", "Integer", "",1');
    out.push('\t\tP: "UnitScaleFactor", "double", "Number", "",100');
    out.push('\t\tP: "AmbientColor", "ColorRGB", "Color", "",0,0,0');
    out.push('\t\tP: "DefaultCamera", "KString", "", "", "Producer Perspective"');
    out.push('\t\tP: "TimeMode", "enum", "", "",11');
    out.push(`\t\tP: "TimeSpanStart", "KTime", "Time", "",0`);
    out.push(`\t\tP: "TimeSpanStop", "KTime", "Time", "",${46186158000}`);
    out.push('\t}');
    out.push('}');
    out.push('Documents:  {');
    out.push('\tCount: 1');
    out.push('\tDocument: 100000, "", "Scene" {');
    out.push('\t\tProperties70:  {');
    out.push('\t\t\tP: "SourceObject", "object", "", ""');
    out.push('\t\t\tP: "ActiveAnimStackName", "KString", "", "", ""');
    out.push('\t\t}');
    out.push('\t\tRootNode: 0');
    out.push('\t}');
    out.push('}');
    out.push('References:  {');
    out.push('}');
    out.push('Definitions:  {');
    out.push('\tVersion: 100');
    out.push(`\tCount: ${list.length * 2 + materials.length + 1}`);
    out.push('\tObjectType: "GlobalSettings" {');
    out.push('\t\tCount: 1');
    out.push('\t}');
    out.push('\tObjectType: "Model" {');
    out.push(`\t\tCount: ${list.length}`);
    out.push('\t}');
    out.push('\tObjectType: "Geometry" {');
    out.push(`\t\tCount: ${list.length}`);
    out.push('\t}');
    out.push('\tObjectType: "Material" {');
    out.push(`\t\tCount: ${materials.length}`);
    out.push('\t}');
    out.push('}');
    out.push('Objects:  {');

    list.forEach((node, index) => {
      const geometryId = 200000 + index * 2;
      const modelId = geometryId + 1;
      const indices = node.indices;
      const polygon = new Array(indices.length);
      for (let i = 0; i < indices.length; i += 1) {
        /* The last index of a polygon is stored bitwise-negated. */
        polygon[i] = (i % 3 === 2) ? ~indices[i] : indices[i];
      }
      out.push(`\tGeometry: ${geometryId}, "Geometry::${fbxName(node.name).slice(1, -1)}", "Mesh" {`);
      out.push(`\t\tVertices: ${fbxArray(node.positions)}`);
      out.push(`\t\tPolygonVertexIndex: ${fbxArray(polygon)}`);
      out.push('\t\tGeometryVersion: 124');
      if (node.normals && node.normals.length === node.positions.length) {
        out.push('\t\tLayerElementNormal: 0 {');
        out.push('\t\t\tVersion: 101');
        out.push('\t\t\tName: ""');
        out.push('\t\t\tMappingInformationType: "ByVertice"');
        out.push('\t\t\tReferenceInformationType: "Direct"');
        out.push(`\t\t\tNormals: ${fbxArray(node.normals)}`);
        out.push('\t\t}');
      }
      if (node.uvs && node.uvs.length >= node.vertexCount * 2) {
        out.push('\t\tLayerElementUV: 0 {');
        out.push('\t\t\tVersion: 101');
        out.push('\t\t\tName: "UVMap"');
        out.push('\t\t\tMappingInformationType: "ByVertice"');
        out.push('\t\t\tReferenceInformationType: "Direct"');
        out.push(`\t\t\tUV: ${fbxArray(node.uvs)}`);
        out.push('\t\t}');
      }
      out.push('\t\tLayerElementMaterial: 0 {');
      out.push('\t\t\tVersion: 101');
      out.push('\t\t\tName: ""');
      out.push('\t\t\tMappingInformationType: "AllSame"');
      out.push('\t\t\tReferenceInformationType: "IndexToDirect"');
      out.push('\t\t\tMaterials: *1 {\n\t\t\t\t0\n\t\t\t}');
      out.push('\t\t}');
      out.push('\t\tLayer: 0 {');
      out.push('\t\t\tVersion: 100');
      if (node.normals) out.push('\t\t\tLayerElement:  { Type: "LayerElementNormal" TypedIndex: 0 }');
      if (node.uvs) out.push('\t\t\tLayerElement:  { Type: "LayerElementUV" TypedIndex: 0 }');
      out.push('\t\t\tLayerElement:  { Type: "LayerElementMaterial" TypedIndex: 0 }');
      out.push('\t\t}');
      out.push('\t}');

      out.push(`\tModel: ${modelId}, "Model::${fbxName(node.name).slice(1, -1)}", "Mesh" {`);
      out.push('\t\tVersion: 232');
      out.push('\t\tProperties70:  {');
      out.push(fbxProperty('Lcl Translation', 'Lcl Translation', '', 'A', '0,0,0'));
      out.push(fbxProperty('Lcl Rotation', 'Lcl Rotation', '', 'A', '0,0,0'));
      out.push(fbxProperty('Lcl Scaling', 'Lcl Scaling', '', 'A', '1,1,1'));
      out.push(fbxProperty('DefaultAttributeIndex', 'int', 'Integer', '', '0'));
      out.push('\t\t}');
      out.push('\t\tShading: T');
      out.push('\t\tCulling: "CullingOff"');
      out.push('\t}');
    });

    const materialIdOf = new Map();
    materials.forEach((material, index) => {
      const id = 400000 + index;
      materialIdOf.set(material, id);
      const [r, g, b, a] = material.baseColor;
      const shininess = Math.max(1, (1 - material.roughness) * 100);
      out.push(`\tMaterial: ${id}, "Material::${fbxName(material.name).slice(1, -1)}", "" {`);
      out.push('\t\tVersion: 102');
      out.push('\t\tShadingModel: "phong"');
      out.push('\t\tMultiLayer: 0');
      out.push('\t\tProperties70:  {');
      out.push(fbxProperty('DiffuseColor', 'Color', '', 'A', `${fbxFloat(r)},${fbxFloat(g)},${fbxFloat(b)}`));
      out.push(fbxProperty('DiffuseFactor', 'Number', 'float', 'A', '1'));
      out.push(fbxProperty('SpecularColor', 'Color', '', 'A', `${fbxFloat(1 - material.roughness)},${fbxFloat(1 - material.roughness)},${fbxFloat(1 - material.roughness)}`));
      out.push(fbxProperty('SpecularFactor', 'Number', 'float', 'A', fbxFloat(1 - material.roughness * 0.8)));
      out.push(fbxProperty('ShininessExponent', 'Number', 'float', 'A', fbxFloat(shininess)));
      out.push(fbxProperty('TransparencyFactor', 'Number', 'float', 'A', fbxFloat(1 - a)));
      out.push(fbxProperty('EmissiveColor', 'Color', '', 'A', material.emissive ? `${fbxFloat(material.emissive[0])},${fbxFloat(material.emissive[1])},${fbxFloat(material.emissive[2])}` : '0,0,0'));
      out.push(fbxProperty('EmissiveFactor', 'Number', 'float', 'A', material.emissive && (material.emissive[0] || material.emissive[1] || material.emissive[2]) ? '1' : '0'));
      out.push('\t\t}');
      out.push('\t}');
    });

    out.push('}');
    out.push('Connections:  {');
    list.forEach((node, index) => {
      const geometryId = 200000 + index * 2;
      const modelId = geometryId + 1;
      out.push(`\tC: "OO",${modelId},0`);
      out.push(`\tC: "OO",${geometryId},${modelId}`);
      const materialId = node.material ? materialIdOf.get(node.material) : undefined;
      if (materialId !== undefined) out.push(`\tC: "OO",${materialId},${modelId}`);
    });
    out.push('}');
    out.push('');
    return out.join('\n');
  }

  /* The distinct materials an OBJ export references, in file order, for MTL. */
  function materialsOf(nodes) {
    const seen = new Set();
    const out = [];
    (nodes || []).forEach((node) => {
      const material = node.material;
      if (material && !seen.has(material.name)) { seen.add(material.name); out.push(material); }
    });
    return out;
  }

  /* ---- public surface ---------------------------------------------------- */

  const api = {
    VERSION: 1,
    HELPER_NAMES,
    isHelperObject,
    isVisibleInHierarchy,
    isExportableGeometry,
    triangleCount,
    collect,
    bakeGeometry,
    bakeInstanced,
    bakeGeometrySoftware,
    bakeInstancedSoftware,
    describeMaterial,
    sanitize,
    multiply,
    transformPoint,
    normalMatrix,
    buildGLB,
    buildGLTF,
    buildOBJ,
    buildOBJSoftware,
    buildMTL,
    buildMTLSoftware,
    objFloat,
    buildFBX,
    materialsOf,
    align4
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  global.FEWorkspaceExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
