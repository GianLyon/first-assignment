// Azeli PMS service worker: makes the PMS an installable app on phones and computers.
//
// - The app itself (page, script, styles, icons) is kept on the device so it opens instantly and still opens
//   with no connection (it then says it is offline).
// - Hotel data (/api/...) is NEVER stored on the device: guest details must not stay on a shared or lost phone.
// - The booking page, payment pages and widget for guests are left alone.
// - A new version is fetched in the background; the app offers "Reload" when it is ready.
const VERSION = '__VERSION__';
const CACHE = `azeli-pms-${VERSION}`;
const SHELL = ['/', '/app.js', '/app.css', '/offline.html', '/manifest.webmanifest', '/brand/azeli-mark.svg', '/brand/azeli-mark-light.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('azeli-pms-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'activate-now') self.skipWaiting(); });

const isShell = (url) => url.origin === self.location.origin && (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/'));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/book/') || url.pathname.startsWith('/pay/') || url.pathname === '/sw.js') return;
  // opening the app: the newest page when online, the saved one when not
  if (req.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return res; })
      .catch(() => caches.match('/').then((r) => r || caches.match('/offline.html'))));
    return;
  }
  if (!isShell(url)) return;
  // the app's own files: newest when online (checked against the server), saved copy when not
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); } return res; })
    .catch(() => caches.match(url.pathname)));
});
