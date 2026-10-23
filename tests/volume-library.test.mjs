import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

/* The baked "cinema" set is a real asset: build it with
   `node scripts/bake-volume-library.mjs`, then this test checks the format, the
   tile math and the ping-pong frame clock without a GPU. */
const ctx={};vm.createContext(ctx);vm.runInContext(readFileSync('volume-library.js','utf8'),ctx);
const {FEVolumeLibrary}=ctx;
const buffer=readFileSync('volume-library.bin');
const lib=FEVolumeLibrary.parse(buffer);

test('the baked library parses into named, cubic, fixed-length variants',()=>{
  assert.equal(lib.variants.length,3,'fire, smoke and steam are baked');
  assert.equal(lib.variants.map(v=>v.name).join(','),'Fire,Smoke,Steam');
  for(const variant of lib.variants){
    assert.equal(variant.grid,20,'the library is a 20³ grid');
    assert.equal(variant.frames,12);
    assert.equal(variant.fps,24);
    assert.equal(variant.data.length,variant.frames*variant.grid**3*2,'every frame carries density + temperature');
  }
});

test('the baked frames hold a real plume, not an empty buffer',()=>{
  const fire=FEVolumeLibrary.find(lib,'Fire');
  let peak=0,total=0;
  for(let f=0;f<fire.frames;f++){
    let framePeak=0;
    const base=f*fire.grid**3*2;
    for(let i=0;i<fire.grid**3;i++){framePeak=Math.max(framePeak,fire.data[base+i*2]);}
    assert.ok(framePeak>40,`frame ${f} has density`);
    peak=Math.max(peak,framePeak);
  }
  const last=FEVolumeLibrary.sample(fire,fire.frames-1,0.5,0.5,0.5);
  assert.ok(last[0]>0,'the last frame still has a hot core');
  const smoke=FEVolumeLibrary.find(lib,'Smoke');
  for(let i=0;i<smoke.grid**3;i++) total+=smoke.data[(smoke.frames-1)*smoke.grid**3*2+i*2];
  assert.ok(total>0,'the smoke variant is populated');
  assert.ok(peak<=255);
});

test('the atlas tiles every slice of every frame exactly once',()=>{
  const smoke=FEVolumeLibrary.find(lib,'Smoke');
  const atlas=FEVolumeLibrary.packAtlas(smoke);
  assert.equal(atlas.tilesX*atlas.tilesY>=smoke.frames*smoke.grid,true,'all frame/slice tiles fit');
  assert.equal(atlas.width,atlas.tilesX*smoke.grid);
  assert.equal(atlas.height,atlas.tilesY*smoke.grid);
  assert.equal(atlas.data.length,atlas.width*atlas.height*4);
  /* Every density byte must land in the atlas exactly once: compare sums. */
  let source=0,painted=0;
  for(let i=0;i<smoke.data.length;i+=2) source+=smoke.data[i];
  for(let o=0;o<atlas.data.length;o+=4) painted+=atlas.data[o];
  assert.equal(painted,source,'the atlas carries exactly the source density bytes');
  for(let o=3;o<atlas.data.length;o+=4) assert.equal(atlas.data[o],255,'the atlas is opaque');
});

test('playback is a slow ping-pong, so the short loop never snaps',()=>{
  const fire=FEVolumeLibrary.find(lib,'Fire');
  const a=FEVolumeLibrary.frameAt(fire,0,1);
  assert.deepEqual([a.a,a.b], [0,1]);
  const mid=FEVolumeLibrary.frameAt(fire,0.25,1);
  assert.ok(mid.a>=0&&mid.b<fire.frames,'indices stay inside the clip');
  const end=FEVolumeLibrary.frameAt(fire,0.5,1);
  assert.ok(end.a>=mid.a,'the clock keeps moving forward');
  for(let t=0;t<10;t+=0.13){
    const f=FEVolumeLibrary.frameAt(fire,t,1);
    assert.ok(f.a>=0&&f.b<=fire.frames-1&&f.blend>=0&&f.blend<=1);
  }
  const fast=FEVolumeLibrary.frameAt(fire,1,2);
  const slow=FEVolumeLibrary.frameAt(fire,1,0.5);
  assert.notEqual(fast.a,slow.a,'Library Motion retimes the clip');
});

test('the reader rejects foreign or truncated data instead of guessing',()=>{
  assert.throws(()=>FEVolumeLibrary.parse(new Uint8Array(16)),/bad magic/);
  const short=buffer.subarray(0,buffer.length-1000);
  assert.throws(()=>FEVolumeLibrary.parse(short),/truncated/);
  assert.equal(FEVolumeLibrary.find(lib,'Nope'),null);
});
