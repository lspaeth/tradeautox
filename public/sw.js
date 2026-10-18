// TradeAutoX service worker — cache the app shell, pass everything else through.
const CACHE = 'tradeautox-shell-v1';
const SHELL = ['/styles.css', '/logo.png', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only handle same-origin requests; never intercept uploads, API posts, or webhooks.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        // Cache a fresh copy of shell assets for next time.
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      }).catch(() => cached);
      // Shell assets: serve cache first, fall back to network. Pages: network first.
      return SHELL.includes(url.pathname) ? (cached || network) : network.then((res) => res).catch(() => cached);
    })
  );
});
