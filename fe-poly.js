/* FEPoly - the polygon model behind a mesh.

   A mesh is vertices and faces. Triangles are how a GPU draws a face, not what
   the face is: Blender and Maya keep quads and n-gons and only triangulate at
   the render boundary, which is why their models do not grow a diagonal down
   the middle of a flat face when you look at them carefully.

   The measurement itself is no longer in this file. Recovering faces from a
   triangle buffer - welding coincident corners, reading the faces the app
   declared, pairing the two halves of a quad, deciding what is left - is the
   same law the Edit Mode kernel applies (buildQuadGroups in
   cpp/src/fe_editmesh.cpp), and two implementations of one law drift: a fix in
   one shows up as Object Mode drawing a diagonal that Edit Mode does not.
   So the law lives once, in C++ (cpp/src/fe_poly.cpp), and Object Mode asks
   the engine for it.

   What is left here is the boundary between a BufferGeometry and that kernel:

     - the declared rings are read out of geometry.userData.feFaces and tidied
       (a stale ring, a repeated corner, a ring that collapsed to two corners);
     - positions, triangle indices and those rings are copied into the session
       arena, the kernel is called once, and the face table, the edge table and
       the weld table are copied back out (they are only valid until the next
       build, which reuses the arena);
     - the result is cached on the geometry as geometry.userData.fePoly, keyed
       to the position attribute's version, and the three.js objects the rest of
       the app draws with are built here, because a BufferGeometry is a
       three.js object and three.js is the JavaScript half of this editor.

   Nothing in this file decides what a face is.

   The kernel's contract (cpp/src/fe_poly.cpp carries the reasoning):

     faces     the model's faces, as rings of welded vertex ids;
     faceTris  the triangles each face is made of, in the geometry's own
               triangle numbering - a tap on one of them selects the whole face;
     rep       welded id -> one real vertex slot, or null when the geometry is
               indexed and declared no faces, in which case the ids are the
               slots;
     edges     the model's edges, each welded-id pair once, low id first;
     kinds     how many faces have three, four and more corners.
*/
(function (global) {
  'use strict';

  /* The engine, through the same bridge every other kernel call goes through.
     Without it there is no face list: this file used to answer the question
     itself, and a second answer is the bug. */
  function engine() {
    const bridge = global.FECppEngine;
    const exp = bridge && bridge.exports;
    if (!exp || typeof exp.fe_poly_begin !== 'function') return null;
    if (bridge.ready === false) return null;
    return exp;
  }

  function three() {
    return global.THREE || null;
  }

  function attributeStamp(geometry) {
    const position = geometry && geometry.attributes && geometry.attributes.position;
    return position ? position.count + ':' + (position.version || 0) : '';
  }

  /* The faces the app authored: geometry.userData.feFaces is a list of corner
     rings in the geometry's own vertex slots, with feFaceVerts recording the
     vertex count they were measured against - a modifier that rewrites the
     buffer invalidates them, and a stale ring describes a shape that is no
     longer there. A ring that has collapsed (a cone's degenerate half, which the
     kernel's weld drops) is not a face and is dropped here, so the kernel is
     only ever handed rings it can use. */
  function declaredRings(geometry) {
    const rings = geometry && geometry.userData && geometry.userData.feFaces;
    const stamp = geometry && geometry.userData && geometry.userData.feFaceVerts;
    const position = geometry && geometry.attributes && geometry.attributes.position;
    if (!Array.isArray(rings) || !position || stamp !== position.count) return null;
    const out = [];
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const clean = [];
      for (const slot of ring) {
        if (!(slot >= 0 && slot < position.count)) continue;
        if (clean.length && clean[clean.length - 1] === slot) continue;
        clean.push(slot);
      }
      if (clean.length > 2 && clean[0] === clean[clean.length - 1]) clean.pop();
      if (clean.length < 3) continue;
      out.push(clean);
    }
    return out.length ? out : null;
  }

  /* ------------------------------------------------------------------ build --- */

  function build(geometry) {
    const exp = engine();
    if (!exp) return null;
    const position = geometry.attributes && geometry.attributes.position;
    if (!position || !position.array) return null;
    const index = geometry.index;
    const verts = position.count;
    const triangles = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (!verts || !triangles) return null;

    const declared = declaredRings(geometry);
    let corners = 0;
    if (declared) for (const ring of declared) corners += ring.length;
    const code = exp.fe_poly_begin(verts, triangles, declared ? declared.length : 0, corners,
                                   index ? 1 : 0);
    if (code !== 0) return null;   /* over the kernel's budget, or no arena */

    /* Every view is made after the kernel has allocated: a call can grow the
       memory, and a view on the old buffer would be detached. */
    const memory = exp.memory.buffer;
    new Float32Array(memory, exp.fe_poly_positions_ptr(), verts * 3)
      .set(position.array.subarray(0, verts * 3));
    if (index) {
      const src = index.array;
      const idx = new Uint32Array(memory, exp.fe_poly_indices_ptr(), triangles * 3);
      if (src instanceof Uint32Array) idx.set(src.subarray(0, triangles * 3));
      else for (let i = 0; i < triangles * 3; i++) idx[i] = src[i];
    }
    if (declared) {
      const starts = new Uint32Array(memory, exp.fe_poly_declared_start_ptr(), declared.length + 1);
      let at0 = 0;
      for (let f = 0; f < declared.length; f++) {
        starts[f] = at0;
        at0 += declared[f].length;
      }
      starts[declared.length] = at0;
      const ring = new Uint32Array(memory, exp.fe_poly_declared_ring_ptr(), corners);
      let at = 0;
      for (const face of declared) { ring.set(face, at); at += face.length; }
      if (!exp.fe_poly_set_declared_corners(corners)) return null;
    }

    const faceCount = exp.fe_poly_build();
    if (faceCount <= 0) return null;

    /* The kernel's tables are valid until the next build, so they are copied
       into ordinary arrays here; the geometry keeps them, not the engine. */
    const ringStart = new Uint32Array(exp.memory.buffer, exp.fe_poly_face_start_ptr(), faceCount + 1);
    const ringAll = new Uint32Array(exp.memory.buffer, exp.fe_poly_face_ring_ptr(), exp.fe_poly_face_ring_count());
    const triStart = new Uint32Array(exp.memory.buffer, exp.fe_poly_face_tri_start_ptr(), faceCount + 1);
    const triAll = new Uint32Array(exp.memory.buffer, exp.fe_poly_face_tri_ptr(), exp.fe_poly_face_tri_count());
    const faces = new Array(faceCount);
    const faceTris = new Array(faceCount);
    for (let f = 0; f < faceCount; f++) {
      faces[f] = Array.from(ringAll.subarray(ringStart[f], ringStart[f + 1]));
      faceTris[f] = Array.from(triAll.subarray(triStart[f], triStart[f + 1]));
    }

    const edgeCount = exp.fe_poly_edge_count();
    const edgePairs = new Uint32Array(edgeCount * 2);
    if (edgeCount) {
      const pairs = new Uint32Array(exp.memory.buffer, exp.fe_poly_edge_ptr(), edgeCount * 2);
      edgePairs.set(pairs);
    }

    const welded = exp.fe_poly_weld_count();
    let rep = null;
    if (welded !== verts) {
      const table = new Uint32Array(exp.memory.buffer, exp.fe_poly_weld_rep_ptr(), welded);
      rep = new Int32Array(table);
    }

    const kinds = new Uint32Array(exp.memory.buffer, exp.fe_poly_kind_counts_ptr(), 3);
    return {
      faces,
      faceTris,
      rep,
      verts: welded,
      triangles,
      edges: edgePairs,
      kinds: [kinds[0], kinds[1], kinds[2]],
      stamp: attributeStamp(geometry)
    };
  }

  /* ---------------------------------------------------------------- access ---- */

  function faceList(geometry) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) return null;
    const stamp = attributeStamp(geometry);
    const cached = geometry.userData && geometry.userData.fePoly;
    if (cached && cached.stamp === stamp) return cached;
    let built = null;
    try { built = build(geometry); } catch (_) { built = null; }
    if (!built) return null;
    if (!geometry.userData) geometry.userData = {};
    geometry.userData.fePoly = built;
    return built;
  }

  function slotFor(poly, id) {
    return poly && poly.rep ? poly.rep[id] : id;
  }

  /* The model's edges as [low, high] pairs of welded ids. The kernel has already
     counted each pair once; this only unpacks them. */
  function boundaryEdges(poly) {
    if (!poly || !poly.edges) return [];
    const list = new Array(poly.edges.length / 2);
    for (let i = 0; i < list.length; i++) list[i] = [poly.edges[i * 2], poly.edges[i * 2 + 1]];
    return list;
  }

  /* The edges a modeller should see: the faces' own boundaries, and nothing
     down the middle of a face. This is what the wireframe, See through and the
     selection outline are built from. */
  function buildWireGeometry(geometry) {
    const THREE = three();
    const poly = faceList(geometry);
    if (!THREE || !poly || !poly.faces.length || !poly.edges.length) return null;
    const positions = geometry.attributes.position.array;
    const out = new Float32Array(poly.edges.length * 3);
    let at = 0;
    for (let i = 0; i < poly.edges.length; i += 2) {
      const sa = slotFor(poly, poly.edges[i]) * 3;
      const sb = slotFor(poly, poly.edges[i + 1]) * 3;
      out[at++] = positions[sa]; out[at++] = positions[sa + 1]; out[at++] = positions[sa + 2];
      out[at++] = positions[sb]; out[at++] = positions[sb + 1]; out[at++] = positions[sb + 2];
    }
    const built = new THREE.BufferGeometry();
    built.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    built.userData.fePolyEdges = true;
    return built;
  }

  /* Faces as lists of vertex slots, which is what an editor works on. */
  function facesInSlots(geometry) {
    const poly = faceList(geometry);
    if (!poly) return null;
    return poly.faces.map((face) => face.map((id) => slotFor(poly, id)));
  }

  function stats(geometry) {
    const poly = faceList(geometry);
    if (!poly) return null;
    return {
      vertices: poly.verts,
      faces: poly.faces.length,
      quads: poly.kinds[1],
      triangles: poly.kinds[0],
      ngons: poly.kinds[2],
      edges: poly.edges.length / 2,
      sourceTriangles: poly.triangles
    };
  }

  global.FEPoly = {
    /* The wireframe angle the kernel is compiled with; a caller that wants the
       number for a label reads it from here. */
    QUAD_ANGLE_DEG: 0.6,
    faceList,
    boundaryEdges,
    facesInSlots,
    buildWireGeometry,
    stats,
    invalidate(geometry) {
      if (geometry && geometry.userData) delete geometry.userData.fePoly;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
