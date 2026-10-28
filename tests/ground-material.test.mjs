import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parser } from '@shaderfrog/glsl-parser';

/* The ground material is a stack of shader injections on one MeshStandardMaterial:
   the triplanar layers the terrain material installs itself, and the detail pass
   (micro-structure, wetness, snow, water absorption, painted surfaces). They are
   installed in different boot files through onBeforeCompile, and the detail pass
   used to assign that property straight over the top of the triplanar layers. The
   measured texture of the ground then never reached a pixel: the land drew as flat
   vertex colour, which is what "the land has no material" looked like.
   These tests assemble the shipped GLSL and prove both passes are in it, that
   every uniform they read is declared, and that the result parses. */

const scene = readFileSync('terrain-main-01.js', 'utf8');
const detail = readFileSync('terrain-main-04.js', 'utf8');

/* Read one JS single-quoted string literal that starts at `from`, returning the
   decoded text. The payloads carry no quotes of their own, but they do carry
   escaped newlines, so the scan has to honour the backslash. */
function literal(src, from) {
  assert.equal(src[from], "'", 'literal must start at a quote');
  let out = '';
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { out += src[i] + src[i + 1]; i++; continue; }
    if (c === "'") return { text: out, end: i };
    out += c;
  }
  throw new Error('unterminated literal');
}
const unescaped = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');

/* The triplanar payload: the GLSL that replaces the colour include, minus the
   include line it re-emits. */
/* Several materials replace the colour include (water does too), so the
   triplanar payload is found from its own first line and read back to the quote
   that opens it. */
const marker = scene.indexOf('vec3 tN=normalize(vTerrainNormal)');
assert.ok(marker > 0, 'the triplanar layers must exist');
const open = scene.lastIndexOf("','", marker) + 2;
const tri = unescaped(literal(scene, open).text).replace(/^#include <color_fragment>\n/, '');

/* The triplanar declarations: its uniforms and the triGray sampler helper. */
const parsAt = scene.indexOf("const pars='");
const pars = unescaped(literal(scene, scene.indexOf("'", parsAt + 'const pars='.length)).text);

const tmpl = (src, name) => {
  const at = src.indexOf('const ' + name + '=`') + ('const ' + name + '=`').length;
  return src.slice(at, src.indexOf('`;', at));
};
const TG = tmpl(detail, 'TG');
const TD = tmpl(detail, 'TD');

/* three hands one fragment shader to the driver: the material's own texture
   chunks, the triplanar declarations and statements, then the detail pass. */
function assemble({ withTri = true, withDetail = true } = {}) {
  return [
    'precision highp float;',
    withTri ? pars : '',
    withDetail ? TG : '',
    'varying vec3 vTerrainWorld;',
    'varying vec3 vTerrainNormal;',
    'vec4 vSurfaceWeightsA = vec4(0.0), vSurfaceWeightsB = vec4(0.0), vSurfaceWeightsC = vec4(0.0);',
    'void main() {',
    '  vec3 diffuseColor = vec3(0.5);',
    '  float roughnessFactor = 0.9;',
    '  float ambientOcclusion = 1.0;',
    '  vec3 normal = vec3(0.0, 0.0, 1.0);',
    '  vec3 vViewPosition = vec3(0.0, 0.0, -5.0);',
    withTri ? tri : '',
    withDetail ? TD : '',
    '}'
  ].join('\n');
}

test('the ground shader is the triplanar layers plus the detail pass', () => {
  assert.match(tri, /triGray\(uTriGrass,vTerrainWorld,tW/, 'the triplanar layers are injected');
  assert.match(tri, /tShade/, 'and they modulate the albedo');
  const assembled = assemble();
  assert.ok(assembled.includes('triGray(uTriGrass'), 'the material layers are in the program');
  assert.ok(assembled.includes('surfValid'), 'and so is the detail pass');
  assert.ok(
    assembled.indexOf('tShade') < assembled.indexOf('surfValid'),
    'the layers run first: the detail pass reads the albedo they produced'
  );
});

test('every uniform the ground passes read is declared by one of them', () => {
  const declared = new Set();
  for (const m of (pars + TG).matchAll(/uniform\s+\w+\s+([^;]+);/g)) {
    for (const name of m[1].split(',')) declared.add(name.trim());
  }
  const used = new Set([...(pars + TG + tri + TD).matchAll(/\bu[A-Z][A-Za-z0-9]*/g)].map((m) => m[0]));
  /* Bindings owned by passes this file does not assemble: the tree-litter map
     and the autumn amount are injected by the forest material, not the ground. */
  const outOfScope = new Set(['uTreeMap', 'uAutG']);
  const missing = [...used].filter((name) => !declared.has(name) && !outOfScope.has(name));
  assert.deepEqual(missing, [], 'no ground pass may read an undeclared uniform');
  /* The Micro detail control reaches the layers through its own binding, so the
     triplanar pass does not depend on the detail pass being installed. */
  assert.ok(pars.includes('uTriDet'), 'the layers carry their own detail amount');
  assert.match(scene, /shader\.uniforms\.uTriDet=window\.FE_DET\|\|\{value:\.4\}/, 'bound to the one Micro detail control');
  assert.match(detail, /window\.FE_DET=DET;/, 'which the later file publishes');
});

test('the ground GLSL parses', () => {
  assert.doesNotThrow(() => parser.parse(assemble(), { quiet: true }), 'layers + detail must parse together');
  /* And each pass on its own, which is what the fallback ladder compiles when a
     device refuses the combined program. */
  assert.doesNotThrow(() => parser.parse(assemble({ withDetail: false }), { quiet: true }), 'the layers alone must parse');
});

test('the ground falls back one pass at a time, never all at once', () => {
  /* A device that refuses the combined program used to lose every injection on
     the first failure, which is the flat "no material" ground. It drops the
     newest pass first and only falls back to the stock shader if the material
     layers themselves will not compile. */
  assert.match(detail, /let skyTier=2,waterCompileErrorShown=false,groundOld=0,groundTier=2;/);
  assert.match(detail, /if\(groundTier==2\)\{groundTier=1;showErr\('Ground detail shader: '\+progLog\(tm\)\);shaderDrop\(tm,'detail'\);tm\.needsUpdate=true\}/);
  assert.match(detail, /else\{groundOld=1;shFall=true;showErr\('Ground shader: '\+progLog\(tm\)\);shaderOff\(tm,true\)\}/);
  assert.match(scene, /function shaderDrop\(m,id\)\{/, 'dropping a single pass is its own operation');
  assert.match(scene, /function shaderOff\(m,on\)\{/, 'and switching the stack off is reversible');
});

test('the material layers are not blank brightness any more', () => {
  /* Grass, soil, stone and snow used to modulate the same scalar, so a lawn and
     a cliff face differed only in lightness. Each layer now carries its own
     tint, and the deviation follows the Micro detail slider so every control at
     zero still returns the flat procedural look. */
  assert.match(tri, /tTint/, 'the layers tint as well as darken');
  assert.match(tri, /vec3\(\.94,1\.02,\.82\)\*tGrass/, 'grass is cool');
  assert.match(tri, /vec3\(1\.06,\.99,\.86\)\*tSand/, 'sand and soil are warm');
  assert.match(tri, /clamp\(uTriDet\*1\.6,0\.,1\.\)/, 'and the tint is scaled by the user control');
});
