import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ifft2D, TessendorfOcean } from '../src/tessendorf-ocean.mjs';
import { appPath } from './app-paths.mjs';

const rms = a => Math.sqrt(a.reduce((s, x, i) => s + (i % 4 === 0 ? x * x : 0), 0) / (a.length / 4));

test('inverse 2D FFT reconstructs a constant field and rejects unsupported sizes', () => {
  const n = 8, r = new Float64Array(n * n), im = new Float64Array(n * n); r[0] = n * n;
  ifft2D(r, im, n);
  assert.ok([...r].every(x => Math.abs(x - 1) < 1e-10));
  assert.ok([...im].every(x => Math.abs(x) < 1e-10));
  assert.throws(() => ifft2D(new Float64Array(9), new Float64Array(9), 3), /power of two/);
});

test('Tessendorf Phillips-spectrum cascades are deterministic, finite, and evolve without a short loop', () => {
  const options = { resolution: 32, lengths: [128, 512, 2048], windSpeed: 13, windDirection: 32, seed: 91 };
  const a = new TessendorfOcean(options), b = new TessendorfOcean(options), a0 = a.update(0).map(f=>({...f,data:f.data.slice()})), b0 = b.update(0).map(f=>({...f,data:f.data.slice()}));
  assert.equal(a0.length, 3);
  for (let c = 0; c < 3; c++) {
    assert.equal(a0[c].length, options.lengths[c]);
    assert.deepEqual(a0[c].data, b0[c].data);
    assert.ok([...a0[c].data].every(Number.isFinite));
    assert.ok(rms(a0[c].data) > .02, 'each spectrum cascade should contribute visible height');
  }
  const later = a.update(17.3);
  assert.ok(a0.some((field, c) => field.data.some((x, i) => Math.abs(x - later[c].data[i]) > 1e-4)), 'spectral phase should evolve continuously with gravity dispersion');
});

test('spectral amplitudes honor gain and wind changes regenerate the Phillips spectrum', () => {
  const ocean = new TessendorfOcean({ resolution: 16, lengths: [64, 256, 1024], windSpeed: 8, seed: 3 });
  const base = ocean.update(2).map(f=>({...f,data:f.data.slice()})), doubled = ocean.update(2, { amplitude: 2 });
  assert.ok(Math.abs(rms(doubled[0].data) / rms(base[0].data) - 2) < .03);
  const before = base[0].data;
  assert.equal(ocean.configure({ windSpeed: 20 }), true);
  const after = ocean.update(2)[0].data;
  assert.ok(before.some((x, i) => Math.abs(x - after[i]) > 1e-5));
});

test('terrain water wires all three inverse-FFT cascades into vertex displacement', () => {
  const html = readFileSync(appPath('Terrain_system_.html'), 'utf8');
  assert.ok(html.includes('TessendorfOceanBundle.TessendorfOcean'));
  for (const name of ['uFFT0','uFFT1','uFFT2']) assert.ok(html.includes(name));
  assert.ok(html.includes('updateTessendorfOcean'));
  assert.ok(html.includes('Phillips wind spectrum, gravity dispersion')&&html.includes('CPU inverse 2D FFTs feed GPU vertex displacement'));
  assert.ok(!html.includes('for(int i=0;i<8;i++){if(i>=N)break;float fi=float(i)'),'legacy multi-sine wave stack must not be mislabeled as the FFT solver');
});
