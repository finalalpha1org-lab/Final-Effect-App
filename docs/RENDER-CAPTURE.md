# Render capture: what a rendered frame contains

Two render engines ship in the 3D Workspace — **FE Cycles** (the C++ BVH path
tracer in `cpp/src/fe_renderer.cpp`) and **FE Eevee + Post-FX** (a WebGL raster
capture piped through the C++ compositor). They share one rule about what a
render *is*, and this file records it because both engines got it wrong in the
same way.

## The rule

> A render is the artwork. The grid, the 3D cursor, the camera rig, the light
> rig, the shadow floor and the transform widget are the editor, and an engine
> that photographs them is broken — the grid is not a scene object, so no
> setting in the render dialog could remove it afterwards.

`render-capture.js` owns that rule:

| Function | Job |
| --- | --- |
| `isRenderHelper(object)` | `isGridHelper`, `userData.isEditorHelper`, or one of `ShadowFloor`, `StudioFloor`, `Cursor3D`, `SelectionOutlineHelper` |
| `hideEditorHelpers(scene, engine, keep)` | hides every helper and returns exactly the objects it touched |
| `restoreEditorHelpers(hidden)` | puts back *those* objects only, so a helper that was already off stays off |
| `withEditorHelpersHidden(scene, engine, run, keep)` | the same, exception-safe |
| `resolveRenderCamera(engine, source)` | `'scene'` → the authored rig, `'viewport'` → the camera the artist is looking through |
| `prepareRenderCamera(camera, aspect)` | takes the camera for the capture: output aspect, no viewport crop |
| `restoreRenderCamera(camera, saved)` | hands the camera back bit for bit |

The shadow catcher is the one exception: `hideEditorHelpers(..., keep)` leaves
the `ShadowFloor` plane visible when the render dialog's **Ground shadow
catcher** is on, because there it is a rendered element rather than a helper.

## What was actually wrong

### 1. The grid was in every Eevee render

`renderSingleWebGLPostFXFrame()` rendered the whole scene graph into the
viewport renderer and copied the result. The viewport's `GridHelper`, the 3D
cursor, the camera pyramid and its wireframe lens, the light gizmo and the
shadow plane were all in that graph, so they were in the PNG and in every frame
of a sequence render. The path tracer had always filtered helpers by traversal;
the raster path had no equivalent, which is why turning **Floor Grid** off in
the settings changed the viewport and nothing about the render.

The capture now hides helpers *after* switching to rendered shading (that switch
is what turns the shadow catcher on) and restores them in a `finally`:

```js
const prevShading = eng.getShadingMode?.() || 'solid';
if (switchedShading) window.applyShadingMode('rendered');
const hiddenHelpers = RC.hideEditorHelpers(eng.sc, eng, keepShadowCatcher);
const cameraState = RC.prepareRenderCamera(cam, width / height);
try {
  eng.r.setPixelRatio(1);
  eng.r.setSize(width, height, false);
  eng.r.render(eng.sc, cam);
  ctx.drawImage(eng.r.domElement, 0, 0, width, height);
} finally {
  eng.r.setPixelRatio(prevPR);
  eng.r.setSize(prevSize.x, prevSize.y, false);
  RC.restoreRenderCamera(cam, cameraState);
  RC.restoreEditorHelpers(hiddenHelpers);
  if (switchedShading) window.applyShadingMode(prevShading);
}
```

A failed capture (lost context, an exception in the compositor) must not leave
the editor stripped, which is why the restore is in `finally` and not after the
draw.

### 2. The camera rig view rendered through a cropped lens

While **View as Camera** is active, `updateCameraFrame()` applies a
`setViewOffset()` crop to the real `sceneCamera` so the viewport shows the
authored frame box over the orbit view. `PerspectiveCamera.updateProjectionMatrix()`
honours `view` when enabled, so the capture inherited that crop and produced a
zoomed, offset image — a render that looked "wrong through the camera rig".

`prepareRenderCamera()` disables `view.enabled` for the length of the capture,
sets the output aspect, and `restoreRenderCamera()` puts both back:

```js
const saved = { aspect: camera.aspect, view: camera.view, viewEnabled: camera.view.enabled };
camera.view.enabled = false;
camera.aspect = width / height;
camera.updateProjectionMatrix();
```

