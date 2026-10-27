/** Optional real Chromium timing diagnostic; never relaxes the e2e-privacy gates.
 * Requires the matching exclusive disposable server/database, with an empty /Private. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing private performance diagnostics without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable server/database.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(6).toString("hex"), root = `/Documents/tt92-perf-${id}`, PASS = "correct horse battery staple orbit";
const { test, finish } = makeHarness("tt92-privacy-perf"), cov = { "SC-10": "partial" } as const;
const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const scope = (c: string) => `(${c}=$1 OR left(${c},char_length($1)+1)=$1||'/')`;
const old = await call("GET", "/api/state?id=default"), settings = await call("GET", "/api/settings"), view = settings.json.rows?.find((x: { key: string }) => x.key === "appearance.desktopView")?.value;
let ownHost = false, ownPrivate = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${scope(col)} LIMIT 1`, [root])).rowCount, 0);
  const privateCount = await db.query("SELECT (SELECT count(*)::int FROM vfs_nodes WHERE path LIKE '/Private/%') AS nodes, (SELECT count(*)::int FROM vfs_versions WHERE path='/Private' OR path LIKE '/Private/%') AS versions");
  const privateList = await call("GET", "/api/fs?op=list&path=%2FPrivate"), header = await call("GET", "/api/fs?op=read&path=%2FPrivate%2F.keyslots.json");
  if (privateCount.rows[0].nodes || privateCount.rows[0].versions || privateList.status !== 200 || privateList.json.nodes?.length || header.status !== 404) throw new Error("Refusing to touch a non-empty Persistent Storage volume");
  ownHost = true;
  assert.equal((await call("POST", "/api/fs", { op: "write", path: `${root}/sentinel.txt`, content: id })).status, 200);
  assert.equal((await db.query("SELECT content FROM vfs_nodes WHERE path=$1", [`${root}/sentinel.txt`])).rows[0]?.content, id, "server/database mismatch");
  if (view && view !== "classic") await call("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  const state = await call("GET", "/api/state?id=default"), rev = Number(state.json.row?.revision ?? 1) + 1000;
  const win = { id: `perf-${id}`, module: "privacy", title: "Privacy", x: 40, y: 40, w: 800, h: 700, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} };
  assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [win], focus: win.id, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } })).status, 200);
  const browser = await launchChromium(), ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    const started = new Map<string, number>(), network: number[] = [];
    cdp.on("Network.requestWillBeSent", (e) => { if (e.request.method === "POST" && new URL(e.request.url).pathname === "/api/fs") started.set(e.requestId, e.timestamp); });
    cdp.on("Network.loadingFinished", (e) => { const t = started.get(e.requestId); if (t !== undefined) { network.push((e.timestamp - t) * 1000); started.delete(e.requestId); } });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("privacy").first(); await panel.waitFor({ timeout: 40000 });
    await panel.getByTestId("pp1").fill(PASS); await panel.getByTestId("pp2").fill(PASS); ownPrivate = true;
    await panel.getByTestId("create").click(); await page.getByTestId("storage-badge").first().waitFor({ timeout: 60000 });
    await page.evaluate(() => {
      const w = window as any; w.__tt92Crypto = [];
      for (const name of ["encrypt", "sign"] as const) {
        const orig = crypto.subtle[name].bind(crypto.subtle) as (...args: any[]) => Promise<unknown>;
        Object.defineProperty(crypto.subtle, name, { configurable: true, value: (...args: any[]) => {
          const start = performance.now(), data = args[2], bytes = data?.byteLength ?? 0, algorithm = typeof args[0] === "string" ? args[0] : args[0]?.name;
          return orig(...args).finally(() => w.__tt92Crypto.push({ name, algorithm, bytes, ms: performance.now() - start }));
        } });
      }
    });
    await test("measure real encrypted and host writes and verify encrypted data remains off the host", cov, async () => {
      type Trace = { name: string; algorithm: string; bytes: number; ms: number };
      const samples: { kind: "host" | "private"; ms: number; networkMs: number | null; crypto: Trace[] }[] = [];
      for (let i = 0; i < 20; i++) for (const kind of (i % 2 ? ["private", "host"] : ["host", "private"]) as ("host" | "private")[]) {
        const startNetwork = network.length;
        const result = await page.evaluate(async ([kind, path]) => {
          const w = window as any; w.__tt92Crypto = []; const start = performance.now();
          const r = await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path, content: "x".repeat(256 * 1024) }) });
          const body = await r.json(); return { kind, status: r.status, ok: body.ok, ms: performance.now() - start, crypto: w.__tt92Crypto };
        }, [kind, kind === "host" ? `${root}/h${i}.txt` : `/Private/perf-${id}/p${i}.txt`] as const);
        assert.equal(result.status, 200); assert.equal(result.ok, true); if (i >= 4) samples.push({ kind, ms: result.ms, networkMs: network.length === startNetwork + 1 ? network[startNetwork] : null, crypto: result.crypto });
      }
      const med = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
      const privateSamples = samples.filter((s) => s.kind === "private"), hostSamples = samples.filter((s) => s.kind === "host");
      const capabilities = await page.evaluate(() => ({ userAgent: navigator.userAgent, nativeToBase64: typeof (Uint8Array.prototype as any).toBase64 === "function" }));
      const measured = { at: new Date().toISOString(), note: "diagnostic only: timings include instrumentation and alternate order; not the e2e-privacy gate", capabilities, warmupPairs: 4, pairs: privateSamples.length,
        hostMedianMs: med(hostSamples.map((s) => s.ms)), privateMedianMs: med(privateSamples.map((s) => s.ms)),
        hostNetworkMedianMs: med(hostSamples.map((s) => s.networkMs).filter((n): n is number => n !== null)),
        privateNetworkMedianMs: med(privateSamples.map((s) => s.networkMs).filter((n): n is number => n !== null)),
        privateCryptoMedianMs: med(privateSamples.map((s) => s.crypto.reduce((n, x) => n + x.ms, 0))), samples };
      writeFileSync("docs/privacy-perf-tt92.json", JSON.stringify(measured, null, 2));
      console.log(`    diagnostic median host ${measured.hostMedianMs.toFixed(1)} ms (network ${measured.hostNetworkMedianMs?.toFixed(1)}), private ${measured.privateMedianMs.toFixed(1)} ms (network ${measured.privateNetworkMedianMs?.toFixed(1)}), summed crypto ${measured.privateCryptoMedianMs.toFixed(1)} ms`);
      assert.equal(privateSamples.length, 16); assert.ok(privateSamples.every((s) => s.crypto.some((e) => e.name === "encrypt" && e.bytes > 256 * 1024)));
      const secret = await db.query("SELECT count(*)::int n FROM vfs_nodes WHERE path LIKE '/Private/%' AND content LIKE $1", [`%${"x".repeat(256)}%`]); assert.equal(secret.rows[0].n, 0);
      const check = await page.evaluate(async (p) => { const r = await fetch(`/api/fs?op=read&path=${encodeURIComponent(p)}`); const j = await r.json(); return { status: r.status, content: j.node?.content }; }, `/Private/perf-${id}/p19.txt`);
      assert.equal(check.status, 200); assert.equal(check.content, "x".repeat(256 * 1024));
    });
  } finally { await ctx.close(); await browser.close(); }
} finally {
  if (ownPrivate) { await db.query("DELETE FROM vfs_versions WHERE path LIKE '/Private/%'"); await db.query("DELETE FROM vfs_nodes WHERE path LIKE '/Private/%'"); await db.query("DELETE FROM index_docs WHERE source='file' AND ref LIKE '/Private/%'"); }
  if (ownHost) { await db.query(`DELETE FROM vfs_versions WHERE ${scope("path")}`, [root]); await db.query(`DELETE FROM vfs_nodes WHERE ${scope("path")}`, [root]); await db.query(`DELETE FROM index_docs WHERE source='file' AND ${scope("ref")}`, [root]); }
  const current = await call("GET", "/api/state?id=default").catch(() => null); if (current && old.json.row?.state) await call("PUT", "/api/state", { id: "default", revision: Number(current.json.row?.revision ?? 0) + 1000, state: old.json.row.state }).catch(() => undefined);
  if (view && view !== "classic") await call("PUT", "/api/settings", { key: "appearance.desktopView", value: view }).catch(() => undefined);
  await db.end();
}
finish();
