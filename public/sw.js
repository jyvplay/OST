/*
 * Fusion Shell Web — service worker (SH-14).
 *
 * Deliberate policy choices:
 *  - API requests are NEVER served stale. A desktop whose file listing is a
 *    cached lie is worse than one that says it is offline, so /api/* is
 *    network-first with an explicit offline envelope ({ok:false, offline:true}).
 *  - Navigations fall back to the cached shell so the compositor still boots.
 *  - No skipWaiting(): an update must never reload a window mid-edit. The page
 *    offers the update instead (AP-04).
 */
const VERSION = "fusion-v6"; // Separate this revision from older shell caches
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/wallpapers/poolside.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => undefined)));
});

// AP-04: the page decides when to take the update (after the user agrees)
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("fusion-") && k !== VERSION).map((k) => caches.delete(k)))),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(
          JSON.stringify({ ok: false, offline: true, error: "The Fusion server is unreachable; no stale data is served." }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only a successful canonical shell response can refresh the offline
          // shell. A /display, /present, query-specific or error page must not
          // overwrite it and later be served as the desktop.
          if (url.pathname === "/" && !url.search && res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put("/", copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => caches.open(VERSION).then((c) => c.match("/")).then((r) => r ?? new Response("Offline", { status: 503 }))),
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then((c) => c.match(req)).then((hit) =>
      hit ??
      fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      }).catch(() => new Response("", { status: 504 })),
    ),
  );
});
