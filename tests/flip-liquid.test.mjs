/* ============================================================================
   FLIP liquid solver - contract tests for cpp/src/fe_flip.cpp.

   Three things are pinned, and they are the three that actually decide whether
   a liquid looks like liquid:

     1. mass.      A closed box of water may slosh, but not one particle may
                   leave it, and a pool at rest must stay a pool at rest.
     2. divergence. The projection has to take the divergence the particles
                   carried in and leave almost none behind - a frame that ends
                   with divergence in it is a frame that leaks volume.
     3. gravity.   A column with nothing under it falls at g and not at 2g;
                   the gravity term is applied on faces, once per face.
   ========================================================================= */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const wasmBytes = readFileSync(appPath('wasm/fe_core_engine.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);

function instantiate() {
  const inst = new WebAssembly.Instance(wasmModule, {});
  const exp = inst.exports;
  return {
    exp,
    f32(ptr, len) { return new Float32Array(exp.memory.buffer, ptr, len); },
    u8(ptr, len) { return new Uint8Array(exp.memory.buffer, ptr, len); }
  };
}

const DT = 1 / 60;
const GRAVITY = -9.81;

/* A lattice of particles filling a box, `spacing` apart. Returns flat arrays. */
function fill(x0, x1, y0, y1, z0, z1, spacing) {
  const points = [];
  for (let y = y0 + spacing * 0.5; y < y1; y += spacing) {
    for (let z = z0 + spacing * 0.5; z < z1; z += spacing) {
      for (let x = x0 + spacing * 0.5; x < x1; x += spacing) points.push(x, y, z);
    }
  }
  return new Float32Array(points);
}

/* Allocate the particle buffers inside the engine's own heap. */
function stage(core, positions, spacing) {
  const { exp } = core;
  const count = positions.length / 3;
  const particleRadius = spacing * 0.5;
  const pos = exp.fe_malloc(count * 12);
  const vel = exp.fe_malloc(count * 12);
  const active = exp.fe_malloc(count);
  const foam = exp.fe_malloc(count * 4);
  const metrics = exp.fe_malloc(32);
  core.f32(pos, count * 3).set(positions);
  core.f32(vel, count * 3).fill(0);
  core.u8(active, count).fill(1);
  core.f32(foam, count).fill(0);
  return { count, particleRadius, pos, vel, active, foam, metrics };
}

function step(core, grid, particles, overrides = {}) {
  const { exp } = core;
  const gx = overrides.gx ?? 0;
  const gy = overrides.gy ?? GRAVITY;
  const gz = overrides.gz ?? 0;
  return exp.fe_flip_step(
    particles.pos, particles.vel, particles.active, particles.foam,
    particles.count, overrides.dt ?? DT,
    gx, gy, gz,
    overrides.flipRatio ?? 0.95,
    overrides.viscosity ?? 0.002,
    overrides.vorticity ?? 0.12,
    overrides.surfaceTension ?? 0.0,
    overrides.restitution ?? 0.02,
    overrides.damping ?? 0.02,
    overrides.outflow ?? 0,
    particles.metrics
  );
}

function bounds(core, b) {
  const { exp } = core;
  const ptr = exp.fe_malloc(24);
  core.f32(ptr, 6).set(b);
  return ptr;
}

function readMetrics(core, metrics) {
  const m = core.f32(metrics, 8);
  return {
    h: m[0], liquidCells: m[1], maxCfl: m[2], divergenceBefore: m[3],
    divergenceAfter: m[4], kinetic: m[5], iterations: m[6], volume: m[7]
  };
}

test('FLIP grid reports the cells it actually allocated', () => {
  const core = instantiate();
  const { exp } = core;
  const ptr = bounds(core, [-1, 0, -0.5, 1, 2, 0.5]);
  assert.equal(exp.fe_flip_begin(24, ptr), 0);
  const nx = exp.fe_flip_grid_nx();
  const ny = exp.fe_flip_grid_ny();
  const nz = exp.fe_flip_grid_nz();
  const h = exp.fe_flip_cell_size();
  const cells = exp.fe_flip_cell_count();
  assert.equal(cells, nx * ny * nz, 'cell count is the product of the axis counts');
  assert.ok(Math.abs(h - 2 / 24) < 1e-6, 'the longest axis is cut into `resolution` cells');
  assert.equal(nx, 24, 'an axis as long as the longest takes the resolution');
  assert.equal(ny, 24, 'the tall axis takes the resolution');
  assert.equal(nz, 12, 'the short axis takes the same cell size');
});

test('a pool at rest stays at rest: no particle leaves and the surface holds', () => {
  const core = instantiate();
  const { exp } = core;
  const B = [-1, 0, -0.5, 1, 2, 0.5];
  exp.fe_flip_begin(24, bounds(core, B));
  const h = exp.fe_flip_cell_size();
  /* Four to six particles per cell is the density the solver is built for. */
  const spacing = h / 2.4;
  const start = fill(-0.95, 0.95, 0, 1.0, -0.45, 0.45, spacing);
  const p = stage(core, start, spacing);

  let surface = 0;
  for (let frame = 0; frame < 120; frame++) {
    assert.equal(step(core, B, p), 1, 'the step reports success');
    const pos = core.f32(p.pos, p.count * 3);
    let maxY = -1e9;
    for (let k = 0; k < p.count; k++) {
      const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
      assert.ok(Number.isFinite(x + y + z), `particle ${k} stayed finite at frame ${frame}`);
      assert.ok(x >= B[0] - 1e-4 && x <= B[3] + 1e-4, `particle ${k} stayed inside x at frame ${frame}`);
      assert.ok(y >= B[1] - 1e-4 && y <= B[4] + 1e-4, `particle ${k} stayed inside y at frame ${frame}`);
      assert.ok(z >= B[2] - 1e-4 && z <= B[5] + 1e-4, `particle ${k} stayed inside z at frame ${frame}`);
      if (y > maxY) maxY = y;
    }
    if (frame === 0) surface = maxY;
  }

  const pos = core.f32(p.pos, p.count * 3);
  let maxY = -1e9;
  for (let k = 0; k < p.count; k++) maxY = Math.max(maxY, pos[k * 3 + 1]);
  assert.ok(
    Math.abs(maxY - surface) < 0.05,
    `the surface must hold within 5 cm over two seconds (started ${surface.toFixed(3)}, ended ${maxY.toFixed(3)})`
  );
  const m = readMetrics(core, p.metrics);
  assert.ok(m.divergenceAfter < 0.01, `a resting pool must stay divergence free (${m.divergenceAfter})`);
});

test('a dam break stays incompressible and conserves its volume', () => {
  const core = instantiate();
  const { exp } = core;
  const B = [-1, 0, -0.5, 1, 2, 0.5];
  exp.fe_flip_begin(32, bounds(core, B));
  const h = exp.fe_flip_cell_size();
  const spacing = h / 2;
  const start = fill(-0.9, -0.1, 0, 1.5, -0.4, 0.4, spacing);
  const p = stage(core, start, spacing);

  let maxDivergenceBefore = 0;
  let maxDivergenceAfter = 0;
  for (let frame = 0; frame < 150; frame++) {
    assert.equal(step(core, B, p), 1);
    const m = readMetrics(core, p.metrics);
    if (m.divergenceBefore > maxDivergenceBefore) maxDivergenceBefore = m.divergenceBefore;
    if (m.divergenceAfter > maxDivergenceAfter) maxDivergenceAfter = m.divergenceAfter;
    assert.ok(m.iterations > 0, 'the pressure solve runs every frame the liquid moves');
    assert.ok(m.iterations <= 300, 'the solve never exceeds its iteration cap');
  }

  /* The projection has to remove the divergence the column carried in. */
  assert.ok(maxDivergenceBefore > 0.5, `the collapse must actually carry divergence (${maxDivergenceBefore})`);
  assert.ok(
    maxDivergenceAfter < maxDivergenceBefore * 0.02,
    `the projection must remove the divergence (before ${maxDivergenceBefore.toFixed(3)} after ${maxDivergenceAfter.toFixed(4)})`
  );

  /* Not one particle may be lost, and the pile must have spread sideways. */
  const pos = core.f32(p.pos, p.count * 3);
  let escaped = 0;
  let rightMost = -1e9;
  for (let k = 0; k < p.count; k++) {
    const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    if (y < B[1] - 1e-4 || y > B[4] + 1e-4 || x < B[0] - 1e-4 || x > B[3] + 1e-4 ||
        z < B[2] - 1e-4 || z > B[5] + 1e-4) escaped++;
    if (x > rightMost) rightMost = x;
  }
  assert.equal(escaped, 0, 'no particle leaves the box');
  assert.ok(rightMost > 0.3, `the column must collapse across the floor (reached ${rightMost.toFixed(2)})`);
});

test('gravity alone accelerates a free body at g, not at 2g', () => {
  /* The gravity term is applied on faces, once per face. Applying it per cell
     instead writes every interior face twice - once from each side - and the
     body falls at 2g. Ten frames of free fall is short enough that the particles
     are still inside the cells they started in, so the measurement is the
     impulse and not the interpolation. */
  const core = instantiate();
  const { exp } = core;
  const B = [-4, -2, -4, 4, 10, 4];
  exp.fe_flip_begin(16, bounds(core, B));
  const spacing = 0.25;
  const p = stage(core, fill(-2, 2, -1, 3, -2, 2, spacing), spacing);
  const frames = 10;
  for (let frame = 0; frame < frames; frame++) {
    step(core, B, p, { vorticity: 0, viscosity: 0, surfaceTension: 0 });
  }
  /* Only the interior counts: a particle in the outer shell samples faces that
     are half in air, and the gravity weight there is a half. */
  const vel = core.f32(p.vel, p.count * 3);
  const pos = core.f32(p.pos, p.count * 3);
  let sum = 0;
  let n = 0;
  for (let k = 0; k < p.count; k++) {
    const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    if (Math.abs(x) > 1.0 || Math.abs(z) > 1.0 || y < 0.6 || y > 2.4) continue;
    sum += vel[k * 3 + 1];
    n++;
  }
  assert.ok(n > p.count * 0.1, 'the sample has to be large enough to mean something');
  const mean = sum / n;
  /* The free surface of a finite blob lets a little of the impulse go into the
     surface pressure correction, so the body runs at about 0.87 g here rather
     than exactly 1 g. The window is wide enough for that and far too narrow for
     the factor-of-two mistake this test exists to catch. */
  const expected = GRAVITY * frames * DT;
  const ratio = mean / expected;
  assert.ok(
    ratio > 0.75 && ratio < 1.05,
    `after ${frames} frames the interior should be near ${expected.toFixed(2)} m/s (0.75-1.05 g), got ${mean.toFixed(2)} (${ratio.toFixed(2)} g)`
  );
});

test('the solver is deterministic: the same input gives the same frame', () => {
  const run = () => {
    const core = instantiate();
    const { exp } = core;
    const B = [-1, 0, -0.5, 1, 2, 0.5];
    exp.fe_flip_begin(24, bounds(core, B));
    const spacing = exp.fe_flip_cell_size() / 2;
    const p = stage(core, fill(-0.8, 0.0, 0, 1.2, -0.4, 0.4, spacing), spacing);
    for (let frame = 0; frame < 40; frame++) step(core, B, p);
    const pos = core.f32(p.pos, p.count * 3);
    const vel = core.f32(p.vel, p.count * 3);
    return { count: p.count, pos: Array.from(pos), vel: Array.from(vel) };
  };
  const a = run();
  const b = run();
  assert.equal(a.count, b.count);
  assert.deepEqual(a.pos, b.pos, 'particle positions repeat exactly');
  assert.deepEqual(a.vel, b.vel, 'particle velocities repeat exactly');
});

test('the particle cap is a guard, not a crash', () => {
  const core = instantiate();
  const { exp } = core;
  const B = [-1, 0, -1, 1, 2, 1];
  exp.fe_flip_begin(16, bounds(core, B));
  const count = 65537;
  const spacing = 0.05;
  const positions = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    positions[k * 3] = -0.9 + (k % 40) * spacing;
    positions[k * 3 + 1] = 0.5;
    positions[k * 3 + 2] = -0.9 + Math.floor(k / 40) * spacing * 0.02;
  }
  const p = stage(core, positions, spacing);
  assert.equal(step(core, B, p), -2, 'one particle over the cap is refused with -2');
});
