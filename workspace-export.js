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

  /* One mesh, transformed into world space. Returns typed arrays only, so the
     caller decides how to package them (glTF buffers, OBJ text, …). */
  function bakeGeometry(geometry, matrix) {
    const attributes = geometry.attributes || {};
    const position = attributes.position;
    if (!position || !position.array) return null;
    const count = position.count;
    const m = matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
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
     instancing, so the copies are baked into a single primitive here — the
     export looks like the viewport instead of like one plant at the origin. */
  function bakeInstanced(object, options) {
    const opts = options || {};
    const base = object.matrixWorld ? object.matrixWorld.elements : null;
    const instanceArray = object.instanceMatrix && object.instanceMatrix.array;
    if (!base || !instanceArray) return null;
    const total = Math.max(1, object.count | 0);
    const limit = Number(opts.maxInstances) > 0 ? Math.min(total, Number(opts.maxInstances)) : total;

    let first = null;
    for (let i = 0; i < limit; i++) {
      const slice = Array.prototype.slice.call(instanceArray, i * 16, i * 16 + 16);
      const baked = bakeGeometry(object.geometry, multiply(base, slice));
      if (!baked) return null;
      if (!first) first = baked;
      else first = concat(first, baked);
    }
    if (first) first.instanceCount = limit;
    return first;
  }

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

  function objFloat(value) {
    if (!isFinite(value)) return '0';
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded === 0 ? 0 : rounded);
  }

  function buildMTL(materials) {
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
    describeMaterial,
    sanitize,
    multiply,
    transformPoint,
    normalMatrix,
    buildGLB,
    buildGLTF,
    buildOBJ,
    buildMTL,
    materialsOf,
    align4
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  global.FEWorkspaceExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
