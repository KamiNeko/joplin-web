/*
 * Service worker: makes Joplin Web installable as an app and shows offline.html when a page of the
 * app can't be loaded. Nothing else is cached, so notes never end up in the browser's storage.
 * Pages always come from the network, never from a cache: a sign-in proxy in front of the app
 * (e.g. Cloudflare Access) must still be able to redirect them to its login page.
 */
const CACHE = "joplin-web-offline-v1";
const OFFLINE_PAGE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_PAGE, { cache: "reload" })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith("joplin-web-") && key !== CACHE).map((key) => caches.delete(key)))
      )
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Attachments and other /api/ responses go straight to the network, without the worker
  if (request.mode !== "navigate" || new URL(request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE_PAGE)) ?? Response.error()));
});
