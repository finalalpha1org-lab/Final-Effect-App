import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8'),bridge=readFileSync('fe-cpp-engine.js','utf8');
test('viewport governor preserves stable native pixel density',()=>{
 const start=bridge.indexOf('tickPerformanceGovernor() {'),end=bridge.indexOf('const perfStats',start),code=bridge.slice(start,end);
 assert.ok(code.includes('eng.r.setPixelRatio(sharpDpr)'));
 assert.ok(!code.includes('eng.r.setPixelRatio(recDpr)'));
 assert.ok(code.includes('Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)'));
});
test('render and diagnostics use bounded scrollable bottom sheets without the home install CTA',()=>{
 assert.ok(html.includes('.render-modal-backdrop{align-items:flex-end'));
 assert.ok(html.includes('height:62dvh;max-height:72dvh'));
 assert.ok(html.includes('.render-controls-pane{overflow:visible;flex:none}'));
 assert.ok(html.includes('id="render-engine-modal"'));
 assert.ok(!html.includes('<button class="install-app-btn pwa-install-btn"'));
 assert.ok(bridge.includes('class="diagnostics-body"'));
});
test('device diagnostic governor measurement starts from an isolated sample window',()=>{
 assert.ok(bridge.includes('exp.fe_perf_reset();\n    exp.fe_perf_push_frame_ms(16.2);'));
 assert.ok(bridge.includes('FECppEngine.lastFrameTick = performance.now()'));
});
