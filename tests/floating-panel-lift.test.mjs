import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The Move / Rotate / Scale sheet is where an object is moved, and it used to
   sit flush on the bottom edge of the phone: the model, the gizmo and the
   floor under them were covered by the panel the user was dragging in. It is
   lifted by a thumb's width now - a small change, not a new layout - and the
   number box beside every slider is readable again. Both are plain stylesheet
   facts, so they are read out of index.html the way the other sheet tests do. */

const html = readFileSync('index.html', 'utf8');

function cssRule(selector) {
  const at = html.indexOf(selector + ' {');
  assert.ok(at > 0, `no stylesheet rule for ${selector}`);
  const open = html.indexOf('{', at);
  const close = html.indexOf('}', open);
  assert.ok(close > open, `the rule for ${selector} is not closed`);
  return html.slice(open + 1, close);
}

test('the transform sheet clears the bottom of the screen', () => {
  const container = cssRule('.floating-panels-container');
  assert.match(container, /position:\s*fixed/);
  assert.ok(!/bottom:\s*0\s*;/.test(container), 'the sheet is still pinned to the bottom edge');

  const bottom = /bottom:\s*([^;]+);/.exec(container)?.[1]?.trim();
  assert.ok(bottom, 'the sheet needs a bottom offset');
  /* Above the home indicator and a further, fixed number of pixels - the
     lift has to survive a phone with and without a safe area, and it has to be
     a real offset rather than the inset alone, or nothing moves on a device
     whose inset is zero. */
  assert.match(bottom, /env\(safe-area-inset-bottom, 0px\)/, 'the home-indicator inset is not accounted for');
  const lift = /\+\s*(\d+(?:\.\d+)?)px\)?$/.exec(bottom);
  assert.ok(lift, `the offset is inset-only, so the sheet does not move: ${bottom}`);
  const pixels = Number(lift[1]);
  assert.ok(pixels >= 24 && pixels <= 72, `a small lift was asked for, not ${pixels}px`);

  /* Lifted off the edge it is a floating card: the square bottom edge it wore
     while it was docked would now look like a torn sheet. */
  const panel = cssRule('.floating-panel');
  assert.match(panel, /border-radius:\s*14px;/, 'the sheet still has its docked, top-only corners');
  assert.ok(!/border-bottom:\s*0/.test(panel), 'the floating card has no bottom border');

  /* The safe-area inset moved from the body's padding to the container, or the
     sheet would reserve the home indicator twice and sit 34px higher on an
     iPhone than on a phone without one. */
  const body = cssRule('.panel-body');
  assert.ok(!/padding:[^;]*env\(safe-area-inset-bottom/.test(body), 'the bottom inset is counted twice');
});

/* The four transform cards are the only sheets the user looks *through* while
   placing an object, and they had no way to grow at all. They now take the
   same grab handle as every other bottom sheet, with a fixed headroom instead
   of a share of the screen. The controller is extracted from index.html and
   run against a DOM stub, so a handle that is listed but never given a height
   fails here rather than on the phone. */
function makePanelDom(natural = 300) {
  const gripBlock = /\/\* ---- FE-SHEET-GRIP ---- \*\/[\s\S]*?\/\* ---- \/FE-SHEET-GRIP ---- \*\//.exec(html)?.[0];
  assert.ok(gripBlock, 'index.html no longer carries the sheet grip controller');
  const listeners = new Map();
  const makeElement = (id) => ({
    id, style: {}, children: [], className: '', height: natural, attributes: {},
    classList: {
      set: new Set(),
      add(...n) { n.forEach((x) => this.set.add(x)); },
      remove(...n) { n.forEach((x) => this.set.delete(x)); },
      contains(n) { return this.set.has(n); },
      toggle(n, force) {
        const on = force === undefined ? !this.set.has(n) : !!force;
        if (on) this.set.add(n); else this.set.delete(n);
        return on;
      }
    },
    get firstChild() { return this.children[0] || null; },
    insertBefore(node, ref) {
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
      /* The controller reads the sheet off the handle (`grip.parentElement`),
         exactly as the browser would. */
      node.parentElement = this;
    },
    querySelector(selector) {
      if (selector === ':scope > .sheet-grip') return this.children.find((c) => c.className === 'sheet-grip') || null;
      return null;
    },
    getBoundingClientRect() { return { height: this.height }; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; }
  });
  const panels = new Map();
  for (const id of ['panel-move', 'panel-rotate', 'panel-scale', 'panel-transform']) panels.set(id, makeElement(id));
  const document = {
    readyState: 'complete',
    getElementById: (id) => panels.get(id) || null,
    querySelectorAll: () => [],
    createElement: () => makeElement(''),
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch: (type, event) => { for (const handler of listeners.get(type) || []) handler(event); }
  };
  const window = { innerHeight: 800, visualViewport: { height: 800 }, addEventListener() {} };
  new Function('window', 'document', 'setTimeout', gripBlock)(window, document, (fn) => fn());
  return { document, panels };
}

