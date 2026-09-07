/* Signal PWA service worker — app-shell caching only.
 * Live traffic (/socket.io/*, /health) is NEVER intercepted, so real-time
 * chat, presence and typing behave exactly like the website.
 *
 * BUMP THIS together with the ?v= query in index.html whenever the shell
 * (html/css/js) changes, otherwise Android keeps the old shell.
 */
const CACHE = 'signal-shell-v1.7.3';
// NOTE: unversioned paths on purpose — the fetch handler matches with
// ignoreSearch so ?v= cache-busters still hit the cache.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/qr.js',
  '/main.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // Non-atomic: one flaky URL must NOT kill the whole install
  // (cache.addAll rejects everything if a single request fails —
  // the classic "PWA sometimes won't install" bug).
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(
        SHELL_URLS.map((u) => c.add(new Request(u, { cache: 'reload' })))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Allow the page to trigger immediate activation for updates.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isShellAsset(pathname) {
  return SHELL_URLS.includes(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Real-time + health traffic must always hit the network.
  if (url.pathname.startsWith('/socket.io/') || url.pathname === '/health') return;

  // Page navigations (/, /?session=XX, /?source=pwa): network-first so the
  // installed app never gets stuck on stale HTML, cached shell as fallback
  // so invite links still open offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // App shell assets: cache-first (instant launch), query-insensitive so
  // ?v= cache-busters match the precached entries.
  if (isShellAsset(url.pathname)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(
        (hit) => hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
  }
});
