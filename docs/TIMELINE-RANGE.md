# Timeline: range, playback stop and transport

Blender rules on a phone: the timeline has **no length ceiling**, but once an
end frame is known it is a **wall**. Time is added by dragging the ruler past
the right edge or by typing a longer end frame — never as a side effect of
playback.

## What the range means

| Behaviour | Rule |
| --- | --- |
| End frame | Any finite non-negative integer, pinned to the right of the transport row. Only `Number.MAX_SAFE_INTEGER` is a guard, so `1e999` cannot poison the axis math. |
| Start frame | `0` or later, always `< end`. |
| Playback | **Stops exactly on the end frame** (`advanceTimelinePlayback().stopped`). With `Loop: on` it wraps inside `[start, end]` instead. |
| Play on the wall | Pressing play while parked on the end frame rewinds to `start` first, so the button never looks dead. |
| Frame step | `stepTimelineFrame(±1)` stops at both walls; it never wraps. |
| Dragging | A drag past the right edge adds `overshoot × framesPerPx × 1.6` frames (≤ 320 px of overshoot per move) and the new length becomes the wall. |
| Typing | `End` (header) or `Start`/`End` (Animation Studio strip) sets the wall directly. |
| Fit to keys | Sizes the wall to the last key (or bake) plus a 12-frame tail, and hands the range back to content tracking. |
| Auto-grow | Only while `timelineConfig.customRange` is **false** — a length the user typed, fitted or dragged is never silently stretched again. |

`timelineConfig.customRange` is the single switch: `false` = derive the length
from content, `true` = the user owns it.

## Controls

**Timeline header** (`#studio-timeline-bar`, 122 px tall — 132 px on phones)

* `End` numeric field **pinned** to the right, outside the scrolling row, so the
  wall is always one tap away
* raised 3D play disc (`#tb-play-btn`): glossy gradient, hard lip, indigo halo,
  pulsing ring while playing; play/pause swap is an SVG swap, not a text glyph
* `skipBack` / `skipForward` — first and last frame
* `stepBack` / `stepForward` — one frame (stops at the walls)
* amber `keyPrev` / `keyNext` — previous / next keyframe (a key beyond the wall
  widens the range to reach it)
* `SNAP`, `Key`, `Frame`, `Start`, `FPS`, `Bake Sim` live in the scrolling part
* chevron button collapses the bar to just the control row

**Animation Studio → Timeline strip** (`#anim-range-strip`)

* `Start` / `End` fields, `+50`, `Fit to keys`
* `Loop: off/on` — off (default) stops on the end frame, on loops inside the range
* status chip showing the current `start – end`

## Playback

```js
const advance = advanceTimelinePlayback(steps);   // pure: no DOM, no physics
if (advance.wrapped) resetAllPhysicsSimulations();
setTimelineCurrentFrame(advance.frame);
if (advance.stopped) stopTimelinePlayback();      // leaves the play disc in play state
```

`advanceTimelinePlayback` is pure so the rule is testable without a browser; the
render loop owns the side effects. `stopTimelinePlayback()` announces *how to add
time* once per session and never nags again.

## Scrubbing

`applyTimelineScrub(clientX)` maps the pointer position absolutely (never
`currentFrame + delta`, which used to drift). A pointer left of the plot clamps
to `startFrame`; a pointer past the right edge grows the range (see the table)
and then lands the playhead on the new end.

## No solver badge

The header used to carry a green readiness pill (`#tb-status-badge`). It is
gone: the viewport chrome never reports engine or solver state.
`removePhysicsBadgeFromDom()` deletes the pill if an installed client still has
it cached, and `SimulationEngine.updateStatusBadge()` only performs that removal.

## Verifying

* `node --test tests/timeline-range.test.mjs tests/timeline-scrub.test.mjs tests/timeline-transport.test.mjs`
* In the app: set `End` to 120 → play → the playhead stops on 120 and the disc
  returns to play; press play again → it rewinds and replays; drag past the right
  edge → the range grows to the next 50; `Loop: on` → playback wraps instead.
