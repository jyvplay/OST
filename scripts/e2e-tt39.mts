/**
 * TT39 end to end (WP-10): per-origin isolation inside one Private proxy session, checked against an EXTERNAL
 * ORACLE — Chromium itself. The same request matrix (fetch / XMLHttpRequest, credentials modes, CORS read checks,
 * preflights, SameSite, Set-Cookie storage) runs twice in real Chromium:
 *   native:  the page loaded straight from site A, talking to A, A′ and B as a browser does;
 *   proxied: the same page loaded through a second production server of this build.
 * Every observable result (which requests fail, what each site saw: cookies, Origin, Sec-Fetch-Site, headers; which
 * response headers the page can read; how many preflights each site received) must be identical.
 * Three real local sites stand in for the internet this sandbox cannot reach:
 *   A  = http://127.0.0.1:41811        (the page's own origin)
 *   A′ = http://127.0.0.1:41813        (same site, other origin — cookies are not port-scoped)
 *   B  = https://127.0.0.2:41814       (another site, real TLS from a CA generated for this run)
 *   L  = https://127.0.0.2:41815       (a certificate for "localhost" only — must be refused for 127.0.0.2)
 * Then the adversary: untagged raw requests, a forged document id, a direct client with no browser.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import type { Browser, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("e2e-tt39");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PORT = 3990, PA = 41811, PA2 = 41813, PB = 41814, PL = 41815, PWS = 41812;
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const A = `http://127.0.0.1:${PA}`, A2 = `http://127.0.0.1:${PA2}`, B = `https://127.0.0.2:${PB}`, LB = `https://127.0.0.2:${PL}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(100); } throw new Error(`timed out: ${what}`); }

// ------------------------------------------------------------------ certificates (openssl, this run only)
const CD = "/tmp/tt39-certs";
fs.rmSync(CD, { recursive: true, force: true }); fs.mkdirSync(CD, { recursive: true });
const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: CD, stdio: "pipe" });
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Fusion TT39 test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
for (const [name, san] of [["b", "IP:127.0.0.2"], ["l", "DNS:localhost"]] as const) {
  ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
  fs.writeFileSync(`${CD}/${name}.ext`, `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  ossl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`);
}

// ------------------------------------------------------------------ the sites
const options: Record<string, number> = {}; // OPTIONS (preflight) requests seen, per run
let run = "native";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt39 site</title></head><body><h1>tt39</h1>
<script>
const A = ${JSON.stringify(A)}, A2 = ${JSON.stringify(A2)}, B = ${JSON.stringify(B)};
async function f(name, url, init) {
  try {
    const r = await fetch(url, init); let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { name, status: r.status, body, xs: r.headers.get("x-secret"), xt: r.headers.get("x-total") };
  } catch (e) { return { name, err: e.name }; }
}
function xhr(name, url, cred, late) {
  return new Promise((res) => {
    const x = new XMLHttpRequest();
    if (cred && !late) x.withCredentials = true;
    x.open("GET", url);
    if (cred && late) x.withCredentials = true;
    x.onload = () => { let b = null; try { b = JSON.parse(x.responseText); } catch (e) { b = null; } res({ name, status: x.status, body: b, wc: x.withCredentials }); };
    x.onerror = () => res({ name, err: "error", wc: x.withCredentials });
    x.send();
  });
}
window.runMatrix = async () => {
  const out = [];
  out.push(await f("same-origin GET", A + "/echo"));
  out.push(await f("same-origin POST", A + "/echo", { method: "POST", body: "x" }));
  out.push(await f("same-origin omit", A + "/echo", { credentials: "omit" }));
  out.push(await f("same-site ACAO *", A2 + "/echo?acao=star"));
  out.push(await f("same-site include", A2 + "/echo?acao=echo&acac=1&aceh=1", { credentials: "include" }));
  out.push(await f("same-site include + ACAO *", A2 + "/echo?acao=star", { credentials: "include" }));
  out.push(await f("same-site include, no ACAC", A2 + "/echo?acao=echo", { credentials: "include" }));
  out.push(await f("same-site no ACAO", A2 + "/echo"));
  out.push(await f("cross-site include", B + "/echo?acao=echo&acac=1", { credentials: "include" }));
  out.push(await f("cross-site default", B + "/echo?acao=star"));
  out.push(await f("preflight ok", B + "/echo?acao=echo&pf=ok", { method: "PUT", headers: { "x-custom": "1" } }));
  out.push(await f("preflight ok (cached)", B + "/echo?acao=echo&pf=ok", { method: "PUT", headers: { "x-custom": "1" } }));
  out.push(await f("preflight denies method", B + "/echo?acao=echo&pf=deny", { method: "PUT" }));
  out.push(await f("Authorization under * (browsers allow it)", B + "/echo?acao=echo&pf=star&u=auth", { headers: { authorization: "Bearer t" } }));
  out.push(await f("x-custom under * (no new preflight: cached *)", B + "/echo?acao=echo&pf=star&u=auth", { headers: { "x-other": "3" } }));
  out.push(await f("x-custom covered by *", B + "/echo?acao=echo&pf=star", { headers: { "x-custom": "2" } }));
  out.push(await f("methods * not with credentials", B + "/echo?acao=echo&acac=1&pf=star", { method: "PUT", credentials: "include" }));
  out.push(await f("JSON body needs a preflight", B + "/echo?acao=star", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  out.push(await f("same-origin redirect", A + "/redir?to=/echo"));
  out.push(await xhr("XHR default", B + "/echo?acao=echo&acac=1", false, false));
  out.push(await xhr("XHR withCredentials", B + "/echo?acao=echo&acac=1", true, false));
  out.push(await xhr("XHR withCredentials after open()", B + "/echo?acao=echo&acac=1", true, true));
  out.push(await xhr("XHR withCredentials + ACAO *", B + "/echo?acao=star", true, false));
  out.push(await f("cross-site Set-Cookie", B + "/setc?acao=echo&acac=1", { credentials: "include" }));
  out.push(await f("…then: only SameSite=None stored", B + "/echo?acao=echo&acac=1", { credentials: "include" }));
  out.push(await f("Set-Cookie with omit", A + "/setc", { credentials: "omit" }));
  out.push(await f("…then: not stored", A + "/echo"));
  return out;
};
</script></body></html>`;

// ---- WP-11: the worker page and its scripts (identical natively and through the proxy)
const WPAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt39 workers</title></head><body><h1>workers</h1>
<script>
const A2 = ${JSON.stringify(A2)};
const once = (w) => new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); res("error: " + (e.message || e.type)); }; });
const msg = (p) => new Promise((res) => { p.onmessage = (e) => res(e.data); });
window.runWorkers = async () => {
  const out = {};
  const w1 = new Worker("w.js"); out.classic = await once(w1); w1.terminate();
  const w2 = new Worker("mw.mjs", { type: "module" }); w2.postMessage("early"); out.module = await once(w2); w2.terminate();
  const code = "fetch(" + JSON.stringify(A2 + "/echo?acao=star") + ").then(function (r) { return r.json(); }).then(function (j) { postMessage({ origin: j.origin, cookie: j.cookie }); }, function (e) { postMessage('fetch failed: ' + e.name); });";
  const w3 = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))); out.blob = await once(w3); w3.terminate();
  const s1 = new SharedWorker("sw.js"); s1.port.postMessage("hi"); out.shared1 = await msg(s1.port);
  const s2 = new SharedWorker("sw.js"); s2.port.postMessage("hi"); out.shared2 = await msg(s2.port);
  const m1 = new SharedWorker("msw.mjs", { type: "module" }); m1.port.postMessage("hi"); out.sharedModule = await msg(m1.port);
  const s3 = new SharedWorker("sw.js", "other"); s3.port.postMessage("hi"); out.sharedOtherName = await msg(s3.port);
  try { new Worker(A2 + "/w.js"); out.crossOrigin = "no error"; } catch (e) { out.crossOrigin = e.name; }
  return out;
};
</script></body></html>`;
const WORKER_JS: Record<string, string> = {
  "/lib.js": `self.LIB = "lib-ok";`,
  "/data.json": `{"v":42}`,
  "/nested.js": `fetch("data.json").then(function (r) { return r.json(); }).then(function (j) { postMessage("nested " + j.v); });`,
  "/w.js": `importScripts("lib.js");
(async () => {
  const r = { lib: self.LIB };
  r.data = (await (await fetch("data.json")).json()).v;
  r.request = (await (await fetch(new Request("data.json"))).json()).v;
  r.xhr = await new Promise((res) => { const x = new XMLHttpRequest(); x.open("GET", "data.json"); x.onload = () => res(JSON.parse(x.responseText).v); x.onerror = () => res("xhr error"); x.send(); });
  const j = await (await fetch(${JSON.stringify(A2)} + "/echo?acao=star")).json();
  r.echo = { origin: j.origin, cookie: j.cookie, sfs: j.sfs };
  r.ws = await new Promise((res) => { const ws = new WebSocket("ws://127.0.0.1:${PWS}/echo"); ws.onopen = () => ws.send("ping from a worker"); ws.onmessage = (e) => { res(String(e.data)); ws.close(); }; ws.onerror = () => res("ws error"); });
  r.nested = await new Promise((res) => { const n = new Worker("nested.js"); n.onmessage = (e) => res(e.data); n.onerror = () => res("nested error"); });
  postMessage(r);
})();`,
  "/mw.mjs": `import { dep } from "./dep.mjs";
// a module that waits for its first message at top level (a common pattern): the page posted it right after new Worker()
const first = await new Promise((r) => self.addEventListener("message", (e) => r(e.data), { once: true }));
const d = await (await fetch("data.json")).json();
let imp; try { importScripts("dep.mjs"); imp = "no error"; } catch (e) { imp = e.name; }
postMessage({ dep, v: d.v, metaEndsWithScript: import.meta.url.endsWith("/mw.mjs"), first, importScripts: imp });`,
  "/msw.mjs": `let n = 0;
self.onconnect = (e) => { n++; const port = e.ports[0]; port.onmessage = () => port.postMessage("module shared " + n); };`,
  "/dep.mjs": `export const dep = "dep-ok";`,
  "/sw.js": `let n = 0;
onconnect = (e) => { const port = e.ports[0]; n++; const mine = n; port.onmessage = () => port.postMessage("connection " + mine + " of " + n + " (" + self.name + ")"); };`,
};

function siteHandler(self: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url ?? "/", self);
    const q = u.searchParams, origin = req.headers.origin;
    const cors: Record<string, string> = {};
    if (q.get("acao") === "star") cors["access-control-allow-origin"] = "*";
    if (q.get("acao") === "echo") cors["access-control-allow-origin"] = String(origin ?? "*");
    if (q.get("acac")) cors["access-control-allow-credentials"] = "true";
    if (q.get("aceh")) cors["access-control-expose-headers"] = "x-total";
    if (req.method === "OPTIONS") {
      options[run] = (options[run] ?? 0) + 1;
      const pf = q.get("pf");
      if (pf === "ok") Object.assign(cors, { "access-control-allow-methods": "PUT", "access-control-allow-headers": "x-custom", "access-control-max-age": "60" });
      else if (pf === "star") Object.assign(cors, { "access-control-allow-methods": "*", "access-control-allow-headers": "*" });
      else if (pf === "deny") Object.assign(cors, { "access-control-allow-methods": "GET" });
      else { res.writeHead(404); res.end(); return; }
      res.writeHead(204, cors); res.end(); return;
    }
    if (u.pathname === "/wpage") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(WPAGE); return; }
    if (WORKER_JS[u.pathname] !== undefined) {
      const ct = u.pathname.endsWith(".json") ? "application/json" : "text/javascript";
      // module scripts are fetched with CORS — a site serving modules to itself needs no header natively, but the
      // header is harmless and the same for both runs
      res.writeHead(200, { "content-type": ct, "access-control-allow-origin": "*" }); res.end(WORKER_JS[u.pathname]); return;
    }
    if (u.pathname === "/page") { res.writeHead(200, { ...cors, "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    if (u.pathname === "/set") {
      const c = self === B ? ["b=1; Path=/; SameSite=None; Secure", "bl=1; Path=/; SameSite=Lax; Secure"] : ["a=1; Path=/; SameSite=Lax"];
      res.writeHead(200, { "content-type": "text/html", "set-cookie": c }); res.end("<p>set</p>"); return;
    }
    if (u.pathname === "/setc") {
      const c = self === B ? ["n2=1; Path=/; SameSite=None; Secure", "l2=1; Path=/; SameSite=Lax; Secure"] : ["o=1; Path=/"];
      res.writeHead(200, { ...cors, "content-type": "application/json", "set-cookie": c }); res.end("{}"); return;
    }
    if (u.pathname === "/redir") { res.writeHead(302, { ...cors, location: q.get("to") ?? "/" }); res.end(); return; }
    if (u.pathname === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { ...cors, "content-type": "application/json", "x-secret": "s3", "x-total": "7" });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? "", origin: origin ?? null, sfs: req.headers["sec-fetch-site"] ?? null, sfm: req.headers["sec-fetch-mode"] ?? null, method: req.method, xc: req.headers["x-custom"] ?? null, auth: !!req.headers.authorization }));
      });
      return;
    }
    res.writeHead(404); res.end();
  };
}
const sA = http.createServer(siteHandler(A)), sA2 = http.createServer(siteHandler(A2));
const sB = https.createServer({ key: fs.readFileSync(`${CD}/b.key`), cert: fs.readFileSync(`${CD}/b.pem`) }, siteHandler(B));
const sL = https.createServer({ key: fs.readFileSync(`${CD}/l.key`), cert: fs.readFileSync(`${CD}/l.pem`) }, (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<p>should never be reached through the proxy</p>"); });

let srv: ChildProcess | null = null, browser: Browser | null = null, py: ChildProcess | null = null;
const pyLines: string[] = [];
type Row = { name: string; err?: string; status?: number; body?: Record<string, unknown> | null; xs?: string | null; xt?: string | null; wc?: boolean };
const byName = (rows: Row[], n: string) => rows.find((r) => r.name === n)!;
try {
  await Promise.all([
    new Promise<void>((r) => sA.listen(PA, "127.0.0.1", r)), new Promise<void>((r) => sA2.listen(PA2, "127.0.0.1", r)),
    new Promise<void>((r) => sB.listen(PB, "127.0.0.2", r)), new Promise<void>((r) => sL.listen(PL, "127.0.0.2", r)),
  ]);
  py = spawn(PY, ["scripts/fixtures/ws/ws_server.py", String(PWS)], { stdio: ["ignore", "pipe", "inherit"] });
  py.stdout!.on("data", (d: Buffer) => pyLines.push(...d.toString().split("\n").filter(Boolean)));
  await poll(() => pyLines.some((l) => l.startsWith("READY")), "ws server");
  srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    env: { ...process.env, FUSION_WP_TEST_LOOPBACK_PORTS: `${PA},${PA2},${PB},${PL},${PWS}`, FUSION_WP_UPSTREAM: "", NODE_EXTRA_CA_CERTS: `${CD}/ca.pem` }, stdio: "ignore",
  });
  await poll(async () => (await fetch(`${ORIGIN}/api/wp-route`)).ok, "second server up", 40000);
  browser = await launchChromium();

  // ---- native run: the oracle
  run = "native";
  const nctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const np = await nctx.newPage();
  await np.goto(`${B}/set`); await np.goto(`${A}/set`); await np.goto(`${A}/page`);
  const native = await np.evaluate(() => (window as unknown as { runMatrix: () => Promise<Row[]> }).runMatrix());
  await np.goto(`${A}/wpage`);
  const nativeW = await np.evaluate(() => (window as unknown as { runWorkers: () => Promise<Record<string, unknown>> }).runWorkers());
  await nctx.close();

  // ---- proxied run
  run = "proxied";
  const sess = await (await fetch(`${ORIGIN}/api/wp-session`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ ua: "desktop" }) })).json() as { sid: string; prefix: string };
  ok(sess.sid, "session");
  const pctx = await browser.newContext();
  const pp: Page = await pctx.newPage();
  const perrors: string[] = [];
  pp.on("pageerror", (e) => perrors.push(e.message));
  const P = (u: string) => `${ORIGIN}${sess.prefix}${u.replace("://", "/")}`;
  await pp.goto(P(`${B}/set`)); await pp.goto(P(`${A}/set`)); await pp.goto(P(`${A}/page`));
  const proxied = await pp.evaluate(() => (window as unknown as { runMatrix: () => Promise<Row[]> }).runMatrix());

  await test("WP-10 oracle: the same 27-request matrix (fetch + XHR; credentials include / same-origin / omit; ACAO * vs echoed; ACAC; preflights that pass, are reused from the cache (incl. `*` entries), deny a method, deny `*` with credentials, Authorization under `*`; a JSON body; a redirect; withCredentials before and after open(); cross-site Set-Cookie; Set-Cookie with omit) gives IDENTICAL results natively in Chromium and through the proxy — failures, cookies and Origin the sites saw, Sec-Fetch-Site/Mode, readable response headers", { "WP-10": "full" }, async () => {
    ok(native.length === 27 && proxied.length === 27, `rows ${native.length}/${proxied.length}`);
    const diffs: string[] = [];
    for (let i = 0; i < native.length; i++) if (JSON.stringify(native[i]) !== JSON.stringify(proxied[i])) diffs.push(`${native[i].name}\n      native  ${JSON.stringify(native[i])}\n      proxied ${JSON.stringify(proxied[i])}`);
    ok(diffs.length === 0, `differences:\n    ${diffs.join("\n    ")}`);
    ok(perrors.length === 0, `page errors: ${perrors.join(" | ")}`);
    const fails = native.filter((r) => r.err).length;
    console.log(`    ${native.length} requests, ${fails} refused by the browser in both runs, 0 differences`);
  });

  await test("WP-10 oracle is not vacuous: the matrix exercises both outcomes — the cross-site request with credentials carries ONLY the SameSite=None cookie (b=1, not the Lax bl=1); same-origin reads the private header, cross-origin reads only exposed ones; ACAO * with credentials, a JSON body without a preflight answer and a denied method all FAIL; the cached preflight was not repeated", { "WP-10": "full" }, async () => {
    const r = (n: string) => byName(proxied, n);
    ok(r("same-origin GET").body?.cookie === "a=1" && r("same-origin GET").body?.origin === null && r("same-origin GET").xs === "s3", `so ${JSON.stringify(r("same-origin GET"))}`);
    ok(r("same-origin POST").body?.origin === A, "so POST origin");
    ok(r("same-origin omit").body?.cookie === "", "omit");
    ok(r("same-site ACAO *").body?.cookie === "" && r("same-site ACAO *").body?.sfs === "same-site" && r("same-site ACAO *").xs === null, `ss ${JSON.stringify(r("same-site ACAO *"))}`);
    ok(r("same-site include").body?.cookie === "a=1" && r("same-site include").xt === "7" && r("same-site include").xs === null, "ss include");
    for (const n of ["same-site include + ACAO *", "same-site include, no ACAC", "same-site no ACAO", "preflight denies method", "methods * not with credentials", "JSON body needs a preflight"]) ok(r(n).err === "TypeError", `${n}: ${JSON.stringify(r(n))}`);
    ok(r("cross-site include").body?.cookie === "b=1" && r("cross-site include").body?.sfs === "cross-site" && r("cross-site include").body?.origin === A, `cs ${JSON.stringify(r("cross-site include"))}`);
    ok(r("cross-site default").body?.cookie === "", "cs default");
    ok(r("preflight ok").body?.method === "PUT" && r("preflight ok").body?.xc === "1", "pf ok");
    ok(r("x-custom covered by *").body?.xc === "2", "star x-custom");
    ok(r("Authorization under * (browsers allow it)").body?.auth === true, "auth under * (as Chromium)");
    ok(r("XHR default").body?.cookie === "" && r("XHR withCredentials").body?.cookie === "b=1" && r("XHR withCredentials after open()").body?.cookie === "b=1" && r("XHR withCredentials after open()").wc === true, "xhr");
    ok(r("XHR withCredentials + ACAO *").err === "error", "xhr star");
    ok(r("…then: only SameSite=None stored").body?.cookie === "b=1; n2=1", `stored ${JSON.stringify(r("…then: only SameSite=None stored").body)}`);
    ok(r("…then: not stored").body?.cookie === "a=1", `omit stored ${JSON.stringify(r("…then: not stored").body)}`);
    ok(options.native === options.proxied, `preflights at the sites: native ${options.native}, proxied ${options.proxied}`);
    console.log(`    preflights the sites received: native ${options.native}, proxied ${options.proxied}`);
  });

  await test("WP-10 adversary inside the page: an UNTAGGED raw request (the shim's own rawFetch, bypassing tagging) and a FORGED document id both reach B with Origin \"null\" and no cookies; a script-fetched copy of another site's page carries no document id", { "WP-10": "full" }, async () => {
    const adv = await pp.evaluate(async (BB) => {
      const me = document.querySelector("script[data-fusion-wp]") as HTMLScriptElement;
      const sid = me.dataset.sid!, raw = (window as unknown as { __fusionWp: { rawFetch: typeof fetch } }).__fusionWp.rawFetch;
      const tail = "/" + BB.replace("://", "/");
      const j = async (p: Promise<Response>) => { try { return await (await p).json(); } catch (e) { return { err: (e as Error).name }; } };
      const untagged = await j(raw.call(window, `/api/wp/s/${sid}${tail}/echo?acao=star`));
      const untaggedInc = await j(raw.call(window, `/api/wp/s/${sid}${tail}/echo?acao=echo&acac=1`, { credentials: "omit" }));
      const forged = await j(raw.call(window, `/api/wp/s/${sid}:AAAAAAAAAAAAAAAA:i${tail}/echo?acao=echo&acac=1`));
      const html = await (await fetch(BB + "/page?acao=star")).text();
      const doc = new DOMParser().parseFromString(html, "text/html").querySelector("script[data-fusion-wp]") as HTMLScriptElement | null;
      return { untagged, untaggedInc, forged, fetchedDoc: doc ? doc.dataset.doc : "missing", myDoc: me.dataset.doc ?? "" };
    }, B);
    ok(adv.untagged.cookie === "" && adv.untagged.origin === "null", `untagged ${JSON.stringify(adv.untagged)}`);
    ok(adv.untaggedInc.cookie === "" && adv.untaggedInc.origin === "null", `untagged echo ${JSON.stringify(adv.untaggedInc)}`);
    ok(adv.forged.cookie === "" && adv.forged.origin === "null", `forged ${JSON.stringify(adv.forged)}`);
    ok(adv.fetchedDoc === "", `fetched copy doc ${adv.fetchedDoc}`);
    ok(/^[A-Za-z0-9_-]{16}$/.test(adv.myDoc), `own doc ${adv.myDoc}`);
  });

  await test("WP-10 adversary outside the browser: a direct client using a REAL document id cannot bypass the read check (ACAO * with credentials → 403 and no Access-Control-Allow-Origin, reason given); a failed preflight never sends the actual request", { "WP-10": "full" }, async () => {
    const pageHtml = await (await fetch(P(`${A}/page`), { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } })).text();
    const doc = /data-doc="([A-Za-z0-9_-]{16})"/.exec(pageHtml)?.[1];
    ok(doc, "a navigation issues a document id");
    const base = `${ORIGIN}${sess.prefix.replace(sess.sid, `${sess.sid}:${doc}:i`)}${B.replace("://", "/")}`;
    const r1 = await fetch(`${base}/echo?acao=star`, { headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" } });
    ok(r1.status === 403 && !r1.headers.get("access-control-allow-origin") && /wildcard/.test(r1.headers.get("x-fusion-wp-cors") ?? ""), `r1 ${r1.status} ${r1.headers.get("x-fusion-wp-cors")}`);
    await r1.arrayBuffer();
    const before = options.proxied;
    const r2 = await fetch(`${base}/echo?acao=echo&acac=1&pf=deny`, { method: "DELETE", headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" } });
    ok(r2.status === 403 && /method DELETE not allowed/.test(r2.headers.get("x-fusion-wp-cors") ?? ""), `r2 ${r2.status} ${r2.headers.get("x-fusion-wp-cors")}`);
    ok(options.proxied === before + 1, "exactly one OPTIONS reached the site");
    // a forged credentials code / malformed segment is not a proxy address at all
    const r3 = await fetch(`${ORIGIN}${sess.prefix.replace(sess.sid, `${sess.sid}:${doc}:x`)}${B.replace("://", "/")}/echo`);
    ok(r3.status === 400, `r3 ${r3.status}`);
    console.log(`    ACAO * + include → 403 (${r1.headers.get("x-fusion-wp-cors")}); denied DELETE → only the OPTIONS reached B`);
  });

  await test("TLS identity for IP-literal sites (TT39 fix): https://127.0.0.2 with a valid certificate FOR 127.0.0.2 loads through the proxy; a certificate from the same trusted CA but for \"localhost\" is refused for 127.0.0.2 (before the fix Node checked IP sites against \"localhost\" and would have accepted it)", { "WP-09": "partial" }, async () => {
    const good = await fetch(P(`${B}/echo?acao=star`));
    ok(good.status === 200, `good ${good.status}`); await good.arrayBuffer();
    const bad = await fetch(P(`${LB}/`));
    const t = await bad.text();
    ok(bad.status === 502 && !/should never be reached/.test(t), `bad ${bad.status} ${t.slice(0, 120)}`);
    console.log(`    127.0.0.2 with an IP certificate: 200; with a localhost certificate: ${bad.status} (${t.replace(/\s+/g, " ").slice(0, 90)})`);
  });

  await test("modal shortcut fails (D): the TT35–TT38 approach — every proxied response readable by any page via ACAO * — is exactly what a native browser refuses: in the native run, B's credentialed read under ACAO * failed and Lax cookies never went cross-site; the proxy now matches it", { "WP-10": "full" }, async () => {
    ok(byName(native, "same-site include + ACAO *").err === "TypeError", "native refuses ACAO * with credentials");
    ok(byName(native, "cross-site include").body?.cookie === "b=1", "native sends only SameSite=None cross-site");
    ok(byName(proxied, "same-site include + ACAO *").err === "TypeError", "proxy refuses too");
  });
  await pp.goto(P(`${A}/wpage`));
  const proxiedW = await pp.evaluate(() => (window as unknown as { runWorkers: () => Promise<Record<string, unknown>> }).runWorkers());
  await test("WP-11 oracle: Web Workers in a proxied page behave as natively — a classic worker (importScripts, relative fetch, new Request, XHR, a cross-origin fetch with the PAGE's origin, a WebSocket, a nested worker), a module worker (static import, top-level await, import.meta.url, awaiting its first message at top level, importScripts → TypeError; a module SharedWorker), a page-made blob: worker, SharedWorker (two connections share one instance; another name gets its own) and the SecurityError for a cross-origin script: results IDENTICAL natively and through the proxy", { "WP-11": "full" }, async () => {
    const n = JSON.stringify(nativeW), p = JSON.stringify(proxiedW);
    console.log(`    native  ${n}\n    proxied ${p}`);
    ok(n === p, "worker results differ");
    const c = (nativeW as { classic: Record<string, unknown> }).classic;
    ok(c.lib === "lib-ok" && c.data === 42 && c.request === 42 && c.xhr === 42 && c.ws === "ping from a worker" && c.nested === "nested 42", `classic ${JSON.stringify(c)}`);
    ok((c.echo as { origin: string }).origin === A, "the worker's requests carry the page's origin");
    ok(perrors.length === 0, `page errors: ${perrors.join(" | ")}`);
  });
  await pctx.close();
} catch (e) {
  await test("e2e-tt39 setup", {}, async () => { throw e; });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill("SIGTERM");
  py?.kill("SIGTERM");
  for (const s of [sA, sA2, sB, sL]) { s.closeAllConnections?.(); s.close(); }
}
await finish();
process.exit(0);
