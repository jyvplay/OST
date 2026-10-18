/**
 * TT41 end to end — the oracle is Chromium itself. One page runs twice in real Chromium: natively from site A, and
 * through a second production server of this build. Everything the PAGE observed (module values, worker locations,
 * Response.url, which fetches failed) and everything the SITES saw (cookies, Origin, Sec-Fetch-Site, Referer) must be
 * identical, and B's / A′'s cookie jars must end up the same.
 *   A  = http://127.0.0.1:41891      A′ = http://127.0.0.1:41892 (same site as A: cookies are not port-scoped)
 *   B  = https://127.0.0.2:41893     C  = https://127.0.0.2:41894 (same site as B, cross-site to A; real TLS)
 * WP-17  ES modules: root-relative / parent-relative / absolute cross-origin imports, an import map (bare prefix AND a
 *        URL-like key), export-from, dynamic import(), import.meta.url, `new Worker(new URL("./w.js", import.meta.url))`,
 *        a module worker's own root-relative import, importScripts, self.location / self.origin, a data: worker.
 * WP-18  fetch fidelity: Response.url / redirected / XHR responseURL / Request.url, redirect TAINT (A→B→C gives Origin
 *        "null"; A→B→A is cross-origin for cookies and needs CORS), mode "same-origin" across origins, full Referer.
 * WP-19  frames: SameSite follows the frame tree — a cross-site iframe and everything inside it get only SameSite=None
 *        cookies and may only store those; a same-site iframe keeps them all.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import type { Browser, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("e2e-tt41");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PORT = Number(process.env.TT41_PORT ?? 3992), PA = 41891, PA2 = 41892, PB = 41893, PC = 41894;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const A = `http://127.0.0.1:${PA}`, A2 = `http://127.0.0.1:${PA2}`, B = `https://127.0.0.2:${PB}`, C = `https://127.0.0.2:${PC}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(100); } throw new Error(`timed out: ${what}`); }

const CD = "/tmp/tt41-certs";
fs.rmSync(CD, { recursive: true, force: true }); fs.mkdirSync(CD, { recursive: true });
const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: CD, stdio: "pipe" });
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Fusion TT41 test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "b.key", "-out", "b.csr", "-subj", "/CN=b");
fs.writeFileSync(`${CD}/b.ext`, "subjectAltName=IP:127.0.0.2\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
ossl("x509", "-req", "-in", "b.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "b.pem", "-days", "2", "-extfile", "b.ext");

type Seen = { n: string; cookie: string; sfs: string | null; referer: string | null; origin: string | null };
const seen: Record<string, Seen[]> = { native: [], proxied: [] };
let run = "native";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const JS = { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" };

// ---- the modules (served by A; x.js by B, cross-origin with ACAO *)
const MODS: Record<string, string> = {
  "/m/main.js": `import { a } from "/m/root.js";
import { b } from "../../m/up.js";
import { c } from "lib/c.js";
import { d } from "/mapped/d.js";
import { x } from "${B}/m/x.js";
export { r } from "/m/re.js";
import * as ns from "/m/re.js";
// import "/m/never-1.js"   — a comment, not a dependency
const s = "import '/m/never-2.js'", re = /import\\("\\/m\\/never-3\\.js"\\)/, t = \`import("/m/never-4.js") \${a}\`;
const dyn = await import("/m/dyn.js");
const dv = ["", "m", "dyn2.js"].join("/"), dyn2 = await import(dv); // computed at run time: only an import map can route it
const dm = await import(["", "mapped", "d2.js"].join("/")); // computed, through the PAGE's own URL-like key
const w = await new Promise((res) => { const wk = new Worker(new URL("./w.js", import.meta.url), { type: "module" }); wk.onmessage = (e) => res(e.data); wk.onerror = (e) => res({ err: String(e.message || "error") }); });
window.__mod = { a, b, c, d, x, r: ns.r, dyn: dyn.v, dyn2: dyn2.v, dm: dm.v, meta: import.meta.url, metaResolve: import.meta.resolve ? import.meta.resolve("./q.js") : null, w, decoys: [s.length, String(re).length, t.length] };
`,
  "/m/root.js": `export const a = "root";`,
  "/m/up.js": `export const b = "up";`,
  "/lib/c.js": `export const c = "bare-via-map";`,
  "/real/d.js": `export const d = "url-key-via-map";`,
  "/real/d2.js": `export const v = "computed-via-page-map";`,
  "/m/re.js": `export const r = "reexport";`,
  "/m/dyn.js": `export const v = "dynamic";`,
  "/m/dyn2.js": `export const v = "computed-root-relative";`,
  "/m/w.js": `import { a } from "/m/root.js";
postMessage({ a, href: location.href, str: String(location), origin: self.origin, path: location.pathname, host: location.host, isWL: typeof WorkerLocation === "function" && location instanceof WorkerLocation });`,
  "/m/cw.js": `importScripts("/m/imp.js");
fetch("/m/root.js").then((r) => postMessage({ imp: self.__imp, href: location.href, origin: self.origin, rurl: r.url, redirected: r.redirected }), (e) => postMessage({ err: String(e) }));`,
  "/m/imp.js": `self.__imp = "imported";`,
  "/m/inline-dep.js": `export const v = "inline";`,
};
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt41</title>
<script type="importmap">{"imports":{"lib/":"/lib/","/mapped/":"/real/"}}</script>
<script type="module" src="/m/main.js"></script>
<script type="module">import { v } from "/m/inline-dep.js"; window.__inline = { v, meta: import.meta.url };</script>
</head><body><h1>tt41</h1>
<iframe id="xf" src="${B}/frame?n=fnav"></iframe><iframe id="sf" src="${A2}/frame?n=snav"></iframe>
<script>
(function () {
  var A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)}, C = ${JSON.stringify(C)};
  function q(o) { return Object.keys(o).map(function (k) { return k + "=" + encodeURIComponent(o[k]); }).join("&"); }
  function F(name, url, init) {
    return fetch(url, init).then(function (r) { return r.text().then(function (t) { return [name, { ok: r.ok, status: r.status, url: r.url, redirected: r.redirected, type: r.type, body: t.slice(0, 80) }]; }); },
      function (e) { return [name, { error: e && e.name }]; });
  }
  var echo = function (n, extra) { return "/echo?" + q(Object.assign({ n: n }, extra || {})); };
  var redir = function (from, to, extra) { return from + "/redir?" + q(Object.assign({ to: to }, extra || {})); };
  var go = function () { Promise.all(mk().map(function (p) { return p; })).then(function (rs) { var o = {}; rs.forEach(function (p) { o[p[0]] = p[1]; }); window.__fetch = o; }); };
  function mk() { return [
    F("r1", redir(A, A + echo("r1"))),                                                         // same-origin redirect
    F("r2", redir(A, B + echo("r2", { acao: "*" }))),                                          // → cross-origin, untainted
    F("r3", redir(B, C + echo("r3", { acao: "null", acac: "1" }), { racao: "page", acac: "1" }), { credentials: "include" }), // A→B→C: tainted
    F("r4", redir(B, C + echo("r4", { acao: "page", acac: "1" }), { racao: "page", acac: "1" }), { credentials: "include" }), // tainted: ACAO A must fail
    F("r5", redir(B, A + echo("r5", { acao: "*" }), { racao: "*" })),                         // A→B→A: tainted, cors, no cookies
    F("r6", redir(B, A + echo("r6"), { racao: "*" })),                                        // same without ACAO: fails
    F("r7", redir(A, B + echo("r7", { acao: "*" })), { mode: "same-origin" }),                // same-origin mode leaves: fails
    F("r8", A + echo("r8")),                                                                   // Referer = the full page URL
    new Promise(function (res) { var x = new XMLHttpRequest(); x.open("GET", redir(A, A + echo("x1"))); x.onload = function () { res(["x1", { url: x.responseURL, status: x.status }]); }; x.onerror = function () { res(["x1", { error: "xhr" }]); }; x.send(); }),
    Promise.resolve(["req", { url: new Request("/x?y=1#frag").url, rel: new Request("rel/z").url }]),
    new Promise(function (res) { var w = new Worker("/m/cw.js"); w.onmessage = function (e) { res(["classicWorker", e.data]); }; w.onerror = function (e) { res(["classicWorker", { err: String(e.message) }]); }; }),
    new Promise(function (res) {
      var src = "fetch(" + JSON.stringify(C + echo("dw", { acao: "null", acac: "1" })) + ", { credentials: 'include' }).then(function (r) { return r.text(); }).then(function (t) { postMessage({ origin: self.origin, href: location.href.slice(0, 22), body: t.slice(0, 80) }); }, function (e) { postMessage({ origin: self.origin, err: e.name }); });";
      var w = new Worker("data:text/javascript," + encodeURIComponent(src)); w.onmessage = function (e) { res(["dataWorker", e.data]); }; w.onerror = function () { res(["dataWorker", { err: "worker error" }]); };
    }),
  ]; }
  if (document.readyState === "complete") go(); else window.addEventListener("load", go);
  // (the jobs start only after window load — the frames' Set-Cookie included — so both runs see the same jar)
})();
</script></body></html>`;

function siteHandler(self: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url ?? "/", self), n = u.searchParams.get("n");
    const row: Seen | null = n ? { n, cookie: String(req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).sort().join("; "), sfs: (req.headers["sec-fetch-site"] as string) ?? null, referer: (req.headers.referer as string) ?? null, origin: (req.headers.origin as string) ?? null } : null;
    if (row) seen[run].push(row);
    const cors = (v: string | null, cred: boolean): Record<string, string> => {
      const h: Record<string, string> = {};
      if (v === "*") h["access-control-allow-origin"] = "*"; else if (v === "null") h["access-control-allow-origin"] = "null"; else if (v === "page") h["access-control-allow-origin"] = A;
      if (cred) h["access-control-allow-credentials"] = "true";
      return h;
    };
    if (u.pathname === "/set") {
      const c = self === B ? ["b=1; SameSite=None; Secure", "bl=1; SameSite=Lax", "bs=1; SameSite=Strict", "bd=1"] : ["a=1", "as=1; SameSite=Strict"];
      res.writeHead(200, { "set-cookie": c, "content-type": "text/html" }); res.end("<p>set</p>"); return;
    }
    if (u.pathname === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    if (MODS[u.pathname] !== undefined || u.pathname === "/m/x.js") {
      res.writeHead(200, JS); res.end(u.pathname === "/m/x.js" ? `export const x = "cross-origin-absolute";` : MODS[u.pathname]); return;
    }
    if (u.pathname === "/redir") {
      res.writeHead(302, { location: u.searchParams.get("to") ?? "/", ...cors(u.searchParams.get("racao"), u.searchParams.get("acac") === "1") }); res.end(); return;
    }
    if (u.pathname === "/echo") {
      res.writeHead(200, { "content-type": "text/plain", ...cors(u.searchParams.get("acao"), u.searchParams.get("acac") === "1") });
      res.end(JSON.stringify(row ?? {})); return;
    }
    if (u.pathname === "/frame") {
      const p = self === B ? "f" : "s";
      const sc = self === B ? ["fl=1; SameSite=Lax", "fn=1; SameSite=None; Secure"] : ["sl=1; SameSite=Lax"];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": sc });
      res.end(`<!doctype html><html><body><p>frame ${p}</p><img src="${self}/img?n=${p}img"><script>fetch(${JSON.stringify(`${self}/echo?n=${p}fetch`)}, { credentials: "same-origin" });</script></body></html>`); return;
    }
    if (u.pathname === "/img") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
    if (u.pathname === "/bad.js") { res.writeHead(200, JS); res.end("export const z = `never closed ${1}"); return; }
    res.writeHead(404); res.end();
  };
}
const sA = http.createServer(siteHandler(A)), sA2 = http.createServer(siteHandler(A2));
const tls = { key: fs.readFileSync(`${CD}/b.key`), cert: fs.readFileSync(`${CD}/b.pem`) };
const sB = https.createServer(tls, siteHandler(B)), sC = https.createServer(tls, siteHandler(C));
let srv: ChildProcess | null = null, browser: Browser | null = null;
const SITE_NAMES = ["r1", "r2", "r3", "r5", "r8", "x1", "dw", "fnav", "fimg", "ffetch", "snav", "simg", "sfetch"];
const pickSeen = (rows: Seen[]) => Object.fromEntries(SITE_NAMES.map((n) => { const r = rows.find((x) => x.n === n); return [n, r ? { cookie: r.cookie, sfs: r.sfs, referer: r.referer, origin: r.origin } : null]; }));

type Obs = { mod: unknown; inline: unknown; fetch: Record<string, unknown>; jarB: string; jarA2: string };
async function observe(page: Page, nav: (u: string) => string, label: string): Promise<Obs> {
  await page.goto(nav(`${B}/set`)); await page.goto(nav(`${A}/set`));
  await page.goto(nav(`${A}/page?q=1`), { waitUntil: "load" });
  await poll(() => page.evaluate(() => !!(window as unknown as { __mod?: unknown }).__mod && !!(window as unknown as { __fetch?: unknown }).__fetch), `${label}: page results`, 30000)
    .catch(async (e) => { throw new Error(`${(e as Error).message}; have ${JSON.stringify(await page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return { mod: !!w.__mod, fetch: !!w.__fetch, inline: !!w.__inline }; }))}`); });
  await poll(() => ["fimg", "ffetch", "simg", "sfetch"].every((n) => seen[run].some((r) => r.n === n)), `${label}: frame loads`)
    .catch(async (e) => { throw new Error(`${(e as Error).message}; seen ${JSON.stringify(seen[run].map((r) => r.n))}; frames ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src"))))}; frame urls ${JSON.stringify(page.frames().map((f) => f.url().slice(0, 140)))}; content ${JSON.stringify(await page.frames()[1]?.content().then((c) => c.slice(0, 900)).catch((x) => String(x)))}`); });
  const got = await page.evaluate(() => { const w = window as unknown as { __mod: unknown; __inline: unknown; __fetch: Record<string, unknown> }; return { mod: w.__mod, inline: w.__inline, fetch: w.__fetch }; });
  await sleep(200);
  await page.goto(nav(`${B}/echo?n=jarB`)); await page.goto(nav(`${A2}/echo?n=jarA2`));
  return { ...got, jarB: seen[run].find((r) => r.n === "jarB")!.cookie, jarA2: seen[run].find((r) => r.n === "jarA2")!.cookie };
}
/** what the page saw, with proxy-only noise normalised: nothing — the shim must make it identical */
function diff(a: unknown, b: unknown, path: string, out: string[]) {
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}\n      native  ${JSON.stringify(a)}\n      proxied ${JSON.stringify(b)}`);
}

try {
  await Promise.all([new Promise<void>((r) => sA.listen(PA, "127.0.0.1", r)), new Promise<void>((r) => sA2.listen(PA2, "127.0.0.1", r)), new Promise<void>((r) => sB.listen(PB, "127.0.0.2", r)), new Promise<void>((r) => sC.listen(PC, "127.0.0.2", r))]);
  srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    env: { ...process.env, FUSION_WP_TEST_LOOPBACK_PORTS: `${PA},${PA2},${PB},${PC}`, FUSION_WP_UPSTREAM: "", FUSION_WP_OS_PROXY: "0", NODE_EXTRA_CA_CERTS: `${CD}/ca.pem` }, stdio: "ignore",
  });
  await poll(async () => (await fetch(`${ORIGIN}/api/wp-route`)).ok, "second server up", 40000);
  browser = await launchChromium();

  run = "native";
  const nctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const native = await observe(await nctx.newPage(), (u) => u, "native");
  await nctx.close();

  run = "proxied";
  const sess = await (await fetch(`${ORIGIN}/api/wp-session`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ ua: "desktop" }) })).json() as { sid: string; prefix: string };
  ok(sess.sid, "session");
  const P = (u: string) => `${ORIGIN}${sess.prefix}${u.replace("://", "/")}`;
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  if (process.env.TT41_DEBUG) {
    pp.on("response", async (r) => { if (r.url().includes(":f/")) console.log("RESP", r.status(), r.url().slice(-60), JSON.stringify(await r.allHeaders()).slice(0, 900)); });
    pp.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 300)));
    pp.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
    pp.on("request", (r) => { if (/\.js(\?|$)/.test(r.url())) console.log("REQ", r.url().replace(/^.*\/api\/wp\/s\//, "").slice(0, 120)); });
    pp.on("response", (r) => { if (/\.js(\?|$)/.test(r.url())) console.log("JSRESP", r.status(), r.url().replace(/^.*\/api\/wp\/s\//, "").slice(0, 120)); });
    pp.on("requestfailed", (r) => console.log("FAILED", r.url().slice(-80), r.failure()?.errorText));
  }
  const proxied = await observe(pp, P, "proxied");

  await test("WP-17 oracle: an ES-module page — root-relative, parent-relative, absolute cross-origin imports; an import map with a bare prefix AND a URL-like key; export-from; dynamic import() of a literal AND of a root-relative path computed at run time; import.meta.url and import.meta.resolve; a module worker created with new Worker(new URL(\"./w.js\", import.meta.url)) that itself imports root-relative and reports self.location / self.origin; an inline module — yields IDENTICAL values natively and through the proxy", { "WP-17": "full" }, async () => {
    const d: string[] = [];
    diff(native.mod, proxied.mod, "mod", d); diff(native.inline, proxied.inline, "inline", d);
    ok(d.length === 0, `differences:\n    ${d.join("\n    ")}`);
    const m = proxied.mod as { a: string; c: string; d: string; x: string; meta: string; w: { href: string; origin: string; a: string } };
    ok((m as unknown as { dyn2: string }).dyn2 === "computed-root-relative" && (m as unknown as { dm: string }).dm === "computed-via-page-map" && m.a === "root" && m.c === "bare-via-map" && m.d === "url-key-via-map" && m.x === "cross-origin-absolute" && m.meta === `${A}/m/main.js`, `not vacuous: ${JSON.stringify(m)}`);
    ok(m.w.href === `${A}/m/w.js` && m.w.origin === A && m.w.a === "root", `worker: ${JSON.stringify(m.w)}`);
    console.log(`     module graph identical; worker location ${m.w.href}, origin ${m.w.origin}`);
  });

  await test("WP-18 oracle: Response.url / redirected / type after redirects, XHR responseURL, Request.url (fragment kept), redirect TAINT (A→B→C: C sees Origin \"null\" and must allow \"null\"; A→B→A: no same-origin cookies, needs CORS), mode \"same-origin\" leaving the origin fails, the full page URL as same-origin Referer, a classic worker's importScripts + Response.url, and a data: worker's opaque origin — the page's view AND what A / B / C saw are IDENTICAL natively and through the proxy", { "WP-18": "full" }, async () => {
    const d: string[] = [];
    diff(native.fetch, proxied.fetch, "fetch", d);
    const ns = pickSeen(seen.native), ps = pickSeen(seen.proxied);
    for (const k of ["r1", "r2", "r3", "r5", "r8", "x1", "dw"]) diff(ns[k], ps[k], `seen.${k}`, d);
    ok(d.length === 0, `differences:\n    ${d.join("\n    ")}`);
    const f = proxied.fetch as Record<string, { url?: string; error?: string; redirected?: boolean }>;
    ok(f.r1.url === `${A}/echo?n=r1` && f.r1.redirected === true && !!f.r4.error && !!f.r6.error && !!f.r7.error && !f.r3.error && !f.r5.error, `not vacuous: ${JSON.stringify(f).slice(0, 400)}`);
    ok(ps.r3?.origin === "null" && ps.r5?.origin === "null" && ps.r5?.cookie === "" && ps.r8?.referer === `${A}/page?q=1`, `taint/referer: ${JSON.stringify({ r3: ps.r3, r5: ps.r5, r8: ps.r8 })}`);
    console.log(`     r3 Origin ${ps.r3?.origin} cookie "${ps.r3?.cookie}"; r5 Origin ${ps.r5?.origin}; data: worker ${JSON.stringify((f as Record<string, unknown>).dataWorker).slice(0, 120)}`);
  });

  await test("WP-19 oracle: a CROSS-SITE iframe (B in A) — its navigation, its own image and its same-origin fetch get only SameSite=None cookies, and its Set-Cookie may store only SameSite=None; a SAME-SITE iframe (A′ in A) keeps every cookie and may store Lax — identical natively and through the proxy, including Sec-Fetch-Site and Referer", { "WP-19": "full" }, async () => {
    const d: string[] = [];
    const ns = pickSeen(seen.native), ps = pickSeen(seen.proxied);
    for (const k of ["fnav", "fimg", "ffetch", "snav", "simg", "sfetch"]) diff(ns[k], ps[k], `seen.${k}`, d);
    if (native.jarB !== proxied.jarB) d.push(`B's jar\n      native  ${native.jarB}\n      proxied ${proxied.jarB}`);
    if (native.jarA2 !== proxied.jarA2) d.push(`A′'s jar\n      native  ${native.jarA2}\n      proxied ${proxied.jarA2}`);
    ok(d.length === 0, `differences:\n    ${d.join("\n    ")}`);
    ok(!/bl=1|bs=1|bd=1/.test(ps.fimg!.cookie + ps.ffetch!.cookie + ps.fnav!.cookie) && /as=1/.test(ps.simg!.cookie) && !/fl=1/.test(proxied.jarB) && /fn=1/.test(proxied.jarB) && /sl=1/.test(proxied.jarA2), `not vacuous: ${JSON.stringify({ fnav: ps.fnav, fimg: ps.fimg, simg: ps.simg, jarB: proxied.jarB, jarA2: proxied.jarA2 })}`);
    console.log(`     cross-site frame img "${ps.fimg?.cookie}", same-site frame img "${ps.simg?.cookie}"; B's jar "${proxied.jarB}"`);
  });

  await test("WP-17/18/19 adversary: page fetch() of a module gets its bytes UNCHANGED (only script / worker destinations are rewritten); a module the lexer cannot tokenise (an unterminated template) is served unchanged and labelled; an \"f\" (frame) tag on an image is not honoured as a frame (no frame-tree cookies, the script rules apply: none cross-site); chain flags only ever REMOVE — a tag without them is what the shim emits, so a page cannot claim more", { "WP-17": "full", "WP-19": "full" }, async () => {
    await pp.goto(P(`${A}/page?q=2`), { waitUntil: "load" });
    const r = await pp.evaluate(async (u) => { const res = await fetch(u); return { t: await res.text(), h: res.headers.get("x-fusion-wp-js") }; }, `${A}/m/main.js`);
    ok(r.t === MODS["/m/main.js"] && r.h === null, `fetch() body changed: ${r.h} ${r.t.slice(0, 80)}`);
    const bad = await fetch(`${ORIGIN}/api/wp/s/${sess.sid}/http/127.0.0.1:${PA}/bad.js`, { headers: { "sec-fetch-dest": "script" } });
    ok((await bad.text()) === "export const z = `never closed ${1}" && /^unchanged/.test(bad.headers.get("x-fusion-wp-js") ?? ""), `bad.js: ${bad.headers.get("x-fusion-wp-js")}`);
    const good = await fetch(`${ORIGIN}/api/wp/s/${sess.sid}/http/127.0.0.1:${PA}/m/main.js`, { headers: { "sec-fetch-dest": "script" } });
    const gt = await good.text();
    ok(/^[1-9][0-9]* specifiers, 2 import\.meta\.url$/.test(good.headers.get("x-fusion-wp-js") ?? "") && gt.includes(`/api/wp/s/${sess.sid}`) && gt.includes(`"${A}/m/main.js"`) && gt.includes("'/m/never-2.js'") && gt.includes("/m/never-1.js") && gt.includes('import("/m/never-4.js")'), `main.js rewrite: ${good.headers.get("x-fusion-wp-js")} ${gt.slice(0, 200)}`);
    const docMatch = /:([A-Za-z0-9_-]{8,32}):[rfs]\//.exec(await pp.evaluate(() => document.documentElement.outerHTML));
    ok(docMatch, "page has a document id");
    await pp.evaluate((u) => new Promise<void>((res) => { const i = new Image(); i.onload = i.onerror = () => res(); i.src = u; }), `${ORIGIN}/api/wp/s/${sess.sid}:${docMatch![1]}:f/https/127.0.0.2:${PB}/img?n=ftagimg`);
    await poll(() => seen.proxied.some((x) => x.n === "ftagimg"), "ftagimg");
    const fi = seen.proxied.find((x) => x.n === "ftagimg")!;
    ok(fi.cookie === "", `an f-tagged image got cookies: ${JSON.stringify(fi)}`);
    console.log(`     fetch() body untouched; bad.js "${bad.headers.get("x-fusion-wp-js")}"; f-tagged image cookies "${fi.cookie}"`);
  });
  await pctx.close();
} catch (e) {
  await test("e2e-tt41 setup", {}, async () => { throw e; });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill("SIGTERM");
  for (const s of [sA, sA2, sB, sC]) s.close();
}
await finish();
process.exit(0);
