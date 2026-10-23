# Temporal anti-aliasing (render-target history + reprojection)

`fe-taa.js` is a real TAA pass for the 3D workspace: the scene is rendered into
an offscreen colour+depth target with a sub-pixel jittered projection, the
previous frame is reprojected into the current one, the history is clipped to
the local neighbourhood, and the result is blended and copied to the screen.

Status: implemented and wired, **not yet verified on a physical GPU** from this
environment. The pass is written so that any unsupported device or runtime
failure falls back to a plain `renderer.render()`.

## Frame

1. `jitter(frame, w, h)` - Halton(2,3), 64-frame cycle, one-pixel amplitude,
   applied to `projectionMatrix.elements[8]/[9]` (clip-space x/y).
2. Render `scene` into `sceneTarget` (`RGBA8` + `DepthTexture`).
3. Restore the unjittered projection immediately (`tests/taa-pass.test.mjs`
   pins this).
4. Composite into the write target:
   - reconstruct the world position from the depth buffer with the unjittered
     inverse projection,
   - project it with the **previous** view-projection matrix to get `prevUv`,
   - reject the sample when it leaves the screen or `w <= 0`,
   - clip the history to the min/max of the current 3x3 neighbourhood
     (variance clipping - this is what stops ghosting),
   - `mix(history, current, alpha)`, `alpha = 0.02..1`.
5. Ping-pong the history targets, store the current view-projection for the
   next frame.
6. Copy the blended frame to the screen, converting linear -> sRGB when the
   renderer's `outputEncoding` is sRGB.

## Settings

| Control | Default | Where |
| --- | --- | --- |
| `Temporal Anti-Aliasing` | on | global settings (⚙) |
| `AA Blend` | 0.12 | global settings (⚙) |
| `Temporal AA` | mirrors the above | viewport sheet (⚙ 3D workspace) |
| `AA Blend` | mirrors the above | viewport sheet |

`AA Blend` is the weight of the **new** frame: 0.05 keeps the sharpest image,
0.5 is calmest but can smear fast motion. Stored in `GLOBAL_SETTINGS.taa` /
`GLOBAL_SETTINGS.taaBlend` and persisted with the rest of the settings.

## Fallbacks

- No WebGL2 (`renderer.capabilities.isWebGL2 === false`) -> `create()` returns
  `null`, the loop keeps the direct render.
- A throw inside the pass -> `state.ok = false`, target reset, direct render for
  the rest of the session.
- `Temporal AA` off -> the loop calls `renderer.render(scene, camera)` directly.
- Resize / camera switch -> `reset()` drops the history so the first frame after
  the change is not reprojected from a stale buffer.

## Volume integration

The raymarch jitter in `simulationCore.js` is now frame-indexed (`uFrame`), so
successive frames sample different depth offsets; the history pass is what makes
those samples converge instead of crawling. This is the image-space half of the
look; `fe_vol_set_temporal()` smooths the *field* and is a separate control.

## Tests

`tests/taa-pass.test.mjs` (offline, no GPU):

- Halton values, one-pixel bounds, 16 unique sample offsets;
- `projectToUv` identity / off-screen / translated cases;
- three passes per frame, projection restored, history ping-pong, screen pass
  last, depth texture attached;
- resize rebuilds attachments and clears history;
- disabled pass and non-WebGL2 both fall back to a single direct render;
- shader anchors for reprojection and neighbourhood clipping;
- `index.html` wiring of both toggles and the fallback branch.

## Known limits

- Transparent surfaces (the volume itself) do not write depth, so their history
  is reprojected from the opaque depth behind them and leans on the
  neighbourhood clip. Acceptable for a demo; a per-pixel velocity buffer would
  be the next step.
- No motion-vector texture: reprojection is depth-based, not object-motion
  based, so animated meshes keep their history clipped rather than tracked.