The path tracer never had the crop (it traces from `getWorldPosition` /
`getWorldDirection` plus a vertical FOV), so it produced the *full* camera frame
while Eevee produced a crop of it. That mismatch is exactly what "the camera rig
view is buggy in Eevee" looks like side by side.

### 3. The two engines answered "which camera?" differently

The raster capture and the path tracer each resolved the camera source inline,
and only one of them read `getActiveCamera()`. The raster path could therefore
render a camera that was neither the rig nor the viewport camera, and nothing
guaranteed the two engines would ever agree — a still and a traced frame of the
same scene could be composed differently.

There is now one resolver, and the two meanings are explicit:

```js
function resolveRenderCamera(engine, source, activeCamera) {
  const rig = engine.sceneCamera || null;
  const view = engine.viewportCamera || null;
  if (source === 'scene') return rig || view || activeCamera || null;
  return activeCamera || view || rig;      // the camera the viewport draws with
}
```

* **Scene Camera 1 Rig** is the authored camera, whatever the viewport shows.
* **Active Viewport View** is the camera the viewport is *drawing with*: the
  orbit camera normally, and the rig itself while camera view is active — so the
  render matches the screen instead of silently switching lenses.

`renderSingleWebGLPostFXFrame()` and `uploadWorkspaceSceneToCpp()` both go
through `this.renderCamera()`; no render path resolves a camera on its own.

Resolution still drives the render framing (a "HD Production" still is 16:9
whatever the camera frame box shows), which is why the aspect is part of the
capture rather than something the camera keeps.

## Saving what came out: formats, and why a phone could not keep the video

The render dialog had a Save PNG button and a Render Video button, and both were
wired for a desktop. On iOS, `a[download]` with a blob URL in a standalone PWA
saves nothing, and a `.webm` file lands somewhere no app will open it. So the
output path now asks the device instead of assuming.

**Stills** (`render-export.js`): PNG, JPEG or WebP, chosen in the dialog, with a
quality slider that only appears for the lossy ones. The extension comes from
the blob the browser actually produced — a WebP request that silently returns a
PNG is saved as `.png`, not mislabeled.

**Video:** MP4/H.264 first, WebM second, decided by `MediaRecorder.isTypeSupported`
rather than by a hardcoded list in the wrong order. When the browser can encode
neither, the export falls back to a **PNG sequence in a ZIP**, written by a
store-only ZIP writer in the same module — the frames are already compressed, so
deflating them again would cost battery for no gain. That archive opens
anywhere, including in our own project importer, which is the point: a render
that cannot leave the browser is not a render.

**Saving:** if the platform can share files (`navigator.canShare({files})`), the
file goes through the share sheet — Files, Photos, or whatever the user picks.
Otherwise it is a normal download. A cancelled share falls back to the download
instead of losing the render.

**Frame accounting** has been wrong twice, in opposite directions:

1. `canvas.captureStream(fps)` samples the canvas on a wall clock, so a frame
   that took 300 ms occupied ten frames of video and the clip ran 3× slow.
2. `captureStream(0)` + `requestFrame()` after each frame fixed the frame count
   but still opened the recorder *while rendering*, so the file's timestamps
   came from how fast the path tracer happened to be on that device.

The render is now two phases. Phase one renders every frame of the timeline's
START→END range into memory (`FERenderExport.createSequence`, capped at 640 MB
of encoded frames) — no recorder is open yet. Phase two plays those frames into
a `2D` canvas on a `setTimeout`-accurate `1000/fps` clock while
`captureStream(0)` + `requestFrame()` records them. The clip is therefore
exactly `frames / fps` seconds long on a phone, on a desktop, and in a hidden
tab. If the browser cannot record at all, phase two is skipped and the same
buffered frames become `frames/frame_00001.png` in a store-only ZIP.

**Range:** the frame range is read from the timeline itself — the START/END
fields the user typed — through `FECppEngine.renderRange()`, and the render
dialog prints the same numbers back as `Frames 0–250 · 251 frames · 30 fps ·
8.4 s`. There is no second, private default range for animation.


## The viewport grid in the landscaping studio

The studio drew a 200 × 200 `GridHelper` and two ground axes and had no switch
at all — no setting, no chip, nothing. It now has both:

* **Terrain sheet → `Floor grid`** toggles the grid and the two axes together and
  remembers the choice in `fe_terrain_grid`;
