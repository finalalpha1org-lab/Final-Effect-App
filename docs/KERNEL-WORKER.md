# The off-thread kernel channel

The C++ core is no longer the slow part. Growing all 26 species takes **14 ms**,
generating the whole heightfield **4–5 ms**, culling 40 000 trees **0.04 ms**.
What still costs a frame is *where* that work runs: any kernel call blocks the
frame it is called on, and on a phone every millisecond here is about four.

`kernel-worker.js` gives the core a second home — a Worker with its own instance
of the same `fe_core_engine.wasm` — plus a job table shared by both threads.

## The rules it follows

1. **One job table.** The worker stringifies `jobTable()`; the inline fallback
   calls the same function. There is no second implementation to drift, and
   `tests/kernel-worker.test.mjs` asserts the two produce byte-identical
   atlases rather than merely "something".
2. **Typed arrays with a transfer list.** A 2 MiB atlas crosses threads without
   a copy in either direction.
3. **A worker is an optimisation, never a dependency.** No `Worker`, no Blob
   URL, a blocked CSP, an out-of-memory module, a job that throws — every one of
   those falls back to running the job on this thread, and the caller sees the
   same promise. The channel reports `mode:'inline'` instead of failing.
4. **Bounded concurrency.** At most two atlases bake at once; an in-flight slot
   is released on success *and* on failure.

## First payload: impostor baking

Measured on this machine (a desktop CPU; multiply by roughly four for a phone):

| species | grow | bake (8 azimuths) |
|---|---|---|
| oak | 5.0 ms | 26.5 ms |
| treefern | 0.7 ms | 35.7 ms |
| shrub | 0.8 ms | 20.6 ms |
| pine | 0.2 ms | 7.5 ms |
| all 26 species | **14 ms** | **268 ms** |

Baking was one dropped frame per species — up to 26 of them in a session. It is
now zero frames of main-thread work; the main thread only creates the
`DataTexture` around pixels that arrived from another thread.

The queue is unchanged in behaviour: a species is queued when it first has far
instances, baked once, cached for the session, and re-routed the moment its
atlas lands. If the worker is unavailable the bake runs inline, exactly as
before — slower, never broken.

## What this unlocks

The same table is where erosion, terrain rebuilds, flora regrowth and the Open
World chunk build go next: each is a pure function from inputs to a typed array,
which is precisely what a transfer-list job is for. The transport, the fallback
and the test harness are the hard parts, and they exist now.

## Honest limits

- **Two instances, two memories.** Each instance reserves the module's static
  memory (currently ≈169 MiB of zeroed BSS — the ocean fields, the edit-mesh
  undo pool, the terrain grid and the 24 MiB scratch arena). Browsers commit
  zero pages lazily, but the reservation is real and a low-memory device can
  refuse the second instance; the channel then reports `inline` and the app
  keeps working. Shrinking that footprint is a separate, worthwhile job.
- **No shared memory, no threads inside C++.** This is message passing between
  two single-threaded instances, not `SharedArrayBuffer` + wasm threads, so it
  needs no cross-origin isolation headers and works on the deployed origin
  today. A real thread pool is the next step, not this one.
- **No priority or cancellation.** Jobs run in the order they arrive and cannot
  be interrupted; a cancelled bake finishes and its result is dropped by the
  caller.
- **Boot cost.** The worker compiles the module a second time. It happens once,
  during idle, and nothing waits on it.
- **Not measured on a phone.** Same standing caveat as everything else here:
  this is a **Very Early Demo**, and the numbers above are desktop Node.

## Check it

```
node --test tests/kernel-worker.test.mjs
```

The test runs the shipped worker source inside a sandbox with the real artifact,
compares its atlas bytes against the main-thread path, drives an unknown job and
an impossible species, and asserts that a channel with no `Worker` still
completes the job and says so.
