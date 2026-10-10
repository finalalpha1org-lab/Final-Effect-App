// Procedural canvas texture generators matching Landscaping Studio
function createProceduralNoiseTextureHost(T, type = 'rock') {
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    const imgData = ctx.createImageData(256, 256);
    const d = imgData.data;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const idx = (y * 256 + x) * 4;
        let val = 128;
        if (type === 'rock') {
          const n1 = Math.sin(x * 0.05 + y * 0.04) * Math.cos(x * 0.03 - y * 0.06);
          const n2 = Math.sin(x * 0.18) * Math.cos(y * 0.18) * 0.4;
          const n3 = Math.sin(x * 0.45 - y * 0.42) * 0.2;
          val = Math.floor(128 + (n1 + n2 + n3) * 110);
        } else if (type === 'bark') {
          const grain = Math.sin(x * 0.72 + Math.sin(y * 0.09) * 3.8);
          const fine = Math.sin(x * 2.4 + y * 0.18) * 0.3;
          val = Math.floor(128 + (grain * 0.75 + fine) * 95);
        } else if (type === 'leaf') {
          const v1 = Math.sin(x * 0.36 + y * 0.24) * Math.cos(x * 0.22 - y * 0.34);
          const v2 = Math.sin(x * 0.82) * Math.sin(y * 0.82) * 0.35;
          val = Math.floor(128 + (v1 * 0.7 + v2) * 85);
        } else if (type === 'water') {
          const u = (x / 256) * Math.PI * 2;
          const v = (y / 256) * Math.PI * 2;
          const w1 = Math.sin(u * 2.0 + Math.cos(v * 2.0) * 1.6) * 0.40;
          const w2 = Math.sin(u * 3.0 - v * 2.0 + Math.sin(u * 1.0) * 1.2) * 0.30;
          const w3 = Math.cos(u * 1.0 + v * 4.0 - Math.cos(v * 1.0) * 1.4) * 0.25;
          const w4 = Math.sin((u * 0.866 + v * 0.500) * 5.0) * 0.18;
          val = Math.floor(128 + (w1 + w2 + w3 + w4) * 95);
        }
        val = Math.max(0, Math.min(255, val));
        d[idx] = val;
        d[idx + 1] = val;
        d[idx + 2] = val;
        d[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new T.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    const rep = type === 'rock' ? 4 : (type === 'bark' ? 3 : (type === 'water' ? 1 : 6));
    tex.repeat.set(rep, rep);
    return tex;
  } catch(e) {
    return null;
  }
}

function createProceduralTerrainTexturesHost(T) {
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 512;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#3a6b28';
    ctx.fillRect(0, 0, 512, 512);
    const imgData = ctx.getImageData(0, 0, 512, 512);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const px = (i / 4) % 512;
      const py = Math.floor((i / 4) / 512);
      const n1 = Math.sin(px * 0.08 + py * 0.06) * Math.cos(px * 0.05 - py * 0.09);
      const n2 = Math.sin(px * 0.22 + py * 0.18) * 0.4;
      const n3 = Math.sin(px * 0.55 - py * 0.48) * 0.2;
      const noise = n1 + n2 + n3;
      data[i] = Math.min(255, Math.max(0, Math.floor(65 + noise * 25)));
      data[i + 1] = Math.min(255, Math.max(0, Math.floor(125 + noise * 38)));
      data[i + 2] = Math.min(255, Math.max(0, Math.floor(48 + noise * 18)));
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    const map = new T.CanvasTexture(cv);
    map.wrapS = map.wrapT = T.RepeatWrapping;
    map.repeat.set(20, 20);

    const bcv = document.createElement('canvas');
    bcv.width = bcv.height = 512;
    const bctx = bcv.getContext('2d');
    const bData = bctx.createImageData(512, 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const idx = (y * 512 + x) * 4;
        const n = Math.sin(x * 0.15) * Math.cos(y * 0.15) * 0.5 + 0.5;
        const val = Math.floor(128 + n * 64);
        bData.data[idx] = val;
        bData.data[idx + 1] = val;
        bData.data[idx + 2] = val;
        bData.data[idx + 3] = 255;
      }
    }
    bctx.putImageData(bData, 0, 0);
    const bump = new T.CanvasTexture(bcv);
    bump.wrapS = bump.wrapT = T.RepeatWrapping;
    bump.repeat.set(20, 20);

    return { map, bump };
  } catch(e) {
    return { map: null, bump: null };
  }
}

