/** Paired local cold-install measurement against the real production server.
 * The proxy serves a worker from a Git ref (default 148f046) or the current
 * worker; all other responses come from the same current server. Set
 * TT129_WORKER_BASELINE to compare a different ref. This isolates worker code,
 * not the complete app at that ref. Decoded bytes are NOT disk or wire usage. */
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { launchChromium } from "./browser-launch.mts";
if (!process.env.BASE) throw new Error("BASE for the production server is required");
const upstream = new URL(process.env.BASE); if (upstream.protocol !== "http:") throw new Error("HTTP upstream required");
const baselineRef = process.env.TT129_WORKER_BASELINE ?? "148f046";
const baselineCommit = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const variants = { before: execFileSync("git", ["show", `${baselineCommit}:public/sw.js`], { encoding: "utf8" }), after: readFileSync("public/sw.js", "utf8") };
const version = (source: string) => /const VERSION = ["']([^"']+)/.exec(source)?.[1] ?? "unknown";
let selected: keyof typeof variants = "before";
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
const samples: Record<keyof typeof variants, { wallMs: number; entries: number; decodedBytes: number }[]> = { before: [], after: [] };
try {
  for (let i = 0; i < 4; i++) for (const variant of (i % 2 ? ["after", "before"] : ["before", "after"]) as (keyof typeof variants)[]) {
    selected = variant; const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    try {
      const page = await context.newPage(); const start = performance.now();
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("activation timed out")), 20_000))]); });
      const wallMs = performance.now() - start;
      const cache = await page.evaluate(async () => {
        let entries = 0, decodedBytes = 0;
        const names = (await caches.keys()).filter((n) => n.startsWith("fusion-"));
        const paths: string[] = [];
        for (const name of names) {
          const store = await caches.open(name);
          for (const req of await store.keys()) { const value = await store.match(req); if (value) { entries++; decodedBytes += (await value.arrayBuffer()).byteLength; paths.push(new URL(req.url).pathname); } }
        }
        return { entries, decodedBytes, names, paths };
      });
      const missing = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/wallpapers/poolside.svg"].filter((path) => !cache.paths.includes(path));
      if (!cache.names.includes(version(variants[variant])) || missing.length) throw new Error(`${variant} install incomplete: caches=${cache.names.join(",")} missing=${missing.join(",")}`);
      samples[variant].push({ wallMs, entries: cache.entries, decodedBytes: cache.decodedBytes });
    } finally { await context.close(); }
  }
  const stats = (rows: typeof samples.before) => ({ wallMeanMs: rows.reduce((n, r) => n + r.wallMs, 0) / rows.length, decodedBytes: rows[0].decodedBytes, entries: rows[0].entries, samples: rows });
  console.log(JSON.stringify({ availableParallelism: availableParallelism(), baselineRef, baselineCommit, note: "worker-only comparison; both use the current production server", beforeVersion: version(variants.before), afterVersion: version(variants.after), before: stats(samples.before), after: stats(samples.after) }, null, 2));
} finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
