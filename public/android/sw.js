'use strict';

const CACHE = 'bio-wallet-android-shell-v1';
const SHELL = [
  '/android/', '/android/manifest.webmanifest', '/css/wallet.css',
  '/js/client.js', '/js/app.js', '/js/passkey.js', '/js/recovery.js',
  '/js/webauthn-wire.js', '/js/qr.js', '/js/receive.js', '/js/portfolio.js', '/js/ui.js',
  '/js/vendor/qrcode-generator.js', '/assets/icon.svg', '/assets/icon-192.png', '/assets/icon-512.png',
];
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const c = await caches.open(CACHE);
  await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
  await self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const k of await caches.keys()) {
    if (k.startsWith('bio-wallet-android-shell-') && k !== CACHE) await caches.delete(k);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(?:android\/)?api\/fund(?:\/|$)/.test(url.pathname)) {
    event.respondWith(Promise.resolve(new Response(JSON.stringify({ error: 'Conversions are not available in the Android app' }),
      { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })));
    return;
  }
  if (req.method !== 'GET' || /^\/(?:android\/)?api\//.test(url.pathname)) return;
  // Only the wallet shell, its legal pages and known shared assets belong
  // in this cache. A website page or funding script is never an offline fallback.
  if (!url.pathname.startsWith('/android/') && !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && ['basic', 'default'].includes(res.type)) await c.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate' && url.pathname.startsWith('/android/')) {
        const shell = await c.match('/android/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
