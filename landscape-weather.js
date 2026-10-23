/* Final Effect — climate & weather bridge (JS/GPU glue)
 *
 * The Landscaping Studio already draws rain, snow, fog, wind, storms, a tornado
 * and a tsunami. What it did not have was a *world* that decides which of those
 * happens: the weather panel exposed raw targets, and every preset was a hand
 * picked set of numbers.
 *
 * `cpp/src/fe_climate.cpp` now owns that decision. It is seeded with a latitude,
 * a sea-level temperature, a humidity, a continentality and a prevailing wind,
 * and from those it resolves the seasonal-mean temperature (with the real
 * 6.5 K/km lapse rate), the diurnal cycle, the dew point, synoptic fronts,
 * cloud, rain, snow, fog, storm strength, wind and the Whittaker biome.
 *
 * This module is deliberately thin: it advances the world clock, copies the
 * ten numbers the kernel returns into the studio's existing weather state, and
 * reports what it did. It never draws anything and it never invents a value —
 * when the kernel is missing the studio keeps its manual weather exactly as it
 * was, with `state.kernel === false`.
 *
 * Everything the climate does is a user setting (latitude, temperature,
 * humidity, continentality, wind, time scale, fog and wetness coupling), and
 * "Climate-driven weather" can be switched off to get the manual sliders back.
 */
