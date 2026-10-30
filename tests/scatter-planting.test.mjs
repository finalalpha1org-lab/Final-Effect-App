import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* Two radii, one placement rule.
 *
 * Placement used to compare the two *footprints* for every pair of plants, so an
 * oak (an 8 m footprint at its own scale) demanded 16 m of empty ground in every
 * direction - from another oak, from a shrub, from a boulder. A hillside placed
 * that way is a field of isolated trunks with bare ground between them, and no
 * amount of scatter budget changes it because the ground is already spoken for.
 *
 * The rule now separates what a plant occupies at eye height (its crown, which
 * another tree must compete with) from what physically stands on the ground (its
 * trunk, which is all undergrowth has to avoid). */

/* The module is a UMD script with no exports: in the page it hangs itself off
   the global object, so the test loads it the same way. */
await import('../scatter-spacing.js');
const { plantDistance, plantClash, CROWN_SHARE, UNDER_SHARE } = globalThis.ScatterSpacing;
const scatter = readFileSync('terrain-main-03.js', 'utf8');

/* An oak: footprint 4.4 m, its own size scale 1.75, plant scale 1.05. */
const OAK_CROWN = 4.4 * 1.05 * 1.75, OAK_TRUNK = .46;
const SHRUB_CROWN = 1.05, SHRUB_TRUNK = .34;

test('two trees only have to clear the crown they cannot share', () => {
  const apart = plantDistance(OAK_CROWN, OAK_TRUNK, OAK_CROWN, OAK_TRUNK, true, .25);
  assert.ok(Math.abs(apart - (CROWN_SHARE * OAK_CROWN * 2 + .25)) < 1e-6, `oak to oak is ${apart.toFixed(2)} m`);
  assert.ok(apart < 10, `oak spacing ${apart.toFixed(2)} m: crowns interlock instead of demanding a 16 m clearing`);
  assert.ok(apart > 7, `oak spacing ${apart.toFixed(2)} m: trunks still keep their distance`);
  assert.equal(plantClash(0, 0, OAK_CROWN, OAK_TRUNK, OAK_CROWN, OAK_TRUNK, true) && plantClash(9.2, 0, OAK_CROWN, OAK_TRUNK, OAK_CROWN, OAK_TRUNK, true), false);
  assert.ok(plantClash(0, 0, OAK_CROWN, OAK_TRUNK, OAK_CROWN, OAK_TRUNK, true), 'two trunks in the same spot must clash');
});

test('undergrowth lives under the crown and clears only the trunk', () => {
  const near = plantDistance(OAK_CROWN, OAK_TRUNK, SHRUB_CROWN, SHRUB_TRUNK, false, 0);
  assert.ok(near < 1.2, `a shrub 1.2 m from an oak trunk is ${near.toFixed(2)} m from a 16 m tree: the canopy is shade, not a wall`);
  assert.ok(!plantClash(1.2, 0, OAK_CROWN, OAK_TRUNK, SHRUB_CROWN, SHRUB_TRUNK, false), 'a shrub may stand 1.2 m from an oak trunk');
  assert.ok(plantClash(.4, 0, OAK_CROWN, OAK_TRUNK, SHRUB_CROWN, SHRUB_TRUNK, false), 'a shrub may not stand inside the trunk');
});

test('small plants still keep a believable distance from each other', () => {
  const apart = plantDistance(SHRUB_CROWN, SHRUB_TRUNK, SHRUB_CROWN, SHRUB_TRUNK, false);
  assert.ok(apart >= UNDER_SHARE * SHRUB_CROWN - 1e-6, `shrub to shrub ${apart.toFixed(2)} m`);
  assert.ok(plantClash(.6, 0, SHRUB_CROWN, SHRUB_TRUNK, SHRUB_CROWN, SHRUB_TRUNK, false), 'shrubs at 0.6 m overlap');
  assert.ok(!plantClash(1.2, 0, SHRUB_CROWN, SHRUB_TRUNK, SHRUB_CROWN, SHRUB_TRUNK, false), 'shrubs at 1.2 m stand clear');
});

test('the shipped scatter uses the two radii, not the raw footprint', () => {
  assert.match(scatter, /const CANOPY=new Set\(\[/);
  assert.match(scatter, /const TRUNK=\{/);
  assert.match(scatter, /function occBlocked\(x,z,crown,k,gap=0,trunk=0\)/);
  assert.match(scatter, /ScatterSpacing\.plantClash\(dx,dz,crown,trunk,a\[t\+2\],a\[t\+4\],treePair,gap\)/);
  assert.match(scatter, /occAdd\(x,z,crown,k,trunk\)/, 'the crown and trunk radii are stored together');
  assert.match(scatter, /for\(let t=0;t<a\.length;t\+=5\)/, 'five floats per occupancy entry');
});

test('tree slope limits admit a hillside', () => {
  const rule = scatter.slice(scatter.indexOf('const RULE={'), scatter.indexOf('BLD={'));
  const slope = (kind) => Number(rule.match(new RegExp(`\\b${kind}:\\[([\\d.]+),`))[1]);
  for (const kind of ['oak', 'birch']) assert.ok(slope(kind) >= .9, `${kind} slope limit ${slope(kind)} still hides every bank`);
  assert.ok(slope('pine') >= 1.1, `pine slope limit ${slope('pine')}`);
  assert.ok(slope('grass') >= 1, `grass slope limit ${slope('grass')} leaves hillsides bare`);
});

test('grove thinning fades instead of carving tree-free blobs', () => {
  assert.ok(!/PATCH\[k\]&&vn\(x\*\.05\+3,z\*\.05\+8\)\*f<\.22\+scatterClustering\*\.46\)return 0/.test(scatter),
    'the hard grove veto is still shipped');
  assert.match(scatter, /PATCH\[k\]&&f<1\.5\)\{const gp=vn\(x\*\.05\+3,z\*\.05\+8\)/, 'grove density comes from the noise field');
  assert.match(scatter, /if\(R\(\)>grove\*\(1-scatterClustering\*\.4\)\)return 0/, 'the field thins candidates, it does not veto them');
});

test('stone sits on slopes and is sampled on land', () => {
  assert.match(scatter, /if\(RK\[k\]&&f<1\.5&&R\(\)>\.6\+sl\*\.06\)return 0/, 'rock thinning must not get rarer as the ground steepens');
  assert.match(scatter, /scatterFill\(bigCount,pickBig,\{maxSlope:9,clump:0,patch:22\}\)/, 'trees are sampled on land');
  assert.match(scatter, /maxSlope:stony\?9:\(RULE\[n\]\|\|\[9\]\)\[0\]/);
  assert.ok(scatter.includes("['rock',.008]"), 'the deliberate reduction of auto-scattered stone is kept');
});
