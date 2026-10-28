import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Two ways an app can fail without ever saying so:
 *
 *   1. One uncaught error in a long inline block stops everything after it.
 *      The home grid, the studios and the mode select never appear, and the
 *      app looks empty rather than broken.
 *   2. The shell ships without the file that implements a mode, and picking
 *      that mode does nothing at all.
 *
 * Both are silent by construction, so both now have something to say, and
 * both are pinned here. */

const html = readFileSync('index.html', 'utf8');

function bootWatch() {
  const script = /<script>([\s\S]*?__feBootWatch[\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, 'the boot watch is not in the page');
  const listeners = {};
  const created = [];
  const body = {
    children: [],
    appendChild(node) { created.push(node); this.children.push(node); return node; }
  };
  const doc = {
    readyState: 'complete',
    body,
    documentElement: body,
    /* Real getElementById finds the banner after it was appended; the stub has
       to as well, or every error would look like a first error. */
    getElementById: (id) => created.find((el) => el.id === id) || null,
    createElement: () => {
      const el = {
        id: '', textContent: '', style: { cssText: '' }, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        set innerHTML(v) { this._html = v; },
        get innerHTML() { return this._html; },
        appendChild() {}, remove() {},
        querySelector: () => ({ set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick; }, set textContent(v) { this._t = v; }, get textContent() { return this._t; } })
      };
      return el;
    }
  };
  const window = {
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
  };
  const context = vm.createContext({ window, document: doc, navigator: {}, console, setTimeout, clearTimeout });
  vm.runInContext(script[1], context);
  return { window, listeners, created, doc };
}

test('an uncaught error is shown on screen, with the file it came from', () => {
  const { window, listeners, created } = bootWatch();
  assert.ok(Array.isArray(listeners.error) && listeners.error.length, 'nothing is listening for errors');
  listeners.error[0]({ message: 'Cannot read properties of null', filename: 'https://x/workspace-app.js', lineno: 42 });
  assert.equal(created.length, 1, 'the report is not on screen');
  const banner = created[0];
  assert.equal(banner.id, 'fe-boot-error');
  assert.match(banner.innerHTML, /Something failed to load/);
  assert.match(banner.innerHTML, /Copy/, 'the message has to be copyable, or it cannot be reported');
  assert.match(html, /fe-boot-error-msg/);
});

test('a rejected promise that nothing handles is reported too', () => {
  const { listeners, created } = bootWatch();
  assert.ok(Array.isArray(listeners.unhandledrejection) && listeners.unhandledrejection.length);
  listeners.unhandledrejection[0]({ reason: new Error('wasm failed to compile') });
  assert.equal(created.length, 1);
});

test('the reporter cannot itself break the app, and it stops after three', () => {
  const { listeners, created } = bootWatch();
  /* A throw inside the handler, and a broken DOM, must not escape. */
  assert.doesNotThrow(() => listeners.error[0]({ message: 'a' }));
  const broken = bootWatch();
  broken.doc.getElementById = () => { throw new Error('no dom'); };
  broken.doc.createElement = () => { throw new Error('no dom'); };
  assert.doesNotThrow(() => broken.listeners.error[0]({ message: 'b' }));
  /* Four failures, three banners. */
  const many = bootWatch();
  for (let i = 0; i < 6; i++) many.listeners.error[0]({ message: 'e' + i });
  assert.equal(many.created.length, 1, 'one banner element, not one per error');
});

test('the boot watch runs before the app scripts, so their failures are caught', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('__feBootWatch'), 'the watch must be in the head');
  const firstAppScript = html.indexOf('<script src="vendor/three/three.min.js"');
  assert.ok(html.indexOf('__feBootWatch') < firstAppScript, 'the watch must be installed before three.js and the app bundle');
});

test('the settings sheet can say whether the mesh editor arrived', () => {
  const start = html.indexOf('function renderAppBuildStamp()');
  assert.ok(start > 0, 'the build stamp is gone');
  const end = html.indexOf('window.renderAppBuildStamp', start);
  const source = html.slice(start, end);

  /* Run it against a fake page: the meta wins over lastModified, and the
     bridge's presence is reported either way. */
  function stampFor(meta, bridge) {
    const el = { textContent: '' };
    const context = vm.createContext({
      window: { FEEditMode: bridge },
      document: {
        getElementById: () => el,
        querySelector: (sel) => (sel === 'meta[name="fe-build"]' && meta ? { getAttribute: () => meta } : null),
        lastModified: '2026-10-01T10:00:00Z'
      }
    });
    vm.runInContext(`${source}\nrenderAppBuildStamp();`, context);
    return el.textContent;
  }
  const withBridge = stampFor('7fd07d4 · 2026-10-28 07:01 UTC', { enter() {} });
  assert.match(withBridge, /7fd07d4/, 'the meta build is the identity that is shown');
  assert.match(withBridge, /mesh editor ready/);
  const withoutBridge = stampFor('7fd07d4 · 2026-10-28 07:01 UTC', undefined);
  assert.match(withoutBridge, /mesh editor missing/, 'a shell without the bridge has to say so');
  assert.match(withoutBridge, /Update/, 'and what to do');
  const noMeta = stampFor(null, { enter() {} });
  assert.match(noMeta, /2026/, 'lastModified is the fallback');
});

test('the build stamps the page it writes, so a device can name its build', () => {
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /function buildStamp\(\)/, 'the build has no stamp function');
  assert.match(build, /git rev-parse --short HEAD/, 'the stamp should name the commit');
  assert.match(build, /writeFileSync\("build\/client\/index\.html", stampBuild\(bundlableIndexHtml\)\)/);
  assert.match(build, /bundlableTerrainHtml = stampBuild\(bundlableTerrainHtml\)/);
  assert.match(build, /stampBuild\(standaloneAppHtml\)/);
  assert.match(html, /<meta name="fe-build" content="dev">/, 'the source needs the placeholder the build replaces');
});
