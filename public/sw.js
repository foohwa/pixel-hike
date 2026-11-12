// Pixel Hike service worker: works offline once opened, and receives files shared to the app
// (Android share sheet → "Pixel Hike"). Shared files are kept in a cache for the page to pick up;
// nothing is sent anywhere.
const APP = 'pixelhike-app-v1';
const SHARED = 'pixelhike-shared';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname === '/share-target') {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // map tiles, weather: straight to the network
  if (e.request.mode === 'navigate') {
    // the page: fresh when online, the saved copy when not
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(APP).then((k) => k.put('/', c)); return r; })
      .catch(() => caches.match('/')));
    return;
  }
  // scripts, styles, icons, music: from the cache, refreshed in the background
  e.respondWith(caches.open(APP).then(async (k) => {
    const hit = await k.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) k.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit ?? net;
  }));
});

async function receiveShare(req) {
  const form = await req.formData();
  const files = form.getAll('files').filter((f) => f && typeof f !== 'string');
  const cache = await caches.open(SHARED);
  for (const k of await cache.keys()) await cache.delete(k);
  let i = 0;
  for (const f of files) {
    await cache.put(`/shared/${i++}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) } }));
  }
  return Response.redirect('/?shared', 303);
}
