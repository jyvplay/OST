/**
 * TT42 end to end — the oracle is Chromium itself: one page runs natively from site A and through a second production
 * server of this build (spawned from .next); every value the page and its module worker observe must be IDENTICAL.
 *   A = http://127.0.0.1:42891      B = https://127.0.0.2:42893 (cross-site, real TLS from a throwaway CA)
 * WP-20  computed dynamic import(): root-relative in a document AND in a module worker (no import map there), a colon in
 *        the first path segment, an absolute cross-origin URL object, new URL("./x", import.meta.url), a bare name the
 *        page's map routes, a missing module (same rejection), a classic inline script's computed import, and an
 *        eval'd import() that only the page's import-map SCOPE routes (root-relative twins inside scopes).
 *   TT42_DEBUG=1 prints proxied requests / console.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import type { Browser, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("e2e-tt42");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(100); } throw new Error(`timed out: ${what}`); }

const PORT = Number(process.env.TT42_PORT ?? 3993), PA = 42891, PB = 42893, PFRONT = 42899;
const ORIGIN = `http://127.0.0.1:${PORT}`, A = `http://127.0.0.1:${PA}`, B = `https://127.0.0.2:${PB}`;
const CD = "/tmp/tt42-certs";
fs.rmSync(CD, { recursive: true, force: true }); fs.mkdirSync(CD, { recursive: true });
const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: CD, stdio: "pipe" });
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Fusion TT42 test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "b.key", "-out", "b.csr", "-subj", "/CN=b");
fs.writeFileSync(`${CD}/b.ext`, "subjectAltName=IP:127.0.0.2\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
ossl("x509", "-req", "-in", "b.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "b.pem", "-days", "2", "-extfile", "b.ext");

const JS = { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" };
const TRY = `const r = {}; const t = async (k, f) => { try { r[k] = (await f()).v; } catch (e) { r[k] = "ERR:" + (e && e.name); } };`;
const MODS: Record<string, string> = {
  "/m/main.js": `${TRY}
await t("rootComputed", () => import(["", "m", "d1.js"].join("/")));
await t("colon", () => import("/" + "foo:bar" + "/c.js"));
await t("absCross", () => import(new URL("/m/x2.js", ${JSON.stringify(B)})));
await t("relUrl", () => import(new URL("./rel.js", import.meta.url)));
await t("tmpl", () => { const n = "d1"; return import(\`../m/\${n}.js\`); });
await t("bareMapped", () => import("lib/" + "c.js"));
await t("missing", () => import("/m/" + "missing.js"));
await t("evalScoped", () => (0, eval)('import("/old/" + "s.js")'));
r.fetchLen = (await (await fetch("/m/w.js")).text()).length; r.fetchHead = (await (await fetch("/m/w.js")).text()).slice(0, 60); // a page READING a module gets its bytes unchanged
r.navSecret = /data-wst="[^"]+"/.test(await (await fetch("/page")).text()); // a page fetch() is not a navigation
r.w = await new Promise((res) => { const wk = new Worker(new URL("./w.js", import.meta.url), { type: "module" }); wk.onmessage = (e) => res(e.data); wk.onerror = (e) => res({ err: String(e.message || "error") }); });
window.__mod = r;
`,
  "/m/w.js": `${TRY}
await t("wComputed", () => import(["", "m", "wd.js"].join("/")));
await t("wColon", () => import("/" + "foo:bar" + "/c.js"));
await t("wCross", () => import(new URL("/m/x2.js", ${JSON.stringify(B)})));
await t("wRel", () => import("./" + "wd.js"));
postMessage(r);
`,
  "/m/d1.js": `export const v = "computed-root-relative";`,
  "/m/wd.js": `export const v = "worker-computed";`,
  "/foo:bar/c.js": `export const v = "colon-segment";`,
  "/m/rel.js": `export const v = "url-object-relative";`,
  "/lib/c.js": `export const v = "bare-via-page-map";`,
  "/m/cls.js": `export const v = "classic-inline-computed";`,
  "/new/s.js": `export const v = "scoped-mapping";`,
  "/old/s.js": `export const v = "WRONG-scope-ignored";`,
};
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt42</title>
<script type="importmap">{"imports":{"lib/":"/lib/"},"scopes":{"/m/":{"/old/":"/new/"}}}</script>
<script type="module" src="/m/main.js"></script>
<script>import("/m/" + "cls.js").then(function (m) { window.__cls = m.v; }, function (e) { window.__cls = "ERR:" + e.name; });</script>
</head><body><p>tt42</p></body></html>`;

// WP-19 (TT42): srcdoc frames — static (with an inline MODULE, an image, a fetch, and a nested srcdoc) and dynamic
// (property and setAttribute); each reports to its parent (srcdoc documents share the parent's origin)
const SD_STATIC = `<p>s</p><img src="/img?n=sd1"><script>fetch("/echo?n=sd2").then(function (r) { return r.text(); }).then(function (t) { parent.postMessage({ k: "sd2", v: t }, "*"); });</script>` +
  `<script type="module">import { v } from "/m/d1.js"; parent.postMessage({ k: "sdm", v }, "*");</script><iframe srcdoc="<img src=&quot;/img?n=sd5&quot;>"></iframe>`;
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const FPAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt42 srcdoc</title></head><body>
<script>addEventListener("message", function (e) { if (e.data && e.data.k) window["__" + e.data.k] = e.data.v; });</script>
<iframe id="s1" srcdoc="${esc(SD_STATIC)}"></iframe><iframe id="s2"></iframe><iframe id="s3"></iframe>
<script>
document.getElementById("s2").srcdoc = '<img src="/img?n=sd3"><script>fetch("/echo?n=sd4").then(function (r) { return r.text(); }).then(function (t) { parent.postMessage({ k: "sd4", v: t }, "*"); });<\\/script>';
document.getElementById("s3").setAttribute("srcdoc", '<img src="/img?n=sd6"><script>var pa; try { pa = typeof parent.document; } catch (e) { pa = e.name; } parent.postMessage({ k: "sd6", v: document.baseURI.slice(-6) }, "*"); parent.postMessage({ k: "pa", v: pa }, "*");<\\/script>');
</script></body></html>`;
const sdSeen: Record<string, string[]> = { native: [], proxied: [] };
let sdRun = "native";
function siteHandler(self: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url ?? "/", self);
    const p = decodeURIComponent(u.pathname);
    if (p === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    if (p === "/fpage") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(FPAGE); return; }
    if (p === "/img" || p === "/echo") {
      const n = u.searchParams.get("n") ?? ""; sdSeen[sdRun].push(n);
      if (p === "/img") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex")); return; }
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end(`echo:${n}`); return;
    }
    if (p === "/m/x2.js" && self === B) { res.writeHead(200, JS); res.end(`export const v = "cross-origin-computed";`); return; }
    if (self === A && MODS[p] !== undefined) { res.writeHead(200, JS); res.end(MODS[p]); return; }
    res.writeHead(404, { "access-control-allow-origin": "*" }); res.end();
  };
}
const sA = http.createServer(siteHandler(A));
const sB = https.createServer({ key: fs.readFileSync(`${CD}/b.key`), cert: fs.readFileSync(`${CD}/b.pem`) }, siteHandler(B));
let srv: ChildProcess | null = null, browser: Browser | null = null;
// WP-21 (TT42): a browser WITHOUT Fetch Metadata, emulated at the HTTP layer — real Chromium runs the page, but every
// request reaches the server through this front with its Sec-Fetch-* headers removed (Safari < 16.4 sends none)
let frontStripped = 0;
const front = http.createServer((req, res) => {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) { if (/^sec-fetch-/i.test(k)) { frontStripped++; continue; } h[k] = v; }
  const up = http.request({ host: "127.0.0.1", port: PORT, method: req.method, path: req.url, headers: h }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});

async function observe(page: Page, url: string, label: string): Promise<{ mod: Record<string, unknown>; cls: unknown }> {
  await page.goto(url, { waitUntil: "load" });
  await poll(() => page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return !!w.__mod && w.__cls !== undefined; }), `${label}: page results`, 30000)
    .catch(async (e) => { throw new Error(`${(e as Error).message}; have ${JSON.stringify(await page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return { mod: w.__mod ?? null, cls: w.__cls ?? null }; }))}`); });
  return page.evaluate(() => { const w = window as unknown as { __mod: Record<string, unknown>; __cls: unknown }; return { mod: w.__mod, cls: w.__cls }; });
}

try {
  await Promise.all([new Promise<void>((r) => sA.listen(PA, "127.0.0.1", r)), new Promise<void>((r) => sB.listen(PB, "127.0.0.2", r)), new Promise<void>((r) => front.listen(PFRONT, "127.0.0.1", r))]);
  srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    env: { ...process.env, FUSION_WP_TEST_LOOPBACK_PORTS: `${PA},${PB}`, FUSION_WP_UPSTREAM: "", FUSION_WP_OS_PROXY: "0", NODE_EXTRA_CA_CERTS: `${CD}/ca.pem` }, stdio: "ignore",
  });
  await poll(async () => (await fetch(`${ORIGIN}/api/wp-route`)).ok, "second server up", 40000);
  browser = await launchChromium();

  const nctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const native = await observe(await nctx.newPage(), `${A}/page`, "native");
  await nctx.close();

  const sess = await (await fetch(`${ORIGIN}/api/wp-session`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ ua: "desktop" }) })).json() as { sid: string; prefix: string };
  ok(sess.sid, "session");
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  if (process.env.TT42_DEBUG) {
    pp.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 300)));
    pp.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
    pp.on("request", (r) => { if (/\.js(\?|$)/.test(r.url())) console.log("REQ", r.url().replace(/^.*\/api\/wp\/s\//, "").slice(0, 140)); });
    pp.on("response", (r) => { if (/\.js(\?|$)/.test(r.url())) console.log("RESP", r.status(), r.url().replace(/^.*\/api\/wp\/s\//, "").slice(0, 140)); });
    pp.on("requestfailed", (r) => console.log("FAILED", r.url().slice(-90), r.failure()?.errorText));
  }
  const proxied = await observe(pp, `${ORIGIN}${sess.prefix}${`${A}/page`.replace("://", "/")}`, "proxied");

  await test("WP-20 oracle: computed dynamic import() — root-relative in the document AND in a module worker (where no import map applies), a colon in the first path segment (document and worker), an absolute CROSS-ORIGIN URL object (document and worker; CSP refuses the raw URL), new URL(\"./x\", import.meta.url), a template, a relative computed path in the worker, a bare name routed by the page's map, a missing module (same rejection), a classic inline script's computed import, and an eval'd import() routed only by an import-map SCOPE — every value IDENTICAL natively and through the proxy", { "WP-20": "full" }, async () => {
    const keys = ["rootComputed", "colon", "absCross", "relUrl", "tmpl", "bareMapped", "missing", "evalScoped", "fetchLen", "navSecret"];
    const wkeys = ["wComputed", "wColon", "wCross", "wRel"];
    const rows: string[] = [], bad: string[] = [];
    const nw = (native.mod.w ?? {}) as Record<string, unknown>, pw = (proxied.mod.w ?? {}) as Record<string, unknown>;
    for (const k of keys) { const same = JSON.stringify(native.mod[k]) === JSON.stringify(proxied.mod[k]); rows.push(`${same ? "=" : "≠"} ${k}: native ${JSON.stringify(native.mod[k])} proxied ${JSON.stringify(proxied.mod[k])}`); if (!same) bad.push(k); }
    for (const k of wkeys) { const same = JSON.stringify(nw[k]) === JSON.stringify(pw[k]); rows.push(`${same ? "=" : "≠"} worker.${k}: native ${JSON.stringify(nw[k])} proxied ${JSON.stringify(pw[k])}`); if (!same) bad.push(`worker.${k}`); }
    { const same = native.cls === proxied.cls; rows.push(`${same ? "=" : "≠"} classicInline: native ${JSON.stringify(native.cls)} proxied ${JSON.stringify(proxied.cls)}`); if (!same) bad.push("classicInline"); }
    console.log(rows.map((x) => "     " + x).join("\n"));
    ok(bad.length === 0, `differences: ${bad.join(", ")}`);
    // not vacuous: the native run really loaded every module (and the missing one really failed)
    ok(native.mod.rootComputed === "computed-root-relative" && native.mod.colon === "colon-segment" && native.mod.absCross === "cross-origin-computed" && native.mod.evalScoped === "scoped-mapping" && native.mod.missing === "ERR:TypeError" && nw.wComputed === "worker-computed" && nw.wCross === "cross-origin-computed" && native.cls === "classic-inline-computed", `native baseline: ${JSON.stringify(native)}`);
  });

  // ---- the same page through the Fetch-Metadata-stripping front
  const sess2 = await (await fetch(`${ORIGIN}/api/wp-session`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ ua: "desktop" }) })).json() as { sid: string; prefix: string };
  const fctx = await browser.newContext();
  const fp = await fctx.newPage();
  // a failed observation fails THIS test only (the suite goes on to the next one)
  let noFmErr = "";
  const noFmR = await observe(fp, `http://127.0.0.1:${PFRONT}${sess2.prefix}${`${A}/page`.replace("://", "/")}`, "no-fetch-metadata").catch((e: Error) => { noFmErr = e.message; return null; });
  await test("WP-21 browsers WITHOUT Fetch Metadata (TT41 blocker; emulated at the HTTP layer: real Chromium behind a front that removes every Sec-Fetch-* header, as Safari < 16.4 sends none): the destination is inferred from the URL tag + Accept — module scripts and module workers are still rewritten (all computed / static imports identical to native), a page fetch() of a module still gets its bytes UNCHANGED (the shim's \"e\" flag = destination empty), and a page fetch() of a document gets NO navigation secret (before TT42 every untagged request without Fetch Metadata counted as a navigation)", { "WP-21": "full" }, async () => {
    ok(noFmR, noFmErr); const noFm = noFmR!;
    ok(frontStripped > 20, `the front really removed Fetch Metadata (${frontStripped} headers)`);
    const bad: string[] = [];
    const keys = ["rootComputed", "colon", "absCross", "relUrl", "tmpl", "bareMapped", "missing", "evalScoped", "fetchLen", "navSecret"];
    for (const k of keys) if (JSON.stringify(native.mod[k]) !== JSON.stringify(noFm.mod[k])) bad.push(`${k}: native ${JSON.stringify(native.mod[k])} no-FM ${JSON.stringify(noFm.mod[k])}`);
    const nw = (native.mod.w ?? {}) as Record<string, unknown>, fw = (noFm.mod.w ?? {}) as Record<string, unknown>;
    for (const k of ["wComputed", "wColon", "wCross", "wRel"]) if (JSON.stringify(nw[k]) !== JSON.stringify(fw[k])) bad.push(`worker.${k}: native ${JSON.stringify(nw[k])} no-FM ${JSON.stringify(fw[k])}`);
    if (native.cls !== noFm.cls) bad.push(`classicInline: ${JSON.stringify(noFm.cls)}`);
    ok(bad.length === 0, bad.join("\n    "));
    console.log(`     ${frontStripped} Sec-Fetch-* headers removed; ${keys.length + 5} values identical to native; fetchLen ${noFm.mod.fetchLen}, navSecret ${noFm.mod.navSecret}`);
  });

  // ---- srcdoc frames, native vs proxied
  const sdObserve = async (page: Page, url: string, label: string) => {
    await page.goto(url, { waitUntil: "load" });
    const want = ["sd1", "sd3", "sd5", "sd6"];
    await poll(async () => (await page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return !!(w.__sd2 && w.__sd4 && w.__sdm && w.__sd6); })) && want.every((n) => sdSeen[sdRun].includes(n)), `${label}: srcdoc results`, 20000)
      .catch(async (e) => { throw new Error(`${(e as Error).message}; seen ${JSON.stringify(sdSeen[sdRun])} vars ${JSON.stringify(await page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return [w.__sd2, w.__sd4, w.__sdm, w.__sd6]; }))}`); });
    await poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__pa !== undefined), `${label}: parent-access probe`, 5000);
    return page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return { sd2: w.__sd2, sd4: w.__sd4, sdm: w.__sdm, sd6: w.__sd6, pa: w.__pa }; });
  };
  sdRun = "native";
  const nctx2 = await browser.newContext();
  const sdN = await sdObserve(await nctx2.newPage(), `${A}/fpage`, "native srcdoc");
  await nctx2.close();
  sdRun = "proxied";
  let sdErr = "";
  const sdP = await sdObserve(await pctx.newPage(), `${ORIGIN}${sess.prefix}${`${A}/fpage`.replace("://", "/")}`, "proxied srcdoc").catch((e: Error) => { sdErr = e.message; return null; });
  await test("WP-19 srcdoc frames (TT41 blocker): a STATIC srcdoc (server-rewritten: its image, its script's fetch, its inline MODULE's root-relative import, and a NESTED srcdoc's image) and DYNAMIC srcdoc set by script through the property and through setAttribute (shim-rewritten in an inert DOMParser document, runtime injected) — every resource reaches the site and every value the frames report to their parent is IDENTICAL natively and through the proxy", { "WP-19": "full" }, async () => {
    ok(sdP, sdErr);
    const { pa: paN, ...vN } = sdN as Record<string, unknown>, { pa: paP, ...vP } = sdP as Record<string, unknown>;
    ok(JSON.stringify(vN) === JSON.stringify(vP), `native ${JSON.stringify(sdN)}\n    proxied ${JSON.stringify(sdP)}`);
    // DECLARED LIMIT (measured, not asserted equal): a srcdoc child inherits the proxied document's CSP sandbox and
    // so gets its own opaque origin — direct parent.document access works natively but not through the proxy
    console.log(`     declared limit — srcdoc → parent.document: native ${JSON.stringify(paN)}, proxied ${JSON.stringify(paP)}`);
    for (const n of ["sd1", "sd2", "sd3", "sd4", "sd5", "sd6"]) ok(sdSeen.native.includes(n) && sdSeen.proxied.includes(n), `${n}: native ${sdSeen.native.includes(n)} proxied ${sdSeen.proxied.includes(n)}`);
    console.log(`     srcdoc values identical ${JSON.stringify(sdP)}; site saw ${[...new Set(sdSeen.proxied)].sort().join(",")} through the proxy`);
  });
} catch (e) {
  await test("e2e-tt42 setup", {}, async () => { throw e; });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill("SIGTERM");
  sA.close(); sB.close(); front.close();
}
await finish();
process.exit(0);
