import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/* Natural ground-cover candidate generation: the C++ kernel must respect the
   water margin, the species slope limit, stay deterministic, honour the budget
   and actually produce patch structure instead of a uniform carpet. */
const wasm=readFileSync('wasm/fe_core_engine.wasm');
const {instance:{exports:e}}=await WebAssembly.instantiate(wasm,{});
const ptr=e.fe_terrain_scatter_out_ptr();
const out=n=>new Float32Array(e.memory.buffer,ptr,n*4);

function terrain(n=64,fn=(x,z)=>Math.sin(x*.05)*2+z*.01){
  assert.equal(e.fe_terrain_init(n,100),0);
  const w=n+1,H=new Float32Array(e.memory.buffer,e.fe_terrain_get_height_ptr(),w*w);
  for(let j=0;j<w;j++)for(let i=0;i<w;i++)H[j*w+i]=fn((i/n-.5)*100,(j/n-.5)*100);
  return H;
}
function natural(count,opts={}){
  return e.fe_terrain_scatter_natural(count,90,opts.seed??1234,opts.water??-100,opts.maxSlope??9,opts.clump??0,opts.patch??22);
}

test('natural scatter honours the water margin and the slope limit',()=>{
  terrain(64,(x,z)=>Math.sin(x*.05)*2);
  const dry=natural(600,{water:-100});
  assert.ok(dry>0,'a gentle landscape accepts candidates');
  for(let i=0;i<dry;i++){
    const o=out(dry);
    assert.ok(Math.abs(o[i*4])<=45&&Math.abs(o[i*4+1])<=45,'candidates stay inside the spread');
    assert.ok(o[i*4+2]>=-100+.25,'never below the water margin');
  }
  terrain(64,(x,z)=>Math.sin(x*.05)*2);
  assert.equal(natural(600,{water:40}),0,'terrain under water yields no ground cover');
  terrain(64,(x,z)=>x*.6);
  assert.equal(natural(600,{maxSlope:.2}),0,'a cliff rejects cover');
  terrain(64,(x,z)=>x*.05);
  const flat=natural(600,{maxSlope:.4});
  const o=out(flat);
  for(let i=0;i<flat;i++)assert.ok(o[i*4+3]<=.4,'every candidate reports a slope inside the limit');
});

test('natural scatter is deterministic, budget-capped and patch-clumped',()=>{
  terrain();
  assert.equal(natural(500,{seed:77}),natural(500,{seed:77}),'same seed, same candidates');
  const a=natural(500,{seed:77}),snap=Float32Array.from(out(a));
  const b=natural(500,{seed:78}),other=Float32Array.from(out(b));
  let moved=0;for(let i=0;i<Math.min(a,b)*4;i++)if(Math.abs(snap[i]-other[i])>1e-4)moved++;
  assert.ok(moved>a*3,'a new seed reshuffles the candidates');
  assert.ok(natural(500,{seed:77})<=500,'never exceeds the requested budget');
  assert.equal(natural(4096,{seed:5})<=4096,true);
  /* Quadrat clustering: cover must concentrate in patches instead of a uniform
     carpet, so the cell-count spread across an 8x8 grid has to rise sharply. */
  const quadCv=(count,clump)=>{
    terrain();
    const got=natural(count,{clump}),o=Float32Array.from(out(got));
    const g=8,cell=90/g,acc=new Float64Array(g*g);
    for(let i=0;i<got;i++){
      const a=Math.min(g-1,Math.max(0,(o[i*4]/cell+g/2)|0)),b=Math.min(g-1,Math.max(0,(o[i*4+1]/cell+g/2)|0));
      acc[b*g+a]++;
    }
    const mean=got/(g*g);let v=0;for(const c of acc)v+=(c-mean)**2;
    return {got,cv:Math.sqrt(v/(g*g))/mean};
  };
  const uniform=quadCv(2000,0);
  const clumped=quadCv(2000,.9);
  assert.ok(clumped.got>1500,`clumping must still keep a usable budget (${clumped.got})`);
  assert.ok(clumped.cv>uniform.cv*1.8,`clumped ${clumped.cv.toFixed(2)} vs uniform ${uniform.cv.toFixed(2)}`);
});

test('natural scatter validates its parameters',()=>{
  terrain();
  assert.equal(e.fe_terrain_scatter_natural(0,90,1,0,9,0,22),-1);
  assert.equal(e.fe_terrain_scatter_natural(20000,90,1,0,9,0,22),-1);
  assert.equal(e.fe_terrain_scatter_natural(400,0,1,0,9,0,22),-1);
  assert.equal(e.fe_terrain_scatter_natural(400,90,1,0,0,0,22),-1);
  assert.equal(e.fe_terrain_scatter_natural(400,90,1,0,9,-.1,22),-1);
  assert.equal(e.fe_terrain_scatter_natural(400,90,1,0,9,2,22),-1);
  assert.equal(e.fe_terrain_scatter_natural(400,90,1,0,9,.3,0),-1);
});

test('every scattered kind is sampled on land, and only trees skip the kernel clumping',()=>{
  const src=readFileSync('terrain-main-03.js','utf8');
  assert.ok(src.includes("const COVER_KINDS=new Set(['grass','tallgrass','flower','daisy','tulip','lavender']);"));
  assert.ok(src.includes('core.scatterNatural({count:batch,spread:S*.96,seed:seedBatch,water:wl,maxSlope:opts.maxSlope,clump:opts.clump,patch:opts.patch,output:SCBUF})'),'every kind asks C++ for terrain-filtered candidates');
  assert.ok(src.includes(':core.scatterBatch({count:batch,spread:S*.96,seed:seedBatch,output:SCBUF})'),'the uniform grid stays as the fallback when the kernel lacks the sampler');
  /* The uniform grid spent four fifths of a small island's tree budget in the
     sea, so the survivors looked like scattered clumps however high the budget
     went. Trees are sampled on land now, with no kernel clumping (the grove
     gate in add() owns that) and no kernel slope limit (each species has its
     own). Stone is sampled on land with a gentler clump field. */
  assert.ok(src.includes('scatterFill(bigCount,pickBig,{maxSlope:9,clump:0,patch:22})'),'trees are sampled on land');
  assert.ok(src.includes('maxSlope:stony?9:(RULE[n]||[9])[0]'),'stone ignores the species slope limit, the rest respect it');
  assert.ok(src.includes('clump:stony?cl(.15+scatterClustering*.25,0,1):cl(.25+scatterClustering*.45,0,1)'));
  const fills=[...src.matchAll(/scatterFill\([^;]*?,\s*(?:null|\{[^}]*\})\)/g)].map(m=>m[0]);
  assert.ok(fills.length>=2,fills.join(' | '));
  assert.ok(!fills.some(f=>/,\s*null\)$/.test(f)),'no kind is left on the uniform grid');
  const bridge=readFileSync('terrain-main-01.js','utf8');
  assert.ok(bridge.includes('fe_terrain_scatter_natural')&&bridge.includes('core.scatterNatural'));
});
