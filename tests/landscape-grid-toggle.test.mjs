import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* The landscaping studio's floor grid is a viewport reference, like Blender's.
   It has to be switchable — a grid you cannot remove is a bug, not a style. */

const panel = readFileSync('terrain-main-07.js', 'utf8');
const core = readFileSync('terrain-main-01.js', 'utf8');

const START = panel.indexOf('let terrainGridOn=');
const END = panel.indexOf('setTerrainGrid(terrainGridOn,false);') + 'setTerrainGrid(terrainGridOn,false);'.length;

function runGrid(store = {}) {
  assert.ok(START > 0 && END > START, 'the grid switch exists');
  const grid = { visible: true, isGridHelper: true };
  const gridAxes = [{ visible: true }, { visible: true }];
  const context = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    grid, gridAxes
  };
  vm.createContext(context);
  vm.runInContext(panel.slice(START, END) + '\nthis.__set = setTerrainGrid; this.__get = () => terrainGridOn;', context);
  return { context, grid, gridAxes, store };
}

test('the studio grid can be switched off, axes included', () => {
  const { context, grid, gridAxes, store } = runGrid();
  assert.equal(grid.visible, true, 'it starts on');
  context.__set(false);
  assert.equal(grid.visible, false, 'the grid goes away');
  assert.deepEqual(gridAxes.map((a) => a.visible), [false, false], 'and so do the two ground axes');
  assert.equal(store.fe_terrain_grid, '0', 'the choice is remembered');

  context.__set(true);
  assert.equal(grid.visible, true);
  assert.deepEqual(gridAxes.map((a) => a.visible), [true, true]);
  assert.equal(store.fe_terrain_grid, '1');
});

test('a remembered choice is applied before the first frame', () => {
  const off = runGrid({ fe_terrain_grid: '0' });
  assert.equal(off.context.__get(), false, 'the switch restores as off');
  assert.equal(off.grid.visible, false, 'and the grid is already hidden');
  assert.ok(!('fe_terrain_grid' in off.store) || off.store.fe_terrain_grid === '0', 'reading does not rewrite the choice');

  const on = runGrid({ fe_terrain_grid: '1' });
  assert.equal(on.grid.visible, true);
});

test('the parent app’s Floor Grid setting reaches the studio', () => {
  const handler = panel.slice(panel.indexOf("window.addEventListener('message'"), panel.indexOf("else if(d.type==='FE_HISTORY_ACTION'"));
  assert.match(handler, /d\.settings\.grid/, 'the message carries the grid state');
  assert.match(handler, /setTerrainGrid\(d\.settings\.grid,false\)/, 'and the studio applies it');
  assert.match(handler, /tab==='terrain'/, 'rebuilding the open sheet so the chip follows');
});

test('the Terrain sheet has the switch, and the axes are tracked', () => {
  assert.match(panel, /chips\(\[\['grid','Floor grid'\]\]/, 'the chip is in the sheet');
  assert.match(panel, /terrainGridOn\?'grid':''/, 'and shows whether the grid is on');
  assert.match(core, /const gridAxes=\[\];/, 'the ground axes are kept, so they can be hidden with the grid');
  assert.match(core, /gridAxes\.push\(l\)/, 'the axis lines end up in that list');
});
