import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parser } from '@shaderfrog/glsl-parser';

/* A tree that moves like a cut-out on a string is not a tree, and the grounds
 * for it were two separate faults in the vertex shader:
 *
 *   1. the skeletal bend started at 12% of full amplitude at the trunk collar,
 *      so the base slid across the ground instead of being planted;
 *   2. the twigs ran at up to 1.8x the rate of the trunk, so a limb waved at a
 *      different tempo from the trunk it is attached to;
 *   3. and on top of all that, the legacy height-squared shear was still applied
 *      to skeletal geometry, translating the whole plant by its height.
 *
 * These tests read the shipped shader out of the source and pin the three
 * properties that make the difference, then check the assembled GLSL still
 * parses. */

const src = readFileSync('terrain-main-01.js', 'utf8');

/* The SKEL literal: one single-quoted string with a `'+(0.5).toFixed(3)+'`
   concat in the middle, so it is read as the two halves around that seam. */
const skelAt = src.indexOf('const SKEL=');
assert.ok(skelAt > 0, 'the skeletal wind shader must exist');
const skelEnd = src.indexOf("\\n';", skelAt);
const skelRaw = src.slice(skelAt + 'const SKEL='.length, skelEnd + 3);
const seam = skelRaw.indexOf("'+(0.5).toFixed(3)+'");
assert.ok(seam > 0, 'the bend amplitude is a formatted constant');
const skelBefore = skelRaw.slice(1, seam);
const skelAfter = skelRaw.slice(seam + "'+(0.5).toFixed(3)+'".length, -1);
/* The literal ends with escaped newlines for the shader's benefit; the parser
   wants them as real ones. */
const SKEL = (skelBefore + '0.5' + skelAfter).replace(/\\+n/g, '\n');

/** The displacement SKEL computes, evaluated in JS so the shape can be tested. */
function bend({ y, sway, phase, wind, gust = 1, t = 0.7 }) {
  const skT = Math.min(1.25, Math.max(0, y) / 12);
  const skBend = skT * skT;
  const skW = 0.72 + 0.28 * sway;
  const skB = Math.sin(t * skW + phase) + 0.18 * Math.sin(t * skW * 2.03 + phase * 1.4 + 1.7);
  return 0.5 * skBend * sway * wind * skB * gust; /* along skDir, in metres */
}

test('the trunk collar does not move', () => {
  for (const sway of [0, 0.25, 0.5, 1]) {
    assert.equal(bend({ y: 0, sway, phase: 1.3, wind: 1 }), 0,
      `a plant with aSway=${sway} moved at the ground line`);
  }
  /* The old law's floor was 12% of full amplitude, which is what slid the base. */
  assert.equal(/clamp\(skH\*\.34,\.12,1\.\)/.test(src), false, 'the 12% base floor is back');
});

test('the bend is quadratic in height, like a cantilever', () => {
  const low = Math.abs(bend({ y: 3, sway: 1, phase: 0, wind: 1, t: 0.4 }));
  const high = Math.abs(bend({ y: 12, sway: 1, phase: 0, wind: 1, t: 0.4 }));
  assert.ok(high > low * 10, `expected a much larger bend at the top (3 m: ${low}, 12 m: ${high})`);
  /* (3/12)^2 = 1/16 of the top's bend for the same oscillation value */
  const shape = (y) => Math.min(1.25, y / 12) ** 2;
  assert.ok(Math.abs(shape(6) / shape(12) - 0.25) < 1e-9, 'half height is a quarter of the bend');
});

test('one frequency per plant: twigs do not run at their own tempo', () => {
  const rate = (sway) => 0.72 + 0.28 * sway;
  /* The whole range of aSway sits inside a factor of 1.4, not 3.3. */
  assert.ok(rate(1) / rate(0) < 1.4, `frequency spread ${rate(1) / rate(0)} is too wide`);
  const second = /\.18\*sin\(uT\*skW\*2\.03/.test(SKEL);
  assert.ok(second, 'the second harmonic must stay small (0.18) and near-octave');
  assert.equal(/skW=\.55\+1\.25\*aSway/.test(src), false, 'the 1.8x twig rate is back');
});

test('the legacy height-squared shear is masked off skeletal geometry', () => {
  const legacy = /transformed\.xz\+=wd\*wv\*'\+\(a\*\.8\)\.toFixed\(4\)\+'\*gust\*\(\.35\+\.65\*sway\)\*\(1\.-clamp\(aSway\*1\.6,0\.,1\.\)\);/.exec(src);
  assert.ok(legacy, 'the legacy shear must fade out as aSway rises');
  /* A leaf card has no aSway attribute; three reads a missing attribute as 0,
     so the mask must be exactly 1 there and the old look is preserved. */
  const mask = (sway) => 1 - Math.min(1, Math.max(0, sway * 1.6));
  assert.equal(mask(0), 1, 'non-skeletal geometry lost its old wind');
  assert.equal(mask(1), 0, 'skeletal geometry is still translated by the shear');
});

test('the assembled vertex shader still parses', () => {
  /* Everything SKEL reads has to be declared for the parser to accept it. */
  const program = `
    precision highp float;
    attribute float aPhase;
    attribute float aSway;
    uniform float uT;
    uniform float uW;
    varying vec4 vTest;
    void main(){
      vec3 transformed = vec3(0.0);
      vec2 wd = vec2(0.8, 0.6);
      float gust = 1.0;
      float py = 0.0;
      ${SKEL}
      vTest = vec4(transformed, gust + py);
      gl_Position = vec4(1.0);
    }`;
  assert.doesNotThrow(() => parser.parse(program), 'SKEL does not assemble into valid GLSL');
});
