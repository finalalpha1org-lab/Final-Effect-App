/* Bumped whenever the shipped shell changes so installed clients drop stale
   copies of index.html / the wasm artifact on activate. */
const CACHE_NAME = 'final-effect-cpp-v38';
const CORE_ASSETS = [
  './',
  './index.html',
  './Terrain_system_.html',
  './fe-cpp-engine.js',
  './fe_core_engine.wasm',
  './fe-icons.js',
  './fe-taa.js',
  './render-capture.js',
  './render-preview.js',
  './render-export.js',
  './workspace-export.js',
  './edit-mode.js',
  './volume-atlas.js',
  './volume-library.js',
  './volume-library.bin',
  './simulationCore.js',
  './simulation_solver.wasm',
  './modifier-engine.js',
  './tessendorf-ocean.js',
  './celestial-math.js',
  './scatter-spacing.js',
  './open-world-generator.js',
  './open-world.js',
  './terrain-main-01.js',
  './terrain-main-02.js',
  './terrain-main-03.js',
  './terrain-main-04.js',
  './terrain-main-05.js',
  './terrain-main-06.js',
  './terrain-main-07.js',
  './terrain-main-08.js',
  './terrain-main-09.js',
  './kernel-worker.js',
  './landscape-realism.js',
  './landscape-flora.js',
  './landscape-weather.js',
  './favicon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* Network-first so live updates appear immediately, falling back to cache offline */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
