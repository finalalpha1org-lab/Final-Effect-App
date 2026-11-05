/* FEPoly - the polygon model behind a mesh.

   A mesh is vertices and faces. Triangles are how a GPU draws a face, not what
   the face is: Blender and Maya keep quads and n-gons and only triangulate at
   the render boundary, which is why their models do not grow a diagonal down
   the middle of a flat face when you look at them carefully.

   This file keeps that face list for the meshes in this app. The GPU still gets
   triangles - three.js only draws triangles - but everything that looks at the
   shape (the wireframe, See through, the selection outline, the edge table, the
   exports) reads the faces from here instead of guessing from the triangulation.

   How a face list is recovered from a triangle mesh, which is what every mesh in
   this app is today:

     - vertices are welded by position (quantised), because a Boolean or modifier
       result, a decimated model and most glTF exports are non-indexed: their
       triangles carry their own copies of each vertex, so two triangles that
       share an edge share a position but not an index;
     - two triangles that share an edge and face the same way are one quad of the
       model, and the edge between them is not an edge of the model;
     - "face the same way" is measured two ways, because a quad on a curved
       surface is not flat: a pair that is coplanar to within the wireframe angle
       is one face, and so is a pair whose shared edge is the longest side of
       both triangles while the two of them fold by less than 60 degrees. The
       second rule is the one the edit kernel pairs faces with, so a Quad Sphere
       or a knot - every face of which is a slightly warped quad - draws the same
       faces in Object Mode as it does in Edit Mode, instead of growing a
       diagonal across each of them;
     - the candidate pairs are taken longest shared edge first (the diagonal of a
       quad is longer than the sides it shares with its neighbours), each
       triangle is used at most once, and a pair is only accepted when the four
       corners form a convex quad;
     - everything left over stays a triangle.

   Faces hold three or more vertices, so an n-gon that arrives from a loader is
   kept as it is. Nothing is triangulated here; the geometry that three.js draws
   is untouched. This is a view of the same mesh, measured once per geometry and
   remembered on it (`geometry.userData.fePoly`), keyed to the position
   attribute's version so a modifier that rewrites the buffer gets a fresh one.
*/
(function (global) {
  'use strict';

  /* The app's own wireframe angle: two faces within this angle of each other are
     one surface, so the edge between them is internal structure. */
  const QUAD_ANGLE_DEG = 0.6;
  const COS_FLAT = Math.cos((QUAD_ANGLE_DEG * Math.PI) / 180);
  /* The second pairing rule: a pair that is not flat may still be one face, up
     to this fold. It is the edit kernel's number (see buildQuadGroups in
     cpp/src/fe_editmesh.cpp) and for the same reason - an edit bends a face, and
     the face must stay one face - while a real fold, a cone's or a cube's
     ninety degrees, still shows as two. */
  const QUAD_ANGLE_TOLERANT_DEG = 60;
  const COS_QUAD = Math.cos((QUAD_ANGLE_TOLERANT_DEG * Math.PI) / 180);

  /* Vertices within a tenth of a millimetre at unit scale are the same vertex. */
  const QUANT = 1e4;

  /* Vertex ids are packed into a double as a * 2097152 + b; every mesh this app
     holds is far below that. */
  const PACK = 2097152;

  function three() {
    return global.THREE || null;
  }

  function attributeStamp(geometry) {
    const position = geometry && geometry.attributes && geometry.attributes.position;
    return position ? position.count + ':' + (position.version || 0) : '';
  }

  function edgeKey(a, b) {
    return a < b ? a * PACK + b : b * PACK + a;
  }

  /* ---------------------------------------------------------------- build --- */

  function build(geometry) {
    const position = geometry.attributes && geometry.attributes.position;
    if (!position || !position.array) return null;
    const index = geometry.index;
    const positions = position.array;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (!triCount || triCount > 200000) return null;

    const slotOfCorner = (t, k) => (index ? index.array[t * 3 + k] : t * 3 + k);

    /* Canonical ids: the index for an indexed mesh, welded positions for a
       non-indexed one. `rep` remembers one real vertex slot per id so positions
       can still be read from the buffer. */
    let cidOfSlot = null;
    let rep = null;
    let vertCount = position.count;
    if (!index) {
      cidOfSlot = new Int32Array(position.count);
      const first = [];
      const seen = new Map();
      for (let i = 0; i < position.count; i++) {
        const key = Math.round(positions[i * 3] * QUANT) + ',' +
                    Math.round(positions[i * 3 + 1] * QUANT) + ',' +
                    Math.round(positions[i * 3 + 2] * QUANT);
        let id = seen.get(key);
        if (id === undefined) { id = first.length; first.push(i); seen.set(key, id); }
        cidOfSlot[i] = id;
      }
      rep = Int32Array.from(first);
      vertCount = rep.length;
    }
    const cid = (slot) => (cidOfSlot ? cidOfSlot[slot] : slot);

    /* Triangle corners and normals. */
    const corners = new Int32Array(triCount * 3);
    const normals = new Float32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      const s0 = slotOfCorner(t, 0), s1 = slotOfCorner(t, 1), s2 = slotOfCorner(t, 2);
      corners[t * 3] = cid(s0);
      corners[t * 3 + 1] = cid(s1);
      corners[t * 3 + 2] = cid(s2);
      const ax = positions[s0 * 3], ay = positions[s0 * 3 + 1], az = positions[s0 * 3 + 2];
      const ux = positions[s1 * 3] - ax, uy = positions[s1 * 3 + 1] - ay, uz = positions[s1 * 3 + 2] - az;
      const vx = positions[s2 * 3] - ax, vy = positions[s2 * 3 + 1] - ay, vz = positions[s2 * 3 + 2] - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals[t * 3] = nx / length;
      normals[t * 3 + 1] = ny / length;
      normals[t * 3 + 2] = nz / length;
    }

    /* Shared edges. */
    const edges = new Map();
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const a = corners[t * 3 + k];
        const b = corners[t * 3 + ((k + 1) % 3)];
        if (a === b) continue;
        const key = edgeKey(a, b);
        const record = edges.get(key);
        if (!record) edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), t0: t, t1: -1 });
        else if (record.t1 === -1 && record.t0 !== t) record.t1 = t;
        else if (record.t0 !== t && record.t1 !== t) record.t1 = -2;   /* non-manifold: no fusing */
      }
    }

    /* Candidate quads: a shared edge, two coplanar triangles, a convex quad. */
    const point = (id) => {
      const s = rep ? rep[id] : id;
      return [positions[s * 3], positions[s * 3 + 1], positions[s * 3 + 2]];
    };
    const flat = (t0, t1) => {
      const dot = normals[t0 * 3] * normals[t1 * 3] +
                  normals[t0 * 3 + 1] * normals[t1 * 3 + 1] +
                  normals[t0 * 3 + 2] * normals[t1 * 3 + 2];
      return dot >= COS_FLAT;
    };
    const length2 = (a, b) => {
      const pa = point(a), pb = point(b);
      const dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2];
      return dx * dx + dy * dy + dz * dz;
    };
    /* Convexity: going round a-c-b-d, every turn must bend the same way, so the
       four corners enclose a real quad and not a folded or arrow-shaped one.
       The turn is measured against the quad's own normal. */
    /* The shared edge is a quad's diagonal when it is the longest side of both
       of its triangles: in a rectangle the diagonal is the hypotenuse, and the
       sides two quads share are shorter than the diagonals that touch them. The
       tolerance is 2%, so a deformation that brings a side close to the
       diagonal's length does not tear the face into two. */
    const diagonalEdge = (t0, t1, a, b) => {
      const limit = length2(a, b) * 1.02;
      for (const t of [t0, t1]) {
        for (let k = 0; k < 3; k++) {
          const v = corners[t * 3 + k];
          const w = corners[t * 3 + ((k + 1) % 3)];
          if ((v === a && w === b) || (v === b && w === a)) continue;
          if (length2(v, w) > limit) return false;
        }
      }
      return true;
    };
    const convex = (a, c, b, d) => {
      const quad = [point(a), point(c), point(b), point(d)];
      const ux = quad[2][0] - quad[0][0], uy = quad[2][1] - quad[0][1], uz = quad[2][2] - quad[0][2];
      const vx = quad[3][0] - quad[1][0], vy = quad[3][1] - quad[1][1], vz = quad[3][2] - quad[1][2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const normalLength = Math.hypot(nx, ny, nz);
      if (!(normalLength > 1e-12)) return false;
      let positive = 0, counted = 0;
      for (let i = 0; i < 4; i++) {
        const p0 = quad[i], p1 = quad[(i + 1) % 4], p2 = quad[(i + 2) % 4];
        const wx = p1[0] - p0[0], wy = p1[1] - p0[1], wz = p1[2] - p0[2];
        const zx = p2[0] - p1[0], zy = p2[1] - p1[1], zz = p2[2] - p1[2];
        const cx = wy * zz - wz * zy, cy = wz * zx - wx * zz, cz = wx * zy - wy * zx;
        const length = Math.hypot(cx, cy, cz);
        if (length < 1e-12) continue;
        counted++;
        if ((cx * nx + cy * ny + cz * nz) / length > 0) positive++;
      }
      return counted >= 3 && (positive === 0 || positive === counted);
    };

    const candidates = [];
    edges.forEach((record) => {
      const { a, b, t0, t1 } = record;
      if (t1 < 0) return;
      if (!flat(t0, t1)) {
        /* Not coplanar: one face only if the shared edge is the diagonal of a
           quad and the two halves do not fold away from each other. */
        const fold = normals[t0 * 3] * normals[t1 * 3] +
                     normals[t0 * 3 + 1] * normals[t1 * 3 + 1] +
                     normals[t0 * 3 + 2] * normals[t1 * 3 + 2];
        if (fold < COS_QUAD) return;
        if (!diagonalEdge(t0, t1, a, b)) return;
      }
      candidates.push({ a, b, t0, t1, len: length2(a, b) });
    });
    /* Longest shared edge first, which is the order the edit kernel uses. The
       diagonal of a drawn quad is longer than the sides it shares with its
       neighbours, so taking the long ones first rebuilds the quads the model was
       built from; taking the short ones first (which this did) pairs across a
       grid's cell borders instead, and a square grid's borders are the same
       length as its diagonals' neighbours, so faces came out the wrong way. */
    candidates.sort((x, y) => y.len - x.len);

    const faces = [];
    const faceTris = [];
    const done = new Uint8Array(triCount);
    for (const candidate of candidates) {
      const { a, b, t0, t1 } = candidate;
      if (done[t0] || done[t1]) continue;
      /* The two apexes opposite the shared edge. */
      const apex = (t) => {
        for (let k = 0; k < 3; k++) {
          const v = corners[t * 3 + k];
          if (v !== a && v !== b) return v;
        }
        return -1;
      };
      const c = apex(t0), d = apex(t1);
      if (c < 0 || d < 0 || c === d) continue;
      if (!convex(a, c, b, d)) continue;
      done[t0] = 1;
      done[t1] = 1;
      faces.push([a, c, b, d]);
      /* The triangles this face is made of, in the geometry's own triangle
         numbering: the edit mesh hands out triangle indices, so this is what
         lets a tap on one of them select the whole face. */
      faceTris.push([t0, t1]);
    }
    for (let t = 0; t < triCount; t++) {
      if (done[t]) continue;
      faces.push([corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]]);
      faceTris.push([t]);
    }

    return {
      faces,
      faceTris,
      rep,
      verts: vertCount,
      triangles: triCount,
      stamp: attributeStamp(geometry)
    };
  }

  /* ------------------------------------------------------------- access ---- */

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

  function boundaryEdges(poly) {
    const list = [];
    if (!poly) return list;
    const seen = new Set();
    for (const face of poly.faces) {
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        if (a === b) continue;
        const key = edgeKey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        list.push([Math.min(a, b), Math.max(a, b)]);
      }
    }
    return list;
  }

  /* The edges a modeller should see: the faces' own boundaries, and nothing
     down the middle of a face. This is what the wireframe, See through and the
     selection outline should be built from. */
  function buildWireGeometry(geometry) {
    const THREE = three();
    const poly = faceList(geometry);
    if (!THREE || !poly || !poly.faces.length) return null;
    const positions = geometry.attributes.position.array;
    const edges = boundaryEdges(poly);
    if (!edges.length) return null;
    const out = new Float32Array(edges.length * 6);
    let at = 0;
    for (const [a, b] of edges) {
      const sa = slotFor(poly, a), sb = slotFor(poly, b);
      out[at++] = positions[sa * 3]; out[at++] = positions[sa * 3 + 1]; out[at++] = positions[sa * 3 + 2];
      out[at++] = positions[sb * 3]; out[at++] = positions[sb * 3 + 1]; out[at++] = positions[sb * 3 + 2];
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
    let quads = 0, triangles = 0, ngons = 0;
    for (const face of poly.faces) {
      if (face.length === 4) quads++;
      else if (face.length === 3) triangles++;
      else ngons++;
    }
    return {
      vertices: poly.verts,
      faces: poly.faces.length,
      quads,
      triangles,
      ngons,
      edges: boundaryEdges(poly).length,
      sourceTriangles: poly.triangles
    };
  }

  global.FEPoly = {
    QUAD_ANGLE_DEG,
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