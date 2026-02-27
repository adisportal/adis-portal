const CACHE_NAME = 'adis-v1';
const assets = [
  '/',
  '/index.html',
  'https://cdn.rawgit.com/Chalarangelo/mini.css/v3.0.1/dist/mini-default.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
  'https://img.icons8.com/fluency/96/graduation-cap.png'
];

// Install service worker and cache assets
self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Caching shell assets');
      cache.addAll(assets);
    })
  );
});

// Activate service worker
self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys
        .filter(key => key !== CACHE_NAME)
        .map(key => caches.delete(key))
      );
    })
  );
});

// Fetching files - serve from cache if offline
self.addEventListener('fetch', evt => {
  evt.respondWith(
    caches.match(evt.request).then(rec => {
      return rec || fetch(evt.request);
    })
  );
});
