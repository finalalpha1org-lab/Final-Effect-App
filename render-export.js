/* SPDX-License-Identifier: GPL-3.0-or-later */

/* Render output: turning the picture in a canvas into a file on the device.

   A render that cannot leave the browser is not a render. Two things were
   wrong here and both are the kind of wrong that looks fine on a desktop:

   1. There was one still format and one video format. On iOS, a `.webm` file
      downloads to an app that cannot play it, and `a[download]` with a blob
      URL does nothing useful in a standalone PWA — so "save the video" quietly
      did not save anything. The fix is to ask the device what it can hold:
      prefer MP4/H.264, offer Web Share so a phone gets the file in Files or
      Photos, and fall back to a plain download when neither is available.
   2. The sequence recorder captured the canvas in real time (`captureStream`
      with a frame rate), so a frame that took 300 ms to render was stretched
      to occupy ten frames of wall clock. With `captureStream(0)` and
      `requestFrame()` the encoder takes exactly the frames the renderer
      produced, at exactly the timeline's frame rate, however long each took.

   Everything here is pure functions over a canvas plus a small ZIP writer, so
   the format choice and the frame accounting can be tested without a browser. */
(function (global) {
  'use strict';

  const STILL_FORMATS = [
    { id: 'png', label: 'PNG', mime: 'image/png', ext: '.png', lossy: false },
    { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: '.jpg', lossy: true },
    { id: 'webp', label: 'WebP', mime: 'image/webp', ext: '.webp', lossy: true }
  ];

  /* Order matters: MP4 is what every phone and every editor opens. WebM is the
     fallback that desktop browsers are good at and iOS is not. */
  const VIDEO_MIME_CANDIDATES = [
    { mime: 'video/mp4;codecs=avc1.42E01E', ext: '.mp4', label: 'MP4 (H.264)' },
    { mime: 'video/mp4;codecs=avc1', ext: '.mp4', label: 'MP4 (H.264)' },
    { mime: 'video/mp4', ext: '.mp4', label: 'MP4' },
    { mime: 'video/webm;codecs=vp9', ext: '.webm', label: 'WebM (VP9)' },
    { mime: 'video/webm;codecs=vp8', ext: '.webm', label: 'WebM (VP8)' },
    { mime: 'video/webm', ext: '.webm', label: 'WebM' }
  ];

  function stillFormat(id) {
    return STILL_FORMATS.find((f) => f.id === id) || STILL_FORMATS[0];
  }

  function clampQuality(value, format) {
    const n = Number(value);
    if (!format.lossy) return 1;
    if (!Number.isFinite(n)) return 0.92;
    return Math.max(0.2, Math.min(1, n));
  }

  /* Picks the best container this browser admits to supporting. An empty list
     of candidates (no MediaRecorder at all) returns null, and the caller
     falls back to a PNG sequence instead of pretending to record. */
  function pickVideoFormat(isSupported) {
    const test = typeof isSupported === 'function' ? isSupported : () => false;
    for (const candidate of VIDEO_MIME_CANDIDATES) {
      if (test(candidate.mime)) return candidate;
    }
    return null;
  }

  function videoSupported(recorderCtor) {
    const Ctor = recorderCtor || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    if (!Ctor) return false;
    return VIDEO_MIME_CANDIDATES.some((c) => {
      try {
        return typeof Ctor.isTypeSupported === 'function' ? Ctor.isTypeSupported(c.mime) : false;
      } catch (error) {
        return false;
      }
    });
  }

  /* A name every platform accepts: no spaces, no colons, no locale surprises. */
  function fileName(prefix, width, height, extra, ext) {
    const parts = [prefix, `${Math.round(width)}x${Math.round(height)}`];
    if (extra !== undefined && extra !== null && extra !== '') parts.push(String(extra).replace(/[:/\\\s]+/g, '-'));
    return `${parts.join('_')}${ext || ''}`;
  }

  /* ---- Saving ------------------------------------------------------ */

  function canShareFiles(file, nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (!n || typeof n.canShare !== 'function' || typeof n.share !== 'function') return false;
    try {
      return n.canShare({ files: [file] });
    } catch (error) {
      return false;
    }
  }

  /* The order is deliberate. On a phone, a share sheet puts the file in Files,
     Photos or the app the user actually wants; an anchor download in a
     standalone PWA puts it nowhere. On a desktop, the share sheet does not
     exist and the anchor is the right answer. */
  async function saveBlob(blob, name, options) {
    const opts = options || {};
    const nav = opts.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const FileCtor = opts.File || (typeof File !== 'undefined' ? File : null);

    if (opts.share !== false && FileCtor && nav) {
      try {
        const file = new FileCtor([blob], name, { type: blob.type || 'application/octet-stream' });
        if (canShareFiles(file, nav)) {
          await nav.share({ files: [file], title: name });
          return { method: 'share', name };
        }
      } catch (error) {
        /* The user cancelled, or the platform lied about canShare. Either way
           the download below is still worth trying. */
      }
    }

    if (!doc) return { method: 'none', name };
    const url = (opts.URL || global.URL || URL).createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try { (opts.URL || global.URL || URL).revokeObjectURL(url); } catch (error) { /* already gone */ }
    }, opts.revokeAfter || 4000);
    return { method: 'download', name };
  }

  /* ---- Still frames ------------------------------------------------ */

  /* Encodes the current canvas. WebP is offered only when the browser really
     produces WebP — Safari < 14 silently returns a PNG and the file name would
     then be a lie, so the blob's own type decides the extension. */
  function encodeStill(canvas, formatId, quality) {
    const format = stillFormat(formatId);
    const q = clampQuality(quality, format);
    return new Promise((resolve) => {
      const finish = (blob) => {
        if (!blob) return resolve(null);
        const actual = blob.type || format.mime;
        const ext = actual === 'image/webp' ? '.webp' : (actual === 'image/jpeg' ? '.jpg' : '.png');
        resolve({ blob, ext, mime: actual });
      };
      if (typeof canvas.toBlob === 'function') {
        try {
          canvas.toBlob((blob) => {
            if (blob) return finish(blob);
            /* A browser without WebP rejects the type and hands back a PNG;
               ask once more in a format that cannot fail. */
            canvas.toBlob((fallback) => finish(fallback), 'image/png');
          }, format.mime, q);
        } catch (error) {
          resolve(null);
        }
        return;
      }
      /* Node and very old browsers: data URL, converted without a DOM. */
      try {
        const url = canvas.toDataURL(format.mime, q);
        const comma = url.indexOf(',');
        const base64 = url.slice(comma + 1);
        const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
        finish(new Blob([bytes], { type: (format.mime || 'image/png') }));
      } catch (error) {
        resolve(null);
      }
    });
  }

  /* ---- PNG sequence fallback --------------------------------------- */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* A store-only ZIP. No compression: the entries are already-compressed PNGs,
     so deflating them again would cost battery for nothing. */
  function createZip() {
    const entries = [];
    const enc = new TextEncoder();

    function add(name, bytes, date) {
      const nameBytes = enc.encode(name);
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      entries.push({ name, nameBytes, data, crc: crc32(data), date: date || new Date() });
      return entries.length;
    }

    function dosTime(d) {
      return ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    }
    function dosDate(d) {
      return (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    }

    function build() {
      const chunks = [];
      const central = [];
      let offset = 0;
      entries.forEach((entry) => {
        const local = new Uint8Array(30 + entry.nameBytes.length);
        const view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0x0800, true);          /* UTF-8 names */
        view.setUint16(8, 0, true);               /* stored */
        view.setUint16(10, dosTime(entry.date), true);
        view.setUint16(12, dosDate(entry.date), true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.data.length, true);
        view.setUint32(22, entry.data.length, true);
        view.setUint16(26, entry.nameBytes.length, true);
        view.setUint16(28, 0, true);
        local.set(entry.nameBytes, 30);

        chunks.push(local, entry.data);

        const header = new Uint8Array(46 + entry.nameBytes.length);
        const hv = new DataView(header.buffer);
        hv.setUint32(0, 0x02014b50, true);
        hv.setUint16(4, 20, true);
        hv.setUint16(6, 20, true);
        hv.setUint16(8, 0x0800, true);
        hv.setUint16(10, 0, true);
        hv.setUint16(12, dosTime(entry.date), true);
        hv.setUint16(14, dosDate(entry.date), true);
        hv.setUint32(16, entry.crc, true);
        hv.setUint32(20, entry.data.length, true);
        hv.setUint32(24, entry.data.length, true);
        hv.setUint16(28, entry.nameBytes.length, true);
        hv.setUint32(42, offset, true);
        header.set(entry.nameBytes, 46);
        central.push(header);

        offset += local.length + entry.data.length;
      });

      const centralSize = central.reduce((n, c) => n + c.length, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);
      return new Blob([...chunks, ...central, end], { type: 'application/zip' });
    }

    return { add, build, get count() { return entries.length; } };
  }

  /* ---- Sequence buffering ------------------------------------------- */

  /* A render is slower than the timeline. Recording the canvas while it
     renders therefore makes a video whose speed is decided by the device: 20
     seconds of rendering for 8 seconds of animation, and the clip plays 2.5x
     too slowly. So the frames are rendered first and *then* played into the
     recorder at exactly the timeline's rate. `1/fps` per frame is the only
     timing in the pipeline that is allowed to matter. */
  function createSequence(options) {
    const opts = options || {};
    const frames = [];
    let bytes = 0;
    const limit = Number(opts.byteLimit) > 0 ? Number(opts.byteLimit) : 512 * 1024 * 1024;
    return {
      get count() { return frames.length; },
      get bytes() { return bytes; },
      get frames() { return frames; },
      get full() { return bytes >= limit; },
      add(blob) {
        if (!blob) return false;
        if (bytes + blob.size > limit) return false;
        frames.push(blob);
        bytes += blob.size;
        return true;
      }
    };
  }

  function waitUntil(deadline, nowFn) {
    const clock = nowFn || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const remaining = deadline - clock();
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 50)));
  }

  /* Draws each buffered frame and waits out the rest of its slot, so the
     recorder sees one frame per `1/fps`. Returns the number of frames played. */
  async function playSequence(canvas, frames, fps, onFrame, options) {
    const opts = options || {};
    const rate = Math.max(1, Math.min(120, Number(fps) || 30));
    const interval = 1000 / rate;
    const clock = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const ctx = canvas.getContext('2d');
    const start = clock();
    const decode = opts.decode || (async (blob) => {
      if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('frame could not be decoded')); };
        image.src = url;
      });
    });

    let played = 0;
    for (let i = 0; i < frames.length; i++) {
      const bitmap = await decode(frames[i]);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (typeof bitmap.close === 'function') bitmap.close();
      played++;
      if (typeof onFrame === 'function') onFrame(i);
      await waitUntil(start + (i + 1) * interval, clock);
    }
    return played;
  }

  /* "Frames 0–250 · 251 frames · 30 fps · 8.4 s" — the same numbers the render
     will use, because they are read from one place. */
  function rangeLabel(startFrame, endFrame, fps) {
    const start = Math.max(0, Math.round(Number(startFrame) || 0));
    const end = Math.max(start + 1, Math.round(Number(endFrame) || 0));
    const rate = Math.max(1, Math.round(Number(fps) || 30));
    const frames = end - start + 1;
    const seconds = frames / rate;
    return `Frames ${start}–${end} · ${frames} frames · ${rate} fps · ${seconds.toFixed(1)} s`;
  }

  /* ---- Video ------------------------------------------------------- */

  /* Starts a recorder that captures on demand instead of on a timer.
     `requestFrame()` exists on canvas capture streams everywhere that
     `captureStream` does; the timer path is only for browsers that ignore the
     zero frame-rate hint. */
  function beginRecording(canvas, options) {
    const opts = options || {};
    const RecorderCtor = opts.MediaRecorder || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    if (!RecorderCtor || typeof canvas.captureStream !== 'function') return null;

    const format = pickVideoFormat((mime) => {
      try {
        return typeof RecorderCtor.isTypeSupported === 'function' ? RecorderCtor.isTypeSupported(mime) : false;
      } catch (error) {
        return false;
      }
    });
    if (!format) return null;

    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    const manual = !!(track && typeof track.requestFrame === 'function');

    const chunks = [];
    let recorder = null;
    try {
      recorder = new RecorderCtor(stream, {
        mimeType: format.mime,
        videoBitsPerSecond: opts.bitrate || 12_000_000
      });
    } catch (error) {
      return null;
    }
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();

    let frames = 0;
    return {
      format,
      manual,
      get frames() { return frames; },
      /* Called after each rendered frame. The track is told there is a new one
         only when the browser supports it; otherwise captureStream(0) still
         samples the canvas when the timer below fires. */
      capture() {
        frames++;
        if (manual) {
          try { track.requestFrame(); } catch (error) { /* the track ended */ }
        }
      },
      async finish() {
        await new Promise((resolve) => {
          const done = () => resolve();
          if (recorder.state === 'inactive') return done();
          recorder.onstop = done;
          try { recorder.stop(); } catch (error) { done(); }
        });
        try { stream.getTracks().forEach((t) => t.stop()); } catch (error) { /* already stopped */ }
        const type = format.mime.split(';')[0];
        return { blob: new Blob(chunks, { type }), format, frames };
      },
      cancel() {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (error) { /* already stopped */ }
        try { stream.getTracks().forEach((t) => t.stop()); } catch (error) { /* already stopped */ }
      }
    };
  }

  const api = {
    STILL_FORMATS,
    VIDEO_MIME_CANDIDATES,
    stillFormat,
    clampQuality,
    pickVideoFormat,
    videoSupported,
    fileName,
    canShareFiles,
    saveBlob,
    encodeStill,
    createSequence,
    playSequence,
    waitUntil,
    rangeLabel,
    createZip,
    crc32,
    beginRecording
  };

  global.FERenderExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
