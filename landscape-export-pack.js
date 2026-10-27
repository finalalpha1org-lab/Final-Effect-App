/* Turning what the studio is showing into an import payload is arithmetic, not
   rendering, so it lives here as pure functions the offline tests can run:

     measureChunks        the world-space box the resident chunks cover
     mergedGridPlan       one square heightfield that covers that box
     sampleWorldField     bilinear resampling of a per-chunk field onto it
     mergeInstancedParts  per-chunk instance matrices folded into world space
     packPlanetGlobe      a procedural planet tessellated into a displaced sphere

   No three.js, no DOM, no globals: the studio passes in its own relief and
   colour functions, the tests pass in known ones. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LandscapeExportPack = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  /* Every resident chunk is a square of `size` metres centred on
     (originX, originZ) — the studio positions each chunk group there and the
     generator stores the same centre in the chunk record. */
  function measureChunks(records) {
    const list = Array.isArray(records) ? records : [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    let counted = 0;
    for (const record of list) {
      if (!record || !record.heights) continue;
      const size = Math.max(1, num(record.size, 1));
      const half = size * 0.5;
      const cx = num(record.originX);
      const cz = num(record.originZ);
      minX = Math.min(minX, cx - half);
      maxX = Math.max(maxX, cx + half);
      minZ = Math.min(minZ, cz - half);
      maxZ = Math.max(maxZ, cz + half);
      const heights = record.heights;
      for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (!Number.isFinite(h)) continue;
        if (h < minHeight) minHeight = h;
        if (h > maxHeight) maxHeight = h;
      }
      counted++;
    }
    if (!counted) {
      return { count: 0, minX: 0, maxX: 0, minZ: 0, maxZ: 0, centerX: 0, centerZ: 0, sizeX: 0, sizeZ: 0, minHeight: 0, maxHeight: 0 };
    }
    return {
      count: counted,
      minX,
      maxX,
      minZ,
      maxZ,
      centerX: (minX + maxX) * 0.5,
      centerZ: (minZ + maxZ) * 0.5,
      sizeX: maxX - minX,
      sizeZ: maxZ - minZ,
      minHeight: Number.isFinite(minHeight) ? minHeight : 0,
      maxHeight: Number.isFinite(maxHeight) ? maxHeight : 0,
    };
  }

  /* One square grid, never coarser than the finest source chunk and never
     larger than `maxSegments` so the import cannot turn into a million-vertex
     transfer on a handset. */
  function mergedGridPlan(bounds, options) {
    const opts = options || {};
    const maxSegments = clamp(Math.round(num(opts.maxSegments, 256)), 8, 1024);
    const minStep = Math.max(0.02, num(opts.minStep, 2));
    const sizeX = Math.max(0, num(bounds && bounds.sizeX));
    const sizeZ = Math.max(0, num(bounds && bounds.sizeZ));
    const size = Math.max(sizeX, sizeZ, minStep);
    const segments = clamp(Math.round(size / minStep), 8, maxSegments);
    return {
      size,
      segments,
      step: size / segments,
      centerX: num(bounds && bounds.centerX),
      centerZ: num(bounds && bounds.centerZ),
      vertices: (segments + 1) * (segments + 1),
    };
  }

  /* Chunk fields are row-major over (segments + 1)² metres of X then Z, which
     is exactly the order three.js PlaneGeometry lays out after rotateX(-PI/2).
     The merged grid uses the same order, so index k is j * row + i with i on
     +X and j on +Z. Vertices that fall outside every resident chunk borrow the
     nearest one rather than inventing a hole the eye would read as a cliff. */
  function sampleWorldField(records, plan, fieldName, components) {
    const list = (Array.isArray(records) ? records : []).filter((record) => record && record[fieldName]);
    const row = plan.segments + 1;
    const total = row * row;
    const parts = Math.max(1, Math.round(num(components, 1)));
    const out = new Float32Array(total * parts);
    if (!list.length) return out;
    for (let j = 0; j < row; j++) {
      const z = plan.centerZ + (j / plan.segments - 0.5) * plan.size;
      for (let i = 0; i < row; i++) {
        const x = plan.centerX + (i / plan.segments - 0.5) * plan.size;
        let chunk = null;
        let nearest = Infinity;
        for (const record of list) {
          const size = Math.max(1, num(record.size, 1));
          const halfSize = size * 0.5;
          const dx = Math.abs(x - num(record.originX));
          const dz = Math.abs(z - num(record.originZ));
          if (dx <= halfSize && dz <= halfSize) { chunk = record; break; }
          const distance = Math.max(dx - halfSize, 0) + Math.max(dz - halfSize, 0);
          if (distance < nearest) { nearest = distance; chunk = record; }
        }
        if (!chunk) continue;
        const out0 = (j * row + i) * parts;
        sampleChunk(chunk, x, z, fieldName, parts, out, out0);
      }
    }
    return out;
  }

  function sampleChunk(chunk, x, z, fieldName, parts, out, out0) {
    const size = Math.max(1, num(chunk.size, 1));
    const segments = Math.max(1, Math.round(num(chunk.segments, 1)));
    const row = segments + 1;
    const step = size / segments;
    const u = clamp((x - (num(chunk.originX) - size * 0.5)) / step, 0, segments);
    const v = clamp((z - (num(chunk.originZ) - size * 0.5)) / step, 0, segments);
    const i = Math.min(Math.floor(u), segments - 1);
    const j = Math.min(Math.floor(v), segments - 1);
    const a = clamp(u - i, 0, 1);
    const b = clamp(v - j, 0, 1);
    const field = chunk[fieldName];
    const base = j * row + i;
    const limit = field.length;
    for (let q = 0; q < parts; q++) {
      const k00 = (base * parts) + q;
      const k10 = ((base + 1) * parts) + q;
      const k01 = ((base + row) * parts) + q;
      const k11 = ((base + row + 1) * parts) + q;
      const v00 = k00 < limit ? field[k00] : 0;
      const v10 = k10 < limit ? field[k10] : v00;
      const v01 = k01 < limit ? field[k01] : v00;
      const v11 = k11 < limit ? field[k11] : v01;
      out[out0 + q] = (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b;
    }
  }

  /* The open world renders one InstancedMesh per species part inside each chunk
     group, with matrices relative to the chunk centre. The Workspace wants one
     world-space list per part, so this concatenates the chunks into position +
     quaternion + scale (10 floats) instead of 16-float matrices: the instance
     transforms carry no shear, the translation is folded in, and a third of the
     transfer disappears with it. Colours are concatenated the same way. */
  function matricesToTransforms(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const buckets = new Map();
    const order = [];
    for (const entry of list) {
      if (!entry || !entry.matrices) continue;
      const count = Math.max(0, Math.round(num(entry.count, 0)));
      if (!count) continue;
      const key = String(entry.key == null ? entry.name || "part" : entry.key);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, count: 0 };
        buckets.set(key, bucket);
        order.push(bucket);
      }
      bucket.count += count;
    }
    if (!order.length) return [];
    for (const bucket of order) {
      bucket.transforms = new Float32Array(bucket.count * 10);
      bucket.colors = new Float32Array(bucket.count * 3).fill(1);
      bucket.cursor = 0;
    }
    for (const entry of list) {
      if (!entry || !entry.matrices) continue;
      const bucket = buckets.get(String(entry.key == null ? entry.name || "part" : entry.key));
      if (!bucket) continue;
      const count = Math.max(0, Math.min(Math.round(num(entry.count, 0)), Math.floor(entry.matrices.length / 16)));
      if (!count) continue;
      const ox = num(entry.originX);
      const oz = num(entry.originZ);
      const e = entry.matrices;
      const target = bucket.transforms;
      let out = bucket.cursor * 10;
      for (let i = 0; i < count; i++) {
        const at = i * 16;
        const sx = Math.hypot(e[at], e[at + 1], e[at + 2]);
        const sy = Math.hypot(e[at + 4], e[at + 5], e[at + 6]);
        const sz = Math.hypot(e[at + 8], e[at + 9], e[at + 10]);
        let qx = 0, qy = 0, qz = 0, qw = 1;
        /* A collapsed instance has no rotation to recover; keep it collapsed
           rather than dividing a zero basis into a meaningless quaternion. */
        if (!(sx > 1e-8 && sy > 1e-8 && sz > 1e-8)) {
          target[out] = e[at + 12] + ox;
          target[out + 1] = e[at + 13];
          target[out + 2] = e[at + 14] + oz;
          target[out + 3] = 0; target[out + 4] = 0; target[out + 5] = 0; target[out + 6] = 1;
          target[out + 7] = sx; target[out + 8] = sy; target[out + 9] = sz;
          out += 10;
          continue;
        }
        const r00 = e[at] / sx, r10 = e[at + 1] / sx, r20 = e[at + 2] / sx;
        const r01 = e[at + 4] / sy, r11 = e[at + 5] / sy, r21 = e[at + 6] / sy;
        const r02 = e[at + 8] / sz, r12 = e[at + 9] / sz, r22 = e[at + 10] / sz;
        const trace = r00 + r11 + r22;
        if (trace > 0) {
          const k = Math.sqrt(trace + 1) * 2;
          qw = k * 0.25;
          qx = (r21 - r12) / k;
          qy = (r02 - r20) / k;
          qz = (r10 - r01) / k;
        } else if (r00 > r11 && r00 > r22) {
          const k = Math.sqrt(1 + r00 - r11 - r22) * 2;
          qw = (r21 - r12) / k;
          qx = k * 0.25;
          qy = (r01 + r10) / k;
          qz = (r02 + r20) / k;
        } else if (r11 > r22) {
          const k = Math.sqrt(1 + r11 - r00 - r22) * 2;
          qw = (r02 - r20) / k;
          qx = (r01 + r10) / k;
          qy = k * 0.25;
          qz = (r12 + r21) / k;
        } else {
          const k = Math.sqrt(1 + r22 - r00 - r11) * 2;
          qw = (r10 - r01) / k;
          qx = (r02 + r20) / k;
          qy = (r12 + r21) / k;
          qz = k * 0.25;
        }
        target[out] = e[at + 12] + ox;
        target[out + 1] = e[at + 13];
        target[out + 2] = e[at + 14] + oz;
        target[out + 3] = qx;
        target[out + 4] = qy;
        target[out + 5] = qz;
        target[out + 6] = qw;
        target[out + 7] = sx;
        target[out + 8] = sy;
        target[out + 9] = sz;
        out += 10;
      }
      if (entry.colors) {
        const colors = bucket.colors;
        const colorAt = bucket.cursor * 3;
        const available = Math.floor(entry.colors.length / 3);
        for (let i = 0; i < count && i < available; i++) {
          colors[colorAt + i * 3] = entry.colors[i * 3];
          colors[colorAt + i * 3 + 1] = entry.colors[i * 3 + 1];
          colors[colorAt + i * 3 + 2] = entry.colors[i * 3 + 2];
        }
      }
      bucket.cursor = Math.min(bucket.cursor + count, bucket.count);
    }
    return order.map((bucket) => ({
      key: bucket.key,
      count: bucket.count,
      transforms: bucket.transforms,
      colors: bucket.colors,
    }));
  }

  /* A planet is a grid in longitude/latitude displaced along its own radius and
     coloured by whatever the studio's surface classifier says. The vertex order
     is three.js SphereGeometry's — x = -cos(u)sin(v)π, y = cos(v)π, z =
     sin(u)sin(v)π, row-major from the north pole — so the Workspace can rebuild
     the sphere with SphereGeometry and displace it index for index, instead of
     shipping a non-indexed triangle soup. Normals come from the neighbouring
     vertices (wrapping across the date line, clamped at the poles), so the seam
     and the poles shade like the rest of the globe rather than showing a crease. */
  function packPlanetGlobe(options) {
    const opts = options || {};
    const segments = clamp(Math.round(num(opts.segments, 192)), 8, 512);
    const rings = clamp(Math.round(num(opts.rings, 96)), 4, 256);
    const radius = Math.max(1e-3, num(opts.radius, 1));
    const relief = typeof opts.relief === "function" ? opts.relief : () => 0;
    const colour = typeof opts.colour === "function" ? opts.colour : () => [1, 1, 1];
    const row = segments + 1;
    const count = row * (rings + 1);
    const positions = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    let p = 0;
    let c = 0;
    let t = 0;
    let minRadius = Infinity;
    let maxRadius = -Infinity;
    for (let j = 0; j <= rings; j++) {
      const v = j / rings;
      const phi = v * Math.PI;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      for (let i = 0; i <= segments; i++) {
        const u = i / segments;
        const theta = u * Math.PI * 2;
        const dx = -sinPhi * Math.cos(theta);
        const dy = cosPhi;
        const dz = sinPhi * Math.sin(theta);
        const height = num(relief(dx, dy, dz, u, v), 0);
        const r = radius + height;
        positions[p] = dx * r;
        positions[p + 1] = dy * r;
        positions[p + 2] = dz * r;
        radii[p / 3] = r;
        const rgb = colour(dx, dy, dz, height, u, v) || [1, 1, 1];
        colors[c] = num(rgb[0], 1);
        colors[c + 1] = num(rgb[1], 1);
        colors[c + 2] = num(rgb[2], 1);
        uvs[t++] = u;
        uvs[t++] = 1 - v;
        p += 3;
        c += 3;
        if (r < minRadius) minRadius = r;
        if (r > maxRadius) maxRadius = r;
      }
    }
    const normals = new Float32Array(count * 3);
    const at = (i, j) => ((clamp(j, 0, rings) * row) + clamp(i, 0, segments)) * 3;
    for (let j = 0; j <= rings; j++) {
      for (let i = 0; i <= segments; i++) {
        const n = at(i, j);
        const west = at(i === 0 ? segments - 1 : i - 1, j);
        const east = at(i === segments ? 1 : i + 1, j);
        const past = at(i, j === 0 ? 0 : j - 1);
        const next = at(i, j === rings ? rings : j + 1);
        const ux = positions[east] - positions[west];
        const uy = positions[east + 1] - positions[west + 1];
        const uz = positions[east + 2] - positions[west + 2];
        const vx = positions[next] - positions[past];
        const vy = positions[next + 1] - positions[past + 1];
        const vz = positions[next + 2] - positions[past + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        let length = Math.hypot(nx, ny, nz);
        /* Relief is small against the radius, so the radial direction is a sound
           reference for "outward" and keeps the winding question out of it. */
        if (!(length > 1e-8)) {
          nx = positions[n];
          ny = positions[n + 1];
          nz = positions[n + 2];
          length = Math.hypot(nx, ny, nz) || 1;
        } else if (nx * positions[n] + ny * positions[n + 1] + nz * positions[n + 2] < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        normals[n] = nx / length;
        normals[n + 1] = ny / length;
        normals[n + 2] = nz / length;
      }
    }
    return {
      segments,
      rings,
      radius,
      positions,
      radii,
      normals,
      colors,
      uvs,
      vertexCount: count,
      triangleCount: rings * segments * 2,
      minRadius,
      maxRadius,
    };
  }

  return { measureChunks, mergedGridPlan, sampleWorldField, matricesToTransforms, packPlanetGlobe };
});
