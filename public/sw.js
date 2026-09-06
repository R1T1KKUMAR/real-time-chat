/* Signal PWA service worker — app-shell caching only.
 * Live traffic (/socket.io/*, /health) is NEVER intercepted, so real-time
 * chat, presence and typing behave exactly like the website.
 * Bump CACHE below whenever the shell (html/css/js) changes.
 */
const CACHE = 'signal-shell-v1.7.0';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/qr.js?v=1.7.0',
  '/main.js?v=1.7.0',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShellAsset(pathname) {
  if (SHELL_URLS.includes(pathname)) return true;
  return pathname === '/main.js'; // versioned query (?v=) still the shell script
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Real-time + health traffic must always hit the network.
  if (url.pathname.startsWith('/socket.io/') || url.pathname === '/health') return;

  // App shell assets: cache-first (instant launch, works offline for the UI).
  if (isShellAsset(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) => hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
    return;
  }

  // Page navigations (e.g. /?session=XXYNK3, /?source=pwa): network-first,
  // fall back to the cached shell so a shared link opens even offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
  }
});
