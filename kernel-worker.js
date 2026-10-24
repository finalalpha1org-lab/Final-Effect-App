/* Off-thread kernel channel.
 *
 * Every heavy thing this app does is C++ already. The remaining cost is *where*
 * it runs: a kernel call blocks the frame it is called on, and one 30 ms call is
 * a visible stutter however fast the maths is. This module gives the core a
 * second home — a Worker with its own instance of the same artifact — and a
 * small job table shared by both threads, so a job behaves identically whether
 * it runs off-thread or falls back inline.
 *
 * Design rules, because a worker is easy to get subtly wrong:
 *
 *   - The job table is one function. The worker stringifies it, the inline
 *     fallback calls it. There is no second implementation to drift.
 *   - Results cross as typed arrays with a transfer list: no structured clone
 *     of a megabyte of atlas, no copy on the way back.
 *   - If a Worker cannot start (no Blob URL, blocked, out of memory, a module
 *     that will not instantiate) the channel reports `mode:'inline'` and every
 *     job still completes, synchronously. The app must never depend on the
 *     worker existing.
 *   - A job that throws comes back as a rejected promise with the same message
 *     the inline path would have thrown, so the caller has one error path.
 *
 * The first payload is the impostor baker: 20–36 ms per species on this
 * machine, which is 80–140 ms on a phone — far too much for a frame, and
 * exactly the kind of work that does not need the main thread at all.
 */
