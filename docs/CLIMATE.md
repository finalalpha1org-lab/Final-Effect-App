# Climate & weather field

The Landscaping Studio can already draw rain, snow, fog, wind, storms, a tornado
and a tsunami. What it did not have was a reason for any of them: the weather
sheet exposed raw targets (`rainT`, `stormT`, `coverT`) and six presets, so
"weather" was a set of numbers a person nudged.

`cpp/src/fe_climate.cpp` turns that into a world. One seeded climate — latitude,
sea-level temperature, humidity, continentality, prevailing wind — resolves the
temperature field, its diurnal and seasonal cycles, the dew point, synoptic
fronts, cloud, rain, snow, fog, storm strength, wind and the biome. The existing
weather system keeps ownership of the *rendering* (particles, lightning timing,
easing); it just receives targets that mean something now.

## The model

| Term | Formula | Physical basis |
| --- | --- | --- |
| Seasonal mean | `T̄ = base − 30(1 − cos lat)` | insolation falls with `cos(lat)`; ~30 K equator-to-pole |
| Season | `+ (4 + 14·cont)·sin(lat)·cos(2π(season − .25))` | axial tilt; continental air swings harder than maritime air |
| Diurnal | `±(2 + 4·(1 − humidity))·sinElevation(hour − 2.5)` | dry ground swings ~12 K, humid ground ~4 K (Bowen ratio) |
| Altitude | `− 6.5 K/km` | ICAO standard atmosphere lapse rate |
| Dew point | `Td = T̄ − (1 − moisture)·16`, clamped to −20…32 °C | Magnus, linearised for the studio's range |
| Relative humidity | `RH = exp((Td − T)/8)` | 1/8 K⁻¹ approximation, so dawn saturates and noon dries |
| Fog | `spread < 2.2 K` × calm wind × cloud × RH | radiation fog needs saturation, calm air and a cold night |
| Fronts | seeded noise target, 9–30 h apart, 3 h time constant | synoptic scale; weather evolves instead of teleporting |
| Cloud | `0.08 + 0.92·front·(0.35 + 0.65·humidity)` | fronts alone do not make overcast |
| Rain | `((front − .22)/.78)² · (0.25 + 0.9·humidity) · cloud` | needs lift **and** water |
| Snow | `rain · clamp((2 − T)/2.5, 0, 1)` | all snow below −0.5 °C, sleet mixed above |
| Storm | `rain · warmth · moisture · 1.35 + front²·warmth·moisture·0.35` | deep convection needs heat, water and a trigger |
| Wind | `base·(0.55 + 0.75·front) + base·0.55·storm` | fronts drag the surface wind up |
| Snow line | `T(0 m) / 6.5 K/km` | the altitude where the current field reaches 0 °C |

### Biomes (Whittaker, temperature × moisture)

| id | biome | painted surface | example |
| --- | --- | --- | --- |
| 0 | tundra | `alpine` | < −5 °C, or < 5 °C and dry |
| 1 | boreal forest | `hills` | 0 °C, moist |
| 2 | grassland | `grassy` | 12 °C, dry |
| 3 | temperate forest | `hills` | 12 °C, moist |
| 4 | desert | `desert` | 26 °C, moisture < 0.16 |
| 5 | savanna | `grassy` | 26 °C, 0.16–0.42 |
| 6 | rainforest | `hills` | 26 °C, > 0.78 |
| 7 | bare rock | `rocky` | forced by slope > 0.78 |

`fe_climate_biome_on_slope()` adds the slope override, because a cliff has no
soil whatever the climate says.

### Hazards

* **Tornado** — Rankine vortex mapped from the Enhanced Fujita scale:
  `vmax = 29 + 13.3·EF m/s`, core radius `18 + 16·EF m`, damage swath `≈ 3.2 R`,
  and `v(r) = vmax·r/R` inside the core, `vmax·R/r` outside.
