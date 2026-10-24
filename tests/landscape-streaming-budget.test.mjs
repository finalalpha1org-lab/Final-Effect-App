import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
const source=readFileSync('open-world.js','utf8');
test('streamed terrain supplies all three vec4 material weight attributes',()=>{
 const start=source.indexOf('function owTileTopology('),end=source.indexOf('\n',start);
 const ctx={THREE,OW_TOPOLOGY:new Map(),OW_SHARED:new WeakSet()};
 vm.runInNewContext(source.slice(start,end)+';this.top=owTileTopology;',ctx);
 for(const seg of [32,64]){
 const t=ctx.top(seg);for(const attr of [t.weightsA,t.weightsB,t.weightsC]){
 assert.equal(attr.itemSize,4);assert.equal(attr.count,t.tvt);
 }
 assert.equal(ctx.top(seg),t,'topology is shared, not rebuilt per tile');
 assert.ok([...t.index.array].every(i=>i<t.tvt));
 }
 /* The tile writes all three weight sets through the guard that refuses a
    missing one — an undefined entry in geometry.attributes is a hole three
    throws on when the geometry is released. */
 for(const name of ['surfaceWeightsA','surfaceWeightsB','surfaceWeightsC'])
  assert.ok(source.includes(`put('${name}',top.`),`tiles must supply ${name}`);
});
test('far foliage batches retain species instancing and evict inactive buffers only',()=>{
 assert.ok(source.includes("const key=item.k+':'+si"));
 assert.ok(source.includes('fol.farPools.delete(key)'));
 assert.ok(source.includes('if(pool.ownedMaterial)forestImpostors.disposeMaterial(pool.mesh.material)'));
 const block=source.slice(source.indexOf('function rebuildFar()'),source.indexOf('/* streaming controller */'));
 assert.ok(!block.includes('pool.mesh.geometry.dispose'),'shared species assets must survive instance eviction');
 new vm.Script(source);
});