function gripPointer(document, panel, type, y) {
  const grip = panel.children.find((child) => child.className === 'sheet-grip');
  assert.ok(grip, 'the card has no handle to drag');
  document.dispatch(type, {
    target: { closest: (selector) => (selector === '.sheet-grip' ? grip : null) },
    clientY: y, pointerId: 1, preventDefault() {}
  });
}

test('the transform cards can be dragged a little higher, and no further', () => {
  const { document, panels } = makePanelDom(300);
  const panel = panels.get('panel-move');
  gripPointer(document, panel, 'pointerdown', 700);

  /* A long drag up: "a little more" is a fixed headroom, so it must stop well
     short of the 92% of the screen the other sheets open to. */
  gripPointer(document, panel, 'pointermove', 100);
  const height = parseFloat(panel.style.height);
  assert.equal(height, 450, `the card stopped at ${panel.style.height}, not its own headroom`);
  gripPointer(document, panel, 'pointerup', 100);
  assert.equal(parseFloat(panel.style.height), 450, 'the card has to settle where the finger left it');
  assert.ok(panel.classList.contains('sheet-expanded'));

  /* And a tap puts it back on its own height, like every other sheet. */
  gripPointer(document, panel, 'pointerdown', 400);
  gripPointer(document, panel, 'pointerup', 400);
  assert.equal(panel.classList.contains('sheet-expanded'), false, 'a tap must fold the card again');
  assert.equal(panel.style.height, '', 'the inline height was not cleared');
  assert.equal(panel.style.maxHeight, '', 'the inline max-height was not cleared');

  /* Every one of the four carries the handle, not just the first. */
  for (const [id, node] of panels) {
    assert.ok(node.querySelector(':scope > .sheet-grip'), `${id} has no grab handle`);
    const headroom = Number((new RegExp(`'${id}': (\\d+)`).exec(html) || [])[1]);
    assert.ok(headroom >= 100 && headroom <= 220, `${id} headroom is ${headroom}px - not a small lift`);
  }
});

test('the per-axis number boxes are readable on the dark sheet', () => {
  /* The axis rows are .panel-field-row, not .panel-field, so the shared input
     rule never reached their number box: iOS painted its own white field and
     the value came out pale on white. */
  assert.ok(html.includes('.panel-field-row input[type="number"] {'),
    'the number box in every axis row is unstyled again');
  const rule = cssRule('.panel-field-row input[type="number"]');
  assert.match(rule, /background:\s*#202432/, 'the number box has no dark background');
  assert.match(rule, /color:\s*#edf1ff/, 'the number box has no readable text colour');
  assert.match(rule, /-webkit-text-fill-color:\s*#edf1ff/, 'iOS rewrites the text colour of a native field');
  assert.match(rule, /-webkit-appearance:\s*none/, 'the native white field is what has to go');
  assert.match(rule, /width:\s*100%/, 'the box has to fit the 62px column it is given');
  assert.ok(rule.includes('box-sizing: border-box'), 'padding would push the box out of its grid column');

  /* The slider in the same row must keep its own look: a rule on
     `.panel-field-row input` would win on specificity and paint a border and a
     dark background over the track. */
  assert.ok(!html.includes('.panel-field-row input {'),
    'a bare row-input rule would override the axis slider');

  /* Every axis of every transform panel goes through this row. */
  const rows = html.match(/class="panel-field-row axis-row"/g) || [];
  assert.equal(rows.length, 10, `the axis rows changed shape: ${rows.length}`);
});
