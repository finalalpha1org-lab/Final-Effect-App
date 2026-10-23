import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appPath } from './app-paths.mjs';

const html = readFileSync(appPath('index.html'), 'utf8');
const bridge = readFileSync(appPath('src/modifier-geometry.mjs'), 'utf8');

function sliceFunction(name) {
  const start = html.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const next = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

test('every advanced modifier setting is declared and routed into the evaluator', () => {
  const registry = html.slice(html.indexOf('const modifiersData = {'), html.indexOf('\nlet modStack'));
  const labels = ['Rotation Per Step', 'Preserve Boundaries', 'Merge Distance', 'Rim Fill', 'Even Thickness', 'Size', 'Direction', 'Octaves', 'Seed', 'Preserve Volume', 'Boundary', 'Axis', 'Phase'];
  for (const label of labels) {
    let at = -1, marked = false;
    while ((at = registry.indexOf(`["${label}","`, at + 1)) >= 0) {
      const marker = registry.indexOf('{advanced:true}]', at);
      const nextField = registry.indexOf('],["', at);
      if (marker > at && (nextField < 0 || marker < nextField)) { marked = true; break; }
    }
    assert.ok(marked, `${label} is declared as an advanced setting`);
  }

  const live = sliceFunction('updateModifiersOnScene');
  for (const anchor of [
    'parseFloat(p["Rotation Per Step"] ?? 0)',
    'p["Preserve Boundaries"] !== false',
    'parseFloat(p["Merge Distance"] ?? 1e-6)',
    'p["Rim Fill"] !== false, p["Even Thickness"] !== false',
    'parseFloat(p["Size"] ?? 1)',
    'direction: p["Direction"] || "Normal"',
    'octaves: parseInt(p["Octaves"]',
    'seed: parseInt(p["Seed"]',
    'axis: p["Axis"] || "Y"',
    'preserveVolume: p["Preserve Volume"] === true',
    'applyWarpModifier(currentGeo, str, p["Axis"] || "Y")'
  ]) {
    assert.ok(live.includes(anchor), `live evaluation passes ${anchor}`);
  }

  const baked = sliceFunction('evaluateModifierPrefix');
  for (const anchor of ['Rotation Per Step', 'Preserve Boundaries', 'Merge Distance', 'Rim Fill', 'Direction', 'Octaves', 'Phase', 'Preserve Volume']) {
    assert.ok(baked.includes(anchor), `baking keeps the ${anchor} setting`);
  }
});

test('advanced settings render in a collapsed section instead of the main card', () => {
  const render = html.slice(html.indexOf('function renderModifierStack'), html.indexOf('function openModifiersModal'));
  assert.match(render, /advancedWrap\.style\.display = "none"/);
  assert.match(render, /advancedMarker && advancedMarker\.advanced/);
  assert.match(render, /⚙ Advanced Settings/);
  assert.match(render, /advancedWrap\.childElementCount/);
});

test('geometry modifiers dispatch to the C++ session before the JS reference path', () => {
  for (const kernel of ['fe_mod_weld', 'fe_mod_smooth', 'fe_mod_mirror', 'fe_mod_solidify',
    'fe_mod_displace', 'fe_mod_wave', 'fe_mod_cast', 'fe_mod_twist', 'fe_mod_array',
    'fe_mod_subdivide', 'fe_mod_decimate']) {
    assert.ok(bridge.includes(kernel), `the bridge calls ${kernel}`);
  }
  assert.match(bridge, /const cppExports = \(\) => \{[\s\S]*?globalThis\.FECppEngine/);
  assert.match(bridge, /if \(call\(exp\) !== 0\) return null/);
  assert.match(bridge, /name !== 'position' && name !== 'normal' && name !== 'uv'/);
});

test('the C++ core exports the modifier session and kernels the bridge needs', () => {
  const abi = readFileSync(appPath('cpp/include/fe_abi.h'), 'utf8');
  for (const name of ['fe_mod_begin', 'fe_mod_counts_ptr', 'fe_mod_in_pos_ptr', 'fe_mod_in_uv_ptr',
    'fe_mod_in_idx_ptr', 'fe_mod_normals_ptr', 'fe_mod_set_counts', 'fe_mod_weld', 'fe_mod_smooth',
    'fe_mod_mirror', 'fe_mod_solidify', 'fe_mod_displace', 'fe_mod_wave', 'fe_mod_cast',
    'fe_mod_twist', 'fe_mod_array', 'fe_mod_subdivide', 'fe_mod_decimate']) {
    assert.ok(abi.includes(name), `fe_abi.h declares ${name}`);
  }
  const build = readFileSync(appPath('scripts/build-cpp-wasm.mjs'), 'utf8');
  assert.ok(build.includes("'cpp/src/fe_modifiers.cpp'"));
  assert.ok(build.includes("'fe_mod_begin'"));
  const wasm = readFileSync(appPath('fe_core_engine.wasm'));
  const exported = new Set(WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map(e => e.name));
  assert.ok(exported.has('fe_mod_begin'), 'the shipped wasm exports the session');
  assert.ok(exported.has('fe_mod_subdivide'), 'the shipped wasm exports subdivision');
});
