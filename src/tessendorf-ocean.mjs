const TAU = Math.PI * 2;
const GRAVITY = 9.81;
const CASCADE_WEIGHTS = [0.58, 0.30, 0.16];

function assertResolution(n) {
  if (!Number.isInteger(n) || n < 8 || (n & (n - 1)) !== 0) throw new RangeError('FFT resolution must be a power of two >= 8');
}

function fft1D(re, im, n, offset, stride, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride, b = offset + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 1 : -1) * TAU / len, half = len >> 1;
    for (let base = 0; base < n; base += len) {
      for (let j = 0; j < half; j++) {
        const wr = Math.cos(angle * j), wi = Math.sin(angle * j);
        const a = offset + (base + j) * stride, b = offset + (base + j + half) * stride;
        const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { const k = offset + i * stride; re[k] /= n; im[k] /= n; }
}

export function ifft2D(real, imag, n) {
  assertResolution(n);
  if (real.length !== n * n || imag.length !== n * n) throw new RangeError('FFT arrays must be resolution squared');
  for (let y = 0; y < n; y++) fft1D(real, imag, n, y * n, 1, true);
  for (let x = 0; x < n; x++) fft1D(real, imag, n, x, n, true);
  return { real, imag };
}

function makeRng(seed) {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

function makeCascade(n, length, windSpeed, windDirection, seed) {
  const count = n * n, rng = makeRng(seed), h0r = new Float64Array(count), h0i = new Float64Array(count), omega = new Float64Array(count), opposite = new Uint32Array(count);
  const dk = TAU / length, windX = Math.cos(windDirection), windZ = Math.sin(windDirection);
  const windLength = Math.max(1, windSpeed * windSpeed / GRAVITY), shortWave = windLength * 0.0016, amplitude = 2.8e-3 * Math.max(.08, windSpeed / 12);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const i = z * n + x, mx = (x <= n / 2 ? x : x - n), mz = (z <= n / 2 ? z : z - n), kx = mx * dk, kz = mz * dk, k2 = kx * kx + kz * kz, k = Math.sqrt(k2);
    opposite[i] = ((n - z) % n) * n + ((n - x) % n);
    if (k < 1e-8) continue;
    const align = (kx * windX + kz * windZ) / k, directional = align >= 0 ? align * align : align * align * .07;
    const spectrum = amplitude * Math.exp(-1 / Math.max(k2 * windLength * windLength, 1e-10)) / (k2 * k2) * directional * Math.exp(-k2 * shortWave * shortWave) * dk * dk;
    const scale = Math.sqrt(Math.max(0, spectrum) * .5);
    h0r[i] = gaussian(rng) * scale; h0i[i] = gaussian(rng) * scale;
    omega[i] = Math.sqrt(GRAVITY * k);
  }
  return { n, length, h0r, h0i, omega, opposite };
}

export class TessendorfOcean {
  constructor({ resolution = 128, lengths = [256, 1024, 4096], windSpeed = 14, windDirection = 0, seed = 7 } = {}) {
    assertResolution(resolution);
    this.resolution = resolution;
    this.lengths = lengths.slice();
    this.windSpeed = Math.max(0, windSpeed);
    this.windDirection = windDirection * Math.PI / 180;
    this.seed = seed >>> 0;
    this._build();
  }
  _build() {
    const n=this.resolution,count=n*n;
    this.cascades = this.lengths.map((length, i) => { const c=makeCascade(n,length,this.windSpeed,this.windDirection,this.seed+Math.imul(i+1,0x9e3779b1));c.hr=new Float64Array(count);c.hi=new Float64Array(count);c.xr=new Float64Array(count);c.xi=new Float64Array(count);c.zr=new Float64Array(count);c.zi=new Float64Array(count);c.data=new Float32Array(count*4);return c; });
  }
  configure({ resolution, lengths, windSpeed, windDirection, seed } = {}) {
    let dirty = false;
    if (resolution !== undefined && resolution !== this.resolution) { assertResolution(resolution); this.resolution = resolution; dirty = true; }
    if (lengths && lengths.some((x, i) => x !== this.lengths[i])) { this.lengths = lengths.slice(); dirty = true; }
    if (windSpeed !== undefined && Math.abs(windSpeed - this.windSpeed) >= .75) { this.windSpeed = Math.max(0, windSpeed); dirty = true; }
    if (windDirection !== undefined) { const a = windDirection * Math.PI / 180, d = Math.atan2(Math.sin(a - this.windDirection), Math.cos(a - this.windDirection)); if (Math.abs(d) > 3 * Math.PI / 180) { this.windDirection = a; dirty = true; } }
    if (seed !== undefined && seed !== this.seed) { this.seed = seed >>> 0; dirty = true; }
    if (dirty) this._build();
    return dirty;
  }
  update(time, { amplitude = 1, choppiness = 1 } = {}) {
    const n = this.resolution, count = n * n;
    return this.cascades.map((c, ci) => {
      const {hr,hi,xr,xi,zr,zi,data}=c;hr.fill(0);hi.fill(0);xr.fill(0);xi.fill(0);zr.fill(0);zi.fill(0);
      for (let i = 0; i < count; i++) {
        const j = c.opposite[i], phase = c.omega[i] * time, cs = Math.cos(phase), sn = Math.sin(phase);
        const ar = c.h0r[i] * cs - c.h0i[i] * sn, ai = c.h0r[i] * sn + c.h0i[i] * cs;
        const br = c.h0r[j] * cs - c.h0i[j] * sn, bi = -c.h0r[j] * sn - c.h0i[j] * cs;
        hr[i] = ar + br; hi[i] = ai + bi;
        const kxIndex = i % n, kzIndex = (i / n) | 0, mx = kxIndex <= n / 2 ? kxIndex : kxIndex - n, mz = kzIndex <= n / 2 ? kzIndex : kzIndex - n;
        const kx = mx * TAU / c.length, kz = mz * TAU / c.length, k = Math.hypot(kx, kz);
        if (k > 1e-8) { const sx = kx / k, sz = kz / k; xr[i] = hi[i] * sx * choppiness; xi[i] = -hr[i] * sx * choppiness; zr[i] = hi[i] * sz * choppiness; zi[i] = -hr[i] * sz * choppiness; }
      }
      ifft2D(hr, hi, n); ifft2D(xr, xi, n); ifft2D(zr, zi, n);
      let mean = 0; for (let i = 0; i < count; i++) mean += hr[i]; mean /= count;
      let variance = 0; for (let i = 0; i < count; i++) { const d = hr[i] - mean; variance += d * d; }
      const rms = Math.sqrt(variance / count), weight = CASCADE_WEIGHTS[ci] ?? .1, target = (.12 + this.windSpeed * .043) * weight * Math.max(0, amplitude), scale = rms > 1e-12 ? target / rms : 0;
      for (let i = 0; i < count; i++) { const o = i * 4; data[o] = (hr[i] - mean) * scale; data[o + 1] = xr[i] * scale; data[o + 2] = zr[i] * scale; data[o + 3] = 1; }
      return { length: c.length, resolution: n, data };
    });
  }
}
