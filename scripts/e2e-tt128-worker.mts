/** Real Chromium service-worker lifecycle against the real app through a local
 * fault-injection proxy. The proxy only forwards requests, cuts the connection,
 * or changes the worker version during an upgrade. It is not a fake backend. */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (!process.env.BASE) throw new Error("BASE for an exclusive app server is required");
const upstream = new URL(process.env.BASE); if (upstream.protocol !== "http:") throw new Error("test proxy requires an HTTP BASE");
let offline = false, failInstall = false, upgrade = false;
const worker = readFileSync("public/sw.js", "utf8");
const server = createServer((req, res) => {
  if (offline || (failInstall && req.url?.split("?")[0] === "/offline.html")) { req.socket.destroy(); return; }
  if (upgrade && req.url?.split("?")[0] === "/sw.js") {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    res.end(worker.replace('const VERSION = "fusion-v8"', 'const VERSION = "fusion-v9-test"')); return;
  }
  const outgoing = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(outgoing);
});
// Forward the development server's HMR WebSocket as well; its runtime waits on
// the connection before hydrating. This does not emulate any application API.
server.on("upgrade", (req, socket, head) => {
  const upstreamSocket = connect(Number(upstream.port || 80), upstream.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: upstream.host }).flatMap(([key, value]) =>
      Array.isArray(value) ? value.map((v) => `${key}: ${v}`) : value === undefined ? [] : [`${key}: ${value}`]);
    upstreamSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head); socket.pipe(upstreamSocket).pipe(socket);
  });
  upstreamSocket.on("error", () => socket.destroy()); socket.on("error", () => upstreamSocket.destroy());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("proxy did not listen");
const base = `http://127.0.0.1:${address.port}`;
const browser = await launchChromium(); const { test, finish } = makeHarness("e2e-tt128-worker");
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
try {
  const page = await context.newPage(); page.setDefaultTimeout(25_000);
  await test("successful worker install and activation; API and query URLs never enter the cache", { "SH-14": "partial" }, async () => {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("worker activation timed out")), 15_000))]); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller && !document.body.innerText.includes("Starting Fusion Shell"));
    await page.evaluate(async () => { await fetch("/api/health?secret=do-not-cache"); await fetch("/manifest.webmanifest?secret=do-not-cache"); });
    const keys = await page.evaluate(async () => {
      const cache = await caches.open("fusion-v8"); return (await cache.keys()).map((r) => r.url);
    });
    assert.ok(keys.some((u) => u.endsWith("/offline.html")), "fallback precached");
    assert.ok(!keys.some((u) => u.includes("secret=do-not-cache") || u.includes("/api/")), "sensitive query/API not cached");
  });
  await test("failed upgrade preserves the previous activated worker and cache", { "AP-04": "partial" }, async () => {
    upgrade = true; failInstall = true;
    const result = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration(); if (!reg?.active) throw new Error("no active worker");
      const old = reg.active;
      const state = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("upgrade did not finish")), 20_000);
        reg.addEventListener("updatefound", () => {
          const next = reg.installing!;
          const check = () => { if (next.state === "redundant" || next.state === "installed") { clearTimeout(timer); resolve(next.state); } };
          next.addEventListener("statechange", check); check();
        }, { once: true });
      });
      await reg.update();
      const nextState = await state;
      return { nextState, oldStillActive: reg.active === old && old.state === "activated", caches: await caches.keys() };
    });
    failInstall = false; upgrade = false;
    assert.equal(result.nextState, "redundant"); assert.equal(result.oldStillActive, true); assert.ok(result.caches.includes("fusion-v8"));
  });
  await test("successful upgrade waits for consent, then activates and reloads", { "AP-04": "partial" }, async () => {
    upgrade = true;
    const result = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration(); if (!reg?.active) throw new Error("no active worker");
      const old = reg.active;
      const installed = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("upgrade did not install")), 20_000);
        reg.addEventListener("updatefound", () => {
          const next = reg.installing!;
          const check = () => { if (next.state === "redundant" || next.state === "installed") { clearTimeout(timer); resolve(next.state); } };
          next.addEventListener("statechange", check); check();
        }, { once: true });
      });
      await reg.update(); const state = await installed;
      return { state, waiting: !!reg.waiting, oldStillActive: reg.active === old };
    });
    assert.deepEqual(result, { state: "installed", waiting: true, oldStillActive: true });
    const reload = page.getByRole("button", { name: "Reload when ready" });
    await reload.waitFor({ state: "visible" });
    await Promise.all([page.waitForEvent("load"), reload.click()]);
    await page.waitForFunction(async () => {
      const keys = await caches.keys(); return keys.includes("fusion-v9-test") && !keys.includes("fusion-v8");
    });
  });
  await test("offline API reports 503 and non-desktop navigation shows the explicit fallback", { "SH-14": "partial" }, async () => {
    offline = true;
    const response = await page.evaluate(async () => { const r = await fetch("/api/health"); return { status: r.status, body: await r.json() }; });
    assert.equal(response.status, 503); assert.equal(response.body.offline, true);
    await page.goto(`${base}/display`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.getByRole("heading", { name: "Connection unavailable" }).count(), 1);
    assert.match(await page.locator("main").innerText(), /server data are not available offline/i);
    offline = false;
  });
} finally {
  offline = false; failInstall = false; upgrade = false;
  await context.close(); await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); finish();
}
