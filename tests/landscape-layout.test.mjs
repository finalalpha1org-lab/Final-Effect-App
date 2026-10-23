import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync('index.html','utf8');
const terrain = readFileSync('Terrain_system_.html','utf8');

/* The landscape layer is additive: it must never replace the portrait
   bottom-sheet model, only re-dock it on short wide viewports. */
function landscapeBlock(source){
  const start = source.indexOf('@media (orientation: landscape) and (max-height: 620px)');
  assert.notEqual(start,-1,'landscape media query is missing');
  let depth = 0, started = false;
  for(let i = start; i < source.length; i++){
    const ch = source[i];
    if(ch === '{'){ depth++; started = true; }
    else if(ch === '}'){ depth--; if(started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('landscape media query is not closed');
}

const block = landscapeBlock(html);

test('the portrait layout is untouched and still uses scrollable bottom sheets',()=>{
  assert.ok(html.includes('.render-modal-backdrop{align-items:flex-end'),'the bottom-sheet backdrop must stay the default');
  assert.ok(html.includes('height:62dvh;max-height:72dvh'),'the portrait modal height must stay pinned');
  assert.ok(html.includes('#camera-sheet {' )&&html.includes('height: 50vh'),'the camera sheet keeps its portrait geometry');
});

test('landscape compacts studio chrome so the viewport stays usable',()=>{
  for(const rule of ['.top-bar {','.layer-bar {','.toolbar {','.timeline-bar {','.timeline-bar.minimized {']){
    assert.ok(block.includes(rule),`missing landscape chrome rule ${rule}`);
  }
  assert.ok(/\.layer-bar \{[^}]*height: 34px/.test(block),'the layer bar shrinks in landscape');
  assert.ok(/\.timeline-bar \{[^}]*height: 58px/.test(block),'the timeline bar shrinks in landscape');
  assert.ok(/\.timeline-bar\.minimized \{[^}]*height: 28px/.test(block),'the minimized timeline shrinks in landscape');
});

test('every studio sheet docks to the right edge in landscape',()=>{
  for(const id of ['camera-sheet','light-sheet','modifiers-sheet','animation-sheet','landscape-sheet','import-3d-sheet','add-3d-sheet']){
    assert.ok(block.includes(`#${id}`),`${id} must be re-docked in landscape`);
  }
  const sheetRule = block.slice(block.indexOf('#camera-sheet,'), block.indexOf('#camera-sheet-body'));
  assert.ok(sheetRule.includes('left: auto'),'docked sheets release the left edge');
  assert.ok(sheetRule.includes('right: 0'),'docked sheets hug the right edge');
  assert.ok(sheetRule.includes('top: 0')&&sheetRule.includes('bottom: 0'),'docked sheets span the full height');
  assert.ok(sheetRule.includes('width: min(430px, 48vw)'),'docked sheets keep half the canvas visible');
  assert.ok(sheetRule.includes('border-radius: 14px 0 0 14px'),'docked sheets round the outer edge only');
  assert.ok(/grid-template-columns: 1fr/.test(block),'the modifier sheet stacks to one column in a narrow panel');
});

test('full-height panels replace percentage-height modal cards in landscape',()=>{
  assert.ok(block.includes('.render-modal-backdrop { align-items: stretch'),'the modal backdrop stops bottom-aligning in landscape');
  assert.ok(/\.render-modal-window \{[^}]*width: min\(560px, 56vw\) !important/.test(block),'render and settings cards dock right');
  assert.ok(/\.render-modal-window \{[^}]*height: 100%/.test(block),'modal cards take the full height');
  assert.ok(/\.global-settings-card \{[^}]*min-height: 0/.test(block),'the settings card no longer overflows a short viewport');
  assert.ok(/\.global-settings-card \{[^}]*max-height: 100%/.test(block),'the settings card is capped by the viewport, not 92vh');
  assert.ok(block.includes('.global-settings-body { grid-template-columns: 1fr'),'settings stack to one column in landscape');
  assert.ok(/\.render-canvas-stage \{[^}]*max-height: 26dvh/.test(block),'the render preview shrinks to fit a short panel');
});

test('landscape honours the notch and home layout',()=>{
  assert.ok(block.includes('env(safe-area-inset-left, 0px)'),'the left safe area is respected');
  assert.ok(block.includes('env(safe-area-inset-right, 0px)'),'the right safe area is respected');
  assert.ok(/#home-grid \{ grid-template-columns: repeat\(auto-fit, minmax\(240px, 1fr\)\)/.test(block),'the home grid adapts to landscape');
});

test('the landscaping studio docks its panels in landscape too',()=>{
  const studio = landscapeBlock(terrain);
  assert.ok(studio.includes('#panel, #exploreSheet'),'studio panels share one docking rule');
  assert.ok(studio.includes('transform: translateX(calc(100% + 24px))'),'the explore sheet slides in from the right');
  assert.ok(studio.includes('#exploreSheet.open { transform: none; }'),'the open state clears the slide transform');
  assert.ok(studio.includes('body.explore-heli:not(.explore-compact) #exJoystick'),'the joystick keeps a reachable position');
});
