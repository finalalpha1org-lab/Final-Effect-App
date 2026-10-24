# Landscape surface realism

Every natural material in the Landscaping Studio — grass, turf, soil, sand,
snow, granite, basalt, sandstone, bark, leaves, needles, gravel, lichen, water —
used to be described by a 256 px canvas of random speckles. Speckle has no
scale: at 2 m and at 20 cm it looks the same, so grass, snow and granite all
read as one grey noise field. That is the single biggest reason the procedural
landscape looked *procedural*.

`cpp/src/fe_surface.cpp` replaces the speckle with two things the eye actually
uses to identify a material:

1. **micro-structure at a real scale** (bark fibre, rock bedding + fracture,
   wind-packed sastrugi, aeolian ripples, leaf venation, packed gravel), baked
   into tangent-space normals and handed to the GPU as a normal/roughness map;
2. **measured PBR numbers** (albedo, roughness, F0, translucency) plus the
   physical modifiers that make a surface change under weather — wetness, snow
   grain ageing, lichen cover.

`landscape-realism.js` is the thin JS/GPU bridge: it asks the engine for the
buffers, paints them into the same canvases the renderer already samples, and
grounds each species' material in the measured table. It never contains a
physics constant of its own beyond a documented mirror used before the artifact
is ready.

## Engine API (`fe_surface_*`)

| Export | Result |
| --- | --- |
| `fe_surface_count()` | number of measured surfaces (15) |
| `fe_surface_pbr(surface, wet, snowAge, lichen, out[8])` | `[r, g, b, roughness, F0, translucency, anisotropy, 1]` in linear space |
| `fe_surface_detail(kind, w, h, seed, strength)` | fills the static RGBA float buffer with `(n.x, n.y, n.z, roughness)`, returns 1/0 |
| `fe_surface_detail_ptr()` / `fe_surface_detail_size()` | pointer and texel count of that buffer |
| `fe_water_optical(type, out[6])` | Jerlov absorption `(R, G, B)` in m⁻¹ then scattering `(R, G, B)` |
| `fe_surface_wind_roughness(U)` | Cox–Munk mean-square slope mapped to GGX roughness |
| `fe_surface_snow_albedo(base, ageDays, impurity)` | albedo after grain growth |

Surface ids: `0` meadow grass, `1` dry grass, `2` loam, `3` dry sand, `4` granite,
`5` basalt, `6` sandstone, `7` snow, `8` oak bark, `9` birch bark, `10` pine bark,
`11` broadleaf, `12` needle, `13` gravel, `14` lichen. Detail ids: `0` turf,
`1` loam, `2` rock, `3` snow, `4` sand, `5` bark, `6` leaf, `7` gravel, `8` ripple,
`9` lava, `10` moss.

**The two id lists are ABI.** `FELandscapeRealism.SURFACES` / `DETAIL_KINDS`
mirror them; never reorder either side.

## What the model does and does not claim

* Albedo values approximate published spectral albedos averaged to linear RGB.
* Roughness is a GGX perceptual roughness chosen to match the measured
  micro-structure, not a fitted BRDF.
* Wetness follows a smooth film model: the surface darkens by up to 46 %, F0
  rises towards water and roughness collapses to ~0.045.
* Snow ageing grows the grain radius as `50 + 26·√t` nm and attenuates albedo
  exponentially with radius, which is the Warren & Wiscombe 1980 result
  simplified to one band.
* Water absorption is Jerlov's five water types at 650 / 550 / 450 nm. Red goes
  first, which is why anything below a few metres reads blue; turbid types add
  CDOM absorption in the blue so an estuary turns green-brown instead.
* **Not modelled:** subsurface multiple scattering, specular sheen / velvet
  lobes on foliage, per-species BSSRDF, spectral (multi-band) rendering, and
  real measured textures. These are approximations, documented as such.

## Detail maps

The generator is fully periodic: every noise lattice frequency is an integer
and the Worley cells wrap, so a 256² tile is seamless in both axes. A 256² tile
costs 28–102 ms on the CPU (bark at 256×512 is the most expensive), therefore:

* every map is generated **once**; a six-entry LRU keeps the reuse path cheap
  without holding tens of megabytes of floats on a phone;
* jobs run **one per animation frame** through `upgrade()`, so the studio does
  not hitch on a phone;
* `fe_surface_detail` rejects sizes above 512 px (the static buffer is
  `512 × 512 × 4` floats).
