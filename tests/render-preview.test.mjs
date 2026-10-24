import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* The Render Result window: a finished frame gets its own tab, the way Blender
   gives it one. These tests pin the parts that used to be impossible to check
   without a browser: the window is opened once and reused, a blocked popup is
   not an error, frames and progress reach the window, and the window's own
   runtime draws them. */

const source = readFileSync('render-preview.js', 'utf8');
const engineSource = readFileSync('fe-cpp-engine.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const sw = readFileSync('sw.js', 'utf8');

/* ---------------------------------------------------------------- */
/* A DOM small enough to fit in a test and strict enough to catch  */
/* a missing element reference                                     */
/* ---------------------------------------------------------------- */

function makeElement(tagName) {
  const element = {
    tagName,
    childNodes: [],
    style: {},
    className: '',
    src: '',
    alt: '',
    href: '',
    download: '',
    listeners: {},
    _text: '',
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const at = this.childNodes.indexOf(child);
      if (at >= 0) this.childNodes.splice(at, 1);
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); },
    click() {
      (this.listeners.click || []).forEach((handler) => handler({}));
      this.clicked = true;
    },
    focus() {}
  };
  Object.defineProperty(element, 'textContent', {
    get() { return element._text; },
    set(value) { element._text = String(value); if (element._text === '') element.childNodes.length = 0; }
  });
  Object.defineProperty(element, 'naturalWidth', { get() { return 1920; } });
  Object.defineProperty(element, 'naturalHeight', { get() { return 1080; } });
  return element;
}

function makeDocument() {
  const elements = new Map();
  return {
    body: makeElement('body'),
    written: '',
    open() { this.opened = true; },
    close() { this.closed = true; },
    write(markup) {
      this.written += markup;
      for (const match of markup.matchAll(/id="([^"]+)"/g)) {
        if (!elements.has(match[1])) elements.set(match[1], makeElement('div'));
      }
    },
    getElementById(id) { return elements.get(id) || null; },
    createElement(tagName) { return makeElement(tagName); },
    elements
  };
}

let clock = 1000;

function harness(options = {}) {
  const outbox = [];
  const opened = [];
  const doc = makeDocument();
  const windowObject = {
    closed: false,
    document: doc,
    opener: { postMessage() {} },
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); },
    postMessage(message, origin) { outbox.push({ message, origin }); },
    close() { this.closed = true; },
    focus() { focused = true; }
  };
  let focused = false;
  const browser = {
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); },
    open(url, name, features) {
      if (options.blocked) return null;
      opened.push({ url, name, features });
      return windowObject;
    }
  };
  const store = new Map(options.stored ? Object.entries(options.stored) : []);
  const context = {
    window: browser,
    location: { origin: 'https://app.test' },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value))
    },
    performance: { now: () => clock },
    Math, Number, Object, Array, String, isFinite, Date, JSON
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { RP: context.FERenderPreview, outbox, opened, doc, windowObject, browser, store, isFocused: () => focused };
}

function canvas(width = 1920, height = 1080) {
  return {
    width,
    height,
    toDataURL: (type = 'image/png') => 'data:' + type + ';base64,' + 'A'.repeat(120)
  };
}

function cameraMessage(h, kind, extra = {}) {
  const listeners = h.windowObject.listeners.message || [];
  for (const listener of listeners) listener(Object.assign({ source: h.windowObject.opener, data: Object.assign({ type: 'fe-render-preview', kind }, extra) }));
}

