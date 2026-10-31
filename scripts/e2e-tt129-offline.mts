/** Cold-install test against the real production server and real Chromium.
 * The loopback proxy forwards genuine responses or drops connections for fault
 * injection. The browser HTTP cache is disabled; CacheStorage is not mocked. */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (!process.env.BASE) throw new Error("BASE for an exclusive production server is required");
const upstream = new URL(process.env.BASE);
if (upstream.protocol !== "http:") throw new Error("test proxy needs an HTTP upstream");
let offline = false, failAsset = false, failedAssets = 0, upgrade = false, corruptAsset = false, corruptedAssets = 0;
const worker = readFileSync("public/sw.js", "utf8");
const server = createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "";
  if (!offline && upgrade && path === "/sw.js") {
    // Only the version is changed to force a genuine browser worker update.
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    res.end(worker.replace('const VERSION = "fusion-v8"', 'const VERSION = "fusion-v9-fault-test"')); return;
  }
  const precacheAsset = path.startsWith("/_next/static/") && req.headers["sec-fetch-dest"] === "empty";
  if (!offline && corruptAsset && precacheAsset && path.endsWith(".js")) {
    // Fault injection: an HTTP 200 login/error page masquerading as a chunk.
    corruptedAssets++; res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end("<html>not javascript</html>"); return;
  }
  if (offline || (failAsset && precacheAsset)) {
    if (failAsset && precacheAsset) failedAssets++;
    req.socket.destroy(); return;
  }
  const outgoing = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (r) => {
    // Avoid hiding injected failures in the browser's HTTP cache, including
    // fetches made by the service worker rather than the page's CDP session.
    const headers = path.startsWith("/_next/static/") ? { ...r.headers, "cache-control": "no-store" } : r.headers;
    res.writeHead(r.statusCode ?? 502, headers); r.pipe(res);
  });
  outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(outgoing);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("proxy did not bind");
