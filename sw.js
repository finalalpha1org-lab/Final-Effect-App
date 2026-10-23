const CACHE_NAME = 'final-effect-cpp-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './Terrain_system_.html',
  './fe-cpp-engine.js',
  './fe_core_engine.wasm',
  './simulationCore.js',
  './simulation_solver.wasm',
  './modifier-engine.js',
  './tessendorf-ocean.js',
  './celestial-math.js',
  './scatter-spacing.js',
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