// Procedural foliage geometry builders matching Landscaping Studio
function createProceduralLandscapeFoliage(T) {
  const GA = () => ({ P: [], N: [], C: [], T: [], I: [] });
  function gaV(g, p, n, c, t) {
    g.P.push(p[0], p[1], p[2]);
    g.N.push(n[0], n[1], n[2]);
    g.C.push(c[0], c[1], c[2]);
    g.T.push(t[0], t[1]);
    return g.P.length / 3 - 1;
  }
  function gaQ(g, p, n, c, uv) {
    const a = p.map((q, i) => gaV(g, q, n, c, uv ? uv[i] : [[0, 0], [1, 0], [1, 1], [0, 1]][i]));
    g.I.push(a[0], a[1], a[2], a[0], a[2], a[3]);
  }
  function gaGeo(g) {
    const o = new T.BufferGeometry();
    o.setAttribute('position', new T.Float32BufferAttribute(g.P, 3));
    o.setAttribute('normal', new T.Float32BufferAttribute(g.N, 3));
    o.setAttribute('color', new T.Float32BufferAttribute(g.C, 3));
    o.setAttribute('uv', new T.Float32BufferAttribute(g.T, 2));
    o.setIndex(g.I);
    return o;
  }
  function tube(g, a, b, r0, r1, sd, us, v0, cap) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1e-6, d = [dx / L, dy / L, dz / L];
    let ux, uy = 0, uz;
    if (Math.abs(d[1]) < .97) { ux = d[2]; uz = -d[0]; } else { ux = 1; uz = 0; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uz /= ul;
    const vx = d[1] * uz - d[2] * uy, vy = d[2] * ux - d[0] * uz, vz = d[0] * uy - d[1] * ux, o = g.P.length / 3, off = v0 === undefined ? Math.abs(Math.sin(a[0] * 12.9 + a[1] * 7.3 + a[2] * 3.1)) * 10 : v0;
    for (let i = 0; i < 2; i++) {
      const c = i ? b : a, r = i ? r1 : r0, sh = .68 + .32 * Math.min(1, Math.max(0, (c[1] + 1) / 8));
      for (let j = 0; j <= sd; j++) {
        const th = j / sd * 6.2832, cs = Math.cos(th), sn = Math.sin(th), nx = ux * cs + vx * sn, ny = uy * cs + vy * sn, nz = uz * cs + vz * sn;
        gaV(g, [c[0] + nx * r, c[1] + ny * r, c[2] + nz * r], [nx, ny, nz], [sh, sh, sh], [j / sd * us[0], (i ? L : 0) * us[1] + off]);
      }
    }
    for (let j = 0; j < sd; j++) {
      const a0 = o + j, a1 = o + j + 1, b0 = o + sd + 1 + j, b1 = o + sd + 2 + j;
      g.I.push(a0, a1, b0, a1, b1, b0);
    }
    if (cap !== false && r1 > .004) {
      const sh1 = .68 + .32 * Math.min(1, Math.max(0, (b[1] + 1) / 8)), c0 = gaV(g, [b[0], b[1], b[2]], d, [sh1, sh1, sh1], [.5, .5]), ro = g.P.length / 3;
      for (let j = 0; j <= sd; j++) {
        const th = j / sd * 6.2832, cs = Math.cos(th), sn = Math.sin(th);
        gaV(g, [b[0] + (ux * cs + vx * sn) * r1, b[1] + (uy * cs + vy * sn) * r1, b[2] + (uz * cs + vz * sn) * r1], d, [sh1, sh1, sh1], [.5 + cs * .5, .5 + sn * .5]);
      }
      for (let j = 0; j < sd; j++) g.I.push(c0, ro + j, ro + j + 1);
    }
    return off + L * us[1];
  }
  function tubePath(g, P, Rd, sd, us) {
    const n = P.length, T_dirs = P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
      return [d[0] / l, d[1] / l, d[2] / l];
    });
    let u = Math.abs(T_dirs[0][1]) < .97 ? [T_dirs[0][2], 0, -T_dirs[0][0]] : [1, 0, 0];
    const ul = Math.hypot(u[0], u[1], u[2]) || 1;
    u = u.map(q => q / ul);
    const o = g.P.length / 3;
    let vv = Math.abs(Math.sin(P[0][0] * 12.9 + P[0][2] * 3.1)) * 10;
    for (let i = 0; i < n; i++) {
      const t = T_dirs[i];
      if (i) {
        const dd = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
        u = [u[0] - t[0] * dd, u[1] - t[1] * dd, u[2] - t[2] * dd];
        const l = Math.hypot(u[0], u[1], u[2]) || 1;
        u = u.map(q => q / l);
        vv += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]) * us[1];
      }
      const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]], sh = .68 + .32 * Math.min(1, Math.max(0, (P[i][1] + 1) / 8));
      for (let j = 0; j <= sd; j++) {
        const th = j / sd * 6.2832, cs = Math.cos(th), sn = Math.sin(th), nx = u[0] * cs + w[0] * sn, ny = u[1] * cs + w[1] * sn, nz = u[2] * cs + w[2] * sn;
        gaV(g, [P[i][0] + nx * Rd[i], P[i][1] + ny * Rd[i], P[i][2] + nz * Rd[i]], [nx, ny, nz], [sh, sh, sh], [j / sd * us[0], vv]);
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < sd; j++) {
      const a0 = o + i * (sd + 1) + j, a1 = a0 + 1, b0 = a0 + sd + 1, b1 = b0 + 1;
      g.I.push(a0, a1, b0, a1, b1, b0);
    }
  }
  function lcard(g, b, d, size, c0, c1, ctr) {
    const dl = Math.hypot(d[0], d[1], d[2]) || 1, vx = d[0] / dl, vy = d[1] / dl, vz = d[2] / dl;
    let ux = vz, uz = -vx, ul = Math.hypot(ux, uz);
    if (ul < .2) { ux = 1; uz = 0; ul = 1; }
    ux /= ul; uz /= ul;
    const roll = Math.random() * 3.1416, cr = Math.cos(roll), sr = Math.sin(roll), wx = vy * uz, wy = vz * ux - vx * uz, wz = -vy * ux, ax = ux * cr + wx * sr, ay = wy * sr, az = uz * cr + wz * sr, h = size * .42;
    let nx = vy * az - vz * ay, ny = vz * ax - vx * az, nz = vx * ay - vy * ax;
    const ox = b[0] - ctr[0], oy = b[1] - ctr[1], oz = b[2] - ctr[2], ol = Math.hypot(ox, oy, oz) || 1;
    if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    let fx = nx * .4 + ox / ol * .6, fy = ny * .4 + oy / ol * .6 + .15, fz = nz * .4 + oz / ol * .6;
    const fl = Math.hypot(fx, fy, fz) || 1, t = Math.min(1, Math.max(0, .5 + (oy / ol) * .3 + (ol / ctr[3] - .5) * .5)) * (.85 + Math.random() * .3);
    const c = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    const tp = [b[0] + vx * size, b[1] + vy * size, b[2] + vz * size];
    gaQ(g, [[b[0] - ax * h, b[1] - ay * h, b[2] - az * h], [b[0] + ax * h, b[1] + ay * h, b[2] + az * h], [tp[0] + ax * h, tp[1] + ay * h, tp[2] + az * h], [tp[0] - ax * h, tp[1] - ay * h, tp[2] - az * h]], [fx / fl, fy / fl, fz / fl], c);
  }
  function cluster(L, q, d, n, size, c0, c1, ctr, droop) {
    for (let k = 0; k < n; k++) {
      lcard(L, [q[0] + (Math.random() - .5) * .1, q[1] + (Math.random() - .5) * .1, q[2] + (Math.random() - .5) * .1], [d[0] + (Math.random() - .5) * .9, d[1] + (Math.random() - .5) * .9 - droop, d[2] + (Math.random() - .5) * .9], size * (.75 + Math.random() * .5), c0, c1, ctr);
    }
  }
  function grow(W, L, p, d, len, r, dep, mx, o) {
    const q = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len];
    tube(W, p, q, r, r * .72, 5, [1, .35]);
    if (dep >= mx - 1) {
      cluster(L, q, d, o.cards, o.size, o.c0, o.c1, o.ctr, o.droop);
      if (dep >= mx) return;
    }
    const n = dep == 0 ? 3 : (Math.random() < .55 ? 3 : 2);
    for (let i = 0; i < n; i++) {
      const s = .5 + Math.random() * .5, sp = [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s], j = .75;
      let nd = [d[0] + (Math.random() - .5) * j * 1.6, d[1] + (Math.random() - .5) * j + o.bias, d[2] + (Math.random() - .5) * j * 1.6];
      const nl = Math.hypot(nd[0], nd[1], nd[2]) || 1;
      nd = nd.map(v => v / nl);
      grow(W, L, sp, nd, len * (.6 + Math.random() * .22), r * .6, dep + 1, mx, o);
    }
  }
  const dirA = (a, e) => [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
  function oakTree() {
    const W = GA(), L = GA(), ctr = [0, 6, 0, 3.6], o = { cards: 4, size: 1.05, c0: [.66, .72, .6], c1: [1.15, 1.15, 1], ctr, droop: .25, bias: .12 };
    let p = [0, -.3, 0];
    const pts = [[0, -.3, 0]], rad = [.87], N = 14, wx = (Math.random() - .5) * .5, wz = (Math.random() - .5) * .5;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      pts.push([wx * Math.sin(t * 3) * .5, -.3 + 4.2 * t, wz * Math.sin(t * 2.6) * .5]);
      rad.push(.62 * Math.pow(.5, t) + .25 * Math.exp(-t * 8));
    }
    tubePath(W, pts, rad, 10, [2, .4]);
    p = pts[N];
    const n = 5 + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.283 + Math.random() * .6, e = .5 + Math.random() * .45;
      grow(W, L, [p[0], p[1] - .3 - Math.random() * .4, p[2]], dirA(a, e), 1.8 + Math.random() * .7, .2 + Math.random() * .05, 0, 3, o);
    }
    grow(W, L, p, [(Math.random() - .5) * .3, 1, (Math.random() - .5) * .3], 1.7, .19, 0, 3, o);
    return [gaGeo(W), gaGeo(L)];
  }
  function birchTree() {
    const W = GA(), L = GA(), ctr = [0, 6.5, 0, 2.4], o = { cards: 3, size: .8, c0: [.6, .7, .5], c1: [1.3, 1.25, .9], ctr, droop: .5, bias: -.05 };
    let p = [0, 0, 0];
    const lx = (Math.random() - .5) * .5, lz = (Math.random() - .5) * .5;
    const pts = [], rad = [], N = 14;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push([lx * 1.8 * t, 8.1 * t, lz * 1.8 * t]);
      rad.push(.16 * (1 - t * .7) + .05 * Math.exp(-t * 12));
    }
    tubePath(W, pts, rad, 8, [1, .5]);
    p = pts[N];
    for (let i = 0; i < 7; i++) {
      const y = 3.2 + Math.random() * 4.2, f = y / p[1];
      grow(W, L, [p[0] * f, y, p[2] * f], dirA(Math.random() * 6.283, .5 + Math.random() * .4), .9 + Math.random() * .5, .05, 0, 3, o);
    }
    grow(W, L, p, [0, 1, 0], .9, .05, 0, 2, o);
    return [gaGeo(W), gaGeo(L)];
  }
  function shrubTree() {
    const W = GA(), L = GA(), ctr = [0, .7, 0, 1.1], o = { cards: 3, size: .5, c0: [.66, .72, .6], c1: [1.15, 1.15, 1], ctr, droop: .1, bias: .05 };
    for (let i = 0; i < 7; i++) grow(W, L, [0, 0, 0], dirA(i / 7 * 6.283 + Math.random() * .8, .7 + Math.random() * .5), .55 + Math.random() * .25, .025, 0, 3, o);
    return [gaGeo(W), gaGeo(L)];
  }
  function strip(g, b, d, len, w, drop, c, rows) {
    const hl = Math.hypot(d[0], d[2]) || 1, sx = -d[2] / hl, sz = d[0] / hl, ids = [];
    for (let i = 0; i <= rows; i++) {
      const t = i / rows, wd = w * (1 - t * .35) * (i == rows ? .5 : 1), p = [b[0] + d[0] * len * t, b[1] + d[1] * len * t - drop * t * t, b[2] + d[2] * len * t], n = [d[0] * .5, .8, d[2] * .5], cc = c.map(v => v * (.75 + .25 * t));
      ids.push(gaV(g, [p[0] - sx * wd, p[1], p[2] - sz * wd], n, cc, [0, t]), gaV(g, [p[0] + sx * wd, p[1], p[2] + sz * wd], n, cc, [1, t]));
    }
    for (let i = 0; i < rows; i++) {
      const a = ids[i * 2], b2 = ids[i * 2 + 1], c2 = ids[i * 2 + 2], d2 = ids[i * 2 + 3];
      g.I.push(a, b2, c2, b2, d2, c2);
    }
  }
  function pineBranch(W, L, b, d, Rr, t) {
    const dl = Math.hypot(d[0], d[1], d[2]) || 1, dd = [d[0] / dl, d[1] / dl, d[2] / dl], len = Rr, p1 = [b[0] + dd[0] * len * .6, b[1] + dd[1] * len * .6, b[2] + dd[2] * len * .6], d2 = [dd[0], dd[1] + .35, dd[2]], l2 = Math.hypot(d2[0], d2[1], d2[2]), p2 = [p1[0] + d2[0] / l2 * len * .4, p1[1] + d2[1] / l2 * len * .4, p1[2] + d2[2] / l2 * len * .4];
    tube(W, b, p1, .05 * (1 - t * .5) + .015, .035, 4, [1, .5]);
    tube(W, p1, p2, .035, .015, 4, [1, .5]);
    [.4, .75, 1].forEach(s => {
      const A = s <= .6 ? [b, p1, s / .6] : [p1, p2, (s - .6) / .4], pos = [A[0][0] + (A[1][0] - A[0][0]) * A[2], A[0][1] + (A[1][1] - A[0][1]) * A[2], A[0][2] + (A[1][2] - A[0][2]) * A[2]];
      [-.6, .6].forEach(yw => {
        const c1 = Math.cos(yw), s1 = Math.sin(yw), dir = [dd[0] * c1 - dd[2] * s1, dd[1] * .4 + .05, dd[0] * s1 + dd[2] * c1];
        strip(L, pos, dir, (1.25 - .6 * s) * (.55 + .45 * (1 - t)) + .3, .5 + .3 * (1 - t), .55, [.7 + Math.random() * .3, .78 + Math.random() * .3, .7 + Math.random() * .2], 2);
      });
    });
  }
  function pineTree() {
    const W = GA(), L = GA(), H = 12 + Math.random() * 3, lx = (Math.random() - .5) * .25, lz = (Math.random() - .5) * .25, tx = y => lx * (y / H) * (y / H) * H * .1, tz = y => lz * (y / H) * (y / H) * H * .1;
    let p = [0, -.3, 0];
    const pts = [], rad = [], N = 18;
    for (let i = 0; i <= N; i++) {
      const t = i / N, y = -.3 + (H + .3) * t;
      pts.push([tx(y), y, tz(y)]);
      rad.push(.36 * (1 - t * .93) + .03 + .2 * Math.exp(-t * 16));
    }
    tubePath(W, pts, rad, 10, [2, .35]);
    p = pts[N];
    const nW = Math.round(H * 1.55);
    for (let k = 0; k < nW; k++) {
      const t = k / (nW - 1), y = 2.4 + t * (H - 2.9), Rr = (2.5 * Math.pow(1 - t, .85) + .2) * (.88 + Math.random() * .24), nb = Math.max(3, Math.round(7 * (1 - t * .55)));
      for (let j = 0; j < nb; j++) {
        const a = j / nb * 6.283 + k * 1.13 + Math.random() * .5;
        pineBranch(W, L, [tx(y), y, tz(y)], [Math.cos(a), -.32 + t * .6, Math.sin(a)], Rr, t);
      }
    }
    for (let j = 0; j < 7; j++) {
      const a = j / 7 * 6.283;
      strip(L, [p[0], H, p[2]], [Math.cos(a) * .4, 1, Math.sin(a) * .4], .9, .32, .15, [.9, 1, .8], 2);
    }
    return [gaGeo(W), gaGeo(L)];
  }
  function frond(L, W, b, a, e, len, dead) {
    const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e), g = dead ? 1.5 : 1.05, N = dead ? 11 : 20, pos = t => [b[0] + ca * ce * len * t, b[1] + se * len * t - g * len * t * t * .5, b[2] + sa * ce * len * t];
    tubePath(W, Array.from({ length: 7 }, (_, i) => pos(i / 6)), Array.from({ length: 7 }, (_, i) => .05 * (1 - i / 6 * .7) + .01), 5, [.3, .3]);
    for (let i = 1; i <= N; i++) {
      const t = .1 + .88 * (i + (Math.random() - .5) * .5) / N, P = pos(t), P2 = pos(t + .02), Tx = P2[0] - P[0], Ty = P2[1] - P[1], Tz = P2[2] - P[2], tl = Math.hypot(Tx, Ty, Tz) || 1, tx = Tx / tl, ty = Ty / tl, tz = Tz / tl, sl = Math.hypot(tz, tx) || 1, Sx = -tz / sl, Sz = tx / sl, ll = ((dead ? .8 : 1.3) * Math.pow(Math.max(0, Math.sin(Math.min(1, t * 1.08) * 3.1416)), .55) * (.55 + .45 * (1 - t * .5)) + .14) * (.85 + Math.random() * .3);
      [-1, 1].forEach(sd => {
        const yaw = (Math.random() - .5) * .35, cw = Math.cos(yaw), sw = Math.sin(yaw), dx0 = Sx * sd * .8 + tx * .55, dz0 = Sz * sd * .8 + tz * .55, dy1 = ty * .55 - .35 - t * .15 + (Math.random() - .5) * .2;
        strip(L, P, [dx0 * cw - dz0 * sw, dy1, dx0 * sw + dz0 * cw], ll, .1 + Math.random() * .03, ll * (.35 + Math.random() * .25), dead ? [.9, .65, .35] : [.7 + Math.random() * .3, .85 + Math.random() * .15, .55], 2);
      });
    }
  }
  function palmTree() {
    const W = GA(), L = GA(), Hh = 8 + Math.random() * 2, lean = .7 + Math.random() * 1.2, la = Math.random() * 6.283, lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
    let p = [0, -.2, 0];
    const pts = [], rad = [], N = 26, ph = Math.random() * 6;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push([lx * t * t + Math.sin(t * 5 + ph) * .07, -.2 + (Hh + .2) * t, lz * t * t + Math.cos(t * 4 + ph) * .07]);
      rad.push(.3 * (1 - t * .45) + .16 * Math.exp(-t * 14));
    }
    tubePath(W, pts, rad, 10, [1, .14]);
    p = pts[N];
    const top = p, tp = [top[0], top[1] + .7, top[2]];
    tube(W, top, tp, .2, .16, 7, [1, 1]);
    for (let f = 0; f < 15; f++) {
      const dead = f >= 12;
      frond(L, W, [tp[0], tp[1] - .1, tp[2]], f * 2.4 + Math.random() * .25, dead ? -.7 : .75 - (f % 4) * .12 + (Math.random() * .5) * .15, (dead ? 2.4 : 3.4) + Math.random(), dead);
    }
    return [gaGeo(W), gaGeo(L)];
  }
  function rockG() {
    const planes = Array.from({ length: 7 }, () => {
      const a = Math.random() * 6.283, b = Math.acos(Math.random() * 2 - 1);
      return [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a), .5 + Math.random() * .4];
    });
    const ph = Math.random() * 10, sx = .95 + Math.random() * .4, sy = .55 + Math.random() * .35, sz = .8 + Math.random() * .4, n3 = (x, y, z) => Math.sin(x * 2.3 + 1.3 + ph) * Math.sin(y * 2.9 + 2.1 + ph * .7) * Math.sin(z * 2.1 + 3.3 - ph * .5);
    const rad = (x, y, z) => {
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      let s = 0;
      for (const [a, b, c, o] of planes) {
        const d = a * x + b * y + c * z;
        if (d > .05) s += Math.exp(-10 * (o / d));
      }
      const r = s > 0 ? Math.min(1.15, -Math.log(s) / 10) : 1.1;
      return r * (1 + .1 * n3(x * 2.2, y * 2.2, z * 2.2) + .05 * n3(x * 5, y * 5, z * 5) + .02 * n3(x * 11, y * 11, z * 11));
    };
    const pos = (x, y, z) => {
      const l = Math.hypot(x, y, z) || 1, r = rad(x, y, z);
      return [x / l * r * sx, y / l * r * sy + .45, z / l * r * sz];
    };
    const NU = 32, NV = 20, P = [], Nm = [], C = [], T_coords = [], I = [], e = .012;
    for (let j = 0; j <= NV; j++) {
      const th = j / NV * Math.PI, st = Math.sin(th), ct = Math.cos(th);
      for (let i = 0; i <= NU; i++) {
        const f = i / NU * 6.2832, sf = Math.sin(f), cf = Math.cos(f), d = [st * cf, ct, st * sf], e1 = [ct * cf, -st, ct * sf], e2 = [-sf, 0, cf];
        const pa = pos(d[0] + e1[0] * e, d[1] + e1[1] * e, d[2] + e1[2] * e), pb = pos(d[0] - e1[0] * e, d[1] - e1[1] * e, d[2] - e1[2] * e), pc = pos(d[0] + e2[0] * e, d[1] + e2[1] * e, d[2] + e2[2] * e), pd = pos(d[0] - e2[0] * e, d[1] - e2[1] * e, d[2] - e2[2] * e), p = pos(d[0], d[1], d[2]);
        const u = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]], v = [pc[0] - pd[0], pc[1] - pd[1], pc[2] - pd[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const nl = Math.hypot(n[0], n[1], n[2]);
        n = nl < 1e-9 ? [d[0], d[1], d[2]] : [n[0] / nl, n[1] / nl, n[2] / nl];
        if (n[0] * p[0] + n[1] * (p[1] - .45) + n[2] * p[2] < 0) n = [-n[0], -n[1], -n[2]];
        P.push(p[0], p[1], p[2]);
        Nm.push(n[0], n[1], n[2]);
        T_coords.push(i / NU, j / NV);
        const x = p[0], y = p[1], z = p[2], nn = .5 + .5 * n3(x * 3, y * 3, z * 3), bd = .5 + .5 * Math.sin(y * 16 + n3(x * 2, y * 2, z * 2) * 3);
        const q = .44 + .12 * nn + .07 * bd;
        C.push(q, q * .95, q * .9);
      }
    }
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(Nm, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(C, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(T_coords, 2));
    g.setIndex(I);
    return g;
  }
  const grassG = (() => {
    const g = GA();
    [[1.15, .95, 0, 0, 0], [.7, .55, .2, .15, .5]].forEach(([w, h, ox, oz, ro]) => {
      for (let k = 0; k < 3; k++) {
        const a = ro + k * 1.047, c = Math.cos(a) * w / 2, s = Math.sin(a) * w / 2;
        gaQ(g, [[ox - c, 0, oz - s], [ox + c, 0, oz + s], [ox + c, h, oz + s], [ox - c, h, oz - s]], [0, 1, 0], [.32, .68, .22]);
      }
    });
    return gaGeo(g);
  })();
  const flowerG = (() => {
    const g = GA();
    for (let k = 0; k < 4; k++) {
      const a = k * 1.57, c = Math.cos(a) * .35, s = Math.sin(a) * .35;
      gaQ(g, [[-c, .3, -s], [c, .3, s], [c, .7, s], [-c, .7, -s]], [0, 1, 0], [.95, .35, .55]);
    }
    return gaGeo(g);
  })();

  function makeBuildingGeom(type) {
    const b = new T.Group();
    if (type === 'house') {
      const wall = new T.Mesh(new T.BoxGeometry(6, 6, 6).translate(0, 3, 0), new T.MeshStandardMaterial({ color: 0xd8ccb4, roughness: 0.85 }));
      const roof = new T.Mesh(new T.ConeGeometry(5.2, 3.2, 4).rotateY(Math.PI / 4).translate(0, 7.6, 0), new T.MeshStandardMaterial({ color: 0xb94a32, roughness: 0.7 }));
      b.add(wall, roof);
    } else if (type === 'block') {
      const block = new T.Mesh(new T.BoxGeometry(8, 12, 8).translate(0, 6, 0), new T.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.75 }));
      b.add(block);
    } else if (type === 'mid') {
      const mid = new T.Mesh(new T.BoxGeometry(9, 24, 9).translate(0, 12, 0), new T.MeshStandardMaterial({ color: 0x5b7a96, roughness: 0.5, metalness: 0.2 }));
      b.add(mid);
    } else {
      const tower = new T.Mesh(new T.BoxGeometry(6, 48, 6).translate(0, 24, 0), new T.MeshStandardMaterial({ color: 0x3d5a73, roughness: 0.4, metalness: 0.4 }));
      b.add(tower);
    }
    return b;
  }

  return { oakTree, birchTree, shrubTree, pineTree, palmTree, rockG, grassG, flowerG, makeBuildingGeom };
}

