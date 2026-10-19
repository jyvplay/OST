/**
 * TT43 end to end — WP-22 SharedWorker shared like a native one. The oracle is Chromium's own SharedWorker:
 *   native:  pages P1 (?c=a) and P2 (?c=b) in ONE browser context (one profile), P3 (?c=c) in ANOTHER context;
 *   proxied: the REAL Fusion desktop of a second production server of this build (spawned from .next): a Browser
 *            window in split view with two tabs in profile "Work" (P1, P2 — one proxy session) and a second Browser
 *            window with P3 (its own session). Every page also embeds a same-site frame that joins the worker.
 * The worker counts "inc" messages and connections, reports self.name / self.location, and fetches /hit (which
 * echoes the cookie NAMES it was sent — i.e. which jar the worker uses). Values must be IDENTICAL.
 * Then (proxied): lifecycle — P3 leaves the site → its session's host is removed, P1/P2's worker keeps its state —
 * and attacks: a forged document id, a script of another site, direct use of the broker's server endpoints.
 *   A = http://127.0.0.1:42881    TT43_DEBUG=1 prints console output of the Fusion page.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("e2e-tt43");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(120); } throw new Error(`timed out: ${what}`); }

const PORT = Number(process.env.TT43_PORT ?? 3994), PA = 42881;
const ORIGIN = `http://127.0.0.1:${PORT}`, A = `http://127.0.0.1:${PA}`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt43</title></head><body><p>tt43</p>
<script>
window.__out = []; window.__frame = null;
addEventListener("message", function (e) { if (e.data && e.data.frame) window.__frame = e.data.frame; });
var w = new SharedWorker("/sw.js", { name: "count" });
w.port.onmessage = function (e) { window.__out.push(e.data); };
window.__send = function (m) { w.port.postMessage(m); };
var w2 = new SharedWorker("/sw.js", "other"); w2.port.onmessage = function (e) { window.__other = e.data; }; w2.port.postMessage("peek");
try { new SharedWorker("http://127.0.0.2:42882/sw.js"); window.__xo = "no-throw"; } catch (e) { window.__xo = e.name; }
try { new SharedWorker("http://[::1"); window.__bad = "no-throw"; } catch (e) { window.__bad = e.name; }
var w3 = new SharedWorker("/missing.js"); w3.onerror = function () { window.__err = "error-event"; };
</script><iframe src="/swf"></iframe></body></html>`;
const FRAME = `<!doctype html><script>var w = new SharedWorker("/sw.js", { name: "count" }); w.port.onmessage = function (e) { parent.postMessage({ frame: e.data }, "*"); }; w.port.postMessage("frame");</script>`;
const SW = `var n = 0, conns = 0;
onconnect = function (e) { var p = e.ports[0]; conns++; p.onmessage = function (m) {
  if (m.data === "inc") n++;
  fetch("/hit").then(function (r) { return r.text(); }).then(function (t) { p.postMessage({ n: n, conns: conns, name: self.name, loc: String(self.location.href), cookies: t, said: m.data }); });
}; };`;
const site = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", A);
  if (u.pathname === "/swp") { const c = (u.searchParams.get("c") ?? "x").replace(/\W/g, ""); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `${c}=1; Path=/; SameSite=Lax` }); res.end(PAGE); return; }
  if (u.pathname === "/swf") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(FRAME); return; }
  if (u.pathname === "/plain") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<!doctype html><title>plain</title><p>plain</p>"); return; }
  if (u.pathname === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(SW); return; }
  if (u.pathname === "/hit") {
    const names = String(req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((kv) => kv.split("=")[0]).sort().join(",");
    res.writeHead(200, { "content-type": "text/plain" }); res.end(names || "-"); return;
  }
  res.writeHead(404); res.end();
});

type Probe = (f: () => unknown) => Promise<unknown>;
interface World { p1: Probe; p2: Probe; p3: Probe }
/** the same scripted conversation in either world */
async function converse(w: World, label: string) {
  for (const [k, p] of Object.entries({ p1: w.p1, p2: w.p2, p3: w.p3 })) {
    await poll(async () => !!(await p(() => { const x = window as unknown as Record<string, unknown>; return x.__frame && x.__other && x.__err && x.__xo && x.__bad; })), `${label}: ${k} ready`, 25000);
  }
  const say = async (p: Probe, m: string, nth: number) => {
    await p(new Function(`window.__send(${JSON.stringify(m)})`) as () => unknown);
    await poll(async () => ((await p(() => (window as unknown as { __out: unknown[] }).__out.length)) as number) >= nth, `${label}: reply ${m}`, 15000);
    return ((await p(() => (window as unknown as { __out: unknown[] }).__out)) as unknown[])[nth - 1];
  };
  const r1 = await say(w.p1, "inc", 1), r2 = await say(w.p2, "inc", 1), r3 = await say(w.p3, "inc", 1), r4 = await say(w.p1, "get", 2);
  const extra = async (p: Probe) => p(() => { const x = window as unknown as Record<string, { n: number; name: string; said: string } | string>; const o = x.__other as { n: number; name: string; said: string }; const f = x.__frame as { said: string; name: string }; return { other: { n: o.n, name: o.name, said: o.said }, frame: { said: f.said, name: f.name }, xo: x.__xo, bad: x.__bad, err: x.__err }; });
  return { r1, r2, r3, r4, e1: await extra(w.p1), e3: await extra(w.p3) };
}

