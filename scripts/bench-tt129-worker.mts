/** Paired local cold-install measurement against the real production server.
 * The proxy serves the committed v7 or current v8 worker; all other responses
 * come from the server. Decoded response bytes are NOT physical disk usage. */
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { launchChromium } from "./browser-launch.mts";
if (!process.env.BASE) throw new Error("BASE for the production server is required");
const upstream = new URL(process.env.BASE); if (upstream.protocol !== "http:") throw new Error("HTTP upstream required");
const variants = { v7: execFileSync("git", ["show", "148f046:public/sw.js"], { encoding: "utf8" }), v8: readFileSync("public/sw.js", "utf8") };
let selected: keyof typeof variants = "v7";
const server = createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "";
  if (path === "/sw.js") { res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" }); res.end(variants[selected]); return; }
  const out = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...r.headers, "cache-control": "no-store" }); r.pipe(res);
  });
  out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(out);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("proxy not bound");
const base = `http://127.0.0.1:${address.port}`; const browser = await launchChromium();
const samples: Record<string, { wallMs: number; entries: number; decodedBytes: number }[]> = { v7: [], v8: [] };
try {
  for (let i = 0; i < 4; i++) for (const variant of (i % 2 ? ["v8", "v7"] : ["v7", "v8"]) as (keyof typeof variants)[]) {
    selected = variant; const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    try {
      const page = await context.newPage(); const start = performance.now();
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("activation timed out")), 20_000))]); });
      const wallMs = performance.now() - start;
      const cache = await page.evaluate(async () => {
        let entries = 0, decodedBytes = 0;
        for (const name of (await caches.keys()).filter((n) => n.startsWith("fusion-"))) {
          const store = await caches.open(name);
          for (const req of await store.keys()) { const value = await store.match(req); if (value) { entries++; decodedBytes += (await value.arrayBuffer()).byteLength; } }
        }
        return { entries, decodedBytes };
      });
      samples[variant].push({ wallMs, ...cache });
    } finally { await context.close(); }
  }
  const stats = (rows: typeof samples.v7) => ({ wallMeanMs: rows.reduce((n, r) => n + r.wallMs, 0) / rows.length, decodedBytes: rows[0].decodedBytes, entries: rows[0].entries, samples: rows });
  console.log(JSON.stringify({ availableParallelism: availableParallelism(), baseline: "148f046:public/sw.js", v7: stats(samples.v7), v8: stats(samples.v8) }, null, 2));
} finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
