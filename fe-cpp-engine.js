/* =========================================================================
 * Final Effect 3D — Thin HTML/JS Bridge for the C++20 Core Engine (WASM)
 * Connects Keyframe Animation Studio, Progressive C++ Path Tracer & Eevee
 * Post-FX Render Engine, C++ Mesh Sculpt/Vertex Paint, Mobile Touch HUD,
 * Adaptive Mobile GPU Governor, and Cross-Platform PWA Installability.
 * ========================================================================= */
(function () {
  'use strict';

  const CH = {
    POS_X: 0, POS_Y: 1, POS_Z: 2,
    ROT_X: 3, ROT_Y: 4, ROT_Z: 5,
    SCL_X: 6, SCL_Y: 7, SCL_Z: 8,
    EXTRA_A: 9, EXTRA_B: 10, COUNT: 11
  };

  const CHANNEL_LABELS = [
    'Location X', 'Location Y', 'Location Z',
    'Rotation X°', 'Rotation Y°', 'Rotation Z°',
    'Scale X', 'Scale Y', 'Scale Z',
    'Lens FOV / Intensity', 'Roughness'
  ];

  const CHANNEL_COLORS = [
    '#ef4444', '#22c55e', '#3b82f6',
    '#f97316', '#84cc16', '#06b6d4',
    '#ec4899', '#a855f7', '#6366f1',
    '#fbbf24', '#94a3b8'
  ];

  const RAD2DEG = 180 / Math.PI;
  const DEG2RAD = Math.PI / 180;

  /* -----------------------------------------------------------------------
   * 1. C++20 WASM Loader & Linear Memory Marshal
   * ----------------------------------------------------------------------- */
  const FECppEngine = {
    ready: false,
    wasm: null,
    exports: null,
    memory: null,
    loadError: null,
    autoKey: false,
    currentInterp: 0, // 0=Bezier Smooth
    sculptState: {
      activeMode: 'object',
      brush: 0, // 0=Draw, 1=Smooth, 2=Inflate, 3=Pinch, 4=Flatten, 5=Grab
      invert: false,
      radius: 0.48,
      strength: 0.55,
      symmetryX: true,
      paintColor: '#6366f1',
      strokeActive: false,
      lastLocalHit: null
    },
    renderState: {
      engine: 'cycles_cpp', // 'cycles_cpp' | 'eevee_cpp'
      aspectPreset: '9:16', // Default mobile-editor friendly preset, switchable to 16:9, 1:1, 21:9
      resScale: 'hd',       // 'draft' | 'hd' | 'fhd'
      targetSamples: 32,
      bounces: 2,
      tonemap: 0,           // 0=ACES, 1=AgX, 2=Reinhard, 3=Filmic, 4=Linear
      exposure: 1.25,
      contrast: 1.05,
      saturation: 1.08,
      temperature: 0.0,
      bloom: 0.22,
      vignette: 0.18,
      chromatic: 0.0,
      grain: 0.02,
      shadowCatcher: true,
      isRendering: false,
      isSequenceRendering: false,
      cancelRequested: false,
      rafId: 0
    },
    objectSlots: new Map([
      ['cube', 0],
      ['camera', 1],
      ['light', 2]
    ]),
    nextCustomSlot: 3,
    deferredInstallPrompt: null,
    gpuModeOverride: 0, // 0=Auto, 1=Low, 2=Medium, 3=High
    lastPerfUpdate: 0,
    lastFrameTick: performance.now(),

    async init() {
      if (this.ready && this.exports) return this.exports;
      const mountWasmBuffer = async buf => {
        const mod = await WebAssembly.compile(buf);
        const inst = await WebAssembly.instantiate(mod, {});
        const exp = inst.exports;
        if (typeof exp.fe_core_abi_version !== 'function' || exp.fe_core_abi_version() !== 1) {
          throw new Error('Unexpected engine ABI version');
        }
        this.wasm = inst;
        this.exports = exp;
        this.memory = exp.memory;
        this.ready = true;
        this.loadError = null;
        exp.fe_anim_reset();
        exp.fe_touch_reset();
        exp.fe_perf_reset();
        updateCppStatusBadges();
        return exp;
      };

      /* Support 1-file Standalone Portable HTML mode (works on file:// & mobile Downloads!) */
      if (typeof window !== 'undefined' && typeof window.__FE_CPP_WASM_BASE64__ === 'string' && window.__FE_CPP_WASM_BASE64__.length > 64) {
        try {
          const bin = atob(window.__FE_CPP_WASM_BASE64__);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return await mountWasmBuffer(bytes.buffer);
        } catch (err) {
          console.warn('[FECppEngine] Embedded WASM decode failed, trying network:', err);
        }
      }

      const urls = ['./fe_core_engine.wasm', './wasm/fe_core_engine.wasm'];
      let lastErr = null;
      for (const rel of urls) {
        try {
          const url = new URL(rel, document.baseURI || window.location.href).href;
          const res = await fetch(url, { cache: 'no-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
          const buf = await res.arrayBuffer();
          return await mountWasmBuffer(buf);
        } catch (err) {
          lastErr = err;
        }
      }
      this.loadError = lastErr;
      console.warn('[FECppEngine] Could not load fe_core_engine.wasm:', lastErr);
      updateCppStatusBadges();
      return null;
    },

    allocF32(length) {
      const ptr = this.exports.fe_malloc(length * 4);
      return { ptr, view: new Float32Array(this.memory.buffer, ptr, length) };
    },

    allocU32(length) {
      const ptr = this.exports.fe_malloc(length * 4);
      return { ptr, view: new Uint32Array(this.memory.buffer, ptr, length) };
    },

    allocU8(length) {
      const ptr = this.exports.fe_malloc(length);
      return { ptr, view: new Uint8Array(this.memory.buffer, ptr, length) };
    },

    getSlotForObjectId(objId) {
      if (!objId || objId === 'none') return 0;
      if (this.objectSlots.has(objId)) return this.objectSlots.get(objId);
      const slot = this.nextCustomSlot < 95 ? this.nextCustomSlot++ : 95;
      this.objectSlots.set(objId, slot);
      return slot;
    },

    resolveObjectById(objId) {
      const eng = window.FE?.engines?.core;
      if (!eng) return null;
      if (objId === 'cube') return eng.cube || null;
      if (objId === 'camera') return eng.blenderCam || null;
      if (objId === 'light') return eng.blenderLight || null;
      return eng.customObjects?.[objId] || null;
    },

    readObjectChannels11(objId) {
      const eng = window.FE?.engines?.core;
      const obj = this.resolveObjectById(objId);
      const out = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 50, 0.5]);
      if (!obj) return out;

      out[0] = obj.position.x;
      out[1] = obj.position.y;
      out[2] = obj.position.z;
      out[3] = obj.rotation.x * RAD2DEG;
      out[4] = obj.rotation.y * RAD2DEG;
      out[5] = obj.rotation.z * RAD2DEG;
      out[6] = Math.max(0.01, obj.scale.x);
      out[7] = Math.max(0.01, obj.scale.y);
      out[8] = Math.max(0.01, obj.scale.z);

      if (objId === 'camera' && eng?.sceneCamera) {
        out[9] = eng.sceneCamera.isPerspectiveCamera ? eng.sceneCamera.fov : 39.6;
      } else if (objId === 'light' && eng?.blenderLight?.light) {
        out[9] = eng.blenderLight.light.intensity ?? 2.5;
      } else if (obj.material && typeof obj.material.roughness === 'number') {
        out[10] = obj.material.roughness;
      }
      return out;
    },

    ensureObjectSynced(objId) {
      if (!this.ready) return -1;
      const slot = this.getSlotForObjectId(objId);
      if (this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) {
        this.exports.fe_arena_reset();
        const ch = this.readObjectChannels11(objId);
        const buf = this.allocF32(11);
        buf.view.set(ch);
        this.exports.fe_anim_ensure_object(slot, buf.ptr);
      }
      return slot;
    },

    /* ---- Keyframe Operations (C++ Backed) ---- */
    insertKeyframeForActive(group = 'locrotscale', silent = false) {
      if (!this.ready) {
        window.FE?.toast?.('Engine still starting…');
        return 0;
      }
      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const obj = this.resolveObjectById(objId);
      if (!obj) return 0;

      const slot = this.getSlotForObjectId(objId);
      const frame = Number(window.timelineConfig?.currentFrame || 0);
      const ch = this.readObjectChannels11(objId);

      this.exports.fe_arena_reset();
      const restBuf = this.allocF32(11);
      restBuf.view.set(ch);
      this.exports.fe_anim_ensure_object(slot, restBuf.ptr);

      let channelsToKey = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      if (group === 'loc') channelsToKey = [0, 1, 2];
      else if (group === 'rot') channelsToKey = [3, 4, 5];
      else if (group === 'scale') channelsToKey = [6, 7, 8];
      else if (group === 'extra') channelsToKey = [9, 10];
      else if (group === 'all') channelsToKey = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      if (objId === 'camera' || objId === 'light') {
        channelsToKey = channelsToKey.filter(c => c < 6 || c === 9);
        if (group === 'locrotscale') channelsToKey.push(9);
      }

      for (const c of channelsToKey) {
        this.exports.fe_anim_insert_keyframe(slot, c, frame, ch[c], this.currentInterp);
      }

      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
      if (!silent) {
        const name = window.getActiveObjectDisplayName?.() || objId;
        window.FE?.toast?.(`◆ Keyframed ${name} at frame ${frame}`);
      }
      return channelsToKey.length;
    },

    deleteKeyframeAtCurrentFrame() {
      if (!this.ready) return 0;
      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const slot = this.getSlotForObjectId(objId);
      const frame = Number(window.timelineConfig?.currentFrame || 0);
      const removed = this.exports.fe_anim_remove_keyframe_at(slot, 0xFFFFFFFF, frame, 0.5);
      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
      window.FE?.toast?.(removed > 0 ? `Removed ${removed} keyframe channel(s) at Frame ${frame}` : `No keyframe on Frame ${frame}`);
      return removed;
    },

    clearActiveObjectAnimation() {
      if (!this.ready) return;
      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const slot = this.getSlotForObjectId(objId);
      this.exports.fe_anim_clear_object(slot);
      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
      window.FE?.toast?.(`Cleared animation keys for ${window.getActiveObjectDisplayName?.() || objId}`);
    },

    applyMotionPreset(presetId) {
      if (!this.ready) return;
      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const obj = this.resolveObjectById(objId);
      if (!obj) return;
      const slot = this.getSlotForObjectId(objId);
      const startF = Number(window.timelineConfig?.startFrame || 0);
      const endF = Math.max(startF + 10, Number(window.timelineConfig?.endFrame || 250));
      const ampEl = document.getElementById('anim-preset-amp');
      const amp = ampEl ? Math.max(0.1, Number(ampEl.value) || 1.0) : 1.0;

      this.exports.fe_arena_reset();
      const ch = this.readObjectChannels11(objId);
      const baseBuf = this.allocF32(11);
      baseBuf.view.set(ch);
      this.exports.fe_anim_apply_preset(slot, presetId, startF, endF, amp, baseBuf.ptr);

      this.evaluateSceneAtFrame(Number(window.timelineConfig?.currentFrame || 0));
      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
      const presetNames = ['Turntable 360°', 'Float Hover', 'Squash & Bounce', 'Pendulum', 'Camera Orbit', 'Pulse Scale'];
      window.FE?.toast?.(`Applied motion preset: ${presetNames[presetId] || 'Motion'}`);
    },

    evaluateSceneAtFrame(frame) {
      if (!this.ready || this.exports.fe_anim_get_total_keyframes() === 0) return false;
      const eng = window.FE?.engines?.core;
      if (!eng) return false;

      const startF = Number(window.timelineConfig?.startFrame || 0);
      const endF = Number(window.timelineConfig?.endFrame || 250);
      this.exports.fe_arena_reset();
      const outBuf = this.allocF32(15);
      let updatedAny = false;

      for (const [objId, slot] of this.objectSlots.entries()) {
        if (this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) continue;
        const obj = this.resolveObjectById(objId);
        if (!obj) continue;

        const hasKeys = this.exports.fe_anim_evaluate_object(slot, frame, startF, endF, outBuf.ptr);
        if (hasKeys <= 0) continue;

        const v = outBuf.view;
        if (this.exports.fe_anim_get_keyframe_count(slot, 0) > 0) obj.position.x = v[0];
        if (this.exports.fe_anim_get_keyframe_count(slot, 1) > 0) obj.position.y = v[1];
        if (this.exports.fe_anim_get_keyframe_count(slot, 2) > 0) obj.position.z = v[2];

        const rotKeyed =
          this.exports.fe_anim_get_keyframe_count(slot, 3) > 0 ||
          this.exports.fe_anim_get_keyframe_count(slot, 4) > 0 ||
          this.exports.fe_anim_get_keyframe_count(slot, 5) > 0;
        if (rotKeyed) {
          obj.rotation.set(v[3] * DEG2RAD, v[4] * DEG2RAD, v[5] * DEG2RAD, 'XYZ');
        }

        if (objId !== 'camera' && objId !== 'light') {
          if (this.exports.fe_anim_get_keyframe_count(slot, 6) > 0) obj.scale.x = Math.max(0.01, v[6]);
          if (this.exports.fe_anim_get_keyframe_count(slot, 7) > 0) obj.scale.y = Math.max(0.01, v[7]);
          if (this.exports.fe_anim_get_keyframe_count(slot, 8) > 0) obj.scale.z = Math.max(0.01, v[8]);
        }

        if (objId === 'camera' && eng.sceneCamera) {
          eng.sceneCamera.position.copy(obj.position);
          if (rotKeyed) {
            eng.sceneCamera.quaternion.copy(obj.quaternion);
          } else if (eng.sceneCameraTarget) {
            eng.sceneCamera.lookAt(eng.sceneCameraTarget);
            obj.quaternion.copy(eng.sceneCamera.quaternion);
          }
          if (this.exports.fe_anim_get_keyframe_count(slot, 9) > 0 && eng.sceneCamera.isPerspectiveCamera) {
            eng.sceneCamera.fov = Math.max(10, Math.min(140, v[9]));
            eng.sceneCamera.updateProjectionMatrix();
          }
          eng.sceneCamera.updateMatrixWorld(true);
        } else if (objId === 'light' && eng.blenderLight?.light) {
          if (this.exports.fe_anim_get_keyframe_count(slot, 9) > 0) {
            eng.blenderLight.light.intensity = Math.max(0, v[9]);
          }
        }

        obj.updateMatrix();
        obj.updateMatrixWorld(true);
        updatedAny = true;
      }

      if (updatedAny && eng.selectionBox && typeof eng.selectionBox.update === 'function') {
        eng.selectionBox.update();
      }
      return updatedAny;
    },

    listDistinctKeyFramesForObject(objId) {
      if (!this.ready) return [];
      const slot = this.getSlotForObjectId(objId);
      if (this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) return [];
      this.exports.fe_arena_reset();
      const buf = this.allocF32(128 * 3);
      const frames = new Set();
      for (let c = 0; c < CH.COUNT; c++) {
        const n = this.exports.fe_anim_list_object_keyframes(slot, c, buf.ptr, 128);
        for (let i = 0; i < n; i++) {
          frames.add(Math.round(buf.view[i * 3] * 100) / 100);
        }
      }
      return Array.from(frames).sort((a, b) => a - b);
    },

    serializeAnimation() {
      if (!this.ready || this.exports.fe_anim_get_total_keyframes() === 0) return null;
      this.exports.fe_arena_reset();
      const count = this.exports.fe_anim_serialized_float_count();
      if (count <= 3) return null;
      const buf = this.allocF32(count);
      const written = this.exports.fe_anim_serialize(buf.ptr, count);
      if (!written) return null;
      const slotMap = {};
      for (const [id, slot] of this.objectSlots.entries()) slotMap[id] = slot;
      return {
        version: 1,
        slotMap,
        floats: Array.from(buf.view.subarray(0, written))
      };
    },

    deserializeAnimation(payload) {
      if (!this.ready || !payload || !Array.isArray(payload.floats)) return false;
      if (payload.slotMap && typeof payload.slotMap === 'object') {
        this.objectSlots.clear();
        let maxSlot = 2;
        for (const [k, v] of Object.entries(payload.slotMap)) {
          const s = Number(v);
          if (Number.isFinite(s) && s >= 0 && s < 96) {
            this.objectSlots.set(k, s);
            if (s > maxSlot) maxSlot = s;
          }
        }
        this.nextCustomSlot = Math.min(95, maxSlot + 1);
      }
      this.exports.fe_arena_reset();
      const buf = this.allocF32(payload.floats.length);
      buf.view.set(payload.floats);
      const res = this.exports.fe_anim_deserialize(buf.ptr, payload.floats.length);
      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
      return res >= 0;
    },

    /* ---------------------------------------------------------------------
     * 2. C++ Progressive PBR Path Tracer & Post-Processing Render Engine
     * --------------------------------------------------------------------- */
    computeRenderDimensions() {
      const aspect = this.renderState.aspectPreset;
      const scale = this.renderState.resScale;
      const isPath = this.renderState.engine === 'cycles_cpp';
      /* Keep progressive CPU/WASM path tracing crisp & fast on mobile while supporting full HD on Eevee/High */
      const baseShort = scale === 'draft' ? (isPath ? 270 : 480) : scale === 'fhd' ? (isPath ? 720 : 1080) : (isPath ? 450 : 720);
      let w = baseShort, h = baseShort;
      if (aspect === '9:16') { w = baseShort; h = Math.round(baseShort * 16 / 9); }
      else if (aspect === '16:9') { w = Math.round(baseShort * 16 / 9); h = baseShort; }
      else if (aspect === '21:9') { w = Math.round(baseShort * 21 / 9); h = baseShort; }
      else if (aspect === '1:1') { w = baseShort; h = baseShort; }
      /* Clamp within C++ static HDR framebuffer budget (1280*1280) */
      while (w * h > 1280 * 1280) {
        w = Math.floor(w * 0.9);
        h = Math.floor(h * 0.9);
      }
      return { width: Math.max(64, w & ~1), height: Math.max(64, h & ~1) };
    },

    uploadWorkspaceSceneToCpp(aspectOverride) {
      if (!this.ready) return 0;
      const eng = window.FE?.engines?.core;
      if (!eng || !eng.sc || typeof THREE === 'undefined') return 0;

      const exp = this.exports;
      exp.fe_render_scene_clear();
      eng.sc.updateMatrixWorld(true);

      const vTemp = new THREE.Vector3();
      const nTemp = new THREE.Vector3();
      const normalMat = new THREE.Matrix3();

      eng.sc.traverse(obj => {
        if (!obj.visible || obj.userData?.isEditorHelper) return;
        if (!obj.isMesh || obj === eng.shadowFloor || obj === eng.studioFloor || obj === eng.grid) return;
        if (obj.name === 'ShadowFloor' || obj.name === 'StudioFloor' || obj.name === 'SelectionOutlineHelper') return;
        let parent = obj.parent;
        while (parent) {
          if (!parent.visible || parent === eng.blenderCam || parent === eng.blenderLight || parent === eng.cursor3d) return;
          parent = parent.parent;
        }

        const geom = obj.geometry;
        const posAttr = geom?.attributes?.position;
        if (!posAttr || posAttr.count < 3) return;

        const vCount = posAttr.count;
        const idxAttr = geom.index;
        const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(vCount / 3);
        if (triCount <= 0 || vCount > 65000) return;

        exp.fe_arena_reset();
        const posBuf = this.allocF32(vCount * 3);
        const nrmAttr = geom.attributes.normal;
        const nrmBuf = nrmAttr ? this.allocF32(vCount * 3) : null;
        const idxBuf = idxAttr ? this.allocU32(triCount * 3) : null;

        const mw = obj.matrixWorld;
        normalMat.getNormalMatrix(mw);

        for (let i = 0; i < vCount; i++) {
          vTemp.fromBufferAttribute(posAttr, i).applyMatrix4(mw);
          posBuf.view[i * 3 + 0] = vTemp.x;
          posBuf.view[i * 3 + 1] = vTemp.y;
          posBuf.view[i * 3 + 2] = vTemp.z;
          if (nrmBuf && nrmAttr) {
            nTemp.fromBufferAttribute(nrmAttr, i).applyMatrix3(normalMat).normalize();
            nrmBuf.view[i * 3 + 0] = nTemp.x;
            nrmBuf.view[i * 3 + 1] = nTemp.y;
            nrmBuf.view[i * 3 + 2] = nTemp.z;
          }
        }

        if (idxBuf && idxAttr) {
          const srcIdx = idxAttr.array;
          for (let i = 0; i < triCount * 3; i++) idxBuf.view[i] = srcIdx[i];
        }

        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        const col = mat?.color || { r: 0.52, g: 0.55, b: 0.65 };
        const rough = typeof mat?.roughness === 'number' ? mat.roughness : 0.55;
        const metal = typeof mat?.metalness === 'number' ? mat.metalness : 0.05;
        const emis = (mat?.emissive && (mat.emissive.r + mat.emissive.g + mat.emissive.b > 0.01))
          ? (mat.emissiveIntensity ?? 1.0)
          : 0.0;

        exp.fe_render_add_mesh(
          posBuf.ptr,
          nrmBuf ? nrmBuf.ptr : 0,
          idxBuf ? idxBuf.ptr : 0,
          vCount,
          triCount,
          col.r, col.g, col.b,
          rough, metal, emis, 1.0
        );
      });

      /* Environment & Ground Shadow Catcher */
      const envSel = document.getElementById('render-env-select');
      const envId = envSel ? Number(envSel.value) || 0 : 0;
      exp.fe_render_set_environment(envId, 1.05, this.renderState.shadowCatcher ? 1 : 0, -0.002);

      /* Upload Scene Lights */
      let lightSlot = 0;
      const userLightGrp = eng.blenderLight;
      const userLight = userLightGrp?.light;
      if (userLightGrp?.visible && userLight) {
        const lp = new THREE.Vector3();
        userLightGrp.getWorldPosition(lp);
        const ld = new THREE.Vector3(0, -1, 0).applyQuaternion(userLightGrp.quaternion).normalize();
        let lType = 1; // Point
        if (userLight.isDirectionalLight) lType = 2;
        else if (userLight.isSpotLight) lType = 3;
        const c = userLight.color || { r: 1, g: 1, b: 1 };
        const cosOuter = userLight.isSpotLight ? Math.cos(userLight.angle || (Math.PI / 5)) : 0.5;
        exp.fe_render_set_light(
          lightSlot++, lType,
          lp.x, lp.y, lp.z,
          ld.x, ld.y, ld.z,
          c.r, c.g, c.b,
          Math.max(0.4, (userLight.intensity ?? 2.2) * (lType === 2 ? 1.0 : 2.8)),
          0.32,
          cosOuter
        );
      }

      /* Key Studio Sunlight fallback/fill so Solid-mode scenes still render cinematically */
      if (eng.d) {
        const sd = eng.d.position.clone().negate().normalize();
        const sc = eng.d.color || { r: 1, g: 0.95, b: 0.88 };
        exp.fe_render_set_light(
          lightSlot++, 2,
          eng.d.position.x, eng.d.position.y, eng.d.position.z,
          sd.x, sd.y, sd.z,
          sc.r, sc.g, sc.b,
          lightSlot === 1 ? 2.2 : 0.85,
          0.22,
          0.5
        );
      }

      /* Active Camera */
      const useSceneCam = (document.getElementById('render-cam-source')?.value || 'scene') === 'scene';
      const cam = (useSceneCam && eng.sceneCamera) ? eng.sceneCamera : (eng.getActiveCamera?.() || eng.viewportCamera);
      cam.updateMatrixWorld(true);
      const eye = new THREE.Vector3();
      const fwd = new THREE.Vector3();
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      cam.getWorldPosition(eye);
      cam.getWorldDirection(fwd);
      right.crossVectors(fwd, cam.up).normalize();
      up.crossVectors(right, fwd).normalize();

      const dofCheck = document.getElementById('cam-dof-enable');
      const fStopEl = document.getElementById('cam-fstop');
      const focusDistEl = document.getElementById('cam-focus-distance');
      const aperture = (dofCheck && dofCheck.checked)
        ? Math.max(0.0, Math.min(0.45, 0.28 / Math.max(0.8, Number(fStopEl?.value) || 2.8)))
        : 0.0;
      const focusDist = Math.max(0.5, Number(focusDistEl?.value) || eye.length() || 7.5);
      const fov = cam.isPerspectiveCamera ? cam.fov : 42.0;

      exp.fe_render_set_camera(
        eye.x, eye.y, eye.z,
        fwd.x, fwd.y, fwd.z,
        right.x, right.y, right.z,
        up.x, up.y, up.z,
        fov,
        aspectOverride || 1.0,
        aperture,
        focusDist
      );

      exp.fe_render_build_bvh();
      return exp.fe_render_get_triangle_count();
    },

    renderSingleWebGLPostFXFrame(targetCanvas, width, height, frameSeed = 1) {
      const eng = window.FE?.engines?.core;
      if (!eng || !eng.r || !eng.sc) return false;
      targetCanvas.width = width;
      targetCanvas.height = height;

      const useSceneCam = (document.getElementById('render-cam-source')?.value || 'scene') === 'scene';
      const cam = (useSceneCam && eng.sceneCamera) ? eng.sceneCamera : (eng.getActiveCamera?.() || eng.viewportCamera);
      const prevAspect = cam.aspect;
      if (cam.isPerspectiveCamera) {
        cam.aspect = width / height;
        cam.updateProjectionMatrix();
      }

      /* Temporarily render with authored materials & shadows if currently in Solid/Wireframe */
      const prevShading = eng.getShadingMode?.() || 'solid';
      const switchedShading = (prevShading === 'solid' || prevShading === 'wireframe') && typeof window.applyShadingMode === 'function';
      if (switchedShading) window.applyShadingMode('rendered');

      const prevSize = new THREE.Vector2();
      eng.r.getSize(prevSize);
      const prevPR = eng.r.getPixelRatio();
      eng.r.setPixelRatio(1);
      eng.r.setSize(width, height, false);
      eng.r.render(eng.sc, cam);

      const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(eng.r.domElement, 0, 0, width, height);

      /* Restore interactive viewport dimensions & shading immediately */
      eng.r.setPixelRatio(prevPR);
      eng.r.setSize(prevSize.x, prevSize.y, false);
      if (cam.isPerspectiveCamera && prevAspect) {
        cam.aspect = prevAspect;
        cam.updateProjectionMatrix();
      }
      if (switchedShading) window.applyShadingMode(prevShading);

      /* Run C++ Post-Processing Compositor on the captured RGBA8 frame */
      if (this.ready && ctx) {
        const img = ctx.getImageData(0, 0, width, height);
        this.exports.fe_arena_reset();
        const pxBuf = this.allocU8(img.data.length);
        pxBuf.view.set(img.data);
        const rs = this.renderState;
        const ok = this.exports.fe_postprocess_rgba8(
          pxBuf.ptr, width, height,
          rs.tonemap, rs.exposure, rs.contrast, rs.saturation,
          rs.temperature, rs.bloom, rs.vignette, rs.chromatic, rs.grain,
          frameSeed
        );
        if (ok === 1) {
          img.data.set(pxBuf.view);
          ctx.putImageData(img, 0, 0);
        }
      }
      return true;
    },

    async startStillRender() {
      this.stopActiveRender();
      await this.init();
      const canvas = document.getElementById('render-preview-canvas');
      if (!canvas) return;
      syncRenderControlsFromUI();

      const { width, height } = this.computeRenderDimensions();
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const statusEl = document.getElementById('render-progress-text');
      const barEl = document.getElementById('render-progress-fill');

      if (this.renderState.engine === 'eevee_cpp' || !this.ready) {
        const t0 = performance.now();
        this.renderSingleWebGLPostFXFrame(canvas, width, height, 1);
        const dt = (performance.now() - t0).toFixed(1);
        if (statusEl) statusEl.textContent = `FE Eevee + Post-FX · ${width}×${height} · ${dt} ms`;
        if (barEl) barEl.style.width = '100%';
        return;
      }

      /* C++ Progressive BVH Path Tracer */
      const triCount = this.uploadWorkspaceSceneToCpp(width / height);
      this.exports.fe_render_init_framebuffer(width, height);
      this.renderState.isRendering = true;
      this.renderState.cancelRequested = false;

      const targetSpp = Math.max(1, this.renderState.targetSamples);
      const bounces = this.renderState.bounces;
      const tileRows = Math.max(16, Math.min(height, Math.floor(48000 / Math.max(64, width))));
      let curTileY = 0;
      const tStart = performance.now();

      const stepProgressive = () => {
        if (!this.renderState.isRendering || this.renderState.cancelRequested) {
          this.renderState.isRendering = false;
          return;
        }
        const rs = this.renderState;
        const doneSpp = this.exports.fe_render_trace_samples(1, bounces, curTileY, tileRows);
        curTileY += tileRows;

        if (curTileY >= height) {
          curTileY = 0;
          this.exports.fe_render_resolve_rgba8(
            rs.tonemap, rs.exposure, rs.contrast, rs.saturation,
            rs.temperature, rs.bloom, rs.vignette, rs.chromatic, rs.grain
          );
          const rgbaPtr = this.exports.fe_render_get_rgba8_ptr();
          const rgbaView = new Uint8ClampedArray(this.memory.buffer, rgbaPtr, width * height * 4);
          const imgData = new ImageData(new Uint8ClampedArray(rgbaView), width, height);
          ctx.putImageData(imgData, 0, 0);

          const pct = Math.min(100, Math.round((doneSpp / targetSpp) * 100));
          if (barEl) barEl.style.width = pct + '%';
          const elapsed = ((performance.now() - tStart) / 1000).toFixed(1);
          if (statusEl) {
            statusEl.textContent = `Path tracer · ${doneSpp}/${targetSpp} SPP · ${triCount} tris · ${width}×${height} (${elapsed}s)`;
          }

          if (doneSpp >= targetSpp) {
            this.renderState.isRendering = false;
            window.FE?.toast?.(`⚡ Path trace complete (${doneSpp} SPP)`);
            return;
          }
        }
        this.renderState.rafId = requestAnimationFrame(stepProgressive);
      };

      if (statusEl) statusEl.textContent = `Building BVH (${triCount} triangles) & tracing ${width}×${height}…`;
      if (barEl) barEl.style.width = '4%';
      this.renderState.rafId = requestAnimationFrame(stepProgressive);
    },

    stopActiveRender() {
      this.renderState.cancelRequested = true;
      this.renderState.isRendering = false;
      this.renderState.isSequenceRendering = false;
      if (this.renderState.rafId) {
        cancelAnimationFrame(this.renderState.rafId);
        this.renderState.rafId = 0;
      }
    },

    reResolveToneMapInstant() {
      if (!this.ready || this.renderState.engine !== 'cycles_cpp') {
        if (!this.renderState.isSequenceRendering) this.startStillRender();
        return;
      }
      if (this.exports.fe_render_get_accum_samples() === 0) return;
      const canvas = document.getElementById('render-preview-canvas');
      if (!canvas) return;
      const w = canvas.width, h = canvas.height;
      const rs = this.renderState;
      this.exports.fe_render_resolve_rgba8(
        rs.tonemap, rs.exposure, rs.contrast, rs.saturation,
        rs.temperature, rs.bloom, rs.vignette, rs.chromatic, rs.grain
      );
      const rgbaPtr = this.exports.fe_render_get_rgba8_ptr();
      const rgbaView = new Uint8ClampedArray(this.memory.buffer, rgbaPtr, w * h * 4);
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgbaView), w, h), 0, 0);
    },

    downloadRenderedPNG() {
      const canvas = document.getElementById('render-preview-canvas');
      if (!canvas || !canvas.width) return;
      canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `FinalEffect_Render_${canvas.width}x${canvas.height}_F${window.timelineConfig?.currentFrame || 0}.png`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
        window.FE?.toast?.('Saved PNG Render Image');
      }, 'image/png');
    },

    async renderAnimationSequenceVideo() {
      if (this.renderState.isSequenceRendering) return;
      this.stopActiveRender();
      await this.init();
      syncRenderControlsFromUI();

      const canvas = document.getElementById('render-preview-canvas');
      if (!canvas) return;
      const { width, height } = this.computeRenderDimensions();
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      const startF = Number(window.timelineConfig?.startFrame || 0);
      const endF = Math.max(startF + 1, Number(window.timelineConfig?.endFrame || 120));
      const fps = Number(window.timelineConfig?.fps || 30);
      const statusEl = document.getElementById('render-progress-text');
      const barEl = document.getElementById('render-progress-fill');

      if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
        window.FE?.toast?.('Video encoding requires MediaRecorder support in this browser; saving current frame PNG.');
        this.downloadRenderedPNG();
        return;
      }

      const mimeCandidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4'
      ];
      const mimeType = mimeCandidates.find(m => MediaRecorder.isTypeSupported?.(m)) || '';
      const stream = canvas.captureStream(fps);
      const chunks = [];
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
      recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

      const donePromise = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      this.renderState.isSequenceRendering = true;
      this.renderState.cancelRequested = false;

      const savedFrame = Number(window.timelineConfig?.currentFrame || 0);
      const wasPlaying = !!window.timelineConfig?.isPlaying;
      if (window.timelineConfig) window.timelineConfig.isPlaying = false;

      const usePath = this.renderState.engine === 'cycles_cpp' && this.ready;
      const seqSpp = Math.min(8, Math.max(2, Math.round(this.renderState.targetSamples / 4)));

      for (let f = startF; f <= endF; f++) {
        if (this.renderState.cancelRequested) break;
        if (typeof window.setTimelineCurrentFrame === 'function') {
          window.setTimelineCurrentFrame(f);
        }

        if (usePath) {
          this.uploadWorkspaceSceneToCpp(width / height);
          this.exports.fe_render_init_framebuffer(width, height);
          this.exports.fe_render_trace_samples(seqSpp, 1, 0, height);
          const rs = this.renderState;
          this.exports.fe_render_resolve_rgba8(
            rs.tonemap, rs.exposure, rs.contrast, rs.saturation,
            rs.temperature, rs.bloom, rs.vignette, rs.chromatic, rs.grain
          );
          const ptr = this.exports.fe_render_get_rgba8_ptr();
          const rgbaView = new Uint8ClampedArray(this.memory.buffer, ptr, width * height * 4);
          ctx.putImageData(new ImageData(new Uint8ClampedArray(rgbaView), width, height), 0, 0);
        } else {
          this.renderSingleWebGLPostFXFrame(canvas, width, height, f + 1);
        }

        const pct = Math.round(((f - startF + 1) / (endF - startF + 1)) * 100);
        if (barEl) barEl.style.width = pct + '%';
        if (statusEl) statusEl.textContent = `Rendering Animation Frame ${f}/${endF} (${pct}%) · ${width}×${height} @ ${fps}fps`;

        await new Promise(r => setTimeout(r, Math.max(16, Math.round(1000 / fps))));
      }

      recorder.stop();
      await donePromise;
      this.renderState.isSequenceRendering = false;
      if (typeof window.setTimelineCurrentFrame === 'function') window.setTimelineCurrentFrame(savedFrame);
      if (window.timelineConfig) window.timelineConfig.isPlaying = wasPlaying;

      if (!this.renderState.cancelRequested && chunks.length > 0) {
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `FinalEffect_Animation_${width}x${height}_${fps}fps.${ext}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
        if (statusEl) statusEl.textContent = `Animation Video Exported (${endF - startF + 1} frames · .${ext})`;
        window.FE?.toast?.(`🎬 Exported Animation Video (.${ext})`);
      }
    },

    /* ---------------------------------------------------------------------
     * 3. C++ Real-Time Mesh Sculpt & Vertex/Weight Paint Kernel
     * --------------------------------------------------------------------- */
    applySculptOrPaintAtPointer(clientX, clientY) {
      if (!this.ready || typeof THREE === 'undefined') return false;
      const mode = this.sculptState.activeMode;
      if (mode !== 'sculpt' && mode !== 'vpaint' && mode !== 'wpaint' && mode !== 'tpaint') return false;

      const eng = window.FE?.engines?.core;
      const mesh = window.getActiveObjectMesh?.();
      if (!eng || !mesh || !mesh.isMesh || !mesh.geometry?.attributes?.position) return false;

      const canvas = eng.r?.domElement;
      if (!canvas) return false;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );

      const cam = eng.getActiveCamera ? eng.getActiveCamera() : eng.viewportCamera;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, cam);
      const hits = raycaster.intersectObject(mesh, false);
      if (!hits.length) return false;

      const hit = hits[0];
      const invMat = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      const localPt = hit.point.clone().applyMatrix4(invMat);
      const localNormal = (hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0)).normalize();

      const geom = mesh.geometry;
      const posAttr = geom.attributes.position;
      const vCount = posAttr.count;
      const symMask = this.sculptState.symmetryX ? 1 : 0;
      const avgScale = Math.max(0.05, (mesh.scale.x + mesh.scale.y + mesh.scale.z) / 3);
      const localRadius = this.sculptState.radius / avgScale;

      this.exports.fe_arena_reset();

      if (mode === 'sculpt') {
        let nrmAttr = geom.attributes.normal;
        if (!nrmAttr) {
          geom.computeVertexNormals();
          nrmAttr = geom.attributes.normal;
        }
        const posBuf = this.allocF32(vCount * 3);
        const nrmBuf = this.allocF32(vCount * 3);
        posBuf.view.set(posAttr.array);
        nrmBuf.view.set(nrmAttr.array);

        const grabDelta = new THREE.Vector3();
        if (this.sculptState.lastLocalHit) {
          grabDelta.subVectors(localPt, this.sculptState.lastLocalHit);
        }
        this.sculptState.lastLocalHit = localPt.clone();

        const signedStrength = this.sculptState.invert ? -this.sculptState.strength : this.sculptState.strength;
        const moved = this.exports.fe_sculpt_apply_brush(
          posBuf.ptr,
          nrmBuf.ptr,
          vCount,
          this.sculptState.brush,
          localPt.x, localPt.y, localPt.z,
          localNormal.x, localNormal.y, localNormal.z,
          grabDelta.x, grabDelta.y, grabDelta.z,
          localRadius,
          signedStrength,
          symMask
        );

        if (moved > 0) {
          const idxAttr = geom.index;
          const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(vCount / 3);
          let idxPtr = 0;
          if (idxAttr) {
            const idxBuf = this.allocU32(triCount * 3);
            idxBuf.view.set(idxAttr.array.subarray(0, triCount * 3));
            idxPtr = idxBuf.ptr;
          }
          this.exports.fe_mesh_recompute_vertex_normals(posBuf.ptr, idxPtr, vCount, triCount, nrmBuf.ptr);

          posAttr.array.set(posBuf.view);
          posAttr.needsUpdate = true;
          nrmAttr.array.set(nrmBuf.view);
          nrmAttr.needsUpdate = true;
          geom.computeBoundingBox();
          geom.computeBoundingSphere();

          const outline = mesh.getObjectByName('SelectionOutlineHelper');
          if (outline) outline.visible = false;
        }
        return moved > 0;
      }

      /* Vertex / Weight / Texture Paint Mode via C++ fe_vertex_paint_apply */
      let colAttr = geom.attributes.color;
      if (!colAttr) {
        const initCols = new Float32Array(vCount * 3);
        const baseC = mesh.material?.color || { r: 0.75, g: 0.78, b: 0.86 };
        for (let i = 0; i < vCount; i++) {
          initCols[i * 3 + 0] = mode === 'wpaint' ? 0.05 : baseC.r;
          initCols[i * 3 + 1] = mode === 'wpaint' ? 0.15 : baseC.g;
          initCols[i * 3 + 2] = mode === 'wpaint' ? 0.75 : baseC.b;
        }
        colAttr = new THREE.BufferAttribute(initCols, 3);
        geom.setAttribute('color', colAttr);
        if (mesh.material) {
          mesh.material.vertexColors = true;
          if (mesh.material.color && mode !== 'wpaint') mesh.material.color.setHex(0xffffff);
          mesh.material.needsUpdate = true;
        }
      }

      const posBuf = this.allocF32(vCount * 3);
      const colBuf = this.allocF32(vCount * 3);
      posBuf.view.set(posAttr.array);
      colBuf.view.set(colAttr.array);

      const cObj = new THREE.Color(mode === 'wpaint'
        ? (this.sculptState.invert ? '#1d4ed8' : '#ef4444')
        : this.sculptState.paintColor);

      const painted = this.exports.fe_vertex_paint_apply(
        posBuf.ptr,
        colBuf.ptr,
        vCount,
        localPt.x, localPt.y, localPt.z,
        localRadius,
        this.sculptState.strength,
        cObj.r, cObj.g, cObj.b,
        symMask
      );

      if (painted > 0) {
        colAttr.array.set(colBuf.view);
        colAttr.needsUpdate = true;
      }
      return painted > 0;
    },

    subdivideActiveMeshForSculpt() {
      const mesh = window.getActiveObjectMesh?.();
      if (!mesh || !mesh.isMesh || !mesh.geometry) {
        window.FE?.toast?.('Select a 3D mesh to subdivide');
        return;
      }
      const curVerts = mesh.geometry.attributes.position?.count || 0;
      if (curVerts > 24000) {
        window.FE?.toast?.(`Mesh already high-detail (${curVerts} vertices)`);
        return;
      }
      if (window.ModifierGeometry?.subdivideLoop) {
        const nextGeo = window.ModifierGeometry.subdivideLoop(mesh.geometry, 1);
        mesh.geometry.dispose();
        mesh.geometry = nextGeo;
        if (typeof window.applyMeshSelectionOutline === 'function') {
          window.applyMeshSelectionOutline(window.FE?.getActiveObjectId?.() || 'cube');
        }
        window.FE?.engines?.core?.commitHistory?.('sculpt-subdivide');
        window.FE?.toast?.(`Subdivided mesh → ${nextGeo.attributes.position.count} vertices for smooth sculpting`);
      }
    },

    /* ---------------------------------------------------------------------
     * 4. Adaptive Mobile GPU Performance Governor Tick
     * --------------------------------------------------------------------- */
    tickPerformanceGovernor() {
      const now = performance.now();
      const dtMs = now - this.lastFrameTick;
      this.lastFrameTick = now;
      if (!this.ready || dtMs <= 0.2 || dtMs > 400) return;

      this.exports.fe_perf_push_frame_ms(dtMs);
      if (now - this.lastPerfUpdate < 1200) return;
      this.lastPerfUpdate = now;

      this.exports.fe_arena_reset();
      const mBuf = this.allocF32(6);
      this.exports.fe_perf_query_metrics(this.gpuModeOverride, window.devicePixelRatio || 1, mBuf.ptr);
      const [avgMs, fps, recDpr, shadowRes, , tier] = mBuf.view;

      const eng = window.FE?.engines?.core;
      if (eng?.r && !this.renderState.isRendering && !this.renderState.isSequenceRendering) {
        // Keep a stable native-resolution viewport; tier changes must not blur editing.
        const sharpDpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
        const curPr = eng.r.getPixelRatio();
        if (Math.abs(curPr - sharpDpr) > 0.01) {
          eng.r.setPixelRatio(sharpDpr);
          const vp = document.getElementById('viewport-core');
          if (vp && vp.clientWidth && vp.clientHeight) {
            eng.r.setSize(vp.clientWidth, vp.clientHeight, false);
          }
        }
        if (eng.d?.shadow?.mapSize && eng.d.shadow.mapSize.x !== shadowRes) {
          eng.d.shadow.mapSize.set(shadowRes, shadowRes);
          if (eng.d.shadow.map) {
            eng.d.shadow.map.dispose();
            eng.d.shadow.map = null;
          }
        }
      }

      const perfStats = {
        fps: Math.min(120, Math.round(fps)),
        avgMs,
        tier,
        tierLabel: tier === 0 ? 'Low' : tier === 1 ? 'Medium' : 'High',
        dpr: recDpr,
        shadowRes
      };
      window.FEWorkspacePerf = perfStats;
      window.fepdateWorkspacePerf?.(perfStats);
      const settingsPerfLabel = document.getElementById('cpp-perf-live-readout');
      if (settingsPerfLabel) {
        const tierNames = ['Low (Mobile 60fps)', 'Medium (Balanced)', 'High (Pro Quality)'];
        settingsPerfLabel.textContent = `${avgMs.toFixed(1)} ms · ${Math.round(fps)} FPS · ${tierNames[tier] || 'High'} quality · ${recDpr.toFixed(2)}x`;
      }
    }
  };

  window.FECppEngine = FECppEngine;

  /* -----------------------------------------------------------------------
   * UI Wiring Helpers (Animation Dope Sheet, Render Studio, Sculpt & Mobile)
   * ----------------------------------------------------------------------- */
  function updateCppStatusBadges() {
    /* Engine state stays available to the app, but the viewport chrome does not
       advertise the implementation. */
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.engineReady = FECppEngine.ready ? '1' : '0';
      document.body.dataset.engineFallback = FECppEngine.loadError ? '1' : '0';
    }
  }

  function refreshAnimationStudioUI() {
    const sheet = document.getElementById('animation-sheet');
    if (!sheet) return;
    const objId = window.FE?.getActiveObjectId?.() || 'cube';
    const objName = window.getActiveObjectDisplayName?.() || objId;
    const slot = FECppEngine.getSlotForObjectId(objId);

    const activeLabel = document.getElementById('anim-active-target');
    if (activeLabel) activeLabel.textContent = objName;

    const totalKeys = FECppEngine.ready ? FECppEngine.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) : 0;
    const countLabel = document.getElementById('anim-key-count-badge');
    if (countLabel) countLabel.textContent = `${totalKeys} Keys`;

    const extrapSel = document.getElementById('anim-extrap-select');
    if (extrapSel && FECppEngine.ready) {
      extrapSel.value = String(FECppEngine.exports.fe_anim_get_extrapolation(slot));
    }

    const autoBtn = document.getElementById('btn-anim-autokey');
    if (autoBtn) {
      autoBtn.classList.toggle('active-autokey', FECppEngine.autoKey);
      autoBtn.textContent = FECppEngine.autoKey ? '⏺ Auto-Key ON' : '⏺ Auto-Key';
    }

    renderDopeSheetAndCurveCanvas();
  }
  window.refreshAnimationStudioUI = refreshAnimationStudioUI;

  function renderDopeSheetAndCurveCanvas() {
    const canvas = document.getElementById('anim-dopesheet-canvas');
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(260, parent?.clientWidth || 500);
    const h = Math.max(150, parent?.clientHeight || 168);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#0b0d14';
    ctx.fillRect(0, 0, w, h);

    const startF = Number(window.timelineConfig?.startFrame || 0);
    const endF = Math.max(startF + 1, Number(window.timelineConfig?.endFrame || 250));
    const curF = Number(window.timelineConfig?.currentFrame || 0);
    const padL = 88, padR = 14, padT = 22, padB = 12;
    const plotW = Math.max(40, w - padL - padR);
    const plotH = Math.max(40, h - padT - padB);

    const frameToX = f => padL + ((f - startF) / (endF - startF)) * plotW;

    /* Frame grid */
    ctx.strokeStyle = '#1c2030';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    const step = Math.max(5, Math.round((endF - startF) / 8 / 5) * 5);
    for (let f = startF; f <= endF; f += step) {
      const x = frameToX(f);
      ctx.beginPath();
      ctx.moveTo(x, padT - 4);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      ctx.fillText(String(f), x, 13);
    }

    const objId = window.FE?.getActiveObjectId?.() || 'cube';
    const slot = FECppEngine.getSlotForObjectId(objId);

    const groups = [
      { label: 'Location XYZ', chs: [0, 1, 2] },
      { label: 'Rotation XYZ', chs: [3, 4, 5] },
      { label: 'Scale XYZ',    chs: [6, 7, 8] },
      { label: 'Lens / Light', chs: [9, 10] }
    ];
    const rowH = plotH / groups.length;

    groups.forEach((g, idx) => {
      const yMid = padT + idx * rowH + rowH * 0.5;
      ctx.strokeStyle = '#171b29';
      ctx.beginPath();
      ctx.moveTo(0, padT + (idx + 1) * rowH);
      ctx.lineTo(w, padT + (idx + 1) * rowH);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(g.label, 8, yMid + 4);

      if (!FECppEngine.ready) return;
      FECppEngine.exports.fe_arena_reset();
      const kBuf = FECppEngine.allocF32(128 * 3);

      for (const c of g.chs) {
        const n = FECppEngine.exports.fe_anim_list_object_keyframes(slot, c, kBuf.ptr, 128);
        if (n === 0) continue;

        /* Draw mini interpolated C++ curve preview in the row */
        let minV = Infinity, maxV = -Infinity;
        const samples = 48;
        const vals = new Float32Array(samples + 1);
        for (let s = 0; s <= samples; s++) {
          const sf = startF + ((endF - startF) * s) / samples;
          const v = FECppEngine.exports.fe_anim_evaluate_channel(slot, c, sf, startF, endF);
          vals[s] = v;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const spanV = Math.max(0.01, maxV - minV);
        ctx.strokeStyle = CHANNEL_COLORS[c] + '88';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let s = 0; s <= samples; s++) {
          const x = padL + (s / samples) * plotW;
          const norm = (vals[s] - minV) / spanV;
          const y = (padT + idx * rowH + rowH - 5) - norm * (rowH - 10);
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        /* Draw diamond keyframe markers */
        for (let k = 0; k < n; k++) {
          const kf = kBuf.view[k * 3];
          const x = frameToX(kf);
          if (x < padL - 4 || x > w - padR + 4) continue;
          ctx.fillStyle = Math.abs(kf - curF) < 0.5 ? '#fbbf24' : CHANNEL_COLORS[c];
          ctx.beginPath();
          ctx.moveTo(x, yMid - 5);
          ctx.lineTo(x + 5, yMid);
          ctx.lineTo(x, yMid + 5);
          ctx.lineTo(x - 5, yMid);
          ctx.closePath();
          ctx.fill();
        }
      }
    });

    /* Current Playhead Line */
    const playX = frameToX(curF);
    if (playX >= padL && playX <= w - padR) {
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, h);
      ctx.stroke();
    }
  }
  window.renderDopeSheetAndCurveCanvas = renderDopeSheetAndCurveCanvas;

  function syncRenderControlsFromUI() {
    const rs = FECppEngine.renderState;
    const getVal = (id, def) => {
      const el = document.getElementById(id);
      return el ? el.value : def;
    };
    rs.engine = getVal('render-engine-select', rs.engine);
    rs.aspectPreset = getVal('render-aspect-select', rs.aspectPreset);
    rs.resScale = getVal('render-quality-select', rs.resScale);
    rs.targetSamples = Math.max(2, parseInt(getVal('render-samples-select', rs.targetSamples), 10) || 32);
    rs.bounces = Math.max(0, parseInt(getVal('render-bounces-select', rs.bounces), 10) || 2);
    rs.tonemap = parseInt(getVal('render-tonemap-select', rs.tonemap), 10) || 0;
    rs.exposure = parseFloat(getVal('render-exp-range', rs.exposure)) || 1.25;
    rs.contrast = parseFloat(getVal('render-contrast-range', rs.contrast)) || 1.05;
    rs.saturation = parseFloat(getVal('render-sat-range', rs.saturation)) || 1.08;
    rs.temperature = parseFloat(getVal('render-temp-range', rs.temperature)) || 0.0;
    rs.bloom = parseFloat(getVal('render-bloom-range', rs.bloom)) || 0;
    rs.vignette = parseFloat(getVal('render-vig-range', rs.vignette)) || 0;
    rs.chromatic = parseFloat(getVal('render-ca-range', rs.chromatic)) || 0;
    rs.grain = parseFloat(getVal('render-grain-range', rs.grain)) || 0;
    const scEl = document.getElementById('render-shadow-catcher');
    if (scEl) rs.shadowCatcher = !!scEl.checked;
  }

  function openRenderEngineModal() {
    const modal = document.getElementById('render-engine-modal');
    if (!modal) return;
    if (typeof window.closeAnimationModal === 'function') window.closeAnimationModal();
    if (typeof window.closeModifiersModal === 'function') window.closeModifiersModal();
    const camSheet = document.getElementById('camera-sheet');
    if (camSheet) camSheet.style.display = 'none';
    const lightSheet = document.getElementById('light-sheet');
    if (lightSheet) { lightSheet.hidden = true; lightSheet.style.display = 'none'; }
    modal.hidden = false;
    FECppEngine.startStillRender();
  }
  window.openRenderEngineModal = openRenderEngineModal;

  function closeRenderEngineModal() {
    FECppEngine.stopActiveRender();
    const modal = document.getElementById('render-engine-modal');
    if (modal) modal.hidden = true;
  }
  window.closeRenderEngineModal = closeRenderEngineModal;

  /* ---- Focus Camera Smoothly on Active Object (Mobile 1-Tap & Double-Tap) ---- */
  function focusActiveObjectInViewport() {
    const eng = window.FE?.engines?.core;
    const obj = window.getActiveObjectMesh?.();
    if (!eng || !eng.oc || !obj) return;
    const cam = eng.getActiveCamera ? eng.getActiveCamera() : eng.viewportCamera;
    if (!cam) return;

    const targetPos = new THREE.Vector3();
    obj.getWorldPosition(targetPos);

    let radius = 2.2;
    if (obj.geometry) {
      if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
      const bs = obj.geometry.boundingSphere;
      if (bs && Number.isFinite(bs.radius)) {
        const maxScale = Math.max(obj.scale.x, obj.scale.y, obj.scale.z, 0.2);
        radius = Math.max(1.6, bs.radius * maxScale * 2.4);
      }
    }

    const dir = cam.position.clone().sub(eng.oc.target);
    if (dir.lengthSq() < 0.01) dir.set(1, 0.75, 1);
    dir.normalize();

    const startTarget = eng.oc.target.clone();
    const startCam = cam.position.clone();
    const endCam = targetPos.clone().addScaledVector(dir, radius * 2.1);
    const t0 = performance.now();

    const step = now => {
      const u = Math.min(1, (now - t0) / 240);
      const ease = 1 - Math.pow(1 - u, 3);
      eng.oc.target.lerpVectors(startTarget, targetPos, ease);
      cam.position.lerpVectors(startCam, endCam, ease);
      eng.oc.update();
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    window.FE?.toast?.(`🎯 Focused ${window.getActiveObjectDisplayName?.() || 'Object'}`);
  }
  window.focusActiveObjectInViewport = focusActiveObjectInViewport;

  function toggleMobileFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }
  window.toggleMobileFullscreen = toggleMobileFullscreen;

  /* ---- PWA Install Handler (Android/Desktop prompt + iOS Safari guide) ---- */
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    FECppEngine.deferredInstallPrompt = e;
    document.querySelectorAll('.pwa-install-btn').forEach(btn => { btn.hidden = false; });
  });

  async function installFinalEffectPWA() {
    if (FECppEngine.deferredInstallPrompt) {
      FECppEngine.deferredInstallPrompt.prompt();
      await FECppEngine.deferredInstallPrompt.userChoice.catch(() => null);
      FECppEngine.deferredInstallPrompt = null;
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      window.FE?.toast?.('📲 On iPhone/iPad: tap Share (↑) → "Add to Home Screen" to install Final Effect 3D');
    } else {
      window.FE?.toast?.('📲 Use browser menu → "Install App / Add to Home Screen" for full-screen mobile mode');
    }
  }
  window.installFinalEffectPWA = installFinalEffectPWA;

  /* -----------------------------------------------------------------------
   * Hook into Workspace Lifecycle Once DOM & Inline Scripts Are Ready
   * ----------------------------------------------------------------------- */
  function wireWorkspaceIntegration() {
    FECppEngine.init();

    /* 1. Wrap setTimelineCurrentFrame so C++ Animation evaluates on every scrub/play/render step */
    const origSetFrame = window.setTimelineCurrentFrame;
    if (typeof origSetFrame === 'function' && !origSetFrame._cppWrapped) {
      const wrapped = function (frame) {
        origSetFrame(frame);
        FECppEngine.evaluateSceneAtFrame(Number(window.timelineConfig?.currentFrame || frame || 0));
        const sheet = document.getElementById('animation-sheet');
        if (sheet && sheet.style.display !== 'none') {
          renderDopeSheetAndCurveCanvas();
        }
      };
      wrapped._cppWrapped = true;
      window.setTimelineCurrentFrame = wrapped;
    }

    /* 2. Wrap renderTimelineRulerCanvas to overlay C++ Keyframe Diamonds ◆ on the bottom timeline */
    const origRenderRuler = window.renderTimelineRulerCanvas;
    if (typeof origRenderRuler === 'function' && !origRenderRuler._cppWrapped) {
      const wrappedRuler = function () {
        origRenderRuler();
        if (!FECppEngine.ready) return;
        const canvas = document.getElementById('timeline-ruler-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const objId = window.FE?.getActiveObjectId?.() || 'cube';
        const frames = FECppEngine.listDistinctKeyFramesForObject(objId);
        if (!frames.length) return;
        const curF = Number(window.timelineConfig?.currentFrame || 0);
        const centerX = canvas.width * 0.5;
        const spacing = 14;
        const y = canvas.height - 9;
        for (const kf of frames) {
          const x = centerX + (kf - curF) * spacing;
          if (x < -10 || x > canvas.width + 10) continue;
          ctx.fillStyle = Math.abs(kf - curF) < 0.5 ? '#fde047' : '#f59e0b';
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x + 4.5, y);
          ctx.lineTo(x, y + 5);
          ctx.lineTo(x - 4.5, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      };
      wrappedRuler._cppWrapped = true;
      window.renderTimelineRulerCanvas = wrappedRuler;
    }

    /* 3. Wrap openAnimationModal to refresh Dope Sheet immediately */
    const origOpenAnim = window.openAnimationModal;
    if (typeof origOpenAnim === 'function' && !origOpenAnim._cppWrapped) {
      const wrappedAnim = function () {
        origOpenAnim();
        requestAnimationFrame(refreshAnimationStudioUI);
      };
      wrappedAnim._cppWrapped = true;
      window.openAnimationModal = wrappedAnim;
    }

    /* 4. Listen for tool='render' & object selection & mode changes */
    document.addEventListener('fe:tool', e => {
      if (e.detail?.studio === 'core' && e.detail?.tool === 'render') {
        openRenderEngineModal();
      }
    });

    document.addEventListener('fe:mode', e => {
      if (e.detail?.studio !== 'core') return;
      const mode = e.detail.mode || 'object';
      FECppEngine.sculptState.activeMode = mode;
      const bar = document.getElementById('cpp-sculpt-paint-bar');
      const isBrushMode = (mode === 'sculpt' || mode === 'vpaint' || mode === 'wpaint' || mode === 'tpaint');
      if (bar) {
        bar.hidden = !isBrushMode;
        const paintWrap = document.getElementById('cpp-paint-color-wrap');
        const brushSelWrap = document.getElementById('cpp-sculpt-brush-wrap');
        if (paintWrap) paintWrap.style.display = (mode === 'vpaint' || mode === 'tpaint') ? 'inline-flex' : 'none';
        if (brushSelWrap) brushSelWrap.style.display = mode === 'sculpt' ? 'inline-flex' : 'none';
      }
      if (isBrushMode) {
        const labels = { sculpt: '🗿 Sculpt Brush Ready', vpaint: '🎨 Vertex Paint Ready', wpaint: '⚖️ Weight Paint Ready', tpaint: '🖌️ Surface Paint Ready' };
        window.FE?.toast?.(labels[mode] || 'Brush Mode Active');
      } else {
        const mesh = window.getActiveObjectMesh?.();
        const outline = mesh?.getObjectByName?.('SelectionOutlineHelper');
        if (outline) outline.visible = true;
      }
    });

    /* 5. Dope sheet pointer scrubbing */
    const dopeCanvas = document.getElementById('anim-dopesheet-canvas');
    if (dopeCanvas && !dopeCanvas.dataset.bound) {
      dopeCanvas.dataset.bound = '1';
      let dragging = false;
      const scrubDope = ev => {
        const rect = dopeCanvas.getBoundingClientRect();
        const padL = 88, padR = 14;
        const plotW = Math.max(40, rect.width - padL - padR);
        const u = Math.max(0, Math.min(1, (ev.clientX - rect.left - padL) / plotW));
        const startF = Number(window.timelineConfig?.startFrame || 0);
        const endF = Math.max(startF + 1, Number(window.timelineConfig?.endFrame || 250));
        const target = Math.round(startF + u * (endF - startF));
        if (typeof window.setTimelineCurrentFrame === 'function') window.setTimelineCurrentFrame(target);
      };
      dopeCanvas.addEventListener('pointerdown', ev => { dragging = true; scrubDope(ev); });
      window.addEventListener('pointermove', ev => { if (dragging) scrubDope(ev); });
      window.addEventListener('pointerup', () => { dragging = false; });
    }

    /* 6. Bind Sculpt/Paint strokes + C++ Touch Gesture + Mobile Double-Tap Focus on #canvas-core */
    const bindCoreViewportHooks = () => {
      const eng = window.FE?.engines?.core;
      const canvas = document.getElementById('canvas-core');
      if (!eng || !eng.sc || !canvas) {
        setTimeout(bindCoreViewportHooks, 200);
        return;
      }
      if (canvas.dataset.cppHooksBound) return;
      canvas.dataset.cppHooksBound = '1';

      /* Auto-Key when TransformControls drag completes */
      if (eng.transformControls) {
        eng.transformControls.addEventListener('dragging-changed', ev => {
          if (!ev.value && FECppEngine.autoKey) {
            FECppEngine.insertKeyframeForActive('locrotscale', true);
            window.FE?.toast?.(`⏺ Auto-Keyed Frame ${window.timelineConfig?.currentFrame || 0}`);
          }
        });
      }

      /* Wrap serializeAutosave / restoreAutosave to persist C++ Keyframe Animation */
      if (eng.serializeAutosave && !eng.serializeAutosave._cppWrapped) {
        const baseSerialize = eng.serializeAutosave.bind(eng);
        const wrappedSerialize = () => {
          const data = baseSerialize();
          const anim = FECppEngine.serializeAnimation();
          if (anim) data.cppAnimation = anim;
          return data;
        };
        wrappedSerialize._cppWrapped = true;
        eng.serializeAutosave = wrappedSerialize;
      }
      if (eng.restoreAutosave && !eng.restoreAutosave._cppWrapped) {
        const baseRestore = eng.restoreAutosave.bind(eng);
        const wrappedRestore = async data => {
          const ok = await baseRestore(data);
          if (data?.cppAnimation) {
            await FECppEngine.init();
            FECppEngine.deserializeAnimation(data.cppAnimation);
          }
          return ok;
        };
        wrappedRestore._cppWrapped = true;
        eng.restoreAutosave = wrappedRestore;
      }

      /* Multi-pointer tracking for C++ Touch Filter, Sculpt/Paint stroke & Double-Tap Focus */
      const activePointers = new Map();
      let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

      canvas.addEventListener('pointerdown', ev => {
        activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, downX: ev.clientX, downY: ev.clientY, t: performance.now() });

        const mode = FECppEngine.sculptState.activeMode;
        const isBrush = (mode === 'sculpt' || mode === 'vpaint' || mode === 'wpaint' || mode === 'tpaint');
        if (isBrush && activePointers.size === 1) {
          FECppEngine.sculptState.lastLocalHit = null;
          if (FECppEngine.applySculptOrPaintAtPointer(ev.clientX, ev.clientY)) {
            FECppEngine.sculptState.strokeActive = true;
            eng.history?.begin?.('cpp-brush');
            if (eng.oc) eng.oc.enabled = false;
          }
        } else if (FECppEngine.sculptState.strokeActive && activePointers.size >= 2) {
          /* Allow 2-finger orbit/zoom even inside Sculpt Mode on mobile! */
          FECppEngine.sculptState.strokeActive = false;
          if (eng.oc) eng.oc.enabled = true;
        }
      }, { passive: true });

      canvas.addEventListener('pointermove', ev => {
        const rec = activePointers.get(ev.pointerId);
        if (rec) { rec.x = ev.clientX; rec.y = ev.clientY; }

        if (FECppEngine.ready && activePointers.size > 0) {
          const pts = Array.from(activePointers.values());
          FECppEngine.exports.fe_arena_reset();
          const out8 = FECppEngine.allocF32(8);
          FECppEngine.exports.fe_touch_update(
            pts.length,
            pts[0].x, pts[0].y,
            pts[1]?.x || 0, pts[1]?.y || 0,
            canvas.clientWidth || 800, canvas.clientHeight || 600,
            1 / 60,
            out8.ptr
          );
        }

        if (FECppEngine.sculptState.strokeActive && activePointers.size === 1) {
          FECppEngine.applySculptOrPaintAtPointer(ev.clientX, ev.clientY);
        }
      }, { passive: true });

      const finishPointer = ev => {
        const rec = activePointers.get(ev.pointerId);
        activePointers.delete(ev.pointerId);

        if (FECppEngine.sculptState.strokeActive && activePointers.size === 0) {
          FECppEngine.sculptState.strokeActive = false;
          FECppEngine.sculptState.lastLocalHit = null;
          if (eng.oc) eng.oc.enabled = true;
          const mesh = window.getActiveObjectMesh?.();
          if (mesh && typeof window.applyMeshSelectionOutline === 'function') {
            window.applyMeshSelectionOutline(window.FE?.getActiveObjectId?.() || 'cube');
          }
          eng.history?.commitPending?.('cpp-brush');
          return;
        }

        /* Touch Double-Tap on Viewport -> Smooth Focus Active Object */
        if (rec && ev.pointerType === 'touch' && activePointers.size === 0) {
          const moved = Math.hypot(ev.clientX - rec.downX, ev.clientY - rec.downY);
          const dur = performance.now() - rec.t;
          if (moved < 14 && dur < 280) {
            const now = performance.now();
            if (now - lastTapTime < 320 && Math.hypot(ev.clientX - lastTapX, ev.clientY - lastTapY) < 36) {
              focusActiveObjectInViewport();
              lastTapTime = 0;
            } else {
              lastTapTime = now;
              lastTapX = ev.clientX;
              lastTapY = ev.clientY;
            }
          }
        }
      };

      canvas.addEventListener('pointerup', finishPointer, { passive: true });
      canvas.addEventListener('pointercancel', finishPointer, { passive: true });

      /* Performance samples are supplied by the actual Workspace render loop. */
    };

    bindCoreViewportHooks();

    /* 7. Wire GPU Performance Mode selector in Application Settings */
    const gpuSel = document.getElementById('set-gpu-tier');
    if (gpuSel) {
      let savedTier = '0';
      try { savedTier = localStorage.getItem('fe_cpp_gpu_tier') || '0'; } catch (_) {}
      FECppEngine.gpuModeOverride = parseInt(savedTier, 10) || 0;
      gpuSel.value = String(FECppEngine.gpuModeOverride);
      gpuSel.addEventListener('change', e => {
        const v = parseInt(e.target.value, 10) || 0;
        FECppEngine.gpuModeOverride = v;
        try { localStorage.setItem('fe_cpp_gpu_tier', String(v)); } catch (_) {}
        FECppEngine.lastPerfUpdate = 0;
        const names = ['Auto (Adaptive)', 'Low (High battery life)', 'Medium (Balanced)', 'High (Best quality)'];
        window.FE?.toast?.(`GPU Performance: ${names[v] || 'Auto'}`);
      });
    }

    /* 7b. Upgrade #frame-landscape in Standalone Portable HTML mode */
    if (typeof window.__FE_TERRAIN_STANDALONE_HTML__ === 'string' && window.__FE_TERRAIN_STANDALONE_HTML__.length > 100) {
      const mountStandaloneTerrain = () => {
        const frame = document.getElementById('frame-landscape');
        if (!frame) { setTimeout(mountStandaloneTerrain, 250); return; }
        if (frame.dataset.standaloneMounted) return;
        frame.dataset.standaloneMounted = '1';
        try {
          const blob = new Blob([window.__FE_TERRAIN_STANDALONE_HTML__], { type: 'text/html' });
          frame.src = URL.createObjectURL(blob);
        } catch (_) {
          frame.srcdoc = window.__FE_TERRAIN_STANDALONE_HTML__;
        }
      };
      mountStandaloneTerrain();
    }

    /* 8. Register PWA Service Worker cleanly (only on http/https production-compatible origins) */
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  /* -----------------------------------------------------------------------
   * Live On-Device C++20 Engine Self-Test & Visual Ray-Trace Benchmark
   * Lets any user on Phone or Desktop verify every C++ subsystem in 1 tap!
   * ----------------------------------------------------------------------- */
  FECppEngine.runLiveSelfTest = async function (previewCanvas) {
    const results = [];
    const tTotal0 = performance.now();
    await this.init();

    if (!this.ready || !this.exports) {
      results.push({ name: 'Engine initialization', ok: false, detail: String(this.loadError || 'engine unavailable') });
      return { ok: false, results, totalMs: +(performance.now() - tTotal0).toFixed(1) };
    }
    const exp = this.exports;

    /* Save existing animation tracks before running isolated self-test */
    const savedAnim = this.serializeAnimation();

    /* 1. Freestanding ABI v1 & Memory Arena */
    let t0 = performance.now();
    const abi = exp.fe_core_abi_version();
    exp.fe_arena_reset();
    const probe = this.allocF32(64);
    probe.view[0] = 42.5;
    results.push({
      name: 'Core Engine (ABI v1)',
      ok: abi === 1 && probe.ptr > 0 && probe.view[0] === 42.5,
      detail: `ABI v${abi} · Heap ${(exp.fe_heap_used_bytes() / 1024).toFixed(1)} KB · ${(performance.now() - t0).toFixed(2)} ms`
    });

    /* 2. Keyframe Bezier Curve & Motion Preset Engine */
    t0 = performance.now();
    exp.fe_anim_reset();
    exp.fe_anim_insert_keyframe(90, 0, 0, 0.0, 0);
    exp.fe_anim_insert_keyframe(90, 0, 60, 10.0, 0);
    const midVal = exp.fe_anim_evaluate_channel(90, 0, 30, 0, 60);
    const rest11 = this.allocF32(11);
    rest11.view.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 50, 0.5]);
    const presetKeys = exp.fe_anim_apply_preset(91, 2, 0, 120, 1.0, rest11.ptr);
    exp.fe_anim_reset();
    if (savedAnim) this.deserializeAnimation(savedAnim);
    results.push({
      name: 'Keyframe Curves & Motion Clips',
      ok: Math.abs(midVal - 5.0) < 0.05 && presetKeys >= 6,
      detail: `Bezier f=30 → ${midVal.toFixed(2)} · Bounce Preset (${presetKeys} keys) · ${(performance.now() - t0).toFixed(2)} ms`
    });

    /* 3. C++ 3D Sculpt Symmetry & Smooth Normal Kernel */
    t0 = performance.now();
    exp.fe_arena_reset();
    const vPos = this.allocF32(6);
    const vNrm = this.allocF32(6);
    vPos.view.set([0.4, 0.2, 0.0, -0.4, 0.2, 0.0]);
    vNrm.view.set([0, 1, 0, 0, 1, 0]);
    const moved = exp.fe_sculpt_apply_brush(vPos.ptr, vNrm.ptr, 2, 0, 0.4, 0.2, 0.0, 0, 1, 0, 0, 0, 0, 0.5, 0.6, 1);
    const symMatch = Math.abs(vPos.view[1] - vPos.view[4]) < 1e-4 && vPos.view[1] > 0.2;
    results.push({
      name: 'Sculpt Brush & Mirror-X Symmetry',
      ok: moved === 2 && symMatch,
      detail: `Moved ${moved} symmetric verts (Y=${vPos.view[1].toFixed(3)}) · ${(performance.now() - t0).toFixed(2)} ms`
    });

    /* 4. C++ Touch Filter & Mobile GPU Governor */
    t0 = performance.now();
    exp.fe_arena_reset();
    const touchOut = this.allocF32(8);
    const perfOut = this.allocF32(6);
    exp.fe_touch_reset();
    exp.fe_touch_update(2, 120, 200, 240, 200, 800, 600, 0.016, touchOut.ptr);
    exp.fe_perf_reset();
    exp.fe_perf_push_frame_ms(16.2);
    exp.fe_perf_query_metrics(0, 2.0, perfOut.ptr);
    results.push({
      name: 'Multi-Touch & GPU Governor',
      ok: perfOut.view[1] > 30 && perfOut.view[3] >= 512,
      detail: `${Math.round(perfOut.view[1])} FPS est · Shadow ${perfOut.view[3]}px · DPR ${perfOut.view[2].toFixed(2)}x`
    });

    /* 5 & 6. C++ SAH BVH Path Tracer + ACES Filmic & HDR Bloom Render */
    t0 = performance.now();
    exp.fe_render_scene_clear();
    exp.fe_arena_reset();
    /* Build an icosahedron-like UV sphere + beveled pedestal right in memory for visual proof */
    const segU = 20, segV = 14;
    const sVerts = [];
    const sNrms = [];
    const sIdx = [];
    for (let y = 0; y <= segV; y++) {
      const v = y / segV;
      const phi = v * Math.PI;
      for (let x = 0; x <= segU; x++) {
        const u = x / segU;
        const th = u * Math.PI * 2;
        const nx = -Math.cos(th) * Math.sin(phi);
        const ny = Math.cos(phi);
        const nz = Math.sin(th) * Math.sin(phi);
        sVerts.push(nx * 0.95 - 0.65, ny * 0.95 + 0.95, nz * 0.95);
        sNrms.push(nx, ny, nz);
      }
    }
    for (let y = 0; y < segV; y++) {
      for (let x = 0; x < segU; x++) {
        const a = y * (segU + 1) + x;
        const b = a + segU + 1;
        sIdx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const svBuf = this.allocF32(sVerts.length);
    const snBuf = this.allocF32(sNrms.length);
    const siBuf = this.allocU32(sIdx.length);
    svBuf.view.set(sVerts);
    snBuf.view.set(sNrms);
    siBuf.view.set(sIdx);
    exp.fe_render_add_mesh(svBuf.ptr, snBuf.ptr, siBuf.ptr, sVerts.length / 3, sIdx.length / 3, 0.39, 0.42, 0.96, 0.18, 0.82, 0.0, 1.0);

    /* Add golden metallic cube beside the sphere */
    const cPos = [
      0.35,0, -0.55,  1.65,0, -0.55,  1.65,1.3,-0.55,  0.35,1.3,-0.55,
      0.35,0,  0.75,  1.65,0,  0.75,  1.65,1.3, 0.75,  0.35,1.3, 0.75
    ];
    const cIdx = [
      4,5,6, 4,6,7,  1,0,3, 1,3,2,  3,7,6, 3,6,2,
      0,1,5, 0,5,4,  1,2,6, 1,6,5,  0,4,7, 0,7,3
    ];
    const cpBuf = this.allocF32(cPos.length);
    const ciBuf = this.allocU32(cIdx.length);
    cpBuf.view.set(cPos);
    ciBuf.view.set(cIdx);
    exp.fe_render_add_mesh(cpBuf.ptr, 0, ciBuf.ptr, 8, 12, 0.96, 0.68, 0.22, 0.26, 0.65, 0.0, 1.0);

    exp.fe_render_set_environment(4, 1.15, 1, 0.0);
    exp.fe_render_set_light(0, 2, 5, 8, 6, -0.52, -0.72, -0.46, 1.0, 0.95, 0.86, 2.6, 0.2, 0.5);
    exp.fe_render_set_camera(0.2, 2.25, 4.4, -0.03, -0.28, -0.96, 0.999, 0, -0.03, -0.008, 0.96, -0.28, 40, 16 / 9, 0.0, 4.5);
    const bvhOk = exp.fe_render_build_bvh();
    const tris = exp.fe_render_get_triangle_count();

    const rw = 240, rh = 135;
    exp.fe_render_init_framebuffer(rw, rh);
    const spp = exp.fe_render_trace_samples(3, 2, 0, rh);
    exp.fe_render_resolve_rgba8(0, 1.28, 1.06, 1.12, 0.04, 0.24, 0.16, 0.0, 0.01);
    const rgbaPtr = exp.fe_render_get_rgba8_ptr();
    const rgbaView = new Uint8ClampedArray(this.memory.buffer, rgbaPtr, rw * rh * 4);

    let litPx = 0;
    for (let i = 0; i < rgbaView.length; i += 4) {
      if (rgbaView[i] > 18 || rgbaView[i + 1] > 18 || rgbaView[i + 2] > 18) litPx++;
    }
    if (previewCanvas && previewCanvas.getContext) {
      previewCanvas.width = rw;
      previewCanvas.height = rh;
      previewCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgbaView), rw, rh), 0, 0);
    }
    const rtMs = (performance.now() - t0).toFixed(1);
    results.push({
      name: 'SAH BVH Builder & PBR Path Tracer',
      ok: bvhOk >= 1 && tris > 500 && spp === 3 && litPx > rw * rh * 0.7,
      detail: `${tris} tris · ${spp} SPP @ ${rw}×${rh} · ${rtMs} ms`
    });
    results.push({
      name: 'ACES Filmic Tone-Map & HDR Bloom',
      ok: litPx > rw * rh * 0.7,
      detail: `${((litPx / (rw * rh)) * 100).toFixed(1)}% lit pixels · Golden Sunset HDRI`
    });

    /* 7. Landscape bridge + ocean kernel: reports every degraded subsystem
       instead of only the engine-side checks. */
    t0 = performance.now();
    try {
      const land = typeof window !== 'undefined' ? window.FELandscapeCore : null;
      const present = !!land;
      const bound = !!(land && land.ready);
      let oceanOk = false;
      if (typeof exp.fe_ocean_configure === 'function' && typeof exp.fe_ocean_update === 'function') {
        oceanOk = exp.fe_ocean_configure(32, 256, 1024, 4096, 12, 30, 7) === 0 &&
          exp.fe_ocean_update(1.5, 1, 1, 3, 2) > 0 && exp.fe_ocean_resolution() === 32;
      }
      const degraded = bound && land.missing ? land.missing.length : 0;
      results.push({
        name: 'Landscape & Ocean Kernels',
        ok: oceanOk && (present ? bound && degraded === 0 : true),
        detail: (oceanOk ? `Wave field 32² · ${(performance.now() - t0).toFixed(2)} ms · ` : 'Ocean kernel unavailable · ') +
          (present ? (bound ? (degraded ? `${degraded} kernel${degraded===1?'':'s'} on JS fallback: ${land.missing.join(', ')}` : 'Every terrain, Open World and ocean kernel bound') : 'Terrain bridge did not bind — JS fallback active') : 'Terrain bridge not part of this page')
      });
    } catch (error) {
      results.push({ name: 'Landscape & Ocean Kernels', ok: false, detail: String(error.message || error) });
    }

    /* 8. Eulerian smoke & fire core: MAC-grid transport + pressure projection
       + the dual isosurface, exercised at a small grid so this row is cheap
       enough to run on a phone. There is no volume renderer yet - this row
       proves the solver runs, not that fire is visible in the viewport. */
    t0 = performance.now();
    try {
      let smokeOk = false, smokeDetail = 'Smoke & fire solver unavailable';
      if (typeof exp.fe_vol_init === 'function' && typeof exp.fe_vol_step === 'function' && typeof exp.fe_vol_surface === 'function') {
        const grid = 16, cells = grid * grid * grid;
        exp.fe_vol_init(grid, grid, grid);
        exp.fe_vol_source(0.5, 0.2, 0.5, 0.16, 1.2, 0.6, 0.8);
        for (let step = 0; step < 4; step++) exp.fe_vol_step(1 / 60, 4, 1, 0.2, 0.3, 24);
        const stats = new Float32Array(exp.memory.buffer, exp.fe_vol_stats_ptr(), 6);
        const density = new Float32Array(exp.memory.buffer, exp.fe_vol_density_ptr(), cells);
        let smokeMass = 0;
        for (let n = 0; n < cells; n++) smokeMass += density[n];
        for (let k = 0; k < grid; k++) {
          for (let j = 0; j < grid; j++) {
            for (let i = 0; i < grid; i++) {
              const x = (i + 0.5) / grid - 0.5, y = (j + 0.5) / grid - 0.5, z = (k + 0.5) / grid - 0.5;
              density[(k * grid + j) * grid + i] = 0.3 - Math.sqrt(x * x + y * y + z * z);
            }
          }
        }
        const verts = exp.fe_vol_surface(0, 1 << 16);
        smokeOk = exp.fe_vol_grid_size() === grid && Number.isFinite(stats[1]) &&
          stats[1] <= stats[0] && smokeMass > 0 && verts > 0 &&
          exp.fe_vol_surface_index_count() > 0 && exp.fe_vol_surface_index_count() % 3 === 0;
        smokeDetail = `16³ MAC grid · div ${Number(stats[0]).toFixed(1)}→${Number(stats[1]).toFixed(2)} · ${verts} surface verts · ${(performance.now() - t0).toFixed(2)} ms`;
        exp.fe_vol_init(grid, grid, grid);
      }
      results.push({ name: 'Smoke & Fire Volume Solver', ok: smokeOk, detail: smokeDetail });
    } catch (error) {
      results.push({ name: 'Smoke & Fire Volume Solver', ok: false, detail: String(error.message || error) });
    }

    const allOk = results.every(r => r.ok);
    return { ok: allOk, results, totalMs: +(performance.now() - tTotal0).toFixed(1) };
  };

  async function openCppDiagnosticsModal() {
    let modal = document.getElementById('cpp-diagnostics-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cpp-diagnostics-modal';
      modal.className = 'render-modal-backdrop';
      modal.onclick = e => { if (e.target === modal) modal.hidden = true; };
      modal.innerHTML =
        '<div class="render-modal-window" style="max-width:680px;">' +
          '<header class="render-modal-head">' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              '<span style="font-size:20px;">🧪</span>' +
              '<div>' +
                '<strong style="font-size:15px;color:#f8fafc;">Performance Benchmark</strong>' +
                '<div style="font-size:11px;color:#94a3b8;">Measures animation, sculpt, touch and path-tracing speed on this device</div>' +
              '</div>' +
            '</div>' +
            '<button class="export-modal-close" type="button" onclick="document.getElementById(\'cpp-diagnostics-modal\').hidden=true">✕</button>' +
          '</header>' +
          '<div class="diagnostics-body" style="padding:14px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;">' +
            '<div style="background:#090b10;border:1px solid #262c40;border-radius:12px;padding:10px;text-align:center;">' +
              '<canvas id="cpp-diag-canvas" width="320" height="180" style="width:100%;max-width:460px;height:auto;border-radius:8px;"></canvas>' +
              '<div id="cpp-diag-summary" style="margin-top:8px;font-size:12px;font-weight:700;color:#34d399;">Running benchmark…</div>' +
            '</div>' +
            '<div id="cpp-diag-list" style="display:flex;flex-direction:column;gap:7px;"></div>' +
          '</div>' +
          '<footer class="render-actions-bar">' +
            '<button class="export-action-btn" type="button" onclick="openCppDiagnosticsModal()">🔄 Re-Run Benchmark</button>' +
            '<button class="export-action-btn" type="button" style="background:#4f46e5;border-color:#818cf8;" onclick="document.getElementById(\'cpp-diagnostics-modal\').hidden=true;FE.open(\'core\')">🧊 Open 3D Workspace</button>' +
            '<button class="btn btn-secondary" type="button" style="margin-left:auto;" onclick="document.getElementById(\'cpp-diagnostics-modal\').hidden=true">Close</button>' +
          '</footer>' +
        '</div>';
      document.body.appendChild(modal);
    }
    modal.hidden = false;
    const summaryEl = document.getElementById('cpp-diag-summary');
    const listEl = document.getElementById('cpp-diag-list');
    const cv = document.getElementById('cpp-diag-canvas');
    if (summaryEl) summaryEl.textContent = 'Running performance benchmark…';
    if (listEl) listEl.innerHTML = '';

    let report;
    try {
      report = await FECppEngine.runLiveSelfTest(cv);
    } catch (error) {
      report = {ok:false, totalMs:0, results:[{name:'Diagnostics execution',ok:false,detail:String(error.message || error)}]};
    } finally {
      FECppEngine.exports?.fe_perf_reset();
      FECppEngine.lastFrameTick = performance.now();
    }
    FECppEngine.lastDiagnosticsReport = report;
    console.info('[FECppEngine] Diagnostics report', report);
    if (summaryEl) {
      summaryEl.style.color = report.ok ? '#34d399' : '#f87171';
      summaryEl.textContent = report.ok
        ? `✅ ${report.results.length}/${report.results.length} CHECKS PASSED (${report.totalMs} ms total)`
        : `⚠️ Failed: ${report.results.filter(r => !r.ok).map(r => r.name).join(' · ')}. See details below.`;
    }
    if (listEl) {
      listEl.innerHTML = report.results.map(r =>
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;background:#161926;border:1px solid ${r.ok ? 'rgba(52,211,153,0.32)' : 'rgba(248,113,113,0.4)'};">` +
          `<span style="font-size:12px;font-weight:700;color:#e2e8f0;">${r.ok ? '✅' : '❌'} ${r.name}</span>` +
          `<span style="font-size:11px;color:#94a3b8;font-family:ui-monospace,monospace;">${r.detail}</span>` +
        `</div>`
      ).join('');
    }
  }
  window.openCppDiagnosticsModal = openCppDiagnosticsModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireWorkspaceIntegration);
  } else {
    setTimeout(wireWorkspaceIntegration, 0);
  }
})();
