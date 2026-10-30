import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* Two ways a species silently disappears from a world:
 *
 *   1. its placement gate asks for a ground material the palette can never
 *      return, so `add()` rejects every candidate and the species is simply
 *      absent - no error, no warning, just a world with fewer plants than the
 *      density table promises;
 *   2. the gate is right but nothing in the biome's table ever selects it.
 *
 * `mIdx()` is the only source of that material index, and it returns 0-4:
 * 0 grass, 1 dirt, 2 rock, 3 sand, 4 snow. A gate that tests `m===5` can never
 * be true. The jungle palm branch did exactly that, and otherwise allowed only
 * rock and snow, which is how the species holding most of the jungle's tree
 * budget never appeared on the jungle floor.
 *
 * These tests read the shipped gates and prove every material comparison is
 * inside the range the palette can produce. */

const scene = readFileSync('terrain-main-01.js', 'utf8');
const scatter = readFileSync('terrain-main-03.js', 'utf8');

/** The material indices `mIdx` can actually return. */
function paletteRange() {
  const at = scene.indexOf('function mIdx(');
  assert.ok(at > 0, 'mIdx is missing');
  const body = scene.slice(at, scene.indexOf('\n}', at));
  const returned = [...body.matchAll(/return (\d+)(?![.\d])/g)].map((m) => Number(m[1]));
  assert.ok(returned.length >= 3, 'mIdx must return material indices');
  return { min: Math.min(...returned), max: Math.max(...returned), values: [...new Set(returned)].sort() };
}

/** Comments are not code: a gate mentioned inside one is not a gate. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The `add()` placement gate, exactly as shipped, with its commentary removed. */
function addGate() {
  const at = scatter.indexOf('function add(k,x,z');
  assert.ok(at > 0, 'add() is missing');
  return stripComments(scatter.slice(at, scatter.indexOf('\nconst RATE=', at)));
}

test('mIdx only produces grass, dirt, rock, sand and snow', () => {
  const range = paletteRange();
  assert.deepEqual(range.values, [0, 1, 2, 3, 4],
    `mIdx returns ${range.values.join(',')}; every placement gate is written against this set`);
});

test('every material comparison in the placement gate can be true', () => {
  const { min, max } = paletteRange();
  const gate = addGate();
  const compared = [...gate.matchAll(/\bm\s*===\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(compared.length >= 1, 'the gate must test the material index');
  for (const value of compared) {
    assert.ok(value >= min && value <= max,
      `a gate compares m===${value}, but mIdx never returns it (range ${min}-${max})`);
  }
});

test('palms grow on grass and sand, never on rock', () => {
  const gate = addGate();
  const palm = /k=='palm'\?\(([^)]*)\)/.exec(gate);
  assert.ok(palm, 'the palm branch must exist');
  const allowed = [...palm[1].matchAll(/m===(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(allowed.sort(), [0, 3],
    `palms must take grass (0) and sand (3); got ${allowed.join(',')}`);
  /* The dead jungle branch is the failure this test exists for. */
  assert.equal(/m===\s*5/.test(gate), false, 'a gate still tests a material index that cannot exist');
});

test('a biome only spends its budget on species it declares', () => {
  /* BSP is the roster a biome announces (the plant brush falls back through it),
     BTAB is where that biome's density budget goes. A species in the budget but
     not in the roster is spending plants on something the biome does not list -
     invisible in the palette, visible in the world. Volc spent 1% of its budget
     on tulips it never declared. */
  const at = scatter.indexOf('const BSP={');
  const bt = scatter.indexOf('const BTAB=');
  assert.ok(at > 0 && bt > 0, 'the biome tables are missing');
  const parse = (text) => {
    const out = {};
    for (const [, biome, body] of text.matchAll(/(\w+):\[((?:['\w,]+))\]/g)) {
      out[biome] = [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    }
    return out;
  };
  const roster = { ...parse(scatter.slice(at, bt)) };
  const budgetSrc = scatter.slice(bt, scatter.indexOf('const LBL=', bt));
  for (const [, biome, body] of budgetSrc.matchAll(/(\w+):\[((?:\[[^\]]*\],?)+)\]/g)) {
    const spent = [...body.matchAll(/\['(\w+)'/g)].map((m) => m[1]);
    const declared = roster[biome];
    assert.ok(declared, `${biome} has no roster`);
    const orphan = spent.filter((k) => !declared.includes(k));
    assert.deepEqual(orphan, [], `${biome} spends budget on undeclared species: ${orphan.join(', ')}`);
  }
});
