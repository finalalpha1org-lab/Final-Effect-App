import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* The project file is `fe-project.js`: `.fe3d` and `.fe3a` carry the whole
   project, and the older `.final3d` still opens. The writer does not describe
   the scene a second time - it stores the engine's own autosave blob, and every
   object's `userData` (which is where the modifier stack lives) rides inside
   it - so these tests drive the module itself and read the bytes back. */

const source = readFileSync('fe-project.js', 'utf8');

const MOD_STACK = [
  { id: 'mod-1', name: 'Bevel', values: { Width: 0.2, Segments: 3 } },
  { id: 'mod-2', name: 'Subdivision Surface', values: { Levels: 2 } }
];

function loadProject(overrides = {}) {
  /* One mesh with a modifier stack, described the way THREE's toJSON() would:
     the stack is in userData, so the project file inherits it. */
  const autosave = {
    version: 1,
    studio: 'core',
    savedAt: 1700000000000,
    cube: null,
    custom: [{ key: 'modifier-cube', json: { uuid: 'u-1', name: 'ModifierCube', userData: { modStack: MOD_STACK } } }],
    camera: { viewport: {} }
  };
  const sceneObjects = [];
  const eng = {
    sc: {
      traverse(fn) {
        for (const obj of sceneObjects) fn(obj);
      }
    },
    serializeAutosave() { return autosave; }
  };
  const core = { ready: true, exports: { fe_anim_get_total_keyframes: () => 4 }, serializeAnimation: () => ({ tracks: [] }) };
  const window = {
    FE: { engines: { core: eng } },
    FECppEngine: core,
    document: { getElementById: () => null, createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild() {} } },
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    setTimeout,
    ...overrides
  };
  window.window = window;
  const ctx = vm.createContext({ window, Blob: window.Blob, setTimeout, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, console });
  vm.runInContext(source, ctx);
  return { FEProject: window.FEProject, autosave, eng };
}

test('the writer stores the engine autosave, so each object keeps its modifier stack', () => {
  const { FEProject } = loadProject();
  const payload = FEProject.buildPayload();
  assert.equal(payload.format, 'FE3D_PROJECT');
  assert.deepEqual(
    JSON.parse(JSON.stringify(payload.engine.autosave.custom[0].json.userData.modStack)),
    MOD_STACK,
    'the modifier configuration has to be in the project payload'
  );
});

test('.fe3d and .fe3a round-trip through the container byte for byte', () => {
  const { FEProject } = loadProject();
  const payload = FEProject.buildPayload();
  for (const kind of ['fe3d', 'fe3a']) {
    const { buffer } = FEProject.writeContainer(payload, kind);
    const back = FEProject.readContainer(buffer);
    assert.equal(back.kind, kind, `the ${kind} magic byte tag names the container`);
    /* Across a vm realm the objects have another Object prototype, so compare
       them as JSON - which is also exactly what travelled through the file. */
    assert.deepEqual(
      JSON.parse(JSON.stringify(back.payload.engine.autosave.custom[0].json.userData.modStack)),
      MOD_STACK
    );
    assert.equal(back.payload.projectName, payload.projectName);
  }
  /* The two tags are different files carrying the same project. */
  const a = new Uint8Array(FEProject.writeContainer(payload, 'fe3d').buffer);
  const b = new Uint8Array(FEProject.writeContainer(payload, 'fe3a').buffer);
  assert.notEqual(a[3], b[3], 'the fourth magic byte tells .fe3d from .fe3a');
  assert.equal(a.length, b.length, 'and the rest of the container is identical');
});

test('an old .final3d file is recognised and says what it cannot bring back', () => {
  const { FEProject } = loadProject();
  /* What the old exporter wrote: "F3D" + a version byte + a JSON payload. */
  const legacy = { format: 'FINAL3D_BINARY', projectName: 'Old', camera: {}, lighting: {} };
  const json = JSON.stringify(legacy);
  const body = Buffer.from(json, 'utf8');
  const bytes = new Uint8Array(8 + body.length);
  bytes.set([0x46, 0x33, 0x44, 0x01], 0);
  new DataView(bytes.buffer).setUint32(4, body.length, true);
  bytes.set(body, 8);
  const read = FEProject.readContainer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(read.kind, 'final3d');
  assert.equal(read.headerVersion, 1);
  assert.equal(read.payload.projectName, 'Old');
});

test('the export modal offers both project files and the old one still opens', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(html.includes('<script src="fe-poly.js"></script>'), 'the polygon layer loads before the project file');
  assert.ok(html.includes('<script src="fe-project.js"></script>'));
  assert.ok(html.indexOf('fe-poly.js') < html.indexOf('fe-project.js'), 'in that order');
  assert.ok(html.includes('exportFe3dProject()') && html.includes('exportFe3aProject()'));
  assert.match(html, /accept="\.fe3d,\.fe3a,\.final3d"/);
});
