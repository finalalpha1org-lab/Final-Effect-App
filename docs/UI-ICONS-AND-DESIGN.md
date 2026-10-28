# Icons and the visual system

Status: Very Early Demo, but the shell is now consistent: no emoji is rendered
anywhere in the app.

## One icon set

`fe-icons.js` is the only icon source. It ships 125 hand-written 24x24 stroke
icons (Feather-style geometry) and renders them inline, so every icon inherits
`currentColor`, the surrounding font size and the active accent.

```js
FEIcons.svg('cube')                    // -> '<svg class="ico" ...>'
FEIcons.glyphIcon('🧊')                // -> 'cube'
FEIcons.hydrate(rootElement)           // fill <i data-ico>, swap text emoji
```

Two integration paths:

1. **Declarative markup** - write
   `<i class="ico" data-ico="cube" data-size="20"></i>`; `hydrate()` replaces
   it with the SVG. The home cards, tabs, lock badge, settings dialog and
   benchmark button already use this.
2. **Runtime sweep** - any emoji that still arrives through a template string,
   a toast or the terrain page is replaced by the matching icon during
   hydration. A `MutationObserver` keeps doing this for dynamically rendered
   panels, so new UI cannot reintroduce emoji.

Emoji inside `<script>`, `<style>` and `<noscript>` is never touched (that text
is source, not UI). Inside `<option>`/`<textarea>`/`<title>` the glyph is
stripped instead, because those elements cannot render SVG. Unknown glyphs fall
back to `sparkle` rather than showing an emoji.

### Adding an icon

1. Add a `name: '<path .../>'` entry to `PATHS` in `fe-icons.js`.
2. If it replaces an emoji, add the glyph to `EMOJI`.
3. `npm test` - `tests/icon-system.test.mjs` fails if any glyph in any shipped
   source has no mapping, if an icon renders malformed markup, or if a page
   stops loading the renderer before the app scripts.

## Design tokens

The `FE design system` block at the end of the `<style>` in `index.html` adds
tokens and refines the shell without touching layout-critical selectors
(`.render-modal-backdrop`, the sheet heights, the diagnostics body, etc. are
unchanged on purpose - they are pinned by tests and by the bottom-sheet
contract).

| Token | Value | Used for |
| --- | --- | --- |
| `--fe-ink` | `#eef2ff` | primary text |
| `--fe-muted` | `#98a5c4` | secondary text |
| `--fe-line` / `--fe-line-strong` | `rgba(148,163,184,.16 / .28)` | hairlines |
| `--fe-surface` | `rgba(255,255,255,.045)` | raised surfaces |
| `--fe-accent` | `#7c8cff` | focus, active tab, icon tint |
| `--fe-radius` | `16px` | cards and tiles |
| `--fe-shadow` | `0 18px 40px -26px rgba(2,6,23,.95)` | card elevation |

Home cards get an accent rail (`--c` per studio), an icon tile, a lift on
hover/press, and pill tags. Focus rings are visible on every interactive
element, icons align on the text baseline (`.ico-wrap`), and text selection and
sheet scrollbars use the same accent.

## Bottom sheets have a grab handle

Every bottom sheet carries a grab handle on its top edge - camera, light, add
3D, modifiers, animation, Edit Mode, and the render / settings panels that dock
to the bottom on a phone. It is a 44 px bar in a 16 px sticky strip, and it is
the same control on all of them.

| Gesture | Result |
| --- | --- |
| Drag up | the panel follows the finger |
| Let go past halfway | it settles at 92 % of the viewport, still scrollable |
| Let go below halfway | it settles back at the height its CSS asks for |
| Tap | toggles between the two, so a thumb that misses the drag gets there anyway |

The handles are inserted by one controller (marked `FE-SHEET-GRIP` in
`index.html`) rather than written into each panel, so a sheet added later cannot
be the one panel without a handle, and `tests/sheet-grip.test.mjs` asks the page
which sheets it has and then checks each one got exactly one handle and that the
drag, the tap and the "never smaller than its own height" rule all behave.

A desktop modal is centred rather than docked, so `.render-modal-window`'s
handle is hidden above 900 px.

## Naming

The 3D studio is called **3D Workspace** everywhere (home card, breadcrumb,
recent-project entries, autosave messages). No `Workspace (3D Animation)` string
remains; `tests/icon-system.test.mjs` pins the new name and fails if the old one
returns.
