import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html = readFileSync('index.html','utf8');
const bridge = readFileSync('fe-cpp-engine.js','utf8');

function badgeHarness(initialText){
  const badge = {textContent:initialText, _observers:[]};
  const document = {
    getElementById: id => (id === 'tb-status-badge' ? badge : null)
  };
  class MutationObserver {
    constructor(cb){ this.cb = cb; this.targets = []; }
    observe(target){ this.targets.push(target); badge._observers.push(this); }
    disconnect(){}
  }
  const ctx = vm.createContext({window:{}, document, MutationObserver, console, String, RegExp});
  const code = html.slice(html.indexOf('function sanitizePhysicsBadge'), html.indexOf('watchPhysicsBadge();') + 'watchPhysicsBadge();'.length);
  vm.runInContext(code, ctx);
  return {badge, ctx};
}

test('an implementation label never survives on the physics badge',()=>{
  const cases = [
    ['Physics: C++/WASM v3 ready','Physics: ready'],
    ['Physics: C++20/WASM v3 (XPBD) ready','Physics: ready'],
    ['Physics · 2 active','Physics · 2 active'],
    ['Physics: starting…','Physics: starting…'],
    ['Physics unavailable','Physics unavailable']
  ];
  for(const [input,expected] of cases){
    const {badge} = badgeHarness(input);
    assert.equal(badge.textContent, expected, `${input} must render as ${expected}`);
    assert.doesNotMatch(badge.textContent, /C\+\+|WASM|WebAssembly|Rust\//, 'no engine names reach the viewport chrome');
  }
});

test('the guard keeps watching the badge after other scripts rewrite it',()=>{
  const {badge} = badgeHarness('Physics: starting…');
  assert.equal(badge._observers.length >= 1, true, 'a MutationObserver is attached');
  badge.textContent = 'Physics: C++/WASM v3 ready';
  badge._observers[0].cb();
  assert.equal(badge.textContent, 'Physics: ready', 'a late write is scrubbed');
});

test('solver internals stay available for diagnostics only',()=>{
  assert.ok(bridge.includes('document.body.dataset.engineReady'), 'engine state stays on the body dataset');
  assert.ok(!/tb-status-badge[\s\S]{0,200}(C\+\+|WASM)/.test(bridge), 'the bridge never writes an engine label');
  assert.ok(html.includes('window.sanitizePhysicsBadge = sanitizePhysicsBadge'));
  assert.ok(html.includes('window.watchPhysicsBadge = watchPhysicsBadge'));
  assert.ok(html.includes('watchPhysicsBadge();'), 'the guard starts with the page');
});
