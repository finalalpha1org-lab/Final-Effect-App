# Landscape layout

The app is mobile-first, but every studio has to stay usable when the phone is
turned sideways. Portrait keeps the original scrollable bottom sheets; landscape
re-docks the same panels to the right edge so the short (vertical) axis stays
free for the 3D canvas.

## Breakpoint

```css
@media (orientation: landscape) and (max-height: 620px) { … }
```

* `max-height: 620px` covers phones in landscape (≈ 320–440 px tall) and small
  desktop windows. Tablets in landscape (≈ 768 px tall) keep the portrait
  bottom-sheet model, which still fits there.
* The block is **additive**. The portrait rules (`.render-modal-backdrop
  {align-items:flex-end…}`, `height:62dvh;max-height:72dvh`) are untouched and
  still pinned by the existing tests.

## What changes in landscape

### Studio chrome (index.html)

| Element | Portrait | Landscape |
| --- | --- | --- |
| `.top-bar` | safe-area + 6 px | safe-area + 2 px, tighter gap |
| `.layer-bar` | 50 px | 34 px |
| `.toolbar` | `--tb: 54px` | `--tb: 44px` |
| `.timeline-bar` | 82 px (min 30) | 58 px (min 28), header 26 px |
| `#nav-gizmo-wrapper` | scale 1 | scale 0.72 |

The canvas keeps the remaining height; bottom sheets no longer eat it.

### Docked panels

`#camera-sheet`, `#light-sheet`, `#modifiers-sheet`, `#animation-sheet`,
`#landscape-sheet`, `#import-3d-sheet` and `#add-3d-sheet` all become
right-hand panels:

```css
top: 0; bottom: 0; left: auto; right: 0;
width: min(430px, 48vw);
border-radius: 14px 0 0 14px;
```

Half the width always stays on the canvas, so a parameter change is visible
while the sheet is open. The modifier sheet stacks to a single column inside
the narrower panel (`grid-template-columns: 1fr`).

### Modal cards

`#workspace-settings-sheet`, the render studio and the diagnostics modal use
`.render-modal-window`; in landscape the backdrop stretches and the card docks
right at `min(560px, 56vw)` with `height: 100%`. `.global-settings-card` loses
its `min-height: 420px` (which overflowed a 390 px tall phone) and takes the
full height instead of `max-height: 92vh`.

### Notch and home screen

Horizontal safe-area insets are applied to the top bar, toolbar, layer bar,
docked panels and modals, so the notch/cutout never covers a control. Home
switches to a tighter grid (240 px cards, smaller headings).

### Landscaping studio (Terrain_system_.html)

The terrain studio has its own landscape block: `#panel` and `#exploreSheet`
dock right, `#exploreSheet` slides in from the right (`translateX(100% + 24px)`
→ `transform: none` when open), the dock is capped at 26 vh and the explore
joystick sits at 84 px from the bottom instead of 158–270 px.

## Verifying

1. Rotate to landscape in the 3D workspace and open each sheet: the sheet must
   dock right, keep its own scroll, and leave the left half of the canvas
   visible.
2. Open ⚙ viewport settings → full-height panel, every row reachable by scroll.
3. Open the render studio → preview stage shrinks but stays visible.
4. Open Landscaping Studio → tool panel on the right, joystick reachable.
5. Rotate back to portrait → the original bottom sheets return unchanged.

`tests/landscape-layout.test.mjs` pins the breakpoint, the docking geometry,
the full-height modal rules, the safe-area usage and the studio docking. It also
asserts that the portrait bottom-sheet rules are still present, so a future
landscape change cannot silently replace the primary layout.

## Cache

`sw.js` is bumped to `final-effect-cpp-v15` so installed clients drop the
pre-landscape shell. Bump it again whenever `index.html` or
`Terrain_system_.html` change.
