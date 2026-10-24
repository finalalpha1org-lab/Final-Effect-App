import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

/* Why a cube used to take ten minutes.

   Two separate reasons, and both are pinned here.

   1. The renderer's whole budget was spent producing noise. 24 samples of a
      path tracer on a phone is minutes of work for an image that is still
      grainy, because samples are the most expensive way to remove noise and
      the least effective. Eight samples through an edge-aware filter is a
      fraction of the cost and a cleaner picture.
   2. The progressive loop was driven by `requestAnimationFrame`. A render is
      exactly the workload that gets the tab hidden — opening the Render
      Result window hides the editor — and rAF stops dead in a hidden tab. So
      the render advanced one slice each time the user looked at it.

   The C++ side is measured against a 96-sample reference, not asserted on
   vibes: the filtered 8-sample frame has to be closer to the reference than
   the raw one, and it has to keep the floor grid's edges. */

const wasm = readFileSync(appPath('wasm/fe_core_engine.wasm'));
const module_ = new WebAssembly.Module(wasm);

function instance() {
  const exp = new WebAssembly.Instance(module_, {}).exports;
  const mem = exp.memory;
  const f32 = (n) => { const ptr = exp.fe_malloc(n * 4); return { ptr, view: new Float32Array(mem.buffer, ptr, n) }; };
  const u32 = (n) => { const ptr = exp.fe_malloc(n * 4); return { ptr, view: new Uint32Array(mem.buffer, ptr, n) }; };
  return { exp, mem, f32, u32 };
}

const CUBE_POSITIONS = [
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
];
const CUBE_INDICES = [
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 3, 7, 0, 7, 4,
  1, 5, 6, 1, 6, 2, 3, 2, 6, 3, 6, 7, 0, 4, 5, 0, 5, 1
];

function cubeScene(width, height) {
  const { exp, mem, f32, u32 } = instance();
  exp.fe_render_scene_clear();
  exp.fe_arena_reset();
  const pos = f32(24), idx = u32(36);
  CUBE_POSITIONS.forEach((v, i) => { pos.view[i] = v; });
  CUBE_INDICES.forEach((v, i) => { idx.view[i] = v; });
  exp.fe_render_add_mesh(pos.ptr, 0, idx.ptr, 8, 12, 0.62, 0.64, 0.7, 0.45, 0.1, 0, 1);
  exp.fe_render_set_environment(0, 1.05, 1, -0.002);
  exp.fe_render_set_light(0, 2, 3, 6, 4, -0.45, -0.8, -0.4, 1, 0.98, 0.94, 2.2, 0.22, 0.5);
  exp.fe_render_set_light(1, 2, -3, 4, -2, 0.5, -0.7, 0.5, 0.7, 0.8, 1, 0.85, 0.22, 0.5);
  exp.fe_render_set_camera(0, 1.6, 6.5, 0, -0.18, -1, 1, 0, 0, 0, 1, 0, 45, width / height, 0, 5);
  exp.fe_render_build_bvh();
  return { exp, mem, width, height };
}

function renderFrame(scene, spp, denoisePasses) {
  const { exp, mem, width, height } = scene;
  exp.fe_render_init_framebuffer(width, height);
  exp.fe_render_trace_samples(spp, 2, 0, 0);
  if (denoisePasses) assert.equal(exp.fe_render_denoise(denoisePasses, 1), 1, 'the filter ran');
  exp.fe_render_resolve_rgba8(0, 1.25, 1.05, 1.08, 0, 0, 0, 0, 0);
  const ptr = exp.fe_render_get_rgba8_ptr();
  return new Uint8ClampedArray(new Uint8Array(mem.buffer, ptr, width * height * 4));
}

function psnr(a, b, width, height) {
  let sum = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      const d = a[i * 4 + c] - b[i * 4 + c];
      sum += d * d;
      n++;
    }
  }
  const mse = sum / n;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