(function (root) {
  'use strict';

  const PROTOCOL = 1;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ---- job table ------------------------------------------------------- *
   * `api` is whatever can run kernel calls: in the worker it is an adapter over
   * the raw exports, on the main thread it is the FELandscapeCore bridge. Both
   * expose the same few methods, which is what keeps the two paths honest. */
  function jobTable(api) {
    const jobs = {};

    /* Bake one species' impostor atlas. Returns the pixels and the quad
       rectangle the studio needs to draw them; the bytes are transferred, so
       this is only safe to call when the caller owns the copy. */
    jobs.impostor = function impostor(a) {
      if (!api || typeof api.impostor !== 'function') throw new Error('Kernel cannot bake impostors');
      const baked = api.impostor(a.kind, a.seed, a.detail, a.views);
      if (!baked || !baked.pixels) return null;
      return {
        result: {
          views: baked.views, width: baked.width, height: baked.height,
          quadW: baked.quadW, quadH: baked.quadH, coverage: baked.coverage,
          cropU: baked.cropU, cropV: baked.cropV, offU: baked.offU
        },
        pixels: baked.pixels,
        transfer: [baked.pixels.buffer]
      };
    };

    return jobs;
  }

  /* ---- worker body ----------------------------------------------------- *
   * Stringified into the Blob below. It must not close over anything. */
  function workerMain(__feJobTable) {
    let table = null;
    const pending = [];

    function makeApi(ex) {
      function impostor(kind, seed, detail, views) {
        const n = ex.fe_impostor_build(kind | 0, (seed >>> 0) || 1, detail | 0, views | 0);
        if (n < 1) return null;
        const w = ex.fe_impostor_width(), h = ex.fe_impostor_height();
        const bounds = new Float32Array(new Float32Array(ex.memory.buffer, ex.fe_impostor_bounds_ptr(), 8));
        return {
          views: n, width: w, height: h,
          pixels: new Uint8Array(new Uint8Array(ex.memory.buffer, ex.fe_impostor_pixels_ptr(), w * h * n * 4)),
          quadW: bounds[0], quadH: bounds[1], coverage: bounds[2], baseY: bounds[3],
          cropU: bounds[4], cropV: bounds[5], offU: bounds[6]
        };
      }
      return { impostor: impostor };
    }

    function run(msg) {
      const id = msg.id;
      try {
        const job = table[msg.name];
        if (!job) throw new Error('Unknown kernel job: ' + msg.name);
        const out = job(msg.args || {});
        if (!out) { self.postMessage({ type: 'result', id: id, value: null }); return; }
        self.postMessage({ type: 'result', id: id, value: out.result, pixels: out.pixels }, out.transfer || []);
      } catch (error) {
        self.postMessage({ type: 'error', id: id, message: String((error && error.message) || error) });
      }
    }

    self.onmessage = function (event) {
      const msg = event.data || {};
      if (msg.type === 'init') {
        try {
          const exports = new WebAssembly.Instance(new WebAssembly.Module(msg.bytes), {}).exports;
          table = __feJobTable(makeApi(exports));
          self.postMessage({ type: 'ready', protocol: msg.protocol });
          for (const job of pending.splice(0)) run(job);
        } catch (error) {
          self.postMessage({ type: 'failed', message: String((error && error.message) || error) });
        }
        return;
      }
      if (msg.type === 'job') {
        if (!table) { pending.push(msg); return; }
        run(msg);
      }
    };
  }

  function buildSource() {
    /* The table is passed in, not looked up on `self`: a top-level binding in a
       classic worker is not guaranteed to be a global property, and a sandbox
       that runs this body is not a worker at all. */
    return 'var __feJobTable=' + jobTable.toString() + ';\n(' + workerMain.toString() + ')(__feJobTable);';
  }

  /* ---- inline channel -------------------------------------------------- *
   * The same table, run here. Used as the fallback and as the answer to a job
   * that arrives before the worker is ready. */
  function inlineChannel(api) {
    const table = jobTable(api);
    const stats = { jobs: 0, ranInline: 0, lastError: null };
    return {
      mode: () => 'inline',
      stats: () => ({ ...stats }),
      runInline(name, args) {
        const job = table[name];
        if (!job) throw new Error('Unknown kernel job: ' + name);
        stats.jobs++;
        stats.ranInline++;
        try {
          const out = job(args || {});
          return out ? { ...out.result, pixels: out.pixels } : null;
        } catch (error) {
          stats.lastError = String((error && error.message) || error);
          throw error;
        }
      }
    };
  }

  /* ---- client ---------------------------------------------------------- *
   * `create()` never throws: on any failure it hands back an inline channel
   * with the same interface, so callers never branch on "is there a worker". */
  function create(options) {
    const opts = options || {};
    const api = opts.api || (root.FELandscapeCore || null);
    const bytes = opts.bytes || (api && typeof api.bytes === 'function' ? api.bytes() : null);
    const fallback = inlineChannel(api);
    const stats = {
      mode: 'inline', jobs: 0, ranOffThread: 0, ranInline: 0,
      lastError: null, bootMs: 0, busyMs: 0
    };
    for (const key of Object.keys(fallback.stats())) stats[key] = fallback.stats()[key];

    let worker = null, url = null, failed = false, seq = 0, bootAt = now();
    const inFlight = new Map();
    let readyResolve = null, readyReject = null;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    ready.catch(() => {});

    function inlineResult(name, args) {
      const value = fallback.runInline(name, args);
      const count = fallback.stats();
      stats.jobs = count.jobs;
      stats.ranInline = count.ranInline;
      stats.lastError = count.lastError;
      return value;
    }

    function fail(error) {
      if (failed) return;
      failed = true;
      stats.mode = 'inline';
      stats.lastError = String((error && error.message) || error);
      try { readyReject(error); } catch (thrown) { /* nobody listening */ }
      for (const [, entry] of inFlight) {
        try { entry.resolve(inlineResult(entry.name, entry.args)); }
        catch (thrown) { entry.reject(thrown); }
      }
      inFlight.clear();
    }

    const channel = {
      ready: null,
      run(name, args) {
        if (failed || !worker) {
          return Promise.resolve().then(() => inlineResult(name, args)).catch((error) => {
            stats.lastError = String((error && error.message) || error);
            throw error;
          });
        }
        stats.jobs++;
        stats.ranOffThread++;
        const id = ++seq;
        const started = now();
        return new Promise((resolve, reject) => {
          const settle = (fn, value) => { stats.busyMs += now() - started; fn(value); };
          inFlight.set(id, {
            name, args,
            resolve: (value) => settle(resolve, value),
            reject: (error) => settle(reject, error)
          });
          try {
            worker.postMessage({ type: 'job', id, name, args });
          } catch (error) {
            inFlight.delete(id);
            try { resolve(inlineResult(name, args)); } catch (thrown) { reject(thrown); }
          }
        });
      },
      runInline: (name, args) => inlineResult(name, args),
      dispose() {
        try { if (worker) worker.terminate(); } catch (error) { /* already gone */ }
        try { if (url) URL.revokeObjectURL(url); } catch (error) { /* not a blob url */ }
        worker = null;
        stats.mode = 'inline';
      },
      mode: () => stats.mode,
      stats: () => ({ ...stats })
    };

    /* Booting the worker needs a real Worker, a Blob URL and the artifact
       bytes. Any of the three missing is not an error — it is the inline path. */
    const canSpawn = typeof root.Worker === 'function' && typeof root.Blob === 'function' &&
      typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && !!bytes;

    if (!canSpawn) {
      stats.mode = 'inline';
      channel.ready = Promise.resolve(false);
      return channel;
    }

    try {
      url = URL.createObjectURL(new Blob([buildSource()], { type: 'text/javascript' }));
      worker = new root.Worker(url);
    } catch (error) {
      fail(error);
      channel.ready = ready;
      return channel;
    }

    worker.onerror = (event) => fail(new Error(event && event.message ? event.message : 'Kernel worker failed'));
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ready') {
        stats.mode = 'worker';
        stats.bootMs = now() - bootAt;
        readyResolve(true);
        return;
      }
      if (msg.type === 'failed') { fail(new Error(msg.message)); return; }
      const entry = inFlight.get(msg.id);
      if (!entry) return;
      inFlight.delete(msg.id);
      if (msg.type === 'error') { entry.reject(new Error(msg.message)); return; }
      if (msg.value === null || msg.value === undefined) { entry.resolve(null); return; }
      entry.resolve({ ...msg.value, pixels: msg.pixels });
    };

    try {
      /* The bridge keeps its copy — self-heal re-parses it — so the worker gets
         its own, transferred rather than cloned. */
      const copy = bytes.slice();
      worker.postMessage({ type: 'init', protocol: PROTOCOL, bytes: copy }, [copy.buffer]);
    } catch (error) {
      fail(error);
    }

    channel.ready = ready;
    return channel;
  }

  root.FEKernelWorker = { create, PROTOCOL, jobTable, source: buildSource };
})(typeof window !== 'undefined' ? window : globalThis);
