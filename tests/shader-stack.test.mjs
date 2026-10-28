import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* The ground is a stack of shader injections: the triplanar material layers the
   terrain material assigns itself, the detail pass (micro-structure, wetness,
   snow, water absorption, painted surfaces) and, in the open world, the leaf
   litter switch. They are all installed through onBeforeCompile, and assigning
   that property straight over the top replaces the one before it. The detail
   pass did exactly that to the terrain, so the measured texture of the ground
   never reached a pixel and the land drew as flat vertex colour.
   These tests run the shipped stack against a material stub: both injections
   have to reach the shader, in order, with both cache keys. */

const scene = readFileSync('terrain-main-01.js', 'utf8');
const detail = readFileSync('terrain-main-04.js', 'utf8');
const openWorld = readFileSync('open-world.js', 'utf8');

const block = /\/\* One material can carry more than one shader injection[\s\S]*?function shaderOff\(m,on\)\{[\s\S]*?\n\}/.exec(scene)?.[0];
assert.ok(block, 'the shader stack lives in terrain-main-01.js');

function mkMaterial() {
  const m = { userData: {}, needsUpdate: false };
  const ctx = { WeakMap, m };
  vm.createContext(ctx);
  vm.runInContext(block + ';this.addShader=addShader;this.shaderOff=shaderOff;this.FESHADER=FESHADER;', ctx);
  return { m, addShader: ctx.addShader, shaderOff: ctx.shaderOff, stack: ctx.FESHADER };
}

test('the triplanar ground and the detail pass both reach the compiled shader', () => {
  const { m, addShader } = mkMaterial();
  /* The terrain material's own triplanar layers. */
  m.customProgramCacheKey = () => 'terrain-triplanar-pbr-v2';
  m.onBeforeCompile = (s) => { s.fragmentShader = 'triplanar<color_fragment>'; };
  /* The detail pass is added on top, exactly as injectDetail() does it. */
  addShader(m, 'detail', () => 'det-surface-pbr-v3-T', (s) => { s.fragmentShader += '|detail'; });
  const shader = { fragmentShader: '' };
  m.onBeforeCompile(shader);
  assert.equal(shader.fragmentShader, 'triplanar<color_fragment>|detail', 'both injections run, base first');
  assert.equal(m.customProgramCacheKey(), 'terrain-triplanar-pbr-v2|det-surface-pbr-v3-T', 'and both keys are in the program cache key');
});

test('a later injection runs after the ones already installed', () => {
  const { m, addShader } = mkMaterial();
  addShader(m, 'detail', () => 'd', (s) => { s.fragmentShader = s.fragmentShader.replace('uLit*(grm', '0.*(grm'); });
  /* The detail pass contributes the text this one edits: it can only find it
     if it runs second, which is what the open-world litter switch needs. */
  addShader(m, 'ow-lit', () => 'ow', (s) => { s.fragmentShader = s.fragmentShader.replace('uLit*(grm', '0.*(grm'); });
  const shader = { fragmentShader: 'float lit=uLit*(grm' };
  m.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /0\.\*\(grm/, 'the later injection saw the earlier one\'s text');
  assert.equal(m.customProgramCacheKey(), 'd|ow');
});

test('adding the same injection twice replaces it instead of stacking', () => {
  const { m, addShader } = mkMaterial();
  let runs = 0;
  const once = () => { runs++; };
  m.onBeforeCompile = once;
  addShader(m, 'detail', () => 'a', () => {});
  addShader(m, 'detail', () => 'b', () => {});
  const shader = {};
  m.onBeforeCompile(shader);
  assert.equal(runs, 1, 'the base still runs once');
  const key = m.customProgramCacheKey();
  assert.match(key, /\|b$/, 'the newest copy of the detail pass is in the key');
  assert.doesNotMatch(key, /a/, 'and the replaced copy is not');
});

test('the ground can be turned back to the stock shader without losing the stack', () => {
  const { m, addShader, shaderOff } = mkMaterial();
  let ran = 0;
  addShader(m, 'detail', () => 'd', () => { ran++; });
  assert.equal(shaderOff(m, true), 1);
  m.onBeforeCompile({});
  assert.equal(ran, 0, 'off means the stock shader compiles');
  assert.match(m.customProgramCacheKey(), /off$/);
  shaderOff(m, false);
  m.onBeforeCompile({});
  assert.equal(ran, 1, 'and back on it compiles the real material again');
  assert.doesNotMatch(m.customProgramCacheKey(), /off$/);
});

test('nothing assigns onBeforeCompile over an existing injection any more', () => {
  assert.match(detail, /function injectDetail\(m,inst\)\{addShader\(m,'detail'/, 'the detail pass is a stacked injection');
  assert.match(detail, /injectDetail\(tm,false\);/, 'and it is still installed on the ground');
  assert.match(openWorld, /addShader\(m,'ow-lit'/, 'the open-world litter switch stacks too');
  /* The ground fallback and the Ground detail toggle must switch the stack off
     rather than wipe the property, or turning the detail back on would leave a
     material with no triplanar layers at all. */
  assert.match(detail, /if\(!groundOld&&badProg\(tm\)\)\{/, 'a failed ground program is handled');
  assert.match(detail, /shaderDrop\(tm,'detail'\)/, 'the newest pass is the first thing dropped');
  assert.match(detail, /if\(v=='ground'\)\{if\(SAFE\.ground\)shaderOff\(tm,true\);else\{shaderOff\(tm,false\);injectDetail\(tm,false\)\}/);
  for (const [name, source] of [['terrain', detail], ['open world', openWorld]]) {
    assert.doesNotMatch(source, /onBeforeCompile=\(\)=>\{\}/, `${name} must not blank the injection`);
  }
  /* The terrain's triplanar assignment is the base of the stack and stays. */
  assert.match(scene, /tm\.onBeforeCompile=shader=>\{/, 'the triplanar layers are still the material\'s own injection');
  assert.match(scene, /tm\.customProgramCacheKey=\(\)=>'terrain-triplanar-pbr-v2'/);
});
