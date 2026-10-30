import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* Two things that are easy to leave half-connected, and impossible to spot in a
 * screenshot when they are:
 *
 *   1. a lawn casts its shadow through a decimated proxy mesh - one blade in
 *      eight - because shading 105 000 blades into a shadow map is a waste of
 *      the frame. If nothing ever copies the lawn's instance transforms into
 *      that proxy, the shadows stay behind at the world origin while the grass
 *      grows somewhere else;
 *   2. foliage that sheds leaves, drops snow or blooms has to discard the same
 *      pixels in the depth pass as it does in the colour pass, or every leaf
 *      keeps casting a shadow after it has fallen.
 *
 * Neither failure raises an error - the scene just looks wrong - so both links
 * are pinned here. */

const scene = readFileSync('terrain-main-01.js', 'utf8');
const sync = readFileSync('terrain-main-03.js', 'utf8');
const plants = readFileSync('terrain-main-02.js', 'utf8');

test('the lawn shadow proxy follows the lawn', () => {
  assert.match(scene, /function makeBotanicalShadowProxy\(geometry,material,capacity,name\)/);
  assert.match(scene, /if\(n==='grass'\|\|n==='tallgrass'\)K\.shadowMeshes=K\.meshes\.map\(\(m,i\)=>\{/,
    'grass and tall grass are the kinds that need a decimated caster');
  /* The per-frame copy: source matrix j goes to proxy slot j/stride. */
  assert.match(sync, /const shadow=K\.shadowMeshes\?\.\[mi\];/);
  assert.match(sync, /shadow\.instanceMatrix\.array\.set\(m\.instanceMatrix\.array\.subarray\(j\*16,j\*16\+16\),si\*16\)/);
  assert.match(sync, /shadow\.count=si;shadow\.visible=si>0;/, 'the proxy is submitted with the count it just filled');
  /* A grown blade is a different silhouette: the proxy geometry follows it. */
  assert.match(plants, /proxy\.geometry\s*=\s*\(m\.userData && m\.userData\.lodGeom\) \|\| m\.geometry/);
});

test('the depth pass discards the leaves the colour pass discards', () => {
  assert.match(scene, /function depthFx\(m,fx\)\{if\(!\/\[sSb\]\/\.test\(fx\)\)return;/, 'only the shedding kinds get a custom depth material');
  assert.match(scene, /if\(o\.cut&&sh\)\{const depth=new THREE\.MeshDepthMaterial\(/, 'cut-out foliage needs an alpha-tested depth material');
  assert.match(scene, /depthFx\(depth,o\.fx\|\|''\)/, 'and that material has to receive the shedding uniforms');
  for (const uniform of ['uShed', 'uShedF', 'uBloom', 'uGrow', 'uShedS0', 'uShedT0', 'uClk']) {
    assert.ok(scene.includes(`s.uniforms.${uniform}=FXU.`), `${uniform} is never wired into the depth material`);
  }
  assert.match(scene, /if\(vFall>=1\.\)discard/, 'a fallen leaf must not cast a shadow');
});
