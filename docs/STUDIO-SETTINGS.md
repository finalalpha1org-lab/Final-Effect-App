# Studio settings that persist

Every control in the Landscaping Studio — terrain, water, sky, weather, season,
open world and climate — used to live only in a live variable. A reload threw
all of them away. They are now one JSON document.

## Where it lives

| Build | Storage |
| --- | --- |
| Web | `localStorage['fe_landscape_config_v1']` |
| Native / offline | the same document exported with **Export settings JSON** |

The web shell's own viewport preferences keep their existing key
(`fe_global_settings_v1`) and are not duplicated here.

## The document

```json
{
  "app": "final-effect",
  "kind": "landscape-settings",
  "version": 1,
  "savedAt": "2026-10-23T09:14:02.118Z",
  "studio": {
    "seed": 128.5, "hs": 34, "rockT": 0.62, "snowL": 44, "biome": "hills",
    "wl": -6, "ampUser": 1.4, "wspd": 0.9, "waterWavePeriod": 8.2,
    "clarity": 0.8, "foam": 0.35, "tod": 14.5, "az": 120, "cov": 0.4,
    "fogD": 0.004, "windUser": 1.2, "season": "autumn",
    "waveAuto": false, "floraHeight": 1.2, "floraDensity": 1,
    "floraRules": "X -> F[+X]F[-X]+X | F[-X]F[+X]-X\nF -> FF",
    "sky": "{\"…\":…}", "wx": "{\"rainT\":0.2,…}"
  },
  "openWorld": {
    "sizeKm": 12, "seed": 42817, "blend": 0.58, "mountainHeight": 48,
    "waterCoverage": 35, "waterLevel": -28, "vegetationDensity": 0.9,
    "biomeMix": { "hills": 1, "alpine": 1, "desert": 1, "volc": 1 }
  },
  "climate": {
    "enabled": true, "latitude": 32, "temperature": 22, "humidity": 0.55,
    "continentality": 0.4, "wind": 6, "timeScale": 30, "fog": true,
    "wetnessFromRain": true, "autoTornado": false, "seed": 7
  }
}
```

`studio` is exactly the snapshot the undo system already took
(`captureStudioSettings()`), so the settings and the undo history can never
disagree about what a control means. Three of those fields are new and worth
naming:

* `waveAuto` — whether the sea was following the climate wind. Restored off if
  it was off, so a session never silently starts re-parameterising the water.
* `floraHeight` / `floraDensity` — the grown-flora shape multipliers, clamped to
  0.3–2.5 and 0.3–2.0 by the core on the way back in.
* `floraRules` — the fern grammar text exactly as it was typed. It is applied to
  the core after the module loads, and a grammar the current build rejects is
  dropped rather than retried on every boot.

## When it is written

* Any `input`, `change` or `click` inside the panel schedules **one** write after
  a 700 ms debounce — six slider moves produce one document.
* `pagehide` flushes a pending write, so closing the tab never loses the last
  edit.
* An explicit **Load settings from JSON** writes immediately after applying.

Writes are wrapped in `try/catch`: private-mode browsers and native shells
without `localStorage` simply keep the in-memory values and still get the
export path.

`biomeMix` is **merged**, never replaced: a document that names one influence
must not zero the other three, and a field whose type does not match the live
value is ignored rather than coerced.

## World size is not part of the memory budget

`openWorld.sizeKm` is stored like any other number, but it does not size a
buffer. The streamed world keeps only the nine 256 m chunks around the camera
resident, so 1 km and 50 km cost the same; `owSetWorldSize()` clamps to 1–50,
disposes the chunks that fall outside the new edge (moving edited ones into the
edit store), re-sizes the water plane and re-streams. `window.__feWorldMemory()`
reports the real footprint for diagnostics. A test asserts the resident byte
count is identical before and after growing the world from 12 km to 50 km.

## Restoring

`window.__feRestoreStudioConfig()` runs **before** the world is generated. It
reads the document, hands `studio` to `restoreStudioSettings()` (the same
function undo uses), copies the open-world numbers, copies the climate numbers
and re-seeds the climate kernel. The saved seed is passed to `gen()` so the same
world comes back, and the weather field resumes from the same parameters instead
of its defaults.

`applyStudioConfig()` is deliberately strict:

* the document must carry `kind: "landscape-settings"` and a `studio` object;
* a field is only copied when the destination already has that key **and** the
  types match, so a string can never become a world size or a `null` a water
  level;
* unknown fields are ignored, which keeps older and newer documents loadable.

A corrupt, empty or foreign JSON is refused without touching anything.

## Export and import

Both actions reuse the studio's existing export overlay, so there is no second
file dialog, no download helper and no new markup:

* **Export settings JSON** fills the overlay with the document and shows the
  copy button.
* **Load settings from JSON** parses whatever is in that box, applies it,
  regenerates the world from the saved seed and re-scatters the foliage.

## What the document deliberately excludes

Terrain heights, painted surface weights, scattered plants and placed objects
are *scene*, not settings. They are handled by the undo history and by the
autosave/export path (`makeLandscapeAutosave()`, `importToGrid()`), which already
serialise them as base64 buffers.