test('the window document is complete, self-contained and icon-only', () => {
  const h = harness();
  const markup = h.RP.previewHtml();

  assert.ok(markup.startsWith('<!doctype html>'), 'it is a whole document, not a fragment');
  assert.match(markup, /<title>Render Result<\/title>/);

  assert.ok(!/<link\b/i.test(markup), 'no stylesheet has to load');
  assert.ok(!/src="http/i.test(markup), 'and no image or script is fetched from the network');
  assert.ok(!/@import/i.test(markup), 'the styles are inline');

  for (const id of ['stage', 'shot', 'empty', 'fill', 'status', 'title', 'meta', 'strip', 'btn-fit', 'btn-one', 'btn-save', 'btn-close']) {
    assert.ok(markup.includes(`id="${id}"`), `the runtime needs #${id}`);
  }

  assert.ok(markup.includes('(window, document)'), 'the runtime travels with the document');

  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  assert.ok(!emoji.test(markup), 'icons are SVG, never emoji');
  assert.ok((markup.match(/<svg /g) || []).length >= 4, 'the toolbar is drawn with SVG');
});

test('opening the window writes the document once and reuses the same tab', () => {
  const h = harness();
  const first = h.RP.ensure({ title: 'Render Result', width: 1920, height: 1080, reset: true });

  assert.ok(first, 'a handle comes back');
  assert.equal(h.opened.length, 1, 'one tab was opened');
  assert.equal(h.opened[0].name, h.RP.WINDOW_NAME, 'under a stable name, so a second render reuses it');
  assert.match(h.opened[0].features, /width=\d+/, 'sized to the render');
  assert.ok(h.doc.written.includes('<title>Render Result</title>'), 'the document was written into it');
  assert.ok(h.doc.opened && h.doc.closed, 'and the document stream was closed');
  assert.ok(h.RP.isOpen());

  const before = h.doc.written.length;
  h.RP.ensure({ title: 'Render Result', width: 1920, height: 1080 });
  assert.equal(h.opened.length, 1, 'a second render does not open a second tab');
  assert.equal(h.doc.written.length, before, 'and does not rewrite the document under the user');
  assert.ok(h.outbox.some((entry) => entry.message.kind === 'meta'), 'it just tells the open window what is coming');
});

test('a blocked popup returns null instead of throwing', () => {
  const h = harness({ blocked: true });
  assert.equal(h.RP.ensure({ title: 'Render Result', width: 800, height: 600 }), null);
  assert.equal(h.RP.isOpen(), false);
  assert.equal(h.RP.pushCanvas(canvas(), { final: true }), false, 'and frames are simply not sent');
  assert.equal(h.RP.progress(50, 'half'), false);
});

test('frames are throttled, finals and animation frames are not', () => {
  const h = harness();
  h.RP.ensure({ title: 'Render Result' });

  clock = 5000;
  assert.equal(h.RP.pushCanvas(canvas(), { spp: 1 }), true, 'the first pass is sent');
  clock = 5010;
  assert.equal(h.RP.pushCanvas(canvas(), { spp: 2 }), false, 'a pass 10 ms later waits');
  clock = 5200;
  assert.equal(h.RP.pushCanvas(canvas(), { spp: 3 }), true, 'the next one outside the window is sent');
  clock = 5210;
  assert.equal(h.RP.pushCanvas(canvas(), { spp: 4, final: true }), true, 'the final frame always goes');
  clock = 5220;
  assert.equal(h.RP.pushCanvas(canvas(), { index: 2, force: true }), true, 'an animation frame is never dropped');

  const frames = h.outbox.filter((entry) => entry.message.kind === 'frame');
  assert.equal(frames.length, 4);
  assert.match(frames[0].message.src, /^data:image\/jpeg;base64,/, 'an in-progress pass is cheap to encode');
  assert.match(frames[3].message.src, /^data:image\/jpeg;base64,/);
  const finalFrame = h.outbox.filter((entry) => entry.message.kind === 'frame' && entry.message.meta && entry.message.meta.final);
  assert.match(finalFrame.at(-1).message.src, /^data:image\/png;base64,/, 'the finished picture is lossless');
  assert.equal(h.outbox[0].origin, 'https://app.test', 'and it is addressed to this origin only');
});

test('the window is told when the render is done, and a reopened tab gets the last frame', () => {
  const h = harness();
  h.RP.ensure({ title: 'Render Result' });
  clock = 9000;
  h.RP.pushCanvas(canvas(), { spp: 24, sppTotal: 24, final: true });
  assert.equal(h.RP.done(undefined, 4200), true);

  const kinds = h.outbox.map((entry) => entry.message.kind);
  assert.ok(kinds.includes('frame') && kinds.includes('done'));

  const before = h.outbox.length;
  const listener = (h.browser.listeners.message || [])[0];
  assert.equal(typeof listener, 'function', 'the editor listens for the window saying hello');
  listener({ source: h.windowObject, data: { type: 'fe-render-preview', kind: 'ready' } });

  const reposted = h.outbox.slice(before);
  assert.equal(reposted.length, 1, 'a window that just came up is handed the current picture');
  assert.equal(reposted[0].message.kind, 'frame');
  assert.match(reposted[0].message.src, /^data:image\/png/);

  listener({ source: {}, data: { type: 'fe-render-preview', kind: 'ready' } });
  assert.equal(h.outbox.length, before + 1, 'but not on behalf of some other window');
});

test('closing forgets the window; the setting persists and defaults to on', () => {
  const h = harness();
  assert.equal(h.RP.enabled(), true, 'a fresh install shows renders in their own window');

  h.RP.ensure({ title: 'Render Result' });
  h.RP.close();
  assert.equal(h.RP.isOpen(), false);
  assert.equal(h.windowObject.closed, true, 'the tab is actually closed');
  assert.equal(h.RP.pushCanvas(canvas(), { final: true }), false);

  h.RP.setEnabled(false);
  assert.equal(h.store.get(h.RP.STORAGE_KEY), '0');
  const again = harness({ stored: { [h.RP.STORAGE_KEY]: '0' } });
  assert.equal(again.RP.enabled(), false, 'the choice survives a reload');
});

/* ---------------------------------------------------------------- */
/* The window's own runtime, executed                               */
/* ---------------------------------------------------------------- */

test('the runtime paints frames, keeps a filmstrip, and reports progress', () => {
  const h = harness();
  h.RP.ensure({ title: 'Render Result' });
  /* attachPreviewRuntime is self-contained, so it runs against the fake DOM. */
  h.RP.attachPreviewRuntime(h.windowObject, h.doc);

  const shot = h.doc.getElementById('shot');
  const empty = h.doc.getElementById('empty');
  const meta = h.doc.getElementById('meta');
  const fill = h.doc.getElementById('fill');
  const status = h.doc.getElementById('status');
  const spinner = h.doc.getElementById('spinner');
  const strip = h.doc.getElementById('strip');
  const stage = h.doc.getElementById('stage');

  cameraMessage(h, 'frame', { src: 'data:image/png;base64,AAA', meta: { width: 1920, height: 1080, spp: 24, sppTotal: 24, final: true } });
  assert.equal(shot.src, 'data:image/png;base64,AAA');
  assert.equal(shot.style.display, 'block', 'the picture is shown');
  assert.equal(empty.style.display, 'none', 'the placeholder is gone');
  assert.match(meta.textContent, /1920 × 1080/);
  assert.match(meta.textContent, /24\/24 SPP/);
  assert.equal(spinner.style.display, 'none', 'a finished frame stops the spinner');

  cameraMessage(h, 'progress', { percent: 40, text: 'pass 2 of 5' });
  assert.equal(fill.style.width, '40%');
  assert.equal(status.textContent, 'pass 2 of 5');

  cameraMessage(h, 'done', { elapsed: 8200 });
  assert.equal(fill.style.width, '100%');
  assert.match(status.textContent, /8\.2 s/);

  /* A new run starts: the window forgets the previous result, exactly as the
     engine does with reset() before a still or an animation. */
  assert.equal(h.RP.reset('Render Result'), true);
  cameraMessage(h, 'meta', { title: 'Render Result', reset: true });
  assert.equal(strip.childNodes.length, 0, 'the old filmstrip is gone');
  assert.equal(shot.style.display, 'none', 'and the old frame is not left on screen');

  cameraMessage(h, 'frame', { src: 'data:image/png;base64,BBB', meta: { width: 1920, height: 1080, index: 1, total: 3 } });
  cameraMessage(h, 'frame', { src: 'data:image/png;base64,CCC', meta: { width: 1920, height: 1080, index: 2, total: 3 } });
  cameraMessage(h, 'frame', { src: 'data:image/png;base64,DDD', meta: { width: 1920, height: 1080, index: 3, total: 3 } });
  assert.equal(strip.style.display, 'flex', 'an animation gets a filmstrip');
  assert.equal(strip.childNodes.length, 3);
  assert.equal(strip.childNodes[2].className, 'thumb on', 'the newest frame is the selected thumb');
  assert.equal(shot.src, 'data:image/png;base64,DDD');

  strip.childNodes[0].click();
  assert.equal(shot.src, 'data:image/png;base64,BBB', 'clicking a thumb shows that frame');
  assert.equal(strip.childNodes[0].className, 'thumb on');

  cameraMessage(h, 'error', { text: 'out of memory' });
  assert.equal(status.textContent, 'out of memory');

  /* A message from anywhere but the opener is ignored. */
  const before = shot.src;
  const listeners = h.windowObject.listeners.message || [];
  for (const listener of listeners) listener({ source: {}, data: { type: 'fe-render-preview', kind: 'frame', src: 'data:evil' } });
  assert.equal(shot.src, before, 'only the editor may drive the window');

  /* Zoom and save, driven from the toolbar and the keyboard. */
  h.doc.getElementById('btn-one').click();
  assert.match(stage.className, /one/);
  h.doc.getElementById('btn-fit').click();
  assert.match(stage.className, /fit/);

  const key = (value) => { (h.windowObject.listeners.keydown || []).forEach((listener) => listener({ key: value, preventDefault() {} })); };
  key('1');
  assert.match(stage.className, /one/);
  key('f');
  assert.match(stage.className, /fit/);

  const anchors = [];
  const createElement = h.doc.createElement.bind(h.doc);
  h.doc.createElement = (tagName) => {
    const element = createElement(tagName);
    if (tagName === 'a') anchors.push(element);
    return element;
  };
  h.doc.getElementById('btn-save').click();
  const anchor = anchors.at(-1);
  assert.equal(anchor.tagName, 'a');
  assert.ok(anchor.download.endsWith('.png'), 'Save writes a .png with the frame in its name');
  assert.match(anchor.href, /^data:image\/png/, 'holding the frame that is on screen');
  assert.ok(anchor.clicked, 'and clicks the link for the user');
  assert.equal(h.doc.body.childNodes.length, 0, 'then cleans the temporary link up again');
});

test('a long animation is capped instead of eating the tab', () => {
  const h = harness();
  h.RP.ensure({ title: 'Render Result' });
  h.RP.attachPreviewRuntime(h.windowObject, h.doc);
  const strip = h.doc.getElementById('strip');

  for (let frame = 1; frame <= 60; frame++) {
    cameraMessage(h, 'frame', { src: 'data:image/png;base64,' + String(frame).padStart(4, '0'), meta: { index: frame, total: 60, force: true } });
  }
  assert.equal(strip.childNodes.length, 48, 'the strip keeps the recent frames, not all of them');
  assert.equal(strip.childNodes.at(-1).src, 'data:image/png;base64,0060', 'the newest frame is the one shown');
  assert.equal(h.doc.getElementById('shot').src, 'data:image/png;base64,0060');

  /* A still render improves in place: 24 sample passes are one picture. */
  h.RP.reset('Render Result');
  cameraMessage(h, 'meta', { title: 'Render Result', reset: true });
  for (let pass = 1; pass <= 24; pass++) {
    cameraMessage(h, 'frame', { src: 'data:image/png;base64,pass' + pass, meta: { spp: pass, sppTotal: 24 } });
  }
  assert.equal(strip.childNodes.length, 0, 'a still render has no filmstrip');
  assert.equal(strip.style.display, 'none');
  assert.equal(h.doc.getElementById('shot').src, 'data:image/png;base64,pass24', 'but the last pass is the picture');
});

test('the render dialog actually publishes to the window', () => {
  /* The engine half of the contract, read from the real source: the Render
     button opens the tab while the click is still live, and every render path
     pushes what it drew. */
  const openMethod = engineSource.slice(engineSource.indexOf('renderFrameToPreview() {'));
  assert.ok(openMethod.indexOf('preview.ensure(') > 0, 'the button opens the window');
  assert.ok(openMethod.indexOf('preview.ensure(') < openMethod.indexOf('startStillRender()'), 'synchronously, before the first await');

  const publish = engineSource.match(/publishPreview\(canvas, \{[\s\S]*?\}\);/g) || [];
  assert.ok(publish.length >= 3, 'raster, path-traced and animation frames all reach the window');

  assert.ok(/this\.publishPreview\(canvas, \{[\s\S]*?final: true \}\)/.test(engineSource), 'the raster still is a final frame');
  assert.ok(/this\.publishPreview\(canvas, \{[\s\S]*?force: true/.test(engineSource), 'animation frames are never throttled away');

  assert.ok(html.includes('<script src="render-preview.js"></script>'), 'the page loads the module');
  assert.ok(html.indexOf('render-preview.js') < html.indexOf('fe-cpp-engine.js'), 'before the engine that calls it');
  assert.ok(html.includes('id="render-new-window"'), 'the dialog has the switch');
  assert.ok(html.includes('FECppEngine.renderFrameToPreview()'), 'and Render Frame goes through the window');
});

test('the window ships with the app', () => {
  assert.ok(sw.includes("'./render-preview.js'"), 'the service worker caches it');
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(/'?render-preview\.js'?,/.test(build) || build.includes('"render-preview.js"'), 'the build copies it');
  assert.ok(build.includes('renderPreview: readFileSync'), 'and embeds it in the single-file build');
  const standalone = readFileSync('scripts/standalone-html.mjs', 'utf8');
  assert.ok(standalone.includes("['render-preview.js', renderPreview]"), 'which inlines it');
});
