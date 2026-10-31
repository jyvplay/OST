/* Fusion Shell Web service worker.
 * API data is network-only; an offline response is never a cached listing.
 * The shell is a best-effort fallback, NOT an offline copy of the database.
 * Deployments changing this worker must change VERSION as well. */
const VERSION = "fusion-v8";
const OFFLINE = "/offline.html";
const SHELL = ["/", OFFLINE, "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/wallpapers/poolside.svg"];

// The first page is not controlled by the newly installed worker, so its
// scripts never enter the runtime cache. Discover the production shell's own
// content-hashed Next assets and local CSS resources before accepting it.
// Restrict discovery to public same-origin static paths, never APIs or queries.
async function ensureShellAssets(cache, response) {
  if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) throw new Error("invalid shell response");
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("shell HTML exceeds precache bound");
  const chunks = new Set();
  for (const match of html.matchAll(/\/_next\/static\/[A-Za-z0-9%._/-]+\.(?:js|css)/g)) {
    const url = new URL(match[0], self.location.origin);
    if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/") && !url.search && !url.hash) chunks.add(url.pathname);
    if (chunks.size > 256) throw new Error("too many shell assets");
  }
  if (![...chunks].some((path) => path.endsWith(".js"))) throw new Error("shell has no discoverable JavaScript");
  await cacheMissing(cache, [...chunks]);

  const resources = new Set();
  for (const css of [...chunks].filter((path) => path.endsWith(".css"))) {
    const saved = await cache.match(css);
    if (!saved) throw new Error("shell stylesheet is missing");
    const text = await saved.text();
    if (text.length > 4_000_000) throw new Error("shell stylesheet exceeds precache bound");
    for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      let url;
      try { url = new URL((match[1] || match[2] || match[3] || "").trim(), new URL(css, self.location.origin)); }
      catch { continue; }
      if (url.origin === self.location.origin && !url.hash && staticAsset(url)) resources.add(url.pathname);
      if (resources.size > 256) throw new Error("too many shell style resources");
    }
  }
  await cacheMissing(cache, [...resources]);
}

function validAsset(path, response) {
  if (!response || !response.ok) return false;
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (path.endsWith(".js")) return /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/.test(type);
  if (path.endsWith(".css")) return type === "text/css";
  return true;
}

async function cacheMissing(cache, paths) {
  const entries = await Promise.all(paths.map(async (path) => [path, await cache.match(path)]));
  const missing = entries.filter(([path, hit]) => !validAsset(path, hit)).map(([path]) => path);
  // Validate each response before writing it: a 200 login/error page must
  // not poison a hashed JS/CSS key, including under concurrent navigations.
  // Consume each response as it arrives. Waiting for every response header
  // before consuming bodies can deadlock the browser's HTTP connection pool.
  const outcomes = await Promise.allSettled(missing.map(async (path) => {
    const response = await fetch(path, { redirect: "error" });
    if (!validAsset(path, response)) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      throw new Error(`invalid asset content type or status: ${path}`);
    }
    await cache.put(path, response);
  }));
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
}

self.addEventListener("install", (event) => {
  // Reject the entire install if the document or any discovered dependency is
  // unavailable: an old active worker and its cache must remain intact.
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    const root = await cache.match("/");
    const offline = await cache.match(OFFLINE);
    if (!root) throw new Error("shell is missing");
    if (!offline || !offline.ok || !(offline.headers.get("content-type") || "").includes("text/html")) throw new Error("offline page is invalid");
    await ensureShellAssets(cache, root);
  })());
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
      event.waitUntil(network.then(async (res) => {
        if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return;
        const cache = await caches.open(VERSION);
        // Never replace the last usable offline document with a newer HTML
        // document whose hashed assets were not all cached successfully.
        await ensureShellAssets(cache, res.clone());
        await cache.put("/", res.clone());
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
