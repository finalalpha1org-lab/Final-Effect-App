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

  /* Kernels the shell expects from fe_core_engine.wasm. A deployment that serves
     an older artifact still boots (the ABI is forwards compatible), but the
     benchmark has to say exactly which subsystem is missing instead of a vague
     "unavailable". */
  const REQUIRED_KERNELS = Object.freeze({
    animation: ['fe_anim_insert_keyframe', 'fe_anim_evaluate_channel', 'fe_anim_bake_samples'],
    ocean: ['fe_ocean_configure', 'fe_ocean_update', 'fe_ocean_resolution'],
    terrain: ['fe_terrain_erode_brush', 'fe_terrain_erode_hydraulic', 'fe_lod_visible', 'fe_lod_visible_index_ptr', 'fe_lod_visible_tier_ptr'],
    surface: ['fe_surface_pbr', 'fe_surface_detail', 'fe_water_optical'],
    flora: ['fe_flora_tree', 'fe_flora_rock', 'fe_flora_leaf_ptr', 'fe_flora_sway_ptr', 'fe_flora_phase_ptr', 'fe_flora_lsystem', 'fe_flora_lsystem_plant'],
    climate: ['fe_climate_at', 'fe_climate_weather', 'fe_climate_biome'],
    volumetrics: ['fe_vol_init', 'fe_vol_step', 'fe_vol_surface', 'fe_vol_stats_ptr', 'fe_vol_density_ptr', 'fe_vol_grid_size'],
    modifiers: ['fe_mod_begin', 'fe_mod_subdivide', 'fe_mod_lattice_apply', 'fe_mod_shrinkwrap'],
    simulation: ['fe_sim_bake_compress', 'fe_sim_xpbd_deformable_step', 'fe_sim_liquid_pbf_step', 'fe_sim_pyro_step']
  });

  function describeArtifact(exportsObject, byteLength = 0) {
    const names = exportsObject ? Object.keys(exportsObject) : [];
    const available = new Set(names);
    const missing = [];
    const modules = {};
    for (const [module, kernels] of Object.entries(REQUIRED_KERNELS)) {
      const absent = kernels.filter(kernel => !available.has(kernel));
      modules[module] = absent.length === 0;
      for (const kernel of absent) missing.push(kernel);
    }
    return {
      bytes: byteLength,
      exports: names.length,
      missing,
      modules,
      complete: missing.length === 0
    };
  }

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
        this.artifactBytes = typeof buf === 'object' && buf ? (buf.byteLength || buf.length || 0) : 0;
        this.artifact = describeArtifact(exp, this.artifactBytes);
        if (!this.artifact.complete) {
          console.warn('[FECppEngine] Engine artifact is missing kernels:', this.artifact.missing.join(', '));
        }
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

      /* Both candidates are tried, and the one with the most kernels wins. The
         repo ships the ABI-checked binary at ./wasm/fe_core_engine.wasm, while
         ./fe_core_engine.wasm is an untracked copy written by the C++ build -
         so a host that kept an old root copy from an earlier deploy must never
         shadow the current artifact. */
      const urls = ['./fe_core_engine.wasm', './wasm/fe_core_engine.wasm'];
      let lastErr = null;
      let best = null;
      for (const rel of urls) {
        try {
          const url = new URL(rel, document.baseURI || window.location.href).href;
          const res = await fetch(url, { cache: 'no-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
          const buf = await res.arrayBuffer();
          await mountWasmBuffer(buf);
          if (!best || this.artifact.exports > best.artifact.exports) best = { url, buf, artifact: this.artifact };
          if (this.artifact.complete) { this.artifactSource = rel; return this.exports; }
        } catch (err) {
          lastErr = err;
        }
      }
      if (best) {
        /* Keep the richest artifact found, even if no candidate is complete. */
        if (this.artifact?.exports !== best.artifact.exports) await mountWasmBuffer(best.buf);
        this.artifactUrl = best.url;
        this.artifactSource = 'best of ' + urls.join(' + ');
        /* An installed client can still hold an older binary in a browser or
           proxy cache: retry once with a cache-busting query before giving up. */
        await this.ensureFreshArtifact();
        if (!this.artifact?.complete) this.warnStaleArtifact();
        return this.exports;
      }
      this.loadError = lastErr;
      console.warn('[FECppEngine] Could not load fe_core_engine.wasm:', lastErr);
      updateCppStatusBadges();
      return null;
    },

    /* Re-fetch the artifact with a cache-busting query and swap it in when it
       carries more kernels than the copy already in memory. Returns true when
       the engine now has every kernel the shell needs. */
    async ensureFreshArtifact({ force = false } = {}) {
      if (!this.artifact || (this.artifact.complete && !force)) return this.artifact?.complete ?? false;
      if (typeof fetch !== 'function') return false;
      const base = this.artifactUrl || new URL('./fe_core_engine.wasm', document.baseURI || window.location.href).href;
      const bust = `${base}${base.includes('?') ? '&' : '?'}v=${Date.now().toString(36)}`;
      try {
        const res = await fetch(bust, { cache: 'reload' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const mod = await WebAssembly.compile(buf);
        const inst = await WebAssembly.instantiate(mod, {});
        const next = describeArtifact(inst.exports, buf.byteLength);
        if (!force && next.exports <= (this.artifact?.exports || 0)) {
          return this.artifact?.complete ?? false;
        }
        if (typeof inst.exports.fe_core_abi_version !== 'function' || inst.exports.fe_core_abi_version() !== 1) {
          throw new Error('Unexpected engine ABI version');
        }
        this.wasm = inst;
        this.exports = inst.exports;
        this.memory = inst.exports.memory;
        this.ready = true;
        this.loadError = null;
        this.artifact = next;
        this.artifactSource = 'cache-busted refetch';
        inst.exports.fe_anim_reset?.();
        inst.exports.fe_touch_reset?.();
        inst.exports.fe_perf_reset?.();
        updateCppStatusBadges();
        return next.complete;
      } catch (error) {
        console.warn('[FECppEngine] Artifact refresh failed:', error);
        return this.artifact?.complete ?? false;
      }
    },

    /* Human readable one-liner used by the benchmark and the diagnostics sheet. */
    artifactSummary() {
      const a = this.artifact;
      if (!a) return 'Engine artifact not loaded';
      const size = a.bytes ? `${(a.bytes / 1024).toFixed(0)} KB · ` : '';
      return `${size}${a.exports} exports${a.complete ? '' : ` · missing ${a.missing.length} kernel${a.missing.length === 1 ? '' : 's'}`}`;
    },

    requiresDeploymentRefresh() {
      return !!this.artifact && !this.artifact.complete;
    },

    /* Console only, on purpose: the shell shows no engine/version chrome, so the
       stale-binary story is told where the user asked for it - the benchmark
       sheet, which owns the banner and the Repair Engine button. */
    warnStaleArtifact() {
      if (this._staleWarned) return;
      this._staleWarned = true;
      console.warn('[FECppEngine] Outdated engine artifact:', this.artifactSummary());
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
      else if (group === 'keyset') channelsToKey = keyingSetChannels(this.keyingSet);

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
        // Keep a stable, sharp viewport. High Refresh Mode deliberately trades
        // some super-sampling for frame rate, never sub-native resolution.
        const sharpCap = window.__feHighRefresh ? 1.5 : 2;
        const sharpDpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), sharpCap);
        const curPr = eng.r.getPixelRatio();
        if (Math.abs(curPr - sharpDpr) > 0.01) {
          eng.r.setPixelRatio(sharpDpr);
          const vp = document.getElementById('viewport-core');
          if (vp && vp.clientWidth && vp.clientHeight) {
            eng.r.setSize(vp.clientWidth, vp.clientHeight, false);
          }
        }
        const shadowTarget = window.__feHighRefresh ? Math.min(shadowRes, 1024) : shadowRes;
        if (eng.d?.shadow?.mapSize && eng.d.shadow.mapSize.x !== shadowTarget) {
          eng.d.shadow.mapSize.set(shadowTarget, shadowTarget);
          if (eng.d.shadow.map) {
            eng.d.shadow.map.dispose();
            eng.d.shadow.map = null;
          }
        }
      }

      /* Auto quality may drop temporal AA when the device is already GPU-bound;
         the resolution stays sharp so the viewport never turns blurry. */
      if (eng?.taa && GLOBAL_SETTINGS.taa !== false && !GLOBAL_SETTINGS.highRefresh) {
        const qualitySel = document.getElementById('ws-quality');
        const isAuto = !qualitySel || qualitySel.value === '0';
        /* Single source of truth for the RAF loop. Hysteresis prevents the
           classic auto-quality ping-pong: TAA off raises the frame rate, the
           higher tier would switch it back on, the frame rate drops again. */
        if (!isAuto) {
          eng._autoTaa = true;
          eng._autoTaaGood = 0;
        } else if (tier === 0) {
          eng._autoTaa = false;
          eng._autoTaaGood = 0;
        } else if (eng._autoTaa === false) {
          eng._autoTaaGood = (eng._autoTaaGood || 0) + 1;
          if (eng._autoTaaGood >= 4) { eng._autoTaa = true; eng._autoTaaGood = 0; }
        }
      }

      const vm = eng?.viewportMetrics || {};
      const perfStats = {
        fps: Math.min(120, Math.round(fps)),
        avgMs,
        tier,
        tierLabel: tier === 0 ? 'Low' : tier === 1 ? 'Medium' : 'High',
        dpr: recDpr,
        shadowRes,
        cpuMs: Number(vm.cpuMs || 0),
        renderMs: Number(vm.renderSubmitMs || 0),
        physicsMs: Number(vm.physicsMs || 0),
        drawCalls: Number(vm.drawCalls || 0),
        triangles: Number(vm.triangles || 0),
        taa: !!eng?.taa?.enabled && !!eng?.taa?.ok
      };
      /* One-time hint: the panel is clearly capable of more than 60 Hz. */
      try {
        if (!window.__feRefreshHinted && (window.__feDisplayHz || 0) >= 90 && !GLOBAL_SETTINGS.highRefresh &&
            !localStorage.getItem('fe_high_refresh_hint')) {
          window.__feRefreshHinted = true;
          localStorage.setItem('fe_high_refresh_hint', '1');
          window.FE?.toast?.('This display runs above 85 Hz — enable High Refresh Mode in ⚙ for smoother motion');
        }
      } catch (_) {}

      window.FEWorkspacePerf = perfStats;
      window.fepdateWorkspacePerf?.(perfStats);
      const settingsPerfLabel = document.getElementById('cpp-perf-live-readout');
      if (settingsPerfLabel) {
        const tierNames = ['Low (Mobile 60fps)', 'Medium (Balanced)', 'High (Pro Quality)'];
        settingsPerfLabel.textContent = `${avgMs.toFixed(1)} ms · ${Math.round(fps)} FPS · ${tierNames[tier] || 'High'} quality · ${recDpr.toFixed(2)}x`;
      }
    }
  };


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


  /* -----------------------------------------------------------------------
   * Animation Studio: curve/dope editing, keying sets, simulation bake,
   * onion skin, motion trails, camera paths and glTF animation export.
   * --------------------------------------------------------------------- */
  const KEYING_SETS = {
    transform: { label: 'Keying Set: Full Transform', channels: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
    location: { label: 'Keying Set: Location', channels: [0, 1, 2] },
    rotation: { label: 'Keying Set: Rotation', channels: [3, 4, 5] },
    scale: { label: 'Keying Set: Scale', channels: [6, 7, 8] },
    locrot: { label: 'Keying Set: Location + Rotation', channels: [0, 1, 2, 3, 4, 5] },
    all: { label: 'Keying Set: All Channels', channels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    extra: { label: 'Keying Set: Lens / Light', channels: [9, 10] }
  };

  function keyingSetChannels(id) {
    return (KEYING_SETS[id] || KEYING_SETS.transform).channels.slice();
  }

  function animationCanvasMetrics(w, h, startF, endF) {
    const padL = 88, padR = 14, padT = 22, padB = 12;
    const plotW = Math.max(40, w - padL - padR);
    const plotH = Math.max(40, h - padT - padB);
    const span = Math.max(1e-6, endF - startF);
    return {
      padL, padR, padT, padB, plotW, plotH,
      frameToX: f => padL + ((f - startF) / span) * plotW,
      xToFrame: x => startF + ((x - padL) / plotW) * span
    };
  }

  function readAllKeys(slot, channel) {
    if (!FECppEngine.ready) return [];
    FECppEngine.exports.fe_arena_reset();
    const buf = FECppEngine.allocF32(128 * 3);
    const n = FECppEngine.exports.fe_anim_list_object_keyframes(slot, channel, buf.ptr, 128);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ frame: buf.view[i * 3], value: buf.view[i * 3 + 1], interp: buf.view[i * 3 + 2] });
    }
    return out;
  }

  function sceneTimeConfig() {
    const cfg = window.timelineConfig || {};
    const startF = Number(cfg.startFrame || 0);
    const endF = Math.max(startF + 1, Number(cfg.endFrame || 250));
    const curF = Number(cfg.currentFrame || 0);
    const fps = Math.max(1, Number(cfg.fps || 30));
    return { startF, endF, curF, fps };
  }

  Object.assign(FECppEngine, {
    keyingSet: 'transform',
    editorMode: 'dope',
    graphChannel: 0,
    selectedKey: null,
    onionSkin: { enabled: false, before: 2, after: 2 },
    motionTrail: { enabled: false, length: 30 },
    _onionGroup: null,
    _trailGroup: null,
    _trailLine: null,

    toggleAutoKey() {
      this.autoKey = !this.autoKey;
      refreshAnimationStudioUI();
      window.FE?.toast?.(this.autoKey ? 'Auto-Key enabled — transform edits are keyed' : 'Auto-Key disabled');
    },

    setKeyingSet(id) {
      this.keyingSet = KEYING_SETS[id] ? id : 'transform';
      refreshAnimationStudioUI();
      window.FE?.toast?.((KEYING_SETS[this.keyingSet]).label.replace('Keying Set: ', 'Keying set → '));
    },

    setAnimationEditorMode(mode) {
      this.editorMode = mode === 'graph' ? 'graph' : 'dope';
      const canvas = document.getElementById('anim-dopesheet-canvas');
      if (canvas) canvas.style.cursor = this.editorMode === 'graph' ? 'crosshair' : 'ew-resize';
      if (document.body?.classList) document.body.classList.toggle('anim-graph-mode', this.editorMode === 'graph');
      renderDopeSheetAndCurveCanvas();
    },

    setGraphChannel(channel) {
      this.graphChannel = Math.max(0, Math.min(10, parseInt(channel, 10) || 0));
      renderDopeSheetAndCurveCanvas();
    },

    getAnimationCanvasMetrics() {
      const canvas = document.getElementById('anim-dopesheet-canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const { startF, endF } = sceneTimeConfig();
      return Object.assign({ rect, startF, endF }, animationCanvasMetrics(rect.width, rect.height, startF, endF));
    },

    animationValueRange(slot, startF, endF) {
      if (!this.ready) return { min: -1, max: 1 };
      let min = Infinity, max = -Infinity;
      this.exports.fe_arena_reset();
      const buf = this.allocF32(64);
      for (let c = 0; c < CH.COUNT; c++) {
        if (this.exports.fe_anim_get_keyframe_count(slot, c) === 0) continue;
        const n = this.exports.fe_anim_sample_channel(slot, c, startF, endF, 48, buf.ptr, 64);
        for (let i = 0; i < n; i++) {
          const v = buf.view[i];
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
      if (max - min < 1e-4) { min -= 0.5; max += 0.5; }
      const pad = (max - min) * 0.08;
      return { min: min - pad, max: max + pad };
    },

    hitTestAnimationKey(clientX, clientY) {
      if (!this.ready) return null;
      const m = this.getAnimationCanvasMetrics();
      if (!m) return null;
      const px = clientX - m.rect.left;
      const py = clientY - m.rect.top;
      if (px < m.padL - 6 || px > m.rect.width - m.padR + 6) return null;
      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const slot = this.getSlotForObjectId(objId);
      if (this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) return null;

      let best = null;
      const consider = (channel, frame, value, x, y, radius) => {
        const d = Math.hypot(x - px, y - py);
        if (d <= radius && (!best || d < best.d)) best = { slot, channel, frame, value, d };
      };

      if (this.editorMode === 'graph') {
        const range = this.animationValueRange(slot, m.startF, m.endF);
        const valueToY = v => m.padT + m.plotH - ((v - range.min) / (range.max - range.min)) * m.plotH;
        for (let c = 0; c < CH.COUNT; c++) {
          for (const key of readAllKeys(slot, c)) {
            consider(c, key.frame, key.value, m.frameToX(key.frame), valueToY(key.value), 10);
          }
        }
      } else {
        const groups = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10]];
        const rowH = m.plotH / groups.length;
        groups.forEach((chs, idx) => {
          const yMid = m.padT + idx * rowH + rowH * 0.5;
          for (const c of chs) {
            for (const key of readAllKeys(slot, c)) {
              consider(c, key.frame, key.value, m.frameToX(key.frame), yMid, 9);
            }
          }
        });
      }
      return best;
    },

    beginKeyDrag(hit) {
      this.selectedKey = hit ? { slot: hit.slot, channel: hit.channel, frame: hit.frame, value: hit.value } : null;
      renderDopeSheetAndCurveCanvas();
    },

    updateKeyDrag(newFrame, newValue) {
      const sel = this.selectedKey;
      if (!this.ready || !sel) return false;
      const frame = Math.round(Math.max(0, newFrame) * 100) / 100;
      const value = Number.isFinite(newValue) ? newValue : sel.value;
      if (Math.abs(frame - sel.frame) < 1e-4 && Math.abs(value - sel.value) < 1e-6) return false;
      const res = this.exports.fe_anim_edit_key(sel.slot, sel.channel, sel.frame, frame, value, 0.8);
      if (res < 0) return false;
      sel.frame = frame;
      sel.value = value;
      renderDopeSheetAndCurveCanvas();
      return true;
    },

    endKeyDrag() {
      const sel = this.selectedKey;
      if (!sel) return;
      this.evaluateSceneAtFrame(sceneTimeConfig().curF);
      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
    },

    deleteSelectedAnimationKey() {
      const sel = this.selectedKey;
      if (!this.ready || !sel) {
        window.FE?.toast?.('Drag-select a keyframe first');
        return 0;
      }
      const removed = this.exports.fe_anim_delete_keys_in_range(sel.slot, 1 << sel.channel, sel.frame, sel.frame);
      if (removed > 0) {
        this.selectedKey = null;
        this.evaluateSceneAtFrame(sceneTimeConfig().curF);
        refreshAnimationStudioUI();
        if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
        window.FE?.toast?.(`Deleted ${CHANNEL_LABELS[sel.channel]} key at frame ${sel.frame}`);
      }
      return removed;
    },

    duplicateSelectedAnimationKey() {
      const sel = this.selectedKey;
      if (!this.ready || !sel) {
        window.FE?.toast?.('Drag-select a keyframe first');
        return 0;
      }
      const copied = this.exports.fe_anim_duplicate_keys_in_range(sel.slot, 1 << sel.channel, sel.frame, sel.frame, 10);
      if (copied > 0) {
        this.selectedKey = { slot: sel.slot, channel: sel.channel, frame: sel.frame + 10, value: sel.value };
        refreshAnimationStudioUI();
        window.FE?.toast?.(`Duplicated ${CHANNEL_LABELS[sel.channel]} key to frame ${sel.frame + 10}`);
      }
      return copied;
    },

    /* ---- Simulation bake: freeze cloth / soft body deformation ---- */
    bakeSimulation() {
      if (!this.ready) { window.FE?.toast?.('Engine still starting…'); return 0; }
      const mesh = window.getActiveObjectMesh?.();
      const record = mesh?.userData?.clothSim || mesh?.userData?.softBodySim;
      if (!mesh || !record) {
        window.FE?.toast?.('Select a cloth or soft body object to bake');
        return 0;
      }
      const geo = mesh.geometry;
      const attr = geo?.attributes?.position;
      if (!attr) { window.FE?.toast?.('This object has no deformable mesh'); return 0; }

      const { startF, endF, curF, fps } = sceneTimeConfig();
      const vertexCount = attr.count;
      const maxFrames = 120;
      const stepFrames = Math.max(1, Math.ceil((endF - startF + 1) / maxFrames));
      const frameList = [];
      for (let f = startF; f <= endF; f += stepFrames) frameList.push(f);
      if (frameList[frameList.length - 1] !== endF) frameList.push(endF);

      const floatCount = frameList.length * vertexCount * 3;
      if (floatCount > 4000000) {
        window.FE?.toast?.('Bake range is too dense — shorten it or use a lighter mesh');
        return 0;
      }

      const captured = new Float32Array(floatCount);
      window.FE?.toast?.('Baking simulation…');
      try {
        window.resetAllPhysicsSimulations?.();
        let next = 0;
        for (let f = startF; f <= endF; f++) {
          if (next < frameList.length && frameList[next] === f) {
            const src = geo.attributes.position.array;
            captured.set(src.subarray(0, vertexCount * 3), next * vertexCount * 3);
            next++;
          }
          if (f < endF) window.stepPhysicsSimulations?.(1 / fps);
        }
      } catch (err) {
        window.FE?.toast?.('Simulation bake failed: ' + err.message);
        return 0;
      }

      this.exports.fe_arena_reset();
      const inPtr = this.exports.fe_malloc(floatCount * 4);
      new Float32Array(this.memory.buffer, inPtr, floatCount).set(captured);
      const outPtr = this.exports.fe_malloc(frameList.length * 4);
      const keptCount = this.exports.fe_sim_bake_compress(inPtr, frameList.length, vertexCount, 0.0025, outPtr, frameList.length);
      const keptIndex = new Uint32Array(this.memory.buffer, outPtr, keptCount).slice();

      const frames = [];
      for (const idx of keptIndex) {
        frames.push({
          frame: frameList[idx],
          positions: captured.slice(idx * vertexCount * 3, (idx + 1) * vertexCount * 3)
        });
      }
      mesh.userData.simBake = {
        type: mesh.userData.clothSim ? 'Cloth' : 'SoftBody',
        frameStart: startF,
        frameEnd: endF,
        fps,
        vertexCount,
        sourceFrames: frameList.length,
        frames
      };
      mesh.userData.simBake._lastFrame = null;

      window.seekTimelinePhysics?.(curF);
      this.applySimulationBakeAtFrame(curF);
      refreshAnimationStudioUI();
      window.FE?.toast?.(`Baked ${frames.length} of ${frameList.length} simulation frames`);
      return frames.length;
    },

    clearSimulationBake() {
      const mesh = window.getActiveObjectMesh?.();
      const bake = mesh?.userData?.simBake;
      if (!bake) { window.FE?.toast?.('No baked simulation on this object'); return 0; }
      delete mesh.userData.simBake;
      try {
        window.SimEngine?.resetSimulation?.(bake.type, mesh);
      } catch {}
      window.seekTimelinePhysics?.(sceneTimeConfig().curF);
      refreshAnimationStudioUI();
      window.FE?.toast?.('Cleared simulation bake');
      return 1;
    },

    applySimulationBakeAtFrame(frame) {
      const eng = window.FE?.engines?.core;
      if (!eng?.sc) return false;
      let applied = false;
      eng.sc.children.forEach(child => {
        const bake = child.userData?.simBake;
        if (!bake || !bake.frames?.length) return;
        const attr = child.geometry?.attributes?.position;
        if (!attr) return;
        const frames = bake.frames;
        const f = Math.max(frames[0].frame, Math.min(frames[frames.length - 1].frame, frame));
        let i = 0;
        while (i < frames.length - 1 && frames[i + 1].frame <= f) i++;
        const a = frames[i];
        const b = frames[Math.min(frames.length - 1, i + 1)];
        const span = Math.max(1e-6, b.frame - a.frame);
        const t = a === b ? 0 : Math.max(0, Math.min(1, (f - a.frame) / span));
        const dst = attr.array;
        const pa = a.positions, pb = b.positions;
        const count = Math.min(dst.length, pa.length);
        if (t < 1e-4) {
          dst.set(pa.subarray(0, count));
        } else {
          for (let k = 0; k < count; k++) dst[k] = pa[k] + (pb[k] - pa[k]) * t;
        }
        attr.needsUpdate = true;
        if (child.geometry.computeVertexNormals) child.geometry.computeVertexNormals();
        bake._lastFrame = f;
        applied = true;
      });
      return applied;
    },

    /* ---- Onion skin ghosts ---- */
    _onionGhostMaterial(obj, past) {
      const T = window.THREE;
      if (!T) return null;
      this._onionMaterials = this._onionMaterials || {};
      if (this._onionMaterialSource !== obj.uuid) {
        this._onionMaterials = {};
        this._onionMaterialSource = obj.uuid;
      }
      const key = past ? 'past' : 'future';
      if (!this._onionMaterials[key]) {
        const base = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        const material = base?.clone?.();
        if (!material) return null;
        material.transparent = true;
        material.opacity = past ? 0.2 : 0.14;
        material.depthWrite = false;
        if (material.color) material.color.setHex(past ? 0x38bdf8 : 0xf472b6);
        if (material.emissive) material.emissive.setHex(past ? 0x0b3a5a : 0x4a1030);
        if ('metalness' in material) material.metalness = 0;
        if ('roughness' in material) material.roughness = 1;
        this._onionMaterials[key] = material;
      }
      return this._onionMaterials[key];
    },

    updateOnionSkin() {
      const T = window.THREE;
      const eng = window.FE?.engines?.core;
      if (!T || !eng?.sc) return;
      if (!this._onionGroup) {
        this._onionGroup = new T.Group();
        this._onionGroup.name = 'OnionSkin';
        this._onionGroup.userData.feOnionGhost = true;
        eng.sc.add(this._onionGroup);
      }
      const group = this._onionGroup;
      if (!group.parent) eng.sc.add(group);
      for (let i = group.children.length - 1; i >= 0; i--) group.remove(group.children[i]);
      const sheet = document.getElementById('animation-sheet');
      const open = !!(sheet && !sheet.hidden && sheet.style.display !== 'none');
      if (!this.onionSkin.enabled || !open || !this.ready || window.timelineConfig?.isPlaying) {
        group.visible = false;
        return;
      }

      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const obj = window.getActiveObjectMesh?.();
      if (!obj || !obj.geometry) { group.visible = false; return; }
      const slot = this.getSlotForObjectId(objId);
      if (this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) { group.visible = false; return; }

      const { startF, endF, curF } = sceneTimeConfig();
      const before = Math.max(0, Math.min(5, this.onionSkin.before | 0));
      const after = Math.max(0, Math.min(5, this.onionSkin.after | 0));
      const offsets = [];
      for (let d = 1; d <= Math.max(before, after); d++) {
        if (d <= before) offsets.push(-d);
        if (d <= after) offsets.push(d);
      }

      this.exports.fe_arena_reset();
      const out = this.allocF32(15);
      const parentWorld = obj.parent && obj.parent !== eng.sc ? obj.parent.matrixWorld : null;
      let made = 0;
      for (const off of offsets) {
        const ghostFrame = Math.max(startF, Math.min(endF, curF + off));
        if (Math.abs(ghostFrame - curF) < 1e-3) continue;
        if (this.exports.fe_anim_evaluate_object(slot, ghostFrame, startF, endF, out.ptr) <= 0) continue;
        const v = out.view;
        const material = this._onionGhostMaterial(obj, off < 0);
        if (!material) continue;
        const ghost = new T.Mesh(obj.geometry, material);
        const pos = new T.Vector3(v[0], v[1], v[2]);
        const quat = new T.Quaternion().setFromEuler(new T.Euler(v[3] * DEG2RAD, v[4] * DEG2RAD, v[5] * DEG2RAD, 'XYZ'));
        const scl = new T.Vector3(Math.max(0.01, v[6]), Math.max(0.01, v[7]), Math.max(0.01, v[8]));
        if (parentWorld) {
          const local = new T.Matrix4().compose(pos, quat, scl);
          ghost.matrixAutoUpdate = false;
          ghost.matrix.multiplyMatrices(parentWorld, local);
        } else {
          ghost.position.copy(pos);
          ghost.quaternion.copy(quat);
          ghost.scale.copy(scl);
        }
        ghost.raycast = () => {};
        ghost.userData.feOnionGhost = true;
        ghost.renderOrder = -1;
        group.add(ghost);
        made++;
      }
      group.visible = made > 0;
    },

    toggleOnionSkin() {
      this.onionSkin.enabled = !this.onionSkin.enabled;
      const range = parseInt(document.getElementById('anim-onion-range')?.value || '2', 10) || 2;
      this.onionSkin.before = range;
      this.onionSkin.after = range;
      this.updateOnionSkin();
      refreshAnimationStudioUI();
      window.FE?.toast?.(this.onionSkin.enabled ? `Onion skin on (${range} before / ${range} after)` : 'Onion skin off');
    },

    setOnionRange(value) {
      const range = Math.max(1, Math.min(5, parseInt(value, 10) || 2));
      this.onionSkin.before = range;
      this.onionSkin.after = range;
      if (this.onionSkin.enabled) this.updateOnionSkin();
    },

    /* ---- Motion trail ---- */
    updateMotionTrail() {
      const T = window.THREE;
      const eng = window.FE?.engines?.core;
      if (!T || !eng?.sc) return;
      if (!this._trailGroup) {
        this._trailGroup = new T.Group();
        this._trailGroup.name = 'MotionTrail';
        this._trailGroup.userData.feOnionGhost = true;
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(new Float32Array(3 * 128), 3));
        geo.setAttribute('color', new T.BufferAttribute(new Float32Array(3 * 128), 3));
        const mat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
        this._trailLine = new T.Line(geo, mat);
        this._trailLine.frustumCulled = false;
        this._trailGroup.add(this._trailLine);
        eng.sc.add(this._trailGroup);
      }
      const group = this._trailGroup;
      if (!group.parent) eng.sc.add(group);
      const sheet = document.getElementById('animation-sheet');
      const sheetOpen = !!(sheet && !sheet.hidden && sheet.style.display !== 'none');
      if (!this.motionTrail.enabled || !sheetOpen || !this.ready) { group.visible = false; return; }

      const objId = window.FE?.getActiveObjectId?.() || 'cube';
      const obj = window.getActiveObjectMesh?.();
      const slot = this.getSlotForObjectId(objId);
      if (!obj || this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) { group.visible = false; return; }

      const { startF, endF, curF } = sceneTimeConfig();
      const length = Math.max(2, Math.min(120, this.motionTrail.length | 0));
      const from = Math.max(startF, curF - length);
      const to = curF;
      const count = Math.max(2, Math.round(to - from) + 1);

      const base = this.readObjectChannels11(objId);
      this.exports.fe_arena_reset();
      const buf = this.allocF32(64);
      const coords = [];
      for (let c = 0; c < 3; c++) {
        if (this.exports.fe_anim_get_keyframe_count(slot, c) > 0) {
          const n = this.exports.fe_anim_sample_channel(slot, c, from, to, count, buf.ptr, 64);
          const arr = new Float32Array(count);
          for (let i = 0; i < count; i++) arr[i] = buf.view[Math.min(n - 1, i)];
          coords.push(arr);
        } else {
          coords.push(new Float32Array(count).fill(base[c]));
        }
      }

      const geo = this._trailLine.geometry;
      const posAttr = geo.attributes.position;
      const colAttr = geo.attributes.color;
      const positions = posAttr.array;
      const colors = colAttr.array;
      const now = new T.Color(0xffd166);
      const old = new T.Color(0x6366f1);
      const mix = new T.Color();
      for (let i = 0; i < count; i++) {
        positions[i * 3] = coords[0][i];
        positions[i * 3 + 1] = coords[1][i];
        positions[i * 3 + 2] = coords[2][i];
        mix.copy(old).lerp(now, count === 1 ? 1 : i / (count - 1));
        colors[i * 3] = mix.r;
        colors[i * 3 + 1] = mix.g;
        colors[i * 3 + 2] = mix.b;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      geo.setDrawRange(0, count);
      geo.computeBoundingSphere();
      group.visible = true;
    },

    toggleMotionTrail() {
      this.motionTrail.enabled = !this.motionTrail.enabled;
      this.updateMotionTrail();
      refreshAnimationStudioUI();
      window.FE?.toast?.(this.motionTrail.enabled ? 'Motion trail on' : 'Motion trail off');
    },

    /* ---- Camera path animation ---- */
    buildCameraPath() {
      if (!this.ready) { window.FE?.toast?.('Engine still starting…'); return 0; }
      const T = window.THREE;
      const eng = window.FE?.engines?.core;
      const camObj = this.resolveObjectById('camera');
      if (!T || !eng?.sc || !camObj) { window.FE?.toast?.('Camera is not ready'); return 0; }

      const { startF, endF, curF } = sceneTimeConfig();
      const target = new T.Vector3(0, 1, 0);
      const active = window.getActiveObjectMesh?.();
      if (active && active !== camObj) active.getWorldPosition(target);

      const ampEl = document.getElementById('anim-preset-amp');
      const amp = ampEl ? Math.max(0.1, Number(ampEl.value) || 1) : 1;
      let size = 2;
      if (active) {
        const box = new T.Box3().setFromObject(active);
        if (!box.isEmpty()) {
          const s = box.getSize(new T.Vector3());
          size = Math.max(s.x, s.y, s.z, 0.5);
        }
      }
      const radius = Math.max(2.2, size * 1.9 * amp);
      const height = Math.max(0.6, radius * 0.32);
      const baseAngle = Math.atan2(camObj.position.z - target.z, camObj.position.x - target.x);

      const controlCount = 9;
      const control = new Float32Array(controlCount * 3);
      for (let i = 0; i < controlCount; i++) {
        const a = baseAngle + (i / controlCount) * Math.PI * 2;
        control[i * 3] = target.x + Math.cos(a) * radius;
        control[i * 3 + 1] = target.y + height;
        control[i * 3 + 2] = target.z + Math.sin(a) * radius;
      }

      this.exports.fe_arena_reset();
      const inPtr = this.exports.fe_malloc(control.length * 4);
      new Float32Array(this.memory.buffer, inPtr, control.length).set(control);
      const perSegment = 8;
      const outCap = controlCount * perSegment * 3 + 3;
      const outPtr = this.exports.fe_malloc(outCap * 4);
      const pathCount = this.exports.fe_anim_catmull_rom(inPtr, controlCount, perSegment, outPtr, outCap);
      if (!pathCount) { window.FE?.toast?.('Camera path could not be generated'); return 0; }
      const path = new Float32Array(this.memory.buffer, outPtr, pathCount * 3).slice();

      const maxKeys = 96;
      const step = Math.max(1, Math.round((endF - startF) / maxKeys));
      const sampleCount = Math.min(128, Math.floor((endF - startF) / step) + 1);
      const samples = new Float32Array(sampleCount * 11);
      const tmpCam = new T.PerspectiveCamera();
      const euler = new T.Euler();
      const pos = new T.Vector3();
      const fov = camObj.fov || eng.sceneCamera?.fov || 39.6;

      for (let s = 0; s < sampleCount; s++) {
        const t = sampleCount === 1 ? 0 : s / (sampleCount - 1);
        const pi = Math.min(pathCount - 1, Math.round(t * (pathCount - 1)));
        pos.set(path[pi * 3], path[pi * 3 + 1], path[pi * 3 + 2]);
        tmpCam.position.copy(pos);
        tmpCam.up.set(0, 1, 0);
        tmpCam.lookAt(target);
        euler.setFromQuaternion(tmpCam.quaternion, 'XYZ');
        samples[s * 11 + 0] = pos.x;
        samples[s * 11 + 1] = pos.y;
        samples[s * 11 + 2] = pos.z;
        samples[s * 11 + 3] = euler.x * RAD2DEG;
        samples[s * 11 + 4] = euler.y * RAD2DEG;
        samples[s * 11 + 5] = euler.z * RAD2DEG;
        samples[s * 11 + 6] = 1;
        samples[s * 11 + 7] = 1;
        samples[s * 11 + 8] = 1;
        samples[s * 11 + 9] = fov;
        samples[s * 11 + 10] = 0;
      }

      const slot = this.getSlotForObjectId('camera');
      const rest = this.readObjectChannels11('camera');
      const restPtr = this.exports.fe_malloc(11 * 4);
      new Float32Array(this.memory.buffer, restPtr, 11).set(rest);
      this.exports.fe_anim_ensure_object(slot, restPtr);

      const samplePtr = this.exports.fe_malloc(samples.length * 4);
      new Float32Array(this.memory.buffer, samplePtr, samples.length).set(samples);
      const mask = 0x3f | (1 << 9);
      const written = this.exports.fe_anim_bake_samples(slot, mask, startF, step, samplePtr, sampleCount, 0, 1e-3);
      this.evaluateSceneAtFrame(curF);
      refreshAnimationStudioUI();
      if (typeof window.renderTimelineRulerCanvas === 'function') window.renderTimelineRulerCanvas();
      window.FE?.toast?.(`Camera path: ${written} keys over frames ${startF}–${endF}`);
      return written;
    },

    /* ---- glTF animation export ---- */
    exportAnimatedGLTF() {
      const T = window.THREE;
      if (!T || typeof T.GLTFExporter !== 'function') {
        window.FE?.toast?.('glTF exporter is still loading');
        return;
      }
      if (!this.ready || this.exports.fe_anim_get_total_keyframes() === 0) {
        window.FE?.toast?.('Nothing to export — add keyframes first');
        return;
      }
      const eng = window.FE?.engines?.core;
      if (!eng?.sc) return;
      const { startF, endF, fps } = sceneTimeConfig();
      const frameCount = Math.max(2, Math.round(endF - startF) + 1);

      const entries = [];
      for (const [objId, slot] of this.objectSlots.entries()) {
        if (this.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) === 0) continue;
        const obj = this.resolveObjectById(objId);
        if (!obj) continue;
        entries.push({ objId, slot, obj });
      }

      const exportScene = new T.Scene();
      const cloneMap = new Map();
      eng.sc.children.forEach(child => {
        if (!child.isGridHelper && child.name !== 'Cursor3D' && child.name !== 'StudioFloor' && child.name !== 'ShadowFloor'
          && !child.userData?.feOnionGhost && child !== this._onionGroup && child !== this._trailGroup) {
          const clone = child.clone(true);
          exportScene.add(clone);
          cloneMap.set(child, clone);
        }
      });

      /* glTF animation tracks address nodes by name, so keyed nodes need unique names. */
      const claimed = new Set();
      exportScene.children.forEach(child => {
        if (!child.name) return;
        if (claimed.has(child.name)) child.name = '';
        else claimed.add(child.name);
      });
      for (const entry of entries) {
        const target = cloneMap.get(entry.obj) || entry.obj;
        const fallback = 'FE_' + entry.objId.replace(/[^a-zA-Z0-9_]/g, '_') + '_' + entry.slot;
        let base = target.name || fallback;
        let name = base;
        let suffix = 2;
        while (claimed.has(name)) name = base + '_' + suffix++;
        target.name = name;
        entry.trackName = name;
        claimed.add(name);
      }

      const tracks = [];
      for (const { slot, trackName } of entries) {
        if (!trackName) continue;
        this.exports.fe_arena_reset();
        const cap = frameCount * 11;
        const ptr = this.exports.fe_malloc(cap * 4);
        const n = this.exports.fe_anim_sample_object(slot, startF, endF, frameCount, ptr, cap);
        if (!n) continue;
        const v = new Float32Array(this.memory.buffer, ptr, n * 11).slice();

        const times = new Float32Array(n);
        const positions = new Float32Array(n * 3);
        const quaternions = new Float32Array(n * 4);
        const scales = new Float32Array(n * 3);
        const euler = new T.Euler();
        const quat = new T.Quaternion();
        for (let i = 0; i < n; i++) {
          times[i] = i / fps;
          const b = i * 11;
          positions[i * 3] = v[b];
          positions[i * 3 + 1] = v[b + 1];
          positions[i * 3 + 2] = v[b + 2];
          euler.set(v[b + 3] * DEG2RAD, v[b + 4] * DEG2RAD, v[b + 5] * DEG2RAD, 'XYZ');
          quat.setFromEuler(euler);
          quaternions[i * 4] = quat.x;
          quaternions[i * 4 + 1] = quat.y;
          quaternions[i * 4 + 2] = quat.z;
          quaternions[i * 4 + 3] = quat.w;
          scales[i * 3] = Math.max(0.01, v[b + 6]);
          scales[i * 3 + 1] = Math.max(0.01, v[b + 7]);
          scales[i * 3 + 2] = Math.max(0.01, v[b + 8]);
        }
        tracks.push(new T.VectorKeyframeTrack(entry.trackName + '.position', times, positions));
        tracks.push(new T.QuaternionKeyframeTrack(entry.trackName + '.quaternion', times, quaternions));
        tracks.push(new T.VectorKeyframeTrack(entry.trackName + '.scale', times, scales));
      }

      if (!tracks.length) { window.FE?.toast?.('No keyframed objects found in the scene'); return; }
      const clip = new T.AnimationClip('FinalEffectAnimation', (frameCount - 1) / fps, tracks);
      const exporter = new T.GLTFExporter();
      window.FE?.toast?.('Exporting glTF animation…');
      exporter.parse(exportScene, result => {
        const json = JSON.stringify(result, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        if (typeof window.downloadBlob === 'function') window.downloadBlob(blob, 'FinalEffect-Animated.gltf');
        else {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'FinalEffect-Animated.gltf';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }
        window.FE?.toast?.('Exported FinalEffect-Animated.gltf with animation');
      }, err => {
        console.error('Animated glTF export failed:', err);
        window.FE?.toast?.('glTF export failed');
      }, { binary: false, animations: [clip], embedImages: true });
    }
  });

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

    const keySetSelect = document.getElementById('anim-keying-set');
    if (keySetSelect) keySetSelect.value = FECppEngine.keyingSet;

    const modeSelect = document.getElementById('anim-editor-mode');
    if (modeSelect) modeSelect.value = FECppEngine.editorMode;

    const channelSelect = document.getElementById('anim-graph-channel');
    if (channelSelect) channelSelect.value = String(FECppEngine.graphChannel);

    const onionBtn = document.getElementById('anim-onion-toggle');
    if (onionBtn) {
      onionBtn.classList.toggle('is-on', FECppEngine.onionSkin.enabled);
      onionBtn.setAttribute('aria-pressed', FECppEngine.onionSkin.enabled ? 'true' : 'false');
    }
    const onionRange = document.getElementById('anim-onion-range');
    if (onionRange) onionRange.value = String(FECppEngine.onionSkin.before);

    const trailBtn = document.getElementById('anim-trail-toggle');
    if (trailBtn) {
      trailBtn.classList.toggle('is-on', FECppEngine.motionTrail.enabled);
      trailBtn.setAttribute('aria-pressed', FECppEngine.motionTrail.enabled ? 'true' : 'false');
    }

    const bakeStatus = document.getElementById('anim-bake-status');
    if (bakeStatus) {
      const mesh = window.getActiveObjectMesh?.();
      const bake = mesh?.userData?.simBake;
      bakeStatus.textContent = bake
        ? `${bake.frames.length} baked frames · ${bake.frameStart}–${bake.frameEnd}`
        : 'No simulation bake';
      bakeStatus.classList.toggle('is-on', !!bake);
    }

    const dupBtn = document.getElementById('anim-dup-btn');
    const delSelBtn = document.getElementById('anim-del-sel-btn');
    const hasSelection = !!FECppEngine.selectedKey;
    if (dupBtn) dupBtn.disabled = !hasSelection;
    if (delSelBtn) delSelBtn.disabled = !hasSelection;

    FECppEngine.updateOnionSkin();
    FECppEngine.updateMotionTrail();
    if (typeof window.timelineAutoFitRange === 'function') window.timelineAutoFitRange();
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

    const { startF, endF, curF } = sceneTimeConfig();
    const m = animationCanvasMetrics(w, h, startF, endF);
    const objId = window.FE?.getActiveObjectId?.() || 'cube';
    const slot = FECppEngine.getSlotForObjectId(objId);
    const graph = FECppEngine.editorMode === 'graph';
    const sel = FECppEngine.selectedKey;

    /* Frame grid shared by both editors */
    ctx.strokeStyle = '#1c2030';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    const step = Math.max(5, Math.round((endF - startF) / 8 / 5) * 5);
    for (let f = startF; f <= endF; f += step) {
      const x = m.frameToX(f);
      ctx.beginPath();
      ctx.moveTo(x, m.padT - 4);
      ctx.lineTo(x, h - m.padB);
      ctx.stroke();
      ctx.fillText(String(f), x, 13);
    }

    if (!FECppEngine.ready) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Animation engine starting…', w * 0.5, h * 0.5);
      return;
    }

    const anyKeys = FECppEngine.exports.fe_anim_get_keyframe_count(slot, 0xFFFFFFFF) > 0;

    if (graph) {
      const active = FECppEngine.graphChannel;
      const range = FECppEngine.animationValueRange(slot, startF, endF);
      FECppEngine._graphRange = range;
      const valueToY = v => m.padT + m.plotH - ((v - range.min) / (range.max - range.min)) * m.plotH;

      ctx.strokeStyle = '#161a27';
      ctx.fillStyle = '#64748b';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      for (let g = 0; g <= 4; g++) {
        const y = m.padT + (m.plotH * g) / 4;
        ctx.beginPath();
        ctx.moveTo(m.padL, y);
        ctx.lineTo(w - m.padR, y);
        ctx.stroke();
        const value = range.max - ((range.max - range.min) * g) / 4;
        ctx.fillText(value.toFixed(Math.abs(value) < 10 ? 2 : 1), m.padL - 6, y + 3);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = CHANNEL_COLORS[active];
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`Graph · ${CHANNEL_LABELS[active]}`, 8, m.padT + 12);

      if (!anyKeys) {
        ctx.fillStyle = '#475569';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No keys yet — key the selected object to edit its curves', w * 0.5, h * 0.5);
      } else {
        FECppEngine.exports.fe_arena_reset();
        const buf = FECppEngine.allocF32(64);
        const samples = 48;
        for (let c = 0; c < CH.COUNT; c++) {
          const keyCount = FECppEngine.exports.fe_anim_get_keyframe_count(slot, c);
          if (keyCount === 0) continue;
          const n = FECppEngine.exports.fe_anim_sample_channel(slot, c, startF, endF, samples, buf.ptr, 64);
          const isActive = c === active;
          ctx.strokeStyle = CHANNEL_COLORS[c] + (isActive ? 'ee' : '3a');
          ctx.lineWidth = isActive ? 1.8 : 1;
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const x = m.padL + (i / Math.max(1, n - 1)) * m.plotW;
            const y = valueToY(buf.view[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        for (let c = 0; c < CH.COUNT; c++) {
          const isActive = c === active;
          for (const key of readAllKeys(slot, c)) {
            const x = m.frameToX(key.frame);
            const y = valueToY(key.value);
            if (x < m.padL - 6 || x > w - m.padR + 6) continue;
            ctx.fillStyle = CHANNEL_COLORS[c];
            ctx.globalAlpha = isActive ? 1 : 0.45;
            ctx.beginPath();
            ctx.arc(x, y, isActive ? 4.2 : 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            if (sel && sel.channel === c && Math.abs(sel.frame - key.frame) < 0.01) {
              ctx.strokeStyle = '#fde047';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(x, y, 7.5, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      }
    } else {
      const groups = [
        { label: 'Location XYZ', chs: [0, 1, 2] },
        { label: 'Rotation XYZ', chs: [3, 4, 5] },
        { label: 'Scale XYZ',    chs: [6, 7, 8] },
        { label: 'Lens / Light', chs: [9, 10] }
      ];
      const rowH = m.plotH / groups.length;

      groups.forEach((g, idx) => {
        const yMid = m.padT + idx * rowH + rowH * 0.5;
        ctx.strokeStyle = '#171b29';
        ctx.beginPath();
        ctx.moveTo(0, m.padT + (idx + 1) * rowH);
        ctx.lineTo(w, m.padT + (idx + 1) * rowH);
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(g.label, 8, yMid + 4);

        if (!anyKeys) return;
        FECppEngine.exports.fe_arena_reset();
        const kBuf = FECppEngine.allocF32(128 * 3);

        for (const c of g.chs) {
          const n = FECppEngine.exports.fe_anim_list_object_keyframes(slot, c, kBuf.ptr, 128);
          if (n === 0) continue;

          const samples = 48;
          const vals = new Float32Array(samples + 1);
          let minV = Infinity, maxV = -Infinity;
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
            const x = m.padL + (s / samples) * m.plotW;
            const norm = (vals[s] - minV) / spanV;
            const y = (m.padT + idx * rowH + rowH - 5) - norm * (rowH - 10);
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();

          for (let k = 0; k < n; k++) {
            const kf = kBuf.view[k * 3];
            const x = m.frameToX(kf);
            if (x < m.padL - 4 || x > w - m.padR + 4) continue;
            ctx.fillStyle = Math.abs(kf - curF) < 0.5 ? '#fbbf24' : CHANNEL_COLORS[c];
            ctx.beginPath();
            ctx.moveTo(x, yMid - 5);
            ctx.lineTo(x + 5, yMid);
            ctx.lineTo(x, yMid + 5);
            ctx.lineTo(x - 5, yMid);
            ctx.closePath();
            ctx.fill();
            if (sel && sel.channel === c && Math.abs(sel.frame - kf) < 0.01) {
              ctx.strokeStyle = '#fde047';
              ctx.lineWidth = 2;
              ctx.strokeRect(x - 8, yMid - 8, 16, 16);
            }
          }
        }
      });

      if (!anyKeys) {
        ctx.fillStyle = '#475569';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No keys yet — press + Key All to animate this object', w * 0.5, h * 0.5);
      }
    }

    /* Current playhead line */
    const playX = m.frameToX(curF);
    if (playX >= m.padL && playX <= w - m.padR) {
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
      const wrapped = function (frame, options) {
        origSetFrame(frame, options);
        const current = Number(window.timelineConfig?.currentFrame || frame || 0);
        FECppEngine.evaluateSceneAtFrame(current);
        FECppEngine.applySimulationBakeAtFrame(current);
        FECppEngine.updateOnionSkin();
        FECppEngine.updateMotionTrail();
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
        const project = typeof window.timelineFrameToX === 'function'
          ? kf => window.timelineFrameToX(kf, canvas.width)
          : kf => centerX + (kf - curF) * spacing;
        for (const kf of frames) {
          const x = project(kf);
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

    /* 3b. Hide ghosts and trails when the Animation Studio closes */
    const origCloseAnim = window.closeAnimationModal;
    if (typeof origCloseAnim === 'function' && !origCloseAnim._cppWrapped) {
      const wrappedClose = function () {
        origCloseAnim();
        if (FECppEngine._onionGroup) FECppEngine._onionGroup.visible = false;
        if (FECppEngine._trailGroup) FECppEngine._trailGroup.visible = false;
      };
      wrappedClose._cppWrapped = true;
      window.closeAnimationModal = wrappedClose;
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

    /* 5. Dope sheet / graph editor: scrub, drag keys, delete and duplicate */
    const dopeCanvas = document.getElementById('anim-dopesheet-canvas');
    if (dopeCanvas && !dopeCanvas.dataset.bound) {
      dopeCanvas.dataset.bound = '1';
      let scrubbing = false;
      let keyDragging = false;

      const scrubDope = ev => {
        const rect = dopeCanvas.getBoundingClientRect();
        const padL = 88, padR = 14;
        const plotW = Math.max(40, rect.width - padL - padR);
        const u = Math.max(0, Math.min(1, (ev.clientX - rect.left - padL) / plotW));
        const startF = Number(window.timelineConfig?.startFrame || 0);
        const endF = Math.max(startF + 1, Number(window.timelineConfig?.endFrame || 250));
        const raw = Math.round(startF + u * (endF - startF));
        const target = typeof window.snapTimelineFrame === 'function' ? window.snapTimelineFrame(raw, 6) : raw;
        if (typeof window.setTimelineCurrentFrame === 'function') {
          window.setTimelineCurrentFrame(target, { scrub: true, clampRange: true });
        }
      };

      const dragKeyTo = ev => {
        const m = FECppEngine.getAnimationCanvasMetrics();
        if (!m || !FECppEngine.selectedKey) return;
        const px = ev.clientX - m.rect.left;
        const py = ev.clientY - m.rect.top;
        const rawFrame = m.xToFrame(px);
        const snapped = typeof window.snapTimelineFrame === 'function'
          ? window.snapTimelineFrame(Math.round(rawFrame * 10) / 10, 6)
          : Math.round(rawFrame);
        let value;
        if (FECppEngine.editorMode === 'graph' && FECppEngine._graphRange) {
          const range = FECppEngine._graphRange;
          const t = Math.max(0, Math.min(1, (py - m.padT) / m.plotH));
          value = range.max - t * (range.max - range.min);
        }
        FECppEngine.updateKeyDrag(snapped, value);
      };

      /* A touch that starts on the graph may be either a scrub (horizontal) or a
         scroll of the sheet (vertical). The wrapper is touch-action:pan-y, so the
         browser owns vertical pans; we only start scrubbing once the gesture is
         clearly horizontal. Starting on the first pointerdown used to swallow the
         vertical drag, which left the sheet impossible to scroll after a tap. */
      let pendingPointer = null;

      const beginScrub = ev => {
        scrubbing = true;
        FECppEngine.selectedKey = null;
        renderDopeSheetAndCurveCanvas();
        scrubDope(ev);
      };

      dopeCanvas.addEventListener('pointerdown', ev => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const hit = FECppEngine.hitTestAnimationKey(ev.clientX, ev.clientY);
        if (hit) {
          keyDragging = true;
          scrubbing = false;
          pendingPointer = null;
          FECppEngine.beginKeyDrag(hit);
          try { dopeCanvas.setPointerCapture(ev.pointerId); } catch {}
          ev.preventDefault();
          return;
        }
        pendingPointer = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, type: ev.pointerType };
      });

      window.addEventListener('pointermove', ev => {
        if (keyDragging) { dragKeyTo(ev); return; }
        if (pendingPointer && ev.pointerId === pendingPointer.id) {
          const dx = Math.abs(ev.clientX - pendingPointer.x);
          const dy = Math.abs(ev.clientY - pendingPointer.y);
          if (dx < 4 && dy < 4) return;
          if (dx > dy * 1.2) {
            pendingPointer = null;
            beginScrub(ev);
          } else {
            /* Vertical intent: hand the gesture back to the sheet. */
            pendingPointer = null;
          }
          return;
        }
        if (scrubbing) scrubDope(ev);
      });

      const endDopePointer = () => {
        pendingPointer = null;
        if (keyDragging) {
          keyDragging = false;
          FECppEngine.endKeyDrag();
          return;
        }
        if (!scrubbing) return;
        scrubbing = false;
        if (window.timelineConfig?._physicsDirty && typeof window.seekTimelinePhysics === 'function') {
          window.seekTimelinePhysics(window.timelineConfig.currentFrame);
        }
      };
      window.addEventListener('pointerup', endDopePointer);
      window.addEventListener('pointercancel', endDopePointer);

      window.addEventListener('keydown', ev => {
        const sheet = document.getElementById('animation-sheet');
        const open = sheet && !sheet.hidden && sheet.style.display !== 'none';
        if (!open || !FECppEngine.selectedKey) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        if (ev.key === 'Delete' || ev.key === 'Backspace') {
          ev.preventDefault();
          FECppEngine.deleteSelectedAnimationKey();
        } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
          ev.preventDefault();
          FECppEngine.duplicateSelectedAnimationKey();
        }
      });
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
            FECppEngine.insertKeyframeForActive('keyset', true);
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
      detail: `ABI v${abi} · Heap ${(exp.fe_heap_used_bytes() / 1024).toFixed(1)} KB · ${this.artifactSummary()} · ${(performance.now() - t0).toFixed(2)} ms`
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

    /* A stale artifact is the usual reason a kernel row fails on a device that
       was working yesterday: retry with a cache-busted fetch before judging. */
    let activeExp = this.exports;
    if (this.artifact && !this.artifact.complete) {
      await this.ensureFreshArtifact();
      activeExp = this.exports;
    }

    /* 7. Landscape bridge + ocean kernel: reports every degraded subsystem
       instead of only the engine-side checks. */
    t0 = performance.now();
    try {
      const land = typeof window !== 'undefined' ? window.FELandscapeCore : null;
      const present = !!land;
      const bound = !!(land && land.ready);
      let oceanOk = false;
      if (typeof activeExp.fe_ocean_configure === 'function' && typeof activeExp.fe_ocean_update === 'function') {
        oceanOk = activeExp.fe_ocean_configure(32, 256, 1024, 4096, 12, 30, 7) === 0 &&
          activeExp.fe_ocean_update(1.5, 1, 1, 3, 2) > 0 && activeExp.fe_ocean_resolution() === 32;
      }
      const degraded = bound && land.missing ? land.missing.length : 0;
      /* "Where is the terrain bridge" is not a health signal: the bridge lives in
         the Landscaping Studio frame, so on the home screen / workspace it is
         legitimately absent and the ocean + terrain kernels below are the check. */
      const bridgeNote = !present
        ? 'terrain bridge runs in the Landscaping Studio frame'
        : bound
          ? (degraded ? `${degraded} kernel${degraded===1?'':'s'} on JS fallback: ${land.missing.join(', ')}` : 'Every terrain, Open World and ocean kernel bound')
          : 'Terrain bridge did not bind — JS fallback active';
      const artifactNote = this.artifact && !this.artifact.complete
        ? `Engine artifact is stale: ${this.artifactBytes ? Math.round(this.artifactBytes / 1024) + ' KB · ' : ''}${activeExp && Object.keys(activeExp).length} exports · missing ${this.artifact.missing.slice(0, 4).join(', ')}${this.artifact.missing.length > 4 ? '…' : ''} — reload or redeploy fe_core_engine.wasm`
        : '';
      results.push({
        name: 'Landscape & Ocean Kernels',
        ok: oceanOk && (present ? bound && degraded === 0 : true),
        detail: (oceanOk
          ? `Wave field 32² · ${(performance.now() - t0).toFixed(2)} ms · `
          : (artifactNote ? '' : 'Ocean kernel unavailable · ')) + (artifactNote || bridgeNote)
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
      const smokeExports = activeExp;
      if (typeof smokeExports.fe_vol_init !== 'function' || typeof smokeExports.fe_vol_step !== 'function' || typeof smokeExports.fe_vol_surface !== 'function') {
        smokeDetail = this.artifact && !this.artifact.complete
          ? `Engine artifact is stale: ${Object.keys(smokeExports).length} exports · no volume kernel (fe_vol_init) — reload or redeploy fe_core_engine.wasm`
          : 'Smoke & fire solver unavailable in this build';
      } else {
        const grid = 16, cells = grid * grid * grid;
        smokeExports.fe_vol_init(grid, grid, grid);
        smokeExports.fe_vol_source(0.5, 0.2, 0.5, 0.16, 1.2, 0.6, 0.8);
        for (let step = 0; step < 4; step++) smokeExports.fe_vol_step(1 / 60, 4, 1, 0.2, 0.3, 24);
        const stats = new Float32Array(smokeExports.memory.buffer, smokeExports.fe_vol_stats_ptr(), 6);
        const density = new Float32Array(smokeExports.memory.buffer, smokeExports.fe_vol_density_ptr(), cells);
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
        const verts = smokeExports.fe_vol_surface(0, 1 << 16);
        smokeOk = smokeExports.fe_vol_grid_size() === grid && Number.isFinite(stats[1]) &&
          stats[1] <= stats[0] && smokeMass > 0 && verts > 0 &&
          smokeExports.fe_vol_surface_index_count() > 0 && smokeExports.fe_vol_surface_index_count() % 3 === 0;
        smokeDetail = `16³ MAC grid · div ${Number(stats[0]).toFixed(1)}→${Number(stats[1]).toFixed(2)} · ${verts} surface verts · ${(performance.now() - t0).toFixed(2)} ms`;
        smokeExports.fe_vol_init(grid, grid, grid);
      }
      results.push({ name: 'Smoke & Fire Volume Solver', ok: smokeOk, detail: smokeDetail });
    } catch (error) {
      results.push({ name: 'Smoke & Fire Volume Solver', ok: false, detail: String(error.message || error) });
    }

    const allOk = results.every(r => r.ok);
    return {
      ok: allOk,
      results,
      totalMs: +(performance.now() - tTotal0).toFixed(1),
      artifact: this.artifact || null,
      artifactSummary: this.artifactSummary()
    };
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
              '<i class="ico" data-ico="flask" data-size="22"></i>' +
              '<div>' +
                '<strong style="font-size:15px;color:#f8fafc;">Performance Benchmark</strong>' +
                '<div style="font-size:11px;color:#94a3b8;">Measures animation, sculpt, touch and path-tracing speed on this device</div>' +
              '</div>' +
            '</div>' +
            '<button class="export-modal-close" type="button" aria-label="Close" onclick="document.getElementById(\'cpp-diagnostics-modal\').hidden=true"><i class="ico" data-ico="close"></i></button>' +
          '</header>' +
          '<div class="diagnostics-body" style="padding:14px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;">' +
            '<div style="background:#090b10;border:1px solid #262c40;border-radius:12px;padding:10px;text-align:center;">' +
              '<canvas id="cpp-diag-canvas" width="320" height="180" style="width:100%;max-width:460px;height:auto;border-radius:8px;"></canvas>' +
              '<div id="cpp-diag-summary" style="margin-top:8px;font-size:12px;font-weight:700;color:#34d399;">Running benchmark…</div>' +
            '</div>' +
            '<div id="cpp-diag-list" style="display:flex;flex-direction:column;gap:7px;"></div>' +
            '<div id="cpp-diag-artifact" hidden style="display:none;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.45);border-radius:10px;padding:10px 12px;gap:8px;flex-direction:column;"></div>' +
          '</div>' +
          '<footer class="render-actions-bar">' +
            '<button class="export-action-btn" type="button" id="cpp-diag-repair" onclick="repairEngineArtifact()"><i class="ico" data-ico="gear"></i> <span id="cpp-diag-repair-label">Repair Engine</span></button>' +
            '<button class="export-action-btn" type="button" onclick="openCppDiagnosticsModal()"><i class="ico" data-ico="refresh"></i> Re-Run Benchmark</button>' +
            '<button class="export-action-btn" type="button" style="background:#4f46e5;border-color:#818cf8;" onclick="document.getElementById(\'cpp-diagnostics-modal\').hidden=true;FE.open(\'core\')"><i class="ico" data-ico="cube3d"></i> Open 3D Workspace</button>' +
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
        ? `All ${report.results.length} checks passed · ${report.totalMs} ms total`
        : `Failed: ${report.results.filter(r => !r.ok).map(r => r.name).join(' · ')}`;
    }
    const artifactEl = document.getElementById('cpp-diag-artifact');
    if (artifactEl) {
      const stale = report.artifact && !report.artifact.complete;
      artifactEl.hidden = !stale;
      artifactEl.style.display = stale ? 'flex' : 'none';
      artifactEl.innerHTML = stale
        ? '<strong style="font-size:12px;color:#fca5a5;">Engine artifact is outdated</strong>' +
          `<span style="font-size:11px;color:#fecaca;line-height:1.45;">This page is running ${report.artifact.exports} engine exports` +
          `${report.artifact.bytes ? ` (${Math.round(report.artifact.bytes / 1024)} KB)` : ''}, so ${report.artifact.missing.length} kernel` +
          `${report.artifact.missing.length === 1 ? '' : 's'} cannot run: ${report.artifact.missing.slice(0, 6).join(', ')}` +
          `${report.artifact.missing.length > 6 ? '…' : ''}. Tap <b>Repair Engine</b> to fetch the current fe_core_engine.wasm; ` +
          'if it stays outdated the deployed file itself is old (redeploy the 185-export build).</span>'
        : '';
    }
    if (listEl) {
      listEl.innerHTML = report.results.map(r =>
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;background:#161926;border:1px solid ${r.ok ? 'rgba(52,211,153,0.32)' : 'rgba(248,113,113,0.4)'};">` +
          `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#e2e8f0;"><i class="ico" data-ico="${r.ok ? 'check' : 'close'}" data-size="15"></i>${r.name}</span>` +
          `<span style="font-size:11px;color:#94a3b8;font-family:ui-monospace,monospace;">${r.detail}</span>` +
        `</div>`
      ).join('');
    }
  }
  window.openCppDiagnosticsModal = openCppDiagnosticsModal;

  /* One-tap recovery from a stale binary: swap in a cache-busted artifact and
     re-run the benchmark so the user sees the result immediately. */
  window.repairEngineArtifact = async function repairEngineArtifact() {
    const btn = document.getElementById('cpp-diag-repair');
    /* Only the label is swapped - rewriting textContent would delete the icon. */
    const label = document.getElementById('cpp-diag-repair-label');
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Repairing…';
    try {
      await FECppEngine.ensureFreshArtifact({ force: true });
      await openCppDiagnosticsModal();
    } finally {
      if (btn) btn.disabled = false;
      const fresh = document.getElementById('cpp-diag-repair-label');
      if (fresh) fresh.textContent = 'Repair Engine';
    }
  };
  window.FECppEngine = FECppEngine;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireWorkspaceIntegration);
  } else {
    setTimeout(wireWorkspaceIntegration, 0);
  }
})();
