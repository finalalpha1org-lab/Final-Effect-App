import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8'),bridge=readFileSync('fe-cpp-engine.js','utf8');

test('viewport chrome never advertises the engine implementation',()=>{
 const markup=html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
 assert.ok(!/C\+\+20|C\+\+|WASM|Rust\//.test(markup),'rendered markup must not name the engine stack');
 assert.ok(!html.includes('id="tb-cpp-badge"'),'the old engine badge is gone from the timeline bar');
 assert.ok(!html.includes('🧪 Test C++')&&html.includes('🧪 Run Benchmark'),'the benchmark entry point uses a neutral label');
 assert.ok(html.includes('<span id="tb-status-badge">Physics: starting…</span>'));
 assert.ok(!bridge.includes('C++ Engine ·')&&!bridge.includes('tb-cpp-badge'));
});

test('the workspace gear opens a scrollable viewport settings sheet with live FPS',()=>{
 assert.ok(html.includes('onclick="openWorkspaceSettings()"'),'the header gear must open the settings sheet');
 assert.ok(html.includes('id="workspace-settings-sheet"')&&html.includes('class="render-modal-backdrop"'));
 assert.ok(html.includes('<div id="ws-perf-fps">--</div>')||html.includes('<span id="ws-perf-fps">--</span>'));
 for(const id of ['ws-perf-fps','ws-perf-ms','ws-perf-tier','ws-perf-dpr','ws-quality','ws-grid','ws-shadows','ws-gizmo','ws-exposure','ws-sensitivity'])assert.ok(html.includes(`id="${id}"`),`missing ${id}`);
 assert.ok(html.includes('overflow-y:auto;flex:1;min-height:0'),'the sheet body scrolls inside the bottom sheet');
 assert.ok(html.includes("forward('ws-quality', 'set-gpu-tier', 'change')"),'quality tier reuses the existing governor setting');
 assert.ok(bridge.includes('window.FEWorkspacePerf = perfStats')&&bridge.includes('window.fepdateWorkspacePerf?.(perfStats)'),'FPS is published from the governor metrics');
});

function sheetHarness(){
 const ids=['workspace-settings-sheet','ws-perf-fps','ws-perf-ms','ws-perf-tier','ws-perf-dpr','ws-quality','ws-grid','ws-shadows','ws-gizmo','ws-exposure','ws-exposure-val','ws-sensitivity','ws-sensitivity-val','set-grid','set-shadows','set-gizmo','set-gpu-tier','set-exposure','set-sensitivity'];
 const els=new Map(ids.map(id=>[id,{id,textContent:'',value:'',checked:false,hidden:true,type:id.startsWith('ws-')&&['ws-grid','ws-shadows','ws-gizmo'].includes(id)?'checkbox':'text',addEventListener(){}}]));
 const document={getElementById:id=>els.get(id)||null,addEventListener(){}};
 const FE={engines:{core:{oc:{rotateSpeed:1.2}}},toast(){}};
 const window={renderer:{toneMappingExposure:1.4}};
 const ctx=vm.createContext({document,FE,window,console,Math,String,Number,Event:class Event{constructor(t){this.type=t}}});
 const src=html.slice(html.indexOf('const WS_TIERS'),html.indexOf('function initWorkspaceSettingsEvents'));
 vm.runInContext(src,ctx);
 return {window,els};
}
test('opening the sheet mirrors the current viewport settings and FPS',()=>{
 const {window,els}=sheetHarness();
 els.get('set-grid').checked=true;els.get('set-shadows').checked=false;els.get('set-gizmo').checked=true;
 els.get('set-gpu-tier').value='2';
 window.FEWorkspacePerf={fps:57.6,avgMs:17.35,tier:2,tierLabel:'High',dpr:2,shadowRes:2048};
 window.openWorkspaceSettings();
 assert.equal(els.get('workspace-settings-sheet').hidden,false);
 assert.equal(els.get('ws-perf-fps').textContent,'58');
 assert.equal(els.get('ws-perf-ms').textContent,'17.4 ms');
 assert.equal(els.get('ws-perf-tier').textContent,'High');
 assert.equal(els.get('ws-perf-dpr').textContent,'2.00x');
 assert.equal(els.get('ws-quality').value,'2');
 assert.equal(els.get('ws-grid').checked,true);
 assert.equal(els.get('ws-shadows').checked,false);
 assert.equal(els.get('ws-exposure').value,1.4);
 assert.equal(els.get('ws-sensitivity').value,1.2);
});
test('live FPS updates only while the sheet is open and stops after closing',()=>{
 const {window,els}=sheetHarness();
 window.openWorkspaceSettings();
 window.fepdateWorkspacePerf({fps:29.4,avgMs:34.01,tier:0,tierLabel:'Low',dpr:1.5});
 assert.equal(els.get('ws-perf-fps').textContent,'29');
 assert.equal(els.get('ws-perf-tier').textContent,'Low');
 window.closeWorkspaceSettings();
 window.fepdateWorkspacePerf({fps:60,avgMs:16.67,tier:2,tierLabel:'High',dpr:2});
 assert.equal(els.get('ws-perf-fps').textContent,'29','a closed sheet must not keep repainting');
 assert.equal(window.FEWorkspacePerf.fps,60,'latest metrics stay available for the next open');
});

test('the sheet offers a hard refresh so a stale installed build can update',()=>{
 assert.ok(html.includes('onclick="refreshAppCache()"'),'the sheet needs an update action');
 assert.ok(html.includes('window.refreshAppCache = refreshAppCache'));
 assert.ok(html.includes('id="ws-build-stamp"'),'the loaded build must be visible');
 assert.ok(/caches\.keys\(\)/.test(html)&&/serviceWorker\.getRegistrations\(\)/.test(html),'update clears caches and registrations');
 const sw=readFileSync('sw.js','utf8');
 assert.ok(sw.includes("'final-effect-cpp-v7'"),'bump the cache name whenever the shipped shell changes');
 assert.ok(!sw.includes("'final-effect-cpp-v6'"),'the previous cache name must be retired, not kept alongside');
 for(const file of ['fe_core_engine.wasm','terrain-main-01.js','terrain-main-09.js','open-world-generator.js','open-world.js'])assert.ok(sw.includes(`'./${file}'`),`the service worker must cache ${file}`);
});