* the workspace's **⚙ → Floor Grid** setting arrives over
  `FE_GLOBAL_SETTINGS` and drives it, because the studio is an iframe and
  otherwise a global preference stops at the frame boundary.

## Where the result goes: the Render Result window

A render is judged at full size, on a neutral background, and it is judged
*while* the editor is still open next to it. So Render Frame opens the result in
its own tab (`render-preview.js`), the way Blender gives a render its own window,
instead of only shrinking it into the dialog's preview pane.

The browser rules that shape it:

- **A window can only be opened from a user gesture.** The Render button opens
  it synchronously, before the first `await`, and every later sample pass or
  animation frame is posted into the window that already exists. Changing a
  dropdown re-renders into the open window; it never opens another one.
- **A blocked popup is not an error.** `ensure()` returns `null`, the dialog
  keeps its inline preview, and the user is told once. Nothing throws.
- **The window is written with `document.write`,** so it stays same-origin and
  frames travel as data URLs over `postMessage`. No blob lifecycle has to be
  managed across two documents.
- **The runtime is stringified into the document** (`attachPreviewRuntime`), so
  it shares no scope with the editor and cannot reach engine state even by
  accident. It only obeys messages whose `source` is its own opener.

Inside the window: fit / actual size, a checkerboard for transparency, Save,
frame thumbnails for animations, and F / 1 / S / Esc. `reset()` clears the
previous result at the start of each run, so a new still never leaves the last
one's filmstrip behind. The site never opens a second preview tab; the window
name is fixed, so a reload of the editor reuses it.

## Tests

`tests/render-capture.test.mjs` builds a small studio scene with real three.js
objects and asserts, without a GPU:

* the artwork survives a capture and every helper does not;
* a helper that was already off is not switched on by the restore;
* a throwing capture still restores the scene;
* the shadow catcher survives when the dialog asks for it;
* `prepareRenderCamera`/`restoreRenderCamera` round-trip a cropped camera's
  projection matrix bit for bit;
* `renderCamera()` defers to the shared rule, and the two meanings of the menu
  are pinned: the rig is the rig, the viewport is whatever it is drawing;
* both engines call the same helpers, and the helper ships in the page, the
  service worker cache, the build and the single-file app.

`tests/landscape-grid-toggle.test.mjs` runs the studio's grid switch in a vm and
checks the axes, the remembered choice and the parent-app message.

## Exporting the workspace: glTF and OBJ

Both buttons used to fail before writing a byte. The cause was not the format:

```text
TypeError: null is not an object (evaluating 'this.domElement.ownerDocument.addEventListener')
```

`exportGLTF()` copied the scene with `child.clone(true)`. The scene contains the
`TransformControls` gizmo, and cloning it re-runs its constructor with no
`domElement`, which falls back to `document` — and `document.ownerDocument` is
`null`. The same line existed in the animated glTF path. Three further problems
sat behind it:

- r128's `GLTFExporter` has no `InstancedMesh` support, so landscape foliage
  would have exported as one plant at the origin;
- those exporters only exist if the CDN answered, and a CDN dependency cannot be
  proven by an offline test;
- `parse(input, onDone, options)` silently never calls back if the loaded
  exporter is a different version than the one the call was written for, which
  leaves the dialog on "generating" forever.

So the writers are ours (`workspace-export.js`, plain arrays, no CDN):

| Step | What happens |
| --- | --- |
| `collect(scene)` | traverses once; skips gizmos (including anything under `TransformControls`), grids, cursors, onion ghosts, light/camera helpers, hidden objects and empty geometry; enforces a 900k-triangle budget and reports truncation |
| `bakeGeometry` | world matrix baked into positions, inverse-transpose into normals, index rebuilt with the right width |
| `bakeInstanced` | every instance matrix multiplied into one primitive, so N plants export as N plants |
| `buildGLB` / `buildGLTF` | glTF 2.0: one buffer, aligned bufferViews, POSITION/NORMAL/TEXCOORD_0 + indices, PBR materials deduplicated by name, optional animation samplers |
| `buildOBJ` / `buildMTL` | `o` / `v` / `vt` / `vn` / `f`, indices offset per object, `usemtl` + a `.mtl` with `Kd`, `Ns`, `d`, `Pr`, `Pm`, `Ke` |

The animated export now goes through the same collector, so a keyed object is
matched to its exported node by the name the collector gave it — not by cloning
the graph and hoping the clone kept the name.