* **Tsunami** — long-wave physics: `c = √(g·d)`, `T = 2πc/g`,
  `λ = cT`, Green's-law shoaling `(d/3)^¼`, Synolakis run-up `2.83·A·shoal`.
  The panel's "sea wave at its real phase speed" button sets the approach speed
  from a 120 m depth instead of the old fixed 26 m/s.

## ABI

```c
int32_t fe_climate_init(uint32_t seed, float latitude, float base_c,
                        float humidity, float continentality, float wind_mps);
int32_t fe_climate_ready(void);
float   fe_climate_set_clock(float hours);
float   fe_climate_set_season(float t01);
float   fe_climate_step(float dt_hours);
float   fe_climate_clock(void);
float   fe_climate_sea_level_temp(float hour);
float   fe_climate_snow_line(float hour);
int32_t fe_climate_at(float x, float z, float altitude, float hour, float *out10);
int32_t fe_climate_weather(float *out10);
int32_t fe_climate_biome(float temp_c, float moisture);
int32_t fe_climate_biome_count(void);          /* 8 */
int32_t fe_climate_biome_on_slope(float temp_c, float moisture, float slope);
int32_t fe_climate_tornado(float ef, float *out4);
float   fe_climate_rankine(float r, float core_radius, float vmax);
int32_t fe_climate_tsunami(float amplitude, float depth, float *out6);
```

`fe_climate_at()` returns `[temperature, dew point, moisture, cloud, rain,
snow, fog, wind m/s, wind direction rad, biome]`.
`fe_climate_weather()` returns `[temperature, dew point, cloud, rain, snow,
storm, lightning, fog, wind m/s, wind direction]`.

## Integration

```
fe_climate.cpp ──▶ FELandscapeCore.climate*  (terrain-main-01.js, copies into JS arrays)
              └──▶ FELandscapeWeather       (landscape-weather.js, drives the scene)
              └──▶ Climate controls         (terrain-main-07.js, the Weather sheet)
```

`landscape-weather.js` advances the world clock (`timeScale` world hours per real
minute), copies the kernel's ten values every ~200 ms and writes them into the
studio's existing weather state:

* `WX.rainT / overT / stormT / snowfallT` — the manual targets, so `wxStep()`
  still owns easing, lightning timing and the particle systems;
* `WX.coverT` from the current temperature (and `WX.snowAuto` is parked while
  the field is driving, then restored when it is switched off);
* `windUser` from the kernel wind (the studio's wind multiplier);
* `scene.fog.density` from the fog term — clear air keeps the authored 0.004,
  a saturated dawn reaches ~0.024;
* `FELandscapeRealism.set('wetness', rain)` so every measured surface darkens
  and glosses exactly as the surface kernel says it should;
* optionally, a supercell tornado during a strong storm (`Storm tornadoes`).

Every one of those is a switch on the weather sheet, and switching
**Climate-driven weather** off returns the manual sliders and presets unchanged.

## What this does not do

* It is not a general circulation model. There is no advection between grid
  cells, no radiation budget and no pressure field — it is a parameterisation.
* The biome *classification* is computed and exposed (`FELandscapeWeather.biomeAt`,
  `biomeSurface`), but the painted biome layers still come from the existing
  Open World generator. Any automatic repaint would silently overwrite a user's
  own painting, so it is not wired in yet.
* Tsunamis stay a user-triggered tectonic event; the climate only supplies the
  physics envelope. Automatic earthquakes are not modelled.
* No hail, no graupel, no cloud shadowing from the front itself.

## Verification

```bash
node --test tests/landscape-climate.test.mjs   # 11 tests
npm test                                       # 330 tests
```

The tests pin the 6.5 K/km lapse rate, the post-noon thermal peak, fog at dawn
but not at noon, the latitude and season signs (including the southern
hemisphere), moisture falling inland and with altitude, the whole Whittaker
table, front reproducibility per seed with bounded rain/cloud/snow/storm,
snow only near freezing, `√(g·d)` phase speed, Rankine decay, and that a missing
kernel leaves the manual weather untouched.
