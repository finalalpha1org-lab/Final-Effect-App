import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The shell is a phone app now: desktop is a separate product. Two things have
 * to stay true for that to mean anything.
 *
 *   1. The home screen must not advertise a platform matrix it no longer
 *      targets, and it must say what the product is for.
 *   2. The first paint must not wait for the engines. A phone on 4G opening
 *      the app should see the home screen before 1.8 MB of JavaScript is
 *      downloaded and parsed, so nothing external loads above the home markup.
 *
 * Both are one careless edit away from being undone, so both are pinned. */

const html = readFileSync('index.html', 'utf8');

test('home hero states the bar: Hollywood level, pick a studio', () => {
  const hero = /<h1>Final Effect 3D<\/h1>[\s\S]*?<p>([^<]*)<\/p>/.exec(html);
  assert.ok(hero, 'the home hero paragraph is missing');
  assert.equal(hero[1].trim(), 'Reach Hollywood level. Choose a studio to start.');
});

test('no platform matrix is left in the shell', () => {
  assert.equal(/All-Platform/i.test(html), false, 'All-Platform wording is still in the page');
  assert.equal(/Mobile\s*&\s*Desktop/i.test(html), false, 'mobile & desktop wording is still in the page');
  assert.equal(/\bDesktop\b/.test(html), false, 'a Desktop reference is still in the page');
});

test('every external script loads after the home markup, so the home paints first', () => {
  const homeEnd = html.indexOf('</main>');
  assert.ok(homeEnd > 0, 'the home screen has no closing main tag');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)];
  assert.ok(scripts.length >= 16, `expected the engine scripts, found ${scripts.length}`);
  const early = scripts.filter((m) => m.index < homeEnd).map((m) => m[1]);
  assert.deepEqual(early, [], `these scripts block the first paint: ${early.join(', ')}`);
});

test('the loading order the inline boot code assumes is unchanged', () => {
  const order = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const at = (name) => order.indexOf(name);
  assert.ok(at('vendor/three/three.min.js') >= 0, 'three is not loaded');
  /* The controls extend THREE, so they have to come after it. */
  assert.ok(at('vendor/three/three.min.js') < at('vendor/three/OrbitControls.js'));
  assert.ok(at('vendor/three/three.min.js') < at('vendor/three/TransformControls.js'));
  assert.ok(at('vendor/three/three.min.js') < at('vendor/three/RGBELoader.js'));
  /* Icons are inlined into markup the boot code builds. */
  assert.ok(at('fe-icons.js') < at('edit-mode.js'));
  /* The WASM bridge is last: it is the biggest file and the studio scripts
     register their bridges before it starts reporting. */
  assert.equal(order[order.length - 1], 'fe-cpp-engine.js');
});

test('the install action is an icon, not an emoji', () => {
  const button = /<button[^>]*installFinalEffectPWA\(\)[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(button, 'the install button is missing');
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  assert.equal(emoji.test(button[1]), false, `emoji in the install button: ${button[1].trim()}`);
  assert.match(button[1], /data-ico="download"/);
});
