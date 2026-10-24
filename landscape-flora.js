/* Final Effect — grown flora (JS/GPU bridge)
 *
 * Trees used to be authored in JavaScript: a hand-written recursive splitter
 * with three children at fixed jitter and four levels, which is why a row of
 * oaks read as a row of copies. The shape was drawn, not grown.
 *
 * `cpp/src/fe_flora.cpp` now grows the skeleton with space colonisation
 * (Runions et al. 2007), sizes branches with da Vinci's rule and places leaf
 * anchors on a golden-angle phyllotaxis. It also carries the rock recipe
 * (clipped sphere + trig-noise displacement + lichen on upward faces).
 *
 * This module is deliberately small: it converts the engine's flat buffers into
 * the attribute layout the existing materials already sample, and it reports
 * honestly when the kernel is missing so the studio can keep its previous
 * builder. All shading, wind, shadows and instancing stay exactly where they
 * were.
 */
(function (root) {
  'use strict';

  /* Kernel order — every name here maps to one row of `kSpecies` in
   * `cpp/src/fe_flora.cpp`. Broadleaves grow by space colonisation; the two
   * herbaceous species at the end are grown by a strict L-system. */
  const KINDS = ['oak', 'birch', 'acacia', 'shrub', 'ashbush', 'deadtree', 'fern', 'treefern',
    /* Ground cover, succulents and palms: same table, same buffers, own
       builders in the kernel. Order is the C++ species index. */
    'grass', 'tallgrass', 'daisy', 'tulip', 'lavender', 'saguaro', 'barrel', 'agave', 'palm', 'pebble',
    /* Conifers and desert scrub. */
    'pine', 'spruce', 'krumm', 'juniper', 'prickly', 'joshua', 'sage',
    /* The generic wildflower tuft the biome tables scatter as "flower". */
    'flower'];
  /* Species whose whole mesh — not leaf cards around a trunk — is grown in
     C++. These are the plants with real petal, rib and leaflet geometry. */
  const PLANT_KINDS = ['grass', 'tallgrass', 'daisy', 'tulip', 'lavender', 'saguaro', 'barrel', 'agave', 'palm', 'pebble',
    'pine', 'spruce', 'krumm', 'juniper', 'prickly', 'joshua', 'sage', 'flower'];
  /* Species that grow leaf cards in the kernel: wood + foliage (+ blossom). */
  const CARD_KINDS = ['oak', 'birch', 'acacia', 'shrub', 'ashbush', 'fern', 'treefern'];
  /* Which material slot each kernel part feeds, per kind. Slot order matches
     the part list the studio already builds for that species. */
  const PART_PLAN = {
    grass: [[1, 0]],
    tallgrass: [[1, 0]],
    /* stem, leaf, bloom, and the darkest part of the head (a composite's disc
       florets, a tulip's stamens, a lavender bud). */
    daisy: [[0, 0], [1, 1], [2, 2], [3, 3]],
    tulip: [[0, 0], [1, 1], [2, 2], [3, 3]],
    lavender: [[0, 0], [1, 1], [2, 2], [3, 3]],
    flower: [[0, 0], [1, 1], [2, 2], [3, 3]],
    saguaro: [[0, 0]],
    barrel: [[0, 0], [2, 1]],
    agave: [[1, 0]],
    palm: [[0, 0], [1, 1]],
    pebble: [[0, 0]],
    pine: [[0, 0], [1, 1]],
    spruce: [[0, 0], [1, 1]],
    krumm: [[0, 0], [1, 1]],
    juniper: [[0, 0], [1, 1]],
    prickly: [[0, 0], [2, 1]],
    joshua: [[0, 0], [1, 1]],
    sage: [[0, 0], [1, 1]],
    /* Card-grown species: the foliage (and blossom) live in the card buffer. */
    oak: [[0, 0], [1, 1], [2, 2]],
    birch: [[0, 0], [1, 1], [2, 2]],
    acacia: [[0, 0], [1, 1]],
    shrub: [[0, 0], [1, 1], [2, 2]],
    ashbush: [[0, 0], [1, 1]],
    fern: [[0, 0], [1, 1]],
    treefern: [[0, 0], [1, 1]],
    deadtree: [[0, 0]]
  };
  const ROCK_KINDS = ['granite', 'sandstone', 'basalt'];

  const state = {
    ready: false,
    used: 0,
    fallbacks: 0,
    lastError: null
  };

  function core() {
    const c = root.FELandscapeCore;
    return c && c.ready && typeof c.floraTree === 'function' ? c : null;
  }

  /* Runtime shape controls. They live here so every builder (species, fern,
     uploaded rule set) sees the same numbers, and they are re-pushed before
     each build so a kernel reset can never leave them stale. */
  const shape = { height: 1, density: 1 };
  function pushShape(c) {
    if (c && typeof c.floraSetShape === 'function') c.floraSetShape(shape.height, shape.density);
  }
  function setShape(height, density) {
    const h = Number(height), d = Number(density);
    shape.height = Number.isFinite(h) ? Math.min(2.5, Math.max(0.3, h)) : shape.height;
    shape.density = Number.isFinite(d) ? Math.min(2, Math.max(0.3, d)) : shape.density;
    pushShape(core());
    return { ...shape };
  }
  function resetRules() {
    const c = core();
    if (c && typeof c.lsystemReset === 'function') c.lsystemReset();
    return true;
  }

  function three() {
    return root.THREE;
  }

  /* Detail level 0..3 follows the studio's own quality setting so a low-end
   * phone does not pay for a 40x26 rock. */
  function detailLevel(detail) {
    const d = detail === undefined ? 2 : detail;
    return d >= 3 ? 3 : d >= 2 ? 2 : d >= 1 ? 1 : 0;
  }

  function toGeometry(mesh) {
    const THREE = three();
    if (!THREE || !mesh || !mesh.verts) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(mesh.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uv, 2));
    g.setAttribute('aRnd', new THREE.Float32BufferAttribute(mesh.rnd, 1));
    g.setAttribute('aCen', new THREE.Float32BufferAttribute(mesh.cen, 3));
    /* Skeletal wind: compliance + branch phase, straight from the kernel. */
    if (mesh.sway) g.setAttribute('aSway', new THREE.Float32BufferAttribute(mesh.sway, 1));
    if (mesh.phase) g.setAttribute('aPhase', new THREE.Float32BufferAttribute(mesh.phase, 1));
    g.setIndex(new THREE.BufferAttribute(mesh.idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  /* Wood + leaf anchors for one species, or null when the kernel is absent. */
  function tree(kind, seed, detail) {
    const c = core();
    if (!c) { state.fallbacks++; return null; }
    const id = typeof kind === 'number' ? kind : KINDS.indexOf(kind);
    if (id < 0 || id >= KINDS.length) return null;
    const s = (seed === undefined || seed === null) ? ((Math.random() * 4294967295) >>> 0) : (seed >>> 0);
    try {
      pushShape(c);
      const mesh = c.floraTree(id, s || 1, detailLevel(detail));
      if (!mesh) { state.fallbacks++; return null; }
      const wood = toGeometry(mesh);
      if (!wood) return null;
      state.ready = true;
      state.used++;
      return {
        wood,
        leaf: mesh.leaf,
        leafStride: mesh.leafStride || 8,
        info: mesh.info || null,
        verts: mesh.verts,
        leaves: mesh.leaves
      };
    } catch (error) {
      state.lastError = error && error.message;
      state.fallbacks++;
      return null;
    }
  }

  function rock(kind, seed, detail) {
    const c = core();
    if (!c || typeof c.floraRock !== 'function') { state.fallbacks++; return null; }
    const id = typeof kind === 'number' ? kind : ROCK_KINDS.indexOf(kind);
    if (id < 0 || id >= ROCK_KINDS.length) return null;
    const s = (seed === undefined || seed === null) ? ((Math.random() * 4294967295) >>> 0) : (seed >>> 0);
    try {
      const mesh = c.floraRock(id, s || 1, detailLevel(detail));
      if (!mesh) { state.fallbacks++; return null; }
      const geo = toGeometry(mesh);
      if (geo) { state.ready = true; state.used++; }
      return geo;
    } catch (error) {
      state.lastError = error && error.message;
      state.fallbacks++;
      return null;
    }
  }

  /* Expands the fern production rules inside the kernel and returns the word.
   * This is the honest answer to "is it really an L-system": the rewrite
   * happens in C++, and the string is the proof. */
  function lsystem(iterations, seed) {
    const c = core();
    if (!c || typeof c.lsystem !== 'function') return null;
    return c.lsystem(iterations, seed);
  }

  /* Editable grammar, end to end: the rule set is uploaded to the kernel, the
   * rewrite runs there and the turtle walks the result there. `spec` is
   * { axiom, rules: [{ pre, alts: [string, optional second] }], iterations,
   *   fronds, step, tilt, droop, leafSize, seed, detail }. */
  function plant(spec) {
    const c = core();
    if (!c || typeof c.lsystemPlant !== 'function') { state.fallbacks++; return null; }
    try {
      const cfg = spec || {};
      pushShape(c);
      if (cfg.rules && cfg.rules.length && typeof c.lsystemLoad === 'function') {
        if (c.lsystemLoad(cfg) < 0) { state.lastError = 'rule set rejected'; state.fallbacks++; return null; }
      }
      const mesh = c.lsystemPlant(cfg);
      if (!mesh || !mesh.verts) { state.fallbacks++; return null; }
      const wood = toGeometry(mesh);
      if (!wood) return null;
      state.ready = true;
      state.used++;
      return { wood, leaf: mesh.leaf, leafStride: mesh.leafStride || 8, verts: mesh.verts, leaves: mesh.leaves };
    } catch (error) {
      state.lastError = error && error.message;
      state.fallbacks++;
      return null;
    }
  }

  /* Expand the rules currently loaded in the kernel without growing anything. */
  function rules(iterations, seed) {
    const c = core();
    if (!c || typeof c.lsystemRun !== 'function') return null;
    return c.lsystemRun(iterations, seed);
  }

  /* One grown plant, split into the material groups the studio renders.
   * Returns { groups: [{ slot, index }] } where `slot` is the legacy part's
   * position and `index` is a Uint32Array for that group, or null when the
   * kernel is absent. The attributes are shared between groups — the same
   * vertex buffer, three index sets — so a three-material plant costs one
   * upload, not three. */
  function plantParts(kind, seed, detail) {
    const c = core();
    if (!c || typeof c.floraTree !== 'function') {
      state.fallbacks++;
      return null;
    }
    const id = typeof kind === 'number' ? kind : KINDS.indexOf(kind);
    if (id < 0 || id >= KINDS.length) return null;
    const plan = PART_PLAN[KINDS[id]];
    if (!plan) return null;
    const s = (seed === undefined || seed === null) ? ((Math.random() * 4294967295) >>> 0) : (seed >>> 0);
    try {
      pushShape(c);
      const mesh = c.floraTree(id, s || 1, detailLevel(detail));
      if (!mesh) { state.fallbacks++; return null; }
      const idx = new Uint32Array(mesh.idx);
      const part = mesh.part;
      const groups = plan.map(([kernelPart, slot]) => {
        const out = [];
        for (let i = 0; i < idx.length; ++i) {
          if (Math.round(part[idx[i]]) === kernelPart) out.push(idx[i]);
        }
        return { slot, index: new Uint32Array(out) };
      }).filter((g) => g.index.length);
      if (!groups.length) { state.fallbacks++; return null; }
      const base = toGeometry(mesh);
      if (!base) return null;
      state.ready = true;
      state.used++;
      return { base, groups, verts: mesh.verts };
    } catch (error) {
      state.lastError = error && error.message;
      state.fallbacks++;
      return null;
    }
  }

  /* Turn a plant group into its own geometry: same attribute buffers, its own
     index, so one kernel mesh feeds every material slot. */
  function groupGeometry(base, index) {
    const THREE = three();
    if (!THREE || !base) return null;
    const g = new THREE.BufferGeometry();
    for (const name in base.attributes) g.setAttribute(name, base.attributes[name]);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = base.boundingSphere;
    g.boundingBox = base.boundingBox;
    return g;
  }

  /* One call grows a whole plant in the kernel and hands back the geometry for
   * every material slot the studio renders. Card-grown trees (oak, birch, …)
   * get their foliage and blossom from the card buffer the kernel filled with
   * the wood; everything else is split out of the mesh itself by the per-vertex
   * part id. Either way the studio receives BufferGeometry and nothing else —
   * no asset is authored in JavaScript. */
  function grownAsset(kind, seed, detail, planOverride) {
    const c = core();
    if (!c || typeof c.floraTree !== 'function') return null;
    const id = typeof kind === 'number' ? kind : KINDS.indexOf(kind);
    if (id < 0 || id >= KINDS.length) return null;
    const name = KINDS[id];
    const plan = planOverride || PART_PLAN[name] || [];
    const s = (seed === undefined || seed === null) ? ((Math.random() * 4294967295) >>> 0) : (seed >>> 0);
    const indexOf = (idx, partArr, part) => {
      const out = [];
      for (let i = 0; i < idx.length; ++i) if (Math.round(partArr[idx[i]]) === part) out.push(idx[i]);
      return out;
    };
    try {
      pushShape(c);
      const mesh = c.floraTree(id, s || 1, detailLevel(detail));
      if (!mesh || !mesh.verts) return null;
      const base = toGeometry(mesh);
      if (!base) return null;
      const slots = [];
      const cards = (CARD_KINDS.indexOf(name) >= 0 && typeof c.floraCards === 'function')
        ? c.floraCards() : null;
      if (cards && cards.verts) {
        /* Wood from the mesh, foliage and blossom from the cards. */
        for (const [part, slot] of plan) {
          if (part !== 0) continue;
          const idx = indexOf(mesh.idx, mesh.part, 0);
          if (idx.length) slots.push({ slot, geometry: groupGeometry(base, new Uint32Array(idx)) });
        }
        const cardBase = toGeometry(cards);
        for (const [part, slot] of plan) {
          if (part === 0) continue;
          const idx = indexOf(cards.idx, cards.part, part);
          if (idx.length) slots.push({ slot, geometry: groupGeometry(cardBase, new Uint32Array(idx)) });
        }
        state.ready = true;
        state.used++;
        return { slots, verts: mesh.verts, cards: cards.cards, leaves: mesh.leaves };
      }
      for (const [part, slot] of plan) {
        /* -1 means "the whole mesh into this slot": a plant whose parts share
           one material does not need to be split at all. */
        if (part < 0) { slots.push({ slot, geometry: base }); continue; }
        const idx = indexOf(mesh.idx, mesh.part, part);
        if (!idx.length) continue;
        slots.push({ slot, geometry: groupGeometry(base, new Uint32Array(idx)) });
      }
      if (!slots.length) {
        /* No part plan: the whole mesh is one material. */
        slots.push({ slot: 0, geometry: base });
      }
      state.ready = true;
      state.used++;
      return { slots, verts: mesh.verts, cards: 0, leaves: mesh.leaves };
    } catch (error) {
      state.lastError = error && error.message;
      state.fallbacks++;
      return null;
    }
  }

  /* ---- buildings -------------------------------------------------------- *
   * The four street shells the studio places are grown by the same kernel, in
   * real metres: 3 m storeys, 3.6 m bays, a 1.3 m balcony, a 35 degree roof.
   * They keep the studio's three material slots (wall / roof / base) and, like
   * a plant, hand back one BufferGeometry per slot rather than a mesh in JS. */
  const BUILDINGS = ['house', 'block', 'mid', 'tower'];
  const BUILDING_PLAN = {
    house: [[0, 0], [1, 1], [2, 2]],
    /* A flat-roofed block has no roof mesh of its own: the parapet, plant deck
       and canopy are all the concrete slot, so part 1 is unused. */
    block: [[0, 0], [2, 1]],
    mid: [[0, 0], [2, 1]],
    tower: [[0, 0], [2, 1]]
  };
  function buildingAsset(kind, seed, detail, planOverride) {
    const c = core();
    if (!c || typeof c.building !== 'function') return null;
    const id = typeof kind === 'number' ? kind : BUILDINGS.indexOf(kind);
    if (id < 0 || id >= BUILDINGS.length) return null;
    const plan = planOverride || BUILDING_PLAN[BUILDINGS[id]] || [];
    const s = (seed === undefined || seed === null) ? ((Math.random() * 4294967295) >>> 0) : (seed >>> 0);
    try {
      const mesh = c.building(id, s || 1, detailLevel(detail));
      if (!mesh || !mesh.verts) return null;
      const base = toGeometry(mesh);
      if (!base) return null;
      const slots = [];
      for (const [part, slot] of plan) {
        const idx = [];
        for (let i = 0; i < mesh.idx.length; ++i) {
          if (Math.round(mesh.part[mesh.idx[i]]) === part) idx.push(mesh.idx[i]);
        }
        if (!idx.length) continue;
        slots.push({ slot, geometry: groupGeometry(base, new Uint32Array(idx)) });
      }
      if (!slots.length) return null;
      state.ready = true;
      state.used++;
      return { slots, verts: mesh.verts };
    } catch (error) {
      state.lastError = error && error.message;
      return null;
    }
  }

  function counts() {
    const c = core();
    if (!c || typeof c.floraCounts !== 'function') return { species: 0, rocks: 0 };
    try { return c.floraCounts(); } catch (_) { return { species: 0, rocks: 0 }; }
  }

  root.FELandscapeFlora = {
    version: '1.1.0',
    KINDS,
    PLANT_KINDS,
    PART_PLAN,
    ROCK_KINDS,
    state,
    shape,
    setShape,
    resetRules,
    tree,
    rock,
    lsystem,
    plant,
    rules,
    counts,
    toGeometry,
    plantParts,
    grownAsset,
    BUILDINGS,
    BUILDING_PLAN,
    buildingAsset,
    CARD_KINDS,
    groupGeometry,
    detailLevel
  };
})(typeof window !== 'undefined' ? window : globalThis);
