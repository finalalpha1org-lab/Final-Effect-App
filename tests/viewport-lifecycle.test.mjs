import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync('index.html','utf8');
test('a studio screen is a real viewport, not an embedded page',()=>{
 /* The only studio that embedded a page was the Landscaping Studio. With it
    gone the shell must not keep an iframe path that no studio uses: a hidden
    second lifecycle is how the loop silently stopped running before. */
 assert.ok(!html.includes('frame-${id}'),'no studio screen builds an iframe');
 assert.ok(!html.includes("type:'FE_STUDIO_ACTIVE'"),'no studio-to-shell lifecycle messages remain');
 assert.ok(!/querySelectorAll\('iframe'\)/.test(html),'settings are not broadcast to frames');
 assert.ok(html.includes("if(!mounted.has(id)){mounted.add(id);e.mount?."),'mount still runs once per screen');
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
