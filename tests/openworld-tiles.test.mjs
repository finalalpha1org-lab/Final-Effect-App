import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* The landscape studio's Open World tiles used to take the whole frame down the
 * moment one of them was released. The cause was a single hole in the attribute
 * dictionary: the cached 64-segment topology shipped weights A and B but not C,
 * and `owBuildNode` happily wrote `surfaceWeightsC: undefined` into every tile.
 * Drawing survived it (three skips a missing attribute); `geometry.dispose()`
 * did not, because WebGLRenderer walks `for (const name in geometry.attributes)`
 * and calls `attributes.remove(undefined)`, which throws on the first property
 * read. These tests pin the fix and the two follow-on guarantees: a shared
 * attribute is never freed from under its sibling tiles, and one bad release
 * can no longer kill the streaming loop. */

const openWorld = readFileSync('open-world.js', 'utf8');
const scene = readFileSync('terrain-main-01.js', 'utf8');

test('the cached tile topology ships all three vec4 material weight sets', () => {
  /* The detail shader declares surfaceWeightsA, B and C. Every topology the
     studio can hand a tile must provide all three, or the geometry gets a hole. */
  const line = openWorld.split('\n').find((l) => l.includes('OW_TOPOLOGY=new Map'));
  assert.ok(line, 'the cached topology must exist');
  assert.match(line, /weightsA:OWZA/, 'cached topology needs weightsA');
  assert.match(line, /weightsB:OWZB/, 'cached topology needs weightsB');
  assert.match(line, /weightsC:OWZC/, 'cached topology needs weightsC');
  assert.match(openWorld, /OWZC=new THREE\.BufferAttribute\(new Float32Array\(TVT\*4\),4\)/, 'weights C is a vec4, like the shader samples');
  assert.match(openWorld, /OWZB=new THREE\.BufferAttribute\(new Float32Array\(TVT\*4\),4\)/, 'weights B is a vec4 too — itemSize 2 could never fill the attribute');
});

