import assert from 'node:assert/strict';
import test from 'node:test';
import { appPath } from './app-paths.mjs';
import { pathToFileURL } from 'node:url';
await import(pathToFileURL(appPath('celestial-math.js')).href);

const { moonOrbitDirection, moonPhaseLighting } = globalThis.CelestialMath;
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

test('moon phase changes illumination without changing its orbital position', () => {
  const position = moonOrbitDirection(0.73, 120, 18, 145);
  const phases = [0, 90, 180, 270, 360];
  const lighting = phases.map(phase => moonPhaseLighting(position, phase));

  assert.deepEqual(moonOrbitDirection(0.73, 120, 18, 145), position);
  near(lighting[0].illuminatedFraction, 0);
  near(lighting[1].illuminatedFraction, 0.5);
  near(lighting[2].illuminatedFraction, 1);
  near(lighting[3].illuminatedFraction, 0.5);
  near(lighting[4].illuminatedFraction, 0);
  near(dot(lighting[0].direction, lighting[2].direction), -1);
});

test('orbit position offset moves the moon independently of phase', () => {
  const before = moonOrbitDirection(0.73, 120, 18, 145);
  const after = moonOrbitDirection(0.73, 120, 18, 235);

  assert.notDeepEqual(after, before);
  near(Math.hypot(...before), 1);
  near(Math.hypot(...after), 1);
});
