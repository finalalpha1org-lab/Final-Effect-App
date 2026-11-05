import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8'),bridge=readFileSync('fe-cpp-engine.js','utf8');
test('viewport governor preserves stable native pixel density',()=>{
 const start=bridge.indexOf('tickPerformanceGovernor() {'),end=bridge.indexOf('const perfStats',start),code=bridge.slice(start,end);
 /* The kernel's `recDpr` is a recommendation, not a command: a phone that
    reports three device pixels per CSS pixel used to be told `clamp(3, 1, 2)`,
    which is nine device pixels per CSS pixel, and that is the slow, smeared
    viewport the users reported. The tier is now a ceiling and the governor
    climbs to it from a floor. */
 assert.ok(!code.includes('eng.r.setPixelRatio(recDpr)'),'the recommendation must not set the ratio');
 assert.match(code,/const ceilings = window\.__feHighRefresh\s*\?\s*\[1\.5, 1, 1\.25, 1\.5\]\s*:\s*\[Math\.min\(native, 2\), 1, 1\.5, Math\.min\(native, 3\)\]/,
   'Low 1x, Medium 1.25x, High 1.5x, Auto up to the device ratio or 2x');
 assert.match(code,/const floors = window\.__feHighRefresh\s*\?\s*\[1, 1, 1, 1\]/,
   'and where each tier stops giving ground');
 assert.match(code,/goal = Math\.min\(native, ceiling, curPr \+ 0\.25\)/,'climbing stops at the device ratio and the ceiling');
 assert.ok(code.includes('if (goal !== curPr && Math.abs(goal - curPr) >= 0.05)'),'a resize has to be a real change');
 assert.ok(code.includes('eng.r.setPixelRatio(goal)'),'the governor is the one writer');
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