* resolution follows how close the material is ever seen: terrain detail and
  snow at 256², bark micro-structure at 128 × 256 (sampled up to the 256 × 512
  colour canvas, which stays full resolution), leaf veining and biome tiles at
  128². That keeps the boot sweep at roughly 0.7 s of CPU spread one job per
  frame instead of 2 s with a 100 ms hitch.

## User settings

The realism controls live in the Landscaping dock (Terrain panel) and are
exposed as `FELandscapeRealism.settings` / `window.setLandscapeRealism(key, v)`:

| Setting | Range | Effect |
| --- | --- | --- |
| `detail` | 0–2 | strength of every micro-structure normal map |
| `wetness` | 0–1 | rain film on every exposed surface (darken + gloss) |
| `snowAge` | 0–300 days | grain growth: lower albedo, rougher, less translucent |
| `translucency` | 0–1.5 | back-lit leaf scatter multiplier |

Nothing here is a hidden constant: moving all four sliders to 0 returns the flat
procedural look.

## Where each value is used

* `TERRAIN_PBR.grass/soil/rock/snow/rough` — repainted with `turf`, `loam`,
  `rock`, `snow`, `rock` detail; the triplanar shader gained a `uSurfRough`
  `vec4` so grass, soil, rock and snow no longer share one roughness value.
* `OW_SURFACE_MAPS` biome tiles + `OW_SURFACE_ATLAS` — cavity-shaded with the
  matching biome micro-structure (moss, rock, sand, lava, gravel).
* `BT` / `BN` / `BR` bark colour, normal and roughness — all three repainted
  from the same bark buffer so they stay consistent; cactus skin only gets a
  fine pore pass because a cactus stem is waxy, not bark.
* `LEAF_PBR.*.nm` / `.rm` — leaf venation; the materials also gain a
  back-scatter term (`uFeTrans`) patched into the real three.js fragment
  shader, chained onto whatever cache key the wind injection already set.
* Water — the FFT waves already carry the large-scale slope, so the material
  roughness is scaled by how much rougher the profile's wind is than a 6 m/s
  reference sea (Cox–Munk) instead of being replaced by the absolute value.

## Rain without particles

Rain is one float, not a particle system. `WX.rain` (0–1, the resolved intensity
of the weather preset) is copied into `FXU.rain` once per weather tick, and every
surface shader reads that single uniform:

* **Ground** (`terrain-main-04.js`, the triplanar surface injection) —
  `roughnessFactor *= mix(1, 0.62, uRainK)` for soil and stone, and the puddle
  mask drives it further down to `0.045`. Where a puddle forms, the normal is
  perturbed by two sine ripples in world space (`sin(vW.x*7.1 + uT*3.3)` and
  friends, amplitude `0.055`) so the water surface moves without geometry.
* **Bark, needles and rock** (`wind()` in `terrain-main-01.js`) —
  `roughnessFactor *= mix(1, 0.55, uRainK)`, then `mix(roughness, roughness*0.35,
  uRainK*vSn*1.3)` so only upward-facing faces glaze. Wet foliage also keeps the
  existing `diffuseColor *= 1 - uWet*0.2` darkening.

The falling streaks are a 7 000-segment instanced batch in `terrain-main-06.js`
(`NR = 7000`), hidden entirely when `WX.rain < 0.02`. Nothing in the rain path
allocates per frame and nothing loops over a million particles.

## Fail behaviour

`upgrade()` refuses to run when `fe_surface_pbr` is absent: the scene keeps its
previous textures and one warning is logged. The reward for that is that
`REQUIRED_KERNELS.surface` in `fe-cpp-engine.js` now flags such an artifact as
stale in the Performance Benchmark sheet, so the repair path can fix it.

## See also

`docs/FLORA.md` — the grown tree/rock kernel that feeds these materials
(space colonisation, da Vinci radii, golden-angle leaf anchors).
`docs/CLIMATE.md` — the seeded climate field that decides rain, snow, fog,
wind and the snow line the wetness term follows.
`docs/STUDIO-SETTINGS.md` — the JSON document that keeps every studio control
across a reload.

## Verification

```bash
node --test tests/landscape-realism.test.mjs   # 14 tests
node --test tests/landscape-flora.test.mjs     # 24 tests
node --test tests/flora-plants.test.mjs        # 7 tests
node --test tests/buildings.test.mjs           # 7 tests
npm test                                       # 505 tests
```
