import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html = readFileSync('index.html','utf8');
const bridge = readFileSync('fe-cpp-engine.js','utf8');
const simulation = readFileSync('simulationCore.js','utf8');

function removalHarness({exists = true, siblings = 1} = {}){
  const state = {badgeRemoved:false};
  const host = { childElementCount: siblings, removed:false, remove(){ this.removed = true; } };
  let badge = null;
  if (exists) {
    badge = {
      id:'tb-status-badge',
      textContent:'Physics: C++/WASM v3 ready',
      closest(){ return host; },
      remove(){ state.badgeRemoved = true; }
    };
  }
  const document = { getElementById: id => (id === 'tb-status-badge' ? badge : null) };
  const ctx = vm.createContext({ window:{}, document, console, String, Number, Math });
  const start = html.indexOf('function removePhysicsBadgeFromDom');
  const end = html.indexOf('removePhysicsBadgeFromDom();', start) + 'removePhysicsBadgeFromDom();'.length;
  vm.runInContext(html.slice(start,end), ctx);
  return { host, state };
}

test('the viewport renders no solver or readiness pill at all',()=>{
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
  assert.ok(!markup.includes('tb-status-badge'), 'no badge element ships in the timeline header');
  assert.ok(!markup.includes('timeline-right-info'), 'the badge container is gone too');
  assert.ok(!/#tb-status-badge\s*\{/.test(html), 'its styling is removed, not orphaned');
  assert.ok(!/Physics:ready|Physics: ready|Physics: starting/.test(markup), 'the header carries no readiness text');
  assert.ok(!/C\+\+20|C\+\+|WASM|Rust\//.test(markup), 'rendered markup never names the engine stack');
});

test('an installed shell with the old pill is cleaned up on boot',()=>{
  const solo = removalHarness({exists:true, siblings:1});
  assert.equal(solo.host.removed, true, 'a container holding only the pill is removed');

  const shared = removalHarness({exists:true, siblings:3});
  assert.equal(shared.state.badgeRemoved, true, 'a shared container keeps its other children, the pill goes');

  const clean = removalHarness({exists:false});
  assert.equal(clean.host.removed, false, 'a clean page is left alone');
  assert.ok(html.includes('window.removePhysicsBadgeFromDom = removePhysicsBadgeFromDom'));
});

test('the solver bridge no longer writes status text into the page',()=>{
  assert.ok(simulation.includes("getElementById?.('tb-status-badge')"), 'the bridge only looks the id up to delete it');
  assert.ok(!/badge\.textContent\s*=/.test(simulation), 'nothing writes badge text any more');
  assert.ok(simulation.includes("backendLabel: this.isCppBackend ? 'C++20/WASM v3"), 'solver details stay in diagnostics');
  assert.ok(bridge.includes('document.body.dataset.engineReady'), 'engine state stays on the body dataset');
  assert.ok(!/tb-status-badge[\s\S]{0,200}(C\+\+|WASM)/.test(bridge), 'the bridge never writes an engine label');
});
