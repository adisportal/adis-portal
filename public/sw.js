// Bump this on any future change to this file — it's what forces old,
// stuck caches to get thrown away on activate().
const CACHE_VERSION = 'v3';
const CACHE_NAME = `adis-${CACHE_VERSION}`;

// Only truly static, rarely-changing third-party assets belong here.
// The app shell itself (index.html/script.js/style.css/API responses) is
// deliberately NOT precached — see the fetch handler below. Precaching it
// is what caused the app to keep serving an old, broken build no matter
// how many times it was redeployed.
const STATIC_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
    'https://img.icons8.com/fluency/96/graduation-cap.png'
];

self.addEventListener('install', evt => {
    // Take over from any previously-installed worker immediately, instead
    // of waiting for every open tab to be closed first.
    self.skipWaiting();
    evt.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .catch(() => {}) // don't let a flaky CDN block install
    );
});

self.addEventListener('activate', evt => {
    evt.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
            .then(() => self.clients.claim()) // control already-open tabs right away
    );
});

self.addEventListener('fetch', evt => {
    // Known static assets: cache-first is fine, they don't change often.
    if (STATIC_ASSETS.includes(evt.request.url)) {
        evt.respondWith(
            caches.match(evt.request).then(cached => cached || fetch(evt.request))
        );
        return;
    }

    // Everything else (the app shell + API calls): network-first. A
    // redeploy is always what the user sees; the cache is only a
    // fallback for genuinely being offline.
    evt.respondWith(
        fetch(evt.request)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(evt.request, copy)).catch(() => {});
                return res;
            })
            .catch(() => caches.match(evt.request))
    );
});
