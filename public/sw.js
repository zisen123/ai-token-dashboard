/* Token Studio service worker.
 *
 * Strategy:
 *  - /sw.js itself and /index.html are always network-first with a short
 *    cache fallback, so a redeploy is detected on the next navigation.
 *  - Hashed build assets (/assets/*) are immutable: cache-first, cached on
 *    first use, never revalidated.
 *  - Everything else (API, fonts) is network-only; the dashboard is a live
 *    data app and must never serve stale numbers from cache.
 *
 * Update flow: a new `npm run build` produces new hashed asset names and a
 * new index.html. The browser sees the byte-different /sw.js on its periodic
 * update check, installs this worker, `skipWaiting` promotes it, and the
 * `controllerchange` listener in main.jsx reloads the page exactly once so
 * the user lands on the fresh bundle without manual refresh.
 */
const RUNTIME = 'ts-runtime-v1';
const IMMUTABLE = 'ts-assets-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n !== RUNTIME && n !== IMMUTABLE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts etc: network-only

  // Navigation requests and the shell document: network-first so a new
  // deploy is picked up; fall back to cache when offline.
  if (req.mode === 'navigate' || url.pathname === '/index.html' || url.pathname === '/sw.js') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(RUNTIME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Hashed build output is immutable: cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(IMMUTABLE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // API and everything else: straight to network, never cached.
});
