import { readFileSync } from 'node:fs';
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync('./fe_core_engine.wasm')), {});
// a profile: a vertical line of 5 points at x=1 (as a thin quad strip so it has edges)
const P=[], I=[];
for (let k=0;k<5;k++){ P.push(1, k*0.25, 0); }
// a strip of 4 triangles needs 5 verts shared: make quads degenerating to a line is invalid;
// use a thin ribbon: 2 columns of points
const P2=[], I2=[];
for (let k=0;k<5;k++){ P2.push(1,k*0.25,0, 1,k*0.25,0.01); }
for (let k=0;k<4;k++){ const a=k*2,b=k*2+1,c=(k+1)*2,d=(k+1)*2+1; I2.push(a,c,b, b,c,d); }
const v=P2.length/3, t=I2.length/3;
function run(angle, ofs, iters, steps, axis, merge, label){
  exports.fe_mod_begin(4000, 4000, 0);
  new Float32Array(exports.memory.buffer, exports.fe_mod_in_pos_ptr(), P2.length).set(P2);
  new Uint32Array(exports.memory.buffer, exports.fe_mod_in_idx_ptr(), I2.length).set(I2);
  exports.fe_mod_set_counts(v,t);
  const rc = exports.fe_mod_screw(angle*Math.PI/180, ofs, iters, steps, axis, merge, 0.0001, 0);
  const c = new Uint32Array(exports.memory.buffer, exports.fe_mod_counts_ptr(), 2);
  const out = new Float32Array(exports.memory.buffer, exports.fe_mod_in_pos_ptr(), c[0]*3);
  let maxR=0, maxY=-9, minY=9;
  for(let i=0;i<c[0];i++){ maxR=Math.max(maxR, Math.hypot(out[i*3], out[i*3+2])); maxY=Math.max(maxY,out[i*3+1]); minY=Math.min(minY,out[i*3+1]); }
  console.log(label, 'rc', rc, 'v', c[0], 't', c[1], 'max radius', maxR.toFixed(3), 'y', minY.toFixed(2), maxY.toFixed(2));
}
run(360, 0, 1, 8, 1, 0, 'full turn, 8 steps     ');
run(360, 0, 1, 8, 1, 1, 'full turn + merge      ');
run(90, 0, 1, 4, 1, 0, 'quarter turn           ');
run(360, 0.5, 1, 8, 1, 0, 'helix (screw 0.5)      ');
run(360, 0, 2, 4, 1, 0, 'iterations 2           ');
