/* ============================================================
   Service worker — makes the wallet installable and open offline.

   Policy, and why it is this way round:

     /api/*            NEVER cached, never intercepted. Balances, prices and
                       prepared transactions must always be live; a cached
                       balance is a lie and a cached prepared transaction is
                       a replay.
     everything else   NETWORK FIRST, cache as fallback. There is no build
                       step and no versioned filenames, so a cache-first
                       shell would keep serving last week's app after a
                       deploy. Going to the network first means every load
                       picks up the newest files; the cache only answers
                       when the network cannot, which is what "offline" is
                       for.

   The cache name carries a version so an incompatible shell can be dropped
   wholesale by bumping it.
   ============================================================ */
'use strict';

const CACHE = 'bio-wallet-shell-v2';
const SHELL = [
  '/', '/index.html', '/css/wallet.css', '/manifest.webmanifest',
  '/js/app.js', '/js/fund.js', '/js/passkey.js', '/js/recovery.js',
  '/js/webauthn-wire.js', '/js/qr.js', '/js/receive.js', '/js/portfolio.js', '/js/ui.js',
  '/js/vendor/qrcode-generator.js',
  '/assets/icon.svg', '/assets/icon-192.png', '/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* Best effort: a missing file must not fail the install. */
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // CDN fonts, explorers — not ours
  if (url.pathname.startsWith('/api/')) return;         // always live, never cached

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (_) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      /* A navigation with nothing cached: hand back the shell so the app
         boots and can say it is offline, instead of the browser's error. */
      if (req.mode === 'navigate') {
        const shell = await caches.match('/', { ignoreSearch: true });
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