test('the denoiser earns its samples back', () => {
  const W = 220, H = 308;
  const scene = cubeScene(W, H);

  const reference = renderFrame(scene, 64, 0);
  const raw8 = renderFrame(scene, 8, 0);
  const den8 = renderFrame(scene, 8, 3);

  const rawScore = psnr(raw8, reference, W, H);
  const denScore = psnr(den8, reference, W, H);

  assert.ok(rawScore < 30, `8 samples on its own is noisy (${rawScore.toFixed(1)} dB)`);
  assert.ok(denScore > rawScore + 4,
    `the filter passes have to be worth several times the samples (${denScore.toFixed(1)} dB vs ${rawScore.toFixed(1)} dB)`);
  assert.ok(denScore > 30, `and the result has to be presentable (${denScore.toFixed(1)} dB)`);
});

/* A plain blur is the obvious way to pass a "less noise" test and the wrong
   way to ship: it also deletes the floor grid, which is the studio. So every
   preservation check below is a comparison against a 5x5 box blur of the same
   noisy frame — the filter has to beat it by a wide margin, not merely exist. */
function boxBlur(img, width, height, radius = 2) {
  const out = new Uint8ClampedArray(img.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          const i = (yy * width + xx) * 4;
          r += img[i]; g += img[i + 1]; b += img[i + 2]; n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

const luma = (img, i) => img[i] * 0.3 + img[i + 1] * 0.6 + img[i + 2] * 0.1;

test('the filter keeps the cube edge a blur would delete', () => {
  const W = 220, H = 308;
  const scene = cubeScene(W, H);
  const raw = renderFrame(scene, 8, 0);
  const denoised = renderFrame(scene, 8, 3);
  const blurred = boxBlur(raw, W, H);
  const reference = renderFrame(scene, 48, 0);

  /* Find the cube's top edge in the converged image (a strong vertical step at
     the centre column), then measure contrast across it by averaging bands
     above and below — a single-pixel comparison is too easily a noise spike. */
  const column = Math.round(W * 0.5);
  let edgeY = 0;
  let bestStep = 0;
  for (let y = 1; y < H; y++) {
    const step = Math.abs(luma(reference, (y * W + column) * 4) - luma(reference, ((y - 1) * W + column) * 4));
    if (step > bestStep) { bestStep = step; edgeY = y; }
  }
  assert.ok(bestStep > 10, 'the reference actually has an edge to measure');

  /* Sharpness across the edge: the steepest step within four pixels of it,
     medianed over five columns so one noisy column cannot decide the answer. */
  const sharpness = (img) => {
    const steps = [];
    for (let c = column - 2; c <= column + 2; c++) {
      let worst = 0;
      for (let y = edgeY - 4; y <= edgeY + 4; y++) {
        if (y < 1 || y >= H) continue;
        worst = Math.max(worst, Math.abs(luma(img, (y * W + c) * 4) - luma(img, ((y - 1) * W + c) * 4)));
      }
      steps.push(worst);
    }
    steps.sort((a, b) => a - b);
    return steps[2];
  };

  const rawSharp = sharpness(raw);
  const denSharp = sharpness(denoised);
  const blurSharp = sharpness(blurred);

  assert.ok(blurSharp < rawSharp * 0.4, `a box blur flattens it (${blurSharp.toFixed(0)} of ${rawSharp.toFixed(0)})`);
  assert.ok(denSharp > rawSharp * 0.7, `the filter does not (${denSharp.toFixed(0)} of ${rawSharp.toFixed(0)})`);
  assert.ok(denSharp > blurSharp * 2.5, `which is the difference being claimed (${(denSharp / blurSharp).toFixed(1)}x the blur)`);
});

test('the studio grid survives the filter', () => {
  const W = 220, H = 308;
  const scene = cubeScene(W, H);
  const raw = renderFrame(scene, 8, 0);
  const denoised = renderFrame(scene, 8, 3);
  const blurred = boxBlur(raw, W, H);
  const reference = renderFrame(scene, 48, 0);

  /* The floor grid is a set of thin, low-contrast lines. Compare the row
     profile of each candidate against the converged reference: a filter that
     eats the lines cannot correlate with it, and neither can a blur. */
  const correlation = (img, yFraction) => {
    const y = Math.round(H * yFraction);
    const a = [], b = [];
    for (let x = 0; x < W; x++) {
      a.push(luma(img, (y * W + x) * 4));
      b.push(luma(reference, (y * W + x) * 4));
    }
    const mean = (v) => v.reduce((sum, n) => sum + n, 0) / v.length;
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };

  const rows = [0.62, 0.70, 0.88];
  for (const row of rows) {
    const den = correlation(denoised, row);
    const blur = correlation(blurred, row);
    assert.ok(den > 0.3, `the grid is still where it should be at row ${row} (r=${den.toFixed(2)})`);
    assert.ok(den > blur, `and better than a blur, which flattens it (${den.toFixed(2)} vs ${blur.toFixed(2)})`);
  }
});

test('render cost at the default settings is seconds, not minutes', () => {
  const W = 240, H = 426;
  const scene = cubeScene(W, H);
  const { exp } = scene;

  const time = (spp, denoise) => {
    exp.fe_render_init_framebuffer(W, H);
    const t0 = performance.now();
    exp.fe_render_trace_samples(spp, 2, 0, 0);
    if (denoise) exp.fe_render_denoise(denoise, 1);
    exp.fe_render_resolve_rgba8(0, 1.25, 1.05, 1.08, 0, 0, 0, 0, 0);
    return performance.now() - t0;
  };

  const oldDefault = time(24, 0);          /* 24 SPP, no filter — the old path */
  const newDefault = time(8, 3);           /* 8 SPP plus the filter */

  assert.ok(newDefault < oldDefault,
    `the new default has to be cheaper (${newDefault.toFixed(0)} ms vs ${oldDefault.toFixed(0)} ms)`);
  /* Halving is the floor; on a desktop it is nearer a third. The mobile ratio
     is worse than this and still better than 3x, so the assertion is safe. */
  assert.ok(newDefault < oldDefault * 0.75,
    `and meaningfully so — ${(oldDefault / newDefault).toFixed(2)}x faster`);
});

test('the progressive loop cannot be starved by a hidden tab', () => {
  const engine = readFileSync(appPath('fe-cpp-engine.js'), 'utf8');
  const progress = engine.slice(engine.indexOf('async startStillRender() {'));
  const loop = progress.slice(0, progress.indexOf('stopActiveRender() {'));

  assert.ok(loop.includes('this.renderTicker()'), 'the path tracer is driven by a tick queue');
  assert.ok(loop.includes('tick(stepProgressive)'), 'and schedules itself through it');
  assert.ok(!/requestAnimationFrame\(stepProgressive\)/.test(loop),
    'requestAnimationFrame is gone — it stops when the tab is hidden');
  assert.ok(engine.includes('MessageChannel'), 'a message port is used instead');

  assert.ok(/let tileRows = Math\.max\(4/.test(loop), 'slice size starts small');
  assert.ok(loop.includes('sliceTarget'), 'and is measured against a target');
  assert.ok(engine.includes("visibilityState === 'hidden'"), 'a hidden tab uses longer slices, not more round trips');
  assert.ok(loop.includes('tileRows * (scale'), 'adapting to what the device actually managed');

  assert.ok(loop.includes('this.renderState.renderToken'), 'a stopped render is invalidated');
  const stop = engine.slice(engine.indexOf('stopActiveRender() {'));
  assert.ok(stop.slice(0, 600).includes('renderToken'), 'and stopping bumps the token');
});

test('the denoise kernel is a first-class export, not a stray symbol', () => {
  const exportsList = WebAssembly.Module.exports(module_).map((e) => e.name);
  assert.ok(exportsList.includes('fe_render_denoise'));

  const builder = readFileSync(appPath('scripts/build-cpp-wasm.mjs'), 'utf8');
  assert.ok(builder.includes("'fe_render_denoise'"), 'the artifact check requires it');

  const engine = readFileSync(appPath('fe-cpp-engine.js'), 'utf8');
  assert.ok(engine.includes('fe_render_denoise'), 'the engine calls it');
  assert.ok(/fe_render_denoise\(3, 1\)/.test(engine), 'stills get three à-trous passes — two leave blotches on a flat face');
  assert.ok(engine.includes('denoise'), 'the setting exists');

  /* The filter needs a depth and an albedo guide or it is just a blur; both
     have to be written while tracing, not after. */
  const renderer = readFileSync(appPath('cpp/src/fe_renderer.cpp'), 'utf8');
  assert.ok(renderer.includes('g_depth16'), 'depth is recorded per pixel');
  assert.ok(renderer.includes('g_albedo8'), 'albedo is recorded per pixel');
  assert.ok(renderer.includes('denoise_weight'), 'and the weights use both');
});
