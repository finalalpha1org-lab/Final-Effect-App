import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* Every bottom sheet in the app has to carry a grab handle on its top edge, and
   the handle has to do something: pull the panel taller with the finger, settle
   at the tall height, and come back with a tap. The shipped controller is
   extracted from index.html and run against a DOM stub, so a handle that is
   drawn but never wired - the failure the user sees as "nothing happens when I
   drag" - fails here. */

const html = readFileSync('index.html', 'utf8');
const block = /\/\* ---- FE-SHEET-GRIP ---- \*\/[\s\S]*?\/\* ---- \/FE-SHEET-GRIP ---- \*\//.exec(html)?.[0];
const SHEET_IDS = ['camera-sheet', 'light-sheet', 'add-3d-sheet', 'landscape-sheet', 'import-3d-sheet', 'modifiers-sheet', 'animation-sheet', 'edit-sheet'];

function makeDom(height = 480) {
  class ClassList {
    constructor() { this.set = new Set(); }
    add(...names) { for (const name of names) this.set.add(name); }
    remove(...names) { for (const name of names) this.set.delete(name); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
      const on = force === undefined ? !this.set.has(name) : !!force;
      if (on) this.set.add(name); else this.set.delete(name);
      return on;
    }
  }
  class Element {
    constructor(id = '') {
      this.id = id;
      this.style = {};
      this.classList = new ClassList();
      this.children = [];
      this.attributes = {};
      this.height = 0;
    }
    get firstChild() { return this.children[0] || null; }
    insertBefore(node, ref) {
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
      node.parentElement = this;
      return node;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() { return { height: Number(this.style.height) || this.height, width: 360, top: 100 }; }
    querySelector(selector) {
      if (selector === ':scope > .sheet-grip') {
        return this.children.find((child) => child.className === 'sheet-grip') || null;
      }
      return null;
    }
    // A hand-written "height" so the test can see what the controller painted.
    set innerHTML(value) { this._html = value; }
    get innerHTML() { return this._html; }
  }

  const sheets = new Map();
  for (const id of SHEET_IDS) {
    const sheet = new Element(id);
    sheet.height = 300; /* the CSS height of a closed sheet */
    sheets.set(id, sheet);
  }
  const renderModal = new Element('render-modal-window');
  renderModal.className = 'render-modal-window';
  renderModal.height = 320;

  const listeners = new Map();
  const document = {
    readyState: 'complete',
    getElementById: (id) => sheets.get(id) || null,
    querySelectorAll: (selector) => (selector === '.render-modal-window' ? [renderModal] : []),
    createElement: () => new Element(),
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch: (type, event) => {
      for (const handler of listeners.get(type) || []) handler(event);
    }
  };
  const window = {
    innerHeight: 800,
    visualViewport: { height: 800 },
    addEventListener() {}
  };
  return { document, window, sheets, renderModal, Element };
}

function load(dom) {
  assert.ok(block, 'index.html no longer carries the sheet grip controller');
  const run = new Function('window', 'document', 'setTimeout', block);
  run(dom.window, dom.document, (fn) => fn());
}

/* A pointer event aimed at a handle. `closest` is what the controller asks. */
function pointer(dom, sheet, type, { y = 400, pointerId = 1 } = {}) {
  const grip = sheet.children.find((child) => child.className === 'sheet-grip');
  const target = { closest: (selector) => (selector === '.sheet-grip' ? grip : null) };
  dom.document.dispatch(type, {
    target, clientY: y, pointerId, preventDefault() {}
  });
  return grip;
}

test('every bottom sheet in the page is in the handle list and gets exactly one handle', () => {
  assert.ok(block, 'index.html no longer carries the sheet grip controller');
  /* Asked of the page, not of the list: a panel added later, or renamed, has to
     fail here instead of shipping without a handle. The settings backdrop is a
     full-screen scrim rather than a sheet - the window inside it is covered by
     the .render-modal-window rule. */
  const present = new Set(Array.from(html.matchAll(/id="([a-z0-9-]*-sheet)"/g), (hit) => hit[1]));
  present.delete('workspace-settings-sheet');
  assert.ok(present.size >= 6, `only ${present.size} sheets found in the page`);
  for (const id of present) {
    assert.ok(block.includes(`'${id}'`), `the ${id} panel has no grab handle in the controller`);
  }
  assert.match(block, /querySelectorAll\('\.render-modal-window'\)/, 'the render panel is not a bottom sheet any more');

  const dom = makeDom();
  load(dom);
  for (const id of SHEET_IDS) {
    const grip = dom.sheets.get(id).querySelector(':scope > .sheet-grip');
    assert.ok(grip, `the ${id} panel has no grab handle`);
    assert.equal(grip.getAttribute('role'), 'button');
  }
  assert.ok(dom.renderModal.querySelector(':scope > .sheet-grip'), 'the render panel has no grab handle');

  /* Opening the sheet and running install again must not stack handles. */
  dom.document.dispatch('fe:screen', {});
  for (const id of SHEET_IDS) {
    const count = dom.sheets.get(id).children.filter((child) => child.className === 'sheet-grip').length;
    assert.equal(count, 1, `the ${id} panel collected ${count} handles`);
  }
});

test('dragging the handle up opens the sheet taller, and a tap closes it again', () => {
  const dom = makeDom();
  load(dom);
  const sheet = dom.sheets.get('camera-sheet');
  assert.equal(sheet.getBoundingClientRect().height, 300, 'the sheet should start at its CSS height');

  /* A thumb drag: down, up 260px, let go. */
  pointer(dom, sheet, 'pointerdown', { y: 500 });
  assert.equal(sheet.classList.contains('sheet-dragging'), true, 'the sheet does not know it is being dragged');
  pointer(dom, sheet, 'pointermove', { y: 240 });
  assert.equal(sheet.style.height, '560px', `the panel did not follow the finger, got ${sheet.style.height}`);
  pointer(dom, sheet, 'pointerup', { y: 240 });

  assert.equal(sheet.classList.contains('sheet-dragging'), false, 'the drag never ended');
  assert.equal(sheet.classList.contains('sheet-expanded'), true, 'a long drag up must leave the panel open tall');
  assert.equal(sheet.style.height, '736px', `the tall height is not 92% of the screen, got ${sheet.style.height}`);
  assert.equal(sheet.style.maxHeight, 'none', 'the CSS max-height still caps the tall panel');

  /* A tap on the handle puts it back. */
  pointer(dom, sheet, 'pointerdown', { y: 300 });
  pointer(dom, sheet, 'pointerup', { y: 300 });
  assert.equal(sheet.classList.contains('sheet-expanded'), false, 'a tap must close the tall panel');
  assert.equal(sheet.style.height, '', 'the inline height was not cleared');
  assert.equal(sheet.style.maxHeight, '', 'the inline max-height was not cleared');
});

test('a short drag settles back to the normal height instead of sticking halfway', () => {
  const dom = makeDom();
  load(dom);
  const sheet = dom.sheets.get('modifiers-sheet');
  pointer(dom, sheet, 'pointerdown', { y: 600 });
  pointer(dom, sheet, 'pointermove', { y: 570 });
  pointer(dom, sheet, 'pointerup', { y: 570 });
  assert.equal(sheet.classList.contains('sheet-expanded'), false, '30px is not a request for a full-screen panel');
  assert.equal(sheet.style.height, '', 'the settled panel should go back to its own height');
});

test('the handle cannot drag a panel smaller than it already is', () => {
  const dom = makeDom();
  load(dom);
  const sheet = dom.sheets.get('light-sheet');
  pointer(dom, sheet, 'pointerdown', { y: 200 });
  pointer(dom, sheet, 'pointermove', { y: 700 });
  assert.equal(parseFloat(sheet.style.height), 300, `dragging down shrank the panel to ${sheet.style.height}`);
  pointer(dom, sheet, 'pointerup', { y: 700 });
  assert.equal(sheet.classList.contains('sheet-expanded'), false, 'dragging down must not open the panel');
  assert.equal(sheet.style.height, '', 'and it must go back to the height its CSS asks for');
});
