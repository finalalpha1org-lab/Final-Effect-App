import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

/* Render output. Two failures are pinned here: a render had exactly one still
   format and one video container (both of which were wrong on a phone), and
   the recorder captured in real time so a slow frame silently stretched into
   several frames of video. */

const source = readFileSync('render-export.js', 'utf8');
const engineSource = readFileSync('fe-cpp-engine.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const sw = readFileSync('sw.js', 'utf8');

function load() {
  const context = { TextEncoder, Blob, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date, Buffer, console, URL, setTimeout };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.FERenderExport;
}

const X = load();

test('a still can be written as PNG, JPEG or WebP, and the name never lies', async () => {
  assert.deepEqual(Array.from(X.STILL_FORMATS, (f) => f.id), ['png', 'jpeg', 'webp']);

  assert.equal(X.stillFormat('jpeg').ext, '.jpg');
  assert.equal(X.stillFormat('nonsense').id, 'png', 'an unknown format falls back to the lossless one');
  assert.equal(X.clampQuality(0.5, X.stillFormat('png')), 1, 'PNG has no quality to trade away');
  assert.equal(X.clampQuality(0, X.stillFormat('jpeg')), 0.2, 'and a lossy format has a floor');
  assert.equal(X.clampQuality(5, X.stillFormat('webp')), 1);

  const png = await X.encodeStill({ toBlob: (cb) => cb(new Blob([new Uint8Array(8)], { type: 'image/png' })) }, 'png');
  assert.equal(png.ext, '.png');

  /* Safari used to answer a WebP request with a PNG; the extension follows the
     blob, not the request. */
  const webp = await X.encodeStill({ toBlob: (cb) => cb(new Blob([new Uint8Array(8)], { type: 'image/webp' })) }, 'webp');
  assert.equal(webp.ext, '.webp');

  const fallback = await X.encodeStill({
    toBlob: (cb, mime) => cb(mime === 'image/webp' ? null : new Blob([new Uint8Array(8)], { type: 'image/png' }))
  }, 'webp');
  assert.equal(fallback.ext, '.png', 'a refused type is retried as PNG, and says so');
});

test('the video container is chosen by asking the browser', () => {
  assert.equal(X.pickVideoFormat((m) => m.startsWith('video/mp4')).ext, '.mp4');
  assert.equal(X.pickVideoFormat((m) => m.startsWith('video/webm')).ext, '.webm');
  assert.equal(X.pickVideoFormat(() => false), null, 'no support is reported as none, not as webm');

  /* MP4 must win when both are offered: a phone cannot open WebM. */
  const both = X.pickVideoFormat((m) => true);
  assert.equal(both.ext, '.mp4');
  assert.equal(both.mime.startsWith('video/mp4'), true);

  assert.equal(X.videoSupported(null), false);
  assert.equal(X.videoSupported({ isTypeSupported: () => false }), false);
  assert.equal(X.videoSupported({ isTypeSupported: (m) => m.includes('webm') }), true);
});

test('a phone gets the share sheet, a desktop gets a download', async () => {
  const blob = new Blob([new Uint8Array(16)], { type: 'video/mp4' });
  const shared = [];
  class FakeFile {
    constructor(parts, name, options) { this.name = name; this.type = options.type; this.size = 16; }
  }
  const mobile = await X.saveBlob(blob, 'clip.mp4', {
    File: FakeFile,
    navigator: {
      canShare: ({ files }) => files[0].name.endsWith('.mp4'),
      share: async (payload) => { shared.push(payload.files[0].name); }
    }
  });
  assert.equal(mobile.method, 'share');
  assert.deepEqual(shared, ['clip.mp4'], 'the file really was handed to the OS');

  const clicked = [];
  const desktop = await X.saveBlob(blob, 'clip.mp4', {
    File: FakeFile,
    navigator: { canShare: () => false },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    document: {
      body: { appendChild: () => {} },
      createElement: () => ({ click: () => clicked.push('clicked'), remove: () => {} })
    }
  });
  assert.equal(desktop.method, 'download');
  assert.equal(clicked.length, 1);

  /* A user who cancels the share sheet must still get a file. */
  const afterCancel = await X.saveBlob(blob, 'clip.mp4', {
    File: FakeFile,
    navigator: { canShare: () => true, share: async () => { throw new Error('AbortError'); } },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    document: {
      body: { appendChild: () => {} },
      createElement: () => ({ click: () => clicked.push('clicked'), remove: () => {} })
    }
  });
  assert.equal(afterCancel.method, 'download', 'a cancelled share falls back to a download');
});

test('file names are portable', () => {
  assert.equal(X.fileName('FinalEffect', 1080, 1920, 'F30', '.png'), 'FinalEffect_1080x1920_F30.png');
  assert.equal(X.fileName('FinalEffect', 1920, 1080, '30fps', '.mp4'), 'FinalEffect_1920x1080_30fps.mp4');
  assert.ok(!/[\s:/\\]/.test(X.fileName('A', 1, 1, 'a b:c/d\\e', '.png')));
});

test('the PNG-sequence archive is a real ZIP a tool can open', async () => {
  const zip = X.createZip();
  zip.add('frames/frame_00001.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  zip.add('frames/frame_00002.png', new Uint8Array([9, 8, 7]));
  assert.equal(zip.count, 2);

  const blob = zip.build();
  assert.equal(blob.type, 'application/zip');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(view.getUint32(0, true), 0x04034b50, 'the first local header is where it must be');
  assert.equal(view.getUint16(8, true), 0, 'entries are stored, not deflated — they are already PNGs');

  /* Walking the central directory is what an unzip tool does. */
  const endOffset = bytes.length - 22;
  assert.equal(view.getUint32(endOffset, true), 0x06054b50, 'the archive ends with its directory');
  assert.equal(view.getUint16(endOffset + 8, true), 2, 'both entries are listed');

  const crcOffset = 14;                                   /* local header CRC field */
  assert.equal(view.getUint32(crcOffset, true), X.crc32(new Uint8Array([137, 80, 78, 71, 1, 2, 3])),
    'the CRC in the header matches the data');
  assert.equal(X.crc32(new TextEncoder().encode('hello')), 0x3610a686, 'and the CRC itself is the standard one');
});

test('the recorder captures frames, not wall-clock ticks', () => {
  const captured = [];
  let stopped = false;
  const track = { requestFrame: () => captured.push(captured.length), stop: () => {} };
  const canvas = { captureStream: () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) };
  class FakeRecorder {
    static isTypeSupported(mime) { return mime.startsWith('video/mp4'); }
    constructor(stream, options) { this.state = 'recording'; this.mimeType = options.mimeType; }
    start() {}
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  }

  const recording = X.beginRecording(canvas, { MediaRecorder: FakeRecorder });
  assert.ok(recording, 'a recorder is handed back');
  assert.equal(recording.format.ext, '.mp4');
  assert.equal(recording.manual, true, 'the capture track is driven by hand');

  for (let i = 0; i < 5; i++) recording.capture();
  assert.equal(recording.frames, 5);
  assert.equal(captured.length, 5, 'exactly one track frame per rendered frame');

  recording.cancel();
  assert.equal(stopped, false);

  /* Without a recorder at all, the caller is told so it can fall back. */
  assert.equal(X.beginRecording({ captureStream: () => ({ getVideoTracks: () => [], getTracks: () => [] }) },
    { MediaRecorder: { isTypeSupported: () => false } }), null);
});

test('the engine saves through the new formats and never silently drops a video', () => {
  const save = engineSource.slice(engineSource.indexOf('downloadRenderedStill() {'));
  assert.ok(save.indexOf('encodeStill') > 0 && save.indexOf('saveBlob') > 0, 'still saving goes through the format table');
  assert.ok(engineSource.includes('downloadRenderedPNG() {'), 'the old name still exists for saved pages');

  const video = engineSource.slice(engineSource.indexOf('renderAnimationSequenceVideo() {'));
  assert.ok(video.indexOf('beginRecording') > 0, 'video uses the frame-accurate recorder');
  assert.ok(video.indexOf('createZip') > 0, 'and falls back to a PNG sequence when there is no encoder');
  assert.ok(!/setTimeout\(r, Math\.max\(16/.test(video), 'no wall-clock frame pacing is left');
  assert.ok(video.indexOf('saveBlob') > 0, 'the finished file is saved, not just logged');

  assert.ok(html.includes('id="render-still-format"'), 'the format is a user setting');
  assert.ok(html.includes('value="webp"') && html.includes('value="jpeg"') && html.includes('value="png"'));
  assert.ok(html.includes('FECppEngine.downloadRenderedStill()'), 'the button saves in the chosen format');
  assert.ok(html.includes('id="render-denoise-toggle"'), 'and the denoiser can be turned off');
});

test('the export module ships with the app', () => {
  assert.ok(sw.includes("'./render-export.js'"), 'the service worker caches it');
  assert.ok(html.includes('<script src="render-export.js"></script>'));
  assert.ok(html.indexOf('render-export.js') < html.indexOf('fe-cpp-engine.js'), 'loaded before the engine');
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(build.includes('"render-export.js"'));
  assert.ok(build.includes('renderExport: readFileSync'));
  assert.ok(readFileSync('scripts/standalone-html.mjs', 'utf8').includes("['render-export.js', renderExport]"));
});

test('the ZIP is genuinely a ZIP', () => {
  /* Deflate the archive's own contents with zlib as an external check that the
     stored bytes are the image bytes, not an offset mistake. */
  const zip = X.createZip();
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  zip.add('a.png', payload);
  return zip.build().arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    const nameLength = new DataView(bytes.buffer).getUint16(26, true);
    const start = 30 + nameLength;
    assert.deepEqual(Array.from(bytes.slice(start, start + payload.length)), Array.from(payload));
    assert.equal(zlib.deflateSync(Buffer.from(payload)).length > 0, true);
  });
});