let srv: ChildProcess | null = null, browser: Browser | null = null;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(ORIGIN + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
};
const tab = (id: string, url: string, profile?: string) => ({ id, url, title: new URL(url).host, group: "", pinned: false, asleep: false, ...(profile ? { profile } : {}) });
const win = (id: string, x: number, tabs: ReturnType<typeof tab>[], split: "off" | "h") => ({ id, module: "browser", title: "Browser", x, y: 8, w: 700, h: 820, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { tabs, active: tabs[0].id, split, proxyAll: true } });
let prevState: unknown, prevView: string | undefined;

try {
  site.listen(PA, "127.0.0.1");
  srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    env: { ...process.env, FUSION_WP_TEST_LOOPBACK_PORTS: `${PA}`, FUSION_WP_UPSTREAM: "", FUSION_WP_OS_PROXY: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let srvLog = ""; srv.stdout!.on("data", (d) => { srvLog = (srvLog + d).slice(-2000); }); srv.stderr!.on("data", (d) => { srvLog = (srvLog + d).slice(-2000); });
  let lastStatus = "";
  await poll(async () => { const r = await fetch(`${ORIGIN}/api/wp-route`).catch((e) => { lastStatus = String(e.cause?.code ?? e); return null; }); if (r) lastStatus = String(r.status); return !!r?.ok; }, "second server up", 60000)
    .catch((e) => { throw new Error(`${(e as Error).message} (last: ${lastStatus}; exit ${srv?.exitCode}) ${srvLog.replace(/\s+/g, " ").slice(-600)}`); });
  browser = await launchChromium();

  // ---- native: P1 + P2 in one context, P3 in another
  const n1 = await browser.newContext(), n2 = await browser.newContext();
  const [np1, np2, np3] = [await n1.newPage(), await n1.newPage(), await n2.newPage()];
  await Promise.all([np1.goto(`${A}/swp?c=a`), np2.goto(`${A}/swp?c=b`), np3.goto(`${A}/swp?c=c`)]);
  const ev = (p: Page): Probe => (f) => p.evaluate(f);
  const native = await converse({ p1: ev(np1), p2: ev(np2), p3: ev(np3) }, "native");
  await n1.close(); await n2.close();

  // ---- proxied: the real Fusion desktop
  prevState = (await api("GET", "/api/state?id=default")).json.row?.state;
  prevView = (await api("GET", "/api/settings")).json.rows?.find((r: { key: string }) => r.key === "appearance.desktopView")?.value;
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  const windows = [win("b1", 8, [tab("t1", `${A}/swp?c=a`, "Work"), tab("t2", `${A}/swp?c=b`, "Work")], "h"), win("b2", 716, [tab("t3", `${A}/swp?c=c`)], "off")];
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: "b2", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 } } });
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  if (process.env.TT43_DEBUG) { page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 300))); page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300))); }
  await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
  const fr = (c: string): Frame | undefined => page.frames().find((f) => f.url().includes("/api/wp/s/") && f.url().includes(`/swp?c=${c}`));
  await poll(() => !!fr("a") && !!fr("b") && !!fr("c"), "three proxied tabs mounted (split view + second window)", 40000);
  const fp = (c: string): Probe => async (f) => { const x = fr(c); if (!x) throw new Error(`no frame ${c}`); return x.evaluate(f); };
  const proxied = await converse({ p1: fp("a"), p2: fp("b"), p3: fp("c") }, "proxied");

  await test("WP-22 oracle: SharedWorker shared like Chromium's own — two tabs of one profile (Fusion split view, one proxy session) and their nested same-site frames reach ONE worker (count and connections continue across them), a tab of another session gets its own; self.name, self.location, the worker's cookie jar (cookies set by BOTH tabs of the profile, only the other tab's in the other session), a second named worker, SecurityError for another site's script, SyntaxError for a bad URL and the error event of a missing script — every value IDENTICAL natively and through the proxy", { "WP-22": "full" }, async () => {
    const N = JSON.stringify(native), P = JSON.stringify(proxied);
    ok(N === P, `native  ${N}\n    proxied ${P}`);
    const r2 = native.r2 as { n: number; conns: number };
    ok(r2.n === 2 && r2.conns === 4, `the native oracle really shares (n ${r2.n}, conns ${r2.conns})`);
    console.log(`     identical: ${P.slice(0, 400)}`);
  });

  await test("WP-22 hosts and lifecycle (proxied): one hidden host document per (session, site) — opaque origin, sandboxed — and when the last page of a session leaves the site its host is removed (after the grace), while the other session's worker keeps its state; coming back starts a fresh worker", { "WP-22": "full" }, async () => {
    const hosts = page.locator("iframe[data-fusion-shared-host]");
    ok((await hosts.count()) === 2, `hosts: ${await hosts.count()}`);
    const hf = page.frames().filter((f) => f.url().includes("/__shared-host?"));
    const origins = await Promise.all(hf.map((f) => f.evaluate(() => self.origin)));
    ok(origins.length === 2 && origins.every((o) => o === "null"), `host origins ${origins}`);
    await fr("c")!.evaluate(() => { location.href = location.pathname.replace(/swp$/, "plain"); });
    await poll(async () => (await hosts.count()) === 1, "session 2's host removed after P3 left", 10000)
      .catch(async (e) => { throw new Error(`${(e as Error).message}; broker ${JSON.stringify(await page.evaluate(() => (window as unknown as { __fusionSharedBroker: { stats(): unknown; conns: Map<number, { id: string; wkey: string; hostKey: string }> } }).__fusionSharedBroker).then(async (b) => ({ s: await page.evaluate(() => (window as any).__fusionSharedBroker.stats()), c: await page.evaluate(() => [...(window as any).__fusionSharedBroker.conns.values()].map((c: any) => [c.id, c.wkey.split("\n")[1], c.hostKey.split("\n")[0].slice(0, 6), (() => { try { return c.src.closed; } catch { return "x"; } })()])) })))}; frames ${page.frames().map((f) => f.url().replace(/^.*\/api\/wp\/s\/[^/]+/, "").slice(0, 60)).join(" | ")}`); });
    await fp("a")(() => (window as unknown as { __send: (m: string) => void }).__send("get"));
    await poll(async () => ((await fp("a")(() => (window as unknown as { __out: unknown[] }).__out.length)) as number) >= 3, "P1 reply");
    const r5 = (await fp("a")(() => (window as unknown as { __out: { n: number }[] }).__out[2])) as { n: number };
    ok(r5.n === 2, `session 1's worker kept its state: ${JSON.stringify(r5)}`);
    const plain = page.frames().find((f) => f.url().includes("/plain"))!;
    await plain.evaluate(() => { location.href = location.pathname.replace(/plain$/, "swp") + "?c=c"; });
    await poll(async () => !!fr("c") && !!(await fr("c")!.evaluate(() => !!(window as unknown as { __frame: unknown }).__frame).catch(() => false)), "P3 back", 20000);
    await fp("c")(() => (window as unknown as { __send: (m: string) => void }).__send("inc"));
    await poll(async () => ((await fp("c")(() => (window as unknown as { __out: unknown[] }).__out.length)) as number) >= 1, "P3 reply");
    const r6 = (await fp("c")(() => (window as unknown as { __out: { n: number }[] }).__out[0])) as { n: number };
    ok(r6.n === 1 && (await hosts.count()) === 2, `fresh worker for session 2: ${JSON.stringify(r6)}`);
    console.log(`     hosts 2 → 1 after P3 left → 2 on return; session 1 kept n=${r5.n}; session 2 restarted at n=${r6.n}`);
  });

  await test("WP-22 attacks (proxied): a page that forges a connect with a document id the server never issued, or names another site's script, gets an error and no worker; a proxied page calling the broker's server endpoints directly (__shared-who / __shared-host) cannot read them, and the server refuses such requests (403: only the Fusion window may), so it can neither learn about documents nor mint host documents", { "WP-22": "full" }, async () => {
    const res = await fp("a")(async () => {
      const me = document.querySelector("script[data-fusion-wp]") as HTMLScriptElement;
      const sid = me.dataset.sid!, doc = me.dataset.doc!;
      const errs: string[] = [];
      addEventListener("message", (e) => { if (e.data && e.data.fusionWpShared === "error") errs.push(e.data.id); });
      const send = (id: string, d: string, url: string) => { const mc = new MessageChannel(); top!.postMessage({ fusionWpShared: "connect", id, sid, doc: d, url, name: "", type: "classic" }, "*", [mc.port2]); };
      send("forged1", "AAAAAAAAAAAAAAAA", location.href);
      send("othersite1", doc, "http://127.0.0.2:42882/sw.js");
      await new Promise((r) => setTimeout(r, 1500));
      const who = await fetch(`/api/wp/s/${sid}/__shared-who?d=${encodeURIComponent(doc)}`).then((r) => r.status, () => -1);
      const host = await fetch(`/api/wp/s/${sid}/__shared-host?d=${encodeURIComponent(doc)}`).then((r) => r.status, () => -1);
      return { errs: errs.sort(), who, host };
    }) as { errs: string[]; who: number; host: number };
    ok(JSON.stringify(res.errs) === JSON.stringify(["forged1", "othersite1"]), JSON.stringify(res));
    ok(res.who === -1 && res.host === -1, `the page cannot read either endpoint: ${JSON.stringify(res)}`);
    // and the server refuses what such a request carries (an opaque initiator: Origin null / Sec-Fetch-Site cross-site)
    const sid = await fp("a")(() => (document.querySelector("script[data-fusion-wp]") as HTMLScriptElement).dataset.sid) as string;
    const doc = await fp("a")(() => (document.querySelector("script[data-fusion-wp]") as HTMLScriptElement).dataset.doc) as string;
    for (const ep of ["__shared-who", "__shared-host"]) {
      const r1 = await fetch(`${ORIGIN}/api/wp/s/${sid}/${ep}?d=${doc}`, { headers: { "sec-fetch-site": "cross-site", origin: "null" } });
      const r2 = await fetch(`${ORIGIN}/api/wp/s/${sid}/${ep}?d=${doc}`, { headers: { "sec-fetch-site": "cross-site" } });
      ok(r1.status === 403 && r2.status === 403, `${ep}: ${r1.status} / ${r2.status}`);
    }
    ok((await page.locator("iframe[data-fusion-shared-host]").count()) === 2, "no host was framed for the forgeries");
    console.log(`     forged → errors ${res.errs.join(", ")}; endpoints from the page unreadable; server 403 for opaque / cross-site callers`);
  });
  await ctx.close();
} catch (e) {
  await test("e2e-tt43 setup", {}, async () => { throw e; });
} finally {
  if (prevState !== undefined) {
    const cur = await api("GET", "/api/state?id=default").catch(() => null);
    await api("PUT", "/api/state", { id: "default", revision: Number(cur?.json.row?.revision ?? 1) + 1000, state: prevState }).catch(() => {});
  }
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView }).catch(() => {});
  await browser?.close().catch(() => {});
  srv?.kill("SIGTERM");
  site.close();
}
await finish();
process.exit(0);
