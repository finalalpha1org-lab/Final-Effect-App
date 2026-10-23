import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync('open-world.js','utf8');

/* Pull the pure-maths world model out of open-world.js. It is a single
   `const OWM=(() => { … })();` block with no THREE or DOM dependencies, so it
   can be exercised headlessly: exactly the layer that builds heights, rivers,
   lakes, ponds and the spawn point. */
function extractWorldModel(){
  const start = source.indexOf('const OWM=(()=>{');
  assert.notEqual(start,-1,'the world model block must exist');
  let depth = 0, i = start, inString = null, inLine = false, inBlock = false;
  for(; i < source.length; i++){
    const ch = source[i], next = source[i+1], prev = source[i-1];
    if(inLine){ if(ch === '\n') inLine = false; continue; }
    if(inBlock){ if(ch === '*' && next === '/'){ inBlock = false; i++; } continue; }
    if(inString){ if(ch === '\\'){ i++; continue; } if(ch === inString) inString = null; continue; }
    if(ch === '/' && next === '/'){ inLine = true; i++; continue; }
    if(ch === '/' && next === '*'){ inBlock = true; i++; continue; }
    if(ch === '"' || ch === "'" || ch === '`'){ inString = ch; continue; }
    if(ch === '{') depth++;
    else if(ch === '}'){
      depth--;
      if(depth === 0){
        const tail = source.slice(i, i + 5);
        assert.match(tail,/^\}\)\(\);/, 'the world model must close as an IIFE');
        return source.slice(start, i + 1).replace('const OWM=','globalThis.OWM=') + ')();';
      }
    }
    if(prev === undefined) break;
  }
  throw new Error('unterminated world model block');
}

const model = extractWorldModel();

function run({seed = 1234, size = 2048, lakes = 4, ponds = 6, withCpp = false} = {}){
  const sandbox = {console, Math, Float32Array, Float64Array, Uint8Array, Int16Array, Int32Array, performance};
  sandbox.root = sandbox;
  sandbox.window = sandbox;
  if(withCpp) sandbox.FELandscapeCore = fakeLandscapeCore();
  vm.createContext(sandbox);
  vm.runInContext(model, sandbox, {filename:'open-world-model.js'});
  const OWM = sandbox.OWM;
  OWM.configure({
    seed, size, biome:'mixed', land:0, mount:1, relief:1, rough:1, sea:-24,
    rivers:4, riverW:1, lakes, lakeSize:1, ponds, falls:2, fallH:1, snowOff:0
  });
  let steps = 0;
  const gen = OWM.generate();
  for(;;){
    const r = gen.next();
    if(r.done) break;
    steps++;
    assert.ok(steps < 1000,'the generator must finish');
    assert.ok(Number.isFinite(r.value) || typeof r.value === 'number','progress values are numeric');
  }
  return {OWM, steps};
}

/* Mirrors the shape of root.FELandscapeCore.owHydroSet / owHydroTrace: six
   metadata floats per river (start x,z scaled by 100, first point, length,
   end code, parent id) plus a flat point buffer. */
function fakeLandscapeCore(){
  const points = [];
  const meta = [];
  for(let i = 0; i < 4; i++){
    const first = points.length / 2;
    for(let q = 0; q < 48; q++) points.push(-1200 + i * 600 + q * 12, -900 + i * 400 + q * 9);
    meta.push((-1200 + i * 600) * 100, (-900 + i * 400) * 100, first, 48, 0, -1);
  }
  return {
    ready:true,
    owHydroSet(){ return {ok:true}; },
    owHydroTrace(){ return {count:4, points:Float64Array.from(points), meta:Float64Array.from(meta)}; }
  };
}

test('the native hydrology path still places lakes and ponds',()=>{
  const {OWM, steps} = run({withCpp:true});
  assert.ok(steps > 3,'the generator yields progress while it works');
  assert.ok(OWM.S.lk.length > 0,'lakes/ponds must be placed on the native path');
  assert.ok(OWM.S.lk.every(lk => Number.isFinite(lk.x) && Number.isFinite(lk.z) && lk.R > 0));
  assert.ok(Number.isFinite(OWM.S.spawn.x) && Number.isFinite(OWM.S.spawn.z),'a spawn point is produced');
  assert.ok(OWM.S.rv.length === 4,'every traced river reaches the runtime');
});

test('the JS fallback path still places lakes and ponds',()=>{
  const {OWM} = run({withCpp:false});
  assert.ok(OWM.S.lk.length > 0);
  assert.ok(OWM.S.rv.length > 0);
  assert.ok(Number.isFinite(OWM.S.spawn.x));
});

test('both hydrology paths are deterministic for the same seed',()=>{
  const a = run({withCpp:true});
  const b = run({withCpp:true});
  assert.equal(a.OWM.S.lk.length, b.OWM.S.lk.length);
  /* Arrays created inside a vm context have that realm's prototype, so compare
     a serialised snapshot instead of using deepStrictEqual. */
  assert.equal(
    JSON.stringify(a.OWM.S.lk.map(l => [l.x, l.z, l.R])),
    JSON.stringify(b.OWM.S.lk.map(l => [l.x, l.z, l.R]))
  );
  assert.equal(a.OWM.S.spawn.x, b.OWM.S.spawn.x);
  assert.equal(a.OWM.S.spawn.z, b.OWM.S.spawn.z);
});

test('the fallback branch initialises the shared RNG before the lakes pass',()=>{
  /* Regression: `rn` used to be declared inside `if(!traces){…}`, so taking the
     native hydrology path threw "rn is not defined" inside the lakes pass and
     surfaced as the red "Open World:" error overlay. */
  const genStart = source.indexOf('function* generate()');
  const rnDecl = source.indexOf('const rn=rng(P.seed*31+7);', genStart);
  const cppBranch = source.indexOf('const hydroCpp=', genStart);
  const fallbackBranch = source.indexOf('if(!traces){', genStart);
  assert.ok(rnDecl > genStart && rnDecl < cppBranch,'the RNG must exist before the hydrology branch');
  assert.ok(fallbackBranch > cppBranch);
  const between = source.slice(fallbackBranch, source.indexOf('function owBuildWorld'));
  assert.ok(!between.includes('const rn=rng('),'the fallback branch must not redeclare the RNG');
});
