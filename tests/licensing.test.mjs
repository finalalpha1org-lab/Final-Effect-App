import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs';

/* The licence is a decision, not a comment. It was changed from CC0-1.0 to
   GPL-3.0-or-later on 2026-10-24 so the project can use GPL components from
   the Blender tree. These tests keep the repository saying that, and keep the
   attribution three.js needs to travel with its code. */

const licence = readFileSync('LICENSE', 'utf8');
const notice = readFileSync('NOTICE', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const readme = readFileSync('README.md', 'utf8');
const doc = readFileSync('docs/LICENSING.md', 'utf8');

test('the project is GPL-3.0-or-later everywhere it is declared', () => {
  assert.equal(pkg.license, 'GPL-3.0-or-later', 'package.json declares it');

  assert.match(licence, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(licence, /Version 3, 29 June 2007/);
  assert.match(licence, /either version 3 of the License, or \(at your option\) any later version/,
    'the grant is "or later", because Apache-2.0 is only GPLv3-compatible');
  assert.match(licence, /Copyright \(C\) 20\d\d/);

  assert.match(readme, /## Licence/);
  const section = readme.slice(readme.indexOf('## Licence'));
  assert.match(section.slice(0, 120), /GPL-3\.0-or-later/, 'the section opens with the current licence');
});

test('the CC0 history is stated, not quietly overwritten', () => {
  assert.match(readme, /CC0-1\.0/);
  assert.match(readme, /published\s+before that date remain CC0-1\.0/i);
  assert.match(doc, /CC0/);
  assert.match(doc, /cannot be withdrawn/);
});

test('third-party attribution travels with the code', () => {
  assert.match(notice, /three\.js/);
  assert.match(notice, /MIT/);
  assert.match(notice, /three-csg-ts/);
  assert.match(notice, /esbuild/);
  assert.match(notice, /GPL-3\.0-or-later/);
});

test('the licensing document keeps the component table honest', () => {
  for (const component of ['Cycles', 'EEVEE', 'Apache-2.0', 'GPL-2.0-or-later']) {
    assert.ok(doc.includes(component), `the table still covers ${component}`);
  }
  assert.match(doc, /WebGL2|WebGPU/, 'and the technical limit is stated, not glossed over');
  assert.ok(!/Cycles is proprietary/.test(doc));
});

test('files this project wrote carry an SPDX line where it matters', () => {
  for (const file of ['render-capture.js', 'render-preview.js']) {
    assert.match(readFileSync(file, 'utf8').slice(0, 80), /SPDX-License-Identifier: GPL-3\.0-or-later/);
  }
});

/* ---------------------------------------------------------------- pasted code --
   The licence changed so GPL components *can* be taken from the Blender tree.
   That permission is only safe while it is honest: a copied file keeps its
   original copyright header, and the same commit records it in NOTICE. These
   checks keep the door open without letting code walk through it unrecorded. */

function sourceFiles(dir, extensions) {
  const { readdirSync } = fs;
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(path);
  }
  return out;
}

test('a file that came from the Blender tree is credited in NOTICE', () => {
  const candidates = [
    ...sourceFiles('cpp', ['.cpp', '.hpp', '.c', '.h']),
    ...sourceFiles('src', ['.mjs', '.js']),
    ...fs.readdirSync('.').filter((name) => name.endsWith('.js')).map((name) => `./${name}`)
  ];
  const copied = [];
  for (const file of candidates) {
    const head = readFileSync(file, 'utf8').slice(0, 1200);
    const fromBlender = /Blender Foundation/.test(head) ||
      /SPDX-License-Identifier:.*GPL-2\.0/.test(head);
    if (fromBlender) copied.push(file);
  }
  /* Nothing is copied today. If that changes, the file has to be named in the
     NOTICE section that exists for exactly this. */
  for (const file of copied) {
    assert.ok(
      notice.includes(file.replace(/^\.\//, '')),
      `${file} carries a Blender copyright header but is not listed under "Copied Blender source" in NOTICE`
    );
  }
});

test('the licensing document keeps the measured cost of pasting a Blender file', () => {
  /* The decision "reference, not paste" is only defensible while the numbers
     behind it are written down and still true of our build. */
  assert.match(doc, /bmesh_bevel\.cc/, 'the bevel is the worked example');
  assert.match(doc, /8 485 lines/, 'with its measured size');
  assert.match(doc, /nostdlib/, 'and the reason it cannot simply be compiled in');
  assert.match(doc, /0 imports/, 'the freestanding contract is stated');
  const artifact = statSync('wasm/fe_core_engine.wasm').size;
  assert.ok(doc.includes(`${artifact}`) || doc.includes(artifact.toLocaleString('en-US').replace(/,/g, ' ')),
    `the document must quote the shipped artifact size (${artifact} bytes)`);
});
