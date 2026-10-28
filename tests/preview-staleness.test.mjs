import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newestExisting } from '../scripts/preview-server.mjs';

/* The preview server serves `build/client` before the source tree, because that
   is what a deploy ships. The side effect is that an edit made after the last
   build was invisible in the browser: the studio kept running yesterday's
   material while the file on disk was the new one — which reads exactly like
   "the fix did not work". The server now picks the newest copy of a file that
   exists in both places. */

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'fe-preview-'));
  const built = join(root, 'build', 'client');
  mkdirSync(built, { recursive: true });
  return { root, built };
}

test('a source edit newer than the build wins, so the preview never hides it', () => {
  const { root, built } = scratch();
  writeFileSync(join(root, 'terrain-main-02.js'), '/* new */');
  writeFileSync(join(built, 'terrain-main-02.js'), '/* old */');
  const older = new Date(Date.now() - 60000);
  utimesSync(join(built, 'terrain-main-02.js'), older, older);
  assert.equal(newestExisting([join(built, 'terrain-main-02.js'), join(root, 'terrain-main-02.js')]), join(root, 'terrain-main-02.js'));
});

test('a fresh build still wins over an untouched source', () => {
  const { root, built } = scratch();
  writeFileSync(join(root, 'terrain-main-02.js'), '/* source */');
  writeFileSync(join(built, 'terrain-main-02.js'), '/* minified */');
  const older = new Date(Date.now() - 60000);
  utimesSync(join(root, 'terrain-main-02.js'), older, older);
  assert.equal(newestExisting([join(built, 'terrain-main-02.js'), join(root, 'terrain-main-02.js')]), join(built, 'terrain-main-02.js'));
});

test('a file that only exists in one place is still served', () => {
  const { root, built } = scratch();
  writeFileSync(join(root, 'only-source.js'), '1');
  writeFileSync(join(built, 'only-build.html'), '2');
  assert.equal(newestExisting([join(built, 'only-build.html'), join(root, 'only-build.html')]), join(built, 'only-build.html'));
  assert.equal(newestExisting([join(built, 'only-source.js'), join(root, 'only-source.js')]), join(root, 'only-source.js'));
  assert.equal(newestExisting([join(built, 'missing.js'), join(root, 'missing.js')]), null);
});

test('the server resolves a real page from the repository', () => {
  /* The shipped page and the artifact both have to resolve, whichever copy is
     newest, and an import of the module must not take a port. */
  const html = newestExisting(['build/client/Terrain_system_.html', 'Terrain_system_.html']);
  const wasm = newestExisting(['build/client/fe_core_engine.wasm', 'fe_core_engine.wasm']);
  assert.ok(html && html.endsWith('Terrain_system_.html'));
  assert.ok(wasm && wasm.endsWith('fe_core_engine.wasm'));
});
