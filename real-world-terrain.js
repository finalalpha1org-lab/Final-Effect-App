/* Real-world terrain ingestion.
   Fetches a heightfield for a latitude/longitude box from the Google Elevation
   API, then hands it to the C++ core (`fe_terrain_apply_dem`) so the landscape
   carries real-world relief at a metric scale. Everything here is plain data
   plumbing: sampling, request building, response decoding and the JS fallback
   resampler that mirrors the C++ kernel when wasm is unavailable.

   API notes (verified against Google's documentation):
   - at most 512 sample points per request, so a grid is fetched one row at a
     time with `path` + `samples`;
   - `solution_id` is the attribution token Google asks these integrations to
     send;
   - multipoint requests can be returned at lower precision, which is why rows
     are sampled as paths instead of packing 512 unrelated `locations`. */
var RealWorldTerrain = (function () {
  'use strict';
  const ELEVATION_ENDPOINT = 'https://maps.googleapis.com/maps/api/elevation/json';
  const SOLUTION_ID = 'gmp_git_agentskills_v1';
  const MAX_SAMPLES = 512;
  const MAX_GRID = 257;

  const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

  function metersPerDegree(lat) {
    const cos = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
    return { lat: 111320, lon: 111320 * cos };
  }

  function gridFor(opts) {
    const lat = Number(opts.lat), lon = Number(opts.lon), spanM = Number(opts.spanM);
    if (!Number.isFinite(lat) || lat < -85 || lat > 85) throw new Error('Latitude must be between -85 and 85');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('Longitude must be between -180 and 180');
    if (!Number.isFinite(spanM) || spanM < 20 || spanM > 200000) throw new Error('Span must be between 20 m and 200 km');
    const samples = clampInt(opts.samples || 65, 2, MAX_GRID);
    const d = metersPerDegree(lat);
    const halfLat = spanM / 2 / d.lat;
    const halfLon = spanM / 2 / d.lon;
    const rows = [];
    for (let j = 0; j < samples; j++) {
      /* row 0 is the north edge, matching the DEM layout the C++ kernel expects */
      const rowLat = lat + halfLat - (2 * halfLat * j) / (samples - 1);
      rows.push({ lat: rowLat, west: lon - halfLon, east: lon + halfLon });
    }
    return { rows, samples, width: samples, height: samples, spanM };
  }

  function elevationUrl(row, samples, key) {
    const path = `${row.lat.toFixed(7)},${row.west.toFixed(7)}|${row.lat.toFixed(7)},${row.east.toFixed(7)}`;
    const params = new URLSearchParams({
      path,
      samples: String(samples),
      key: String(key || ''),
      solution_id: SOLUTION_ID
    });
    return `${ELEVATION_ENDPOINT}?${params.toString()}`;
  }

  function elevationUrls(opts) {
    const grid = gridFor(opts);
    const urls = grid.rows.map((row) => elevationUrl(row, grid.samples, opts.key));
    return { ...grid, urls };
  }

  function parseElevationResponse(json, expected) {
    if (!json || typeof json !== 'object') throw new Error('Elevation response was not JSON');
    if (json.status !== 'OK') {
      const detail = json.error_message ? ` · ${json.error_message}` : '';
      throw new Error(`Elevation request failed: ${json.status || 'unknown'}${detail}`);
    }
    if (!Array.isArray(json.results) || !json.results.length) throw new Error('Elevation response was empty');
    if (expected && json.results.length !== expected) {
      throw new Error(`Elevation response had ${json.results.length} samples, expected ${expected}`);
    }
    const out = new Float32Array(json.results.length);
    for (let i = 0; i < json.results.length; i++) {
      const e = json.results[i] && json.results[i].elevation;
      if (!Number.isFinite(e)) throw new Error(`Elevation sample ${i} was not a number`);
      out[i] = e;
    }
    return out;
  }

  async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const run = async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
    return out;
  }

  /* Splits a fetch chain across requests and stitches the rows back together.
     `fetchImpl` is injectable so the pipeline can be tested without a network. */
  async function fetchDem(opts) {
    if (!opts || !opts.key) throw new Error('A Google Maps API key is required');
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('fetch is not available in this environment');
    const plan = elevationUrls(opts);
    let done = 0;
    const rows = await mapLimit(plan.urls, opts.concurrency || 3, async (url, index) => {
      const response = await fetchImpl(url, { cache: 'no-store' });
      if (!response || !response.ok) throw new Error(`Elevation HTTP ${response ? response.status : 'error'} on row ${index + 1}`);
      const json = await response.json();
      const row = parseElevationResponse(json, plan.samples);
      done++;
      if (typeof opts.onProgress === 'function') opts.onProgress(done, plan.height);
      return row;
    });
    const dem = new Float32Array(plan.width * plan.height);
    for (let j = 0; j < plan.height; j++) dem.set(rows[j], j * plan.width);
    return { dem, width: plan.width, height: plan.height, spanM: plan.spanM, ...demStats(dem) };
  }

  function demStats(dem) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < dem.length; i++) {
      const v = dem[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    if (!Number.isFinite(min)) return { min: 0, max: 0, mean: 0 };
    return { min, max, mean: sum / dem.length };
  }

  /* JS twin of cpp/src/fe_landscape.cpp:fe_terrain_apply_dem. Kept in lockstep
     by tests/real-world-terrain.test.mjs so the fallback matches the wasm path. */
  function resampleToTerrain(opts) {
    const { dem, demW, demH } = opts;
    if (!dem || demW < 2 || demH < 2) throw new Error('DEM must be at least 2x2');
    const n = clampInt(opts.n || 128, 8, 512);
    const worldSize = Number(opts.size) || 100;
    const spanM = Number(opts.spanM);
    const referenceM = Number(opts.referenceM) || 0;
    const exaggeration = Number.isFinite(opts.exaggeration) ? Number(opts.exaggeration) : 1;
    const offset = Number(opts.offset) || 0;
    if (!Number.isFinite(spanM) || spanM < 10) throw new Error('A real-world span in metres is required');
    const scale = (worldSize / spanM) * exaggeration;
    const fu = (demW - 1) / n, fv = (demH - 1) / n;
    const out = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      const v = j * fv, y0 = Math.floor(v), y1 = y0 + 1 < demH ? y0 + 1 : y0, fy = v - y0;
      for (let i = 0; i <= n; i++) {
        const u = i * fu, x0 = Math.floor(u), x1 = x0 + 1 < demW ? x0 + 1 : x0, fx = u - x0;
        const a = dem[y0 * demW + x0] + (dem[y0 * demW + x1] - dem[y0 * demW + x0]) * fx;
        const b = dem[y1 * demW + x0] + (dem[y1 * demW + x1] - dem[y1 * demW + x0]) * fx;
        const e = a + (b - a) * fy;
        out[j * (n + 1) + i] = ((Number.isFinite(e) ? e : referenceM) - referenceM) * scale + offset;
      }
    }
    return out;
  }

  return {
    ELEVATION_ENDPOINT,
    SOLUTION_ID,
    MAX_SAMPLES,
    metersPerDegree,
    gridFor,
    elevationUrl,
    elevationUrls,
    parseElevationResponse,
    demStats,
    fetchDem,
    resampleToTerrain
  };
})();
if (typeof globalThis !== 'undefined') globalThis.RealWorldTerrain = RealWorldTerrain;
