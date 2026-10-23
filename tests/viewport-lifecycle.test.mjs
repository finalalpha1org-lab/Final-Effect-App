import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync('index.html','utf8');
test('landscape iframe is lazy and studio switches send lifecycle messages',()=>{
 assert.ok(html.includes('data-src="${s.embed}" title='));
 assert.ok(!html.includes('data-src="${s.embed}" src='));
 assert.ok(html.includes("type:'FE_STUDIO_ACTIVE',active:false"));
 assert.ok(html.includes("type:'FE_STUDIO_ACTIVE',active:FE.current===id"));
});
test('repeated resume creates one RAF chain and pause prevents further work',()=>{
 const start=html.indexOf('  resume(){\n    if(this._viewportRunning)'),end=html.indexOf('\n});',start);
 assert.ok(start>0&&end>start);
 const callbacks=new Map();let serial=0,renders=0;
 const context={requestAnimationFrame:f=>{callbacks.set(++serial,f);return serial},cancelAnimationFrame:id=>callbacks.delete(id),document:{hidden:true},performance};
 const engine=vm.runInNewContext('({'+html.slice(start,end)+'})',context);
 engine.resume();engine.resume();assert.equal(callbacks.size,1);
 engine.pause();assert.equal(callbacks.size,0);assert.equal(engine._viewportRunning,false);
 engine.resume();assert.equal(callbacks.size,1);engine.pause();assert.equal(callbacks.size,0);
});
test('profiling distinguishes CPU work from frame interval and GPU submission',()=>{
 for(const key of ['frameIntervalMs','physicsMs','sceneUpdateMs','renderSubmitMs','cpuMs','drawCalls','pixelRatio'])assert.ok(html.includes(key+':'));
 const bridge=readFileSync('fe-cpp-engine.js','utf8');assert.ok(!bridge.includes('requestAnimationFrame(perfLoop)'));
});
test('landscape loop pauses offscreen and does not accumulate hidden-tab delta',()=>{
 const source=readFileSync('terrain-main-09.js','utf8');new vm.Script(source);
 assert.ok(source.includes('if(!landscapeActive||document.hidden)return'));
 assert.ok(source.includes('cancelAnimationFrame(landscapeRaf)'));
 assert.ok(source.includes('pt=performance.now();scheduleLandscapeFrame()'));
});
