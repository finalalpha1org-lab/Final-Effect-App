/* SPDX-License-Identifier: GPL-3.0-or-later */

/* Render Result window: the render gets its own tab, the way Blender gives it one.

   The render dialog is an editor. It has dropdowns, sliders and a thumbnail,
   and while you are dialling in a look that is exactly right. The moment a
   frame finishes, though, what you want is the picture — at its real size, on a
   neutral background, filling the screen — and you want it to stay there while
   you go back and move a slider. That is a second window, not a bigger panel.

   Two browser facts shape the design:

   1. A window can only be opened from a user gesture, so the caller opens it
      from the Render button. Every later frame — the next sample pass, the next
      animation frame — is posted into the window that is already open. If the
      popup is blocked, `ensure()` returns null and the caller keeps the inline
      preview: the feature degrades to the previous behaviour instead of
      throwing.
   2. The window is written with `document.write`, which keeps it same-origin,
      so frames travel as data URLs over `postMessage` and no blob lifecycle has
      to be managed across two documents.

   The window itself is a tiny self-contained document: the runtime below is
   stringified into it, so it shares no scope with the editor and cannot reach
   into engine state even by accident. */
(function (global) {
  'use strict';

  const MESSAGE_TYPE = 'fe-render-preview';
  const STORAGE_KEY = 'fe_render_window';
  const WINDOW_NAME = 'fe_render_preview';
  /* Intermediate frames during a progressive render are throttled: converting a
     1080p canvas to a data URL costs several milliseconds, and the preview does
     not need to see every sample pass. A final frame is always pushed. */
  const MIN_FRAME_INTERVAL = 90;

  let handle = null;
  let last = null;
  let lastPush = 0;
  let listening = false;

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function targetOrigin() {
    const origin = global.location && global.location.origin;
    return origin && origin !== 'null' ? origin : '*';
  }

  function isOpen() {
    return !!(handle && handle.win && !handle.win.closed);
  }

  function enabled() {
    try {
      const stored = global.localStorage ? global.localStorage.getItem(STORAGE_KEY) : null;
      return stored === null || stored === undefined ? true : stored === '1';
    } catch (error) {
      return true;
    }
  }

  function setEnabled(on) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch (error) { /* private mode: the switch just does not persist */ }
    if (!on) close();
  }

  function post(payload) {
    if (!isOpen()) return false;
    try {
      handle.win.postMessage(Object.assign({ type: MESSAGE_TYPE }, payload), handle.origin);
      return true;
    } catch (error) {
      return false;
    }
  }

  /* The window says hello when its runtime starts listening. Anything posted
     before that is not lost — the parent re-sends the current picture. */
  function onWindowMessage(event) {
    const data = event && event.data;
    if (!data || data.type !== MESSAGE_TYPE || data.kind !== 'ready') return;
    if (!isOpen() || (event.source && event.source !== handle.win)) return;
    if (last) post(last);
  }

  function installListener() {
    if (listening || !global.window || typeof global.window.addEventListener !== 'function') return;
    global.window.addEventListener('message', onWindowMessage);
    listening = true;
  }

  function previewHtml() {
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta name="color-scheme" content="dark">',
      '<title>Render Result</title><style>',
      PREVIEW_CSS,
      '</style></head><body>',
      '<header class="head"><div class="ttl"><strong id="title">Render Result</strong>',
      '<span id="meta">waiting for a frame</span></div><div class="tools">',
      button('btn-fit', 'Fit to window (F)', ICON_FIT),
      button('btn-one', 'Actual size (1)', ICON_ONE),
      button('btn-save', 'Save image (S)', ICON_SAVE),
      button('btn-close', 'Close (Esc)', ICON_CLOSE, 'danger'),
      '</div></header>',
      '<div class="progress"><div id="fill"></div></div>',
      '<div id="stage" class="stage fit"><div id="empty">No frame yet. Render from the 3D Workspace to fill this window.</div>',
      '<img id="shot" alt="Rendered frame"></div>',
      '<footer class="foot"><span id="spinner" class="spin"></span><span id="status">Ready</span>',
      '<div id="strip"></div></footer>',
      /* The closing tag is escaped so this file can itself be inlined into a
         one-file build without ending the host script early. */
      '<script>(', attachPreviewRuntime.toString(), ')(window, document);<\/script>',
      '</body></html>'
    ].join('');
  }

  function button(id, label, icon, tone) {
    return '<button type="button" id="' + id + '" class="tool' + (tone ? ' ' + tone : '') +
      '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>';
  }

  /* Opens the window if it is not already open, and re-sends the current
     picture if it is. Returns the handle, or null when the browser blocked the
     popup — the caller is expected to keep its inline preview in that case. */
  function ensure(options) {
    const opts = options || {};
    if (isOpen()) {
      post({ kind: 'meta', title: opts.title, total: opts.total, reset: !!opts.reset });
      if (last) post(last);
      return handle;
    }
    if (!global.window || typeof global.window.open !== 'function') return null;

    const width = Number(opts.width) > 0 ? Math.round(Number(opts.width)) : 0;
    const height = Number(opts.height) > 0 ? Math.round(Number(opts.height)) : 0;
    const winWidth = Math.min(1600, Math.max(620, Math.round(width * 0.72) + 300));
    const winHeight = Math.min(1200, Math.max(460, Math.round(height * 0.72) + 240));
    let win = null;
    try {
      win = global.window.open('', WINDOW_NAME,
        'width=' + winWidth + ',height=' + winHeight + ',menubar=no,toolbar=no,location=no,status=no');
    } catch (error) {
      win = null;
    }
    if (!win) return null;

    try {
      win.document.open();
      win.document.write(previewHtml());
      win.document.close();
    } catch (error) {
      return null;
    }
    handle = { win, origin: targetOrigin() };
    installListener();
    if (opts.title || opts.total) {
      post({ kind: 'meta', title: opts.title, total: opts.total, reset: !!opts.reset });
    }
    return handle;
  }

  /* Pushes a finished or in-progress frame. Returns false when there is no
     window, when the canvas cannot be encoded, or when an intermediate frame
     arrived inside the throttle window. */
  function pushCanvas(canvas, meta) {
    const info = meta || {};
    if (!isOpen() || !canvas || !canvas.width) return false;
    const stamp = now();
    if (!info.final && !info.force && stamp - lastPush < MIN_FRAME_INTERVAL) return false;
    /* The picture the user judges is lossless; the ones they watch arrive are
       JPEG, because a PNG encode per animation frame is several times more
       expensive and several times larger, and those frames are thumbnails. */
    let src = '';
    try {
      src = info.final ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88);
    } catch (error) {
      return false;
    }
    if (!src || src.length < 64) return false;
    lastPush = stamp;
    last = { kind: 'frame', src, meta: info };
    return post(last);
  }

  /* Starts a new render result: the window drops the previous frame and any
     filmstrip from the last run. Only posts when a window is already open, so a
     dropdown change can never try to raise a popup. */
  function reset(title) {
    last = null;
    lastPush = 0;
    return post({ kind: 'meta', title: title || 'Render Result', reset: true });
  }

  function progress(percent, text) {
    return post({ kind: 'progress', percent, text });
  }

  function status(text, busy) {
    return post({ kind: 'status', text, busy: !!busy });
  }

  function done(text, elapsed) {
    return post({ kind: 'done', text, elapsed });
  }

  function fail(text) {
    return post({ kind: 'error', text });
  }

  function close() {
    if (isOpen()) {
      try { handle.win.close(); } catch (error) { /* already gone */ }
    }
    handle = null;
    last = null;
  }

  /* The window's own runtime. Everything it needs is in its arguments, because
     this function is stringified into the popup and shares no scope with the
     editor. */
  function attachPreviewRuntime(win, doc) {
    'use strict';
    var $ = function (id) { return doc.getElementById(id); };
    var stage = $('stage');
    var shot = $('shot');
    var empty = $('empty');
    var fill = $('fill');
    var statusEl = $('status');
    var titleEl = $('title');
    var metaEl = $('meta');
    var strip = $('strip');
    var spinner = $('spinner');

    var frames = [];
    var current = -1;
    var zoom = 'fit';
    /* A filmstrip is a preview of the animation, not the animation: the video
       is exported separately, so the window keeps only the recent frames
       instead of growing without bound on a long sequence. */
    var MAX_FRAMES = 48;

    function clampPercent(value) {
      var n = Number(value);
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(100, n));
    }

    function seconds(ms) {
      var n = Number(ms);
      if (!isFinite(n) || n < 0) return '';
      return (n < 10000 ? (n / 1000).toFixed(1) : String(Math.round(n / 1000))) + ' s';
    }

    function setZoom(mode) {
      zoom = mode === 'one' ? 'one' : 'fit';
      if (stage) stage.className = 'stage ' + zoom;
      var fitBtn = $('btn-fit');
      var oneBtn = $('btn-one');
      if (fitBtn) fitBtn.setAttribute('aria-pressed', zoom === 'fit' ? 'true' : 'false');
      if (oneBtn) oneBtn.setAttribute('aria-pressed', zoom === 'one' ? 'true' : 'false');
    }

    function describe(meta) {
      if (!meta) return 'waiting for a frame';
      var bits = [];
      if (meta.width && meta.height) bits.push(meta.width + ' \u00d7 ' + meta.height);
      if (meta.spp) bits.push(meta.spp + (meta.sppTotal ? '/' + meta.sppTotal : '') + ' SPP');
      if (meta.index && meta.total) bits.push('Frame ' + meta.index + '/' + meta.total);
      if (meta.elapsed) bits.push(seconds(meta.elapsed));
      return bits.join(' \u00b7 ');
    }

    function saveCurrent() {
      var entry = frames[current];
      if (!entry) return;
      var meta = entry.meta || {};
      var ext = entry.src.indexOf('data:image/jpeg') === 0 ? '.jpg' : '.png';
      var a = doc.createElement('a');
      a.href = entry.src;
      a.download = meta.name || ('Render_' + (meta.width || shot.naturalWidth) + 'x' +
        (meta.height || shot.naturalHeight) + (meta.index ? '_F' + meta.index : '') + ext);
      doc.body.appendChild(a);
      a.click();
      a.remove();
    }

    function paint(index) {
      if (!frames.length) return;
      var at = Math.max(0, Math.min(frames.length - 1, index));
      current = at;
      var entry = frames[at];
      shot.src = entry.src;
      shot.style.display = 'block';
      if (empty) empty.style.display = 'none';
      if (metaEl) metaEl.textContent = describe(entry.meta);
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].node) frames[i].node.className = i === at ? 'thumb on' : 'thumb';
      }
    }

    /* One thumbnail per animation frame, created once and removed once, so a
       200-frame sequence costs one node at a time instead of a rebuild. */
    function makeThumb(entry) {
      if (!strip) return;
      var thumb = doc.createElement('img');
      thumb.className = 'thumb';
      thumb.src = entry.src;
      thumb.alt = 'Frame ' + (entry.meta.index || frames.length + 1);
      (function (self) {
        thumb.addEventListener('click', function () { paint(frames.indexOf(self)); });
      })(entry);
      entry.node = thumb;
      strip.appendChild(thumb);
    }

    function addFrame(src, meta) {
      var entry = { src: src, meta: meta || {} };
      frames.push(entry);
      /* A single result needs no strip. The moment there are two frames it
         becomes a sequence, and the first frame gets its thumbnail too. */
      if (strip && frames.length > 1) {
        for (var i = 0; i < frames.length; i++) if (!frames[i].node) makeThumb(frames[i]);
      }
      while (frames.length > MAX_FRAMES) {
        var dropped = frames.shift();
        if (dropped.node && strip) strip.removeChild(dropped.node);
      }
      paint(frames.length - 1);
      if (strip) strip.style.display = frames.length > 1 ? 'flex' : 'none';
    }

    /* A still render improves in place: the sample passes are the same picture,
       so they replace the frame rather than filling the strip with 24 copies. */
    function updateFrame(src, meta) {
      if (!frames.length || (meta && typeof meta.index === 'number')) { addFrame(src, meta); return; }
      var entry = frames[frames.length - 1];
      entry.src = src;
      entry.meta = meta || {};
      if (entry.node) entry.node.src = src;
      paint(frames.length - 1);
    }

    function onMessage(event) {
      /* Only the opener talks to this window. */
      if (win.opener && event.source && event.source !== win.opener) return;
      var data = event.data;
      if (!data || data.type !== 'fe-render-preview') return;

      if (data.kind === 'meta') {
        if (data.title && titleEl) titleEl.textContent = data.title;
        if (data.reset) {
          frames = [];
          current = -1;
          if (strip) { strip.textContent = ''; strip.style.display = 'none'; }
          if (empty) empty.style.display = '';
          if (shot) shot.style.display = 'none';
        }
        return;
      }

      if (data.kind === 'frame') {
        if (!data.src) return;
        updateFrame(data.src, data.meta || {});
        if (spinner) spinner.style.display = data.meta && data.meta.final ? 'none' : 'inline-block';
        return;
      }

      if (data.kind === 'progress') {
        if (fill) fill.style.width = clampPercent(data.percent) + '%';
        if (data.text && statusEl) statusEl.textContent = data.text;
        return;
      }

      if (data.kind === 'status') {
        if (statusEl && data.text) statusEl.textContent = data.text;
        if (spinner) spinner.style.display = data.busy ? 'inline-block' : 'none';
        return;
      }

      if (data.kind === 'done') {
        if (fill) fill.style.width = '100%';
        if (spinner) spinner.style.display = 'none';
        if (statusEl) statusEl.textContent = data.text || ('Finished in ' + seconds(data.elapsed));
        return;
      }

      if (data.kind === 'error') {
        if (spinner) spinner.style.display = 'none';
        if (statusEl) statusEl.textContent = data.text || 'Render failed';
        if (statusEl) statusEl.className = 'failed';
      }
    }

    function onKey(event) {
      var key = event.key ? String(event.key).toLowerCase() : '';
      if (key === 'f' || key === 'home') { setZoom('fit'); event.preventDefault(); }
      else if (key === '1') { setZoom('one'); event.preventDefault(); }
      else if (key === 's') { saveCurrent(); event.preventDefault(); }
      else if (key === 'escape') { win.close(); }
    }

    setZoom('fit');
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('message', onMessage);
      win.addEventListener('keydown', onKey);
    }
    var fitBtn = $('btn-fit');
    var oneBtn = $('btn-one');
    var saveBtn = $('btn-save');
    var closeBtn = $('btn-close');
    if (fitBtn) fitBtn.addEventListener('click', function () { setZoom('fit'); });
    if (oneBtn) oneBtn.addEventListener('click', function () { setZoom('one'); });
    if (saveBtn) saveBtn.addEventListener('click', saveCurrent);
    if (closeBtn) closeBtn.addEventListener('click', function () { win.close(); });

    if (win && win.opener && typeof win.opener.postMessage === 'function') {
      try {
        win.opener.postMessage({ type: 'fe-render-preview', kind: 'ready' }, '*');
      } catch (error) { /* opener is gone; the parent will re-post on its own */ }
    }
  }

  const ICON_FIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_ONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="6.5" width="15" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 10v4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0-4-4m4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const PREVIEW_CSS = [
    ':root{color-scheme:dark}',
    '*{box-sizing:border-box}',
    'html,body{height:100%}',
    'body{margin:0;display:flex;flex-direction:column;background:#0b0d14;color:#e2e8f0;',
    'font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}',
    '.head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;',
    'background:#11141e;border-bottom:1px solid #272d42;flex:none}',
    '.ttl{display:flex;flex-direction:column;min-width:0}',
    '.ttl strong{font-size:13px;letter-spacing:.01em;color:#f8fafc}',
    '#meta{font-size:11px;color:#94a3b8;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tools{display:flex;gap:6px;flex:none}',
    '.tool{width:30px;height:30px;display:grid;place-items:center;border-radius:8px;cursor:pointer;',
    'border:1px solid #2f364f;background:#171b28;color:#cbd5e1;padding:0}',
    '.tool:hover{background:#1f2536;border-color:#3c4564;color:#f8fafc}',
    '.tool[aria-pressed="true"]{background:#26304a;border-color:#4f5b86;color:#c7d2fe}',
    '.tool.danger:hover{background:#3b1d24;border-color:#7f1d1d;color:#fecaca}',
    '.tool svg{width:16px;height:16px;display:block}',
    '.progress{height:2px;background:#1b2030;flex:none}',
    '#fill{height:100%;width:0;background:linear-gradient(90deg,#4f46e5,#818cf8);transition:width .12s linear}',
    '.stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:14px;',
    'background-color:#0b0d14;',
    'background-image:linear-gradient(45deg,#12151f 25%,transparent 25%),linear-gradient(-45deg,#12151f 25%,transparent 25%),',
    'linear-gradient(45deg,transparent 75%,#12151f 75%),linear-gradient(-45deg,transparent 75%,#12151f 75%);',
    'background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}',
    '.stage.one{align-items:flex-start;justify-content:flex-start}',
    '#shot{display:none;max-width:100%;max-height:100%;object-fit:contain;',
    'box-shadow:0 10px 40px rgba(0,0,0,.6);background:#000}',
    '.stage.one #shot{max-width:none;max-height:none}',
    '#empty{color:#64748b;font-size:12px;text-align:center;max-width:260px}',
    '.foot{display:flex;align-items:center;gap:10px;padding:7px 12px;background:#11141e;border-top:1px solid #272d42;flex:none}',
    '#status{font-size:11px;color:#94a3b8;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#status.failed{color:#fca5a5}',
    '.spin{width:9px;height:9px;border-radius:50%;background:#818cf8;box-shadow:0 0 0 0 rgba(129,140,248,.55);',
    'animation:pulse 1.1s ease-out infinite;display:none;flex:none}',
    '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(129,140,248,.5)}70%{box-shadow:0 0 0 7px rgba(129,140,248,0)}100%{box-shadow:0 0 0 0 rgba(129,140,248,0)}}',
    '#strip{display:none;gap:5px;margin-left:auto;overflow-x:auto;flex:0 1 auto;padding-bottom:1px}',
    '.thumb{height:34px;width:auto;border-radius:4px;border:1px solid #2f364f;cursor:pointer;opacity:.72;flex:none}',
    '.thumb.on{border-color:#818cf8;opacity:1}'
  ].join('');

  const api = {
    MESSAGE_TYPE,
    STORAGE_KEY,
    WINDOW_NAME,
    MIN_FRAME_INTERVAL,
    enabled,
    setEnabled,
    isOpen,
    ensure,
    reset,
    pushCanvas,
    progress,
    status,
    done,
    fail,
    close,
    previewHtml,
    attachPreviewRuntime
  };

  global.FERenderPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