const base = `http://127.0.0.1:${address.port}`;
const browser = await launchChromium(); const { test, finish } = makeHarness("e2e-tt129-offline");
async function noHttpCache(page: import("playwright").Page) {
  const cdp = await page.context().newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
}
try {
  await test("first installation can boot a new offline desktop without an online reload", { "SH-14": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    try {
      const first = await context.newPage(); await noHttpCache(first);
      await first.goto(base, { waitUntil: "domcontentloaded" });
      await first.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("worker activation timed out")), 20_000))]); });
      assert.equal(await first.evaluate(() => !!navigator.serviceWorker.controller), false, "the first uncontrolled page did not warm the runtime cache");
      const keys = await first.evaluate(async () => {
        const all = await caches.keys(); const out: string[] = [];
        for (const name of all.filter((n) => n.startsWith("fusion-"))) out.push(...(await (await caches.open(name)).keys()).map((r) => r.url));
        return out;
      });
      offline = true;
      const cold = await context.newPage(); await noHttpCache(cold);
      const failed: string[] = []; cold.on("requestfailed", (r) => failed.push(r.url()));
      await cold.goto(base, { waitUntil: "domcontentloaded", timeout: 15_000 });
      try { await cold.locator('[data-shell-ready="true"]').waitFor({ timeout: 12_000 }); }
      catch { throw new Error(`cold shell failed to hydrate; cached Next assets=${keys.filter((k) => k.includes("/_next/static/")).length}; failed requests=${failed.join(", ")}`); }
      if (process.env.TT129_CAPTURE === "1") await cold.screenshot({ path: "docs/screens/tt129-offline-shell.png" });
      const api = await cold.evaluate(async () => { const r = await fetch("/api/health?secret=tt129-private"); return { status: r.status, data: await r.json() }; });
      assert.equal(api.status, 503); assert.equal(api.data.offline, true);
      const after = await cold.evaluate(async () => {
        const all = await caches.keys(); const out: string[] = [];
        for (const name of all.filter((n) => n.startsWith("fusion-"))) out.push(...(await (await caches.open(name)).keys()).map((r) => r.url));
        return out;
      });
      assert.ok(!after.some((url) => url.includes("/api/") || url.includes("tt129-private")), "API/query data never enter the cache");
      assert.ok(keys.some((url) => url.includes("/_next/static/") && url.endsWith(".js")), "the shell JavaScript was precached");
      assert.ok(keys.some((url) => url.endsWith(".css")) && keys.some((url) => url.endsWith(".woff2")), "shell CSS and its local fonts were precached");
      const loadedFonts = await cold.evaluate(async () => (await document.fonts.load('16px "Nunito Variable"', "Fusion")).filter((font) => font.status === "loaded").length);
      assert.ok(loadedFonts > 0, "the actual offline page loaded its bundled font");
    } finally { offline = false; await context.close(); }
  });
  await test("a failed required chunk prevents first worker installation", { "AP-04": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    failAsset = true; failedAssets = 0;
    try {
      const page = await context.newPage(); await noHttpCache(page);
      await page.goto(base, { waitUntil: "domcontentloaded" });
      const state = await page.evaluate(async () => Promise.race([
        navigator.serviceWorker.ready.then(() => "activated"),
        new Promise<string>((resolve) => setTimeout(() => resolve("not activated"), 6_000)),
      ]));
      assert.ok(failedAssets > 0, "the proxy actually rejected a worker precache request");
      assert.equal(state, "not activated", "an incomplete shell must not install");
    } finally { failAsset = false; await context.close(); }
  });
  await test("a 200 HTML error page cannot install as a JavaScript dependency", { "AP-04": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    corruptAsset = true; corruptedAssets = 0;
    try {
      const page = await context.newPage(); await noHttpCache(page);
      await page.goto(base, { waitUntil: "domcontentloaded" });
      const state = await page.evaluate(async () => Promise.race([
        navigator.serviceWorker.ready.then(() => "activated"),
        new Promise<string>((resolve) => setTimeout(() => resolve("not activated"), 6_000)),
      ]));
      assert.ok(corruptedAssets > 0, "the proxy returned an injected HTML page for a real chunk request");
      assert.equal(state, "not activated", "invalid dependency content type must fail the install");
    } finally { corruptAsset = false; await context.close(); }
  });
  await test("a failed chunk in an upgrade keeps the previously working offline shell", { "AP-04": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    try {
      const page = await context.newPage(); await noHttpCache(page);
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("old worker activation timed out")), 20_000))]); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      upgrade = true; failAsset = true; failedAssets = 0;
      const result = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration(); if (!reg?.active) throw new Error("old worker is not active");
        const old = reg.active;
        const finished = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("upgrade did not finish")), 20_000);
          reg.addEventListener("updatefound", () => {
            const next = reg.installing!;
            const check = () => { if (next.state === "redundant" || next.state === "installed") { clearTimeout(timer); resolve(next.state); } };
            next.addEventListener("statechange", check); check();
          }, { once: true });
        });
        await reg.update(); const state = await finished;
        return { state, oldStillActive: reg.active === old && old.state === "activated", keys: await caches.keys() };
      });
      assert.ok(failedAssets > 0, "a genuine dependency fetch was dropped");
      assert.equal(result.state, "redundant"); assert.equal(result.oldStillActive, true); assert.ok(result.keys.includes("fusion-v8"));
      offline = true; failAsset = false; upgrade = false;
      const reopened = await context.newPage(); await noHttpCache(reopened);
      await reopened.goto(base, { waitUntil: "domcontentloaded" });
      await reopened.locator('[data-shell-ready="true"]').waitFor({ timeout: 12_000 });
    } finally { offline = false; failAsset = false; upgrade = false; await context.close(); }
  });
} finally {
  offline = false; failAsset = false; upgrade = false; corruptAsset = false; await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); finish();
}