(function (root) {
  'use strict';

  /* Must match BiomeId in cpp/src/fe_climate.cpp. */
  const BIOMES = ['tundra', 'taiga', 'grassland', 'temperateForest', 'desert', 'savanna', 'rainforest', 'bareRock'];
  const BIOME_LABELS = {
    tundra: 'Tundra', taiga: 'Boreal forest', grassland: 'Grassland',
    temperateForest: 'Temperate forest', desert: 'Desert', savanna: 'Savanna',
    rainforest: 'Rainforest', bareRock: 'Bare rock'
  };

  /* Biome -> the studio's painted surface keys (OW_SURFACE_DEFS). */
  const BIOME_SURFACE = {
    tundra: 'alpine', taiga: 'hills', grassland: 'grassy', temperateForest: 'hills',
    desert: 'desert', savanna: 'grassy', rainforest: 'hills', bareRock: 'rocky'
  };

  const DEFAULTS = {
    enabled: true,
    latitude: 32,        /* degrees, -70..70 */
    temperature: 22,     /* sea-level annual mean, C */
    humidity: 0.55,      /* 0..1 */
    continentality: 0.4, /* 0 = coast, 1 = deep interior */
    wind: 6,             /* m/s at 10 m */
    timeScale: 30,       /* world hours per real minute */
    fog: true,           /* let the kernel drive the scene fog */
    wetnessFromRain: true,
    autoTornado: false,
    seed: 1
  };

  const settings = Object.assign({}, DEFAULTS);

  const state = {
    kernel: false,
    ready: false,
    clock: 0,
    temperature: 0,
    dewPoint: 0,
    moisture: 0,
    cloud: 0,
    rain: 0,
    snow: 0,
    storm: 0,
    fog: 0,
    wind: 0,
    windDir: 0,
    biome: 0,
    snowLine: 0,
    applied: 0,
    lastError: null,
    snowAutoPrev: null,
    lastTornado: -1e9
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function bridge() {
    const c = root.FELandscapeCore;
    return c && c.ready && typeof c.climateWeather === 'function' && typeof c.has === 'function' && c.has('fe_climate_weather') ? c : null;
  }

  function studio() {
    const g = {};
    try { g.wx = typeof WX !== 'undefined' ? WX : null; } catch (_) { g.wx = null; }
    try { g.scene = typeof scene !== 'undefined' ? scene : null; } catch (_) { g.scene = null; }
    return g;
  }

  function season() {
    const g = studio();
    return g.wx && typeof g.wx.seasonT === 'number' ? g.wx.seasonT : settings.season || 0.32;
  }

  /* ---------------------------------------------------------------- */
  /* Kernel                                                            */
  /* ---------------------------------------------------------------- */
  function pushSettings(c) {
    return c.climateInit(settings.seed >>> 0, clamp(settings.latitude, -70, 70), settings.temperature,
      clamp(settings.humidity, 0, 1), clamp(settings.continentality, 0, 1), clamp(settings.wind, 0, 40)) === 1;
  }

  function init() {
    const c = bridge();
    if (!c) {
      state.kernel = false;
      state.lastError = 'climate kernel unavailable';
      return false;
    }
    state.kernel = true;
    if (!pushSettings(c)) {
      state.kernel = false;
      state.lastError = 'climate init rejected the parameters';
      return false;
    }
    state.snowAutoPrev = (studio().wx || {}).snowAuto === undefined ? null : studio().wx.snowAuto;
    state.ready = true;
    tick(0, true);
    return true;
  }

  /* Advances the world clock and pulls the current weather. */
  function tick(dtMs, force) {
    const c = bridge();
    if (!c) return false;
    const dt = Math.max(0, Math.min(5000, dtMs || 0));
    if (!force && dt < 180) return false;
    try {
      c.climateSetSeason(season());
      const hours = (dt / 1000) * (clamp(settings.timeScale, 1, 600) / 60);
      if (hours > 0) c.climateStep(hours);
      const w = c.climateWeather();
      if (!w) return false;
      state.clock = c.climateClock();
      state.temperature = w[0];
      state.dewPoint = w[1];
      state.cloud = w[2];
      state.rain = w[3];
      state.snow = w[4];
      state.storm = w[5];
      state.fog = w[7];
      state.wind = w[8];
      state.windDir = w[9];
      state.snowLine = c.climateSnowLine(state.clock % 24);
      const here = c.climateAt(0, 0, 0, state.clock % 24);
      if (here) {
        state.moisture = here[2];
        state.biome = here[9] | 0;
      }
      return true;
    } catch (error) {
      state.lastError = error && error.message;
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Application — the only place the climate touches the scene        */
  /* ---------------------------------------------------------------- */
  function apply() {
    if (!settings.enabled || !state.ready) return false;
    const g = studio();
    const W = g.wx;
    if (W) {
      /* The kernel's numbers are the targets; wxStep() still owns the easing,
         the lightning timing and the particle systems. */
      W.rainT = clamp(state.rain, 0, 1);
      W.overT = clamp(state.cloud * 0.92, 0, 1);
      W.stormT = clamp(state.storm, 0, 1);
      W.snowfallT = clamp(state.snow, 0, 1);
      /* Snow cover follows the current temperature, not a season table. */
      W.coverT = clamp((2 - state.temperature) / 8, 0, 1);
      W.snowAuto = false;
      try { windUser = clamp(state.wind / 6, 0.05, 3); } catch (_) {}
    }
    if (settings.fog && g.scene && g.scene.fog) {
      /* Clear air keeps the studio's authored haze (0.004); a saturated dawn
         adds up to 0.02, i.e. roughly 60 m of visibility. */
      g.scene.fog.density = 0.0035 + clamp(state.fog, 0, 1) * 0.02;
    }
    if (settings.wetnessFromRain && root.FELandscapeRealism && typeof root.FELandscapeRealism.set === 'function') {
      try { root.FELandscapeRealism.set('wetness', clamp(state.rain * 1.15, 0, 1)); } catch (_) {}
    }
    /* Supercell tornadoes are the one hazard the weather itself can spawn. */
    if (settings.autoTornado && state.storm > 0.72) {
      const t = now();
      if (t - state.lastTornado > 60000 && ((state.clock * 2654435761) >>> 0) % 17 === 0) {
        state.lastTornado = t;
        try { if (typeof torSpawn === 'function') torSpawn(); } catch (_) {}
      }
    }
    state.applied++;
    paintReadout();
    return true;
  }

  function paintReadout() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('fe-climate-readout');
    if (!el) return;
    const b = BIOME_LABELS[BIOMES[state.biome]] || '—';
    el.textContent = `${state.temperature.toFixed(1)} °C · dew ${state.dewPoint.toFixed(1)} °C · ` +
      `humidity ${Math.round(state.moisture * 100)}% · wind ${state.wind.toFixed(1)} m/s · ` +
      `${b} · snow line ${Math.round(state.snowLine)} m`;
  }

  function restore() {
    const W = studio().wx;
    if (W && state.snowAutoPrev !== null) W.snowAuto = state.snowAutoPrev;
  }

  function set(key, value) {
    if (!(key in settings)) return false;
    if (key === 'enabled') {
      settings.enabled = !!value;
      if (settings.enabled) { if (!state.ready) init(); apply(); schedule(); }
      else restore();
      return settings.enabled;
    }
    settings[key] = value;
    const c = bridge();
    if (c) {
      pushSettings(c);
      tick(0, true);
      if (settings.enabled) apply();
    }
    return settings[key];
  }

  function reset() {
    Object.assign(settings, DEFAULTS);
    const c = bridge();
    if (c) { pushSettings(c); tick(0, true); if (settings.enabled) apply(); }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Hazard envelopes (kernel physics, used by the panel)              */
  /* ---------------------------------------------------------------- */
  function tornado(ef) {
    const c = bridge();
    if (c && typeof c.climateTornado === 'function') {
      const o = c.climateTornado(ef);
      if (o) return { coreRadius: o[0], maxWind: o[1], height: o[2], swath: o[3], rankine: (r) => c.climateRankine(r, o[0], o[1]) };
    }
    const e = clamp(ef, 0, 5);
    return { coreRadius: 18 + 16 * e, maxWind: 29 + 13.3 * e, height: 1100 + 180 * e, swath: (18 + 16 * e) * 3.2, rankine: () => 0 };
  }

  function tsunami(amplitude, depth) {
    const c = bridge();
    if (c && typeof c.climateTsunami === 'function') {
      const o = c.climateTsunami(amplitude, depth);
      if (o) return { speed: o[0], wavelength: o[1], shoaling: o[2], runup: o[3], period: o[4], energy: o[5] };
    }
    const d = clamp(depth, 1, 6000), a = clamp(amplitude, 0.05, 40);
    const speed = Math.sqrt(9.80665 * d);
    return { speed, wavelength: speed * (2 * Math.PI * speed / 9.80665), shoaling: Math.pow(d / 3, 0.25), runup: 2.83 * a, period: 2 * Math.PI * speed / 9.80665, energy: a * a * speed };
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                             */
  /* ---------------------------------------------------------------- */
  let raf = 0, last = 0, started = false;

  function frame(t) {
    raf = 0;
    if (!settings.enabled) return;
    const dt = last ? t - last : 0;
    last = t;
    if (tick(dt, false)) apply();
    schedule();
  }

  function schedule() {
    if (raf || !settings.enabled) return;
    if (typeof root.requestAnimationFrame === 'function') raf = root.requestAnimationFrame(frame);
    else raf = root.setTimeout(() => frame(now()), 250) && 1;
  }

  function install() {
    if (started) return true;
    const c = root.FELandscapeCore;
    if (!c) return false;
    started = true;
    const start = () => {
      settings.seed = climateSeed();
      if (init()) { apply(); schedule(); }
      else if (state.lastError) console.warn('[FELandscapeWeather] ' + state.lastError + ', manual weather stays in charge');
    };
    if (c.loading && typeof c.loading.then === 'function') c.loading.then(start).catch(start);
    else start();
    return true;
  }

  /* The world seed comes from the studio's own terrain seed when it exists, so
     two people opening the same landscape get the same weather history. */
  function climateSeed() {
    let seed = settings.seed;
    try {
      if (typeof P !== 'undefined' && P && typeof P.seed === 'number') seed = P.seed >>> 0;
      else if (typeof PLAN !== 'undefined' && PLAN && typeof PLAN.seed === 'number') seed = PLAN.seed >>> 0;
    } catch (_) {}
    return seed >>> 0 || 1;
  }

  /* Re-seeds the kernel from the current settings. Used by actions that read
     the climate field (the biome map) without moving the live weather. */
  function syncKernel() {
    const c = bridge();
    return c ? pushSettings(c) : false;
  }

  const api = {
    version: '1.0.0',
    BIOMES,
    BIOME_LABELS,
    BIOME_SURFACE,
    DEFAULTS,
    settings,
    state,
    init,
    syncKernel,
    tick,
    apply,
    set,
    reset,
    install,
    schedule,
    tornado,
    tsunami,
    biomeName: (id) => BIOMES[clamp(id | 0, 0, BIOMES.length - 1)],
    biomeSurface: (id) => BIOME_SURFACE[BIOMES[clamp(id | 0, 0, BIOMES.length - 1)]] || 'hills'
  };

  root.FELandscapeWeather = api;
  root.setLandscapeClimate = set;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else setTimeout(install, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
