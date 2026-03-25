const CACHE = "tonight-to-v4";
const ASSETS = [
  "/tonight-to/",
  "/tonight-to/index.html",
  "/tonight-to/manifest.json",
  "/tonight-to/icon-192.png",
  "/tonight-to/icon-512.png",
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  // Never cache venues.json — always fetch fresh from network
  if (e.request.url.includes("venues.json")) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"venues":[]}', {headers:{'Content-Type':'application/json'}})));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => caches.match("/tonight-to/index.html")))
  );
});
