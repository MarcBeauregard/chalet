// Service worker minimal pour PWA Notre Chalet
// Stratégie: cache-first pour les ressources statiques, bypass réseau pour le reste.
// Bumper CACHE_VERSION à chaque déploiement pour invalider l'ancien cache.

const CACHE_VERSION = 'chalet-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // N'interceptons que notre propre origine
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Mise à jour en arrière-plan (stale-while-revalidate)
        fetch(req).then(fresh => {
          if (fresh && fresh.ok) {
            caches.open(CACHE_VERSION).then(c => c.put(req, fresh.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then(fresh => {
        if (fresh && fresh.ok) {
          const copy = fresh.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return fresh;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
