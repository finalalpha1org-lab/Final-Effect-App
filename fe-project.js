/* =========================================================================
   fe-project.js — the project file (.fe3d and .fe3a)

   One project, two containers. Both carry the whole project and either one can
   be opened back into the app: `.fe3d` is the current project file, `.fe3a` is
   the same project written with the companion tag, and the older `.final3d`
   files still open (they carry camera, lighting and animation but no meshes, so
   the app says so instead of pretending).

   Nothing here invents a second scene description. The project is captured with
   the same two round trips the app already trusts for its own session recovery:
   the engine's autosave (every scene object, its geometry, materials, userData
   and the cameras, through THREE's own ObjectLoader) and the core engine's
   animation blob (every keyframe, plus the object-to-slot map, straight out of
   the C++ side). Loading feeds both back through their own deserializers, so
   what comes out of a file is what went into it, and the parts of the app that
   already restore autosaves do the work.

   Container: 4 magic bytes, then a little-endian uint32 payload length, then the
   UTF-8 JSON payload. `.fe3d` = "FE3D", `.fe3a` = "FE3A", `.final3d` = "F3D" +
   version byte, which is exactly what the old exporter wrote.
   ========================================================================= */
(function (global) {
  'use strict';

  const MAGIC_FE3D = [0x46, 0x45, 0x33, 0x44];
  const MAGIC_FE3A = [0x46, 0x45, 0x33, 0x41];
  const MAGIC_OLD = [0x46, 0x33, 0x44];

  const FORMAT = 'FE3D_PROJECT';
  const VERSION = '2.0';
  const GENERATOR = 'Final Effect 3D Suite';

  const EXTENSIONS = { fe3d: 'fe3d', fe3a: 'fe3a', final3d: 'final3d' };

  function engine() {
    return (global.FE && global.FE.engines && global.FE.engines.core) || null;
  }

  function core() {
    return global.FECppEngine || null;
  }

  function projectName() {
    const el = global.document && global.document.getElementById('project-name');
    const text = el && String(el.value || el.textContent || '').trim();
    return text || 'MyProject';
  }

  /* ---------------------------------------------------------------- write -- */

  function timelineSnapshot() {
    const t = global.timelineConfig;
    if (!t) return null;
    const pick = ['fps', 'startFrame', 'endFrame', 'currentFrame', 'playing', 'loop', 'keyingSet', 'totalFrames'];
    const out = {};
    for (const key of pick) if (t[key] !== undefined) out[key] = t[key];
    return out;
  }

  /* What went into the file, so opening it can say what came back out. Helpers
     (grid, gizmo, cursor, floors) are left out: they are not part of a project,
     they exist in every session. */
  function sceneCounts() {
    const eng = engine();
    const counts = { objects: 0, meshes: 0, triangles: 0, vertices: 0, materials: 0 };
    if (!eng || !eng.sc) return counts;
    eng.sc.traverse((obj) => {
      if (!obj || !(obj.isMesh || obj.isPoints || obj.isLine)) return;
      if (isFurniture(obj)) return;
      counts.meshes++;
      const geo = obj.geometry;
      if (geo && geo.attributes && geo.attributes.position) {
        counts.vertices += geo.attributes.position.count;
        const index = geo.index;
        counts.triangles += index ? Math.floor(index.count / 3) : Math.floor(geo.attributes.position.count / 3);
      }
      if (obj.material) counts.materials += Array.isArray(obj.material) ? obj.material.length : 1;
    });
    return counts;
  }

  const FURNITURE = /^(grid|floor|shadowfloor|cursor3d|gizmo|transformcontrols|selectionbox|blendercam|blenderlight|annotation|selectionoutlinehelper|modifierhelper|editcage)/i;
  const FURNITURE_NAMES = new Set(['Cursor3D', 'StudioFloor', 'ShadowFloor', 'GridHelper']);

  function isFurniture(obj) {
    let node = obj;
    let depth = 0;
    while (node && depth++ < 8) {
      if (node.userData && (node.userData.feOnionGhost || node.userData.feHelper || node.userData.forceModUpdate === undefined && false)) return true;
      if (node.isGridHelper || node.isCamera || node.isLight || node.isTransformControls || node.isBoxHelper) return true;
      if (node === engine() || node === (engine() && engine().sc)) break;
      if (node.parent === (engine() && engine().sc)) break;
      node = node.parent;
    }
    if (obj.name && FURNITURE_NAMES.has(obj.name)) return true;
    let current = obj;
    let up = 0;
    while (current && up++ < 6) {
      if (current.name && FURNITURE.test(current.name)) return true;
      current = current.parent;
    }
    return false;
  }

  /* Materials travel with the scene, but the app's own object registration puts a
     default material on a freshly restored object, and the geometry is rebuilt by
     THREE's loader either from raw arrays or from the parameters of a procedural
     shape. The file therefore also lists the material of every object by the
     object's own uuid, and opening the file puts those back afterwards. */
  const MATERIAL_PROPS = ['color', 'emissive', 'roughness', 'metalness', 'opacity', 'transparent', 'wireframe', 'flatShading', 'side', 'vertexColors', 'envMapIntensity', 'emissiveIntensity', 'depthWrite', 'alphaTest'];

  function describeMaterial(material) {
    if (!material || Array.isArray(material)) {
      return Array.isArray(material) ? material.map((one) => describeMaterial(one)) : null;
    }
    const out = { type: material.type || null, name: material.name || '', uuid: material.uuid || null };
    for (const key of MATERIAL_PROPS) {
      const value = material[key];
      if (value === undefined) continue;
      out[key] = (value && typeof value.getHex === 'function') ? '#' + value.getHexString() : value;
    }
    return out;
  }

  function applyMaterial(target, description) {
    if (!target || !description) return false;
    if (Array.isArray(description)) {
      const list = Array.isArray(target.material) ? target.material : [target.material];
      let any = false;
      description.forEach((one, i) => { if (list[i]) any = applyMaterialProps(list[i], one) || any; });
      return any;
    }
    return applyMaterialProps(target.material, description);
  }

  function applyMaterialProps(material, description) {
    if (!material || !description) return false;
    let touched = false;
    for (const key of MATERIAL_PROPS) {
      if (description[key] === undefined) continue;
      const value = description[key];
      if (key === 'color' || key === 'emissive') {
        if (typeof value === 'string' && material[key] && material[key].setStyle) { material[key].setStyle(value); touched = true; }
        continue;
      }
      if (description[key] !== material[key]) { material[key] = value; touched = true; }
    }
    if (typeof material.needsUpdate !== 'undefined') material.needsUpdate = true;
    return touched;
  }

  function collectMaterials() {
    const eng = engine();
    const out = [];
    if (!eng || !eng.sc) return out;
    eng.sc.traverse((obj) => {
      if (!obj || !obj.uuid) return;
      if (!(obj.isMesh || obj.isPoints || obj.isLine)) return;
      if (isFurniture(obj)) return;
      const described = describeMaterial(obj.material);
      if (described) out.push({ uuid: obj.uuid, name: obj.name || '', material: described });
    });
    return out;
  }

  function applyCollectedMaterials(list, summary) {
    const eng = engine();
    if (!eng || !eng.sc || !Array.isArray(list)) return 0;
    const byUuid = new Map();
    eng.sc.traverse((obj) => { if (obj && obj.uuid) byUuid.set(obj.uuid, obj); });
    let applied = 0;
    const unmatched = [];
    for (const entry of list) {
      const target = byUuid.get(entry.uuid);
      if (!target) { unmatched.push(entry.name || entry.uuid); continue; }
      if (applyMaterial(target, entry.material)) applied++;
    }
    if (unmatched.length && summary) summary.warnings.push('These objects were not found in the restored scene, so their materials were left as they are: ' + unmatched.slice(0, 5).join(', ') + (unmatched.length > 5 ? '…' : ''));
    return applied;
  }

  function keyframeCount() {
    const c = core();
    try {
      if (c && c.ready && c.exports && c.exports.fe_anim_get_total_keyframes) return c.exports.fe_anim_get_total_keyframes();
    } catch (_) { /* kernel not up yet */ }
    return 0;
  }

  function buildPayload(meta) {
    const eng = engine();
    const c = core();
    const options = meta || {};
    const payload = {
      format: FORMAT,
      version: VERSION,
      generator: GENERATOR,
      timestamp: new Date().toISOString(),
      projectName: options.projectName || projectName(),
      engine: {
        autosave: eng && typeof eng.serializeAutosave === 'function' ? eng.serializeAutosave() : null,
        animation: c && typeof c.serializeAnimation === 'function' ? c.serializeAnimation() : null
      },
      timeline: timelineSnapshot(),
      polygon: { module: global.FEPoly ? 'fe-poly' : null },
      materials: collectMaterials(),
      counts: { scene: sceneCounts(), keyframes: keyframeCount() }
    };
    if (!payload.engine.autosave) throw new Error('The 3D workspace is not ready to be saved yet.');
    return payload;
  }

  /* ---------------------------------------------------------------- bytes -- */

  function encode(text) {
    if (global.TextEncoder) return new global.TextEncoder().encode(text);
    const bytes = new Uint8Array(text.length * 4);
    let written = 0;
    for (let i = 0; i < text.length; i++) {
      let code = text.codePointAt(i);
      if (code > 0xffff) i++;
      if (code < 0x80) bytes[written++] = code;
      else if (code < 0x800) { bytes[written++] = 0xc0 | (code >> 6); bytes[written++] = 0x80 | (code & 63); }
      else if (code < 0x10000) { bytes[written++] = 0xe0 | (code >> 12); bytes[written++] = 0x80 | ((code >> 6) & 63); bytes[written++] = 0x80 | (code & 63); }
      else { bytes[written++] = 0xf0 | (code >> 18); bytes[written++] = 0x80 | ((code >> 12) & 63); bytes[written++] = 0x80 | ((code >> 6) & 63); bytes[written++] = 0x80 | (code & 63); }
    }
    return bytes.subarray(0, written);
  }

  function decode(bytes) {
    if (global.TextDecoder) return new global.TextDecoder('utf-8').decode(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      else if (b < 0xf0) out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else {
        const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        out += String.fromCodePoint(cp);
      }
    }
    return out;
  }

  function magicFor(kind) {
    if (kind === 'fe3a') return MAGIC_FE3A;
    if (kind === 'final3d') return MAGIC_OLD.concat([0x01]);
    return MAGIC_FE3D;
  }

  function writeContainer(payload, kind) {
    const json = JSON.stringify(payload);
    const body = encode(json);
    const magic = magicFor(kind);
    const buffer = new ArrayBuffer(magic.length + 4 + body.length);
    const view = new DataView(buffer);
    magic.forEach((byte, i) => view.setUint8(i, byte));
    view.setUint32(magic.length, body.length, true);
    new Uint8Array(buffer).set(body, magic.length + 4);
    return { buffer, bytes: buffer.byteLength, json };
  }

  function readContainer(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const at = (i) => view.getUint8(i);
    const starts = (magic) => magic.every((byte, i) => at(i) === byte);
    let kind = null;
    let header = 4;
    if (starts(MAGIC_FE3D)) kind = 'fe3d';
    else if (starts(MAGIC_FE3A)) kind = 'fe3a';
    else if (MAGIC_OLD.every((byte, i) => at(i) === byte)) { kind = 'final3d'; header = 4; }
    else throw new Error('This is not a Final Effect 3D project file (the header is not FE3D, FE3A or F3D).');
    const length = view.getUint32(header, true);
    if (length <= 0 || header + 4 + length > arrayBuffer.byteLength) {
      throw new Error('This project file is incomplete: it claims ' + length + ' bytes of data but carries ' + Math.max(0, arrayBuffer.byteLength - header - 4) + '.');
    }
    const body = new Uint8Array(arrayBuffer, header + 4, length);
    let payload;
    try {
      payload = JSON.parse(decode(body));
    } catch (err) {
      throw new Error('This project file could not be read: ' + err.message);
    }
    return { kind, payload, headerVersion: kind === 'final3d' ? at(3) : null };
  }

  /* ---------------------------------------------------------------- apply -- */

  function restoreTimeline(snapshot) {
    if (!snapshot || !global.timelineConfig) return false;
    const t = global.timelineConfig;
    for (const key of Object.keys(snapshot)) t[key] = snapshot[key];
    if (typeof global.renderTimelineRulerCanvas === 'function') global.renderTimelineRulerCanvas();
    if (typeof global.refreshAnimationStudioUI === 'function') global.refreshAnimationStudioUI();
    if (typeof global.syncKeyButtonStates === 'function') global.syncKeyButtonStates();
    return true;
  }

  /* The old .final3d payload: camera, lighting and the animation blob only. It
     is applied for what it does carry and reported for what it does not. */
  function applyLegacy(payload, summary) {
    const eng = engine();
    if (!eng) throw new Error('The 3D workspace is not ready yet.');
    /* The engine keeps two cameras (the viewport camera and the scene camera the
       renderer uses) under their own names, not under `cam`. */
    const cameras = [eng.sceneCamera, eng.viewportCamera, eng.cam].filter(Boolean);
    const camera = payload.camera || {};
    if (eng.oc && eng.oc.target && Array.isArray(camera.target)) eng.oc.target.fromArray(camera.target);
    cameras.forEach((one) => {
      if (Array.isArray(camera.position)) one.position.fromArray(camera.position);
      if (Number.isFinite(camera.fov)) one.fov = camera.fov;
      if (Number.isFinite(camera.near)) one.near = camera.near;
      if (Number.isFinite(camera.far)) one.far = camera.far;
      one.updateProjectionMatrix && one.updateProjectionMatrix();
      one.updateMatrixWorld && one.updateMatrixWorld(true);
      if (eng.oc && typeof eng.oc.update === 'function') eng.oc.update();
    });
    summary.cameras = cameras.length;
    const lighting = payload.lighting || {};
    if (eng.r && Number.isFinite(lighting.exposure)) eng.r.toneMappingExposure = lighting.exposure;
    if (eng.d && lighting.sun) {
      if (lighting.sun.color) eng.d.color.setStyle('#' + lighting.sun.color);
      if (Number.isFinite(lighting.sun.intensity)) eng.d.intensity = lighting.sun.intensity;
      if (Array.isArray(lighting.sun.position)) eng.d.position.fromArray(lighting.sun.position);
    }
    if (eng.amb && lighting.ambient) {
      if (lighting.ambient.color) eng.amb.color.setStyle('#' + lighting.ambient.color);
      if (Number.isFinite(lighting.ambient.intensity)) eng.amb.intensity = lighting.ambient.intensity;
    }
    if (payload.animation) {
      const c = core();
      if (c && typeof c.deserializeAnimation === 'function') {
        c.deserializeAnimation(payload.animation);
        summary.keyframes = keyframeCount();
      }
    }
    summary.legacy = true;
    summary.warnings.push('This is an older .final3d file: it stores the camera, the lighting and the animation, but no mesh data, so the objects in it cannot be rebuilt.');
  }

  async function applyPayload(payload, summary) {
    const eng = engine();
    const c = core();
    if (!payload || typeof payload !== 'object') throw new Error('This project file has no data in it.');

    if (payload.format === 'FINAL3D_BINARY') { applyLegacy(payload, summary); return summary; }
    if (payload.format !== FORMAT) throw new Error('This project file was written by a different program (' + String(payload.format) + ').');

    const autosave = payload.engine && payload.engine.autosave;
    if (!autosave) throw new Error('This project file has no scene in it.');
    if (!eng || typeof eng.restoreAutosave !== 'function') throw new Error('The 3D workspace is not ready yet.');

    const restored = await eng.restoreAutosave(autosave);
    if (restored === false) throw new Error('The scene in this project file could not be restored.');

    if (payload.engine.animation && c && typeof c.deserializeAnimation === 'function') {
      c.deserializeAnimation(payload.engine.animation);
    }
    restoreTimeline(payload.timeline);

    if (typeof global.updateModifiersOnScene === 'function') {
      try { global.updateModifiersOnScene(true); } catch (err) { summary.warnings.push('Modifiers were not re-evaluated: ' + err.message); }
    }
    if (typeof global.clearMeshSelectionOutline === 'function') {
      try { global.clearMeshSelectionOutline(); global.selectObject && global.selectObject(engine() && engine().cube); } catch (_) {}
    }
    if (typeof global.applyShadingMode === 'function' && autosave.camera && autosave.camera.shading) {
      try { global.applyShadingMode(autosave.camera.shading); } catch (_) {}
    }
    summary.scene = sceneCounts();
    summary.keyframes = keyframeCount();
    summary.materialsApplied = applyCollectedMaterials(payload.materials, summary);
    summary.materialsInFile = Array.isArray(payload.materials) ? payload.materials.length : 0;
    return summary;
  }

  /* ------------------------------------------------------------- workflow -- */

  function downloadBytes(bytes, filename) {
    const blob = new global.Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = global.document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    global.document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 1000);
  }

  function describe(summary) {
    const parts = [];
    if (summary.scene) {
      parts.push(summary.scene.meshes + ' mesh' + (summary.scene.meshes === 1 ? '' : 'es'));
      parts.push(summary.scene.triangles.toLocaleString() + ' triangles');
    }
    parts.push(summary.keyframes + ' keyframe' + (summary.keyframes === 1 ? '' : 's'));
    return parts.join(' · ');
  }

  function exportProject(kind) {
    const payload = buildPayload();
    const { buffer, bytes } = writeContainer(payload, kind);
    const name = payload.projectName.replace(/[^\w.\-]+/g, '_') + '.' + EXTENSIONS[kind];
    downloadBytes(buffer, name);
    return { name, bytes, payload };
  }

  async function importFile(file) {
    if (!file) throw new Error('No file was chosen.');
    const buffer = await file.arrayBuffer();
    const { kind, payload } = readContainer(buffer);
    const summary = { kind, file: file.name, bytes: file.size, keyframes: 0, scene: null, legacy: false, warnings: [], projectName: payload.projectName || null, savedAt: payload.timestamp || null, version: payload.version || null };
    await applyPayload(payload, summary);
    return summary;
  }

  async function importArrayBuffer(buffer, name) {
    const { kind, payload } = readContainer(buffer);
    const summary = { kind, file: name || '(buffer)', bytes: buffer.byteLength, keyframes: 0, scene: null, legacy: false, warnings: [], projectName: payload.projectName || null, savedAt: payload.timestamp || null, version: payload.version || null };
    await applyPayload(payload, summary);
    return summary;
  }

  global.FEProject = {
    FORMAT,
    VERSION,
    EXTENSIONS,
    /* introspection for tests */
    buildPayload,
    sceneCounts,
    isFurniture,
    collectMaterials,
    applyCollectedMaterials,
    describeMaterial,
    keyframeCount,
    timelineSnapshot,
    writeContainer,
    readContainer,
    applyPayload,
    restoreTimeline,
    exportProject,
    importFile,
    importArrayBuffer,
    describe
  };
})(typeof window !== 'undefined' ? window : globalThis);