function buildLandscapeFromPayload(payload, targetScene, T) {
  if (!payload || !targetScene) return;

  // Cache last imported payload so that clicking Landscaping Studio allows re-customization seamlessly
  window._lastImportedLandscapePayload = payload;

  const oldGroup = targetScene.getObjectByName('ImportedLandscape');
  if (oldGroup) targetScene.remove(oldGroup);

  const group = new T.Group();
  group.name = 'ImportedLandscape';
  group.userData.isLandscape = true;
  group.userData.isCustomObject = true;

  // Initialize foliage builders
  const folBuilder = createProceduralLandscapeFoliage(T);

  // 0. RESTORE LIGHTING & SKY FROM PAYLOAD
  if (payload.lighting || payload.sky) {
    const eng = FE.engines?.core;
    if (eng) {
      if (payload.lighting?.sun && eng.d) {
        eng.d.color.set(payload.lighting.sun.color);
        eng.d.intensity = payload.lighting.sun.intensity;
        if (payload.lighting.sun.position) eng.d.position.fromArray(payload.lighting.sun.position);
      }
      if (payload.lighting?.hemi && eng.hemi) {
        eng.hemi.color.set(payload.lighting.hemi.skyColor);
        eng.hemi.groundColor.set(payload.lighting.hemi.groundColor);
        eng.hemi.intensity = payload.lighting.hemi.intensity;
      }
      if (payload.sky?.fogColor && eng.sc && eng.sc.fog) {
        eng.sc.fog.color.set(payload.sky.fogColor);
        if (typeof payload.sky.fog === 'number') eng.sc.fog.density = payload.sky.fog;
      }
    }
  }

  // Restore point lights if exported
  if (payload.pointLights && Array.isArray(payload.pointLights)) {
    payload.pointLights.forEach(pl => {
      const pLight = new T.PointLight(pl.color, pl.intensity, pl.distance || 18);
      if (pl.position) pLight.position.fromArray(pl.position);
      group.add(pLight);
    });
  }

  // 1. BASE TERRAIN MESH (Ground geometry with exact heightmap & material)
  if (payload.terrain && payload.terrain.heights) {
    try {
      let heights;
      if (typeof payload.terrain.heights === 'string') {
        const bstr = atob(payload.terrain.heights);
        const buf = new ArrayBuffer(bstr.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < bstr.length; i++) view[i] = bstr.charCodeAt(i);
        heights = new Float32Array(buf);
      } else if (Array.isArray(payload.terrain.heights) || payload.terrain.heights instanceof Float32Array) {
        heights = new Float32Array(payload.terrain.heights);
      }

      let materials = null;
      if (payload.terrain.materials && typeof payload.terrain.materials === 'string') {
        const mb = atob(payload.terrain.materials);
        const mbuf = new ArrayBuffer(mb.length);
        const mview = new Uint8Array(mbuf);
        for (let i = 0; i < mb.length; i++) mview[i] = mb.charCodeAt(i);
        materials = new Uint8Array(mbuf);
      }

      const S = payload.terrain.size || 100;
      const N = payload.terrain.segments || 128;
      const W = N + 1;
      const terGeom = new T.PlaneGeometry(S, S, N, N).rotateX(-Math.PI / 2);
      const posAttr = terGeom.attributes.position;
      const colors = new Float32Array(W * W * 3);

      const pal = (payload.terrain.palette && payload.terrain.palette.length >= 4)
        ? payload.terrain.palette
        : [[0.28, 0.5, 0.16], [0.42, 0.29, 0.17], [0.42, 0.42, 0.44], [0.64, 0.56, 0.38], [0.92, 0.94, 0.98]];

      for (let j = 0; j < W; j++) {
        for (let i = 0; i < W; i++) {
          const idx = j * W + i;
          const h = (heights && heights[idx] !== undefined) ? heights[idx] : 0;
          posAttr.setY(idx, h);

          let r = 0.3, g = 0.55, b = 0.2;
          if (materials && materials[idx] !== 255 && pal[materials[idx]]) {
            const c = pal[materials[idx]];
            r = c[0]; g = c[1]; b = c[2];
          } else {
            const v = Math.min(1.0, Math.max(0.45, 0.78 + (h / 28)));
            if (h > 15) {
              r = 0.75 * v; g = 0.75 * v; b = 0.78 * v;
            } else if (h < 1.2) {
              r = 0.65 * v; g = 0.58 * v; b = 0.40 * v;
            } else {
              r = 0.28 * v; g = 0.52 * v; b = 0.20 * v;
            }
          }
          colors[idx * 3] = r;
          colors[idx * 3 + 1] = g;
          colors[idx * 3 + 2] = b;
        }
      }

      terGeom.setAttribute('color', new T.BufferAttribute(colors, 3));
      terGeom.computeVertexNormals();
      const finalTerGeom = terGeom.toNonIndexed();

      const terrainTex = createProceduralTerrainTexturesHost(T);
      const terMat = new T.MeshStandardMaterial({
        color: new T.Color(0xffffff),
        map: terrainTex.map,
        bumpMap: terrainTex.bump,
        bumpScale: 0.08,
        vertexColors: true,
        roughness: payload.terrain.roughness || 0.88,
        metalness: 0.02,
        side: T.DoubleSide
      });

      const terMesh = new T.Mesh(finalTerGeom, terMat);
      terMesh.name = 'Terrain Mesh';
      terMesh.userData.isLandscape = true;
      terMesh.castShadow = terMesh.receiveShadow = true;
      terMesh.frustumCulled = false;
      terMesh.visible = true;
      group.add(terMesh);
    } catch (e) {
      console.warn('Failed to build terrain from payload:', e);
    }
  }

  // 2. WATER PLANE MESH (Physical realistic water with procedural ripples)
  if (payload.water && payload.water.visible !== false) {
    const waterGeom = new T.PlaneGeometry(260, 260, 64, 64).rotateX(-Math.PI / 2).toNonIndexed();
    const waterRipple = createProceduralNoiseTextureHost(T, 'water');
    const waterMat = new T.MeshPhysicalMaterial({
      color: new T.Color(0x06657a),
      roughness: 0.065,
      metalness: 0.02,
      transmission: 0.90,
      ior: 1.333,
      bumpMap: waterRipple,
      bumpScale: 0.06,
      transparent: true,
      opacity: 0.88,
      side: T.DoubleSide
    });
    const waterMesh = new T.Mesh(waterGeom, waterMat);
    waterMesh.name = 'Water Surface';
    waterMesh.userData.isLandscape = true;
    const waterLevel = typeof payload.water.level === 'number' ? payload.water.level : 0;
    waterMesh.position.y = Math.max(0.08, waterLevel);
    waterMesh.frustumCulled = false;
    waterMesh.visible = true;
    group.add(waterMesh);
  }

  // 3. ALL PROCEDURAL REALISTIC FOLIAGE & ROCKS & BUILDINGS WITH EXACT MATERIALS
  if (payload.foliage) {
    try {
      const kinds = payload.foliage.kinds;
      if (kinds) {
        for (const k in kinds) {
          const item = kinds[k];
          if (!item || !item.data || item.count <= 0) continue;
          const bstr = atob(item.data);
          const buf = new ArrayBuffer(bstr.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < bstr.length; i++) view[i] = bstr.charCodeAt(i);
          const floats = new Float32Array(buf);
          const count = item.count;

          let geomList = [];
          const isRock = (k === 'rock');
          const isBuilding = (k === 'house' || k === 'block' || k === 'mid' || k === 'tower');

          if (k === 'pine') {
            const [wG, lG] = folBuilder.pineTree();
            geomList.push({ geom: wG, col: 0x523a2e, rough: 0.9, bump: 'bark' }, { geom: lG, col: 0x14401e, rough: 0.7, bump: 'needle' });
          } else if (k === 'oak') {
            const [wG, lG] = folBuilder.oakTree();
            geomList.push({ geom: wG, col: 0x46372c, rough: 0.9, bump: 'bark' }, { geom: lG, col: 0x1e682e, rough: 0.72, bump: 'leaf' });
          } else if (k === 'birch') {
            const [wG, lG] = folBuilder.birchTree();
            geomList.push({ geom: wG, col: 0xe0ddd4, rough: 0.85, bump: 'bark' }, { geom: lG, col: 0x529e34, rough: 0.72, bump: 'leaf' });
          } else if (k === 'palm') {
            const [wG, lG] = folBuilder.palmTree();
            geomList.push({ geom: wG, col: 0x847056, rough: 0.9, bump: 'bark' }, { geom: lG, col: 0x2d7a36, rough: 0.7, bump: 'leaf' });
          } else if (k === 'shrub') {
            const [wG, lG] = folBuilder.shrubTree();
            geomList.push({ geom: wG, col: 0x46372c, rough: 0.9, bump: 'bark' }, { geom: lG, col: 0x1b5e20, rough: 0.75, bump: 'leaf' });
          } else if (k === 'rock') {
            geomList.push({ geom: folBuilder.rockG(), col: 0x788596, rough: 0.92, bump: 'rock' });
          } else if (k === 'grass') {
            geomList.push({ geom: folBuilder.grassG, col: 0x388e3c, rough: 0.8, bump: 'leaf' });
          } else if (k === 'flower') {
            geomList.push({ geom: folBuilder.flowerG, col: 0xf43f5e, rough: 0.7 });
          } else if (isBuilding) {
            const baseSize = item.size || 1;
            for (let i = 0; i < count; i++) {
              const off = i * 7;
              const bMesh = folBuilder.makeBuildingGeom(k);
              bMesh.name = k + '_' + (i + 1);
              bMesh.position.set(floats[off], floats[off + 1], floats[off + 2]);
              bMesh.rotation.set(0, floats[off + 4] || 0, 0);
              const s = (floats[off + 3] || 1) * baseSize;
              bMesh.scale.set(s, s, s);
              bMesh.userData.isLandscape = true;
              group.add(bMesh);
            }
            continue;
          }

          geomList.forEach((entry, gIdx) => {
            const bumpTex = entry.bump ? createProceduralNoiseTextureHost(T, entry.bump) : null;
            const mat = new T.MeshStandardMaterial({
              color: new T.Color(entry.col),
              roughness: entry.rough || 0.8,
              metalness: isRock ? 0.04 : 0.01,
              bumpMap: bumpTex,
              bumpScale: bumpTex ? (isRock ? 0.15 : 0.08) : 0,
              side: T.DoubleSide
            });
            const instMesh = new T.InstancedMesh(entry.geom, mat, count);
            instMesh.name = k + '_foliage_' + gIdx;
            instMesh.userData.isLandscape = true;
            instMesh.frustumCulled = false;
            instMesh.castShadow = true;
            instMesh.receiveShadow = true;

            const dummy = new T.Object3D();
            const baseSize = item.size || 1;
            for (let i = 0; i < count; i++) {
              const off = i * 7;
              const x = floats[off];
              const y = floats[off + 1];
              const z = floats[off + 2];
              const s = (floats[off + 3] || 1) * baseSize;
              const r = floats[off + 4] || 0;
              const a = floats[off + 5] || 1;
              dummy.position.set(x, y - (isRock ? 0.12 * s : 0), z);
              dummy.rotation.set(0, r, 0);
              dummy.scale.set(s * a, s, s * a);
              dummy.updateMatrix();
              instMesh.setMatrixAt(i, dummy.matrix);
            }
            instMesh.instanceMatrix.needsUpdate = true;
            group.add(instMesh);
          });
        }
      }
    } catch (e) {
      console.warn('Failed to rebuild foliage from payload:', e);
    }
  }

  // 4. Placed Objects
  if (payload.objects && Array.isArray(payload.objects)) {
    payload.objects.forEach(o => {
      const g = new T.BoxGeometry(1.5, 1.5, 1.5);
      const m = new T.MeshStandardMaterial({ color: 0x818cf8, side: T.DoubleSide });
      const mesh = new T.Mesh(g, m);
      mesh.name = o.name || 'Object';
      if (o.position) mesh.position.fromArray(o.position);
      if (o.quaternion) mesh.quaternion.fromArray(o.quaternion);
      if (o.scale) mesh.scale.fromArray(o.scale);
      mesh.userData.isLandscape = true;
      group.add(mesh);
    });
  }

  targetScene.add(group);

  const eng = FE.engines?.core;
  if (eng) {
    if (!eng.customObjects) eng.customObjects = {};
    eng.customObjects['ImportedLandscape'] = group;
    eng.customObjects['landscape'] = group;
    eng.customObjects['landscape_scene'] = group;

    const chipContainer = document.querySelector('.object-chips');
    if (chipContainer) {
      let chipLandscape = document.getElementById('chip-landscape');
      if (!chipLandscape) {
        chipLandscape = document.createElement('button');
        chipLandscape.className = 'chip';
        chipLandscape.id = 'chip-landscape';
        chipLandscape.textContent = 'Landscape';
        chipLandscape.onclick = () => selectObject('landscape', 'chip');
        chipContainer.appendChild(chipLandscape);
      }
    }

    selectObject('landscape', 'import');

    if (eng.cube) eng.cube.visible = false;
    if (eng.studioFloor) eng.studioFloor.visible = false;
    if (eng.viewportCamera && eng.oc) {
      eng.viewportCamera.position.set(55, 45, 65);
      eng.oc.target.set(0, 4, 0);
      eng.viewportCamera.lookAt(0, 4, 0);
      eng.oc.update();
    }
  }
}
