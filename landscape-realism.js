/* Final Effect — landscape surface realism (JS glue)
 *
 * The Landscaping Studio used to describe every natural surface with a 256px
 * canvas of random speckles. Speckle has no scale: grass, snow and granite all
 * end up reading as the same grey noise, which is why the assets looked
 * "procedural" instead of photographed.
 *
 * This module replaces that noise with micro-structure that actually exists on
 * the real material — bark fibre, rock bedding + fracture, wind-packed
 * sastrugi, aeolian ripples, leaf venation, packed gravel — synthesised in C++
 * (cpp/src/fe_surface.cpp) and painted into the same textures the renderer
 * already samples. It also owns the physically-motivated material numbers
 * (albedo / roughness / F0 / translucency) and their wetness, snow-age and
 * lichen modifiers, all resolved by the engine rather than hard-coded here.
 *
 * Every change this module makes is exposed as a user setting
 * (`FELandscapeRealism.settings`), and nothing is applied unless the engine
 * reports the surface kernels — a stale artifact keeps the previous look with
 * a console warning instead of half-upgrading the scene.
 */
(function (root) {
  'use strict';

  /* Surface ids — must match cpp/src/fe_surface.cpp SurfaceId. */
  const SURFACES = {
    meadow: 0, dryGrass: 1, loam: 2, sand: 3, granite: 4, basalt: 5,
    sandstone: 6, snow: 7, barkOak: 8, barkBirch: 9, barkPine: 10,
    leafBroad: 11, needle: 12, gravel: 13, lichen: 14
  };
  const SURFACE_NAMES = Object.keys(SURFACES);

  /* Detail ids — must match DetailKind in the C++ kernel. */
  const DETAIL_KINDS = {
    turf: 0, loam: 1, rock: 2, snow: 3, sand: 4, bark: 5,
    leaf: 6, gravel: 7, ripple: 8, lava: 9, moss: 10
  };

  /* JS mirror of the C++ table. Only used before the engine is ready or if a
     deployment serves an artifact without the surface kernels, so the
     fallback keeps the same *shape* of look, just less detail. */
  const FALLBACK = {
    meadow:    { rgb: [0.085, 0.150, 0.045], roughness: 0.93, f0: 0.040, translucency: 0.30 },
    dryGrass:  { rgb: [0.265, 0.215, 0.105], roughness: 0.95, f0: 0.040, translucency: 0.18 },
    loam:      { rgb: [0.125, 0.098, 0.070], roughness: 0.97, f0: 0.038, translucency: 0.00 },
    sand:      { rgb: [0.430, 0.375, 0.265], roughness: 0.88, f0: 0.040, translucency: 0.06 },
    granite:   { rgb: [0.320, 0.310, 0.300], roughness: 0.60, f0: 0.045, translucency: 0.00 },
    basalt:    { rgb: [0.092, 0.092, 0.098], roughness: 0.74, f0: 0.045, translucency: 0.00 },
    sandstone: { rgb: [0.395, 0.300, 0.198], roughness: 0.82, f0: 0.042, translucency: 0.00 },
    snow:      { rgb: [0.830, 0.860, 0.900], roughness: 0.46, f0: 0.018, translucency: 0.55 },
    barkOak:   { rgb: [0.072, 0.055, 0.040], roughness: 0.96, f0: 0.030, translucency: 0.00 },
    barkBirch: { rgb: [0.560, 0.545, 0.505], roughness: 0.90, f0: 0.032, translucency: 0.02 },
    barkPine:  { rgb: [0.088, 0.062, 0.045], roughness: 0.96, f0: 0.030, translucency: 0.00 },
    leafBroad: { rgb: [0.052, 0.118, 0.032], roughness: 0.55, f0: 0.036, translucency: 0.62 },
    needle:    { rgb: [0.030, 0.062, 0.026], roughness: 0.62, f0: 0.034, translucency: 0.34 },
    gravel:    { rgb: [0.215, 0.205, 0.192], roughness: 0.86, f0: 0.042, translucency: 0.00 },
    lichen:    { rgb: [0.165, 0.198, 0.108], roughness: 0.84, f0: 0.035, translucency: 0.05 }
  };

  /* Which micro-structure each terrain surface uses. */
  const TERRAIN_DETAIL = { grass: 'turf', soil: 'loam', rock: 'rock', snow: 'snow', rough: 'rock' };

  /* Open-World biome tile -> micro-structure. Hills/alpine/desert/volcano/
     shore/rocky/grassy/sand/lava/magma/pebbles/beach are the painted biomes. */
  const OW_DETAIL = {
    hills: 'moss', alpine: 'rock', desert: 'sand', volcano: 'lava', shore: 'sand',
    rocky: 'rock', grassy: 'turf', sand: 'sand', lava: 'lava', magma: 'lava',
    pebbles: 'gravel', beach: 'sand'
  };

  /* Species -> how its material is grounded.
     card   : alpha-tested leaf card (broadleaf or needle)
     cactus : waxy photosynthetic stem, no leaf translucency
     wood   : bare trunk (dead tree)
     rock   : stone
     false  : built structure, untouched */
  const SPECIES = {
    grass: 'grass', tallgrass: 'grass', flower: 'flower', daisy: 'flower',
    tulip: 'flower', lavender: 'flower', fern: 'card', treefern: 'card',
    shrub: 'card', sage: 'card', ashbush: 'card', agave: 'card',
    juniper: 'needle', krumm: 'needle', pine: 'needle', spruce: 'needle',
    oak: 'card', birch: 'card', palm: 'card', acacia: 'card', joshua: 'card',
    saguaro: 'cactus', barrel: 'cactus', prickly: 'cactus',
    deadtree: 'wood', rock: 'rock', sandrock: 'rock', basalt: 'rock'
  };

  const BARK_FOR = { oak: 'oak', birch: 'birch', palm: 'palm', acacia: 'oak', joshua: 'oak', deadtree: 'char', shrub: 'oak', ashbush: 'char' };

  const settings = {
    /* All user facing (Landscaping → Surface realism). */
    detail: 1,        /* 0..2   strength of the micro-structure normal maps */
    wetness: 0,       /* 0..1   rain film on every exposed surface */
    snowAge: 0,       /* 0..300 days since snowfall (grain growth, albedo loss) */
    translucency: 1,  /* 0..1.5 multiplier on the measured leaf translucency */
    enabled: true     /* master switch: off = the previous canvas look */
  };

  const state = {
    engine: false,
    upgraded: false,
    applied: [],
    cache: new Map(),
    warnings: [],
    chunks: 0
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const log = (msg) => console.warn('[FELandscapeRealism] ' + msg);

  /* ---------------------------------------------------------------- */
  /* Engine bridge                                                     */
  /* ---------------------------------------------------------------- */
  function bridge() {
    const c = root.FELandscapeCore;
    return c && c.ready && typeof c.surfacePbr === 'function' && typeof c.has === 'function' && c.has('fe_surface_pbr') ? c : null;
  }

  function surface(name, opts) {
    const id = typeof name === 'number' ? clamp(name | 0, 0, SURFACE_NAMES.length - 1) : SURFACES[name] || 0;
    const key = SURFACE_NAMES[id];
    const wet = clamp(opts && opts.wet !== undefined ? opts.wet : settings.wetness, 0, 1);
    const age = clamp(opts && opts.snowAge !== undefined ? opts.snowAge : settings.snowAge, 0, 400);
    const lichen = clamp(opts && opts.lichen ? opts.lichen : 0, 0, 1);
    const b = bridge();
    if (b) {
      const out = b.surfacePbr(id, wet, age, lichen);
      if (out) {
        return {
          id, key, albedo: [out[0], out[1], out[2]], roughness: out[3],
          f0: out[4], translucency: out[5], anisotropy: out[6]
        };
      }
    }
    /* Fallback mirrors the kernel's own transforms. */
    const f = FALLBACK[key] || FALLBACK.meadow;
    let rgb = f.rgb.slice();
    let rough = f.roughness;
    let trans = f.translucency;
    if (key === 'snow') {
      const radius = 50 + 26 * Math.sqrt(age);
      const atten = Math.exp(-0.00022 * (radius - 50));
      rgb = rgb.map((v) => v * atten);
      rough += 0.16 * Math.min(1, age / 200);
      trans = trans + (0.28 - trans) * Math.min(1, age / 200);
    }
    if (key !== 'snow' && lichen > 0) {
      const c = lichen, m = FALLBACK.lichen;
      rgb = rgb.map((v, i) => v + (m.rgb[i] - v) * c);
      rough += (0.86 - rough) * c;
      trans += (0.05 - trans) * c;
    }
    if (wet > 0) {
      const film = wet * wet * (3 - 2 * wet);
      rgb = rgb.map((v) => v * (1 - 0.46 * film));
      rough += (0.045 - rough) * Math.min(1, Math.pow(film, 1.4));
      trans *= 1 - film;
    }
    return { id, key, albedo: rgb.map((v) => clamp(v, 0, 1)), roughness: clamp(rough, 0, 1), f0: f.f0, translucency: trans, anisotropy: 0.2 };
  }

  function surfaceColor(name, opts) {
    const s = surface(name, opts);
    const C = root.THREE && root.THREE.Color;
    if (!C) return s.albedo;
    const c = new C();
    c.setRGB(s.albedo[0], s.albedo[1], s.albedo[2]);
    return c;
  }

  /* ---------------------------------------------------------------- */
  /* Micro-structure buffers (C++ generated, cached)                   */
  /* ---------------------------------------------------------------- */
  const MAX_SIZE = 512;

  function detail(kind, width, height, seed, strength) {
    const key = kind + ':' + width + 'x' + height + ':' + seed + ':' + strength;
    const hit = state.cache.get(key);
    if (hit) return hit;
    const b = bridge();
    if (!b) return null;
    if (width > MAX_SIZE || height > MAX_SIZE) return null;
    const id = DETAIL_KINDS[kind];
    const data = b.surfaceDetail(id === undefined ? 0 : id, width, height, seed >>> 0, strength);
    if (!data) return null;
    const entry = { kind, width, height, data };
    if (state.cache.size >= 32) state.cache.delete(state.cache.keys().next().value);
    state.cache.set(key, entry);
    return entry;
  }

  /* ---------------------------------------------------------------- */
  /* Canvas painting                                                   */
  /* ---------------------------------------------------------------- */
  function mark(texture) {
    if (!texture) return;
    texture.needsUpdate = true;
  }

  function targetSize(canvas, width, height) {
    if (!canvas) return false;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return true;
  }

  /* Height-ish grey map (colour detail). */
  function paintGrey(texture, buffer, opts) {
    const canvas = texture && texture.image;
    if (!canvas || !canvas.getContext) return false;
    const width = buffer.width, height = buffer.height;
    if (!targetSize(canvas, width, height)) return false;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const base = opts && opts.base !== undefined ? opts.base : 0.66;
    const range = opts && opts.range !== undefined ? opts.range : 0.36;
    const data = buffer.data;
    for (let i = 0, n = width * height; i < n; i++) {
      const v = clamp(base + range * Math.pow(clamp(data[i * 4 + 2], 0, 1), 1.7), 0, 1);
      const g = Math.round(v * 255);
      const o = i * 4;
      img.data[o] = g; img.data[o + 1] = g; img.data[o + 2] = g; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    mark(texture);
    return true;
  }

  /* Tangent-space normal map from the kernel's (x, y, z) channels. */
  function paintNormal(texture, buffer) {
    const canvas = texture && texture.image;
    if (!canvas || !canvas.getContext) return false;
    const width = buffer.width, height = buffer.height;
    if (!targetSize(canvas, width, height)) return false;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const data = buffer.data;
    for (let i = 0, n = width * height; i < n; i++) {
      const o = i * 4;
      img.data[o] = Math.round(clamp(data[o], 0, 1) * 255);
      img.data[o + 1] = Math.round(clamp(data[o + 1], 0, 1) * 255);
      img.data[o + 2] = Math.round(clamp(data[o + 2], 0, 1) * 255);
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    mark(texture);
    return true;
  }

  function paintRough(texture, buffer) {
    const canvas = texture && texture.image;
    if (!canvas || !canvas.getContext) return false;
    const width = buffer.width, height = buffer.height;
    if (!targetSize(canvas, width, height)) return false;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const data = buffer.data;
    for (let i = 0, n = width * height; i < n; i++) {
      const o = i * 4;
      const g = Math.round(clamp(data[o + 3], 0, 1) * 255);
      img.data[o] = g; img.data[o + 1] = g; img.data[o + 2] = g; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    mark(texture);
    return true;
  }

  /* Multiplies an existing colour canvas by cavity shading. The untouched
     pixels are cached so re-running (settings changes) never compounds. */
  function shadeColour(texture, buffer, opts) {
    const canvas = texture && texture.image;
    if (!canvas || !canvas.getContext) return false;
    const width = buffer.width, height = buffer.height;
    if (!targetSize(canvas, width, height)) return false;
    const ctx = canvas.getContext('2d');
    if (!canvas.__feOriginal || canvas.__feOriginal.width !== width || canvas.__feOriginal.height !== height) {
      canvas.__feOriginal = ctx.getImageData(0, 0, width, height);
    }
    const src = canvas.__feOriginal;
    const out = ctx.createImageData(width, height);
    const depth = opts && opts.depth !== undefined ? opts.depth : 0.34;
    const tint = (opts && opts.tint) || [1, 1, 1];
    const data = buffer.data;
    for (let i = 0, n = width * height; i < n; i++) {
      const nz = clamp(data[i * 4 + 2], 0, 1);
      const ao = 1 - depth + depth * Math.pow(nz, 1.5);
      const o = i * 4;
      out.data[o] = clamp(src.data[o] * ao * tint[0], 0, 255);
      out.data[o + 1] = clamp(src.data[o + 1] * ao * tint[1], 0, 255);
      out.data[o + 2] = clamp(src.data[o + 2] * ao * tint[2], 0, 255);
      out.data[o + 3] = src.data[o + 3];
    }
    ctx.putImageData(out, 0, 0);
    mark(texture);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Access to the Landscaping globals                                 */
  /* ---------------------------------------------------------------- */
  /* terrain-main-01/04 declare their state as top-level `const` in a classic
     script, so those bindings live in the global lexical environment and are
     reachable by name — but only through a direct reference (they are not
     properties of window). terrain-main-02 wraps its textures in a `try`
     block, i.e. block scope, so it republishes them explicitly. */
  /* Each binding is resolved on its own: a single missing name must not hide
     the ones that do exist (the module also loads in contexts without the
     full studio, e.g. a stale or partial page). */
  function studioGlobal(name) {
    try {
      switch (name) {
        case 'tm': return tm; // eslint-disable-line no-undef
        case 'TERRAIN_PBR': return TERRAIN_PBR; // eslint-disable-line no-undef
        case 'OW_SURFACE_MAPS': return OW_SURFACE_MAPS; // eslint-disable-line no-undef
        case 'OW_SURFACE_ATLAS': return OW_SURFACE_ATLAS; // eslint-disable-line no-undef
        case 'OW_SURFACE_DEFS': return OW_SURFACE_DEFS; // eslint-disable-line no-undef
        case 'KIND': return KIND; // eslint-disable-line no-undef
        case 'ren': return ren; // eslint-disable-line no-undef
        default: return undefined;
      }
    } catch (_) {
      return undefined;
    }
  }

  function globals() {
    const g = {};
    for (const name of ['tm', 'TERRAIN_PBR', 'OW_SURFACE_MAPS', 'OW_SURFACE_ATLAS', 'OW_SURFACE_DEFS', 'KIND', 'ren']) {
      g[name] = studioGlobal(name);
    }
    g.tex = root.__feLandscapeTex || null;
    return g;
  }

  /* ---------------------------------------------------------------- */
  /* Texture upgrade jobs — one per frame so a phone stays responsive   */
  /* ---------------------------------------------------------------- */
  function rebuildAtlas(atlas, maps) {
    const canvas = atlas.image;
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const tile = 256, gutter = 4, cell = tile + gutter * 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    maps.forEach((texture, i) => {
      const img = texture && texture.image;
      if (!img) return;
      const px = (i % 4) * cell, py = Math.floor(i / 4) * cell;
      ctx.drawImage(img, px + gutter, py + gutter, tile, tile);
      ctx.drawImage(img, 0, 0, 1, tile, px, py + gutter, gutter, tile);
      ctx.drawImage(img, tile - 1, 0, 1, tile, px + gutter + tile, py + gutter, gutter, tile);
      ctx.drawImage(img, 0, 0, tile, 1, px + gutter, py, tile, gutter);
      ctx.drawImage(img, 0, tile - 1, tile, 1, px + gutter, py + gutter + tile, tile, gutter);
    });
    mark(atlas);
  }

  function jobList() {
    const g = globals();
    const jobs = [];

    /* Terrain triplanar detail: turf / loam / rock / snow / roughness. */
    const pbr = g.TERRAIN_PBR;
    if (pbr) {
      let seed = 41;
      for (const key of Object.keys(TERRAIN_DETAIL)) {
        const texture = pbr[key];
        if (!texture) continue;
        const kind = TERRAIN_DETAIL[key];
        const s = seed;
        jobs.push(() => {
          const buf = detail(kind, 256, 256, s, 1.2);
          if (buf) paintGrey(texture, buf, { base: 0.64, range: 0.38 });
        });
        seed += 13;
      }
    }

    /* Painted biome tiles + their atlas. */
    const maps = g.OW_SURFACE_MAPS;
    if (maps && maps.length) {
      const defs = g.OW_SURFACE_DEFS || [];
      maps.forEach((texture, i) => {
        const key = defs[i] && defs[i].key;
        const kind = OW_DETAIL[key] || 'turf';
        jobs.push(() => {
          const buf = detail(kind, 128, 128, 61 + i * 7, 1.05);
          if (buf) shadeColour(texture, buf, { depth: 0.3 });
        });
      });
      if (g.OW_SURFACE_ATLAS) jobs.push(() => rebuildAtlas(g.OW_SURFACE_ATLAS, maps));
    }

    /* Bark: colour cavities, matching normal + roughness. */
    const tex = g.tex;
    if (tex && tex.BT) {
      const barkKind = { oak: ['bark', 0], pine: ['bark', 1], birch: ['bark', 2], palm: ['bark', 3], char: ['bark', 4], cactus: ['moss', 5] };
      for (const key of Object.keys(tex.BT)) {
        const cfg = barkKind[key] || ['bark', 0];
        const colour = tex.BT[key];
        const normal = tex.BN && tex.BN[key];
        const rough = tex.BR && tex.BR[key];
        jobs.push(() => {
          const buf = detail(cfg[0], 256, 512, 31 + cfg[1] * 17, cfg[0] === 'moss' ? 0.85 : 1.3);
          if (!buf) return;
          /* Cactus skin is waxy and nearly smooth — only a fine pore texture. */
          shadeColour(colour, buf, { depth: cfg[0] === 'moss' ? 0.12 : 0.4 });
          if (normal) paintNormal(normal, buf);
          if (rough) paintRough(rough, buf);
        });
      }
    }

    /* Leaf venation for the broadleaf and needle cards. */
    const leaf = tex && tex.LEAF_PBR;
    if (leaf) {
      for (const key of Object.keys(leaf)) {
        const entry = leaf[key];
        if (!entry) continue;
        jobs.push(() => {
          const buf = detail('leaf', 256, 256, 83, key === 'petal' ? 0.4 : 0.95);
          if (!buf) return;
          if (entry.nm) paintNormal(entry.nm, buf);
          if (entry.rm) paintRough(entry.rm, buf);
        });
      }
    }
    return jobs;
  }

  let upgradePromise = null;

  function schedule(fn) {
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }

  function upgrade() {
    if (upgradePromise) return upgradePromise;
    upgradePromise = new Promise((resolve) => {
      if (!settings.enabled) { resolve(false); return; }
      if (!bridge()) {
        state.warnings.push('surface kernels unavailable');
        log('C++ surface kernels unavailable, landscape keeps its previous textures');
        resolve(false);
        return;
      }
      state.engine = true;
      const jobs = jobList();
      let index = 0;
      const step = () => {
        if (index >= jobs.length) {
          state.upgraded = true;
          applyMaterials();
          applyDetailStrength();
          applyWetness();
          applySnowAge();
          resolve(true);
          return;
        }
        try { jobs[index++](); } catch (error) { log('upgrade step failed: ' + (error && error.message)); }
        schedule(step);
      };
      schedule(step);
    });
    return upgradePromise;
  }

  /* ---------------------------------------------------------------- */
  /* Materials                                                         */
  /* ---------------------------------------------------------------- */
  function materialsOf(K) {
    const out = [];
    if (!K) return out;
    for (const list of [K.meshes, K.lowMeshes, K.shadowMeshes]) {
      if (!list) continue;
      for (const mesh of list) {
        if (!mesh || !mesh.material) continue;
        const list2 = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of list2) if (m) out.push(m);
      }
    }
    return out;
  }

  function blend(authored, measured, weight) {
    const a = typeof authored === 'number' ? authored : 0.8;
    return a + (measured - a) * weight;
  }

  /* Grounds one species' materials in the measured table. Idempotent: the
     authored values are remembered so moving a slider never compounds. */
  function applyKind(name, K) {
    const role = SPECIES[name];
    if (!role) return 0;
    let touched = 0;
    for (const material of materialsOf(K)) {
      if (material.userData.feRole === role) continue;
      material.userData.feRole = role;
      if (!material.userData.feAuthored) {
        material.userData.feAuthored = {
          roughness: material.roughness,
          normalScale: material.normalScale ? material.normalScale.x : null,
          clearcoat: material.clearcoat
        };
      }
      const authored = material.userData.feAuthored;
      const isCard = material.alphaTest > 0 && !!material.map;
      switch (role) {
        case 'rock': {
          const s = surface(name === 'basalt' ? 'basalt' : 'granite');
          material.roughness = blend(authored.roughness, s.roughness, 0.6);
          material.metalness = 0;
          if (material.normalScale && material.normalScale.setScalar) material.normalScale.setScalar((authored.normalScale || 0.6) * 1.25);
          break;
        }
        case 'cactus': {
          const s = surface('leafBroad');
          /* Waxy cuticle: glossier than a leaf, no translucency. */
          material.roughness = blend(authored.roughness, 0.48, 0.7);
          material.metalness = 0;
          if (material.clearcoat !== undefined) material.clearcoat = 0.35;
          break;
        }
        case 'wood': {
          material.roughness = blend(authored.roughness, surface('barkOak').roughness, 0.5);
          material.metalness = 0;
          break;
        }
        case 'grass': {
          /* A blade of grass is the most back-lit translucent surface in the
             scene, and it has no UVs (real quads + vertex colour), so the
             physical win here is the scatter term, not a normal map. */
          const s = surface('meadow');
          material.roughness = blend(authored.roughness, s.roughness, 0.5);
          material.metalness = 0;
          patchTranslucency(material, s.translucency * 0.9);
          break;
        }
        case 'needle':
        case 'card':
        case 'flower': {
          if (!isCard) break;
          const s = role === 'needle' ? surface('needle') : surface('leafBroad');
          /* A leaf is glossier than the authored .78-.82: a wet-looking
             highlight on the card edge is what sells foliage at distance. */
          material.roughness = blend(authored.roughness, s.roughness, 0.55);
          material.metalness = 0;
          patchTranslucency(material, role === 'needle' ? s.translucency * 0.7 : s.translucency);
          break;
        }
        default: break;
      }
      material.needsUpdate = true;
      touched++;
    }
    return touched;
  }

  function applyMaterials() {
    const g = globals();
    if (!g.KIND) return 0;
    let touched = 0;
    for (const name of Object.keys(g.KIND)) touched += applyKind(name, g.KIND[name]);
    /* The render hook re-scans for lazily built species, so never let this
       history grow with the frame count. */
    if (touched && state.applied.length < 40) state.applied.push('materials:' + touched);
    return touched;
  }

  /* Called when a lazily built species appears (see terrain-main-01 `ensure`). */
  function refreshKind(name) {
    if (!settings.enabled) return 0;
    const g = globals();
    const K = g.KIND && g.KIND[name];
    if (!K) return 0;
    applyKind(name, K);
    applyDetailStrength();
    return 1;
  }

  function forKindMaterials(name, fn) {
    const g = globals();
    const K = g.KIND && g.KIND[name];
    if (!K) return;
    for (const material of materialsOf(K)) fn(material, name);
  }

  /* ---------------------------------------------------------------- */
  /* Leaf translucency                                                 */
  /* ---------------------------------------------------------------- */
  /* A leaf is one to two millimetres of cellulose: a real fraction of sunlight
     passes through it, which is why a back-lit canopy glows while the shaded
     side goes deep green. We add a wrapped-diffuse + back-scatter term to the
     existing shader instead of faking it with emissive colour (which would
     also glow at night). */
  const sharedSun = { value: null };

  function patchTranslucency(material, amount) {
    if (!material || material.userData.feTrans) return false;
    if (typeof material.onBeforeCompile !== 'function') return false;
    const previousCompile = material.onBeforeCompile;
    const previousKey = typeof material.customProgramCacheKey === 'function' ? material.customProgramCacheKey.bind(material) : null;
    const uniform = { value: clamp(amount || 0, 0, 1.5) };
    material.userData.feTrans = uniform;
    material.userData.feTranslucency = uniform.value;

    material.onBeforeCompile = function (shader, renderer) {
      previousCompile.call(this, shader, renderer);
      shader.uniforms.uFeSunView = sharedSun;
      shader.uniforms.uFeTrans = uniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uFeSunView;\nuniform float uFeTrans;');
      /* The scatter term has to land on the final colour: three r128 writes
         `gl_FragColor` directly, newer revisions use <output_fragment>. */
      const add = [
        'vec3 feSun = normalize(uFeSunView);',
        'vec3 feView = normalize(vViewPosition);',
        'float feBack = pow(clamp(dot(-feView, feSun), 0.0, 1.0), 3.0);',
        'float feWrap = clamp(dot(normal, feSun) * 0.5 + 0.5, 0.0, 1.0);',
        'outgoingLight += diffuseColor.rgb * uFeTrans * feBack * feWrap * vec3(1.0, 0.94, 0.72) * 1.45;'
      ].join('\n');
      if (shader.fragmentShader.includes('#include <output_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', add + '\n#include <output_fragment>');
      } else {
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          add + '\ngl_FragColor = vec4( outgoingLight, diffuseColor.a );'
        );
      }
    };
    /* Keep whatever cache key the wind / detail injection already produced, or
       every wind variant would share one compiled program. */
    material.customProgramCacheKey = function () {
      return (previousKey ? previousKey() : 'm') + '+trans';
    };
    material.needsUpdate = true;
    return true;
  }

  function applyTranslucency() {
    for (const name of Object.keys(SPECIES)) {
      const role = SPECIES[name];
      if (!['card', 'needle', 'flower', 'grass'].includes(role)) continue;
      forKindMaterials(name, (material) => {
        if (!material.userData.feTrans) return;
        const scale = role === 'needle' ? 0.7 : role === 'grass' ? 0.9 : 1;
        const s = role === 'needle' ? surface('needle') : role === 'grass' ? surface('meadow') : surface('leafBroad');
        const value = clamp(s.translucency * scale, 0, 1.5);
        material.userData.feTrans.value = value;
        material.userData.feTranslucency = value;
      });
    }
  }

  /* Sun direction in view space, refreshed per rendered frame from the scene's
     own directional light so the back-lit glow follows the sun instead of a
     screen-space constant. Also the point where we notice newly built species. */
  function installSunHook() {
    const g = globals();
    const renderer = g.ren;
    if (!renderer || renderer.__feRealismHooked) return false;
    renderer.__feRealismHooked = true;
    const original = renderer.render.bind(renderer);
    const THREE = root.THREE;
    const dir = THREE ? new THREE.Vector3(0.4, 0.7, 0.3) : null;
    const tmp = THREE ? new THREE.Vector3() : null;
    let frame = 0;
    let scanned = false;
    renderer.render = function (targetScene, camera) {
      try {
        if (THREE && dir && tmp && camera) {
          if (!sharedSun.value) sharedSun.value = new THREE.Vector3();
          let sun = null;
          const children = targetScene.children || [];
          for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.isDirectionalLight && child.intensity > 0.05) { sun = child; break; }
          }
          if (sun) dir.copy(sun.position).normalize();
          tmp.copy(dir).transformDirection(camera.matrixWorldInverse);
          sharedSun.value.copy(tmp);
        }
        /* Species are built lazily on first paint; sweep for new materials a
           couple of times a second instead of hooking every builder. */
        if (scanned && ++frame % 40 === 0) applyMaterials();
        scanned = true;
      } catch (_) { /* never break the render loop for a cosmetic pass */ }
      return original(targetScene, camera);
    };
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */
  function applyDetailStrength() {
    const scale = clamp(settings.detail, 0, 2);
    for (const name of Object.keys(SPECIES)) {
      forKindMaterials(name, (material) => {
        if (!material.normalScale || !material.normalScale.setScalar) return;
        const authored = material.userData.feAuthored && material.userData.feAuthored.normalScale;
        const base = authored === null || authored === undefined ? 0.6 : authored;
        material.normalScale.setScalar(base * scale * (SPECIES[name] === 'rock' ? 1.25 : 1));
      });
    }
  }

  function applyWetness() {
    const wet = clamp(settings.wetness, 0, 1);
    const g = globals();
    if (g.tm) {
      if (!g.tm.userData.feDryColor) g.tm.userData.feDryColor = g.tm.color.clone();
      g.tm.color.copy(g.tm.userData.feDryColor).multiplyScalar(1 - 0.22 * wet);
      const uniforms = g.tm.userData.feShader && g.tm.userData.feShader.uniforms;
      if (uniforms && uniforms.uSurfRough) {
        uniforms.uSurfRough.value.set(
          surface('meadow', { wet }).roughness,
          surface('loam', { wet }).roughness,
          surface('granite', { wet }).roughness,
          surface('snow', { wet }).roughness
        );
      }
    }
    for (const name of Object.keys(SPECIES)) {
      if (SPECIES[name] !== 'rock') continue;
      const s = surface(name === 'basalt' ? 'basalt' : 'granite', { wet });
      forKindMaterials(name, (material) => {
        if (material.userData.feAuthored) material.roughness = blend(material.userData.feAuthored.roughness, s.roughness, 0.6);
      });
    }
  }

  function applySnowAge() {
    const snow = surface('snow', { snowAge: settings.snowAge });
    const g = globals();
    if (g.tm && g.tm.userData.feShader && g.tm.userData.feShader.uniforms.uSurfRough) {
      g.tm.userData.feShader.uniforms.uSurfRough.value.w = snow.roughness;
    }
    if (state.upgraded && g.TERRAIN_PBR && g.TERRAIN_PBR.snow) {
      const seed = 41 + Math.round(settings.snowAge * 0.5);
      const buf = detail('snow', 256, 256, seed, 1.2);
      if (buf) paintGrey(g.TERRAIN_PBR.snow, buf, { base: 0.64, range: 0.38 * (1 - 0.4 * Math.min(1, settings.snowAge / 200)) });
    }
    return snow;
  }

  function set(key, value) {
    if (!(key in settings) || key === 'enabled') return false;
    settings[key] = value;
    if (key === 'detail') applyDetailStrength();
    else if (key === 'wetness') applyWetness();
    else if (key === 'snowAge') applySnowAge();
    else if (key === 'translucency') applyTranslucency();
    return settings[key];
  }

  /* ---------------------------------------------------------------- */
  /* Water                                                             */
  /* ---------------------------------------------------------------- */
  /* Cox–Munk says wind roughens the sea; Jerlov says absorption is what gives
     open ocean, lagoon and estuary their different colours. Both live in the
     engine; this only adapts the authored water profile to them. */
  function windRoughness(mps) {
    const b = bridge();
    if (b && typeof b.windRoughness === 'function') {
      const v = b.windRoughness(mps);
      if (typeof v === 'number' && v > 0) return v;
    }
    const u = clamp(mps, 0, 40);
    return clamp(Math.sqrt(0.003 + 0.00512 * u) * 1.6, 0.03, 0.6);
  }

  /* The FFT wave cascades already carry the large-scale surface slope, so the
     material roughness only has to describe the sub-grid slope (the part of
     Cox–Munk's mean-square slope the mesh cannot resolve). We therefore scale
     the authored value by how much rougher the profile's wind is than a 6 m/s
     reference sea, instead of replacing it with the absolute physical value —
     which would double-count the waves and make the ocean look milky. */
  const REFERENCE_WIND = 6;

  function waterRoughness(profile) {
    if (!profile) return 0.09;
    if (typeof profile.wind !== 'number') return profile.roughness;
    const ratio = windRoughness(profile.wind) / windRoughness(REFERENCE_WIND);
    return clamp(profile.roughness * clamp(ratio, 0.7, 1.8), 0.02, 0.75);
  }

  function waterOptical(type) {
    const b = bridge();
    if (b && typeof b.waterOptical === 'function') {
      const out = b.waterOptical(type | 0);
      if (out) return { absorb: [out[0], out[1], out[2]], scatter: [out[3], out[4], out[5]] };
    }
    /* Absorption m^-1 (R, G, B) then scattering, mirroring the kernel. */
    const t = [
      [0.3050, 0.0545, 0.0145, 0.0035],
      [0.3500, 0.0750, 0.0200, 0.0090],
      [0.4200, 0.1100, 0.0450, 0.0450],
      [0.5500, 0.2000, 0.1150, 0.3500],
      [0.7200, 0.3600, 0.3000, 1.2000]
    ][clamp(type | 0, 0, 4)];
    return { absorb: [t[0], t[1], t[2]], scatter: [t[3], t[3] * 1.08, t[3] * 0.92] };
  }

  /* Beer–Lambert transmission over `depth` metres, lifted by single scattering
     and normalised so the brightest channel is 1 — the caller scales it into
     its own exposure. */
  function waterColour(type, depth) {
    const o = waterOptical(type);
    const d = depth === undefined ? 9 : depth;
    const rgb = [0, 1, 2].map((i) => {
      const t = Math.exp(-o.absorb[i] * d);
      const s = o.scatter[i] / (o.absorb[i] + o.scatter[i]);
      return t * (1 - s) + s * 0.55;
    });
    const max = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
    return [rgb[0] / max, rgb[1] / max, rgb[2] / max];
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */
  function install() {
    if (!settings.enabled) return false;
    if (!root.THREE || !root.THREE.CanvasTexture) return false;
    const g = globals();
    if (!g.KIND) return false; /* not the Landscaping page */
    installSunHook();
    const start = () => { upgrade(); };
    const core = root.FELandscapeCore;
    if (core && core.loading && typeof core.loading.then === 'function') {
      core.loading.then(() => schedule(start)).catch(() => schedule(start));
    } else {
      schedule(start);
    }
    return true;
  }

  const api = {
    version: '1.0.0',
    SURFACES,
    DETAIL_KINDS,
    FALLBACK,
    SPECIES,
    settings,
    state,
    surface,
    surfaceColor,
    detail,
    upgrade,
    install,
    set,
    refreshKind,
    windRoughness,
    waterRoughness,
    waterOptical,
    waterColour,
    patchTranslucency
  };

  root.FELandscapeRealism = api;
  root.setLandscapeRealism = set;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else setTimeout(install, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
