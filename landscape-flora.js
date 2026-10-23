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

  const KINDS = ['oak', 'birch', 'acacia', 'shrub', 'ashbush', 'deadtree'];
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
      const mesh = c.floraTree(id, s || 1, detailLevel(detail));
      if (!mesh) { state.fallbacks++; return null; }
      const wood = toGeometry(mesh);
      if (!wood) return null;
      state.ready = true;
      state.used++;
      return { wood, leaf: mesh.leaf, info: mesh.info || null, verts: mesh.verts, leaves: mesh.leaves };
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

  function counts() {
    const c = core();
    if (!c || typeof c.floraCounts !== 'function') return { species: 0, rocks: 0 };
    try { return c.floraCounts(); } catch (_) { return { species: 0, rocks: 0 }; }
  }

  root.FELandscapeFlora = {
    version: '1.0.0',
    KINDS,
    ROCK_KINDS,
    state,
    tree,
    rock,
    counts,
    toGeometry,
    detailLevel
  };
})(typeof window !== 'undefined' ? window : globalThis);
