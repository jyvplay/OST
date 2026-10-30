/* Fusion Shell Web service worker.
 * API data is network-only; an offline response is never a cached listing.
 * The shell is a best-effort fallback, NOT an offline copy of the database.
 * Deployments changing this worker must change VERSION as well. */
const VERSION = "fusion-v7";
const OFFLINE = "/offline.html";
const SHELL = ["/", OFFLINE, "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/wallpapers/poolside.svg"];

self.addEventListener("install", (event) => {
  // A failed precache must not replace a working old worker. In particular do
  // not swallow the rejection: activation would delete the old shell cache.
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

// Updates are still applied only after the page/user asks for them.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("fusion-") && key !== VERSION).map((key) => caches.delete(key)),
  )));
});

// Only known, app-owned static assets may enter the runtime cache. Never cache
// arbitrary same-origin URLs, RSC payloads, or query-bearing requests (which
// may contain sensitive data). Versioned Next chunks are cache-first.
function staticAsset(url) {
  if (url.search) return false;
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/wallpapers/") ||
    url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/dict/") ||
    ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable.svg", "/icon-maskable-512.png", "/apple-touch-icon.png", OFFLINE].includes(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ ok: false, offline: true, error: "The Fusion server is unreachable; no stale data is served." }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    )));
    return;
  }

  if (req.mode === "navigate") {
    const network = fetch(req);
    // Register waitUntil synchronously; browsers may terminate a worker after
    // respondWith resolves, otherwise leaving an interrupted cache write.
    if (url.pathname === "/" && !url.search) {
      event.waitUntil(network.then((res) => {
        if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return;
        return caches.open(VERSION).then((cache) => cache.put("/", res.clone()));
      }).catch(() => undefined));
    }
    event.respondWith(network.catch(async () => {
      try {
        const cache = await caches.open(VERSION);
        // /display and /present are not the desktop. Never silently substitute it.
        const fallback = url.pathname === "/" ? await cache.match("/") : await cache.match(OFFLINE);
        if (fallback) return fallback;
        const offline = await cache.match(OFFLINE);
        if (offline) return offline;
      } catch { /* storage can be disabled or unavailable */ }
      return new Response("Offline. The server is unavailable.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    }));
    return;
  }

  if (!staticAsset(url)) return;
  const response = (async () => {
    let cache;
    try {
      cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
    } catch { /* a cache read failure must not suppress the network */ }
    try {
      const res = await fetch(req);
      if (cache && res.ok && res.type === "basic") {
        try { await cache.put(req, res.clone()); } catch { /* e.g. quota exceeded */ }
      }
      return res;
    } catch { return new Response("", { status: 504 }); }
  })();
  event.respondWith(response);
});
