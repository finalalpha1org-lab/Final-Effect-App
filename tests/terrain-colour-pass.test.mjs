import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* "Terrain colours came back empty from the engine" is the worst kind of
 * failure this studio can show: it is a banner over the artwork, and what it
 * describes is that the colour pass produced nothing, so the page repainted the
 * whole island from the JavaScript palette instead.
 *
 * Two halves are pinned here. The kernel half boots the real artifact and asks
 * for the colours of a real generated island - a pass that writes nothing, or
 * writes black, fails. The page half pins that the fallback stays a fallback:
 * it repaints quietly, and no error banner is raised for it. */

const WASM = 'wasm/fe_core_engine.wasm';
const N = 128, S = 100, W = N + 1;

async function boot() {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  const ex = instance.exports;
  assert.equal(ex.fe_terrain_init(N, S), 0);
  const palPtr = ex.fe_malloc(96);
  /* The hills palette, sRGB, as the page hands it over. */
  const pal = [.28, .50, .16, .42, .29, .17, .42, .42, .44, .64, .56, .38, .92, .94, .98];
  new Float32Array(ex.memory.buffer, palPtr, pal.length).set(pal);
  assert.equal(ex.fe_terrain_set_palette(palPtr, 5, 12345, 0, 1.3, 16, 0), 0);
  assert.equal(ex.fe_terrain_generate_layered(12345, 34, 0, 0, 0), 0);
  return ex;
}

test('the kernel writes the island a real colour for every cell', async () => {
  const ex = await boot();
  const wrote = ex.fe_terrain_compute_colors(0, N, 0, N);
  assert.ok(wrote > 0, `the colour pass reported ${wrote} cells`);
  assert.equal(wrote, W * W, 'every cell of the grid must be shaded, not just a band');
  const colours = new Float32Array(ex.memory.buffer, ex.fe_terrain_get_color_ptr(), W * W * 3);
  let lit = 0, black = 0, bad = 0, greenest = 0;
  for (let i = 0; i < W * W; i++) {
    const r = colours[i * 3], g = colours[i * 3 + 1], b = colours[i * 3 + 2];
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) { bad++; continue; }
    const l = .2126 * r + .7152 * g + .0722 * b;
    if (l > .002) lit++;
    else black++;
    if (g - Math.max(r, b) > greenest) greenest = g - Math.max(r, b);
  }
  assert.equal(bad, 0, 'no cell may hold a NaN or an infinity');
  assert.equal(lit, W * W, `the colour buffer came back empty: ${black} of ${W * W} cells are black`);
  /* Linear light. Grass is the dominant ground, so some cell on a hills island
     has to be actually green rather than three equal greys. */
  assert.ok(greenest > .01, `no cell is green; the strongest green channel lead is ${greenest.toFixed(4)}`);
});

test('the page treats an empty colour pass as a fallback, not as an error banner', () => {
  const page = readFileSync('terrain-main-01.js', 'utf8');
  /* Both colour commands check the result and repaint in JS when it is empty. */
  assert.match(page, /if\(!native\|\|!coloursLookReal\(rx0,rx1,rz0,rz1\)\)for\(let j=rz0;j<=rz1;j\+\+\)/,
    'the full-grid pass falls back to the JS painter');
  assert.match(page, /if\(!core\.colors\(\{[^}]*\}\)\|\|!coloursLookReal\(x0,x1,z0,z1\)\)/,
    'so does the live band pass');
  /* A fallback that shouts is worse than the fallback: nothing here may call
     showErr for a colour miss. */
  const around = page.slice(page.indexOf('function coloursLookReal('), page.indexOf('const HMB_ROWS'));
  assert.equal(/showErr\(/.test(around), false, 'a JS repaint is not an error');
});

test('every biome seeds its own mix of tree species', () => {
  const scatter = readFileSync('terrain-main-03.js', 'utf8');
  const table = scatter.slice(scatter.indexOf('const BTAB='), scatter.indexOf('const LBL='));
  const treeSet = scatter.match(/const TREE_SET=new Set\(\[([^\]]*)\]\)/)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  const speciesIn = (biome) => {
    const at = table.indexOf(biome + ':[');
    assert.ok(at > 0, `${biome} is missing from the scatter table`);
    const body = table.slice(at, table.indexOf(']]', at));
    return treeSet.filter((k) => body.includes(`['${k}',`));
  };
  const expected = {
    hills: ['pine', 'oak', 'birch', 'palm'],
    alpine: ['spruce', 'krumm', 'juniper'],
    desert: ['acacia', 'joshua', 'palm'],
    volc: ['deadtree', 'treefern'],
  };
  for (const [biome, species] of Object.entries(expected)) {
    const seeded = speciesIn(biome);
    for (const kind of species) {
      assert.ok(seeded.includes(kind), `${biome} no longer seeds its ${kind}`);
    }
    assert.ok(seeded.length >= 3, `${biome} seeds only ${seeded.join(', ')}`);
  }
  /* And the tree budget goes to the tree species of the biome, not to whatever
     clears a footprint threshold - alpine used to hold one spruce that way. */
  assert.match(scatter, /big=BTAB\[biome\]\.filter\(\(\[n\]\)=>TREE_SET\.has\(n\)\)/);
  assert.match(scatter, /tab=BTAB\[biome\]\.filter\(\(\[n\]\)=>!TREE_SET\.has\(n\)\)/);
});

test('one species failing cannot empty the wood', () => {
  const scene = readFileSync('terrain-main-01.js', 'utf8');
  const models = readFileSync('terrain-main-02.js', 'utf8');
  assert.match(scene, /function safeSpecies\(n,max,sh,build\)/, 'the per-species guard exists');
  assert.match(scene, /function basicSpecies\(n\)/, 'and it has a correctly shaped stand-in for every kind');
  assert.match(scene, /try\{parts=build\(\)\}catch\(e\)\{console\.warn\('Species '/,
    'a throwing species is contained and reported, not fatal');
  /* Every eager species goes through the guard: the catalogue used to sit in a
     single try/catch, so the first failure took the rest of the world with it. */
  const eager = models.slice(models.indexOf('function buildEager(){'), models.indexOf('buildEager();'));
  const built = [...eager.matchAll(/(?:^|\{|;)\s*(safe|mk)\('([a-z]+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(built.length >= 15, `only ${built.length} species found in buildEager`);
  const unguarded = built.filter(([via]) => via === 'mk');
  assert.deepEqual(unguarded, [], `these species are still outside the guard: ${unguarded.map((m) => m[1]).join(', ')}`);
  /* Lazy species are guarded the same way. */
  assert.match(models, /function lazyBuild\(k\)\{const\[max,fn\]=LZREG\[k\];let parts=null;/);
  assert.match(models, /catch\(e\)\{console\.warn\('Species '\+k\+' geometry failed:'/);
});

test('the foliage sheet no longer carries a grammar editor', () => {
  const panel = readFileSync('terrain-main-07.js', 'utf8');
  assert.ok(!panel.includes('textarea class="grammar"'), 'the rule editor is gone');
  assert.ok(!panel.includes('Apply grammar'), 'and its action');
  assert.ok(!panel.includes('Restore built-in grammar'), 'and its reset');
  assert.ok(!panel.includes('Fern grammar'), 'and its label');
  /* The shape controls stay: they are the part a user asked for. */
  assert.ok(panel.includes("sl('Tree height ×'"));
  assert.ok(panel.includes("sl('Branch density ×'"));
});
