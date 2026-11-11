/* Bumped whenever the shipped shell changes so installed clients drop stale
   copies of index.html / the wasm artifact on activate. */
const CACHE_NAME = 'final-effect-cpp-v59';
const CORE_ASSETS = [
  './',
  './index.html',
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
  './fe-poly.js',
  './fe-project.js',
  './favicon.svg',
  './manifest.webmanifest',
  /* The shell loads one bundle instead of a dozen separate scripts, and three.js
     is served from this origin instead of a CDN, so the install has to carry
     them or an offline client boots without a renderer. */
  './workspace-app.js',
  './vendor/three/three.min.js',
  './vendor/three/OrbitControls.js',
  './vendor/three/TransformControls.js',
  './vendor/three/GLTFLoader.js',
  './vendor/three/OBJLoader.js',
  './vendor/three/RGBELoader.js'
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