test('a tile never stores a hole in its attribute dictionary', () => {
  const build = openWorld.slice(openWorld.indexOf("const g=new THREE.BufferGeometry();"), openWorld.indexOf("if(!owTerrainMat)owTerrainMat=owMakeTerrainMat()"));
  assert.ok(!/g\.setAttribute\('surfaceWeights[ABC]',top\./.test(build), 'attributes must go through the guard, not straight into the geometry');
  assert.match(build, /const put=\(name,attr\)=>\{if\(attr&&attr\.array\)g\.setAttribute\(name,attr\)\}/, 'the guard must check the attribute exists before storing it');
  for (const name of ['surfaceWeightsA', 'surfaceWeightsB', 'surfaceWeightsC']) {
    assert.match(build, new RegExp(`put\\('${name}'`), `${name} must be written through the guard`);
  }
  assert.match(build, /if\(top\.index\)g\.setIndex\(top\.index\)/, 'a missing index must not become an undefined index');
});

test('releasing a tile detaches the buffers every sibling still draws from', () => {
  assert.match(openWorld, /const OW_SHARED=new WeakSet\(\)/, 'shared attribute ownership must be tracked');
  const release = openWorld.slice(openWorld.indexOf('function owReleaseGeometry(g)'), openWorld.indexOf('function owDisposeNode(n)'));
  assert.match(release, /OW_SHARED\.has\(a\)\)delete at\[name\]/, 'shared attributes are detached, not disposed');
  assert.match(release, /!a\|\|!a\.array\|\|OW_SHARED\.has\(a\)/, 'empty entries are dropped before three sees them');
  assert.match(release, /OW_SHARED\.has\(g\.index\)\)g\.index=null/, 'a shared index buffer must survive one tile');
  assert.match(release, /try\{[\s\S]*g\.dispose\(\);[\s\S]*\}catch\(e\)\{console\.warn/, 'a renderer that refuses one geometry must not throw out of the release');
  assert.match(openWorld, /function owDisposeNode\(n\)\{if\(n\.mesh\)\{OW\.root\.remove\(n\.mesh\);owReleaseGeometry\(n\.mesh\.geometry\)/, 'tiles are released through the guarded path');
  assert.match(openWorld, /function owDisposeWater\(\)\{[\s\S]{0,200}owReleaseGeometry/, 'water meshes take the same path');
  /* Nothing may dispose a tile geometry directly any more. */
  assert.ok(!/owDisposeNode[\s\S]{0,120}\.geometry\.dispose\(\)/.test(openWorld), 'no direct geometry.dispose() in the tile path');
});

test('the registry is populated for every topology, including the cached one', () => {
  assert.match(openWorld, /for\(const t of OW_TOPOLOGY\.values\(\)\)\{OW_SHARED\.add\(t\.index\)/, 'the cached topology must be registered after it is created');
  const factory = openWorld.slice(openWorld.indexOf('function owTileTopology(seg)'), openWorld.indexOf('function owMakeTerrainMat'));
  for (const key of ['t.index', 't.weightsA', 't.weightsB', 't.weightsC']) {
    assert.match(factory, new RegExp(`OW_SHARED\\.add\\(${key.replace('.', '\\.')}\\)`), `${key} must be registered as shared`);
  }
});

test('the studio shows one copy of a repeated error instead of a wall of them', () => {
  /* Two catch sites reported the same stack in the same frame, which is what
     buried the viewport. Extract the real showErr and drive it with a stub
     document: the same message must appear once, a different one still appends. */
  const start = scene.indexOf('const shownErrors=new Set();');
  const end = scene.indexOf('const seenRuntimeErrors', start);
  assert.ok(start > 0 && end > start, 'showErr with its dedupe set must exist');
  const snippet = scene.slice(start, end);
  const box = { textContent: '' };
  const context = {
    console,
    document: { getElementById: () => box, createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } }
  };
  vm.createContext(context);
  vm.runInContext(snippet + '\nglobalThis.showErr = showErr;', context);
  context.showErr('Open World: boom');
  context.showErr('Open World: boom');
  assert.equal(box.textContent, 'Open World: boom', 'the same error is shown once');
  context.showErr('Open World: a different failure');
  assert.equal(box.textContent.split('\n').length, 2, 'a new error still reaches the user');
});

test('a geometry with a hole in its attribute list is released instead of throwing', () => {
  /* Reproduce three r128's onGeometryDispose: it walks
     `for (const name in geometry.attributes)` and reads a property of each
     entry. One `undefined` entry is therefore a TypeError, which is exactly
     the stack the studio was showing. Run the shipped owReleaseGeometry
     against a stand-in that behaves the same way. */
  const start = openWorld.indexOf('function owReleaseGeometry(g)');
  const end = openWorld.indexOf('function owDisposeNode(n)');
  const sharedA = { array: new Float32Array(4), disposed: 0 };
  const sharedIndex = { array: new Uint16Array(6), disposed: 0 };
  const context = { console, OW_SHARED: new WeakSet() };
  vm.createContext(context);
  vm.runInContext(`${openWorld.slice(start, end)}\nglobalThis.release = owReleaseGeometry;`, context);
  context.OW_SHARED.add(sharedA);
  context.OW_SHARED.add(sharedIndex);

  const unique = { array: new Float32Array(3), disposed: 0 };
  const geometry = {
    index: sharedIndex,
    attributes: { position: unique, surfaceWeightsA: sharedA, surfaceWeightsC: undefined },
    disposed: false,
    dispose() {
      if (this.index !== null) this.index.disposed++;      /* three: attributes.remove(index) */
      for (const name in this.attributes) {
        const attribute = this.attributes[name];
        if (attribute.isInterleavedBufferAttribute) { /* throws on undefined, as in r128 */ }
        attribute.disposed++;
      }
      this.disposed = true;
    }
  };
  context.release(geometry);
  assert.equal(geometry.disposed, true, 'the geometry must still be released');
  assert.equal(unique.disposed, 1, 'the tile\'s own vertex data is freed');
  assert.equal(sharedA.disposed, 0, 'a buffer three other tiles still draw from is not freed');
  assert.equal(sharedIndex.disposed, 0, 'and neither is the shared index');
  assert.ok(!('surfaceWeightsC' in geometry.attributes), 'the hole is dropped before three walks the list');
  assert.equal(geometry.index, null, 'the shared index is detached from this one tile');
});
