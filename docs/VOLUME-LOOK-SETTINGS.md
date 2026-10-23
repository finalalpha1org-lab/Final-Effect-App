# Volume look: user-facing settings and the C++ detail tile

Status: Very Early Demo. Phase 1 of the layered look plan (see the
"motion real, detail fake" plan) is implemented: the solver backbone stays a
real C++ MAC-grid sim at 20-32³, while the small-scale detail and the light
response are procedural.

## Where the knobs live

Every control is a normal field of the **Fluid** modifier (`modifiersData` in
`index.html`), so it inherits the modifier card, the collapsed
`⚙ Advanced Settings (n)` block and the same reset/JSON copy path as every
other modifier. Nothing is a hidden constant.

| Field | Default | Range | Effect |
| --- | --- | --- | --- |
| `Volume Quality` | `Balanced` | Mobile / Balanced / Cinematic | grid ceiling only: 20³ / 24-28³ / up to 32³ |
| `Volume Steps` | 48 | 16-64 | raymarch samples; the only knob that directly spends GPU time per pixel |
| `Detail` | 1 | 0-2 | how strongly the baked tile modulates density and temperature (0 = off) |
| `Detail Scale` | 2.5 | 0.5-8 | spatial frequency of the tile |
| `Detail Speed` | 0.6 | 0-3 | scroll rate of the tile through the domain |
| `Self Shadow` | 1 | 0-1 | blends the sun march off (0 = unshadowed, 1 = full) |
| `Scatter Samples` | 2 | 1-4 | extra sun taps for softer multiple scattering |
| `Ambient` | 0.15 | 0-1 | uniform fill light inside the smoke |
| `Extinction` | 1 | 0.2-3 | optical density multiplier |
| `Emission` | 1.3 | 0-3 | fire radiance multiplier |

`Volume Quality` writes a starting point into the other fields (the
`VOLUME_QUALITY_PRESETS` table) **and leaves them editable**; it is not a
locked mode.

## The rule: never trade shape for detail

The detail term is masked by the base density:

```glsl
float edge = smoothstep(0.02, 0.28, dens);
float detailAmount = clamp(uDetail, 0.0, 2.0) * 0.5 * edge;
dens *= mix(1.0, mix(0.55, 1.45, detail), detailAmount);
```

Near the isosurface `edge -> 0`, so `dens` is multiplied by exactly 1.0 and the
silhouette the solver produced is reproduced unchanged, whatever the slider
says. Detail only reshapes the interior. `tests/fire-smoke-volume.test.mjs`
pins that expression.

## The C++ side

`cpp/src/fe_volumetrics.cpp` exports three symbols (declared in
`cpp/include/fe_abi.h`, listed in `scripts/build-cpp-wasm.mjs`):

```
fe_vol_noise_generate(size, seed, octaves) -> 0 | -3
fe_vol_noise_ptr()  -> byte offset of an RGBA8 size*size tile
fe_vol_noise_size() -> last generated size
```

`size` is 16-128, `octaves` 1-6. Three channels are independent fBm fields:
billows (base frequency 4), wisps (base 8, one more octave) and a slow mask
(base 2). The lattice wraps modulo its frequency, so the tile is seamless and
can be sampled with `RepeatWrapping` while it scrolls. The generator is
deterministic for a given `(size, seed, octaves)` and seeds are decorrelated by
a per-octave salt.

`simulationCore.js` uploads it once as a 64² `DataTexture`
(`volumeNoiseTexture()`); `volumeFallbackNoise()` builds the same kind of tile
in JS only when the wasm core is absent, so the shader always has a texture.
The raymarcher reads it three times in `detailField()` and drives `uNoise`,
`uTime` and the nine look uniforms listed above.

## Tests

`tests/fire-smoke-volume.test.mjs` (offline, deterministic, real wasm):

- the tile is deterministic for a seed, changes with a seed, is opaque, has
  contrast, rejects `size < 16`, and its wrap seam is quieter than an interior
  column pair;
- every look control lands in `material.uniforms` with the requested value;
- `Cinematic` reaches 32³ on a desktop tier, `Mobile` stays at 20³, `Balanced`
  keeps 28³;
- stepping advances `uTime` and `syncVolumeUniforms()` propagates edits without
  rebuilding the material.

## Not in this phase

- Temporal accumulation (TAA) and the baked "cinema library" of canonical sims.
- Adaptive per-frame budget that lowers `Volume Steps` under load.
- An offline baker for the library; today the tile is generated at boot.

Those remain marked experimental and are not presented as finished.
