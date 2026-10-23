import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

/* The volume renderer samples a 2D atlas on WebGL1 as well as WebGL2, so the
   slice-to-tile mapping is part of the render contract and is tested here
   without a GPU. */
const ctx={};vm.createContext(ctx);
vm.runInContext(readFileSync('volume-atlas.js','utf8'),ctx);
const {layout,pack}=ctx.FEVolumeAtlas;

test('atlas layout tiles every z slice without wasted rows',()=>{
  for(const [grid,tx,ty] of [[1,1,1],[4,2,2],[16,4,4],[24,5,5],[32,6,6],[40,7,6]]){
    const info=layout(grid);
    assert.equal(info.tilesX,tx,`${grid}³ tilesX`);
    assert.equal(info.tilesY,ty,`${grid}³ tilesY`);
    assert.equal(info.width,grid*tx);
    assert.equal(info.height,grid*ty);
    assert.ok(tx*ty>=grid,'every slice has a tile');
    assert.ok(tx*ty-grid<tx,'no more than one spare row of tiles');
  }
  assert.equal(layout(0).grid,1,'degenerate grids clamp to one cell');
});

test('pack writes density and temperature into the right texel of every slice',()=>{
  const g=4,cells=g**3;
  const density=new Float32Array(cells),temperature=new Float32Array(cells);
  for(let z=0;z<g;z++)for(let y=0;y<g;y++)for(let x=0;x<g;x++){
    const i=(z*g+y)*g+x;
    density[i]=(i+1)/cells*2.5;      // spans 0..2.5 with a 3.0 scale
    temperature[i]=0.5+(i%7)*0.25;   // spans the 0..2 temperature scale
  }
  const packed=pack({density,temperature,grid:g,densityScale:3,temperatureScale:2});
  assert.equal(packed.width,8);
  assert.equal(packed.height,8);
  assert.equal(packed.written,64);
  const at=(x,y,z)=>{
    const tx=(z%packed.tilesX)*g,ty=Math.floor(z/packed.tilesX)*g;
    return ((ty+y)*packed.width+(tx+x))*4;
  };
  for(const [x,y,z] of [[0,0,0],[3,0,0],[1,2,1],[3,3,3],[2,1,3]]){
    const src=(z*g+y)*g+x,dst=at(x,y,z);
    assert.equal(packed.data[dst],Math.round(Math.min(1,density[src]/3)*255),`density texel ${x},${y},${z}`);
    assert.equal(packed.data[dst+1],Math.round(Math.min(1,temperature[src]/2)*255),`temperature texel ${x},${y},${z}`);
    assert.equal(packed.data[dst+2],0);
    assert.equal(packed.data[dst+3],255);
  }
});

test('pack clamps out-of-range fields and rejects bad inputs',()=>{
  const g=2;
  const density=Float32Array.from([-5,0,1,40,2,3,4,5]);
  const temperature=Float32Array.from([0,0.5,1,1.5,2,2.5,3,100]);
  const packed=pack({density,temperature,grid:g,densityScale:2,temperatureScale:1});
  const at=(x,y,z)=>{
    const tx=(z%packed.tilesX)*g,ty=Math.floor(z/packed.tilesX)*g;
    return ((ty+y)*packed.width+(tx+x))*4;
  };
  assert.equal(packed.data[at(0,0,0)],0,'negative density clamps to zero');
  assert.equal(packed.data[at(1,1,0)],255,'density above the scale clamps to one');
  assert.equal(packed.data[at(0,0,0)+1],0,'zero temperature stays at zero');
  assert.equal(packed.data[at(0,0,1)+1],255,'temperature above the scale clamps to one');
  assert.throws(()=>pack({density:new Float32Array(4),temperature:new Float32Array(4),grid:2}),/full grid/);
  assert.throws(()=>pack({density:new Float32Array(8),temperature:new Float32Array(8),grid:2,out:new Uint8Array(4)}),/too small/);
  const reuse=new Uint8Array(layout(2).width*layout(2).height*4);
  assert.equal(pack({density:new Float32Array(8),temperature:new Float32Array(8),grid:2,out:reuse}).data,reuse,'callers can reuse one texture buffer');
});

test('the app ships the volume atlas before the simulation engine',()=>{
  const html=readFileSync('index.html','utf8');
  assert.equal(html.split('<script src="volume-atlas.js"></script>').length-1,1,'exactly one atlas script tag');
  assert.ok(html.indexOf('volume-atlas.js')<html.indexOf('simulationCore.js'),'atlas loads before the simulation engine');
  const core=readFileSync('simulationCore.js','utf8');
  assert.ok(core.includes("global.FEVolumeAtlas"),'the simulation engine reads the atlas helper');
});
