# Timeline: unlimited range and playback

The timeline has no fixed length. Frame `0` is the origin, and the end of the
visible range is just a window that grows whenever something needs more room.

## What "unlimited" means

| Behaviour | Rule |
| --- | --- |
| End frame | Any finite non-negative integer. Only `Number.MAX_SAFE_INTEGER` is a guard, so `1e999` cannot poison the axis math. |
| Start frame | `0` or later, always `< end`. |
| Keyframes | A key beyond the window widens it (`timelineAutoFitRange`). |
| Simulation bake | A bake whose `frameEnd` is beyond the window widens it. |
| Playhead | A frame typed into the **Frame** field past the end widens it. |
| Scrubbing | Dragging past the right edge of the ruler adds time instead of stopping. |
| Playback | Keeps extending the axis in 50-frame pages. Nothing wraps or stops. |
| Fit to keys | Sizes the window to the last key (or bake) plus a 12-frame tail. |

`timelineAutoFitRange()` never shrinks the window; only the explicit range
controls do (`applyTimelineRange`, `fitTimelineRangeToKeys`).

## Controls

**Timeline header** (`#studio-timeline-bar`)

* `Frame`, `Start`, `End` numeric fields
* `▶` play/pause, `⏮` first frame, `⏭` end frame, `◀ ◆` / `◆ ▶` previous/next key
* `SNAP` — magnet scrubbing onto keyframes

**Animation Studio → Timeline strip** (`#anim-range-strip`)

* `Start` / `End` fields
* `+50` — extend the end by 50 frames
* `Fit to keys` — size the window to the last keyframe
* `Loop: off/on` — off (default) means unlimited playback; on loops inside
  `[start, end]`
* status chip showing the current `start – end`

## Playback

```js
if (nextFrame > timelineConfig.endFrame) {
  if (timelineConfig.loopRange) { /* wrap inside the range */ }
  else growTimelineForFrame(nextFrame);       /* unlimited */
}
```

`growTimelineForFrame(frame)` rounds up to the next 50-frame page so the ruler
does not rescale on every single frame.

## Scrubbing

`applyTimelineScrub(clientX)` still maps the pointer position absolutely (never
`currentFrame + delta`, which used to drift). Two additions:

* a pointer left of the plot clamps to `startFrame`;
* a pointer past the right edge adds `overshoot × framesPerPx × 1.6` frames
  (capped at 320 px of overshoot per move) and then lands the playhead on the
  new end.

## No solver badge

The timeline header used to carry a green readiness pill
(`#tb-status-badge`, e.g. `Physics: ready`). It is gone: the viewport chrome
never reports engine or solver state. `getSolverDiagnostics()` still returns
`backendLabel`, and that is shown in ⚙ → Run Benchmark only.

`removePhysicsBadgeFromDom()` deletes the pill if an installed client still has
it cached, and `SimulationEngine.updateStatusBadge()` now only performs that
removal.

## Verifying

* `node --test tests/timeline-range.test.mjs tests/timeline-scrub.test.mjs`
* `node --test tests/physics-badge-guard.test.mjs`
* In the app: set `End` to 5000 → the ruler spans it; play → the playhead keeps
  going and the end keeps growing; drag past the right edge → the timeline
  extends; tap `Loop: on` → playback wraps inside the range instead.
